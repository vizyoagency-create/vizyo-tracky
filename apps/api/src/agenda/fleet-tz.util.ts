/**
 * Refonte agenda/IA (2026-07, P3) — Helpers de fuseau flotte (Europe/Paris) partagés.
 * Conversion instant UTC ↔ heure murale locale, DST-safe via `Intl` (aucune lib fuseau).
 * Utilisés par le détecteur de récurrence (et réutilisables ailleurs).
 */
export const FLEET_TZ = 'Europe/Paris';

const WEEKDAY_TO_DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Formateur TZ flotte (date + heure + jour de semaine, 24 h). */
export function fleetTzFormatter(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FLEET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
}

/** Décompose un instant (ms) en parties locales flotte : dateKey (YYYY-MM-DD), jour 1-7, minutes du jour. */
export function localParts(fmt: Intl.DateTimeFormat, ms: number): { dateKey: string; dow: number; minutes: number } {
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = parseInt(get('hour'), 10) % 24;
  const minute = parseInt(get('minute'), 10);
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    dow: WEEKDAY_TO_DOW[get('weekday')] ?? 1,
    minutes: (Number.isNaN(hour) ? 0 : hour) * 60 + (Number.isNaN(minute) ? 0 : minute),
  };
}

/** Instant UTC correspondant à une heure murale locale (minutes du jour) pour une date donnée. */
export function localWallToUtc(dateKey: string, minutes: number): Date {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  const naive = new Date(`${dateKey}T${pad(h)}:${pad(m)}:00Z`);
  const asTz = new Date(naive.toLocaleString('en-US', { timeZone: FLEET_TZ }));
  const asUtc = new Date(naive.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = asTz.getTime() - asUtc.getTime();
  return new Date(naive.getTime() - offset);
}
