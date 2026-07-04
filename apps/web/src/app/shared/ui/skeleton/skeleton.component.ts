import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Refonte splash/loaders (§2.1) — primitive skeleton partagée. Un simple bloc `.sk`
 * (fond + balayage émeraude défini globalement dans styles.css) dimensionné aux mesures
 * réelles du contenu qu'il remplace, pour combler le trou de chargement SANS saut de
 * mise en page à l'arrivée des données.
 *
 * On assemble plusieurs `<app-skeleton>` pour reproduire une grille (cf. dashboard).
 *
 * Usage :
 *   <app-skeleton />                                  (ligne de texte, 100 % × 1em)
 *   <app-skeleton w="120px" h="14px" />
 *   <app-skeleton [circle]="true" w="40px" h="40px" /> (avatar / pastille)
 *   <app-skeleton w="100%" h="88px" radius="16px" />   (carte)
 *
 * Purement décoratif : masqué aux technologies d'assistance. Le fallback
 * `prefers-reduced-motion` (balayage coupé) est porté par `.sk` dans styles.css.
 */
@Component({
  selector: 'app-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    class: 'sk',
    role: 'presentation',
    'aria-hidden': 'true',
    '[style.display]': '"block"',
    '[style.width]': 'w()',
    '[style.height]': 'h()',
    '[style.borderRadius]': 'resolvedRadius()',
  },
})
export class SkeletonComponent {
  /** Largeur CSS (ex. '100%', '120px', '4rem'). */
  readonly w = input<string>('100%');
  /** Hauteur CSS (ex. '1em', '14px'). */
  readonly h = input<string>('1em');
  /** Pastille ronde (avatar, pin) : force un border-radius 50 %. */
  readonly circle = input<boolean>(false);
  /** Rayon personnalisé (ignoré si circle=true). */
  readonly radius = input<string>('7px');

  protected readonly resolvedRadius = computed(() => (this.circle() ? '50%' : this.radius()));
}
