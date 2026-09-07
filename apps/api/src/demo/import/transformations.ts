import { randomUUID } from 'node:crypto';
import { Prisma, TrackyFormule, TrackyPlan } from '@prisma/client';
import type {
  Alert,
  Driver,
  Fleet,
  FleetPlace,
  FuelFillUp,
  FuelStation,
  FuelStationPrice,
  Geofence,
  GeofenceVehicle,
  Position,
  SurveillanceProfile,
  Tracker,
  Trip,
  TripAnalysis,
  TripFuelStop,
  Vehicle,
  VehicleGroup,
  VehicleGroupAssignment,
  VehicleSchedule,
  VehicleWorkSchedule,
} from '@prisma/client';
import { nomLieuDemo, nomZoneDemo } from './pseudonymes';
import { idDemo } from './uuid-deterministe';

/** Le compte système du seed (`prisma/seed.ts`) : cible des clés « auteur » obligatoires. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Correspondances identifiant source → identifiant de démo, par modèle.
 *
 * `id()` est une fonction PURE de (sel, modèle, id source) — deux appels donnent le même résultat,
 * et deux rafraîchissements aussi. `marquer()` note ce qui est effectivement importé pour que
 * `siImporte()` puisse rendre null sur une clé étrangère qui pointerait hors de la fenêtre
 * (une alerte sur un trajet plus ancien que DEMO_TRIPS_MONTHS, par exemple) : mieux vaut un
 * lien vide qu'une transaction refusée pour une clé absente.
 */
export class Correspondances {
  private readonly importes = new Map<string, Map<string, string>>();

  constructor(private readonly sel: string) {}

  id(modele: string, idSource: string): string {
    return idDemo(this.sel, modele, idSource);
  }

  /** Déclare une ligne importée. `idCible` permet de CONSERVER l'identifiant (données publiques). */
  marquer(modele: string, idSource: string, idCible: string = this.id(modele, idSource)): string {
    let carte = this.importes.get(modele);
    if (!carte) {
      carte = new Map();
      this.importes.set(modele, carte);
    }
    carte.set(idSource, idCible);
    return idCible;
  }

  siImporte(modele: string, idSource: string | null | undefined): string | null {
    if (!idSource) return null;
    return this.importes.get(modele)?.get(idSource) ?? null;
  }

  idsImportes(modele: string): string[] {
    return Array.from(this.importes.get(modele)?.values() ?? []);
  }
}

/**
 * Remplace, dans n'importe quel texte, tout ce qui nomme la source : plaques, IMEI, conducteurs,
 * société. Les alertes citent la plaque dans leur titre (« SOS — véhicule FV-941-LZ »), les
 * récits pourraient citer un nom : on ne parie pas sur le contraire, on remplace.
 */
export class Assainisseur {
  private readonly regles: Array<{ motif: RegExp; par: string }> = [];

  /** Une correspondance source → démo. Les plaques sont aussi reconnues sans tirets ni espaces. */
  ajouter(source: string, par: string): void {
    const valeur = source.trim();
    if (valeur.length < 3) return;
    const variantes = new Set<string>([valeur]);
    const compacte = valeur.replace(/[-\s]/g, '');
    if (compacte !== valeur && compacte.length >= 3) variantes.add(compacte);
    for (const v of variantes) {
      this.regles.push({ motif: new RegExp(`(?<![\\p{L}\\p{N}])${echapper(v)}(?![\\p{L}\\p{N}])`, 'giu'), par });
    }
    // Les plus longues d'abord : « Jean Martin » avant « Jean », si les deux étaient listés.
    this.regles.sort((a, b) => b.motif.source.length - a.motif.source.length);
  }

  texte(t: string): string {
    let resultat = t;
    for (const r of this.regles) resultat = resultat.replace(r.motif, r.par);
    return resultat;
  }

  texteOuNull(t: string | null): string | null {
    return t === null ? null : this.texte(t);
  }

