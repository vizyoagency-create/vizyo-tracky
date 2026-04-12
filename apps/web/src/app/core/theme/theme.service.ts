import { inject, Injectable, signal } from '@angular/core';
import { PreferencesService } from '../services/preferences.service';

export type Theme = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly prefs = inject(PreferencesService);
  readonly theme = signal<Theme>('dark');

  init(): void {
    this.theme.set(this.prefs.prefs().theme);
    this.applyTheme(this.theme());
  }

  toggle(): void {
    const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    this.applyTheme(next);
    this.prefs.update({ theme: next });
  }

  setTheme(theme: Theme): void {
    this.theme.set(theme);
    this.applyTheme(theme);
    this.prefs.update({ theme });
  }

  private applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }
}
