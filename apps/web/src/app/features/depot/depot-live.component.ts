import { ChangeDetectionStrategy, Component, computed, effect, inject, OnDestroy, OnInit, signal } from '@angular/core';
import type { DepotMissionDto, DepotPositionUnavailableDto } from '@vizyo/tracky-shared';
import {
  AlertTriangle,
  Download,
  LucideAngularModule,
  Route as RouteIcon,
  Share2,
  Truck,
  WifiOff,
} from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DepotApiService } from './depot-api.service';
import { DepotLiveStore } from './depot-live.store';
import { DepotMapComponent } from './depot-map.component';
import { DepotMissionCardComponent } from './depot-mission-card.component';
import { DepotExportModalComponent } from './modals/depot-export-modal.component';
import { DepotIncidentModalComponent } from './modals/depot-incident-modal.component';
import { DepotOnboardingModalComponent } from './modals/depot-onboarding-modal.component';
import { DepotShareModalComponent } from './modals/depot-share-modal.component';
import { DepotTripModalComponent } from './modals/depot-trip-modal.component';
import { DepotTruckModalComponent } from './modals/depot-truck-modal.component';

/**
 * Espace dépôt (2026-08) — la carte live, écran d'accueil de `/depot` (A3 § 1).
 *
 * Trois zones sur PC : le menu (porté par le shell), le panneau missions à 384 px,
 * la carte. Sur mobile la carte prend tout l'écran et le panneau devient une feuille
 * basse redimensionnable — le pouce atteint la poignée, pas le haut de l'écran.
 *
 * ┌─ L'ENCART QUI NOMME CE QUI EST ABSENT ────────────────────────────────────┐
 * │ « Les 3 autres camions de votre transporteur ne sont pas sur vos missions : │
 * │ ils ne vous sont pas visibles. »                                           │
 * │                                                                            │
 * │ Sans cette phrase, un dépôt qui sait que son transporteur a sept camions    │
 * │ et n'en voit que quatre conclut que l'outil est cassé, et il appelle. Avec  │
 * │ elle, l'absence devient une GARANTIE explicite — c'est exactement           │
 * │ l'argument qui a permis au transporteur d'ouvrir l'accès (A3 § 1).          │
 * │                                                                            │
 * │ ⚠️ Le nombre vient de `otherVehiclesCount`, seul chiffre de tout l'espace   │
 * │ calculé sur la flotte. Exception assumée à la règle 1 d'A3 § 7, tranchée    │
 * │ avec le client le 2026-08-10.                                              │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

type Filtre = '' | 'IN_PROGRESS' | 'PLANNED' | 'DONE';

const FILTRES: Array<{ valeur: Filtre; libelle: string }> = [
  { valeur: 'IN_PROGRESS', libelle: 'En cours' },
  { valeur: 'PLANNED', libelle: 'Planifiées' },
  { valeur: 'DONE', libelle: 'Terminées' },
];

/** Clef de première visite : l'onboarding ne s'affiche qu'une fois (A3 § 5). */
const CLEF_ONBOARDING = 'vizyo-depot-onboarding-vu';

