import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  LucideAngularModule, Fuel, MapPin, ParkingSquare, Check, Trash2, RefreshCw, AlertTriangle, Info,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  FleetPlacesApiService,
  type FleetPlaceDto,
  type FleetPlaceKind,
  type StationPassageDto,
} from '../../core/services/fleet-places.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { SpinnerComponent } from '../../shared/ui/spinner/spinner.component';

/**
 * « Lieux clés » — page de gestion du référentiel des lieux de la flotte.
 *
 * Deux matières :
 *  1. les PASSAGES en station-service détectés avec un VRAI arrêt (≥ 4 min) — l'exploitant y
 *     valide les stations qu'il retient (« Ajouter aux lieux ») → couleur dédiée sur la carte ;
 *  2. les LIEUX de la flotte : stations validées + parkings / stationnements récurrents posés
 *     à la main sur la carte (ex. « CDEF Launaguet »).
 *
 * Lecture = `places_view`, écriture = `places_manage` (managers inclus par défaut).
 */
@Component({
  selector: 'app-places',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RouterLink, LucideAngularModule, SpinnerComponent],
  template: `
    <div class="lk-page">
      <header class="lk-head">
        <div>
          <h1 class="lk-title">Lieux clés</h1>
          <p class="lk-sub">
            Stations-service fréquentées et parkings / stationnements récurrents de la flotte.
          </p>
        </div>
        <button type="button" class="lk-refresh" [disabled]="loading()" (click)="reload()">
          <lucide-icon [img]="RefreshIcon" [size]="15"></lucide-icon>
          Actualiser
        </button>
      </header>

      @if (error(); as e) {
        <div class="lk-error">
          <lucide-icon [img]="AlertIcon" [size]="15"></lucide-icon>
          <span>{{ e }}</span>
        </div>
      }

      <!-- ─── Lieux de la flotte ─── -->
      <section class="lk-card">
        <div class="lk-card-head">
          <span class="lk-card-title">
            <lucide-icon [img]="ParkingIcon" [size]="15"></lucide-icon>
            Lieux de la flotte
          </span>
          <span class="lk-count">{{ places().length }}</span>
        </div>

        <p class="lk-help">
          Les stations que vous validez et les parkings que vous posez apparaissent avec une couleur
          dédiée sur la carte. Pour créer un parking, utilisez l'outil
          <strong>« Poser un lieu »</strong> depuis la <a routerLink="/map" class="lk-link">carte</a>.
        </p>

        @if (loading() && places().length === 0) {
          <div class="lk-loading"><app-spinner [size]="20" /></div>
        } @else if (places().length === 0) {
          <div class="lk-empty">
            <lucide-icon [img]="MapPinIcon" [size]="26" class="lk-empty-icon"></lucide-icon>
            <p>Aucun lieu enregistré</p>
            <span>Validez une station ci-dessous, ou posez un parking depuis la carte.</span>
          </div>
        } @else {
          <ul class="lk-list">
            @for (p of places(); track p.id) {
              <li class="lk-item">
                <span class="lk-kind" [attr.data-k]="p.kind">{{ kindLabel(p.kind) }}</span>
                <div class="lk-item-main">
                  <strong class="lk-item-name">{{ p.name }}</strong>
                  <span class="lk-item-meta">
                    {{ p.lat | number: '1.4-4' }}, {{ p.lng | number: '1.4-4' }} · rayon {{ p.radiusM }} m
                    @if (p.note) { · {{ p.note }} }
                  </span>
                </div>
                @if (canManage()) {
                  <button
                    type="button"
                    class="lk-btn lk-btn--danger"
                    [disabled]="busyId() === p.id"
                    (click)="removePlace(p)"
                    title="Retirer ce lieu"
                  >
                    <lucide-icon [img]="TrashIcon" [size]="13"></lucide-icon>
                  </button>
                }
              </li>
            }
          </ul>
        }
      </section>

      <!-- ─── Passages station-service ─── -->
      <section class="lk-card">
        <div class="lk-card-head">
          <span class="lk-card-title">
            <lucide-icon [img]="FuelIcon" [size]="15"></lucide-icon>
            Passages en station-service
          </span>
          <span class="lk-count">{{ passages().length }}</span>
        </div>

        <p class="lk-help">
          <lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon>
          Seuls les passages avec un <strong>arrêt réel d'au moins {{ minStopMin }} minutes</strong> à
          moins de 160 m d'une station sont listés — un simple ralentissement en passant devant une
          station n'est jamais compté.
        </p>

        @if (loading() && passages().length === 0) {
          <div class="lk-loading"><app-spinner [size]="20" /></div>
        } @else if (passages().length === 0) {
          <div class="lk-empty">
            <lucide-icon [img]="FuelIcon" [size]="26" class="lk-empty-icon"></lucide-icon>
            <p>Aucun passage sur la période</p>
            <span>Les passages apparaissent quand un trajet analysé s'arrête à une station.</span>
          </div>
        } @else {
          <ul class="lk-list">
            @for (s of passages(); track s.id) {
              <li class="lk-item">
                <div class="lk-item-main">
                  <div class="lk-item-line">
                    <strong class="lk-item-name">{{ s.brand || s.name || 'Station-service' }}</strong>
                    @if (s.validated) {
                      <span class="lk-badge lk-badge--ok">Lieu de la flotte</span>
                    }
                  </div>
                  <span class="lk-item-meta">
                    {{ s.plate || 'Véhicule' }} · {{ s.at | date: 'dd/MM HH:mm' }} ·
                    arrêt {{ s.durationMin }} min · à {{ s.distanceM }} m
                    @if (s.city) { · {{ s.city }} }
                    @if (s.priceEur != null) { · {{ s.priceEur | number: '1.3-3' }} €/L }
                  </span>
                </div>
                @if (canManage() && !s.validated) {
                  <button
                    type="button"
                    class="lk-btn lk-btn--ok"
                    [disabled]="busyId() === s.stationId"
                    (click)="validateStation(s)"
                  >
                    <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon>
                    Ajouter aux lieux
                  </button>
                }
              </li>
            }
          </ul>
        }
      </section>
    </div>
  `,
  styles: [`
    .lk-page { display: flex; flex-direction: column; gap: 16px; padding: 18px; max-width: 1100px; margin: 0 auto; }
    .lk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .lk-title { margin: 0; font-size: 22px; font-weight: 800; color: var(--fg-primary); }
    .lk-sub { margin: 3px 0 0; font-size: 12.5px; color: var(--fg-tertiary); }
    .lk-refresh { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 10px; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-secondary); font-size: 12px; font-weight: 600; cursor: pointer; }
    .lk-refresh:disabled { opacity: .5; cursor: wait; }
    .lk-error { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 10px; background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.3); color: var(--danger); font-size: 12.5px; }
    .lk-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .lk-card-head { display: flex; align-items: center; justify-content: space-between; }
    .lk-card-title { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .lk-card-title lucide-icon { color: #A78BFA; }
    .lk-count { padding: 1px 9px; border-radius: 999px; background: color-mix(in srgb, var(--fg-tertiary) 16%, transparent); color: var(--fg-secondary); font-size: 11px; font-weight: 700; }
    .lk-help { margin: 0; display: flex; align-items: baseline; gap: 5px; font-size: 11.5px; line-height: 1.5; color: var(--fg-tertiary); }
    .lk-help strong { color: var(--fg-secondary); }
    .lk-link { color: var(--tracky-light); text-decoration: underline; }
    .lk-loading { display: flex; justify-content: center; padding: 18px; }
    .lk-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 5px; padding: 20px 10px; color: var(--fg-tertiary); }
    .lk-empty p { margin: 0; font-weight: 700; color: var(--fg-secondary); }
    .lk-empty span { font-size: 11.5px; max-width: 380px; }
    .lk-empty-icon { opacity: .3; }
    .lk-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
    .lk-item { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 11px; border-radius: 10px; background: var(--bg-tertiary, rgba(148,163,184,.07)); border: 1px solid var(--border-subtle); }
    .lk-item-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .lk-item-line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .lk-item-name { color: var(--fg-primary); font-size: 13px; font-weight: 700; }
    .lk-item-meta { color: var(--fg-tertiary); font-size: 11.5px; }
    .lk-kind { padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; background: color-mix(in srgb, var(--fg-tertiary) 16%, transparent); color: var(--fg-secondary); flex-shrink: 0; }
    .lk-kind[data-k='FUEL_STATION'] { background: color-mix(in srgb, #A78BFA 22%, transparent); color: #A78BFA; }
    .lk-kind[data-k='PARKING'] { background: color-mix(in srgb, #0ea5e9 22%, transparent); color: #0ea5e9; }
    .lk-kind[data-k='DEPOT'] { background: color-mix(in srgb, var(--tracky-light) 22%, transparent); color: var(--tracky-light); }
    .lk-badge { padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; }
    .lk-badge--ok { background: color-mix(in srgb, var(--tracky-light) 20%, transparent); color: var(--tracky-light); }
    .lk-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 9px; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-secondary); font-size: 11.5px; font-weight: 600; cursor: pointer; }
    .lk-btn:disabled { opacity: .5; cursor: wait; }
    .lk-btn--ok { border-color: color-mix(in srgb, var(--tracky-light) 45%, var(--border-strong)); color: var(--tracky-light); }
    .lk-btn--danger { border-color: color-mix(in srgb, #ef4444 40%, var(--border-strong)); color: var(--danger); }
  `],
})
export class PlacesComponent {
  private readonly api = inject(FleetPlacesApiService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  protected readonly FuelIcon = Fuel;
  protected readonly MapPinIcon = MapPin;
  protected readonly ParkingIcon = ParkingSquare;
  protected readonly CheckIcon = Check;
  protected readonly TrashIcon = Trash2;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly InfoIcon = Info;

  /** Seuil d'arrêt réel (min) — aligné sur la détection serveur. */
  protected readonly minStopMin = 4;

  protected readonly places = signal<FleetPlaceDto[]>([]);
  protected readonly passages = signal<StationPassageDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** Id (lieu ou station) en cours d'écriture — désactive le bouton concerné. */
  protected readonly busyId = signal<string | null>(null);

  protected readonly canManage = computed(() => this.perms.can('places_manage'));

  constructor() {
    // Recharge au changement de société (sélecteur super-admin).
    effect(() => {
      this.fleetFilter.selectedFleetId();
      void this.load();
    });
  }

  protected reload(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const fleetId = this.fleetFilter.selectedFleetId() ?? undefined;
    try {
      const [places, passages] = await Promise.all([
        firstValueFrom(this.api.list(fleetId)),
        firstValueFrom(this.api.stationPassages({ fleetId, minStopMin: this.minStopMin })),
      ]);
      this.places.set(places);
      this.passages.set(passages);
    } catch {
      // L'erreur détaillée part déjà au centre d'alerte via l'intercepteur HTTP ; ici on
      // informe l'utilisateur sans laisser la page vide et muette.
      this.error.set('Impossible de charger les lieux clés. Réessayez ou contactez le support.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Valide une station détectée → elle devient un lieu de la flotte (couleur dédiée sur la carte). */
  protected async validateStation(s: StationPassageDto): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(s.stationId);
    try {
      const name = [s.brand || s.name || 'Station-service', s.city].filter(Boolean).join(' — ');
      const created = await firstValueFrom(
        this.api.create({
          name,
          kind: 'FUEL_STATION',
          lat: s.lat,
          lng: s.lng,
          stationId: s.stationId,
          fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
        }),
      );
      this.places.update((list) => [...list, created]);
      // Marque tous les passages de cette station comme validés (sans recharger).
      this.passages.update((list) =>
        list.map((p) => (p.stationId === s.stationId ? { ...p, validated: true } : p)),
      );
      this.toast.success('Station ajoutée aux lieux de la flotte');
    } catch {
      this.toast.error("Impossible d'ajouter cette station");
    } finally {
      this.busyId.set(null);
    }
  }

  /** Retire un lieu (dévalide une station, ou efface un parking posé à la main). */
  protected async removePlace(p: FleetPlaceDto): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(p.id);
    try {
      await firstValueFrom(this.api.remove(p.id));
      this.places.update((list) => list.filter((x) => x.id !== p.id));
      if (p.stationId) {
        this.passages.update((list) =>
          list.map((s) => (s.stationId === p.stationId ? { ...s, validated: false } : s)),
        );
      }
      this.toast.success('Lieu retiré');
    } catch {
      this.toast.error('Impossible de retirer ce lieu');
    } finally {
      this.busyId.set(null);
    }
  }

  protected kindLabel(k: FleetPlaceKind): string {
    switch (k) {
      case 'FUEL_STATION': return 'Station';
      case 'PARKING': return 'Parking';
      case 'DEPOT': return 'Dépôt';
      default: return 'Lieu';
    }
  }
}
