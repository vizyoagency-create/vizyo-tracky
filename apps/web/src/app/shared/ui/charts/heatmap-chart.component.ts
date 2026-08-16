import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';

/**
 * Grille 7 (jours) × 24 (heures). data[d][h] = count d'événements démarrés
 * ce jour de la semaine, à cette heure.
 *
 * Ordre des jours : lundi en haut → dimanche en bas (norme FR/ISO).
 *
 * ─── LES 168 CELLULES DE 10 × 11 PX SONT UNE EXCEPTION ASSUMÉE ──────────────
 *
 * Le critère de recette impose des cibles ≥ 44 px au doigt. Les cellules de
 * cette grille mesurent 10 × 11 et la sonde les signale, à raison : ce sont des
 * `<button>`.
 *
 * **Décision client du 2026-08-14 : on les laisse.** Une cellule à 44 px donnerait
 * une grille de 7 392 px de large — la vue d'ensemble sur 24 h × 7 j, qui est
 * toute la raison d'être de l'objet, disparaîtrait derrière un défilement.
 *
 * Ce n'est pas un renoncement, parce que **le doigt a déjà un chemin** : chaque
 * étiquette de jour (`.hm-day-label`) est une cible de 24 × 44 qui ouvre le détail
 * du jour. Les cellules servent au SURVOL et au focus clavier — elles portent
 * chacune un `aria-label` complet (« Lun 15h, 6 trajets »), donc le contenu reste
 * accessible au lecteur d'écran et à la navigation clavier.
 *
 * ⚠️ Si un jour cette grille devient le SEUL accès à une information, la décision
 * est à revoir : elle tient parce qu'un autre chemin existe.
 */
export type HeatmapMatrix = number[][];

const DAYS_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

interface HoverInfo {
  day: number;
  hour: number;
  count: number;
  /** Position pixel relative au wrapper pour le tooltip. */
  x: number;
  y: number;
}

/**
 * Heatmap 24h × 7j en SVG. Pas de Chart.js : implémentation maison plus
 * légère (~3 KB) et plus contrôlable visuellement (couleurs bin-discrètes
 * tirées du design system).
 *
 * Colonnes 24 (heures 0–23) × lignes 7 (lun → dim). Couleur de cellule =
 * intensité du nombre de trajets démarrés. Hover montre count + label
 * "Lun · 14h · 3 trajets".
 */
