import { swallow } from '../../core/error/swallow';
import { HttpClient } from '@angular/common/http';
import { inject, Injectable, isDevMode, signal } from '@angular/core';
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

  /**
   * ⚠️ MUET EN DÉVELOPPEMENT (décision du 2026-08-14).
   *
   * ┌─ CE QU'IL FAUT COMPRENDRE AVANT DE LE RÉACTIVER ──────────────────────────┐
   * │ Cet écran se pose EN PLEIN ÉCRAN au premier lancement et intercepte tous   │
   * │ les clics derrière lui. En production c'est son rôle. Sur un poste de      │
   * │ développement, il repart à zéro à chaque profil de navigateur neuf — donc  │
   * │ à chaque exécution de recette automatisée, à chaque fenêtre privée, à      │
   * │ chaque nettoyage du stockage local. Il barrait la route au premier bouton  │
   * │ de chaque scénario, avec un message d'erreur qui parle d'« élément qui     │
   * │ intercepte les événements de pointeur » et ne le nomme jamais.             │
   * │                                                                            │
   * │ On le TAIT ici plutôt que de le contourner dans chaque harnais : un        │
   * │ contournement par test se recopie, se périme, et finit par manquer         │
   * │ quelque part.                                                              │
   * │                                                                            │
   * │ ⚠️ RIEN D'AUTRE NE CHANGE. `record()` et `finish()` restent intacts : la   │
   * │ traçabilité serveur des choix (UserPermission) et le comportement de       │
   * │ production sont exactement ceux d'avant. `isDevMode()` est faux dès qu'un  │
   * │ paquet est construit en production, y compris servi depuis localhost.      │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  init(): void {
    if (isDevMode()) {
      this.shouldOnboard.set(false);
      return;
    }
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
