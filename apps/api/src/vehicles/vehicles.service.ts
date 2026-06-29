import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandStatus, EngineAction, Prisma, UserRole } from '@prisma/client';
import type { Vehicle } from '@prisma/client';
import type {
  VehicleCapacityRowDto,
  VehicleInstallationSourceDto,
  VehicleSnapshotDto,
  VehicleSyncableField,
} from '@vizyo/tracky-shared';
import { InMemoryCacheService } from '../common/cache/in-memory-cache.service';
import { resolveTenantScope } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateVehicleDto } from './dto/create-vehicle.dto';
import type { UpdateVehicleDto } from './dto/update-vehicle.dto';

// V1.10 (Sprint 2 perf) — TTLs cache KPI.
//   - SNAPSHOT_TTL_MS : positions temps reel, mais on accepte 15s de fraicheur
//     pour reduire la charge DB. Le WS broadcast push les updates temps reel
//     en parallele du polling — l'utilisateur voit l'evenement immediatement.
//   - STATS_TTL_MS : KPIs agreges (count vehicules, alertes critiques), 60s
//     suffit largement (rythme de mise a jour business = minute).
const SNAPSHOT_TTL_MS = 15_000;
const STATS_TTL_MS = 60_000;

export interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
  accessibleVehicleIds?: string[] | 'ALL';
}

/** Sprint 1 (Fondation Groupes) — référence groupe (single) attachée aux réponses véhicule. */
export type VehicleGroupRef = { id: string; name: string } | null;
export type VehicleWithGroup = Vehicle & { group: VehicleGroupRef };

@Injectable()
export class VehiclesService {
  /**
   * Phase 2 — Select Prisma minimal pour inclure le conducteur courant dans
   * les responses Vehicle (cf. DriverSummaryDto cote shared).
   */
  static readonly CURRENT_DRIVER_INCLUDE = {
    currentDriver: {
      select: { id: true, firstName: true, lastName: true, color: true, isActive: true },
    },
  } as const;

  /**
   * V1.10 (Sprint 6 perf) — select Tracker reduit aux champs reellement
   * consommes par le frontend dans une liste (carte, fiche, dashboard). Evite
   * de transferer ~25 champs internes Tracker (sampling state, fix intervals,
   * verboseUntil, etc.) qui n'interessent que /admin/observability.
   * Reduction payload list ~75% a 50 vehicules.
   */
  private static readonly TRACKER_LIST_SELECT = {
    id: true,
    imei: true,
    status: true,
    lastSeenAt: true,
    lastLat: true,
    lastLng: true,
    lastSpeedKmh: true,
    lastHeading: true,
    lastIgnition: true,
    lastValid: true,
    lastPositionAt: true,
    accConnected: true,
    // V1.15 — expose la SIM pour le badge "Installe" (IMEI + SIM presents) cote liste.
    simPhoneNumber: true,
    // Date d'ajout du tracker (proxy d'installation) — pour le flag "installation à revoir".
    createdAt: true,
  } as const;

  /**
   * Sprint 1 (Fondation Groupes) — sélection du groupe (single) d'un véhicule.
   * Décision produit : 1 groupe/véhicule, mais le schéma reste M2M
   * (VehicleGroupAssignment) ; `take: 1` + tri par nom garantissent un résultat
   * déterministe si une donnée legacy porte >1 assignation.
   */
  private static readonly GROUP_INCLUDE = {
    groups: {
      select: { group: { select: { id: true, name: true } } },
      orderBy: { group: { name: 'asc' } },
      take: 1,
    },
  } as const;

  /** Aplatit la jointure `groups[0].group` en `group: {id,name} | null`. */
  private static withGroup<T extends { groups?: { group: { id: string; name: string } }[] }>(
    v: T,
  ): Omit<T, 'groups'> & { group: VehicleGroupRef } {
    const { groups, ...rest } = v;
    return { ...rest, group: groups?.[0]?.group ?? null };
  }

  /**
   * Sprint 8 — Normalise les tags d'équipement (critères de réservation) : trim,
   * dédup insensible à la casse (garde la 1re occurrence), drop des vides. Renvoie
   * `undefined` si l'entrée n'est pas un tableau (=> ne pas toucher au champ).
   */
  static normalizeFeatures(features?: string[] | null): string[] | undefined {
    if (!Array.isArray(features)) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of features) {
      const t = (raw ?? '').trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: InMemoryCacheService,
  ) {}

