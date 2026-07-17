import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Car, LogOut, LucideAngularModule, ShieldCheck, Unlock } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { DriverPrivacyPanelComponent } from './driver-privacy-panel.component';

/**
 * feat/comptes-conducteurs (6) — espace conducteur « Mes véhicules ».
 *
 * Shell FOCALISÉ (hors app d'admin) : le rôle DRIVER est redirigé ici par
 * `driverAwayFromDashboardGuard`. Le conducteur voit uniquement les véhicules de son périmètre
 * (l'API `/vehicles` est scopée serveur) et peut en déverrouiller un (flux proximité in-app,
 * réutilise l'écran `/driver/unlock?vehicleId=`).
 */
@Component({
  selector: 'app-driver-home',
  standalone: true,
  imports: [LucideAngularModule, RouterLink, DriverPrivacyPanelComponent],
  template: `
    <div class="min-h-dvh bg-bg-primary text-fg-primary">
      <header class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div class="flex items-center gap-2">
          <span class="w-8 h-8 rounded-lg bg-tracky/15 flex items-center justify-center">
            <lucide-icon [img]="Car" [size]="18" class="text-tracky-light" />
          </span>
          <div>
            <div class="text-sm font-semibold leading-tight">Mes véhicules</div>
            <div class="text-[11px] text-fg-tertiary leading-tight">{{ email() }}</div>
          </div>
        </div>
        <button (click)="logout()" class="inline-flex items-center gap-1.5 text-xs text-fg-tertiary hover:text-fg-primary">
          <lucide-icon [img]="LogOut" [size]="15" /> Déconnexion
        </button>
      </header>

      <main class="p-4 max-w-md mx-auto">
        @if (loading()) {
          <div class="py-16 flex justify-center">
            <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
          </div>
        } @else if (vehicles().length === 0) {
          <div class="py-16 text-center text-sm text-fg-tertiary">
            Aucun véhicule ne vous est attribué pour le moment.
          </div>
        } @else {
          <p class="text-xs text-fg-tertiary mb-3">Choisissez un véhicule pour le déverrouiller (vous devez être à proximité), ou scannez son QR.</p>
          <div class="flex flex-col gap-2">
            @for (v of vehicles(); track v.id) {
              <div class="flex items-center justify-between gap-3 rounded-xl bg-bg-secondary border border-border-subtle p-3">
                <div class="min-w-0">
                  <div class="text-sm font-semibold truncate">{{ v.plate }}</div>
                  @if (v.brand || v.model) {
                    <div class="text-xs text-fg-tertiary truncate">{{ v.brand }} {{ v.model }}</div>
                  }
                </div>
                <div class="shrink-0 flex items-center gap-2">
                  <button type="button" (click)="privacyFor.set(v)" title="Vie privée & horaires"
                    class="inline-flex items-center justify-center px-2.5 py-2 rounded-lg bg-bg-tertiary text-fg-tertiary border border-border-subtle">
                    <lucide-icon [img]="ShieldCheck" [size]="15" />
                  </button>
                  <a
                    [routerLink]="['/driver/unlock']"
                    [queryParams]="{ vehicleId: v.id }"
                    class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-tracky/20 text-tracky-light border border-tracky/30"
                  >
                    <lucide-icon [img]="Unlock" [size]="14" /> Déverrouiller
                  </a>
                </div>
              </div>
            }
          </div>
        }
      </main>

      @if (privacyFor(); as pv) {
        <app-driver-privacy-panel [vehicleId]="pv.id" [plate]="pv.plate" (close)="privacyFor.set(null)"></app-driver-privacy-panel>
      }
    </div>
  `,
})
export class DriverHomeComponent implements OnInit {
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  /** Véhicule dont on ouvre le panneau « Vie privée & horaires » (overlay). */
  protected readonly privacyFor = signal<VehicleDetailDto | null>(null);

  protected readonly Car = Car;
  protected readonly LogOut = LogOut;
  protected readonly Unlock = Unlock;
  protected readonly ShieldCheck = ShieldCheck;

  protected email(): string {
    return this.auth.user()?.email ?? '';
  }

  ngOnInit(): void {
    this.vehiclesApi
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (v) => {
          this.vehicles.set(v ?? []);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  protected logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
