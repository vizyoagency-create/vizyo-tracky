import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule, Fuel, MapPin, ParkingSquare, Check, Trash2, RefreshCw, AlertTriangle, Info,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  FleetPlacesApiService,
  type FleetPlaceDto,
  type FleetPlaceKind,
  type StationGroupDto,
  type PlaceFactsDto,
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
                <button type="button" class="lk-btn" (click)="toggleFacts(p)">
                  <lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon>
                  {{ expandedPlaceId() === p.id ? 'Masquer' : 'Infos' }}
                </button>
                <button type="button" class="lk-btn" (click)="showOnMap(p.lat, p.lng)" title="Voir sur la carte">
                  <lucide-icon [img]="MapPinIcon" [size]="13"></lucide-icon>
                </button>
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

                <!-- Infos réelles du lieu (OpenStreetMap) — gratuites, jamais inventées. -->
                @if (expandedPlaceId() === p.id) {
                  <div class="lk-facts">
                    @if (factsLoadingId() === p.id) {
                      <div class="lk-loading"><app-spinner [size]="16" /></div>
                    } @else if (factsOf(p.id); as f) {
                      <div class="lk-facts-body">
                        @if (f.imageUrl) {
                          <img class="lk-facts-img" [src]="f.imageUrl" alt="" loading="lazy" />
                        }
                        <div class="lk-facts-cols">
                          @if (f.name || f.brand) {
                            <div class="lk-fact"><span>Enseigne</span><b>{{ f.brand || f.name }}</b></div>
                          }
                          @if (f.openingHours) {
                            <div class="lk-fact"><span>Horaires</span><b>{{ f.openingHours }}</b></div>
                          }
                          @if (f.phone) {
                            <div class="lk-fact"><span>Téléphone</span><b>{{ f.phone }}</b></div>
                          }
                          @if (f.address) {
                            <div class="lk-fact"><span>Adresse</span><b>{{ f.address }}</b></div>
                          }
                          @if (f.parking?.capacity != null) {
                            <div class="lk-fact"><span>Capacité</span><b>{{ f.parking!.capacity }} places</b></div>
                          }
                          @if (f.website) {
                            <div class="lk-fact">
                              <span>Site</span>
                              <a class="lk-link" [href]="f.website" target="_blank" rel="noopener noreferrer">ouvrir</a>
                            </div>
                          }
                        </div>
                        @if (f.services.length || f.fuels.length || f.payment.length) {
                          <div class="lk-chips">
                            @for (s of f.services; track s) { <span class="lk-chip lk-chip--svc">{{ s }}</span> }
                            @for (s of f.fuels; track s) { <span class="lk-chip lk-chip--fuel">{{ s }}</span> }
                            @for (s of f.payment; track s) { <span class="lk-chip">{{ s }}</span> }
                          </div>
                        }
                        <p class="lk-facts-src">Source : OpenStreetMap (contributif, gratuit)</p>
                      </div>
                    } @else {
                      <p class="lk-facts-empty">
                        Aucune information cartographiée pour ce lieu (OpenStreetMap ne le référence pas
                        encore, ou le service est momentanément indisponible).
                      </p>
                    }
                  </div>
                }
              </li>
            }
          </ul>
        }
      </section>

      <!-- ─── Stations-service REGROUPÉES (une ligne par lieu, pas par passage) ─── -->
      <section class="lk-card">
        <div class="lk-card-head">
          <span class="lk-card-title">
            <lucide-icon [img]="FuelIcon" [size]="15"></lucide-icon>
            Stations-service fréquentées
          </span>
          <span class="lk-count">{{ stations().length }}</span>
        </div>

        <p class="lk-help">
          <lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon>
          Une ligne par station — avec qui s'y est arrêté et combien de fois. Seuls les
          <strong>arrêts réels d'au moins {{ minStopMin }} minutes</strong> à moins de 160 m d'une
          station sont comptés — un simple ralentissement devant une station ne l'est jamais.
        </p>

        @if (loading() && stations().length === 0) {
          <div class="lk-loading"><app-spinner [size]="20" /></div>
        } @else if (stations().length === 0) {
          <div class="lk-empty">
            <lucide-icon [img]="FuelIcon" [size]="26" class="lk-empty-icon"></lucide-icon>
            <p>Aucune station fréquentée sur la période</p>
            <span>Une station apparaît dès qu'un trajet analysé s'y arrête réellement.</span>
          </div>
        } @else {
          <ul class="lk-list">
            @for (s of stations(); track s.stationId) {
              <li class="lk-item">
                <div class="lk-item-main">
                  <div class="lk-item-line">
                    <strong class="lk-item-name">{{ s.label }}</strong>
                    @if (s.placeId) {
                      <span class="lk-badge lk-badge--ok">Lieu de la flotte</span>
                    }
                  </div>
                  <span class="lk-item-meta">
                    <b>{{ s.passages }}</b> passage{{ s.passages > 1 ? 's' : '' }} ·
                    <b>{{ s.distinctVehicles }}</b> véhicule{{ s.distinctVehicles > 1 ? 's' : '' }} ·
                    arrêt moy. {{ s.avgStopMin }} min · dernier {{ s.lastAt | date: 'dd/MM' }}
                    @if (s.lastPriceEur != null) { · {{ s.lastPriceEur | number: '1.3-3' }} €/L }
                  </span>
                  <!-- QUI est passé et COMBIEN DE FOIS (la demande client). -->
                  <div class="lk-vehicles">
                    @for (v of s.vehicles; track v.vehicleId) {
                      <span class="lk-veh"><b>{{ v.plate || 'véhicule' }}</b> {{ v.visits }}×</span>
                    }
                  </div>
                </div>
                <button type="button" class="lk-btn" (click)="showOnMap(s.lat, s.lng)" title="Voir sur la carte">
                  <lucide-icon [img]="MapPinIcon" [size]="13"></lucide-icon>
                </button>
                @if (canManage() && !s.placeId) {
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
    .lk-item-meta b { color: var(--fg-secondary); }
    /* Infos OSM dépliées : occupe toute la largeur de l'item (flex-wrap). */
    .lk-facts { flex-basis: 100%; margin-top: 8px; padding-top: 9px; border-top: 1px solid var(--border-subtle); }
    .lk-facts-body { display: flex; flex-direction: column; gap: 8px; }
    .lk-facts-img { width: 100%; max-width: 320px; border-radius: 10px; border: 1px solid var(--border-subtle); }
    .lk-facts-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 6px 14px; }
    .lk-fact { display: flex; flex-direction: column; gap: 1px; font-size: 12px; }
    .lk-fact span { color: var(--fg-tertiary); font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; }
    .lk-fact b { color: var(--fg-primary); font-weight: 600; }
    .lk-chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .lk-chip { padding: 2px 9px; border-radius: 999px; font-size: 11px; background: color-mix(in srgb, var(--fg-tertiary) 15%, transparent); color: var(--fg-secondary); }
    .lk-chip--svc { background: color-mix(in srgb, var(--tracky-light) 18%, transparent); color: var(--tracky-light); }
    .lk-chip--fuel { background: color-mix(in srgb, #A78BFA 20%, transparent); color: #A78BFA; }
    .lk-facts-src { margin: 0; font-size: 10.5px; color: var(--fg-tertiary); font-style: italic; }
    .lk-facts-empty { margin: 0; font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; }
    .lk-vehicles { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
    .lk-veh { padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, #A78BFA 14%, transparent); color: var(--fg-secondary); font-size: 11px; }
    .lk-veh b { color: var(--fg-primary); font-weight: 700; }
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
  private readonly router = inject(Router);

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
  /** Stations REGROUPÉES (une entrée par lieu, pas une par passage). */
  protected readonly stations = signal<StationGroupDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** Id (lieu ou station) en cours d'écriture — désactive le bouton concerné. */
  protected readonly busyId = signal<string | null>(null);

  /**
   * Faits OSM par lieu (horaires, services, contact…), chargés À LA DEMANDE au dépliage :
   * Overpass est un service communautaire, on ne le sollicite pas pour des lieux non consultés.
   */
  protected readonly factsByPlace = signal<Record<string, PlaceFactsDto | null>>({});
  protected readonly factsLoadingId = signal<string | null>(null);
  protected readonly expandedPlaceId = signal<string | null>(null);

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
      const [places, stations] = await Promise.all([
        firstValueFrom(this.api.list(fleetId)),
        firstValueFrom(this.api.stationGroups({ fleetId, minStopMin: this.minStopMin })),
      ]);
      this.places.set(places);
      this.stations.set(stations);
    } catch {
      // L'erreur détaillée part déjà au centre d'alerte via l'intercepteur HTTP ; ici on
      // informe l'utilisateur sans laisser la page vide et muette.
      this.error.set('Impossible de charger les lieux clés. Réessayez ou contactez le support.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Valide une station détectée → elle devient un lieu de la flotte (couleur dédiée sur la carte). */
  protected async validateStation(s: StationGroupDto): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(s.stationId);
    try {
      const created = await firstValueFrom(
        this.api.create({
          name: s.label.slice(0, 120),
          kind: 'FUEL_STATION',
          lat: s.lat,
          lng: s.lng,
          stationId: s.stationId,
          fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
        }),
      );
      this.places.update((list) => [...list, created]);
      // La station devient un lieu de la flotte (une seule ligne à mettre à jour : c'est groupé).
      this.stations.update((list) =>
        list.map((x) => (x.stationId === s.stationId ? { ...x, placeId: created.id, placeName: created.name } : x)),
      );
      this.toast.success('Station ajoutée aux lieux de la flotte', created.name);
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
        this.stations.update((list) =>
          list.map((s) => (s.stationId === p.stationId ? { ...s, placeId: null, placeName: null } : s)),
        );
      }
      this.toast.success('Lieu retiré');
    } catch {
      this.toast.error('Impossible de retirer ce lieu');
    } finally {
      this.busyId.set(null);
    }
  }

  /**
   * Déplie/replie les infos d'un lieu. Le chargement OSM est fait UNE SEULE FOIS par lieu et
   * mémorisé (y compris le résultat « rien trouvé ») pour ne pas re-solliciter Overpass.
   */
  protected async toggleFacts(p: FleetPlaceDto): Promise<void> {
    if (this.expandedPlaceId() === p.id) {
      this.expandedPlaceId.set(null);
      return;
    }
    this.expandedPlaceId.set(p.id);
    if (p.id in this.factsByPlace()) return; // déjà chargé (même si null)
    this.factsLoadingId.set(p.id);
    try {
      const facts = await firstValueFrom(this.api.facts(p.id));
      this.factsByPlace.update((m) => ({ ...m, [p.id]: facts }));
    } catch {
      // Overpass indisponible : on mémorise « rien » pour ne pas boucler, l'UI l'explique.
      this.factsByPlace.update((m) => ({ ...m, [p.id]: null }));
    } finally {
      this.factsLoadingId.set(null);
    }
  }

  /** Faits déjà chargés pour un lieu (undefined = jamais demandé, null = rien trouvé). */
  protected factsOf(id: string): PlaceFactsDto | null | undefined {
    return this.factsByPlace()[id];
  }

  /**
   * Connexion page → carte : ouvre la carte CENTRÉE sur le repère (la carte lit `lat/lng/zoom`
   * depuis l'URL via `restoreFromUrl`), pour passer de la liste au terrain en un clic.
   */
  protected showOnMap(lat: number, lng: number): void {
    void this.router.navigate(['/map'], { queryParams: { lat, lng, zoom: 17 } });
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
