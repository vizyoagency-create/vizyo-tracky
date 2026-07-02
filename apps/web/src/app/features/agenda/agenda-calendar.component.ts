import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { VehicleEventDto } from '@vizyo/tracky-shared';
import {
  addDays,
  buildCells,
  eventColor,
  isSameDay,
  localIso,
  startOfMonth,
  startOfWeekMonday,
} from './agenda.utils';

/** Pilule d'événement affichée dans une cellule (couleur + libellé court). */
interface CalendarPill {
  id: string;
  color: string;
  label: string;
  muted: boolean;
}

/** Cellule du calendrier (un jour). */
interface CalendarCell {
  iso: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  aria: string;
  pills: CalendarPill[];
  overflow: number;
  count: number;
  /** Sprint 8 — nb de véhicules ayant roulé ce jour-là (couche activité). */
  active: number;
  /** Sprint 8 (Palier C) — nb de véhicules dont l'usage est prévu ce jour (couche fantôme). */
  forecast: number;
}

const MAX_PILLS = 3;
const weekdayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/**
 * Sprint 7 — Grille calendrier mensuelle (from scratch, Date natif). 7 colonnes
 * (Lun→Dim) × 6 lignes. Chaque cellule : numéro du jour + jusqu'à 3 pilules
 * colorées par type d'événement + "+N" en débordement. Jour courant surligné,
 * jours hors-mois atténués. Mobile : pleine largeur, cibles ≥ 40px.
 *
 *   [events]       : événements à placer (filtrés en amont par la page)
 *   [currentMonth] : n'importe quelle date du mois affiché
 *   (dayClick)     : ISO (YYYY-MM-DD) du jour cliqué
 */
