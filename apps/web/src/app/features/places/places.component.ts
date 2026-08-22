import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  LucideAngularModule, Fuel, MapPin, ParkingSquare, Check, Trash2, RefreshCw, AlertTriangle, Info, Sparkles,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  FleetPlacesApiService,
  type FleetPlaceDto,
  type FleetPlaceKind,
  type StationGroupDto,
  type PlaceFactsDto,
  type PlaceAnalysisDto,
} from '../../core/services/fleet-places.service';
import {
  GpsDeadZonesApiService,
  type GpsDeadZoneMapDto,
} from '../../core/services/gps-dead-zones.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { SpinnerComponent } from '../../shared/ui/spinner/spinner.component';
import { ZoneComponent, type EtatZone } from '../../shared/ui/zone/zone.component';

/** Les trois onglets de la planche « Lieux Cles ». */
type OngletPlaces = 'valider' | 'valides' | 'zones';

/**
 * « Lieux clés » — page de gestion du référentiel des lieux de la flotte.
 *
 * Deux matières :
 *  1. les PASSAGES en station-service détectés avec un VRAI arrêt (≥ 4 min) — l'exploitant y
 *     valide les stations qu'il retient (« Ajouter aux lieux ») → couleur dédiée sur la carte ;
 *  2. les LIEUX de la flotte : stations validées + parkings / stationnements récurrents posés
 *     à la main sur la carte (ex. « CDEF Launaguet »).
 *
 * Lecture = `places_view`, écriture = `places_manage` (managers inclus par défaut).
 */
