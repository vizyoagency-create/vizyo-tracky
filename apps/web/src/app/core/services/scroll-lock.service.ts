import { Injectable } from '@angular/core';

/**
 * Verrou de scroll global pour les overlays (drawers, modals).
 *
 * Problème : le scroller réel du shell est `.content` (pas `body`) — cf.
 * dashboard-layout. Poser `body { overflow: hidden }` ne suffit donc pas : la
 * page continue de défiler DERRIÈRE la modal sur mobile. Ce service pose une
 * classe `scroll-locked` sur <html> ; la règle globale (styles.css) fige alors
 * `.content` ET `body`.
 *
 * Ref-count : plusieurs overlays peuvent être ouverts simultanément (ex : un
 * drawer qui ouvre une modal de confirmation). On ne déverrouille qu'au dernier
 * `unlock()`. Idempotent par instance appelante grâce au pattern acquire/release
 * recommandé (chaque overlay appelle lock() à l'ouverture, unlock() à la
 * fermeture, exactement une fois par transition).
 */
@Injectable({ providedIn: 'root' })
export class ScrollLockService {
  private count = 0;

  lock(): void {
    if (typeof document === 'undefined') return;
    if (this.count === 0) {
      document.documentElement.classList.add('scroll-locked');
    }
    this.count++;
  }

  unlock(): void {
    if (typeof document === 'undefined') return;
    if (this.count === 0) return;
    this.count--;
    if (this.count === 0) {
      document.documentElement.classList.remove('scroll-locked');
    }
  }
}
