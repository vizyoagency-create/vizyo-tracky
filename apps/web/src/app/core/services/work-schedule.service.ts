import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/** Une journée du cadre (plage unique HH:MM côté UI ; le backend gère aussi le multi-plages). */
export interface WorkScheduleDayInput {
  enabled?: boolean;
  start?: string | null;
  end?: string | null;
}

export interface SetWorkScheduleBody {
  enabled: boolean;
  timezone?: string;
  countryCode?: string;
  days?: Record<string, WorkScheduleDayInput>;
}

/** Cadre renvoyé par le backend (champs par jour + méta). Accès dynamique `${day}Start`… */
export interface WorkScheduleRow {
  enabled: boolean;
  timezone: string;
  countryCode: string;
  [key: string]: unknown;
}

export interface WorkScheduleState {
  vehicleId: string;
  /** Usage mixte déclaré : le cadre ne s'applique QUE si true (sinon véhicule tracé 24/7). */
  mixedUseEnabled: boolean;
  schedule: WorkScheduleRow | null;
  effective: { isPrivate: boolean; reason: string };
}

/** Couverture vie privée de la flotte (écran « Véhicules non couverts »). */
export interface PrivacyCoverageRow {
  vehicleId: string;
  plate: string;
  fleetName: string;
  mixedUseEnabled: boolean;
  hasSchedule: boolean;
  scheduleEnabled: boolean;
  driverName: string | null;
  status: 'PROTEGE' | 'MIXTE_SANS_CADRE' | 'NON_COUVERT';
}

export interface PrivacyCoverageDto {
  items: PrivacyCoverageRow[];
  total: number;
  protectedCount: number;
  uncoveredCount: number;
}

export type EtatViePrivee = PrivacyCoverageRow['status'];

/**
 * LES MOTS DES TROIS ÉTATS — définis UNE fois, lus par les deux écrans.
 *
 * B1 § E le demande explicitement : « les 3 états avec les mêmes mots que dans l'éditeur
 * d'horaires ». Ils ne les avaient pas. L'écran de couverture disait « Protégé hors travail »
 * là où l'éditeur dit « hors temps de travail », et « Suivi 24/7 » là où l'éditeur dit
 * « suivi en permanence ». Pire : la page se contredisait ELLE-MÊME — son compteur annonçait
 * « suivis en permanence » et la pastille de la ligne juste en dessous « Suivi 24/7 ».
 *
 * Deux vocabulaires pour un même état, c'est deux états pour qui lit. Sur un écran qui sert
 * de preuve en cas de contrôle, ce n'est pas un détail de style.
 *
 * ⚠️ « 24/7 » n'est pas supprimé du produit : il reste là où il qualifie l'ANTIVOL
 * (« l'antivol reste actif 24/7 »), qui continue bien de fonctionner en permanence. C'est une
 * autre affirmation que l'état de suivi du véhicule.
 */
export const ETATS_VIE_PRIVEE: Record<EtatViePrivee, {
  /** Sur la pastille de ligne. */
  court: string;
  /** En tête de groupe et dans les phrases. */
  long: string;
  /** Ce que l'état veut dire, en une phrase. */
  sens: string;
}> = {
  PROTEGE: {
    court: 'Protégé',
    long: 'Protégé hors temps de travail',
    sens: "Hors des plages déclarées, aucune position n'est enregistrée.",
  },
  MIXTE_SANS_CADRE: {
    court: 'Mixte sans cadre',
    long: 'Usage mixte déclaré, aucun cadre actif',
    // ⚠️ Cette phrase disait l'INVERSE de ce que fait le système : « le véhicule serait
    // privé en permanence — donc invisible pour vous ». C'est faux, et dangereusement :
    // `resolveEffectivePrivacy` renvoie `NO_SCHEDULE` → `isPrivate: false` quand l'usage
    // mixte est déclaré sans cadre actif (cf. la précédence n° 4 : « aucun cadre → TRACÉ,
    // on ne coupe jamais le suivi sans cadre défini »). Le véhicule est donc suivi 24/7,
    // domicile compris — et l'écran laissait croire au gestionnaire qu'il était protégé.
    sens: "Déclarer l'usage mixte ne protège rien à lui seul : sans plages déclarées, le véhicule reste suivi en permanence, domicile compris.",
  },
  NON_COUVERT: {
    court: 'Suivi en permanence',
    long: 'Suivi en permanence (véhicule professionnel)',
    sens: "Normal pour un véhicule qui ne rentre pas au domicile. L'antivol reste actif 24/7.",
  },
};

/**
 * Cadre de temps de travail par véhicule (usage mixte, RGPD) — client HTTP.
 * GET ouvert (vehicles_view) ; PUT réservé au cadre (schedules_manage).
 */
@Injectable({ providedIn: 'root' })
export class WorkScheduleApiService {
  private readonly http = inject(HttpClient);

  get(vehicleId: string): Observable<WorkScheduleState> {
    return this.http.get<WorkScheduleState>(`/api/vehicles/${vehicleId}/work-schedule`);
  }

  set(vehicleId: string, body: SetWorkScheduleBody): Observable<{ ok: true }> {
    return this.http.put<{ ok: true }>(`/api/vehicles/${vehicleId}/work-schedule`, body);
  }

  /** Déclare/retire l'usage mixte d'un véhicule (gate `schedules_manage`). */
  setMixedUse(vehicleId: string, enabled: boolean): Observable<{ ok: true; mixedUseEnabled: boolean }> {
    return this.http.put<{ ok: true; mixedUseEnabled: boolean }>(`/api/vehicles/${vehicleId}/mixed-use`, { enabled });
  }

  /** Couverture vie privée de la flotte (gate `privacy_manage`). */
  coverage(): Observable<PrivacyCoverageDto> {
    return this.http.get<PrivacyCoverageDto>('/api/privacy-coverage');
  }
}
