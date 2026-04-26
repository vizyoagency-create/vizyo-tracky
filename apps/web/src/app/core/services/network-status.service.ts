import { Injectable, signal } from '@angular/core';

/**
 * Etat de connectivite reseau (online/offline) base sur navigator.onLine
 * et les evenements `online` / `offline` du window.
 *
 * Note : navigator.onLine est notoirement imprecis (il dit "true" si une
 * interface reseau est active, meme sans Internet). Pour un check fiable,
 * il faudrait pinger un endpoint de notre API a intervalle regulier - on
 * delegue ca a RealtimeService qui sait s'il a un WS connecte.
 */
@Injectable({ providedIn: 'root' })
export class NetworkStatusService {
  readonly online = signal<boolean>(this.detectInitial());

  init(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => this.online.set(true));
    window.addEventListener('offline', () => this.online.set(false));
  }

  private detectInitial(): boolean {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine;
  }
}
