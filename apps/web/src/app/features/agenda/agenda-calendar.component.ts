import { ChangeDetectionStrategy, Component, computed, HostListener, input, output, signal } from '@angular/core';
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
  /**
   * Peut-on la saisir et la poser ailleurs ?
   *
   * ⚠️ UNE MISSION NE L'EST JAMAIS, même pour un compte qui gère l'agenda. Elle vit dans cette
   * grille pour qu'un gestionnaire ne double-réserve pas (A2 § 3.1), mais elle appartient à
   * l'espace dépôt et se négocie avec un tiers : la déplacer d'un geste depuis le calendrier
   * déplacerait un engagement pris avec quelqu'un d'autre.
   */
  deplacable: boolean;
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
  /** Lot 3a — nb de PROPOSITIONS de l'agent en attente ce jour (réservations fantômes). */
  proposals: number;
}

const MAX_PILLS = 3;
const weekdayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/**
 * UNE ANNULATION DONT LE CRÉNEAU N'A PAS ENCORE COMMENCÉ NE S'AFFICHE PAS.
 *
 * Elle n'aura pas lieu : il n'y a rien à planifier autour, et la montrer barrée encombre le mois
 * sans rien apprendre. Le PASSÉ garde sa trace barrée — là, l'annulation explique un trou dans
 * l'activité, c'est un fait d'histoire.
 *
 * Sans cette borne, la reprise en masse (feuille « Réorganiser ») laissait autant de lignes barrées
 * qu'elle annulait de réservations : 116 d'un coup chez cdef31 le 2026-09-23, étalées sur les deux
 * semaines à venir. L'outil censé désencombrer l'agenda le rendait moins lisible qu'avant.
 *
 * ⚠️ On borne sur le DÉBUT, pas sur la fin : une réservation annulée qui a déjà commencé a bien
 * occupé son véhicule un moment, et ce trou-là mérite d'être visible.
 */
/**
 * CE QU'ON A LE DROIT DE SAISIR ET DE POSER AILLEURS.
 *
 * Extrait du composant pour être éprouvable : c'est la règle la plus lourde de conséquences du
 * glisser-déposer, puisqu'elle décide seule si un geste d'un demi-seconde peut déplacer un
 * engagement.
 *
 * ⚠️ UNE MISSION N'EST JAMAIS DÉPLAÇABLE, même par un compte qui gère l'agenda. Elle vit dans
 * cette grille pour qu'un gestionnaire ne double-réserve pas (A2 § 3.1), mais elle appartient à
 * l'espace dépôt et engage un TIERS : la faire glisser depuis le calendrier déplacerait un
 * rendez-vous pris avec quelqu'un d'autre, sans que personne d'autre ne soit prévenu.
 *
 * ⚠️ Une RÉSERVATION relève de `reservations_manage`, pas d'`agenda_manage` : déplacer une
 * réservation, c'est la même autorité que la valider. Un compte qui peut poser une maintenance
 * ne peut pas pour autant bouger la voiture que quelqu'un a réservée.
 */
export function peutEtreDeplace(
  ev: Pick<VehicleEventDto, 'type' | 'status'>,
  permissions: { agenda: boolean; reservations: boolean },
): boolean {
  if (ev.status === 'DONE' || ev.status === 'CANCELLED') return false;
  if (ev.type === 'MISSION') return false;
  return ev.type === 'RESERVATION' ? permissions.reservations : permissions.agenda;
}

