import { Component, EventEmitter, Output, OnInit, inject, computed, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  LucideAngularModule,
  Menu, Maximize2, Bell, UserCircle2,
  Car, Power, Crosshair, Satellite, Search, ChevronRight,
} from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
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
  imports: [LucideAngularModule],
  template: `
    <div class="bn-overlay">

      <!-- TOP-LEFT : burger + recentrer + alertes -->
      <div class="bn-top-left">
        <button class="bn-circle" (click)="menuClick.emit()" aria-label="Menu">
          <lucide-icon [img]="MenuIcon" [size]="22"></lucide-icon>
        </button>
        <button class="bn-circle" (click)="recenterClick.emit()" aria-label="Recentrer">
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

      <!-- RIGHT VERTICAL : vehicules, coupe-circuit, GPS, satellite -->
      <div class="bn-right">
        <button class="bn-circle bn-color-blue" (click)="togglePanel()" aria-label="Vehicules" [class.active]="panelOpen()">
          <lucide-icon [img]="CarIcon" [size]="20"></lucide-icon>
        </button>
        <button class="bn-circle bn-color-red" (click)="engineClick.emit()" aria-label="Coupe-circuit moteur">
          <lucide-icon [img]="PowerIcon" [size]="20"></lucide-icon>
        </button>
        <button class="bn-circle" (click)="locateClick.emit()" aria-label="Ma position">
          <lucide-icon [img]="CrosshairIcon" [size]="20"></lucide-icon>
        </button>
        <button class="bn-circle" (click)="satelliteClick.emit()" aria-label="Vue satellite">
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
          <div class="bn-panel-groups">
            @if (groups().length === 0) {
              <div class="bn-group-row bn-group-row--default">
                <span>Groupes par defaut({{ filteredCount() }})</span>
                <lucide-icon [img]="ChevronRightIcon" [size]="16"></lucide-icon>
              </div>
            } @else {
              @for (g of groups(); track g.id) {
                <button class="bn-group-row" (click)="groupClick.emit(g.id)">
                  <span>{{ g.name }}({{ g.vehicles.length }})</span>
                  <lucide-icon [img]="ChevronRightIcon" [size]="16"></lucide-icon>
                </button>
              }
            }
          </div>
        </div>
      }

    </div>
  `,
  styles: [`
    /* Overlay couvre toute la fenetre mais ne bloque pas la map (pointer-events: none).
       Les enfants interactifs reactivent pointer-events: auto. */
    .bn-overlay {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 7500;
    }
    .bn-overlay > * { pointer-events: auto; }

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

    /* Cluster top-left horizontal : 3 cercles cote-a-cote. */
    .bn-top-left {
      position: absolute;
      top: calc(12px + env(safe-area-inset-top));
      left: 12px;
      display: flex;
      gap: 8px;
    }
    .bn-top-right {
      position: absolute;
      top: calc(12px + env(safe-area-inset-top));
      right: 12px;
    }
    .bn-right {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    /* Panel central blanc : flotte sous la top-bar, max-width pour pas etaler sur desktop. */
    .bn-panel {
      position: absolute;
      top: calc(72px + env(safe-area-inset-top));
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
    .bn-panel-groups {
      overflow-y: auto;
      padding: 4px 0;
    }
    .bn-group-row {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      background: white;
      border: none;
      border-radius: 8px;
      margin: 4px 8px;
      cursor: pointer;
      color: #333;
      font-size: 14px;
    }
    .bn-group-row:hover { background: #f8f8f8; }
    .bn-group-row--default {
      cursor: default;
      color: #333;
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

  @Output() menuClick = new EventEmitter<void>();
  @Output() recenterClick = new EventEmitter<void>();
  @Output() locateClick = new EventEmitter<void>();
  @Output() satelliteClick = new EventEmitter<void>();
  @Output() engineClick = new EventEmitter<void>();
  @Output() groupClick = new EventEmitter<string>();

  // Icons
  protected readonly MenuIcon = Menu;
  protected readonly MaximizeIcon = Maximize2;
  protected readonly BellIcon = Bell;
  protected readonly UserIcon = UserCircle2;
  protected readonly CarIcon = Car;
  protected readonly PowerIcon = Power;
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
