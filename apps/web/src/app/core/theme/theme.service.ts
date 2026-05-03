import { inject, Injectable, signal } from '@angular/core';
import { PreferencesService } from '../services/preferences.service';

export type Theme = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly prefs = inject(PreferencesService);
  readonly theme = signal<Theme>('dark');

  init(): void {
    // Le script inline d'index.html a deja applique un theme initial
    // (lu depuis localStorage `vizyo-theme` ou prefers-color-scheme).
    // On se contente de synchroniser le signal Angular sur ce theme pour
    // eviter un repaint flash. Les prefs explicites de l'user sont
    // appliquees via `applyFromPrefs()` une fois prefs.load() effectue.
    const fromDom = document.documentElement.getAttribute('data-theme');
    const initial: Theme = fromDom === 'light' ? 'light' : 'dark';
    this.theme.set(initial);
    // Persistance idempotente pour les prochains chargements
    try { localStorage.setItem('vizyo-theme', initial); } catch { /* */ }
  }

  /**
   * A appeler apres `PreferencesService.load(userId)` : applique le theme
   * stocke dans les prefs si l'user a un choix explicite different du theme
   * courant. Pas d'effet si le choix matche deja (evite un repaint inutile).
   */
  applyFromPrefs(): void {
    const fromPrefs = this.prefs.prefs().theme;
    if (fromPrefs !== this.theme()) {
      this.setTheme(fromPrefs);
    }
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
    // Persiste pour que le script inline d'index.html puisse appliquer le bon
    // theme avant le bootstrap au prochain chargement (evite tout flash de
    // theme et garantit que le splash matche la couleur de l'app).
    try {
      localStorage.setItem('vizyo-theme', theme);
    } catch { /* localStorage indispo : silencieux */ }
  }
}
