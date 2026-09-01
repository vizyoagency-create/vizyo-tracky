import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertSeverity, AlertType, UserRole } from '@prisma/client';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { soupconsAccident, SILENCE_MIN_MS, type EtatBoitier } from './detection-accident.shared';

/**
 * Veille ACCIDENT — le boîtier roulait, puis s'est tu.
 *
 * ── Pourquoi un balayage périodique, et pas une réaction à la trame ──────────────────
 *
 * Toutes les autres alertes naissent d'une trame reçue. Celle-ci naît d'une trame qui
 * N'ARRIVE PAS. Une absence ne se remarque qu'en la cherchant : il n'existe aucun événement
 * sur lequel se brancher. D'où le balayage.
 *
 * ── Pourquoi toutes les 15 minutes, alors que le seuil est de 2 heures ───────────────
 *
 * Le seuil décide de ce qui est anormal ; la période décide du retard à l'annonce. Un
 * balayage horaire ajouterait jusqu'à une heure aux deux heures de silence. Quinze minutes
 * coûtent une requête par quart d'heure et bornent le retard au même quart d'heure.
 *
 * ── Restriction aux super-administrateurs, et ce qu'elle n'est pas ───────────────────
 *
 * L'alerte est CRÉÉE, visible et consultable par qui a le droit de la voir. Seule la
 * NOTIFICATION est restreinte. La différence est celle qui a déjà été tranchée pour les
 * coupures d'alimentation : supprimer l'alerte fabriquerait une cécité à la place d'un
 * bruit. Ici la raison est plus forte encore — cette règle n'a JAMAIS été validée sur un
 * vrai accident, faute d'en avoir un dans les données conservées. On sait qu'elle ne crie
 * pas à tort ; on ignore encore si elle crie à temps. Réveiller un client sur cette base
 * serait prématuré.
 */
