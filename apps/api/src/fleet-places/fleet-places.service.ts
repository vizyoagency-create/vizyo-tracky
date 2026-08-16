import { requiredFleetScope } from '../common/tenant-scope';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FleetPlaceKind, Prisma, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { PlaceEnrichmentService, type PlaceFacts } from './place-enrichment.service';

/** Durée d'arrêt minimale (min) pour qu'un passage station soit considéré comme un VRAI arrêt. */
const MIN_STOP_MIN = 4;
/** Borne de lecture des passages (perf + UI). */
const MAX_PASSAGES = 300;

/**
 * Nombre de passages à partir duquel une station est considérée QUALIFIABLE — la
 * file « 8/8 · PRÊT À VALIDER » de la planche Lieux.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CE NOMBRE VIT ICI, ET NULLE PART AILLEURS                                  │
 * │                                                                            │
 * │ L'écran affichait « 8/8 » sans que rien ne définisse le 8 : il aurait dû   │
 * │ l'inventer côté client. Un seuil recopié dans le navigateur doit rester    │
 * │ d'accord avec la règle de détection du serveur — et le jour où celle-ci    │
 * │ bouge, l'écran continue d'afficher l'ancien nombre EN AYANT L'AIR JUSTE.   │
 * │                                                                            │
 * │ C'est la même erreur que la légende de carte réécrite d'après la planche   │
 * │ sans vérifier la donnée. Le serveur envoie donc le seuil ET le statut ; le │
 * │ client ne recalcule rien, il affiche.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Pourquoi 8 : c'est le seuil de la planche, et il tient au métier — en dessous,
 * quelques passages peuvent être un hasard de tournée ; au-delà, la station fait
 * partie des habitudes de la flotte.
 */
const SEUIL_PASSAGES_QUALIFIABLE = 8;

/**
 * Où en est une station dans son cycle de vie. Dérivé, jamais stocké : il se
 * recalcule à chaque lecture depuis les passages et le lien vers un lieu validé.
 *
 * - `VALIDE`         : l'exploitant l'a confirmée — elle est un lieu de la flotte.
 * - `PRET_A_VALIDER` : assez de passages pour décider, mais personne n'a décidé.
 * - `EN_COURS`       : des passages, pas encore assez.
 * - `A_QUALIFIER`    : à peine vue (un seul passage).
 */
export type StatutStation = 'A_QUALIFIER' | 'EN_COURS' | 'PRET_A_VALIDER' | 'VALIDE';

function statutStation(passages: number, dejaValidee: boolean): StatutStation {
  if (dejaValidee) return 'VALIDE';
  if (passages >= SEUIL_PASSAGES_QUALIFIABLE) return 'PRET_A_VALIDER';
  if (passages > 1) return 'EN_COURS';
  return 'A_QUALIFIER';
}

/**
 * Lieux clés (2026-07) — référentiel MÉTIER des lieux de la flotte.
 *
 * Deux natures de lieux, gérées ici :
 *  - les **stations-service VALIDÉES** : l'exploitant confirme qu'une station détectée
 *    (passage avec arrêt réel) fait partie de ses stations → elle change de couleur sur la carte ;
 *  - les **parkings / stationnements récurrents** posés à la main (ex. « CDEF Launaguet »).
 *
 * À ne pas confondre avec `FuelStation` (catalogue externe prix-carburants) ni `GpsDeadZone`
 * (zone détectée automatiquement par véhicule). Ici c'est ce que l'exploitant DÉCLARE.
 *
 * Scoping : un non-super-admin est borné à SA flotte ; le super-admin peut cibler une flotte
 * via `fleetId` (sélecteur société). Les passages sont en plus bornés au périmètre véhicules
 * de l'utilisateur (anti-IDOR), comme le reste des lectures trajets.
 */
