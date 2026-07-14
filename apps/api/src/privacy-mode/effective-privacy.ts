import type { VehicleSchedule, VehicleWorkSchedule } from '@prisma/client';
import { evaluateSchedule } from '../vehicle-schedules/schedule-evaluator';

export type EffectivePrivacyReason =
  | 'MANUAL' // flag manuel privacyModeEnabled = privé explicite (gagne toujours)
  | 'WORK_OVERRIDE' // exception ponctuelle « je travaille » = tracé malgré le calendrier
  | 'OUT_OF_HOURS' // hors plage de temps de travail (calendrier) = privé
  | 'WORK_HOURS' // dans une plage de temps de travail = tracé
  | 'NO_SCHEDULE'; // aucun cadre actif = tracé (défaut opt-in)

export interface EffectivePrivacy {
  isPrivate: boolean;
  reason: EffectivePrivacyReason;
}

/** Champs minimaux nécessaires du véhicule (évite de dépendre du modèle Prisma complet). */
export interface PrivacyVehicleInput {
  privacyModeEnabled: boolean;
  workOverrideUntil: Date | null;
}

/**
 * Résout l'état de confidentialité EFFECTIF d'un véhicule à l'instant `now`. Source UNIQUE de
 * vérité, appelée à l'ingestion (collecte) ET à la lecture (état affiché). Précédence :
 *   1. `privacyModeEnabled` (privé manuel explicite) → PRIVÉ — gagne toujours (le plus sûr).
 *   2. `workOverrideUntil > now` (exception « je travaille », ex. dimanche) → TRACÉ.
 *   3. cadre de temps de travail actif → hors plage = PRIVÉ, dans plage = TRACÉ.
 *   4. aucun cadre → TRACÉ (opt-in par véhicule ; on ne coupe pas le suivi par défaut).
 * Le calendrier réutilise `evaluateSchedule` (fuseau, multi-plages, fériés, plages de nuit) : la
 * même logique éprouvée que le coupe-circuit horaire, mais sur un cadre distinct (temps de travail).
 */
export function resolveEffectivePrivacy(
  vehicle: PrivacyVehicleInput,
  workSchedule: VehicleWorkSchedule | null | undefined,
  now: Date = new Date(),
): EffectivePrivacy {
  if (vehicle.privacyModeEnabled) return { isPrivate: true, reason: 'MANUAL' };
  if (vehicle.workOverrideUntil && vehicle.workOverrideUntil.getTime() > now.getTime()) {
    return { isPrivate: false, reason: 'WORK_OVERRIDE' };
  }
  if (workSchedule?.enabled) {
    // Le mode vie privée GARDE « férié = hors-travail = privé » (protection du conducteur),
    // indépendamment de l'opt-in coupe-moteur (incident 2026-07-14) : on force cutOnHolidays.
    const state = evaluateSchedule(
      { ...(workSchedule as unknown as VehicleSchedule), cutOnHolidays: true },
      now,
    ).state;
    return state === 'OUT_OF_WINDOW'
      ? { isPrivate: true, reason: 'OUT_OF_HOURS' }
      : { isPrivate: false, reason: 'WORK_HOURS' };
  }
  return { isPrivate: false, reason: 'NO_SCHEDULE' };
}

/**
 * True si `now` tombe dans une plage de temps de travail déclarée (cadre actif). Sert à INTERDIRE
 * au conducteur de passer en privé une plage de travail (droit de l'employeur), indépendamment de
 * `privacyModeEnabled`.
 */
export function isWithinWorkHours(
  workSchedule: VehicleWorkSchedule | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!workSchedule?.enabled) return false;
  // Idem : les fériés restent « hors-travail » pour le cadre de temps de travail (cutOnHolidays forcé).
  return evaluateSchedule(
    { ...(workSchedule as unknown as VehicleSchedule), cutOnHolidays: true },
    now,
  ).state === 'IN_WINDOW';
}
