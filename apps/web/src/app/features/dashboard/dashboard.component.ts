import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  Truck, Navigation, Activity, AlertTriangle, Map as MapIcon, Plus,
  FileBarChart, Shield, ChevronRight, Bell, Radio, Gauge, Clock,
  Settings2, X, Check, ArrowRight,
} from 'lucide-angular';
import { LucideAngularModule } from 'lucide-angular';
import { filter, interval, startWith, switchMap, catchError, of, combineLatest } from 'rxjs';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { VehiclesApiService } from '../../core/services/vehicles.service';
import { AlertsApiService } from '../../core/services/alerts.service';
import { PreferencesService, type DashboardWidgetKey } from '../../core/services/preferences.service';
import { MiniMapComponent } from '../../shared/ui/mini-map/mini-map.component';
import { SkeletonComponent } from '../../shared/ui/skeleton/skeleton.component';
import { getVehicleConnectivityState, isAcceptableLiveFix, isInstallationToReview, isTrackerOnline } from '@vizyo/tracky-shared';

interface WidgetMeta {
  key: DashboardWidgetKey;
  label: string;
  description: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, DatePipe, RouterLink, MiniMapComponent, SkeletonComponent],
  template: `
    <div class="dash-page">
      <!-- Background grid -->
      <div class="dash-grid-bg"></div>
      <div class="dash-glow"></div>

      <!-- Header -->
      <div class="dash-header">
        <div class="dash-header-text">
          <span class="vt-eyebrow">Vue d'ensemble</span>
          <h1 class="dash-title">Votre flotte est active.</h1>
          <p class="dash-sub">Suivi en temps réel de votre flotte</p>
        </div>
        <button (click)="customizerOpen.set(true)" class="dash-customize-btn" aria-label="Personnaliser">
          <lucide-icon [img]="Settings2" [size]="15"></lucide-icon>
          <span class="dash-customize-label">Personnaliser</span>
        </button>
      </div>

      <!-- Pont splash → données (§2.2) : squelette qui copie EXACTEMENT la grille réelle
           (4 KPI + carte + activité + alertes). Dimensions = dimensions réelles → aucun
           saut de mise en page à la substitution. Balayage émeraude via .sk (styles.css). -->
      @if (!loaded()) {
        <div class="dash-content dash-sk" aria-hidden="true">
          <div class="metrics-grid">
            @for (i of skFour; track i) {
              <div class="metric-card">
                <app-skeleton w="34px" h="34px" radius="10px" />
                <div class="metric-content" style="gap:6px">
                  <app-skeleton w="46px" h="22px" />
                  <app-skeleton w="72px" h="11px" radius="5px" />
                </div>
              </div>
            }
          </div>
          <div class="quick-actions">
            @for (i of skFour; track i) {
              <app-skeleton w="104px" h="36px" radius="11px" />
            }
          </div>
          <div class="dash-2col">
            <div class="widget widget--map dash-2col-main">
              <div class="widget-header">
                <app-skeleton w="150px" h="16px" />
                <app-skeleton w="42px" h="12px" radius="5px" />
              </div>
              <div class="sk" style="flex:1 1 auto;min-height:240px;border-radius:10px"></div>
            </div>
            <div class="dash-col">
              <div class="widget">
                <div class="widget-header">
                  <app-skeleton w="130px" h="15px" />
                  <app-skeleton w="34px" h="12px" radius="5px" />
                </div>
                <div class="widget-list">
                  @for (i of skThree; track i) {
                    <div class="widget-row">
                      <app-skeleton [circle]="true" w="8px" h="8px" />
                      <div class="widget-row-info" style="display:flex;flex-direction:column;gap:5px">
                        <app-skeleton w="72px" h="13px" />
                        <app-skeleton w="48px" h="10px" radius="4px" />
                      </div>
                      <app-skeleton w="42px" h="16px" />
                    </div>
                  }
                </div>
              </div>
              <div class="widget">
                <div class="widget-header">
                  <app-skeleton w="130px" h="15px" />
                  <app-skeleton w="46px" h="12px" radius="5px" />
                </div>
                <div class="widget-list">
                  @for (i of skThree; track i) {
                    <div class="widget-row">
                      <app-skeleton w="28px" h="28px" radius="8px" />
                      <div class="widget-row-info" style="display:flex;flex-direction:column;gap:5px">
                        <app-skeleton w="120px" h="12px" />
                        <app-skeleton w="70px" h="10px" radius="4px" />
                      </div>
                    </div>
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
      } @else {
      <div class="dash-content vt-realin">

      <!-- Installations à revoir : boîtier posé < 1 mois qui se déconnecte. -->
      @if (vehiclesToReview().length > 0) {
        <a routerLink="/alerts" class="dash-review-banner">
          <lucide-icon [img]="AlertTriangle" [size]="16"></lucide-icon>
          <span class="dash-review-text">
            <strong>{{ vehiclesToReview().length }} installation(s) à revoir</strong>
            <span>boîtier posé récemment qui se déconnecte — à vérifier au plus vite</span>
          </span>
          <lucide-icon [img]="ChevronRight" [size]="14" class="dash-review-arrow"></lucide-icon>
        </a>
      }

      <!-- KPIs compactes (2x2 mobile, 4x1 desktop) -->
      @if (isWidgetEnabled('kpis')) {
        <div class="metrics-grid">
          <a routerLink="/vehicles" class="metric-card metric-card--link">
            <div class="vt-icon-tile">
              <lucide-icon [img]="Truck" [size]="18"></lucide-icon>
            </div>
            <div class="metric-content">
              <span class="metric-value">{{ stats()?.total ?? '—' }}</span>
              <span class="metric-label">Véhicules</span>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="14" class="metric-arrow"></lucide-icon>
          </a>

          <a routerLink="/map" class="metric-card metric-card--link">
            <div class="vt-icon-tile">
              <lucide-icon [img]="Navigation" [size]="18"></lucide-icon>
            </div>
            <div class="metric-content">
              <span class="metric-value">{{ stats()?.moving ?? '—' }}</span>
              <span class="metric-label">En mouvement</span>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="14" class="metric-arrow"></lucide-icon>
          </a>

          <a routerLink="/map" class="metric-card metric-card--link">
            <div class="vt-icon-tile vt-icon-tile--muted">
              <lucide-icon [img]="Activity" [size]="18"></lucide-icon>
            </div>
            <div class="metric-content">
              <span class="metric-value">{{ stats()?.idle ?? '—' }}</span>
              <span class="metric-label">À l'arrêt</span>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="14" class="metric-arrow"></lucide-icon>
          </a>

          <a routerLink="/alerts" class="metric-card metric-card--link">
            <div class="vt-icon-tile vt-icon-tile--danger">
              <lucide-icon [img]="AlertTriangle" [size]="18"></lucide-icon>
            </div>
            <div class="metric-content">
              <span class="metric-value metric-value--danger">{{ stats()?.criticalAlerts ?? '—' }}</span>
              <span class="metric-label">Alertes critiques</span>
            </div>
            <lucide-icon [img]="ChevronRight" [size]="14" class="metric-arrow"></lucide-icon>
          </a>
        </div>
      }

      <!-- Quick actions chips -->
      @if (isWidgetEnabled('actions')) {
        <div class="quick-actions">
          @if (perms.can('vehicles_view')) {
            <a routerLink="/map" class="quick-chip">
              <lucide-icon [img]="MapIcon" [size]="14"></lucide-icon>
              <span>Carte</span>
            </a>
            <a routerLink="/vehicles" class="quick-chip">
              <lucide-icon [img]="Truck" [size]="14"></lucide-icon>
              <span>Véhicules</span>
            </a>
          }
          @if (perms.can('reports_view')) {
            <a routerLink="/reports" class="quick-chip">
              <lucide-icon [img]="FileBarChart" [size]="14"></lucide-icon>
              <span>Rapports</span>
            </a>
          }
          @if (perms.can('geofences_view')) {
            <a routerLink="/geofences" class="quick-chip">
              <lucide-icon [img]="Shield" [size]="14"></lucide-icon>
              <span>Géofences</span>
            </a>
          }
        </div>
      }

      <!-- Aperçu 2 colonnes : carte (gauche) + activité / alertes (droite) -->
      @if (isWidgetEnabled('map') || isWidgetEnabled('activity') || isWidgetEnabled('alerts')) {
      <div class="dash-2col">
      <!-- Mini-map widget -->
      @if (isWidgetEnabled('map')) {
        <a routerLink="/map" class="widget widget--map dash-2col-main">
          <div class="widget-header">
            <h3 class="widget-title">
              <lucide-icon [img]="MapIcon" [size]="16" class="text-tracky-light"></lucide-icon>
              Carte temps réel
            </h3>
            <span class="widget-action">
              Voir
              <lucide-icon [img]="ChevronRight" [size]="14"></lucide-icon>
            </span>
          </div>
          @if (firstActivePosition(); as pos) {
            <app-mini-map
              [center]="pos"
              [zoom]="13"
              [vehicleType]="firstVehicleMeta().type"
              [plate]="firstVehicleMeta().plate"
              [speedKmh]="firstVehicleMeta().speedKmh"
              [heading]="firstVehicleMeta().heading"
              [ignition]="firstVehicleMeta().ignition"
              height="100%" />
            <div class="widget-map-overlay">
              <div class="widget-map-stat">
                <strong>{{ enrichedPositions().length }}</strong>
                <span>actif{{ enrichedPositions().length > 1 ? 's' : '' }}</span>
              </div>
              <!-- La vignette défile : on le dit, sinon le changement de véhicule paraît erratique. -->
              @if (cinemaActive()) {
                <div class="widget-map-stat widget-map-stat--cinema">
                  <span class="cinema-dot"></span>
                  <span>{{ firstVehicleMeta().plate || 'en route' }}</span>
                </div>
              }
            </div>
          } @else {
            <div class="widget-empty widget-empty--map">
              <lucide-icon [img]="Radio" [size]="28" style="opacity:.3"></lucide-icon>
              <p>Aucune position en temps réel</p>
            </div>
          }
        </a>
      }

      @if (isWidgetEnabled('activity') || isWidgetEnabled('alerts')) {
      <div class="dash-col">
      <!-- Widget : Activité en direct -->
      @if (isWidgetEnabled('activity')) {
        <div class="widget">
          <div class="widget-header">
            <h3 class="widget-title">
              <lucide-icon [img]="Gauge" [size]="16" class="text-tracky-light"></lucide-icon>
              Activité en direct
            </h3>
            <a routerLink="/vehicles" class="widget-action">
              Tous
              <lucide-icon [img]="ChevronRight" [size]="14"></lucide-icon>
            </a>
          </div>
          @if (topActiveVehicles().length === 0) {
            <div class="widget-empty">
              <lucide-icon [img]="Radio" [size]="24" style="opacity:.3"></lucide-icon>
              <p>Aucun véhicule actif</p>
            </div>
          } @else {
            <div class="widget-list">
              @for (item of topActiveVehicles(); track item.trackerId) {
                <a [routerLink]="['/vehicles', item.vehicleId]" class="widget-row">
                  <div class="widget-row-indicator" [class]="item.speedKmh > 5 ? 'moving' : 'idle'"></div>
                  <div class="widget-row-info">
                    <p class="widget-row-title">{{ item.plate || item.trackerId.slice(0, 8) }}</p>
                    <p class="widget-row-sub">{{ item.timestamp | date:'HH:mm:ss' }}</p>
                  </div>
                  <div class="widget-row-speed" [class]="speedClass(item.speedKmh)">
                    {{ item.speedKmh.toFixed(0) }}<span class="speed-unit">km/h</span>
                  </div>
                  <lucide-icon [img]="ChevronRight" [size]="14" class="widget-row-chevron"></lucide-icon>
                </a>
              }
            </div>
          }
        </div>
      }

      <!-- Widget : Alertes récentes -->
      @if (isWidgetEnabled('alerts')) {
        <div class="widget">
          <div class="widget-header">
            <h3 class="widget-title">
              <lucide-icon [img]="Bell" [size]="16" style="color:var(--warning)"></lucide-icon>
              Alertes récentes
            </h3>
            <a routerLink="/alerts" class="widget-action">
              Toutes
              <lucide-icon [img]="ChevronRight" [size]="14"></lucide-icon>
            </a>
          </div>
          @if (recentAlerts().length === 0) {
            <div class="widget-empty">
              <lucide-icon [img]="Bell" [size]="24" style="opacity:.3"></lucide-icon>
              <p>Aucune alerte en cours</p>
            </div>
          } @else {
            <div class="widget-list">
              @for (alert of recentAlerts(); track alert.id) {
                <a routerLink="/alerts" class="widget-row widget-row--alert">
                  <div class="widget-alert-severity"
                       [class.crit]="alert.severity === 'CRITICAL'"
                       [class.warn]="alert.severity === 'WARNING'"
                       [class.info]="alert.severity === 'INFO'">
                    <lucide-icon [img]="AlertTriangle" [size]="14"></lucide-icon>
                  </div>
                  <div class="widget-row-info">
                    <p class="widget-row-title widget-row-title--small">{{ alert.title || alertLabel(alert.type) }}</p>
                    <p class="widget-row-sub">
                      @if (alert.vehiclePlate) { {{ alert.vehiclePlate }} · }
                      {{ alert.createdAt | date:'dd MMM HH:mm' }}
                    </p>
                  </div>
                  <lucide-icon [img]="ChevronRight" [size]="14" class="widget-row-chevron"></lucide-icon>
                </a>
              }
            </div>
          }
        </div>
      }
      </div>
      }
      </div>
      }

      <!-- Automatisation horaire (bannière) -->
      @if (isWidgetEnabled('schedule')) {
        <div class="dash-banner">
          <span class="dash-banner-icon"><lucide-icon [img]="Clock" [size]="22"></lucide-icon></span>
          <div class="dash-banner-text">
            <h3 class="dash-banner-title">Pilotez les plages horaires de chaque véhicule</h3>
            <p class="dash-banner-sub">Coupez automatiquement le moteur en dehors des heures de service.</p>
          </div>
          <a routerLink="/vehicles" class="dash-banner-btn">
            Configurer
            <lucide-icon [img]="ArrowRight" [size]="15"></lucide-icon>
          </a>
        </div>
      }

      @if (allWidgetsDisabled()) {
        <div class="dash-empty-state">
          <lucide-icon [img]="Settings2" [size]="32" style="opacity:.3"></lucide-icon>
          <p>Aucun widget activé</p>
          <button (click)="customizerOpen.set(true)" class="dash-empty-btn">
            Personnaliser le tableau de bord
          </button>
        </div>
      }
      </div>
      }
    </div>

    <!-- Customizer dialog -->
    @if (customizerOpen()) {
      <div class="dash-customizer-overlay" (click)="customizerOpen.set(false)"></div>
      <div class="dash-customizer">
        <div class="dash-customizer-header">
          <h3>Personnaliser</h3>
          <button (click)="customizerOpen.set(false)" class="dash-customizer-close" aria-label="Fermer">
            <lucide-icon [img]="X" [size]="16"></lucide-icon>
          </button>
        </div>
        <p class="dash-customizer-sub">Activez ou désactivez les widgets affichés sur le tableau de bord.</p>
        <div class="dash-customizer-list">
          @for (widget of widgetMeta; track widget.key) {
            <label class="dash-customizer-item">
              <div class="dash-customizer-item-info">
                <span class="dash-customizer-item-label">{{ widget.label }}</span>
                <span class="dash-customizer-item-desc">{{ widget.description }}</span>
              </div>
              <button
                type="button"
                (click)="toggleWidget(widget.key)"
                class="dash-customizer-toggle"
                [class.dash-customizer-toggle--on]="isWidgetEnabled(widget.key)"
                [attr.aria-label]="(isWidgetEnabled(widget.key) ? 'Désactiver ' : 'Activer ') + widget.label"
              >
                <span class="dash-customizer-toggle-knob"></span>
              </button>
            </label>
          }
        </div>
        <div class="dash-customizer-footer">
          <button (click)="customizerOpen.set(false)" class="dash-customizer-done">
            <lucide-icon [img]="Check" [size]="14"></lucide-icon>
            Terminé
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    .dash-page { position: relative; overflow: hidden }
    /* Conteneur commun squelette / contenu réel — au-dessus du fond (grille + glow). */
    .dash-content { position: relative; z-index: 1 }

    /* Grid background */
    .dash-grid-bg {
      position: absolute; inset: 0; pointer-events: none; z-index: 0;
      background-image: radial-gradient(circle, var(--border-subtle) 1px, transparent 1px);
      background-size: 24px 24px;
      mask-image: radial-gradient(ellipse at 50% 0%, black 0%, transparent 70%);
      -webkit-mask-image: radial-gradient(ellipse at 50% 0%, black 0%, transparent 70%);
      opacity: .5;
    }
    .dash-glow {
      position: absolute; top: -80px; left: 50%; transform: translateX(-50%); width: 600px; height: 300px;
      background: radial-gradient(ellipse, rgba(16,224,160,.07) 0%, transparent 70%);
      pointer-events: none; z-index: 0;
    }

    /* Header */
    .dash-header { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 18px }
    .dash-title { font-size: 22px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.03em; margin-top: 8px; line-height: 1.1 }
    .dash-header-text { min-width: 0 }
    .dash-sub { font-size: 12px; color: var(--fg-tertiary); margin-top: 2px }
    .dash-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end }
    .dash-customize-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 10px; border-radius: 9999px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); font-size: 11px; font-weight: 600;
      cursor: pointer; transition: all .15s;
    }
    .dash-customize-btn:hover { color: var(--tracky-light); border-color: var(--tracky) }
    .dash-customize-label { display: none }
    @media (min-width: 380px) { .dash-customize-label { display: inline } }

    .dash-status { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 20px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); flex-shrink: 0 }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-tertiary); animation: pulse 2s ease infinite }
    .status-dot.online { background: var(--tracky-light) }
    .status-text { font-size: 10px; font-weight: 600; color: var(--fg-tertiary) }
    .status-text.online { color: var(--tracky-light) }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

    /* Metrics grid : 2x2 mobile, 4x1 desktop */
    .metrics-grid { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px }
    .dash-review-banner {
      position: relative; z-index: 1; display: flex; align-items: center; gap: 10px;
      margin-bottom: 16px; padding: 11px 14px; border-radius: 12px; text-decoration: none;
      background: color-mix(in srgb, var(--danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent); color: var(--danger);
      transition: border-color .15s;
    }
    .dash-review-banner:hover { border-color: color-mix(in srgb, var(--danger) 55%, transparent) }
    .dash-review-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0 }
    .dash-review-text strong { font-size: 13px; font-weight: 800 }
    .dash-review-text span { font-size: 11px; color: var(--fg-tertiary); font-weight: 500 }
    .dash-review-arrow { color: var(--fg-tertiary); flex-shrink: 0 }
    .metric-card {
      position: relative; display: flex; align-items: center; gap: 12px;
      padding: 14px 16px; border-radius: 16px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      transition: transform .2s var(--ease-tracky, ease), border-color .2s;
      text-decoration: none; color: inherit;
    }
    .metric-card:hover, .metric-card:active {
      border-color: var(--tracky-light); transform: translateY(-3px);
    }

    .metric-content { display: flex; flex-direction: column; min-width: 0; flex: 1 }
    .metric-value { font-size: 24px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display); letter-spacing: -.02em; line-height: 1 }
    .metric-value--danger { color: var(--danger) }
    /* Label complet sans tronquer : on autorise le wrap sur 2 lignes */
    .metric-label { font-size: 11px; font-weight: 500; color: var(--fg-tertiary); margin-top: 3px; line-height: 1.2 }
    .metric-arrow { color: var(--fg-tertiary); flex-shrink: 0; opacity: 0; transition: opacity .2s, transform .2s }
    .metric-card:hover .metric-arrow, .metric-card--link:active .metric-arrow { opacity: 1; transform: translateX(2px) }

    /* Quick actions : chips horizontales (réf. maquette) */
    .quick-actions { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 9px; margin-bottom: 22px }
    .quick-chip {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 9px 14px; border-radius: 11px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); text-decoration: none; font-size: 13px; font-weight: 600;
      transition: border-color .18s, color .18s;
    }
    .quick-chip:hover, .quick-chip:active { border-color: var(--tracky-light); color: var(--fg-primary) }
    .quick-chip lucide-icon { color: var(--tracky-light) }

    /* Aperçu 2 colonnes : carte (gauche) + colonne activité/alertes (droite).
       Flex -> se réagence gracieusement si un widget est désactivé. */
    .dash-2col { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 16px; margin-bottom: 16px }
    .dash-2col-main { flex: 1.35 1 0; min-width: 0; margin-bottom: 0 }
    .dash-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 16px }
    .dash-col .widget { margin-bottom: 0 }

    /* Bannière « Automatisation horaire » (réf. maquette) */
    .dash-banner {
      position: relative; z-index: 1; display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
      padding: 18px 20px; border-radius: 18px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
    }
    .dash-banner-icon {
      display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
      width: 46px; height: 46px; border-radius: 13px;
      background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--tracky-light);
    }
    .dash-banner-text { flex: 1; min-width: 200px }
    .dash-banner-title { font-size: 15px; font-weight: 700; color: var(--fg-primary); line-height: 1.3 }
    .dash-banner-sub { font-size: 13px; color: var(--fg-secondary); margin-top: 4px; line-height: 1.4 }
    .dash-banner-btn {
      display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
      padding: 11px 18px; border-radius: 11px;
      background: var(--tracky-light); color: var(--accent-ink);
      font-size: 13px; font-weight: 700; text-decoration: none; cursor: pointer;
      box-shadow: var(--shadow-tracky-glow); transition: filter .15s;
    }
    .dash-banner-btn:hover { filter: brightness(1.05) }

    /* Widget générique */
    .widget {
      position: relative; z-index: 1;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 18px; padding: 16px; margin-bottom: 12px;
      text-decoration: none; color: inherit; display: block;
      transition: border-color .2s;
    }
    .widget:hover { border-color: var(--tracky-light) }
    /* Désactive le tooltip/preview natif du lien (long-press iOS, hover desktop)
       sur les widgets entiers — l'utilisateur clique pour naviguer, sans preview parasite. */
    a.widget,
    a.widget--map,
    a.metric-card {
      -webkit-touch-callout: none;
      -webkit-user-drag: none;
      user-select: none;
      -webkit-user-select: none;
    }
    a.widget *,
    a.widget--map *,
    a.metric-card * {
      -webkit-user-drag: none;
    }
    .widget-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px }
    .widget-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; color: var(--fg-primary) }
    .widget-action { display: flex; align-items: center; gap: 2px; font-size: 12px; font-weight: 600; color: var(--tracky-light); text-decoration: none }
    .widget-action lucide-icon { transition: transform .2s }
    .widget-action:hover lucide-icon { transform: translateX(2px) }

    .widget-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 20px 0; color: var(--fg-tertiary); font-size: 12px }
    .widget-empty--map { padding: 40px 0 }

    /* Widget map */
    .widget--map { padding: 14px; position: relative; display: flex; flex-direction: column }
    /* La mini-carte remplit la hauteur du widget (qui s'étire pour matcher la
       colonne activité/alertes en 2-col) — fini le grand vide sous une carte fixe.
       Le composant mini-map resize MapLibre via ResizeObserver. */
    .widget--map app-mini-map { display: block; border-radius: 10px; overflow: hidden; flex: 1 1 auto; min-height: 220px }
    .widget--map app-mini-map > div { height: 100% }
    /* Mobile / tablette (1 colonne) : en 2-col desktop, la RANGÉE étire le widget carte
       et lui donne sa hauteur ; en mono-colonne cette hauteur disparaît. Le widget garde
       pourtant flex 1.35/1/0 (flex-basis:0) → il se rétrécit ET ignore la hauteur de la
       carte → la mini-carte (dont le div interne fait height:100%) tombe à ~0, déborde et
       la carte « Activité » se pose par-dessus. Fix : hauteur DÉFINIE sur le widget +
       flex:none (sinon flex-basis:0 l'ignore) ; app-mini-map remplit cette hauteur définie
       → le height:100% interne se résout enfin. */
    @media (max-width: 1023px) {
      .widget--map.dash-2col-main { flex: none; height: 280px; }
      .widget--map app-mini-map { flex: 1 1 auto; height: auto; min-height: 0; }
    }
    .widget-map-overlay { position: absolute; bottom: 22px; left: 22px; z-index: 2; pointer-events: none; display: flex; align-items: center; gap: 8px }
    .widget-map-stat--cinema { gap: 6px; font-family: var(--font-mono, monospace); font-size: 10.5px; font-weight: 700; color: var(--fg-primary) }
    .cinema-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tracky-light); box-shadow: 0 0 8px rgba(16,224,160,.5); animation: pulse 2s ease infinite }
    .widget-map-stat {
      display: inline-flex; align-items: baseline; gap: 4px;
      padding: 6px 12px; border-radius: 9999px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      backdrop-filter: blur(8px); box-shadow: 0 4px 12px rgba(0,0,0,.08);
      font-size: 11px; color: var(--fg-secondary);
    }
    .widget-map-stat strong { font-size: 14px; color: var(--tracky-light); font-weight: 800 }

    /* Widget list */
    .widget-list { display: flex; flex-direction: column; gap: 4px }
    .widget-row {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 8px; border-radius: 10px;
      text-decoration: none; color: inherit; transition: background .2s;
    }
    .widget-row:hover, .widget-row:active { background: var(--bg-tertiary) }
    .widget-row-indicator { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-tertiary); flex-shrink: 0 }
    .widget-row-indicator.moving { background: var(--tracky-light); box-shadow: 0 0 8px rgba(16,224,160,.4); animation: pulse 2s ease infinite }
    .widget-row-info { flex: 1; min-width: 0 }
    .widget-row-title { font-size: 13px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-mono, monospace) }
    .widget-row-title--small { font-size: 12px; font-family: var(--font-sans, sans-serif); font-weight: 600 }
    .widget-row-sub { font-size: 10px; color: var(--fg-tertiary); margin-top: 1px }
    .widget-row-speed { font-size: 16px; font-weight: 800; font-family: var(--font-display); letter-spacing: -.02em }
    .widget-row-speed.fast { color: var(--danger) }
    .widget-row-speed.medium { color: var(--warning) }
    .widget-row-speed.slow { color: var(--tracky-light) }
    .widget-row-speed.stopped { color: var(--fg-tertiary) }
    .speed-unit { font-size: 9px; font-weight: 500; opacity: .65; margin-left: 2px }
    .widget-row-chevron { color: var(--fg-tertiary); opacity: .5; flex-shrink: 0 }

    /* Alert severity */
    .widget-row--alert .widget-alert-severity { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
    .widget-alert-severity.crit { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger) }
    .widget-alert-severity.warn { background: color-mix(in srgb, var(--warning) 14%, transparent); color: var(--warning) }
    .widget-alert-severity.info { background: var(--bg-tertiary); color: var(--fg-secondary) }

    /* Widget Schedule */
    .widget-schedule-content { display: flex; flex-direction: column; gap: 12px }
    .widget-schedule-card {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px; border-radius: 10px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
    }
    .widget-schedule-icon {
      width: 36px; height: 36px; border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(16,224,160,.12); color: var(--tracky-light);
      flex-shrink: 0;
    }
    .widget-schedule-info { flex: 1; min-width: 0 }
    .widget-schedule-title { font-size: 12px; font-weight: 700; color: var(--fg-primary); line-height: 1.3 }
    .widget-schedule-sub { font-size: 11px; color: var(--fg-tertiary); margin-top: 3px; line-height: 1.4 }
    .widget-schedule-presets { display: flex; gap: 8px; flex-wrap: wrap }
    .widget-schedule-preset {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 12px; border-radius: 9999px;
      background: rgba(16,224,160,.08); color: var(--tracky-light);
      border: 1px solid rgba(16,224,160,.25);
      font-size: 11px; font-weight: 600;
      text-decoration: none; transition: all .2s;
    }
    .widget-schedule-preset:hover { background: rgba(16,224,160,.15); transform: translateY(-1px) }

    /* Empty dashboard */
    .dash-empty-state {
      position: relative; z-index: 1;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 10px; padding: 40px 20px;
      background: var(--bg-secondary); border: 1px dashed var(--border-subtle);
      border-radius: 14px;
      color: var(--fg-tertiary); font-size: 13px;
    }
    .dash-empty-btn {
      padding: 8px 16px; border-radius: 9999px;
      background: var(--tracky-light); color: var(--accent-ink);
      border: 0; font-size: 12px; font-weight: 700; cursor: pointer;
    }

    /* Customizer */
    .dash-customizer-overlay {
      position: fixed; inset: 0; z-index: 8000;
      background: rgba(0,0,0,.4); backdrop-filter: blur(2px);
      animation: fade-in .2s ease;
    }
    @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
    .dash-customizer {
      position: fixed; left: 16px; right: 16px; bottom: 76px;
      max-width: 480px; margin: 0 auto;
      z-index: 8001;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 18px;
      box-shadow: 0 20px 50px rgba(0,0,0,.25);
      padding: 16px;
      animation: slide-up .25s cubic-bezier(0.16, 1, 0.3, 1);
      max-height: 70vh; max-height: 70dvh; overflow-y: auto;
    }
    @keyframes slide-up { from { transform: translateY(20px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
    .dash-customizer-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px }
    .dash-customizer-header h3 { font-size: 16px; font-weight: 800; color: var(--fg-primary) }
    .dash-customizer-close {
      width: 28px; height: 28px; border-radius: 50%;
      background: var(--bg-tertiary); border: 0; color: var(--fg-secondary);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .dash-customizer-sub { font-size: 12px; color: var(--fg-tertiary); margin-bottom: 14px }
    .dash-customizer-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px }
    .dash-customizer-item {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 12px; border-radius: 12px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      cursor: pointer;
    }
    .dash-customizer-item-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 }
    .dash-customizer-item-label { font-size: 13px; font-weight: 700; color: var(--fg-primary) }
    .dash-customizer-item-desc { font-size: 11px; color: var(--fg-tertiary); line-height: 1.3 }
    .dash-customizer-toggle {
      position: relative; flex-shrink: 0;
      width: 38px; height: 22px; border-radius: 9999px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      cursor: pointer; transition: background .2s;
    }
    .dash-customizer-toggle--on { background: var(--tracky-light); border-color: var(--tracky-light) }
    .dash-customizer-toggle-knob {
      position: absolute; top: 2px; left: 2px;
      width: 16px; height: 16px; border-radius: 50%;
      background: white;
      transition: transform .25s cubic-bezier(0.34, 1.56, 0.64, 1);
      box-shadow: 0 1px 3px rgba(0,0,0,.18);
    }
    .dash-customizer-toggle--on .dash-customizer-toggle-knob { transform: translateX(16px) }
    .dash-customizer-footer { display: flex; justify-content: flex-end }
    .dash-customizer-done {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 9px 16px; border-radius: 10px;
      background: var(--tracky-light); color: var(--accent-ink); border: 0;
      font-size: 12px; font-weight: 700; cursor: pointer; transition: filter .15s;
    }
    .dash-customizer-done:hover { filter: brightness(1.05) }

    /* Desktop */
    @media (min-width: 1024px) {
      .metrics-grid { grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 24px }
      .metric-card { padding: 16px }
      .metric-icon-wrap { width: 36px; height: 36px }
      .metric-value { font-size: 26px }
      .metric-label { font-size: 12px }
      .dash-2col { flex-direction: row }
      .dash-title { font-size: 28px }
      .dash-sub { font-size: 13px }
      .dash-customizer { right: auto; left: 50%; transform: translateX(-50%); bottom: auto; top: 100px; width: 480px }
    }
  `],
})
export class DashboardComponent implements OnInit {
  protected readonly realtime = inject(RealtimeService);
  /** Filtre société global (sélecteur super-admin). matches() = true pour un non-super. */
  private readonly fleetFilter = inject(FleetFilterService);

