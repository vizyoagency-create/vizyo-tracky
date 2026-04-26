import { Component, inject } from '@angular/core';
import { LucideAngularModule, Sun, Moon } from 'lucide-angular';
import { ThemeService } from '../../core/theme/theme.service';

@Component({
  selector: 'app-theme-toggle',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <button
      (click)="theme.toggle()"
      class="flex items-center justify-center w-10 h-10 rounded-full
             bg-bg-secondary border border-border-subtle
             text-fg-secondary hover:text-tracky-light
             transition-all duration-300 ease-tracky
             hover:shadow-tracky-glow cursor-pointer"
      [attr.aria-label]="theme.theme() === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'"
      [attr.aria-pressed]="theme.theme() === 'dark'"
    >
      @if (theme.theme() === 'dark') {
        <lucide-icon [img]="Sun" [size]="18" aria-hidden="true"></lucide-icon>
      } @else {
        <lucide-icon [img]="Moon" [size]="18" aria-hidden="true"></lucide-icon>
      }
    </button>
  `,
  styles: [`
    @keyframes theme-toggle-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(16, 224, 160, 0.35); }
      70%  { box-shadow: 0 0 0 8px rgba(16, 224, 160, 0); }
      100% { box-shadow: 0 0 0 0 rgba(16, 224, 160, 0); }
    }
    :host button {
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
}
