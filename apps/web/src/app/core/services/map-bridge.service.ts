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
  /** vehicleId quand l'utilisateur veut centrer la map sur un vehicule precis
   *  (depuis le panel Baanool). Reset a null apres consommation. */
  readonly flyToVehicleId = signal<string | null>(null);
  /** Incremente quand l'utilisateur interagit directement avec la map (drag,
   *  zoom, click sur le fond). Utilise par les overlays (ex: panel Baanool)
   *  pour s'auto-fermer : l'intention "je veux voir la carte" prime sur
   *  l'overlay qui la couvre. Emis par map.component depuis les listeners
   *  movestart/click natifs maplibre. */
  readonly mapInteractionTrigger = signal(0);

  requestRecenter(): void { this.recenterTrigger.update((n) => n + 1); }
  requestLocate(): void { this.locateTrigger.update((n) => n + 1); }
  requestToggleSatellite(): void { this.toggleSatelliteTrigger.update((n) => n + 1); }
  requestFlyToVehicle(vehicleId: string): void { this.flyToVehicleId.set(vehicleId); }
  notifyMapInteraction(): void { this.mapInteractionTrigger.update((n) => n + 1); }
}
