import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { BANDES_VITESSE } from '../../utils/couleurs-carte';

/**
 * La légende des vitesses, GÉNÉRÉE depuis `BANDES_VITESSE`.
 *
 * Avant, elle était écrite à la main à deux endroits du composant carte, avec des seuils
 * qui n'étaient plus ceux des marqueurs : la carte disait « 1-50 » en légende et peignait
 * en vert jusqu'à 65. Une légende qui ne lit pas la table qu'elle décrit finit toujours
 * par mentir — ici elle ne peut plus.
 *
 * Trois dispositions, parce que trois hôtes : la liste verticale du HUD de bureau, la grille
 * à deux colonnes de la feuille mobile, la ligne qui se replie sous la carte d'un rejeu ou
 * de la page publique. La taille de police se règle par l'hôte avec `--lv-taille` (10 px
 * par défaut, 12 px dans la feuille), pas par une variante de plus.
 */
@Component({
  selector: 'app-legende-vitesse',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="lv" [class.lv--grille]="disposition() === 'grille'" [class.lv--ligne]="disposition() === 'ligne'"
        aria-label="Couleurs de vitesse">
      @for (bande of bandes; track bande.max) {
        <li class="lv-item">
          <span class="lv-pastille" [style.background]="bande.couleur" aria-hidden="true"></span>
          <span class="lv-libelle">{{ bande.libelle }}</span>
        </li>
      }
    </ul>
  `,
  styles: [`
    :host { display: block; --lv-taille: 10px; }
    .lv { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .lv--grille { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .lv--ligne { flex-direction: row; flex-wrap: wrap; gap: 4px 12px; }
    .lv-item { display: flex; align-items: center; gap: 8px; font-size: var(--lv-taille); color: var(--fg-tertiary); }
    .lv-pastille { width: 10px; height: 10px; border-radius: 999px; flex: none; }
  `],
})
export class LegendeVitesseComponent {
  protected readonly bandes = BANDES_VITESSE;
  readonly disposition = input<'liste' | 'grille' | 'ligne'>('liste');
}
