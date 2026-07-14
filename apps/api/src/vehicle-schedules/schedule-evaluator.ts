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
/**
 * Cache des Intl.DateTimeFormat par fuseau. Revue perf : `computeNextTransition` peut appeler
 * `getNowInTimezone` des milliers de fois par véhicule ; reconstruire un formateur à chaque appel
 * saturait l'event-loop sur une grosse flotte. Un formateur par fuseau suffit (résultat identique
 * pour un instant donné). Clé = timezone.
 */
const _tzFormatterCache = new Map<string, Intl.DateTimeFormat>();
function getTzFormatter(timezone: string): Intl.DateTimeFormat {
  let f = _tzFormatterCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    _tzFormatterCache.set(timezone, f);
  }
  return f;
}

export function getNowInTimezone(timezone: string, base: Date = new Date()): Date {
  const parts = getTzFormatter(timezone).formatToParts(base);
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
    // Plage normale (a<b) : [a, b[. Plage qui passe minuit (a>b, ex 22:00-06:00) :
    // hit si on est APRES le debut OU AVANT la fin. cf. audit #8 — sinon une plage
    // de nuit ne matchait JAMAIS et l'evaluateur tombait en OUT_OF_WINDOW => moteur
    // coupe 24/7 pour un vehicule legitimement autorise la nuit.
    const hit =
      a < b ? minutesNow >= a && minutesNow < b : a > b ? minutesNow >= a || minutesNow < b : false;
    if (hit) return { hit: true, desc };
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

export interface UpcomingHoliday {
  /** YYYY-MM-DD (jour local du férié). */
  date: string;
  /** Nom localisé (ex. « Fête Nationale de la France »). */
  name: string;
}

/**
 * Prochains jours fériés PUBLICS (à partir de `from`) pour un pays. Sert à l'aperçu de la page
 * « Horaires flotte » (incident 2026-07-14) : anticiper l'effet de l'automatisation les fériés.
 * Retourne au plus `count` fériés à venir (jour non encore terminé), triés par date croissante.
 */
export function computeUpcomingHolidays(
  countryCode: string,
  from: Date = new Date(),
  count = 3,
): UpcomingHoliday[] {
  if (!countryCode) return [];
  try {
    const hd = getHolidays(countryCode);
    const y = from.getFullYear();
    const all = [...(hd.getHolidays(y) ?? []), ...(hd.getHolidays(y + 1) ?? [])];
    const out: UpcomingHoliday[] = [];
    const seen = new Set<string>();
    for (const h of all
      .filter((x) => x.type === 'public')
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())) {
      const start = new Date((h as { start?: Date }).start ?? h.date);
      if (Number.isNaN(start.getTime())) continue;
      // Férié « à venir » : sa journée n'est pas terminée.
      const dayEnd = new Date(start);
      dayEnd.setHours(23, 59, 59, 999);
      if (dayEnd.getTime() < from.getTime()) continue;
      const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date: key, name: h.name });
      if (out.length >= count) break;
    }
    return out;
  } catch {
    return [];
  }
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

  // 2) Jours feries — OPT-IN (incident 2026-07-14). Ne coupe QUE si la flotte a explicitement
  //    demandé « à l'arrêt les fériés » (cutOnHolidays). Sinon un férié suit les horaires NORMAUX
  //    du jour : une flotte de location doit rouler le 14 juillet. Avant, le seul countryeCode
  //    (défaut 'FR') coupait TOUT tous les fériés → 29/30 véhicules cdef31 immobilisés.
  if (schedule.cutOnHolidays && schedule.countryCode) {
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

/**
 * Prochaine bascule de fenêtre (CUT / RESTORE) après `base`, en INSTANT ABSOLU.
 *
 * Sert au compte-à-rebours « dans combien de temps la voiture sera coupée / rendue »
 * de la page flotte. On ré-évalue `evaluateSchedule` en avançant dans le temps RÉEL
 * (pas de calcul de fuseau à la main → nuit + DST gérés par evaluateSchedule lui-même,
 * puisqu'on lui passe un instant absolu qu'il reconvertit dans le fuseau du planning).
 * Pas de 1 min, horizon 8 jours, sortie anticipée au 1er changement d'état.
 *
 * Retourne `null` si aucune bascule dans l'horizon (planning « toujours ouvert » ou
 * « toujours fermé », ex. tous les jours activés sans plages). Granularité = 1 min ;
 * le client interpole ensuite en local (timer 1 s). Perf : le formateur Intl est mémoïsé
 * par fuseau (cf getTzFormatter) et le résultat est mis en cache par
 * (scheduleId, updatedAt) côté FleetSchedulesService — recalculé seulement à l'édition du
 * planning ou une fois la bascule passée. Le cas courant (planning quotidien) sort en < 24 h.
 */
export function computeNextTransition(
  schedule: VehicleSchedule,
  base: Date = new Date(),
): { at: Date; action: 'CUT' | 'RESTORE' } | null {
  const current = evaluateSchedule(schedule, base).state;
  const STEP_MS = 60 * 1000;
  const HORIZON_MS = 8 * 24 * 60 * 60 * 1000;
  for (let elapsed = STEP_MS; elapsed <= HORIZON_MS; elapsed += STEP_MS) {
    const at = new Date(base.getTime() + elapsed);
    const next = evaluateSchedule(schedule, at).state;
    if (next !== current) {
      return { at, action: next === 'IN_WINDOW' ? 'RESTORE' : 'CUT' };
    }
  }
  return null;
}