export function annulationSansObjet(
  ev: { status?: string | null; startAt: string },
  maintenantMs: number = Date.now(),
): boolean {
  if (ev.status !== 'CANCELLED') return false;
  const debut = new Date(ev.startAt).getTime();
  if (Number.isNaN(debut)) return false;
  return debut > maintenantMs;
}

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
            [class.cal-cell--cible]="cibleIso() === c.iso && enDeplacement()"
            [attr.data-jour]="c.iso"
            [attr.aria-label]="c.aria + (c.count ? ' — ' + c.count + ' événement(s)' : '')"
            (click)="cliquerJour(c.iso)">
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
                <span class="cal-pill"
                      [class.cal-pill--muted]="p.muted"
                      [class.cal-pill--saisissable]="p.deplacable"
                      [class.cal-pill--prise]="enDeplacement() === p.id"
                      [style.--pill]="p.color"
                      [title]="p.deplacable ? p.label + ' — glissez-la sur un autre jour pour la déplacer' : p.label"
                      (pointerdown)="debuterSaisie($event, p, c.iso)">
                  <span class="cal-pill-text">{{ p.label }}</span>
                </span>
              }
              @if (c.overflow > 0) {
                <span class="cal-more">+{{ c.overflow }}</span>
              }
              <!-- Lot 3a — les propositions de l'agent. Contour POINTILLÉ et fond transparent :
                   elles se lisent d'un coup d'œil comme « prévu, pas réservé ». -->
              @if (c.proposals > 0) {
                <span class="cal-pill cal-pill--fantome"
                      [attr.title]="c.proposals + ' proposition(s) de l’agent à valider — aucun véhicule n’est bloqué'">
                  <span class="cal-pill-text">{{ c.proposals }} proposé{{ c.proposals > 1 ? 's' : '' }}</span>
                </span>
              }
            </span>
            <!-- Mobile compact : pastilles colorées (les pilules texte sont masquées en CSS) -->
            @if (c.count > 0 || c.proposals > 0) {
              <span class="cal-dots" aria-hidden="true">
                @for (p of c.pills; track p.id) {
                  <span class="cal-dot" [style.background]="p.color"></span>
                }
                @if (c.overflow > 0) { <span class="cal-dot cal-dot--more"></span> }
                <!-- Point CREUX = proposition. Le plein dit « réservé », le creux « prévu ». -->
                @if (c.proposals > 0) { <span class="cal-dot cal-dot--fantome"></span> }
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

      <!-- Ce qu'on tient. Sans cette étiquette, un glissement au doigt est aveugle : le pouce
           cache la pilule d'origine et rien ne dit ce qu'on est en train de poser. -->
      @if (etiquette(); as e) {
        <div class="cal-fantome" aria-hidden="true"
             [style.left.px]="e.x" [style.top.px]="e.y">{{ e.texte }}</div>
      }
    </div>
  `,
  styles: [`
    /* ── Glisser-déposer ──────────────────────────────────────────────────────────────
       « touch-action: none » UNIQUEMENT sur les pilules saisissables : posé sur la cellule,
       il tuerait le défilement du mois au doigt. Posé ici, il n'empêche que le défilement
       qui démarrerait sur une pilule — et celui-là, on le veut pour l'appui long. */
    .cal-pill--saisissable { cursor: grab; touch-action: none; }
    .cal-pill--saisissable:active { cursor: grabbing; }
    .cal-pill--prise { opacity: .35; outline: 2px dashed var(--tracky-light); outline-offset: 1px; }
    /* Le jour visé. Un liseré franc, pas un simple survol : on doit savoir où ça va tomber. */
    .cal-cell--cible {
      border-color: var(--tracky-light) !important;
      box-shadow: inset 0 0 0 2px var(--tracky-light);
      background: color-mix(in srgb, var(--tracky-light) 10%, transparent);
    }
    .cal-fantome {
      position: fixed; z-index: 60; pointer-events: none;
      transform: translate(10px, -50%);
      max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 5px 10px; border-radius: 8px;
      background: var(--bg-secondary); border: 1px solid var(--tracky-light);
      color: var(--fg-primary); font-size: 12px; font-weight: 700;
      box-shadow: 0 6px 18px rgb(0 0 0 / .28);
    }

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
    /* Le numero du jour courant est du TEXTE : meme convention que l'etat actif
       d'un segment (styles.css) — --texte-succes, pas le vert de marque (3,24:1). */
    .cal-cell--today .cal-cell-day { color: var(--texte-succes); }
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
      /* Lavis a 14 % et non 16 : le jeton alerte tombe sous 4,5:1 au-dela (verif:contraste). */
      color: var(--pill, var(--texte-succes));
      background: color-mix(in srgb, var(--pill, var(--texte-succes)) 14%, transparent);
      border-left: 2px solid var(--pill, var(--texte-succes));
    }
    /* ── Lot 3a — la réservation FANTÔME ──────────────────────────────────────
       Contour pointillé, fond transparent, encre violette : la même famille que la
       couche « usage prévu » (~N), parce que c'est la même nature d'information —
       quelque chose d'attendu, pas quelque chose d'acté. La pilule pleine reste
       réservée à ce qui BLOQUE réellement un véhicule. */
    .cal-pill--fantome {
      color: var(--texte-violet);
      background: transparent;
      border: 1px dashed color-mix(in srgb, var(--violet) 55%, transparent);
      border-left-width: 1px;
      font-weight: 700;
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
      color: var(--texte-violet);
      border: 1px dashed color-mix(in srgb, var(--violet) 45%, transparent);
    }
    /* Pastilles compactes — affichées seulement en mobile (pilules texte masquées). */
    .cal-dots { display: none; gap: 3px; margin-top: auto; }
    .cal-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    /* Point CREUX : la proposition n'est pas une réservation. Bordure et non fond. */
    .cal-dot--fantome {
      background: transparent !important;
      border: 1.5px solid var(--texte-violet);
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
  /**
   * Lot 3a — nb de PROPOSITIONS de l'agent en attente ce jour.
   *
   * Rendues en pastille à CONTOUR POINTILLÉ, jamais en pilule pleine : une proposition ne bloque
   * aucun véhicule, et la confondre avec une réservation ferme est exactement l'erreur qui a
   * conduit à pré-prendre 21 véhicules sur 30 chez cdef31.
   */
  readonly proposalsByDay = input<Map<string, number>>(new Map());
  /** Émis avec l'ISO (YYYY-MM-DD) du jour cliqué. */
  readonly dayClick = output<string>();

  /**
   * ── DÉPLACER UN ÉVÉNEMENT EN LE FAISANT GLISSER ────────────────────────────────────────
   *
   * Le calendrier ne connaît pas les permissions : on les lui DONNE, plutôt que de lui faire
   * injecter un service. Il décide alors seul, par type, ce qui est saisissable — une règle,
   * un endroit.
   */
  readonly peutGererAgenda = input(false);
  readonly peutGererReservations = input(false);

  /** Émis quand une pilule est lâchée sur un AUTRE jour. Le parent décide et appelle le serveur. */
  readonly evenementDeplace = output<{ id: string; versIso: string }>();

  protected readonly weekdayLabels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  // ── Glisser-déposer ────────────────────────────────────────────────────────────────────
  //
  // POURQUOI DES « POINTER EVENTS » ET PAS LE GLISSER-DÉPOSER NATIF : `draggable="true"` et
  // `dragstart` n'existent pas au doigt. Un agenda qu'on ne peut réorganiser qu'à la souris
  // rate la moitié des gens qui s'en servent — le standard traverse son dépôt avec un
  // téléphone. Les pointer events couvrent souris, doigt et stylet d'un seul code.
  //
  // ⚠️ AU DOIGT, ON EXIGE UN APPUI LONG. Sans lui, le premier glissement vertical empoignerait
  // une pilule au lieu de faire défiler le mois : le calendrier deviendrait impraticable.

  /** Appui maintenu avant d'armer la saisie au doigt. En dessous, le geste reste un défilement. */
  private static readonly APPUI_LONG_MS = 320;
  /** Déplacement à la souris avant d'armer : en dessous, c'est un clic, pas un glissement. */
  private static readonly SEUIL_SOURIS_PX = 5;

  private saisie: {
    id: string;
    depuisIso: string;
    pointerId: number;
    x0: number;
    y0: number;
    minuteur: ReturnType<typeof setTimeout> | null;
    element: Element;
  } | null = null;

  /** Identifiant de la pilule réellement en cours de déplacement (null = aucune). */
  protected readonly enDeplacement = signal<string | null>(null);
  /** Jour actuellement survolé par le doigt/curseur. */
  protected readonly cibleIso = signal<string | null>(null);
  /** Libellé flottant qui suit le pointeur — c'est lui qui rend le geste lisible. */
  protected readonly etiquette = signal<{ texte: string; x: number; y: number } | null>(null);
  /** Un glissement vient-il d'avoir lieu ? Sert à ne PAS ouvrir le panneau du jour au relâchement. */
  private glissementConsomme = false;

  /**
   * Ce qu'on peut déplacer, et sous quelle permission.
   *
   * Clôturé (DONE) ou annulé : non. Une mission : jamais (voir `CalendarPill.deplacable`).
   * Une réservation relève de `reservations_manage` — la même autorité que la valider ; tout le
   * reste (maintenance, incident) relève d'`agenda_manage`.
   */
  private estDeplacable(ev: VehicleEventDto): boolean {
    return peutEtreDeplace(ev, {
      agenda: this.peutGererAgenda(),
      reservations: this.peutGererReservations(),
    });
  }

  protected debuterSaisie(evt: PointerEvent, p: CalendarPill, iso: string): void {
    if (!p.deplacable || evt.button !== 0) return;
    // On ne coupe PAS la propagation ici : tant que la saisie n'est pas armée, le clic et le
    // défilement doivent continuer de fonctionner normalement.
    const element = evt.currentTarget as Element;
    const armer = () => {
      if (!this.saisie || this.saisie.id !== p.id) return;
      this.saisie.minuteur = null;
      this.enDeplacement.set(p.id);
      this.cibleIso.set(iso);
      this.etiquette.set({ texte: p.label, x: this.saisie.x0, y: this.saisie.y0 });
      try { element.setPointerCapture(evt.pointerId); } catch { /* capture refusée : on suit quand même */ }
    };
    this.saisie = {
      id: p.id, depuisIso: iso, pointerId: evt.pointerId,
      x0: evt.clientX, y0: evt.clientY, element,
      // Souris et stylet : on arme au premier déplacement franc. Doigt : appui long.
      minuteur: evt.pointerType === 'touch'
        ? setTimeout(armer, AgendaCalendarComponent.APPUI_LONG_MS)
        : null,
    };
    this.armerAuSeuil = evt.pointerType !== 'touch' ? armer : null;
  }

  /** Armement différé de la souris : appelé au premier déplacement dépassant le seuil. */
  private armerAuSeuil: (() => void) | null = null;

  @HostListener('document:pointermove', ['$event'])
  protected suivrePointeur(evt: PointerEvent): void {
    const s = this.saisie;
    if (!s || evt.pointerId !== s.pointerId) return;

    if (!this.enDeplacement()) {
      const d = Math.hypot(evt.clientX - s.x0, evt.clientY - s.y0);
      // Le doigt qui bouge AVANT la fin de l'appui long fait défiler : on abandonne la saisie.
      if (s.minuteur && d > 10) { this.annulerSaisie(); return; }
      if (this.armerAuSeuil && d > AgendaCalendarComponent.SEUIL_SOURIS_PX) {
        this.armerAuSeuil();
        this.armerAuSeuil = null;
      }
      if (!this.enDeplacement()) return;
    }

    evt.preventDefault();
    this.etiquette.set({ texte: this.etiquette()?.texte ?? '', x: evt.clientX, y: evt.clientY });
    // `elementFromPoint` reste juste même sous capture de pointeur : c'est la pile visuelle,
    // pas la cible d'événement, qu'on interroge.
    const sous = document.elementFromPoint(evt.clientX, evt.clientY);
    const cellule = sous?.closest('[data-jour]') as HTMLElement | null;
    this.cibleIso.set(cellule?.dataset['jour'] ?? null);
  }

  @HostListener('document:pointerup', ['$event'])
  @HostListener('document:pointercancel', ['$event'])
  protected relacherPointeur(evt: PointerEvent): void {
    const s = this.saisie;
    if (!s || evt.pointerId !== s.pointerId) return;
    const cible = this.cibleIso();
    const aBouge = this.enDeplacement() !== null;
    const id = s.id;
    const depuis = s.depuisIso;
    this.annulerSaisie();
    if (!aBouge) return;
    // Un glissement a eu lieu : on empêche le clic qui suit d'ouvrir le panneau du jour.
    this.glissementConsomme = true;
    if (evt.type === 'pointercancel' || !cible || cible === depuis) return;
    this.evenementDeplace.emit({ id, versIso: cible });
  }

  /** Échap pendant un glissement : on repose la pilule là où elle était. */
  @HostListener('document:keydown.escape')
  protected annulerAuClavier(): void {
    if (this.enDeplacement()) { this.glissementConsomme = true; this.annulerSaisie(); }
  }

  private annulerSaisie(): void {
    const s = this.saisie;
    if (s?.minuteur) clearTimeout(s.minuteur);
    if (s) { try { s.element.releasePointerCapture(s.pointerId); } catch { /* déjà relâchée */ } }
    this.saisie = null;
    this.armerAuSeuil = null;
    this.enDeplacement.set(null);
    this.cibleIso.set(null);
    this.etiquette.set(null);
  }

  /**
   * Le clic sur un jour — sauf s'il clôt un glissement.
   *
   * Sans ce garde, poser une pilule ouvrirait le panneau du jour par-dessus le résultat : on
   * verrait le déplacement disparaître sous une feuille qu'on n'a pas demandée.
   */
  protected cliquerJour(iso: string): void {
    if (this.glissementConsomme) { this.glissementConsomme = false; return; }
    this.dayClick.emit(iso);
  }

  /** Regroupe les événements par jour (clé ISO locale de leur startAt). */
  private readonly eventsByDay = computed(() => {
    const map = new Map<string, VehicleEventDto[]>();
    const maintenant = Date.now();
    for (const ev of this.events()) {
      const d = new Date(ev.startAt);
      if (Number.isNaN(d.getTime())) continue;
      if (annulationSansObjet(ev, maintenant)) continue;
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
    const byProposals = this.proposalsByDay();
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
        deplacable: this.estDeplacable(ev),
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
        proposals: byProposals.get(iso) ?? 0,
      };
    });
  });
}
