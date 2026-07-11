import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AlertTriangle, CheckCircle2, LoaderCircle, LucideAngularModule, MapPin, Shield, ShieldCheck, Unlock } from 'lucide-angular';
import { DriverUnlockApiService } from '../../core/services/driver-unlock.service';

type UnlockState = 'idle' | 'locating' | 'unlocking' | 'success' | 'error';

/**
 * feat/comptes-conducteurs (4b) — écran conducteur « Déverrouiller un véhicule ».
 * Cible du QR (deep-link `?token=`). Page focalisée, publique côté route (l'API exige la session :
 * un 401 affiche « connectez-vous »). Au clic : géoloc du téléphone → POST /driver/unlock.
 */
@Component({
  selector: 'app-driver-unlock',
  standalone: true,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="min-h-dvh flex items-center justify-center p-4 bg-bg-primary text-fg-primary">
      <div class="w-full max-w-sm rounded-2xl bg-bg-secondary border border-border-subtle p-6 text-center shadow-xl">
        @switch (state()) {
          @case ('success') {
            <div class="mx-auto mb-4 w-14 h-14 rounded-full bg-tracky/15 flex items-center justify-center">
              <lucide-icon [img]="CheckCircle2" [size]="30" class="text-tracky-light" />
            </div>
            <h1 class="text-lg font-semibold mb-1">Véhicule déverrouillé</h1>
            @if (plate()) { <div class="text-sm text-fg-secondary font-medium mb-2">{{ plate() }}</div> }
            <p class="text-sm text-fg-tertiary">{{ message() }}</p>

            @if (canManagePrivacy()) {
              <div class="mt-5 pt-4 border-t border-border-subtle text-left">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex items-start gap-2">
                    <lucide-icon [img]="privacyOn() ? ShieldCheck : Shield" [size]="18"
                      [class]="privacyOn() ? 'text-tracky-light mt-0.5' : 'text-fg-tertiary mt-0.5'" />
                    <div>
                      <div class="text-sm font-medium">Mode vie privée</div>
                      <div class="text-xs text-fg-tertiary">
                        {{ privacyOn() ? 'Collecte GPS en pause (trajet personnel).' : 'La position est collectée normalement.' }}
                      </div>
                    </div>
                  </div>
                  <button (click)="togglePrivacy()" [disabled]="privacyBusy()" type="button" role="switch"
                    [attr.aria-checked]="privacyOn()"
                    class="relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50"
                    [class]="privacyOn() ? 'bg-tracky' : 'bg-bg-tertiary border border-border-subtle'">
                    <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform"
                      [class.translate-x-5]="privacyOn()"></span>
                  </button>
                </div>
              </div>
            }
          }
          @case ('error') {
            <div class="mx-auto mb-4 w-14 h-14 rounded-full bg-red-500/15 flex items-center justify-center">
              <lucide-icon [img]="AlertTriangle" [size]="28" class="text-red-400" />
            </div>
            <h1 class="text-lg font-semibold mb-1">Déverrouillage impossible</h1>
            <p class="text-sm text-fg-tertiary mb-4">{{ message() }}</p>
            @if (needsLogin()) {
              <a routerLink="/login" class="inline-flex items-center justify-center w-full px-4 py-2.5 text-sm font-medium rounded-xl bg-tracky/20 text-tracky-light border border-tracky/30">
                Se connecter
              </a>
            } @else {
              <button (click)="unlock()" class="inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 text-sm font-medium rounded-xl bg-bg-tertiary border border-border-subtle">
                <lucide-icon [img]="Unlock" [size]="16" /> Réessayer
              </button>
            }
          }
          @default {
            <div class="mx-auto mb-4 w-14 h-14 rounded-full bg-tracky/15 flex items-center justify-center">
              <lucide-icon [img]="Unlock" [size]="28" class="text-tracky-light" />
            </div>
            <h1 class="text-lg font-semibold mb-1">Déverrouiller le véhicule</h1>
            <p class="text-sm text-fg-tertiary mb-5 inline-flex items-center gap-1.5 justify-center">
              <lucide-icon [img]="MapPin" [size]="14" /> Vous devez être à proximité du véhicule.
            </p>
            <button
              (click)="unlock()"
              [disabled]="busy()"
              class="inline-flex items-center justify-center gap-2 w-full px-4 py-3 text-sm font-semibold rounded-xl bg-tracky/20 text-tracky-light border border-tracky/30 disabled:opacity-50"
            >
              @if (busy()) {
                <lucide-icon [img]="LoaderCircle" [size]="18" class="animate-spin" />
                {{ state() === 'locating' ? 'Localisation…' : 'Déverrouillage…' }}
              } @else {
                <lucide-icon [img]="Unlock" [size]="18" /> Déverrouiller
              }
            </button>
          }
        }
      </div>
    </div>
  `,
})
export class DriverUnlockComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(DriverUnlockApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly state = signal<UnlockState>('idle');
  protected readonly message = signal('');
  protected readonly plate = signal('');
  protected readonly needsLogin = signal(false);
  // Incr.5 — mode vie privée du véhicule déverrouillé (si le conducteur y est autorisé).
  protected readonly vehicleId = signal('');
  protected readonly canManagePrivacy = signal(false);
  protected readonly privacyOn = signal(false);
  protected readonly privacyBusy = signal(false);

  private readonly token = this.route.snapshot.queryParamMap.get('token') ?? '';
  // Incr.6 — entrée in-app (« Mes véhicules ») : vehicleId au lieu du jeton QR.
  private readonly vehicleIdParam = this.route.snapshot.queryParamMap.get('vehicleId') ?? '';

  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Unlock = Unlock;
  protected readonly MapPin = MapPin;
  protected readonly LoaderCircle = LoaderCircle;
  protected readonly Shield = Shield;
  protected readonly ShieldCheck = ShieldCheck;

  protected busy(): boolean {
    return this.state() === 'locating' || this.state() === 'unlocking';
  }

  protected unlock(): void {
    this.needsLogin.set(false);
    if (!this.token && !this.vehicleIdParam) {
      this.fail('QR invalide ou véhicule non spécifié. Rescannez le code du véhicule.');
      return;
    }
    if (!navigator.geolocation) {
      this.fail("La géolocalisation n'est pas disponible sur cet appareil.");
      return;
    }
    this.state.set('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.state.set('unlocking');
        this.api
          .unlock({
            ...(this.vehicleIdParam ? { vehicleId: this.vehicleIdParam } : { token: this.token }),
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          })
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (r) => {
              this.plate.set(r.plate);
              this.message.set(r.message);
              this.vehicleId.set(r.vehicleId);
              this.canManagePrivacy.set(r.canManagePrivacy);
              this.privacyOn.set(r.privacyModeEnabled);
              this.state.set('success');
            },
            error: (err: unknown) => this.handleError(err),
          });
      },
      (geoErr) => {
        this.fail(
          geoErr.code === geoErr.PERMISSION_DENIED
            ? 'Autorisez la géolocalisation : elle sert au contrôle de proximité.'
            : "Impossible d'obtenir votre position. Réessayez à l'air libre.",
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  }

  private handleError(err: unknown): void {
    if (err instanceof HttpErrorResponse && err.status === 401) {
      this.needsLogin.set(true);
      this.fail('Connectez-vous à Tracky, puis rescannez le QR du véhicule.');
      return;
    }
    const body = err instanceof HttpErrorResponse ? (err.error as { error?: { message?: string }; message?: string } | null) : null;
    this.fail(body?.error?.message ?? body?.message ?? 'Déverrouillage impossible. Réessayez.');
  }

  protected togglePrivacy(): void {
    const vid = this.vehicleId();
    if (!vid || this.privacyBusy()) return;
    const target = !this.privacyOn();
    this.privacyBusy.set(true);
    this.api
      .setPrivacy(vid, target)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.privacyOn.set(target);
          this.privacyBusy.set(false);
        },
        error: () => this.privacyBusy.set(false),
      });
  }

  private fail(msg: string): void {
    this.message.set(msg);
    this.state.set('error');
  }
}
