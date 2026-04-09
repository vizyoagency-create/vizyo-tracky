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
    >
      @if (theme.theme() === 'dark') {
        <lucide-icon [img]="Sun" [size]="18"></lucide-icon>
      } @else {
        <lucide-icon [img]="Moon" [size]="18"></lucide-icon>
      }
    </button>
  `,
})
export class ThemeToggleComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly Sun = Sun;
  protected readonly Moon = Moon;
}