@Component({
  selector: 'app-agenda-calendar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cal">
      <div class="cal-weekdays" aria-hidden="true">
        @for (w of weekdayLabels; track $index) { <span>{{ w }}</span> }
      </div>
      <div class="cal-grid" role="grid">
        @for (c of cells(); track c.iso) {
          <button
            type="button"
            role="gridcell"
            class="cal-cell"
            [class.cal-cell--outside]="!c.inMonth"
            [class.cal-cell--today]="c.isToday"
            [class.cal-cell--has]="c.count > 0"
            [attr.aria-label]="c.aria + (c.count ? ' — ' + c.count + ' événement(s)' : '')"
            (click)="dayClick.emit(c.iso)">
            <span class="cal-cell-day">{{ c.day }}</span>
            @if (c.active > 0 || c.forecast > 0) {
              <span class="cal-badges">
                @if (c.active > 0) {
                  <span class="cal-activity" [attr.title]="c.active + ' véhicule(s) ayant roulé ce jour'"><span class="cal-activity-dot"></span>{{ c.active }}</span>
                }
                @if (c.forecast > 0) {
                  <span class="cal-forecast" [attr.title]="c.forecast + ' véhicule(s) — usage habituel prévu'">~{{ c.forecast }}</span>
                }
              </span>
            }
            <span class="cal-cell-pills">
              @for (p of c.pills; track p.id) {
                <span class="cal-pill" [class.cal-pill--muted]="p.muted"
                      [style.--pill]="p.color" [title]="p.label">
                  <span class="cal-pill-text">{{ p.label }}</span>
                </span>
              }
              @if (c.overflow > 0) {
                <span class="cal-more">+{{ c.overflow }}</span>
              }
            </span>
            <!-- Mobile compact : pastilles colorées (les pilules texte sont masquées en CSS) -->
            @if (c.count > 0) {
              <span class="cal-dots" aria-hidden="true">
                @for (p of c.pills; track p.id) {
                  <span class="cal-dot" [style.background]="p.color"></span>
                }
                @if (c.overflow > 0) { <span class="cal-dot cal-dot--more"></span> }
              </span>
            }
            <!-- Mobile : indicateurs de coin (les compteurs chiffrés sont masqués faute de place) -->
            @if (c.active > 0 || c.forecast > 0) {
              <span class="cal-mini" aria-hidden="true">
                @if (c.active > 0) { <span class="cal-mini-dot cal-mini-dot--act"></span> }
                @if (c.forecast > 0) { <span class="cal-mini-dot cal-mini-dot--fc"></span> }
              </span>
            }
          </button>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cal {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card);
      padding: 10px;
      overflow: hidden;
    }
    .cal-weekdays {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
      margin-bottom: 6px;
    }
    .cal-weekdays span {
      text-align: center;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: var(--fg-tertiary);
      padding: 2px 0;
    }
    .cal-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      grid-auto-rows: 1fr;
      gap: 4px;
    }
    .cal-cell {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 3px;
      min-height: 88px;
      padding: 6px;
      background: var(--bg-tertiary);
      border: 1px solid transparent;
      border-radius: 10px;
      cursor: pointer;
      text-align: left;
      transition: border-color .12s, background .12s, transform .05s;
      overflow: hidden;
    }
    .cal-cell:hover { border-color: var(--border-strong); }
    .cal-cell:active { transform: translateY(1px); }
    .cal-cell--has { background: color-mix(in srgb, var(--tracky) 5%, var(--bg-tertiary)); }
    .cal-cell--outside { opacity: .42; }
    .cal-cell--today {
      border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 65%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tracky-light, #10E0A0) 35%, transparent);
    }
    .cal-cell-day {
      font-size: 12px;
      font-weight: 700;
      color: var(--fg-secondary);
      line-height: 1;
    }
    .cal-cell--today .cal-cell-day { color: var(--tracky-light); }
    .cal-cell-pills {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .cal-pill {
      display: flex;
      align-items: center;
      min-width: 0;
      padding: 2px 5px;
      border-radius: 5px;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.25;
      color: var(--pill, #10E0A0);
      background: color-mix(in srgb, var(--pill, #10E0A0) 16%, transparent);
      border-left: 2px solid var(--pill, #10E0A0);
    }
    .cal-pill--muted {
      color: var(--fg-tertiary);
      background: var(--bg-secondary);
      border-left-color: var(--fg-tertiary);
      text-decoration: line-through;
      text-decoration-thickness: 1px;
    }
    .cal-pill-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cal-more {
      font-size: 9px;
      font-weight: 700;
      color: var(--fg-tertiary);
      padding-left: 3px;
    }
    /* Sprint 8 — badges coin haut-droit : activité réelle (bleu plein) + usage prévu (violet pointillé). */
    .cal-badges { position: absolute; top: 5px; right: 5px; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
    .cal-activity {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 5px 1px 4px;
      font-size: 9px;
      font-weight: 800;
      line-height: 1.4;
      border-radius: 999px;
      color: #38BDF8;
      background: color-mix(in srgb, #38BDF8 14%, transparent);
    }
    .cal-activity-dot { width: 5px; height: 5px; border-radius: 50%; background: #38BDF8; }
    .cal-forecast {
      display: inline-flex;
      align-items: center;
      padding: 1px 5px;
      font-size: 9px;
      font-weight: 700;
      line-height: 1.4;
      border-radius: 999px;
      color: #A78BFA;
      border: 1px dashed color-mix(in srgb, #A78BFA 45%, transparent);
    }
    /* Pastilles compactes — affichées seulement en mobile (pilules texte masquées). */
    .cal-dots { display: none; gap: 3px; margin-top: auto; }
    .cal-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .cal-dot--more {
      background: var(--fg-tertiary) !important;
      opacity: .6;
    }
    /* Indicateurs de coin (mobile only) : activité réelle (bleu plein) + prévu (violet contour). */
    .cal-mini { display: none; }
    .cal-mini-dot { width: 5px; height: 5px; border-radius: 50%; }
    .cal-mini-dot--act { background: #38BDF8; }
    .cal-mini-dot--fc { border: 1px solid #A78BFA; }

    @media (max-width: 640px) {
      .cal { padding: 6px; }
      .cal-grid { gap: 3px; }
      .cal-cell {
        min-height: 44px;
        padding: 5px 4px;
        align-items: center;
        gap: 4px;
      }
      .cal-cell-day { font-size: 12px; }
      /* En mobile : on remplace les pilules texte par des pastilles colorées. */
      .cal-cell-pills { display: none; }
      /* Cellules trop compactes en mobile pour les badges chiffrés : remplacés par des points de coin. */
      .cal-badges { display: none; }
      .cal-mini { position: absolute; top: 4px; right: 4px; display: inline-flex; gap: 2px; }
      .cal-dots { display: flex; justify-content: center; flex-wrap: wrap; }
    }
  `],
})
export class AgendaCalendarComponent {
  /** Événements à placer dans la grille (déjà filtrés par la page parente). */
  readonly events = input<VehicleEventDto[]>([]);
  /** N'importe quelle date du mois affiché. */
  readonly currentMonth = input<Date>(new Date());
  /** Sprint 8 — nb de véhicules ayant roulé par jour (clé ISO locale) : couche « activité réelle ». */
  readonly activityByDay = input<Map<string, number>>(new Map());
  /** Sprint 8 (Palier C) — nb de véhicules dont l'usage est PRÉVU ce jour (couche fantôme). */
  readonly forecastByDay = input<Map<string, number>>(new Map());
  /** Émis avec l'ISO (YYYY-MM-DD) du jour cliqué. */
  readonly dayClick = output<string>();

  protected readonly weekdayLabels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  /** Regroupe les événements par jour (clé ISO locale de leur startAt). */
  private readonly eventsByDay = computed(() => {
    const map = new Map<string, VehicleEventDto[]>();
    for (const ev of this.events()) {
      const d = new Date(ev.startAt);
      if (Number.isNaN(d.getTime())) continue;
      const key = localIso(d);
      const list = map.get(key);
      if (list) list.push(ev);
      else map.set(key, [ev]);
    }
    return map;
  });

  protected readonly cells = computed<CalendarCell[]>(() => {
    const monthFirst = startOfMonth(this.currentMonth());
    const monthIdx = monthFirst.getMonth();
    const today = new Date();
    const byDay = this.eventsByDay();
    const byActivity = this.activityByDay();
    const byForecast = this.forecastByDay();
    const start = startOfWeekMonday(monthFirst);

    return Array.from({ length: 42 }, (_, i) => {
      const d = addDays(start, i);
      const iso = localIso(d);
      const dayEvents = byDay.get(iso) ?? [];
      // Tri : non clôturés d'abord, puis par heure de début.
      const sorted = [...dayEvents].sort((a, b) => {
        const aDone = a.status === 'DONE' || a.status === 'CANCELLED' ? 1 : 0;
        const bDone = b.status === 'DONE' || b.status === 'CANCELLED' ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
      });
      const pills: CalendarPill[] = sorted.slice(0, MAX_PILLS).map((ev) => ({
        id: ev.id,
        color: eventColor(ev),
        label: ev.title || ev.vehiclePlate || '—',
        muted: ev.status === 'DONE' || ev.status === 'CANCELLED',
      }));
      return {
        iso,
        day: d.getDate(),
        inMonth: d.getMonth() === monthIdx,
        isToday: isSameDay(d, today),
        aria: weekdayFmt.format(d),
        pills,
        overflow: Math.max(0, sorted.length - MAX_PILLS),
        count: sorted.length,
        active: byActivity.get(iso) ?? 0,
        forecast: byForecast.get(iso) ?? 0,
      };
    });
  });
}