  /** Parcourt récursivement un JSON et assainit chaque chaîne. */
  json(v: Prisma.JsonValue): Prisma.JsonValue {
    if (typeof v === 'string') return this.texte(v);
    if (Array.isArray(v)) return v.map((x) => this.json(x));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.json(x as Prisma.JsonValue)]));
    }
    return v;
  }
}

function echapper(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Un JSON source vers l'entrée d'écriture Prisma (null explicite → `JsonNull`). */
function json(v: Prisma.JsonValue | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue);
}

export interface Contexte {
  sel: string;
  nomFlotte: string;
  idFlotteDemo: string;
  maintenant: Date;
  ids: Correspondances;
  assainisseur: Assainisseur;
}

// ─── Société ───────────────────────────────────────────────────────────────────────────────

export function transformerFlotte(src: Fleet, ctx: Contexte): Prisma.FleetUncheckedCreateInput {
  return {
    id: ctx.idFlotteDemo,
    name: ctx.nomFlotte,
    clientId: null,
    metier: src.metier,
    adaptiveSamplingEnabled: src.adaptiveSamplingEnabled,
    adaptiveFixModeEnabled: src.adaptiveFixModeEnabled,
    fuelPriceEurL: src.fuelPriceEurL,
    weeklyReportEmail: null,
    // L'option IA est ACTIVE : le prospect voit les récits importés et les écrans de l'option.
    // Aucune clé IA dans la démo → rien n'est facturé, rien n'est généré.
    aiEnabled: true,
    speedAlertEnabled: src.speedAlertEnabled,
    speedAlertOverKmh: src.speedAlertOverKmh,
    speedAlertAbsoluteKmh: src.speedAlertAbsoluteKmh,
    speedAlertUpdatedAt: src.speedAlertUpdatedAt,
    speedAlertUpdatedById: null,
    stripeCustomerId: null,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

export function abonnementDemo(ctx: Contexte): Prisma.FleetSubscriptionUncheckedCreateInput {
  return {
    id: ctx.ids.id('FleetSubscription', ctx.idFlotteDemo),
    fleetId: ctx.idFlotteDemo,
    plan: TrackyPlan.SIGNATURE,
    formule: TrackyFormule.SERENITE,
    optLive: true,
    optMicro: true,
    optAgent: true,
    retentionKey: '90j',
    isComp: true,
    customPriceEurYear: null,
    notes: 'Société de démonstration — toutes les options, offert.',
    updatedByUserId: null,
    createdAt: ctx.maintenant,
    updatedAt: ctx.maintenant,
  };
}

export function planningRapportDemo(ctx: Contexte): Prisma.FleetReportScheduleUncheckedCreateInput {
  return {
    fleetId: ctx.idFlotteDemo,
    enabled: false,
    weekday: 1,
    hour: 8,
    recipients: [],
    sections: ['kpi', 'alerts', 'topVehicles', 'trips'],
    vehicleIds: [],
    maxTrips: 30,
    topN: 10,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    updatedAt: ctx.maintenant,
    updatedByUserId: null,
  };
}

// ─── Parc ──────────────────────────────────────────────────────────────────────────────────

export function transformerVehicule(src: Vehicle, ctx: Contexte, plaque: string): Prisma.VehicleUncheckedCreateInput {
  return {
    id: ctx.ids.id('Vehicle', src.id),
    fleetId: ctx.idFlotteDemo,
    plate: plaque,
    type: src.type,
    brand: src.brand,
    model: src.model,
    energy: src.energy,
    year: src.year,
    color: src.color,
    fuelConsumptionL100km: src.fuelConsumptionL100km,
    calibratedConsumptionL100km: src.calibratedConsumptionL100km,
    calibratedTanks: src.calibratedTanks,
    calibratedAt: src.calibratedAt,
    currentDriverId: ctx.ids.siImporte('Driver', src.currentDriverId),
    lastOdometerKm: src.lastOdometerKm,
    lastOdometerAt: src.lastOdometerAt,
    seats: src.seats,
    childSeats: src.childSeats,
    features: src.features,
    mixedUseEnabled: src.mixedUseEnabled,
    speedAlertEnabled: src.speedAlertEnabled,
    speedAlertOverKmh: src.speedAlertOverKmh,
    outOfServiceReason: src.outOfServiceReason,
    outOfServiceSince: src.outOfServiceSince,
    outOfServiceById: null,
    outOfServiceNote: null,
    privacyModeEnabled: src.privacyModeEnabled,
    privacyModeSince: src.privacyModeSince,
    privacyModeById: null,
    privacyModeNote: null,
    workOverrideUntil: src.workOverrideUntil,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

export function transformerBoitier(src: Tracker, ctx: Contexte, imei: string): Prisma.TrackerUncheckedCreateInput {
  return {
    id: ctx.ids.id('Tracker', src.id),
    imei,
    model: src.model,
    status: src.status,
    lastSeenAt: src.lastSeenAt,
    lastKnownIgnition: src.lastKnownIgnition,
    lastIgnitionChangeAt: src.lastIgnitionChangeAt,
    lastLat: src.lastLat,
    lastLng: src.lastLng,
    lastSpeedKmh: src.lastSpeedKmh,
    lastHeading: src.lastHeading,
    lastIgnition: src.lastIgnition,
    lastValid: src.lastValid,
    lastPositionAt: src.lastPositionAt,
    lastNoFixAt: src.lastNoFixAt,
    lastWriteAt: src.lastWriteAt,
    lastSampledState: src.lastSampledState,
    lastPowerNoticeAt: src.lastPowerNoticeAt,
    lastPowerNotice: src.lastPowerNotice,
    powerLossSuspectAt: src.powerLossSuspectAt,
    powerLossSuspectBattery: src.powerLossSuspectBattery,
    lastBatteryPercent: src.lastBatteryPercent,
    lastBatteryAt: src.lastBatteryAt,
    verboseUntil: null,
    desiredFixIntervalS: src.desiredFixIntervalS,
    currentFixIntervalS: src.currentFixIntervalS,
    recentFixIntervalsS: src.recentFixIntervalsS,
    lastFixIntervalSyncAt: src.lastFixIntervalSyncAt,
    fixCommandFailureCount: src.fixCommandFailureCount,
    fixCommandFailing: src.fixCommandFailing,
    fixModeOverrideUntil: null,
    lastValidFrameAt: src.lastValidFrameAt,
    simPhoneNumber: null,
    accConnected: src.accConnected,
    vehicleId: ctx.ids.siImporte('Vehicle', src.vehicleId),
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

export function transformerConducteur(
  src: Driver,
  ctx: Contexte,
  identite: { firstName: string; lastName: string },
): Prisma.DriverUncheckedCreateInput {
  return {
    id: ctx.ids.id('Driver', src.id),
    fleetId: ctx.idFlotteDemo,
    firstName: identite.firstName,
    lastName: identite.lastName,
    phone: null,
    email: null,
    licenseNumber: null,
    color: src.color,
    notes: null,
    isActive: src.isActive,
    // Jamais copié. Côté démo, l'importeur PRÉSERVE le lien posé par le seed (compte conducteur).
    userId: null,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

export function transformerGroupe(src: VehicleGroup, ctx: Contexte, nom: string): Prisma.VehicleGroupUncheckedCreateInput {
  return {
    id: ctx.ids.id('VehicleGroup', src.id),
    name: ctx.assainisseur.texte(nom),
    fleetId: ctx.idFlotteDemo,
    createdAt: src.createdAt,
  };
}

export function transformerAffectation(src: VehicleGroupAssignment, ctx: Contexte): Prisma.VehicleGroupAssignmentCreateManyInput {
  return {
    vehicleId: ctx.ids.id('Vehicle', src.vehicleId),
    groupId: ctx.ids.id('VehicleGroup', src.groupId),
  };
}

export function transformerGeofence(src: Geofence, ctx: Contexte, index: number): Prisma.GeofenceUncheckedCreateInput {
  return {
    id: ctx.ids.id('Geofence', src.id),
    fleetId: ctx.idFlotteDemo,
    name: nomZoneDemo(index),
    type: src.type,
    rule: src.rule,
    centerLat: src.centerLat,
    centerLng: src.centerLng,
    radiusMeters: src.radiusMeters,
    polygonPoints: json(src.polygonPoints),
    corridorPoints: json(src.corridorPoints),
    corridorWidthM: src.corridorWidthM,
    color: src.color,
    active: src.active,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

export function transformerGeofenceVehicule(src: GeofenceVehicle, ctx: Contexte): Prisma.GeofenceVehicleCreateManyInput {
  return {
    geofenceId: ctx.ids.id('Geofence', src.geofenceId),
    vehicleId: ctx.ids.id('Vehicle', src.vehicleId),
    createdAt: src.createdAt,
  };
}

export function transformerLieu(src: FleetPlace, ctx: Contexte, index: number, stationId: string | null): Prisma.FleetPlaceUncheckedCreateInput {
  return {
    id: ctx.ids.id('FleetPlace', src.id),
    fleetId: ctx.idFlotteDemo,
    name: nomLieuDemo(src.kind, index),
    kind: src.kind,
    lat: src.lat,
    lng: src.lng,
    radiusM: src.radiusM,
    note: null,
    stationId,
    createdById: null,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

function joursDePlanning(src: VehicleSchedule | VehicleWorkSchedule) {
  return {
    mondayEnabled: src.mondayEnabled, mondayStart: src.mondayStart, mondayEnd: src.mondayEnd,
    tuesdayEnabled: src.tuesdayEnabled, tuesdayStart: src.tuesdayStart, tuesdayEnd: src.tuesdayEnd,
    wednesdayEnabled: src.wednesdayEnabled, wednesdayStart: src.wednesdayStart, wednesdayEnd: src.wednesdayEnd,
    thursdayEnabled: src.thursdayEnabled, thursdayStart: src.thursdayStart, thursdayEnd: src.thursdayEnd,
    fridayEnabled: src.fridayEnabled, fridayStart: src.fridayStart, fridayEnd: src.fridayEnd,
    saturdayEnabled: src.saturdayEnabled, saturdayStart: src.saturdayStart, saturdayEnd: src.saturdayEnd,
    sundayEnabled: src.sundayEnabled, sundayStart: src.sundayStart, sundayEnd: src.sundayEnd,
    mondaySlots: json(src.mondaySlots),
    tuesdaySlots: json(src.tuesdaySlots),
    wednesdaySlots: json(src.wednesdaySlots),
    thursdaySlots: json(src.thursdaySlots),
    fridaySlots: json(src.fridaySlots),
    saturdaySlots: json(src.saturdaySlots),
    sundaySlots: json(src.sundaySlots),
  };
}

export function transformerPlanning(src: VehicleSchedule, ctx: Contexte): Prisma.VehicleScheduleUncheckedCreateInput {
  return {
    id: ctx.ids.id('VehicleSchedule', src.id),
    vehicleId: ctx.ids.id('Vehicle', src.vehicleId),
    enabled: src.enabled,
    timezone: src.timezone,
    ...joursDePlanning(src),
    countryCode: src.countryCode,
    cutOnHolidays: src.cutOnHolidays,
    customDates: json(src.customDates),
    lastEvaluatedAt: null,
    lastEvaluatedState: null,
    overrideUntil: null,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

export function transformerPlanningTravail(src: VehicleWorkSchedule, ctx: Contexte): Prisma.VehicleWorkScheduleUncheckedCreateInput {
  return {
    id: ctx.ids.id('VehicleWorkSchedule', src.id),
    vehicleId: ctx.ids.id('Vehicle', src.vehicleId),
    enabled: src.enabled,
    timezone: src.timezone,
    ...joursDePlanning(src),
    countryCode: src.countryCode,
    customDates: json(src.customDates),
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

export function transformerProfilSurveillance(src: SurveillanceProfile, ctx: Contexte): Prisma.SurveillanceProfileUncheckedCreateInput {
  return {
    id: ctx.ids.id('SurveillanceProfile', src.id),
    vehicleId: ctx.ids.id('Vehicle', src.vehicleId),
    fleetId: ctx.idFlotteDemo,
    mode: src.mode,
    sensitivity: src.sensitivity,
    scheduleStartTime: src.scheduleStartTime,
    scheduleEndTime: src.scheduleEndTime,
    scheduleDays: json(src.scheduleDays),
    weekendPermanent: src.weekendPermanent,
    triggerVibration: src.triggerVibration,
    triggerMovement: src.triggerMovement,
    triggerDoor: src.triggerDoor,
    additionalNotifyUserIds: [],
    currentlyArmed: false,
    lastArmedAt: src.lastArmedAt,
    lastDisarmedAt: src.lastDisarmedAt,
    createdBy: SYSTEM_USER_ID,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

// ─── Historique ────────────────────────────────────────────────────────────────────────────

export function transformerTrajet(src: Trip, ctx: Contexte): Prisma.TripCreateManyInput {
  return {
    id: ctx.ids.id('Trip', src.id),
    vehicleId: ctx.ids.id('Vehicle', src.vehicleId),
    trackerId: ctx.ids.siImporte('Tracker', src.trackerId),
    fleetId: src.fleetId ? ctx.idFlotteDemo : null,
    startedAt: src.startedAt,
    endedAt: src.endedAt,
    durationSeconds: src.durationSeconds,
    startLat: src.startLat,
    startLng: src.startLng,
    endLat: src.endLat,
    endLng: src.endLng,
    distanceKm: src.distanceKm,
    distanceMeters: src.distanceMeters,
    maxSpeed: src.maxSpeed,
    avgSpeed: src.avgSpeed,
    movingSeconds: src.movingSeconds,
    positionCount: src.positionCount,
    segmentationSource: src.segmentationSource,
    missionId: null,
    polyline: src.polyline,
    polylineMatched: src.polylineMatched,
    notes: null,
    notesUpdatedAt: null,
    notesUpdatedById: null,
    driverId: ctx.ids.siImporte('Driver', src.driverId),
    driverSource: src.driverSource,
    createdAt: src.createdAt,
  };
}

export function transformerAnalyse(src: TripAnalysis, ctx: Contexte): Prisma.TripAnalysisCreateManyInput {
  return {
    id: ctx.ids.id('TripAnalysis', src.id),
    tripId: ctx.ids.id('Trip', src.tripId),
    fleetId: ctx.idFlotteDemo,
    vehicleId: ctx.ids.id('Vehicle', src.vehicleId),
    distanceKm: src.distanceKm,
    durationSec: src.durationSec,
    movingSec: src.movingSec,
    avgSpeedKmh: src.avgSpeedKmh,
    maxSpeedKmh: src.maxSpeedKmh,
    stopCount: src.stopCount,
    idleSec: src.idleSec,
    gpsPoints: src.gpsPoints,
    gpsValidRatio: src.gpsValidRatio,
    gpsLostCount: src.gpsLostCount,
    speedingCount: src.speedingCount,
    speedingSec: src.speedingSec,
    maxOverKmh: src.maxOverKmh,
    limitsKnown: src.limitsKnown,
    limitsCoverage: src.limitsCoverage,
    harshAccel: src.harshAccel,
    harshBrake: src.harshBrake,
    ecoScore: src.ecoScore,
    fuelLiters: src.fuelLiters,
    co2Kg: src.co2Kg,
    detail: ctx.assainisseur.json(src.detail) as Prisma.InputJsonValue,
    provider: src.provider,
    narrative: ctx.assainisseur.texteOuNull(src.narrative),
    advice: ctx.assainisseur.texteOuNull(src.advice),
    trustScore: src.trustScore,
    narratedAt: src.narratedAt,
    computedAt: src.computedAt,
    updatedAt: src.updatedAt,
  };
}

export function transformerArretCarburant(src: TripFuelStop, ctx: Contexte): Prisma.TripFuelStopCreateManyInput {
  return {
    id: ctx.ids.id('TripFuelStop', src.id),
    tripId: ctx.ids.id('Trip', src.tripId),
    fleetId: ctx.idFlotteDemo,
    vehicleId: ctx.ids.id('Vehicle', src.vehicleId),
    stationId: src.stationId,
    arrivedAt: src.arrivedAt,
    durationSec: src.durationSec,
    lat: src.lat,
    lng: src.lng,
    distanceM: src.distanceM,
    fuelType: src.fuelType,
    unitPriceEur: src.unitPriceEur,
    createdAt: src.createdAt,
  };
}

export function transformerPlein(src: FuelFillUp, ctx: Contexte): Prisma.FuelFillUpCreateManyInput {
  return {
    id: ctx.ids.id('FuelFillUp', src.id),
    fleetId: ctx.idFlotteDemo,
    vehicleId: ctx.ids.id('Vehicle', src.vehicleId),
    filledAt: src.filledAt,
    litersFilled: src.litersFilled,
    amountPaidEur: src.amountPaidEur,
    fullTank: src.fullTank,
    odometerKm: src.odometerKm,
    fuelType: src.fuelType,
    stationId: ctx.ids.siImporte('FuelStation', src.stationId),
    note: null,
    createdByUserId: null,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

/** Données publiques : copie à l'identique, identifiant compris. */
export function transformerStation(src: FuelStation): Prisma.FuelStationCreateManyInput {
  return {
    id: src.id,
    source: src.source,
    externalId: src.externalId,
    brand: src.brand,
    name: src.name,
    address: src.address,
    city: src.city,
    postalCode: src.postalCode,
    lat: src.lat,
    lng: src.lng,
    createdAt: src.createdAt,
    updatedAt: src.updatedAt,
  };
}

export function transformerPrix(src: FuelStationPrice): Prisma.FuelStationPriceCreateManyInput {
  return {
    id: src.id,
    stationId: src.stationId,
    fuelType: src.fuelType,
    priceEur: src.priceEur,
    sourceUpdatedAt: src.sourceUpdatedAt,
    capturedAt: src.capturedAt,
  };
}

export function transformerAlerte(src: Alert, ctx: Contexte): Prisma.AlertCreateManyInput {
  return {
    id: ctx.ids.id('Alert', src.id),
    fleetId: ctx.idFlotteDemo,
    vehicleId: ctx.ids.siImporte('Vehicle', src.vehicleId),
    trackerId: ctx.ids.siImporte('Tracker', src.trackerId),
    tripId: ctx.ids.siImporte('Trip', src.tripId),
    type: src.type,
    severity: src.severity,
    title: ctx.assainisseur.texte(src.title),
    message: ctx.assainisseur.texteOuNull(src.message),
    payload: src.payload === null ? Prisma.JsonNull : (ctx.assainisseur.json(src.payload) as Prisma.InputJsonValue),
    latitude: src.latitude,
    longitude: src.longitude,
    acknowledgedAt: src.acknowledgedAt,
    acknowledgedBy: null,
    escalatedAt: src.escalatedAt,
    createdAt: src.createdAt,
  };
}

/** Une position ne porte pas de nom ; son identifiant est neuf (la table est vidée à chaque import). */
export function transformerPosition(src: Position, trackerIdDemo: string): Prisma.PositionCreateManyInput {
  return {
    id: randomUUID(),
    trackerId: trackerIdDemo,
    lat: src.lat,
    lng: src.lng,
    speedKmh: src.speedKmh,
    heading: src.heading,
    altitude: src.altitude,
    satellites: src.satellites,
    valid: src.valid,
    ignition: src.ignition,
    timestamp: src.timestamp,
    createdAt: src.createdAt,
  };
}

/** Une ligne de la semaine de rejeu, telle que la requête SQL de l'importeur la rend. */
export interface TrameSemaine {
  weekday: number;
  secondOfDay: number;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  altitude: number | null;
  ignition: boolean | null;
  valid: boolean;
}

export function transformerTrameRejeu(src: TrameSemaine, imeiDemo: string): Prisma.DemoReplayFrameCreateManyInput {
  return {
    imei: imeiDemo,
    weekday: src.weekday,
    secondOfDay: src.secondOfDay,
    lat: src.lat,
    lng: src.lng,
    speedKmh: src.speedKmh,
    heading: src.heading,
    altitude: src.altitude,
    ignition: src.ignition,
    valid: src.valid,
  };
}
