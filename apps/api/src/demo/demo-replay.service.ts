import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { CobanPositionFrame } from '@vizyo/tracky-shared';
import { PositionsService } from '../positions/positions.service';
import { PrismaService } from '../prisma/prisma.service';
import { FakeTcpSocket } from '../realtime/fake-tcp-socket';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { DemoModeService } from './demo-mode.service';
import { instantLocal, type InstantLocal } from './heure-locale';

/** Cadence du rejeu. Un Coban en mouvement émet toutes les 30 s ; 10 s lisse la carte sans charger. */
export const TIC_REJEU_MS = 10_000;
/** Un boîtier garé émet un battement toutes les 2 min (fix120s) : le tracker reste « en ligne ». */
export const BATTEMENT_MS = 120_000;
/** Resynchronisation avec la table des boîtiers (un véhicule ajouté ou retiré par l'import). */
export const RESYNC_MS = 60_000;
/** Délai entre la commande moteur reçue par le faux boîtier et la trame qui en montre l'effet. */
export const DELAI_EFFET_COMMANDE_MS = 4_000;
/** Au réveil après une pause (déploiement, veille), on ne rejoue pas la pile en rafale : 10 min au plus. */
export const RATTRAPAGE_MAX_S = 600;

interface DernierePosition {
  lat: number;
  lng: number;
  heading: number;
  altitude?: number;
  ignition?: boolean;
}

interface Boitier {
  trackerId: string;
  imei: string;
  fleetId: string;
  socket: FakeTcpSocket;
  /** Dernière position émise (ou dernière connue en base au démarrage) : c'est ce que le battement répète. */
  derniere: DernierePosition | null;
  derniereEmissionMs: number;
  /** `deviceTime` de la dernière trame émise : la garde anti-rejeu de l'ingestion exige une croissance stricte. */
  dernierDeviceTimeMs: number;
  /** Curseur de rejeu : jour civil local + seconde locale de la dernière trame rejouée pour CE boîtier. */
  curseur: { dayKey: string; secondOfDay: number } | null;
  /** Coupure simulée en cours : le véhicule reste où il est, contact coupé. */
  coupe: boolean;
  coupeDepuisMs: number | null;
  /**
   * Retard accumulé (s) par les coupures du jour. Le reste de la journée est décalé d'autant :
   * un véhicule rallumé reprend sa tournée là où il s'est arrêté au lieu de sauter à l'endroit
   * où il « aurait dû » être. Remis à zéro au changement de jour.
   */
  retardS: number;
}

/**
 * ═══ LE DIRECT DE LA DÉMO — un rejeu, pas une marche aléatoire ════════════════════════════
 *
 * Chaque boîtier de la base de démonstration reçoit un `FakeTcpSocket` dans le registre des
 * sockets — le même registre où le serveur TCP range les vrais boîtiers. Toutes les dix
 * secondes, les trames de la semaine de référence (`demo_replay_frames`) dont la seconde locale
 * vient de passer sont injectées dans `PositionsService.ingest()` : échantillonnage, trajets,
 * géofences, analyses, WebSocket… TOUT LE RESTE EST LE PRODUIT RÉEL. La démo ne reproduit rien,
 * elle alimente — c'est ce qui lui permet de suivre l'application sans qu'on la réécrive.
 *
 * ── LA COUPURE MOTEUR ──────────────────────────────────────────────────────────────────────
 *
 * `EngineControlService.dispatchCommand()` n'est PAS modifié : il écrit sa trame `…,J` / `…,K`
 * dans le socket du registre, comme pour un vrai boîtier. Ici, c'est le faux socket qui la
 * reçoit. Un Coban exécute ces commandes EN SILENCE — pas d'accusé applicatif (cf. le `.catch`
 * du service, V1.15) : la seule preuve est la CHUTE DU CONTACT sur la trame suivante. C'est donc
 * exactement ce que produit ce service, quelques secondes plus tard : une trame à la même
 * position, vitesse nulle, contact coupé. Le produit la confirme par le chemin normal
 * (`handleIgnitionTransition`) — ou l'affiche « non vérifiable » si le contact était déjà
 * coupé, comme il le ferait en production.
 *
 * ⚠️ Ce service n'a AUCUN moyen d'atteindre un véhicule : il n'y a ni port TCP ni passerelle SMS
 * dans le processus de démo. Il ne fait qu'écrire des trames dans l'application.
 */
