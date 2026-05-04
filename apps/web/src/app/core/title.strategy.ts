import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRouteSnapshot, RouterStateSnapshot, TitleStrategy } from '@angular/router';

/**
 * Le manifest PWA porte deja la marque ("Vizyo Tracky - Gestion de flotte GPS"),
 * que Chromium prepende au document.title dans le header de fenetre desktop.
 * On garde donc ici uniquement le nom de la page pour eviter la duplication.
 * Fallback : "Vizyo Tracky" pour les routes sans data.title (login, 404).
 */
@Injectable({ providedIn: 'root' })
export class AppTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const pageTitle = this.findDeepestDataTitle(snapshot.root);
    this.title.setTitle(pageTitle ?? 'Vizyo Tracky');
  }

  private findDeepestDataTitle(route: ActivatedRouteSnapshot): string | null {
    let current: ActivatedRouteSnapshot | null = route;
    let found: string | null = null;
    while (current) {
      const t = current.data?.['title'];
      if (typeof t === 'string' && t.length > 0) {
        found = t;
      }
      current = current.firstChild;
    }
    return found;
  }
}
