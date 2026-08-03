import { swallow } from '../../core/error/swallow';
import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/**
 * P3 — onboarding des permissions device (notifications, localisation, hors-ligne)
 * au premier lancement. `shouldOnboard` pilote l'affichage de <app-permissions-gate>
 * dans DashboardLayout (après le consentement). Les choix sont enregistrés côté
 * serveur (UserPermission) pour la traçabilité. Réutilise le deviceId de l'app
 * (`tracky.device.id`) pour rester cohérent avec la gestion des devices.
 *
 * NB : distinct de PermissionsService (matrice d'accès UserVehicleAccess) — ici on
 * parle des autorisations navigateur/appareil.
 */
@Injectable({ providedIn: 'root' })
export class PermissionOnboardingService {
  private readonly http = inject(HttpClient);
  private readonly KEY_DONE = 'tracky.perms.onboarded';
  private readonly KEY_DEVICE = 'tracky.device.id';

  readonly shouldOnboard = signal(false);

  init(): void {
    try {
      this.shouldOnboard.set(!localStorage.getItem(this.KEY_DONE));
    } catch {
      this.shouldOnboard.set(false);
    }
  }

  private deviceId(): string {
    try {
      const v = localStorage.getItem(this.KEY_DEVICE);
      if (v) return v;
      const fresh =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(this.KEY_DEVICE, fresh);
      return fresh;
    } catch {
      return 'unknown';
    }
  }

  async record(kind: 'PUSH' | 'GEOLOCATION', granted: boolean): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post('/api/consent/permission', { kind, granted, deviceId: this.deviceId() }),
      );
    } catch (err) {
      swallow('permission-onboarding:record', err);
      // best-effort — l'enregistrement ne doit jamais bloquer l'utilisateur.
    }
  }

  finish(): void {
    try {
      localStorage.setItem(this.KEY_DONE, '1');
    } catch {
      /* noop */
    }
    this.shouldOnboard.set(false);
  }
}
