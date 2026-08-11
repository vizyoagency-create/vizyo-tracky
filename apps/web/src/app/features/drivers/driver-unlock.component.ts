import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AlertTriangle, CheckCircle2, LoaderCircle, LucideAngularModule, MapPin, Unlock } from 'lucide-angular';
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
            <div class="du-ico du-ico--ok">
              <lucide-icon [img]="CheckCircle2" [size]="30" />
            </div>
            <h1 class="text-lg font-semibold mb-1">Véhicule déverrouillé</h1>
            <p class="text-sm text-fg-secondary">{{ message() }}</p>
          }
          @case ('error') {
            <div class="du-ico du-ico--ko">
              <lucide-icon [img]="AlertTriangle" [size]="28" />
            </div>
            <h1 class="text-lg font-semibold mb-1">Déverrouillage impossible</h1>
            <p class="text-sm text-fg-secondary mb-4">{{ message() }}</p>
            @if (needsLogin()) {
              <a routerLink="/login" [queryParams]="{ returnUrl: currentUrl }" class="du-secondaire">
                Se connecter
              </a>
            } @else {
              <button (click)="unlock()" class="du-secondaire">
                <lucide-icon [img]="Unlock" [size]="18" /> Réessayer
              </button>
            }
          }
          @default {
            <h1 class="text-lg font-semibold mb-1">Déverrouiller le véhicule</h1>
            <p class="text-sm text-fg-secondary mb-1 inline-flex items-center gap-1.5 justify-center">
              <lucide-icon [img]="MapPin" [size]="14" /> Vous devez être à proximité du véhicule.
            </p>

            <!--
              B1 § A : « une main, gants ». Ce geste se fait dehors, souvent gante, souvent
              une seule main libre — l'autre tient un colis ou une portiere. Le bouton etait
              un bouton DOUX de 40 px, cote a cote avec le reste : la meme affordance qu'un
              lien secondaire pour LA seule action de l'ecran.
              Il devient une cible pleine, de 128 px, qu'on vise sans regarder.
            -->
            <button
              (click)="unlock()"
              [disabled]="busy()"
              class="du-gros"
              [attr.aria-label]="busy() ? 'Déverrouillage en cours' : 'Déverrouiller le véhicule'">
              @if (busy()) {
                <lucide-icon [img]="LoaderCircle" [size]="46" class="animate-spin" />
              } @else {
                <lucide-icon [img]="Unlock" [size]="46" />
              }
            </button>
            <div class="du-etat">
              @if (busy()) {
                {{ state() === 'locating' ? 'Localisation…' : 'Déverrouillage…' }}
              } @else {
                Appuyez pour déverrouiller
              }
            </div>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    .du-ico {
      display: flex; align-items: center; justify-content: center;
      width: 56px; height: 56px; border-radius: 999px; margin: 0 auto 16px;
    }
    /* Les classes de PALETTE Tailwind (bg-red-500/15, text-red-400) ont la syntaxe du
       systeme sans en faire partie, et ne suivent pas le theme. */
    .du-ico--ko { background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--texte-alerte); }
    .du-ico--ok { background: color-mix(in srgb, var(--color-tracky-light) 15%, transparent); color: var(--texte-succes); }

    /*
     * 128 px : la cible du geste principal, visee d'une main gantee, dehors, sans regarder.
     * Le plancher de 44 px vaut pour une commande ordinaire ; ici c'est LE bouton de l'ecran.
     */
    .du-gros {
      display: flex; align-items: center; justify-content: center;
      width: 128px; height: 128px; margin: 22px auto 0;
      border: none; border-radius: 999px; cursor: pointer;
      background: var(--color-tracky-light); color: var(--accent-ink);
    }
    .du-gros:disabled { opacity: .6; cursor: wait; }
    .du-etat { margin-top: 14px; font-size: 14px; font-weight: 700; color: var(--fg-primary); }

    .du-secondaire {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; min-height: 48px; padding: 0 16px; border-radius: 12px;
      background: var(--bg-tertiary); border: 1px solid var(--border-strong);
      color: var(--fg-primary); font-size: 14px; font-weight: 600;
      font-family: inherit; text-decoration: none; cursor: pointer;
    }
    @media (prefers-reduced-motion: reduce) { .animate-spin { animation: none; } }
  `],
})
export class DriverUnlockComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(DriverUnlockApiService);
  private readonly destroyRef = inject(DestroyRef);
  /** URL courante (ex. /driver/unlock?token=…) → renvoyée en returnUrl pour revenir ici après login. */
  protected readonly currentUrl = this.router.url;

  protected readonly state = signal<UnlockState>('idle');
  protected readonly message = signal('');
  protected readonly needsLogin = signal(false);

  private readonly token = this.route.snapshot.queryParamMap.get('token') ?? '';
  // Incr.6 — entrée in-app (« Mes véhicules ») : vehicleId au lieu du jeton QR.
  private readonly vehicleIdParam = this.route.snapshot.queryParamMap.get('vehicleId') ?? '';

  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Unlock = Unlock;
  protected readonly MapPin = MapPin;
  protected readonly LoaderCircle = LoaderCircle;

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
              this.message.set(r.message);
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

  private fail(msg: string): void {
    this.message.set(msg);
    this.state.set('error');
  }
}
