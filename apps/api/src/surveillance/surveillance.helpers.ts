import { SurveillanceSensitivity } from '@prisma/client';
import { FLEET_TIME_ZONE } from '../common/utils/datetime';
import { getNowInTimezone } from '../vehicle-schedules/schedule-evaluator';
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
 * Détermine si `now` tombe dans la plage horaire `[start, end]` pour le profil.
 * Gère les plages qui traversent minuit (ex 20:00 -> 06:00) ET le filtre sur les
 * jours actifs.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ « 20:00 » EST UNE HEURE DE PENDULE, PAS UN INSTANT (corrigé au lot B0′)     │
 * │                                                                            │
 * │ Cette fonction lisait `getUTCHours()`. Une surveillance réglée sur 18:00    │
 * │ démarrait donc à 18:00 UTC, soit **20:00 à Paris en été** : deux heures     │
 * │ pendant lesquelles le véhicule n'était pas protégé, sans que personne ne le │
 * │ sache — l'écran affichait bien « 18:00 », et l'antivol était bien « actif ».│
 * │                                                                            │
 * │ Une plage récurrente n'a pas d'équivalent UTC : son décalage vaut +2 h      │
 * │ l'été et +1 h l'hiver. Le seul énoncé juste est « 18:00 dans le fuseau de   │
 * │ la flotte », que `getNowInTimezone` résout au bon décalage à chaque tick, y │
 * │ compris le dimanche du changement d'heure.                                  │
 * │                                                                            │
 * │ C'est déjà la convention du dépôt : `VehicleSchedule` (horaires moteur) et  │
 * │ `VehicleWorkSchedule` (cadre RGPD) portent une colonne `timezone`, et       │
 * │ `evaluateSchedule` en tient compte depuis le sprint K. La surveillance      │
 * │ était le seul planning resté en UTC.                                        │
 * │                                                                            │
 * │ Les profils déjà en base ont été convertis par la migration                 │
 * │ `20260810_surveillance_horaires_locaux` : aucun véhicule ne change de       │
 * │ fenêtre de protection au déploiement.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Important pour le wrap minuit : la "journée logique" est rattachée au jour
 * où débute la plage. Ex : la plage 20:00→06:00 du lundi couvre lundi 20:00 →
 * mardi 06:00. Donc on vérifie si le `start day` est dans `scheduleDays`, pas
 * le jour calendaire courant.
 *
 * @param timezone fuseau dans lequel lire `startTime`/`endTime`. Par défaut celui
 *                 de la flotte — les profils n'ont pas (encore) de colonne dédiée ;
 *                 le jour où une flotte sortira de France métropolitaine, elle se
 *                 branchera ici comme `VehicleSchedule.timezone` le fait déjà.
 */
export function isWithinSchedule(
  now: Date,
  startTime: string,
  endTime: string,
  scheduleDays: ScheduleDay[] | null | undefined,
  timezone: string = FLEET_TIME_ZONE,
  weekendPermanent = false,
): boolean {
  const [sH, sM] = startTime.split(':').map(Number);
  const [eH, eM] = endTime.split(':').map(Number);
  if (
    Number.isNaN(sH) || Number.isNaN(sM) ||
    Number.isNaN(eH) || Number.isNaN(eM)
  ) {
    return false;
  }
  // Date « naïve » dont les composants locaux sont ceux du fuseau demandé : on lit
  // ensuite getHours() / getDay(), jamais leurs variantes UTC.
  const local = getNowInTimezone(timezone, now);
  const nowMin = local.getHours() * 60 + local.getMinutes();
  const startMin = (sH as number) * 60 + (sM as number);
  const endMin = (eH as number) * 60 + (eM as number);

  const todayIdx = local.getDay();
  const yesterdayIdx = (todayIdx + 6) % 7;
  const dayMatch = (idx: number): boolean => {
    if (!scheduleDays || scheduleDays.length === 0) return true;
    return scheduleDays.some((d) => DAY_INDEX[d] === idx);
  };

  // ═══ « UN WEEK-END N'A PAS D'HEURES OUVRÉES » ═══════════════════════════════
  //
  // Un profil réglé 20:00 → 06:00 sur sept jours laissait le samedi de 06:00 à
  // 20:00 SANS protection : quatorze heures où un dépôt est vide et où personne
  // ne passe. L'écran affichait pourtant « antivol actif ». Même famille d'erreur
  // que les heures lues en UTC (cf. le bloc ci-dessus) : une promesse tenue à
  // l'affichage, pas dans les faits.
  //
  // Le test vient AVANT la plage — c'est bien lui qui la remplace ce jour-là, il
  // ne s'y ajoute pas. Et il respecte `scheduleDays` : un samedi DÉCOCHÉ n'est pas
  // surveillé du tout, sinon décocher un jour n'aurait plus aucun effet.
  //
  // ⚠️ `weekendPermanent` est `false` par défaut, et le paramètre est optionnel :
  // tout appelant qui ne le passe pas garde EXACTEMENT le comportement d'avant.
  // Décision client du 2026-08-16 (option B) : la case est décochée sur les profils
  // existants, cochée à la création d'un nouveau.
  if (weekendPermanent && (todayIdx === 0 || todayIdx === 6) && dayMatch(todayIdx)) {
    return true;
  }

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
