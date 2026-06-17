import { ChangeDetectionStrategy, Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Edit2,
  Gauge,
  Info,
  LucideAngularModule,
  MoreVertical,
  Plus,
  Settings,
  Trash2,
  XCircle,
} from 'lucide-angular';
import type { AlertEvent } from '@vizyo/tracky-shared';
import { getVehicleConnectivityState, isInstallationToReview } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { InstallReviewBadgeComponent } from '../../shared/ui/install-review-badge/install-review-badge.component';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { AlertsApiService } from '../../core/services/alerts.service';
import { AuthService } from '../../core/services/auth.service';
import { AlertRuleDto, NotificationsApiService } from '../../core/services/notifications.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { relativeTime } from '../../shared/utils/relative-time';
import { SaFleetBadgeComponent } from '../../shared/ui/super-admin-context/sa-fleet-badge.component';
const ALERT_TYPES: { value: string; label: string; severity: string }[] = [
  { value: '*', label: 'Tous les types', severity: '' },
  { value: 'SOS', label: 'SOS', severity: 'critical' },
  { value: 'POWER_CUT', label: 'Coupure alimentation', severity: 'critical' },
  { value: 'ACCIDENT', label: 'Accident', severity: 'critical' },
  { value: 'COLLISION', label: 'Collision', severity: 'critical' },
  { value: 'TOW', label: 'Remorquage', severity: 'critical' },
  { value: 'TAMPER', label: 'Retrait tracker', severity: 'critical' },
  { value: 'ILLEGAL_IGNITION', label: 'Demarrage non autorise', severity: 'critical' },
  { value: 'LOW_BATTERY', label: 'Batterie faible', severity: 'warning' },
  { value: 'OVERSPEED', label: 'Exces de vitesse', severity: 'warning' },
  { value: 'GEOFENCE_ENTER', label: 'Entree geofence', severity: 'warning' },
  { value: 'GEOFENCE_EXIT', label: 'Sortie geofence', severity: 'warning' },
  { value: 'MOVEMENT_IDLE', label: 'Mouvement vehicule eteint', severity: 'warning' },
  { value: 'BONNET', label: 'Capot ouvert', severity: 'warning' },
  { value: 'DOOR', label: 'Porte ouverte', severity: 'warning' },
  { value: 'FATIGUE', label: 'Fatigue conducteur', severity: 'warning' },
  { value: 'HARSH_BRAKING', label: 'Freinage brutal', severity: 'info' },
  { value: 'HARSH_ACCELERATION', label: 'Acceleration brutale', severity: 'info' },
  { value: 'HARSH_TURN', label: 'Virage brutal', severity: 'info' },
  { value: 'VIBRATION', label: 'Vibration', severity: 'info' },
  { value: 'GPS_LOST', label: 'Perte signal GPS', severity: 'info' },
  { value: 'IDLE_TIME', label: 'Arret prolonge', severity: 'info' },
];

const ALL_CHANNELS: { value: 'WEB_PUSH' | 'EMAIL' | 'WHATSAPP' | 'SMS'; label: string; icon: string }[] = [
  { value: 'WEB_PUSH', label: 'Push', icon: '🔔' },
  { value: 'EMAIL', label: 'Email', icon: '✉️' },
  { value: 'WHATSAPP', label: 'WhatsApp', icon: '💬' },
  { value: 'SMS', label: 'SMS', icon: '📱' },
];

/**
 * Regroupement anti-spam : une rafale d'alertes du même véhicule + même type
 * (ex. excès de vitesse qui s'enchaînent) est fusionnée en une seule card avec
 * un compteur ×N et une liste déroulante détaillant les occurrences (vitesses,
 * moyenne, max). Évite de noyer l'opérateur sous des dizaines de cards.
 */
interface AlertCluster {
  key: string;
  /** Alerte la plus récente — représentante de la card. */
  lead: AlertEvent;
  /** Toutes les occurrences (ordre décroissant). */
  items: AlertEvent[];
  count: number;
  vehicleId: string | null;
  type: string;
  /** Sévérité MAX de la rafale. */
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  newestAt: string;
  oldestAt: string;
  speeds: number[];
  avgSpeed: number | null;
  maxSpeed: number | null;
  unackCount: number;
}

interface RuleForm {
  id: string | null;
  vehicleId: string | null;
  alertType: string;
  enabled: boolean;
  channels: ('WEB_PUSH' | 'EMAIL' | 'WHATSAPP' | 'SMS')[];
  escalateAfterMin: number | null;
  escalateToUserId: string | null;
}

const EMPTY_FORM: RuleForm = {
  id: null,
  vehicleId: null,
  alertType: '*',
  enabled: true,
  channels: ['EMAIL'],
  escalateAfterMin: null,
  escalateToUserId: null,
};

