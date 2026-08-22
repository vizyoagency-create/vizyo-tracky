import { swallow } from '../../core/error/swallow';
import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap } from 'maplibre-gl';
import { LucideAngularModule, MapPin, ShieldCheck, ShieldOff } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { MapService } from '../../core/services/map.service';
import { ThemeService } from '../../core/theme/theme.service';
import {
  AdminSecurityUser,
  AdminUserLocations,
  SecurityAdminService,
} from '../../core/services/security-admin.service';
import { roleLabel as roleLabelFr } from '../../shared/utils/role-labels';

@Component({
  selector: 'app-security-admin',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, DatePipe],
  template: `
    <div class="sa-page">
      <div class="sa-header">
        <span class="vt-eyebrow">Sécurité</span>
        <h1 class="sa-title">Connexions &amp; vérification 2FA</h1>
        <p class="sa-sub">
          Qui a activé la vérification en 2 étapes, et d'où chaque utilisateur se connecte.
        </p>
      </div>

      <div class="sa-grid">
        <!-- Liste utilisateurs -->
        <div class="sa-list">
          @if (loading()) {
            <p class="sa-muted">Chargement…</p>
          } @else if (users().length === 0) {
            <p class="sa-muted">Aucune donnée de connexion pour l'instant.</p>
          } @else {
            @for (u of users(); track u.userId) {
              <button class="sa-row" [class.active]="selectedId() === u.userId" (click)="select(u)">
                <div class="sa-row-main">
                  <span class="sa-name">{{ u.name }}</span>
                  <span class="sa-badge" [class.on]="u.twoFactorEnabled">
                    <lucide-icon [img]="u.twoFactorEnabled ? ShieldCheck : ShieldOff" [size]="11" />
                    {{ u.twoFactorEnabled ? '2FA' : 'Sans 2FA' }}
                  </span>
                </div>
                <div class="sa-row-sub">
                  <span class="sa-role">{{ roleLabel(u.role) }}</span>
                  @if (u.lastLogin) {
                    <span class="sa-loc">
                      <lucide-icon [img]="MapPin" [size]="10" />
                      {{ u.lastLogin.city || u.lastLogin.region || u.lastLogin.country || '—' }}
                      · {{ u.lastLogin.at | date: 'dd/MM HH:mm' }}
                    </span>
                  } @else {
                    <span class="sa-loc sa-muted">jamais connecté</span>
                  }
                  <span class="sa-count">{{ u.connections }} conn.</span>
                </div>
              </button>
            }
          }
        </div>

        <!-- Carte + détail -->
        <div class="sa-detail">
          <div class="sa-map-wrap">
            <div #mapEl class="sa-map"></div>
            @if (!selectedId()) {
              <div class="sa-map-empty">Sélectionnez un utilisateur pour voir ses lieux de connexion.</div>
            }
            @if (locLoading()) { <div class="sa-map-empty">Chargement de la carte…</div> }
          </div>

          @if (locations(); as loc) {
            <div class="sa-legend">
              <div class="sa-legend-head">
                {{ loc.user.name }} — {{ loc.points.length }} point(s) de connexion
              </div>
              <div class="sa-cities">
                @for (c of loc.cities.slice(0, 8); track c.city) {
                  <span class="sa-city">{{ c.city }} <b>{{ c.count }}</b></span>
                }
              </div>
              <p class="sa-legend-note">
                <span class="dot dot--ok"></span> zone habituelle
                <span class="dot dot--warn"></span> appareil / lieu inhabituel
              </p>
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .sa-page { max-width: 1200px; margin: 0 auto; }
      .sa-header { margin-bottom: 18px; }
      .sa-title { font-size: 24px; font-weight: 800; color: var(--fg-primary); letter-spacing: -.03em; margin-top: 6px; }
      .sa-sub { font-size: 13px; color: var(--fg-tertiary); margin-top: 3px; }
      .sa-grid { display: grid; grid-template-columns: 340px 1fr; gap: 16px; align-items: start; }
      .sa-list { display: flex; flex-direction: column; gap: 6px; max-height: 72vh; overflow-y: auto; }
      .sa-row { text-align: left; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 11px 13px; cursor: pointer; transition: border-color .15s, background .15s; }
      .sa-row:hover { border-color: var(--border-strong); }
      .sa-row.active { border-color: var(--tracky); background: color-mix(in srgb, var(--tracky) 8%, var(--bg-secondary)); }
      .sa-row-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .sa-name { font-size: 13px; font-weight: 700; color: var(--fg-primary); }
      .sa-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-tertiary); }
      /* Texte sur lavis accent : --texte-succes, le vert de marque rend ~2,9:1 en clair. */
      .sa-badge.on { background: color-mix(in srgb, var(--tracky-light) 15%, transparent); color: var(--texte-succes); }
      .sa-row-sub { display: flex; align-items: center; gap: 10px; margin-top: 5px; font-size: 11px; color: var(--fg-tertiary); flex-wrap: wrap; }
      .sa-loc { display: inline-flex; align-items: center; gap: 3px; }
      .sa-count { margin-left: auto; }
      .sa-muted { color: var(--fg-tertiary); font-size: 12.5px; }
      .sa-detail { display: flex; flex-direction: column; gap: 12px; }
      .sa-map-wrap { position: relative; border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden; background: var(--bg-secondary); }
      .sa-map { height: 62vh; min-height: 420px; width: 100%; }
      .sa-map-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 20px; color: var(--fg-tertiary); font-size: 13px; background: color-mix(in srgb, var(--bg-primary) 55%, transparent); pointer-events: none; }
      .sa-legend { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 14px; padding: 13px 15px; }
      .sa-legend-head { font-size: 13px; font-weight: 700; color: var(--fg-primary); margin-bottom: 8px; }
      .sa-cities { display: flex; flex-wrap: wrap; gap: 6px; }
      .sa-city { font-size: 11px; padding: 3px 9px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
      .sa-city b { color: var(--fg-primary); margin-left: 3px; }
      .sa-legend-note { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--fg-tertiary); margin: 10px 0 0; }
      .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
      .dot--ok { background: #10e0a0; margin-left: 4px; }
      .dot--warn { background: #f5b33d; margin-left: 12px; }
      @media (max-width: 860px) { .sa-grid { grid-template-columns: 1fr; } .sa-list { max-height: none; } }
    `,
  ],
})
export class SecurityAdminComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(SecurityAdminService);
  private readonly mapService = inject(MapService);
  private readonly theme = inject(ThemeService);

  private readonly mapEl = viewChild<ElementRef<HTMLElement>>('mapEl');

  protected readonly ShieldCheck = ShieldCheck;
  protected readonly ShieldOff = ShieldOff;
  protected readonly MapPin = MapPin;

  protected readonly users = signal<AdminSecurityUser[]>([]);
  protected readonly loading = signal(true);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly locations = signal<AdminUserLocations | null>(null);
  protected readonly locLoading = signal(false);

  private map: MlMap | null = null;
  private markers: maplibregl.Marker[] = [];
  private viewReady = false;

  async ngOnInit(): Promise<void> {
    try {
      this.users.set(await firstValueFrom(this.api.getUsers()));
    } catch (err) {
      // silencieux
      swallow('security-admin:ngOnInit', err);
    } finally {
      this.loading.set(false);
    }
  }

  ngAfterViewInit(): void {
    const el = this.mapEl()?.nativeElement;
    if (!el) return;
    this.map = this.mapService.createMap(el, {
      center: { lat: 46.6, lng: 2.4 }, // France
      zoom: 4.5,
      style: this.theme.theme() === 'light' ? 'light' : 'dark',
      withGeolocateControl: false,
      withScaleControl: false,
    });
    this.viewReady = true;
  }

  ngOnDestroy(): void {
    this.clearMarkers();
    this.map?.remove();
    this.map = null;
  }

  protected roleLabel(role: string): string {
    return roleLabelFr(role as never) || role;
  }

  async select(u: AdminSecurityUser): Promise<void> {
    if (this.selectedId() === u.userId) return;
    this.selectedId.set(u.userId);
    this.locLoading.set(true);
    this.locations.set(null);
    try {
      const loc = await firstValueFrom(this.api.getUserLocations(u.userId));
      this.locations.set(loc);
      this.renderPoints(loc);
    } catch (err) {
      // silencieux
      swallow('security-admin:select', err);
    } finally {
      this.locLoading.set(false);
    }
  }

  private clearMarkers(): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
  }

  private renderPoints(loc: AdminUserLocations): void {
    if (!this.viewReady || !this.map) return;
    this.clearMarkers();

    // Regroupe par coordonnée (le géo-IP renvoie le centroïde ville → beaucoup de doublons).
    const groups = new Map<
      string,
      { lat: number; lng: number; count: number; city: string | null; anomaly: boolean; last: string }
    >();
    for (const p of loc.points) {
      const k = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
      const g = groups.get(k);
      const anomaly = p.newDevice || p.farFromUsual || p.challenged;
      if (g) {
        g.count += 1;
        g.anomaly = g.anomaly || anomaly;
        if (p.createdAt > g.last) g.last = p.createdAt;
      } else {
        groups.set(k, {
          lat: p.lat,
          lng: p.lng,
          count: 1,
          city: p.city || p.region || p.country,
          anomaly,
          last: p.createdAt,
        });
      }
    }

    const bounds = new maplibregl.LngLatBounds();
    for (const g of groups.values()) {
      const marker = new maplibregl.Marker({ color: g.anomaly ? '#f5b33d' : '#10e0a0' })
        .setLngLat([g.lng, g.lat])
        .setPopup(
          new maplibregl.Popup({ offset: 22, closeButton: false }).setHTML(
            `<div style="font:13px system-ui;color:#0b1120"><b>${escapeHtml(g.city || '—')}</b><br>${g.count} connexion(s)${g.anomaly ? '<br><span style="color:#b8860b">⚠ inhabituel</span>' : ''}</div>`,
          ),
        )
        .addTo(this.map!);
      this.markers.push(marker);
      bounds.extend([g.lng, g.lat]);
    }

    if (this.markers.length > 0) {
      this.map.fitBounds(bounds, { padding: 60, maxZoom: 11, duration: 600 });
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
