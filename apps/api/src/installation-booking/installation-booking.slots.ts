/**
 * Génération des créneaux d'installation en fuseau Europe/Paris.
 *
 * Les créneaux sont pensés en heure LOCALE Paris (« 08:00 → 20:00, pas de 2h ») mais
 * stockés/renvoyés en instants UTC. La conversion tient compte de l'heure d'été (DST)
 * via `Intl` — sans dépendance externe (le repo n'embarque pas de lib de fuseau).
 *
 * Fonctions PURES (une `now` explicite en paramètre) → unit-testables sans horloge.
 */

const PARIS_TZ = 'Europe/Paris';

const PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: PARIS_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
});

const DAY_LABEL_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: PARIS_TZ, weekday: 'short', day: 'numeric', month: 'short',
});
const TIME_LABEL_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: PARIS_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});

export interface SlotConfig {
  slotMinutes: number;
  dayStartMinutes: number;
  dayEndMinutes: number;
  /** Jours ISO ouvrés (1=lundi … 7=dimanche). */
  workingDays: number[];
  horizonDays: number;
  leadHours: number;
}

export interface GeneratedSlot {
  startAt: Date;
  endAt: Date;
  label: string;
}
export interface GeneratedDay {
  date: string; // "YYYY-MM-DD" (jour local Paris)
  label: string;
  slots: GeneratedSlot[];
}

/** Intervalle occupé (créneau déjà pris). */
export interface BusyInterval {
  startMs: number;
  endMs: number;
}

/** Décompose un instant en composantes Paris (dont le jour ISO 1..7). */
export function parisParts(date: Date): {
  year: number; month: number; day: number; hour: number; minute: number; isoWeekday: number;
} {
  const parts = PARTS_FMT.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday'); // Mon..Sun
  const ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24, // Intl peut rendre "24" à minuit
    minute: Number(get('minute')),
    isoWeekday: ISO[wd] ?? 1,
  };
}

/**
 * Convertit une heure-murale Paris (y, mo, d, h, mi) en instant UTC. Approche à deux
 * passes robuste au DST : on projette une 1re fois comme si c'était de l'UTC, on lit
 * l'heure Paris obtenue, puis on corrige de l'écart. (Les créneaux 08h–20h ne tombent
 * jamais sur la bascule DST de 02h→03h, donc pas d'ambiguïté.)
 */
export function parisWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = parisParts(new Date(guess));
  const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const desired = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(guess + (desired - actual));
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Génère les jours + créneaux LIBRES sur l'horizon, en excluant :
 *  - les jours non ouvrés,
 *  - les créneaux avant `now + leadHours`,
 *  - les créneaux chevauchant un intervalle occupé (`busy`, demi-ouvert [start,end)).
 */
export function generateAvailability(config: SlotConfig, now: Date, busy: BusyInterval[]): GeneratedDay[] {
  const {
    slotMinutes, dayStartMinutes, dayEndMinutes, workingDays, horizonDays, leadHours,
  } = config;
  const days: GeneratedDay[] = [];
  if (slotMinutes <= 0 || dayEndMinutes - dayStartMinutes < slotMinutes) return days;

  const earliestMs = now.getTime() + leadHours * 3_600_000;
  const workSet = new Set(workingDays);
  const today = parisParts(now);
  // Point de départ : minuit Paris du jour courant.
  const base = parisWallClockToUtc(today.year, today.month, today.day, 0, 0);

  for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset++) {
    // Milieu de journée (12h) pour lire une date stable même autour d'un DST.
    const midInstant = new Date(base.getTime() + dayOffset * 86_400_000 + 12 * 3_600_000);
    const dp = parisParts(midInstant);
    if (!workSet.has(dp.isoWeekday)) continue;

    const slots: GeneratedSlot[] = [];
    for (let start = dayStartMinutes; start + slotMinutes <= dayEndMinutes; start += slotMinutes) {
      const sh = Math.floor(start / 60);
      const sm = start % 60;
      const eh = Math.floor((start + slotMinutes) / 60);
      const em = (start + slotMinutes) % 60;
      const startAt = parisWallClockToUtc(dp.year, dp.month, dp.day, sh, sm);
      const endAt = parisWallClockToUtc(dp.year, dp.month, dp.day, eh, em);
      if (startAt.getTime() < earliestMs) continue;
      const overlaps = busy.some((b) => startAt.getTime() < b.endMs && endAt.getTime() > b.startMs);
      if (overlaps) continue;
      slots.push({
        startAt,
        endAt,
        label: `${TIME_LABEL_FMT.format(startAt)} – ${TIME_LABEL_FMT.format(endAt)}`,
      });
    }
    if (slots.length > 0) {
      days.push({
        date: `${dp.year}-${pad(dp.month)}-${pad(dp.day)}`,
        label: DAY_LABEL_FMT.format(midInstant),
        slots,
      });
    }
  }
  return days;
}

/** Libellé lisible d'un créneau (date + heures, Europe/Paris). */
export function slotLabel(startAt: Date, endAt: Date): string {
  return `${DAY_LABEL_FMT.format(startAt)}, ${TIME_LABEL_FMT.format(startAt)} – ${TIME_LABEL_FMT.format(endAt)}`;
}