@Component({
  selector: 'app-alerts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, RouterLink, FormsModule, SaFleetBadgeComponent, InstallReviewBadgeComponent, GroupBadgeComponent],
  template: `
    @if (isBaanoolMode()) {
      <!-- V1.12 — Mode Baanool : "Centre de messages" style ultra-simple -->
      <div class="bn-alerts">
        <div class="bn-alerts-header">
          <button class="bn-back" (click)="goBack()" aria-label="Retour">
            <lucide-icon [img]="ChevronLeftIcon" [size]="22"></lucide-icon>
          </button>
          <h1 class="bn-title">Centre de messages</h1>
          <button class="bn-more" aria-label="Plus d'options">
            <lucide-icon [img]="MoreVerticalIcon" [size]="20"></lucide-icon>
          </button>
        </div>

        <div class="bn-tabs">
          <button class="bn-tab" [class.active]="bnTab() === 'alarms'" (click)="bnTab.set('alarms')">
            Message d'alarme
          </button>
          <button class="bn-tab" [class.active]="bnTab() === 'notifs'" (click)="bnTab.set('notifs')">
            Notification
          </button>
        </div>

        @if (alerts().length === 0 || bnTab() === 'notifs') {
          <div class="bn-empty">
            <div class="bn-empty-icon">
              <lucide-icon [img]="AlertTriangle" [size]="56"></lucide-icon>
            </div>
            <p class="bn-empty-text">Aucune donnee</p>
          </div>
        } @else {
          <div class="bn-list">
            @for (cluster of groupedAlerts(); track cluster.key) {
              <div class="bn-row" [class.bn-row--acked]="cluster.unackCount === 0">
                <div class="bn-row-icon" [class]="'sev-' + cluster.severity">
                  <lucide-icon [img]="severityIcon(cluster.severity)" [size]="20"></lucide-icon>
                </div>
                <div class="bn-row-main">
                  <div class="bn-row-title">{{ alertLabel(cluster.lead) }}@if (cluster.count > 1) { <span class="bn-count">×{{ cluster.count }}</span> }</div>
                  <div class="bn-row-meta">
                    @if (cluster.lead.vehiclePlate) { <span>{{ cluster.lead.vehiclePlate }}</span> · }
                    @if (cluster.maxSpeed) { <span class="bn-speed">{{ cluster.count > 1 ? 'max ' : '' }}{{ cluster.maxSpeed }} km/h</span> · }
                    <span>{{ formatRelative(cluster.newestAt) }}</span>
                  </div>
                  <!-- V1.15 — Badge fleet (visible SA only). -->
                  <app-sa-fleet-badge [fleetId]="cluster.lead.fleetId" />
                </div>
                @if (cluster.unackCount > 0 && perms.can('alerts_acknowledge')) {
                  <button class="bn-row-ack" (click)="acknowledgeCluster(cluster)" aria-label="Acquitter">
                    <lucide-icon [img]="Check" [size]="16"></lucide-icon>
                  </button>
                }
              </div>
            }
          </div>
        }
      </div>
    } @else {
    <div class="a-page">
      <div class="a-blobs"></div>
      <div class="a-blob-c"></div>

      <!-- Header -->
      <div class="a-header">
        <div>
          <h1 class="a-title">Alertes</h1>
          <p class="a-sub">
            @if (activeTab() === 'alerts') {
              {{ alerts().length }} affichée{{ alerts().length > 1 ? 's' : '' }}
              @if (filterActive()) {
                <span class="a-sub-filter">· filtre actif</span>
              } @else if (totalUnack() > alerts().length) {
                · {{ totalUnack() }} non acquittée{{ totalUnack() > 1 ? 's' : '' }} au total
              }
            } @else {
              Configurez les règles de notification par type et par véhicule
            }
          </p>
        </div>
        @if (activeTab() === 'alerts' && perms.can('alerts_acknowledge') && !showAcknowledged() && alerts().length > 0) {
          <button (click)="onAcknowledgeAll()" class="a-ack-all">
            <lucide-icon [img]="CheckCheck" [size]="14"></lucide-icon> Tout acquitter
          </button>
        }
      </div>

      <!-- Main tabs: Alertes / Réglages -->
      <div class="main-tabs">
        <button class="main-tab" [class.active]="activeTab() === 'alerts'" (click)="activeTab.set('alerts')">
          <lucide-icon [img]="AlertTriangle" [size]="14"></lucide-icon>
          Alertes
          @if (totalUnack() > 0) {
            <span class="tab-badge" [class.critical]="hasCriticalUnack()">{{ totalUnack() }}</span>
          }
        </button>
        @if (perms.can('alerts_configure')) {
          <button class="main-tab" [class.active]="activeTab() === 'settings'" (click)="switchToSettings()">
            <lucide-icon [img]="SettingsIcon" [size]="14"></lucide-icon>
            Réglages
          </button>
        }
      </div>

      <!-- ═══════════════ TAB: ALERTES ═══════════════ -->
      @if (activeTab() === 'alerts') {
        <!-- Filters -->
        <div class="a-filters">
          @for (sev of severities; track sev.value) {
            <button (click)="filterSeverity.set(filterSeverity() === sev.value ? null : sev.value); reload()"
              class="a-filter" [class.active]="filterSeverity() === sev.value" [class]="sev.css">
              <span class="a-filter-dot" [class]="sev.dot"></span>
              {{ sev.label }}
            </button>
          }
          <button (click)="showAcknowledged.set(!showAcknowledged()); reload()"
            class="a-filter" [class.active]="showAcknowledged()">
            <lucide-icon [img]="Check" [size]="11"></lucide-icon> Acquittées
          </button>
          @if (vehicleOptions().length > 1) {
            <select class="a-filter a-filter-select"
                    [class.active]="!!filterVehicleId()"
                    [value]="filterVehicleId() ?? ''"
                    (change)="onVehicleChange($any($event.target).value)"
                    aria-label="Filtrer par véhicule">
              <option value="">Tous véhicules</option>
              @for (v of vehicleOptions(); track v.id) {
                <option [value]="v.id">{{ v.plate }}</option>
              }
            </select>
          }
        </div>

        <!-- Installations à revoir : dérivé du parc (boîtier posé < 1 mois + hors-ligne). -->
        @if (vehiclesToReview().length > 0) {
          <div class="a-review-banner">
            <div class="a-review-head">
              <lucide-icon [img]="AlertTriangle" [size]="15"></lucide-icon>
              <span class="a-review-title">{{ vehiclesToReview().length }} installation(s) à revoir</span>
              <span class="a-review-sub">boîtier posé récemment qui se déconnecte — à vérifier au plus vite</span>
            </div>
            <div class="a-review-list">
              @for (v of vehiclesToReview(); track v.vehicleId) {
                <a [routerLink]="['/vehicles', v.vehicleId]" class="a-review-item">
                  <span class="a-review-plate">{{ v.plate }}</span>
                  <app-install-review-badge [compact]="true" />
                </a>
              }
            </div>
          </div>
        }

        @if (alerts().length === 0 && !loading()) {
          <div class="a-empty">
            <div class="a-empty-icon"><lucide-icon [img]="AlertTriangle" [size]="28"></lucide-icon></div>
            <p>Aucune alerte</p>
          </div>
        }

        <!-- Timeline -->
        <div class="timeline">
          @for (cluster of groupedAlerts(); track cluster.key; let i = $index) {
            <div class="tl-item" [class.acked]="cluster.unackCount === 0">
              <div class="tl-line-wrap">
                <div class="tl-node" [class]="cluster.severity === 'CRITICAL' ? 'critical' : cluster.severity === 'WARNING' ? 'warning' : 'info'">
                  @if (cluster.severity === 'CRITICAL' && cluster.unackCount > 0) {
                    <span class="tl-pulse" [class]="'critical'"></span>
                  }
                </div>
                @if (i < groupedAlerts().length - 1) {
                  <div class="tl-line"></div>
                }
              </div>

              <div class="tl-card" [class]="cluster.severity === 'CRITICAL' ? 'sev-critical' : cluster.severity === 'WARNING' ? 'sev-warning' : 'sev-info'">
                <div class="tl-card-top">
                  <div class="tl-card-info">
                    <span class="tl-alert-title">{{ cluster.lead.title }}</span>
                    <span class="tl-severity" [class]="severityBadge(cluster.severity)">{{ severityLabel(cluster.severity) }}</span>
                    @if (cluster.count > 1) {
                      <span class="tl-count" [attr.title]="cluster.count + ' alertes regroupées'">×{{ cluster.count }}</span>
                    }
                    @if (cluster.maxSpeed) {
                      <span class="tl-speed-badge">
                        <lucide-icon [img]="GaugeIcon" [size]="10"></lucide-icon>
                        {{ cluster.count > 1 ? 'max ' : '' }}{{ cluster.maxSpeed }} km/h
                      </span>
                    }
                    <!-- V1.15 — Badge fleet (visible SA only). -->
                    <app-sa-fleet-badge [fleetId]="cluster.lead.fleetId" />
                  </div>
                  <span class="tl-time">{{ relativeTime(cluster.newestAt) }}</span>
                </div>
                <div class="tl-card-mid">
                  @if (cluster.vehicleId) {
                    <a [routerLink]="['/vehicles', cluster.vehicleId]" class="tl-vehicle">
                      {{ alertVehiclePlate(cluster.lead) }}
                    </a>
                  }
                  @if (cluster.lead.vehicle?.group; as g) { <app-group-badge [group]="g" /> }
                  @if (cluster.lead.message) {
                    <span class="tl-msg">{{ cluster.lead.message }}</span>
                  }
                </div>

                @if (cluster.count > 1) {
                  <button class="tl-expand" (click)="toggleCluster(cluster.key)" [attr.aria-expanded]="isClusterExpanded(cluster.key)">
                    <lucide-icon [img]="isClusterExpanded(cluster.key) ? ChevronDownIcon : ChevronRightIcon" [size]="13"></lucide-icon>
                    <span>{{ cluster.count }} occurrences</span>
                    @if (cluster.avgSpeed) {
                      <span class="tl-expand-stats">· moy {{ cluster.avgSpeed }} · max {{ cluster.maxSpeed }} km/h</span>
                    }
                  </button>
                  @if (isClusterExpanded(cluster.key)) {
                    <div class="tl-occurrences">
                      @for (it of cluster.items; track it.id) {
                        <div class="tl-occ" [class.acked]="isAcknowledged(it)">
                          <span class="tl-occ-time">{{ occTime(it.createdAt) }}</span>
                          @if (alertSpeed(it); as sp) { <span class="tl-occ-speed">{{ sp }} km/h</span> }
                          @if (isAcknowledged(it)) { <lucide-icon [img]="Check" [size]="10" class="tl-occ-ack"></lucide-icon> }
                        </div>
                      }
                    </div>
                  }
                }

                @if (cluster.unackCount > 0 && perms.can('alerts_acknowledge')) {
                  <div class="tl-card-bottom">
                    <button (click)="acknowledgeCluster(cluster)" class="tl-ack-btn">
                      <lucide-icon [img]="Check" [size]="12"></lucide-icon>
                      {{ cluster.unackCount > 1 ? 'Acquitter (' + cluster.unackCount + ')' : 'Acquitter' }}
                    </button>
                  </div>
                } @else {
                  <div class="tl-card-bottom">
                    <span class="tl-acked"><lucide-icon [img]="Check" [size]="10"></lucide-icon> Acquittée{{ cluster.count > 1 ? 's' : '' }}</span>
                  </div>
                }
              </div>
            </div>
          }
        </div>

        @if (nextCursor()) {
          <button (click)="loadMore()" [disabled]="loading()" class="a-load-more">
            Charger plus
          </button>
        }
      }

      <!-- ═══════════════ TAB: RÉGLAGES ═══════════════ -->
      @if (activeTab() === 'settings') {
        <div class="cfg-section">

          <!-- Vehicle filter for rules -->
          <div class="cfg-toolbar">
            <select class="cfg-vehicle-select"
                    [value]="ruleVehicleFilter() ?? ''"
                    (change)="ruleVehicleFilter.set($any($event.target).value || null)"
                    aria-label="Filtrer les règles par véhicule">
              <option value="">Toute la flotte</option>
              @for (v of vehicleOptions(); track v.id) {
                <option [value]="v.id">{{ v.plate }}</option>
              }
            </select>
            @if (canEditRules()) {
              <button class="cfg-btn-add" (click)="openCreateRule()">
                <lucide-icon [img]="PlusIcon" [size]="14"></lucide-icon>
                Ajouter une règle
              </button>
            }
          </div>

          @if (!canEditRules()) {
            <div class="cfg-info-box">
              <lucide-icon [img]="BellIcon" [size]="18"></lucide-icon>
              <div>
                <strong>Lecture seule</strong>
                <p>Seul un administrateur peut créer ou modifier les règles de notification.</p>
              </div>
            </div>
          }

          @if (filteredRules().length === 0) {
            <div class="cfg-empty">
              <p>Aucune règle configurée{{ ruleVehicleFilter() ? ' pour ce véhicule' : '' }}.</p>
              <p class="cfg-empty-hint">Par défaut, les alertes sont notifiées in-app uniquement.</p>
            </div>
          } @else {
            <div class="cfg-rules-grid">
              @for (rule of filteredRules(); track rule.id) {
                <div class="cfg-rule-card">
                  <div class="cfg-rule-header">
                    <div class="cfg-rule-type">
                      <span class="cfg-sev-dot" [class]="ruleSeverityClass(rule.alertType)"></span>
                      {{ alertTypeLabel(rule.alertType) }}
                    </div>
                    <div class="cfg-rule-status">
                      @if (rule.enabled) {
                        <span class="cfg-pill cfg-pill-on">Actif</span>
                      } @else {
                        <span class="cfg-pill cfg-pill-off">Désactivé</span>
                      }
                    </div>
                  </div>
                  <div class="cfg-rule-body">
                    @if (rule.vehicleId) {
                      <div class="cfg-rule-vehicle">
                        Véhicule : <strong>{{ ruleVehiclePlate(rule.vehicleId) }}</strong>
                      </div>
                    } @else {
                      <div class="cfg-rule-vehicle fleet-wide">Toute la flotte</div>
                    }
                    <div class="cfg-rule-channels">
                      @for (c of rule.channels; track c) {
                        @if (c !== 'IN_APP') {
                          <span class="cfg-ch-pill">{{ channelIcon(c) }} {{ channelLabel(c) }}</span>
                        }
                      }
                      @if (rule.channels.length === 0 || (rule.channels.length === 1 && rule.channels[0] === 'IN_APP')) {
                        <span class="cfg-ch-pill muted">In-app seulement</span>
                      }
                    </div>
                    @if (rule.escalateAfterMin) {
                      <div class="cfg-rule-escalation">
                        Escalade après {{ rule.escalateAfterMin }} min
                      </div>
                    }
                  </div>
                  @if (canEditRules()) {
                    <div class="cfg-rule-actions">
                      <button class="cfg-btn-icon" (click)="openEditRule(rule)" aria-label="Modifier">
                        <lucide-icon [img]="Edit2Icon" [size]="13"></lucide-icon>
                      </button>
                      <button class="cfg-btn-icon cfg-btn-danger" (click)="deleteRule(rule)" aria-label="Supprimer">
                        <lucide-icon [img]="Trash2Icon" [size]="13"></lucide-icon>
                      </button>
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>

        <!-- Rule create/edit modal -->
        @if (ruleFormOpen()) {
          <div class="cfg-modal-overlay" (click)="closeRuleForm()">
            <div class="cfg-modal" (click)="$event.stopPropagation()">
              <div class="cfg-modal-header">
                <h2>{{ ruleForm().id ? 'Modifier' : 'Nouvelle' }} règle</h2>
                <button class="cfg-btn-icon" (click)="closeRuleForm()">
                  <lucide-icon [img]="XCircleIcon" [size]="18"></lucide-icon>
                </button>
              </div>
              <div class="cfg-modal-body">
                <div class="cfg-field">
                  <label>Type d'alerte</label>
                  <select [(ngModel)]="formAlertType">
                    @for (t of alertTypes; track t.value) {
                      <option [value]="t.value">{{ t.severity === 'critical' ? '🔴' : t.severity === 'warning' ? '🟠' : t.severity === 'info' ? '🔵' : '⚪' }} {{ t.label }}</option>
                    }
                  </select>
                </div>

                <div class="cfg-field">
                  <label>Véhicule</label>
                  <select [(ngModel)]="formVehicleId">
                    <option [ngValue]="null">Toute la flotte</option>
                    @for (v of vehicleOptions(); track v.id) {
                      <option [value]="v.id">{{ v.plate }}</option>
                    }
                  </select>
                  <span class="cfg-field-hint">Laisser vide pour appliquer à toute la flotte</span>
                </div>

                <div class="cfg-field">
                  <label>Canaux de notification</label>
                  <div class="cfg-channel-toggles">
                    @for (c of allChannels; track c.value) {
                      <label class="cfg-channel-toggle">
                        <input type="checkbox"
                               [checked]="ruleForm().channels.includes(c.value)"
                               (change)="toggleRuleChannel(c.value, $any($event.target).checked)" />
                        <span>{{ c.icon }} {{ c.label }}</span>
                      </label>
                    }
                  </div>
                </div>

                <div class="cfg-field">
                  <label>Escalader après (min)</label>
                  <input type="number" min="1" max="120" placeholder="ex: 10"
                         [ngModel]="ruleForm().escalateAfterMin"
                         (ngModelChange)="updateRuleForm({ escalateAfterMin: $event ? Number($event) : null })" />
                  <span class="cfg-field-hint">Si l'alerte critique n'est pas acquittée après ce délai, escalader</span>
                </div>

                <label class="cfg-checkbox-row">
                  <input type="checkbox" [ngModel]="ruleForm().enabled"
                         (ngModelChange)="updateRuleForm({ enabled: $event })" />
                  Règle active
                </label>
              </div>
              <div class="cfg-modal-footer">
                <button class="cfg-btn-ghost" (click)="closeRuleForm()">Annuler</button>
                <button class="cfg-btn-primary" (click)="saveRule()" [disabled]="ruleSaving()">
                  {{ ruleSaving() ? 'Enregistrement...' : 'Enregistrer' }}
                </button>
              </div>
            </div>
          </div>
        }
      }

    </div>
    }
  `,
  styles: [`
    /* ═══════════════════════════════════════════════════════
       Baanool view
       ═══════════════════════════════════════════════════════ */
    .bn-alerts { background: white; min-height: 100%; display: flex; flex-direction: column; }
    .bn-alerts-header {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 16px; border-bottom: 1px solid #eee; background: white;
    }
    .bn-back, .bn-more {
      width: 36px; height: 36px; border-radius: 50%; border: none;
      background: transparent; display: flex; align-items: center; justify-content: center;
      cursor: pointer; color: #333;
    }
    .bn-title { flex: 1; text-align: center; font-size: 17px; font-weight: 600; margin: 0; color: #333; }
    .bn-tabs { display: flex; gap: 0; border-bottom: 1px solid #eee; background: white; }
    .bn-tab {
      flex: 1; padding: 14px 8px; background: none; border: none;
      border-bottom: 2px solid transparent;
      font-size: 15px; color: #999; cursor: pointer; transition: color 120ms, border-color 120ms;
    }
    .bn-tab.active { color: #00c896; border-bottom-color: #00c896; font-weight: 600; }
    .bn-empty {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 12px; padding: 40px 16px; color: #ccc;
    }
    .bn-empty-icon { opacity: 0.5; }
    .bn-empty-text { color: #999; font-size: 14px; margin: 0; }
    .bn-list { flex: 1; overflow-y: auto; }
    .bn-row {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 16px; border-bottom: 1px solid #f5f5f5; background: white;
    }
    .bn-row--acked { opacity: 0.5; }
    .bn-row-icon {
      width: 36px; height: 36px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .bn-row-icon.sev-CRITICAL { background: #fee; color: #d32f2f; }
    .bn-row-icon.sev-WARNING { background: #fff3e0; color: #f57c00; }
    .bn-row-icon.sev-INFO { background: #e3f2fd; color: #1976d2; }
    .bn-row-main { flex: 1; min-width: 0; }
    .bn-row-title { font-size: 14px; color: #333; font-weight: 500; }
    .bn-row-meta { font-size: 12px; color: #999; margin-top: 2px; }
    .bn-speed { color: #f57c00; font-weight: 600; }
    .bn-count { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 9999px; font-size: 11px; font-weight: 800; background: rgba(16,224,160,.18); color: var(--tracky-light); }
    .bn-row-ack {
      width: 32px; height: 32px; border-radius: 50%;
      background: #00c896; color: white; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }

    /* ═══════════════════════════════════════════════════════
       Main page (Tracky mode)
       ═══════════════════════════════════════════════════════ */
    .a-page { position: relative; min-height: 100% }
    .a-blobs { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden }
    .a-blobs::before {
      content: ''; position: absolute; top: -5%; right: -5%; width: 40%; height: 45%;
      background: radial-gradient(ellipse, rgba(239,68,68,.05) 0%, transparent 70%);
      border-radius: 50% 40% 60% 30%; animation: ab1 11s ease-in-out infinite alternate;
    }
    .a-blobs::after {
      content: ''; position: absolute; bottom: -10%; left: -8%; width: 45%; height: 50%;
      background: radial-gradient(ellipse, rgba(245,158,11,.05) 0%, transparent 70%);
      border-radius: 40% 60% 30% 50%; animation: ab2 13s ease-in-out infinite alternate;
    }
    .a-blob-c {
      position: fixed; top: 50%; left: 40%; transform: translate(-50%,-50%); width: 30%; height: 35%;
      background: radial-gradient(ellipse, rgba(59,130,246,.04) 0%, transparent 70%);
      border-radius: 60% 40% 50% 30%; pointer-events: none; z-index: 0;
      animation: ab3 15s ease-in-out infinite alternate;
    }
    @keyframes ab1 { 0%{border-radius:50% 40% 60% 30%;transform:translate(0,0)} 100%{border-radius:30% 60% 40% 50%;transform:translate(-3%,5%)} }
    @keyframes ab2 { 0%{border-radius:40% 60% 30% 50%;transform:translate(0,0)} 100%{border-radius:60% 30% 50% 40%;transform:translate(3%,-3%)} }
    @keyframes ab3 { 0%{border-radius:60% 40% 50% 30%;transform:translate(-50%,-50%) scale(1)} 100%{border-radius:40% 50% 30% 60%;transform:translate(-50%,-50%) scale(1.1)} }

    .a-header { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px }
    .a-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .a-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .a-sub-filter { color: var(--tracky-light); font-weight: 600; margin-left: 4px }
    .a-ack-all {
      display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px;
      font-size: 12px; font-weight: 700; background: rgba(16,224,160,.1); color: var(--tracky-light);
      border: 1px solid rgba(16,224,160,.2); cursor: pointer; transition: all .2s; white-space: nowrap;
    }
    .a-ack-all:hover { background: rgba(16,224,160,.18) }

    /* ─── Main Tabs ─── */
    .main-tabs {
      position: relative; z-index: 1; display: flex; gap: 4px; margin-bottom: 16px;
      padding: 4px; border-radius: 12px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5);
      backdrop-filter: blur(8px); border: 1px solid var(--border-subtle);
    }
    .main-tab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 16px; border-radius: 8px; border: none;
      font-size: 12px; font-weight: 600; color: var(--fg-tertiary);
      background: transparent; cursor: pointer; transition: all .2s;
    }
    .main-tab:hover { color: var(--fg-secondary) }
    .main-tab.active {
      background: rgba(16,224,160,.1); color: var(--tracky-light);
      box-shadow: 0 1px 3px rgba(0,0,0,.1);
    }
    .tab-badge {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      font-size: 10px; font-weight: 700;
      background: rgba(245,158,11,.15); color: #f59e0b;
    }
    .tab-badge.critical { background: rgba(239,68,68,.15); color: #ef4444; animation: pulse-badge 2s infinite; }
    @keyframes pulse-badge { 0%,100%{opacity:1} 50%{opacity:.6} }

    /* ─── Filters ─── */
    .a-filters { position: relative; z-index: 1; display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px }
    .a-filter {
      display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 20px;
      font-size: 11px; font-weight: 600; background: rgba(var(--bg-secondary-rgb,15,23,20),.5);
      backdrop-filter: blur(8px); border: 1px solid var(--border-subtle); color: var(--fg-tertiary);
      cursor: pointer; transition: all .2s;
    }
    .a-filter:hover { color: var(--fg-secondary) }
    .a-filter.active { border-color: rgba(16,224,160,.3); color: var(--tracky-light); background: rgba(16,224,160,.08) }
    .a-filter-select {
      appearance: none; -webkit-appearance: none;
      padding-right: 26px;
      background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%2364748b' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
      max-width: 160px;
    }
    .a-filter-dot { width: 6px; height: 6px; border-radius: 50% }
    .a-filter-dot.red { background: #ef4444 }
    .a-filter-dot.amber { background: #f59e0b }
    .a-filter-dot.blue { background: #3b82f6 }

    .a-review-banner {
      margin-bottom: 14px; padding: 12px 14px; border-radius: 12px;
      background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.3);
    }
    .a-review-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: #ef4444 }
    .a-review-title { font-weight: 800; font-size: 13px }
    .a-review-sub { font-size: 11px; color: var(--fg-tertiary); font-weight: 500 }
    .a-review-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px }
    .a-review-item {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 9999px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); text-decoration: none;
      font-size: 12px; font-weight: 700; color: var(--fg-primary); transition: border-color .15s;
    }
    .a-review-item:hover { border-color: rgba(239,68,68,.4) }
    .a-review-plate { letter-spacing: .02em }
    .a-empty {
      position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 50px 20px; border-radius: 16px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5); backdrop-filter: blur(16px);
      border: 1px solid rgba(16,224,160,.08); color: var(--fg-tertiary); font-size: 14px;
    }
    .a-empty-icon { width: 56px; height: 56px; border-radius: 14px; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; color: var(--fg-tertiary) }

    /* ─── Timeline ─── */
    .timeline {
      position: relative; z-index: 1; display: flex; flex-direction: column; gap: 0; padding-left: 6px;
      padding-bottom: 140px;
    }
    @media (min-width: 768px) { .timeline { padding-bottom: 24px } }

    .tl-item { display: flex; gap: 16px; position: relative }
    .tl-item.acked { opacity: .5 }

    .tl-line-wrap { display: flex; flex-direction: column; align-items: center; width: 16px; flex-shrink: 0; padding-top: 4px }
    .tl-node { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; position: relative; z-index: 1 }
    .tl-node.critical { background: #ef4444; box-shadow: 0 0 8px rgba(239,68,68,.5) }
    .tl-node.warning { background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,.4) }
    .tl-node.info { background: #3b82f6; box-shadow: 0 0 6px rgba(59,130,246,.4) }
    .tl-pulse { position: absolute; inset: -4px; border-radius: 50%; animation: tlpulse 2s ease infinite; }
    .tl-pulse.critical { background: rgba(239,68,68,.3) }
    @keyframes tlpulse { 0%,100%{transform:scale(1);opacity:.6} 50%{transform:scale(1.8);opacity:0} }
    .tl-line { width: 2px; flex: 1; min-height: 16px; background: var(--border-subtle); margin: 4px 0 }

    .tl-card {
      flex: 1; padding: 14px 16px; border-radius: 12px; margin-bottom: 12px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,.04); transition: all .25s;
    }
    .tl-card:hover { transform: translateX(4px) }
    .tl-card.sev-critical { border-left: 3px solid #ef4444 }
    .tl-card.sev-warning { border-left: 3px solid #f59e0b }
    .tl-card.sev-info { border-left: 3px solid #3b82f6 }
    :host-context([data-theme="light"]) .tl-card { background: rgba(255,255,255,.55); border-color: rgba(0,0,0,.06) }

    .tl-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px }
    .tl-card-info { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; flex-wrap: wrap }
    .tl-alert-title { font-size: 13px; font-weight: 700; color: var(--fg-primary) }
    .tl-severity { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: .04em }
    .tl-speed-badge {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 7px; border-radius: 6px; font-size: 10px; font-weight: 700;
      background: rgba(245,158,11,.12); color: #f59e0b;
    }
    .tl-count {
      display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 9999px;
      font-size: 10px; font-weight: 800; letter-spacing: .02em;
      background: var(--tracky-light, #10E0A0); color: #04140d;
    }
    .tl-expand {
      display: inline-flex; align-items: center; gap: 5px; margin-top: 8px;
      padding: 3px 9px; border-radius: 7px; font-size: 10px; font-weight: 600;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); cursor: pointer; transition: all .15s;
    }
    .tl-expand:hover { color: var(--fg-primary); border-color: var(--border-strong) }
    .tl-expand-stats { color: var(--fg-tertiary); font-weight: 500 }
    .tl-occurrences {
      margin-top: 6px; display: flex; flex-direction: column; gap: 2px;
      max-height: 220px; overflow-y: auto; padding: 6px 9px; border-radius: 8px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
    }
    .tl-occ {
      display: flex; align-items: center; gap: 10px; font-size: 10px; color: var(--fg-secondary);
      padding: 3px 0; border-bottom: 1px solid var(--border-subtle);
    }
    .tl-occ:last-child { border-bottom: none }
    .tl-occ.acked { opacity: .5 }
    .tl-occ-time { font-family: var(--font-mono, monospace); color: var(--fg-tertiary); min-width: 64px }
    .tl-occ-speed { font-weight: 700; color: #f59e0b }
    .tl-occ-ack { color: var(--tracky-light); margin-left: auto }
    .tl-time { font-size: 10px; color: var(--fg-tertiary); white-space: nowrap; flex-shrink: 0 }

    .tl-card-mid { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap }
    .tl-vehicle { font-size: 11px; font-weight: 600; color: var(--tracky-light); text-decoration: none }
    .tl-vehicle:hover { text-decoration: underline }
    .tl-msg { font-size: 11px; color: var(--fg-tertiary) }

    .tl-card-bottom { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-subtle) }
    .tl-ack-btn {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 8px;
      font-size: 11px; font-weight: 600; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-tertiary); cursor: pointer; transition: all .2s;
    }
    .tl-ack-btn:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.2) }
    .tl-acked { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: var(--fg-tertiary) }

    .a-load-more {
      position: relative; z-index: 1; display: block; margin: 16px auto 0; padding: 10px 24px;
      border-radius: 10px; font-size: 12px; font-weight: 600;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5); backdrop-filter: blur(8px);
      border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; transition: all .2s;
    }
    .a-load-more:hover { color: var(--fg-primary); border-color: var(--border-strong) }

    /* ═══════════════════════════════════════════════════════
       Settings tab (Réglages)
       ═══════════════════════════════════════════════════════ */
    .cfg-section { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 16px }

    .cfg-toolbar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    .cfg-vehicle-select {
      padding: 8px 28px 8px 12px; border-radius: 10px; font-size: 12px; font-weight: 600;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5); backdrop-filter: blur(8px);
      border: 1px solid var(--border-subtle); color: var(--fg-secondary);
      appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%2364748b' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center;
      max-width: 200px; cursor: pointer;
    }
    .cfg-btn-add {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px; border-radius: 10px; font-size: 12px; font-weight: 700;
      background: var(--tracky); color: var(--bg-primary); border: none; cursor: pointer;
      margin-left: auto; transition: background .2s;
    }
    .cfg-btn-add:hover { background: var(--tracky-light) }

    .cfg-info-box {
      display: flex; gap: 12px; padding: 14px; border-radius: 12px;
      background: rgba(56,189,248,.08); border: 1px solid rgba(56,189,248,.2);
      color: var(--fg-secondary); font-size: 12px;
    }
    .cfg-info-box strong { display: block; margin-bottom: 2px; font-size: 13px }
    .cfg-info-box p { margin: 0 }

    .cfg-empty {
      padding: 40px 20px; text-align: center; border-radius: 16px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5); backdrop-filter: blur(16px);
      border: 1px solid var(--border-subtle); color: var(--fg-tertiary); font-size: 13px;
    }
    .cfg-empty-hint { font-size: 11px; margin-top: 6px; opacity: .7 }

    /* Rules grid — responsive cards */
    .cfg-rules-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;
    }
    .cfg-rule-card {
      border-radius: 12px; padding: 14px 16px;
      background: rgba(var(--bg-secondary-rgb,15,23,20),.5); backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,.04); transition: all .2s;
    }
    .cfg-rule-card:hover { border-color: rgba(16,224,160,.15) }
    :host-context([data-theme="light"]) .cfg-rule-card { background: rgba(255,255,255,.55); border-color: rgba(0,0,0,.06) }

    .cfg-rule-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px }
    .cfg-rule-type { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; color: var(--fg-primary) }
    .cfg-sev-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0 }
    .cfg-sev-dot.sev-critical { background: #ef4444 }
    .cfg-sev-dot.sev-warning { background: #f59e0b }
    .cfg-sev-dot.sev-info { background: #3b82f6 }
    .cfg-sev-dot.sev-all { background: linear-gradient(135deg, #ef4444, #f59e0b, #3b82f6) }
    .cfg-pill { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 9999px }
    .cfg-pill-on { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .cfg-pill-off { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .cfg-rule-body { display: flex; flex-direction: column; gap: 6px }
    .cfg-rule-vehicle { font-size: 11px; color: var(--fg-tertiary) }
    .cfg-rule-vehicle.fleet-wide { color: var(--tracky-light); font-weight: 600 }
    .cfg-rule-channels { display: flex; gap: 4px; flex-wrap: wrap }
    .cfg-ch-pill {
      padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 600;
      background: var(--bg-tertiary); color: var(--fg-secondary);
    }
    .cfg-ch-pill.muted { color: var(--fg-tertiary) }
    .cfg-rule-escalation { font-size: 10px; color: var(--fg-tertiary); font-style: italic }
    .cfg-rule-actions {
      display: flex; gap: 4px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-subtle);
    }
    .cfg-btn-icon {
      background: transparent; border: 0; color: var(--fg-tertiary);
      padding: 6px; border-radius: 6px; cursor: pointer; transition: all .15s;
    }
    .cfg-btn-icon:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .cfg-btn-danger:hover { color: #f87171 }

    /* ─── Modal ─── */
    .cfg-modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,.5);
      display: flex; align-items: center; justify-content: center;
      z-index: 100; padding: 16px;
    }
    .cfg-modal {
      background: var(--bg-secondary); border-radius: 16px;
      width: 100%; max-width: 480px; max-height: 90vh; overflow-y: auto;
      border: 1px solid var(--border-subtle);
    }
    .cfg-modal-header, .cfg-modal-footer {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 18px; border-bottom: 1px solid var(--border-subtle);
    }
    .cfg-modal-footer { border-top: 1px solid var(--border-subtle); border-bottom: 0; gap: 8px }
    .cfg-modal-header h2 { margin: 0; font-size: 16px; font-weight: 700; color: var(--fg-primary) }
    .cfg-modal-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 16px }
    .cfg-field { display: flex; flex-direction: column; gap: 6px }
    .cfg-field label { font-size: 11px; font-weight: 600; color: var(--fg-tertiary); text-transform: uppercase }
    .cfg-field select, .cfg-field input[type="number"] {
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); padding: 8px 10px; border-radius: 8px; font-size: 13px;
    }
    .cfg-field-hint { font-size: 10px; color: var(--fg-tertiary) }
    .cfg-channel-toggles { display: flex; flex-direction: column; gap: 6px }
    .cfg-channel-toggle {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; background: var(--bg-tertiary); border-radius: 8px;
      cursor: pointer; font-size: 13px; color: var(--fg-primary);
    }
    .cfg-channel-toggle:hover { background: var(--bg-primary) }
    .cfg-checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: var(--fg-primary) }
    .cfg-btn-ghost {
      background: transparent; color: var(--fg-secondary);
      border: 1px solid var(--border-subtle); padding: 8px 14px; border-radius: 8px;
      font-size: 12px; cursor: pointer;
    }
    .cfg-btn-primary {
      background: var(--tracky); color: var(--bg-primary);
      border: 0; padding: 8px 14px; border-radius: 8px;
      font-weight: 600; font-size: 12px; cursor: pointer;
    }
    .cfg-btn-primary:hover { background: var(--tracky-light) }
    .cfg-btn-primary:disabled { opacity: .5; cursor: not-allowed }

    @media (max-width: 480px) {
      .a-title { font-size: 20px }
      .a-ack-all { padding: 6px 12px; font-size: 11px }
      .tl-item { gap: 10px }
      .tl-card { padding: 12px 14px }
      .main-tab { padding: 6px 10px; font-size: 11px }
      .cfg-rules-grid { grid-template-columns: 1fr }
    }
  `],
})
export class AlertsComponent implements OnInit {
  private readonly alertsApi = inject(AlertsApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly notifApi = inject(NotificationsApiService);
  protected readonly perms = inject(PermissionsService);

  // V1.12 — Mode Baanool
  protected readonly isBaanoolMode = computed(() => this.auth.user()?.preferences?.uiMode === 'baanool');
  protected readonly bnTab = signal<'alarms' | 'notifs'>('alarms');
  protected readonly ChevronLeftIcon = ChevronLeft;
  protected readonly MoreVerticalIcon = MoreVertical;

  goBack(): void { void this.router.navigate(['/map']); }
  formatRelative(ts: string | Date): string { return relativeTime(ts); }

  severityIcon(sev: string): typeof AlertTriangle {
    if (sev === 'CRITICAL') return AlertCircle;
    if (sev === 'WARNING') return AlertTriangle;
    return Info;
  }

  private static readonly ALERT_LABELS_FR: Record<string, string> = {
    SOS: 'SOS',
    POWER_CUT: 'Coupure d\'alimentation',
    ACCIDENT: 'Accident',
    COLLISION: 'Collision',
    LOW_BATTERY: 'Batterie faible',
    OVERSPEED: 'Excès de vitesse',
    GEOFENCE_ENTER: 'Entrée géofence',
    GEOFENCE_EXIT: 'Sortie géofence',
    MOVEMENT_IDLE: 'Mouvement à l\'arrêt',
    HARSH_BRAKING: 'Freinage brusque',
    HARSH_ACCELERATION: 'Accélération brusque',
    HARSH_TURN: 'Virage brusque',
    BONNET: 'Capot ouvert',
    DOOR: 'Porte ouverte',
    VIBRATION: 'Vibration détectée',
    TOW: 'Remorquage détecté',
    TAMPER: 'Tentative de sabotage',
    FATIGUE: 'Fatigue conducteur',
    ILLEGAL_IGNITION: 'Démarrage non autorisé',
    GPS_LOST: 'Perte du signal GPS',
    IDLE_TIME: 'Temps d\'arrêt prolongé',
    SURVEILLANCE_TRIGGERED: 'Surveillance déclenchée',
    UNKNOWN: 'Alerte inconnue',
  };

  alertLabel(alert: AlertEvent): string {
    if (!alert.type) return 'Alerte';
    return AlertsComponent.ALERT_LABELS_FR[alert.type]
      ?? alert.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  }

  /** Extract speed from alert — either from the enriched field or the payload. */
  alertSpeed(alert: any): number | null {
    const speed = alert.speedKmh ?? alert.payload?.speedKmh;
    if (typeof speed === 'number' && speed > 0) return Math.round(speed);
    return null;
  }

  // ─── Tab state ────────────────────────────────────────────
  protected readonly activeTab = signal<'alerts' | 'settings'>('alerts');

  // ─── Alerts tab state ─────────────────────────────────────
  protected readonly alerts = signal<AlertEvent[]>([]);
  protected readonly loading = signal(false);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly filterSeverity = signal<string | null>(null);
  protected readonly showAcknowledged = signal(false);
  protected readonly filterVehicleId = signal<string | null>(null);

  // ─── Regroupement anti-spam des alertes ───────────────────────────────────
  /**
   * Fusionne les alertes de `alerts()` (triées desc) en clusters : occurrences
   * consécutives d'un même véhicule + type espacées de < 30 min. Robuste à
   * l'entrelacement (cluster ouvert mémorisé par clé véhicule|type).
   */
  protected readonly groupedAlerts = computed<AlertCluster[]>(() => {
    const WINDOW_MS = 30 * 60 * 1000;
    const clusters: AlertCluster[] = [];
    const openByKey = new Map<string, AlertCluster>();
    for (const a of this.alerts()) {
      const key = `${a.vehicleId ?? 'none'}|${a.type}`;
      const open = openByKey.get(key);
      const aMs = new Date(a.createdAt).getTime();
      if (open && new Date(open.oldestAt).getTime() - aMs <= WINDOW_MS) {
        open.items.push(a);
        open.oldestAt = a.createdAt;
      } else {
        const c: AlertCluster = {
          key: `${key}|${a.id}`, lead: a, items: [a], count: 1,
          vehicleId: a.vehicleId, type: a.type, severity: a.severity,
          newestAt: a.createdAt, oldestAt: a.createdAt,
          speeds: [], avgSpeed: null, maxSpeed: null, unackCount: 0,
        };
        clusters.push(c);
        openByKey.set(key, c);
      }
    }
    for (const c of clusters) {
      const speeds: number[] = [];
      let unack = 0;
      let rank = 0;
      for (const it of c.items) {
        const sp = this.alertSpeed(it);
        if (sp != null) speeds.push(sp);
        if (!this.isAcknowledged(it)) unack++;
        const r = it.severity === 'CRITICAL' ? 3 : it.severity === 'WARNING' ? 2 : 1;
        if (r > rank) { rank = r; c.severity = it.severity; }
      }
      c.count = c.items.length;
      c.speeds = speeds;
      c.maxSpeed = speeds.length ? Math.max(...speeds) : null;
      c.avgSpeed = speeds.length ? Math.round(speeds.reduce((s, x) => s + x, 0) / speeds.length) : null;
      c.unackCount = unack;
    }
    return clusters;
  });

  /** Clés de clusters dépliés (liste déroulante des occurrences ouverte). */
  protected readonly expandedClusters = signal<Set<string>>(new Set());
  protected toggleCluster(key: string): void {
    const next = new Set(this.expandedClusters());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.expandedClusters.set(next);
  }
  protected isClusterExpanded(key: string): boolean { return this.expandedClusters().has(key); }

  /** Heure locale HH:mm:ss d'une occurrence (sans DatePipe). */
  protected occTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ''; }
  }

  /** Acquitte toutes les occurrences non acquittées d'un cluster en une fois. */
  protected async acknowledgeCluster(cluster: AlertCluster): Promise<void> {
    const ids = cluster.items.filter((a) => !this.isAcknowledged(a)).map((a) => a.id);
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((id) => firstValueFrom(this.alertsApi.acknowledge(id))));
      const idSet = new Set(ids);
      this.alerts.update((l) =>
        l.map((a) => (idSet.has(a.id) ? ({ ...a, acknowledgedAt: new Date().toISOString() } as any) : a)),
      );
      ids.forEach((id) => this.realtime.dismissAlert(id));
      this.toast.success(ids.length > 1 ? `${ids.length} alertes acquittées` : 'Alerte acquittée');
    } catch { /* handled */ }
  }

  protected readonly vehicleOptions = computed(() =>
    this.realtime.snapshot()
      .map((v) => ({ id: v.vehicleId, plate: v.plate }))
      .sort((a, b) => a.plate.localeCompare(b.plate)),
  );

  /**
   * Véhicules dont l'installation est à revoir : boîtier posé depuis < 1 mois
   * mais hors-ligne (a déjà communiqué). Dérivé du snapshot flotte → visible par
   * tous les rôles ayant accès, y compris FLEET_ADMIN.
   */
  protected readonly vehiclesToReview = computed(() =>
    this.realtime.snapshot().filter((v) =>
      isInstallationToReview(
        getVehicleConnectivityState({ trackerId: v.trackerId, lastSeenAt: v.lastSeenAt }),
        v.trackerCreatedAt,
      ),
    ),
  );

  protected onVehicleChange(id: string): void {
    this.filterVehicleId.set(id || null);
    this.reload();
  }

  protected reload(): void { this.loadAlerts(); }

  protected readonly totalUnack = this.realtime.unacknowledgedCount;
  protected readonly hasCriticalUnack = computed(() => this.realtime.hasCritical());

  protected readonly filterActive = computed(() =>
    !!this.filterSeverity() || !!this.filterVehicleId() || this.showAcknowledged(),
  );

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly AlertCircle = AlertCircle;
  protected readonly Info = Info;
  protected readonly Check = Check;
  protected readonly CheckCheck = CheckCheck;
  protected readonly GaugeIcon = Gauge;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly SettingsIcon = Settings;
  protected readonly BellIcon = Bell;
  protected readonly PlusIcon = Plus;
  protected readonly Edit2Icon = Edit2;
  protected readonly Trash2Icon = Trash2;
  protected readonly XCircleIcon = XCircle;
  protected readonly relativeTime = relativeTime;

  protected readonly severities = [
    { value: 'CRITICAL', label: 'Critiques', css: '', dot: 'red' },
    { value: 'WARNING', label: 'Avertissements', css: '', dot: 'amber' },
    { value: 'INFO', label: 'Informations', css: '', dot: 'blue' },
  ];

  private lastWsCount = -1;

  private syncEffect = effect(() => {
    const count = this.realtime.alerts().length;
    if (count !== this.lastWsCount) {
      this.lastWsCount = count;
      this.loadAlerts();
    }
  });

  ngOnInit(): void {}

  protected isAcknowledged(alert: any): boolean {
    return !!alert.acknowledgedAt;
  }

  protected alertVehiclePlate(alert: any): string {
    return alert?.vehicle?.plate ?? alert?.vehiclePlate ?? 'Véhicule';
  }

  protected severityBadge(severity: string): string {
    if (severity === 'CRITICAL') return 'bg-red-500/20 text-red-400';
    if (severity === 'WARNING') return 'bg-amber-500/20 text-amber-400';
    return 'bg-sky-500/20 text-sky-400';
  }

  protected severityLabel(severity: string): string {
    if (severity === 'CRITICAL') return 'Critique';
    if (severity === 'WARNING') return 'Avertissement';
    if (severity === 'INFO') return 'Info';
    return severity;
  }

  protected async onAcknowledge(id: string): Promise<void> {
    try {
      await firstValueFrom(this.alertsApi.acknowledge(id));
      this.alerts.update((list) =>
        list.map((a) => (a.id === id ? { ...a, acknowledgedAt: new Date().toISOString() } as any : a)),
      );
      this.realtime.dismissAlert(id);
      this.toast.success('Alerte acquittée');
    } catch { /* handled */ }
  }

  protected async onAcknowledgeAll(): Promise<void> {
    try {
      const ids = this.alerts().filter((a) => !this.isAcknowledged(a)).map((a) => a.id);
      const { count } = await firstValueFrom(this.alertsApi.acknowledgeAll());
      ids.forEach((id) => this.realtime.dismissAlert(id));
      this.toast.success(`${count} alertes acquittées`);
      this.loadAlerts();
    } catch { /* handled */ }
  }

  protected loadMore(): void {
    this.loadAlerts(this.nextCursor() ?? undefined);
  }

  private async loadAlerts(cursor?: string): Promise<void> {
    this.loading.set(true);
    try {
      const params: Record<string, string> = { limit: '20' };
      if (this.filterSeverity()) params['severity'] = this.filterSeverity()!;
      if (this.showAcknowledged()) params['acknowledged'] = 'true';
      else params['acknowledged'] = 'false';
      if (this.filterVehicleId()) params['vehicleId'] = this.filterVehicleId()!;
      if (cursor) params['cursor'] = cursor;

      const res = await firstValueFrom(this.alertsApi.list(params));
      if (cursor) {
        this.alerts.update((list) => [...list, ...res.items]);
      } else {
        this.alerts.set(res.items);
      }
      this.nextCursor.set(res.nextCursor);
    } catch { /* handled */ } finally {
      this.loading.set(false);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Settings tab — Alert Rules management
  // ═══════════════════════════════════════════════════════════
  protected readonly rules = signal<AlertRuleDto[]>([]);
  protected readonly ruleFormOpen = signal(false);
  protected readonly ruleForm = signal<RuleForm>({ ...EMPTY_FORM });
  protected readonly ruleSaving = signal(false);
  protected readonly ruleVehicleFilter = signal<string | null>(null);
  private rulesLoaded = false;

  protected readonly alertTypes = ALERT_TYPES;
  protected readonly allChannels = ALL_CHANNELS;
  protected readonly Number = Number;

  protected readonly canEditRules = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'FLEET_ADMIN' || role === 'SUPER_ADMIN';
  });

  /** Filter rules by vehicle selection. */
  protected readonly filteredRules = computed(() => {
    const vid = this.ruleVehicleFilter();
    if (!vid) return this.rules();
    return this.rules().filter((r) => r.vehicleId === vid || !r.vehicleId);
  });

  /** Lookup vehicle plate for a rule's vehicleId. */
  protected ruleVehiclePlate(vehicleId: string): string {
    return this.vehicleOptions().find((v) => v.id === vehicleId)?.plate ?? 'Véhicule';
  }

  /** Get severity CSS class for an alert type. */
  protected ruleSeverityClass(alertType: string): string {
    if (alertType === '*') return 'sev-all';
    const t = ALERT_TYPES.find((a) => a.value === alertType);
    if (t?.severity === 'critical') return 'sev-critical';
    if (t?.severity === 'warning') return 'sev-warning';
    return 'sev-info';
  }

  protected alertTypeLabel(value: string): string {
    return ALERT_TYPES.find((t) => t.value === value)?.label ?? value;
  }

  protected channelIcon(c: string): string {
    return ALL_CHANNELS.find((x) => x.value === c)?.icon ?? '';
  }

  protected channelLabel(c: string): string {
    return ALL_CHANNELS.find((x) => x.value === c)?.label ?? c;
  }

  /** Switch to settings tab and lazy-load rules. */
  protected async switchToSettings(): Promise<void> {
    this.activeTab.set('settings');
    if (!this.rulesLoaded) {
      await this.loadRules();
    }
  }

  private async loadRules(): Promise<void> {
    try {
      await this.notifApi.listRules();
      this.rules.set(this.notifApi.rules());
      this.rulesLoaded = true;
    } catch { /* handled */ }
  }

  // ─── Rule form ────────────────────────────────────────────

  protected get formAlertType(): string { return this.ruleForm().alertType; }
  protected set formAlertType(value: string) { this.updateRuleForm({ alertType: value }); }

  protected get formVehicleId(): string | null { return this.ruleForm().vehicleId; }
  protected set formVehicleId(value: string | null) { this.updateRuleForm({ vehicleId: value || null }); }

  protected openCreateRule(): void {
    const preset: RuleForm = { ...EMPTY_FORM };
    if (this.ruleVehicleFilter()) preset.vehicleId = this.ruleVehicleFilter();
    this.ruleForm.set(preset);
    this.ruleFormOpen.set(true);
  }

  protected openEditRule(rule: AlertRuleDto): void {
    this.ruleForm.set({
      id: rule.id,
      vehicleId: rule.vehicleId,
      alertType: rule.alertType,
      enabled: rule.enabled,
      channels: rule.channels.filter((c) => c !== 'IN_APP') as RuleForm['channels'],
      escalateAfterMin: rule.escalateAfterMin,
      escalateToUserId: rule.escalateToUserId,
    });
    this.ruleFormOpen.set(true);
  }

  protected closeRuleForm(): void { this.ruleFormOpen.set(false); }

  protected toggleRuleChannel(channel: 'WEB_PUSH' | 'EMAIL' | 'WHATSAPP' | 'SMS', checked: boolean): void {
    const current = this.ruleForm().channels;
    const next = checked ? [...current, channel] : current.filter((c) => c !== channel);
    this.updateRuleForm({ channels: next as RuleForm['channels'] });
  }

  protected updateRuleForm(patch: Partial<RuleForm>): void {
    this.ruleForm.update((f) => ({ ...f, ...patch }));
  }

  protected async saveRule(): Promise<void> {
    const f = this.ruleForm();
    if (f.channels.length === 0) {
      this.toast.error('Choisis au moins un canal');
      return;
    }
    this.ruleSaving.set(true);
    try {
      const payload = {
        vehicleId: f.vehicleId,
        alertType: f.alertType,
        enabled: f.enabled,
        channels: f.channels,
        escalateAfterMin: f.escalateAfterMin,
        escalateToUserId: f.escalateToUserId,
      };
      if (f.id) {
        await this.notifApi.updateRule(f.id, payload);
        this.toast.success('Règle mise à jour');
      } else {
        await this.notifApi.createRule(payload);
        this.toast.success('Règle créée');
      }
      await this.loadRules();
      this.ruleFormOpen.set(false);
    } catch {
      this.toast.error('Échec de l\'enregistrement');
    } finally {
      this.ruleSaving.set(false);
    }
  }

  protected async deleteRule(rule: AlertRuleDto): Promise<void> {
    if (!confirm(`Supprimer la règle "${this.alertTypeLabel(rule.alertType)}" ?`)) return;
    try {
      await this.notifApi.deleteRule(rule.id);
      this.toast.success('Règle supprimée');
      await this.loadRules();
    } catch {
      this.toast.error('Échec de la suppression');
    }
  }
}
