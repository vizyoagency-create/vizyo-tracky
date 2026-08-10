import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { DepotMissionDto, DepotPositionDto } from '@vizyo/tracky-shared';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import { MapService } from '../../core/services/map.service';
import { ThemeService } from '../../core/theme/theme.service';

/**
 * Espace dépôt (2026-08) — la carte live, en CONFIGURATION RESTREINTE (A3 § 1).
 *
 * ┌─ POURQUOI PAS `MapComponent` ─────────────────────────────────────────────┐
 * │ La spec dit « le composant de carte se réutilise depuis /map avec une      │
 * │ configuration restreinte ». `map.component.ts` fait 4 200 lignes et porte   │
 * │ géofences, lieux clés, sélecteur de véhicules, clustering, historique de    │
 * │ trajets, coupure moteur — chacun câblé sur des routes qu'un dépôt n'a pas   │
 * │ le droit d'appeler. L'y brancher aurait demandé une trentaine de drapeaux,  │
 * │ et il aurait suffi qu'UN seul manque pour qu'un tiers voie la flotte.       │
 * │                                                                            │
 * │ Ce qui est RÉELLEMENT réutilisé est ce qui doit l'être : `MapService`       │
 * │ (tuiles CartoDB, création MapLibre) et la charte des marqueurs. La carte    │
 * │ du dépôt ne sait rien faire d'autre qu'afficher ses propres missions —      │
 * │ non par configuration, mais par construction.                              │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

/** Toulouse — repli quand aucune position n'est connue. */
const CENTRE_PAR_DEFAUT = { lat: 43.6045, lng: 1.4442 };

@Component({
  selector: 'app-depot-map',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #carte class="dm-carte" role="application" aria-label="Carte des camions en mission"></div>`,
  styles: [`
    :host { display: block; position: relative; width: 100%; height: 100% }
    .dm-carte { width: 100%; height: 100% }

    /* ─── Marqueur camion ────────────────────────────────────────────────────
       Le halo pulsé signale un suivi ACTIF, pas une simple présence : c'est ce
       qui distingue « le camion roule » de « voici sa dernière position ». */
    :host ::ng-deep .dm-pin {
      display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer;
    }
    :host ::ng-deep .dm-pin-rond {
      position: relative; width: 30px; height: 30px; border-radius: 50%;
      display: grid; place-items: center;
      background: var(--color-tracky-light); color: var(--accent-ink);
      border: 2px solid var(--surface-secondary);
      box-shadow: 0 2px 10px rgba(0, 0, 0, .35);
      font-size: 14px; line-height: 1;
    }
    :host ::ng-deep .dm-pin--retard .dm-pin-rond { background: var(--danger); color: #fff }
    :host ::ng-deep .dm-pin--selection .dm-pin-rond { outline: 3px solid var(--violet); outline-offset: 2px }
    :host ::ng-deep .dm-pin-rond::after {
      content: ''; position: absolute; inset: -6px; border-radius: 50%;
      border: 2px solid currentColor; opacity: .55;
      animation: dm-pulse 2s cubic-bezier(.4, 0, .6, 1) infinite;
    }
    :host ::ng-deep .dm-pin-plaque {
      padding: 2px 7px; border-radius: 7px; white-space: nowrap;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
      color: var(--text-primary); font-family: var(--font-mono); font-size: 10.5px; font-weight: 700;
    }
    /* Le dépôt de départ : tireté VIOLET — la couleur du dépôt dans tout le système. */
    :host ::ng-deep .dm-depot {
      width: 26px; height: 26px; border-radius: 50%;
      border: 2px dashed var(--violet);
      background: color-mix(in srgb, var(--violet) 18%, transparent);
    }
    @keyframes dm-pulse {
      0%   { transform: scale(.85); opacity: .6 }
      70%  { transform: scale(1.35); opacity: 0 }
      100% { transform: scale(1.35); opacity: 0 }
    }
    @media (prefers-reduced-motion: reduce) {
      :host ::ng-deep .dm-pin-rond::after { animation: none; opacity: .35 }
    }
  `],
})
export class DepotMapComponent implements AfterViewInit, OnDestroy {
  readonly missions = input<DepotMissionDto[]>([]);
  readonly positions = input<DepotPositionDto[]>([]);
  readonly selection = input<string | null>(null);

  readonly choisir = output<string>();

  private readonly conteneur = viewChild<ElementRef<HTMLDivElement>>('carte');
  private readonly mapSvc = inject(MapService);
  private readonly theme = inject(ThemeService);

  private map: MlMap | null = null;
  private readonly prete = signal(false);
  /** Un marqueur par mission. La clé est l'identifiant de mission, pas de véhicule :
   *  deux missions sur le même camion doivent pouvoir coexister. */
  private readonly marqueurs = new Map<string, { marker: MlMarker; el: HTMLElement }>();
  private observateur: ResizeObserver | null = null;
  /** Premier cadrage seulement : recadrer à chaque position ferait sauter la carte
   *  sous le doigt du dépôt, toutes les vingt secondes. */
  private cadre = false;