@Injectable()
export class FleetPlacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly errorLogger: ErrorLogger,
    private readonly enrichment: PlaceEnrichmentService,
  ) {}

  /**
   * Faits OSM d'un lieu — GRATUIT et SANS IA (donc aucun gating IA) : horaires, services,
   * carburants, contact, capacité de parking, et une image libre si OSM en référence une.
   * `null` si le lieu n'est pas cartographié ou si Overpass est indisponible (best-effort).
   */
  async facts(user: AuthUser, id: string): Promise<PlaceFacts | null> {
    const place = await this.findScoped(user, id);
    return this.enrichment.enrich(place.lat, place.lng, place.kind);
  }

  /**
   * Flotte sur laquelle opérer. Un non-super est TOUJOURS borné à la sienne (le `fleetId`
   * fourni est ignoré) ; le super-admin cible celle qu'il a choisie (ou null = toutes, en lecture).
   */
  resolveFleetId(user: AuthUser, fleetId?: string): string | null {
    // ⚠️ Renvoyait `null` pour un non-super-admin sans societe, et plusieurs appelants
    // traitent `null` en OUVERTURE (`where = {}`) et non en refus. Un compte sans flotte
    // voyait donc les passages et les plaques des trois societes.
    // `requiredFleetScope` retourne une flotte IMPOSSIBLE dans ce cas : zero ligne.
    return requiredFleetScope(user, fleetId) ?? null;
  }

  /** Flotte OBLIGATOIRE pour une écriture (créer/modifier/supprimer un lieu). */
  private requireWritableFleetId(user: AuthUser, fleetId?: string): string {
    const id = this.resolveFleetId(user, fleetId);
    if (!id) {
      throw new BadRequestException(
        user.role === UserRole.SUPER_ADMIN
          ? 'Sélectionnez une société avant de créer ou modifier un lieu.'
          : 'Aucune flotte associée à votre compte.',
      );
    }
    return id;
  }

  /** Lieux clés de la flotte (stations validées + parkings + dépôts). */
  async list(user: AuthUser, fleetId?: string): Promise<FleetPlaceDto[]> {
    const scoped = this.resolveFleetId(user, fleetId);
    if (!scoped && user.role !== UserRole.SUPER_ADMIN) return [];
    const where: Prisma.FleetPlaceWhereInput = scoped ? { fleetId: scoped } : {};
    const places = await this.prisma.fleetPlace.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      take: 1000,
    });
    return places.map(toDto);
  }

  /** Crée un lieu : parking/stationnement à la main, ou validation d'une station détectée. */
  async create(
    user: AuthUser,
    dto: {
      name: string;
      kind: FleetPlaceKind;
      lat: number;
      lng: number;
      radiusM?: number;
      note?: string | null;
      stationId?: string | null;
      fleetId?: string;
    },
  ): Promise<FleetPlaceDto> {
    const fleetId = this.requireWritableFleetId(user, dto.fleetId);
    if (!Number.isFinite(dto.lat) || !Number.isFinite(dto.lng)) {
      throw new BadRequestException('Coordonnées invalides.');
    }
    // Validation d'une station : on vérifie qu'elle existe vraiment (évite un lieu fantôme
    // pointant vers un id inventé) et on récupère ses coordonnées de référence.
    if (dto.stationId) {
      const station = await this.prisma.fuelStation.findUnique({
        where: { id: dto.stationId },
        select: { id: true, lat: true, lng: true },
      });
      if (!station) throw new NotFoundException('Station introuvable.');
    }
    try {
      const created = await this.prisma.fleetPlace.create({
        data: {
          fleetId,
          name: dto.name.trim().slice(0, 120),
          kind: dto.kind,
          lat: dto.lat,
          lng: dto.lng,
          radiusM: Number.isFinite(dto.radiusM) && (dto.radiusM as number) > 0 ? (dto.radiusM as number) : 120,
          note: dto.note?.trim().slice(0, 500) || null,
          stationId: dto.stationId ?? null,
          createdById: user.id,
        },
      });
      return toDto(created);
    } catch (err) {
      // Unicité (fleetId, stationId) : la station est déjà validée pour cette flotte.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException('Cette station fait déjà partie des lieux de la flotte.');
      }
      throw err;
    }
  }

  /** Modifie un lieu (nom, nature, position, rayon, note). */
  async update(
    user: AuthUser,
    id: string,
    dto: { name?: string; kind?: FleetPlaceKind; lat?: number; lng?: number; radiusM?: number; note?: string | null },
  ): Promise<FleetPlaceDto> {
    const place = await this.findScoped(user, id);
    const data: Prisma.FleetPlaceUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim().slice(0, 120);
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.lat !== undefined) {
      if (!Number.isFinite(dto.lat)) throw new BadRequestException('Latitude invalide.');
      data.lat = dto.lat;
    }
    if (dto.lng !== undefined) {
      if (!Number.isFinite(dto.lng)) throw new BadRequestException('Longitude invalide.');
      data.lng = dto.lng;
    }
    if (dto.radiusM !== undefined && Number.isFinite(dto.radiusM) && dto.radiusM > 0) data.radiusM = dto.radiusM;
    if (dto.note !== undefined) data.note = dto.note?.trim().slice(0, 500) || null;
    const updated = await this.prisma.fleetPlace.update({ where: { id: place.id }, data });
    return toDto(updated);
  }

  /** Supprime un lieu (retire la station des lieux de la flotte, ou efface un parking). */
  async remove(user: AuthUser, id: string): Promise<{ ok: true }> {
    const place = await this.findScoped(user, id);
    await this.prisma.fleetPlace.delete({ where: { id: place.id } });
    return { ok: true };
  }

  /** Récupère un lieu en vérifiant qu'il appartient bien au périmètre de l'utilisateur (404 sinon). */
  /** Charge un lieu en appliquant le périmètre société de l'utilisateur (anti-IDOR). Public :
   *  `PlaceAnalysisService` s'en sert pour ne jamais dupliquer la règle de scoping. */
  async findScoped(user: AuthUser, id: string) {
    const place = await this.prisma.fleetPlace.findUnique({ where: { id } });
    if (!place) throw new NotFoundException('Lieu introuvable.');
    if (user.role !== UserRole.SUPER_ADMIN && place.fleetId !== user.fleetId) {
      // 404 (pas 403) pour ne pas révéler l'existence d'un lieu d'une autre société.
      throw new NotFoundException('Lieu introuvable.');
    }
    return place;
  }

  /**
   * Stations-service REGROUPÉES par lieu — UNE ligne par station, pas une par passage.
   *
   * La vue à plat répétait la même station des dizaines de fois (41 lignes pour ~6 stations) et
   * était inexploitable. Ici chaque station apparaît une seule fois avec : le nombre total de
   * passages, QUI est passé et COMBIEN DE FOIS, la période couverte, la durée d'arrêt moyenne, le
   * dernier prix, et le lieu de la flotte correspondant s'il existe. Seuls les passages avec un
   * VRAI arrêt (≥ 4 min par défaut) sont comptés.
   */
  async stationGroups(
    user: AuthUser,
    opts: { fromIso?: string; toIso?: string; fleetId?: string; minStopMin?: number } = {},
  ): Promise<StationGroupDto[]> {
    const to = opts.toIso ? new Date(opts.toIso) : new Date();
    const from = opts.fromIso ? new Date(opts.fromIso) : new Date(to.getTime() - 90 * 24 * 3600 * 1000);
    const minStopMin = Number.isFinite(opts.minStopMin) && (opts.minStopMin as number) > 0
      ? (opts.minStopMin as number)
      : MIN_STOP_MIN;

    // Périmètre véhicules (anti-IDOR) — même règle que les autres lectures trajets.
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const scopedFleet = this.resolveFleetId(user, opts.fleetId);
    const scopeWhere: Prisma.TripFuelStopWhereInput =
      accessible === 'ALL'
        ? scopedFleet
          ? { fleetId: scopedFleet }
          : {}
        : { vehicleId: { in: accessible.length ? accessible : ['00000000-0000-0000-0000-000000000000'] } };

    const stops = await this.prisma.tripFuelStop.findMany({
      where: {
        ...scopeWhere,
        arrivedAt: { gte: from, lte: to },
        // Le VRAI arrêt : on ne compte pas un simple ralentissement près d'une station.
        durationSec: { gte: Math.round(minStopMin * 60) },
      },
      select: {
        id: true, vehicleId: true, arrivedAt: true, durationSec: true, distanceM: true,
        unitPriceEur: true, fuelType: true,
        station: { select: { id: true, brand: true, name: true, city: true, address: true, lat: true, lng: true } },
      },
      orderBy: { arrivedAt: 'desc' },
      take: MAX_PASSAGES,
    });

    const withStation = stops.filter((s) => s.station);
    if (withStation.length === 0) return [];

    // Enrichissements (plaques + stations déjà validées). BEST-EFFORT : un échec ici ne doit pas
    // faire échouer toute la page — on dégrade (plaque nulle / non validé) ET on remonte au
    // centre d'alerte, sinon la panne serait invisible.
    const plateById = new Map<string, string | null>();
    const placeByStationId = new Map<string, { id: string; name: string }>();
    try {
      const vehicleIds = [...new Set(withStation.map((s) => s.vehicleId))];
      const stationIds = [...new Set(withStation.map((s) => s.station!.id))];
      const [vehicles, places] = await Promise.all([
        this.prisma.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { id: true, plate: true } }),
        this.prisma.fleetPlace.findMany({
          where: { stationId: { in: stationIds }, ...(scopedFleet ? { fleetId: scopedFleet } : {}) },
          select: { id: true, stationId: true, name: true },
        }),
      ]);
      for (const v of vehicles) plateById.set(v.id, v.plate);
      for (const p of places) if (p.stationId) placeByStationId.set(p.stationId, { id: p.id, name: p.name });
    } catch (err) {
      this.errorLogger.recordBackground(
        err instanceof Error ? err : new Error(String(err)),
        'fleet-places',
        { note: 'enrichissement des passages station (plaques / stations validées) a échoué', userId: user.id },
      );
    }

    // Regroupement par STATION : une entrée par lieu, avec le détail par véhicule.
    type Agg = {
      station: { id: string; brand: string | null; name: string | null; city: string | null; address: string | null; lat: number; lng: number };
      passages: number;
      totalStopMin: number;
      firstAt: Date;
      lastAt: Date;
      lastPriceEur: number | null;
      fuelType: string | null;
      vehicles: Map<string, { visits: number; lastAt: Date }>;
    };
    const byStation = new Map<string, Agg>();
    for (const s of withStation) {
      const st = s.station!;
      let e = byStation.get(st.id);
      if (!e) {
        e = {
          station: st,
          passages: 0,
          totalStopMin: 0,
          firstAt: s.arrivedAt,
          lastAt: s.arrivedAt,
          lastPriceEur: null,
          fuelType: null,
          vehicles: new Map(),
        };
        byStation.set(st.id, e);
      }
      e.passages += 1;
      e.totalStopMin += s.durationSec / 60;
      if (s.arrivedAt < e.firstAt) e.firstAt = s.arrivedAt;
      if (s.arrivedAt > e.lastAt) e.lastAt = s.arrivedAt;
      const v = e.vehicles.get(s.vehicleId);
      if (v) {
        v.visits += 1;
        if (s.arrivedAt > v.lastAt) v.lastAt = s.arrivedAt;
      } else {
        e.vehicles.set(s.vehicleId, { visits: 1, lastAt: s.arrivedAt });
      }
      // `stops` est trié du plus récent au plus ancien → le 1er prix non nul rencontré est le dernier relevé.
      if (e.lastPriceEur == null && s.unitPriceEur != null) {
        e.lastPriceEur = s.unitPriceEur;
        e.fuelType = s.fuelType;
      }
    }

    return [...byStation.values()]
      .map((e) => {
        const place = placeByStationId.get(e.station.id) ?? null;
        return {
          stationId: e.station.id,
          label: stationLabel(e.station),
          brand: e.station.brand,
          name: e.station.name,
          city: e.station.city,
          address: e.station.address,
          lat: e.station.lat,
          lng: e.station.lng,
          passages: e.passages,
          distinctVehicles: e.vehicles.size,
          vehicles: [...e.vehicles.entries()]
            .map(([vehicleId, v]) => ({
              vehicleId,
              plate: plateById.get(vehicleId) ?? null,
              visits: v.visits,
              lastAt: v.lastAt.toISOString(),
            }))
            .sort((a, b) => b.visits - a.visits),
          firstAt: e.firstAt.toISOString(),
          lastAt: e.lastAt.toISOString(),
          avgStopMin: Math.max(1, Math.round(e.totalStopMin / e.passages)),
          lastPriceEur: e.lastPriceEur,
          fuelType: e.fuelType,
          placeId: place?.id ?? null,
          placeName: place?.name ?? null,
          seuilPassages: SEUIL_PASSAGES_QUALIFIABLE,
          statut: statutStation(e.passages, place != null),
        };
      })
      .sort((a, b) => b.passages - a.passages || (a.lastAt < b.lastAt ? 1 : -1));
  }
}