@Component({
  selector: 'app-heatmap-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="hm-wrapper" role="img" [attr.aria-label]="ariaLabel()">
      <div class="hm-grid" (pointerleave)="hover.set(null)">
        <!-- Header heures (toutes les 3h pour éviter clutter mobile) -->
        <div class="hm-header">
          <div class="hm-corner"></div>
          @for (h of hoursAxis; track h) {
            <div class="hm-hour-label" [class.hm-hour-label--shown]="h % 3 === 0">
              @if (h % 3 === 0) { {{ h }}h }
            </div>
          }
        </div>
        @for (row of data(); track $index; let dayIdx = $index) {
          <div class="hm-row">
            <!-- LE JOUR EST UN BOUTON — c'est lui, le drill-down (B1 § D).
                 Les 168 cellules ne se lisent qu'au SURVOL, qui n'existe pas au doigt :
                 sur un téléphone, la carte de chaleur était donc un dessin muet. Les
                 agrandir n'était pas la réponse — 168 × 44 px font 7 392 px de large.
                 On ouvre le jour, et ses heures se lisent en toutes lettres. -->
            <button
              type="button"
              class="hm-day-label"
              [class.hm-day-label--ouvert]="jourOuvert() === dayIdx"
              [attr.aria-expanded]="jourOuvert() === dayIdx"
              [attr.aria-label]="'Détail du ' + days[dayIdx]"
              (click)="basculerJour(dayIdx)">{{ days[dayIdx] }}</button>
            @for (count of row; track $index; let hourIdx = $index) {
              <button
                type="button"
                class="hm-cell"
                [style.background]="cellColor(count)"
                [style.--hm-cell-border]="count > 0 ? 'color-mix(in srgb, var(--color-tracky-light) 20%, transparent)' : 'transparent'"
                [attr.aria-label]="ariaLabelCell(dayIdx, hourIdx, count)"
                (pointerenter)="onCellHover($event, dayIdx, hourIdx, count)"
                (focus)="onCellHover($event, dayIdx, hourIdx, count)"
                (blur)="hover.set(null)"
              ></button>
            }
          </div>
          @if (jourOuvert() === dayIdx) {
            <div class="hm-detail" role="status">
              @if (heuresDuJour(dayIdx); as heures) {
                @if (heures.length === 0) {
                  <span class="hm-detail-vide">Aucun trajet ce jour-là.</span>
                } @else {
                  @for (h of heures; track h.heure) {
                    <span class="hm-detail-h">
                      <strong>{{ h.heure }} h</strong> — {{ h.count }} trajet{{ h.count > 1 ? 's' : '' }}
                    </span>
                  }
                }
              }
            </div>
          }
        }
      </div>

      @if (hover(); as h) {
        <div class="hm-tooltip" [style.left.px]="h.x" [style.top.px]="h.y" role="status">
          <strong>{{ days[h.day] }} · {{ h.hour }}h</strong>
          <span>{{ h.count }} trajet{{ h.count > 1 ? 's' : '' }}</span>
        </div>
      }

      <table class="sr-only">
        <caption>{{ ariaLabel() }}</caption>
        <thead>
          <tr>
            <th>Jour</th>
            @for (h of hoursAxis; track h) { <th>{{ h }}h</th> }
          </tr>
        </thead>
        <tbody>
          @for (row of data(); track $index; let i = $index) {
            <tr>
              <th>{{ days[i] }}</th>
              @for (c of row; track $index) { <td>{{ c }}</td> }
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; }
    .hm-wrapper {
      position: relative;
      width: 100%;
      overflow: hidden;
    }
    .hm-grid { display: flex; flex-direction: column; gap: 3px; }
    .hm-header,
    .hm-row {
      display: grid;
      grid-template-columns: 32px repeat(24, minmax(8px, 1fr));
      gap: 3px;
      align-items: center;
    }
    .hm-header { padding-bottom: 2px; }
    .hm-corner { width: 32px; height: 14px; }
    .hm-hour-label {
      font-size: 9px;
      font-weight: 500;
      color: var(--fg-tertiary);
      text-align: center;
      line-height: 14px;
      height: 14px;
      letter-spacing: -0.02em;
    }
    .hm-hour-label--shown { font-weight: 600; }
    .hm-day-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--fg-tertiary);
      text-align: right;
      padding-right: 6px;
      line-height: 1;
      background: none; border: 0; cursor: pointer; font-family: inherit;
    }
    .hm-day-label--ouvert { color: var(--texte-succes); }
    .hm-day-label:hover { color: var(--fg-secondary); }
    /* Le détail d'un jour : les heures en toutes lettres, ce que le survol donnait
       jusqu'ici à la souris seulement. */
    .hm-detail {
      display: flex; flex-wrap: wrap; gap: 4px 12px;
      margin: 4px 0 6px; padding: 8px 10px;
      background: var(--bg-quaternary);
      border-radius: 8px;
      font-size: 11px; line-height: 1.5; color: var(--fg-secondary);
    }
    .hm-detail-h strong { color: var(--fg-primary); font-weight: 700; }
    .hm-detail-vide { color: var(--fg-tertiary); font-style: italic; }

    .hm-cell {
      width: 100%;
      aspect-ratio: 1 / 1;
      min-height: 14px;
      max-height: 28px;
      border-radius: 3px;
      border: 1px solid var(--hm-cell-border, transparent);
      cursor: pointer;
      padding: 0;
      transition: transform .12s ease, outline .12s ease;
      outline: none;
    }
    .hm-cell:hover,
    .hm-cell:focus-visible {
      transform: scale(1.18);
      outline: 2px solid var(--tracky-light);
      outline-offset: 1px;
      z-index: 5;
      position: relative;
    }
    /* Mobile : compacter, masquer les labels d'heures impaires */
    @media (max-width: 640px) {
      .hm-header,
      .hm-row {
        grid-template-columns: 24px repeat(24, minmax(6px, 1fr));
        gap: 2px;
      }
      .hm-corner { width: 24px; }
      /* Au doigt, le jour est la seule prise sur la carte : 44 px. */
      .hm-day-label { font-size: 9px; padding-right: 4px; min-height: 44px; }
      .hm-cell { min-height: 11px; max-height: 22px; border-radius: 2px; }
      .hm-hour-label { font-size: 8px; }
    }
    .hm-tooltip {
      position: absolute;
      transform: translate(-50%, calc(-100% - 10px));
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 6px 10px;
      pointer-events: none;
      box-shadow: 0 6px 20px rgba(0,0,0,.4);
      display: flex;
      flex-direction: column;
      gap: 2px;
      z-index: 10;
      white-space: nowrap;
    }
    .hm-tooltip strong { font-size: 12px; color: var(--fg-primary); font-weight: 700; }
    .hm-tooltip span { font-size: 11px; color: var(--fg-secondary); }
    .sr-only {
      position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `],
})
export class HeatmapChartComponent {
  /** Matrice 7×24. data[dayIdx][hourIdx] = count. dayIdx 0=Lun … 6=Dim. */
  readonly data = input.required<HeatmapMatrix>();

  protected readonly days = DAYS_FR;
  protected readonly hoursAxis = Array.from({ length: 24 }, (_, i) => i);
  protected readonly hover = signal<HoverInfo | null>(null);
  /**
   * Le jour dont on a demandé le détail. `null` = aucun. C'est le drill-down du doigt :
   * le survol, seul moyen de lire une cellule jusqu'ici, n'existe pas sur un écran
   * tactile — la carte de chaleur y était un dessin muet.
   */
  protected readonly jourOuvert = signal<number | null>(null);

  protected basculerJour(jour: number): void {
    this.jourOuvert.update((courant) => (courant === jour ? null : jour));
  }

  /** Les heures NON VIDES d'un jour. Lister les 24 noierait les trois qui comptent. */
  protected heuresDuJour(jour: number): { heure: number; count: number }[] {
    const ligne = this.data()[jour] ?? [];
    return ligne
      .map((count, heure) => ({ heure, count }))
      .filter((h) => h.count > 0);
  }

  /** Max sur l'ensemble pour normaliser l'intensité de couleur. */
  private readonly maxCount = computed(() => {
    let m = 0;
    for (const row of this.data()) {
      for (const c of row) if (c > m) m = c;
    }
    return m;
  });

  protected readonly ariaLabel = computed(() => {
    let total = 0;
    for (const row of this.data()) for (const c of row) total += c;
    // ⚠️ « sur les données affichées », et non « sur la période ». Ce composant ne SAIT
    // pas quelle période l'appelant couvre : il reçoit une grille déjà calculée. Sur
    // l'écran Rapports, elle vient d'un échantillon de 100 trajets, et l'ancienne
    // formulation affirmait donc au lecteur d'écran quelque chose de faux — le titre
    // visible, lui, avait été corrigé. Un composant ne doit pas parler d'un contexte
    // qu'il ne connaît pas : c'est à l'appelant de nommer sa période.
    return `Heatmap fréquentation 24h × 7j : ${total} trajets sur les données affichées, pic ${this.maxCount()} trajets sur une plage horaire.`;
  });

  protected ariaLabelCell(day: number, hour: number, count: number): string {
    return `${this.days[day]} ${hour}h, ${count} trajet${count > 1 ? 's' : ''}`;
  }

  /**
   * Couleur de cellule. 0 = bg neutre. Sinon échelle 4 paliers en alpha sur
   * --tracky-light (#10E0A0). On lit pas le CSS var ici parce qu'on veut un
   * dégradé alpha bien net que getComputedStyle ne donne pas trivialement
   * — on reste en hex avec alpha CSS rgba(), ce qui marche pareil dark/light.
   */
  protected cellColor(count: number): string {
    if (count <= 0) return 'rgba(255,255,255,.025)';
    const m = this.maxCount();
    if (m === 0) return 'rgba(255,255,255,.025)';
    const ratio = count / m;
    // 4 paliers visuels : 0.18, 0.36, 0.6, 0.85
    let alpha = 0.18;
    if (ratio > 0.25) alpha = 0.36;
    if (ratio > 0.5) alpha = 0.60;
    if (ratio > 0.75) alpha = 0.85;
    return `rgba(16, 224, 160, ${alpha})`;
  }

  protected onCellHover(ev: Event, day: number, hour: number, count: number): void {
    const target = ev.currentTarget as HTMLElement | null;
    if (!target) return;
    // wrapper relatif = 2 parents au-dessus (.hm-row > .hm-grid > .hm-wrapper)
    const wrapper = target.closest('.hm-wrapper') as HTMLElement | null;
    if (!wrapper) return;
    const cellRect = target.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    this.hover.set({
      day,
      hour,
      count,
      x: cellRect.left - wrapperRect.left + cellRect.width / 2,
      y: cellRect.top - wrapperRect.top,
    });
  }
}