@Injectable()
export class DetectionAccidentService {
  private readonly logger = new Logger(DetectionAccidentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async balayer(): Promise<void> {
    try {
      // TRK-054 — la rétractation D'ABORD. Une alerte dont le boîtier est déjà revenu ne
      // doit pas survivre le temps d'un examen, et l'ordre rend la trace lisible : ce qui
      // se referme se referme avant que ce qui s'ouvre s'ouvre.
      const retractees = await this.retracterLesRevenus();
      const soupcons = await this.examiner();
      for (const s of soupcons) {
        await this.poserAlerte(s);
      }
      if (soupcons.length > 0) {
        this.logger.warn(`[ACCIDENT] ${soupcons.length} boîtier(s) muet(s) après avoir roulé`);
      }
      if (retractees > 0) {
        this.logger.warn(`[ACCIDENT] ${retractees} alerte(s) rétractée(s) — le boîtier a repris`);
      }
    } catch (err) {
      // La veille ne doit jamais faire tomber le processus qu'elle surveille.
      this.logger.error(`Veille accident interrompue : ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * ── TRK-054 — LE CHEMIN DE RETOUR, qui n'existait pas ────────────────────────────────
   *
   * Cette veille affirmait sans jamais se dédire. Le 31/08, sa PREMIÈRE et SEULE alerte de
   * toute l'histoire du parc était un faux positif : HD-779-MA, annoncé « boîtier muet après
   * avoir roulé à 113 km/h » à 17:30, avait simplement traversé une zone blanche près de la
   * frontière espagnole. Il est revenu à 20:00 avec une rafale de 686 trames — un vidage de
   * tampon — et il roule encore : ONLINE, batterie 100 %, à ~180 km du point de l'alerte.
   * **L'alerte CRITICAL, elle, est restée ouverte.**
   *
   * Le défaut n'était donc pas le déclenchement — la règle a fait exactement ce qu'elle
   * annonce — mais l'absence de tout mécanisme pour la reprendre. Le dispositif savait
   * pourtant déjà le faire : `PowerCutRecheckService.refermer()` annule un soupçon
   * d'alimentation dès que le contact revient. Ceci en est la symétrique.
   *
   * ⚠️ POURQUOI LE SEUIL DE 2 h N'A PAS ÉTÉ RELEVÉ. La solution tentante était de porter
   * `SILENCE_MIN_MS` à six heures : sur le seul cas connu, ça suffisait, puisque le boîtier
   * est revenu à 4 h 40. Elle est refusée. **On ne ralentit pas un filet de sécurité pour
   * corriger un défaut d'affichage** — un accident annoncé six heures après n'est plus une
   * alerte, c'est un constat. Le coût d'un faux positif rétracté au bout de deux heures est
   * sans commune mesure avec celui d'un vrai accident annoncé quatre heures trop tard, et la
   * notification est de toute façon restreinte aux super-administrateurs.
   *
   * ⚠️ ON REFERME, ON N'EFFACE PAS. `acknowledgedAt` est posé — c'est la seule clôture que
   * porte le modèle — mais `acknowledgedBy` reste NUL : personne n'a acquitté, c'est le
   * système qui se dédit, et la distinction doit rester lisible. Le motif est écrit dans
   * `payload.retractation` avec l'heure du retour et la durée réelle du silence. *Une alerte
   * qu'on retire sans dire pourquoi apprend à l'exploitant à ne plus les croire.*
   */
  async retracterLesRevenus(maintenant = new Date()): Promise<number> {
    const ouvertes = await this.prisma.alert.findMany({
      where: { type: AlertType.ACCIDENT, acknowledgedAt: null, trackerId: { not: null } },
      select: { id: true, trackerId: true, createdAt: true, payload: true },
    });
    if (ouvertes.length === 0) return 0;

    let retractees = 0;
    for (const a of ouvertes) {
      const ancien =
        a.payload && typeof a.payload === 'object' && !Array.isArray(a.payload)
          ? (a.payload as Record<string, unknown>)
          : {};

      /**
       * 🔴 LA GARDE LA PLUS IMPORTANTE DE CETTE MÉTHODE — et elle a failli manquer.
       *
       * Le type `ACCIDENT` a DEUX émetteurs, et ils n'ont rien à voir :
       *
       *   1. cette veille-ci, qui infère un accident d'un SILENCE (`detection: 'telemetrie'`) ;
       *   2. le chemin des trames, quand le boîtier envoie son alarme `accident` — le
       *      CAPTEUR DE CHOC, qui mesure une décélération réelle.
       *
       * Rétracter « parce que le boîtier a réémis » n'a de sens que pour le premier. Sur le
       * second, c'est l'inverse : un boîtier qui signale un choc CONTINUE d'émettre, par
       * construction. Une rétractation aveugle refermerait donc automatiquement, en moins de
       * trente minutes, **toutes les alertes de choc réelles** — en écrivant noir sur blanc
       * « aucun choc confirmé » sur la seule alerte du système qui en ait mesuré un.
       *
       * *Le correctif d'un faux positif ne doit jamais pouvoir éteindre un vrai positif.*
       */
      if (ancien.detection !== 'telemetrie') continue;

      const t = await this.prisma.tracker.findUnique({
        where: { id: a.trackerId! },
        select: { lastSeenAt: true, lastBatteryPercent: true, vehicle: { select: { plate: true } } },
      });
      // Pas de trame postérieure à l'alerte : le silence dure, l'alerte reste. C'est le cas
      // normal, et c'est celui qu'il ne faut surtout pas refermer.
      if (!t?.lastSeenAt || t.lastSeenAt <= a.createdAt) continue;

      const repriseA = t.lastSeenAt;
      const silenceMin = Math.round((repriseA.getTime() - a.createdAt.getTime()) / 60_000);
      const batterie = t.lastBatteryPercent;
      const motif =
        `Rétractée automatiquement : le boîtier a repris l'émission le ` +
        `${repriseA.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}, ` +
        `soit ${silenceMin} min après cette alerte` +
        (batterie != null ? `, batterie à ${batterie} %` : '') +
        `. Aucun choc confirmé — un boîtier arraché ou écrasé ne revient pas.`;

      const maj = await this.prisma.alert.update({
        where: { id: a.id },
        data: {
          // Seule clôture que porte le modèle. `acknowledgedBy` reste NUL : c'est le
          // système qui se dédit, pas un exploitant qui a traité.
          acknowledgedAt: maintenant,
          payload: {
            ...ancien,
            retractation: {
              motif,
              repriseA: repriseA.toISOString(),
              silenceApresAlerteMin: silenceMin,
              batteriePct: batterie ?? null,
              par: 'detection-accident/retractation',
            },
          } as never,
        },
        include: { vehicle: true, tracker: true },
      });

      this.gateway.broadcastAlertAcknowledged(maj);
      this.logger.warn(
        `[ACCIDENT] rétractation ${t.vehicle?.plate ?? a.trackerId} — reprise après ${silenceMin} min` +
          (batterie != null ? `, batterie ${batterie} %` : ''),
      );
      retractees += 1;
    }
    return retractees;
  }

  /** Lit l'état du parc et applique la règle pure. Séparé du cron pour être testable. */
  async examiner(maintenant = new Date()) {
    const maintenantMs = maintenant.getTime();
    // On ne considère QUE les boîtiers dont le silence a déjà atteint le seuil : inutile de
    // rapatrier le parc entier pour n'en garder qu'une poignée.
    const limite = new Date(maintenantMs - SILENCE_MIN_MS);
    const trackers = await this.prisma.tracker.findMany({
      where: {
        lastSeenAt: { not: null, lt: limite },
        vehicleId: { not: null },
        // Un vehicule DEJA declare accidente n'a pas a redeclencher la veille accident : on
        // annoncerait un accident deja connu, et l'alerte perdrait son sens d'urgence.
        vehicle: { outOfServiceReason: null },
      },
      select: {
        id: true,
        lastSeenAt: true,
        lastLat: true,
        lastLng: true,
        vehicle: { select: { id: true, plate: true, fleetId: true } },
      },
    });
    if (trackers.length === 0) return [];

    // La vitesse vient du dernier POINT, pas du tracker : c'est la seule source qui dise à
    // quelle allure il roulait quand il s'est tu.
    const etats: EtatBoitier[] = [];
    for (const t of trackers) {
      const dernier = await this.prisma.position.findFirst({
        where: { trackerId: t.id, valid: true },
        orderBy: { timestamp: 'desc' },
        select: { speedKmh: true },
      });
      // Une alerte déjà posée depuis le début du silence : on ne répète pas. Sans cette
      // garde, un boîtier définitivement mort produirait une alerte CRITIQUE toutes les
      // demi-heures, indéfiniment — le déluge qu'on vient de corriger ailleurs.
      const dejaAlerte =
        (await this.prisma.alert.count({
          where: {
            trackerId: t.id,
            type: AlertType.ACCIDENT,
            createdAt: { gte: t.lastSeenAt! },
          },
        })) > 0;
      etats.push({
        trackerId: t.id,
        plaque: t.vehicle?.plate ?? null,
        derniereTrameA: t.lastSeenAt,
        derniereVitesseKmh: dernier?.speedKmh ?? null,
        lat: t.lastLat,
        lng: t.lastLng,
        dejaAlerte,
      });
    }
    const soupcons = soupconsAccident(etats, maintenantMs);
    // On rattache la société et le véhicule, nécessaires à la création de l'alerte.
    return soupcons
      .map((s) => {
        const t = trackers.find((x) => x.id === s.trackerId);
        return t?.vehicle ? { ...s, vehicleId: t.vehicle.id, fleetId: t.vehicle.fleetId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  private async poserAlerte(s: {
    trackerId: string;
    vehicleId: string;
    fleetId: string;
    plaque: string | null;
    derniereVitesseKmh: number;
    silenceMs: number;
    lat: number | null;
    lng: number | null;
    constat: string;
  }): Promise<void> {
    const alert = await this.prisma.alert.create({
      data: {
        fleetId: s.fleetId,
        vehicleId: s.vehicleId,
        trackerId: s.trackerId,
        type: AlertType.ACCIDENT,
        severity: AlertSeverity.CRITICAL,
        // Le titre annonce ce qu'on a VU. « Accident détecté » serait une promesse que la
        // règle ne tient pas : elle observe un silence après une vitesse, pas un choc.
        title: `🚨 Boîtier muet après avoir roulé — ${s.plaque ?? 'véhicule'}`,
        message: s.constat,
        payload: {
          detection: 'telemetrie',
          derniereVitesseKmh: s.derniereVitesseKmh,
          silenceH: Number((s.silenceMs / 3_600_000).toFixed(1)),
        } as never,
        latitude: s.lat,
        longitude: s.lng,
      },
      include: { vehicle: true, tracker: true },
    });

    this.gateway.broadcastAlert(alert);

    // ⚠️ RESTRICTION VOLONTAIRE ET PROVISOIRE. Cf. l'en-tête de cette classe : l'alerte
    // existe pour tout le monde, la notification ne part qu'aux super-administrateurs, le
    // temps de vérifier sur le terrain que la règle dit vrai. La liste est résolue ici et
    // passée explicitement — le dispatcher applique ensuite son chemin normal, sans
    // exception : permissions, périmètre véhicule, préférences, plafond, journal.
    const superAdmins = await this.prisma.user.findMany({
      where: { role: UserRole.SUPER_ADMIN, isActive: true },
      select: { id: true },
    });
    this.dispatch
      .dispatchAlert(alert, { restreindreAuxUtilisateurs: superAdmins.map((u) => u.id) })
      .catch((err) => {
        this.logger.warn(
          `Notification accident ${alert.id} non partie : ${err instanceof Error ? err.message : err}`,
        );
      });
  }
}
