import { GoneException, Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TripShareDuration } from '@prisma/client';
import {
  TRIP_SHARE_MAX_ACTIFS_PAR_TRAJET,
  type PartageTrajetPublicDto,
  type TripShareCreatedDto,
  type TripShareDurationDto,
  type TripShareLinkAvecTrajetDto,
  type TripShareLinkDto,
} from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { genererTokenPartage, tronquerAdresse } from '../depot/share-token';
import { vitesseMoyenneTrajet } from '../common/vitesse-moyenne';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARTAGE PUBLIC D'UN TRAJET
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ┌─ LE DÉFAUT QU'IL FERME ────────────────────────────────────────────────────────────────┐
 * │ Le bouton « Partager » du replay copiait l'URL INTERNE de l'application. Envoyée au     │
 * │ conducteur concerné — qui n'a pas de compte Tracky — elle affichait un écran de         │
 * │ connexion. L'écran annonçait pourtant « Lien copié », donc l'utilisateur envoyait un    │
 * │ lien mort en croyant avoir partagé.                                                     │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ TROIS RÈGLES REPRISES DU SUIVI DE LIVRAISON (lot A4), MOT POUR MOT ───────────────────┐
 * │                                                                                        │
 * │ 1. LE TEMPS EST LE SEUL VERROU. Le destinataire est une adresse à qui on a envoyé une  │
 * │    URL : il n'y a pas d'authentification à faire échouer. L'expiration est calculée à   │
 * │    la création, jamais prolongeable, vérifiée à l'heure SERVEUR à chaque requête.       │
 * │                                                                                        │
 * │ 2. `410` UNIFORME. Expiré, révoqué, inexistant : même code, même corps. Distinguer      │
 * │    permettrait d'énumérer — et « ce token a existé » est déjà une information.          │
 * │                                                                                        │
 * │ 3. LA LISTE EST LE CONTRAT. Ce que `versDtoPublic` n'écrit pas ne sort pas. Ni société, │
 * │    ni conducteur, ni les autres trajets du véhicule.                                    │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ ET UNE QUATRIÈME, PROPRE À CE LOT : RIEN DE FANTÔME. Chaque lien est visible par la
 * société qui l'a ouvert, avec son auteur, son échéance et son usage. Un accès public que
 * personne ne voit est un accès que personne ne révoque.
 */
/** Au-delà, on ne lit plus : une route publique ne doit pas pouvoir faire travailler la base. */
const MAX_POINTS_LUS = 20_000;
/** Ce qu'on envoie au navigateur du destinataire — décimé, indiscernable à l'œil. */
const MAX_POINTS_SERVIS = 1_500;