  /** Véhicules dont l'installation est à revoir (boîtier posé < 1 mois + hors-ligne). */
  protected readonly vehiclesToReview = computed(() =>
    // scopedSnapshot = déjà filtré par le sélecteur société (source centralisée, réactive).
    this.realtime.scopedSnapshot().filter((v) =>
      isInstallationToReview(
        getVehicleConnectivityState({ trackerId: v.trackerId, lastSeenAt: v.lastSeenAt, lastIgnition: v.lastIgnition }),
        v.trackerCreatedAt,
      ),
    ),
  );
  protected readonly preferences = inject(PreferencesService);
  protected readonly perms = inject(PermissionsService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly alertsApi = inject(AlertsApiService);

  protected readonly Truck = Truck;
  protected readonly Navigation = Navigation;
  protected readonly Activity = Activity;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly MapIcon = MapIcon;
  protected readonly Plus = Plus;
  protected readonly FileBarChart = FileBarChart;
  protected readonly Shield = Shield;
  protected readonly ChevronRight = ChevronRight;
  protected readonly Bell = Bell;
  protected readonly Radio = Radio;
  protected readonly Gauge = Gauge;
  protected readonly Clock = Clock;
  protected readonly Settings2 = Settings2;
  protected readonly X = X;
  protected readonly Check = Check;
  protected readonly ArrowRight = ArrowRight;

  protected readonly customizerOpen = signal(false);

  /**
   * Chargement initial (§2). `stats` (toSignal sans initialValue) reste `undefined`
   * jusqu'à la première réponse — même vide ou en erreur (catchError → null). Avant :
   * squelette copiant la grille. Après : contenu réel qui se substitue en cascade.
   */
  protected readonly loaded = computed(() => this.stats() !== undefined);
  /** Itérateurs statiques pour les blocs squelette (évite de recréer les tableaux à chaque CD). */
  protected readonly skFour = [0, 1, 2, 3];
  protected readonly skThree = [0, 1, 2];

  protected readonly widgetMeta: WidgetMeta[] = [
    { key: 'kpis', label: 'KPIs', description: 'Compteurs Véhicules / En mouvement / Arrêt / Alertes' },
    { key: 'actions', label: 'Actions rapides', description: 'Boutons Carte / Véhicules / Rapports / Géofences' },
    { key: 'map', label: 'Carte temps réel', description: 'Aperçu live des véhicules sur une mini-carte' },
    { key: 'activity', label: 'Activité en direct', description: 'Top des véhicules les plus actifs' },
    { key: 'alerts', label: 'Alertes récentes', description: '3 dernières alertes non acquittées' },
    { key: 'schedule', label: 'Automatisation horaire', description: 'Accès rapide à la configuration des plages horaires' },
  ];

  protected isWidgetEnabled(key: DashboardWidgetKey): boolean {
    // Permission check — hide widgets the user has no access to
    const permMap: Partial<Record<DashboardWidgetKey, string>> = {
      kpis: 'vehicles_view',
      actions: 'vehicles_view',
      map: 'vehicles_view',
      activity: 'vehicles_view',
      alerts: 'alerts_view',
      schedule: 'vehicles_view',
    };
    const requiredPerm = permMap[key];
    if (requiredPerm && !this.perms.can(requiredPerm as any)) return false;

    const widgets = this.preferences.prefs().dashboardWidgets;
    return widgets.find((w) => w.key === key)?.enabled ?? true;
  }

  protected toggleWidget(key: DashboardWidgetKey): void {
    this.preferences.toggleDashboardWidget(key);
  }

  protected readonly allWidgetsDisabled = computed(() => {
    const widgets = this.preferences.prefs().dashboardWidgets;
    return widgets.length > 0 && widgets.every((w) => !w.enabled);
  });

  private readonly accessibleVehicleIds = signal<Set<string> | 'ALL'>('ALL');
  private readonly vehicleMetaMap = signal<Map<string, { type: string; plate: string }>>(new Map());

  // V1.10 (Sprint 2 perf) — pause le polling stats si le tab est en arriere-plan.
  // Au retour visible, on force un fetch immediat via le startWith(0) lors de la
  // souscription suivante. Reduit la charge backend ~50% sur les utilisateurs
  // qui laissent l'onglet ouvert sans le regarder.
  // KPI scopés au filtre société : re-fetch au tick 30s ET à chaque changement de
  // société dans le sélecteur (combineLatest émet sur l'un ou l'autre).
  protected readonly stats = toSignal(
    combineLatest([
      interval(30_000).pipe(startWith(0)),
      toObservable(this.fleetFilter.selectedFleetId),
    ]).pipe(
      filter(() => typeof document === 'undefined' || !document.hidden),
      switchMap(() => this.vehiclesApi.stats(this.fleetFilter.selectedFleetId())),
      catchError(() => of(null)),
    ),
  );

  protected readonly enrichedPositions = computed(() => {
    const ids = this.accessibleVehicleIds();
    const meta = this.vehicleMetaMap();
    return this.realtime.scopedPositionsList()
      .filter((pos) => ids === 'ALL' || ids.has(pos.vehicleId))
      // GPS sanity : ecarte les fixes `valid:false` (broadcastes par le backend
      // pour propager l'ignition mais lat/lng degradees) et Null Island. Sans
      // ce filtre, le mini-map du dashboard peut afficher un vehicule en plein
      // ocean ou avec une icone qui saute. Les KPI persistants viennent de
      // `stats` (endpoint dedie), donc filtrer ici n'affecte pas les compteurs.
      .filter((pos) => isAcceptableLiveFix(pos))
      // Garde de FRAÎCHEUR : la position hydratée au login est la *dernière connue*,
      // qui peut dater (boîtier débranché). Sans ce filtre, un véhicule muet depuis
      // des jours apparaît « actif » dans « Activité en direct » (point vert + vitesse)
      // car on affiche son dernier fix comme s'il était live. On ne garde donc que
      // les positions réellement fraîches (< seuil online partagé, 15 min).
      .filter((pos) => isTrackerOnline(pos.timestamp))
      .map((pos) => ({
        ...pos,
        plate: meta.get(pos.vehicleId)?.plate ?? '',
      }));
  });

  protected readonly topActiveVehicles = computed(() => {
    return [...this.enrichedPositions()]
      .sort((a, b) => {
        if (a.speedKmh > 5 && b.speedKmh <= 5) return -1;
        if (a.speedKmh <= 5 && b.speedKmh > 5) return 1;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      })
      .slice(0, 3);
  });

  /**
   * ─── Mode cinéma de la carte du tableau de bord ───────────────────────────
   *
   * La vignette ne montrait QUE le premier véhicule de la liste, même quand la flotte roulait.
   * Elle cycle désormais sur les véhicules EN MARCHE (contact mis), 8 s chacun — comme le mode
   * Cinéma de la carte principale, mais ici en automatique : c'est une vignette de supervision,
   * on veut voir ce qui bouge sans cliquer.
   *
   * Repli : si AUCUN véhicule ne roule, on n'invente pas de mouvement — on affiche simplement le
   * premier véhicule à l'arrêt, sans cycle (comportement d'avant).
   *
   * ⚠️ Volontairement limité à CETTE vignette : la carte principale garde son bouton Cinéma manuel.
   */
  private readonly cinemaTick = signal(0);

  private readonly destroyRef = inject(DestroyRef);

  /** Véhicules éligibles au cycle : ceux qui roulent. Vide = flotte à l'arrêt. */
  private readonly cinemaCandidates = computed(() =>
    this.enrichedPositions().filter((p) => p.ignition || p.speedKmh > 3),
  );

  /** Véhicule actuellement mis en avant : celui du cycle, sinon le premier à l'arrêt. */
  private readonly spotlightVehicle = computed(() => {
    const running = this.cinemaCandidates();
    if (running.length > 0) return running[this.cinemaTick() % running.length]!;
    return this.enrichedPositions()[0] ?? null;
  });

  /** Le cycle tourne-t-il ? (≥ 2 véhicules en marche) — sert aussi à l'indicateur visuel. */
  protected readonly cinemaActive = computed(() => this.cinemaCandidates().length > 1);

  protected readonly firstActivePosition = computed(() => {
    const v = this.spotlightVehicle();
    return v ? { lat: v.lat, lng: v.lng } : null;
  });

  protected readonly firstVehicleMeta = computed(() => {
    const v = this.spotlightVehicle();
    if (!v) return { type: 'OTHER', plate: '', speedKmh: 0, heading: 0, ignition: false };
    const m = this.vehicleMetaMap().get(v.vehicleId);
    return {
      type: m?.type ?? 'OTHER',
      plate: m?.plate ?? '',
      speedKmh: v.speedKmh,
      heading: v.heading,
      ignition: v.ignition,
    };
  });

  protected readonly liveAlerts = this.realtime.alerts;
  // V1.10 (Sprint 2 perf) — un seul fetch initial d'hydratation au lieu d'un
  // polling 60s. Le WS RealtimeService.alerts pousse les nouveautes en temps
  // reel ; le polling etait redondant et tirait 1 requete/min/dashboard meme
  // quand aucune nouvelle alerte. `of(0)` declenche le switchMap une seule fois.
  private readonly fetchedAlerts = toSignal(
    of(0).pipe(
      switchMap(() => this.alertsApi.list({ limit: '3', acknowledged: 'false' })),
      catchError(() => of({ items: [], nextCursor: null })),
    ),
    { initialValue: { items: [], nextCursor: null } },
  );
  protected readonly recentAlerts = computed(() => {
    // Live = scopedAlerts (source centralisée) ; le fetch initial (HTTP one-shot) est filtré réactivement.
    const live = this.realtime.scopedAlerts();
    if (live.length > 0) return live.slice(0, 3);
    return (this.fetchedAlerts()?.items ?? []).filter((a) => this.fleetFilter.matches(a.fleetId)).slice(0, 3);
  });

  protected speedClass(speed: number): string {
    if (speed > 90) return 'fast';
    if (speed > 50) return 'medium';
    if (speed > 0) return 'slow';
    return 'stopped';
  }

  protected alertLabel(kind: string): string {
    const labels: Record<string, string> = {
      OVERSPEED: 'Excès de vitesse',
      MOVE_AT_STOP: 'Mouvement à l\'arrêt',
      HARSH_BRAKE: 'Freinage brusque',
      HARSH_ACCEL: 'Accélération forte',
      GEOFENCE_ENTER: 'Entrée géofence',
      GEOFENCE_EXIT: 'Sortie géofence',
      ENGINE_CUT: 'Coupure moteur',
      ENGINE_RESTORED: 'Moteur restauré',
      OFFLINE: 'Hors-ligne',
      LOW_BATTERY: 'Batterie faible',
    };
    return labels[kind] ?? kind;
  }

  async ngOnInit(): Promise<void> {
    // Cycle « cinéma » de la vignette carte : 8 s par véhicule en marche. `document.hidden` →
    // on n'avance pas dans un onglet en arrière-plan (sinon on « saute » N vues au retour).
    const cinemaId = setInterval(() => {
      if (!document.hidden && this.cinemaCandidates().length > 1) {
        this.cinemaTick.update((n) => n + 1);
      }
    }, 8000);
    this.destroyRef.onDestroy(() => clearInterval(cinemaId));

    try {
      const vehicles = await firstValueFrom(this.vehiclesApi.list());
      this.accessibleVehicleIds.set(new Set(vehicles.map((v) => v.id)));
      const meta = new Map<string, { type: string; plate: string }>();
      vehicles.forEach((v) => {
        const cast = v as { id: string; plate: string; type?: string };
        meta.set(v.id, { type: cast.type ?? 'OTHER', plate: v.plate });
      });
      this.vehicleMetaMap.set(meta);
    } catch { /* fallback to ALL */ }
  }
}
