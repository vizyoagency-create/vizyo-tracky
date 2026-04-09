import { Injectable, signal } from '@angular/core';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'vizyo-tracky-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(this.loadTheme());

  init(): void {
    this.applyTheme(this.theme());
  }

  toggle(): void {
    const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    this.applyTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
  }

  private loadTheme(): Theme {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return 'dark';
  }

  private applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }
}
