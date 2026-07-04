import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Refonte splash/loaders (§3) — spinner partagé, unique et cohérent, qui remplace la
 * quinzaine de `.spinner` ad-hoc disséminés dans les features. Anneau qui tourne :
 * bordure discrète + arc émeraude (seule couleur de mouvement autorisée).
 *
 * Le style vit dans `.vt-spinner` (styles.css) — ce composant ne fait que l'appliquer
 * et régler taille / épaisseur. Tailles usuelles : 14 (inline / boutons), 18 (défaut),
 * 24 (panneau centré).
 *
 * Usage :
 *   <app-spinner />                 (18px)
 *   <app-spinner [size]="14" />     (inline / bouton)
 *   <app-spinner [size]="24" />     (chargement de panneau)
 *   <app-spinner label="Enregistrement…" />   (libellé lu par les lecteurs d'écran)
 *
 * Accessibilité : role="status" + aria-label. Fallback `prefers-reduced-motion`
 * (rotation → pulsation d'opacité) porté par `.vt-spinner` dans styles.css.
 */
@Component({
  selector: 'app-spinner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  host: {
    class: 'vt-spinner',
    role: 'status',
    '[attr.aria-label]': 'label()',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.borderWidth.px]': 'borderWidth()',
  },
})
export class SpinnerComponent {
  /** Diamètre en px (14 inline, 18 défaut, 24 panneau). */
  readonly size = input<number>(18);
  /** Libellé accessible (lecteurs d'écran). */
  readonly label = input<string>('Chargement');

  /** Épaisseur du trait proportionnée au diamètre. */
  protected readonly borderWidth = computed(() => (this.size() >= 24 ? 3 : 2));
}
