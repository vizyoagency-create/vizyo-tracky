import { Injectable, signal } from '@angular/core';

/**
 * V1.12 — Etat partage du menu mobile (bottom-sheet).
 *
 * Ce service est apparu pour resoudre un bug iOS PWA standalone ou
 * l'EventEmitter (menuClick) du BaanoolMapOverlay ne propageait pas son
 * event au listener (menuClick)="..." du parent dashboard-layout (cause
 * pas trouvee, probablement un edge case Angular HMR/OnPush x DOM click
 * qui ne re-bind pas correctement le handler apres hot reload).
 *
 * Pattern : extraire l'etat du menu hors du composant dashboard-layout
 * vers un service singleton. Le BaanoolMapOverlay set directement
 * `mobileMenuOpen.set(true)` sans plus dependre d'EventEmitter.
 *
 * Le dashboard-layout lit ce signal pour passer a `<app-bottom-sheet [open]="...">`.
 */
@Injectable({ providedIn: 'root' })
export class MenuStateService {
  readonly mobileMenuOpen = signal(false);

  open(): void { this.mobileMenuOpen.set(true); }
  close(): void { this.mobileMenuOpen.set(false); }
  toggle(): void { this.mobileMenuOpen.update((v) => !v); }
}