@Component({
  selector: 'app-places',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RouterLink, LucideAngularModule, SpinnerComponent, ZoneComponent],
  template: `
    <div class="lk-page">
      <header class="lk-head">
        <div>
          <h1 class="lk-title">Lieux clés</h1>
          <p class="lk-sub">
            Stations-service fréquentées et parkings / stationnements récurrents de la flotte.
          </p>
        </div>
        <button type="button" class="lk-refresh" [disabled]="loading()" (click)="reload()">
          <lucide-icon [img]="RefreshIcon" [size]="15"></lucide-icon>
          Actualiser
        </button>
      </header>

      <!--
        Trois onglets (planche « Lieux Cles »). La classe .tab-btn n'est pas
        decorative : la regle des 44 px de styles.css est une LISTE de noms de
        classes, elle ne rattrape que ce qui y est inscrit. Toute nouvelle barre
        d'onglets doit la porter.
      -->
      <div class="lk-tabs" role="tablist" aria-label="Sections des lieux">
        <button type="button" class="tab-btn lk-tab" role="tab"
                [class.lk-tab--on]="onglet() === 'valider'"
                [attr.aria-selected]="onglet() === 'valider'"
                (click)="onglet.set('valider')">
          À valider <span class="lk-tab-n">{{ stationsAValider().length }}</span>
        </button>
        <button type="button" class="tab-btn lk-tab" role="tab"
                [class.lk-tab--on]="onglet() === 'valides'"
                [attr.aria-selected]="onglet() === 'valides'"
                (click)="onglet.set('valides')">
          Lieux validés <span class="lk-tab-n">{{ places().length }}</span>
        </button>
        <button type="button" class="tab-btn lk-tab" role="tab"
                [class.lk-tab--on]="onglet() === 'zones'"
                [attr.aria-selected]="onglet() === 'zones'"
                (click)="onglet.set('zones')">
          Zones GPS <span class="lk-tab-n">{{ zonesGps().length }}</span>
        </button>
      </div>

      <!--
        Les etats non nominaux passent par <app-zone> : « vide » ne peut plus
        absorber « erreur ». Le bandeau maison ci-dessus affichait l'erreur ET
        laissait le vide s'afficher dessous.
      -->
      @if (etatOnglet() !== 'rempli') {
        <app-zone [etat]="etatOnglet()"
                  [quoi]="onglet() === 'valider' ? 'les stations à valider'
                        : onglet() === 'valides' ? 'vos lieux'
                        : 'les zones GPS'"
                  [vide]="onglet() === 'valider' ? 'Aucune station à valider'
                        : onglet() === 'valides' ? 'Aucun lieu enregistré'
                        : 'Aucune zone GPS détectée'"
                  [videDetail]="onglet() === 'valider' ? 'Une station apparaît ici dès qu\\'un trajet analysé s\\'y arrête réellement plus de ' + minStopMin + ' minutes.'
                              : onglet() === 'valides' ? 'Validez une station depuis l\\'onglet « À valider », ou posez un parking depuis la carte.'
                              : 'Une zone apparaît quand plusieurs véhicules perdent le signal au même endroit — un parking souterrain, par exemple.'"
                  erreur="Impossible de charger les lieux clés"
                  erreurDetail="Vos lieux ne sont pas perdus : c'est leur chargement qui a échoué."
                  (reessayer)="reload()" />
      }

      <!-- ─── Onglet « Lieux validés » ─── -->
      @if (onglet() === 'valides' && etatOnglet() === 'rempli') {
      <section class="lk-card">
        <div class="lk-card-head">
          <span class="lk-card-title">
            <lucide-icon [img]="ParkingIcon" [size]="15"></lucide-icon>
            Lieux de la flotte
          </span>
          <span class="lk-count">{{ places().length }}</span>
        </div>

        <p class="lk-help">
          Les stations que vous validez et les parkings que vous posez apparaissent avec une couleur
          dédiée sur la carte. Pour créer un parking, utilisez l'outil
          <strong>« Poser un lieu »</strong> depuis la <a routerLink="/map" class="lk-link">carte</a>.
        </p>

          <ul class="lk-list">
            @for (p of places(); track p.id) {
              <li class="lk-item">
                <span class="lk-kind" [attr.data-k]="p.kind">{{ kindLabel(p.kind) }}</span>
                <div class="lk-item-main">
                  <strong class="lk-item-name">{{ p.name }}</strong>
                  <span class="lk-item-meta">
                    {{ p.lat | number: '1.4-4' }}, {{ p.lng | number: '1.4-4' }} · rayon {{ p.radiusM }} m
                    @if (p.note) { · {{ p.note }} }
                  </span>
                  <!--
                    Les passages d'une station VALIDEE se lisaient dans l'autre section
                    tant que la page empilait tout. Separee en onglets, elle les aurait
                    perdus : « A valider » ne montre que ce qui reste a faire. Ils sont
                    donc rendus ici, sur le lieu qui en est issu.
                  -->
                  @if (stationOf(p.id); as s) {
                    <span class="lk-item-meta">
                      <b>{{ s.passages }}</b> passage{{ s.passages > 1 ? 's' : '' }} ·
                      <b>{{ s.distinctVehicles }}</b> véhicule{{ s.distinctVehicles > 1 ? 's' : '' }} ·
                      arrêt moy. {{ s.avgStopMin }} min · dernier {{ s.lastAt | date: 'dd/MM' }}
                      @if (s.lastPriceEur != null) { · {{ s.lastPriceEur | number: '1.3-3' }} €/L }
                    </span>
                    <div class="lk-vehicles">
                      @for (v of s.vehicles; track v.vehicleId) {
                        <span class="lk-veh"><b>{{ v.plate || 'véhicule' }}</b> {{ v.visits }}×</span>
                      }
                    </div>
                  }
                </div>
                <button type="button" class="lk-btn" (click)="toggleFacts(p)">
                  <lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon>
                  {{ expandedPlaceId() === p.id ? 'Masquer' : 'Infos' }}
                </button>
                <button type="button" class="lk-btn" (click)="showOnMap(p.lat, p.lng)" title="Voir sur la carte">
                  <lucide-icon [img]="MapPinIcon" [size]="13"></lucide-icon>
                </button>
                @if (canManage()) {
                  <button
                    type="button"
                    class="lk-btn lk-btn--danger"
                    [disabled]="busyId() === p.id"
                    (click)="removePlace(p)"
                    title="Retirer ce lieu"
                  >
                    <lucide-icon [img]="TrashIcon" [size]="13"></lucide-icon>
                  </button>
                }

                <!-- Infos réelles du lieu (OpenStreetMap) — gratuites, jamais inventées. -->
                @if (expandedPlaceId() === p.id) {
                  <div class="lk-facts">
                    @if (factsLoadingId() === p.id) {
                      <div class="lk-loading"><app-spinner [size]="16" /></div>
                    } @else if (factsOf(p.id); as f) {
                      <div class="lk-facts-body">
                        @if (f.imageUrl) {
                          <img class="lk-facts-img" [src]="f.imageUrl" alt="" loading="lazy" />
                        }
                        <div class="lk-facts-cols">
                          @if (f.name || f.brand) {
                            <div class="lk-fact"><span>Enseigne</span><b>{{ f.brand || f.name }}</b></div>
                          }
                          @if (f.openingHours) {
                            <div class="lk-fact"><span>Horaires</span><b>{{ f.openingHours }}</b></div>
                          }
                          @if (f.phone) {
                            <div class="lk-fact"><span>Téléphone</span><b>{{ f.phone }}</b></div>
                          }
                          @if (f.address) {
                            <div class="lk-fact"><span>Adresse</span><b>{{ f.address }}</b></div>
                          }
                          @if (f.parking?.capacity != null) {
                            <div class="lk-fact"><span>Capacité</span><b>{{ f.parking!.capacity }} places</b></div>
                          }
                          @if (f.website) {
                            <div class="lk-fact">
                              <span>Site</span>
                              <a class="lk-link" [href]="f.website" target="_blank" rel="noopener noreferrer">ouvrir</a>
                            </div>
                          }
                        </div>
                        @if (f.services.length || f.fuels.length || f.payment.length) {
                          <div class="lk-chips">
                            @for (s of f.services; track s) { <span class="lk-chip lk-chip--svc">{{ s }}</span> }
                            @for (s of f.fuels; track s) { <span class="lk-chip lk-chip--fuel">{{ s }}</span> }
                            @for (s of f.payment; track s) { <span class="lk-chip">{{ s }}</span> }
                          </div>
                        }
                        <p class="lk-facts-src">Source : OpenStreetMap (contributif, gratuit)</p>
                      </div>
                    } @else {
                      <p class="lk-facts-empty">
                        Aucune information cartographiée pour ce lieu (OpenStreetMap ne le référence pas
                        encore, ou le service est momentanément indisponible).
                      </p>
                    }
                  </div>

                  <!--
                    ⚠️ CE COMMENTAIRE DISAIT : « Sinon : rien, pas même une analyse passée. »
                    C'était un choix assumé, et c'est celui qu'on corrige (2026-08-03).

                    Une analyse déjà produite appartient au client : elle a été payée, elle
                    est en base, et la relire ne coûte rien. La cacher parce que l'option
                    n'est plus souscrite revient à reprendre une marchandise livrée — et
                    c'est ce qui arrivait aux 4 409 récits de trajets, même défaut.

                    La section apparaît donc si l'option est active OU si une analyse
                    existe ; seul le bouton « Analyser » dépend de l'option.
                  -->
                  @if (aiVisible() || analysisOf(p.id)) {
                    <div class="lk-ai">
                      <div class="lk-ai-head">
                        <span class="lk-ai-title">
                          <lucide-icon [img]="SparklesIcon" [size]="13"></lucide-icon>
                          Analyse du lieu
                        </span>
                        <!--
                          ⚠️ DEUX conditions, et elles disent deux choses différentes :
                          la permission d'un côté, l'option souscrite de l'autre. Sans la
                          seconde, le bouton restait cliquable option coupée : l'appel
                          partait, le serveur le refusait, et le client récoltait une
                          erreur pour une action que l'écran lui proposait.
                        -->
                        @if (canAnalyze() && aiVisible()) {
                          <button
                            type="button"
                            class="lk-btn lk-btn--ai"
                            [disabled]="analyzingId() === p.id"
                            (click)="analyzePlace(p)"
                          >
                            @if (analyzingId() === p.id) {
                              <app-spinner [size]="12" />
                              Analyse…
                            } @else {
                              {{ analysisOf(p.id) ? 'Relancer' : 'Analyser' }}
                            }
                          </button>
                        }
                      </div>

                      @if (analysisOf(p.id); as a) {
                        <p class="lk-ai-summary">{{ a.summary }}</p>
                        @if (a.highlights.length) {
                          <ul class="lk-ai-list">
                            @for (h of a.highlights; track h) { <li>{{ h }}</li> }
                          </ul>
                        }
                        @if (a.recommendations.length) {
                          <div class="lk-ai-reco">
                            <span class="lk-ai-reco-label">À envisager</span>
                            <ul class="lk-ai-list">
                              @for (r of a.recommendations; track r) { <li>{{ r }}</li> }
                            </ul>
                          </div>
                        }
                        <p class="lk-facts-src">
                          Rédigé à partir des données OpenStreetMap et des passages réels de vos
                          véhicules — aucune information extérieure.
                          @if (a.aiModel) { · {{ a.aiModel }} }
                          · {{ a.computedAt | date: 'dd/MM/yyyy HH:mm' }}
                        </p>
                      } @else if (analyzingId() !== p.id) {
                        <p class="lk-facts-empty">
                          @if (canAnalyze()) {
                            Ce lieu n'a pas encore été analysé. L'analyse reprend les informations
                            ci-dessus et l'usage réel de vos véhicules pour en faire une fiche.
                          } @else {
                            Ce lieu n'a pas encore été analysé.
                          }
                        </p>
                      }
                    </div>
                  }
                }
              </li>
            }
          </ul>
      </section>
      }

      <!-- ─── Onglet « À valider » : les stations detectees, PAS ENCORE validees ─── -->
      @if (onglet() === 'valider' && etatOnglet() === 'rempli') {
      <section class="lk-card">
        <div class="lk-card-head">
          <span class="lk-card-title">
            <lucide-icon [img]="FuelIcon" [size]="15"></lucide-icon>
            Stations-service fréquentées
          </span>
          <span class="lk-count">{{ stationsAValider().length }}</span>
        </div>

        <p class="lk-help">
          <lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon>
          Une ligne par station — avec qui s'y est arrêté et combien de fois. Seuls les
          <strong>arrêts réels d'au moins {{ minStopMin }} minutes</strong> à moins de 160 m d'une
          station sont comptés — un simple ralentissement devant une station ne l'est jamais.
        </p>

        <!-- « Tout valider (3 sûrs) » — le raccourci de la planche. Il ne porte QUE
             les stations que le SERVEUR déclare prêtes : valider en masse ce qui
             n'a que deux passages ferait entrer dans le référentiel des lieux vus
             une fois par hasard. Le compte est donc celui du serveur, pas un seuil
             que l'écran se serait donné. -->
        @if (canManage() && stationsSures().length > 0) {
          <button type="button" class="lk-tout-valider"
                  [disabled]="busyId() !== null"
                  (click)="validerLesSures()">
            <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon>
            Tout valider ({{ stationsSures().length }} sûr{{ stationsSures().length > 1 ? 's' : '' }})
          </button>
        }

          <ul class="lk-list">
            @for (s of stationsAValider(); track s.stationId) {
              <li class="lk-item">
                <div class="lk-item-main">
                  <div class="lk-item-line">
                    <strong class="lk-item-name">{{ s.label }}</strong>
                    <!-- L'AVANCEMENT, tel que le serveur le voit. « 6/8 » dit à la fois
                         où on en est et ce qu'il reste — un simple « en cours » ne dirait
                         ni l'un ni l'autre. -->
                    @if (avancement(s); as av) {
                      <span class="pl-av {{ av.classe }}">
                        <b>{{ av.texte }}</b> · {{ av.libelle }}
                      </span>
                    }
                  </div>
                  <span class="lk-item-meta">
                    <b>{{ s.passages }}</b> passage{{ s.passages > 1 ? 's' : '' }} ·
                    <b>{{ s.distinctVehicles }}</b> véhicule{{ s.distinctVehicles > 1 ? 's' : '' }} ·
                    arrêt moy. {{ s.avgStopMin }} min · dernier {{ s.lastAt | date: 'dd/MM' }}
                    @if (s.lastPriceEur != null) { · {{ s.lastPriceEur | number: '1.3-3' }} €/L }
                  </span>
                  <!-- QUI est passé et COMBIEN DE FOIS (la demande client). -->
                  <div class="lk-vehicles">
                    @for (v of s.vehicles; track v.vehicleId) {
                      <span class="lk-veh"><b>{{ v.plate || 'véhicule' }}</b> {{ v.visits }}×</span>
                    }
                  </div>
                </div>
                <button type="button" class="lk-btn" (click)="showOnMap(s.lat, s.lng)" title="Voir sur la carte">
                  <lucide-icon [img]="MapPinIcon" [size]="13"></lucide-icon>
                </button>
                @if (canManage()) {
                  <button
                    type="button"
                    class="lk-btn lk-btn--ok"
                    [disabled]="busyId() === s.stationId"
                    (click)="validateStation(s)"
                  >
                    <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon>
                    Ajouter aux lieux
                  </button>
                }
              </li>
            }
          </ul>
      </section>
      }

      <!-- ─── Onglet « Zones GPS » ─── -->
      @if (onglet() === 'zones' && etatOnglet() === 'rempli') {
      <section class="lk-card">
        <div class="lk-card-head">
          <span class="lk-card-title">
            <lucide-icon [img]="MapPinIcon" [size]="15"></lucide-icon>
            Zones sans signal GPS
          </span>
          <span class="lk-count">{{ zonesGps().length }}</span>
        </div>

        <!--
          ⚠️ Cette phrase ne promet QUE ce qui est affiche. Le detail d'une zone
          (evenements, qualification, note) vit sur la fiche du vehicule : ici on
          liste, on situe, on renvoie. Ecrire « qualifiez vos zones » depuis cet
          onglet serait promettre une action qu'il ne porte pas.
        -->
        <p class="lk-help">
          <lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon>
          Les endroits où vos véhicules perdent le signal de façon récurrente — un parking
          souterrain, un entrepôt. Chaque zone se qualifie depuis la fiche du véhicule concerné.
        </p>

        <ul class="lk-list">
          @for (z of zonesGps(); track z.id) {
            <li class="lk-item">
              <span class="lk-kind" [attr.data-k]="z.status === 'SUSPECT' ? 'OTHER' : 'PARKING'">
                {{ z.status === 'SUSPECT' ? 'Suspecte' : 'Connue' }}
              </span>
              <div class="lk-item-main">
                <strong class="lk-item-name">{{ z.placeLabel || z.plate || 'Zone sans signal' }}</strong>
                <span class="lk-item-meta">
                  <b>{{ z.occurrences }}</b> perte{{ z.occurrences > 1 ? 's' : '' }} de signal ·
                  rayon {{ z.radiusM }} m
                  @if (z.plate) { · {{ z.plate }} }
                </span>
              </div>
              <button type="button" class="lk-btn" (click)="showOnMap(z.centroidLat, z.centroidLng)" title="Voir sur la carte">
                <lucide-icon [img]="MapPinIcon" [size]="13"></lucide-icon>
              </button>
            </li>
          }
        </ul>
      </section>
      }
    </div>
  `,
  styles: [`
    /* Cibles tactiles au doigt — critère de recette « iPhone 390 px : cibles ≥ 44 px ».
       Mesuré à 375 px : « Actualiser » 36 de haut, le lien « carte » 28 de large. */
    @media (max-width: 768px) {
      .lk-page button,
      .lk-page a[href] { min-height: 44px }
      /* La hauteur ne suffisait pas : les boutons a icone seule sortaient a 35x44.
         Une cible se mesure dans LES DEUX sens. */
      .lk-page .lk-btn { min-width: 44px; justify-content: center }
    }
    .lk-page { display: flex; flex-direction: column; gap: 16px; padding: 18px; max-width: 1100px; margin: 0 auto; }
    .lk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .lk-title { margin: 0; font-size: 22px; font-weight: 800; color: var(--fg-primary); }
    .lk-sub { margin: 3px 0 0; font-size: 12.5px; color: var(--fg-tertiary); }
    .lk-refresh { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 10px; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-secondary); font-size: 12px; font-weight: 600; cursor: pointer; }
    .lk-refresh:disabled { opacity: .5; cursor: wait; }
    /* .lk-error est parti avec le bandeau maison : <app-zone> rend l'erreur, et
       surtout elle ne coexiste plus avec le vide affiche dessous. */

    /* ─── Onglets (planche « Lieux Cles ») ───
       .tab-btn porte la garantie des 44 px de styles.css ; .lk-tab ne fait que
       la mise en forme. L'etat actif prend --texte-succes, jamais le vert de
       marque : c'est la convention ecrite dans styles.css, payee sur 5 ecrans. */
    .lk-tabs { display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: var(--bg-tertiary); overflow-x: auto; }
    .lk-tab { flex: 1 1 auto; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 10px; border: none; border-radius: 9px; background: transparent; color: var(--fg-tertiary); font-family: inherit; font-size: 12.5px; font-weight: 700; white-space: nowrap; cursor: pointer; }
    .lk-tab:hover { color: var(--fg-secondary); }
    .lk-tab--on { background: var(--bg-secondary); color: var(--texte-succes); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .lk-tab-n { padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--fg-tertiary) 18%, transparent); color: var(--fg-secondary); font-size: 11px; font-weight: 700; }
    .lk-tab--on .lk-tab-n { background: color-mix(in srgb, var(--tracky) 18%, transparent); color: var(--texte-succes); }
    .lk-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .lk-card-head { display: flex; align-items: center; justify-content: space-between; }
    .lk-card-title { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .lk-card-title lucide-icon { color: var(--texte-violet); }
    .lk-count { padding: 1px 9px; border-radius: 999px; background: color-mix(in srgb, var(--fg-tertiary) 16%, transparent); color: var(--fg-secondary); font-size: 11px; font-weight: 700; }
    .lk-help { margin: 0; display: flex; align-items: baseline; gap: 5px; font-size: 11.5px; line-height: 1.5; color: var(--fg-tertiary); }
    .lk-help strong { color: var(--fg-secondary); }
    .lk-link { color: var(--tracky-light); text-decoration: underline; }
    .lk-loading { display: flex; justify-content: center; padding: 18px; }
    .lk-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 5px; padding: 20px 10px; color: var(--fg-tertiary); }
    .lk-empty p { margin: 0; font-weight: 700; color: var(--fg-secondary); }
    .lk-empty span { font-size: 11.5px; max-width: 380px; }
    .lk-empty-icon { opacity: .3; }
    .lk-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
    .lk-item { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 11px; border-radius: 10px; background: var(--bg-tertiary, rgba(148,163,184,.07)); border: 1px solid var(--border-subtle); }
    .lk-item-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .lk-item-line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }

    /* L'AVANCEMENT DANS LA FILE — « 6/8 · En cours ».
       Trois teintes pour trois moments : ce qui est prêt attire l'œil (vert),
       ce qui approche se lit sans appeler (ambre), ce qui vient d'apparaître
       reste neutre. Le chiffre porte l'information, la couleur ne fait que
       hiérarchiser — elle n'est jamais seule à dire l'état. */
    .pl-av {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 1px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 600; white-space: nowrap;
    }
    .pl-av b { font-weight: 800; }
    .pl-av--pret { background: color-mix(in srgb, var(--color-tracky-light) 15%, transparent); color: var(--texte-succes); }
    .pl-av--cours { background: color-mix(in srgb, var(--warning) 15%, transparent); color: var(--texte-attente); }
    .pl-av--qualifier { background: color-mix(in srgb, var(--fg-tertiary) 14%, transparent); color: var(--fg-secondary); }

    /* Le raccourci de masse : une vraie cible, pas un lien discret — c'est
       l'action qui vide la file. */
    .lk-tout-valider {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      align-self: flex-start; min-height: 44px; padding: 0 14px;
      border-radius: 10px; cursor: pointer;
      background: color-mix(in srgb, var(--color-tracky-light) 15%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 40%, transparent);
      color: var(--texte-succes); font: inherit; font-size: 12.5px; font-weight: 700;
    }
    .lk-tout-valider:disabled { opacity: .55; cursor: wait; }
    .lk-item-name { color: var(--fg-primary); font-size: 13px; font-weight: 700; }
    .lk-item-meta { color: var(--fg-tertiary); font-size: 11.5px; }
    .lk-item-meta b { color: var(--fg-secondary); }
    /* Infos OSM dépliées : occupe toute la largeur de l'item (flex-wrap). */
    .lk-facts { flex-basis: 100%; margin-top: 8px; padding-top: 9px; border-top: 1px solid var(--border-subtle); }
    .lk-facts-body { display: flex; flex-direction: column; gap: 8px; }
    .lk-facts-img { width: 100%; max-width: 320px; border-radius: 10px; border: 1px solid var(--border-subtle); }
    .lk-facts-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 6px 14px; }
    .lk-fact { display: flex; flex-direction: column; gap: 1px; font-size: 12px; }
    .lk-fact span { color: var(--fg-tertiary); font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; }
    .lk-fact b { color: var(--fg-primary); font-weight: 600; }
    .lk-chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .lk-chip { padding: 2px 9px; border-radius: 999px; font-size: 11px; background: color-mix(in srgb, var(--fg-tertiary) 15%, transparent); color: var(--fg-secondary); }
    /* Texte sur lavis accent : --texte-succes, comme .pl-av--pret et .lk-btn--ok
       ci-dessus — le vert de marque tombe a ~2,8:1 en clair sur ces teintes. */
    .lk-chip--svc { background: color-mix(in srgb, var(--tracky-light) 18%, transparent); color: var(--texte-succes); }
    .lk-chip--fuel { background: color-mix(in srgb, var(--violet) 10%, transparent); color: var(--texte-violet); }
    .lk-facts-src { margin: 0; font-size: 10.5px; color: var(--fg-tertiary); font-style: italic; }
    .lk-facts-empty { margin: 0; font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; }
    .lk-vehicles { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
    .lk-veh { padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--violet) 14%, transparent); color: var(--fg-secondary); font-size: 11px; }
    .lk-veh b { color: var(--fg-primary); font-weight: 700; }
    .lk-kind { padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; background: color-mix(in srgb, var(--fg-tertiary) 16%, transparent); color: var(--fg-secondary); flex-shrink: 0; }
    .lk-kind[data-k='FUEL_STATION'] { background: color-mix(in srgb, var(--violet) 10%, transparent); color: var(--texte-violet); }
    .lk-kind[data-k='PARKING'] { background: color-mix(in srgb, #0ea5e9 22%, transparent); color: #0ea5e9; }
    .lk-kind[data-k='DEPOT'] { background: color-mix(in srgb, var(--tracky-light) 22%, transparent); color: var(--texte-succes); }
    .lk-badge { padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; }
    .lk-badge--ok { background: color-mix(in srgb, var(--tracky-light) 20%, transparent); color: var(--texte-succes); }
    .lk-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 9px; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-secondary); font-size: 11.5px; font-weight: 600; cursor: pointer; }
    .lk-btn:disabled { opacity: .5; cursor: wait; }
    /* Le libelle prend --texte-succes (3,24:1 avec le vert de marque) ; la BORDURE
       garde --tracky-light, ce n'est pas du texte. Meme partage que .tab.active. */
    .lk-btn--ok { border-color: color-mix(in srgb, var(--tracky-light) 45%, var(--border-strong)); color: var(--texte-succes); }
    .lk-btn--danger { border-color: color-mix(in srgb, var(--danger) 40%, var(--border-strong)); color: var(--texte-alerte); }
    /* Analyse IA — teinte violette, la même que les autres surfaces IA de l'app. */
    .lk-btn--ai { border-color: color-mix(in srgb, var(--violet) 45%, var(--border-strong)); color: var(--texte-violet); }
    .lk-ai { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; padding: 10px 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--violet) 22%, var(--border-subtle)); background: color-mix(in srgb, var(--violet) 6%, transparent); }
    .lk-ai-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .lk-ai-title { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 700; color: var(--texte-violet); }
    .lk-ai-summary { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--fg-primary); }
    .lk-ai-list { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--fg-secondary); line-height: 1.45; }
    .lk-ai-reco { display: flex; flex-direction: column; gap: 4px; }
    .lk-ai-reco-label { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
  `],
})
export class PlacesComponent {
  private readonly api = inject(FleetPlacesApiService);
  private readonly zonesApi = inject(GpsDeadZonesApiService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /**
   * Lieu à déplier au chargement — deep-link `?place=` posé par la card de la carte (bouton
   * « Analyser »). Consommé UNE SEULE FOIS : un changement de société ne doit pas le rejouer.
   */
  private pendingFocusPlaceId: string | null = null;

  protected readonly FuelIcon = Fuel;
  protected readonly MapPinIcon = MapPin;
  protected readonly ParkingIcon = ParkingSquare;
  protected readonly CheckIcon = Check;
  protected readonly TrashIcon = Trash2;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly InfoIcon = Info;
  protected readonly SparklesIcon = Sparkles;

  /** Seuil d'arrêt réel (min) — aligné sur la détection serveur. */
  protected readonly minStopMin = 4;

  protected readonly places = signal<FleetPlaceDto[]>([]);
  /** Stations REGROUPÉES (une entrée par lieu, pas une par passage). */
  protected readonly stations = signal<StationGroupDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** Id (lieu ou station) en cours d'écriture — désactive le bouton concerné. */
  protected readonly busyId = signal<string | null>(null);

  /**
   * Faits OSM par lieu (horaires, services, contact…), chargés À LA DEMANDE au dépliage :
   * Overpass est un service communautaire, on ne le sollicite pas pour des lieux non consultés.
   */
  protected readonly factsByPlace = signal<Record<string, PlaceFactsDto | null>>({});
  protected readonly factsLoadingId = signal<string | null>(null);
  protected readonly expandedPlaceId = signal<string | null>(null);

  protected readonly canManage = computed(() => this.perms.can('places_manage'));

  /**
   * ─── Les trois onglets de la planche ──────────────────────────────────────
   *
   * La page empilait deux sections ; la planche les separe en trois onglets
   * (« A valider · Valides · Zones GPS »), chacun avec son compteur.
   *
   * La file d'attente « 8/8 · PRET A VALIDER » est livree depuis le 2026-08-16 :
   * le serveur envoie `seuilPassages` ET `statut`. Le client ne recalcule rien —
   * inventer le « 8 » ici poserait un nombre qui doit rester d'accord avec la
   * regle de detection du serveur, et qui deriverait en silence le jour ou elle
   * bouge.
   */
  protected readonly onglet = signal<OngletPlaces>('valider');

  /**
   * Une station VALIDEE est devenue un lieu de la flotte : elle quitte « a valider ».
   * Sans ce filtre, l'onglet demanderait d'agir sur ce qui est deja fait.
   *
   * Tri par AVANCEMENT : les stations pretes a valider d'abord, puis celles qui
   * approchent. C'est une file d'attente — ce qui est actionnable se lit en premier.
   */
  protected readonly stationsAValider = computed(() => {
    const rang: Record<string, number> = { PRET_A_VALIDER: 0, EN_COURS: 1, A_QUALIFIER: 2 };
    return this.stations()
      .filter((s) => !s.placeId)
      .slice()
      .sort((a, b) =>
        (rang[a.statut ?? 'EN_COURS'] ?? 1) - (rang[b.statut ?? 'EN_COURS'] ?? 1)
        || b.passages - a.passages,
      );
  });

  /** Les stations que le serveur declare prêtes. Sert au bouton « Tout valider ». */
  protected readonly stationsSures = computed(() =>
    this.stationsAValider().filter((s) => s.statut === 'PRET_A_VALIDER'),
  );

  /**
   * L'avancement d'une station, tel que le SERVEUR le voit — ou null si ce backend
   * ne l'envoie pas encore. Dans ce cas l'ecran se tait : mieux vaut ne rien dire
   * que d'afficher « 6/undefined ».
   */
  protected avancement(s: StationGroupDto): { texte: string; libelle: string; classe: string } | null {
    if (!s.statut || s.seuilPassages == null) return null;
    switch (s.statut) {
      case 'PRET_A_VALIDER':
        return { texte: `${s.seuilPassages}/${s.seuilPassages}`, libelle: 'Prêt à valider', classe: 'pl-av--pret' };
      case 'EN_COURS':
        return { texte: `${s.passages}/${s.seuilPassages}`, libelle: 'En cours', classe: 'pl-av--cours' };
      case 'A_QUALIFIER':
        return { texte: `${s.passages}/${s.seuilPassages}`, libelle: 'À qualifier', classe: 'pl-av--qualifier' };
      default:
        return null;
    }
  }

  /** Valide d'un coup les stations que le serveur declare sûres. */
  protected async validerLesSures(): Promise<void> {
    const sures = this.stationsSures();
    if (sures.length === 0) return;
    for (const s of sures) {
      await this.validateStation(s);
    }
  }

  /** Les passages d'un lieu issu d'une station validee (pour ne pas les perdre). */
  protected stationOf(placeId: string): StationGroupDto | undefined {
    return this.stations().find((s) => s.placeId === placeId);
  }

  /**
   * Zones mortes GPS de la flotte — `listForMap` existe deja et couvre toute la
   * flotte : AUCUN changement de contrat d'API n'a ete necessaire.
   */
  protected readonly zonesGps = signal<GpsDeadZoneMapDto[]>([]);

  /**
   * L'etat de l'onglet COURANT. L'ordre compte : une erreur n'est pas un vide et
   * prime sur lui — c'est le defaut trouve six fois ailleurs dans l'app.
   */
  protected readonly etatOnglet = computed<EtatZone>(() => {
    if (this.loading()) return 'chargement';
    if (this.error()) return 'erreur';
    const n = this.onglet() === 'valider' ? this.stationsAValider().length
      : this.onglet() === 'valides' ? this.places().length
      : this.zonesGps().length;
    return n === 0 ? 'vide' : 'rempli';
  });

  /**
   * ─── Analyse IA ───────────────────────────────────────────────────────────
   * `aiEnabled` vient du SERVEUR (clé provider + kill-switch owner + option IA de la société).
   * Deux niveaux distincts, à ne pas confondre :
   *  - `aiVisible` = l'IA est active pour cette société → on affiche la section. Si elle est
   *    coupée, on n'affiche **rien du tout** (pas même une analyse passée) : une fonction non
   *    souscrite ne doit pas être visible.
   *  - `canAnalyze` = le droit de DÉCLENCHER (consomme des tokens). Sans lui on peut lire, pas lancer.
   */
  protected readonly aiEnabled = signal(false);
  protected readonly canAnalyze = computed(() => this.perms.can('places_analyze'));
  protected readonly aiVisible = computed(() => this.aiEnabled());
  protected readonly analysisByPlace = signal<Record<string, PlaceAnalysisDto | null>>({});
  protected readonly analyzingId = signal<string | null>(null);

  constructor() {
    this.pendingFocusPlaceId = this.route.snapshot.queryParamMap.get('place');
    // Recharge au changement de société (sélecteur super-admin).
    effect(() => {
      this.fleetFilter.selectedFleetId();
      void this.load();
    });
  }

  protected reload(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const fleetId = this.fleetFilter.selectedFleetId() ?? undefined;
    try {
      const [places, stations, ai, zones] = await Promise.all([
        firstValueFrom(this.api.list(fleetId)),
        firstValueFrom(this.api.stationGroups({ fleetId, minStopMin: this.minStopMin })),
        // Statut IA : NON bloquant et fail-CLOSED — son échec ne doit ni vider la page, ni faire
        // apparaître une fonction que la société n'a pas.
        firstValueFrom(this.api.aiStatus(fleetId)).catch(() => ({ enabled: false })),
        // Zones mortes GPS : NON bloquant, comme le statut IA. Elles occupent un
        // onglet à part ; leur absence ne doit pas emporter les deux autres, qui
        // sont le cœur de la page. Le repli est un tableau vide ASSUMÉ — l'onglet
        // dira « aucune zone », ce qui est vrai du point de vue de l'écran.
        firstValueFrom(this.zonesApi.listForMap(fleetId)).catch((e) => {
          swallow('places:zones-gps', e);
          return [] as GpsDeadZoneMapDto[];
        }),
      ]);
      this.places.set(places);
      this.stations.set(stations);
      this.aiEnabled.set(ai.enabled);
      this.zonesGps.set(zones);
      // Arrivée depuis la carte : on ouvre directement la fiche du lieu ciblé.
      const focusId = this.pendingFocusPlaceId;
      if (focusId) {
        this.pendingFocusPlaceId = null;
        const target = places.find((p) => p.id === focusId);
        if (target) void this.toggleFacts(target);
      }
    } catch (err) {
      swallow('places:load', err);
      // L'erreur détaillée part déjà au centre d'alerte via l'intercepteur HTTP ; ici on
      // informe l'utilisateur sans laisser la page vide et muette.
      this.error.set('Impossible de charger les lieux clés. Réessayez ou contactez le support.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Valide une station détectée → elle devient un lieu de la flotte (couleur dédiée sur la carte). */
  protected async validateStation(s: StationGroupDto): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(s.stationId);
    try {
      const created = await firstValueFrom(
        this.api.create({
          name: s.label.slice(0, 120),
          kind: 'FUEL_STATION',
          lat: s.lat,
          lng: s.lng,
          stationId: s.stationId,
          fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
        }),
      );
      this.places.update((list) => [...list, created]);
      // La station devient un lieu de la flotte (une seule ligne à mettre à jour : c'est groupé).
      this.stations.update((list) =>
        list.map((x) => (x.stationId === s.stationId ? { ...x, placeId: created.id, placeName: created.name } : x)),
      );
      this.toast.success('Station ajoutée aux lieux de la flotte', created.name);
    } catch (err) {
      swallow('places:validateStation', err);
      this.toast.error("Impossible d'ajouter cette station");
    } finally {
      this.busyId.set(null);
    }
  }

  /** Retire un lieu (dévalide une station, ou efface un parking posé à la main). */
  protected async removePlace(p: FleetPlaceDto): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(p.id);
    try {
      await firstValueFrom(this.api.remove(p.id));
      this.places.update((list) => list.filter((x) => x.id !== p.id));
      if (p.stationId) {
        this.stations.update((list) =>
          list.map((s) => (s.stationId === p.stationId ? { ...s, placeId: null, placeName: null } : s)),
        );
      }
      this.toast.success('Lieu retiré');
    } catch (err) {
      swallow('places:removePlace', err);
      this.toast.error('Impossible de retirer ce lieu');
    } finally {
      this.busyId.set(null);
    }
  }

  /**
   * Déplie/replie les infos d'un lieu. Le chargement OSM est fait UNE SEULE FOIS par lieu et
   * mémorisé (y compris le résultat « rien trouvé ») pour ne pas re-solliciter Overpass.
   */
  protected async toggleFacts(p: FleetPlaceDto): Promise<void> {
    if (this.expandedPlaceId() === p.id) {
      this.expandedPlaceId.set(null);
      return;
    }
    this.expandedPlaceId.set(p.id);
    // Analyse IA DÉJÀ calculée : simple lecture en base, aucun appel moteur, donc gratuite.
    //
    // ⚠️ Chargée MÊME SI l'option est coupée. Elle ne l'était que si `aiVisible()` — donc
    // une analyse existante restait invisible et, pire, l'écran ne pouvait même pas SAVOIR
    // qu'elle existait pour décider de l'afficher. Une lecture gratuite n'a aucune raison
    // d'être conditionnée à une option payante.
    if (!(p.id in this.analysisByPlace())) {
      void firstValueFrom(this.api.analysis(p.id))
        .then((a) => this.analysisByPlace.update((m) => ({ ...m, [p.id]: a })))
        .catch(() => this.analysisByPlace.update((m) => ({ ...m, [p.id]: null })));
    }
    if (p.id in this.factsByPlace()) return; // déjà chargé (même si null)
    this.factsLoadingId.set(p.id);
    try {
      const facts = await firstValueFrom(this.api.facts(p.id));
      this.factsByPlace.update((m) => ({ ...m, [p.id]: facts }));
    } catch (err) {
      swallow('places:toggleFacts', err);
      // Overpass indisponible : on mémorise « rien » pour ne pas boucler, l'UI l'explique.
      this.factsByPlace.update((m) => ({ ...m, [p.id]: null }));
    } finally {
      this.factsLoadingId.set(null);
    }
  }

  /** Faits déjà chargés pour un lieu (undefined = jamais demandé, null = rien trouvé). */
  protected factsOf(id: string): PlaceFactsDto | null | undefined {
    return this.factsByPlace()[id];
  }

  /** Analyse IA déjà chargée (undefined = pas demandée, null = jamais analysé). */
  protected analysisOf(id: string): PlaceAnalysisDto | null | undefined {
    return this.analysisByPlace()[id];
  }

  /**
   * Lance l'analyse IA d'un lieu. Double garde côté client (l'IA doit être active ET l'utilisateur
   * habilité) — le serveur revérifie de toute façon : le client ne fait qu'éviter un appel voué au 503.
   */
  protected async analyzePlace(p: FleetPlaceDto): Promise<void> {
    if (!this.aiVisible() || !this.canAnalyze() || this.analyzingId()) return;
    this.analyzingId.set(p.id);
    try {
      const analysis = await firstValueFrom(this.api.analyze(p.id));
      this.analysisByPlace.update((m) => ({ ...m, [p.id]: analysis }));
      this.toast.success('Analyse terminée', p.name);
    } catch (err) {
      swallow('places:analyzePlace', err);
      // Le détail (503 IA coupée, panne provider…) part déjà au centre d'alerte via l'intercepteur.
      this.toast.error("L'analyse n'a pas abouti", 'Réessayez dans un instant.');
    } finally {
      this.analyzingId.set(null);
    }
  }

  /**
   * Connexion page → carte : ouvre la carte CENTRÉE sur le repère (la carte lit `lat/lng/zoom`
   * depuis l'URL via `restoreFromUrl`), pour passer de la liste au terrain en un clic.
   */
  protected showOnMap(lat: number, lng: number): void {
    void this.router.navigate(['/map'], { queryParams: { lat, lng, zoom: 17 } });
  }

  protected kindLabel(k: FleetPlaceKind): string {
    switch (k) {
      case 'FUEL_STATION': return 'Station';
      case 'PARKING': return 'Parking';
      case 'DEPOT': return 'Dépôt';
      default: return 'Lieu';
    }
  }
}
