import { Injectable, signal } from '@angular/core';

/**
 * V1.12 — Bridge entre composants overlay (ex: BaanoolMapOverlay) et le
 * MapComponent. Chaque action est un signal de "trigger" incremente, que le
 * map.component ecoute via effect() pour declencher l'action correspondante.
 *
 * Pattern signal-trigger plutot que Subject : 100% Angular signals natif,
 * pas de dependance RxJS, marche bien avec effect() reactif.
 */
@Injectable({ providedIn: 'root' })
export class MapBridgeService {
  /** Incremente quand l'utilisateur demande a recentrer la carte sur tous les vehicules. */
  readonly recenterTrigger = signal(0);
  /** Incremente quand l'utilisateur demande a localiser sa propre position GPS. */
  readonly locateTrigger = signal(0);
  /** Incremente quand l'utilisateur demande a switcher le style de carte (satellite <-> standard). */
  readonly toggleSatelliteTrigger = signal(0);
  /** Incremente quand l'utilisateur demande l'action coupe-circuit moteur. */
  readonly engineActionTrigger = signal(0);

  requestRecenter(): void { this.recenterTrigger.update((n) => n + 1); }
  requestLocate(): void { this.locateTrigger.update((n) => n + 1); }
  requestToggleSatellite(): void { this.toggleSatelliteTrigger.update((n) => n + 1); }
  requestEngineAction(): void { this.engineActionTrigger.update((n) => n + 1); }
}
