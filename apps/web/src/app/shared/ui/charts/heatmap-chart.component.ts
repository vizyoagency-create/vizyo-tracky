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
 * ─── AU DOIGT, LA CIBLE EST LA RANGÉE, PAS LA CELLULE ───────────────────────
 *
 * Le critère de recette impose des cibles ≥ 44 px. Une cellule à 44 px donnerait une
 * grille de 7 392 px de large : la vue d'ensemble 24 h × 7 j — toute la raison d'être
 * de l'objet — disparaîtrait derrière un défilement. Les 168 cellules restent donc des
 * DONNÉES, pas des commandes, et la feuille globale les excepte nommément.
 *
 * La première réponse avait été de faire de l'ÉTIQUETTE DE JOUR la cible tactile, à
 * 44 px de haut. Mesuré à 375 px, le remède était pire que le mal : une rangée de grille
 * prend la hauteur de son plus grand élément, donc sept bandes de 44 px contenant des
 * carrés de 10 × 11 px centrés — une carte de chaleur faite de points séparés de 33 px
 * de vide, et une prise tactile large de 24 px seulement.
 *
 * Deux corrections, pas une :
 *
 *   1. LES CELLULES REMPLISSENT LA RANGÉE (44 px sous 768 px). La carte occupe la même
 *      hauteur qu'avant et redevient un aplat continu, où le motif se lit. Rapetisser
 *      l'étiquette aurait été l'autre voie, mais le critère de recette exige 44 px sur
 *      toute commande et sa sonde n'excepte que `.hm-cell` : on ne descend pas une
 *      cible pour arranger un dessin.
 *   2. LA RANGÉE ENTIÈRE ouvre le détail du jour — 305 × 44 px à 375 px, au lieu d'une
 *      bande de 24 px de large. Sous un pointeur grossier les cellules ne captent plus
 *      le clic (`pointer-events: none`), qui va donc à la rangée.
 *
 * L'étiquette de jour reste un `<button>` : c'est le chemin CLAVIER et LECTEUR D'ÉCRAN
 * vers le même détail. Elle arrête la propagation pour que le geste ne bascule pas deux
 * fois.
 */
export type HeatmapMatrix = number[][];

const DAYS_FR = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

/**
 * Les quatre paliers d'intensité, exprimés en PART D'ACCENT mélangée au fond de carte.
 * Cf. `couleurPalier` pour la raison d'un mélange plutôt qu'une opacité.
 */
const PARTS_PALIERS = ['30%', '50%', '75%', '100%'];

/**
 * Demi-largeur estimée de l'infobulle, pour la garder dans le cadre en 0 h et en 23 h.
 * Une mesure exacte demanderait de rendre l'infobulle avant de la placer ; le contenu
 * est borné (« Lun · 14h » + « 12 trajets »), donc une constante suffit et évite un
 * aller-retour de mise en page à chaque survol.
 */
const DEMI_LARGEUR_INFOBULLE = 68;

