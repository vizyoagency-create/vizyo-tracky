import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Car, Eye, LogOut, LucideAngularModule, ShieldCheck, Unlock } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { AuthService } from '../../core/services/auth.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { DriverPrivacyPanelComponent } from './driver-privacy-panel.component';

/**
 * Espace dépôt (2026-08) — une mission telle que son CONDUCTEUR la voit.
 * `depotWatching` est décidé côté serveur : c'est une obligation d'information, elle ne
 * doit pas dépendre d'un calcul côté client qu'on pourrait retirer par mégarde.
 */
interface MissionConducteur {
  id: string;
  ref: string;
  origin: string;
  destination: string;
  startAt: string;
  endAt: string;
  plate: string;
  depotWatching: boolean;
}

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
        <!-- Espace dépôt (2026-08) — la mission du jour, avec sa mention d'information.
             Placée AVANT la liste des véhicules : c'est ce qui structure la journée du
             conducteur, et la mention doit être vue sans avoir à faire défiler. -->
        @for (m of missions(); track m.id) {
          <article class="mb-3 rounded-[14px] border border-border-subtle bg-bg-secondary p-3.5">
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono text-[11px] font-semibold text-fg-tertiary">{{ m.ref }}</span>
              <span class="text-[11px] font-semibold text-fg-secondary">{{ heure(m.startAt) }} → {{ heure(m.endAt) }}</span>
            </div>
            <p class="mt-1 text-sm font-semibold leading-snug">{{ m.origin }} → {{ m.destination }}</p>
            <p class="mt-0.5 font-mono text-[11px] text-fg-tertiary">{{ m.plate }}</p>

            @if (m.depotWatching) {
              <!-- ⚠️ OBLIGATION D'INFORMATION, pas une politesse : le conducteur doit
                   savoir qu'un tiers voit sa position pendant la mission. C'est la
                   condition de conformité du dispositif (A2 § 3.4). Le drapeau est
                   décidé côté serveur — ce bloc ne fait que le rendre visible. -->
              <p class="mt-2.5 flex items-start gap-2 rounded-[10px] px-2.5 py-2 text-[11.5px] leading-relaxed"
                 style="background: color-mix(in srgb, var(--violet) 12%, transparent); color: var(--violet)">
                <lucide-icon [img]="Eye" [size]="14" class="mt-px shrink-0" />
                <span>Le dépôt destinataire suit la position de ce véhicule pendant le créneau de la mission.</span>
              </p>
            }
          </article>
        }

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
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  /** Véhicule dont on ouvre le panneau « Vie privée & horaires » (overlay). */
  protected readonly privacyFor = signal<VehicleDetailDto | null>(null);

  /** Espace dépôt (2026-08) — les missions du jour de ce conducteur. */
  protected readonly missions = signal<MissionConducteur[]>([]);

  protected readonly Car = Car;
  protected readonly LogOut = LogOut;
  protected readonly Unlock = Unlock;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly Eye = Eye;

  protected email(): string {
    return this.auth.user()?.email ?? '';
  }

  protected heure(iso: string): string {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
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

    // Les missions ne bloquent PAS l'écran : un échec laisse la liste vide et le
    // conducteur garde ses véhicules. Le bandeau d'information n'apparaît que s'il y a
    // réellement une mission suivie.
    this.http
      .get<MissionConducteur[]>('/api/missions/mine')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (m) => this.missions.set(m ?? []),
        error: (err) => swallow('driver-home:missions', err),
      });
  }

  protected logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