@Injectable()
export class DemoReplayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DemoReplayService.name);
  /** Clé : IMEI (pseudonymisé) du boîtier. */
  private readonly boitiers = new Map<string, Boitier>();
  private ticTimer: ReturnType<typeof setInterval> | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  /** Suivis pour être annulés à l'arrêt : un timer qui survit à son module se réveille dans le vide. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private ticEnCours = false;

  constructor(
    private readonly demoMode: DemoModeService,
    private readonly prisma: PrismaService,
    private readonly positions: PositionsService,
    private readonly registry: SocketRegistryService,
    private readonly gateway: RealtimeGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.demoMode.enabled) return;
    this.logger.warn(
      'ENVIRONNEMENT DE DÉMONSTRATION — boîtiers simulés par rejeu de trames ; aucune commande ne peut atteindre un véhicule.',
    );
    await this.synchroniser();
    this.ticTimer = setInterval(() => {
      void this.tic().catch((e) => this.logger.error(`Tic de rejeu en échec : ${(e as Error)?.message ?? e}`));
    }, TIC_REJEU_MS);
    this.resyncTimer = setInterval(() => {
      void this.synchroniser().catch((e) =>
        this.logger.error(`Resynchronisation des boîtiers en échec : ${(e as Error)?.message ?? e}`),
      );
    }, RESYNC_MS);
  }

  onModuleDestroy(): void {
    if (this.ticTimer) clearInterval(this.ticTimer);
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const b of Array.from(this.boitiers.values())) this.retirer(b);
  }

  @OnEvent('tracker.assigned')
  async surAffectation(): Promise<void> {
    if (this.demoMode.enabled) await this.synchroniser();
  }

  @OnEvent('tracker.unassigned')
  async surDesaffectation(): Promise<void> {
    if (this.demoMode.enabled) await this.synchroniser();
  }

  /** Nombre de boîtiers simulés à cet instant (écran d'administration). */
  get nombreBoitiers(): number {
    return this.boitiers.size;
  }

  /**
   * Aligne les faux sockets sur la table des boîtiers : un boîtier rattaché à un véhicule reçoit
   * un socket, un boîtier disparu (import, suppression) perd le sien. Idempotent.
   */
  async synchroniser(): Promise<void> {
    const trackers = await this.prisma.tracker.findMany({
      where: { vehicleId: { not: null } },
      select: {
        id: true,
        imei: true,
        lastLat: true,
        lastLng: true,
        lastHeading: true,
        lastIgnition: true,
        vehicle: { select: { fleetId: true } },
      },
    });
    const vus = new Set<string>();
    for (const t of trackers) {
      if (!t.vehicle) continue;
      vus.add(t.imei);
      if (this.boitiers.has(t.imei)) continue;
      const derniere: DernierePosition | null =
        t.lastLat != null && t.lastLng != null
          ? { lat: t.lastLat, lng: t.lastLng, heading: t.lastHeading ?? 0, ignition: t.lastIgnition ?? undefined }
          : null;
      this.enregistrer(t.id, t.imei, t.vehicle.fleetId, derniere);
    }
    for (const b of Array.from(this.boitiers.values())) {
      if (!vus.has(b.imei)) this.retirer(b);
    }
  }

  private enregistrer(trackerId: string, imei: string, fleetId: string, derniere: DernierePosition | null): void {
    const socket = new FakeTcpSocket(imei, (i, action) => this.surCommande(i, action));
    this.boitiers.set(imei, {
      trackerId,
      imei,
      fleetId,
      socket,
      derniere,
      derniereEmissionMs: 0,
      dernierDeviceTimeMs: 0,
      curseur: null,
      coupe: false,
      coupeDepuisMs: null,
      retardS: 0,
    });
    this.registry.register(imei, socket);
    this.gateway.emitTrackerStatus(fleetId, { trackerId, imei, status: 'online', at: new Date().toISOString() });
    this.logger.log(`[DÉMO] boîtier simulé ${imei} enregistré`);
  }

  private retirer(b: Boitier): void {
    this.registry.unregister(b.imei);
    b.socket.destroy();
    this.boitiers.delete(b.imei);
    this.logger.log(`[DÉMO] boîtier simulé ${b.imei} retiré`);
  }

  /**
   * Le faux boîtier vient de recevoir une commande moteur (`,J` = couper, `,K` = rallumer).
   *
   * Aucun accusé n'est renvoyé — un Coban n'en renvoie pas. L'effet arrive sur la trame suivante :
   *   · CUT     → le véhicule s'immobilise là où il est, contact coupé (la preuve que le produit
   *               attend pour confirmer) ; le rejeu est suspendu pour ce boîtier.
   *   · RESTORE → rallumer ne redémarre pas un moteur : le contact reste coupé, mais le rejeu
   *               reprend, décalé de la durée de la coupure, et la tournée repart de là.
   */
  private surCommande(imei: string, action: 'CUT' | 'RESTORE'): void {
    const b = this.boitiers.get(imei);
    if (!b) return;
    if (action === 'CUT') {
      if (b.coupe) return;
      b.coupe = true;
      b.coupeDepuisMs = Date.now();
      this.logger.log(`[DÉMO] coupure simulée sur ${imei} — contact coupé dans ${DELAI_EFFET_COMMANDE_MS / 1000} s`);
      this.planifier(DELAI_EFFET_COMMANDE_MS, () => this.emettreBattement(b, new Date(), false));
      return;
    }
    if (!b.coupe) return;
    b.coupe = false;
    if (b.coupeDepuisMs != null) b.retardS += Math.round((Date.now() - b.coupeDepuisMs) / 1000);
    b.coupeDepuisMs = null;
    this.logger.log(`[DÉMO] rallumage simulé sur ${imei} — la tournée reprend avec ${b.retardS} s de retard`);
    this.planifier(DELAI_EFFET_COMMANDE_MS, () => this.emettreBattement(b, new Date(), false));
  }

  /** Un passage du rejeu. Exposé pour les tests ; le timer l'appelle avec l'instant courant. */
  async tic(maintenant: Date = new Date()): Promise<void> {
    if (this.ticEnCours) return;
    this.ticEnCours = true;
    try {
      const local = instantLocal(maintenant);
      for (const b of Array.from(this.boitiers.values())) {
        if (!b.coupe) await this.rejouer(b, local, maintenant);
        if (b.derniere && maintenant.getTime() - b.derniereEmissionMs >= BATTEMENT_MS) {
          await this.emettreBattement(b, maintenant, b.coupe ? false : b.derniere.ignition);
        }
      }
    } finally {
      this.ticEnCours = false;
    }
  }

  private async rejouer(b: Boitier, local: InstantLocal, maintenant: Date): Promise<void> {
    // Premier passage : on repart de maintenant, sans rattraper ce qui précède.
    if (!b.curseur) {
      b.curseur = { dayKey: local.dayKey, secondOfDay: local.secondOfDay };
      await this.repositionner(b, local);
      return;
    }
    // La journée a tourné : on ne rattrape pas la nuit, et le retard des coupures de la veille
    // n'a plus d'objet.
    if (b.curseur.dayKey !== local.dayKey) {
      b.curseur = { dayKey: local.dayKey, secondOfDay: local.secondOfDay };
      b.retardS = 0;
      await this.repositionner(b, local);
      return;
    }
    const jusqua = local.secondOfDay - b.retardS;
    const depuis = b.curseur.secondOfDay;
    if (jusqua <= depuis) return;
    const borne = Math.max(depuis, jusqua - RATTRAPAGE_MAX_S);
    // On a sauté du temps (réveil après une pause, déploiement) : la trace reprend ailleurs, donc
    // on se replace avant d'émettre — sinon la première trame serait un saut infaisable.
    if (borne > depuis) await this.repositionner(b, { ...local, secondOfDay: borne });

    const trames = await this.prisma.demoReplayFrame.findMany({
      where: { imei: b.imei, weekday: local.weekday, secondOfDay: { gt: borne, lte: jusqua } },
      orderBy: { secondOfDay: 'asc' },
    });
    for (const t of trames) {
      // La trame garde son âge relatif : rejouée 7 s « trop tard » dans le tic, elle est datée 7 s plus tôt.
      const deviceTime = new Date(maintenant.getTime() - (jusqua - t.secondOfDay) * 1000);
      await this.emettre(
        b,
        { lat: t.lat, lng: t.lng, heading: t.heading, altitude: t.altitude ?? undefined, ignition: t.ignition ?? undefined },
        t.speedKmh,
        t.valid,
        deviceTime,
      );
    }
    b.curseur.secondOfDay = jusqua;
  }

  /**
   * ══ REPLACER LE BOÎTIER SUR SA TRACE, SANS PASSER PAR L'INGESTION ═════════════════════════
   *
   * L'ingestion refuse les sauts infaisables (`implausible_jump`) : elle compare la position
   * reçue à la dernière position connue et rejette ce qu'aucun véhicule ne pourrait parcourir.
   * C'est une garde JUSTE, qui protège la production d'un boîtier qui déraille — et le rejeu la
   * déclenchait de plein fouet.
   *
   * ⚠️ MESURÉ LE 2026-09-07, ET C'ÉTAIT UNE SPIRALE. Après l'import, la dernière position connue
   * d'un boîtier est celle de la source, ailleurs et à une autre heure. La première trame rejouée
   * est donc un saut, elle est rejetée — donc la position connue ne bouge pas — donc la suivante
   * est rejetée aussi, indéfiniment. Résultat : 42 positions acceptées en cinq minutes pour
   * trente-sept véhicules, une carte figée, et une coupure moteur qui ne pouvait plus être
   * confirmée faute de trame.
   *
   * On ne désarme PAS la garde : on supprime le saut. Le boîtier est replacé une fois, en base,
   * sur le point de sa trace correspondant à l'heure courante ; tout ce qui suit est la trace
   * réelle, donc continu par construction. Un replacement, et non un déplacement : aucune ligne
   * de `positions` n'est écrite, c'est l'état du boîtier qu'on aligne.
   */
  private async repositionner(b: Boitier, local: InstantLocal): Promise<void> {
    // Le point de la trace où le véhicule se trouve à cette heure-ci…
    const ancre =
      (await this.prisma.demoReplayFrame.findFirst({
        where: { imei: b.imei, weekday: local.weekday, secondOfDay: { lte: local.secondOfDay } },
        orderBy: { secondOfDay: 'desc' },
      })) ??
      // …ou, avant le premier point du jour (la nuit, tôt le matin), son point de DÉPART. Sans ce
      // repli, le boîtier resterait sur sa position d'import jusqu'au début de la tournée, et la
      // première trame de celle-ci serait de nouveau un saut infaisable — la spirale reviendrait
      // chaque matin.
      (await this.prisma.demoReplayFrame.findFirst({
        where: { imei: b.imei, weekday: local.weekday },
        orderBy: { secondOfDay: 'asc' },
      }));
    if (!ancre) return;
    const quand = new Date();
    await this.prisma.tracker.update({
      where: { id: b.trackerId },
      data: {
        lastLat: ancre.lat,
        lastLng: ancre.lng,
        lastHeading: ancre.heading,
        lastSpeedKmh: 0,
        lastValid: true,
        lastIgnition: ancre.ignition ?? false,
        lastKnownIgnition: ancre.ignition ?? false,
        lastPositionAt: quand,
        lastValidFrameAt: quand,
        lastSeenAt: quand,
        status: 'ONLINE',
      },
    });
    b.derniere = {
      lat: ancre.lat,
      lng: ancre.lng,
      heading: ancre.heading,
      altitude: ancre.altitude ?? undefined,
      ignition: ancre.ignition ?? undefined,
    };
    b.dernierDeviceTimeMs = quand.getTime();
    b.derniereEmissionMs = Date.now();
    this.logger.log(`[DÉMO] ${b.imei} replacé sur sa trace (jour ${local.weekday}, seconde ${ancre.secondOfDay})`);
  }

  private async emettreBattement(b: Boitier, maintenant: Date, ignition: boolean | undefined): Promise<void> {
    if (!b.derniere) return;
    await this.emettre(b, { ...b.derniere, ignition }, 0, true, maintenant);
  }

  private async emettre(
    b: Boitier,
    position: DernierePosition,
    vitesseKmh: number,
    valide: boolean,
    deviceTime: Date,
  ): Promise<void> {
    // Croissance stricte du `deviceTime` (garde anti-rejeu de l'ingestion) : une trame datée au
    // même instant que la précédente serait jetée comme un doublon. Une seconde de plus suffit.
    let quand = deviceTime.getTime();
    if (quand <= b.dernierDeviceTimeMs) quand = b.dernierDeviceTimeMs + 1000;

    const trame: CobanPositionFrame = {
      type: 'position',
      imei: b.imei,
      alarm: 'none',
      deviceTime: new Date(quand),
      valid: valide,
      latitude: position.lat,
      longitude: position.lng,
      speedKph: Math.round(vitesseKmh * 100) / 100,
      course: Math.round(position.heading * 100) / 100,
      altitude: position.altitude,
      ignition: position.ignition,
      raw: '[demo]',
    };
    try {
      await this.positions.ingest(trame);
      b.derniere = position;
      b.derniereEmissionMs = Date.now();
      b.dernierDeviceTimeMs = quand;
    } catch (err) {
      this.logger.error(`[DÉMO] ingestion refusée pour ${b.imei} : ${(err as Error)?.message ?? err}`);
    }
  }

  private planifier(ms: number, action: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void action().catch((e) => this.logger.error(`[DÉMO] action différée en échec : ${(e as Error)?.message ?? e}`));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.add(timer);
  }
}