  private readonly majEffect = effect(() => {
    const positions = this.positions();
    const missions = this.missions();
    const selection = this.selection();
    if (!this.map || !this.prete()) return;
    this.dessiner(missions, positions, selection);
  });

  /** Les tuiles suivent le thème : CartoDB clair ou sombre (A3 § 1). */
  private readonly themeEffect = effect(() => {
    const sombre = this.theme.theme() === 'dark';
    if (!this.map || !this.prete()) return;
    this.mapSvc.setStyle(this.map, sombre ? 'dark' : 'light');
  });

  ngAfterViewInit(): void {
    setTimeout(() => this.initialiser(), 0);
  }

  ngOnDestroy(): void {
    this.observateur?.disconnect();
    for (const { marker } of this.marqueurs.values()) marker.remove();
    this.marqueurs.clear();
    this.map?.remove();
    this.map = null;
  }

  private initialiser(): void {
    const el = this.conteneur()?.nativeElement;
    if (!el) return;

    this.map = this.mapSvc.createMap(el, {
      center: CENTRE_PAR_DEFAUT,
      zoom: 10,
      style: this.theme.theme() === 'dark' ? 'dark' : 'light',
      // Aucun contrôle de géolocalisation : la position du DÉPÔT n'a rien à faire
      // ici, et le navigateur demanderait une permission que rien ne justifie.
      withNavigationControl: true,
      withGeolocateControl: false,
      withScaleControl: false,
    });

    this.observateur = new ResizeObserver(() => this.map?.resize());
    this.observateur.observe(el);
    this.prete.set(true);
  }

  /**
   * Un marqueur par position SERVIE — jamais par mission.
   *
   * Une mission planifiée n'a pas de position : elle reste dans la liste et n'apparaît
   * pas sur la carte (A3 § 6). Une mission dont le boîtier s'est tu n'en a pas non plus :
   * son marqueur DISPARAÎT plutôt que de rester figé au dernier point connu, ce qui se
   * lirait comme un camion à l'arrêt. Le panneau, lui, écrit « indisponible depuis
   * 14 min » — l'information est donnée, elle n'est pas déguisée en position.
   */
  private dessiner(missions: DepotMissionDto[], positions: DepotPositionDto[], selection: string | null): void {
    if (!this.map) return;
    const parMission = new Map(missions.map((m) => [m.id, m]));
    const vus = new Set<string>();

    for (const p of positions) {
      const mission = parMission.get(p.missionId);
      if (!mission) continue;
      vus.add(p.missionId);

      const existant = this.marqueurs.get(p.missionId);
      if (existant) {
        existant.marker.setLngLat([p.lng, p.lat]);
        this.majElement(existant.el, mission, selection === mission.id);
      } else {
        const el = this.construirePin(mission, selection === mission.id);
        el.addEventListener('click', () => this.choisir.emit(mission.id));
        const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
          .setLngLat([p.lng, p.lat])
          .addTo(this.map);
        this.marqueurs.set(p.missionId, { marker, el });
      }
    }

    // Les marqueurs sans position servie sortent de la carte. C'est le cas de la
    // mission qui vient de se terminer : le marqueur part, et le parent affiche un
    // toast qui explique pourquoi (critère de recette n° 4).
    for (const [missionId, { marker }] of this.marqueurs) {
      if (!vus.has(missionId)) {
        marker.remove();
        this.marqueurs.delete(missionId);
      }
    }

    this.cadrer(positions);
  }

  /** Cadre sur l'ensemble des camions, une seule fois. Sans camion, la carte reste
   *  centrée par défaut — jamais un écran gris sans explication (A3 § 6). */
  private cadrer(positions: DepotPositionDto[]): void {
    if (!this.map || this.cadre || positions.length === 0) return;
    this.cadre = true;
    if (positions.length === 1) {
      this.map.easeTo({ center: [positions[0]!.lng, positions[0]!.lat], zoom: 12, duration: 500 });
      return;
    }
    const lats = positions.map((p) => p.lat);
    const lngs = positions.map((p) => p.lng);
    this.map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 80, maxZoom: 13, duration: 500 },
    );
  }

  private construirePin(mission: DepotMissionDto, selectionne: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'dm-pin';
    el.innerHTML =
      '<span class="dm-pin-rond" aria-hidden="true">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5v8h1"/>' +
      '<circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>' +
      '</span><span class="dm-pin-plaque"></span>';
    this.majElement(el, mission, selectionne);
    return el;
  }

  private majElement(el: HTMLElement, mission: DepotMissionDto, selectionne: boolean): void {
    el.classList.toggle('dm-pin--retard', mission.status === 'LATE');
    el.classList.toggle('dm-pin--selection', selectionne);
    const plaque = el.querySelector('.dm-pin-plaque');
    if (plaque) plaque.textContent = mission.vehicle.plate;
    el.setAttribute('title', `${mission.vehicle.plate} · ${mission.ref}`);
  }
}
