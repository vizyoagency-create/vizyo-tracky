import { FLEET_TIME_ZONE } from '../common/utils/datetime';

/**
 * Un instant, vu en heure LOCALE de la flotte : jour civil, jour de semaine ISO, seconde du jour.
 *
 * C'est la clé du rejeu de la démo : une trame réelle émise « mardi à 08:14:30 heure de Paris »
 * est rejouée chaque mardi à 08:14:30 heure de Paris — été comme hiver. Raisonner en UTC aurait
 * décalé toute la flotte d'une heure au changement d'heure, et une tournée qui part à 07:00 en
 * septembre serait partie à 06:00 en décembre.
 */
export interface InstantLocal {
  /** « 2026-09-08 » — jour civil local, pour savoir quand la journée a tourné. */
  dayKey: string;
  /** Jour de semaine ISO : 1 = lundi … 7 = dimanche. */
  weekday: number;
  /** Seconde écoulée depuis minuit local : 0 … 86 399. */
  secondOfDay: number;
}

const JOURS_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * ⚠️ `formatToParts` et jamais `Number(format(...))` : c'est la leçon de TRK-044
 * (`heureParis`) — un format localisé habille les nombres, et `Number('04 h')` vaut NaN.
 * `hourCycle: 'h23'` : minuit = « 00 », jamais « 24 ».
 */
export function instantLocal(instant: Date, timeZone: string = FLEET_TIME_ZONE): InstantLocal {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const lire = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const n = (type: Intl.DateTimeFormatPartTypes): number => Number(lire(type)) || 0;

  return {
    dayKey: `${lire('year')}-${lire('month')}-${lire('day')}`,
    weekday: JOURS_ISO[lire('weekday')] ?? 1,
    secondOfDay: (n('hour') * 3600 + n('minute') * 60 + n('second')) % 86_400,
  };
}
