import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { LucideAngularModule, Calendar, ChevronLeft, ChevronRight, Check } from 'lucide-angular';

/* ── Helpers de date natifs, heure LOCALE (self-contained : un composant partagé
   ne doit pas dépendre d'une feature). ────────────────────────────────────── */
function startOfMonthOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function startOfWeekMonday(d: Date): Date {
  return addDays(d, -((d.getDay() + 6) % 7));
}
/** YYYY-MM-DD en heure locale (pas d'UTC → pas de décalage d'un jour). */
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
/** 42 cellules (6 semaines) à partir du lundi de la 1re semaine du mois. */
function monthCells(monthFirst: Date): Date[] {
  const start = startOfWeekMonday(monthFirst);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

interface DayCell {
  iso: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  inRange: boolean;
  isStart: boolean;
  isEnd: boolean;
}

/**
 * Sélecteur de plage date + heures, aux couleurs du DS (remplace les deux
 * `datetime-local` natifs, moches et hors-thème). Un seul champ qui pilote
 * **début** et **fin** :
 *
 *  - 1 clic sur un jour → créneau sur ce jour (début = fin) ; un 2e clic sur un
 *    jour ultérieur étend en plage multi-jours. Un clic sur un jour antérieur
 *    repart de zéro.
 *  - Heures « Début → Fin » réglées juste sous le calendrier.
 *  - Panneau **en ligne** (déplié sous le champ) : jamais rogné par l'overflow
 *    du bottom-sheet, contrairement à un overlay positionné.
 *
 * Entrées / sorties au format `datetime-local` (`YYYY-MM-DDTHH:mm`) pour un
 * branchement direct sur les signaux existants du parent.
 */
@Component({
  selector: 'app-datetime-range',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    <div class="dtr">
      <button type="button" class="dtr-field" [class.dtr-field--open]="open()" (click)="toggle()">
        <lucide-icon [img]="CalendarIcon" [size]="15" class="dtr-field-ic"></lucide-icon>
        <span class="dtr-field-txt" [class.dtr-field-txt--ph]="!startDayIso()">{{ summary() }}</span>
        <lucide-icon [img]="ChevronRightIcon" [size]="16" class="dtr-caret" [class.dtr-caret--open]="open()"></lucide-icon>
      </button>

      @if (open()) {
        <div class="dtr-panel" #panel>
          <div class="dtr-cal-head">
            <button type="button" class="dtr-nav" (click)="prevMonth()" aria-label="Mois précédent"><lucide-icon [img]="ChevronLeftIcon" [size]="16"></lucide-icon></button>
            <span class="dtr-month">{{ monthLabel() }}</span>
            <button type="button" class="dtr-nav" (click)="nextMonth()" aria-label="Mois suivant"><lucide-icon [img]="ChevronRightIcon" [size]="16"></lucide-icon></button>
          </div>

          <div class="dtr-wd" aria-hidden="true">
            @for (w of weekdays; track $index) { <span>{{ w }}</span> }
          </div>

          <div class="dtr-grid" role="grid">
            @for (c of cells(); track c.iso) {
              <button
                type="button"
                role="gridcell"
                class="dtr-day"
                [class.dtr-day--out]="!c.inMonth"
                [class.dtr-day--today]="c.isToday"
                [class.dtr-day--range]="c.inRange"
                [class.dtr-day--start]="c.isStart"
                [class.dtr-day--end]="c.isEnd"
                [attr.aria-label]="c.iso"
                (click)="pickDay(c.iso)">
                <span>{{ c.day }}</span>
              </button>
            }
          </div>

          <div class="dtr-times">
            <label class="dtr-time"><span>Début</span><input type="time" [value]="startTime()" (input)="setStartTime($any($event.target).value)"></label>
            <span class="dtr-arrow" aria-hidden="true">→</span>
            <label class="dtr-time"><span>Fin</span><input type="time" [value]="endTime()" (input)="setEndTime($any($event.target).value)"></label>
          </div>

          @if (invalid()) { <p class="dtr-warn">La fin doit être après le début.</p> }

          <div class="dtr-foot">
            <button type="button" class="dtr-today" (click)="today()">Aujourd'hui</button>
            <button type="button" class="dtr-done" (click)="open.set(false)"><lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon> Terminé</button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dtr { position: relative; }

    /* Champ-déclencheur : ressemble à un input, résume le créneau choisi. */
    .dtr-field {
      width: 100%; display: flex; align-items: center; gap: 9px;
      padding: 10px 11px; border-radius: 10px;
      background: var(--bg-secondary); border: 1px solid var(--border-strong);
      color: var(--fg-primary); font-size: 15px; cursor: pointer; text-align: left;
      transition: border-color .15s, box-shadow .15s;
    }
    .dtr-field:hover { border-color: var(--tracky-light); }
    .dtr-field--open { border-color: var(--tracky-light); box-shadow: 0 0 0 3px rgba(16,224,160,.14); }
    .dtr-field-ic { color: var(--tracky-light); flex-shrink: 0; }
    .dtr-field-txt { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dtr-field-txt--ph { color: var(--fg-tertiary); font-weight: 500; }
    .dtr-caret { color: var(--fg-tertiary); flex-shrink: 0; transition: transform .2s; }
    .dtr-caret--open { transform: rotate(90deg); }

    /* Panneau déplié en ligne (pas d'overlay → jamais rogné par le sheet). */
    .dtr-panel {
      margin-top: 8px; padding: 12px;
      max-width: 360px;
      background: var(--bg-secondary); border: 1px solid var(--border-strong);
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0,0,0,.18);
      animation: dtr-in .14s ease;
    }
    @keyframes dtr-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

    .dtr-cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .dtr-month { font-size: 13px; font-weight: 700; color: var(--fg-primary); text-transform: capitalize; }
    .dtr-nav {
      width: 30px; height: 30px; border-radius: 8px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--fg-secondary); transition: background .12s, color .12s;
    }
    .dtr-nav:hover { background: var(--bg-tertiary); color: var(--fg-primary); }

    .dtr-wd { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin-bottom: 4px; }
    .dtr-wd span { text-align: center; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }

    .dtr-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px 0; }
    .dtr-day {
      position: relative; height: 38px; border-radius: 9px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 600; color: var(--fg-secondary);
      cursor: pointer; transition: background .12s, color .12s;
    }
    .dtr-day:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .dtr-day--out { color: var(--fg-tertiary); opacity: .4; }
    .dtr-day--today::after {
      content: ''; position: absolute; bottom: 5px; left: 50%; transform: translateX(-50%);
      width: 4px; height: 4px; border-radius: 50%; background: var(--tracky-light);
    }
    /* Bande de plage (jours entre début et fin). */
    .dtr-day--range { background: color-mix(in srgb, var(--tracky-light) 15%, transparent); border-radius: 0; color: var(--fg-primary); }
    /* Bornes de la plage : pastille pleine accent. */
    .dtr-day--start, .dtr-day--end {
      background: var(--tracky-light); color: var(--accent-ink, #04130D); font-weight: 800;
    }
    .dtr-day--start { border-radius: 9px 0 0 9px; }
    .dtr-day--end { border-radius: 0 9px 9px 0; }
    .dtr-day--start.dtr-day--end { border-radius: 9px; }
    .dtr-day--start::after, .dtr-day--end::after { display: none; }

    /* Heures début → fin. */
    .dtr-times { display: flex; align-items: flex-end; gap: 10px; margin-top: 14px; }
    .dtr-time { flex: 1; display: flex; flex-direction: column; gap: 5px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .dtr-time input {
      width: 100%; padding: 9px 10px; border-radius: 9px;
      background: var(--bg-tertiary); border: 1px solid var(--border-strong);
      color: var(--fg-primary); font-size: 15px; font-variant-numeric: tabular-nums;
    }
    .dtr-time input:focus { outline: none; border-color: var(--tracky-light); }
    .dtr-arrow { padding-bottom: 9px; color: var(--fg-tertiary); font-size: 15px; font-weight: 700; }

    .dtr-warn { margin: 9px 0 0; font-size: 11.5px; font-weight: 600; color: var(--danger, #EF4444); }

    .dtr-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--border-subtle); }
    .dtr-today { font-size: 12.5px; font-weight: 700; color: var(--tracky-light); padding: 4px 2px; }
    .dtr-today:hover { text-decoration: underline; }
    .dtr-done { display: inline-flex; align-items: center; gap: 5px; padding: 8px 15px; border-radius: 9px; background: var(--tracky-light); color: var(--accent-ink, #04130D); font-size: 12.5px; font-weight: 800; }

    /* Dark : traits renforcés (les bordures à 8 % blanc sont quasi invisibles). */
    :host-context([data-theme='dark']) .dtr-field,
    :host-context([data-theme='dark']) .dtr-panel,
    :host-context([data-theme='dark']) .dtr-time input { border-color: rgba(255,255,255,.15); }
    :host-context([data-theme='dark']) .dtr-time input { color-scheme: dark; }
    :host-context([data-theme='dark']) .dtr-foot { border-top-color: rgba(255,255,255,.10); }
  `],
})
export class DateTimeRangePickerComponent {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  /** Début / fin au format `YYYY-MM-DDTHH:mm` (datetime-local). */
  readonly start = input<string>('');
  readonly end = input<string>('');
  readonly startChange = output<string>();
  readonly endChange = output<string>();

  protected readonly CalendarIcon = Calendar;
  protected readonly ChevronLeftIcon = ChevronLeft;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly CheckIcon = Check;

  protected readonly weekdays = ['Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa', 'Di'];

  protected readonly open = signal(false);
  protected readonly viewMonth = signal<Date>(startOfMonthOf(new Date()));

  // État interne en chaînes → égalité par valeur (pas de boucle avec les entrées).
  protected readonly startDayIso = signal(''); // YYYY-MM-DD
  protected readonly endDayIso = signal('');
  protected readonly startTime = signal('09:00'); // HH:mm
  protected readonly endTime = signal('10:00');
  /** 'idle' = prochain clic pose le début ; 'extending' = prochain clic étend la fin. */
  private phase: 'idle' | 'extending' = 'idle';

  private readonly dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  private readonly dayShortFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  private readonly monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

  constructor() {
    // Synchro ENTRANTE : (ré)initialise l'état depuis les entrées (ex. reset à l'ouverture
    // du sheet). `untracked` sur les écritures → l'effet ne dépend que de start()/end().
    effect(() => {
      const s = this.start();
      const e = this.end();
      untracked(() => {
        const sp = this.parse(s);
        const ep = this.parse(e);
        if (sp) { this.startDayIso.set(sp.day); this.startTime.set(sp.time); }
        if (ep) { this.endDayIso.set(ep.day); this.endTime.set(ep.time); }
        if (sp) {
          const m = startOfMonthOf(new Date(`${sp.day}T00:00:00`));
          if (!this.sameMonth(this.viewMonth(), m)) this.viewMonth.set(m);
        }
        // NB : ne PAS toucher `phase` ici — la synchro se déclenche aussi après
        // notre propre emit (aller-retour par le parent) ; la remettre à 'idle'
        // casserait la sélection de plage en 2 clics. Reset uniquement à l'ouverture.
      });
    });

    // À l'ouverture du panneau : le faire défiler dans la vue (le sheet peut scroller).
    effect(() => {
      if (!this.open()) return;
      const el = this.panel()?.nativeElement;
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  protected readonly monthLabel = computed(() => this.monthFmt.format(this.viewMonth()));

  protected readonly cells = computed<DayCell[]>(() => {
    const month = this.viewMonth();
    const monthIdx = month.getMonth();
    const sIso = this.startDayIso();
    const eIso = this.endDayIso();
    const lo = sIso && eIso ? (sIso <= eIso ? sIso : eIso) : '';
    const hi = sIso && eIso ? (sIso <= eIso ? eIso : sIso) : '';
    const today = new Date();
    return monthCells(startOfMonthOf(month)).map((d) => {
      const iso = localIso(d);
      return {
        iso,
        day: d.getDate(),
        inMonth: d.getMonth() === monthIdx,
        isToday: isSameDay(d, today),
        inRange: !!lo && iso >= lo && iso <= hi,
        isStart: iso === sIso,
        isEnd: iso === eIso,
      };
    });
  });

  /** Résumé affiché dans le champ. */
  protected readonly summary = computed(() => {
    const s = this.startDayIso();
    const e = this.endDayIso();
    if (!s) return 'Choisir un créneau';
    const st = this.startTime();
    const et = this.endTime();
    if (s === e) return `${this.fmtLong(s)} · ${st} → ${et}`;
    return `${this.fmtShort(s)} ${st} → ${this.fmtShort(e)} ${et}`;
  });

  /** Créneau invalide (fin ≤ début) — avertit sans bloquer (le parent revalide). */
  protected readonly invalid = computed(() => {
    const s = this.startDayIso();
    const e = this.endDayIso();
    if (!s || !e) return false;
    return `${e}T${this.endTime()}` <= `${s}T${this.startTime()}`;
  });

  protected toggle(): void {
    const willOpen = !this.open();
    this.open.set(willOpen);
    if (willOpen) this.phase = 'idle'; // chaque ouverture repart sur un 1er clic « neuf »
  }
  protected prevMonth(): void { this.viewMonth.set(addMonths(this.viewMonth(), -1)); }
  protected nextMonth(): void { this.viewMonth.set(addMonths(this.viewMonth(), 1)); }

  protected pickDay(iso: string): void {
    if (this.phase === 'idle') {
      this.startDayIso.set(iso);
      this.endDayIso.set(iso);
      this.phase = 'extending';
    } else {
      const s = this.startDayIso();
      if (iso >= s) {
        this.endDayIso.set(iso);
        this.phase = 'idle';
      } else {
        this.startDayIso.set(iso);
        this.endDayIso.set(iso);
        this.phase = 'extending';
      }
    }
    this.emit();
  }

  protected setStartTime(v: string): void { this.startTime.set(v || '00:00'); this.emit(); }
  protected setEndTime(v: string): void { this.endTime.set(v || '00:00'); this.emit(); }

  protected today(): void {
    const iso = localIso(new Date());
    this.startDayIso.set(iso);
    this.endDayIso.set(iso);
    this.phase = 'idle';
    this.viewMonth.set(startOfMonthOf(new Date()));
    this.emit();
  }

  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (!this.open()) return;
    if (!this.host.nativeElement.contains(ev.target as Node)) this.open.set(false);
  }

  private emit(): void {
    const s = this.startDayIso();
    const e = this.endDayIso();
    if (s) this.startChange.emit(`${s}T${this.startTime()}`);
    if (e) this.endChange.emit(`${e}T${this.endTime()}`);
  }

  private parse(v: string): { day: string; time: string } | null {
    if (!v || v.length < 16) return null;
    return { day: v.slice(0, 10), time: v.slice(11, 16) };
  }
  private sameMonth(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }
  private fmtLong(iso: string): string { return this.dayFmt.format(new Date(`${iso}T00:00:00`)); }
  private fmtShort(iso: string): string { return this.dayShortFmt.format(new Date(`${iso}T00:00:00`)); }
}
