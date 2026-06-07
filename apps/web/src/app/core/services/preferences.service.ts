import { Injectable, signal } from '@angular/core';
import type { MapStyleId } from './map-style.service';

export type CameraMode = 'free' | 'follow' | 'heading-up' | 'chase';

export interface NotificationPrefs {
  enabled: boolean;
  duration: number; // ms, 0 = permanent
}

/** Widgets activables sur le tableau de bord. Permet à l'utilisateur de
 *  personnaliser l'affichage et l'ordre des sections. */
export type DashboardWidgetKey =
  | 'kpis'        // KPIs 2x2 (véhicules, mouvement, arrêt, alertes)
  | 'actions'     // Quick actions chips
  | 'map'         // Carte temps réel
  | 'activity'    // Activité en direct
  | 'alerts'      // Alertes récentes
  | 'schedule';   // Automatisation horaire

export interface DashboardWidgetConfig {
  key: DashboardWidgetKey;
  enabled: boolean;
}

/** Per-category push alert preferences (false = muted, true/undefined = active). */
export interface PushAlertPrefs {
  [category: string]: boolean;
}

export interface UserPreferences {
  theme: 'dark' | 'light';
  notifications: {
    critical: NotificationPrefs;
    warning: NotificationPrefs;
    info: NotificationPrefs;
  };
  /** Per-category push notification preferences. Keys match pushAlertTypes in settings. */
  pushAlerts: PushAlertPrefs;
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
    /** V1.7 — si false, jamais de mode compact a faible zoom (markers riches partout). */
    compactMarkers: boolean;
  };
  /** Widgets activés et ordre d'affichage sur le tableau de bord. */
  dashboardWidgets: DashboardWidgetConfig[];
  /** #3 — vue de la liste véhicules : cartes (défaut) ou tableau. */
  vehiclesView: 'cards' | 'table';
}

const DEFAULTS: UserPreferences = {
  theme: 'light',
  notifications: {
    critical: { enabled: true, duration: 0 },
    warning: { enabled: true, duration: 6000 },
    info: { enabled: false, duration: 4000 },
  },
  pushAlerts: {
    critical: true,
    overspeed: true,
    geofence: true,
    movement: true,
    battery: true,
    fatigue: true,
    driving: false,
    device: false,
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
    compactMarkers: true,
  },
  dashboardWidgets: [
    { key: 'kpis', enabled: true },
    { key: 'actions', enabled: true },
    { key: 'map', enabled: true },
    { key: 'activity', enabled: true },
    { key: 'alerts', enabled: true },
    { key: 'schedule', enabled: true },
  ],
  vehiclesView: 'cards',
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
    if (partial.pushAlerts) {
      merged.pushAlerts = { ...current.pushAlerts, ...partial.pushAlerts };
    }
    if (partial.map) {
      merged.map = { ...current.map, ...partial.map };
    }
    if (partial.dashboardWidgets) {
      merged.dashboardWidgets = partial.dashboardWidgets;
    }

    this._prefs.set(merged);
    this.save(merged);
  }

  /** Active ou désactive un widget du tableau de bord. */
  toggleDashboardWidget(key: DashboardWidgetKey): void {
    const current = this._prefs().dashboardWidgets;
    const updated = current.map((w) =>
      w.key === key ? { ...w, enabled: !w.enabled } : w,
    );
    this.update({ dashboardWidgets: updated });
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
      pushAlerts: { ...defaults.pushAlerts, ...saved.pushAlerts },
      map: { ...defaults.map, ...saved.map },
      // Si la liste sauvegardée existe, on s'assure que les widgets manquants
      // sont ajoutés (par défaut activés) — utile pour évoluer le set sans casser.
      dashboardWidgets: this.mergeDashboardWidgets(saved.dashboardWidgets, defaults.dashboardWidgets),
      vehiclesView: saved.vehiclesView ?? defaults.vehiclesView,
    };
  }

  private mergeDashboardWidgets(
    saved: DashboardWidgetConfig[] | undefined,
    defaults: DashboardWidgetConfig[],
  ): DashboardWidgetConfig[] {
    if (!saved || !Array.isArray(saved)) return defaults;
    const savedKeys = new Set(saved.map((w) => w.key));
    const merged: DashboardWidgetConfig[] = [...saved];
    // Ajouter les widgets par défaut absents du saved (ex: nouveau widget)
    defaults.forEach((d) => {
      if (!savedKeys.has(d.key)) merged.push(d);
    });
    return merged;
  }
}
