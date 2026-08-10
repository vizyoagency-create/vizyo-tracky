import { Component, inject, input } from '@angular/core';
import { LucideAngularModule, Sun, Moon } from 'lucide-angular';
import { ThemeService } from '../../core/theme/theme.service';

/**
 * Bascule de thème — deux habillages, un seul comportement.
 *
 * « Avec libellé dans les réglages, pictogramme seul dans les barres » (Kit Partage).
 * Ce n'est pas une préférence esthétique : dans une barre, le pictogramme est entouré
 * d'autres pictogrammes et le contexte suffit ; dans une page de réglages, il est
 * entouré de lignes libellées, et un bouton muet au milieu d'une liste de réglages
 * n'annonce ni ce qu'il règle ni son état courant.
 */
@Component({
  selector: 'app-theme-toggle',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <button
      (click)="theme.toggle()"
      class="tt-btn"
      [class.tt-btn--libelle]="avecLibelle()"
      [attr.aria-label]="theme.theme() === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'"
      [attr.aria-pressed]="theme.theme() === 'dark'"
    >
      @if (theme.theme() === 'dark') {
        <lucide-icon [img]="Sun" [size]="18" aria-hidden="true"></lucide-icon>
      } @else {
        <lucide-icon [img]="Moon" [size]="18" aria-hidden="true"></lucide-icon>
      }
      @if (avecLibelle()) {
        <!-- Le libellé dit l'état COURANT, pas l'action : « Thème sombre » se lit comme
             une valeur de réglage, ce qu'il est. L'action reste dans l'aria-label, où
             elle sert à qui n'a pas le visuel. -->
        <span class="tt-l">{{ theme.theme() === 'dark' ? 'Thème sombre' : 'Thème clair' }}</span>
      }
    </button>
  `,
  styles: [`
    .tt-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 44px; height: 44px;
      border-radius: 9999px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      cursor: pointer;
      transition: color .3s var(--ease-tracky), box-shadow .3s var(--ease-tracky), transform .2s;
    }
    .tt-btn:hover { color: var(--texte-succes); box-shadow: var(--shadow-tracky-glow); }
    /* Version « réglages » : le libellé rend le bouton lisible au milieu d'une liste. */
    .tt-btn--libelle {
      width: auto; height: auto;
      gap: 9px; padding: 10px 16px;
      border-radius: 12px;
    }
    .tt-l { font-size: .875rem; font-weight: 600; color: var(--fg-primary); }

    @keyframes theme-toggle-pulse {
      0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-tracky-light) 35%, transparent); }
      70%  { box-shadow: 0 0 0 8px color-mix(in srgb, var(--color-tracky-light) 0%, transparent); }
      100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-tracky-light) 0%, transparent); }
    }
    /* La pulsation appelle l'œil sur une commande discrète d'une barre. Dans une page
       de réglages, la ligne est déjà libellée : elle n'a rien à réclamer. */
    :host button:not(.tt-btn--libelle) {
      animation: theme-toggle-pulse 3s ease-out infinite;
    }
    :host button:hover {
      animation: none;
      transform: scale(1.08);
    }
    :host button:active {
      transform: scale(0.94);
    }
    :host lucide-icon {
      display: inline-flex;
      transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    :host button:hover lucide-icon {
      transform: rotate(-25deg);
    }
    @media (prefers-reduced-motion: reduce) {
      :host button { animation: none; }
      :host lucide-icon { transition: none; }
    }
  `],
})
export class ThemeToggleComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly Sun = Sun;
  protected readonly Moon = Moon;

  /** `true` dans une page de réglages, `false` (défaut) dans une barre. */
  readonly avecLibelle = input<boolean>(false);
}