@Component({
  selector: 'app-depot-live',
  standalone: true,
  imports: [
    LucideAngularModule,
    DepotMapComponent,
    DepotMissionCardComponent,
    DepotTripModalComponent,
    DepotTruckModalComponent,
    DepotIncidentModalComponent,
    DepotExportModalComponent,
    DepotOnboardingModalComponent,
    DepotShareModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- La hauteur de la feuille est portée par la RACINE : le FAB et la barre basse
         vivent dans la carte, pas dans le panneau, et doivent tous deux se placer
         au-dessus de lui. Une variable posée sur le panneau seul leur serait invisible. -->
    <div class="dl" [style.--feuille-h.px]="hauteurFeuille()">
      <!-- ═══ PANNEAU MISSIONS (PC) / FEUILLE BASSE (mobile) ═══════════════════ -->
      <aside class="dl-panneau">
        <!-- Poignée : mobile seulement. Géométrie de la plateforme — 36 × 5 sur iOS,
             32 × 4 sur Android. Les composants ne testent pas la plateforme, ils
             consomment les variables (design/B1-PAGES.md). -->
        <button
          type="button"
          class="dl-poignee"
          (pointerdown)="debutGlisse($event)"
          aria-label="Redimensionner le panneau des missions"
        ><span></span></button>

        <header class="dl-entete">
          <div class="dl-entete-txt">
            <h1>Missions du jour</h1>
            <p>{{ dateDuJour() }} · {{ store.depotName() }}</p>
          </div>
          <span class="dl-pastille" [class.dl-pastille--vide]="store.camionsEnMission() === 0">
            <span class="dl-pastille-dot" aria-hidden="true"></span>
            {{ store.camionsEnMission() }} {{ store.camionsEnMission() > 1 ? 'camions' : 'camion' }} en mission
          </span>
        </header>

        <div class="dl-actions">
          <button type="button" class="dl-btn" (click)="ouvrirIncident()">
            <lucide-icon [img]="AlertTriangle" [size]="15" aria-hidden="true" />Signaler
          </button>
          <button type="button" class="dl-btn" (click)="exportOuvert.set(true)">
            <lucide-icon [img]="Download" [size]="15" aria-hidden="true" />Exporter
          </button>
          <button type="button" class="dl-btn dl-btn--accent" (click)="partager()">
            <lucide-icon [img]="Share2" [size]="15" aria-hidden="true" />Partager un suivi
          </button>
        </div>

        <div class="dl-filtres" role="group" aria-label="Filtrer les missions">
          <button type="button" class="dl-chip" [class.dl-chip--actif]="filtre() === ''" (click)="filtre.set('')">
            Toutes
          </button>
          @for (f of filtres; track f.valeur) {
            <button
              type="button"
              class="dl-chip"
              [class.dl-chip--actif]="filtre() === f.valeur"
              (click)="filtre.set(f.valeur)"
            >{{ f.libelle }}</button>
          }
        </div>

        <div class="dl-liste">
          @if (store.chargement()) {
            @for (i of [1, 2, 3]; track i) { <div class="sk dl-sk"></div> }
          } @else if (missionsFiltrees().length === 0) {
            <!-- L'état vide N'EST PAS une carte muette : il dit ce qui se passera. -->
            <div class="dl-vide">
              <span class="vt-icon-tile dl-vide-ico"><lucide-icon [img]="RouteIcon" [size]="22" /></span>
              <p class="dl-vide-titre">
                @if (filtre()) { Aucune mission pour ce filtre } @else { Aucune mission en cours }
              </p>
              <p class="dl-vide-txt">
                @if (filtre()) {
                  Changez de filtre pour voir vos autres missions.
                } @else {
                  {{ store.carrierName() }} vous assignera des missions depuis son espace.
                  Vous recevrez un e-mail à chaque nouvelle mission.
                }
              </p>
              @if (!filtre()) {
                <button type="button" class="dl-vide-lien" (click)="onboardingOuvert.set(true)">
                  Comment ça marche
                </button>
              }
            </div>
          } @else {
            @for (m of missionsFiltrees(); track m.id) {
              <app-depot-mission-card
                [mission]="m"
                [selectionnee]="selection() === m.id"
                [distanceRestanteKm]="selection() === m.id ? distanceRestante() : null"
                (choisir)="selectionner($event.id)"
                (appeler)="appeler($event)"
              />
              @if (indisponibiliteDe(m.id); as indispo) {
                <!-- Jamais une position périmée présentée comme actuelle (A3 § 6).
                     « Suivi suspendu » ne dit PAS pourquoi : la raison est le mode vie
                     privée du conducteur, et elle ne regarde pas le dépôt. -->
                <p class="dl-indispo">
                  @if (indispo.reason === 'SUSPENDED') {
                    Suivi suspendu
                  } @else if (indispo.unavailableSince > 0) {
                    Position indisponible depuis {{ indispo.unavailableSince }} min
                  } @else {
                    Position indisponible
                  }
                </p>
              }
            }
          }
        </div>

        <!-- ═══ L'ENCART QUI NOMME CE QUI EST ABSENT ═══════════════════════════ -->
        @if (!store.chargement()) {
          <div class="dl-encart">
            <lucide-icon [img]="Truck" [size]="16" aria-hidden="true" />
            <p>
              @if (store.otherVehiclesCount() > 0) {
                Les <strong>{{ store.otherVehiclesCount() }}</strong> autres camions de
                {{ store.carrierName() }} ne sont pas sur vos missions : ils ne vous sont pas visibles.
              } @else {
                Vous ne voyez que les camions engagés sur vos missions, et seulement pendant leur créneau.
              }
            </p>
          </div>
        }
      </aside>

      <!-- ═══ CARTE ═══════════════════════════════════════════════════════════ -->
      <div class="dl-carte">
        <app-depot-map
          [missions]="store.missions()"
          [positions]="store.positions()"
          [selection]="selection()"
          (choisir)="selectionner($event)"
        />

        <!-- Fraîcheur : un VRAI compteur, jamais un texte figé. -->
        <div class="dl-fraicheur" [class.dl-fraicheur--perdue]="store.connexionPerdue()">
          @if (store.connexionPerdue()) {
            <lucide-icon [img]="WifiOff" [size]="14" aria-hidden="true" />
            Connexion perdue · nouvelle tentative
          } @else {
            <span class="dl-fraicheur-dot" aria-hidden="true"></span>
            Rafraîchie il y a {{ store.secondesDepuisMaj() }} s
          }
        </div>

        <!-- ═══ BARRE BASSE : le camion sélectionné ═════════════════════════ -->
        @if (missionSelectionnee(); as m) {
          <div class="dl-barre">
            <div class="dl-barre-id">
              <span class="dl-barre-plaque">{{ m.vehicle.plate }}</span>
              <span class="dl-barre-ref">{{ m.ref }}</span>
            </div>
            <div class="dl-barre-infos">
              @if (m.driver) { <span>{{ m.driver.displayName }}</span> }
              @if (vitesseSelection() !== null) { <span>{{ vitesseSelection() }} km/h</span> }
              <span [class.dl-barre-retard]="(m.delayMinutes ?? 0) > 0">{{ libelleArrivee(m) }}</span>
            </div>
            <div class="dl-barre-actions">
              <button type="button" class="dl-btn" (click)="camionOuvert.set(true)">Le camion</button>
              <button type="button" class="dl-btn dl-btn--accent" (click)="voirTrajet(m)">Voir le trajet</button>
            </div>
          </div>
        }

        <!-- FAB étendu « Partager » — Android seulement (les 3 boutons système
             occupent déjà le bas, une barre d'onglets de plus serait illisible).
             Remonté à 100 px quand un snackbar est affiché, sinon le toast le
             recouvre au moment précis où l'utilisateur cherche à agir. -->
        <button
          type="button"
          class="dl-fab"
          [class.dl-fab--releve]="unToastEstAffiche()"
          (click)="partager()"
        >
          <lucide-icon [img]="Share2" [size]="18" aria-hidden="true" />Partager
        </button>
      </div>
    </div>

    @if (incidentOuvert()) {
      <app-depot-incident-modal
        [missions]="store.missions()"
        [missionInitiale]="selection()"
        (fermer)="incidentOuvert.set(false)"
      />
    }
    @if (exportOuvert()) { <app-depot-export-modal (fermer)="exportOuvert.set(false)" /> }
    @if (onboardingOuvert()) {
      <app-depot-onboarding-modal
        [carrierName]="store.carrierName()"
        (fermer)="fermerOnboarding()"
      />
    }
    @if (partageOuvert(); as m) {
      <app-depot-share-modal [mission]="m" (fermer)="partageOuvert.set(null)" />
    }
    @if (camionOuvert() && missionSelectionnee(); as m) {
      <app-depot-truck-modal [mission]="m" (fermer)="camionOuvert.set(false)" />
    }
    @if (tripOuvert()) {
      <app-depot-trip-modal
        [missionId]="tripOuvert()"
        (fermer)="tripOuvert.set(null)"
        (signaler)="depuisTrajetVersIncident($event)"
        (partager)="depuisTrajetVersPartage($event)"
      />
    }
  `,
  styles: [`
    :host { display: block; height: 100% }
    .dl { display: flex; height: 100%; min-height: 0 }

    /* --depot-attenue et --depot-alerte sont définis une seule fois, dans styles.css,
       sur .layout--depot : les variables CSS traversent l'encapsulation, il serait
       absurde de les redéclarer dans chacun des dix composants de l'espace. */

    /* ─── Panneau missions — 384 px sur PC (A3 § 1) ────────────────────────── */
    .dl-panneau {
      flex: 0 0 384px; width: 384px; display: flex; flex-direction: column; min-height: 0;
      border-right: 1px solid var(--border-color); background: var(--surface-primary);
    }
    .dl-poignee { display: none }
    .dl-entete { padding: 16px 18px 10px; display: flex; flex-direction: column; gap: 10px }
    .dl-entete-txt h1 {
      margin: 0; font-family: var(--font-display); font-size: 19px; font-weight: 800;
      letter-spacing: -.02em; color: var(--text-primary);
    }
    .dl-entete-txt p { margin: 3px 0 0; font-size: 12.5px; color: var(--depot-attenue) }

    /* Pastille pulsée : vert = un suivi actif, gris = aucun. Une pastille verte
       immobile sur zéro camion promettrait un direct qui n'existe pas. */
    .dl-pastille {
      align-self: flex-start; display: inline-flex; align-items: center; gap: 8px;
      padding: 5px 12px; border-radius: 9999px; font-size: 12.5px; font-weight: 700;
      background: color-mix(in srgb, var(--color-tracky-light) 13%, transparent);
      color: var(--depot-succes);
    }
    .dl-pastille-dot {
      width: 7px; height: 7px; border-radius: 50%; background: currentColor; position: relative;
    }
    .dl-pastille-dot::after {
      content: ''; position: absolute; inset: -4px; border-radius: 50%;
      border: 2px solid currentColor; animation: dl-pulse 2s cubic-bezier(.4, 0, .6, 1) infinite;
    }
    .dl-pastille--vide { background: var(--surface-tertiary); color: var(--depot-attenue) }
    .dl-pastille--vide .dl-pastille-dot::after { animation: none; opacity: .4 }
    @keyframes dl-pulse {
      0% { transform: scale(.8); opacity: .7 }
      70%, 100% { transform: scale(1.9); opacity: 0 }
    }
    @media (prefers-reduced-motion: reduce) { .dl-pastille-dot::after { animation: none; opacity: .4 } }

    .dl-actions { display: flex; gap: 7px; padding: 0 18px 12px; flex-wrap: wrap }
    .dl-btn {
      display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 7px 13px;
      border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-secondary);
      color: var(--text-secondary); font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    }
    .dl-btn:hover { border-color: var(--border-strong-color); color: var(--text-primary) }
    .dl-btn--accent {
      background: var(--color-tracky-light); border-color: transparent; color: var(--accent-ink);
    }
    .dl-btn--accent:hover { color: var(--accent-ink); filter: brightness(1.06) }

    .dl-filtres { display: flex; gap: 7px; padding: 0 18px 12px; overflow-x: auto; scrollbar-width: none }
    .dl-filtres::-webkit-scrollbar { display: none }
    .dl-chip {
      flex: 0 0 auto; min-height: 32px; padding: 6px 14px; border-radius: 9999px;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
      color: var(--depot-attenue); font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    }
    .dl-chip--actif {
      background: color-mix(in srgb, var(--violet) 14%, transparent);
      border-color: color-mix(in srgb, var(--violet) 34%, transparent); color: var(--violet);
    }

    .dl-liste { flex: 1; min-height: 0; overflow-y: auto; padding: 0 18px 12px; display: flex; flex-direction: column; gap: 9px }
    .dl-sk { height: 92px; border-radius: 14px }
    .dl-indispo {
      margin: -4px 0 2px; padding-left: 4px; font-size: 11.5px; color: var(--depot-attente); font-weight: 600;
    }

    .dl-vide { padding: 30px 6px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 9px }
    .dl-vide-ico { width: 46px; height: 46px; border-radius: 14px }
    .dl-vide-titre { margin: 0; font-size: 15px; font-weight: 700; color: var(--text-primary) }
    .dl-vide-txt { margin: 0; font-size: 13px; line-height: 1.6; color: var(--depot-attenue) }
    .dl-vide-lien {
      margin-top: 4px; min-height: 36px; padding: 8px 16px; border-radius: 10px;
      border: 1px solid var(--border-color); background: transparent;
      color: var(--violet); font-family: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer;
    }

    /* L'encart tireté : la bordure en tirets dit « ceci n'est pas une donnée, c'est
       une explication ». Il reste collé en bas du panneau, toujours visible. */
    .dl-encart {
      flex: 0 0 auto; display: flex; align-items: flex-start; gap: 10px;
      margin: 0 18px 16px; padding: 11px 13px; border-radius: 13px;
      border: 1px dashed var(--border-strong-color);
    }
    .dl-encart lucide-icon { flex: 0 0 auto; margin-top: 1px; color: var(--depot-attenue) }
    .dl-encart p { margin: 0; font-size: 12px; line-height: 1.55; color: var(--depot-attenue) }
    .dl-encart strong { color: var(--text-secondary) }

    /* ─── Carte ────────────────────────────────────────────────────────────── */
    .dl-carte { flex: 1; position: relative; min-width: 0 }

    .dl-fraicheur {
      position: absolute; top: 12px; right: 12px; z-index: 3;
      display: inline-flex; align-items: center; gap: 7px;
      padding: 6px 12px; border-radius: 9999px;
      background: color-mix(in srgb, var(--surface-secondary) 92%, transparent);
      border: 1px solid var(--border-color); backdrop-filter: blur(6px);
      font-size: 11.5px; font-weight: 600; color: var(--depot-attenue);
    }
    .dl-fraicheur-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-tracky-light) }
    .dl-fraicheur--perdue { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 40%, transparent) }

    .dl-barre {
      position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 3;
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
      padding: 12px 16px; border-radius: 16px;
      background: color-mix(in srgb, var(--surface-secondary) 95%, transparent);
      border: 1px solid var(--border-color); backdrop-filter: blur(8px);
      box-shadow: 0 8px 28px rgba(0, 0, 0, .18);
    }
    .dl-barre-id { display: flex; flex-direction: column; gap: 2px }
    .dl-barre-plaque { font-family: var(--font-mono); font-size: 14px; font-weight: 800; color: var(--text-primary) }
    .dl-barre-ref { font-family: var(--font-mono); font-size: 11px; color: var(--depot-attenue) }
    .dl-barre-infos { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 12.5px; color: var(--depot-attenue) }
    .dl-barre-retard { color: var(--depot-alerte); font-weight: 700 }
    .dl-barre-actions { margin-left: auto; display: flex; gap: 7px }

    /* FAB Android uniquement. :host-context() est OBLIGATOIRE pour atteindre
       body.plat-android depuis un composant encapsulé : un sélecteur d'ancêtre
       ordinaire serait réécrit en body.plat-android[_ngcontent-xxx] — attribut posé
       sur body, qui ne le porte pas — et la règle échouerait EN SILENCE.
       ⚠️ Aucun accent grave dans ce commentaire : il terminerait le littéral de
       styles (piège payé deux fois sur ce chantier). */
    .dl-fab { display: none }
    :host-context(body.plat-android) .dl-fab {
      display: inline-flex; align-items: center; gap: 8px;
      /* AU-DESSUS de la feuille, pas derrière : posé à 24 px du bas de l'écran il
         disparaissait sous le panneau des missions, c'est-à-dire toujours. Il suit
         donc la hauteur de la feuille, y compris quand on la redimensionne. */
      position: absolute; right: 16px; bottom: calc(var(--feuille-h, 330px) + 16px); z-index: 6;
      min-height: 56px; padding: 0 20px; border-radius: 16px; border: none;
      background: var(--color-tracky-light); color: var(--accent-ink);
      font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .3);
      transition: bottom .2s ease;
    }
    /* Snackbar affiché : le FAB remonte de 100 px au-dessus de sa position habituelle,
       sinon le toast le recouvre au moment précis où l'utilisateur cherche à agir. */
    :host-context(body.plat-android) .dl-fab--releve { bottom: calc(var(--feuille-h, 330px) + 100px) }

    /* ─── Mobile : carte plein écran + feuille basse redimensionnable ──────── */
    @media (max-width: 900px) {
      .dl { position: relative; display: block }
      .dl-carte { position: absolute; inset: 0 }
      .dl-panneau {
        position: absolute; left: 0; right: 0; bottom: 0; z-index: 5;
        width: auto; flex: none;
        height: var(--feuille-h, 330px); max-height: 82%;
        border-right: none; border-top: 1px solid var(--border-color);
        /* Géométrie de plateforme : 22 px sur iOS, 28 px sur Android. */
        border-radius: var(--feuille-rayon) var(--feuille-rayon) 0 0;
        background: var(--surface-secondary);
        box-shadow: 0 -10px 34px rgba(0, 0, 0, .25);
      }
      .dl-poignee {
        display: flex; align-items: center; justify-content: center;
        width: 100%; height: 26px; padding: 0; border: none; background: transparent;
        cursor: grab; touch-action: none; flex: 0 0 auto;
      }
      .dl-poignee span {
        display: block; border-radius: 9999px; background: var(--text-tertiary); opacity: .45;
        /* 36 × 5 sur iOS, 32 × 4 sur Android — écart volontaire. */
        width: var(--feuille-poignee-l); height: var(--feuille-poignee-h);
      }
      .dl-entete { padding: 4px 16px 8px }
      .dl-actions, .dl-filtres { padding-left: 16px; padding-right: 16px }
      .dl-liste { padding-left: 16px; padding-right: 16px }
      .dl-encart { margin: 0 16px 14px }
      .dl-barre { bottom: calc(var(--feuille-h, 330px) + 12px) }
      /* Cibles tactiles ≥ 44 px (critère de recette n° 8). */
      .dl-btn, .dl-chip { min-height: 44px }
    }
  `],
})
export class DepotLiveComponent implements OnInit, OnDestroy {
  protected readonly store = inject(DepotLiveStore);
  private readonly api = inject(DepotApiService);
  private readonly toast = inject(ToastService);

  protected readonly filtres = FILTRES;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Download = Download;
  protected readonly Share2 = Share2;
  protected readonly Truck = Truck;
  protected readonly RouteIcon = RouteIcon;
  protected readonly WifiOff = WifiOff;

  protected readonly filtre = signal<Filtre>('');
  protected readonly selection = signal<string | null>(null);
  protected readonly hauteurFeuille = signal(330);

  protected readonly incidentOuvert = signal(false);
  protected readonly exportOuvert = signal(false);
  protected readonly onboardingOuvert = signal(false);
  protected readonly camionOuvert = signal(false);
  protected readonly partageOuvert = signal<DepotMissionDto | null>(null);
  protected readonly tripOuvert = signal<string | null>(null);

  protected readonly missionsFiltrees = computed(() => {
    const f = this.filtre();
    const missions = this.store.missions();
    // « En cours » englobe les missions EN RETARD : un dépôt cherche « quels camions
    // roulent », et une mission en retard roule encore. La séparer la ferait
    // disparaître du filtre où on la cherche justement en priorité.
    const retenues = !f
      ? missions
      : f === 'IN_PROGRESS'
        ? missions.filter((m) => m.status === 'IN_PROGRESS' || m.status === 'LATE')
        : missions.filter((m) => m.status === f);
    return [...retenues].sort((a, b) => this.rang(a) - this.rang(b));
  });

  protected readonly missionSelectionnee = computed(
    () => this.store.missions().find((m) => m.id === this.selection()) ?? null,
  );

  protected readonly vitesseSelection = computed(() => {
    const p = this.store.positions().find((x) => x.missionId === this.selection());
    return p?.speedKmh ?? null;
  });

  /** Null quand la destination est une adresse libre : le serveur ne peut alors pas
   *  la calculer, et on n'affiche rien plutôt qu'une estimation injustifiable. */
  protected readonly distanceRestante = computed(
    () => this.store.positions().find((x) => x.missionId === this.selection())?.remainingKm ?? null,
  );

  /** Le FAB Android remonte quand un toast occupe le bas de l'écran. */
  protected readonly unToastEstAffiche = computed(() => this.toast.toasts().length > 0);

  /**
   * La mission sélectionnée vient de se clore : on retire la sélection, sinon la
   * barre basse continuerait d'annoncer une arrivée pour un camion qui n'est plus
   * sur la carte. L'ANNONCE, elle, est faite par le store (cf. `DepotLiveStore`).
   */
  private readonly finDeMissionEffect = effect(() => {
    const fin = this.store.derniereFin();
    if (fin && this.selection() === fin.missionId) this.selection.set(null);
  });

  async ngOnInit(): Promise<void> {
    await this.store.demarrer();
    // Première connexion : l'onboarding s'ouvre une fois, puis se retrouve par
    // « Comment ça marche ». Un tutoriel qui revient à chaque visite se ferme sans
    // être lu, et devient un obstacle plutôt qu'une aide.
    try {
      if (!localStorage.getItem(CLEF_ONBOARDING)) this.onboardingOuvert.set(true);
    } catch {
      /* stockage indisponible (navigation privée) : on n'affiche rien plutôt que
         d'imposer le tutoriel à chaque chargement. */
    }
  }

  ngOnDestroy(): void {
    this.store.arreter();
  }

  protected selectionner(missionId: string): void {
    this.selection.set(this.selection() === missionId ? null : missionId);
  }

  protected indisponibiliteDe(missionId: string): DepotPositionUnavailableDto | null {
    return this.store.indisponibles().get(missionId) ?? null;
  }

  protected dateDuJour(): string {
    return new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  /**
   * L'arrivée estimée, AVEC l'avance ou le retard (A3 § 1).
   *
   * Un dépôt ne se demande pas « à quelle heure » dans l'absolu : il se demande
   * « est-ce que ça tient le créneau que je lui ai donné ». L'écart est donc
   * l'information principale, l'heure n'est que son support.
   */
  protected libelleArrivee(m: DepotMissionDto): string {
    const retard = m.delayMinutes ?? 0;
    const heure = new Date(m.etaAt ?? m.endAt).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    if (m.status === 'DONE') return `Livrée à ${heure}`;
    if (retard > 0) return `Arrivée ${heure} · +${retard} min`;
    return `Arrivée prévue ${heure}`;
  }

  /** Tri : les retards d'abord, puis en cours, puis planifiées, puis terminées. */
  private rang(m: DepotMissionDto): number {
    switch (m.status) {
      case 'LATE':
        return 0;
      case 'IN_PROGRESS':
        return 1;
      case 'PLANNED':
        return 2;
      default:
        return 3;
    }
  }

  protected ouvrirIncident(): void {
    this.incidentOuvert.set(true);
  }

  /** Depuis la modale de trajet : on ferme le trajet et on ouvre le partage. Deux
   *  modales empilees rendraient l'echappement clavier ambigu. */
  protected depuisTrajetVersPartage(missionId: string): void {
    const m = this.store.missions().find((x) => x.id === missionId);
    this.tripOuvert.set(null);
    if (m) this.partageOuvert.set(m);
  }

  protected depuisTrajetVersIncident(missionId: string): void {
    this.tripOuvert.set(null);
    this.selection.set(missionId);
    this.incidentOuvert.set(true);
  }

  protected voirTrajet(m: DepotMissionDto): void {
    // Une mission planifiée n'a pas commencé : il n'y a rien à dérouler, et une modale
    // à zéros se lit comme une panne. On dit quand elle deviendra utile.
    if (m.status === 'PLANNED') {
      this.toast.show({
        kind: 'info',
        title: 'Le suivi n\'a pas encore démarré',
        message: `Le déroulé sera disponible dès le départ du camion, prévu à ${new Date(m.startAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`,
      });
      return;
    }
    this.tripOuvert.set(m.id);
  }

  /**
   * Ouvre la modale de partage (lot A4).
   *
   * Un lien porte UNE mission, jamais « toutes mes livraisons » (A4 § 7, règle 4) :
   * sans sélection, on ne devine pas — on demande laquelle. Le repli prend la première
   * mission de la liste, triée retards en tête, celle qu'on partage le plus souvent.
   */
  protected partager(): void {
    const m = this.missionSelectionnee() ?? this.missionsFiltrees()[0] ?? null;
    if (!m) {
      this.toast.show({
        kind: 'info',
        title: 'Aucune mission à partager',
        message: 'Le lien de suivi porte sur une livraison précise.',
      });
      return;
    }
    if (m.status === 'DONE' || m.status === 'CANCELLED') {
      this.toast.show({
        kind: 'info',
        title: 'Cette livraison est terminée',
        message: 'Un lien de suivi ne se partage que sur une livraison à venir ou en cours.',
      });
      return;
    }
    this.partageOuvert.set(m);
  }

  protected async appeler(m: DepotMissionDto): Promise<void> {
    try {
      const { phone } = await this.api.numeroConducteur(m.id);
      window.location.href = `tel:${phone}`;
    } catch (err) {
      swallow('depot-live:appeler', err);
      this.toast.show({
        kind: 'warning',
        title: 'Appel indisponible',
        message: 'Le contact du conducteur n\'est joignable que pendant le créneau de la mission.',
      });
    }
  }

  protected fermerOnboarding(): void {
    this.onboardingOuvert.set(false);
    try {
      localStorage.setItem(CLEF_ONBOARDING, '1');
    } catch {
      /* sans stockage, l'onboarding ne s'affichera pas du tout : cf. ngOnInit. */
    }
  }

  // ─── Redimensionnement de la feuille (mobile) ──────────────────────────────
  private glisseDepartY = 0;
  private glisseHauteur = 0;

  protected debutGlisse(e: PointerEvent): void {
    this.glisseDepartY = e.clientY;
    this.glisseHauteur = this.hauteurFeuille();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const bouger = (ev: PointerEvent): void => {
      // Vers le haut = plus grand. Bornes : la feuille ne mange jamais toute la
      // carte, et ne se réduit pas à un liseré qu'on ne peut plus rattraper.
      const suivant = this.glisseHauteur + (this.glisseDepartY - ev.clientY);
      this.hauteurFeuille.set(Math.min(Math.max(suivant, 140), window.innerHeight * 0.82));
    };
    const finir = (): void => {
      window.removeEventListener('pointermove', bouger);
      window.removeEventListener('pointerup', finir);
    };
    window.addEventListener('pointermove', bouger);
    window.addEventListener('pointerup', finir);
  }
}
