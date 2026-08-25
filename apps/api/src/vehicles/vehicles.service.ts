import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandStatus, EngineAction, Prisma, UserRole , VehicleOutOfServiceReason } from '@prisma/client';
import type { Vehicle } from '@prisma/client';
import type {
  VehicleCapacityRowDto,
  VehicleInstallationSourceDto,
  VehicleSnapshotDto,
  VehicleSyncableField,
} from '@vizyo/tracky-shared';
// Dormance (lot « dénominateurs ») — seuils et prédicats PARTAGÉS avec l'UI : ce fichier ne
// doit plus contenir de seuil de fraîcheur maison. `isVehicleDormant` est volontairement
// asymétrique (faux sans boîtier, faux si le boîtier n'a JAMAIS émis) — cf. tracker-liveness.
import {
  DORMANT_STOP_COUNTING_MS,
  MOVING_FRESHNESS_MS,
  formatSilenceLabel,
  isVehicleDormant,
} from '@vizyo/tracky-shared';
import { InMemoryCacheService } from '../common/cache/in-memory-cache.service';
import { resolveTenantScope } from '../common/tenant-scope';
import { GpsDeadZonesService } from '../gps-dead-zones/gps-dead-zones.service';
import {
  estStationnementPresume,
  libelleZoneParking,
  type TrackerPourPresomption,
} from '../gps-dead-zones/presomption-stationnement';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { UnlockTokenService } from '../driver-unlock/unlock-token.service';
import * as QRCode from 'qrcode';
import type { CreateVehicleDto } from './dto/create-vehicle.dto';
import type { UpdateVehicleDto } from './dto/update-vehicle.dto';

// V1.10 (Sprint 2 perf) — TTLs cache KPI.
//   - SNAPSHOT_TTL_MS : positions temps reel, mais on accepte 15s de fraicheur
//     pour reduire la charge DB. Le WS broadcast push les updates temps reel
//     en parallele du polling — l'utilisateur voit l'evenement immediatement.
//   - STATS_TTL_MS : KPIs agreges (count vehicules, alertes critiques), 60s
//     suffit largement (rythme de mise à jour business = minute).
const SNAPSHOT_TTL_MS = 15_000;
const STATS_TTL_MS = 60_000;

/**
 * Borne du balayage de présence des KPI (`stats`). Même ordre de grandeur que le `take` de
 * `snapshot()` : deux colonnes par véhicule (id + lastSeenAt du boîtier), donc négligeable
 * face au reste de la requête, mais on ne descend jamais un `findMany` non borné sur un VPS
 * 2 vCPU. `total` reste compté par la DB (exact) : seule la RÉPARTITION est bornée.
 */
const PRESENCE_SCAN_CAP = 2000;

/**
 * KPI du dashboard. `moving` / `idle` / `unreachable` forment une partition EXPLICITE du parc
 * (chaque véhicule tombe dans une case et une seule), et non plus « idle = total - moving ».
 * Le résidu masquait le fait réel : au 27/07, 2 véhicules muets depuis 89 j et 52 j étaient
 * comptés « à l'arrêt », donc indiscernables d'une camionnette garée pour la nuit.
 */
export interface FleetVehicleStats {
  total: number;
  /** Boîtier joignable ET une position > 5 km/h dans les {@link MOVING_FRESHNESS_MS} dernières minutes. */
  moving: number;
  /** Boîtier joignable mais pas de mouvement récent : à l'arrêt, au sens où le client l'entend. */
  idle: number;
  /**
   * INJOIGNABLES : boîtier posé, qui a déjà parlé, puis muet depuis plus de
   * {@link DORMANT_STOP_COUNTING_MS}. Jamais retirés du `total` — on les nomme, on ne les cache pas.
   * Les véhicules SANS boîtier n'entrent pas ici (ils ne se sont pas « tus ») : ils restent dans `idle`.
   */
  unreachable: number;
  criticalAlerts: number;
  newThisMonth: number;
  /** Seuil de silence appliqué (ms) — permet à l'UI d'écrire « muet depuis plus de 7 jours ». */
  dormantThresholdMs: number;
  /**
   * `true` si le balayage de présence a été borné ({@link PRESENCE_SCAN_CAP}) : `total` reste
   * exact mais la somme des trois cases lui est INFÉRIEURE. Exposé au lieu d'être subi — un
   * plafond qui rogne des compteurs en silence est précisément ce que ce lot corrige, et la
   * page « Horaires » a déjà ce réflexe avec `awaitingStopScanTruncated`.
   */
  presenceScanTruncated: boolean;
}

