import { DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import type { PartageTrajetPublicDto } from '@vizyo/tracky-shared';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap } from 'maplibre-gl';
import { firstValueFrom } from 'rxjs';
import { MapService } from '../../core/services/map.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA PAGE PUBLIQUE D'UN TRAJET — `/t/:token`
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ┌─ LE DÉFAUT QU'ELLE FERME ──────────────────────────────────────────────────────────────┐
 * │ Le bouton « Partager » du replay copiait l'URL INTERNE de l'application. Envoyée au    │
 * │ conducteur concerné — qui n'a pas de compte — elle affichait un écran de connexion.     │
 * │ L'application annonçait pourtant « Lien copié » : on envoyait un lien mort en croyant   │
 * │ avoir partagé, et c'est le destinataire qui découvrait le problème.                     │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ ELLE S'OUVRE CHEZ QUELQU'UN QUI N'A RIEN DEMANDÉ ─────────────────────────────────────┐
 * │ Pas de compte, pas de menu, pas de lien vers l'application, et RIEN de posé sur son    │
 * │ appareil : ni cookie, ni stockage local, ni mesure d'audience. Même règle que le suivi  │
 * │ de livraison (A4 § 6), tenue par `estPagePublique` qui connaît le préfixe `/t/`.        │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ QUATRE ÉTATS, ET TROIS SONT LE MÊME ÉCRAN. Expiré, révoqué, introuvable : le serveur
 * répond `410` sans distinguer, et cette page dit la même chose. Une nuance à l'écran
 * trahirait ce que le code de retour refuse de dire — « ce token a existé » est déjà une
 * information.
 */

type Etat = 'chargement' | 'actif' | 'ferme';