interface HoverInfo {
  day: number;
  hour: number;
  count: number;
  /** Position pixel relative au wrapper pour le tooltip. */
  x: number;
  y: number;
  /**
   * Infobulle posée SOUS la cellule. Au-dessus des deux premières rangées, elle se
   * dessinait en dehors du cadre : on n'en voyait qu'un bord.
   */
  dessous: boolean;
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
    <!-- ⚠️ role="group" et NON role="img". Le rôle « img » porte
         « children presentational: true » : les lecteurs d'écran exposent alors
         l'élément comme une image unique nommée par l'aria-label, et IGNORENT tout
         ce qu'il contient — les sept boutons de jour, les 168 cellules et le tableau
         de données ci-dessous, construit exactement pour eux. L'alternative
         accessible existait dans le DOM et n'était jamais lue. -->
    <div class="hm-wrapper" role="group" [attr.aria-label]="ariaLabel()">
      <div class="hm-grid" (pointerleave)="hover.set(null)">
        <!-- Header heures : une sur trois en large, une sur six au doigt (0 · 6 · 12 · 18)
             — à 375 px, une étiquette sur trois retombait à 8 px, sous tout seuil de
             lisibilité. -->
        <div class="hm-header">
          <div class="hm-corner"></div>
          @for (h of hoursAxis; track h) {
            <div class="hm-hour-label"
                 [class.hm-hour-label--shown]="h % 3 === 0"
                 [class.hm-hour-label--jalon]="h % 6 === 0">
              @if (h % 3 === 0) { {{ h }}h }
            </div>
          }
        </div>
        @for (row of data(); track $index; let dayIdx = $index) {
          <!-- LA RANGÉE EST LE DRILL-DOWN (B1 § D). Les 168 cellules ne se lisent qu'au
               SURVOL, qui n'existe pas au doigt : sur un téléphone, la carte de chaleur
               était un dessin muet. Les agrandir n'était pas la réponse — 168 × 44 px
               font 7 392 px de large. On touche le JOUR, sur toute sa largeur, et ses
               heures se lisent en toutes lettres. -->
          <div class="hm-row"
               [class.hm-row--ouvert]="jourOuvert() === dayIdx"
               (click)="basculerJour(dayIdx)">
            <button
              type="button"
              class="hm-day-label"
              [class.hm-day-label--ouvert]="jourOuvert() === dayIdx"
              [attr.aria-expanded]="jourOuvert() === dayIdx"
              [attr.aria-label]="'Détail du ' + days[dayIdx]"
              (click)="$event.stopPropagation(); basculerJour(dayIdx)">{{ days[dayIdx] }}</button>
            @for (count of row; track $index; let hourIdx = $index) {
              <button
                type="button"
                class="hm-cell"
                [style.background]="cellColor(count)"
                [style.--hm-cell-border]="bordureCellule(count)"
                [attr.aria-label]="ariaLabelCell(dayIdx, hourIdx, count)"
                (click)="$event.stopPropagation()"
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

      <!-- L'échelle, absente jusqu'ici : une cellule teintée ne se compare à rien tant
           qu'on ne sait pas ce que « foncé » veut dire. Décorative pour le lecteur
           d'écran, qui dispose du tableau chiffré. -->
      <div class="hm-legende" aria-hidden="true">
        <span class="hm-legende-mot">moins</span>
        @for (p of paliers; track p) {
          <span class="hm-legende-pastille" [style.background]="couleurPalier(p)"></span>
        }
        <span class="hm-legende-mot">plus</span>
      </div>

      @if (hover(); as h) {
        <div class="hm-tooltip"
             [class.hm-tooltip--dessous]="h.dessous"
             [style.left.px]="h.x" [style.top.px]="h.y" role="status">
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
    /* ⚠️ PAS d'overflow: hidden ici. L'infobulle est en position absolue dans ce
       wrapper : la rogner revenait à n'en montrer qu'un bord sur la rangée du lundi
       et à couper la moitié du texte en 0 h et en 23 h. Rien d'autre ne déborde. */
    .hm-wrapper {
      position: relative;
      width: 100%;
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
    .hm-row { cursor: pointer; border-radius: 4px; transition: background .12s ease; }
    .hm-row:hover { background: color-mix(in srgb, var(--tracky) 7%, transparent); }
    .hm-row--ouvert { background: color-mix(in srgb, var(--tracky) 12%, transparent); }
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

    /* ─── Échelle d'intensité ─── */
    .hm-legende {
      display: flex; align-items: center; gap: 4px;
      margin-top: 8px;
      font-size: 11px; color: var(--fg-tertiary);
    }
    .hm-legende-mot { font-weight: 500; }
    .hm-legende-pastille {
      width: 14px; height: 12px; border-radius: 3px;
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 20%, transparent);
    }

    /* ─── LE VIDE ENTRE LES CELLULES, C'ÉTAIT LE DÉFAUT ────────────────────────
     *
     * Sous 768 px, la feuille globale impose 44 px à tout <button> : l'étiquette de
     * jour les prend, et une rangée de grille fait la hauteur de son plus grand
     * élément. Les cellules, elles, restaient bornées à 11–22 px et se centraient au
     * milieu de la bande : sept rangées de 44 px contenant des carrés de 10 × 11,
     * séparés par 33 px de vide. Le motif de chaleur — la raison d'être de l'objet —
     * n'était plus perceptible.
     *
     * La correction n'est pas de rapetisser l'étiquette (le critère de recette exige
     * 44 px sur toute commande, et la sonde n'excepte que la classe .hm-cell) : c'est de faire
     * REMPLIR la rangée par les cellules. La carte occupe la même hauteur qu'avant et
     * redevient un aplat continu. La rangée entière ouvre le détail du jour, ce qui
     * porte la cible de 24 px de large à toute la largeur utile. */
    @media (max-width: 768px) {
      .hm-cell {
        min-height: 44px; max-height: 44px;
        aspect-ratio: auto;
      }
    }
    /* Téléphone : colonnes resserrées et une étiquette d'heure sur six (0 · 6 · 12 · 18)
       — une sur trois retombait à 8 px, sous tout seuil de lisibilité. */
    @media (max-width: 640px) {
      .hm-header,
      .hm-row {
        grid-template-columns: 24px repeat(24, minmax(6px, 1fr));
        gap: 2px;
      }
      .hm-corner { width: 24px; }
      .hm-day-label { font-size: 9px; padding-right: 4px; }
      .hm-cell { border-radius: 2px; }
      .hm-hour-label { font-size: 10px; }
      .hm-hour-label--shown:not(.hm-hour-label--jalon) { visibility: hidden; }
    }
    /* Sous un pointeur grossier, le clic appartient à la rangée : une cellule de 10 px
       de large n'est jamais celle qu'on visait. */
    @media (pointer: coarse) {
      .hm-cell { pointer-events: none; }
    }

    .hm-tooltip {
      position: absolute;
      transform: translate(-50%, calc(-100% - 10px));
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 6px 10px;
      pointer-events: none;
      /* Ombre neutre, pas l'ombre lourde du thème sombre : la page a aussi un thème clair. */
      box-shadow: 0 6px 20px rgba(0,0,0,.18);
      display: flex;
      flex-direction: column;
      gap: 2px;
      z-index: 10;
      white-space: nowrap;
    }
    /* Sur les deux premières rangées, l'infobulle passe SOUS la cellule. */
    .hm-tooltip--dessous { transform: translate(-50%, 10px); }
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
  /** Indices des quatre paliers, pour la légende « moins → plus ». */
  protected readonly paliers = [0, 1, 2, 3];
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
   * Couleur d'un palier d'intensité, composée avec les JETONS du thème.
   *
   * ⚠️ L'échelle était écrite en dur pour le thème sombre — `rgba(255,255,255,.025)`
   * pour le vide, puis `rgba(16,224,160, alpha)` — avec un commentaire affirmant que
   * « ça marche pareil dark/light ». C'est faux : en thème clair, la cellule vide
   * devenait du blanc à 2,5 % SUR DU BLANC (la grille disparaissait, « 0 trajet » ne
   * se distinguait plus de « pas de cellule »), et les deux premiers paliers tombaient
   * autour de 1,1:1 et 1,3:1 — illisibles pour tout le monde, pas seulement pour les
   * malvoyants.
   *
   * Un MÉLANGE avec le fond, et non une opacité : `--tracky` est déjà assombri en
   * thème clair (#0A9E6C), donc les quatre paliers descendent du bon vert des deux
   * côtés, et se posent sur une base opaque au lieu de laisser transparaître ce qu'il
   * y a dessous.
   */
  protected couleurPalier(palier: number): string {
    const part = PARTS_PALIERS[palier] ?? '100%';
    return `color-mix(in srgb, var(--tracky) ${part}, var(--bg-tertiary))`;
  }

  /** Couleur de cellule. 0 = fond neutre du thème, sinon un des quatre paliers. */
  protected cellColor(count: number): string {
    const m = this.maxCount();
    if (count <= 0 || m === 0) return 'var(--bg-quaternary)';
    const ratio = count / m;
    let palier = 0;
    if (ratio > 0.25) palier = 1;
    if (ratio > 0.5) palier = 2;
    if (ratio > 0.75) palier = 3;
    return this.couleurPalier(palier);
  }

  /**
   * Filet de la cellule. Les cellules VIDES en portent un aussi : sur fond blanc, un
   * aplat de 3 % ne suffit pas à dessiner la grille, et sans grille on ne voit plus
   * où sont les créneaux sans trajet.
   */
  protected bordureCellule(count: number): string {
    return count > 0
      ? 'color-mix(in srgb, var(--color-tracky-light) 20%, transparent)'
      : 'var(--border-subtle)';
  }

  protected onCellHover(ev: Event, day: number, hour: number, count: number): void {
    // Au doigt, `pointerenter` se déclenche sur la cellule TOUCHÉE — 10 px de large,
    // donc rarement celle qu'on visait — et `pointerleave` sur la grille ne la referme
    // qu'au toucher suivant. Le détail par jour (toucher la rangée) la remplace.
    if ('pointerType' in ev && (ev as PointerEvent).pointerType === 'touch') return;
    const target = ev.currentTarget as HTMLElement | null;
    if (!target) return;
    // wrapper relatif = 2 parents au-dessus (.hm-row > .hm-grid > .hm-wrapper)
    const wrapper = target.closest('.hm-wrapper') as HTMLElement | null;
    if (!wrapper) return;
    const cellRect = target.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    // Sur les deux premières rangées, l'infobulle dessinée au-dessus sortait du cadre.
    const dessous = day <= 1;
    const x = cellRect.left - wrapperRect.left + cellRect.width / 2;
    const xMax = Math.max(DEMI_LARGEUR_INFOBULLE, wrapperRect.width - DEMI_LARGEUR_INFOBULLE);
    this.hover.set({
      day,
      hour,
      count,
      // Bornée : en 0 h et en 23 h, la moitié du texte sortait du conteneur.
      x: Math.min(Math.max(x, DEMI_LARGEUR_INFOBULLE), xMax),
      y: dessous ? cellRect.bottom - wrapperRect.top : cellRect.top - wrapperRect.top,
      dessous,
    });
  }
}