  /**
   * Build une cle de cache stable pour les KPI. On ne cache que quand le
   * scope est ouvert ('ALL') — sinon la cle exploserait avec toutes les
   * combinaisons d'accessibleVehicleIds. Les VIEWER restreints (minoritaires)
   * tapent la DB directement, c'est OK perf-wise (ils ne sont pas le pic).
   */
  private kpiCacheKey(prefix: string, requestedBy: RequestedBy): string | null {
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      return null;
    }
    const scope = requestedBy.role === UserRole.SUPER_ADMIN ? 'super' : (requestedBy.fleetId ?? 'none');
    return `${prefix}:${scope}`;
  }

  /**
   * Invalide les caches KPI de la fleet quand un write touche l'etat affiche
   * sur le dashboard (creation/suppression vehicule, nouvelle alerte critique,
   * commande CUT/RESTORE). Appele depuis create / archive / hooks broadcast.
   */
  invalidateKpiCache(fleetId: string | null): void {
    const scope = fleetId ?? 'none';
    this.cache.invalidate(`stats:${scope}`);
    this.cache.invalidate(`snapshot:${scope}`);
    this.cache.invalidate('stats:super');
    this.cache.invalidate('snapshot:super');
  }

  async create(dto: CreateVehicleDto, requestedBy: RequestedBy): Promise<Vehicle> {
    let fleetId: string;

    if (requestedBy.role === UserRole.SUPER_ADMIN) {
      if (!dto.fleetId) {
        throw new BadRequestException(
          'En tant que SUPER_ADMIN, vous devez sélectionner une flotte',
        );
      }
      fleetId = dto.fleetId;
    } else if (requestedBy.fleetId) {
      if (dto.fleetId && dto.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException(
          'Impossible de créer un véhicule dans une autre flotte',
        );
      }
      fleetId = requestedBy.fleetId;
    } else {
      throw new ForbiddenException('Aucune flotte associée à votre compte');
    }

    try {
      const created = await this.prisma.vehicle.create({
        data: {
          fleetId,
          plate: dto.plate,
          type: dto.type,
          brand: dto.brand,
          model: dto.model,
          energy: dto.energy,
          year: dto.year,
          color: dto.color,
          seats: dto.seats,
          childSeats: dto.childSeats,
          features: VehiclesService.normalizeFeatures(dto.features),
        },
        include: { tracker: true, ...VehiclesService.CURRENT_DRIVER_INCLUDE },
      });
      // #37 — invalider le cache KPI (stats/snapshot) : un vehicule ajoute change les
      // compteurs de la flotte (le doc de invalidateKpiCache annonce "appele depuis create").
      this.invalidateKpiCache(fleetId);
      return created;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Plaque "${dto.plate}" déjà utilisée dans cette flotte`);
      }
      throw err;
    }
  }

  async findAll(
    requestedBy: RequestedBy,
    filters?: { search?: string; hasTracker?: string; limit?: number; cursor?: string },
  ): Promise<VehicleWithGroup[]> {
    const limit = Math.min(filters?.limit ?? 50, 50);
    const where: Prisma.VehicleWhereInput = {};

    // V1.16 (audit A3) — fail-closed : un non-super sans fleetId ne voit RIEN.
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') return [];
    if (scope.mode === 'FLEET') where.fleetId = scope.fleetId;

    // Filtrage par accès véhicules (sous-utilisateurs)
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.id = { in: requestedBy.accessibleVehicleIds };
    }

    if (filters?.search) {
      where.OR = [
        { plate: { contains: filters.search, mode: 'insensitive' } },
        { brand: { contains: filters.search, mode: 'insensitive' } },
        { model: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters?.hasTracker === 'true') {
      where.tracker = { isNot: null };
    } else if (filters?.hasTracker === 'false') {
      where.tracker = { is: null };
    }

    // V1.10 (Sprint 6 perf) — tracker select reduit (au lieu d'include: true)
    // pour ne pas transferer les champs internes inutiles a la liste.
    const rows = await this.prisma.vehicle.findMany({
      where,
      include: {
        tracker: { select: VehiclesService.TRACKER_LIST_SELECT },
        ...VehiclesService.CURRENT_DRIVER_INCLUDE,
        // Sprint 1 (Fondation Groupes) — groupe (single) pour le badge + la vue groupée.
        ...VehiclesService.GROUP_INCLUDE,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(filters?.cursor ? { skip: 1, cursor: { id: filters.cursor } } : {}),
    });
    return rows.map((v) => VehiclesService.withGroup(v)) as VehicleWithGroup[];
  }

  async findOne(id: string, requestedBy: RequestedBy): Promise<VehicleWithGroup> {
    // V1.10 (Sprint 6) — IDOR fix : filtre tenant integre au where (404 plutot
    // que 403 pour ne pas leak l'existence cross-fleet via timing).
    const where: Prisma.VehicleWhereInput = { id };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Véhicule introuvable');
      where.fleetId = requestedBy.fleetId;
    }
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      // Acces granulaire : un VIEWER restreint a un groupe doit aussi voir ses
      // vehicules autorises (sinon il a un 404 sur ses propres ressources).
      if (!requestedBy.accessibleVehicleIds.includes(id)) {
        throw new NotFoundException('Véhicule introuvable');
      }
    }
    const vehicle = await this.prisma.vehicle.findFirst({
      where,
      include: {
        tracker: true,
        schedule: { select: { enabled: true } },
        ...VehiclesService.CURRENT_DRIVER_INCLUDE,
        // Sprint 1 (Fondation Groupes) — groupe (single) pour la fiche détail.
        ...VehiclesService.GROUP_INCLUDE,
      },
    });

    if (!vehicle) throw new NotFoundException('Véhicule introuvable');

    // Vérifier accès véhicule pour les sous-utilisateurs
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL' && !requestedBy.accessibleVehicleIds.includes(vehicle.id)) {
      throw new ForbiddenException('Accès refusé à ce véhicule');
    }

    return VehiclesService.withGroup(vehicle);
  }

  async update(id: string, dto: UpdateVehicleDto, requestedBy: RequestedBy): Promise<Vehicle> {
    const vehicle = await this.findOne(id, requestedBy);

    if (dto.fleetId && dto.fleetId !== vehicle.fleetId && requestedBy.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Impossible de changer la flotte du véhicule');
    }

    const data: Prisma.VehicleUpdateInput = {};
    if (dto.plate !== undefined) data.plate = dto.plate;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.brand !== undefined) data.brand = dto.brand;
    if (dto.model !== undefined) data.model = dto.model;
    if (dto.energy !== undefined) data.energy = dto.energy;
    if (dto.year !== undefined) data.year = dto.year;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.seats !== undefined) data.seats = dto.seats;
    if (dto.childSeats !== undefined) data.childSeats = dto.childSeats;
    if (dto.features !== undefined) {
      const f = VehiclesService.normalizeFeatures(dto.features);
      if (f !== undefined) data.features = f;
    }
    if (dto.fleetId !== undefined && requestedBy.role === UserRole.SUPER_ADMIN) {
      data.fleet = { connect: { id: dto.fleetId } };
      // #28 — changement de flotte : detacher le conducteur courant (il appartient
      // a l'ANCIENNE flotte) pour ne pas conserver une reference cross-tenant. Les
      // affectations groupe/planning (autres tables fleet-bound) restent a
      // reconfigurer par l'admin sur la nouvelle flotte.
      if (dto.fleetId !== vehicle.fleetId) {
        data.currentDriver = { disconnect: true };
      }
    }

    try {
      return await this.prisma.vehicle.update({
        where: { id },
        data,
        include: { tracker: true, ...VehiclesService.CURRENT_DRIVER_INCLUDE },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Plaque "${dto.plate}" déjà utilisée dans cette flotte`);
      }
      throw err;
    }
  }

  async remove(id: string, requestedBy: RequestedBy): Promise<void> {
    const vehicle = await this.findOne(id, requestedBy);

    if ((vehicle as any).tracker) {
      await this.prisma.tracker.update({
        where: { vehicleId: vehicle.id },
        data: { vehicleId: null },
      });
    }

    await this.prisma.vehicle.delete({ where: { id } });
    // #37 — invalider le cache KPI : la suppression change les compteurs de la flotte.
    this.invalidateKpiCache(vehicle.fleetId);
  }

  /**
   * Sprint 1 (Fondation Groupes) — définit/retire le groupe (single) d'un véhicule.
   * Sémantique « remplacer » : on supprime les assignations existantes puis on
   * recrée la nouvelle (ou aucune si `groupId` est null → « sans groupe »).
   * Le scoping tenant + IDOR sont délégués à `findOne` (404 cross-fleet), et le
   * groupe cible doit appartenir à la même flotte que le véhicule.
   */
  async setGroup(
    id: string,
    groupId: string | null,
    requestedBy: RequestedBy,
  ): Promise<VehicleWithGroup> {
    // Vérifie l'accès au véhicule (tenant scope + accès granulaire). Throw sinon.
    const vehicle = await this.findOne(id, requestedBy);

    if (groupId) {
      const group = await this.prisma.vehicleGroup.findFirst({
        where: { id: groupId, fleetId: vehicle.fleetId },
        select: { id: true },
      });
      if (!group) throw new BadRequestException('Groupe introuvable dans cette flotte');
    }

    try {
      await this.prisma.$transaction([
        this.prisma.vehicleGroupAssignment.deleteMany({ where: { vehicleId: id } }),
        ...(groupId
          ? [this.prisma.vehicleGroupAssignment.create({ data: { vehicleId: id, groupId } })]
          : []),
      ]);
    } catch (err) {
      // TOCTOU : le groupe a pu etre supprime entre le check et l'insert -> FK P2003.
      // On renvoie un 400 propre plutot qu'un 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new BadRequestException('Groupe introuvable dans cette flotte');
      }
      throw err;
    }

    return this.findOne(id, requestedBy);
  }

  /**
   * Sprint 10 — Source de synchro : la tâche d'installation liée la plus récente. Le planning
   * porte marque/modèle/énergie (saisis à la prépa de la pose) ; on les expose pour pré-remplir
   * / synchroniser la fiche véhicule. `null` si le véhicule n'a aucune tâche liée (créé manuellement).
   */
  private async installationSourceRow(vehicleId: string): Promise<VehicleInstallationSourceDto | null> {
    const task = await this.prisma.installationTask.findFirst({
      where: { vehicleId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, planId: true, brand: true, model: true, energy: true,
        scheduledDate: true, firstRegistrationDate: true,
        plan: { select: { clientName: true } },
      },
    });
    if (!task) return null;
    return {
      taskId: task.id,
      planId: task.planId,
      planName: task.plan?.clientName ?? null,
      scheduledDate: task.scheduledDate ? task.scheduledDate.toISOString() : null,
      brand: task.brand ?? null,
      model: task.model ?? null,
      energy: task.energy ?? null,
      firstRegistrationDate: task.firstRegistrationDate ? task.firstRegistrationDate.toISOString() : null,
    };
  }

  /** Sprint 10 — Source de synchro pour UN véhicule (scopée : 404 hors périmètre via findOne). */
  async getInstallationSource(
    id: string,
    requestedBy: RequestedBy,
  ): Promise<VehicleInstallationSourceDto | null> {
    await this.findOne(id, requestedBy); // garde tenant + accès granulaire
    return this.installationSourceRow(id);
  }

  /**
   * Sprint 10 — Recopie (écrasement assumé) des champs choisis depuis la tâche d'installation liée
   * vers le véhicule. Ne recopie QUE les champs demandés ET non vides côté planning : la synchro ne
   * vide jamais un champ. Scopée via findOne (mêmes gardes tenant/IDOR que l'édition).
   */
  async syncFromInstallation(
    id: string,
    fields: VehicleSyncableField[],
    requestedBy: RequestedBy,
  ): Promise<Vehicle> {
    const vehicle = await this.findOne(id, requestedBy);
    const source = await this.installationSourceRow(id);
    if (!source) {
      throw new NotFoundException("Aucune tâche d'installation liée à ce véhicule");
    }
    const requested = new Set(Array.isArray(fields) ? fields : []);
    const data: Prisma.VehicleUpdateInput = {};
    if (requested.has('brand') && source.brand) data.brand = source.brand;
    if (requested.has('model') && source.model) data.model = source.model;
    if (requested.has('energy') && source.energy) data.energy = source.energy;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Aucun champ à synchroniser (planning vide pour les champs choisis)');
    }
    return this.prisma.vehicle.update({
      where: { id: vehicle.id },
      data,
      include: { tracker: true, ...VehiclesService.CURRENT_DRIVER_INCLUDE },
    });
  }

  /**
   * Sprint 10 — Vue « Parc & capacités » : tous les véhicules accessibles + leur capacité
   * (places / sièges-enfant / équipements) alignée sur la source planning (marque/modèle/énergie),
   * avec les champs divergents pré-calculés (proposables à la synchro). Scopée tenant + granulaire.
   */
  async capacityOverview(requestedBy: RequestedBy): Promise<VehicleCapacityRowDto[]> {
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') return [];
    const where: Prisma.VehicleWhereInput = {};
    if (scope.mode === 'FLEET') where.fleetId = scope.fleetId;
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.id = { in: requestedBy.accessibleVehicleIds };
    }
    const vehicles = await this.prisma.vehicle.findMany({
      where,
      select: {
        id: true, plate: true, type: true, brand: true, model: true, energy: true,
        seats: true, childSeats: true, features: true,
        ...VehiclesService.GROUP_INCLUDE,
      },
      orderBy: { plate: 'asc' },
      take: 500,
    });
    const vids = vehicles.map((v) => v.id);
    const tasks = vids.length
      ? await this.prisma.installationTask.findMany({
          where: { vehicleId: { in: vids } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, planId: true, vehicleId: true, brand: true, model: true, energy: true,
            scheduledDate: true, firstRegistrationDate: true,
            plan: { select: { clientName: true } },
          },
        })
      : [];
    const srcByVeh = new Map<string, VehicleInstallationSourceDto>();
    for (const t of tasks) {
      if (!t.vehicleId || srcByVeh.has(t.vehicleId)) continue; // 1re rencontrée (desc) = la plus récente
      srcByVeh.set(t.vehicleId, {
        taskId: t.id,
        planId: t.planId,
        planName: t.plan?.clientName ?? null,
        scheduledDate: t.scheduledDate ? t.scheduledDate.toISOString() : null,
        brand: t.brand ?? null,
        model: t.model ?? null,
        energy: t.energy ?? null,
        firstRegistrationDate: t.firstRegistrationDate ? t.firstRegistrationDate.toISOString() : null,
      });
    }
    return vehicles.map((v) => {
      const source = srcByVeh.get(v.id) ?? null;
      const divergentFields: VehicleSyncableField[] = [];
      if (source) {
        if (source.brand && source.brand !== v.brand) divergentFields.push('brand');
        if (source.model && source.model !== v.model) divergentFields.push('model');
        if (source.energy && source.energy !== v.energy) divergentFields.push('energy');
      }
      return {
        vehicleId: v.id,
        plate: v.plate,
        type: v.type,
        brand: v.brand,
        model: v.model,
        energy: v.energy,
        seats: v.seats,
        childSeats: v.childSeats,
        features: v.features,
        group: v.groups?.[0]?.group ?? null,
        installationSource: source,
        divergentFields,
      };
    });
  }

  async stats(requestedBy: RequestedBy): Promise<{
    total: number;
    moving: number;
    idle: number;
    criticalAlerts: number;
    newThisMonth: number;
  }> {
    // V1.10 (Sprint 2 perf) — cache 60s pour le scope 'ALL'. A 10+ utilisateurs
    // sur le dashboard, divise le nombre de stats() par DB par ~30 (60 / 2s polls).
    // V1.16 (audit A3/B1) — fail-closed AVANT le cache : un non-super sans
    // fleetId ne voit RIEN (jamais "toutes flottes"). Resolu avant kpiCacheKey
    // pour ne pas lire/ecrire une entree poisonnee sous la cle 'none'.
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') {
      return { total: 0, moving: 0, idle: 0, criticalAlerts: 0, newThisMonth: 0 };
    }

    const cacheKey = this.kpiCacheKey('stats', requestedBy);
    if (cacheKey) {
      const hit = this.cache.get<{
        total: number; moving: number; idle: number; criticalAlerts: number; newThisMonth: number;
      }>(cacheKey);
      if (hit) return hit;
    }

    let fleetFilter: Prisma.VehicleWhereInput =
      scope.mode === 'FLEET' ? { fleetId: scope.fleetId } : {};

    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      fleetFilter = { ...fleetFilter, id: { in: requestedBy.accessibleVehicleIds } };
    }

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [total, newThisMonth, movingVehicles, criticalAlerts] = await Promise.all([
      this.prisma.vehicle.count({ where: fleetFilter }),
      this.prisma.vehicle.count({ where: { ...fleetFilter, createdAt: { gte: monthStart } } }),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT v."id") as count
        FROM vehicles v
        JOIN trackers t ON t."vehicleId" = v."id"
        JOIN positions p ON p."trackerId" = t."id"
        WHERE p."timestamp" > ${fiveMinAgo}
          AND p."speedKmh" > 5
          ${scope.mode === 'FLEET'
            ? Prisma.sql`AND v."fleetId" = ${scope.fleetId}::uuid`
            : Prisma.empty}
          ${requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL'
            ? Prisma.sql`AND v."id" = ANY(${requestedBy.accessibleVehicleIds}::uuid[])`
            : Prisma.empty}
      `,
      this.prisma.alert.count({
        where: {
          severity: 'CRITICAL',
          acknowledgedAt: null,
          ...(scope.mode === 'FLEET'
            ? { fleetId: scope.fleetId }
            : {}),
          ...(requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL'
            ? { vehicleId: { in: requestedBy.accessibleVehicleIds } }
            : {}),
        },
      }),
    ]);

    const moving = Number(movingVehicles[0]?.count ?? 0);

    const result = {
      total,
      moving,
      idle: total - moving,
      criticalAlerts,
      newThisMonth,
    };
    if (cacheKey) this.cache.set(cacheKey, result, STATS_TTL_MS);
    return result;
  }

  /**
   * Snapshot bulk de la flotte : tous les vehicules accessibles + leur derniere
   * position connue (lue depuis les colonnes denormalisees `Tracker.last*`).
   *
   * V1.10 (Sprint 2 perf) — `select` ciblé au lieu de `include: { tracker: true }`
   * pour eviter de charger les champs lourds non utilises (fix interval state,
   * verboseUntil, sampling state, etc). Reduction payload ~60% a 100+ vehicules.
   *
   * Borne `take` defensive — un fleet avec >2000 vehicules sortirait du scope
   * realiste actuel et risquerait OOM. Au-dela il faut paginer cote frontend.
   *
   * Note : la query engine_control_commands depend de trackerIds → impossible
   * de paralleliser avec Promise.all. L'index [trackerId, createdAt DESC]
   * ajoute en Sprint 2 fait le job pour la rendre rapide (~5ms a 100 vehicules).
   */
  async snapshot(requestedBy: RequestedBy): Promise<VehicleSnapshotDto[]> {
    // V1.10 (Sprint 2 perf) — cache 15s pour le scope 'ALL'. Le WS broadcast
    // les positions temps reel en parallele, donc 15s de staleness HTTP est
    // imperceptible pour l'utilisateur.
    // V1.16 (audit A3) — fail-closed avant le cache (cf. stats()).
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') return [];

    const cacheKey = this.kpiCacheKey('snapshot', requestedBy);
    if (cacheKey) {
      const hit = this.cache.get<VehicleSnapshotDto[]>(cacheKey);
      if (hit) return hit;
    }

    const where: Prisma.VehicleWhereInput = {};

    if (scope.mode === 'FLEET') where.fleetId = scope.fleetId;

    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.id = { in: requestedBy.accessibleVehicleIds };
    }

    const vehicles = await this.prisma.vehicle.findMany({
      where,
      select: {
        id: true,
        fleetId: true,
        plate: true,
        type: true,
        brand: true,
        model: true,
        tracker: {
          select: {
            id: true,
            imei: true,
            status: true,
            lastSeenAt: true,
            lastLat: true,
            lastLng: true,
            lastSpeedKmh: true,
            lastHeading: true,
            lastIgnition: true,
            lastValid: true,
            lastPositionAt: true,
            accConnected: true,
            createdAt: true,
          },
        },
        schedule: { select: { enabled: true } },
        // Sprint 1 (Fondation Groupes) — groupe (single) pour le popup carte.
        ...VehiclesService.GROUP_INCLUDE,
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });

    // Sprint 2 (Obj 3 + revue #2) — etat coupe TRI-ETAT par tracker :
    //   'cut'     = coupure CONFIRMEE (ACKNOWLEDGED, toutes sources dont DEVICE_OBSERVED
    //               = coupure SMS/externe detectee par chute d'ignition)
    //   'pending' = coupure COMMANDEE non encore confirmee (SENT) — ex. vehicule a
    //               l'arret (non verifiable par ignition) : a verifier, PAS "normal"
    //   sinon      = normal. Un RESTORE (SENT||ACK) plus recent nettoie l'etat : le
    //   rallumage est toujours sur et ne requiert pas de confirmation (sinon l'etat
    //   "coupe" resterait colle, le RESTORE app n'etant jamais ACKNOWLEDGED).
    const trackerIds = vehicles.map((v) => v.tracker?.id).filter(Boolean) as string[];
    const cutStateByTracker = new Map<string, 'cut' | 'pending'>();

    if (trackerIds.length > 0) {
      const lastCmds = await this.prisma.engineControlCommand.findMany({
        where: {
          trackerId: { in: trackerIds },
          status: { in: [CommandStatus.SENT, CommandStatus.ACKNOWLEDGED] },
          // Bug « véhicule garé = coupé » : on EXCLUT les commandes DEVICE_OBSERVED.
          // Elles sont synthétisées à CHAQUE coupure de contact (ignition OFF) pour
          // tenter de détecter une coupure SMS/externe — mais elles se déclenchent
          // tout autant sur un simple stationnement (indistinguable d'une coupure).
          // Résultat : tout véhicule garé apparaissait « coupé » → bouton « Rallumer »
          // à tort (cf. veilleur). L'état coupé du bouton ne doit refléter QUE les
          // immobilisations réellement commandées par l'app : MANUAL/SCHEDULER
          // (dont la coupe veilleur). Les DEVICE_OBSERVED restent en base (audit).
          source: { not: 'DEVICE_OBSERVED' },
        },
        orderBy: { createdAt: 'desc' },
        distinct: ['trackerId', 'action'],
        select: { trackerId: true, action: true, status: true, createdAt: true },
      });
      const perTracker = new Map<string, { cut?: { status: CommandStatus; createdAt: Date }; restoreAt?: Date }>();
      for (const cmd of lastCmds) {
        const e = perTracker.get(cmd.trackerId) ?? {};
        if (cmd.action === EngineAction.CUT) e.cut = { status: cmd.status, createdAt: cmd.createdAt };
        else e.restoreAt = cmd.createdAt;
        perTracker.set(cmd.trackerId, e);
      }
      for (const [tid, e] of perTracker) {
        if (!e.cut) continue;
        if (e.restoreAt && e.restoreAt > e.cut.createdAt) continue; // rallumage plus recent -> normal
        cutStateByTracker.set(tid, e.cut.status === CommandStatus.ACKNOWLEDGED ? 'cut' : 'pending');
      }
    }

    const result: VehicleSnapshotDto[] = vehicles.map((v) => {
      const t = v.tracker;
      return {
        vehicleId: v.id,
        fleetId: v.fleetId,
        plate: v.plate,
        type: v.type,
        brand: v.brand,
        model: v.model,
        trackerId: t?.id ?? null,
        trackerImei: t?.imei ?? null,
        trackerStatus: (t?.status as 'ONLINE' | 'OFFLINE' | 'IDLE' | undefined) ?? null,
        lastSeenAt: t?.lastSeenAt ? t.lastSeenAt.toISOString() : null,
        lastLat: t?.lastLat ?? null,
        lastLng: t?.lastLng ?? null,
        lastSpeedKmh: t?.lastSpeedKmh ?? null,
        lastHeading: t?.lastHeading ?? null,
        lastIgnition: t?.lastIgnition ?? null,
        lastValid: t?.lastValid ?? null,
        lastPositionAt: t?.lastPositionAt ? t.lastPositionAt.toISOString() : null,
        accConnected: t?.accConnected ?? null,
        trackerCreatedAt: t?.createdAt ? t.createdAt.toISOString() : null,
        engineCutActive: t ? cutStateByTracker.get(t.id) === 'cut' : null,
        engineCutState: t ? (cutStateByTracker.get(t.id) ?? 'normal') : null,
        scheduleEnabled: !!v.schedule?.enabled,
        group: v.groups?.[0]?.group ?? null,
      };
    });

    if (cacheKey) this.cache.set(cacheKey, result, SNAPSHOT_TTL_MS);
    return result;
  }
}