/**
 * Ligne « Parc & capacités » enrichie de la présence du boîtier. Les champs de dormance sont
 * AJOUTÉS au DTO partagé, jamais substitués : un véhicule muet reste dans le tableau, avec ses
 * capacités et sa source planning — on ne fait que le SIGNALER (pastille + ancienneté).
 */
export type VehicleCapacityRow = VehicleCapacityRowDto & {
  /** `true` = boîtier muet depuis plus de {@link DORMANT_STOP_COUNTING_MS}. */
  dormant: boolean;
  /** ISO — dernier signal du boîtier, ou null (pas de boîtier / jamais émis). */
  lastSeenAt: string | null;
  /** Ancienneté du silence en clair (« 45 min », « 89 j »), ou null si le boîtier n'a jamais parlé. */
  silenceLabel: string | null;
};

export interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
  accessibleVehicleIds?: string[] | 'ALL';
}

/** Sprint 1 (Fondation Groupes) — référence groupe (single) attachée aux réponses véhicule. */
export type VehicleGroupRef = { id: string; name: string } | null;
export type VehicleWithGroup = Vehicle & {
  group: VehicleGroupRef;
  moving?: boolean;
  /**
   * TRK-046 — libellé du lieu quand le véhicule est CONSIDÉRÉ STATIONNÉ (hors champ GPS,
   * dernière position dans un parking validé, aucun soupçon d'alimentation). `null` sinon.
   * Dérivé au read-time — jamais persisté : à la première position valide, il disparaît.
   */
  presumedParkedZone?: string | null;
};

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
    // Incident FS-253 — dernière trame no_fix : permet à la LISTE de détecter GPS_LOST.
    lastNoFixAt: true,
    // TRK-046 — entrées de la présomption de stationnement (et du tri-état côté client).
    lastKnownIgnition: true,
    powerLossSuspectAt: true,
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
    private readonly unlockToken: UnlockTokenService,
    private readonly systemActivity: SystemActivityService,
    // TRK-046 — présomption de stationnement : zones parking validées + rattachement spatial.
    private readonly deadZones: GpsDeadZonesService,
  ) {}

  /**
   * TRK-046 — libellé « considéré stationné » d'un véhicule, ou null. Les zones arrivent
   * pré-chargées EN LOT (une requête pour toute la liste) ; le rattachement spatial reste
   * celui de GpsDeadZonesService. Fail-open : le moindre doute rend null et l'affichage
   * retombe sur le tri-état classique.
   */
  private presumedParkedLabel(
    tracker: TrackerPourPresomption | null | undefined,
    zonesDuVehicule: Awaited<ReturnType<GpsDeadZonesService['zonesParkingParVehicule']>> extends Map<string, infer Z> ? Z : never,
  ): string | null {
    try {
      if (!tracker || !zonesDuVehicule?.length) return null;
      const zone = this.deadZones.matchAmong(zonesDuVehicule, tracker.lastLat, tracker.lastLng);
      if (!zone) return null;
      return estStationnementPresume(tracker, zone) ? libelleZoneParking(zone) : null;
    } catch {
      return null;
    }
  }

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

  /**
   * Cadre de temps de travail par défaut (lot 2) : lun-ven 07h00-19h00, samedi/dimanche fermés.
   * `enabled: true` = le cadre est DÉFINI ; c'est `Vehicle.mixedUseEnabled` (false par défaut) qui
   * décide s'il s'APPLIQUE. Les horaires sont explicites à dessein : sans start/end, l'évaluateur
   * considère la journée entière hors plage et le véhicule serait privé 24/7.
   */
  private static readonly DEFAULT_WORK_SCHEDULE = {
    enabled: true,
    timezone: 'Europe/Paris',
    mondayEnabled: true, mondayStart: '07:00', mondayEnd: '19:00',
    tuesdayEnabled: true, tuesdayStart: '07:00', tuesdayEnd: '19:00',
    wednesdayEnabled: true, wednesdayStart: '07:00', wednesdayEnd: '19:00',
    thursdayEnabled: true, thursdayStart: '07:00', thursdayEnd: '19:00',
    fridayEnabled: true, fridayStart: '07:00', fridayEnd: '19:00',
    saturdayEnabled: false,
    sundayEnabled: false,
  } as const;

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
          // Lot 2 (RGPD) — cadre de temps de travail PRÊT À L'EMPLOI dès la création : lundi→vendredi
          // 07h00-19h00, week-end fermé. Il ne s'applique PAS tant que `mixedUseEnabled` reste false
          // (défaut) : le véhicule est tracé 24/7, antivol actif. Le jour où un fleet-admin déclare
          // le véhicule à usage mixte, la protection est immédiate et sensée — sans avoir à saisir
          // des horaires (un cadre vide rendrait le véhicule privé en permanence, cf. legacyDaySlot).
          workSchedule: { create: VehiclesService.DEFAULT_WORK_SCHEDULE },
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
    // Fix veilleur — `moving` (booléen) dérivé de la dernière position connue, pour
    // hydrater l'état « en mouvement » côté client (le veilleur grise alors le bouton
    // « Couper » dès l'ouverture, sans attendre une transition WS). Seuil aligné sur
    // REST_SPEED_KMH (5 km/h) du garde coupe-moteur.
    // TRK-046 — zones parking validées chargées EN LOT (une requête), jamais par véhicule.
    const zonesParVehicule = await this.deadZones.zonesParkingParVehicule(rows.map((v) => v.id));
    return rows.map((v) => {
      const withGroup = VehiclesService.withGroup(v);
      const moving =
        !!v.tracker && v.tracker.lastIgnition === true && (v.tracker.lastSpeedKmh ?? 0) > 5;
      const presumedParkedZone = this.presumedParkedLabel(
        v.tracker as TrackerPourPresomption | null,
        zonesParVehicule.get(v.id) ?? [],
      );
      return { ...withGroup, moving, presumedParkedZone };
    }) as VehicleWithGroup[];
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

    // TRK-046 — même dérivation que la liste (fiche et liste ne doivent jamais se contredire).
    const zonesParVehicule = await this.deadZones.zonesParkingParVehicule([vehicle.id]);
    const presumedParkedZone = this.presumedParkedLabel(
      vehicle.tracker as TrackerPourPresomption | null,
      zonesParVehicule.get(vehicle.id) ?? [],
    );
    return { ...VehiclesService.withGroup(vehicle), presumedParkedZone };
  }

  /**
   * feat/comptes-conducteurs (4a) — QR de déverrouillage d'UN véhicule : jeton signé + deep-link
   * vers l'écran conducteur + rendu SVG. Le scoping IDOR (404 cross-fleet + périmètre granulaire)
   * est délégué à `findOne`. Le QR n'est pas un secret : le verrou reste l'autorisation + la proximité.
   */
  async buildUnlockQr(
    id: string,
    requestedBy: RequestedBy,
  ): Promise<{ vehicleId: string; plate: string | null; token: string; url: string; svg: string }> {
    const vehicle = await this.findOne(id, requestedBy);
    const { token, url } = this.unlockToken.buildDeepLink(vehicle.id);
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 });
    return { vehicleId: vehicle.id, plate: vehicle.plate, token, url, svg };
  }

  /**
   * feat/comptes-conducteurs (4a) — Feuille HTML imprimable de TOUS les QR du périmètre accessible
   * (une carte plaque + QR par véhicule). Scopée tenant + granulaire. Pour un SUPER_ADMIN, `superFleetId`
   * (sélecteur société) limite la feuille à une flotte (sinon toutes flottes, capé à 500).
   */
  async buildUnlockQrSheet(requestedBy: RequestedBy, superFleetId?: string | null): Promise<string> {
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') return this.renderQrSheet([]);
    const where: Prisma.VehicleWhereInput = {};
    if (scope.mode === 'FLEET') where.fleetId = scope.fleetId;
    else if (scope.mode === 'ALL' && superFleetId) where.fleetId = superFleetId;
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.id = { in: requestedBy.accessibleVehicleIds };
    }
    const vehicles = await this.prisma.vehicle.findMany({
      where,
      select: { id: true, plate: true, brand: true, model: true },
      orderBy: { plate: 'asc' },
      take: 500,
    });
    const cards = await Promise.all(
      vehicles.map(async (v) => {
        const { url } = this.unlockToken.buildDeepLink(v.id);
        const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200 });
        return { plate: v.plate, subtitle: [v.brand, v.model].filter(Boolean).join(' '), svg };
      }),
    );
    return this.renderQrSheet(cards);
  }

  /**
   * feat/comptes-conducteurs — DONNÉES JSON des QR de déverrouillage du périmètre (plaque + modèle +
   * lien signé), pour un rendu PREMIUM côté client de la feuille imprimable (mêmes cartes que la fiche
   * véhicule). Même scope tenant + granulaire que `buildUnlockQrSheet` ; capé à 500.
   */
  async buildUnlockQrLinks(
    requestedBy: RequestedBy,
    superFleetId?: string | null,
  ): Promise<{ items: { vehicleId: string; plate: string | null; model: string | null; url: string }[] }> {
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') return { items: [] };
    const where: Prisma.VehicleWhereInput = {};
    if (scope.mode === 'FLEET') where.fleetId = scope.fleetId;
    else if (scope.mode === 'ALL' && superFleetId) where.fleetId = superFleetId;
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.id = { in: requestedBy.accessibleVehicleIds };
    }
    const vehicles = await this.prisma.vehicle.findMany({
      where,
      select: { id: true, plate: true, brand: true, model: true },
      orderBy: { plate: 'asc' },
      take: 500,
    });
    return {
      items: vehicles.map((v) => ({
        vehicleId: v.id,
        plate: v.plate,
        model: [v.brand, v.model].filter(Boolean).join(' ') || null,
        url: this.unlockToken.buildDeepLink(v.id).url,
      })),
    };
  }

  /** Rendu de la feuille imprimable (grille de cartes plaque + QR), CSS d'impression inclus. */
  private renderQrSheet(cards: { plate: string | null; subtitle: string; svg: string }[]): string {
    const esc = (s: string): string =>
      s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    const items = cards
      .map(
        (c) => `
      <div class="card">
        <div class="svg">${c.svg}</div>
        <div class="plate">${esc(c.plate ?? '—')}</div>
        ${c.subtitle ? `<div class="sub">${esc(c.subtitle)}</div>` : ''}
        <div class="hint">Scannez pour déverrouiller</div>
      </div>`,
      )
      .join('');
    const empty = cards.length === 0 ? '<p class="empty">Aucun véhicule accessible.</p>' : '';
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>QR de déverrouillage — Vizyo Tracky</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 16px; color: #0b1220; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #64748b; font-size: 12px; margin: 0 0 16px; max-width: 640px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .card { border: 1px solid #cbd5e1; border-radius: 10px; padding: 12px; text-align: center; page-break-inside: avoid; }
  .card .svg svg { width: 100%; height: auto; max-width: 200px; }
  .plate { font-weight: 700; font-size: 15px; margin-top: 6px; letter-spacing: .5px; }
  .sub { color: #64748b; font-size: 12px; }
  .hint { color: #94a3b8; font-size: 10px; margin-top: 4px; }
  .empty { color: #64748b; }
  .toolbar { margin-bottom: 12px; }
  @media print { .toolbar { display: none; } body { margin: 0; } .grid { gap: 8px; } }
</style></head>
<body>
  <div class="toolbar"><button onclick="window.print()">Imprimer</button></div>
  <h1>QR de déverrouillage — Vizyo Tracky</h1>
  <p class="meta">Un QR par véhicule. Le conducteur autorisé le scanne avec son téléphone pour déverrouiller le véhicule (à proximité).</p>
  ${empty}
  <div class="grid">${items}</div>
</body></html>`;
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

  /**
   * Declare (ou leve) l'etat HORS SERVICE d'un vehicule — reserve au SUPER_ADMIN.
   *
   * ── POURQUOI CET ETAT EXISTE ─────────────────────────────────────────────────────
   *
   * Un vehicule qui ne roule plus reste dans le perimetre de tous les traitements de fond.
   * Il y produit du travail impossible et des alertes vraies-mais-inutiles. Mesure du
   * 2026-08-21 sur KSR370, accidente : 843 trajets a re-segmenter et 1 309 a analyser, soit
   * 99 % du reste-a-faire de TOUTE la flotte pour un seul vehicule immobilise. Impossible,
   * en lisant les compteurs, de savoir si la convergence avancait.
   *
   * ⚠️ AUCUNE DONNEE N'EST TOUCHEE. L'etat ne supprime rien, ne fige rien en base : il retire
   *    seulement le vehicule du perimetre des traitements. Une remise en service le fait
   *    reprendre exactement ou il en etait — c'est la condition pour que ce soit un
   *    interrupteur et non une decision irreversible.
   */
  async setOutOfService(
    id: string,
    dto: { reason?: VehicleOutOfServiceReason | null; note?: string },
    requestedBy: RequestedBy,
  ): Promise<VehicleWithGroup> {
    // Le controleur porte deja la garde de role. On la repose ici : un service qui ne se
    // defend pas seul finit par etre appele depuis un endroit qui a oublie la garde.
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Action réservée au super-admin.');
    }

    const actuel = await this.prisma.vehicle.findUnique({
      where: { id },
      select: { id: true, plate: true, fleetId: true, outOfServiceReason: true },
    });
    if (!actuel) throw new NotFoundException('Véhicule introuvable');

    const motif = dto.reason ?? null;
    const note = (dto.note ?? '').trim() || null;
    const changeDeMotif = actuel.outOfServiceReason !== motif;

    await this.prisma.vehicle.update({
      where: { id },
      data: {
        outOfServiceReason: motif,
        // La date ne bouge QUE si le motif change : corriger une note ne doit pas faire croire
        // que le vehicule vient d'etre immobilise.
        ...(changeDeMotif ? { outOfServiceSince: motif ? new Date() : null } : {}),
        outOfServiceById: motif ? (requestedBy.userId ?? null) : null,
        outOfServiceNote: motif ? note : null,
      },
    });

    // Le journal garde l'HISTORIQUE des bascules ; la fiche ne porte que l'etat courant.
    // Sans lui, on saurait qu'un vehicule est hors service sans savoir depuis combien de
    // bascules ni sur decision de qui.
    this.systemActivity.record({
      category: 'MUTATION',
      action: motif ? 'vehicle_out_of_service' : 'vehicle_back_in_service',
      status: 'SUCCESS',
      actor: 'super-admin',
      target: actuel.plate,
      detail: motif
        ? `${actuel.plate} déclaré hors service (${motif})${note ? ` — ${note}` : ''}`
        : `${actuel.plate} remis en service`,
      meta: { vehicleId: id, fleetId: actuel.fleetId, reason: motif, note },
    });

    this.invalidateKpiCache(actuel.fleetId);
    return this.findOne(id, requestedBy);
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
   *
   * Dormance : la vue SIGNALE le boîtier muet (pastille + ancienneté) sans RETIRER la ligne. Un
   * véhicule dont le boîtier s'est tu reste un véhicule du parc : il a toujours 9 places et 2
   * sièges-enfant, il reste planifiable, et c'est justement cette page qui doit permettre de
   * remarquer qu'on compte sur une capacité qu'on ne voit plus depuis 89 jours.
   */
  async capacityOverview(requestedBy: RequestedBy): Promise<VehicleCapacityRow[]> {
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
        // Greffé sur la requête EXISTANTE (jointure 1-1 déjà indexée) plutôt qu'une 2e requête :
        // le VPS 2 vCPU ne doit pas payer un aller-retour de plus pour deux colonnes.
        tracker: { select: { id: true, lastSeenAt: true } },
        ...VehiclesService.GROUP_INCLUDE,
      },
      orderBy: { plate: 'asc' },
      take: 500,
    });
    const now = Date.now();
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
      const lastSeenAt = v.tracker?.lastSeenAt ?? null;
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
        // Dérivé au read-time : aucun champ en base, aucun drapeau à lever ni à baisser.
        // Le jour où le boîtier ré-émet, `dormant` retombe à false tout seul au prochain appel.
        dormant: isVehicleDormant({ trackerId: v.tracker?.id ?? null, lastSeenAt }, now),
        lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
        silenceLabel: formatSilenceLabel(lastSeenAt, now),
      };
    });
  }

  async stats(requestedBy: RequestedBy, superFleetId?: string | null): Promise<FleetVehicleStats> {
    // V1.10 (Sprint 2 perf) — cache 60s pour le scope 'ALL'. A 10+ utilisateurs
    // sur le dashboard, divise le nombre de stats() par DB par ~30 (60 / 2s polls).
    // V1.16 (audit A3/B1) — fail-closed AVANT le cache : un non-super sans
    // fleetId ne voit RIEN (jamais "toutes flottes"). Resolu avant kpiCacheKey
    // pour ne pas lire/ecrire une entree poisonnee sous la cle 'none'.
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') {
      return {
        total: 0, moving: 0, idle: 0, unreachable: 0, criticalAlerts: 0, newThisMonth: 0,
        dormantThresholdMs: DORMANT_STOP_COUNTING_MS, presenceScanTruncated: false,
      };
    }

    // Filtre société GLOBAL (sélecteur super-admin) : un SUPER_ADMIN peut scoper les KPI
    // à une flotte précise. Un non-super est déjà borné à SA flotte (superFleetId ignoré).
    const effectiveFleetId: string | null =
      scope.mode === 'FLEET' ? scope.fleetId : (superFleetId ?? null);

    // On BYPASSE le cache quand un super-admin filtre par flotte (sinon la clé partagée
    // 'stats:super' serait empoisonnée par une vue mono-flotte). Ces vues filtrées sont
    // plus rares que le poll « toutes flottes ».
    const cacheKey = effectiveFleetId && scope.mode !== 'FLEET' ? null : this.kpiCacheKey('stats', requestedBy);
    if (cacheKey) {
      const hit = this.cache.get<FleetVehicleStats>(cacheKey);
      if (hit) return hit;
    }

    let fleetFilter: Prisma.VehicleWhereInput =
      effectiveFleetId ? { fleetId: effectiveFleetId } : {};

    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      fleetFilter = { ...fleetFilter, id: { in: requestedBy.accessibleVehicleIds } };
    }

    const now = Date.now();
    // Seuil de fraîcheur « en mouvement » : plus de constante locale réinventée ici. C'est la
    // MÊME valeur (5 min) que celle lue par la carte et la fiche véhicule — sinon le dashboard
    // pouvait annoncer « 12 en mouvement » pendant que la carte n'en montrait que 9.
    const movingSince = new Date(now - MOVING_FRESHNESS_MS);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [total, newThisMonth, movingVehicles, criticalAlerts, presenceRows] = await Promise.all([
      this.prisma.vehicle.count({ where: fleetFilter }),
      this.prisma.vehicle.count({ where: { ...fleetFilter, createdAt: { gte: monthStart } } }),
      // On remonte les IDENTIFIANTS (et non plus un COUNT) : la répartition ci-dessous a besoin
      // de savoir QUI roule pour ranger chaque véhicule dans une case et une seule. Même plan
      // d'exécution, même index — seule la projection change.
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT v."id" AS id
        FROM vehicles v
        JOIN trackers t ON t."vehicleId" = v."id"
        JOIN positions p ON p."trackerId" = t."id"
        WHERE p."timestamp" > ${movingSince}
          AND p."speedKmh" > 5
          ${effectiveFleetId
            ? Prisma.sql`AND v."fleetId" = ${effectiveFleetId}::uuid`
            : Prisma.empty}
          ${requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL'
            ? Prisma.sql`AND v."id" = ANY(${requestedBy.accessibleVehicleIds}::uuid[])`
            : Prisma.empty}
      `,
      this.prisma.alert.count({
        where: {
          severity: 'CRITICAL',
          acknowledgedAt: null,
          ...(effectiveFleetId
            ? { fleetId: effectiveFleetId }
            : {}),
          ...(requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL'
            ? { vehicleId: { in: requestedBy.accessibleVehicleIds } }
            : {}),
        },
      }),
      // Présence du parc : `Tracker.lastSeenAt` et RIEN d'autre. Pas Trip/Position (vidés en
      // mode vie privée alors que le boîtier parle : on classerait injoignable tout véhicule
      // sous RGPD), pas `Tracker.status` (colonne collante, jamais remise à OFFLINE).
      this.prisma.vehicle.findMany({
        where: fleetFilter,
        select: { id: true, tracker: { select: { id: true, lastSeenAt: true } } },
        take: PRESENCE_SCAN_CAP,
      }),
    ]);

    const movingIds = new Set(movingVehicles.map((r) => r.id));
    // Partition EXPLICITE : chaque véhicule est rangé par un test qui lui est propre. L'ancien
    // `idle = total - moving` faisait de « à l'arrêt » un fourre-tout qui absorbait en silence
    // tout ce qu'on ne savait pas classer — dont FV-941-LZ, muet depuis 89 jours.
    let moving = 0;
    let idle = 0;
    let unreachable = 0;
    for (const v of presenceRows) {
      const dormant = isVehicleDormant(
        { trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null },
        now,
      );
      // La dormance est testée EN PREMIER : un boîtier muet depuis des semaines ne peut pas
      // avoir de position fraîche, mais si les deux se contredisaient (rejeu d'archive, horloge
      // boîtier folle), c'est l'INJOIGNABLE qui doit gagner — le silence est le fait dur.
      if (dormant) unreachable++;
      else if (movingIds.has(v.id)) moving++;
      // Reste : boîtier joignable sans mouvement récent, ET véhicules SANS boîtier. Ces derniers
      // ne sont pas « injoignables » (ils ne se sont jamais tus, ils n'ont jamais parlé) : les
      // deux TEST-00x du parc sont des véhicules légitimes, à l'arrêt, pas des pannes.
      else idle++;
    }

    const result: FleetVehicleStats = {
      total,
      moving,
      idle,
      unreachable,
      criticalAlerts,
      newThisMonth,
      dormantThresholdMs: DORMANT_STOP_COUNTING_MS,
      // Au-delà de PRESENCE_SCAN_CAP véhicules, `total` reste exact (compté par la DB) mais la
      // répartition ne couvre que les premiers scannés : la somme des trois cases devient
      // inférieure au total. On le DIT au lieu de le laisser passer pour un parc qui rétrécit.
      // (Comparaison de comptages, pas `length >= cap` : un parc de très exactement 2000
      // véhicules n'est pas tronqué et ne doit pas déclencher l'avertissement.) Le jour où une
      // flotte s'en approche, il faudra agréger côté SQL — pas relever le plafond en douce.
      presenceScanTruncated: presenceRows.length < total,
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
        privacyModeEnabled: true,
        privacyModeSince: true,
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
            lastNoFixAt: true,
            // TRK-046 — entrées de la présomption de stationnement.
            lastKnownIgnition: true,
            powerLossSuspectAt: true,
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

    // TRK-046 — zones parking validées EN LOT (le snapshot est déjà caché 15 s : une
    // requête de plus par rafraîchissement, jamais une par véhicule).
    const zonesParkingSnapshot = await this.deadZones.zonesParkingParVehicule(vehicles.map((v) => v.id));

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
        lastNoFixAt: t?.lastNoFixAt ? t.lastNoFixAt.toISOString() : null,
        accConnected: t?.accConnected ?? null,
        trackerCreatedAt: t?.createdAt ? t.createdAt.toISOString() : null,
        engineCutActive: t ? cutStateByTracker.get(t.id) === 'cut' : null,
        engineCutState: t ? (cutStateByTracker.get(t.id) ?? 'normal') : null,
        scheduleEnabled: !!v.schedule?.enabled,
        privacyModeEnabled: v.privacyModeEnabled,
        privacyModeSince: v.privacyModeSince ? v.privacyModeSince.toISOString() : null,
        group: v.groups?.[0]?.group ?? null,
        presumedParkedZone: this.presumedParkedLabel(
          t as TrackerPourPresomption | null,
          zonesParkingSnapshot.get(v.id) ?? [],
        ),
      };
    });

    if (cacheKey) this.cache.set(cacheKey, result, SNAPSHOT_TTL_MS);
    return result;
  }
}
