import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, LogOut, User, Moon, Sun, Bell, Map, MapPin, RotateCcw, Palette, Navigation, Route } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ThemeService } from '../../core/theme/theme.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
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
                  <p class="account-email">{{ user()?.email }}</p>
                  <span class="role-badge" [class]="user()?.role === 'FLEET_ADMIN' || user()?.role === 'SUPER_ADMIN' ? 'admin' : 'viewer'">
                    {{ roleLabel() }}
                  </span>
                </div>
              </div>
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
            </div>
          </div>
        </div>

        <!-- RIGHT COLUMN -->
        <div class="settings-col">

          <!-- NOTIFICATIONS -->
          <div class="s-card">
            <div class="s-card-head">
              <div class="s-icon amber"><lucide-icon [img]="BellIcon" [size]="16"></lucide-icon></div>
              <div class="s-card-title">Notifications</div>
            </div>
            <div class="s-card-body">
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
            </div>
          </div>

          <!-- CARTE -->
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
    .s-icon.green { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .s-icon.purple { background: rgba(168,85,247,.12); color: #a855f7 }
    .s-icon.amber { background: rgba(245,158,11,.12); color: #f59e0b }
    .s-icon.blue { background: rgba(59,130,246,.12); color: #3b82f6 }

    /* Account */
    .account-block { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 12px; background: var(--bg-tertiary); margin-bottom: 14px }
    .avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--tracky); color: white; font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
    .account-email { font-size: 14px; font-weight: 600; color: var(--fg-primary) }
    .role-badge { display: inline-block; margin-top: 3px; padding: 2px 10px; border-radius: 20px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em }
    .role-badge.admin { background: rgba(16,224,160,.15); color: var(--tracky-light) }
    .role-badge.viewer { background: var(--bg-secondary); color: var(--fg-tertiary) }
    .logout-btn {
      display: inline-flex; align-items: center; gap: 7px; padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 600;
      background: rgba(239,68,68,.08); color: #f87171; border: 1px solid rgba(239,68,68,.15); cursor: pointer; transition: all .2s;
    }
    .logout-btn:hover { background: rgba(239,68,68,.15) }

    /* Theme picker */
    .theme-picker { display: grid; grid-template-columns: 1fr 1fr; gap: 12px }
    .theme-option { padding: 0; border: 2px solid var(--border-subtle); border-radius: 12px; overflow: hidden; cursor: pointer; transition: all .2s; background: transparent }
    .theme-option:hover { border-color: var(--border-strong) }
    .theme-option.active { border-color: var(--tracky); box-shadow: 0 0 0 2px rgba(16,224,160,.15) }
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
    .notif-dot.red { background: #ef4444 }
    .notif-dot.amber { background: #f59e0b }
    .notif-dot.blue { background: #3b82f6 }
    .notif-name { font-size: 13px; font-weight: 600; color: var(--fg-primary) }
    .notif-desc { font-size: 10px; color: var(--fg-tertiary); margin-top: 1px }
    .permanent-badge { font-size: 11px; color: var(--fg-tertiary); padding: 2px 8px; border-radius: 6px; background: var(--bg-tertiary) }
    .duration-select {
      padding: 3px 6px; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); font-size: 11px; font-weight: 600; outline: none; cursor: pointer;
    }

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
    .toggle { position: relative; display: inline-block; cursor: pointer; flex-shrink: 0 }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute }
    .toggle-track {
      display: flex; align-items: center; width: 40px; height: 22px; background: rgba(239,68,68,.15); border: 1.5px solid rgba(239,68,68,.25);
      border-radius: 22px; transition: all .25s; position: relative; padding: 0 2px;
    }
    .toggle-thumb {
      position: relative; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center;
      background: #ef4444; border-radius: 50%; transition: transform .25s, background .25s; box-shadow: 0 1px 3px rgba(0,0,0,.3);
    }
    .toggle-thumb::after { content: '✕'; font-size: 8px; font-weight: 700; color: white; line-height: 1 }
    .toggle input:checked + .toggle-track { background: rgba(16,224,160,.15); border-color: rgba(16,224,160,.3) }
    .toggle input:checked + .toggle-track .toggle-thumb { transform: translateX(18px); background: var(--tracky-light) }
    .toggle input:checked + .toggle-track .toggle-thumb::after { content: '✓' }

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
export class SettingsComponent {
  private readonly auth = inject(AuthService);
  private readonly preferencesService = inject(PreferencesService);
  private readonly realtime = inject(RealtimeService);
  private readonly router = inject(Router);
  protected readonly theme = inject(ThemeService);

  protected readonly user = this.auth.user;
  protected readonly prefs = this.preferencesService.prefs;

  protected readonly UserIcon = User;
  protected readonly LogOutIcon = LogOut;
  protected readonly MoonIcon = Moon;
  protected readonly SunIcon = Sun;
  protected readonly BellIcon = Bell;
  protected readonly MapIcon = Map;
  protected readonly MapPinIcon = MapPin;
  protected readonly ResetIcon = RotateCcw;
  protected readonly PaletteIcon = Palette;
  protected readonly NavigationIcon = Navigation;
  protected readonly RouteIcon = Route;

  protected readonly notifItems = [
    { key: 'critical' as const, label: 'Critiques', desc: 'Accidents, coupures, SOS', color: 'red' },
    { key: 'warning' as const, label: 'Warning', desc: 'Vitesse, inactivité, géofence', color: 'amber' },
    { key: 'info' as const, label: 'Info', desc: 'Freinage, vibrations, portes', color: 'blue' },
  ];

  protected initials(): string {
    const email = this.user()?.email ?? '';
    return email.slice(0, 2).toUpperCase();
  }

  protected roleLabel(): string {
    const m: Record<string, string> = { SUPER_ADMIN: 'Super Admin', FLEET_ADMIN: 'Administrateur', FLEET_MANAGER: 'Manager', VIEWER: 'Lecteur' };
    return m[this.user()?.role ?? ''] ?? '';
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
