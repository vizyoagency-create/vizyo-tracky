import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, LogOut, User, Moon, Sun, Bell, BellOff, Map, MapPin, RotateCcw } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ThemeService } from '../../core/theme/theme.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    <div class="flex flex-col gap-6 max-w-2xl">
      <h1 class="text-2xl font-display font-bold text-fg-primary">Parametres</h1>

      <!-- COMPTE -->
      <section class="card">
        <div class="card-header">
          <lucide-icon [img]="UserIcon" [size]="16" class="text-tracky-light"></lucide-icon>
          <span>Compte</span>
        </div>
        <div class="card-body">
          <div class="flex items-center gap-4 p-4 rounded-xl bg-bg-tertiary">
            <div class="w-11 h-11 rounded-full bg-tracky/20 flex items-center justify-center text-tracky-light font-bold text-sm">
              {{ initials() }}
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-semibold text-fg-primary truncate">{{ user()?.email }}</p>
              <span class="inline-block mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide"
                [class]="user()?.role === 'FLEET_ADMIN' || user()?.role === 'SUPER_ADMIN' ? 'bg-tracky/20 text-tracky-light' : 'bg-bg-secondary text-fg-tertiary'">
                {{ roleLabel() }}
              </span>
            </div>
          </div>
          <button (click)="logout()"
            class="mt-4 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium
                   bg-red-600/15 text-red-400 border border-red-600/25
                   hover:bg-red-600/25 transition-colors cursor-pointer">
            <lucide-icon [img]="LogOutIcon" [size]="16"></lucide-icon>
            Se deconnecter
          </button>
        </div>
      </section>

      <!-- APPARENCE -->
      <section class="card">
        <div class="card-header">
          <lucide-icon [img]="theme.theme() === 'dark' ? MoonIcon : SunIcon" [size]="16" class="text-tracky-light"></lucide-icon>
          <span>Apparence</span>
        </div>
        <div class="card-body">
          <div class="setting-row">
            <div>
              <p class="setting-label">Theme</p>
              <p class="setting-hint">Choisissez l'apparence de l'interface</p>
            </div>
            <div class="flex gap-2">
              <button (click)="theme.setTheme('dark')"
                class="theme-btn" [class.active]="theme.theme() === 'dark'">
                <lucide-icon [img]="MoonIcon" [size]="14"></lucide-icon> Sombre
              </button>
              <button (click)="theme.setTheme('light')"
                class="theme-btn" [class.active]="theme.theme() === 'light'">
                <lucide-icon [img]="SunIcon" [size]="14"></lucide-icon> Clair
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- NOTIFICATIONS -->
      <section class="card">
        <div class="card-header">
          <lucide-icon [img]="BellIcon" [size]="16" class="text-tracky-light"></lucide-icon>
          <span>Notifications</span>
        </div>
        <div class="card-body space-y-1">
          <!-- Critical -->
          <div class="setting-row">
            <div>
              <p class="setting-label">Alertes critiques</p>
              <p class="setting-hint">Accidents, coupures d'alimentation, SOS</p>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-[10px] text-fg-tertiary">Permanent</span>
              <label class="toggle">
                <input type="checkbox" [checked]="prefs().notifications.critical.enabled"
                  (change)="toggleNotif('critical')" />
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
          </div>
          <!-- Warning -->
          <div class="setting-row">
            <div>
              <p class="setting-label">Alertes warning</p>
              <p class="setting-hint">Exces de vitesse, inactivite, geofence</p>
            </div>
            <div class="flex items-center gap-3">
              @if (prefs().notifications.warning.enabled) {
                <select [ngModel]="prefs().notifications.warning.duration" (ngModelChange)="setNotifDuration('warning', $event)"
                  class="select-sm">
                  <option [ngValue]="3000">3s</option>
                  <option [ngValue]="6000">6s</option>
                  <option [ngValue]="10000">10s</option>
                  <option [ngValue]="0">Permanent</option>
                </select>
              }
              <label class="toggle">
                <input type="checkbox" [checked]="prefs().notifications.warning.enabled"
                  (change)="toggleNotif('warning')" />
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
          </div>
          <!-- Info -->
          <div class="setting-row">
            <div>
              <p class="setting-label">Alertes info</p>
              <p class="setting-hint">Freinage brusque, vibrations, portes</p>
            </div>
            <div class="flex items-center gap-3">
              @if (prefs().notifications.info.enabled) {
                <select [ngModel]="prefs().notifications.info.duration" (ngModelChange)="setNotifDuration('info', $event)"
                  class="select-sm">
                  <option [ngValue]="3000">3s</option>
                  <option [ngValue]="4000">4s</option>
                  <option [ngValue]="6000">6s</option>
                  <option [ngValue]="0">Permanent</option>
                </select>
              }
              <label class="toggle">
                <input type="checkbox" [checked]="prefs().notifications.info.enabled"
                  (change)="toggleNotif('info')" />
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
          </div>
        </div>
      </section>

      <!-- CARTE -->
      <section class="card">
        <div class="card-header">
          <lucide-icon [img]="MapIcon" [size]="16" class="text-tracky-light"></lucide-icon>
          <span>Carte</span>
        </div>
        <div class="card-body space-y-1">
          <!-- Centre -->
          <div class="setting-row">
            <div>
              <p class="setting-label">Centre par defaut</p>
              <p class="setting-hint">Position initiale de la carte</p>
            </div>
            <div class="flex items-center gap-2">
              <input type="number" step="0.001" [ngModel]="prefs().map.centerLat" (ngModelChange)="setMapPref('centerLat', $event)"
                class="input-sm w-20" placeholder="Lat" />
              <input type="number" step="0.001" [ngModel]="prefs().map.centerLng" (ngModelChange)="setMapPref('centerLng', $event)"
                class="input-sm w-20" placeholder="Lng" />
              <button (click)="useMyPosition()" title="Utiliser ma position"
                class="p-2 rounded-lg bg-bg-tertiary text-fg-tertiary hover:text-tracky-light border border-border-subtle
                       transition-colors cursor-pointer">
                <lucide-icon [img]="MapPinIcon" [size]="14"></lucide-icon>
              </button>
            </div>
          </div>
          <!-- Zoom -->
          <div class="setting-row">
            <div>
              <p class="setting-label">Zoom par defaut</p>
              <p class="setting-hint">Niveau de zoom initial ({{ prefs().map.zoom }})</p>
            </div>
            <input type="range" min="5" max="18" [ngModel]="prefs().map.zoom" (ngModelChange)="setMapPref('zoom', $event)"
              class="w-28 accent-[var(--tracky)]" />
          </div>
          <!-- Trails -->
          <div class="setting-row">
            <div>
              <p class="setting-label">Trainees vehicules</p>
              <p class="setting-hint">Afficher le trajet recent sur la carte</p>
            </div>
            <label class="toggle">
              <input type="checkbox" [checked]="prefs().map.showTrails"
                (change)="setMapPref('showTrails', !prefs().map.showTrails)" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
          @if (prefs().map.showTrails) {
            <!-- Trail length -->
            <div class="setting-row">
              <div>
                <p class="setting-label">Longueur des trainees</p>
                <p class="setting-hint">{{ prefs().map.trailLength }} points</p>
              </div>
              <input type="range" min="5" max="50" [ngModel]="prefs().map.trailLength" (ngModelChange)="setMapPref('trailLength', $event)"
                class="w-28 accent-[var(--tracky)]" />
            </div>
          }
        </div>
      </section>

      <!-- RESET -->
      <button (click)="resetAll()"
        class="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium
               bg-bg-secondary text-fg-tertiary border border-border-subtle
               hover:text-fg-secondary hover:border-border-strong transition-colors cursor-pointer self-start">
        <lucide-icon [img]="ResetIcon" [size]="14"></lucide-icon>
        Reinitialiser les parametres
      </button>
    </div>
  `,
  styles: [`
    .card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: var(--radius-card); overflow: hidden }
    .card-header {
      display: flex; align-items: center; gap: 8px; padding: 10px 16px;
      font-size: 11px; font-weight: 700; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .06em;
      border-bottom: 1px solid var(--border-subtle); background: var(--bg-tertiary);
    }
    .card-body { padding: 16px }

    .setting-row {
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 10px 0; border-bottom: 1px solid var(--border-subtle);
    }
    .setting-row:last-child { border-bottom: none }
    .setting-label { font-size: 13px; font-weight: 600; color: var(--fg-primary) }
    .setting-hint { font-size: 11px; color: var(--fg-tertiary); margin-top: 1px }

    .theme-btn {
      display: inline-flex; align-items: center; gap: 5px; padding: 7px 14px; border-radius: 10px;
      font-size: 12px; font-weight: 600; background: var(--bg-tertiary); border: 1.5px solid var(--border-subtle);
      color: var(--fg-secondary); cursor: pointer; transition: all .2s;
    }
    .theme-btn:hover { border-color: var(--border-strong) }
    .theme-btn.active { border-color: var(--tracky); color: var(--tracky-light); background: rgba(16,224,160,.06) }

    .toggle { position: relative; display: inline-block; cursor: pointer }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute }
    .toggle-track {
      display: flex; align-items: center; width: 44px; height: 24px; background: rgba(239,68,68,.15); border: 1.5px solid rgba(239,68,68,.25);
      border-radius: 24px; transition: all .25s; position: relative; padding: 0 3px;
    }
    .toggle-thumb {
      position: relative; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;
      background: #ef4444; border-radius: 50%; transition: transform .25s, background .25s; box-shadow: 0 1px 3px rgba(0,0,0,.3);
    }
    .toggle-thumb::after { content: '✕'; font-size: 9px; font-weight: 700; color: white; line-height: 1 }
    .toggle input:checked + .toggle-track { background: rgba(16,224,160,.15); border-color: rgba(16,224,160,.3) }
    .toggle input:checked + .toggle-track .toggle-thumb { transform: translateX(20px); background: var(--tracky-light) }
    .toggle input:checked + .toggle-track .toggle-thumb::after { content: '✓' }

    .select-sm {
      padding: 4px 8px; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); font-size: 11px; outline: none;
    }
    .select-sm:focus { border-color: var(--tracky) }

    .input-sm {
      padding: 5px 8px; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); font-size: 11px; font-family: var(--font-mono, monospace); outline: none; text-align: center;
    }
    .input-sm:focus { border-color: var(--tracky) }
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
  protected readonly BellOffIcon = BellOff;
  protected readonly MapIcon = Map;
  protected readonly MapPinIcon = MapPin;
  protected readonly ResetIcon = RotateCcw;

  protected initials(): string {
    const email = this.user()?.email ?? '';
    return email.slice(0, 2).toUpperCase();
  }

  protected roleLabel(): string {
    const map: Record<string, string> = {
      SUPER_ADMIN: 'Super Admin',
      FLEET_ADMIN: 'Administrateur',
      FLEET_MANAGER: 'Manager',
      VIEWER: 'Lecteur',
    };
    return map[this.user()?.role ?? ''] ?? this.user()?.role ?? '';
  }

  protected toggleNotif(severity: 'critical' | 'warning' | 'info'): void {
    const current = this.prefs().notifications;
    this.preferencesService.update({
      notifications: {
        ...current,
        [severity]: { ...current[severity], enabled: !current[severity].enabled },
      },
    });
  }

  protected setNotifDuration(severity: 'warning' | 'info', duration: number): void {
    const current = this.prefs().notifications;
    this.preferencesService.update({
      notifications: {
        ...current,
        [severity]: { ...current[severity], duration: Number(duration) },
      },
    });
  }

  protected setMapPref(key: string, value: number | boolean): void {
    this.preferencesService.update({
      map: { ...this.prefs().map, [key]: value },
    });
  }

  protected useMyPosition(): void {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      this.preferencesService.update({
        map: {
          ...this.prefs().map,
          centerLat: Math.round(pos.coords.latitude * 10000) / 10000,
          centerLng: Math.round(pos.coords.longitude * 10000) / 10000,
        },
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