@Component({
  selector: 'app-public-trip',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pj">
      @switch (etat()) {
        @case ('chargement') {
          <div class="pj-centre">
            <div class="pj-rond"></div>
            <p class="pj-attente">Chargement du trajet…</p>
          </div>
        }

        @case ('ferme') {
          <!--
            L'écran des TROIS états fermés. Aucun bouton pour « demander un nouveau lien » :
            le destinataire n'a personne à qui le demander depuis ici, et un bouton qui ne
            mène nulle part est pire qu'une phrase claire.
          -->
          <div class="pj-centre">
            <div class="pj-ico" aria-hidden="true">⏱</div>
            <h1 class="pj-titre">Ce lien n'est plus valide</h1>
            <p class="pj-texte">
              Les liens de partage sont temporaires. Demandez-en un nouveau à la personne
              qui vous a envoyé celui-ci.
            </p>
          </div>
        }

        @case ('actif') {
          <div class="pj-page">
            <header class="pj-entete">
              <div>
                <p class="pj-oeil">TRAJET PARTAGÉ</p>
                <h1 class="pj-plaque">{{ trajet()!.plate }}</h1>
              </div>
              <p class="pj-quand">{{ quand() }}</p>
            </header>

            <div #carte class="pj-carte" role="application" aria-label="Tracé du trajet"></div>

            <dl class="pj-chiffres">
              <div><dt>Distance</dt><dd>{{ trajet()!.distanceKm | number:'1.1-1' }} km</dd></div>
              <div><dt>Durée</dt><dd>{{ duree() }}</dd></div>
              <div><dt>Vitesse moy.</dt><dd>{{ trajet()!.avgSpeedKmh }} km/h</dd></div>
              <div><dt>Vitesse max</dt><dd>{{ trajet()!.maxSpeedKmh }} km/h</dd></div>
            </dl>

            <!--
              ⚠️ L'ÉCHÉANCE EST ÉCRITE. Le destinataire range le lien dans ses messages et le
              rouvre trois jours plus tard : sans cette phrase, il conclut que le produit est
              cassé plutôt que de comprendre que le lien avait une durée.
            -->
            <p class="pj-pied">Ce lien expire le {{ expiration() }}.</p>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100dvh; min-height: 100vh; background: var(--bg-primary) }
    .pj { min-height: 100dvh; min-height: 100vh; display: flex; flex-direction: column }

    .pj-centre {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 12px; padding: 32px 24px; text-align: center;
    }
    .pj-rond {
      width: 26px; height: 26px; border-radius: 9999px;
      border: 2.5px solid var(--border-subtle); border-top-color: var(--fg-secondary);
      animation: pj-tourne .9s linear infinite;
    }
    @keyframes pj-tourne { to { transform: rotate(360deg) } }
    @media (prefers-reduced-motion: reduce) { .pj-rond { animation: none } }

    .pj-attente { margin: 0; font-size: 13.5px; color: var(--fg-secondary) }
    .pj-ico { font-size: 34px; line-height: 1 }
    .pj-titre { margin: 0; font-size: 19px; font-weight: 700; color: var(--fg-primary) }
    .pj-texte { margin: 0; max-width: 34ch; font-size: 14px; line-height: 1.6; color: var(--fg-secondary) }

    .pj-page { flex: 1; display: flex; flex-direction: column; gap: 0 }
    .pj-entete {
      display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
      padding: 20px 20px 14px;
    }
    .pj-oeil {
      margin: 0 0 4px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
      color: var(--fg-secondary);
    }
    .pj-plaque { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary) }
    .pj-quand { margin: 0; font-size: 13px; color: var(--fg-secondary); text-align: right }

    /* La carte prend ce qui reste : c'est l'objet du partage, pas une illustration. */
    .pj-carte { flex: 1; min-height: 320px; width: 100% }

    .pj-chiffres {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; margin: 0;
      background: var(--border-subtle); border-top: 1px solid var(--border-subtle);
    }
    .pj-chiffres > div { background: var(--bg-primary); padding: 12px 10px; text-align: center }
    .pj-chiffres dt {
      font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-secondary);
    }
    .pj-chiffres dd { margin: 4px 0 0; font-size: 16px; font-weight: 700; color: var(--fg-primary) }
    /* Deux colonnes sous 420 px : quatre cases côte à côte y coupent leurs libellés. */
    @media (max-width: 420px) {
      .pj-chiffres { grid-template-columns: repeat(2, 1fr) }
    }

    .pj-pied {
      margin: 0; padding: 12px 20px 20px; font-size: 11.5px;
      color: var(--fg-secondary); text-align: center;
    }
  `],
})
export class PublicTripComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly mapSvc = inject(MapService);
  private readonly conteneur = viewChild<ElementRef<HTMLDivElement>>('carte');

  protected readonly etat = signal<Etat>('chargement');
  protected readonly trajet = signal<PartageTrajetPublicDto | null>(null);
  private map: MlMap | null = null;

  protected readonly quand = computed(() => {
    const t = this.trajet();
    if (!t) return '';
    const d = new Date(t.startedAt);
    return d.toLocaleString('fr-FR', {
      day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  });

  protected readonly duree = computed(() => {
    const s = this.trajet()?.durationSeconds ?? 0;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
  });

  protected readonly expiration = computed(() => {
    const t = this.trajet();
    if (!t) return '';
    return new Date(t.expiresAt).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  });

  async ngOnInit(): Promise<void> {
    const token = this.route.snapshot.paramMap.get('token');
    if (!token) { this.etat.set('ferme'); return; }
    try {
      const dto = await firstValueFrom(
        this.http.get<PartageTrajetPublicDto>(`/api/public/trip/${encodeURIComponent(token)}`),
      );
      this.trajet.set(dto);
      this.etat.set('actif');
      // Le conteneur n'existe qu'une fois l'état passé à « actif » : la carte se monte au
      // tour de boucle suivant, pas dans `ngAfterViewInit` qui a déjà eu lieu.
      setTimeout(() => this.dessiner(), 0);
    } catch {
      /**
       * ⚠️ AUCUNE DISTINCTION D'ERREUR. `410`, `404`, réseau coupé : le même écran. Trier les
       * causes ici rendrait bavard ce que le serveur refuse de dire, et un destinataire ne
       * peut de toute façon rien faire d'autre que redemander un lien.
       */
      this.etat.set('ferme');
    }
  }

  ngAfterViewInit(): void { /* la carte est montée par `dessiner`, après le chargement */ }

  ngOnDestroy(): void {
    this.map?.remove();
    this.map = null;
  }

  /**
   * Le tracé, et rien d'autre.
   *
   * ⚠️ AUCUN CONTRÔLE DE CARTE : ni navigation, ni géolocalisation, ni échelle. La page ne
   * demande RIEN à l'appareil du destinataire — surtout pas sa position.
   */
  private dessiner(): void {
    const el = this.conteneur()?.nativeElement;
    const t = this.trajet();
    if (!el || !t || t.path.length === 0) return;

    const bornes = t.path.reduce(
      (b, [lng, lat]) => b.extend([lng, lat] as [number, number]),
      new maplibregl.LngLatBounds(t.path[0] as [number, number], t.path[0] as [number, number]),
    );

    this.map = this.mapSvc.createMap(el, {
      center: bornes.getCenter(),
      zoom: 12,
      /**
       * ⚠️ LE FOND `osm`, PAS `light`/`dark`. Les fonds « Plan clair » et « Plan sombre »
       * viennent de CARTO, qui exige désormais une clé : leurs tuiles reviennent barrées
       * d'un filigrane « API KEY REQUIRED » en travers de toute la carte. Constaté le
       * 2026-09-07 sur le rendu réel.
       *
       * Sur une page que le client envoie à un conducteur ou à un tiers, c'est la dernière
       * chose à montrer. `osm` est le fond par défaut du produit, sans clé et sans filigrane.
       *
       * ⚠️ ET IL NE SUIT PAS LE THÈME, volontairement. Le destinataire n'a pas de préférence
       * enregistrée — il n'a pas de compte : suivre le thème de SON système donnerait une
       * carte sombre à qui n'a rien demandé, et surtout une seule des deux variantes est
       * utilisable.
       */
      style: 'osm',
      withNavigationControl: false,
      withGeolocateControl: false,
      withScaleControl: false,
    });

    this.map.once('load', () => {
      if (!this.map) return;
      this.map.addSource('trajet', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t.path } },
      });
      // Un contour sous le trait : sur un fond clair comme sur un fond sombre, une ligne
      // simple disparaît dès qu'elle croise une route de la même teinte.
      this.map.addLayer({
        id: 'trajet-contour', type: 'line', source: 'trajet',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0A1311', 'line-width': 7, 'line-opacity': .35 },
      });
      this.map.addLayer({
        id: 'trajet-trait', type: 'line', source: 'trajet',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#10E0A0', 'line-width': 4 },
      });

      const depart = t.path[0]!;
      const arrivee = t.path[t.path.length - 1]!;
      this.marqueur(depart, 'Départ', '#10E0A0');
      if (arrivee[0] !== depart[0] || arrivee[1] !== depart[1]) {
        this.marqueur(arrivee, 'Arrivée', '#0A1311');
      }

      /**
       * ⚠️ `resize()` AVANT `fitBounds`, et ce n'est pas superflu. `fitBounds` cadre d'après
       * la taille que la carte CROIT avoir : si elle a été créée pendant que la mise en page
       * flex se posait encore, elle garde une taille périmée et le cadrage tombe à côté —
       * observé une fois sur deux, avec le tracé qui sortait par la droite. Un trajet
       * partagé dont on ne voit pas l'arrivée ne partage pas grand-chose.
       */
      this.map.resize();
      this.map.fitBounds(bornes, { padding: 48, maxZoom: 15, duration: 0 });
    });
  }

  private marqueur(point: [number, number], titre: string, couleur: string): void {
    if (!this.map) return;
    const el = document.createElement('div');
    el.setAttribute('aria-label', titre);
    el.style.cssText = `width:14px;height:14px;border-radius:50%;background:${couleur};`
      + 'border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35)';
    new maplibregl.Marker({ element: el }).setLngLat(point).addTo(this.map);
  }
}
