import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  DriverSummaryDto,
  InstallationEnergy,
  VehicleCapacityRowDto,
  VehicleInstallationSourceDto,
  VehicleSyncableField,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

export interface VehicleDetailDto {
  id: string;
  plate: string;
  type: string;
  brand: string | null;
  model: string | null;
  /** Sprint 10 — type de carburant (synchronisé depuis le planning d'installation). */
  energy: InstallationEnergy | null;
  year: number | null;
  color: string | null;
  /** Sprint 8 — caractéristiques (critères de réservation). */
  seats: number | null;
  childSeats: number | null;
  features: string[];
  fleetId: string;
  tracker: {
    id: string;
    imei: string;
    status: string;
    lastSeenAt: string | null;
    /** Dernière position GPS valide (null = jamais de fix → état « Recherche GPS »). */
    lastPositionAt: string | null;
    /** Incident FS-253 — dernière trame no_fix (LBS sans lock GPS) → détection GPS_LOST. */
    lastNoFixAt: string | null;
    lastKnownIgnition: boolean | null;
    /** V1.7 — fil ACC connecte (true) ou ignition inferee depuis vitesse (false). */
    accConnected: boolean;
    /** V1.15 — n° SIM data (E.164). Avec l'IMEI, determine le statut « Installé ». */
    simPhoneNumber?: string | null;
    /** Date d'ajout (ISO), proxy d'installation — pour le flag « installation à revoir ». */
    createdAt?: string | null;
  } | null;
  /** Phase 2 — Conducteur courant (defaut snape sur prochains trajets). null = aucun. */
  currentDriver?: DriverSummaryDto | null;
  createdAt: string;
  schedule?: { enabled: boolean } | null;
  /** Mode vie privée — collecte des positions en pause pour ce véhicule. */
  privacyModeEnabled?: boolean;
  privacyModeSince?: string | null;
  /** Sprint 1 (Fondation Groupes) — groupe (unique) du véhicule. null = sans groupe. */
  group?: { id: string; name: string } | null;
  /**
   * Fix veilleur — le véhicule roule-t-il (ignition ON + vitesse > 5 km/h) d'après la
   * dernière position connue ? Sert à hydrater l'état « en mouvement » côté veilleur
   * (qui ne reçoit aucune position) pour griser le bouton « Couper ».
   */
  moving?: boolean;
}

@Injectable({ providedIn: 'root' })
export class VehiclesApiService {
  private readonly http = inject(HttpClient);

  findOne(id: string): Observable<VehicleDetailDto> {
    return this.http.get<VehicleDetailDto>(`/api/vehicles/${id}`);
  }

  create(data: {
    plate: string;
    type?: 'CAR' | 'TRUCK' | 'VAN' | 'MOTORCYCLE' | 'BICYCLE' | 'BUS' | 'CONSTRUCTION' | 'OTHER';
    brand?: string;
    model?: string;
    energy?: InstallationEnergy;
    year?: number;
    color?: string;
    seats?: number;
    childSeats?: number;
    features?: string[];
    fleetId?: string;
  }): Observable<VehicleDetailDto> {
    return this.http.post<VehicleDetailDto>('/api/vehicles', data);
  }

  list(params?: Record<string, string>): Observable<VehicleDetailDto[]> {
    return this.http.get<VehicleDetailDto[]>('/api/vehicles', { params });
  }

  update(id: string, data: Record<string, unknown>): Observable<VehicleDetailDto> {
    return this.http.patch<VehicleDetailDto>(`/api/vehicles/${id}`, data);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`/api/vehicles/${id}`);
  }

  /**
   * Sprint 1 (Fondation Groupes) — définit/retire le groupe (single) du véhicule.
   * `groupId: null` retire le véhicule de son groupe (« sans groupe »).
   */
  setGroup(id: string, groupId: string | null): Observable<VehicleDetailDto> {
    return this.http.patch<VehicleDetailDto>(`/api/vehicles/${id}/group`, { groupId });
  }

  stats(fleetId?: string | null): Observable<VehicleStatsDto> {
    return this.http.get<VehicleStatsDto>('/api/vehicles/stats', fleetId ? { params: { fleetId } } : {});
  }

  // ─── Sprint 10 — Synchro véhicules ↔ planning d'installation ───

  /** Vue « Parc & capacités » : véhicules + capacité + source planning (modèle/énergie). */
  capacityOverview(): Observable<VehicleCapacityRowDto[]> {
    return this.http.get<VehicleCapacityRowDto[]>('/api/vehicles/capacity-overview');
  }

  /** Source de synchro (tâche d'installation liée la plus récente) d'un véhicule. */
  installationSource(id: string): Observable<VehicleInstallationSourceDto | null> {
    return this.http.get<VehicleInstallationSourceDto | null>(`/api/vehicles/${id}/installation-source`);
  }

  /** Recopie les champs choisis (marque/modèle/énergie) du planning vers le véhicule. */
  syncFromInstallation(id: string, fields: VehicleSyncableField[]): Observable<VehicleDetailDto> {
    return this.http.post<VehicleDetailDto>(`/api/vehicles/${id}/sync-from-installation`, { fields });
  }

  // ─── feat/comptes-conducteurs (4a) — QR de déverrouillage (gate `qr_manage`) ───

  /** QR de déverrouillage d'un véhicule : jeton signé + deep-link + rendu SVG. */
  getUnlockQr(id: string): Observable<VehicleUnlockQrDto> {
    return this.http.get<VehicleUnlockQrDto>(`/api/vehicles/${id}/unlock-qr`);
  }

  /**
   * URL de la feuille imprimable de TOUS les QR (fleet-scopée). Ouverte via `window.open`
   * (cookie de session, même origine). `fleetId` = sélecteur société (super-admin) ; null = flotte de l'user.
   */
  unlockQrSheetUrl(fleetId: string | null): string {
    return `/api/vehicles/unlock-qr-sheet${fleetId ? `?fleetId=${encodeURIComponent(fleetId)}` : ''}`;
  }

  /** Données JSON des QR de la flotte (plaque/modèle/lien signé) → rendu premium client-side (Imprimer tous). */
  getUnlockQrLinks(fleetId: string | null): Observable<{ items: UnlockQrLinkDto[] }> {
    return this.http.get<{ items: UnlockQrLinkDto[] }>(
      `/api/vehicles/unlock-qr-links${fleetId ? `?fleetId=${encodeURIComponent(fleetId)}` : ''}`,
    );
  }
}

export interface UnlockQrLinkDto {
  vehicleId: string;
  plate: string | null;
  model: string | null;
  url: string;
}

export interface VehicleUnlockQrDto {
  vehicleId: string;
  plate: string | null;
  token: string;
  url: string;
  /** SVG inline du QR (généré côté serveur). */
  svg: string;
}

export interface VehicleStatsDto {
  total: number;
  moving: number;
  idle: number;
  criticalAlerts: number;
  newThisMonth: number;
}
