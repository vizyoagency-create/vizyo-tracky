import { DecimalPipe } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import { firstValueFrom } from 'rxjs';
import { MapService } from '../../core/services/map.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { FleetPlacesApiService, type FleetPlaceDto } from '../../core/services/fleet-places.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * DÉPLACER UN LIEU — depuis la page Lieux, par un geste explicite
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le glisser-déposer d'un repère vivait sur la carte temps réel. Sur téléphone, un pouce qui
 * veut faire défiler la carte et tombe sur un repère le déplaçait — et la nouvelle position
 * partait en base sans qu'on l'ait voulu (constaté par le propriétaire, 2026-09-07). La carte
 * ne déplace donc plus rien ; ici, on ouvre une carte POUR ÇA, on glisse le repère, et rien
 * n'est enregistré avant d'avoir appuyé sur le bouton.
 */
@Component({
  selector: 'app-place-move',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pm-fond" (click)="annule.emit()"></div>
    <div class="pm-boite" role="dialog" aria-modal="true" [attr.aria-label]="'Déplacer ' + place().name">
      <header class="pm-tete">
        <h2 class="pm-titre">Déplacer « {{ place().name }} »</h2>
        <p class="pm-aide">
          Faites glisser le repère jusqu'au bon endroit, puis enregistrez. Rien ne change tant
          que vous n'avez pas enregistré.
        </p>
      </header>
      <div #carte class="pm-carte" role="application" aria-label="Carte de positionnement"></div>
      @if (position(); as p) {
        <p class="pm-coord" aria-live="polite">
          {{ p.lat | number: '1.5-5' }}, {{ p.lng | number: '1.5-5' }}
          @if (aBouge()) { <span class="pm-coord-note">— nouvelle position, non enregistrée</span> }
        </p>
      }
      <footer class="pm-pied">
        <button type="button" class="pm-b" (click)="annule.emit()">Annuler</button>
        <button type="button" class="pm-b pm-b--principal" [disabled]="!aBouge() || enregistrement()" (click)="enregistrer()">
          {{ enregistrement() ? 'Enregistrement…' : 'Enregistrer la nouvelle position' }}
        </button>
      </footer>
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .pm-fond { position: fixed; inset: 0; z-index: 9000; background: rgba(0, 0, 0, .55); backdrop-filter: blur(2px); }
    .pm-boite {
      position: fixed; z-index: 9001; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(96vw, 640px); max-height: 92dvh; display: flex; flex-direction: column;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card, 16px); box-shadow: 0 18px 60px rgba(0, 0, 0, .45); overflow: hidden;
    }
    .pm-tete { padding: 16px 18px 10px; }
    .pm-titre { margin: 0; font-size: 16px; font-weight: 700; color: var(--fg-primary); }
    .pm-aide { margin: 6px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); }
    .pm-carte { height: min(52vh, 380px); min-height: 240px; width: 100%; }
    .pm-coord { margin: 0; padding: 8px 18px; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--fg-tertiary); }
    .pm-coord-note { color: var(--fg-secondary); font-weight: 600; }
    .pm-pied { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 18px 16px; flex-wrap: wrap; }
    .pm-b {
      min-height: 44px; padding: 10px 14px; border-radius: 10px; font-size: 13px; font-weight: 600;
      background: transparent; border: 1px solid var(--border-strong); color: var(--fg-primary); cursor: pointer;
    }
    /* Même encre que le bouton du bandeau carte : du blanc sur le vert de marque donne 1,72:1. */
    .pm-b--principal { background: var(--tracky-light); border-color: transparent; color: #04150F; }
    .pm-b:disabled { opacity: .5; cursor: default; }
  `],
})
export class PlaceMoveComponent implements AfterViewInit, OnDestroy {
  readonly place = input.required<FleetPlaceDto>();
  /** Le lieu, tel que le serveur l'a enregistré à sa nouvelle position. */
  readonly deplace = output<FleetPlaceDto>();
  readonly annule = output<void>();

  private readonly carte = viewChild<ElementRef<HTMLDivElement>>('carte');
  private readonly mapSvc = inject(MapService);
  private readonly preferences = inject(PreferencesService);
  private readonly api = inject(FleetPlacesApiService);
  private readonly toast = inject(ToastService);

  protected readonly position = signal<{ lat: number; lng: number } | null>(null);
  protected readonly enregistrement = signal(false);
  protected readonly aBouge = computed(() => {
    const p = this.position();
    const o = this.place();
    return !!p && (p.lat !== o.lat || p.lng !== o.lng);
  });

  private map: MlMap | null = null;
  private marker: MlMarker | null = null;

  ngAfterViewInit(): void {
    setTimeout(() => this.monterCarte(), 0);
  }

  ngOnDestroy(): void {
    this.marker?.remove();
    this.marker = null;
    this.map?.remove();
    this.map = null;
  }

  /** Le repère a été lâché ici. Appelé par le glisser-déposer — et par les tests. */
  protected deplacerVers(lat: number, lng: number): void {
    this.position.set({ lat, lng });
  }

  protected async enregistrer(): Promise<void> {
    const p = this.position();
    if (!p || !this.aBouge() || this.enregistrement()) return;
    this.enregistrement.set(true);
    try {
      const updated = await firstValueFrom(this.api.update(this.place().id, { lat: p.lat, lng: p.lng }));
      this.toast.success('Lieu déplacé', updated.name);
      this.deplace.emit(updated);
    } catch {
      this.toast.error('Déplacement non enregistré');
    } finally {
      this.enregistrement.set(false);
    }
  }

  private monterCarte(): void {
    const el = this.carte()?.nativeElement;
    const p = this.place();
    if (!el) return;
    this.position.set({ lat: p.lat, lng: p.lng });
    this.map = this.mapSvc.createMap(el, {
      center: { lat: p.lat, lng: p.lng },
      zoom: 16,
      style: this.preferences.prefs().map.style,
      withGeolocateControl: false,
      withScaleControl: false,
    });
    if (!this.map) return;

    const pin = document.createElement('div');
    pin.setAttribute('aria-label', 'Repère à déplacer');
    // Créé hors du gabarit : les styles du composant ne le voient pas, d'où l'inline.
    pin.style.cssText = 'width:26px;height:26px;border-radius:8px;background:#10E0A0;border:3px solid #fff;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.4);cursor:grab';
    this.marker = new maplibregl.Marker({ element: pin, anchor: 'center', draggable: true })
      .setLngLat([p.lng, p.lat])
      .addTo(this.map);
    this.marker.on('dragend', () => {
      const ll = this.marker!.getLngLat();
      this.deplacerVers(ll.lat, ll.lng);
    });
    // La boîte finit de s'ouvrir après la création : sans resize, canvas blanc.
    setTimeout(() => this.map?.resize(), 50);
    setTimeout(() => this.map?.resize(), 300);
  }
}
