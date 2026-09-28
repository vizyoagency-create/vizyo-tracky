import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { LucideAngularModule, CalendarDays, Clock } from 'lucide-angular';

/* ── Helpers de date natifs, heure LOCALE (self-contained : un composant partagé
   ne doit pas dépendre d'une feature). ────────────────────────────────────── */
/** YYYY-MM-DD en heure locale (pas d'UTC → pas de décalage d'un jour). */
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dateDe(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}
function plusJours(iso: string, n: number): string {
  const d = dateDe(iso);
  return localIso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}
function minutesDe(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
function hhmmDe(minutes: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, minutes));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(m / 60))}:${p(m % 60)}`;
}

/**
 * Nombre de jours civils couverts par [debut, fin], bornes comprises (1 = une journée). Une fin
 * avant le début, ou une borne illisible, compte pour 1 : on ne raconte jamais une durée négative.
 */
export function joursCivils(debutIso: string, finIso: string): number {
  if (!debutIso || !finIso) return 1;
  const a = dateDe(debutIso).getTime();
  const b = dateDe(finIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 1;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * La phrase qui résume un créneau, celle que le gestionnaire lit AVANT d'envoyer :
 *  - même jour : « lun. 5 oct. · 09:00 → 17:00 (8 h) » ;
 *  - plusieurs jours : « 3 jours · lun. 5 oct. 09:00 → mer. 7 oct. 17:00 ».
 * Une durée en heures s'écrit « 1 h 30 » ; sous l'heure, « 45 min ».
 */
export function resumeCreneau(
  debutIso: string,
  finIso: string,
  debutHeure: string,
  finHeure: string,
): string {
  if (!debutIso) return 'Choisir un créneau';
  const fmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  const jours = joursCivils(debutIso, finIso || debutIso);
  if (jours === 1) {
    const minutes = minutesDe(finHeure) - minutesDe(debutHeure);
    const duree =
      minutes <= 0
        ? ''
        : minutes < 60
          ? ` (${minutes} min)`
          : minutes % 60 === 0
            ? ` (${minutes / 60} h)`
            : ` (${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')})`;
    return `${fmt.format(dateDe(debutIso))} · ${debutHeure} → ${finHeure}${duree}`;
  }
  return `${jours} jours · ${fmt.format(dateDe(debutIso))} ${debutHeure} → ${fmt.format(dateDe(finIso))} ${finHeure}`;
}

/**
 * Sélecteur de créneau COMPACT (refonte UX du 28/09, points 1 et 10 de la commande).
 *
 * Avant : un champ qui dépliait une grille de 42 jours — « lorsqu'on choisit plusieurs jours, cela
 * ouvre actuellement un grand calendrier ; je veux quelque chose de beaucoup plus compact ». La plage
 * multi-jours existait (deux clics), personne ne la trouvait (F9).
 *
 * Maintenant : **Début (date · heure) → Fin (date · heure)** sur deux champs natifs — le navigateur
 * fournit son propre calendrier, celui que l'utilisateur connaît déjà —, quatre raccourcis pour les
 * cas courants, et UNE ligne de lecture qui dit la durée, les jours et les heures avant d'envoyer.
 *
 * Règle de cohérence : la fin ne passe jamais avant le début. Si le début avance au-delà de la fin,
 * la fin le suit (même jour) ; si, le même jour, l'heure de fin passe sous l'heure de début, elle
 * repart une heure après.
 *
 * Entrées / sorties au format `datetime-local` (`YYYY-MM-DDTHH:mm`), inchangées : la feuille de
 * réservation n'a rien eu à recâbler.
 */
