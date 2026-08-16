import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { LucideAngularModule, ChevronLeft, ChevronRight } from 'lucide-angular';

/**
 * Calendrier inline avec selection d'une plage (from / to).
 *
 * Utilise dans /reports en desktop comme alternative aux <input type="date">
 * natifs. Affiche 2 mois cote a cote (mois precedent + mois courant par
 * defaut). Clic 1 = debut, clic 2 = fin (auto-reordonne si <).
 *
 * Localisation FR via Intl.DateTimeFormat. Pas de dependance externe.
 *
 * Inputs/outputs :
 *   - from, to : plage courante (ISO YYYY-MM-DD, '' si vide)
 *   - (fromChange), (toChange) : emis a chaque selection partielle
 *   - (rangeChange) : emis quand la plage devient complete (2e clic)
 *   - min, max : bornes desactivees (ISO)
 */
@Component({
  selector: 'app-date-range-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    <!-- LES QUATRE RACCOURCIS D'ABORD — « dans 9 cas sur 10 on veut 7 jours, pas un
         calendrier » (Kit Partage). Ils sont AVANT la grille, pas à côté : le
         calendrier reste disponible pour le dixième cas, il cesse d'être le passage
         obligé des neuf autres. -->
    @if (raccourcis()) {
      <div class="drp-raccourcis" role="group" aria-label="Périodes courantes">
        @for (r of RACCOURCIS; track r.jours) {
          <button
            type="button"
            class="drp-rac"
            [class.drp-rac--actif]="raccourciActif() === r.jours"
            (click)="appliquerRaccourci(r.jours)">
            {{ r.libelle }}
          </button>
        }
      </div>
    }

    <div class="drp-root" (keydown)="onKeydown($event)">
      @for (m of months(); track m.key; let idx = $index) {
        <div class="drp-month">
          <div class="drp-header">
            @if (idx === 0) {
              <button type="button" class="drp-nav" (click)="prevMonth()"
                      aria-label="Mois précédent">
                <lucide-icon [img]="ChevronLeft" [size]="14"></lucide-icon>
              </button>
            } @else { <span class="drp-nav-spacer"></span> }
            <span class="drp-month-label">{{ m.label }}</span>
            @if (idx === months().length - 1) {
              <button type="button" class="drp-nav" (click)="nextMonth()"
                      aria-label="Mois suivant">
                <lucide-icon [img]="ChevronRight" [size]="14"></lucide-icon>
              </button>
            } @else { <span class="drp-nav-spacer"></span> }
          </div>
          <div class="drp-weekdays" aria-hidden="true">
            @for (w of weekdayLabels; track $index) { <span>{{ w }}</span> }
          </div>
          <div class="drp-cells" role="grid" [attr.aria-label]="m.label">
            @for (c of m.cells; track c.iso) {
              <button
                type="button"
                role="gridcell"
                class="drp-cell"
                [attr.data-iso]="c.iso"
                [attr.aria-label]="c.aria"
                [attr.aria-selected]="c.isStart || c.isEnd ? 'true' : null"
                [attr.aria-disabled]="c.disabled ? 'true' : null"
                [attr.tabindex]="c.tabIndex"
                [disabled]="c.disabled"
                [class.drp-cell--outside]="!c.inMonth"
                [class.drp-cell--today]="c.isToday"
                [class.drp-cell--start]="c.isStart"
                [class.drp-cell--end]="c.isEnd"
                [class.drp-cell--in-range]="c.isInRange"
                [class.drp-cell--preview]="c.isPreview"
                (click)="onCellClick(c)"
                (mouseenter)="onCellHover(c)"
                (focus)="onCellFocus(c)">
                {{ c.day }}
              </button>
            }
          </div>
        </div>
      }
    </div>

    <!-- LE TOTAL DE LA SÉLECTION — « on évite les "du 1er au 31" involontaires ».
         Deux clics dans une grille ne disent pas combien de jours on vient de choisir ;
         un rapport lancé sur 31 jours au lieu de 7 ne se voit qu'à l'arrivée, quand il
         est trop tard pour le rattraper. -->
    @if (totalSelection(); as total) {
      <p class="drp-total" role="status">{{ total }}</p>
    }
  `,
  styles: [`
    :host { display: block; }

    .drp-raccourcis { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .drp-rac {
      min-height: 32px; padding: 6px 12px;
      font: inherit; font-size: 12px; font-weight: 600;
      border-radius: 8px; cursor: pointer;
      background: var(--bg-quaternary);
      color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
    }
    .drp-rac:hover { color: var(--fg-primary); }
    .drp-rac--actif {
      background: color-mix(in srgb, var(--texte-succes) 14%, transparent);
      color: var(--texte-succes);
      border-color: color-mix(in srgb, var(--texte-succes) 30%, transparent);
    }

    .drp-total {
      margin: 10px 0 0;
      font-size: 12px; font-weight: 600;
      color: var(--fg-secondary);
      text-align: center;
    }
    .drp-root {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 4px 2px;
    }
    .drp-month { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .drp-header {
      display: grid; grid-template-columns: 24px 1fr 24px;
      align-items: center; gap: 4px;
    }
    .drp-month-label {
      text-align: center;
      font-size: 12px; font-weight: 700; letter-spacing: .02em;
      color: var(--fg-primary);
      text-transform: capitalize;
    }
    .drp-nav {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px;
      border-radius: 6px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--fg-tertiary);
      cursor: pointer;
      transition: background .12s, color .12s, border-color .12s;
    }
    .drp-nav:hover {
      background: var(--bg-tertiary);
      color: var(--fg-primary);
      border-color: var(--border-subtle);
    }
    .drp-nav:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--tracky-light) 60%, transparent);
      outline-offset: 1px;
    }
    .drp-nav-spacer { width: 24px; height: 24px; }
    .drp-weekdays {
      display: grid; grid-template-columns: repeat(7, 1fr);
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      color: var(--fg-tertiary); text-align: center;
      letter-spacing: .04em;
    }
    .drp-weekdays span { padding: 2px 0; }
    .drp-cells {
      display: grid; grid-template-columns: repeat(7, 1fr);
      gap: 2px;
    }
    .drp-cell {
      height: 28px; min-width: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 500;
      color: var(--fg-secondary);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      transition: background .12s, color .12s, border-color .12s;
      padding: 0;
    }
    .drp-cell:hover:not(:disabled):not(.drp-cell--start):not(.drp-cell--end) {
      background: var(--bg-tertiary);
      color: var(--fg-primary);
    }
    .drp-cell:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--tracky-light) 70%, transparent);
      outline-offset: 1px;
      z-index: 1;
    }
    .drp-cell--outside { color: var(--fg-tertiary); opacity: .55; }
    .drp-cell--today {
      border-color: color-mix(in srgb, var(--tracky-light) 60%, transparent);
    }
    .drp-cell--in-range,
    .drp-cell--preview {
      background: color-mix(in srgb, var(--tracky) 15%, transparent);
      color: var(--fg-primary);
      border-radius: 0;
    }
    .drp-cell--preview { background: color-mix(in srgb, var(--tracky) 8%, transparent); }
    .drp-cell--start, .drp-cell--end {
      background: var(--tracky);
      color: white !important;
      font-weight: 700;
      border-color: transparent;
    }
    .drp-cell--start { border-top-right-radius: 0; border-bottom-right-radius: 0; }
    .drp-cell--end   { border-top-left-radius: 0;  border-bottom-left-radius: 0; }
    .drp-cell--start.drp-cell--end { border-radius: 6px; }
    .drp-cell:disabled {
      opacity: .3;
      cursor: not-allowed;
      background: transparent;
      color: var(--fg-tertiary);
    }
    .drp-cell:disabled:hover { background: transparent; color: var(--fg-tertiary); }

    @media (max-width: 767px) {
      .drp-root { grid-template-columns: 1fr; gap: 12px; }
    }
  `],
})
export class DateRangePickerComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly from = input<string>('');
  readonly to = input<string>('');
  readonly max = input<string>('');
  readonly min = input<string>('');
  /** Affiche la rangée de raccourcis au-dessus de la grille. */
  readonly raccourcis = input<boolean>(true);

  readonly fromChange = output<string>();
  readonly toChange = output<string>();
  readonly rangeChange = output<{ from: string; to: string }>();

  protected readonly ChevronLeft = ChevronLeft;
  protected readonly ChevronRight = ChevronRight;

  protected readonly weekdayLabels = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  /**
   * Les quatre périodes qui couvrent l'essentiel des usages. Bornes INCLUSES : « 7
   * jours » se lit comme sept jours affichés, aujourd'hui compris — pas six plus un.
   */
  protected readonly RACCOURCIS = [
    { jours: 7, libelle: '7 jours' },
    { jours: 14, libelle: '14 jours' },
    { jours: 30, libelle: '30 jours' },
    { jours: 90, libelle: '90 jours' },
  ] as const;

  private readonly today = startOfDay(new Date());

  protected readonly leftMonth = signal<Date>(addMonths(startOfMonth(this.today), -1));
  protected readonly hoverDate = signal<Date | null>(null);
  protected readonly pendingFrom = signal<Date | null>(null);
  protected readonly focusedDate = signal<Date | null>(null);

  private readonly parsedFrom = computed(() => fromIso(this.from()));
  private readonly parsedTo = computed(() => fromIso(this.to()));
  private readonly parsedMax = computed(() => {
    const m = this.max();
    return m ? fromIso(m) : this.today;
  });
  private readonly parsedMin = computed(() => fromIso(this.min()));

  protected readonly months = computed(() => {
    const left = this.leftMonth();
    const right = addMonths(left, 1);
    return [this.buildMonthView(left), this.buildMonthView(right)];
  });

  /**
   * « Du 12 au 18 mars · 7 jours ». Le nombre de jours est la moitié utile : deux clics
   * dans une grille ne le disent pas, et un rapport lancé sur 31 jours au lieu de 7 ne
   * se voit qu'à l'arrivée.
   */
  protected readonly totalSelection = computed(() => {
    const a = this.parsedFrom();
    const b = this.parsedTo();
    if (!a || !b) return null;
    const lo = a <= b ? a : b;
    const hi = a <= b ? b : a;
    // Bornes incluses : du lundi au lundi suivant fait 8 jours, pas 7.
    const jours = Math.round((startOfDay(hi).getTime() - startOfDay(lo).getTime()) / 86_400_000) + 1;
    const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
    return `Du ${fmt.format(lo)} au ${fmt.format(hi)} · ${jours} jour${jours > 1 ? 's' : ''}`;
  });

  /** Le raccourci qui correspond exactement à la sélection courante, s'il y en a un. */
  protected readonly raccourciActif = computed(() => {
    const a = this.parsedFrom();
    const b = this.parsedTo();
    if (!a || !b) return null;
    if (!isSameDay(startOfDay(b), this.today)) return null;
    const jours = Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000) + 1;
    return this.RACCOURCIS.some((r) => r.jours === jours) ? jours : null;
  });

  /**
   * Applique une période qui se termine AUJOURD'HUI. C'est le sens attendu de « 7
   * jours » sur un tableau de bord : les sept derniers, pas une fenêtre glissante
   * autour de la sélection en cours.
   */
  protected appliquerRaccourci(jours: number): void {
    const fin = this.today;
    const debut = addDays(fin, -(jours - 1));
    this.pendingFrom.set(null);
    this.hoverDate.set(null);
    this.leftMonth.set(addMonths(startOfMonth(fin), -1));
    const from = toIso(debut);
    const to = toIso(fin);
    this.fromChange.emit(from);
    this.toChange.emit(to);
    this.rangeChange.emit({ from, to });
  }

  private readonly focusEffect = effect(() => {
    const fd = this.focusedDate();
    if (!fd) return;
    queueMicrotask(() => {
      const iso = toIso(fd);
      const el = this.host.nativeElement.querySelector<HTMLButtonElement>(
        '[data-iso="' + iso + '"]',
      );
      el?.focus();
    });
  });

  private buildMonthView(monthFirst: Date) {
    const monthIdx = monthFirst.getMonth();
    const cells = buildCells(monthFirst);
    const from = this.parsedFrom();
    const to = this.parsedTo();
    const pending = this.pendingFrom();
    const hover = this.hoverDate();
    const max = this.parsedMax();
    const min = this.parsedMin();
    const focused = this.focusedDate();
    const anchor =
      focused ?? from ?? (isInGrid(this.today, cells) ? this.today : monthFirst);

    return {
      key: toIso(monthFirst),
      label: monthLabel(monthFirst),
      cells: cells.map((d) => {
        const inMonth = d.getMonth() === monthIdx;
        const disabled = (max && d > max) || (min && d < min) ? true : false;
        const isStart = !!from && isSameDay(d, from);
        const isEnd = !!to && isSameDay(d, to);
        const inFromTo = !!from && !!to && d > from && d < to;
        const previewEnd = hover ?? focused;
        const inPreview =
          !!pending && !!previewEnd && !isStart && !isEnd && !inFromTo
            ? isBetween(d, pending, previewEnd)
            : false;
        return {
          iso: toIso(d),
          day: d.getDate(),
          aria: ariaLabel(d),
          inMonth,
          isToday: isSameDay(d, this.today),
          isStart,
          isEnd,
          isInRange: inFromTo,
          isPreview: inPreview,
          disabled,
          tabIndex: isSameDay(d, anchor) ? 0 : -1,
          date: d,
        };
      }),
    };
  }

  protected onCellClick(c: { date: Date; disabled: boolean }): void {
    if (c.disabled) return;
    const d = c.date;
    const pending = this.pendingFrom();
    if (!pending) {
      this.pendingFrom.set(d);
      this.fromChange.emit(toIso(d));
      this.toChange.emit(toIso(d));
    } else {
      const ordered: [Date, Date] = d < pending ? [d, pending] : [pending, d];
      this.pendingFrom.set(null);
      this.hoverDate.set(null);
      const fIso = toIso(ordered[0]);
      const tIso = toIso(ordered[1]);
      this.fromChange.emit(fIso);
      this.toChange.emit(tIso);
      this.rangeChange.emit({ from: fIso, to: tIso });
    }
    this.focusedDate.set(d);
  }

  protected onCellHover(c: { date: Date; disabled: boolean }): void {
    if (c.disabled) return;
    this.hoverDate.set(c.date);
  }

  protected onCellFocus(c: { date: Date }): void {
    if (this.focusedDate() && isSameDay(this.focusedDate()!, c.date)) return;
    this.focusedDate.set(c.date);
  }

  protected prevMonth(): void { this.leftMonth.update((d) => addMonths(d, -1)); }
  protected nextMonth(): void { this.leftMonth.update((d) => addMonths(d, +1)); }

  protected onKeydown(ev: KeyboardEvent): void {
    const focused = this.focusedDate() ?? this.parsedFrom() ?? this.today;
    let next: Date | null = null;
    switch (ev.key) {
      case 'ArrowLeft':  next = addDays(focused, -1); break;
      case 'ArrowRight': next = addDays(focused, +1); break;
      case 'ArrowUp':    next = addDays(focused, -7); break;
      case 'ArrowDown':  next = addDays(focused, +7); break;
      case 'Home':       next = startOfWeekMonday(focused); break;
      case 'End':        next = addDays(startOfWeekMonday(focused), 6); break;
      case 'PageUp':     next = addMonths(focused, ev.shiftKey ? -12 : -1); break;
      case 'PageDown':   next = addMonths(focused, ev.shiftKey ? +12 : +1); break;
      case 'Enter':
      case ' ': {
        ev.preventDefault();
        const max = this.parsedMax();
        const min = this.parsedMin();
        if ((max && focused > max) || (min && focused < min)) return;
        this.onCellClick({ date: focused, disabled: false });
        return;
      }
      default: return;
    }
    if (!next) return;
    ev.preventDefault();
    const left = this.leftMonth();
    const right = addMonths(left, 1);
    if (next < left) this.leftMonth.set(addMonths(left, -1));
    else if (next >= addMonths(right, 1)) this.leftMonth.set(addMonths(left, +1));
    this.focusedDate.set(next);
  }
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function startOfWeekMonday(d: Date): Date {
  const dow = d.getDay();
  const offset = (dow + 6) % 7;
  return addDays(d, -offset);
}
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function isBetween(d: Date, a: Date, b: Date): boolean {
  const lo = a <= b ? a : b;
  const hi = a <= b ? b : a;
  return d >= lo && d <= hi;
}
function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function fromIso(iso: string): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function buildCells(monthFirst: Date): Date[] {
  const start = startOfWeekMonday(monthFirst);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(start, i));
  return cells;
}
function isInGrid(d: Date, cells: Date[]): boolean {
  return cells.some((c) => isSameDay(c, d));
}

const monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
const ariaFmt = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
function monthLabel(d: Date): string { return monthFmt.format(d); }
function ariaLabel(d: Date): string { return ariaFmt.format(d); }