function toDto(p: {
  id: string; fleetId: string; name: string; kind: FleetPlaceKind; lat: number; lng: number;
  radiusM: number; note: string | null; stationId: string | null; createdAt: Date; updatedAt: Date;
}): FleetPlaceDto {
  return {
    id: p.id,
    fleetId: p.fleetId,
    name: p.name,
    kind: p.kind,
    lat: p.lat,
    lng: p.lng,
    radiusM: Math.round(p.radiusM),
    note: p.note,
    stationId: p.stationId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export interface FleetPlaceDto {
  id: string;
  fleetId: string;
  name: string;
  kind: FleetPlaceKind;
  lat: number;
  lng: number;
  radiusM: number;
  note: string | null;
  /** Station d'origine si le lieu vient de la validation d'une station détectée. */
  stationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Libellé lisible d'une station. Le catalogue gouv laisse souvent `brand`/`name` VIDES — sans ce
 * repli toutes les stations s'affichaient « Station-service », impossible à distinguer dans la liste.
 */
function stationLabel(st: { brand: string | null; name: string | null; city: string | null; address: string | null }): string {
  const base = st.brand?.trim() || st.name?.trim();
  if (base) return st.city ? `${base} — ${st.city}` : base;
  const where = st.address?.trim() || st.city?.trim();
  return where ? `Station-service — ${where}` : 'Station-service';
}

/** Un véhicule passé par une station + son nombre de passages. */
export interface StationGroupVehicleDto {
  vehicleId: string;
  plate: string | null;
  visits: number;
  lastAt: string;
}

/** Une STATION regroupée (et non un passage) : qui est passé, combien de fois, quand. */
export interface StationGroupDto {
  stationId: string;
  /** Libellé prêt à afficher (marque/adresse + ville) — jamais vide. */
  label: string;
  brand: string | null;
  name: string | null;
  city: string | null;
  address: string | null;
  lat: number;
  lng: number;
  /** Nombre total de passages (arrêts réels) sur la période. */
  passages: number;
  distinctVehicles: number;
  /** Détail par véhicule, du plus fréquent au moins fréquent. */
  vehicles: StationGroupVehicleDto[];
  firstAt: string;
  lastAt: string;
  /** Durée d'arrêt moyenne (min). */
  avgStopMin: number;
  lastPriceEur: number | null;
  fuelType: string | null;
  /** Lieu de la flotte correspondant si la station est déjà validée (sinon null). */
  placeId: string | null;
  placeName: string | null;
  /**
   * Passages nécessaires pour qualifier — la file « 8/8 » de la planche.
   * Envoyé par le serveur pour que le client n'ait JAMAIS à inventer ce nombre :
   * un seuil recopié dériverait en silence de la règle de détection.
   */
  seuilPassages: number;
  /** Où en est la station dans son cycle de vie. Dérivé, jamais stocké. */
  statut: StatutStation;
}