@Component({
  selector: 'app-datetime-range',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    <div class="dtr">
      <div class="dtr-row">
        <div class="dtr-f">
          <span class="dtr-lbl"><lucide-icon [img]="CalendarIcon" [size]="12"></lucide-icon> Début</span>
          <div class="dtr-pair">
            <input type="date" class="dtr-in dtr-in--date" [value]="startDayIso()" [attr.min]="minDay() || null"
                   aria-label="Date de début" (input)="setStartDay($any($event.target).value)">
            <input type="time" class="dtr-in dtr-in--time" [value]="startTime()"
                   aria-label="Heure de début" (input)="setStartTime($any($event.target).value)">
          </div>
        </div>
        <span class="dtr-arrow" aria-hidden="true">→</span>
        <div class="dtr-f">
          <span class="dtr-lbl"><lucide-icon [img]="ClockIcon" [size]="12"></lucide-icon> Fin</span>
          <div class="dtr-pair">
            <input type="date" class="dtr-in dtr-in--date" [value]="endDayIso()" [attr.min]="startDayIso() || minDay() || null"
                   aria-label="Date de fin" (input)="setEndDay($any($event.target).value)">
            <input type="time" class="dtr-in dtr-in--time" [value]="endTime()"
                   aria-label="Heure de fin" (input)="setEndTime($any($event.target).value)">
          </div>
        </div>
      </div>

      <!-- Raccourcis : les cas qui reviennent chaque jour dans une flotte (une demi-journée, une
           journée, prolonger d'un jour ou d'une semaine). Ils RÈGLENT les champs, ils ne les
           remplacent pas : on peut toujours corriger à la main. -->
      <div class="dtr-chips" role="group" aria-label="Raccourcis de créneau">
        <button type="button" class="dtr-chip" [class.dtr-chip--on]="jours() === 1" (click)="memeJour()">Même jour</button>
        <button type="button" class="dtr-chip" (click)="prolonger(1)">+1 jour</button>
        <button type="button" class="dtr-chip" (click)="prolonger(7)">+1 semaine</button>
        <button type="button" class="dtr-chip" (click)="heures('08:00', '12:00')">Matin</button>
        <button type="button" class="dtr-chip" (click)="heures('13:00', '17:00')">Après-midi</button>
        <button type="button" class="dtr-chip" (click)="heures('08:00', '18:00')">Journée</button>
      </div>

      <p class="dtr-sum" [class.dtr-sum--warn]="invalid() || debutPasse()" aria-live="polite">
        @if (invalid()) { La fin doit être après le début. }
        @else if (debutPasse()) { {{ summary() }} — <span class="dtr-sum-note">le début est déjà passé : choisissez une heure à venir.</span> }
        @else { {{ summary() }} }
      </p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .dtr { display: flex; flex-direction: column; gap: 8px; }
    .dtr-row { display: flex; align-items: flex-end; gap: 8px; }
    .dtr-f { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .dtr-lbl { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .dtr-lbl lucide-icon { color: var(--tracky-light); }
    .dtr-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(88px, auto); gap: 6px; }
    .dtr-in {
      width: 100%; min-height: 40px; padding: 8px 9px; border-radius: 9px;
      background: var(--bg-secondary); border: 1px solid var(--border-strong);
      color: var(--fg-primary); font-size: 14px; font-variant-numeric: tabular-nums;
      transition: border-color .15s, box-shadow .15s;
    }
    .dtr-in:focus { outline: none; border-color: var(--tracky-light); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-tracky-light) 14%, transparent); }
    .dtr-arrow { padding-bottom: 11px; color: var(--fg-tertiary); font-size: 15px; font-weight: 700; flex-shrink: 0; }
    .dtr-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .dtr-chip {
      padding: 5px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 700;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary);
      cursor: pointer; transition: all .12s;
    }
    .dtr-chip:hover { color: var(--fg-primary); border-color: var(--border-strong); }
    .dtr-chip--on { color: var(--texte-succes); border-color: color-mix(in srgb, var(--tracky-light) 45%, transparent); background: color-mix(in srgb, var(--tracky-light) 10%, transparent); }
    /* La ligne de lecture : en gras, c'est elle qu'on vérifie avant d'envoyer. */
    .dtr-sum { margin: 0; font-size: 13px; font-weight: 700; color: var(--fg-primary); text-transform: none; letter-spacing: 0; }
    .dtr-sum--warn { color: var(--texte-alerte); }
    .dtr-sum-note { font-weight: 600; }

    /* Téléphone : Début et Fin l'un sous l'autre, la flèche disparaît. */
    @media (max-width: 480px) {
      .dtr-row { flex-direction: column; align-items: stretch; }
      .dtr-arrow { display: none; }
    }

    /* Dark : traits renforcés (les bordures à 8 % blanc sont quasi invisibles) et sélecteurs natifs sombres. */
    :host-context([data-theme='dark']) .dtr-in { border-color: rgba(255,255,255,.15); color-scheme: dark; }
  `],
})
export class DateTimeRangePickerComponent {
  /** Début / fin au format `YYYY-MM-DDTHH:mm` (datetime-local). */
  readonly start = input<string>('');
  readonly end = input<string>('');
  /** Jour minimum sélectionnable (`YYYY-MM-DD`) — les jours antérieurs sont refusés par le champ.
   *  Vide = aucune borne (ex. consignation d'une réservation déjà effectuée). */
  readonly minDay = input<string>('');
  readonly startChange = output<string>();
  readonly endChange = output<string>();

  protected readonly CalendarIcon = CalendarDays;
  protected readonly ClockIcon = Clock;

  // État interne en chaînes → égalité par valeur (pas de boucle avec les entrées).
  protected readonly startDayIso = signal(''); // YYYY-MM-DD
  protected readonly endDayIso = signal('');
  protected readonly startTime = signal('09:00'); // HH:mm
  protected readonly endTime = signal('10:00');

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
      });
    });
  }

  /** Jours civils couverts (1 = même jour). */
  protected readonly jours = computed(() => joursCivils(this.startDayIso(), this.endDayIso() || this.startDayIso()));

  /** Résumé affiché sous les champs. */
  protected readonly summary = computed(() =>
    resumeCreneau(this.startDayIso(), this.endDayIso() || this.startDayIso(), this.startTime(), this.endTime()),
  );

  /**
   * Le début est déjà passé alors qu'une borne existe (`minDay` = aujourd'hui) : un raccourci
   * « Journée » pris le soir met le début à 08:00 du jour même, et le serveur refuse. Dit ICI,
   * sous les champs, avant le clic — pas dans un refus au bout de la feuille.
   */
  protected readonly debutPasse = computed(() => {
    const s = this.startDayIso();
    if (!s || !this.minDay()) return false;
    const debut = new Date(`${s}T${this.startTime()}:00`).getTime();
    return Number.isFinite(debut) && debut < Date.now();
  });

  /** Créneau invalide (fin ≤ début) — avertit sans bloquer (le parent revalide). */
  protected readonly invalid = computed(() => {
    const s = this.startDayIso();
    const e = this.endDayIso();
    if (!s || !e) return false;
    return `${e}T${this.endTime()}` <= `${s}T${this.startTime()}`;
  });

  protected setStartDay(v: string): void {
    if (!v) return;
    const min = this.minDay();
    const jour = min && v < min ? min : v;
    this.startDayIso.set(jour);
    if (!this.endDayIso() || this.endDayIso() < jour) this.endDayIso.set(jour);
    this.recalerFin();
    this.emit();
  }

  protected setEndDay(v: string): void {
    if (!v) return;
    const s = this.startDayIso();
    this.endDayIso.set(s && v < s ? s : v);
    this.recalerFin();
    this.emit();
  }

  protected setStartTime(v: string): void {
    this.startTime.set(v || '00:00');
    this.recalerFin();
    this.emit();
  }

  protected setEndTime(v: string): void {
    this.endTime.set(v || '00:00');
    this.emit();
  }

  /** Raccourci « Même jour » : la fin revient sur le jour du début. */
  protected memeJour(): void {
    if (!this.startDayIso()) return;
    this.endDayIso.set(this.startDayIso());
    this.recalerFin();
    this.emit();
  }

  /** Raccourcis « +1 jour » / « +1 semaine » : la fin avance de n jours (depuis la fin courante). */
  protected prolonger(n: number): void {
    const s = this.startDayIso();
    if (!s) return;
    const base = this.endDayIso() && this.endDayIso() >= s ? this.endDayIso() : s;
    this.endDayIso.set(plusJours(base, n));
    this.emit();
  }

  /** Raccourcis d'heures (matin, après-midi, journée) : ne touchent pas aux jours. */
  protected heures(debut: string, fin: string): void {
    this.startTime.set(debut);
    this.endTime.set(fin);
    if (!this.endDayIso() && this.startDayIso()) this.endDayIso.set(this.startDayIso());
    this.emit();
  }

  /** Même jour et fin ≤ début : la fin repart une heure après le début (bornée à 23:59). */
  private recalerFin(): void {
    if (this.startDayIso() !== this.endDayIso()) return;
    if (minutesDe(this.endTime()) <= minutesDe(this.startTime())) {
      this.endTime.set(hhmmDe(minutesDe(this.startTime()) + 60));
    }
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
}
