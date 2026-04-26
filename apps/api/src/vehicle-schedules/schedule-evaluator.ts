import type { VehicleSchedule } from '@prisma/client';
import Holidays from 'date-holidays';

/**
 * V1.5 (Sprint K) — Evaluation du scheduling V2.
 *
 * Trois niveaux de priorite (du plus prioritaire au moins prioritaire) :
 *   1. customDates  : override ponctuel pour la date du jour
 *   2. jours feries : si countryCode est defini ET le jour est ferie -> CUT
 *   3. plages hebdo : multi-slots (mondaySlots, ...) + fallback legacy
 *
 * Cette fonction est cote serveur, mais l'helper est exporte sous forme pure
 * pour faciliter les tests et une eventuelle reutilisation cote client.
 */

export type ScheduleState = 'IN_WINDOW' | 'OUT_OF_WINDOW';

export type ScheduleReason =
  | 'IN_WINDOW'              // dans une plage active
  | 'OUT_OF_WINDOW'           // hors plage normale
  | 'DAY_DISABLED'            // jour explicitement coche disabled
  | 'HOLIDAY'                 // jour ferie selon countryCode
  | 'CUSTOM_DATE_CLOSED'      // override custom : ferme ce jour
  | 'CUSTOM_DATE_RANGE'       // override custom : dans une plage de la date
  | 'CUSTOM_DATE_OUT';         // override custom : hors plages de la date

export interface EvaluationResult {
  state: ScheduleState;
  reason: ScheduleReason;
  windowDesc: string | null;
}

interface Slot { start: string; end: string }

interface CustomDateEntry {
  date: string;
  closed?: boolean;
  slots?: Slot[];
}

const DAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday',
] as const;

/**
 * Get current Date object adjusted to a timezone.
 * Returns naive Date components matching the tz, so we can read getHours()
 * etc. as if we were in that timezone.
 */
export function getNowInTimezone(timezone: string, base: Date = new Date()): Date {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(base);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return new Date(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  );
}

function parseTime(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function inAnySlot(slots: Slot[], minutesNow: number): { hit: boolean; desc: string } {
  const desc = slots.map((s) => `${s.start}-${s.end}`).join(' + ');
  for (const slot of slots) {
    const a = parseTime(slot.start);
    const b = parseTime(slot.end);
    if (a == null || b == null) continue;
    if (minutesNow >= a && minutesNow < b) return { hit: true, desc };
  }
  return { hit: false, desc };
}

function legacyDaySlot(schedule: VehicleSchedule, dayName: string): Slot | null {
  const start = (schedule as unknown as Record<string, string | null>)[`${dayName}Start`];
  const end = (schedule as unknown as Record<string, string | null>)[`${dayName}End`];
  if (!start || !end) return null;
  return { start, end };
}

const holidaysCache = new Map<string, Holidays>();
function getHolidays(countryCode: string): Holidays {
  let h = holidaysCache.get(countryCode);
  if (!h) {
    h = new Holidays(countryCode);
    holidaysCache.set(countryCode, h);
  }
  return h;
}

/**
 * Returns the schedule state at the given moment, with the matching reason
 * + a human-readable window description.
 *
 * If `schedule.enabled = false`, the function still returns a state to be
 * informative, but the cron consumer should not act on it.
 */
export function evaluateSchedule(
  schedule: VehicleSchedule,
  base: Date = new Date(),
): EvaluationResult {
  const now = getNowInTimezone(schedule.timezone, base);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const today = dateKey(now);
  const dayName = DAYS[now.getDay()]!;

  // 1) customDates — priorite max
  const customDates = (schedule.customDates as unknown as CustomDateEntry[] | null) ?? null;
  if (Array.isArray(customDates)) {
    const entry = customDates.find((c) => c.date === today);
    if (entry) {
      if (entry.closed) {
        return { state: 'OUT_OF_WINDOW', reason: 'CUSTOM_DATE_CLOSED', windowDesc: 'Date specifique : ferme' };
      }
      if (Array.isArray(entry.slots) && entry.slots.length > 0) {
        const out = inAnySlot(entry.slots, minutesNow);
        return {
          state: out.hit ? 'IN_WINDOW' : 'OUT_OF_WINDOW',
          reason: out.hit ? 'CUSTOM_DATE_RANGE' : 'CUSTOM_DATE_OUT',
          windowDesc: `Date specifique : ${out.desc}`,
        };
      }
      // entry sans closed=true ni slots = on retombe sur la logique normale
    }
  }

  // 2) Jours feries
  if (schedule.countryCode) {
    try {
      const hd = getHolidays(schedule.countryCode);
      const matches = hd.isHoliday(now);
      if (matches && Array.isArray(matches) && matches.length > 0) {
        const name = matches[0]!.name;
        return { state: 'OUT_OF_WINDOW', reason: 'HOLIDAY', windowDesc: `Ferie : ${name}` };
      }
    } catch {
      // Pays inconnu / lib boguee — on continue avec les plages hebdo.
    }
  }

  // 3) Plages hebdomadaires
  const enabled = (schedule as unknown as Record<string, boolean>)[`${dayName}Enabled`];
  if (!enabled) {
    return { state: 'OUT_OF_WINDOW', reason: 'DAY_DISABLED', windowDesc: `${dayName} desactive` };
  }
  const slots = (schedule as unknown as Record<string, Slot[] | null>)[`${dayName}Slots`];
  const effectiveSlots: Slot[] = Array.isArray(slots) && slots.length > 0
    ? slots
    : (() => {
        const legacy = legacyDaySlot(schedule, dayName);
        return legacy ? [legacy] : [];
      })();

  if (effectiveSlots.length === 0) {
    // Jour active sans plages = no restriction
    return { state: 'IN_WINDOW', reason: 'IN_WINDOW', windowDesc: 'Toute la journee' };
  }

  const out = inAnySlot(effectiveSlots, minutesNow);
  return {
    state: out.hit ? 'IN_WINDOW' : 'OUT_OF_WINDOW',
    reason: out.hit ? 'IN_WINDOW' : 'OUT_OF_WINDOW',
    windowDesc: out.desc,
  };
}
