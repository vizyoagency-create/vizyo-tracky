import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { brandLogoUrl, findBrand } from '../../utils/vehicle-brands';

/**
 * Logo de marque véhicule. Affiche le PNG `public/logos/brands/<slug>.png`
 * correspondant au texte de marque (tolérant casse/accents), ou RIEN si la
 * marque est inconnue ou si le fichier n'existe pas (gestion `(error)`).
 *
 * L'appelant gère le fallback (ex. icône de type véhicule) en testant `hasLogo`,
 * ou en laissant simplement ce composant ne rien rendre.
 *
 * `size` = côté du carré en px (logos en tailles variées selon l'emplacement).
 * Fond clair arrondi optionnel (`chip`) pour les logos sombres sur thème sombre.
 */
@Component({
  selector: 'app-brand-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visibleUrl(); as src) {
      <img
        [src]="src"
        [alt]="label()"
        [title]="label()"
        [width]="size()"
        [height]="size()"
        [class.brand-logo--chip]="chip()"
        [class.brand-logo--dark]="chip() && dark()"
        class="brand-logo"
        loading="lazy"
        decoding="async"
        (error)="failedUrl.set(src)"
      />
    }
  `,
  styles: [`
    .brand-logo {
      display: inline-block;
      object-fit: contain;
      vertical-align: middle;
      flex-shrink: 0;
    }
    /* ⚠️ EXCEPTION ASSUMÉE — ces deux fonds ne suivent PAS le thème, et c'est voulu.
       Ce sont les plaques sur lesquelles se pose un logo CONSTRUCTEUR (Renault, Volvo,
       Peugeot…), fourni en PNG avec ses propres couleurs et souvent sans transparence.
       Le blanc et le gris très sombre sont les deux fonds sur lesquels ces logos ont
       été dessinés ; les remplacer par une surface du thème rendrait certains d'entre
       eux invisibles — un logo noir sur une surface sombre disparaît. La plaque est un
       support d'image, pas une surface d'interface. */
    .brand-logo--chip {
      background: #fff;
      border-radius: 6px;
      padding: 2px;
      box-shadow: 0 0 0 1px var(--border-subtle);
    }
    .brand-logo--dark {
      background: #1a1d21;
    }
  `],
})
export class BrandLogoComponent {
  /** Texte de marque libre (ex. valeur de `Vehicle.brand`). */
  readonly brand = input<string | null | undefined>(null);
  /** Côté du carré, en pixels. */
  readonly size = input<number>(20);
  /** Pose le logo sur une pastille blanche arrondie (lisibilité thème sombre). */
  readonly chip = input<boolean>(false);

  /** URL du logo connu pour cette marque, ou null. */
  protected readonly url = computed(() => brandLogoUrl(this.brand()));
  /** Dernière URL dont le chargement a échoué (fichier absent). */
  protected readonly failedUrl = signal<string | null>(null);
  /** URL à afficher : connue ET pas en échec. Se réinitialise si la marque change. */
  protected readonly visibleUrl = computed(() => {
    const u = this.url();
    return u && u !== this.failedUrl() ? u : null;
  });
  protected readonly label = computed(() => findBrand(this.brand())?.label ?? '');
  /** Vrai si la marque doit s'afficher sur pastille sombre (logo à tracé clair). */
  protected readonly dark = computed(() => findBrand(this.brand())?.darkBg ?? false);

  /** Vrai si un logo connu existe pour cette marque (avant tentative de chargement). */
  readonly hasLogo = computed(() => this.url() !== null);
}
