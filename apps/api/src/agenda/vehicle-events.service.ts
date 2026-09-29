import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  AgendaSummaryDto,
  CreateVehicleEventDto,
  OdometerEstimateDto,
  ReportIncidentDto,
  UpdateVehicleEventDto,
  VehicleEventDto,
} from '@vizyo/tracky-shared';
import { IMMOBILIZING_STATUSES } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * P2-3 (audit du 22/09) — plafond de la liste d'évènements d'une fenêtre.
 *
 * L'ancien `take: 1000` était MUET : trié par date croissante, au-delà de mille lignes **la fin
 * du mois disparaissait** sans qu'aucune trace ne le dise — ni au client, ni au journal. cdef31
 * est à ~300 évènements sur une grille de six semaines ; un parc de trente véhicules à deux
 * réservations par jour en produirait 2 500 sur la même fenêtre, et l'écran aurait tronqué en
 * silence. Le plafond est relevé à une marge confortable pour tout parc connu, et **quand il
 * mord, il le dit** dans le journal avec la société et la fenêtre — le contrat de réponse (un
 * tableau) n'est pas changé, mais l'oubli cesse d'être invisible.
 */
export const MAX_EVENEMENTS_PAR_FENETRE = 3000;

type EventRow = Prisma.VehicleEventGetPayload<{ include: { vehicle: { select: { plate: true } } } }>;

/**
 * Sprint 7 — CRUD des événements d'agenda (générique : maintenance + incidents). Scoping
 * tenant STRICT (anti-IDOR) réutilisant la chaîne S5 : `getAccessibleVehicleIds` +
 * `resolveReportVehicleScope`. Aucune donnée hors périmètre véhicule de l'utilisateur.
 */
@Injectable()
export class VehicleEventsService {
  private readonly logger = new Logger(VehicleEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    // EventEmitter2 est global (EventEmitterModule.forRoot) : injecté en prod, omis dans les specs.
    private readonly emitter?: EventEmitter2,
  ) {}

  /** Notifie l'agent d'agenda qu'un incident/maintenance vient d'être créé (déclencheur P3). */
  private emitAgentTrigger(fleetId: string, kind: 'incident' | 'maintenance'): void {
    this.emitter?.emit('agenda-agent.trigger', { fleetId, kind });
  }

