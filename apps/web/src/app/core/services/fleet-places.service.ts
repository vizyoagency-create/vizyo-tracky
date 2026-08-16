import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Lieux clés (2026-07) — référentiel des lieux de la flotte : stations-service VALIDÉES par
 * l'exploitant et parkings / stationnements récurrents posés à la main. DTO définis localement
 * (même convention que VehicleDetailDto / GpsDeadZoneDto).
 */
export type FleetPlaceKind = 'FUEL_STATION' | 'PARKING' | 'DEPOT' | 'OTHER';

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

/** Un véhicule passé par une station + son nombre de passages. */
export interface StationGroupVehicleDto {
  vehicleId: string;
  plate: string | null;
  visits: number;
  lastAt: string;
}

/** Une STATION regroupée (une ligne par lieu) : qui est passé, combien de fois, quand. */
export interface StationGroupDto {
  stationId: string;
  /** Libellé prêt à afficher (jamais vide, même si la marque est absente du catalogue). */
  label: string;
  brand: string | null;
  name: string | null;
  city: string | null;
  address: string | null;
  lat: number;
  lng: number;
  passages: number;
  distinctVehicles: number;
  vehicles: StationGroupVehicleDto[];
  firstAt: string;
  lastAt: string;
  avgStopMin: number;
  lastPriceEur: number | null;
  fuelType: string | null;
  /** Lieu de la flotte correspondant si la station est validée (sinon null). */
  placeId: string | null;
  placeName: string | null;
  /**
   * Passages nécessaires pour qualifier — le « 8 » de « 8/8 · PRÊT À VALIDER ».
   *
   * ⚠️ Vient du SERVEUR et ne se recalcule pas ici. Inventer ce nombre côté client
   * poserait une valeur qui doit rester d'accord avec la règle de détection : le
   * jour où celle-ci bouge, l'écran afficherait l'ancien seuil en ayant l'air juste.
   *
   * Optionnel : un backend antérieur ne l'envoie pas, et l'écran doit alors se
   * taire plutôt que d'afficher « 8/undefined ».
   */
  seuilPassages?: number;
  /** Où en est la station dans son cycle de vie. Dérivé côté serveur. */
  statut?: 'A_QUALIFIER' | 'EN_COURS' | 'PRET_A_VALIDER' | 'VALIDE';
}

/**
 * Faits OpenStreetMap d'un lieu — source FACTUELLE (gratuite, légale, sans IA). Champs souvent
 * partiellement nuls : OSM est du contributif, on affiche ce qui existe et rien d'autre.
 */
export interface PlaceFactsDto {
  source: 'osm';
  osmId: string | null;
  name: string | null;
  brand: string | null;
  operator: string | null;
  openingHours: string | null;
  phone: string | null;
  website: string | null;
  services: string[];
  fuels: string[];
  payment: string[];
  parking: { capacity: number | null; type: string | null; access: string | null; fee: string | null } | null;
  /** Photo libre (OSM / Wikimedia). Souvent absente — jamais inventée. */
  imageUrl: string | null;
  wikidata: string | null;
  address: string | null;
}

@Injectable({ providedIn: 'root' })
export class FleetPlacesApiService {
  private readonly http = inject(HttpClient);

  /** Lieux clés de la flotte (stations validées + parkings + dépôts). */
  list(fleetId?: string): Observable<FleetPlaceDto[]> {
    const params: Record<string, string> = {};
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<FleetPlaceDto[]>('/api/fleet-places', { params });
  }

  /** Stations REGROUPÉES (une par lieu) avec arrêt réel ≥ minStopMin (4 min par défaut). */
  stationGroups(opts: { from?: string; to?: string; fleetId?: string; minStopMin?: number } = {}): Observable<StationGroupDto[]> {
    const params: Record<string, string> = {};
    if (opts.from) params['from'] = opts.from;
    if (opts.to) params['to'] = opts.to;
    if (opts.fleetId) params['fleetId'] = opts.fleetId;
    if (opts.minStopMin != null) params['minStopMin'] = String(opts.minStopMin);
    return this.http.get<StationGroupDto[]>('/api/fleet-places/stations', { params });
  }

  /** Crée un lieu : parking posé à la main, ou validation d'une station détectée. */
  create(data: {
    name: string;
    kind: FleetPlaceKind;
    lat: number;
    lng: number;
    radiusM?: number;
    note?: string | null;
    stationId?: string | null;
    fleetId?: string;
  }): Observable<FleetPlaceDto> {
    return this.http.post<FleetPlaceDto>('/api/fleet-places', data);
  }

