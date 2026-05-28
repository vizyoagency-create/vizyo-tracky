import { Component, EventEmitter, Output, OnInit, inject, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import {
  LucideAngularModule,
  Menu, Maximize2, Bell, UserCircle2,
  Car, Crosshair, Satellite, Search, ChevronRight,
} from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { MapBridgeService } from '../../core/services/map-bridge.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { VehicleGroupsService, type VehicleGroup } from '../../core/services/vehicle-groups.service';

/**
 * V1.12 — Overlay UI style Baanool pour la page /map en mode 'baanool'.
 *
 * Reproduit fidelement le look Baanool :
 * - Top-left : 3 boutons cercles (burger, recentrer, alertes)
 * - Top-right : 1 bouton cercle profile
 * - Right vertical : boutons cercles (vehicules, coupe-circuit, GPS, satellite)
 * - Panel central blanc flottant (toggleable) : search + tabs + groupes
 *
 * Inclus dans dashboard-layout via @if (isBaanoolMode() && route === '/map').
 * Tous les inputs sont en pointer-events: auto pour permettre les clics, mais
 * l'overlay lui-meme est en pointer-events: none pour ne pas bloquer la map.
 */
@Component({
  selector: 'app-baanool-map-overlay',
  standalone: true,
  imports: [LucideAngularModule, DecimalPipe],
  template: `
      <!-- TOP-LEFT : burger + recentrer + alertes -->
      <div class="bn-top-left">
        <button class="bn-circle" (click)="menuClick.emit()" aria-label="Menu">
          <lucide-icon [img]="MenuIcon" [size]="22"></lucide-icon>
        </button>
        <button class="bn-circle" (click)="mapBridge.requestRecenter()" aria-label="Recentrer">
          <lucide-icon [img]="MaximizeIcon" [size]="22"></lucide-icon>
        </button>
        <button class="bn-circle" (click)="goAlerts()" aria-label="Alertes">
          <lucide-icon [img]="BellIcon" [size]="22"></lucide-icon>
          @if (unreadCount() > 0) {
            <span class="bn-badge">{{ unreadCount() }}</span>
          }
        </button>
      </div>

      <!-- TOP-RIGHT : profile -->
      <div class="bn-top-right">
        <button class="bn-circle bn-circle--empty" (click)="goAccount()" aria-label="Mon compte">
          <lucide-icon [img]="UserIcon" [size]="22"></lucide-icon>
        </button>
      </div>

      <!-- RIGHT VERTICAL : vehicules, GPS, satellite (coupe-circuit retire :
           l'action est deja accessible via popup au click vehicule sur la map). -->
      <div class="bn-right">
        <button class="bn-circle bn-color-blue" (click)="togglePanel()" aria-label="Vehicules" [class.active]="panelOpen()">
          <lucide-icon [img]="CarIcon" [size]="20"></lucide-icon>
        </button>
        <button class="bn-circle" (click)="mapBridge.requestLocate()" aria-label="Ma position">
          <lucide-icon [img]="CrosshairIcon" [size]="20"></lucide-icon>
        </button>
        <button class="bn-circle" (click)="mapBridge.requestToggleSatellite()" aria-label="Vue satellite">
          <lucide-icon [img]="SatelliteIcon" [size]="20"></lucide-icon>
        </button>
      </div>

      <!-- CENTRAL PANEL (toggleable) -->
      @if (panelOpen()) {
        <div class="bn-panel" role="dialog" aria-label="Liste des vehicules">
          <div class="bn-panel-search">
            <lucide-icon [img]="SearchIcon" [size]="16"></lucide-icon>
            <input
              type="search"
              placeholder="Numero d'appareil/plaque d'i..."
              [value]="searchQuery()"
              (input)="onSearch($event)"
            />
          </div>
          <div class="bn-panel-tabs">
            @for (t of tabs; track t.key) {
              <button class="bn-tab" [class.active]="activeTab() === t.key" (click)="activeTab.set(t.key)">
                {{ t.label }}({{ counts()[t.key] }})
              </button>
            }
          </div>
          <div class="bn-panel-vehicles">
            @if (filteredVehicles().length === 0) {
              <div class="bn-vehicle-empty">
                Aucun vehicule
              </div>
            } @else {
              @for (v of filteredVehicles(); track v.vehicleId) {
                <button class="bn-vehicle-row" (click)="onVehicleClick(v.vehicleId)">
                  <span class="bn-vehicle-dot" [class.online]="isOnline(v)"></span>
                  <div class="bn-vehicle-main">
                    <div class="bn-vehicle-plate">{{ v.plate || '—' }}</div>
                    <div class="bn-vehicle-meta">
                      @if (isOnline(v)) {
                        {{ v.speedKmh | number: '1.0-0' }} km/h
                      } @else {
                        Hors ligne
                      }
                    </div>
                  </div>
                  <lucide-icon [img]="ChevronRightIcon" [size]="16"></lucide-icon>
                </button>
              }
            }
          </div>
        </div>
      }
  `,
  styles: [`
    /* V1.12 — Overlay Baanool.
       Pas de conteneur intermediaire, pas de display:contents (buggé iOS Safari),
       pas de pointer-events:none. Chaque cluster est position:fixed directement.
       Le :host Angular est un simple block sans dimensions qui ne bloque rien. */
    :host {
      display: block;
      position: fixed;
      top: 0; left: 0;
      width: 0; height: 0;
      overflow: visible;
      z-index: 7500;
    }
    button {
      -webkit-touch-callout: none;
      touch-action: manipulation;
    }

    /* Cercle de base : fond blanc, ombre douce, taille tap target Apple HIG. */
    .bn-circle {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: white;
      border: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: #333;
      position: relative;
      transition: transform 120ms;
    }
    .bn-circle:active { transform: scale(0.92); }
    .bn-circle.active { box-shadow: 0 0 0 3px rgba(66, 133, 244, 0.4), 0 4px 12px rgba(0, 0, 0, 0.15); }
    .bn-circle--empty { background: rgba(255, 255, 255, 0.95); }
    .bn-color-blue { background: #4285f4; color: white; }
    .bn-color-red { background: #ea4335; color: white; }

    /* Badge alerte non lue, accroche en haut a droite du cercle. */
    .bn-badge {
      position: absolute;
      top: -4px; right: -4px;
      min-width: 18px; height: 18px;
      padding: 0 4px;
      border-radius: 9999px;
      background: #f59e0b;
      color: white;
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Chaque cluster est position:fixed independamment — pas de conteneur
       intermediaire qui pourrait bloquer les events sur iOS Safari. */
    .bn-top-left {
      position: fixed;
      top: calc(12px + env(safe-area-inset-top));
      left: 12px;
      display: flex;
      gap: 8px;
      z-index: 7500;
      pointer-events: auto;
    }
    .bn-top-right {
      position: fixed;
      top: calc(12px + env(safe-area-inset-top));
      right: 12px;
      z-index: 7500;
      pointer-events: auto;
    }
    .bn-right {
      position: fixed;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      gap: 12px;
      z-index: 7500;
      pointer-events: auto;
    }

    /* Panel central blanc : flotte sous la top-bar, max-width pour pas etaler sur desktop. */
    .bn-panel {
      position: fixed;
      top: calc(72px + env(safe-area-inset-top));
      z-index: 7500;
      left: 12px;
      right: 70px; /* laisse la place pour la bn-top-right */
      max-width: 480px;
      background: white;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
      overflow: hidden;
      max-height: calc(100vh - 200px);
      display: flex;
      flex-direction: column;
    }
    .bn-panel-search {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid #eee;
      color: #999;
    }
    .bn-panel-search input {
      flex: 1;
      border: none;
      outline: none;
      font-size: 14px;
      background: transparent;
      color: #333;
      min-width: 0;
    }
    .bn-panel-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid #eee;
      padding: 0 14px;
    }
    .bn-tab {
      flex: 1;
      padding: 12px 4px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      font-size: 13px;
      color: #666;
      cursor: pointer;
      transition: color 120ms, border-color 120ms;
    }
    .bn-tab.active {
      color: #00c896;
      border-bottom-color: #00c896;
      font-weight: 600;
    }
    .bn-panel-vehicles {
      overflow-y: auto;
      padding: 4px 0;
      max-height: 50vh;
    }
    .bn-vehicle-row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: white;
      border: none;
      cursor: pointer;
      color: #333;
      font-size: 14px;
      border-bottom: 1px solid #f5f5f5;
      text-align: left;
    }
    .bn-vehicle-row:hover { background: #f8f8f8; }
    .bn-vehicle-row:last-child { border-bottom: none; }
    .bn-vehicle-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: #ccc; flex-shrink: 0;
    }
    .bn-vehicle-dot.online { background: #00c896; box-shadow: 0 0 0 3px rgba(0, 200, 150, 0.2); }
    .bn-vehicle-main { flex: 1; min-width: 0; }
    .bn-vehicle-plate { font-weight: 600; font-size: 14px; color: #333; }
    .bn-vehicle-meta { font-size: 12px; color: #999; margin-top: 2px; }
    .bn-vehicle-empty {
      padding: 32px 16px; text-align: center; color: #999; font-size: 13px;
    }

    /* Mobile : compress les espacements et reduce panel padding. */
    @media (max-width: 480px) {
      .bn-circle { width: 40px; height: 40px; }
      .bn-right { gap: 10px; }
      .bn-panel { right: 60px; }
    }
  `],
})
export class BaanoolMapOverlayComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly vehicleGroupsService = inject(VehicleGroupsService);
  protected readonly mapBridge = inject(MapBridgeService);

  @Output() menuClick = new EventEmitter<void>();
  @Output() groupClick = new EventEmitter<string>();

  // Icons
  protected readonly MenuIcon = Menu;
  protected readonly MaximizeIcon = Maximize2;
  protected readonly BellIcon = Bell;
  protected readonly UserIcon = UserCircle2;
  protected readonly CarIcon = Car;
  protected readonly CrosshairIcon = Crosshair;
  protected readonly SatelliteIcon = Satellite;
  protected readonly SearchIcon = Search;
  protected readonly ChevronRightIcon = ChevronRight;

  // Panel state
  protected readonly panelOpen = signal(false);
  protected readonly searchQuery = signal('');
  protected readonly activeTab = signal<'total' | 'online' | 'offline'>('total');
  protected readonly tabs = [
    { key: 'total' as const, label: 'Total' },
    { key: 'online' as const, label: 'En ligne' },
    { key: 'offline' as const, label: 'Hors ligne' },
  ];

  // Data
  protected readonly groups = signal<VehicleGroup[]>([]);
  protected readonly unreadCount = signal(0);

  ngOnInit(): void {
    this.vehicleGroupsService.list()
      .then((g) => this.groups.set(g))
      .catch(() => this.groups.set([]));
  }

  protected readonly counts = computed(() => {
    const positions = this.realtime.positionsList();
    const total = positions.length;
    const now = Date.now();
    const ONLINE_MS = 5 * 60 * 1000; // 5min
    let online = 0;
    for (const p of positions) {
      const ts = p.timestamp ? new Date(p.timestamp).getTime() : 0;
      if (now - ts < ONLINE_MS) online++;
    }
    return { total, online, offline: total - online };
  });

  protected readonly filteredCount = computed(() => {
    const cnt = this.counts();
    const tab = this.activeTab();
    return tab === 'online' ? cnt.online : tab === 'offline' ? cnt.offline : cnt.total;
  });

  /** Liste filtree des vehicules : merge positions (live speed/timestamp) avec
   *  snapshot (plate persistante). Filtres : search query + tab Total/En ligne/Hors ligne. */
  protected readonly filteredVehicles = computed(() => {
    const positions = this.realtime.positionsList();
    const snapshots = this.realtime.snapshot();
    const tab = this.activeTab();
    const q = this.searchQuery().trim().toLowerCase();
    const now = Date.now();
    const ONLINE_MS = 5 * 60 * 1000;

    // Map vehicleId → plate depuis le snapshot
    const plateById = new Map<string, string>();
    for (const s of snapshots) plateById.set(s.vehicleId, s.plate);

    // Enrichir les positions avec plate
    const enriched = positions.map((p) => ({
      vehicleId: p.vehicleId,
      plate: plateById.get(p.vehicleId) ?? '',
      speedKmh: p.speedKmh,
      timestamp: p.timestamp,
    }));

    return enriched.filter((v) => {
      if (q && !v.plate.toLowerCase().includes(q)) return false;
      if (tab === 'total') return true;
      const ts = v.timestamp ? new Date(v.timestamp).getTime() : 0;
      const online = now - ts < ONLINE_MS;
      return tab === 'online' ? online : !online;
    });
  });

  isOnline(v: { timestamp?: string | Date }): boolean {
    const ts = v.timestamp ? new Date(v.timestamp).getTime() : 0;
    return Date.now() - ts < 5 * 60 * 1000;
  }

  onVehicleClick(vehicleId: string): void {
    this.mapBridge.requestFlyToVehicle(vehicleId);
    // Optionnel : fermer le panel apres avoir centre pour montrer la map
    // this.panelOpen.set(false);
  }

  togglePanel(): void {
    this.panelOpen.update(v => !v);
  }

  onSearch(e: Event): void {
    this.searchQuery.set((e.target as HTMLInputElement).value);
  }

  goAlerts(): void {
    void this.router.navigate(['/alerts']);
  }

  goAccount(): void {
    void this.router.navigate(['/account']);
  }
}
