import type {
  VehicleEventDto,
  VehicleEventSeverity,
  VehicleEventStatus,
  VehicleEventType,
} from '@vizyo/tracky-shared';

/**
 * Sprint 7 — Agenda : conventions visuelles (couleurs / libellés) + helpers de
 * temps, définis UNE fois et réutilisés par la page agenda, le calendrier et
 * l'onglet maintenance du détail véhicule.
 *
 * Convention couleur événement :
 *   MAINTENANCE  → vert (--tracky)
 *   INCIDENT     → ambre/rouge selon la sévérité
 *   RESERVATION  → bleu (réservé Sprint 8, n'apparaît pas en S7)
 * Statut :
 *   DONE         → muet + check
 *   CANCELLED    → muet barré
 *   PLANNED      → contour
 *   OPEN/retard  → plein rouge/ambre
 */

/**
 * Couleur principale d'un événement selon son type + sévérité.
 *
 * ⚠️ Des jetons `var(--texte-*)`, PAS des hexadécimaux : ces couleurs finissent en
 * couleur de TEXTE via `[style.--pill]` / `[style.--u]`, et les valeurs vives
 * d'avant (#F59E0B, #EF4444, #38BDF8…) rendaient 2,1 à 3,4:1 en thème clair.
 * Les jetons basculent d'eux-mêmes entre les deux thèmes. Elles ne sont
 * consommées que par des propriétés CSS — ne pas les passer à un canvas ni à un
 * attribut SVG, où `var()` ne se résout pas.
 */
export function eventColor(ev: Pick<VehicleEventDto, 'type' | 'severity'>): string {
  switch (ev.type) {
    case 'MAINTENANCE':
      return 'var(--texte-succes)';
    case 'INCIDENT':
      return severityColor(ev.severity);
    case 'RESERVATION':
      return 'var(--texte-info)';
    default:
      return 'var(--texte-inactif)';
  }
}

/** Couleur d'une sévérité d'incident — mêmes règles que eventColor. */
export function severityColor(severity: VehicleEventSeverity | null | undefined): string {
  switch (severity) {
    case 'HIGH':
      return 'var(--texte-alerte)';
    case 'MEDIUM':
    case 'LOW':
      // L'écart amber-400 / amber-500 ne survivait pas au thème clair : les deux
      // sévérités partagent le jeton ambre, le libellé porte la nuance.
      return 'var(--texte-attente)';
    default:
      return 'var(--texte-attente)';
  }
}

/** Libellé FR court d'un type d'événement. */
export function eventTypeLabel(type: VehicleEventType): string {
  switch (type) {
    case 'MAINTENANCE':
      return 'Maintenance';
    case 'INCIDENT':
      return 'Incident';
    case 'RESERVATION':
      return 'Réservation';
    default:
      return type;
  }
}

/** Libellé FR d'un statut d'événement. */
export function eventStatusLabel(status: VehicleEventStatus): string {
  switch (status) {
    case 'PLANNED':
      return 'Planifié';
    case 'OPEN':
      return 'Ouvert';
    case 'IN_PROGRESS':
      return 'En cours';
    case 'DONE':
      return 'Terminé';
    case 'CANCELLED':
      return 'Annulé';
    case 'REQUESTED':
      return 'Demande';
    case 'CONFIRMED':
      return 'Confirmée';
    default:
      return status;
  }
}

/** Libellé FR d'une sévérité. */
export function severityLabel(severity: VehicleEventSeverity | null | undefined): string {
  switch (severity) {
    case 'HIGH':
      return 'Critique';
    case 'MEDIUM':
      return 'Moyenne';
    case 'LOW':
      return 'Faible';
    default:
      return '—';
  }
}

/** Urgence dérivée d'un événement non clôturé selon son échéance (startAt). */
export type EventUrgency = 'overdue' | 'soon' | 'normal' | 'done';

/**
 * Calcule l'urgence d'un événement PLANNED/OPEN par rapport à maintenant :
 *  - DONE/CANCELLED → 'done' (neutre)
 *  - échéance passée → 'overdue'
 *  - échéance < 7 jours → 'soon'
 *  - sinon → 'normal'
 */
export function eventUrgency(ev: Pick<VehicleEventDto, 'status' | 'startAt'>, now = Date.now()): EventUrgency {
  if (ev.status === 'DONE' || ev.status === 'CANCELLED') return 'done';
  const due = new Date(ev.startAt).getTime();
  if (Number.isNaN(due)) return 'normal';
  if (due < now) return 'overdue';
  if (due - now < 7 * 86400000) return 'soon';
  return 'normal';
}

/** Couleur associée à une urgence (listes à venir / en retard) — mêmes règles que eventColor. */
export function urgencyColor(urgency: EventUrgency): string {
  switch (urgency) {
    case 'overdue':
      return 'var(--texte-alerte)';
    case 'soon':
      return 'var(--texte-attente)';
    case 'done':
      return 'var(--texte-inactif)';
    default:
      return 'var(--texte-succes)';
  }
}

// ─── Helpers de date (natifs, repris du date-range-picker, heure LOCALE) ────

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
export function startOfWeekMonday(d: Date): Date {
  const dow = d.getDay();
  const offset = (dow + 6) % 7;
  return addDays(d, -offset);
}
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
/** YYYY-MM-DD en heure LOCALE (évite les décalages d'1 jour façon UTC). */
export function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
/** 42 cellules (6 semaines) à partir du lundi de la 1re semaine du mois. */
export function buildCells(monthFirst: Date): Date[] {
  const start = startOfWeekMonday(monthFirst);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(start, i));
  return cells;
}
