import { SurveillanceSensitivity } from '@prisma/client';
import type { ScheduleDay } from './surveillance.dto';

/**
 * Mapping sensibilité métier → niveau Coban (commande `sensitivity123456 N`).
 *
 * Contre-intuitif côté tracker : niveau 1 = vibration légère détectée (très sensible),
 * niveau 3 = il faut secouer fort. On expose à l'utilisateur final une sémantique
 * naturelle (HIGH = réagit à tout, LOW = ne réagit qu'aux gros chocs).
 */
export function mapSensitivityToCobanLevel(s: SurveillanceSensitivity): '1' | '2' | '3' {
  switch (s) {
    case SurveillanceSensitivity.HIGH:
      return '1';
    case SurveillanceSensitivity.MEDIUM:
      return '2';
    case SurveillanceSensitivity.LOW:
      return '3';
  }
}

const DAY_INDEX: Record<ScheduleDay, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/**
 * Détermine si `now` (UTC) tombe dans la plage horaire `[start, end]` pour le
 * profil. Gère les plages qui traversent minuit (ex 20:00 -> 06:00) ET le filtre
 * sur les jours actifs.
 *
 * Important pour le wrap minuit : la "journée logique" est rattachée au jour
 * où débute la plage. Ex : la plage 20:00→06:00 du lundi couvre lundi 20:00 →
 * mardi 06:00. Donc on vérifie si le `start day` est dans `scheduleDays`, pas
 * le jour calendaire courant.
 */
export function isWithinSchedule(
  now: Date,
  startTime: string,
  endTime: string,
  scheduleDays: ScheduleDay[] | null | undefined,
): boolean {
  const [sH, sM] = startTime.split(':').map(Number);
  const [eH, eM] = endTime.split(':').map(Number);
  if (
    Number.isNaN(sH) || Number.isNaN(sM) ||
    Number.isNaN(eH) || Number.isNaN(eM)
  ) {
    return false;
  }
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMin = (sH as number) * 60 + (sM as number);
  const endMin = (eH as number) * 60 + (eM as number);

  const todayIdx = now.getUTCDay();
  const yesterdayIdx = (todayIdx + 6) % 7;
  const dayMatch = (idx: number): boolean => {
    if (!scheduleDays || scheduleDays.length === 0) return true;
    return scheduleDays.some((d) => DAY_INDEX[d] === idx);
  };

  if (startMin === endMin) return false; // plage nulle

  if (startMin < endMin) {
    // Plage normale dans la journée (ex 08:00 -> 18:00)
    return dayMatch(todayIdx) && nowMin >= startMin && nowMin < endMin;
  }

  // Plage qui passe minuit (ex 20:00 -> 06:00).
  // - Soit on est après start aujourd'hui → c'est lié au jour courant.
  // - Soit on est avant end aujourd'hui → c'est lié à la veille.
  if (nowMin >= startMin) return dayMatch(todayIdx);
  if (nowMin < endMin) return dayMatch(yesterdayIdx);
  return false;
}
