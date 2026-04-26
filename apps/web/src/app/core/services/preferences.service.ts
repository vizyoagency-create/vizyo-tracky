import { Injectable, signal } from '@angular/core';
import type { MapStyleId } from './map-style.service';

export type CameraMode = 'free' | 'follow' | 'heading-up' | 'chase';

export interface NotificationPrefs {
  enabled: boolean;
  duration: number; // ms, 0 = permanent
}

export interface UserPreferences {
  theme: 'dark' | 'light';
  notifications: {
    critical: NotificationPrefs;
    warning: NotificationPrefs;
    info: NotificationPrefs;
  };
  map: {
    centerLat: number;
    centerLng: number;
    zoom: number;
    style: MapStyleId;
    showTrails: boolean;
    trailLength: number;
    showPlates: boolean;
    /** Mode camera par defaut au chargement (`free` recommande). */
    cameraMode: CameraMode;
  };
}

const DEFAULTS: UserPreferences = {
  theme: 'light',
  notifications: {
    critical: { enabled: true, duration: 0 },
    warning: { enabled: true, duration: 6000 },
    info: { enabled: false, duration: 4000 },
  },
  map: {
    centerLat: 46.6034,
    centerLng: 1.8883,
    zoom: 12,
    style: 'osm',
    showTrails: true,
    trailLength: 20,
    showPlates: true,
    cameraMode: 'free',
  },
};

const KEY_PREFIX = 'vizyo-tracky-prefs-';

@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private userId = '';
  private readonly _prefs = signal<UserPreferences>(structuredClone(DEFAULTS));
  readonly prefs = this._prefs.asReadonly();

  /** Charger les préférences depuis localStorage pour un user */
  load(userId: string): void {
    this.userId = userId;
    try {
      const raw = localStorage.getItem(KEY_PREFIX + userId);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<UserPreferences>;
        // Merge avec les defaults pour les clés manquantes
        this._prefs.set(this.mergeWithDefaults(saved));
      } else {
        this._prefs.set(structuredClone(DEFAULTS));
      }
    } catch {
      this._prefs.set(structuredClone(DEFAULTS));
    }
  }

  /** Mettre à jour une section et persister */
  update(partial: Partial<UserPreferences>): void {
    const current = this._prefs();
    const merged = { ...current, ...partial };

    // Deep merge pour les objets imbriqués
    if (partial.notifications) {
      merged.notifications = { ...current.notifications, ...partial.notifications };
    }
    if (partial.map) {
      merged.map = { ...current.map, ...partial.map };
    }

    this._prefs.set(merged);
    this.save(merged);
  }

  /** Réinitialiser toutes les préférences */
  reset(): void {
    const defaults = structuredClone(DEFAULTS);
    this._prefs.set(defaults);
    this.save(defaults);
  }

  /** Obtenir les valeurs par défaut */
  getDefaults(): UserPreferences {
    return structuredClone(DEFAULTS);
  }

  private save(prefs: UserPreferences): void {
    if (!this.userId) return;
    localStorage.setItem(KEY_PREFIX + this.userId, JSON.stringify(prefs));
  }

  private mergeWithDefaults(saved: Partial<UserPreferences>): UserPreferences {
    const defaults = structuredClone(DEFAULTS);
    return {
      theme: saved.theme ?? defaults.theme,
      notifications: {
        critical: { ...defaults.notifications.critical, ...saved.notifications?.critical },
        warning: { ...defaults.notifications.warning, ...saved.notifications?.warning },
        info: { ...defaults.notifications.info, ...saved.notifications?.info },
      },
      map: { ...defaults.map, ...saved.map },
    };
  }
}
