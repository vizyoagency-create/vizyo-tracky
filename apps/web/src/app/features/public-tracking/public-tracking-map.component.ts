import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import { MapService } from '../../core/services/map.service';
import { ThemeService } from '../../core/theme/theme.service';

/**
 * Lot A4 — la carte de la page publique.
 *
 * ┌─ UN POINT, JAMAIS UNE LIGNE ──────────────────────────────────────────────┐
 * │ Ce composant ne sait PAS dessiner de tracé, et c'est délibéré. Afficher    │
 * │ « d'où vient le camion » révélerait les points de livraison précédents,    │
 * │ donc les autres clients du dépôt — le piège classique du suivi public      │
 * │ (A4 § 2).                                                                  │
 * │                                                                            │
 * │ L'absence de capacité vaut mieux qu'une option désactivée : on ne peut pas  │
 * │ activer par erreur ce qui n'existe pas.                                    │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Séparé de `DepotMapComponent` pour la même raison : celle-ci porte des marqueurs
 * multiples, une sélection, des plaques. Ici, un point sans étiquette suffit — et
 * une plaque affichée serait une fuite (A4 § 2).
 */

/** Toulouse — repli quand aucune position n'est connue (avant le départ). */
const CENTRE_PAR_DEFAUT = { lat: 43.6045, lng: 1.4442 };

@Component({
  selector: 'app-public-tracking-map',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #carte class="ptm" role="application" aria-label="Position du camion"></div>`,
  styles: [`
    :host { display: block; position: relative }
    .ptm { width: 100%; height: 100% }

    :host ::ng-deep .ptm-pin {
      position: relative; width: 34px; height: 34px; border-radius: 50%;
      display: grid; place-items: center;
      background: var(--color-tracky-light); color: var(--accent-ink);
      border: 3px solid var(--surface-secondary);
      box-shadow: 0 3px 14px rgba(0, 0, 0, .35);
    }
    :host ::ng-deep .ptm-pin--retard { background: var(--danger); color: #fff }
    /* Le halo pulsé dit « c'est en direct » — sans lui, le destinataire ne sait pas
       si le point bouge encore ou s'il regarde une capture. */
    :host ::ng-deep .ptm-pin::after {
      content: ''; position: absolute; inset: -8px; border-radius: 50%;
      border: 2px solid currentColor; opacity: .5;
      animation: ptm-pulse 2s cubic-bezier(.4, 0, .6, 1) infinite;
    }
    @keyframes ptm-pulse {
      0%   { transform: scale(.8); opacity: .55 }
      70%, 100% { transform: scale(1.5); opacity: 0 }
    }
    @media (prefers-reduced-motion: reduce) {
      :host ::ng-deep .ptm-pin::after { animation: none; opacity: .3 }
    }
  `],
})
export class PublicTrackingMapComponent implements AfterViewInit, OnDestroy {
  readonly position = input<{ lat: number; lng: number } | null>(null);
  readonly enRetard = input(false);

  private readonly conteneur = viewChild<ElementRef<HTMLDivElement>>('carte');
  private readonly mapSvc = inject(MapService);
  private readonly theme = inject(ThemeService);

  private map: MlMap | null = null;
  private marqueur: MlMarker | null = null;
  private element: HTMLElement | null = null;
  private observateur: ResizeObserver | null = null;
  private readonly prete = signal(false);

  private readonly majEffect = effect(() => {
    const p = this.position();
    const retard = this.enRetard();
    if (!this.map || !this.prete()) return;

    if (!p) {
      // Pas de position : on retire le marqueur plutot que de le laisser au dernier
      // point connu. Un point fige se lit comme un camion a l'arret.
      this.marqueur?.remove();
      this.marqueur = null;
      this.element = null;
      return;
    }

    if (this.marqueur && this.element) {
      this.marqueur.setLngLat([p.lng, p.lat]);
      this.element.classList.toggle('ptm-pin--retard', retard);
    } else {
      this.element = this.construirePin(retard);
      this.marqueur = new maplibregl.Marker({ element: this.element })
        .setLngLat([p.lng, p.lat])
        .addTo(this.map);
    }
    // On recentre en douceur : le destinataire regarde UN camion, il n'a aucune
    // raison de le perdre de vue.
    this.map.easeTo({ center: [p.lng, p.lat], zoom: 13, duration: 700 });
  });

  ngAfterViewInit(): void {
    setTimeout(() => this.initialiser(), 0);
  }

  ngOnDestroy(): void {
    this.observateur?.disconnect();
    this.marqueur?.remove();
    this.map?.remove();
    this.map = null;
  }

  private initialiser(): void {
    const el = this.conteneur()?.nativeElement;
    if (!el) return;
    const p = this.position();

    this.map = this.mapSvc.createMap(el, {
      center: p ?? CENTRE_PAR_DEFAUT,
      zoom: p ? 13 : 10,
      style: this.theme.theme() === 'dark' ? 'dark' : 'light',
      // Aucun controle : ni navigation, ni geolocalisation, ni echelle. La page ne
      // demande RIEN a l'appareil du destinataire — surtout pas sa position (A4 § 6).
      withNavigationControl: false,
      withGeolocateControl: false,
      withScaleControl: false,
    });

    this.observateur = new ResizeObserver(() => this.map?.resize());
    this.observateur.observe(el);
    this.prete.set(true);
  }

  private construirePin(retard: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = `ptm-pin${retard ? ' ptm-pin--retard' : ''}`;
    // Aucune plaque, aucune etiquette : le marqueur ne porte rien qui identifie un
    // vehicule ou son proprietaire.
    el.innerHTML =
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5v8h1"/>' +
      '<circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>';
    return el;
  }
}
