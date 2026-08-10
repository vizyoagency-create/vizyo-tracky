import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ThemeService } from '../../../core/theme/theme.service';

type LogoVariant = 'icon' | 'lockup';
type LogoTheme = 'dark' | 'light' | 'auto';

/**
 * Le logo de VIZYO TRACKY — notre marque, celle du produit.
 *
 * ⚠️ NE PAS CONFONDRE AVEC `app-brand-logo`. Le kit signale les deux comme « deux
 * composants que leur nom fait confondre » (`Kit Partage Refonte`), et l'erreur est
 * facile : les deux affichent une image de marque, à quelques pixels près.
 *
 *   app-logo        → Vizyo Tracky. Un seul logo, le nôtre. Suit le thème (variante
 *                     claire ou sombre), se pose partout : barre du haut, écran de
 *                     connexion, en-tête d'e-mail, page publique.
 *   app-brand-logo  → le CONSTRUCTEUR d'un véhicule (Renault, Volvo, Peugeot…). Autant
 *                     de logos que de marques, choisis d'après `Vehicle.brand`, posés
 *                     sur une plaque dont le fond ne suit PAS le thème — cf. le
 *                     commentaire de ce composant.
 *
 * Le test qui tranche : si l'image change d'un véhicule à l'autre, c'est
 * `app-brand-logo`. Si elle est la même sur toute l'application, c'est celui-ci.
 */
@Component({
  selector: 'app-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <img [src]="src()" [style.height.px]="size()" [alt]="'Vizyo Tracky'" style="width:auto;display:block" />
  `,
})
export class LogoComponent {
  readonly variant = input<LogoVariant>('lockup');
  readonly theme = input<LogoTheme>('auto');
  readonly size = input(32);

  private readonly themeService = inject(ThemeService);

  protected readonly src = computed(() => {
    const resolvedTheme = this.theme() === 'auto' ? this.themeService.theme() : this.theme();
    const v = this.variant();

    if (v === 'icon') {
      return resolvedTheme === 'dark'
        ? 'logos/svg/vizyo-tracky-icon-white.svg'
        : 'logos/svg/vizyo-tracky-icon-green.svg';
    }

    return resolvedTheme === 'dark'
      ? 'logos/png/vizyo-tracky-icon-white-lockup-gradient-green.png'
      : 'logos/png/vizyo-tracky-icon-black-lockup-gradient-green.png';
  });
}