@Injectable()
export class TripShareService {
  private readonly logger = new Logger(TripShareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly systemActivity: SystemActivityService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  /**
   * Crée un lien public sur un trajet.
   *
   * ⚠️ LE PÉRIMÈTRE EST VÉRIFIÉ ICI, PAS DANS LE CONTRÔLEUR. Partager, c'est ouvrir un accès
   * SANS authentification : c'est le geste le plus sensible du produit après la suppression.
   * Il ne doit pas dépendre d'un décorateur qu'un refactor pourrait déplacer.
   */
  async creer(
    user: AuthUser,
    tripId: string,
    duree: TripShareDurationDto,
  ): Promise<TripShareCreatedDto> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { id: true, fleetId: true, vehicleId: true, vehicle: { select: { plate: true, privacyModeEnabled: true } } },
    });
    if (!trip || !trip.fleetId) throw new NotFoundException('Trajet introuvable');
    await this.verifierPerimetre(user, trip.fleetId, trip.vehicleId);

    /**
     * ⚠️ LE MODE VIE PRIVÉE INTERDIT LE PARTAGE, et ce n'est pas une précaution de plus.
     * Ce mode existe pour qu'un trajet ne soit PAS regardé ; en publier le tracé sur une URL
     * sans authentification viderait le réglage de son sens, et le ferait par le chemin le
     * plus difficile à rattraper — un lien déjà envoyé.
     */
    if (trip.vehicle?.privacyModeEnabled) {
      throw new BadRequestException(
        'Ce véhicule est en mode vie privée : ses trajets ne peuvent pas être partagés publiquement.',
      );
    }

    const maintenant = new Date();
    /**
     * ⚠️ LE PLAFOND SE COMPTE SUR LES LIENS VIVANTS, pas sur l'historique. Sans lui, un trajet
     * finit avec quinze liens ouverts dont personne ne sait à qui ils ont été envoyés ; avec
     * lui, re-partager oblige à révoquer, donc à REGARDER la liste. C'est la borne qui rend
     * l'écran de surveillance utile plutôt que décoratif.
     */
    const actifs = await this.prisma.tripShareLink.count({
      where: { tripId, revokedAt: null, expiresAt: { gt: maintenant } },
    });
    if (actifs >= TRIP_SHARE_MAX_ACTIFS_PAR_TRAJET) {
      throw new BadRequestException(
        `Ce trajet a déjà ${TRIP_SHARE_MAX_ACTIFS_PAR_TRAJET} liens de partage actifs. Révoquez-en un avant d'en créer un autre.`,
      );
    }

    const lien = await this.prisma.tripShareLink.create({
      data: {
        tripId,
        fleetId: trip.fleetId,
        token: genererTokenPartage(),
        createdByUserId: user.id,
        duration: duree as TripShareDuration,
        expiresAt: new Date(maintenant.getTime() + this.dureeEnMs(duree)),
      },
      include: { createdBy: { select: { firstName: true, lastName: true, email: true } } },
    });

    /**
     * ⚠️ TRACÉ DANS L'ACTIVITÉ SYSTÈME. Ouvrir un accès public est une DÉCISION, pas une
     * consultation : elle doit se retrouver des mois plus tard, y compris si le lien a été
     * révoqué depuis et que sa ligne a été purgée.
     */
    this.systemActivity.record({
      category: 'EXPORT',
      action: 'trip_share_created',
      status: 'SUCCESS',
      actor: this.nomDe(lien.createdBy) ?? user.email ?? 'utilisateur',
      target: trip.vehicle?.plate ?? tripId,
      fleetId: trip.fleetId,
      triggeredByUserId: user.id,
      meta: { tripId, duration: duree, expiresAt: lien.expiresAt.toISOString() },
    });

    const base = this.config.get('APP_BASE_URL', { infer: true });
    return {
      ...this.versDto(lien, maintenant),
      token: lien.token,
      url: `${base}/t/${lien.token}`,
    };
  }

  /** Les liens d'un trajet, du plus récent au plus ancien. */
  async listerPourTrajet(user: AuthUser, tripId: string): Promise<TripShareLinkDto[]> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { fleetId: true, vehicleId: true },
    });
    if (!trip || !trip.fleetId) throw new NotFoundException('Trajet introuvable');
    await this.verifierPerimetre(user, trip.fleetId, trip.vehicleId);

    const liens = await this.prisma.tripShareLink.findMany({
      where: { tripId },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { firstName: true, lastName: true, email: true } } },
    });
    const maintenant = new Date();
    return liens.map((l) => this.versDto(l, maintenant));
  }

  /**
   * ── L'ÉCRAN DE SURVEILLANCE ────────────────────────────────────────────────────────────
   *
   * Tous les liens de la société, le plus urgent d'abord. C'est la réponse à « je ne veux
   * rien qui soit transparent et fantôme » : un accès public qui n'apparaît nulle part est un
   * accès que personne ne pense à couper.
   *
   * ⚠️ LES LIENS MORTS SONT SERVIS AUSSI, et c'est volontaire. Une liste qui ne montre que
   * l'actif ne répond pas à « qu'est-ce qui a été partagé la semaine dernière, et par qui ? ».
   * Ils sont marqués `active: false` ; l'écran les range à part.
   */
  async listerPourSociete(user: AuthUser, fleetId: string): Promise<TripShareLinkAvecTrajetDto[]> {
    await this.verifierPerimetre(user, fleetId, null);

    const liens = await this.prisma.tripShareLink.findMany({
      where: { fleetId },
      orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { expiresAt: 'desc' }],
      take: 200,
      include: {
        createdBy: { select: { firstName: true, lastName: true, email: true } },
        trip: {
          select: {
            startedAt: true, endedAt: true, distanceKm: true,
            vehicle: { select: { plate: true } },
          },
        },
      },
    });
    const maintenant = new Date();
    return liens.map((l) => ({
      ...this.versDto(l, maintenant),
      trip: l.trip
        ? {
            startedAt: l.trip.startedAt.toISOString(),
            endedAt: l.trip.endedAt?.toISOString() ?? null,
            distanceKm: Math.round((l.trip.distanceKm ?? 0) * 10) / 10,
            plate: l.trip.vehicle?.plate ?? '—',
          }
        : null,
    }));
  }

  /** Révocation immédiate. Le lien cesse de fonctionner à la requête suivante. */
  async revoquer(user: AuthUser, id: string): Promise<void> {
    const lien = await this.prisma.tripShareLink.findUnique({
      where: { id },
      select: { id: true, fleetId: true, tripId: true, revokedAt: true, trip: { select: { vehicleId: true, vehicle: { select: { plate: true } } } } },
    });
    if (!lien) throw new NotFoundException('Lien introuvable');
    await this.verifierPerimetre(user, lien.fleetId, lien.trip?.vehicleId ?? null);
    // Révoquer deux fois n'est pas une erreur : le geste est le même, l'état voulu aussi.
    if (lien.revokedAt) return;

    await this.prisma.tripShareLink.update({
      where: { id },
      data: { revokedAt: new Date(), revokedByUserId: user.id },
    });

    this.systemActivity.record({
      category: 'EXPORT',
      action: 'trip_share_revoked',
      status: 'SUCCESS',
      actor: user.email ?? 'utilisateur',
      target: lien.trip?.vehicle?.plate ?? lien.tripId,
      fleetId: lien.fleetId,
      triggeredByUserId: user.id,
      meta: { tripId: lien.tripId, shareId: id },
    });
  }

  /**
   * ── LA CONSULTATION PUBLIQUE ───────────────────────────────────────────────────────────
   *
   * Aucune authentification. Le token EST le justificatif, et le temps est le seul verrou.
   */
  async consulterPublic(token: string, adresseAppelant?: string): Promise<PartageTrajetPublicDto> {
    const lien = await this.prisma.tripShareLink.findUnique({
      where: { token },
      select: {
        id: true, expiresAt: true, revokedAt: true,
        trip: {
          select: {
            startedAt: true, endedAt: true, durationSeconds: true, movingSeconds: true,
            distanceKm: true, maxSpeed: true, trackerId: true,
            vehicle: { select: { plate: true, privacyModeEnabled: true } },
          },
        },
      },
    });

    const maintenant = new Date();
    /**
     * ⚠️ UN SEUL `410`, POUR QUATRE CAUSES. Inexistant, expiré, révoqué, ou véhicule passé en
     * mode vie privée DEPUIS le partage : le destinataire reçoit exactement la même réponse.
     * Distinguer « ce token n'existe pas » de « ce token a expiré » permettrait d'énumérer.
     *
     * ⚠️ LA VIE PRIVÉE EST REVÉRIFIÉE À CHAQUE OUVERTURE, pas seulement à la création. Un
     * gestionnaire qui bascule un véhicule en vie privée doit couper les liens déjà envoyés —
     * sinon le réglage ne vaut que pour l'avenir, ce qui n'est pas ce qu'il promet.
     */
    if (
      !lien || !lien.trip || lien.revokedAt || lien.expiresAt <= maintenant
      || lien.trip.vehicle?.privacyModeEnabled
    ) {
      throw new GoneException('Ce lien de partage n\'est plus valide.');
    }

    // Le suivi d'usage, en tâche de fond : il alimente la révocation éclairée.
    void this.enregistrerOuverture(lien.id, adresseAppelant);

    const t = lien.trip;
    const distanceKm = Math.round((t.distanceKm ?? 0) * 10) / 10;
    const maxSpeedKmh = Math.round(t.maxSpeed ?? 0);
    return {
      plate: t.vehicle?.plate ?? '—',
      startedAt: t.startedAt.toISOString(),
      endedAt: t.endedAt?.toISOString() ?? null,
      durationSeconds: t.durationSeconds ?? 0,
      distanceKm,
      /**
       * ⚠️ LA MÊME DÉFINITION QUE PARTOUT : distance ÷ temps ROULANT. Un destinataire qui
       * compare ce chiffre à celui que le gestionnaire lui a lu au téléphone doit lire le
       * même nombre — sinon c'est le produit qui a l'air de se contredire.
       */
      avgSpeedKmh: Math.round(vitesseMoyenneTrajet({
        distanceKm,
        movingSec: t.movingSeconds ?? 0,
        durationSec: t.durationSeconds ?? 0,
        maxSpeedKmh,
      })),
      maxSpeedKmh,
      ...(await this.trace(t.trackerId, t.startedAt, t.endedAt)),
      expiresAt: lien.expiresAt.toISOString(),
    };
  }

  // ═══ Interne ═══════════════════════════════════════════════════════════════════════════

  /**
   * ── LE TRACÉ ───────────────────────────────────────────────────────────────────────────
   *
   * Les positions du boîtier entre le départ et l'arrivée. Le trajet ne porte pas son tracé :
   * il est reconstitué depuis `Position`, comme le fait le replay de l'application.
   *
   * ⚠️ PLAFONNÉ ET DÉCIMÉ. Un trajet de six heures peut porter plusieurs milliers de points ;
   * les servir tous sur une route PUBLIQUE et sans authentification offrirait à qui trouve un
   * token un moyen de faire travailler la base. Un tracé décimé à 1 500 points se superpose au
   * tracé complet à l'œil nu — c'est une carte, pas une pièce d'expertise.
   *
   * ⚠️ `valid: true` : les trames aberrantes sont écartées ici comme partout ailleurs. Un
   * point à l'autre bout du département tirerait une ligne droite en travers de la carte, et
   * le destinataire n'a personne à qui demander si c'est normal.
   *
   * ⚠️ LA VITESSE SUIT CHAQUE POINT, AU MÊME INDEX. Le tracé est coloré par bande de vitesse
   * comme le rejeu de l'application ; les deux listes sont décimées du même pas, par la même
   * boucle — une vitesse décalée d'un index peindrait l'autoroute en vert et la ville en
   * rouge. Entière : un destinataire n'a que faire de 88,6 km/h.
   */
  private async trace(
    trackerId: string | null,
    debut: Date,
    fin: Date | null,
  ): Promise<{ path: [number, number][]; speedsKmh: number[] }> {
    if (!trackerId) return { path: [], speedsKmh: [] };
    const positions = await this.prisma.position.findMany({
      where: {
        trackerId,
        valid: true,
        timestamp: { gte: debut, ...(fin ? { lte: fin } : {}) },
      },
      orderBy: { timestamp: 'asc' },
      select: { lat: true, lng: true, speedKmh: true },
      take: MAX_POINTS_LUS,
    });

    const pas = Math.max(1, Math.ceil(positions.length / MAX_POINTS_SERVIS));
    const path: [number, number][] = [];
    const speedsKmh: number[] = [];
    const servir = (p: { lat: number; lng: number; speedKmh: number | null }): void => {
      path.push([p.lng, p.lat]);
      speedsKmh.push(Number.isFinite(p.speedKmh) ? Math.max(0, Math.round(p.speedKmh as number)) : 0);
    };
    for (let i = 0; i < positions.length; i += pas) {
      const p = positions[i]!;
      if (Number.isFinite(p.lng) && Number.isFinite(p.lat)) servir(p);
    }
    // Le DERNIER point est toujours servi : sans lui, le tracé s'arrête avant l'arrivée, ce
    // qui se voit — et fait douter du reste.
    const dernier = positions[positions.length - 1];
    if (dernier && (path.length === 0 || path[path.length - 1]![0] !== dernier.lng || path[path.length - 1]![1] !== dernier.lat)) {
      servir(dernier);
    }
    return { path, speedsKmh };
  }

  /**
   * Le périmètre : la société de l'appelant, ET son périmètre véhicule s'il en a un.
   *
   * ⚠️ `404` ET NON `403`, dans les deux cas. Un utilisateur borné à trois véhicules n'a pas à
   * apprendre que les autres existent — même raisonnement que le `410` uniforme du chemin
   * public. Distinguer « ça n'existe pas » de « vous n'y avez pas droit » permet d'énumérer.
   *
   * ⚠️ LE PÉRIMÈTRE VÉHICULE PASSE PAR `VehicleAccessService`, pas par un champ du jeton :
   * c'est lui qui résout les accès par GROUPE, et un contrôle qui l'ignorerait laisserait
   * partager le trajet d'un véhicule qu'on n'a pas le droit de regarder.
   */
  private async verifierPerimetre(user: AuthUser, fleetId: string, vehicleId: string | null): Promise<void> {
    if (user.role !== 'SUPER_ADMIN' && user.fleetId !== fleetId) {
      throw new NotFoundException('Trajet introuvable');
    }
    if (!vehicleId) return;
    const perimetre = await this.vehicleAccess.getAccessibleVehicleIds(user);
    if (perimetre !== 'ALL' && !perimetre.includes(vehicleId)) {
      throw new NotFoundException('Trajet introuvable');
    }
  }

  private dureeEnMs(duree: TripShareDurationDto): number {
    switch (duree) {
      case 'HOUR_1': return 3_600_000;
      case 'DAY_7': return 7 * 24 * 3_600_000;
      case 'HOUR_24':
      default: return 24 * 3_600_000;
    }
  }

  private nomDe(u: { firstName?: string | null; lastName?: string | null; email?: string | null } | null): string | null {
    if (!u) return null;
    const nom = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return nom || u.email || null;
  }

  private versDto(
    lien: {
      id: string; tripId: string; duration: TripShareDuration; expiresAt: Date; createdAt: Date;
      openCount: number; firstOpenedAt: Date | null; lastOpenedAt: Date | null;
      lastOpenedFrom: string | null; revokedAt: Date | null;
      createdBy?: { firstName: string | null; lastName: string | null; email: string | null } | null;
    },
    maintenant: Date,
  ): TripShareLinkDto {
    return {
      id: lien.id,
      tripId: lien.tripId,
      duration: lien.duration as TripShareDurationDto,
      expiresAt: lien.expiresAt.toISOString(),
      createdAt: lien.createdAt.toISOString(),
      createdByName: this.nomDe(lien.createdBy ?? null),
      openCount: lien.openCount,
      firstOpenedAt: lien.firstOpenedAt?.toISOString() ?? null,
      lastOpenedAt: lien.lastOpenedAt?.toISOString() ?? null,
      lastOpenedFrom: lien.lastOpenedFrom,
      revokedAt: lien.revokedAt?.toISOString() ?? null,
      active: !lien.revokedAt && lien.expiresAt > maintenant,
    };
  }

  /**
   * Le suivi d'usage, BEST-EFFORT.
   *
   * ⚠️ Un échec d'écriture ne doit JAMAIS empêcher le destinataire de voir son trajet : il
   * n'y peut rien, et le compteur n'est pas ce qu'il est venu chercher.
   */
  private async enregistrerOuverture(lienId: string, adresse?: string): Promise<void> {
    try {
      const maintenant = new Date();
      await this.prisma.tripShareLink.update({
        where: { id: lienId },
        data: {
          openCount: { increment: 1 },
          lastOpenedAt: maintenant,
          lastOpenedFrom: tronquerAdresse(adresse),
        },
      });
      // `firstOpenedAt` ne se pose qu'une fois : un `update` conditionnel plutôt qu'un `set`
      // qui écraserait la première ouverture à chaque visite.
      await this.prisma.tripShareLink.updateMany({
        where: { id: lienId, firstOpenedAt: null },
        data: { firstOpenedAt: maintenant },
      });
    } catch (e) {
      this.logger.warn(`suivi d'ouverture du partage ${lienId} : ${(e as Error)?.message ?? e}`);
    }
  }
}
