import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FleetPlaceKind, Prisma, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

/** Durée d'arrêt minimale (min) pour qu'un passage station soit considéré comme un VRAI arrêt. */
const MIN_STOP_MIN = 4;
/** Borne de lecture des passages (perf + UI). */
const MAX_PASSAGES = 300;

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
  ) {}

  /**
   * Flotte sur laquelle opérer. Un non-super est TOUJOURS borné à la sienne (le `fleetId`
   * fourni est ignoré) ; le super-admin cible celle qu'il a choisie (ou null = toutes, en lecture).
   */
  private resolveFleetId(user: AuthUser, fleetId?: string): string | null {
    if (user.role !== UserRole.SUPER_ADMIN) return user.fleetId ?? null;
    return fleetId || null;
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
  private async findScoped(user: AuthUser, id: string) {
    const place = await this.prisma.fleetPlace.findUnique({ where: { id } });
    if (!place) throw new NotFoundException('Lieu introuvable.');
    if (user.role !== UserRole.SUPER_ADMIN && place.fleetId !== user.fleetId) {
      // 404 (pas 403) pour ne pas révéler l'existence d'un lieu d'une autre société.
      throw new NotFoundException('Lieu introuvable.');
    }
    return place;
  }

  /**
   * Passages en station-service avec un VRAI arrêt (≥ 4 min par défaut), du plus récent au plus
   * ancien. C'est la matière première de la page « Lieux clés » : chaque ligne dit QUI s'est
   * arrêté, OÙ, COMBIEN DE TEMPS, et si la station est déjà validée comme lieu de la flotte.
   */
  async stationPassages(
    user: AuthUser,
    opts: { fromIso?: string; toIso?: string; fleetId?: string; minStopMin?: number } = {},
  ): Promise<StationPassageDto[]> {
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
    const validatedStationIds = new Set<string>();
    try {
      const vehicleIds = [...new Set(withStation.map((s) => s.vehicleId))];
      const stationIds = [...new Set(withStation.map((s) => s.station!.id))];
      const [vehicles, places] = await Promise.all([
        this.prisma.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { id: true, plate: true } }),
        this.prisma.fleetPlace.findMany({
          where: { stationId: { in: stationIds }, ...(scopedFleet ? { fleetId: scopedFleet } : {}) },
          select: { stationId: true },
        }),
      ]);
      for (const v of vehicles) plateById.set(v.id, v.plate);
      for (const p of places) if (p.stationId) validatedStationIds.add(p.stationId);
    } catch (err) {
      this.errorLogger.recordBackground(
        err instanceof Error ? err : new Error(String(err)),
        'fleet-places',
        { note: 'enrichissement des passages station (plaques / stations validées) a échoué', userId: user.id },
      );
    }

    return withStation.map((s) => ({
      id: s.id,
      at: s.arrivedAt.toISOString(),
      vehicleId: s.vehicleId,
      plate: plateById.get(s.vehicleId) ?? null,
      stationId: s.station!.id,
      brand: s.station!.brand,
      name: s.station!.name,
      city: s.station!.city,
      address: s.station!.address,
      lat: s.station!.lat,
      lng: s.station!.lng,
      durationMin: Math.round(s.durationSec / 60),
      distanceM: Math.round(s.distanceM),
      priceEur: s.unitPriceEur,
      fuelType: s.fuelType,
      validated: validatedStationIds.has(s.station!.id),
    }));
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

export interface StationPassageDto {
  id: string;
  at: string;
  vehicleId: string;
  plate: string | null;
  stationId: string;
  brand: string | null;
  name: string | null;
  city: string | null;
  address: string | null;
  lat: number;
  lng: number;
  /** Durée de l'arrêt (min) — garantie ≥ au seuil demandé (4 min par défaut). */
  durationMin: number;
  /** Distance arrêt ↔ station (m). */
  distanceM: number;
  priceEur: number | null;
  fuelType: string | null;
  /** true si cette station fait déjà partie des lieux de la flotte. */
  validated: boolean;
}
