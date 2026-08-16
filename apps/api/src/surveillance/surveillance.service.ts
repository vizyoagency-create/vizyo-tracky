import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SurveillanceEventStatus,
  SurveillanceMode,
  SurveillanceSensitivity,
  UserRole,
} from '@prisma/client';
import type {
  SurveillanceEvent,
  SurveillanceEventTrigger,
  SurveillanceProfile,
} from '@prisma/client';
import {
  DORMANT_STOP_ACTING_MS,
  formatSilenceLabel,
  isVehicleDormant,
  trackerSilenceMs,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { TrackerCommandsService } from '../tracker-commands/tracker-commands.service';
import {
  AcknowledgeEventDto,
  UpdateSurveillanceProfileDto,
} from './surveillance.dto';
import { mapSensitivityToCobanLevel } from './surveillance.helpers';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

/** Anti-flood : le scheduler retente CHAQUE minute un tracker offline. On ne journalise
 *  un échec PLANIFIÉ qu'au plus une fois par heure et par (profil, action). */
const SCHEDULED_FAILURE_THROTTLE_MS = 60 * 60 * 1000;

interface ListEventsFilters {
  vehicleId?: string;
  status?: SurveillanceEventStatus;
  limit?: number;
  cursor?: string;
}

/** Boîtier tel que ce service en a besoin : son id (commandes) et sa dernière parole. */
type TrackerLiveness = { id: string; lastSeenAt: Date | null } | null;

/**
 * VÉRACITÉ DE LA PROTECTION — champs DÉRIVÉS au read-time, joints au profil renvoyé.
 *
 * Aucune colonne en base, aucun drapeau : tout se recalcule à chaque lecture et
 * s'inverse seul dès que le boîtier réémet. `currentlyArmed` n'est JAMAIS réécrit ici —
 * prétendre « désarmé » sur un boîtier injoignable serait aussi mensonger que le
 * prétendre « protégé ». On DATE l'information, on ne la remplace pas.
 */
export interface SurveillanceLivenessFields {
  /** null = aucun boîtier affecté au véhicule (véhicule non équipé). */
  trackerId: string | null;
  /** Dernier signal reçu du boîtier. null = jamais émis (jamais installé / SIM KO). */
  trackerLastSeenAt: Date | null;
  /** Silence en ms, null si le boîtier n'a jamais parlé ou n'existe pas. */
  trackerSilenceMs: number | null;
  /** « 45 min » / « 5 h » / « 89 j » — libellé prêt à afficher, source unique API+UI. */
  trackerSilenceLabel: string | null;
  /**
   * true = muet depuis plus de {@link DORMANT_STOP_ACTING_MS} (72 h) → l'armement est
   * impossible. MÊME seuil que le bouton côté UI et que le planificateur antivol : une
   * garde d'action ne doit jamais être plus laxiste d'un côté que de l'autre.
   */
  trackerDormant: boolean;
  /**
   * false = on ne peut PAS affirmer que le véhicule est protégé, donc l'UI ne doit pas
   * afficher de vert rassurant. Trois cas : pas de boîtier, boîtier qui n'a jamais émis,
   * boîtier muet au-delà du seuil d'action. Un antivol qui ne répond plus est un
   * mensonge de sécurité bien plus coûteux qu'un doute affiché.
   */
  protectionVerifiable: boolean;
}

/** Profil renvoyé à l'UI : la ligne Prisma intacte + la véracité de la protection. */
export type SurveillanceProfileWithLiveness = SurveillanceProfile &
  SurveillanceLivenessFields;

@Injectable()
export class SurveillanceService {
  private readonly logger = new Logger(SurveillanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackerCommands: TrackerCommandsService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /**
   * Journal Système — l'armement/désarmement antivol est l'exact analogue du
   * coupe-circuit (catégorie ENGINE) : commandes Coban réelles, déclenchées à la
   * main OU par le planificateur. Le FAILURE est le cas le plus précieux (le
   * scheduler avale les erreurs par profil → un tracker offline qui empêche
   * l'armement resterait invisible sans cette ligne).
   */
  private readonly lastScheduledFailureAt = new Map<string, number>();

  private recordSurveillance(
    action: 'surveillance_armed' | 'surveillance_disarmed',
    profile: SurveillanceProfile,
    requestedBy: RequestedBy,
    source: 'manual' | 'scheduled',
    status: 'SUCCESS' | 'FAILURE',
    detail: string,
  ): void {
    // Un échec planifié répété (tracker offline, ré-essayé chaque minute) ne
    // s'écrit qu'une fois/heure — les succès et TOUTES les actions manuelles passent.
    if (status === 'FAILURE' && source === 'scheduled') {
      const key = `${profile.id}|${action}`;
      const last = this.lastScheduledFailureAt.get(key) ?? 0;
      if (Date.now() - last < SCHEDULED_FAILURE_THROTTLE_MS) return;
      this.lastScheduledFailureAt.set(key, Date.now());
    }
    this.prisma.vehicle
      .findUnique({ where: { id: profile.vehicleId }, select: { plate: true } })
      .then((v) =>
        this.systemActivity.record({
          category: 'SURVEILLANCE',
          action,
          status,
          actor: source === 'scheduled' ? 'planning' : 'utilisateur',
          target: v?.plate ?? profile.vehicleId,
          detail,
          fleetId: profile.fleetId,
          triggeredByUserId: source === 'manual' ? requestedBy.userId : null,
        }),
      )
      .catch(() => {
        /* le journal ne casse jamais l'action métier */
      });
  }

  /**
   * Joint la véracité de la protection au profil renvoyé.
   *
   * @param tracker boîtier DÉJÀ chargé par l'appelant (armProfile/disarmProfile en ont
   *                un sous la main) — évite une requête de plus sur un VPS 2 vCPU déjà
   *                saturé. Absent → on le charge ici.
   */
  private async withLiveness(
    profile: SurveillanceProfile,
    tracker?: TrackerLiveness,
  ): Promise<SurveillanceProfileWithLiveness> {
    const t =
      tracker !== undefined
        ? tracker
        : await this.findTrackerForVehicle(profile.vehicleId);
    const now = Date.now();
    // Source de dormance = `Tracker.lastSeenAt`, et RIEN d'autre. Ni `Tracker.status`
    // (colonne collante, jamais remise à OFFLINE), ni les positions (jetées en mode
    // vie privée alors que le boîtier parle : on marquerait muet tout véhicule RGPD).
    const dormant = isVehicleDormant(
      { trackerId: t?.id, lastSeenAt: t?.lastSeenAt },
      now,
      DORMANT_STOP_ACTING_MS,
    );
    return {
      ...profile,
      trackerId: t?.id ?? null,
      trackerLastSeenAt: t?.lastSeenAt ?? null,
      trackerSilenceMs: trackerSilenceMs(t?.lastSeenAt, now),
      trackerSilenceLabel: formatSilenceLabel(t?.lastSeenAt, now),
      trackerDormant: dormant,
      // « Jamais émis » (lastSeenAt null) n'est PAS de la dormance — c'est un boîtier
      // jamais installé — mais la protection y est tout aussi invérifiable.
      protectionVerifiable: t != null && t.lastSeenAt != null && !dormant,
    };
  }

  // ─── Profile CRUD ───────────────────────────────────────────────────

  async getOrCreateProfile(
    vehicleId: string,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceProfileWithLiveness> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');

    if (
      requestedBy.role !== UserRole.SUPER_ADMIN &&
      vehicle.fleetId !== requestedBy.fleetId
    ) {
      throw new ForbiddenException('Accès refusé à ce véhicule');
    }

    const existing = await this.prisma.surveillanceProfile.findUnique({
      where: { vehicleId },
    });
    if (existing) return this.withLiveness(existing);

    const created = await this.prisma.surveillanceProfile.create({
      data: {
        vehicleId: vehicle.id,
        fleetId: vehicle.fleetId,
        mode: SurveillanceMode.OFF,
        sensitivity: SurveillanceSensitivity.MEDIUM,
        triggerVibration: true,
        triggerMovement: true,
        triggerDoor: false,
        additionalNotifyUserIds: [],
        createdBy: requestedBy.userId,
      },
    });
    return this.withLiveness(created);
  }

  async updateProfile(
    vehicleId: string,
    dto: UpdateSurveillanceProfileDto,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceProfileWithLiveness> {
    const profile = await this.getOrCreateProfile(vehicleId, requestedBy);

    // Validations métier
    if (dto.mode === SurveillanceMode.SCHEDULED) {
      const start = dto.scheduleStartTime ?? profile.scheduleStartTime;
      const end = dto.scheduleEndTime ?? profile.scheduleEndTime;
      if (!start || !end) {
        throw new BadRequestException(
          'Mode SCHEDULED requiert scheduleStartTime et scheduleEndTime',
        );
      }
    }

    // Validation : si additionalNotifyUserIds change, vérifier appartenance fleet.
    if (dto.additionalNotifyUserIds) {
      if (dto.additionalNotifyUserIds.length > 0) {
        const users = await this.prisma.user.findMany({
          where: { id: { in: dto.additionalNotifyUserIds } },
          select: { id: true, fleetId: true, role: true, isActive: true },
        });
        for (const id of dto.additionalNotifyUserIds) {
          const u = users.find((x) => x.id === id);
          if (!u) throw new NotFoundException(`Utilisateur ${id} introuvable`);
          if (!u.isActive) {
            throw new BadRequestException(`Utilisateur ${id} inactif`);
          }
          if (
            requestedBy.role !== UserRole.SUPER_ADMIN &&
            u.fleetId !== profile.fleetId
          ) {
            throw new ForbiddenException(
              `Utilisateur ${id} hors de la flotte`,
            );
          }
          if (
            u.role !== UserRole.FLEET_ADMIN &&
            u.role !== UserRole.FLEET_MANAGER &&
            u.role !== UserRole.SUPER_ADMIN
          ) {
            throw new BadRequestException(
              `Utilisateur ${id} doit être FLEET_ADMIN ou FLEET_MANAGER`,
            );
          }
        }
      }
    }

    const updated = await this.prisma.surveillanceProfile.update({
      where: { id: profile.id },
      data: {
        mode: dto.mode ?? undefined,
        sensitivity: dto.sensitivity ?? undefined,
        scheduleStartTime:
          dto.scheduleStartTime === undefined ? undefined : dto.scheduleStartTime,
        scheduleEndTime:
          dto.scheduleEndTime === undefined ? undefined : dto.scheduleEndTime,
        scheduleDays:
          dto.scheduleDays === undefined
            ? undefined
            : (dto.scheduleDays as unknown as Prisma.InputJsonValue),
        // `?? undefined` serait un piège ici : on doit pouvoir DÉCOCHER la case.
        // `false ?? undefined` vaut bien `false`, mais on écrit le test explicite
        // pour que la distinction « non transmis » / « transmis à false » se voie.
        weekendPermanent:
          dto.weekendPermanent === undefined ? undefined : dto.weekendPermanent,
        triggerVibration: dto.triggerVibration ?? undefined,
        triggerMovement: dto.triggerMovement ?? undefined,
        triggerDoor: dto.triggerDoor ?? undefined,
        additionalNotifyUserIds: dto.additionalNotifyUserIds ?? undefined,
      },
    });
    // Le boîtier a DÉJÀ été lu par `getOrCreateProfile` quelques millisecondes plus haut :
    // on réinjecte ce fait au lieu de refaire la même requête. C'est exactement ce à quoi
    // sert le paramètre `tracker` de `withLiveness` — chaque bascule d'interrupteur du
    // panneau déclenche un PUT, et le VPS 2 vCPU ne pardonne pas les requêtes gratuites.
    const tracker =
      profile.trackerId != null
        ? { id: profile.trackerId, lastSeenAt: profile.trackerLastSeenAt }
        : null;
    return this.withLiveness(updated, tracker);
  }

  // ─── Arm / Disarm ───────────────────────────────────────────────────

  /**
   * Armement manuel par un utilisateur. Envoie les commandes Coban (shock +
   * sensitivity) via TrackerCommandsService. Si une commande échoue (tracker
   * offline par exemple), on remonte l'erreur sans modifier `currentlyArmed`.
   */
  async armNow(
    vehicleId: string,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceProfileWithLiveness> {
    const profile = await this.getOrCreateProfile(vehicleId, requestedBy);
    return this.armProfile(profile, requestedBy, 'manual');
  }

  async disarmNow(
    vehicleId: string,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceProfileWithLiveness> {
    const profile = await this.getOrCreateProfile(vehicleId, requestedBy);
    return this.disarmProfile(profile, requestedBy, 'manual');
  }

  /**
   * Armement utilisé à la fois par armNow() et par le scheduler. La distinction
   * `source` sert uniquement aux logs.
   */
  async armProfile(
    profile: SurveillanceProfile,
    requestedBy: RequestedBy,
    source: 'manual' | 'scheduled',
  ): Promise<SurveillanceProfileWithLiveness> {
    const tracker = await this.findTrackerForVehicle(profile.vehicleId);
    if (!tracker) {
      throw new BadRequestException(
        'Aucun tracker associé à ce véhicule — impossible d\'armer',
      );
    }

    // ─── PORTE « BOÎTIER MUET » (seuil AGIR = 72 h) ────────────────────────────
    // ARMER est une action qui AGGRAVE : elle ajoute une contrainte au véhicule. Sur un
    // boîtier muet depuis des semaines (FV-941-LZ, 89 j en prod) elle ne peut qu'échouer,
    // après avoir créé une ligne `tracker_commands`, un passage au centre d'alertes et,
    // en repli, un SMS facturé. Le planificateur applique déjà cette porte ; sans elle
    // ici, le bouton « Armer maintenant » restait le seul chemin ouvert vers cet échec.
    //
    // 72 h et pas 7 j : c'est le seuil que le serveur et l'UI DOIVENT partager. À 7 j le
    // bouton serait resté actif quatre jours de plus pour une commande déjà condamnée.
    //
    // DÉSARMER n'est PAS gardé (cf. disarmProfile) : c'est l'action qui RESTAURE la
    // liberté du véhicule, elle doit rester possible en toutes circonstances.
    if (
      isVehicleDormant(
        { trackerId: tracker.id, lastSeenAt: tracker.lastSeenAt },
        Date.now(),
        DORMANT_STOP_ACTING_MS,
      )
    ) {
      const silence = formatSilenceLabel(tracker.lastSeenAt) ?? '—';
      const detail =
        `Armement impossible — boîtier muet depuis ${silence} : aucune commande ne lui parvient ` +
        `(reprise automatique dès la première trame reçue, sans intervention).`;
      // On journalise AVANT de lever : sans cette ligne, un antivol qui n'arme plus
      // disparaîtrait de l'écran et l'exploitant croirait son véhicule protégé.
      this.recordSurveillance(
        'surveillance_armed', profile, requestedBy, source, 'FAILURE', detail,
      );
      throw new BadRequestException(detail);
    }

    // Envoyer en séquence : sensitivity puis shock (l'ordre importe : on règle
    // d'abord la sensibilité, ensuite on arme).
    try {
      await this.trackerCommands.request(
        tracker.id,
        'sensitivity',
        { level: mapSensitivityToCobanLevel(profile.sensitivity) },
        null,
        requestedBy,
      );
      await this.trackerCommands.request(
        tracker.id,
        'shock_on',
        {},
        null,
        requestedBy,
      );
    } catch (err) {
      this.recordSurveillance('surveillance_armed', profile, requestedBy, source, 'FAILURE',
        `Armement échoué (${profile.mode}, sens. ${profile.sensitivity}) : ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    this.logger.log(
      `[surveillance] ARM ${source} vehicle=${profile.vehicleId} ` +
        `sens=${profile.sensitivity} by=${requestedBy.userId}`,
    );
    this.recordSurveillance('surveillance_armed', profile, requestedBy, source, 'SUCCESS',
      `Armé (${profile.mode}, sensibilité ${profile.sensitivity})`);

    const armed = await this.prisma.surveillanceProfile.update({
      where: { id: profile.id },
      data: {
        currentlyArmed: true,
        lastArmedAt: new Date(),
      },
    });
    return this.withLiveness(armed, tracker);
  }

  async disarmProfile(
    profile: SurveillanceProfile,
    requestedBy: RequestedBy,
    source: 'manual' | 'scheduled',
  ): Promise<SurveillanceProfileWithLiveness> {
    // Le désarmement RESTAURE (il retire une contrainte) : il ne peut JAMAIS être refusé.
    const tracker = await this.findTrackerForVehicle(profile.vehicleId);
    // ─── BOÎTIER MUET : on n'appelle même pas la commande, et on désarme quand même ───
    // TrackerCommandsService.request() refuse désormais toute commande immédiate vers un
    // boîtier muet depuis > 72 h (503). Laisser cet appel se faire ici enfermerait le
    // véhicule : l'exception remonterait AVANT la mise à jour du profil, `currentlyArmed`
    // resterait à true, et il deviendrait littéralement IMPOSSIBLE de désarmer un véhicule
    // dont le boîtier est mort — la fiche répéterait « sous surveillance » pour toujours.
    //
    // On enregistre donc la décision de l'exploitant, en disant exactement ce qui s'est
    // passé. Aucune protection n'est perdue au passage : un boîtier qui ne nous parle plus
    // ne peut de toute façon REMONTER aucun déclenchement, armé ou non — et le panneau
    // affiche « Protection non vérifiable » (cf. `protectionVerifiable`), pas un faux vert.
    const dormant = isVehicleDormant(
      { trackerId: tracker?.id, lastSeenAt: tracker?.lastSeenAt },
      Date.now(),
      DORMANT_STOP_ACTING_MS,
    );
    if (tracker && !dormant) {
      try {
        await this.trackerCommands.request(
          tracker.id,
          'shock_off',
          {},
          null,
          requestedBy,
        );
      } catch (err) {
        this.recordSurveillance('surveillance_disarmed', profile, requestedBy, source, 'FAILURE',
          `Désarmement échoué : ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }

    this.logger.log(
      `[surveillance] DISARM ${source} vehicle=${profile.vehicleId} by=${requestedBy.userId}` +
        (dormant ? ' (boîtier muet — commande non transmise)' : ''),
    );
    this.recordSurveillance(
      'surveillance_disarmed', profile, requestedBy, source, 'SUCCESS',
      dormant
        ? `Désarmé côté application — boîtier muet depuis ${formatSilenceLabel(tracker?.lastSeenAt) ?? '—'} : ` +
          // ⚠️ Ne PAS écrire « la commande sera transmise plus tard » : ce serait faux. Le
          // `shock_off` n'est mis dans aucune file et ne sera jamais rejoué — un profil en
          // mode MANUEL n'est même pas repris par le planificateur. Le boîtier conserve donc
          // son dernier état PHYSIQUE (armé, s'il l'était réellement) jusqu'à la prochaine
          // commande qu'il recevra vraiment. Le dire ici évite qu'un exploitant s'étonne d'une
          // alerte antivol sur un véhicule affiché « désarmé » après un réveil du boîtier.
          'la commande ne lui a pas été transmise et ne sera pas rejouée — tant qu\'il se tait, ' +
          'il conserve son dernier état physique connu.'
        : 'Désarmé',
    );

    const disarmed = await this.prisma.surveillanceProfile.update({
      where: { id: profile.id },
      data: {
        currentlyArmed: false,
        lastDisarmedAt: new Date(),
      },
    });
    return this.withLiveness(disarmed, tracker);
  }

  // ─── Events ─────────────────────────────────────────────────────────

  async listEvents(
    requestedBy: RequestedBy,
    filters: ListEventsFilters,
  ): Promise<{ items: SurveillanceEvent[]; nextCursor: string | null }> {
    // Mode vie privée (RGPD) : les événements de surveillance portent lat/lng/vitesse
    // → masqués tant que le véhicule est en mode privé.
    const where: Prisma.SurveillanceEventWhereInput = { NOT: { vehicle: { privacyModeEnabled: true } } };

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) return { items: [], nextCursor: null };
      where.fleetId = requestedBy.fleetId;
    }
    if (filters.vehicleId) where.vehicleId = filters.vehicleId;
    if (filters.status) where.status = filters.status;

    const limit = Math.min(filters.limit ?? 50, 200);
    const items = await this.prisma.surveillanceEvent.findMany({
      where,
      orderBy: { triggeredAt: 'desc' },
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      include: {
        vehicle: { select: { id: true, plate: true } },
      },
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async acknowledgeEvent(
    eventId: string,
    dto: AcknowledgeEventDto,
    requestedBy: RequestedBy,
  ): Promise<SurveillanceEvent> {
    const event = await this.prisma.surveillanceEvent.findUnique({
      where: { id: eventId },
    });
    if (!event) throw new NotFoundException('Événement introuvable');

    if (
      requestedBy.role !== UserRole.SUPER_ADMIN &&
      event.fleetId !== requestedBy.fleetId
    ) {
      throw new ForbiddenException('Accès refusé');
    }

    return this.prisma.surveillanceEvent.update({
      where: { id: eventId },
      data: {
        status: dto.status,
        notes: dto.notes ?? event.notes,
        acknowledgedAt: new Date(),
        acknowledgedBy: requestedBy.userId,
      },
    });
  }

  /**
   * Enregistre un déclenchement reçu via une trame Coban. Appelée par
   * AlertsService.createFromCobanFrame() quand un véhicule armé matche un trigger.
   * Le SurveillanceEvent est lié à l'Alert créée — la severity de l'Alert est
   * déjà CRITICAL côté appelant.
   */
  async recordTrigger(params: {
    profileId: string;
    vehicleId: string;
    fleetId: string;
    alertId: string;
    trigger: SurveillanceEventTrigger;
    latitude: number | null;
    longitude: number | null;
    speedKmh: number | null;
  }): Promise<SurveillanceEvent> {
    return this.prisma.surveillanceEvent.create({
      data: {
        profileId: params.profileId,
        vehicleId: params.vehicleId,
        fleetId: params.fleetId,
        alertId: params.alertId,
        trigger: params.trigger,
        latitude: params.latitude,
        longitude: params.longitude,
        speedKmh: params.speedKmh,
      },
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /**
   * Boîtier du véhicule, réduit à ce que ce service utilise réellement : `id` (cible des
   * commandes Coban) et `lastSeenAt` (seule source de la dormance). Sélection explicite
   * plutôt que la ligne entière — c'est la même requête, avec moins à transporter.
   */
  private async findTrackerForVehicle(vehicleId: string): Promise<TrackerLiveness> {
    return this.prisma.tracker.findFirst({
      where: { vehicle: { id: vehicleId } },
      select: { id: true, lastSeenAt: true },
    });
  }
}
