import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { LucideAngularModule, LogOut, User, Moon, Sun, Bell, BellOff, Map, MapPin, RotateCcw, Palette, Navigation, Route, ArrowRight, Smartphone, Ear } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { AudioMonitoringService } from '../../core/services/audio-monitoring.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { NotificationsApiService } from '../../core/services/notifications.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ThemeService } from '../../core/theme/theme.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { RetentionFleetCardComponent } from './retention-fleet-card.component';
import { roleLabel as roleLabelFr } from '../../shared/utils/role-labels';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, RouterLink, RetentionFleetCardComponent],
  template: `
    <div class="settings-page">
      <div class="settings-header">
        <h1 class="settings-title">Paramètres</h1>
        <p class="settings-sub">Personnalisez votre expérience Vizyo Tracky</p>
      </div>

      <div class="settings-grid">
        <!-- LEFT COLUMN -->
        <div class="settings-col">

          <!-- COMPTE -->
          <div class="s-card">
            <div class="s-card-head">
              <div class="s-icon green"><lucide-icon [img]="UserIcon" [size]="16"></lucide-icon></div>
              <div class="s-card-title">Compte</div>
            </div>
            <div class="s-card-body">
              <div class="account-block">
                <div class="avatar">{{ initials() }}</div>
                <div class="account-info">
                  <p class="account-email">{{ user()?.email || '—' }}</p>
                  <span class="role-badge" [class]="user()?.role === 'FLEET_ADMIN' || user()?.role === 'SUPER_ADMIN' ? 'admin' : 'viewer'">
                    {{ roleLabel() || 'Utilisateur' }}
                  </span>
                </div>
              </div>
              <a routerLink="/account" class="account-link">
                <lucide-icon [img]="UserIcon" [size]="14"></lucide-icon>
                Voir mon profil
              </a>
              <button (click)="logout()" class="logout-btn">
                <lucide-icon [img]="LogOutIcon" [size]="15"></lucide-icon>
                Se déconnecter
              </button>
            </div>
          </div>

          <!-- APPARENCE -->
          <div class="s-card">
            <div class="s-card-head">
              <div class="s-icon purple"><lucide-icon [img]="PaletteIcon" [size]="16"></lucide-icon></div>
              <div class="s-card-title">Apparence</div>
            </div>
            <div class="s-card-body">
              <div class="theme-picker">
                <button (click)="theme.setTheme('dark')" class="theme-option" [class.active]="theme.theme() === 'dark'">
                  <div class="theme-preview dark-preview">
                    <div class="tp-bar"></div><div class="tp-content"><div class="tp-line"></div><div class="tp-line short"></div></div>
                  </div>
                  <div class="theme-label">
                    <lucide-icon [img]="MoonIcon" [size]="12"></lucide-icon> Sombre
                  </div>
                </button>
                <button (click)="theme.setTheme('light')" class="theme-option" [class.active]="theme.theme() === 'light'">
                  <div class="theme-preview light-preview">
                    <div class="tp-bar"></div><div class="tp-content"><div class="tp-line"></div><div class="tp-line short"></div></div>
                  </div>
                  <div class="theme-label">
                    <lucide-icon [img]="SunIcon" [size]="12"></lucide-icon> Clair
                  </div>
                </button>
              </div>

              <!-- V1.12 — Mode interface : Tracky (riche) vs Baanool (simplifie) -->
              <div class="ui-mode-section" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border-subtle)">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
                  <div style="flex:1;min-width:0">
                    <div style="font-size:13px;font-weight:600;color:var(--fg-primary);margin-bottom:4px">
                      Mode interface simplifiee
                    </div>
                    <p style="font-size:11px;color:var(--fg-tertiary);margin:0;line-height:1.4">
                      Connexion directe a la carte, sidebar et bottom-bar masquees,
                      navigation via le menu burger uniquement. Toutes les pages
                      restent accessibles.
                    </p>
                  </div>
                  <button
                    type="button"
                    (click)="toggleBaanoolMode()"
                    [attr.aria-pressed]="isBaanoolMode()"
                    [disabled]="savingUiMode()"
                    style="flex-shrink:0;width:44px;height:24px;border-radius:9999px;border:none;cursor:pointer;position:relative;transition:background 200ms"
                    [style.background]="isBaanoolMode() ? 'var(--tracky)' : 'var(--bg-tertiary)'">
                    <span style="position:absolute;top:2px;width:20px;height:20px;border-radius:50%;background:white;transition:left 200ms"
                          [style.left]="isBaanoolMode() ? '22px' : '2px'"></span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- RIGHT COLUMN -->
        <div class="settings-col">

          <!-- NOTIFICATIONS IN-APP -->
          @if (perms.can('alerts_view')) {
          <div class="s-card">
            <div class="s-card-head">
              <div class="s-icon amber"><lucide-icon [img]="BellIcon" [size]="16"></lucide-icon></div>
              <div class="s-card-title">Notifications in-app</div>
            </div>
            <div class="s-card-body">
              <p class="section-desc">Toasts affichés dans l'application selon la sévérité.</p>
              @for (n of notifItems; track n.key) {
                <div class="notif-row">
                  <div class="notif-left">
                    <div class="notif-dot" [class]="n.color"></div>
                    <div>
                      <p class="notif-name">{{ n.label }}</p>
                      <p class="notif-desc">{{ n.desc }}</p>
                    </div>
                  </div>
                  <div class="notif-right">
                    @if (prefs().notifications[n.key].enabled && n.key !== 'critical') {
                      <select [ngModel]="prefs().notifications[n.key].duration" (ngModelChange)="setNotifDuration(n.key, $event)" class="duration-select">
                        <option [ngValue]="3000">3s</option>
                        <option [ngValue]="6000">6s</option>
                        <option [ngValue]="10000">10s</option>
                        <option [ngValue]="0">∞</option>
                      </select>
                    }
                    @if (n.key === 'critical' && prefs().notifications.critical.enabled) {
                      <span class="permanent-badge">∞</span>
                    }
                    <label class="toggle">
                      <input type="checkbox" [checked]="prefs().notifications[n.key].enabled" (change)="toggleNotif(n.key)" />
                      <span class="toggle-track"><span class="toggle-thumb"></span></span>
                    </label>
                  </div>
                </div>
              }
              <a routerLink="/settings/alert-rules" class="advanced-link">
                Configurer les règles avancées
                <lucide-icon [img]="ArrowRightIcon" [size]="13"></lucide-icon>
              </a>
            </div>
          </div>

          }

          <!-- PUSH NOTIFICATIONS -->
          @if (perms.can('alerts_view')) {
          <div class="s-card">
            <div class="s-card-head">
              <div class="s-icon cyan"><lucide-icon [img]="SmartphoneIcon" [size]="16"></lucide-icon></div>
              <div class="s-card-title">Notifications push</div>
            </div>
            <div class="s-card-body">
              <p class="section-desc">Recevez des alertes même quand l'application est fermée.</p>

              @if (!pushSupported()) {
                <div class="push-status push-unsupported">
                  <lucide-icon [img]="BellOffIcon" [size]="16"></lucide-icon>
                  <div>
                    <p class="notif-name">Non disponible</p>
                    <p class="notif-desc">{{ pushDiagReason() }}</p>
                  </div>
                </div>
              } @else if (!pushSubscribed()) {
                <div class="push-status push-inactive">
                  <lucide-icon [img]="BellOffIcon" [size]="16"></lucide-icon>
                  <div>
                    <p class="notif-name">Push désactivé</p>
                    <p class="notif-desc">Activez pour recevoir des alertes sur cet appareil.</p>
                  </div>
                  <button (click)="enablePush()" class="btn-push" [disabled]="pushLoading()">
                    {{ pushLoading() ? 'Activation...' : 'Activer' }}
                  </button>
                </div>
              } @else {
                <div class="push-status push-active">
                  <lucide-icon [img]="BellIcon" [size]="16"></lucide-icon>
                  <div>
                    <p class="notif-name">Push actif</p>
                    <p class="notif-desc">Les alertes arrivent sur cet appareil.</p>
                  </div>
                  <button (click)="disablePush()" class="btn-push btn-push-off" [disabled]="pushLoading()">
                    Désactiver
                  </button>
                </div>

                <div class="push-types-section">
                  <p class="push-types-title">Types d'alertes push</p>
                  @for (pt of pushAlertTypes; track pt.type) {
                    <div class="notif-row">
                      <div class="notif-left">
                        <div class="notif-dot" [class]="pt.color"></div>
                        <div>
                          <p class="notif-name">{{ pt.label }}</p>
                          <p class="notif-desc">{{ pt.desc }}</p>
                        </div>
                      </div>
                      <div class="notif-right">
                        <label class="toggle">
                          <input type="checkbox" [checked]="prefs().pushAlerts[pt.type] !== false" (change)="togglePushType(pt.type)" />
                          <span class="toggle-track"><span class="toggle-thumb"></span></span>
                        </label>
                      </div>
                    </div>
                  }
                </div>
              }
            </div>
          </div>

          }

          <!-- AUDIO N2 — FLEET_ADMIN/client : Mode assistance. Masqué tant que le prestataire
               n'a pas rendu la flotte ÉLIGIBLE (N1 superAdminEnabled). Fail-closed : la carte
               reste cachée par défaut (pas de fleetId, fetch en échec). Une fois éligible, elle
               ouvre l'écran N2 (consentement/attestation). -->
          @if (user()?.role === 'FLEET_ADMIN' && perms.can('audio_monitoring') && audioEligible()) {
          <div class="s-card">
            <div class="s-card-head">
              <div class="s-icon violet"><lucide-icon [img]="EarIcon" [size]="16"></lucide-icon></div>
              <div class="s-card-title">Mode assistance</div>
            </div>
            <div class="s-card-body">
              <p class="section-desc">
                En cas d'accident, autorisez le prestataire à activer l'écoute de la cabine pour
                vous porter assistance (capacité légalement sensible, attestation requise).
              </p>
              <a routerLink="/settings/audio-monitoring" class="advanced-link">
                Gérer le Mode assistance
                <lucide-icon [img]="ArrowRightIcon" [size]="13"></lucide-icon>
              </a>
            </div>
          </div>
          }

          <!-- Sprint 6 — Rétention des données de la flotte (lecture seule, FLEET_ADMIN). -->
          @if (user()?.role === 'FLEET_ADMIN') {
            <app-retention-fleet-card />
          }

          <!-- CARTE -->
          @if (perms.can('vehicles_view')) {
          <div class="s-card">
            <div class="s-card-head">
              <div class="s-icon blue"><lucide-icon [img]="MapIcon" [size]="16"></lucide-icon></div>
              <div class="s-card-title">Carte</div>
            </div>
            <div class="s-card-body">
              <!-- Centre -->
              <div class="map-row">
                <div class="map-row-left">
                  <lucide-icon [img]="NavigationIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                  <span class="map-label">Centre</span>
                </div>
                <div class="map-row-right">
                  <input type="number" step="0.001" [ngModel]="prefs().map.centerLat" (ngModelChange)="setMapPref('centerLat', $event)" class="coord-input" />
                  <input type="number" step="0.001" [ngModel]="prefs().map.centerLng" (ngModelChange)="setMapPref('centerLng', $event)" class="coord-input" />
                  <button (click)="useMyPosition()" class="geo-btn" title="Ma position">
                    <lucide-icon [img]="MapPinIcon" [size]="13"></lucide-icon>
                  </button>
                </div>
              </div>
              <!-- Zoom -->
              <div class="map-row">
                <div class="map-row-left">
                  <lucide-icon [img]="MapIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                  <span class="map-label">Zoom</span>
                </div>
                <div class="map-row-right gap-2">
                  <span class="zoom-value">{{ prefs().map.zoom }}</span>
                  <input type="range" min="5" max="18" [ngModel]="prefs().map.zoom" (ngModelChange)="setMapPref('zoom', $event)" class="range-styled" />
                </div>
              </div>
              <!-- Trails -->
              <div class="map-row">
                <div class="map-row-left">
                  <lucide-icon [img]="RouteIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                  <span class="map-label">Traînées</span>
                </div>
                <div class="map-row-right">
                  @if (prefs().map.showTrails) {
                    <span class="zoom-value">{{ prefs().map.trailLength }}pts</span>
                    <input type="range" min="5" max="50" [ngModel]="prefs().map.trailLength" (ngModelChange)="setMapPref('trailLength', $event)" class="range-styled range-sm" />
                  }
                  <label class="toggle">
                    <input type="checkbox" [checked]="prefs().map.showTrails" (change)="setMapPref('showTrails', !prefs().map.showTrails)" />
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                  </label>
                </div>
              </div>
            </div>
          </div>
          }
        </div>
      </div>

      <!-- RESET -->
      <button (click)="resetAll()" class="reset-btn">
        <lucide-icon [img]="ResetIcon" [size]="14"></lucide-icon>
        Réinitialiser tous les paramètres
      </button>
    </div>
  `,
  styles: [`
    .settings-page { max-width: 900px; margin: 0 auto }
    .settings-header { margin-bottom: 24px }
    .settings-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.02em }
    .settings-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 2px }
    .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start }
    .settings-col { display: flex; flex-direction: column; gap: 16px }

    /* Card */
    .s-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden }
    .s-card-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle) }
    .s-card-title { font-size: 13px; font-weight: 700; color: var(--fg-primary) }
    .s-card-body { padding: 18px }
    .s-icon { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
    /* DS : accent émeraude unique — les sections se distinguent par leur icône,
       pas par une couleur différente (fin de l'arc-en-ciel violet/bleu/cyan). */
    .s-icon.green, .s-icon.purple, .s-icon.amber, .s-icon.blue, .s-icon.cyan, .s-icon.violet {
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent); color: var(--color-tracky-light);
    }

    /* Account */
    .account-block { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 12px; background: var(--bg-tertiary); margin-bottom: 14px }
    .avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--tracky); color: var(--accent-ink); font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
    .account-email { font-size: 14px; font-weight: 600; color: var(--fg-primary) }
    .role-badge { display: inline-block; margin-top: 3px; padding: 2px 10px; border-radius: 20px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em }
    .role-badge.admin { background: rgba(16,224,160,.15); color: var(--tracky-light) }
    .role-badge.viewer { background: var(--bg-secondary); color: var(--fg-tertiary) }
    .logout-btn {
      display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 600;
      background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 18%, transparent); cursor: pointer; transition: all .2s;
    }
    .logout-btn:hover { background: rgba(239,68,68,.15) }
    .account-link {
      display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 600;
      background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle);
      text-decoration: none; transition: all .2s; margin-right: 8px;
    }
    .account-link:hover { background: var(--bg-secondary); color: var(--fg-primary); border-color: var(--border-strong) }
    .advanced-link {
      display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; padding: 10px 14px;
      border-radius: 10px; font-size: 12px; font-weight: 600; color: var(--tracky-light);
      text-decoration: none; background: rgba(16,224,160,.06); border: 1px solid rgba(16,224,160,.18);
      transition: all .2s;
    }
    .advanced-link:hover { background: rgba(16,224,160,.12); border-color: rgba(16,224,160,.28) }

    /* Push notifications */
    .section-desc { font-size: 11px; color: var(--fg-tertiary); margin: 0 0 12px }
    .push-status {
      display: flex; align-items: center; gap: 12px; padding: 12px 14px;
      border-radius: 10px; margin-bottom: 12px;
    }
    .push-unsupported { background: rgba(239,68,68,.06); color: var(--fg-tertiary) }
    .push-inactive { background: rgba(245,158,11,.06) }
    .push-active { background: rgba(16,224,160,.06) }
    .btn-push {
      margin-left: auto; padding: 7px 14px; border-radius: 8px; font-size: 12px;
      font-weight: 600; border: 0; cursor: pointer; white-space: nowrap;
      background: var(--tracky); color: var(--bg-primary);
    }
    .btn-push:hover { background: var(--tracky-light) }
    .btn-push:disabled { opacity: .5; cursor: not-allowed }
    .btn-push-off { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 22%, transparent) }
    .btn-push-off:hover { background: rgba(239,68,68,.2) }
    .push-types-section { margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--border-subtle) }
    .push-types-title { font-size: 11px; font-weight: 600; color: var(--fg-tertiary); text-transform: uppercase; margin: 0 0 8px }

    /* Theme picker */
    .theme-picker { display: grid; grid-template-columns: 1fr 1fr; gap: 12px }
    .theme-option { padding: 0; border: 2px solid var(--border-subtle); border-radius: 12px; overflow: hidden; cursor: pointer; transition: all .2s; background: transparent }
    .theme-option:hover { border-color: var(--border-strong) }
    .theme-option.active { border-color: var(--tracky); box-shadow: 0 0 0 2px rgba(16,224,160,.30); background: rgba(16,224,160,.10) }
    .theme-preview { height: 56px; position: relative; overflow: hidden }
    .dark-preview { background: #0b1120 }
    .light-preview { background: #f1f5f9 }
    .tp-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 24px }
    .dark-preview .tp-bar { background: #111827 }
    .light-preview .tp-bar { background: #e2e8f0 }
    .tp-content { position: absolute; left: 30px; top: 10px; display: flex; flex-direction: column; gap: 4px }
    .tp-line { width: 40px; height: 4px; border-radius: 2px }
    .tp-line.short { width: 24px }
    .dark-preview .tp-line { background: #1e293b }
    .light-preview .tp-line { background: #cbd5e1 }
    .theme-label { display: flex; align-items: center; justify-content: center; gap: 5px; padding: 8px; font-size: 12px; font-weight: 600; color: var(--fg-secondary) }
    .theme-option.active .theme-label { color: var(--tracky-light) }

    /* Notifications */
    .notif-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border-subtle) }
    .notif-row:last-child { border-bottom: none }
    .notif-left { display: flex; align-items: center; gap: 10px }
    .notif-right { display: flex; align-items: center; gap: 8px }
    .notif-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0 }
    .notif-dot.red { background: var(--danger) }
    .notif-dot.amber { background: var(--warning) }
    .notif-dot.blue { background: var(--fg-tertiary) }
    .notif-name { font-size: 13px; font-weight: 600; color: var(--fg-primary) }
    .notif-desc { font-size: 10px; color: var(--fg-tertiary); margin-top: 1px }
    .permanent-badge { font-size: 11px; color: var(--fg-tertiary); padding: 2px 8px; border-radius: 6px; background: var(--bg-tertiary) }
    .duration-select {
      padding: 4px 24px 4px 10px; border-radius: 9999px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); font-size: 11px; font-weight: 700; outline: none; cursor: pointer;
      appearance: none; -webkit-appearance: none; -moz-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2310E0A0' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      transition: all .15s;
    }
    .duration-select:hover { border-color: var(--tracky); color: var(--fg-primary); }
    .duration-select:focus { border-color: var(--tracky); }

    /* Map settings */
    .map-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border-subtle) }
    .map-row:last-child { border-bottom: none }
    .map-row-left { display: flex; align-items: center; gap: 8px }
    .map-row-right { display: flex; align-items: center; gap: 6px }
    .map-label { font-size: 13px; font-weight: 600; color: var(--fg-primary) }
    .coord-input {
      width: 72px; padding: 5px 6px; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); font-size: 11px; font-family: var(--font-mono, monospace); text-align: center; outline: none;
    }
    .coord-input:focus { border-color: var(--tracky) }
    .geo-btn {
      width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary);
      cursor: pointer; transition: all .2s;
    }
    .geo-btn:hover { color: var(--tracky-light); border-color: var(--tracky) }
    .zoom-value { font-size: 11px; font-weight: 700; color: var(--tracky-light); min-width: 28px; text-align: center }
    .range-styled { width: 100px; accent-color: var(--tracky) }
    .range-sm { width: 70px }

    /* Toggle */
    /* .toggle : styles globaux (styles.css) */

    /* Reset */
    .reset-btn {
      display: inline-flex; align-items: center; gap: 7px; margin-top: 20px; padding: 10px 18px; border-radius: 10px;
      font-size: 12px; font-weight: 600; background: var(--bg-secondary); color: var(--fg-tertiary);
      border: 1px solid var(--border-subtle); cursor: pointer; transition: all .2s;
    }
    .reset-btn:hover { color: var(--fg-secondary); border-color: var(--border-strong) }

    @media (max-width: 768px) {
      .settings-grid { grid-template-columns: 1fr }
    }
  `],
})
export class SettingsComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly audioApi = inject(AudioMonitoringService);
  private readonly preferencesService = inject(PreferencesService);
  private readonly notifApi = inject(NotificationsApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected readonly theme = inject(ThemeService);
  protected readonly perms = inject(PermissionsService);

  protected readonly user = this.auth.user;
  protected readonly prefs = this.preferencesService.prefs;

  protected readonly UserIcon = User;
  protected readonly LogOutIcon = LogOut;
  protected readonly MoonIcon = Moon;
  protected readonly SunIcon = Sun;
  protected readonly BellIcon = Bell;
  protected readonly BellOffIcon = BellOff;
  protected readonly SmartphoneIcon = Smartphone;
  protected readonly MapIcon = Map;
  protected readonly MapPinIcon = MapPin;
  protected readonly ResetIcon = RotateCcw;
  protected readonly PaletteIcon = Palette;
  protected readonly NavigationIcon = Navigation;
  protected readonly RouteIcon = Route;
  protected readonly ArrowRightIcon = ArrowRight;
  protected readonly EarIcon = Ear;

  protected readonly pushSupported = signal(false);
  protected readonly pushSubscribed = signal(false);
  protected readonly pushLoading = signal(false);
  protected readonly pushDiagReason = signal('');

  // Sprint 4 — AUDIO N1 : la flotte est-elle ÉLIGIBLE au Mode assistance (le prestataire
  // l'a-t-il autorisée, `superAdminEnabled`) ? Gate l'affichage de la carte N2 du fleet-admin.
  // Fail-closed : false par défaut → carte masquée tant que l'éligibilité n'est pas confirmée.
  protected readonly audioEligible = signal(false);

  // V1.12 — Mode UI (Tracky riche vs Baanool simplifie)
  protected readonly isBaanoolMode = computed(() => this.user()?.preferences?.uiMode === 'baanool');
  protected readonly savingUiMode = signal(false);

  async toggleBaanoolMode(): Promise<void> {
    if (this.savingUiMode()) return;
    this.savingUiMode.set(true);
    const next: 'tracky' | 'baanool' = this.isBaanoolMode() ? 'tracky' : 'baanool';
    try {
      await this.auth.updatePreferences({ uiMode: next });
      this.toast.success(
        next === 'baanool'
          ? 'Mode interface simplifiee active.'
          : 'Interface complete restauree.',
      );
      // V1.12 — Auto-redirect : en activant baanool, on va direct sur /map
      // (UX coherente avec le redirect post-login). En desactivant, retour
      // au dashboard pour montrer le mode complet retrouve.
      void this.router.navigate([next === 'baanool' ? '/map' : '/dashboard']);
    } catch {
      this.toast.error('Echec mise a jour de la preference');
    } finally {
      this.savingUiMode.set(false);
    }
  }

  protected readonly notifItems = [
    { key: 'critical' as const, label: 'Critiques', desc: 'Accidents, coupures, SOS, remorquage', color: 'red' },
    { key: 'warning' as const, label: 'Avertissements', desc: 'Vitesse, inactivité, géofence, fatigue', color: 'amber' },
    { key: 'info' as const, label: 'Informations', desc: 'Freinage, vibrations, GPS, arrêt prolongé', color: 'blue' },
  ];

  protected readonly pushAlertTypes = [
    { type: 'critical', label: 'Critiques', desc: 'SOS, accident, collision, remorquage, sabotage', color: 'red' },
    { type: 'overspeed', label: 'Excès de vitesse', desc: 'Dépassement de la limite configurée', color: 'amber' },
    { type: 'geofence', label: 'Géofence', desc: 'Entrée/sortie de zone', color: 'amber' },
    { type: 'movement', label: 'Mouvement à l\'arrêt', desc: 'Véhicule bouge en mode parking', color: 'amber' },
    { type: 'battery', label: 'Batterie faible', desc: 'Niveau batterie bas', color: 'amber' },
    { type: 'fatigue', label: 'Fatigue conducteur', desc: 'Conduite prolongée détectée', color: 'amber' },
    { type: 'driving', label: 'Conduite', desc: 'Freinage, accélération, virage brusque', color: 'blue' },
    { type: 'device', label: 'Appareil', desc: 'Vibration, perte GPS, arrêt prolongé', color: 'blue' },
  ];

  async ngOnInit(): Promise<void> {
    const diag = this.notifApi.pushSupportDiagnostic();
    this.pushSupported.set(diag.supported);
    if (!diag.supported) {
      this.pushDiagReason.set(diag.reason ?? 'Non supporté');
    }
    await this.notifApi.loadStatus();
    this.pushSubscribed.set(this.notifApi.isSubscribed());

    // Sprint 4 — éligibilité audio (N1) : un FLEET_ADMIN ne voit la carte « Mode assistance »
    // que si le prestataire a rendu sa flotte éligible. Un seul fetch, mis en cache dans un
    // signal. Fail-closed : pas de fleetId ou fetch en échec → la carte reste masquée.
    const u = this.user();
    if (u?.role === 'FLEET_ADMIN' && u.fleetId) {
      firstValueFrom(this.audioApi.getFleetAudioConfig(u.fleetId))
        .then((cfg) => this.audioEligible.set(cfg.superAdminEnabled === true))
        .catch(() => {
          // Échec silencieux → fail-closed : la carte reste cachée (default false).
        });
    }
  }

  protected async enablePush(): Promise<void> {
    this.pushLoading.set(true);
    try {
      const result = await this.notifApi.subscribePush();
      if (result.ok) {
        this.pushSubscribed.set(true);
        this.toast.success('Notifications push activées');
      } else {
        this.toast.error(result.reason ?? 'Échec de l\'activation');
      }
    } catch {
      this.toast.error('Erreur lors de l\'activation');
    } finally {
      this.pushLoading.set(false);
    }
  }

  protected async disablePush(): Promise<void> {
    this.pushLoading.set(true);
    try {
      await this.notifApi.unsubscribePush();
      this.pushSubscribed.set(false);
      this.toast.success('Notifications push désactivées');
    } catch {
      this.toast.error('Erreur lors de la désactivation');
    } finally {
      this.pushLoading.set(false);
    }
  }

  protected togglePushType(type: string): void {
    const current = this.prefs().pushAlerts ?? {};
    const newValue = current[type] === false;
    this.preferencesService.update({
      pushAlerts: { ...current, [type]: newValue },
    } as any);
  }

  protected initials(): string {
    const email = this.user()?.email ?? '';
    return email.slice(0, 2).toUpperCase();
  }

  protected roleLabel(): string {
    return roleLabelFr(this.user()?.role);
  }

  protected toggleNotif(severity: 'critical' | 'warning' | 'info'): void {
    const c = this.prefs().notifications;
    this.preferencesService.update({ notifications: { ...c, [severity]: { ...c[severity], enabled: !c[severity].enabled } } });
  }

  protected setNotifDuration(severity: 'warning' | 'info', duration: number): void {
    const c = this.prefs().notifications;
    this.preferencesService.update({ notifications: { ...c, [severity]: { ...c[severity], duration: Number(duration) } } });
  }

  protected setMapPref(key: string, value: number | boolean): void {
    this.preferencesService.update({ map: { ...this.prefs().map, [key]: value } });
  }

  protected useMyPosition(): void {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      this.preferencesService.update({
        map: { ...this.prefs().map, centerLat: Math.round(pos.coords.latitude * 10000) / 10000, centerLng: Math.round(pos.coords.longitude * 10000) / 10000 },
      });
    });
  }

  protected resetAll(): void {
    this.preferencesService.reset();
    this.theme.setTheme('dark');
  }

  protected logout(): void {
    this.realtime.disconnect();
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