  update(id: string, data: Partial<{ name: string; kind: FleetPlaceKind; lat: number; lng: number; radiusM: number; note: string | null }>): Observable<FleetPlaceDto> {
    return this.http.patch<FleetPlaceDto>(`/api/fleet-places/${id}`, data);
  }

  remove(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/fleet-places/${id}`);
  }

  /** Faits OSM d'un lieu (gratuit, sans IA). `null` si le lieu n'est pas cartographié. */
  facts(id: string): Observable<PlaceFactsDto | null> {
    return this.http.get<PlaceFactsDto | null>(`/api/fleet-places/${id}/facts`);
  }

  /**
   * L'analyse IA est-elle proposable ? À interroger AVANT d'afficher quoi que ce soit d'IA :
   * si la société n'a pas l'option (ou si l'owner a coupé la fonction), on n'affiche RIEN.
   */
  aiStatus(fleetId?: string): Observable<{ enabled: boolean }> {
    const params: Record<string, string> = {};
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<{ enabled: boolean }>('/api/fleet-places/ai-status', { params });
  }

  /** Analyse IA COURANTE d'un lieu (null si jamais analysé). Lecture seule, sans appel moteur. */
  analysis(id: string): Observable<PlaceAnalysisDto | null> {
    return this.http.get<PlaceAnalysisDto | null>(`/api/fleet-places/${id}/analysis`);
  }

  /** Lance (ou relance) l'analyse IA — CONSOMME DES TOKENS (permission `places_analyze`). */
  analyze(id: string): Observable<PlaceAnalysisDto> {
    return this.http.post<PlaceAnalysisDto>(`/api/fleet-places/${id}/analyze`, {});
  }

  // ─── Automatisation (super-admin) ──────────────────────────────────────────

  automationSettings(): Observable<PlaceAutomationSettingsDto> {
    return this.http.get<PlaceAutomationSettingsDto>('/api/fleet-places/automation');
  }

  setAutomationSettings(dto: Partial<PlaceAutomationSettingsDto>): Observable<PlaceAutomationSettingsDto> {
    return this.http.put<PlaceAutomationSettingsDto>('/api/fleet-places/automation', dto);
  }

  automationRuns(limit = 30): Observable<PlaceAutomationRunDto[]> {
    return this.http.get<PlaceAutomationRunDto[]>('/api/fleet-places/automation/runs', { params: { limit: String(limit) } });
  }

  /** SIMULATION : chiffre le passage sans émettre le moindre appel IA (aucune dépense). */
  simulateAutomation(): Observable<PlaceAutomationStatsDto> {
    return this.http.post<PlaceAutomationStatsDto>('/api/fleet-places/automation/simulate', {});
  }

  /** Lancement RÉEL immédiat — dépense réellement. */
  runAutomationNow(): Observable<PlaceAutomationStatsDto> {
    return this.http.post<PlaceAutomationStatsDto>('/api/fleet-places/automation/run-now', {});
  }
}

/** Réglages de l'automatisation. Les plafonds sont bornés CÔTÉ SERVEUR (la saisie est clampée). */
export interface PlaceAutomationSettingsDto {
  id: string;
  enabled: boolean;
  hour: number;
  minIntervalDays: number;
  skipUnchanged: boolean;
  maxAnalysesPerRun: number;
  maxCostEurPerRun: number;
  lastRunAt: string | null;
  /** Budget IA mensuel global (0 = non défini). Joint aux réglages : c'est le plafond qui prime. */
  monthlyBudgetEur?: number;
}

/** Bilan d'un passage — `dryRun` distingue une simulation (coût estimé) d'un run réel. */
export interface PlaceAutomationStatsDto {
  fleets: number;
  candidates: number;
  analyzed: number;
  skippedUnchanged: number;
  skippedCooldown: number;
  skippedAiOff: number;
  failed: number;
  costEur: number;
  durationMs: number;
  stopReason: string;
  dryRun: boolean;
}

export interface PlaceAutomationRunDto extends PlaceAutomationStatsDto {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  origin: string;
}

/**
 * Fiche IA d'un lieu. L'IA REFORMULE des faits (OSM + usage réel de la flotte), elle n'en invente
 * pas : `facts` rappelle la source OSM figée au moment de l'analyse.
 */
export interface PlaceAnalysisDto {
  id: string;
  placeId: string;
  summary: string;
  highlights: string[];
  recommendations: string[];
  aiProvider: string | null;
  aiModel: string | null;
  costEur: number | null;
  origin: string;
  computedAt: string;
  facts: PlaceFactsDto | null;
}