  /** Vérifie l'accès à un véhicule (cross-flotte + IDOR intra-flotte) → renvoie son fleetId. */
  async assertVehicleAccess(user: AuthUser, vehicleId: string): Promise<string> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, fleetId: true },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');
    if (user.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== user.fleetId) {
      throw new ForbiddenException('Véhicule hors de votre flotte');
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    resolveReportVehicleScope(accessible, [vehicleId]); // 403 si hors perimetre per-vehicule
    return vehicle.fleetId;
  }

  /** WHERE scopé (flotte + périmètre véhicules) pour les listes/compteurs. */
  private async scopedWhere(
    user: AuthUser,
    requestedVehicleIds?: string[],
    fleetId?: string,
  ): Promise<Prisma.VehicleEventWhereInput> {
    const where: Prisma.VehicleEventWhereInput = {};
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée');
      where.fleetId = user.fleetId;
    } else if (fleetId) {
      // Filtre société global (SUPER_ADMIN) : restreint à la société choisie dans le top-bar.
      where.fleetId = fleetId;
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const scope = resolveReportVehicleScope(accessible, requestedVehicleIds);
    if (scope !== 'ALL') where.vehicleId = { in: scope };
    return where;
  }

  /** vehicleIds d'un groupe (le groupe doit appartenir à la flotte de l'user, sauf super-admin). */
  private async groupVehicleIds(user: AuthUser, groupId: string): Promise<string[]> {
    const assignments = await this.prisma.vehicleGroupAssignment.findMany({
      where: {
        groupId,
        ...(user.role !== UserRole.SUPER_ADMIN
          ? { group: { fleetId: user.fleetId ?? '__none__' } }
          : {}),
      },
      select: { vehicleId: true },
    });
    return assignments.map((a) => a.vehicleId);
  }

  async list(
    user: AuthUser,
    q: {
      from: Date;
      to: Date;
      vehicleId?: string;
      groupId?: string;
      type?: VehicleEventType;
      status?: VehicleEventStatus;
      fleetId?: string;
    },
  ): Promise<VehicleEventDto[]> {
    let requested: string[] | undefined;
    if (q.vehicleId) requested = [q.vehicleId];
    else if (q.groupId) {
      requested = await this.groupVehicleIds(user, q.groupId);
      if (requested.length === 0) return []; // groupe vide -> ne rien exposer d'autre
    }

    const where = await this.scopedWhere(user, requested, q.fleetId);
    /**
     * Fenêtre temporelle : événements qui chevauchent [from, to].
     *
     * Troisième relecture du 29/09 (T16) — une IMMOBILISATION SANS FIN commencée AVANT la fenêtre, et
     * toujours active, la chevauche aussi. Un incident OPEN bloquant signalé le 20/08, jamais résolu,
     * n'était rendu à aucune grille de septembre : le panneau du jour annonçait le véhicule disponible
     * (« Tous les véhicules du périmètre sont disponibles ») pendant que la réservation répondait 409.
     * Même prédicat que `ReservationsService.findImmobilized` (bloquant, hors réservation, statut
     * immobilisant) et même fin effective que `effectiveBlockingEndMs` : un INCIDENT sans fin bloque
     * jusqu'à résolution, les autres (maintenance…) leur journée — 24 h après leur début.
     * La grille n'en dessine rien (un évènement d'un jour commencé avant la fenêtre n'a aucun jour
     * dedans) ; la disponibilité et le panneau du jour le voient chaque jour, comme prévu.
     */
    const immobilisantSansFin: Prisma.VehicleEventWhereInput = {
      endAt: null,
      blocksVehicle: true,
      status: { in: IMMOBILIZING_STATUSES },
    };
    where.AND = [
      {
        OR: [
          { endAt: null, startAt: { gte: q.from, lte: q.to } },
          { startAt: { lte: q.to }, endAt: { gte: q.from } },
          { ...immobilisantSansFin, type: VehicleEventType.INCIDENT, startAt: { lt: q.from } },
          {
            ...immobilisantSansFin,
            type: { notIn: [VehicleEventType.INCIDENT, VehicleEventType.RESERVATION] },
            startAt: { gt: new Date(q.from.getTime() - DAY_MS), lt: q.from },
          },
        ],
      },
    ];
    if (q.type) where.type = q.type;
    if (q.status) where.status = q.status;

    const rows = await this.prisma.vehicleEvent.findMany({
      where,
      include: { vehicle: { select: { plate: true } } },
      orderBy: { startAt: 'asc' },
      take: MAX_EVENEMENTS_PAR_FENETRE,
    });
    if (rows.length === MAX_EVENEMENTS_PAR_FENETRE) {
      // Tronqué : la fin de la fenêtre n'est pas rendue. Dit, pas avalé (P2-3).
      this.logger.warn(
        `Liste d'évènements tronquée à ${MAX_EVENEMENTS_PAR_FENETRE} lignes — société ${String(where.fleetId ?? 'toutes')}, ` +
          `fenêtre ${q.from.toISOString()} → ${q.to.toISOString()} : les évènements les plus tardifs manquent.`,
      );
    }
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Les trois compteurs de l'en-tête.
   *
   * ── Périmètre (P2-4, audit du 22/09) ────────────────────────────────────────────────────
   * Filtrer par groupe ou véhicule ne changeait pas « En retard / À venir / Incidents
   * ouverts » : l'écran suggérait un périmètre qu'il n'appliquait pas. Les compteurs prennent
   * désormais le MÊME périmètre que la liste (`vehicleId` / `groupId`, résolus comme dans
   * `list()`). Le filtre de TYPE, lui, reste volontairement hors des compteurs : chacun est
   * typé par nature (« Incidents ouverts » sous un filtre « Maintenance » afficherait 0 — et ce
   * zéro serait faux).
   *
   * ── Statuts (audit du 24/09, « compteur ≠ liste ») ───────────────────────────────────────
   * `overdue` comptait les seuls `PLANNED` alors que le contrat du DTO dit « PLANNED/OPEN dont
   * l'échéance est passée » et que la liste « À venir & en retard » affichait aussi les OPEN.
   * La liste, côté web, applique la MÊME règle (`estUneEcheance`, `agenda.utils.ts`) — un
   * compteur et la liste sous lui doivent parler du même ensemble, sinon le lecteur ne sait plus
   * lequel croire.
   *
   * Recette du 28/09 (démo) : compter les OPEN faisait passer un incident déclaré à l'instant
   * (`reportIncident` : OPEN, `startAt` = maintenant) pour « en retard » dans la seconde. Un OPEN
   * est OUVERT — il vit dans `openIncidents`, comme un IN_PROGRESS. Seul un PLANNED a une échéance
   * qu'on peut dépasser : c'est le contrat du DTO, corrigé le même jour.
   */
  async summary(
    user: AuthUser,
    q: { fleetId?: string; vehicleId?: string; groupId?: string } = {},
  ): Promise<AgendaSummaryDto> {
    let requested: string[] | undefined;
    if (q.vehicleId) requested = [q.vehicleId];
    else if (q.groupId) {
      requested = await this.groupVehicleIds(user, q.groupId);
      if (requested.length === 0) return { overdue: 0, upcoming: 0, openIncidents: 0 }; // groupe vide
    }
    const where = await this.scopedWhere(user, requested, q.fleetId);
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * DAY_MS);
    const [overdue, upcoming, openIncidents] = await Promise.all([
      this.prisma.vehicleEvent.count({
        where: {
          ...where,
          status: VehicleEventStatus.PLANNED,
          startAt: { lt: now },
        },
      }),
      this.prisma.vehicleEvent.count({
        where: { ...where, status: VehicleEventStatus.PLANNED, startAt: { gte: now, lte: in30 } },
      }),
      this.prisma.vehicleEvent.count({
        where: {
          ...where,
          type: VehicleEventType.INCIDENT,
          status: { in: [VehicleEventStatus.OPEN, VehicleEventStatus.IN_PROGRESS] },
        },
      }),
    ]);
    return { overdue, upcoming, openIncidents };
  }

  async create(user: AuthUser, dto: CreateVehicleEventDto): Promise<VehicleEventDto> {
    if (dto.type === VehicleEventType.RESERVATION) {
      throw new BadRequestException('Les réservations seront gérées au Sprint 8');
    }
    const fleetId = await this.assertVehicleAccess(user, dto.vehicleId);
    const startAt = this.parseDate(dto.startAt, 'startAt');
    const endAt = dto.endAt ? this.parseDate(dto.endAt, 'endAt') : null;
    // Lot multi-jours (28/09) : une maintenance « du 5 au 12 » se saisit avec sa fin. Elle doit
    // rester après le début — sinon l'immobilisation calculée depuis `effectiveBlockingEndMs`
    // serait vide, et le véhicule « libre » pendant son passage au garage.
    if (endAt && endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('La fin doit être après le début.');
    }
    const row = await this.prisma.vehicleEvent.create({
      data: {
        fleetId,
        vehicleId: dto.vehicleId,
        type: dto.type,
        category: dto.category ?? null,
        status: dto.status ?? VehicleEventStatus.PLANNED,
        severity: dto.severity ?? null,
        title: dto.title.trim(),
        description: dto.description ?? null,
        startAt,
        endAt,
        allDay: dto.allDay ?? true,
        // Un incident immobilise par défaut (roue crevée = indisponible) ; une maintenance non.
        blocksVehicle: dto.blocksVehicle ?? dto.type === VehicleEventType.INCIDENT,
        odometerKm: dto.odometerKm ?? null,
        metadata: dto.metadata ? (dto.metadata as Prisma.InputJsonValue) : undefined,
        createdBy: user.id,
        source: 'MANUAL',
      },
      include: { vehicle: { select: { plate: true } } },
    });
    await this.maybeUpdateOdometer(dto.vehicleId, dto.odometerKm, startAt);
    if (row.type === VehicleEventType.INCIDENT || row.type === VehicleEventType.MAINTENANCE) {
      this.emitAgentTrigger(row.fleetId, row.type === VehicleEventType.INCIDENT ? 'incident' : 'maintenance');
    }
    return this.toDto(row);
  }

  async reportIncident(user: AuthUser, dto: ReportIncidentDto): Promise<VehicleEventDto> {
    const fleetId = await this.assertVehicleAccess(user, dto.vehicleId);
    const row = await this.prisma.vehicleEvent.create({
      data: {
        fleetId,
        vehicleId: dto.vehicleId,
        type: VehicleEventType.INCIDENT,
        status: VehicleEventStatus.OPEN,
        severity: dto.severity ?? 'MEDIUM',
        title: dto.title.trim(),
        description: dto.description ?? null,
        startAt: new Date(),
        allDay: true,
        blocksVehicle: dto.blocksVehicle ?? true,
        createdBy: user.id,
        source: 'MANUAL',
      },
      include: { vehicle: { select: { plate: true } } },
    });
    this.emitAgentTrigger(row.fleetId, 'incident');
    return this.toDto(row);
  }

  async update(user: AuthUser, id: string, dto: UpdateVehicleEventDto): Promise<VehicleEventDto> {
    const existing = await this.loadScoped(user, id);
    // Sprint 8 — une réservation ne se gère QUE via ReservationsService (perms reservations_*),
    // jamais via l'endpoint agenda générique : sinon agenda_manage contournerait reservations_manage
    // et court-circuiterait les pré-checks de conflit. Symétrique du refus dans create().
    if (existing.type === VehicleEventType.RESERVATION) {
      throw new BadRequestException('Les réservations se gèrent depuis l\'espace Réservations.');
    }
    this.refuserSiMission(existing.type);
    const data: Prisma.VehicleEventUpdateInput = {};
    if (dto.status !== undefined) {
      data.status = dto.status;
      if (dto.status === VehicleEventStatus.DONE) data.resolvedAt = new Date();
    }
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.severity !== undefined) data.severity = dto.severity;
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.startAt !== undefined) data.startAt = this.parseDate(dto.startAt, 'startAt');
    if (dto.endAt !== undefined) data.endAt = dto.endAt ? this.parseDate(dto.endAt, 'endAt') : null;
    // Lot multi-jours (28/09) : que le début, la fin ou les deux changent, la fin reste après
    // le début — c'est ce que l'écran « cette maintenance est-elle terminée ? » réécrit.
    const debut = data.startAt instanceof Date ? data.startAt : existing.startAt;
    const fin = dto.endAt !== undefined ? (data.endAt instanceof Date ? data.endAt : null) : existing.endAt;
    if (fin && fin.getTime() <= debut.getTime()) {
      throw new BadRequestException('La fin doit être après le début.');
    }
    if (dto.allDay !== undefined) data.allDay = dto.allDay;
    if (dto.blocksVehicle !== undefined) data.blocksVehicle = dto.blocksVehicle;
    if (dto.odometerKm !== undefined) data.odometerKm = dto.odometerKm;
    if (dto.linkedEventId !== undefined) {
      // Anti-IDOR : un lien ne peut pointer que vers un evenement DANS le perimetre (S8-ready).
      if (dto.linkedEventId) await this.loadScoped(user, dto.linkedEventId);
      data.linkedEventId = dto.linkedEventId;
    }
    if (dto.metadata !== undefined) data.metadata = dto.metadata as Prisma.InputJsonValue;

    const row = await this.prisma.vehicleEvent.update({
      where: { id },
      data,
      include: { vehicle: { select: { plate: true } } },
    });
    if (dto.odometerKm !== undefined) {
      await this.maybeUpdateOdometer(existing.vehicleId, dto.odometerKm, row.startAt);
    }
    return this.toDto(row);
  }

  async remove(user: AuthUser, id: string): Promise<{ ok: true }> {
    const existing = await this.loadScoped(user, id);
    if (existing.type === VehicleEventType.RESERVATION) {
      throw new BadRequestException('Les réservations se gèrent depuis l\'espace Réservations.');
    }
    this.refuserSiMission(existing.type);
    await this.prisma.vehicleEvent.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * P2-1 (audit du 22/09) — un évènement `MISSION` n'est pas un évènement comme les autres :
   * c'est L'OMBRE d'une mission, créée avec elle dans la même transaction (`missions.service.ts`)
   * et retrouvée par `metadata.missionId` à chaque changement d'état. Le serveur refusait déjà
   * l'édition d'une RÉSERVATION par cette voie, mais laissait passer la mission : « Terminé » ou
   * « Supprimer » depuis le panneau du jour **libérait le véhicule pendant une mission qui
   * existait toujours** — exactement la désynchronisation que la transaction de création empêche.
   *
   * Même famille de garde que la réservation, même symétrie : la mission se pilote depuis l'onglet
   * Missions (démarrer, terminer, annuler), et c'est ELLE qui met son ombre à jour. Le message
   * dit où aller, parce qu'un refus qui ne dit pas le bon geste en provoque un autre.
   */
  private refuserSiMission(type: VehicleEventType): void {
    if (type === VehicleEventType.MISSION) {
      throw new BadRequestException(
        "Une mission se pilote depuis l'onglet Missions de l'agenda : c'est elle qui met à jour cet évènement.",
      );
    }
  }

  async estimateOdometer(user: AuthUser, vehicleId: string): Promise<OdometerEstimateDto> {
    await this.assertVehicleAccess(user, vehicleId);
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { lastOdometerKm: true, lastOdometerAt: true },
    });
    const since = vehicle?.lastOdometerAt ?? undefined;
    const agg = await this.prisma.trip.aggregate({
      where: { vehicleId, ...(since ? { startedAt: { gte: since } } : {}) },
      _sum: { distanceKm: true },
    });
    const gpsSince = Math.round(agg._sum.distanceKm ?? 0);
    const base = vehicle?.lastOdometerKm ?? null;
    const estimated = base !== null ? base + gpsSince : gpsSince > 0 ? gpsSince : null;
    return {
      vehicleId,
      lastOdometerKm: base,
      lastOdometerAt: vehicle?.lastOdometerAt?.toISOString() ?? null,
      gpsDistanceSinceKm: gpsSince,
      estimatedKm: estimated,
    };
  }

  /** Charge un événement en garantissant qu'il est dans le périmètre de l'user. */
  private async loadScoped(
    user: AuthUser,
    id: string,
  ): Promise<{ vehicleId: string; type: VehicleEventType; startAt: Date; endAt: Date | null }> {
    const where = await this.scopedWhere(user);
    const ev = await this.prisma.vehicleEvent.findFirst({
      where: { ...where, id },
      // `startAt` / `endAt` : la garde « fin après début » de update() (lot multi-jours) doit
      // raisonner sur les valeurs en base quand le patch n'en change qu'une.
      select: { id: true, vehicleId: true, type: true, startAt: true, endAt: true },
    });
    if (!ev) throw new NotFoundException('Événement introuvable');
    return ev;
  }

  /** Met à jour le baseline km du véhicule (jamais en arrière : on n'écrase qu'avec une saisie plus récente). */
  async maybeUpdateOdometer(
    vehicleId: string,
    odometerKm: number | null | undefined,
    at: Date,
  ): Promise<void> {
    if (odometerKm == null) return;
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { lastOdometerAt: true },
    });
    if (v?.lastOdometerAt && v.lastOdometerAt.getTime() > at.getTime()) return;
    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { lastOdometerKm: odometerKm, lastOdometerAt: at },
    });
  }

  private parseDate(raw: string, field: string): Date {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`${field} doit être une date ISO valide`);
    }
    return d;
  }

  toDto(r: EventRow): VehicleEventDto {
    return {
      id: r.id,
      fleetId: r.fleetId,
      vehicleId: r.vehicleId,
      vehiclePlate: r.vehicle?.plate ?? null,
      type: r.type,
      category: r.category,
      status: r.status,
      severity: (r.severity as VehicleEventDto['severity']) ?? null,
      title: r.title,
      description: r.description,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt?.toISOString() ?? null,
      allDay: r.allDay,
      blocksVehicle: r.blocksVehicle,
      odometerKm: r.odometerKm,
      planId: r.planId,
      linkedEventId: r.linkedEventId,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
