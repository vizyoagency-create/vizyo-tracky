import { swallow } from '../../core/error/swallow';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { httpFailureMessage } from '../../core/services/http-failure';
import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, HostListener, inject, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VehicleLinkDirective } from '../../shared/directives/vehicle-link.directive';
import { LucideAngularModule, BarChart3, ChevronRight, Route, Clock, Gauge, Play, ChevronDown, Truck, Check, MessageSquare, Pencil, UserRound, Users, Download, Calendar, FileText, Layers, ArrowUp, ArrowDown, ArrowUpDown, FileSpreadsheet, RotateCcw, MousePointerClick, Fuel, AlertTriangle } from 'lucide-angular';
import { CONDUCTEUR_AUCUN, normaliserFiltreConducteur, libelleTypeAlerte, partLibelle } from '@vizyo/tracky-shared';
import type {
  DriverDto,
  TripAnalysisDto,
  TripDailySummaryDto,
  TripDto,
  TripPeriodChartsDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { DriversApiService } from '../../core/services/drivers.service';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { TripAnalysisBadgesComponent } from '../trip-analysis/trip-analysis-badges.component';
import { ReportScheduleCardComponent } from './report-schedule-card.component';
import { PermissionsService } from '../../core/services/permissions.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { ReportsApiService, type FleetStatsReportDto } from '../../core/services/reports.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { TripsApiService } from '../../core/services/trips.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { DriverPickerComponent } from '../../shared/ui/driver-picker/driver-picker.component';
import { TripNoteModalComponent } from '../../shared/ui/trip-note-modal/trip-note-modal.component';
import { DateRangePickerComponent } from '../../shared/ui/date-range-picker/date-range-picker.component';
import { PdfExportModalComponent, type PdfExportRequest } from '../../shared/ui/pdf-export-modal/pdf-export-modal.component';
import { LineBarChartComponent, type LineBarChartData } from '../../shared/ui/charts/line-bar-chart.component';
import { TrackClickDirective } from '../../shared/directives/track-click.directive';
import { GroupBadgeComponent } from '../../shared/ui/group-badge/group-badge.component';
import { HistogramChartComponent } from '../../shared/ui/charts/histogram-chart.component';
import { HeatmapChartComponent } from '../../shared/ui/charts/heatmap-chart.component';
import { TripReplayComponent } from './trip-replay.component';
import { PeriodReplayComponent } from './period-replay.component';
import {
  aggregateKpisFromDaily,
  ecartAvecPeriodePrecedente,
  estJourIso,
  libelleEcartPeriode,
  periodePrecedente,
  type ReportsKpis,
  clampSpeed as clampSpeedFn,
  formatDuration as formatDurationFn,
  kpiToSortColumn,
  max0 as max0Fn,
  normalizeCustomRange,
  todayIsoLocal,
  type SortDirection,
  type TripSortColumn,
} from './reports.utils';

/**
 * Taille d'une page de trajets. Plafonnée à 100 côté API (`trips.service.list`) : au-delà,
 * la valeur serait silencieusement ramenée à 100 et la pagination sauterait des lignes.
 * ~430 Ko par page en production, dont plus de la moitié de polylignes — d'où la
 * pagination plutôt qu'un chargement intégral.
 */
const REPORTS_TRIPS_PAGE_SIZE = 100;

/**
 * Combien de types d'alerte la synthèse de période détaille avant de regrouper.
 *
 * ⚠️ Le reste n'est pas jeté : `alertesAutres()` le compte et l'écran le dit. Une liste
 * tronquée en silence laisserait croire que le total ne se décompose qu'en cinq lignes.
 */
const MAX_TYPES_ALERTE_AFFICHES = 5;

/**
 * ── FILTRE CONDUCTEUR (F13, seconde moitié) ─────────────────────────────────────────────
 *
 * `CONDUCTEUR_AUCUN` (le mot-clé « trajets SANS conducteur ») et `normaliserFiltreConducteur`
 * viennent du CONTRAT PARTAGÉ, pas d'une constante locale : le serveur borne les mêmes deux
 * formes dans `common/driver-scope`, et deux expressions écrites séparément auraient fini par
 * diverger — c'est le côté le plus permissif qui aurait gagné, celui qui laisse passer.
 *
 * Ce mot-clé n'est pas une option secondaire : mesuré en production le 2026-09-05, 1 905
 * trajets sur 1 956 chez « mh cars » n'ont aucun conducteur. C'est cette liste que le
 * gestionnaire doit pouvoir isoler pour la corriger.
 *
 * ⚠️ Les paramètres relus au démarrage sont VALIDÉS, jamais appliqués tels quels — une URL
 * bricolée à la main ne doit pas pouvoir mettre l'écran dans un état qu'aucun clic ne
 * produit. Le serveur refuse déjà le reste ; l'écran ne doit pas pour autant afficher un
 * libellé de filtre pour une valeur qu'il n'obtiendra jamais.
 */

/**
 * L'ordre de départ du tableau — du plus récent au plus ancien.
 *
 * ⚠️ Nommé, parce qu'il sert à DEUX endroits qui doivent rester d'accord : l'état initial du
 * tri, et la définition de « les filtres sont revenus à leur point de départ ». Écrit deux
 * fois, il se serait désaccordé au premier changement d'ordre par défaut, et le bouton
 * « Réinitialiser » se serait mis à mentir dans un sens ou dans l'autre.
 */
/**
 * Combien de jours le graphique d'activité peut montrer avant de devenir illisible.
 *
 * ⚠️ Le plafond n'est pas le problème ; son SILENCE l'était. Une période de six mois n'en
 * affichait que trois, sous un titre qui promettait la période entière.
 */
const MAX_JOURS_GRAPHIQUE = 90;

const TRI_PAR_DEFAUT: { col: TripSortColumn; dir: SortDirection } = { col: 'startedAt', dir: 'desc' };

/** Taille d'un lot d'analyses demandées — aligne sur `MAX_TRIP_IDS_PER_BATCH` côté API. */
const ANALYSES_BATCH_SIZE = 200;

/**
 * Le trajet vient-il de SORTIR du périmètre affiché ?
 *
 * ⚠️ Le filtre conducteur est honoré au CHARGEMENT (le `where` est posé en base) ; rien, côté
 * écran, ne réévalue l'appartenance d'une ligne après une MUTATION — `sortedTrips` est
 * l'identité, et c'est voulu (un re-filtrage client réintroduirait le mensonge qu'on vient
 * d'enlever). C'est donc au geste qui mute de le dire.
 *
 * Fonction de module, exportée, sans dépendance à l'écran : c'est LA règle qui décide si une
 * ligne peut rester affichée, et elle doit pouvoir être éprouvée seule — le défaut d'origine
 * était précisément qu'aucun test ne pouvait l'atteindre.
 *
 * @param filtre        `selectedDriverId()` — '' (aucun filtre), `none`, ou un identifiant.
 * @param conducteurApres L'identifiant du conducteur du trajet APRÈS l'affectation, ou `null`.
 */
export function trajetHorsPerimetreConducteur(
  filtre: string,
  conducteurApres: string | null,
): boolean {
  if (!filtre) return false;
  // « Sans conducteur » : le trajet sort dès qu'il en gagne un — c'est le cas d'usage même du
  // filtre, la correction en masse des 1 905 trajets orphelins.
  if (filtre === CONDUCTEUR_AUCUN) return conducteurApres !== null;
  // Filtre nominatif : le trajet sort si on lui retire son conducteur (symétrique, et tout
  // aussi visible : la ligne resterait dans la liste de cette personne avec un bouton
  // « Assigner » à la place du nom) ou si on le donne à quelqu'un d'autre.
  return conducteurApres !== filtre;
}

@Component({
  selector: 'app-reports',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    VehicleLinkDirective,
    LucideAngularModule,
    TrackClickDirective,
    GroupBadgeComponent,
    DatePipe,
    DecimalPipe,
    TripAnalysisBadgesComponent,
    ReportScheduleCardComponent,
    TripReplayComponent,
    TripNoteModalComponent,
    DriverPickerComponent,
    DateRangePickerComponent,
    LineBarChartComponent,
    HistogramChartComponent,
    HeatmapChartComponent,
    PeriodReplayComponent,
    PdfExportModalComponent,
    ConfirmModalComponent,
  ],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <span class="vt-eyebrow">Analyse</span>
          <h1 class="text-2xl font-display font-bold text-fg-primary mt-2">Rapports d'activité</h1>
          <!-- ══ CE QUE SEULE L'IMPRESSION VOIT ═══════════════════════════════════════
               À l'écran, la période et le périmètre se lisent sur les pastilles et les
               menus — que l'impression masque, parce qu'un menu déroulant sur papier ne
               veut rien dire. Sans cette ligne, la feuille sortie de Ctrl+P ne portait NI
               la société, NI les dates, NI le véhicule : un document qu'on ne peut ni
               classer ni opposer à qui que ce soit. -->
          <p class="rep-print-entete">
            {{ enTeteImpression() }}
          </p>
        </div>
      </div>

      <!-- Barre de filtres — MOBILE D'ABORD. Trois groupes réels dans le DOM (sélecteurs,
           périodes, actions) ; en large ils sont « display: contents » et la barre reste la
           ligne fluide d'origine. Sous 640 px : sélecteurs en pleine largeur, périodes en
           rangée défilante au pouce, actions en dernière ligne — au lieu de onze pastilles
           empilées sur quatre lignes. -->
      <div class="rep-filters">
        <div class="rep-selectors">
        <!-- Filtre groupe : restreint la liste de véhicules du sélecteur à un groupe. -->
        @if (groupOptions().length > 0) {
          <div class="rep-dropdown-wrapper">
            <!-- ⚠️ aria-haspopup / aria-expanded : sans eux, un lecteur d'écran annonçait
                 un bouton ordinaire et ne disait jamais que le menu venait de s'ouvrir. -->
            <button type="button" #groupTrigger
                    (click)="groupDropdownOpen.set(!groupDropdownOpen())"
                    class="rep-dropdown-trigger"
                    aria-haspopup="listbox"
                    aria-controls="rep-menu-groupe"
                    [attr.aria-expanded]="groupDropdownOpen()"
                    [class.rep-dropdown-trigger--open]="groupDropdownOpen()">
              <lucide-icon [img]="LayersIcon" [size]="14"></lucide-icon>
              <span class="rep-dropdown-label">{{ selectedGroupLabel() }}</span>
              <lucide-icon [img]="ChevronDown" [size]="14" class="rep-dropdown-chevron"></lucide-icon>
            </button>
            @if (groupDropdownOpen()) {
              <div class="rep-dropdown-backdrop" (click)="fermerMenuGroupe()"></div>
              <div class="rep-dropdown-menu" id="rep-menu-groupe" role="listbox" aria-label="Filtrer par groupe">
                <button type="button"
                        (click)="onSelectGroup('')"
                        class="rep-dropdown-item"
                        role="option"
                        [attr.aria-selected]="!selectedGroupId()"
                        [class.rep-dropdown-item--active]="!selectedGroupId()">
                  <span>Tous les groupes</span>
                  @if (!selectedGroupId()) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                </button>
                <div class="rep-dropdown-divider"></div>
                @for (g of groupOptions(); track g.id) {
                  <button type="button"
                          (click)="onSelectGroup(g.id)"
                          class="rep-dropdown-item"
                          role="option"
                          [attr.aria-selected]="selectedGroupId() === g.id"
                          [class.rep-dropdown-item--active]="selectedGroupId() === g.id">
                    <span class="rep-dropdown-item-content">
                      <app-group-badge [group]="g" />
                    </span>
                    @if (selectedGroupId() === g.id) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                  </button>
                }
              </div>
            }
          </div>
        }
        <!-- Dropdown véhicule custom -->
        <div class="rep-dropdown-wrapper">
          <button type="button" #vehicleTrigger
                  (click)="vehicleDropdownOpen.set(!vehicleDropdownOpen())"
                  [disabled]="vehiclesLoading()"
                  class="rep-dropdown-trigger"
                  aria-haspopup="listbox"
                  aria-controls="rep-menu-vehicule"
                  [attr.aria-expanded]="vehicleDropdownOpen()"
                  [class.rep-dropdown-trigger--open]="vehicleDropdownOpen()">
            <lucide-icon [img]="TruckIcon" [size]="14"></lucide-icon>
            <span class="rep-dropdown-label">
              @if (vehiclesLoading()) { Chargement… } @else { {{ selectedVehicleLabel() }} }
            </span>
            <lucide-icon [img]="ChevronDown" [size]="14" class="rep-dropdown-chevron"></lucide-icon>
          </button>
          @if (vehicleDropdownOpen()) {
            <div class="rep-dropdown-backdrop" (click)="fermerMenuVehicule()"></div>
            <div class="rep-dropdown-menu" id="rep-menu-vehicule" role="listbox" aria-label="Filtrer par véhicule">
              <button type="button"
                      (click)="onSelectVehicle('')"
                      class="rep-dropdown-item"
                      role="option"
                      [attr.aria-selected]="!selectedVehicleId()"
                      [class.rep-dropdown-item--active]="!selectedVehicleId()">
                <span>Tous les véhicules</span>
                @if (!selectedVehicleId()) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
              </button>
              @if (visibleVehicles().length > 0) {
                <div class="rep-dropdown-divider"></div>
              }
              @for (v of visibleVehicles(); track v.id) {
                <button type="button"
                        (click)="onSelectVehicle(v.id)"
                        class="rep-dropdown-item"
                        role="option"
                        [attr.aria-selected]="selectedVehicleId() === v.id"
                        [class.rep-dropdown-item--active]="selectedVehicleId() === v.id">
                  <span class="rep-dropdown-item-content">
                    <span class="rep-dropdown-item-plate">{{ v.plate }}</span>
                    @if (v.brand || v.model) {
                      <span class="rep-dropdown-item-meta">{{ v.brand }} {{ v.model }}</span>
                    }
                    @if (v.group) { <app-group-badge [group]="v.group" /> }
                  </span>
                  @if (selectedVehicleId() === v.id) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                </button>
              }
              @if (!vehiclesLoading() && visibleVehicles().length === 0) {
                <p class="rep-dropdown-vide">
                  @if (vehiclesError()) { Liste indisponible. } @else { Aucun véhicule dans ce périmètre. }
                </p>
              }
            </div>
          }
        </div>

        <!-- ══ FILTRE CONDUCTEUR (F13, seconde moitié) ══════════════════════════════════
             Le récapitulatif répond à « combien a roulé tel conducteur » ; ce menu répond au
             geste suivant : « montre-moi SES trajets ». Il restreint le tableau ET tous les
             agrégats de trajets, sinon l'écran afficherait deux totaux contradictoires.

             Masqué quand la société n'a aucun conducteur : un menu dont la seule option
             utile serait « Sans conducteur » n'aiderait personne à comprendre ce qu'il fait.

             ⚠️ MAIS JAMAIS QUAND UN FILTRE EST POSÉ — « ou conducteurFiltre() ». Relevé en
             revue contradictoire : la liste du menu vient de GET /drivers, qui ne rend que les
             conducteurs ACTIFS, pendant que le bouton « Filtrer » du récapitulatif vient de
             /reports/stats, qui nomme aussi les archivés. Un clic sur la ligne d'un conducteur
             archivé bornait donc tout le rapport — tableau, chiffres, graphiques, exports — à
             une personne, sans laisser à l'écran le moindre contrôle pour l'enlever. Même
             impasse après un 403 sur /drivers, ou sur un lien « ?driver=… » ouvert dans une
             société sans conducteur. « Tous les conducteurs » est écrit HORS de la boucle : le
             menu reste donc utilisable avec zéro option, et retire le filtre par son chemin
             normal, sans emporter la période ni le tri comme le ferait « Réinitialiser ». -->
        @if (driverOptions().length > 0 || conducteurFiltre()) {
          <div class="rep-dropdown-wrapper">
            <button type="button" #driverTrigger
                    (click)="driverDropdownOpen.set(!driverDropdownOpen())"
                    class="rep-dropdown-trigger"
                    aria-haspopup="listbox"
                    aria-controls="rep-menu-conducteur"
                    [attr.aria-expanded]="driverDropdownOpen()"
                    [class.rep-dropdown-trigger--open]="driverDropdownOpen()">
              <lucide-icon [img]="UsersIcon" [size]="14"></lucide-icon>
              <span class="rep-dropdown-label">{{ selectedDriverLabel() }}</span>
              <lucide-icon [img]="ChevronDown" [size]="14" class="rep-dropdown-chevron"></lucide-icon>
            </button>
            @if (driverDropdownOpen()) {
              <div class="rep-dropdown-backdrop" (click)="fermerMenuConducteur()"></div>
              <div class="rep-dropdown-menu" id="rep-menu-conducteur" role="listbox" aria-label="Filtrer par conducteur">
                <button type="button"
                        (click)="onSelectDriver('')"
                        class="rep-dropdown-item"
                        role="option"
                        [attr.aria-selected]="!selectedDriverId()"
                        [class.rep-dropdown-item--active]="!selectedDriverId()">
                  <span>Tous les conducteurs</span>
                  @if (!selectedDriverId()) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                </button>
                <!-- Séparateur CONDITIONNEL : sans conducteur ni ligne hors liste, il se
                     collerait à celui de « Sans conducteur » — deux traits l'un sur l'autre. -->
                @if (conducteurHorsListe() || driverOptions().length > 0) {
                  <div class="rep-dropdown-divider"></div>
                }
                <!-- ⚠️ LA PERSONNE FILTRÉE QUE LA LISTE NE CONTIENT PAS (archivée, ou d'une
                     autre société). Sans cette entrée, AUCUNE option du « listbox » ne portait
                     aria-selected="true" ni de coche pendant que le bouton, lui, annonçait le
                     nom : un lecteur d'écran entendait une liste de sélection sans rien de
                     sélectionné. Le sous-libellé dit POURQUOI elle n'est pas dans la liste —
                     sinon on la cherche, et on la perd en quittant le filtre. -->
                @if (conducteurHorsListe()) {
                  <button type="button"
                          (click)="fermerMenuConducteur()"
                          class="rep-dropdown-item rep-dropdown-item--active"
                          role="option"
                          aria-selected="true">
                    <span class="rep-dropdown-item-content">
                      <span class="rep-vnom">{{ selectedDriverLabel() }}</span>
                      <!-- ⚠️ « absente de la liste » n'est pas « liste absente ». Tant que
                           GET /drivers n'a pas répondu — et après un 403, où il ne répondra
                           jamais —, affirmer « archivé » sur une personne parfaitement active
                           est un motif inventé à partir d'une absence. Même distinction que le
                           menu véhicule juste avant (« Liste indisponible. »). -->
                      <span class="rep-dropdown-item-meta">
                        @if (driversRepondus()) {
                          archivé, ou hors de cette société
                        } @else {
                          liste des conducteurs indisponible
                        }
                      </span>
                    </span>
                    <lucide-icon [img]="Check" [size]="14"></lucide-icon>
                  </button>
                }
                @for (d of driverOptions(); track d.id) {
                  <button type="button"
                          (click)="onSelectDriver(d.id)"
                          class="rep-dropdown-item"
                          role="option"
                          [attr.aria-selected]="selectedDriverId() === d.id"
                          [class.rep-dropdown-item--active]="selectedDriverId() === d.id">
                    <span class="rep-dropdown-item-content">
                      <span class="rep-vnom">{{ d.nom }}</span>
                    </span>
                    @if (selectedDriverId() === d.id) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                  </button>
                }
                <div class="rep-dropdown-divider"></div>
                <!-- ⚠️ L'OPTION QUI SERT VRAIMENT. Chez « mh cars », 1 905 trajets sur 1 956
                     n'ont pas de conducteur : c'est exactement ce que le gestionnaire doit
                     pouvoir isoler pour l'affecter. Séparée des personnes, parce qu'elle ne
                     désigne personne. -->
                <button type="button"
                        (click)="onSelectDriver(CONDUCTEUR_AUCUN)"
                        class="rep-dropdown-item"
                        role="option"
                        [attr.aria-selected]="selectedDriverId() === CONDUCTEUR_AUCUN"
                        [class.rep-dropdown-item--active]="selectedDriverId() === CONDUCTEUR_AUCUN">
                  <span>Sans conducteur</span>
                  @if (selectedDriverId() === CONDUCTEUR_AUCUN) { <lucide-icon [img]="Check" [size]="14"></lucide-icon> }
                </button>
              </div>
            }
          </div>
        }

        </div>

        <div class="rep-periods">
        <!-- periods() et non un tableau figé : une tablette laissée ouverte après
             minuit chargeait « Aujourd'hui » = hier (cf. le signal jourCourant). -->
        @for (p of periods(); track p.label) {
          <button (click)="setPeriod(p.from, p.to); customRangeOpen.set(false)"
                  class="rep-periode px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer"
                  [class]="periodFrom === p.from && periodTo === p.to && !isCustomRange()
                    ? 'bg-tracky/20 text-texte-succes border-tracky/30'
                    : 'bg-bg-tertiary text-fg-tertiary border-border-subtle hover:text-fg-secondary'">
            {{ p.label }}
          </button>
        }

        <!-- Pill personnalise — ouvre un panel avec presets + 2 inputs date -->
        <div class="rep-custom-wrapper">
          <button type="button" #customTrigger
                  (click)="toggleCustomRange()"
                  aria-haspopup="dialog"
                  [attr.aria-expanded]="customRangeOpen()"
                  class="rep-periode px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer inline-flex items-center gap-1.5"
                  [class]="isCustomRange()
                    ? 'bg-tracky/20 text-texte-succes border-tracky/30'
                    : 'bg-bg-tertiary text-fg-tertiary border-border-subtle hover:text-fg-secondary'">
            <lucide-icon [img]="CalendarIcon" [size]="12"></lucide-icon>
            @if (isCustomRange()) { {{ customRangeLabel() }} } @else { Personnalisé }
          </button>
          @if (customRangeOpen()) {
            <div class="rep-custom-backdrop" (click)="fermerPlagePerso()"></div>
            <div class="rep-custom-panel" role="dialog" aria-label="Période personnalisée">
              <div class="rep-custom-presets">
                <p class="rep-custom-section">Raccourcis</p>
                @for (pr of customPresets(); track pr.label) {
                  <button type="button" (click)="applyPreset(pr)"
                          class="rep-custom-preset"
                          [class.rep-custom-preset--active]="periodFrom === pr.from && periodTo === pr.to">
                    {{ pr.label }}
                  </button>
                }
              </div>
              <div class="rep-custom-fields">
                <p class="rep-custom-section">Plage personnalisée</p>
                @if (isDesktop()) {
                  <app-date-range-picker
                    [from]="customFrom()"
                    [to]="customTo()"
                    [max]="todayIso"
                    (fromChange)="customFrom.set($event)"
                    (toChange)="customTo.set($event)"
                  />
                } @else {
                  <!-- ⚠️ PAS de liaison deux-sens ngModel ICI : « customFrom » et « customTo »
                       sont des SIGNALS. Le raccourci se compile en une AFFECTATION a la
                       propriete — il remplace le signal au lieu d'ecrire dedans, et cote
                       lecture il passe la FONCTION au champ au lieu de la chaine. Les deux
                       champs de date etaient donc inertes : on saisissait une plage,
                       applyCustomRange relisait une valeur vide et sortait sans rien faire.
                       La branche du dessus, elle, utilisait deja le bon motif. -->
                  <div class="rep-custom-field">
                    <label>Du</label>
                    <input type="date" [ngModel]="customFrom()" (ngModelChange)="customFrom.set($event)" [max]="customTo()" />
                  </div>
                  <div class="rep-custom-field">
                    <label>Au</label>
                    <input type="date" [ngModel]="customTo()" (ngModelChange)="customTo.set($event)" [min]="customFrom()" [max]="todayIso" />
                  </div>
                }
                @if (customRangeError(); as err) {
                  <p class="rep-custom-error">{{ err }}</p>
                }
                @if (customFrom() && !customTo() && !customRangeError()) {
                  <p class="rep-custom-hint">« Jusqu'à » sera fixé à aujourd'hui.</p>
                }
                <div class="rep-custom-actions">
                  <button type="button" (click)="fermerPlagePerso()" class="rep-custom-cancel">Annuler</button>
                  <button type="button"
                          (click)="applyCustomRange()"
                          [disabled]="!customRangeValid()"
                          class="rep-custom-apply">
                    Appliquer
                  </button>
                </div>
              </div>
            </div>
          }
        </div>

        </div>

        <div class="rep-actions">
        <!-- Replay periode : actif uniquement si un vehicule est selectionne
             ET qu'au moins 1 trip existe sur la periode. Sinon tooltip explicatif. -->
        <button (click)="onOpenPeriodReplay()"
                [disabled]="!canPeriodReplay() || periodReplayLoading()"
                [title]="canPeriodReplay() ? 'Replay de tous les trajets de la période'
                                            : 'Sélectionne un véhicule avec des trajets sur la période'"
                class="rep-periode px-3 py-1.5 text-xs rounded-lg border border-tracky/30
                       bg-tracky/10 text-texte-succes hover:bg-tracky/20
                       transition-colors cursor-pointer disabled:opacity-40
                       inline-flex items-center gap-1.5">
          <lucide-icon [img]="Play" [size]="12"></lucide-icon>
          @if (periodReplayLoading()) { Chargement… } @else { Replay période }
        </button>

        @if (isAdmin()) {
          <!-- ⚠️ Le libellé prend --texte-attente (cf. .rep-recalc-btn) et non
               l'utilitaire text-amber-400 : #FBBF24 sur blanc donne 1,7:1, et 1,2:1 une fois
               l'opacité de l'état désactivé appliquée. L'administrateur ne lisait
               simplement pas le mot « Recalculer » en thème clair. Le lavis et le
               liseré ambre, eux, ne portent pas de texte et restent. -->
          <button (click)="onRecompute()" [disabled]="!selectedVehicleId() || recomputing()"
                  class="rep-recalc-btn rep-periode px-3 py-1.5 text-xs rounded-lg border border-amber-500/30
                         bg-amber-500/10 hover:bg-amber-500/20
                         transition-colors cursor-pointer disabled:opacity-60">
            @if (recomputing()) { Recalcul... } @else { Recalculer }
          </button>
        }

        <!-- Sprint 5 — Réinitialiser : tous groupes / tous véhicules / tous conducteurs /
             7 jours, et le TRI avec. Désactivé quand tout est déjà sur ses valeurs par défaut.
             ⚠️ L'énumération taisait déjà les groupes et le tri, et F13 y a ajouté le conducteur
             sans la toucher : un bouton « Réinitialiser » qui annonce moins qu'il ne fait est le
             défaut que ce fichier dénonce en tête. Formulée sans liste, elle ne se périmera plus
             au prochain filtre ajouté. -->
        <button type="button" (click)="resetFilters()" [disabled]="!filtersDirty()"
                trackClick="rapport-reset-filtres"
                title="Réinitialiser tous les filtres et le tri (période : 7 jours)"
                class="rep-reset-btn">
          <lucide-icon [img]="RotateCcwIcon" [size]="13"></lucide-icon>
          <span>Réinitialiser</span>
        </button>
        </div>
      </div>

      <!-- ══ LES EXPORTS VIENNENT APRÈS LES FILTRES ═══════════════════════════════════
           Ils étaient tout en haut, AVANT le moindre filtre : on proposait d'exporter
           avant que le lecteur ait dit sur quoi. C'est l'ordre inverse du geste — on
           choisit une période, une société, des véhicules, un conducteur, on regarde les
           chiffres, ET ALORS on emporte le document. Relevé par le propriétaire :
           « on ne comprend pas trop ».
           ⚠️ La mention reste COLLÉE aux boutons : c'est elle qui dit ce que les fichiers
                contiendront, et une phrase posée ailleurs ne se lit pas au moment du clic. -->
        <div class="rep-export-colonne">
        <div class="rep-export-group" role="group" aria-label="Exporter le rapport">
          <button type="button" (click)="onExportPdf()" trackClick="rapport-export-pdf" [disabled]="!!exporting() || exportsBloquesSansSociete()" class="rep-export-btn rep-export-btn--pdf">
            <lucide-icon [img]="DownloadIcon" [size]="13"></lucide-icon>
            <span>{{ exporting() === 'pdf' ? 'Export…' : 'PDF' }}</span>
          </button>
          <button type="button" (click)="onExportCsv('trips')" trackClick="rapport-export-trips" [disabled]="!!exporting() || exportsBloquesSansSociete()" class="rep-export-btn">
            <lucide-icon [img]="DownloadIcon" [size]="13"></lucide-icon>
            <span>{{ exporting() === 'csv-trips' ? 'Export…' : 'CSV trajets' }}</span>
          </button>
          <!-- ⚠️ DÉSACTIVÉ SOUS UN FILTRE CONDUCTEUR, ET LA MENTION SOUS LES BOUTONS DIT
               POURQUOI (F13). Une alerte appartient à un VÉHICULE : elle n'a pas de
               conducteur. Ce fichier ne peut donc PAS suivre le filtre — le servir quand
               même rendrait, sous un nom qu'on croit filtré, les alertes de tout le parc.
               Le serveur refuse aussi (400 avec la raison), mais un bouton qu'on clique pour
               découvrir un bandeau rouge n'est pas une réponse : on le dit avant. -->
          <button type="button" (click)="onExportCsv('alerts')" trackClick="rapport-export-alerts"
                  [disabled]="!!exporting() || conducteurFiltre() || exportsBloquesSansSociete()"
                  class="rep-export-btn">
            <lucide-icon [img]="DownloadIcon" [size]="13"></lucide-icon>
            <span>{{ exporting() === 'csv-summary' ? 'Export…' : 'CSV alertes' }}</span>
          </button>
          <!-- Sprint 5 — Export Excel « soigné » PAR VÉHICULE : nécessite un
               véhicule précis (sinon désactivé + hint). -->
          <button type="button" (click)="onExportExcel()" trackClick="rapport-export-excel"
                  [disabled]="!!exporting() || exportsBloquesSansSociete()"
                  [title]="libelleExcel()"
                  class="rep-export-btn rep-export-btn--excel">
            @if (exporting() === 'excel') {
              <span class="rep-export-spin"></span>
            } @else {
              <lucide-icon [img]="FileSpreadsheetIcon" [size]="13"></lucide-icon>
            }
            <span>{{ exporting() === 'excel' ? 'Export…' : 'Excel' }}</span>
          </button>
        </div>
        <!-- ══ CE QUE LES FICHIERS CONTIENDRONT — ET CE QU'ILS NE PEUVENT PAS CONTENIR (F13)
             Le PDF, le CSV trajets et l'Excel suivent désormais le filtre conducteur ; le CSV
             alertes ne le peut pas (une alerte appartient à un véhicule) et son bouton est
             désactivé juste au-dessus. Un bouton grisé sans raison est une impasse : la raison
             est ici, VISIBLE, et non dans un attribut « title » — une infobulle n'existe pas
             au doigt. Cette mention est collée aux boutons : une phrase posée ailleurs sur la
             page ne se lit pas au moment où l'on clique. -->
        @if (noteExportsConducteur(); as note) {
          <p class="rep-export-note" role="note">{{ note }}</p>
        }
        </div>

      <!--
        Panne de la liste des VÉHICULES. Elle échouait en silence : plus une seule plaque
        dans le tableau, plus de filtre par groupe, un sélecteur vide — c'est-à-dire
        l'image exacte d'une flotte sans véhicule. Un 401, un 403 ou un 5xx sur /vehicles
        ressemblait donc à une réponse métier plausible, et personne ne le signalait.
      -->
      @if (vehiclesError(); as err) {
        <div class="rep-bandeau-vehicules" role="status">
          <span>{{ err }} Les plaques et le filtre par véhicule sont indisponibles.</span>
          <button type="button" class="btn-secondary text-xs shrink-0"
                  [disabled]="vehiclesLoading()" (click)="loadVehicles()">Réessayer</button>
        </div>
      }

      <!-- ══ CE QUE LE LECTEUR D'ÉCRAN N'ENTENDAIT PAS ═══════════════════════════════
           Trier une colonne ou charger une page de plus ne produisait AUCUNE annonce : le
           tableau changeait en silence, et la seule façon de savoir ce qui s'était passé
           était de relire toutes les lignes. Une zone aria-live polie le dit en une
           phrase, sans interrompre la lecture en cours. -->
      <p class="sr-only" role="status" aria-live="polite">{{ annonceTableau() }}</p>

      <!-- ══ REPRENDRE LE DERNIER RAPPORT CONSULTÉ (F09) ══════════════════════════════
           Une ligne qu'on peut ignorer. On ne restaure PAS d'office : ouvrir un rapport sur
           une période d'il y a trois semaines parce que c'est la dernière regardée serait une
           surprise, et le lecteur ne verrait pas forcément que les dates ne sont pas celles
           du jour. -->
      @if (vueProposee()) {
        <div class="rep-reprise" role="status">
          <span>Reprendre votre dernier rapport — {{ libelleVueProposee() }} ?</span>
          <span class="rep-reprise-actions">
            <button type="button" class="rep-reprise-oui" (click)="reprendreVue()" trackClick="rapport-reprendre-vue">Reprendre</button>
            <button type="button" class="rep-reprise-non" (click)="vueProposee.set(null)" aria-label="Ignorer la proposition">Ignorer</button>
          </span>
        </div>
      }

      <!-- Sparkline KPI cards : compactes, lecture rapide -->
      <div class="rep-kpi-grid">
        <!-- ══ CHAQUE NOMBRE MÈNE À SES LIGNES (F18) ════════════════════════════════
             Trois cartes sur quatre étaient des impasses : un chiffre, et rien à faire
             avec. Elles ouvrent maintenant la liste, triée sur la grandeur qu'elles
             affichent — la carte Trajets sur la date, faute de colonne « nombre ». -->
        <button type="button" class="rep-kpi-card rep-kpi-card--clickable"
                (click)="onKpiClick('tripCount')" [disabled]="trips().length === 0"
                trackClick="rapport-kpi-trajets"
                title="Voir la liste des trajets (du plus récent au plus ancien)">
          <div class="rep-kpi-head">
            <lucide-icon [img]="Route" [size]="14"></lucide-icon>
            <span>Trajets</span>
            <lucide-icon [img]="MousePointerClickIcon" [size]="12" class="rep-kpi-click-hint"></lucide-icon>
          </div>
          <div class="rep-kpi-body">
            <p class="rep-kpi-value">{{ kpis().tripCount }}</p>
            <!-- ⚠️ La tendance n'est ÉCRITE que si elle a un sens : la période précédente
                 doit être connue et non vide. Un taux calculé depuis zéro impressionne
                 sans rien apprendre, et se lit pourtant comme une mesure. -->
            @if (tendance('tripCount'); as t) {
              <span class="rep-kpi-tendance" [class.rep-kpi-tendance--haut]="t.hausse">{{ t.texte }}</span>
            } @else if (periodePrecedenteVide()) {
              <span class="rep-kpi-tendance rep-kpi-tendance--muet">aucun trajet sur la période précédente</span>
            }
            @if (sparkTripBars().length > 0) {
              <svg class="rep-spark" viewBox="0 0 84 28" preserveAspectRatio="none" aria-hidden="true">
                @for (b of sparkTripBars(); track $index) {
                  <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h"
                        fill="var(--tracky-light)" rx="1.5" />
                }
              </svg>
            }
          </div>
        </button>

        <button type="button" class="rep-kpi-card rep-kpi-card--clickable"
                (click)="onKpiClick('totalDistance')" [disabled]="trips().length === 0"
                trackClick="rapport-kpi-distance"
                title="Voir les trajets les plus longs (trie le tableau par distance)">
          <div class="rep-kpi-head">
            <lucide-icon [img]="BarChart3" [size]="14"></lucide-icon>
            <span>Distance</span>
            <lucide-icon [img]="MousePointerClickIcon" [size]="12" class="rep-kpi-click-hint"></lucide-icon>
          </div>
          <div class="rep-kpi-body">
            <p class="rep-kpi-value">
              {{ (kpis().totalDistance / 1000) | number:'1.1-1' }}
              <span class="rep-kpi-unit">km</span>
            </p>
            <!-- ⚠️ La tendance n'est ÉCRITE que si elle a un sens : la période précédente
                 doit être connue et non vide. Un taux calculé depuis zéro impressionne
                 sans rien apprendre, et se lit pourtant comme une mesure. -->
            @if (tendance('totalDistance'); as t) {
              <span class="rep-kpi-tendance" [class.rep-kpi-tendance--haut]="t.hausse">{{ t.texte }}</span>
            } @else if (periodePrecedenteVide()) {
              <span class="rep-kpi-tendance rep-kpi-tendance--muet">aucun trajet sur la période précédente</span>
            }
            @if (sparkDistancePath()) {
              <svg class="rep-spark" viewBox="0 0 84 28" preserveAspectRatio="none" aria-hidden="true">
                <path [attr.d]="sparkDistanceFillPath()" fill="rgba(16,224,160,0.14)" stroke="none" />
                <path [attr.d]="sparkDistancePath()" fill="none" stroke="var(--tracky-light)"
                      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            }
          </div>
        </button>

        <button type="button" class="rep-kpi-card rep-kpi-card--clickable"
                (click)="onKpiClick('totalDuration')" [disabled]="trips().length === 0"
                trackClick="rapport-kpi-duree"
                title="Voir les trajets les plus longs en durée (trie le tableau)">
          <div class="rep-kpi-head">
            <lucide-icon [img]="Clock" [size]="14"></lucide-icon>
            <span>Durée totale</span>
            <lucide-icon [img]="MousePointerClickIcon" [size]="12" class="rep-kpi-click-hint"></lucide-icon>
          </div>
          <div class="rep-kpi-body">
            <!-- Tronque a 375 px sans attribut title : « 24h18 » se coupait sans que la
                 valeur entiere soit lisible nulle part. -->
            <p class="rep-kpi-value" [title]="formatDuration(kpis().totalDuration)">{{ formatDuration(kpis().totalDuration) }}</p>
            <!-- ⚠️ La tendance n'est ÉCRITE que si elle a un sens : la période précédente
                 doit être connue et non vide. Un taux calculé depuis zéro impressionne
                 sans rien apprendre, et se lit pourtant comme une mesure. -->
            @if (tendance('totalDuration'); as t) {
              <span class="rep-kpi-tendance" [class.rep-kpi-tendance--haut]="t.hausse">{{ t.texte }}</span>
            } @else if (periodePrecedenteVide()) {
              <span class="rep-kpi-tendance rep-kpi-tendance--muet">aucun trajet sur la période précédente</span>
            }
            <span class="rep-kpi-meta">~{{ avgDurationPerActiveDay() }} / jour actif</span>
          </div>
        </button>

        <!-- Sprint 5 — KPI « Vitesse max » CLIQUABLE : trie le tableau par
             vitesse max desc + scrolle + surligne la 1ʳᵉ ligne (le trajet le
             plus rapide). Affordance : curseur, hover, icône de clic. -->
        <button type="button" class="rep-kpi-card rep-kpi-card--clickable"
                (click)="onMaxSpeedKpiClick()"
                [disabled]="trips().length === 0"
                trackClick="rapport-kpi-vitesse-max"
                title="Voir le trajet le plus rapide (trie le tableau)">
          <div class="rep-kpi-head">
            <lucide-icon [img]="Gauge" [size]="14"></lucide-icon>
            <span>Vitesse max</span>
            <lucide-icon [img]="MousePointerClickIcon" [size]="12" class="rep-kpi-click-hint"></lucide-icon>
          </div>
          <div class="rep-kpi-body">
            <p class="rep-kpi-value">
              {{ kpis().maxSpeed | number:'1.0-0' }}
              <span class="rep-kpi-unit">km/h</span>
            </p>
            <span class="rep-kpi-dot" [style.background]="speedDotColor()"
                  [attr.title]="speedDotLabel()" [attr.aria-label]="speedDotLabel()"></span>
          </div>
        </button>
      </div>

      <!-- ══ COÛT ET ALERTES DE LA PÉRIODE ═══════════════════════════════════════════
           Le serveur calculait ces deux blocs depuis toujours ; la page ne les demandait
           pas. Un gestionnaire devait donc GÉNÉRER UN PDF pour lire un chiffre déjà prêt —
           « combien m'a coûté la flotte ce mois-ci ? » est pourtant sa première question.

           ⚠️ Les deux blocs ne s'affichent QUE lorsque l'agrégat de période est là. Les
           déduire des trajets chargés donnerait un coût calculé sur cent trajets sur 391 :
           exactement le défaut qu'on vient de retirer du récapitulatif par véhicule. -->
      @if (!synthesePeriodePossible()) {
        <!-- ⚠️ Une absence INEXPLIQUÉE se lit comme une panne. On dit pourquoi les trois
             cartes manquent, et ce qu'il faut faire pour les obtenir. -->
        <p class="rep-synthese-absente">
          <lucide-icon [img]="LayersIcon" [size]="13"></lucide-icon>
          Coût carburant, parc actif et alertes se calculent société par société.
          Choisissez une société dans le sélecteur en haut de page pour les afficher.
        </p>
      }
      @if (statsPeriode(); as st) {
        <div class="rep-synthese-grid">
          <section class="rep-synthese-card">
            <header class="rep-synthese-head">
              <lucide-icon [img]="FuelIcon" [size]="14"></lucide-icon>
              <h2>Carburant estimé sur la période</h2>
            </header>
            <p class="rep-synthese-valeur">
              {{ st.consumption.estimatedCostEur | number:'1.0-0' }}<span class="rep-synthese-unite">€</span>
            </p>
            <p class="rep-synthese-detail">
              {{ st.consumption.estimatedLiters | number:'1.0-0' }} L estimés, au prix paramétré de
              {{ st.consumption.fuelPriceEurL | number:'1.2-3' }} €/L
              <!-- ⚠️ Le CO₂ ne compte QUE la combustion. L'écrire évite qu'un client reprenne
                   ce chiffre dans un bilan carbone en croyant qu'il couvre le cycle de vie. -->
              · ≈ {{ st.consumption.estimatedCo2Kg | number:'1.0-0' }} kg de CO₂ brûlés.
            </p>
            <!-- ⚠️ Le prix CONSTATÉ en station, quand on l'a capté : c'est la seule façon de
                 savoir si le prix paramétré décrit encore la réalité. -->
            @if (st.consumption.observedPriceEurL !== null) {
              <p class="rep-synthese-detail rep-synthese-detail--fort">
                Au prix réellement constaté en station ({{ st.consumption.observedPriceEurL | number:'1.2-3' }} €/L
                sur {{ st.consumption.observedSampleCount }} passage{{ st.consumption.observedSampleCount > 1 ? 's' : '' }}) :
                {{ st.consumption.estimatedCostAtObservedEur | number:'1.0-0' }} €.
              </p>
            } @else {
              <p class="rep-synthese-detail">
                Aucun prix relevé en station sur la période : le coût ci-dessus repose entièrement
                sur le prix paramétré de la société.
              </p>
            }
            <!-- ══ CE PRIX NE SUIT PAS LE FILTRE CONDUCTEUR, ET L'ÉCRAN LE DIT (F13) ══════
                 Un passage en station est un arrêt du VÉHICULE : la table qui les porte n'a
                 aucun conducteur. Le chiffre est GARDÉ — un prix de station est un fait de
                 marché, et le comparer au prix paramétré reste utile — mais muet sous un nom
                 propre, « 12 passages station » s'attribue tout seul à la personne nommée en
                 haut de page. Seuls les litres valorisés, eux, suivent bien le filtre.
                 Même geste et même phrase que le PDF ; le classeur Excel, qui liste les
                 arrêts un par un, les RETIRE et l'écrit. -->
            @if (noteCarburantConducteur(); as note) {
              <p class="rep-synthese-note" role="note">{{ note }}</p>
            }
            <!-- ══ RALENTI MOTEUR (F12) ══════════════════════════════════════════════
                 Calculé par trajet depuis toujours, agrégé nulle part : personne ne pouvait
                 dire « ce parc a passé onze heures moteur tournant à l'arrêt ce mois-ci »,
                 alors que c'est le gaspillage qu'une simple consigne réduit. -->
            @if (st.consumption.idleSecondsTotal > 0) {
              <p class="rep-synthese-detail rep-synthese-detail--fort">
                Dont {{ formatDuration(st.consumption.idleSecondsTotal) }} moteur tournant à l'arrêt
                ({{ partRalenti() }} % du temps de conduite) — le gaspillage qu'une consigne suffit à réduire.
              </p>
            }
            <p class="rep-synthese-note">
              Estimation : kilomètres parcourus × consommation du véhicule. Ce n'est pas un relevé
              de dépense.
            </p>
          </section>

          <!-- ══ PARC ACTIF ET VÉHICULES IMMOBILES (F11) ═══════════════════════════════
               Le récapitulatif par véhicule ne liste que ceux qui ont ROULÉ : un véhicule
               immobile n'y a aucune ligne, et l'écran ne pouvait donc structurellement pas
               montrer ce qu'un gestionnaire cherche quand il envisage une mutualisation ou
               une restitution. Le serveur les connaissait ; personne ne les demandait. -->
          <section class="rep-synthese-card">
            <header class="rep-synthese-head">
              <lucide-icon [img]="TruckIcon" [size]="14"></lucide-icon>
              <!-- ⚠️ DEUX GESTES, PAS UN — la règle que le PDF s'impose déjà dans renderKpis,
                   « Véhicules conduits / parc » : l'INTITULÉ change, puis les phrases
                   l'expliquent. Sous filtre, le numérateur ne compte que les véhicules que
                   CE filtre a fait rouler, le dénominateur reste le parc entier : laisser
                   « Parc actif sur la période » au-dessus de « 2 / 39 », c'est annoter un
                   piège au lieu de le retirer, et les deux surfaces ne nomment plus la même
                   chose sur les mêmes chiffres. -->
              <h2>{{ conducteurFiltre() ? 'Véhicules conduits / parc' : 'Parc actif sur la période' }}</h2>
            </header>
            <p class="rep-synthese-valeur">
              {{ st.vehicles.activeDuringPeriod }}<span class="rep-synthese-unite">/ {{ st.vehicles.total }}</span>
            </p>
            <p class="rep-synthese-detail">
              {{ tauxUtilisation() }} % du parc a roulé{{ perimetreParc() }} au moins une fois.
            </p>
            <!-- ⚠️ SOUS UN FILTRE CONDUCTEUR, « IMMOBILE » CHANGE DE SENS (F13).
                 Ce compte se déduit des trajets du périmètre : filtré sur une personne, il ne
                 dit plus « n'a pas roulé » mais « n'a pas roulé AVEC elle ». Le chiffre reste
                 vrai, c'est sa lecture qui bouge — et une lecture tacite se prend pour un
                 fait, exactement comme le compteur d'alertes juste au-dessus. -->
            @if (noteParcConducteur(); as note) {
              <p class="rep-synthese-note" role="note">{{ note }}</p>
            }
            <!-- ⚠️ UN PARC QUI RÉTRÉCIT SANS LE DIRE SE LIT COMME UNE PERTE.
                 Les véhicules en mode vie privée sont retirés de TOUT ce rapport, y compris
                 du total : sans cette ligne, un client qui en compte 39 verrait « 5 sur 34 »
                 et chercherait les cinq manquants. C'est son propre réglage, il a le droit
                 de savoir qu'il agit ici. -->
            @if (st.vehicles.hiddenByPrivacy > 0) {
              <p class="rep-synthese-note" role="note">
                {{ st.vehicles.hiddenByPrivacy }} véhicule{{ st.vehicles.hiddenByPrivacy > 1 ? 's sont' : ' est' }} en mode vie privée : {{ st.vehicles.hiddenByPrivacy > 1 ? 'ils ne comptent' : 'il ne compte' }} dans aucun chiffre de ce rapport, pas même dans le parc.
              </p>
            }
            @if (st.vehicles.idleTotal === 0) {
              @if (perimetreParc(); as p) {
                <p class="rep-synthese-detail rep-synthese-detail--fort">Tout le parc a roulé{{ p }} au moins une fois : aucun véhicule immobile.</p>
              } @else {
                <p class="rep-synthese-detail rep-synthese-detail--fort">Aucun véhicule immobile : tout le parc a servi.</p>
              }
            } @else {
              <!-- ⚠️ CETTE PHRASE INTRODUIT DES PLAQUES NOMMÉES, et c'est la donnée sur
                   laquelle se décide une mutualisation ou une restitution : sous filtre, ces
                   véhicules ONT roulé, simplement pas avec cette personne. Non qualifiée,
                   elle les désigne comme dormants. -->
              <p class="rep-synthese-detail rep-synthese-detail--fort">
                {{ st.vehicles.idleTotal }} véhicule{{ st.vehicles.idleTotal > 1 ? 's n’ont' : ' n’a' }} fait aucun trajet{{ perimetreParc() }} :
              </p>
              <ul class="rep-parc-liste">
                @for (v of st.vehicles.idleVehicles; track v.vehicleId) {
                  <li>
                    <a [vehicleLink]="v.vehicleId">{{ v.plate }}</a>
                    @if (v.group) { <span class="rep-parc-groupe">{{ v.group.name }}</span> }
                    <!-- ⚠️ Les deux situations ne se traitent pas pareil : un véhicule qui
                         n'a pas servi se mutualise, un boîtier muet se répare. Les confondre
                         ferait rendre un véhicule qui roule peut-être très bien. -->
                    @if (v.silencieux) { <b class="rep-parc-muet">boîtier muet</b> }
                  </li>
                }
              </ul>
              @if (st.vehicles.idleTotal > st.vehicles.idleVehicles.length) {
                <p class="rep-synthese-detail">
                  et {{ st.vehicles.idleTotal - st.vehicles.idleVehicles.length }} autre{{ st.vehicles.idleTotal - st.vehicles.idleVehicles.length > 1 ? 's' : '' }}, non listé{{ st.vehicles.idleTotal - st.vehicles.idleVehicles.length > 1 ? 's' : '' }} ici.
                </p>
              }
            }
          </section>

          <section class="rep-synthese-card">
            <header class="rep-synthese-head">
              <lucide-icon [img]="AlertTriangleIcon" [size]="14"></lucide-icon>
              <h2>Alertes de la période</h2>
            </header>
            @if (st.alerts.total === 0) {
              <p class="rep-synthese-valeur rep-synthese-valeur--calme">0</p>
              <p class="rep-synthese-detail">Aucune alerte sur la période et le périmètre affichés.</p>
            } @else {
              <p class="rep-synthese-valeur">{{ st.alerts.total }}</p>
              <ul class="rep-synthese-liste">
                @for (a of alertesParType(); track a.type) {
                  <li><span>{{ a.libelle }}</span><b>{{ a.count }}</b></li>
                }
              </ul>
              @if (alertesAutres() > 0) {
                <p class="rep-synthese-detail">et {{ alertesAutres() }} d'autres types.</p>
              }
            }
            <!-- ══ L'EXCEPTION DU FILTRE CONDUCTEUR, DITE À VOIX HAUTE (F13) ═════════════
                 Une alerte appartient à un VÉHICULE : elle n'a pas de conducteur, et la
                 rattacher à quelqu'un demanderait de deviner qui conduisait à son heure.
                 Ce compte reste donc calculé sur le périmètre véhicule. Sans cette phrase,
                 une carte muette sous un filtre conducteur laisserait croire que cette
                 personne a déclenché toutes ces alertes — une accusation, pas un chiffre. -->
            @if (noteAlertesConducteur(); as note) {
              <p class="rep-synthese-note" role="note">{{ note }}</p>
            }
          </section>
        </div>
      }

      <!-- Charts : full-width line+bar puis 2 demi-largeur en grid.
           Condition sur l'AGRÉGAT (période entière), pas sur la page de trajets chargée :
           une liste vide (échec, tri) masquait des graphiques qui avaient des données. -->
      @if (!loading() && (kpis().tripCount > 0 || trips().length > 0)) {
        <!-- ══ SECTION REPLIABLE (mobile d'abord) ═══════════════════════════════════════
             Les trois graphiques pèsent 1 134 px, mesurés sur la production à 375 px. Ils
             se REGARDENT, ils ne se lisent pas : les replier au doigt par défaut rend un
             écran et demi sans rien retirer. L'en-tête dit ce qu'il cache, porte
             aria-expanded, et l'impression force l'ouverture. -->
        <button type="button" class="rep-repli" (click)="basculerSection('graphiques')"
                [attr.aria-expanded]="!estRepliee('graphiques')" aria-controls="rep-sec-graphiques"
                trackClick="rapport-replier-graphiques">
          <lucide-icon [img]="ChevronDown" [size]="16" class="rep-repli-chevron"
                       [class.rep-repli-chevron--ferme]="estRepliee('graphiques')"></lucide-icon>
          <span class="rep-repli-titre">Graphiques</span>
          <span class="rep-repli-sous">activité, vitesses, fréquentation</span>
        </button>
        <div class="rep-charts-grid" id="rep-sec-graphiques" [class.rep-sec--repliee]="estRepliee('graphiques')">
          <section class="rep-chart-card rep-chart-card--full">
            <header class="rep-chart-head">
              <h2>Activité</h2>
              @if (joursTronques() > 0) {
                <!-- ⚠️ Le graphique tronquait EN SILENCE au-delà de 90 jours : une période de
                     six mois n'en affichait que les trois derniers, sous un titre qui
                     promettait la période. Les mois manquants passaient pour vides. -->
                <p>Distance &amp; trajets par jour — les {{ maxJoursGraphique }} derniers jours seulement
                  ({{ joursTronques() }} jour{{ joursTronques() > 1 ? 's' : '' }} plus anciens non affichés ; les
                  indicateurs et la synthèse, eux, couvrent toute la période)</p>
              } @else {
                <p>Distance &amp; trajets par jour</p>
              }
            </header>
            <app-line-bar-chart [data]="lineBarData()" [height]="260" />
          </section>

          <!--
            ⚠️ CES DEUX GRAPHIQUES PORTENT SUR UN ECHANTILLON, PAS SUR LA PERIODE.
            Ils se calculent depuis les trajets CHARGES, bornes a 100 par la requete —
            là où les KPI et le graphique d'activité viennent de l'agrégat serveur, complet.

            Ils annonçaient pourtant « Distribution sur la période » et « 24h × 7j ». Sur
            30 jours et 2 738 trajets, la fréquentation ne couvrait en réalité qu'environ
            une journée : elle affichait ZERO trajet le mardi alors que le tableau juste
            au-dessus en comptait 132 le mardi 15 juillet. Deux chiffres contradictoires
            dans la même page, et c'est le plus faux des deux qui avait l'air d'un fait.

            Un graphique incomplet qui le DIT reste utile ; un graphique incomplet qui se
            présente comme exhaustif est pire que pas de graphique du tout.

            ⚠️ Correction de fond à faire : des agrégats serveur dédiés (répartition par
            tranche de vitesse, et par créneau jour × heure), sur le modèle du résumé
            journalier. En attendant, l'échantillon est nommé.
          -->
          <section class="rep-chart-card">
            <header class="rep-chart-head">
              <h2>Vitesses max</h2>
              @if (periodCharts()) {
                <p>Distribution sur la période</p>
              } @else if (tripsTruncated()) {
                <p>Sur les {{ listedTripCount() }} trajets chargés — pas toute la période</p>
              } @else {
                <p>Distribution sur la période</p>
              }
            </header>
            <app-histogram-chart [values]="histoValues()" [height]="220" />
          </section>

          <section class="rep-chart-card">
            <header class="rep-chart-head">
              <h2>Fréquentation</h2>
              @if (periodCharts()) {
                <p>24h × 7j — sur toute la période</p>
              } @else if (tripsTruncated()) {
                <p>Sur les {{ listedTripCount() }} trajets chargés — pas toute la période</p>
              } @else {
                <p>24h × 7j</p>
              }
            </header>
            <app-heatmap-chart [data]="heatmapData()" />
          </section>
        </div>
      }

      <!-- Rapport hebdomadaire par e-mail : réglage par société (admins). Placé avant la
           synthèse : c'est ce que le client règle une fois, pas ce qu'il lit chaque jour. -->
      @if (canSeeSchedule()) {
        <!-- ══ SECTION REPLIABLE — 1 027 px mesurés à 375 px. Ce bloc se RÈGLE une fois puis
             s'oublie ; le laisser déplié entre la synthèse et le récapitulatif imposait un
             écran entier de formulaire à qui vient lire ses trajets. L'en-tête garde
             l'essentiel visible : la prochaine échéance. -->
        <button type="button" class="rep-repli" (click)="basculerSection('hebdo')"
                [attr.aria-expanded]="!estRepliee('hebdo')" aria-controls="rep-sec-hebdo"
                trackClick="rapport-replier-hebdo">
          <lucide-icon [img]="ChevronDown" [size]="16" class="rep-repli-chevron"
                       [class.rep-repli-chevron--ferme]="estRepliee('hebdo')"></lucide-icon>
          <span class="rep-repli-titre">Rapport hebdomadaire par e-mail</span>
          <span class="rep-repli-sous">jour, heure, destinataires et contenu du PDF</span>
        </button>
        <app-report-schedule-card
          id="rep-sec-hebdo"
          [class.rep-sec--repliee]="estRepliee('hebdo')"
          class="rep-sched"
          [fleetId]="fleetFilter.selectedFleetId()"
          [vehicles]="pdfModalVehicles()"
          [editable]="canEditSchedule()"
          [needsFleetChoice]="scheduleNeedsFleetChoice()"
        />
      }

      <!-- Synthèse par véhicule (réf. maquette Rapports) — rollup de la période,
           complémentaire du tableau détaillé par trajet ci-dessous. -->
      @if (!loading() && vehicleSummary().length > 0) {
        <section class="rep-vsum" #recapSection>
          <header class="rep-chart-head rep-vsum-head">
            <h2>{{ vueRecap() === 'attribution' ? 'Par conducteur ou groupe' : 'Par véhicule' }}</h2>
            <!-- Ce rollup agrège les trajets CHARGÉS (cf. vehicleSummary), pas la période
                 entière : tant que le tableau est paginé, il faut le dire, sinon deux
                 totaux différents cohabitent sur le même écran sans explication. -->
            <!-- ⚠️ La phrase disait « cliquez « Voir » pour le détail » alors qu'AUCUN
                 contrôle nommé « Voir » n'existait : la ligne entière était un lien, et
                 le seul indice visible était un chevron gris de 16 px. Sur un téléphone,
                 l'utilisateur cherchait un bouton absent. « Voir › » est désormais écrit
                 en toutes lettres au bout de chaque ligne — la consigne est vraie. -->
            @if (vueRecap() === 'attribution') {
              <!-- ⚠️ Pas de « Voir » ici : une ligne d'imputation n'a pas de fiche à ouvrir. -->
              <p>Synthèse de TOUTE la période — chaque trajet compte pour son conducteur, sinon pour le groupe de son véhicule</p>
            } @else if (!synthesePeriodePossible()) {
              <!-- ⚠️ Ce repli ne DOIT PAS s'annoncer « synthèse de toute la période » : sur
                   « toutes les sociétés », il additionne les trajets chargés, pas la période. -->
              <p>Sur les {{ listedTripCount() }} trajets chargés — la synthèse complète se calcule société par société</p>
            } @else if (recapPartiel() && tripsTruncated()) {
              <p>Sur les {{ listedTripCount() }} trajets chargés sur {{ kpis().tripCount }} — synthèse complète en cours de chargement</p>
            } @else if (recapPartiel()) {
              <p>Sur les {{ listedTripCount() }} trajets chargés — synthèse complète en cours de chargement</p>
            } @else {
              <p>Synthèse de TOUTE la période — « Voir » ouvre la fiche du véhicule</p>
            }
            <!-- ⚠️ EN PLUS des phrases ci-dessus, jamais à leur place : « TOUTE la période »
                 répond à la pagination, celle-ci répond au PÉRIMÈTRE — deux questions
                 différentes, et c'est la seconde qui manquait ici alors que le lot l'écrit
                 déjà pour les alertes, le parc actif et les exports. -->
            @if (noteRecapConducteur(); as note) {
              <p role="note">{{ note }}</p>
            }
          </header>

          <!-- ══ « QUEL VÉHICULE ? » OU « QUI ? » (F13) ═══════════════════════════════════
               La carte répondait à « quel véhicule roule et dépasse ? ». Personne ne pouvait
               répondre à « combien de kilomètres a fait tel conducteur ce mois-ci, avec
               combien d'excès ? », alors que l'écran des scores impute déjà chaque trajet.

               ⚠️ Vrai groupe de boutons : l'état actif est porté par aria-pressed, et doublé
               d'une coche — la teinte seule ne peut pas être la seule information (WCAG 1.4.1). -->
          <div class="rep-vseg" role="group" aria-label="Vue du récapitulatif">
            <button type="button" class="rep-vseg-btn"
                    [attr.aria-pressed]="vueRecap() === 'vehicule'"
                    (click)="setVueRecap('vehicule')"
                    trackClick="rapport-recap-vue-vehicule">
              <lucide-icon [img]="TruckIcon" [size]="14" aria-hidden="true"></lucide-icon>
              Par véhicule
            </button>
            <!-- ⚠️ DÉSACTIVÉ, jamais masqué, quand l'imputation manque : un bouton disparu se
                 lit comme une panne, et une vue vide ferait croire à zéro trajet attribué. -->
            <button type="button" class="rep-vseg-btn"
                    [attr.aria-pressed]="vueRecap() === 'attribution'"
                    [disabled]="!attributionDisponible()"
                    [attr.aria-describedby]="attributionDisponible() ? null : 'rep-vseg-motif'"
                    (click)="setVueRecap('attribution')"
                    trackClick="rapport-recap-vue-attribution">
              <lucide-icon [img]="UsersIcon" [size]="14" aria-hidden="true"></lucide-icon>
              Par conducteur ou groupe
            </button>
          </div>
          @if (motifAttributionIndisponible(); as motif) {
            <p class="rep-vseg-motif" id="rep-vseg-motif">{{ motif }}</p>
          }

          @if (vueRecap() === 'attribution') {
            <div class="rep-vtable">
              <div class="rep-vt-head rep-vt-head--attr">
                <span>Conducteur ou groupe</span>
                <span>Distance</span>
                <span>Conduite</span>
                <span class="rep-vt-hide">Trajets</span>
                <span class="rep-vt-hide">V. moy</span>
                <span class="rep-vexces-h">Excès</span>
                <span></span>
              </div>
              @for (l of attributionSummary(); track l.key) {
                <!-- ⚠️ AUCUN LIEN sur la ligne : il n'existe pas de fiche « conducteur ou
                     groupe » à ouvrir, et un lien mort vaudrait moins que rien.
                     Un bouton « Filtrer » sur les lignes de sorte CONDUCTEUR, en revanche :
                     c'est le geste que ce récapitulatif appelait sans pouvoir l'offrir — il
                     dit combien a roulé telle personne, on veut voir SES trajets (F13).
                     Les lignes de sorte GROUPE n'en ont pas, et ce n'est pas un oubli : il
                     n'existe pas de filtre par groupe d'IMPUTATION. Le filtre groupe de la
                     barre porte sur les VÉHICULES du groupe — donc sur un autre ensemble de
                     trajets que cette ligne, qui n'a que ceux sans conducteur. Un bouton qui
                     poserait ce filtre-là rendrait un total différent de la ligne cliquée. -->
                <div class="rep-vrow rep-vrow--attr">
                  <div class="rep-vveh">
                    <div class="rep-vnom">{{ l.label }}</div>
                    <!-- Le sous-libellé dit d'où vient la ligne : sans lui, « Atelier » et
                         « Amine Berrada » se lisent comme deux personnes. -->
                    <div class="rep-vmodel">{{ l.kind === 'driver' ? 'conducteur' : 'groupe' }}</div>
                  </div>
                  <span class="rep-vdist">{{ (l.distance / 1000) | number:'1.0-0' }} <span class="rep-vunit">km</span></span>
                  <span class="rep-vmeta">{{ formatDuration(l.duration) }}</span>
                  <span class="rep-vmeta rep-vt-hide">{{ l.trips }}</span>
                  <span class="rep-vmeta rep-vt-hide" [class.rep-vspeed-warn]="l.avgSpeed >= 50">
                    @if (l.avgSpeed >= 50) { <span class="sr-only">Vitesse moyenne élevée : </span> }
                    {{ l.avgSpeed }} km/h
                  </span>
                  <!-- Même compte que la vue par véhicule : les excès ÉTABLIS de la règle
                       partagée, jamais le compteur écrit au moment de l'analyse. -->
                  <span class="rep-vexces" [class.rep-vexces--fort]="l.speedingCount > 0">
                    @if (l.speedingCount === 0) {
                      <span class="rep-vexces-vide">0</span>
                    } @else {
                      <span class="sr-only">{{ l.speedingCount }} excès de vitesse établis sur {{ l.speedingTripCount }} trajet(s), pire dépassement {{ l.worstOverKmh }} km/h au-dessus de la limite. </span>
                      <b aria-hidden="true">{{ l.speedingCount }}</b>
                      <small aria-hidden="true">+{{ l.worstOverKmh | number:'1.0-0' }} km/h</small>
                    }
                  </span>
                  @if (l.kind === 'driver' && l.driverId) {
                    <button type="button" class="rep-vfiltre"
                            (click)="filtrerSurConducteur(l.driverId)"
                            trackClick="rapport-recap-filtrer-conducteur"
                            [attr.aria-label]="'Filtrer le rapport sur les trajets de ' + l.label"
                            [title]="'Filtrer tout le rapport sur les trajets de ' + l.label">Filtrer</button>
                  } @else {
                    <span></span>
                  }
                </div>
              }
              @if (attributionSummary().length === 0) {
                <div class="rep-vrow rep-vrow--vide">
                  <!-- ⚠️ « de la période » serait FAUX sous filtre conducteur : la vue vient
                       d'écarter tous les autres conducteurs par construction, donc affirmer que
                       la période n'impute rien à personne est une affirmation, pas une lacune
                       d'explication. -->
                  @if (conducteurFiltre()) {
                    Aucun trajet de ce périmètre n'est imputé à un conducteur ni à un groupe.
                  } @else {
                    Aucun trajet de la période n'est imputé à un conducteur ni à un groupe.
                  }
                </div>
              }
            </div>
            <!-- La troncature se dit : sans cette ligne, un parc de quarante conducteurs
                 semblerait n'en compter que dix. -->
            @if (attributionTotal() > attributionSummary().length) {
              <p class="rep-vseg-motif">
                {{ attributionSummary().length }} ligne{{ attributionSummary().length > 1 ? 's' : '' }} affichée{{ attributionSummary().length > 1 ? 's' : '' }}
                sur {{ attributionTotal() }} — les plus gros rouleurs d'abord.
              </p>
            }
            <!-- ══ CE QUI N'EST IMPUTÉ À PERSONNE ═══════════════════════════════════════
                 Même mention que l'écran des scores, au mot près : ces trajets sont COMPTÉS
                 et ne peuvent être portés au crédit ni au débit de quiconque. Mesuré le
                 2026-09-05 : chez mh cars, 1 866 trajets sur 1 886 sont dans ce cas — les
                 taire ferait lire une image complète là où presque rien n'est imputé. -->
            @if (nonAttribues(); as na) {
              @if (na.tripCount > 0) {
                <div class="rep-vnon-attribue" role="status">
                  <lucide-icon [img]="AlertTriangleIcon" [size]="14"></lucide-icon>
                  <div>
                    <strong>{{ na.tripCount | number }} trajet{{ na.tripCount > 1 ? 's' : '' }}</strong>
                    sur {{ totalTrajetsPeriode() | number }}{{ libelleDenominateurTrajets() }} ({{ partLibelle(na.tripCount, totalTrajetsPeriode()) }},
                    {{ na.distanceKm | number:'1.0-0' }} km) n'{{ na.tripCount > 1 ? 'ont' : 'a' }} <strong>ni conducteur, ni groupe</strong> :
                    {{ na.tripCount > 1 ? 'ils ne peuvent être attribués' : 'il ne peut être attribué' }} à personne.
                    <a routerLink="/vehicles">Renseignez un conducteur ou un groupe</a> sur ces véhicules
                    pour que leurs kilomètres comptent pour quelqu'un.
                  </div>
                </div>
              }
            }
          } @else {
            <div class="rep-vtable">
              <div class="rep-vt-head">
                <span>Véhicule</span>
                <span>Distance</span>
                <span>Conduite</span>
                <span class="rep-vt-hide">Trajets</span>
                <span class="rep-vt-hide">V. moy</span>
                <span class="rep-vexces-h">Excès</span>
                <span></span>
                <span></span>
              </div>
              @for (v of vehicleSummary(); track v.vehicleId) {
                <!-- Le nom accessible du lien était la concaténation « AB-123-CD Renault Clio
                     152 km 3h12 », sans verbe, et l'attribut title ne servait qu'à la souris. -->
                <div class="rep-vrow" [vehicleLink]="v.vehicleId"
                     [attr.aria-label]="'Voir la fiche du véhicule ' + (vehiclePlate(v.vehicleId) || 'sans plaque')">
                  <div class="rep-vveh">
                    <div class="rep-vplate">{{ vehiclePlate(v.vehicleId) || '—' }}</div>
                    <div class="rep-vmodel">{{ vehicleModelLabel(v.vehicleId) }}</div>
                  </div>
                  <span class="rep-vdist">{{ (v.distance / 1000) | number:'1.0-0' }} <span class="rep-vunit">km</span></span>
                  <span class="rep-vmeta">{{ formatDuration(v.duration) }}</span>
                  <span class="rep-vmeta rep-vt-hide">{{ v.trips }}</span>
                  <!-- Le glyphe ▲ double la couleur : l'alerte « vitesse moyenne élevée » ne
                       doit pas reposer sur la seule teinte (WCAG 1.4.1). Le mot, lui, est
                       dit au lecteur d'écran — un aria-label sur un span générique n'est pas
                       restitué de façon fiable, une mention masquée l'est. -->
                  <span class="rep-vmeta rep-vt-hide" [class.rep-vspeed-warn]="v.avgSpeed >= 50">
                    @if (v.avgSpeed >= 50) { <span class="sr-only">Vitesse moyenne élevée : </span> }
                    {{ v.avgSpeed }} km/h
                  </span>
                  <!-- EXCÈS DE LA PÉRIODE (F06) ═══════════════════════════════════════════
                       « Quel véhicule dépasse le plus ? » n'avait aucune réponse sur cet écran :
                       il fallait ouvrir les trajets un par un. Le compte appliqué ici est celui
                       de la règle partagée, pas le compteur d'analyse — 4 036 analyses de
                       production ne portent que des segments de durée nulle, et les compter
                       accuserait des véhicules de ce que le rapport disciplinaire refuse
                       d'affirmer.

                       ⚠️ La valeur nulle signifie qu'on ne SAIT pas encore (repli client, agrégat
                       non arrivé) et s'affiche « — », jamais « 0 ». Un zéro inventé sur une
                       colonne d'excès innocente un véhicule sans l'avoir regardé. -->
                  <span class="rep-vexces" [class.rep-vexces--fort]="(v.speedingCount ?? 0) > 0">
                    @if (v.speedingCount === null) {
                      <span class="rep-vexces-vide" title="Synthèse de période en cours de chargement">—</span>
                    } @else if (v.speedingCount === 0) {
                      <span class="rep-vexces-vide">0</span>
                    } @else {
                      <span class="sr-only">{{ v.speedingCount }} excès de vitesse établis sur {{ v.speedingTripCount }} trajet(s), pire dépassement {{ v.worstOverKmh }} km/h au-dessus de la limite. </span>
                      <b aria-hidden="true">{{ v.speedingCount }}</b>
                      <small aria-hidden="true">+{{ v.worstOverKmh | number:'1.0-0' }} km/h</small>
                    }
                  </span>
                  <!-- ⚠️ Bouton À PART, qui arrête la propagation : la ligne entière est un lien
                       vers la fiche véhicule. Sans cela, filtrer la page quitterait la page —
                       et c'est exactement ce que ce récapitulatif ne permettait pas d'éviter :
                       regarder un véhicule de plus près obligeait à sortir du rapport. -->
                  <button type="button" class="rep-vfiltre"
                          (click)="$event.preventDefault(); $event.stopPropagation(); filtrerSurVehicule(v.vehicleId)"
                          trackClick="rapport-recap-filtrer"
                          [attr.aria-label]="'Filtrer le rapport sur le véhicule ' + (vehiclePlate(v.vehicleId) || 'sans plaque')"
                          title="Filtrer tout le rapport sur ce véhicule">Filtrer</button>
                  <span class="rep-vgo">Voir <lucide-icon [img]="ChevronRightIcon" [size]="14" class="rep-vchev" aria-hidden="true"></lucide-icon></span>
                </div>
              }
            </div>
          }
        </section>
      }

      @if (loadError() && trips().length > 0) {
        <!--
          Panne PARTIELLE : une des deux requetes a echoue, l'autre a repondu. On montre ce
          qu'on a, en disant clairement que la vue est incomplete — plutot que de laisser
          croire a des chiffres complets, ou de tout cacher.
        -->
        <div class="flex items-center justify-between gap-3 mb-3 px-4 py-2 rounded-[--radius-card]
                    bg-bg-secondary border border-amber-500/40 text-fg-secondary text-sm">
          <span>{{ loadError() }} Les données affichées sont incomplètes.</span>
          <button type="button" class="btn-secondary text-xs shrink-0" (click)="loadData()">Réessayer</button>
        </div>
      }

      @if (loading()) {
        <div class="flex items-center justify-center h-32">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (loadError() && trips().length === 0) {
        <!--
          ⚠️ AVANT l'etat vide, sinon invisible : en panne la liste est vide, donc la
          branche du dessous l'avalerait et l'ecran rejouerait « Aucun trajet ».

          ⚠️ ET conditionne a une liste VIDE : les deux appels (trajets / resume journalier)
          echouent independamment. Si seul le resume tombe, les trajets sont bien la — les
          masquer derriere un ecran de panne serait une seconde perte de donnees. Ce cas-la
          est signale par le bandeau ci-dessus, au-dessus du tableau.
        -->
        <div class="flex flex-col items-center justify-center gap-3 h-32 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-secondary">
          <span>{{ loadError() }}</span>
          <button type="button" class="btn-secondary text-xs" (click)="loadData()">Réessayer</button>
        </div>
      } @else if (trips().length === 0) {
        <div class="flex items-center justify-center h-32 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary">
          Aucun trajet pour cette période
        </div>
      } @else {
        @if (tripsTruncated()) {
          <!--
            Le tableau se charge par pages alors que les KPI couvrent toute la periode.
            Le dire est le minimum : un utilisateur qui compte les lignes et tombe sur un
            autre chiffre que le compteur cesse de croire la page entiere. Depuis que
            « Charger plus » existe, la phrase indique aussi comment atteindre le reste —
            avant, elle constatait un manque sans offrir d'issue.
          -->
          <p class="text-xs text-fg-tertiary mb-2">
            {{ listedTripCount() }} trajets affichés sur {{ kpis().tripCount }} —
            « Charger plus » sous le tableau pour la suite.
            Les indicateurs ci-dessus portent bien sur la période complète.
          </p>
        }
        <div #tripsTable class="rep-list" [class.rep-table-wrap--busy]="tripsBusy()" [attr.aria-busy]="tripsBusy() ? 'true' : null">
        @if (isDesktop()) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto rep-table-wrap">
          <table class="w-full text-sm" style="min-width:880px">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-0 text-left">
                  <button type="button" class="rep-th rep-th--left" (click)="onSort('startedAt')">
                    <span>Départ</span>
                    <lucide-icon [img]="sortIcon('startedAt')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('startedAt')"></lucide-icon>
                  </button>
                </th>
                <th class="p-3 text-left">Arrivée</th>
                <th class="p-0 text-right">
                  <button type="button" class="rep-th rep-th--right" (click)="onSort('durationSeconds')">
                    <span>Durée</span>
                    <lucide-icon [img]="sortIcon('durationSeconds')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('durationSeconds')"></lucide-icon>
                  </button>
                </th>
                <th class="p-0 text-right">
                  <button type="button" class="rep-th rep-th--right" (click)="onSort('distanceMeters')">
                    <span>Distance</span>
                    <lucide-icon [img]="sortIcon('distanceMeters')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('distanceMeters')"></lucide-icon>
                  </button>
                </th>
                <th class="p-0 text-right">
                  <button type="button" class="rep-th rep-th--right" (click)="onSort('avgSpeed')">
                    <span>V. moy</span>
                    <lucide-icon [img]="sortIcon('avgSpeed')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('avgSpeed')"></lucide-icon>
                  </button>
                </th>
                <th class="p-0 text-right">
                  <button type="button" class="rep-th rep-th--right" (click)="onSort('maxSpeed')">
                    <span>V. max</span>
                    <lucide-icon [img]="sortIcon('maxSpeed')" [size]="13"
                                 [class.rep-th-arrow--active]="sortIndicator('maxSpeed')"></lucide-icon>
                  </button>
                </th>
                <th class="p-3 text-left">Conducteur</th>
                <th class="p-3 text-left">Note</th>
                <!-- Colonne « Analyse » : plus conditionnée au choix d'un véhicule unique.
                     Les analyses sont désormais chargées par trajet (cf. loadAnalyses), donc
                     elles existent aussi en filtre société / groupe — où la colonne
                     disparaissait purement et simplement. -->
                <th class="p-3 text-left">Analyse</th>
                <th class="p-3 text-center">Replay</th>
              </tr>
            </thead>
            <tbody>
              @for (trip of sortedTrips(); track trip.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50 transition-colors"
                    [class.rep-row--highlight]="highlightTripId() === trip.id">
                  <td class="p-3 text-fg-primary">
                    <div>{{ trip.startedAt | date:'dd/MM HH:mm' }}</div>
                    @if (vehiclePlate(trip.vehicleId); as plate) {
                      <!-- Nom accessible avec un VERBE : « AB-123-CD » seul ne dit pas
                           qu'on peut l'activer, et l'attribut title ne parlait qu'à la souris. -->
                      <div class="text-[10px] font-bold uppercase tracking-wider text-fg-tertiary mt-0.5"
                           [vehicleLink]="trip.vehicleId"
                           [attr.aria-label]="'Voir la fiche du véhicule ' + plate">
                        {{ plate }}
                      </div>
                    }
                    @if (vehicleGroup(trip.vehicleId); as g) {
                      <div class="mt-0.5"><app-group-badge [group]="g" /></div>
                    }
                  </td>
                  <td class="p-3 text-fg-primary">{{ trip.endedAt | date:'dd/MM HH:mm' }}</td>
                  <td class="p-3 text-right font-mono text-fg-secondary">{{ formatDuration(trip.durationSeconds) }}</td>
                  <td class="p-3 text-right font-mono text-fg-secondary">{{ (max0(trip.distanceMeters) / 1000) | number:'1.1-1' }} km</td>
                  <td class="p-3 text-right text-fg-secondary">{{ clampSpeed(trip.avgSpeed) | number:'1.0-0' }}</td>
                  <td class="p-3 text-right text-fg-secondary">{{ clampSpeed(trip.maxSpeed) | number:'1.0-0' }}</td>
                  <td class="p-3 max-w-[180px]">
                    @if (trip.driver) {
                      <button type="button"
                              (click)="canManageDrivers() ? openDriverPickerForTrip(trip) : null"
                              [disabled]="!canManageDrivers()"
                              class="rep-driver"
                              [class.cursor-default]="!canManageDrivers()"
                              [style.--driver-color]="trip.driver.color || '#10E0A0'">
                        <span class="rep-driver-dot"></span>
                        <span class="rep-driver-name">
                          {{ trip.driver.firstName }} {{ trip.driver.lastName }}
                        </span>
                      </button>
                    } @else if (canManageDrivers()) {
                      <button type="button" (click)="openDriverPickerForTrip(trip)"
                              class="rep-driver rep-driver--add">
                        <lucide-icon [img]="UserRoundIcon" [size]="11"></lucide-icon>
                        Assigner
                      </button>
                    } @else {
                      <span class="text-fg-tertiary text-xs">—</span>
                    }
                  </td>
                  <td class="p-3 max-w-[260px]">
                    @if (trip.notes) {
                      <!-- ⚠️ Le texte complet n'existait que dans l'attribut title et le bouton était
                           DÉSACTIVÉ pour un rôle sans droit d'édition : un conducteur ou un
                           lecteur voyait « Livraison chez Dup… » sans aucun moyen d'en lire
                           la suite. Le bouton reste actif en lecture seule et déplie la note
                           sur place. -->
                      <button type="button"
                              (click)="canEditNotes() ? openNoteEdit(trip) : basculerNote(trip.id)"
                              [attr.aria-expanded]="canEditNotes() ? null : noteDepliee() === trip.id"
                              class="rep-note rep-note--filled"
                              [class.rep-note--depliee]="noteDepliee() === trip.id">
                        <lucide-icon [img]="MessageSquareIcon" [size]="12"></lucide-icon>
                        <span class="rep-note-text">{{ trip.notes }}</span>
                        @if (canEditNotes()) {
                          <lucide-icon [img]="PencilIcon" [size]="11" class="rep-note-edit-icon"></lucide-icon>
                        }
                      </button>
                    } @else if (canEditNotes()) {
                      <button type="button" (click)="openNoteEdit(trip)" class="rep-note rep-note--add">
                        <lucide-icon [img]="MessageSquareIcon" [size]="12"></lucide-icon>
                        Ajouter
                      </button>
                    } @else {
                      <span class="text-fg-tertiary text-xs">—</span>
                    }
                  </td>
                  <td class="p-3 max-w-[320px] rep-analysis-cell">
                    <app-trip-analysis-badges
                      [tripId]="trip.id"
                      [analysis]="analysisFor(trip.id)"
                      [tripStartedAt]="trip.startedAt"
                      layout="row"
                      (analyzed)="onAnalyzed($event)"
                    />
                  </td>
                  <td class="p-3 text-center">
                    <div class="flex items-center justify-center gap-1.5">
                      <!-- Toujours proposé : la liste allégée ne porte plus le tracé, il est
                           demandé au clic (cf. openReplay). -->
                      <button (click)="openReplay(trip)" class="rep-ligne-action text-tracky-light hover:underline cursor-pointer" title="Replay">
                        <lucide-icon [img]="Play" [size]="16"></lucide-icon>
                      </button>
                      @if (isAdmin() && trip.maxSpeed > 90) {
                        <button (click)="downloadSpeedReport(trip)"
                                class="text-fg-tertiary hover:text-tracky-light cursor-pointer transition-colors"
                                title="Rapport vitesse">
                          <lucide-icon [img]="FileTextIcon" [size]="14"></lucide-icon>
                        </button>
                      }
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        } @else {
          <!-- MOBILE : une carte par trajet. Le tableau de 880 px imposait un défilement
               horizontal au pouce pour lire une vitesse ; ici tout se lit en une colonne,
               les actions ont 44 px, et le tri passe par un sélecteur puisqu'il n'y a plus
               d'en-têtes. Même source de données, même tri serveur, même surlignage. -->
          <div class="rep-sortbar" role="group" aria-label="Tri des trajets">
            <label class="rep-sortbar-label" for="rep-sort-select">Trier par</label>
            <select id="rep-sort-select" class="rep-sortbar-select"
                    [value]="sortBy()" (change)="setSort($any($event.target).value, sortDir())">
              @for (o of sortOptions; track o.col) {
                <option [value]="o.col" [selected]="sortBy() === o.col">{{ o.label }}</option>
              }
            </select>
            <button type="button" class="rep-sortbar-dir"
                    (click)="setSort(sortBy(), sortDir() === 'desc' ? 'asc' : 'desc')"
                    [title]="sortDir() === 'desc' ? 'Décroissant — passer en croissant' : 'Croissant — passer en décroissant'">
              <lucide-icon [img]="sortDir() === 'desc' ? ArrowDownIcon : ArrowUpIcon" [size]="14"></lucide-icon>
              {{ sortDir() === 'desc' ? 'Décroissant' : 'Croissant' }}
            </button>
          </div>
          <div class="rep-cards">
            @for (trip of sortedTrips(); track trip.id) {
              <article class="rep-card" [class.rep-row--highlight]="highlightTripId() === trip.id">
                <header class="rep-card-head">
                  <div class="rep-card-when">
                    <span class="rep-card-date">{{ trip.startedAt | date:'EEE d MMM' }}</span>
                    <span class="rep-card-times">{{ trip.startedAt | date:'HH:mm' }} → {{ trip.endedAt | date:'HH:mm' }}</span>
                  </div>
                  @if (vehiclePlate(trip.vehicleId); as plate) {
                    <!-- Seule porte vers la fiche véhicule depuis une carte : elle vaut
                         44 px au doigt (cf. .rep-card-plate) et porte un nom avec verbe. -->
                    <span class="rep-card-plate" [vehicleLink]="trip.vehicleId"
                          [attr.aria-label]="'Voir la fiche du véhicule ' + plate">{{ plate }}</span>
                  }
                </header>
                @if (vehicleGroup(trip.vehicleId); as g) {
                  <div class="rep-card-group"><app-group-badge [group]="g" /></div>
                }
                <div class="rep-card-stats">
                  <div class="rep-card-stat">
                    <span class="rep-card-stat-label">Distance</span>
                    <span class="rep-card-stat-value">{{ (max0(trip.distanceMeters) / 1000) | number:'1.1-1' }} <small>km</small></span>
                  </div>
                  <div class="rep-card-stat">
                    <span class="rep-card-stat-label">Durée</span>
                    <span class="rep-card-stat-value">{{ formatDuration(trip.durationSeconds) }}</span>
                  </div>
                  <div class="rep-card-stat">
                    <span class="rep-card-stat-label">V. max</span>
                    <span class="rep-card-stat-value" [class.rep-card-stat-value--warn]="clampSpeed(trip.maxSpeed) > 110">
                      {{ clampSpeed(trip.maxSpeed) | number:'1.0-0' }} <small>km/h</small>
                    </span>
                  </div>
                  <div class="rep-card-stat">
                    <span class="rep-card-stat-label">V. moy</span>
                    <span class="rep-card-stat-value">{{ clampSpeed(trip.avgSpeed) | number:'1.0-0' }} <small>km/h</small></span>
                  </div>
                </div>
                <!-- ══ LE DÉTAIL D'ANALYSE SE REPLIE, CARTE PAR CARTE ═══════════════════
                     Mesuré en production : 453 px par carte, pour 100 cartes — 45 360 px,
                     90 % de la page. Le bloc d'analyse en porte le plus gros, et l'essentiel
                     y tient en une ligne : la note et les excès. Les estimations et l'extrait
                     du récit sont ce qu'on lit sur UN trajet qu'on a choisi, pas sur cent
                     qu'on parcourt.
                     Replié, on garde donc la disposition « row » du tableau — note, excès,
                     faits, et l'action ; déplié, la carte complète revient. La bascule vit
                     dans le PIED, une rangée de 44 px qui existe déjà : le repli ne coûte
                     donc aucune hauteur, il n'en rend que. -->
                <div class="rep-card-analysis">
                  <app-trip-analysis-badges
                    [tripId]="trip.id"
                    [analysis]="analysisFor(trip.id)"
                    [tripStartedAt]="trip.startedAt"
                    [layout]="detailTrajetOuvert(trip.id) ? 'card' : 'row'"
                    (analyzed)="onAnalyzed($event)"
                  />
                </div>
                <footer class="rep-card-foot">
                  <div class="rep-card-foot-left">
                    @if (trip.driver) {
                      <button type="button"
                              (click)="canManageDrivers() ? openDriverPickerForTrip(trip) : null"
                              [disabled]="!canManageDrivers()"
                              class="rep-driver"
                              [class.cursor-default]="!canManageDrivers()"
                              [style.--driver-color]="trip.driver.color || '#10E0A0'">
                        <span class="rep-driver-dot"></span>
                        <span class="rep-driver-name">{{ trip.driver.firstName }} {{ trip.driver.lastName }}</span>
                      </button>
                    } @else if (canManageDrivers()) {
                      <button type="button" (click)="openDriverPickerForTrip(trip)" class="rep-driver rep-driver--add">
                        <lucide-icon [img]="UserRoundIcon" [size]="11"></lucide-icon>
                        Conducteur
                      </button>
                    }
                    @if (trip.notes) {
                      <!-- Même règle que dans le tableau : au doigt il n'y a pas de survol,
                           donc pas d'attribut title. La note se déplie sur trois lignes, et le tap
                           l'ouvre en entier pour un rôle sans droit d'édition. -->
                      <button type="button"
                              (click)="canEditNotes() ? openNoteEdit(trip) : basculerNote(trip.id)"
                              [attr.aria-expanded]="canEditNotes() ? null : noteDepliee() === trip.id"
                              class="rep-note rep-note--filled"
                              [class.rep-note--depliee]="noteDepliee() === trip.id">
                        <lucide-icon [img]="MessageSquareIcon" [size]="12"></lucide-icon>
                        <span class="rep-note-text">{{ trip.notes }}</span>
                      </button>
                    } @else if (canEditNotes()) {
                      <button type="button" (click)="openNoteEdit(trip)" class="rep-note rep-note--add">
                        <lucide-icon [img]="MessageSquareIcon" [size]="12"></lucide-icon>
                        Note
                      </button>
                    }
                  </div>
                  <div class="rep-card-foot-right">
                    <!-- ⚠️ DANS LE PIED, et c'est tout l'intérêt : cette rangée mesure déjà
                         44 px pour « Replay ». Une bascule posée sous l'analyse aurait ajouté
                         sa propre hauteur à chacune des cent cartes, et mangé une bonne part
                         de ce que le repli fait gagner. -->
                    <button type="button" (click)="basculerDetailTrajet(trip.id)"
                            [attr.aria-expanded]="detailTrajetOuvert(trip.id)"
                            class="rep-card-action rep-card-detail"
                            trackClick="rapport-detail-trajet">
                      <lucide-icon [img]="ChevronDown" [size]="14" class="rep-repli-chevron"
                                   [class.rep-repli-chevron--ferme]="!detailTrajetOuvert(trip.id)"></lucide-icon>
                      Détail
                    </button>
                    @if (isAdmin() && trip.maxSpeed > 90) {
                      <button type="button" (click)="downloadSpeedReport(trip)" class="rep-card-action" title="Rapport vitesse">
                        <lucide-icon [img]="FileTextIcon" [size]="15"></lucide-icon>
                      </button>
                    }
                    <button type="button" (click)="openReplay(trip)" class="rep-card-action rep-card-action--replay" title="Replay">
                      <lucide-icon [img]="Play" [size]="14"></lucide-icon>
                      Replay
                    </button>
                  </div>
                </footer>
              </article>
            }
          </div>
        }
        </div>

        <!-- Pagination : la page suivante s'AJOUTE au tableau (le tri reste celui
             demandé au serveur, donc « plus » veut bien dire « la suite », pas
             « d'autres trajets pris ailleurs »). Le bouton reste la commande explicite ;
             la sentinelle en dessous charge d'elle-même quand on arrive en bas — au pouce,
             c'est ce qu'on attend d'une liste. -->
        @if (nextCursor()) {
          <div #moreSentinel class="rep-more-sentinel" aria-hidden="true"></div>
          <div class="rep-more">
            <button type="button" class="btn-secondary text-xs"
                    (click)="loadMoreTrips()" [disabled]="loadingMore()"
                    trackClick="rapport-charger-plus">
              @if (loadingMore()) {
                <span class="rep-more-spinner"></span> Chargement…
              } @else {
                Charger plus
                @if (kpis().tripCount > listedTripCount()) {
                  <span class="rep-more-rest">({{ kpis().tripCount - listedTripCount() }} restants)</span>
                }
              }
            </button>
          </div>
        }
      }
    </div>

    <app-trip-replay
      [lienPartage]="lienDuTrajetOuvert()"
      (copierLien)="copierLienTrajet()"
      [open]="!!replayTrip()"
      [trip]="replayTrip()"
      [analysis]="replayTrip() ? analysisFor(replayTrip()!.id) : null"
      [vehicleType]="replayVehicleType()"
      [canEditNote]="canEditNotes()"
      (closed)="fermerReplay()"
      (editNote)="onEditNoteFromReplay($event)"
    />

    <app-period-replay
      [open]="periodReplayOpen()"
      [trips]="periodReplayTrips()"
      [vehicleType]="periodReplayVehicleType()"
      [vehiclePlate]="periodReplayPlate()"
      (closed)="periodReplayOpen.set(false)"
    />

    <app-trip-note-modal
      [open]="!!noteEditTrip()"
      [trip]="noteEditTrip()"
      (closed)="noteEditTrip.set(null)"
      (saved)="onNoteSaved($event)"
    />

    <app-confirm-modal
      [open]="recomputeConfirmOpen()"
      title="Recalculer les trajets de la période ?"
      description="Le recalcul redécoupe les trajets depuis les positions GPS brutes. Utile quand des trajets sont fragmentés ou manquants."
      [consequences]="recomputeConsequences()"
      [irreversible]="true"
      [danger]="true"
      confirmLabel="Recalculer"
      [loading]="recomputing()"
      (confirmed)="confirmRecompute()"
      (cancelled)="recomputeConfirmOpen.set(false)"
    />

    <app-driver-picker
      [open]="!!driverPickerTrip()"
      [currentDriverId]="driverPickerTrip()?.driver?.id ?? null"
      title="Reaffecter le conducteur"
      [subtitle]="driverPickerSubtitle()"
      (closed)="driverPickerTrip.set(null)"
      (selected)="onDriverPickedForTrip($event)"
    />

    <!-- ⚠️ Le filtre conducteur est LU par la modale, jamais modifié par elle (F13) : le
         conducteur se choisit sur la page, et nulle part ailleurs. La modale l'annonce dans
         son bandeau de périmètre et dans sa phrase d'aperçu — la dernière ligne lue avant de
         cliquer, où « pour toute la flotte » était un mensonge dès qu'un conducteur était
         sélectionné. -->
    <app-pdf-export-modal
      [preselectedVehicleIds]="pdfPreselectedVehicleIds()"
      [tripCount]="kpis().tripCount"
      [fileDateRange]="pdfFileDateRange()"
      [open]="pdfModalOpen()"
      [vehicles]="pdfModalVehicles()"
      [periodLabel]="pdfPeriodLabel()"
      [driverFilter]="conducteurPourExport()"
      [groupLabel]="selectedGroupId() ? selectedGroupLabel() : null"
      [loading]="exporting() === 'pdf'"
      (closed)="pdfModalOpen.set(false)"
      (exportRequested)="onPdfExportRequested($event)"
    />
  `,
  styles: [`
    /* ─── Cibles tactiles — ce que la mesure a corrigé dans mon diagnostic ──────
     *
     * La sonde comptait 232 cibles sous 44 px sur cette page, et j'en avais conclu
     * qu'elle appelait la refonte mobile de B1 § D. La mesure dit autre chose :
     *
     *   · 168 de ces 232 sont les CELLULES DE LA CARTE DE CHALEUR (24 h × 7 j, 10 × 11
     *     px chacune). Ce ne sont pas des commandes, ce sont des données. Les porter à
     *     44 px ferait 7 392 px de large sur un écran de 375 : la carte de chaleur
     *     cesserait d'exister. Le critère vise ce qu'on actionne, pas ce qu'on lit.
     *   · le scroll horizontal, lui, est DÉJÀ à zéro — le critère « jamais de scroll
     *     horizontal » est tenu.
     *
     * Restent 64 vraies commandes, corrigées ici. Le vrai sujet de la refonte n'est
     * donc pas le tableau, c'est la carte de chaleur : au doigt, elle demande un
     * drill-down (toucher un jour, puis lire ses heures) plutôt que des cellules
     * qu'aucun pouce ne peut viser. Cela reste à faire, et c'est écrit comme tel. */
    @media (max-width: 768px) {
      .rep-driver, .rep-note, .rep-export-btn, .rep-reset-btn,
      .rep-dropdown-trigger, .rep-th, .rep-periode { min-height: 44px }
      /* L'action de fin de ligne est un pictogramme de 16 px : c'est la SURFACE qui
         doit grandir, pas le dessin. */
      .rep-ligne-action { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center }
      /* Les actions en fin de ligne sont des pictogrammes de 16 px : c'est la surface
         qui doit grandir, pas le dessin. */
      /* Les raccourcis de période portent une classe stable — les utilitaires
         Tailwind ne s'attrapent pas depuis une feuille de styles. */
    }
    /* ─── Sparkline KPI cards ─── */
    .rep-kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    @media (min-width: 1024px) {
      .rep-kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }
    .rep-kpi-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card);
      min-width: 0;
    }
    .rep-kpi-head {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .rep-kpi-head lucide-icon { color: var(--tracky-light); }
    .rep-kpi-body {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .rep-kpi-value {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      color: var(--fg-primary);
      line-height: 1;
      letter-spacing: -.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 0 1 auto;
    }
    .rep-kpi-unit {
      font-size: 12px;
      font-weight: 500;
      color: var(--fg-tertiary);
      margin-left: 2px;
    }
    .rep-kpi-meta {
      font-size: 10px;
      font-weight: 500;
      color: var(--fg-tertiary);
      white-space: nowrap;
    }
    .rep-kpi-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 25%, transparent);
      flex-shrink: 0;
      align-self: center;
    }
    .rep-spark {
      width: 84px;
      height: 28px;
      flex-shrink: 0;
      overflow: visible;
    }
    /* Sous 480 px, une carte KPI fait ~134 px de large utile : « 33 171,4 km » et sa
       courbe ne tiennent pas côte à côte, et la valeur s'affichait « 33171,… ». Le chiffre
       est la raison d'être de la carte : il ne se tronque JAMAIS. La courbe et la mention
       passent à la ligne quand il n'y a plus de place. */
    @media (max-width: 480px) {
      .rep-kpi-body { flex-wrap: wrap; row-gap: 4px; }
      .rep-kpi-value { font-size: 20px; overflow: visible; text-overflow: clip; }
      .rep-kpi-meta { white-space: normal; line-height: 1.3; }
      .rep-spark { width: 60px; height: 22px; }
    }
    /* KPI cliquable (Vitesse max → drilldown tableau). Reset des defauts <button>
     * + affordance hover/curseur + petite icône de clic. */
    .rep-kpi-card--clickable {
      cursor: pointer;
      text-align: left;
      font: inherit;
      color: inherit;
      transition: border-color .15s, background .15s, transform .05s;
    }
    .rep-kpi-card--clickable:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--tracky, #10E0A0) 45%, var(--border-subtle));
      background: color-mix(in srgb, var(--tracky, #10E0A0) 6%, var(--bg-secondary));
    }
    .rep-kpi-card--clickable:active:not(:disabled) { transform: translateY(1px); }
    .rep-kpi-card--clickable:disabled { cursor: default; opacity: .75; }
    .rep-reprise {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
      margin-bottom: 12px; padding: 9px 14px; border-radius: 12px;
      border: 1px dashed var(--border-subtle); background: var(--bg-secondary);
      font-size: 12.5px; color: var(--fg-secondary);
    }
    /* ── EN-TÊTE D'UNE SECTION REPLIABLE ─────────────────────────────────────────────
       Un bouton pleine largeur, pas une pastille : au doigt, la cible est la ligne
       entière. Le chevron pivote plutôt que de changer de dessin — un seul repère à
       apprendre, et l'animation dit dans quel sens ça va s'ouvrir. */
    .rep-repli {
      display: flex; align-items: center; gap: 8px; width: 100%;
      min-height: 44px; padding: 10px 12px; margin: 0;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      border-radius: 12px; cursor: pointer; text-align: left;
    }
    .rep-repli:hover { border-color: var(--border-strong); }
    .rep-repli-chevron { color: var(--tracky-light); flex-shrink: 0; transition: transform .2s; }
    /* Fermé = le chevron pointe vers la droite ; ouvert = vers le bas. */
    .rep-repli-chevron--ferme { transform: rotate(-90deg); }
    .rep-repli-titre { font-size: 13.5px; font-weight: 800; color: var(--fg-primary); }
    /* ⚠️ Le sous-titre DIT CE QUE LA SECTION CACHE. Un en-tête replié qui n'annoncerait que
       « Graphiques » obligerait à ouvrir pour savoir s'il y a là ce qu'on cherche. */
    .rep-repli-sous { font-size: 11.5px; color: var(--fg-tertiary); font-weight: 600; }
    @media (max-width: 480px) {
      /* Sous 480 px les deux textes ne tiennent plus sur une ligne : le sous-titre passe
         dessous plutôt que d'être coupé. */
      .rep-repli { flex-wrap: wrap; }
      .rep-repli-sous { flex-basis: 100%; padding-left: 24px; }
    }
    /* ⚠️ BORNÉ À L'ÉCRAN, et c'est tout l'intérêt d'écrire « @media screen » plutôt que de
       masquer sans condition : à l'IMPRESSION la règle n'existe pas, donc une section
       repliée sort quand même sur le papier, avec sa mise en page d'origine (une grille
       reste une grille — la forcer en « display: block » à l'impression l'aurait cassée).
       Un Ctrl+P amputé de ses graphiques parce qu'on les avait fermés à l'écran serait un
       piège ; l'en-tête de repli, lui, est masqué avec les autres commandes plus bas. */
    @media screen {
      .rep-sec--repliee { display: none !important; }
    }
    .rep-reprise-actions { display: inline-flex; gap: 8px; }
    .rep-reprise-oui, .rep-reprise-non {
      min-height: 32px; padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 700; cursor: pointer;
    }
    .rep-reprise-oui { background: var(--tracky, #10E0A0); color: var(--accent-ink, #04130D); border: none; }
    .rep-reprise-non { background: transparent; color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
    /* ⚠️ AU DOIGT, 44 px — ET LE BLOC EST POSÉ ICI, PAS DANS CELUI DES CIBLES TACTILES
       PLUS HAUT. Celui-là est déclaré AVANT le min-height de 32px de ces deux boutons :
       une media query n'ajoute aucune spécificité, la règle y serait strictement inerte.
       Ce dépôt a livré deux fois ce défaut exact ; cascade-css.spec.ts le tient désormais.
       Mesuré à 320 px : « Reprendre » et « Ignorer » rendaient 32 px, alors que tout le
       reste de la barre est à 44. Ce sont les deux actions d'une proposition qui pose un
       filtre — les rater fait recharger le mauvais rapport. */
    @media (max-width: 768px) {
      .rep-reprise-oui, .rep-reprise-non { min-height: 44px; padding-left: 14px; padding-right: 14px; }
    }
    .rep-kpi-tendance { display: block; margin-top: 4px; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); }
    /* ⚠️ La couleur ne porte pas l'information : le signe et le mot « vs période
       précédente » sont écrits. Elle n'est là que pour accélérer la lecture. */
    .rep-kpi-tendance--haut { color: var(--texte-succes); }
    .rep-kpi-tendance--muet { font-weight: 500; font-style: italic; }
    .rep-kpi-click-hint {
      color: var(--fg-tertiary) !important;
      margin-left: auto;
      opacity: .5;
      transition: opacity .15s, color .15s;
    }
    .rep-kpi-card--clickable:hover:not(:disabled) .rep-kpi-click-hint {
      opacity: 1;
      color: var(--tracky-light) !important;
    }

    /* ─── Charts grid ─── */
    .rep-charts-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }
    @media (min-width: 1024px) {
      .rep-charts-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .rep-chart-card--full { grid-column: 1 / -1; }
    }
    .rep-chart-card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px 18px 18px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card);
      min-width: 0;
    }
    .rep-chart-head { display: flex; flex-direction: column; gap: 2px; }
    .rep-chart-head h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      color: var(--fg-primary);
      letter-spacing: -.01em;
    }
    .rep-chart-head p {
      margin: 0;
      font-size: 11px;
      color: var(--fg-tertiary);
    }

    /* ─── Date range personnalisé ─── */
    .rep-custom-wrapper { position: relative; display: inline-block }
    .rep-custom-backdrop {
      position: fixed; inset: 0; z-index: 50;
      background: transparent;
    }
    .rep-custom-panel {
      /* right:0 ancre le panel au bord droit du wrapper "Personnalisé"
       * (qui est en bout de barre filtres) et le fait s'étirer vers la gauche.
       * Évite le débord à droite de la viewport en desktop. Le max-width
       * sécurise le cas où le wrapper serait trop à gauche. */
      position: absolute; top: calc(100% + 8px); right: 0;
      z-index: 51;
      display: grid; grid-template-columns: 160px 1fr;
      width: 600px; max-width: calc(100vw - 24px);
      background: var(--bg-secondary, #0F1714);
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .35);
      overflow: hidden;
      animation: rep-custom-pop .2s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes rep-custom-pop {
      from { opacity: 0; transform: translateY(-6px) }
      to   { opacity: 1; transform: translateY(0) }
    }
    /* Tablette (< 768px) : pas de calendrier inline, on garde les inputs
     * natifs → on n'a plus besoin des 600px de large. */
    @media (max-width: 767px) {
      .rep-custom-panel {
        grid-template-columns: 160px 220px;
        width: 380px;
      }
    }
    /* Mobile : repli en colonne unique, ancre en fixed bottom pour eviter
     * tout debordement (le wrapper .rep-custom-wrapper peut etre place
     * n'importe ou dans la barre de filtres horizontale).
     * 640 px et non 480 : sous 640, la rangee des periodes defile horizontalement
     * (overflow), et un panneau en position absolue y serait rogne. */
    @media (max-width: 640px) {
      .rep-custom-panel {
        position: fixed;
        top: auto;
        left: 12px; right: 12px; bottom: calc(env(safe-area-inset-bottom) + 80px);
        grid-template-columns: 1fr;
        width: auto;
      }
      .rep-custom-backdrop {
        background: rgba(0, 0, 0, .35);
      }
    }
    .rep-custom-presets {
      display: flex; flex-direction: column; gap: 2px;
      padding: 12px 8px;
      background: var(--bg-tertiary);
      border-right: 1px solid var(--border-subtle);
    }
    @media (max-width: 640px) {
      .rep-custom-presets { border-right: none; border-bottom: 1px solid var(--border-subtle) }
    }
    .rep-custom-section {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-tertiary);
      padding: 4px 10px; margin: 0 0 4px;
    }
    .rep-custom-preset {
      text-align: left; padding: 8px 10px;
      font-size: 12px; font-weight: 500; color: var(--fg-secondary);
      background: transparent; border: none; border-radius: 8px;
      cursor: pointer; transition: all .15s;
    }
    .rep-custom-preset:hover { background: var(--bg-secondary); color: var(--fg-primary) }
    /* ⚠️ --texte-succes, pas le vert de MARQUE : c'est du texte de 12 px, et
       --tracky-light y donne 3,3:1 en thème clair (styles.css § « état actif d'un
       segment » l'interdit nommément). Le lavis dérive du jeton au lieu d'être écrit
       en rgba(), sinon il ne suit pas le vert clair #0A9E6C. */
    .rep-custom-preset--active {
      background: color-mix(in srgb, var(--tracky-light) 12%, transparent);
      color: var(--texte-succes);
    }
    .rep-custom-fields { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px }
    .rep-custom-field { display: flex; flex-direction: column; gap: 4px }
    .rep-custom-field label {
      font-size: 11px; font-weight: 600; color: var(--fg-tertiary);
    }
    .rep-custom-field input[type="date"] {
      padding: 8px 10px; border-radius: 8px;
      background: var(--bg-tertiary); color: var(--fg-primary);
      border: 1px solid var(--border-subtle);
      font-size: 13px; font-family: inherit;
    }
    .rep-custom-field input[type="date"]:focus {
      outline: 2px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 60%, transparent);
      outline-offset: 1px; border-color: var(--tracky-light, #10E0A0);
    }
    .rep-custom-error {
      font-size: 11px; color: var(--danger); margin: 0;
    }
    .rep-custom-hint {
      font-size: 11px; color: var(--fg-tertiary); margin: 0;
    }
    .rep-custom-actions {
      display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px;
    }
    .rep-custom-cancel {
      padding: 7px 12px; border-radius: 8px;
      background: transparent; color: var(--fg-tertiary);
      border: 1px solid var(--border-subtle);
      font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .rep-custom-cancel:hover { color: var(--fg-secondary); border-color: var(--border-strong) }
    .rep-custom-apply {
      padding: 7px 14px; border-radius: 8px;
      background: var(--tracky, #10E0A0); color: var(--accent-ink);
      border: none; font-size: 12px; font-weight: 700; cursor: pointer;
      transition: opacity .15s;
    }
    .rep-custom-apply:disabled { opacity: .5; cursor: not-allowed }
    .rep-custom-apply:not(:disabled):hover { opacity: .92 }

    /* ─── Boutons d'export PDF / CSV ─── */
    .rep-export-group {
      display: inline-flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    /* Les boutons d'export et, dessous, ce qu'ils ne couvrent pas — la mention doit rester
       COLLÉE aux boutons : une phrase posée ailleurs sur la page ne se lit pas au moment
       où l'on clique. */
    .rep-export-colonne { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .rep-export-note { margin: 0; max-width: 38ch; text-align: right; font-size: 11.5px;
                       line-height: 1.45; color: var(--fg-tertiary); }
    @media (max-width: 640px) {
      .rep-export-colonne { align-items: stretch; width: 100%; }
      .rep-export-note { text-align: left; max-width: none; }
    }
    .rep-export-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--fg-secondary);
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      cursor: pointer;
      transition: color .15s, background .15s, border-color .15s;
    }
    .rep-export-btn:hover:not(:disabled) {
      color: var(--fg-primary);
      border-color: var(--border-strong);
      background: var(--bg-tertiary);
    }
    .rep-export-btn:disabled { opacity: .5; cursor: not-allowed }
    .rep-export-btn--pdf {
      /* Meme convention que l'etat actif d'un segment : le vert de MARQUE ne porte
         pas de texte (il rendait 3,17:1 en clair). */
      color: var(--texte-succes);
      background: rgba(16,224,160,.08);
      border-color: rgba(16,224,160,.22);
    }
    .rep-export-btn--pdf:hover:not(:disabled) {
      background: rgba(16,224,160,.14);
      border-color: rgba(16,224,160,.32);
    }
    /* Excel — teinte verte « tableur » (217954) distincte du tracky.
       On garde la DECISION de la planche — une teinte a part, pour que l'export
       tableur ne se confonde pas avec le vert de marque — mais pas sa VALEUR :
       #34d399 rendait 1,74:1 en theme clair (et 1,64 mesure, l'ecart venant de
       l'opacite .5 de l'etat desactive). Assombri pour le clair seulement, il
       reste parfaitement distinct du tracky. */
    .rep-export-btn--excel {
      color: #34d399;
      background: rgba(33,121,84,.10);
      border-color: rgba(33,121,84,.28);
    }
    :host-context([data-theme='light']) .rep-export-btn--excel,
    :host-context([data-theme='light']) .rep-export-btn--excel lucide-icon {
      color: color-mix(in srgb, #34d399 55%, #000);
    }
    .rep-export-btn--excel:hover:not(:disabled) {
      background: rgba(33,121,84,.18);
      border-color: rgba(33,121,84,.40);
    }
    .rep-export-btn--excel lucide-icon { color: #34d399; }
    .rep-export-spin {
      width: 13px; height: 13px;
      border: 2px solid color-mix(in srgb, #34d399 35%, transparent);
      border-top-color: #34d399;
      border-radius: 50%;
      animation: rep-export-spin .7s linear infinite;
      flex-shrink: 0;
    }
    @keyframes rep-export-spin { to { transform: rotate(360deg); } }

    /* ══════════════════════════════════════════════════════════════════════════════
       IMPRESSION (Ctrl+P) — F15

       Ce que Ctrl+P sortait jusqu'ici : les menus déroulants, les boutons d'export, la
       barre de tri, le fond sombre imprimé en aplat, et un tableau coupé au milieu d'une
       ligne à chaque saut de page. Autrement dit une capture d'écran, pas un document.

       ⚠️ On ne fabrique PAS une seconde mise en page : on retire ce qui n'a pas de sens
       sur papier (tout ce qui se clique) et on tient les deux règles qui font qu'un tableau
       reste lisible sur plusieurs pages — l'en-tête se répète, une ligne ne se coupe pas.
       ══════════════════════════════════════════════════════════════════════════════ */
    .rep-print-entete { display: none; }

    @media print {
      /* Le fond sombre du produit deviendrait un aplat d'encre : on imprime sur blanc. */
      :host { color: #111 !important; background: #fff !important; }
      :host ::ng-deep * {
        background-image: none !important;
        box-shadow: none !important;
        color: #111 !important;
        border-color: #bbb !important;
      }
      .rep-print-entete {
        display: block; margin-top: 6px;
        font-size: 11pt; color: #333 !important;
      }

      /* Tout ce qui se clique n'a aucun sens sur du papier. */
      .rep-repli,
      .rep-export-group, .rep-export-note, .rep-filters, .rep-selectors, .rep-periods, .rep-actions,
      .rep-sortbar, .rep-vgo, .rep-vfiltre, .rep-kpi-click-hint, .rep-more,
      .rep-ligne-action, .rep-card-action, .rep-dropdown-backdrop, .rep-custom-backdrop,
      .rep-custom-panel, .rep-dropdown-menu {
        display: none !important;
      }

      /* ⚠️ Les deux règles qui font un tableau lisible sur plusieurs pages. Sans la
         première, seule la page 1 porte les titres de colonnes et les suivantes sont des
         colonnes de chiffres sans nom ; sans la seconde, une ligne se coupe en deux. */
      thead { display: table-header-group; }
      tr, .rep-vrow, .rep-card, .rep-synthese-card, .rep-chart-card { break-inside: avoid; }

      /* Les cartes s'étalent : sur papier il n'y a pas de survol pour révéler le reste. */
      .rep-synthese-grid { grid-template-columns: 1fr 1fr !important; }
      /* ⚠️ .rep-vt-hide N'EST PAS ICI : à cette place, la règle était strictement INERTE en
         A4 portrait (le bloc « max-width: 1000px » qui la contredit est écrit 600 lignes plus
         bas, à poids égal). Elle vit désormais tout en bas du fichier — voir le dernier bloc
         « @media print » de ce tableau de styles. */

      /* Un graphique par page au maximum, et jamais coupé en deux. */
      .rep-charts-grid { display: block !important; }
      .rep-chart-card { margin-bottom: 12pt; }
    }

    /* ─── Coût et alertes de la période (F02 / F05) ─── */
    .rep-synthese-absente { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding: 10px 14px;
                            border: 1px dashed var(--border-subtle); border-radius: 12px;
                            font-size: 12.5px; color: var(--fg-tertiary); }
    .rep-synthese-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 16px; }
    @media (min-width: 720px) { .rep-synthese-grid { grid-template-columns: 1fr 1fr; } }
    @media (min-width: 1120px) { .rep-synthese-grid { grid-template-columns: repeat(3, 1fr); } }
    .rep-synthese-card { padding: 14px 16px; border: 1px solid var(--border-subtle); border-radius: 14px; background: var(--bg-secondary); }
    .rep-synthese-head { display: flex; align-items: center; gap: 8px; color: var(--fg-tertiary); }
    .rep-synthese-head h2 { margin: 0; font-size: 12px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
    .rep-synthese-valeur { margin: 8px 0 2px; font-size: 30px; font-weight: 800; line-height: 1; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .rep-synthese-valeur--calme { color: var(--texte-succes); }
    .rep-synthese-unite { font-size: 16px; font-weight: 700; color: var(--fg-tertiary); margin-left: 3px; }
    .rep-synthese-detail { margin: 6px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); }
    .rep-synthese-detail--fort { color: var(--fg-primary); font-weight: 600; }
    .rep-synthese-note { margin: 8px 0 0; font-size: 11.5px; color: var(--fg-tertiary); }
    .rep-synthese-liste { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .rep-synthese-liste li { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--fg-secondary); }
    .rep-synthese-liste b { color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .rep-parc-liste { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
    .rep-parc-liste li { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px;
                         border: 1px solid var(--border-subtle); background: var(--bg-tertiary); font-size: 12px; }
    .rep-parc-liste a { color: var(--fg-primary); font-weight: 700; text-decoration: none; }
    .rep-parc-liste a:hover { text-decoration: underline; }
    .rep-parc-groupe { color: var(--fg-tertiary); font-size: 11px; }
    .rep-parc-muet { color: var(--texte-attente); font-size: 11px; font-weight: 700; }

    /* ─── Bouton Réinitialiser (filtres) ─── */
    .rep-reset-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--fg-tertiary);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      cursor: pointer;
      transition: color .15s, background .15s, border-color .15s;
    }
    .rep-reset-btn lucide-icon { color: var(--fg-tertiary); }
    .rep-reset-btn:hover:not(:disabled) {
      color: var(--fg-primary);
      border-color: var(--border-strong);
      background: var(--bg-secondary);
    }
    .rep-reset-btn:disabled { opacity: .4; cursor: not-allowed; }

    /* ─── Bouton admin « Recalculer » ───
       Le libellé porte --texte-attente (l'ambre assombri pour le thème clair) et non
       l'utilitaire text-amber-400 : #FBBF24 sur blanc rendait 1,7:1, et 1,2:1 à
       l'opacité de l'état désactivé. Le fond et le liseré ambre restent — ils ne portent
       pas de caractères. */
    .rep-recalc-btn { color: var(--texte-attente); }

    /* ─── Bandeau : liste des véhicules indisponible ─── */
    .rep-bandeau-vehicules {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; flex-wrap: wrap;
      padding: 10px 16px;
      border-radius: var(--radius-card, 16px);
      background: var(--bg-secondary);
      border: 1px solid color-mix(in srgb, var(--texte-attente) 40%, transparent);
      color: var(--fg-secondary);
      font-size: 13px;
    }

    /* ─── Dropdown véhicule custom ─── */
    .rep-dropdown-wrapper {
      position: relative;
      min-width: 0;
    }
    .rep-dropdown-trigger {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      min-width: 180px;
      max-width: 240px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      color: var(--fg-primary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all .15s;
    }
    .rep-dropdown-trigger:hover { border-color: var(--border-strong) }
    .rep-dropdown-trigger--open {
      border-color: var(--tracky);
      background: var(--bg-tertiary);
    }
    .rep-dropdown-trigger lucide-icon { color: var(--tracky-light); flex-shrink: 0 }
    .rep-dropdown-label {
      flex: 1;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rep-dropdown-chevron {
      transition: transform .2s;
      color: var(--fg-tertiary) !important;
    }
    .rep-dropdown-trigger--open .rep-dropdown-chevron { transform: rotate(180deg) }

    .rep-dropdown-backdrop {
      position: fixed; inset: 0; z-index: 50;
      background: transparent;
    }
    .rep-dropdown-menu {
      position: absolute; top: calc(100% + 6px); left: 0;
      min-width: 240px; max-width: 320px;
      max-height: 320px; overflow-y: auto;
      z-index: 60;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 4px 12px rgba(0,0,0,.08);
      padding: 6px;
      animation: rep-dropdown-pop 180ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes rep-dropdown-pop {
      from { opacity: 0; transform: translateY(-6px) scale(.98) }
      to   { opacity: 1; transform: translateY(0) scale(1) }
    }
    .rep-dropdown-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      padding: 9px 12px;
      border-radius: 10px;
      background: transparent;
      border: 0;
      color: var(--fg-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: all .12s;
    }
    .rep-dropdown-item:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    /* La plaque du véhicule sélectionné est l'endroit où l'on vérifie « qu'est-ce que je
       regarde ? ». Elle passait sous 4,5:1 en thème clair : --tracky-light est une
       couleur de FOND ou de filet, jamais de texte à 13 px. L'icône, elle, n'est pas du
       texte et garde l'accent. */
    .rep-dropdown-item--active {
      background: color-mix(in srgb, var(--tracky-light) 10%, transparent);
      color: var(--texte-succes);
      font-weight: 700;
    }
    .rep-dropdown-item--active lucide-icon { color: var(--tracky-light) }
    .rep-dropdown-vide {
      margin: 0; padding: 10px 12px;
      font-size: 12px; color: var(--fg-tertiary);
    }
    .rep-dropdown-item-content {
      display: flex; flex-direction: column;
      min-width: 0; flex: 1;
    }
    .rep-dropdown-item-plate {
      font-family: var(--font-mono, monospace);
      font-weight: 700;
      font-size: 13px;
      color: inherit;
    }
    .rep-dropdown-item-meta {
      font-size: 11px;
      color: var(--fg-tertiary);
      font-weight: 400;
      margin-top: 2px;
    }
    .rep-dropdown-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: 6px 4px;
    }

    @media (max-width: 640px) {
      .rep-dropdown-trigger { min-width: 0; max-width: none; flex: 1 }
      .rep-dropdown-menu { left: 0; right: 0; max-width: none }
    }

    /* ─── Cellule note dans la table ─── */
    .rep-note {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      max-width: 100%;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all .15s;
      border: 1px solid transparent;
      background: transparent;
      text-align: left;
    }
    .rep-note--filled {
      background: rgba(16,224,160,.08);
      color: var(--fg-primary);
      border-color: rgba(16,224,160,.18);
    }
    .rep-note--filled:hover:not(:disabled) {
      background: rgba(16,224,160,.14);
      border-color: rgba(16,224,160,.30);
    }
    .rep-note--filled:disabled { cursor: default }
    .rep-note--filled lucide-icon { color: var(--tracky-light); flex-shrink: 0 }
    .rep-note-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 180px;
    }
    /* Note dépliée : la suite du texte, à la place de l'attribut title, qui n'existe pas au doigt. */
    .rep-note--depliee { align-items: flex-start; }
    .rep-note--depliee .rep-note-text {
      white-space: normal;
      max-width: 100%;
      overflow: visible;
      text-overflow: clip;
      line-height: 1.45;
    }
    .rep-note-edit-icon { color: var(--fg-tertiary) !important; opacity: .7 }

    .rep-note--add {
      color: var(--fg-tertiary);
      border-color: var(--border-subtle);
      border-style: dashed;
    }
    /* Meme famille que MOB-09 : du texte de 11 px ne prend pas le vert de MARQUE.
       Le lavis derive du jeton, sinon il ne suit pas le vert clair. */
    .rep-note--add:hover {
      color: var(--texte-succes);
      border-color: color-mix(in srgb, var(--tracky-light) 30%, transparent);
      background: color-mix(in srgb, var(--tracky-light) 5%, transparent);
    }

    /* ─── Cellule conducteur dans la table ─── */
    .rep-driver {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      max-width: 100%;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all .15s;
      background: color-mix(in srgb, var(--driver-color, #10E0A0) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--driver-color, #10E0A0) 25%, transparent);
      color: var(--fg-primary);
      text-align: left;
    }
    .rep-driver:hover:not(:disabled) {
      background: color-mix(in srgb, var(--driver-color, #10E0A0) 18%, transparent);
      border-color: color-mix(in srgb, var(--driver-color, #10E0A0) 38%, transparent);
    }
    .rep-driver:disabled { cursor: default }
    .rep-driver-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--driver-color, #10E0A0);
      flex-shrink: 0;
    }
    .rep-driver-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 130px;
    }
    .rep-driver--add {
      background: transparent;
      border-color: var(--border-subtle);
      border-style: dashed;
      color: var(--fg-tertiary);
    }
    .rep-driver--add:hover {
      color: var(--texte-succes);
      border-color: color-mix(in srgb, var(--tracky-light) 30%, transparent);
      background: color-mix(in srgb, var(--tracky-light) 5%, transparent);
    }
    .rep-driver--add lucide-icon { color: inherit; flex-shrink: 0 }

    /* ─── En-têtes de colonne triables (Sprint 5) ─── */
    .rep-th {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      width: 100%;
      padding: 12px;
      background: transparent;
      border: 0;
      color: inherit;
      font: inherit;
      text-transform: inherit;
      letter-spacing: inherit;
      cursor: pointer;
      transition: color .12s;
    }
    .rep-th--right { justify-content: flex-end; }
    .rep-th--left { justify-content: flex-start; }
    .rep-th:hover { color: var(--fg-secondary); }
    /* Flèche neutre discrète, accentuée quand la colonne est active. */
    .rep-th lucide-icon { opacity: .35; transition: opacity .12s, color .12s; }
    .rep-th:hover lucide-icon { opacity: .6; }
    .rep-th .rep-th-arrow--active { opacity: 1; color: var(--tracky-light); }

    /* ─── Highlight de la ligne ciblée par le clic KPI « Vitesse max » ─── */
    .rep-row--highlight {
      background: color-mix(in srgb, var(--tracky, #10E0A0) 16%, transparent) !important;
      box-shadow: inset 3px 0 0 var(--tracky-light, #10E0A0);
      animation: rep-row-flash 2.4s ease-out;
    }
    @keyframes rep-row-flash {
      0%   { background: color-mix(in srgb, var(--tracky, #10E0A0) 34%, transparent); }
      100% { background: color-mix(in srgb, var(--tracky, #10E0A0) 16%, transparent); }
    }

    /* Re-tri serveur : les lignes restent lisibles, estompées et non cliquables, plutôt
       que de céder la place à un spinner (qui démonterait les en-têtes sous le curseur). */
    /* Pas de pointer-events:none ici : un second clic sur le même en-tête (pour inverser
       la direction) tomberait pendant la requête et serait perdu. La course est déjà
       arbitrée côté composant par loadSeq. */
    .rep-table-wrap { transition: opacity .15s ease; }
    .rep-table-wrap--busy { opacity: .55; }

    /* ─── Colonne « Analyse » ───
       Elle n'apparaissait qu'avec un véhicule unique sélectionné ; elle est maintenant
       toujours là (les analyses sont chargées par trajet). Sur un écran large la cellule
       fait ~300 px et les badges tiennent sur trois lignes : 61 → 107 px par ligne, sans
       conséquence. Sous 900 px en revanche, la cellule retombe à sa largeur minimale et
       les huit badges s'empilent : la ligne passe à plus de 300 px, soit un tableau
       quatre fois plus long à parcourir. On borne donc la hauteur ici — le reste des
       badges reste atteignable en faisant défiler la cellule, là où un display:none
       les aurait supprimés du mobile, ce qui est précisément le manque qu'on répare. */
    /* La variante « rangée » du bloc d'analyse tient sur une ligne : plus de bride de
       hauteur ni d'ascenseur interne (qui cachait les boutons entre 768 et 900 px). */
    .rep-analysis-cell { min-width: 220px; }

    /* ─── Pagination du tableau (« Charger plus ») ─── */
    .rep-more { display: flex; justify-content: center; margin-top: 12px; }
    .rep-more button { display: inline-flex; align-items: center; gap: 8px; }
    .rep-more-rest { color: var(--fg-tertiary); font-weight: 500; }
    .rep-more-spinner {
      width: 12px; height: 12px; border-radius: 999px;
      border: 2px solid var(--border-subtle);
      border-top-color: var(--tracky-light, #10E0A0);
      animation: rep-more-spin .7s linear infinite;
    }
    @keyframes rep-more-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .rep-more-spinner { animation-duration: 2s; }
    }
    /* Sentinelle de pagination : 1 px, invisible, placée juste au-dessus du bouton. */
    .rep-more-sentinel { height: 1px; }

    /* ─── Barre de filtres — MOBILE D'ABORD ───
       Trois groupes réels dans le DOM. En large ils s'effacent (display: contents) et la
       barre redevient la ligne fluide d'origine, pixel pour pixel. Sous 640 px : sélecteurs
       en pleine largeur, périodes en rangée défilante au pouce (pas de retour à la ligne),
       actions sur une dernière rangée. Avant : onze pastilles empilées sur quatre lignes. */
    .rep-filters { display: flex; flex-direction: column; gap: 10px; }
    .rep-selectors { display: flex; gap: 8px; }
    .rep-selectors .rep-dropdown-wrapper { flex: 1; min-width: 0; }
    .rep-selectors .rep-dropdown-trigger { width: 100%; }
    /* ⚠️ DEUX RANGÉES DE DEUX, comme les exports et les périodes le font déjà plus bas.
       À 375 px, .rep-selectors mesure 343 px : à deux menus chacun tenait 167,5 px et son
       libellé 97,5 px — « Livraisons Nord » et « EP-047-TY » se lisaient en entier. Le
       troisième menu (F13) les a serrés à 109 px, soit 39 px de libellé une fois retirés les
       bordures, le remplissage, l'écart et les deux pictogrammes : les trois boutons
       affichaient « Tous… », distinguables au seul pictogramme de 14 px, et les valeurs
       posées tombaient à « Livra… », « EP-0… », « Soh… » — le nom du conducteur, c'est-à-dire
       la seule chose que ce filtre sert à montrer.
       ⚠️ flex-wrap: wrap SEUL ne change rien : avec flex: 1 la base vaut 0, les enveloppes
       ne débordent jamais et ne reviennent donc jamais à la ligne. C'est la BASE de 50 % qui
       déclenche le retour ; le flex-grow déjà posé absorbe ensuite le reste, donc aucune
       largeur n'est figée et une société sans groupe garde ses deux menus côte à côte.
       ⚠️ Borné à 640 px, et surtout PAS sur la règle de base : au-delà, .rep-selectors est
       en display: contents (voir plus bas) et ces enveloppes deviennent enfants directs de
       .rep-filters — leur donner une base y déplacerait toute la barre du bureau. */
    @media (max-width: 640px) {
      .rep-selectors { flex-wrap: wrap; }
      .rep-selectors .rep-dropdown-wrapper { flex-basis: calc(50% - 4px); }
      /* ⚠️ ET ON RÉCUPÈRE LA PLACE À L'INTÉRIEUR DU BOUTON, parce que le retour à la ligne
         ne suffit pas quand la société n'a PAS de groupes.
         Mesuré en production sur « mh cars » (aucun groupe, donc DEUX menus côte à côte, à
         375 px) : bouton 168 px, moins 2 de bordures, 24 de remplissage, 16 de double écart
         et 28 pour les deux pictogrammes = 98 px de libellé. « Sohaib Hamanni » en réclame
         101 et « Tous les véhicules » 113 : le nom du conducteur — la seule chose que ce
         filtre sert à montrer — sortait en « Sohaib Hama… ».
         Le correctif précédent n'avait été mesuré qu'à TROIS menus, cas où le conducteur
         passe seul en seconde rangée et dispose de 343 px : le cas à deux menus, qui est
         celui de la société la plus concernée par ce filtre, lui avait échappé.
         8 px de remplissage et 4 px d'écart rendent 114 px, ce qui loge les deux. */
      .rep-selectors .rep-dropdown-trigger { padding-left: 8px; padding-right: 8px; gap: 4px; }
    }
    /* ⚠️ SOUS 360 px, UN FILTRE PAR RANGÉE. Mesuré à 320 px (iPhone SE) : à deux menus, la
       moitié de 288 px utiles laisse 86 px de libellé — « Sohaib Hamanni » en réclame 101,
       et le nom du conducteur retombait en « Sohaib Ha… ». Récupérer du remplissage ne suffit
       plus à cette largeur : il faut la rangée entière. Une société à trois menus en obtient
       trois, empilés — c'est plus haut, mais tout se lit, et c'est le seul arbitrage qui
       tienne quand la largeur manque vraiment.
       Placé APRÈS le bloc 640 px, jamais avant : à média égal, seul l'ordre tranche. */
    /* ⚠️ SOUS 480 px, UN FILTRE PAR RANGÉE — seuil relevé de 359 px après mesure SUR LA
       PRODUCTION, à 375 px, une fois le nom du conducteur enfin lisible :
       « Tous les conducteurs » (l'état PAR DÉFAUT, celui que tout le monde voit en arrivant)
       réclame 125 px là où une demi-rangée n'en laisse que 114. Récupérer du remplissage a
       sauvé le nom de la personne ; ça ne sauvera pas un libellé de vingt caractères.
       Le coût est d'une rangée de 52 px — à comparer aux 2 161 px que les deux sections
       repliables viennent de rendre. La lisibilité passe avant la compacité quand on a les
       deux moyens de la payer.
       Placé APRÈS le bloc 640 px, jamais avant : à média égal, seul l'ordre tranche. */
    @media (max-width: 480px) {
      .rep-selectors .rep-dropdown-wrapper { flex-basis: 100%; }
    }
    .rep-periods {
      display: flex; gap: 6px; flex-wrap: nowrap;
      overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none;
      /* Marge négative + padding : les pastilles filent jusqu'au bord de l'écran, l'ombre
         de focus n'est pas rognée. */
      margin: 0 -4px; padding: 2px 4px;
    }
    .rep-periods::-webkit-scrollbar { display: none; }
    .rep-periods > * { flex: 0 0 auto; }
    .rep-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    @media (min-width: 641px) {
      .rep-filters { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 8px; }
      .rep-selectors, .rep-periods, .rep-actions { display: contents; }
    }

    /* ─── Liste des trajets : conteneur commun tableau / cartes ─── */
    .rep-list { transition: opacity .15s ease; }

    /* ─── Tri mobile ─── */
    .rep-sortbar {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 10px;
    }
    .rep-sortbar-label { font-size: 12px; font-weight: 600; color: var(--fg-tertiary); white-space: nowrap; }
    .rep-sortbar-select {
      flex: 1; min-width: 0; min-height: 44px;
      padding: 8px 12px; border-radius: 10px;
      background: var(--bg-secondary); color: var(--fg-primary);
      border: 1px solid var(--border-subtle);
      font-size: 13px; font-weight: 600; font-family: inherit;
    }
    .rep-sortbar-dir {
      display: inline-flex; align-items: center; gap: 6px;
      min-height: 44px; padding: 8px 12px; border-radius: 10px;
      background: var(--bg-secondary); color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
      font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
    }
    .rep-sortbar-dir lucide-icon { color: var(--tracky-light); }

    /* ─── Cartes trajet (mobile) ─── */
    .rep-cards { display: flex; flex-direction: column; gap: 10px; }
    .rep-card {
      display: flex; flex-direction: column; gap: 10px;
      padding: 12px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card, 16px);
      min-width: 0;
    }
    /* Le surlignage KPI (rep-row--highlight) est partagé avec le tableau : même flash,
       même bordure d'accent, pour que le geste ait le même retour quel que soit l'écran. */
    .rep-card.rep-row--highlight { border-color: var(--tracky-light, #10E0A0); }
    .rep-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .rep-card-when { display: flex; flex-direction: column; min-width: 0; }
    .rep-card-date { font-size: 14px; font-weight: 700; color: var(--fg-primary); text-transform: capitalize; }
    .rep-card-times { font-size: 12px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; }
    /* ⚠️ 44 px, même si la règle globale ne l'atteint pas. La plaque porte
       role="link" (directive [vehicleLink]), et la liste de styles.css qui impose la
       cible tactile énumère [role='button'] et [role='tab'], mais pas [role='link'].
       Résultat : la SEULE porte vers la fiche véhicule depuis une carte de trajet était
       aussi la plus petite cible de la carte (≈ 24 px). La marge négative rend la
       hauteur ajoutée à l'en-tête, qui ne grandit donc pas. */
    .rep-card-plate {
      flex-shrink: 0;
      display: inline-flex; align-items: center; align-self: center;
      min-height: 44px; margin: -6px 0;
      font-family: var(--font-mono, monospace); font-size: 12px; font-weight: 700;
      letter-spacing: .06em; color: var(--fg-secondary);
      padding: 4px 8px; border-radius: 8px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      cursor: pointer;
    }
    .rep-card-group { display: flex; }
    .rep-card-stats {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
    }
    /* ── LES QUATRE CHIFFRES SUR UNE LIGNE DENSE, AU DOIGT ──────────────────────────────
       En pastilles empilées deux par deux, ils prenaient 114 px sur 453 — pour quatre
       nombres qu'on lit d'un coup d'œil. La grille cède donc la place à une ligne qui
       s'enroule : libellé et valeur côte à côte, sans fond ni remplissage. Mesuré : 114 px
       → 40, soit 74 px rendus sur CHACUNE des cent cartes, près de 7 400 px au total.
       ⚠️ Les libellés RESTENT. « 46 » sans « V. max » n'est plus un chiffre, c'est une
       devinette — et « V. moy » juste à côté rendrait la confusion certaine. C'est le
       CONTENANT qu'on retire, jamais le sens.
       Au-delà de 768 px la grille d'origine reprend : la place ne manque pas, et les
       pastilles s'y lisent mieux. */
    @media (max-width: 768px) {
      .rep-card-stats { display: flex; flex-wrap: wrap; gap: 2px 14px; }
      .rep-card-stat {
        flex-direction: row; align-items: baseline; gap: 5px;
        padding: 0; background: none; border-radius: 0;
      }
      .rep-card-stat-label { font-size: 9.5px; }
      .rep-card-stat-value { font-size: 13.5px; }
    }
    /* ⚠️ L'ancienne bascule à deux colonnes sous 380 px a été RETIRÉE, pas déplacée : la
       ligne dense ci-dessus couvre déjà tout ce qui est sous 768 px, et une règle bornée à
       la fois au-dessus de 768 et en dessous de 380 ne se serait jamais appliquée. */
    /* La bascule du détail : même pastille que « Replay », chevron qui pivote comme celui
       des sections repliables — un seul repère à apprendre dans toute la page. */
    .rep-card-detail { font-size: 12px; font-weight: 700; }
    .rep-card-stat {
      display: flex; flex-direction: column; gap: 2px; min-width: 0;
      padding: 8px 10px; border-radius: 10px;
      background: var(--bg-tertiary);
    }
    .rep-card-stat-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .rep-card-stat-value { font-size: 15px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rep-card-stat-value small { font-size: 10px; font-weight: 600; color: var(--fg-tertiary); }
    .rep-card-stat-value--warn { color: var(--texte-alerte, var(--danger)); }
    .rep-card-analysis { min-width: 0; }
    .rep-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .rep-card-foot-left { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .rep-card-foot-right { display: flex; align-items: center; gap: 6px; margin-left: auto; }
    .rep-card-action {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      min-height: 44px; min-width: 44px; padding: 8px 12px; border-radius: 10px;
      background: var(--bg-tertiary); color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
      font-size: 12px; font-weight: 700; cursor: pointer;
    }
    .rep-card-action--replay {
      color: var(--texte-succes);
      background: rgba(16,224,160,.08); border-color: rgba(16,224,160,.22);
    }
    .rep-card-action--replay lucide-icon { color: var(--tracky-light); }
    /* Les chips conducteur / note viennent du tableau : au doigt, 44 px de haut. */
    .rep-card .rep-driver, .rep-card .rep-note { min-height: 44px; }
    /* ⚠️ Sur une carte, la note prend sa propre ligne et se lit sur trois lignes plutôt
       que de se couper à 180 px derrière un attribut title que le doigt n'atteint jamais.
       Le tap la déplie en entier (cf. basculerNote). */
    .rep-card .rep-note--filled { flex: 1 1 100%; min-width: 0; align-items: flex-start; }
    .rep-card .rep-note-text {
      white-space: normal;
      max-width: none;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.45;
    }
    .rep-card .rep-note--depliee .rep-note-text { display: block; overflow: visible; }

    /* ─── Exports : une rangée défilante au doigt plutôt que quatre lignes ─── */
    @media (max-width: 640px) {
      .rep-export-group {
        flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;
        max-width: 100%; padding-bottom: 2px;
      }
      .rep-export-group::-webkit-scrollbar { display: none; }
      .rep-export-btn { flex: 0 0 auto; }
    }

    /* ══ SOUS 430 px, ON REVIENT AU RETOUR À LA LIGNE ═══════════════════════════════
       La rangée défilante convient tant qu'on devine qu'elle défile. À 375 px, le
       QUATRIÈME bouton d'export (« Excel ») et la pastille « Personnalisé » étaient coupés
       en plein mot au bord de l'écran, sans ombre ni flèche : rien ne disait qu'il restait
       quelque chose à droite, et l'utilisateur concluait que la fonction n'existait pas sur
       téléphone.

       Deux rangées de deux valent mieux qu'une rangée dont on ne voit pas la fin. ⚠️ Le
       seuil est à 430 px et non 375 : entre les deux (iPhone Pro Max, Pixel), la même
       coupure se produit, un cran plus loin. */
    @media (max-width: 430px) {
      .rep-export-group {
        flex-wrap: wrap; overflow-x: visible;
      }
      .rep-export-btn { flex: 1 1 calc(50% - 3px); justify-content: center; }
      .rep-periods {
        flex-wrap: wrap; overflow-x: visible;
      }
      .rep-periods > *, .rep-custom-wrapper { flex: 1 1 calc(50% - 3px); }
      .rep-custom-wrapper > .rep-periode { width: 100%; justify-content: center; }
    }

    /* ─── Synthèse par véhicule (réf. maquette Rapports) ─── */
    .rep-vsum { margin-bottom: 16px; }
    .rep-vsum-head { margin-bottom: 12px; }
    .rep-vtable { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 16px); overflow: hidden; }
    .rep-vt-head, .rep-vrow { display: grid; grid-template-columns: minmax(160px,1.8fr) 1fr 1fr .9fr 1fr .9fr 76px 70px; align-items: center; gap: 14px; padding: 12px 18px; }
    .rep-vt-head { background: var(--surface-rail); border-bottom: 1px solid var(--border-subtle); font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--fg-tertiary); }
    .rep-vrow { border-top: 1px solid var(--border-subtle); transition: background .15s; }
    .rep-vrow:hover { background: var(--bg-tertiary); }
    .rep-vveh { min-width: 0; }
    .rep-vplate { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--fg-primary); }
    .rep-vmodel { font-size: 11px; color: var(--fg-tertiary); margin-top: 1px; }
    .rep-vdist { font-size: 15px; font-weight: 800; color: var(--fg-primary); }
    .rep-vunit { font-size: 10px; font-weight: 600; color: var(--fg-tertiary); }
    .rep-vmeta { font-size: 13px; color: var(--fg-secondary); }
    /* ⚠️ --warning (#C98708 en clair) sur du texte de 13 px donne 2,68:1 — c'est
       exactement le cas pour lequel --texte-attente a été créé. Et le signal « vitesse
       moyenne ≥ 50 km/h » est une alerte métier : il ne peut pas être le texte le moins
       lisible de la ligne. Le triangle double la couleur, pour ne pas reposer sur elle
       seule. */
    .rep-vspeed-warn { color: var(--texte-attente); font-weight: 600; }
    .rep-vspeed-warn::before { content: '▲'; font-size: 9px; margin-right: 3px; }
    /* « Voir › » écrit en toutes lettres : le chevron seul n'était l'indice de rien, et
       l'en-tête de la section promettait un contrôle nommé « Voir » qui n'existait pas. */
    .rep-vgo {
      display: inline-flex; align-items: center; justify-content: flex-end; gap: 2px;
      justify-self: end;
      min-width: 44px;
      font-size: 12px; font-weight: 700; color: var(--texte-succes);
      white-space: nowrap;
    }
    .rep-vexces { display: flex; align-items: baseline; gap: 6px; font-size: 13px; color: var(--fg-secondary); font-variant-numeric: tabular-nums; }
    .rep-vexces b { font-weight: 800; color: var(--fg-primary); }
    .rep-vexces small { font-size: 11px; color: var(--fg-tertiary); }
    /* ⚠️ Le rouge ne porte JAMAIS l'information seul (WCAG 1.4.1) : le nombre et le pire
       dépassement sont écrits, et le lecteur d'écran reçoit la phrase entière. */
    .rep-vexces--fort b { color: var(--texte-alerte); }
    .rep-vexces-vide { color: var(--fg-tertiary); }
    .rep-vexces-h { font: inherit; }
    .rep-vfiltre { min-height: 32px; padding: 5px 10px; border-radius: 8px; font-size: 11.5px; font-weight: 700;
                   background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-subtle); cursor: pointer; }
    .rep-vfiltre:hover { color: var(--fg-primary); border-color: var(--tracky-light, #10E0A0); }
    /* Au doigt seulement : à la souris, 44 px de haut allongeraient inutilement chaque ligne
       de la synthèse. Le « Voir › » de la ligne voisine le fait déjà ; « Filtrer », lui, ne
       l'obtenait qu'à 480 px et restait à 32 px sur toute la bande 481-768 px — la tablette
       d'atelier tenue en main. styles.css porte pourtant depuis le 2026-08-17 une règle
       globale de TYPE (44 px à tout bouton sous 768 px), écrite après un relevé de 111 cibles
       trop petites sur 25 écrans ; le sélecteur de classe (0,1,0, et 0,2,0 sous l'encapsulation
       émulée d'Angular) l'écrase. Cela répare du même geste le « Filtrer » de la vue par
       véhicule, qui était sous le seuil à TOUTES les largeurs, 375 px compris.

       ⚠️ PLACÉ APRÈS LA RÈGLE DE BASE, ET C'EST TOUT L'ENJEU. Une media query n'ajoute AUCUNE
       spécificité : les deux déclarations de min-height pèsent pareil, c'est l'ORDRE qui
       tranche. Écrit AU-DESSUS de la règle de base — comme il l'était —, ce bloc est inerte :
       mesuré au banc statique à 375 px comme à 700 px, le bouton restait à 32 px, exactement
       comme si la media query n'existait pas. Ne pas le remonter, et ne rien déclarer d'autre
       sur cette classe en dessous. */
    @media (max-width: 768px) {
      .rep-vgo, .rep-vfiltre { min-height: 44px; }
    }
    .rep-vchev { color: inherit; transition: transform .15s ease; }
    .rep-vrow:hover .rep-vchev { transform: translateX(2px); }
    /* La colonne Excès reste visible sur tablette : c'est la question qu'on vient poser
       à ce tableau, pas un détail qu'on masque au premier resserrement. */
    @media (max-width: 1000px) {
      .rep-vt-head, .rep-vrow { grid-template-columns: minmax(140px,1.6fr) 1fr 1fr .9fr 76px 74px; }
      .rep-vt-hide { display: none !important; }
    }
    /* Sous 480 px, quatre colonnes ne tiennent plus : la ligne devient une carte à deux
       colonnes (plaque en tête, chiffres dessous), le chevron reste à droite. */
    @media (max-width: 480px) {
      .rep-vt-head { display: none; }
      .rep-vrow { grid-template-columns: 1fr 1fr 56px; grid-template-areas: 'veh veh voir' 'dist meta voir' 'exces filtre voir'; gap: 6px 10px; padding: 12px 14px; }
      .rep-vrow > .rep-vveh { grid-area: veh; }
      .rep-vrow > .rep-vgo { grid-area: voir; align-self: center; }
      .rep-vrow > :nth-child(2) { grid-area: dist; }
      .rep-vrow > :nth-child(3) { grid-area: meta; }
      .rep-vrow > .rep-vexces { grid-area: exces; justify-self: start; }
      .rep-vrow > .rep-vfiltre { grid-area: filtre; justify-self: start; }
    }
    /* ══ BASCULE VÉHICULE / CONDUCTEUR OU GROUPE (F13) ════════════════════════════════
       Un vrai groupe de boutons : l'état vit dans aria-pressed, pas dans une classe que
       seul l'œil voit. La coche double la teinte, pour que « actif » ne repose jamais sur
       la seule couleur (WCAG 1.4.1). */
    .rep-vseg { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 3px; margin-bottom: 12px;
                border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .rep-vseg-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 6px 12px;
                    border: 1px solid transparent; border-radius: 8px; background: transparent;
                    color: var(--fg-secondary); font-size: 12.5px; font-weight: 700; cursor: pointer; }
    .rep-vseg-btn:hover:not(:disabled) { color: var(--fg-primary); }
    .rep-vseg-btn[aria-pressed="true"] { background: var(--bg-secondary); color: var(--fg-primary);
                                         border-color: var(--border-subtle); }
    .rep-vseg-btn[aria-pressed="true"]::before { content: '✓'; font-size: 11px; font-weight: 800; color: var(--texte-succes); }
    /* Indisponible, jamais masqué : le motif est écrit juste dessous. */
    .rep-vseg-btn:disabled { opacity: .55; cursor: not-allowed; }
    /* Au doigt : 44 px de haut sur TOUTE la bande tactile, pas seulement sous 480 px. La
       bascule restait à 34 px entre 481 et 768 px — la tablette d'atelier tenue en main —,
       sous le seuil que le reste de l'écran respecte, et le bloc de 480 px juste dessous
       laissait croire le contraire. Même défaut, même correction et même raison que le
       Filtrer de la synthèse (cf. le bloc 768 px plus haut) : la règle globale de TYPE de
       styles.css est écrasée par un sélecteur de classe.

       ⚠️ PLACÉ APRÈS LA DÉCLARATION DE BASE, ET C'EST TOUT L'ENJEU. Une media query n'ajoute
       AUCUNE spécificité : les deux min-height pèsent pareil, seul l'ORDRE tranche. Écrit
       au-dessus, ce bloc serait strictement inerte — c'est la faute déjà payée sur
       .rep-vfiltre, invisible à la relecture et visible au banc statique. MESURÉ ici, pas
       déduit — banc statique servi en HTTP, hauteur du bouton à 375 / 481 / 700 / 769 px :
         · avant : 44 / 34 / 34 / 34 px (les 44 px de 375 px viennent du bloc 480 px) ;
         · après : 44 / 44 / 44 / 34 px, le retour à 34 px au-delà du seuil étant voulu ;
         · le même bloc écrit AU-DESSUS de la base : 34 px aux quatre largeurs, inerte.
       Ne pas le remonter, et ne rien déclarer d'autre en dessous sur cette classe. */
    @media (max-width: 768px) {
      .rep-vseg-btn { min-height: 44px; }
    }
    .rep-vseg-motif { margin: -6px 0 12px; font-size: 11.5px; line-height: 1.45; color: var(--fg-tertiary); }
    /* Nom d'une personne ou d'un groupe : PAS la police à chasse fixe des plaques. */
    .rep-vnom { font-size: 13.5px; font-weight: 700; color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Sept colonnes au lieu de huit : pas de « Voir » — une ligne d'imputation n'ouvre
       aucune fiche —, mais bien un « Filtrer », qui pose le filtre conducteur (F13). La
       septième colonne reste VIDE sur une ligne de groupe : le filtre groupe de la barre
       porte sur les véhicules, pas sur cette imputation. */
    .rep-vt-head--attr, .rep-vrow--attr { grid-template-columns: minmax(160px,2fr) 1fr 1fr .9fr 1fr .9fr 76px; }
    .rep-vrow--attr:hover { background: transparent; }
    .rep-vrow--vide { display: block; padding: 18px; font-size: 12.5px; color: var(--fg-tertiary); }
    /* Mention des trajets qu'on ne peut imputer à personne — même forme que l'écran des
       scores, pour que le gestionnaire reconnaisse la phrase d'un écran à l'autre. */
    .rep-vnon-attribue {
      display: flex; align-items: flex-start; gap: 10px; margin-top: 12px; padding: 12px 14px;
      border-radius: 12px; font-size: 13px; line-height: 1.5; color: var(--fg-secondary);
      border: 1px solid color-mix(in srgb, var(--texte-attente) 35%, transparent);
      background: color-mix(in srgb, var(--texte-attente) 8%, transparent);
    }
    .rep-vnon-attribue lucide-icon { color: var(--texte-attente); flex-shrink: 0; margin-top: 2px; }
    .rep-vnon-attribue strong { color: var(--fg-primary); }
    .rep-vnon-attribue a { color: var(--texte-succes); font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
    @media (max-width: 1000px) {
      /* Les deux colonnes masquées (Trajets, V. moy) partent ; « Filtrer » RESTE : c'est le
         geste que ce tableau offre, pas une décoration de grand écran. */
      .rep-vt-head--attr, .rep-vrow--attr { grid-template-columns: minmax(140px,2fr) 1fr 1fr .9fr 76px; }
    }
    /* Au doigt : la bascule occupe la largeur et chaque position fait 44 px de haut —
       critère de recette du dépôt à 375 px. */
    @media (max-width: 480px) {
      .rep-vseg { display: flex; width: 100%; }
      .rep-vseg-btn { flex: 1 1 0; min-height: 44px; justify-content: center; text-align: center; }
      /* La zone « filtre » EXISTE même sur une ligne de groupe, qui n'y met qu'un span vide :
         sans elle, le bouton des lignes conducteur retomberait dans une zone implicite et se
         placerait au hasard de l'ordre du DOM. */
      .rep-vrow--attr { grid-template-columns: 1fr 1fr; grid-template-areas: 'veh veh' 'dist meta' 'exces filtre'; }
      .rep-vrow--attr > .rep-vveh { grid-area: veh; }
      .rep-vrow--attr > :nth-child(2) { grid-area: dist; }
      .rep-vrow--attr > :nth-child(3) { grid-area: meta; }
      .rep-vrow--attr > .rep-vexces { grid-area: exces; justify-self: start; }
      /* Les 44 px au doigt viennent du bloc ≤ 768 px ci-dessus, qui couvre les DEUX vues :
         les répéter ici laisserait croire que la hauteur ne vaut que sous 480 px. */
      .rep-vrow--attr > .rep-vfiltre { grid-area: filtre; justify-self: end; }
    }

    /* ══ LES COLONNES QUI REVIENNENT SUR LE PAPIER ════════════════════════════════════
       ⚠️ PLACÉ APRÈS LES BLOCS ≤ 1000 px, ET C'EST TOUT L'ENJEU. Une media query n'ajoute
       AUCUNE spécificité : « .rep-vt-hide { display: block !important } » écrit dans le bloc
       « @media print » du haut pesait exactement autant que le « display: none !important »
       du bloc ≤ 1000 px placé 600 lignes plus bas, et perdait donc sur l'ORDRE. Or une A4
       PORTRAIT fait 794 px CSS (717 px avec les marges par défaut de Chrome) : la condition
       « max-width: 1000px » y est VRAIE. La règle du haut n'agissait qu'en A4 paysage —
       l'orientation que personne ne choisit. Même faute que celle déjà payée deux fois dans
       ce fichier, sur .rep-vfiltre et .rep-vseg-btn.

       MESURÉ, PAS DÉDUIT — banc statique servi en HTTP avec le CSS RÉELLEMENT ÉMIS par le
       build (apps/web/dist/web), Chromium en media=print, DOM fidèle des deux tableaux :
         · avant, 794 px et 717 px : .rep-vt-hide = none, en-tête « Par conducteur ou groupe »
           réduit à [Conducteur ou groupe, Distance, Conduite, Excès, (vide)] pour 5 pistes,
           et la ligne à 4 cellules — 76 px de colonne morte à droite de chaque page ;
         · avant, 1122 px (paysage) : block, 7 pistes ;
         · après : block et 6 cellules pour 6 pistes aux trois largeurs.
       Ne pas remonter ce bloc, et ne rien déclarer d'autre sur .rep-vt-hide en dessous.

       Les grilles sont REPOSÉES ici : sans elles, les colonnes revenues se placeraient dans
       les 5 (ou 6) pistes du bloc ≤ 1000 px et l'en-tête se replierait sur une seconde
       rangée. Les pistes de fin tombent avec leurs contrôles — « Filtrer » et « Voir › » sont
       masqués à l'impression, leur colonne ne laisserait qu'un vide. */
    @media print {
      .rep-vt-hide { display: block !important; }
      .rep-vt-head, .rep-vrow { grid-template-columns: minmax(140px, 1.8fr) 1fr 1fr .9fr 1fr .9fr; }
      .rep-vt-head--attr, .rep-vrow--attr { grid-template-columns: minmax(140px, 2fr) 1fr 1fr .9fr 1fr .9fr; }
      /* Les cellules de remplissage (une dans l'en-tête « attr » et sur une ligne de GROUPE,
         deux dans l'en-tête par véhicule) n'ont plus de piste : sans cela elles créeraient une
         seconde rangée sous chaque en-tête. */
      .rep-vt-head > span:nth-child(n + 7) { display: none; }
      .rep-vrow--attr > span:nth-child(7) { display: none; }
    }
  `],
})
export class ReportsComponent implements OnInit, OnDestroy {
  private readonly tripsApi = inject(TripsApiService);
  /** Lue UNE fois au démarrage (cf. `ngOnInit`) ; l'écriture passe par `majParametresUrl`. */
  private readonly route = inject(ActivatedRoute);
  private readonly preferences = inject(PreferencesService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly driversApi = inject(DriversApiService);
  private readonly perms = inject(PermissionsService);
  private readonly authService = inject(AuthService);
  private readonly toast = inject(ToastService);

  /**
   * Qui VOIT la carte du rapport hebdomadaire : les rôles qui pilotent une flotte, à condition
   * de pouvoir consulter les rapports. Même périmètre que `GET /api/reports/schedule` — un écran
   * qui montre une carte dont l'API refusera la lecture ne fait qu'afficher une erreur.
   */
  protected readonly canSeeSchedule = computed(() => {
    const r = this.authService.user()?.role;
    return (r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN' || r === 'FLEET_MANAGER') && this.perms.can('reports_view');
  });

  /**
   * Qui peut le MODIFIER : le droit d'export, celui-là même qu'exige l'API. Un gestionnaire à
   * qui on l'a retiré voit le réglage et la prochaine échéance, sans les commandes — plutôt
   * qu'un bouton qui échouerait en 403.
   */
  protected readonly canEditSchedule = computed(() => this.perms.can('reports_export'));

  /**
   * Un super-admin qui regarde « toutes les sociétés » n'a pas de société courante, et le
   * rapport hebdomadaire n'a de sens que pour une : la carte invite alors à en choisir une
   * dans le sélecteur du haut, au lieu d'afficher le refus de l'API.
   */
  protected readonly scheduleNeedsFleetChoice = computed(() =>
    this.authService.user()?.role === 'SUPER_ADMIN' && !this.fleetFilter.selectedFleetId(),
  );
  private readonly reportsApi = inject(ReportsApiService);
  /** `protected` : le gabarit passe la société courante à la carte de réglage
   *  hebdomadaire, et un gabarit Angular ne peut pas lire un membre privé. */
  protected readonly fleetFilter = inject(FleetFilterService);
  private readonly analysisApi = inject(TripAnalysisApiService);
  protected readonly exporting = signal<null | 'pdf' | 'csv-trips' | 'csv-summary' | 'excel'>(null);

  // Recharge le rapport (KPI/trajets/charts scopés serveur) quand la société change dans
  // le sélecteur global. On saute le 1er run (le chargement initial se fait via ngOnInit).
  private prevFleet: string | null | undefined = undefined;
  private readonly fleetReloadEffect = effect(() => {
    const sel = this.fleetFilter.selectedFleetId();
    if (this.prevFleet === undefined) { this.prevFleet = sel; return; }
    if (sel !== this.prevFleet) {
      this.prevFleet = sel;
      // Un véhicule/groupe choisi peut appartenir à l'ancienne société → on repart sur le
      // rapport « toute la flotte » de la nouvelle société.
      this.selectedVehicleId.set('');
      this.selectedGroupId.set('');
      // ⚠️ Le conducteur AUSSI : il appartient à une société. Le garder ferait demander au
      // serveur les trajets d'une personne d'un autre client — zéro ligne, sous un nom qui
      // reste affiché dans le menu, donc un rapport « vide » parfaitement crédible.
      this.selectedDriverId.set('');
      // La liste est rechargée : le menu la borne déjà à la société affichée
      // (`driverOptions`), mais un conducteur créé entre-temps chez le client qu'on vient
      // d'ouvrir doit y figurer — sinon le filtre ne propose personne là où il y a du monde.
      void this.loadDrivers();
      // ⚠️ La synthèse de la société PRÉCÉDENTE doit partir avec elle : sans cela, la vue « par
      // conducteur ou groupe » gardait, le temps du chargement, les conducteurs d'un autre client
      // sous le nom de la nouvelle société (revue du 2026-09-05).
      this.oublierStatsPeriode();
      /**
       * ⚠️ ET LA MÉMOIRE DE L'ÉTAT AVEC, sinon effacer les filtres ne sert à rien.
       *
       * Les trois `set('')` ci-dessus ne touchent QUE la mémoire de l'écran. La barre d'adresse,
       * elle, gardait `driver=` (et `vehicle=`, `group=`) de la société qu'on vient de quitter —
       * le sélecteur de société ne navigue pas, il ne fait que poser un signal. Au F5 réflexe,
       * `ngOnInit` relit ces paramètres, la FORME est valide (c'est bien un UUID), et le rapport
       * s'ouvre borné sur une personne d'un autre client : zéro ligne et « Aucun trajet pour
       * cette période » pour une société qui en compte des milliers. C'est exactement le
       * « rapport vide parfaitement crédible » que le commentaire ci-dessus dit empêcher.
       *
       * La vue mémorisée part d'abord : elle ne porte AUCUNE société, donc elle n'appartient
       * qu'à celle qui l'a écrite. `ecrireEtatDansUrl` ne l'écrase pas quand la query est vide
       * (période par défaut, aucun filtre) — « Reprendre votre dernier rapport » reposerait
       * alors le conducteur étranger par l'autre porte, et le libellé annoncerait
       * « un conducteur » sans pouvoir le nommer.
       */
      this.preferences.update({ reportsLastView: '' });
      this.ecrireEtatDansUrl();
      void this.loadData();
    }
  });

  protected readonly vehicles = signal<VehicleDetailDto[]>([]);
  protected readonly trips = signal<TripDto[]>([]);
  protected readonly dailySummary = signal<TripDailySummaryDto[]>([]);
  protected readonly loading = signal(true);
  /**
   * Message de PANNE du chargement, distinct de l'etat « aucun trajet ».
   *
   * ⚠️ Les deux « catch » de loadData() renvoyaient une liste VIDE : une panne serveur, un
   * 403 ou une session expiree s'affichaient donc « Aucun trajet pour cette periode » —
   * la reponse metier d'une periode reellement sans trajet. Le gestionnaire en concluait
   * que ses vehicules n'avaient pas roule.
   */
  /**
   * ⚠️ DEUX pannes distinctes, et non une seule.
   *
   * `loadData` lance deux requêtes indépendantes : la LISTE de trajets et le RÉSUMÉ
   * journalier (d'où viennent tous les KPI et le graphique d'activité). Un seul signal
   * les confondait, et `loadTrips` — le re-tri — le remettait à `null` dès que la liste
   * répondait. Conséquence mesurée : résumé en panne, KPI à zéro, bandeau ambre ; un clic
   * sur un en-tête de colonne faisait disparaître le bandeau, les KPI restaient à zéro et
   * plus rien ne disait que la vue était incomplète. Un tri réussi effaçait le seul
   * avertissement de l'écran.
   */
  private readonly tripsError = signal<string | null>(null);
  private readonly summaryError = signal<string | null>(null);
  /** Message affiché : la panne de la liste prime, elle est la plus visible. */
  protected readonly loadError = computed(() => this.tripsError() ?? this.summaryError());
  protected readonly recomputing = signal(false);
  /**
   * Liste des véhicules : état de chargement et panne éventuelle (cf. `loadVehicles`).
   * Tout le rendu des plaques, des groupes, du sélecteur et de la modale PDF en dépend.
   */
  protected readonly vehiclesLoading = signal(true);
  protected readonly vehiclesError = signal<string | null>(null);
  /** Note dépliée sur place (rôle sans droit d'édition) — cf. `basculerNote`. */
  protected readonly noteDepliee = signal<string | null>(null);
  protected readonly replayTrip = signal<TripDto | null>(null);
  protected readonly noteEditTrip = signal<TripDto | null>(null);
  protected readonly driverPickerTrip = signal<TripDto | null>(null);
  /** Traçabilité fine (Palier 4c) — analyses des trajets du VÉHICULE sélectionné (par tripId). */
  protected readonly analysesMap = signal<Map<string, TripAnalysisDto>>(new Map());
  /** Phase 3 — Modal d'export PDF configurable (perimetre + sections + caps). */
  protected readonly pdfModalOpen = signal(false);

  protected readonly selectedVehicleId = signal('');
  protected periodFrom = '';
  protected periodTo = '';
  /** Signal annexe synchronise avec periodFrom/periodTo (qui ne sont pas des
   * signals pour eviter de casser tous les bindings du template). Sert
   * uniquement aux `computed()` qui ont besoin de reagir aux changements de
   * periode (ex: isCustomRange, customRangeLabel). */
  private readonly periodKey = signal('');

  protected readonly Route = Route;
  protected readonly BarChart3 = BarChart3;
  protected readonly Clock = Clock;
  protected readonly Gauge = Gauge;
  protected readonly Play = Play;
  protected readonly ChevronDown = ChevronDown;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly TruckIcon = Truck;
  protected readonly Check = Check;
  protected readonly LayersIcon = Layers;
  protected readonly MessageSquareIcon = MessageSquare;
  protected readonly PencilIcon = Pencil;
  protected readonly UserRoundIcon = UserRound;
  protected readonly DownloadIcon = Download;
  protected readonly CalendarIcon = Calendar;
  protected readonly FileTextIcon = FileText;
  protected readonly ArrowUpIcon = ArrowUp;
  protected readonly ArrowDownIcon = ArrowDown;
  protected readonly ArrowUpDownIcon = ArrowUpDown;
  protected readonly FileSpreadsheetIcon = FileSpreadsheet;
  protected readonly RotateCcwIcon = RotateCcw;
  protected readonly MousePointerClickIcon = MousePointerClick;
  protected readonly FuelIcon = Fuel;
  protected readonly AlertTriangleIcon = AlertTriangle;
  /** Bascule « Par conducteur ou groupe » — même icône que la 4ᵉ portée des scores. */
  protected readonly UsersIcon = Users;

  // ─── Date range custom ────────────────────────────────────────────────
  protected readonly customRangeOpen = signal(false);
  protected readonly customFrom = signal('');
  protected readonly customTo = signal('');
  /**
   * LE JOUR CIVIL COURANT (AAAA-MM-JJ, heure locale), en SIGNAL.
   *
   * ⚠️ Tout ce qui est daté sur cet écran en descend : les pastilles de période, les
   * raccourcis du panneau « Personnalisé » et la borne « pas de futur » du calendrier.
   * Ces trois-là étaient figés à la construction du composant — et cet écran vit dans
   * une PWA qu'on laisse ouverte sur une tablette d'atelier. Le lendemain matin :
   * « Aujourd'hui » chargeait la veille, le calendrier refusait de choisir aujourd'hui,
   * et l'export partait sur une période différente de celle affichée.
   *
   * Le signal est rafraîchi à trois moments : au retour dans l'onglet
   * (`visibilitychange`), à minuit par une minuterie, et avant tout export.
   */
  private readonly jourCourant = signal(todayIsoLocal());

  /** Aujourd'hui au format YYYY-MM-DD heure LOCALE (limite haute du date picker
   *  + borne no-future). Local pour rester cohérent avec localIso/buildPeriods. */
  protected get todayIso(): string { return this.jourCourant(); }

  /** Minuterie qui bascule le jour à minuit passé, sans attendre une interaction. */
  private minuitTimer: ReturnType<typeof setTimeout> | null = null;

  private armerBasculeDeMinuit(): void {
    if (this.minuitTimer) clearTimeout(this.minuitTimer);
    const maintenant = new Date();
    // Cinq secondes après minuit : on veut être du bon côté de la frontière, pas dessus.
    const minuit = new Date(
      maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate() + 1, 0, 0, 5,
    );
    this.minuitTimer = setTimeout(() => {
      this.rafraichirJour();
      this.armerBasculeDeMinuit();
    }, Math.max(1000, minuit.getTime() - maintenant.getTime()));
  }

  /**
   * Réaligne le jour courant, et AVEC LUI la période affichée si elle correspondait à
   * une pastille.
   *
   * ⚠️ Le réalignement passe par `setPeriod`, donc RECHARGE. L'ancien
   * `refreshPeriodIfStalePreset` se contentait de réécrire `periodFrom`/`periodTo` en
   * silence juste avant un export : le fichier couvrait alors une période que l'écran
   * n'avait jamais montrée.
   */
  private rafraichirJour(): void {
    const jour = todayIsoLocal();
    if (jour === this.jourCourant()) return;
    const index = this.periods().findIndex(
      (p) => p.from === this.periodFrom && p.to === this.periodTo,
    );
    this.jourCourant.set(jour);
    if (index >= 0) {
      const frais = this.periods()[index]!;
      this.setPeriod(frais.from, frais.to);
    }
  }

  /** Ouvre / ferme le panneau « Personnalisé » en rafraîchissant les raccourcis datés. */
  protected toggleCustomRange(): void {
    if (!this.customRangeOpen()) {
      this.rafraichirJour();
      this.presetsNow.update((n) => n + 1);
    }
    this.customRangeOpen.set(!this.customRangeOpen());
  }

  /** Ferme le panneau de plage personnalisée en rendant le focus à son déclencheur. */
  protected fermerPlagePerso(): void {
    this.customRangeOpen.set(false);
    this.rendreLeFocus(this.customTriggerEl());
  }

  /** True quand viewport >= 768px : calendrier inline. Sinon : inputs natifs.
   *  Mis a jour live via matchMedia. */
  protected readonly isDesktop = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  );
  private readonly desktopMql =
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)') : null;
  private readonly desktopMqlListener = (e: MediaQueryListEvent) => this.isDesktop.set(e.matches);

  /** True si periodFrom/periodTo correspondent a une plage custom (et non un preset). */
  protected readonly isCustomRange = computed(() => {
    this.periodKey(); // dependance explicite pour declencher le re-calcul
    if (!this.periodFrom || !this.periodTo) return false;
    return !this.periods().some((p) => p.from === this.periodFrom && p.to === this.periodTo);
  });

  /**
   * Une date CIVILE (AAAA-MM-JJ) lue en heure LOCALE.
   *
   * ⚠️ `new Date('2026-03-12')` vaut minuit UTC, c'est-à-dire la VEILLE au soir pour un
   * utilisateur à l'ouest de Greenwich. Aux Antilles ou en Guyane (UTC−4 / UTC−3, des
   * flottes françaises), « 12 mars → 18 mars » s'affichait « 11 mars → 17 mars ». Le
   * défaut est invisible en métropole, ce qui le rend durable. Midi local met la valeur
   * à l'abri de tout fuseau et de tout changement d'heure.
   */
  /**
   * ── UN JOUR N'EST PAS 86 400 000 MILLISECONDES ──────────────────────────────────────
   *
   * Les périodes étaient calculées en soustrayant `N × 86 400 000`. Aux deux week-ends de
   * changement d'heure, une journée civile dure 23 ou 25 heures : « 30 derniers jours »
   * couvrait alors 29 ou 31 jours, et « Hier » pouvait tomber sur avant-hier. Le décalage
   * est d'une heure, mais il traverse minuit — donc il change de JOUR.
   *
   * `setDate` fait de l'arithmétique de CALENDRIER en heure locale : il connaît les mois de
   * 28 jours comme les journées de 23 heures. C'est déjà ce que fait le calcul du lundi de
   * la semaine, quelques lignes plus bas ; il n'y avait aucune raison que le reste diffère.
   */
  private ajouterJours(d: Date, jours: number): Date {
    const copie = new Date(d);
    copie.setDate(copie.getDate() + jours);
    return copie;
  }

  private dateCivileLocale(iso: string): Date {
    return new Date(`${iso}T12:00:00`);
  }

  /** Label compact de la plage active (ex: "12 mars → 18 mars"). */
  protected readonly customRangeLabel = computed(() => {
    this.periodKey(); // dependance explicite pour declencher le re-calcul
    if (!this.isCustomRange()) return '';
    try {
      const f = this.dateCivileLocale(this.periodFrom);
      const t = this.dateCivileLocale(this.periodTo);
      const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
      // Le `to` est toujours +1 jour (exclusif) cote periods → on retire 1 jour pour l'affichage.
      const tDisplay = this.ajouterJours(t, -1);
      return `${fmt(f)} → ${fmt(tDisplay)}`;
    } catch { return 'Personnalisée'; }
  });

  /**
   * Sprint 5 — Normalisation centralisée de la plage perso (auto-fill +
   * cohérence + no-future + max 365j), déléguée au helper pur testable
   * `normalizeCustomRange` (cf. reports.utils). Réagit à customFrom/customTo.
   */
  protected readonly normalizedCustomRange = computed(() =>
    normalizeCustomRange({ from: this.customFrom(), to: this.customTo() }, this.todayIso),
  );

  /** Validation : retourne le message d'erreur du helper ('' si OK). */
  protected readonly customRangeError = computed(() => this.normalizedCustomRange().error);

  /** True si la plage saisie est applicable (helper). Pilote le bouton Appliquer. */
  protected readonly customRangeValid = computed(() => this.normalizedCustomRange().valid);

  /** Presets dynamiques (calculés au render pour rester relatifs à aujourd'hui). */
  /**
   * Ré-évalué à chaque OUVERTURE du panneau (cf. `openCustomRange`) : une PWA laissée
   * ouverte après minuit proposait « Hier » et « 7 derniers jours » d'hier.
   */
  private readonly presetsNow = signal(0);

  protected readonly customPresets = computed(() => {
    this.presetsNow();
    // Dépendance explicite au jour civil : après minuit, « Hier » désignait avant-hier.
    this.jourCourant();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // ⚠️ HEURE LOCALE, pas toISOString (UTC) : en France, minuit local = 22:00 ou 23:00 UTC
    //    la veille, donc « Hier » tombait sur avant-hier et « 7 derniers jours » excluait
    //    aujourd'hui. Même convention que `localIso` et que les pastilles de la barre.
    const iso = (d: Date) => this.localIso(d);
    const tomorrow = this.ajouterJours(today, 1);
    const yesterday = this.ajouterJours(today, -1);
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7)); // lundi
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    // 7 et 30 jours civils, aujourd'hui compris — même règle que les pastilles.
    const days7 = this.ajouterJours(today, -6);
    const days30 = this.ajouterJours(today, -29);
    return [
      { label: "Hier", from: iso(yesterday), to: iso(today) },
      { label: "Cette semaine", from: iso(startOfWeek), to: iso(tomorrow) },
      { label: "7 derniers jours", from: iso(days7), to: iso(tomorrow) },
      { label: "30 derniers jours", from: iso(days30), to: iso(tomorrow) },
      { label: "Ce mois-ci", from: iso(startOfMonth), to: iso(tomorrow) },
      { label: "Mois dernier", from: iso(startOfLastMonth), to: iso(endOfLastMonth) },
    ];
  });

  protected applyPreset(preset: { from: string; to: string }): void {
    this.setPeriod(preset.from, preset.to);
    this.customRangeOpen.set(false);
  }

  /**
   * Applique la plage saisie dans les 2 inputs date.
   * Sprint 5 — passe par `normalizeCustomRange` (auto-fill « jusqu'à » =
   * aujourd'hui si vide, clamp no-future, coherence from<=to, max 365j). La
   * plage normalisée est INCLUSIVE → on convertit le `to` en exclusif (+1 jour,
   * convention `periods` existante) avant `setPeriod`. On réinjecte aussi le
   * `to` auto-rempli dans le signal pour que l'UI reflète ce qui a été appliqué.
   */
  protected applyCustomRange(): void {
    const norm = this.normalizedCustomRange();
    if (!norm.valid) return;
    // Si le `to` a été auto-rempli (saisie « from » seule), on le reflète dans
    // l'input pour cohérence visuelle.
    if (norm.to !== this.customTo()) this.customTo.set(norm.to);
    if (norm.from !== this.customFrom()) this.customFrom.set(norm.from);
    const tDate = new Date(`${norm.to}T00:00:00`);
    tDate.setDate(tDate.getDate() + 1);
    const tExclusive = this.localIso(tDate);
    this.setPeriod(norm.from, tExclusive);
    this.customRangeOpen.set(false);
  }

  /** Roles autorises a editer/effacer la note d'un trajet. */
  protected readonly canEditNotes = computed(() => {
    const r = this.authService.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN' || r === 'FLEET_MANAGER';
  });

  /** Roles autorises a (re)affecter un conducteur sur un trajet. */
  protected readonly canManageDrivers = computed(() => {
    const r = this.authService.user()?.role;
    if (r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN') return true;
    if (r === 'FLEET_MANAGER') return this.perms.can('drivers_manage');
    return false;
  });

  /** Sous-titre du picker driver (montre date du trajet pour clarte). */
  protected readonly driverPickerSubtitle = computed(() => {
    const t = this.driverPickerTrip();
    if (!t) return undefined;
    try {
      return `Trajet du ${new Date(t.startedAt).toLocaleString('fr-FR', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })}`;
    } catch { return undefined; }
  });

  protected readonly vehicleDropdownOpen = signal(false);

  /**
   * Déclencheurs des trois panneaux, pour LEUR RENDRE LE FOCUS à la fermeture.
   *
   * ⚠️ Le menu est retiré du DOM quand on choisit un item : le focus retombait alors sur
   * `<body>`, et la navigation au clavier repartait du haut de la page. On ne « perd »
   * pas le focus par distraction — on le perd parce que l'élément qui le portait n'existe
   * plus, et personne ne l'a repris.
   */
  private readonly groupTriggerEl = viewChild<ElementRef<HTMLButtonElement>>('groupTrigger');
  private readonly vehicleTriggerEl = viewChild<ElementRef<HTMLButtonElement>>('vehicleTrigger');
  private readonly customTriggerEl = viewChild<ElementRef<HTMLButtonElement>>('customTrigger');

  /**
   * Rend le focus au PREMIER déclencheur qui peut réellement le prendre.
   *
   * Le déclencheur peut ne pas exister (filtre groupe masqué quand il n'y a pas de groupe),
   * ou exister sans pouvoir être focalisé — le déclencheur véhicule porte
   * `[disabled]="vehiclesLoading()"`, et `focus()` sur un bouton désactivé ne fait rien.
   * D'où les replis en cascade : sans eux, le focus retombe sur `<body>` et la navigation au
   * clavier repart du haut du document.
   */
  private rendreLeFocus(...refs: (ElementRef<HTMLElement> | undefined)[]): void {
    for (const ref of refs) {
      const el = ref?.nativeElement;
      if (!el || (el as HTMLButtonElement).disabled) continue;
      el.focus();
      if (document.activeElement === el) return;
    }
  }

  protected fermerMenuGroupe(): void {
    this.groupDropdownOpen.set(false);
    this.rendreLeFocus(this.groupTriggerEl());
  }

  protected fermerMenuVehicule(): void {
    this.vehicleDropdownOpen.set(false);
    this.rendreLeFocus(this.vehicleTriggerEl());
  }

  /* ══ FILTRE CONDUCTEUR (F13, seconde moitié) ═══════════════════════════════════════════
     Le récapitulatif dit COMBIEN a roulé telle personne ; ce filtre montre SES trajets. Il
     borne la liste, le résumé journalier, les graphiques de période et la synthèse — un
     tableau filtré sous des compteurs qui ne le sont pas, c'est deux totaux contradictoires
     dans le même écran. Les ALERTES font exception, et l'écran le dit (cf. `noteAlertesConducteur`). */

  /** Conducteurs de la société, source du menu — chargés comme les véhicules (`loadDrivers`). */
  protected readonly drivers = signal<DriverDto[]>([]);
  /**
   * La liste a-t-elle RÉPONDU ? Faux tant qu'elle charge, et faux après un échec.
   *
   * ⚠️ Sans ce drapeau, « absente de la liste » et « liste pas là » étaient la même chose, et le
   * menu répondait par un MOTIF INVENTÉ : « archivé, ou hors de cette société » s'affichait pour
   * un conducteur parfaitement ACTIF de la société courante, le temps que `GET /drivers` réponde
   * — c'est-à-dire à chaque ouverture d'un lien « /rapports?driver=… » partagé —, et
   * DÉFINITIVEMENT après un 403 (cette route exige `drivers_view`, la page `reports_view`) ou une
   * coupure réseau. Le sélecteur véhicule d'à côté distingue les deux états depuis toujours
   * (« Liste indisponible. » / « Aucun véhicule dans ce périmètre. ») : c'est cette parité-là qui
   * manquait.
   */
  protected readonly driversRepondus = signal(false);
  protected readonly driverDropdownOpen = signal(false);
  /** '' = tous ; un identifiant de conducteur ; ou `CONDUCTEUR_AUCUN` (sans conducteur). */
  protected readonly selectedDriverId = signal('');
  /** Exposée au gabarit : une constante de module n'est pas lisible depuis un template. */
  protected readonly CONDUCTEUR_AUCUN = CONDUCTEUR_AUCUN;
  private readonly driverTriggerEl = viewChild<ElementRef<HTMLButtonElement>>('driverTrigger');

  protected fermerMenuConducteur(): void {
    this.driverDropdownOpen.set(false);
    /**
     * ⚠️ LE DÉCLENCHEUR NE SURVIT PAS TOUJOURS AU GESTE QU'ON VIENT DE FAIRE. La garde du
     * gabarit est `driverOptions().length > 0 || conducteurFiltre()` : choisir « Tous les
     * conducteurs » dans un menu SANS option (conducteur archivé seul filtré, ou 403 sur
     * /drivers) rend les deux branches fausses, et la détection de changements qui suit retire
     * le bloc entier — déclencheur compris. Rendre le focus à un élément sur le point d'être
     * démonté, c'est le laisser tomber sur `<body>` : le clavier repart du haut du document.
     * `onSelectDriver` pose le signal AVANT d'appeler cette fermeture, donc l'expression est
     * déjà à jour ; les trois autres chemins (fond cliqué, Échap, entrée « hors liste ») ne
     * touchent pas au filtre et gardent le comportement d'aujourd'hui.
     */
    const survit = this.driverOptions().length > 0 || this.conducteurFiltre();
    if (survit) { this.rendreLeFocus(this.driverTriggerEl()); return; }
    // Les voisins de la même barre, dans l'ordre où le clavier les rencontrerait.
    this.rendreLeFocus(this.vehicleTriggerEl(), this.groupTriggerEl());
  }

  /**
   * Conducteurs proposés — bornés à la société courante, comme les groupes le sont.
   *
   * ⚠️ `GET /drivers` rend TOUTES les sociétés à un super-administrateur (le serveur ne
   * filtre que les autres rôles) : sans cette borne, le menu d'une société afficherait les
   * conducteurs d'un autre client.
   */
  protected readonly driverOptions = computed(() =>
    this.drivers()
      .filter((d) => this.fleetFilter.matches(d.fleetId))
      .map((d) => ({ id: d.id, nom: `${d.firstName} ${d.lastName}`.trim() || 'Conducteur sans nom' }))
      .sort((a, b) => a.nom.localeCompare(b.nom)),
  );

  /** Un filtre conducteur est-il posé ? (« sans conducteur » en est un, et pas des moindres.) */
  protected readonly conducteurFiltre = computed(() => !!this.selectedDriverId());

  /**
   * Le nom d'un conducteur HORS LISTE, retenu au moment où l'on a cliqué « Filtrer ».
   *
   * ⚠️ `filtrerSurConducteur` efface la synthèse dans la MÊME instruction qui pose le filtre
   * (`oublierStatsPeriode`) : le repli de `selectedDriverLabel` cherchait donc son nom dans un
   * récapitulatif que la ligne précédente venait de vider — mort sur le chemin même pour lequel
   * il existe. Un conducteur ARCHIVÉ est nommé par `/reports/stats` mais absent de `GET /drivers` :
   * tout l'écran annonçait alors « Conducteur », y compris l'en-tête d'impression et la modale
   * PDF, pendant que le PDF produit imprimait, lui, le vrai nom résolu en base. Et
   * DÉFINITIVEMENT si la synthèse échoue (`statsEchouee`), puisque `statsPeriode` reste nul.
   *
   * ⚠️ RETENU AVEC SON IDENTIFIANT : sans cette clé, le souvenir survivrait au filtre suivant et
   * nommerait quelqu'un d'autre. La paire s'invalide donc toute seule — aucun nettoyage à
   * ajouter dans `onSelectDriver`, `reprendreVue` ni la relecture d'URL.
   *
   * ⚠️ ET RETENIR, PAS RÉORDONNER : `selectedDriverLabel` est un `computed` relu à chaque
   * lecture, pas un instantané pris au clic. Lire le libellé avant `oublierStatsPeriode()` sans
   * le mémoriser serait une correction strictement inerte.
   */
  private readonly libelleConducteurRetenu = signal<{ id: string; nom: string } | null>(null);

  /**
   * Ce qu'affiche le bouton du menu.
   *
   * ⚠️ Le repli n'est JAMAIS « Tous les conducteurs » : ce libellé dirait exactement le
   * contraire de ce que la page montre. Un conducteur archivé (ou une liste pas encore
   * arrivée) est cherché dans le récapitulatif — c'est de là que vient l'identifiant quand on
   * a cliqué « Filtrer » —, puis dans le nom retenu à ce clic, puis nommé « Conducteur ».
   */
  protected readonly selectedDriverLabel = computed(() => {
    const id = this.selectedDriverId();
    if (!id) return 'Tous les conducteurs';
    if (id === CONDUCTEUR_AUCUN) return 'Sans conducteur';
    const d = this.driverOptions().find((x) => x.id === id);
    if (d) return d.nom;
    // La synthèse FRAÎCHE reste prioritaire ; le souvenir n'est qu'un filet, et seulement
    // pour l'identifiant qui l'a posé.
    const memo = this.libelleConducteurRetenu();
    return this.attributionSummary().find((l) => l.driverId === id)?.label
      ?? (memo?.id === id ? memo.nom : undefined)
      ?? 'Conducteur';
  });

  /**
   * Le conducteur filtré est-il ABSENT du menu ?
   *
   * ⚠️ Ce cas n'a rien d'exotique et ne demande aucune URL bricolée : `GET /drivers` ne rend
   * que les conducteurs ACTIFS, tandis que `/reports/stats` nomme aussi les archivés — le
   * bouton « Filtrer » du récapitulatif offre donc, d'un clic ordinaire, un identifiant que la
   * liste du menu ne contient pas. Idem pour un `?driver=` d'une autre société.
   *
   * Le repli de `selectedDriverLabel` couvrait déjà le LIBELLÉ ; il ne couvrait pas l'ÉTAT de
   * la liste : les trois `aria-selected` du menu étaient faux en même temps, donc plus aucune
   * option sélectionnée sous un bouton qui annonçait pourtant un nom.
   */
  protected readonly conducteurHorsListe = computed(() => {
    const id = this.selectedDriverId();
    return !!id && id !== CONDUCTEUR_AUCUN && !this.driverOptions().some((d) => d.id === id);
  });

  /**
   * ── L'EXCEPTION DES ALERTES, ÉCRITE À L'ÉCRAN ────────────────────────────────────────
   *
   * Une alerte appartient à un VÉHICULE : elle n'a pas de conducteur, et lui en attribuer un
   * demanderait de deviner qui conduisait à son horodatage. Ce compte reste donc calculé sur
   * le périmètre véhicule. Une carte muette, sous un filtre conducteur, laisserait croire que
   * cette personne a déclenché toutes ces alertes — ce n'est plus un chiffre, c'est une
   * accusation. `null` quand aucun conducteur n'est choisi : rien à expliquer.
   */
  protected readonly noteAlertesConducteur = computed<string | null>(() => {
    const id = this.selectedDriverId();
    if (!id) return null;
    const porte = 'Ce compte porte sur les véhicules du périmètre.';
    return id === CONDUCTEUR_AUCUN
      ? `Les alertes appartiennent à un véhicule, pas à un conducteur : elles ne suivent pas le filtre « Sans conducteur ». ${porte}`
      : `Les alertes appartiennent à un véhicule, pas à un conducteur : elles ne sont pas filtrées sur ${this.selectedDriverLabel()}. ${porte}`;
  });

  /**
   * ── ET L'EXCEPTION DU PRIX CONSTATÉ EN STATION ───────────────────────────────────────
   *
   * Même famille que les alertes, et pour la même raison : un passage en station est un arrêt
   * du VÉHICULE — `TripFuelStop` n'a pas de colonne conducteur, et rien ne dit qui tenait le
   * pistolet. Le serveur GARDE donc ce prix et ce compte sur le périmètre véhicule sous
   * filtre, délibérément (cf. `reports-stats.service`) : les neutraliser ferait afficher
   * « Aucun prix relevé en station sur la période », ce qui serait faux — des prix ont bien
   * été relevés, ils ne sont simplement imputables à personne.
   *
   * ⚠️ Ce qui n'était pas permis, c'est le SILENCE : « … sur 12 passages » sous le nom d'une
   * personne se lit comme ses douze pleins. Et la phrase doit nommer la part qui, elle, SUIT
   * le filtre — les litres —, sinon le lecteur conclut que la carte entière est hors filtre
   * alors que le coût estimé, lui, ne compte que les kilomètres de cette personne.
   *
   * `null` sans filtre, et `null` sans prix relevé : la phrase d'à côté dit alors déjà qu'il
   * n'y a rien à imputer, et une note sur un chiffre absent est du bruit.
   */
  protected readonly noteCarburantConducteur = computed<string | null>(() => {
    const id = this.selectedDriverId();
    if (!id) return null;
    if (this.statsPeriode()?.consumption.observedPriceEurL == null) return null;
    const porte = 'Ils portent sur les véhicules du périmètre ; seuls les litres valorisés à ce prix suivent le filtre.';
    return id === CONDUCTEUR_AUCUN
      ? `Les passages en station sont des arrêts du véhicule, pas d'une personne : ce prix et ce nombre de passages ne suivent pas le filtre « Sans conducteur ». ${porte}`
      : `Les passages en station sont des arrêts du véhicule, pas d'une personne : ce prix et ce nombre de passages ne sont pas filtrés sur ${this.selectedDriverLabel()}. ${porte}`;
  });

  /**
   * ── CE QUE LES FICHIERS VONT CONTENIR, DIT À L'ENDROIT OÙ L'ON CLIQUE ────────────────
   *
   * Les TRAJETS des exports suivent le filtre conducteur (F13) : le PDF est calculé dessus et
   * porte le nom de la personne sous celui de la société, le CSV trajets ne rend que ses lignes,
   * le classeur Excel ne porte que ses trajets.
   *
   * ⚠️ ET LES ALERTES, NULLE PART — une alerte appartient à un véhicule. Le CSV alertes est donc
   * refusé (son bouton est désactivé juste au-dessus, et un bouton grisé sans raison est une
   * impasse : la raison est ici, et elle dit quoi faire), MAIS la section « Alertes » du PDF,
   * elle, sort quand même — cochée par défaut — avec le compte de tout le périmètre véhicule.
   *
   * ⚠️ D'où la formulation. La phrase a d'abord accroché l'exception au SEUL fichier « CSV
   * alertes » : nommer une exception fait lire l'énumération comme complète, et le lecteur en
   * concluait que le PDF, lui, n'en avait pas. La mention ne corrigeait pas l'inférence, elle la
   * renforçait — sur un document qui part par courriel avec un nom de personne en tête et le
   * total d'alertes de tout le parc dedans. L'exception porte donc sur LES ALERTES, pas sur un
   * fichier.
   *
   * Le classeur Excel perd en plus ses passages en station (des arrêts du VÉHICULE) : c'est
   * dit dans l'infobulle du bouton et écrit dans le classeur lui-même, pas ici. Cette mention
   * doit rester lisible d'un coup d'œil au moment du clic ; y empiler tout ce qui est vrai la
   * transformerait en pavé qu'on ne lit plus, et le point important — les alertes — s'y
   * perdrait.
   *
   * `null` sans filtre : aucun export n'a alors quoi que ce soit à annoncer, et une mention
   * permanente deviendrait du bruit.
   */
  /**
   * ── UN RAPPORT PORTE SUR UNE SOCIÉTÉ, ET L'ÉCRAN LE DIT AVANT LE CLIC ────────────────
   *
   * Le serveur refuse désormais un export sans société désignée (il en choisissait une au
   * hasard — la plus ancienne — et l'étiquetait de son nom). Mais découvrir ce refus APRÈS
   * avoir cliqué, dans un bandeau rouge, n'est pas une réponse : on ferme les boutons et on
   * dit pourquoi, exactement comme le CSV alertes sous filtre conducteur.
   *
   * ⚠️ Ne concerne QUE les comptes qui voient plusieurs sociétés. Un gestionnaire n'a rien
   * à choisir : `synthesePeriodePossible` est vrai pour lui, et rien ne change.
   */
  protected readonly exportsBloquesSansSociete = computed(() => !this.synthesePeriodePossible());

  protected readonly noteExportsConducteur = computed<string | null>(() => {
    if (this.exportsBloquesSansSociete()) {
      return 'Choisissez une société dans le sélecteur en haut de page pour exporter. '
        + "Un rapport porte sur UNE société : en désigner une au hasard produirait un "
        + "document au nom d'un client qui n'est pas celui que vous regardez.";
    }
    const cond = this.conducteurPourExport();
    if (!cond) return null;
    return `PDF, CSV trajets et Excel ne retiendront que ${cond.trajets}. `
      + 'Les alertes, elles, ne suivent jamais ce filtre — une alerte appartient à un véhicule, '
      + 'pas à une personne : la section « Alertes » du PDF porte sur les véhicules du périmètre, '
      + 'et le CSV alertes n\'est pas exportable sous filtre (retirez-le pour l\'obtenir).';
  });

  /**
   * Le filtre conducteur sous ses DEUX formes de phrase, pour la modale PDF et la mention
   * ci-dessus. Une seule source : deux libellés écrits séparément se contrediraient le jour
   * où l'un des deux changerait, et c'est la phrase lue juste avant le clic qui mentirait.
   */
  protected readonly conducteurPourExport = computed<{ nom: string; trajets: string } | null>(() => {
    const id = this.selectedDriverId();
    if (!id) return null;
    if (id === CONDUCTEUR_AUCUN) return { nom: 'Sans conducteur', trajets: 'les trajets sans conducteur' };
    const nom = this.selectedDriverLabel();
    return { nom, trajets: `les trajets de ${nom}` };
  });

  /**
   * ── ET CE QUE LE FILTRE FAIT AU PARC ACTIF ───────────────────────────────────────────
   *
   * Contrairement aux alertes, ce compte SUIT le filtre : il se déduit des trajets du
   * périmètre. Mais « immobile » ne veut alors plus dire « n'a pas roulé », il veut dire
   * « n'a pas roulé avec cette personne ». Le chiffre reste vrai, sa lecture change — et une
   * lecture tacite se prend pour un fait.
   */
  protected readonly noteParcConducteur = computed<string | null>(() => {
    const id = this.selectedDriverId();
    if (!id) return null;
    return id === CONDUCTEUR_AUCUN
      ? 'Sous ce filtre, « immobile » veut dire : aucun trajet sans conducteur sur la période.'
      : `Sous ce filtre, « immobile » veut dire : aucun trajet avec ${this.selectedDriverLabel()} sur la période.`;
  });

  /**
   * ── … ET LE MÊME PÉRIMÈTRE, ACCOLÉ AUX PHRASES ELLES-MÊMES ───────────────────────────
   *
   * ⚠️ DEUX GESTES, PAS UN. La note ci-dessus ne redéfinit que le mot « immobile » ; les deux
   * phrases qui l'encadrent, elles, restaient des phrases de FLOTTE : « 5 % du parc a roulé au
   * moins une fois » et « 37 véhicules n'ont fait aucun trajet : AA-111-BB, CC-222-DD… ». Sous
   * un filtre conducteur, ces 37 véhicules ont roulé — hors de ce filtre — et la seconde phrase
   * NOMME des plaques : c'est la donnée sur laquelle se décide une mutualisation ou une
   * restitution. Annoter un piège ne le retire pas ; le PDF, sur les mêmes chiffres, renomme
   * son libellé (`renderKpis` : « Véhicules conduits / parc ») avant de l'expliquer. L'écran
   * fait désormais les deux, et les deux surfaces nomment enfin la même chose pareil.
   *
   * Chaîne VIDE hors filtre : les phrases de flotte y sont justes telles quelles, et un suffixe
   * permanent serait du bruit.
   */
  protected readonly perimetreParc = computed<string>(() => {
    const id = this.selectedDriverId();
    if (!id) return '';
    return id === CONDUCTEUR_AUCUN ? ' sans conducteur' : ` avec ${this.selectedDriverLabel()}`;
  });

  /**
   * ── ET CE QUE LE FILTRE FAIT AU RÉCAPITULATIF LUI-MÊME ───────────────────────────────
   *
   * C'est la carte où le rétrécissement est le plus spectaculaire, et la seule des quatre à
   * n'avoir rien dit. Filtrée sur une personne, elle ne peut plus contenir qu'UNE ligne — la
   * sienne, dont les deux chiffres recopient les indicateurs du haut de page. La mention de
   * troncature ne se déclenche pas (rien n'est tronqué : le total servi vaut 1 lui aussi), et
   * un classement de flotte à une ligne se lit « il n'y a qu'une personne qui roule ». La vue
   * « Par véhicule » fond de la même façon, sous le même en-tête.
   *
   * Aucun chiffre n'est faux — c'est bien l'objet de ce lot. C'est la LECTURE qu'il faut
   * énoncer, comme pour les alertes, le parc actif et les exports.
   *
   * ⚠️ Vaut pour les DEUX vues et pour les DEUX formes du filtre : sous « Sans conducteur » la
   * carte garde plusieurs lignes de GROUPE, une phrase qui annoncerait « une seule ligne » y
   * serait fausse. Le seul dénominateur commun est le PÉRIMÈTRE.
   */
  protected readonly noteRecapConducteur = computed<string | null>(() => {
    const id = this.selectedDriverId();
    if (!id) return null;
    const perimetre = id === CONDUCTEUR_AUCUN
      ? 'aux trajets sans conducteur'
      : `aux trajets de ${this.selectedDriverLabel()}`;
    const consequence = id === CONDUCTEUR_AUCUN
      ? 'aucune ligne de conducteur ne peut y figurer'
      : 'aucun autre conducteur ne peut y figurer';
    return `Périmètre limité ${perimetre} : ${consequence}, et seuls les véhicules concernés sont listés. `
      + 'Retirez le filtre conducteur pour la flotte entière.';
  });

  /**
   * Ce que le dénominateur de « N trajets sur M » compte VRAIMENT.
   *
   * ⚠️ Sous « Sans conducteur », le dénominateur DEVIENT l'une des deux conditions du
   * numérateur : le total suit le filtre, alors que les trajets « ni conducteur, ni groupe » en
   * sont par construction un sous-ensemble et ne bougent pas. La part passe donc de 33 % à 83 %
   * sur les mêmes trajets, sans qu'un seul ait changé — et cette mention est une boîte à part,
   * avec son `role="status"` : elle est lue seule, donc elle doit être vraie seule. La note
   * d'en-tête de la carte ne la couvre pas.
   *
   * Chaîne vide sous un conducteur nommé : tous ses trajets ont un conducteur, le numérateur
   * vaut alors zéro et la mention ne s'affiche pas.
   */
  protected readonly libelleDenominateurTrajets = computed(() =>
    this.selectedDriverId() === CONDUCTEUR_AUCUN ? ' trajets sans conducteur' : '',
  );

  /**
   * Pose (ou retire) le filtre conducteur.
   *
   * ⚠️ `oublierStatsPeriode()` AVANT de recharger, comme pour le véhicule et le groupe : la
   * synthèse en mémoire décrit l'ancien périmètre, et la laisser à l'écran afficherait une
   * seconde les chiffres de tout le parc sous le nom d'une personne.
   */
  protected onSelectDriver(id: string): void {
    this.selectedDriverId.set(id);
    this.fermerMenuConducteur();
    this.oublierStatsPeriode();
    this.ecrireEtatDansUrl();
    void this.loadData();
  }

  /**
   * Le geste que le récapitulatif appelait : depuis la ligne d'un conducteur, voir SES
   * trajets. Même chemin que `filtrerSurVehicule`, sans raccourci.
   *
   * ⚠️ Le véhicule et le groupe ne sont PAS effacés : un gestionnaire qui regarde un groupe
   * et veut y isoler un conducteur ne demande pas à sortir du groupe. Les deux filtres se
   * composent — le récapitulatif affiché décrivait déjà ce périmètre-là.
   */

  /**
   * ── APRÈS UN « FILTRER », ON RESTE OÙ L'ON ÉTAIT ──────────────────────────────────────
   *
   * Ces deux gestes partaient d'un `window.scrollTo({ top: 0 })`. Sur un écran large c'est
   * anodin ; au doigt, c'est une éjection : le récapitulatif est à quatre écrans du haut,
   * on y tape « Filtrer » sur une ligne, et on se retrouve devant l'en-tête sans savoir si
   * quelque chose s'est passé. Il faut alors redescendre chercher la ligne qu'on vient de
   * toucher.
   *
   * On ramène donc le RÉCAPITULATIF en haut de la fenêtre : c'est là qu'on a agi, c'est là
   * que la réponse s'écrit (la carte porte « Périmètre limité aux trajets de … » et se
   * réduit à une ligne), et la barre de filtres reste à un pouce au-dessus.
   *
   * ⚠️ APRÈS le chargement, pas avant : `oublierStatsPeriode()` vide la synthèse, et la
   * carte SORT du DOM le temps de la requête (son `@if` porte sur `vehicleSummary()`).
   * Scroller tout de suite viserait un élément qui n'existe plus.
   *
   * ⚠️ Repli sur le haut de page si la carte n'est pas revenue — un filtre qui ne rend
   * aucune ligne, par exemple. Ne rien faire du tout laisserait le lecteur devant une zone
   * vide, sans rien pour comprendre.
   */
  private ramenerSurLeRecap(): void {
    const el = this.recapEl()?.nativeElement;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  protected async filtrerSurConducteur(driverId: string): Promise<void> {
    if (this.selectedDriverId() === driverId) return;
    // ⚠️ AVANT `oublierStatsPeriode()` : c'est la dernière instruction où le nom est encore
    // lisible. La ligne suivante vide `statsPeriode`, dont `attributionSummary` — la source du
    // repli de `selectedDriverLabel` — dérive. Cf. `libelleConducteurRetenu`.
    const nom = this.attributionSummary().find((l) => l.driverId === driverId)?.label;
    this.libelleConducteurRetenu.set(nom ? { id: driverId, nom } : null);
    this.selectedDriverId.set(driverId);
    this.oublierStatsPeriode();
    this.ecrireEtatDansUrl();
    await this.loadData();
    this.ramenerSurLeRecap();
  }

  /**
   * Liste des conducteurs — alimente le menu, et rien d'autre.
   *
   * ⚠️ Un échec ne montre PAS de bandeau et ne coupe rien : le menu se vide de ses options,
   * les trajets et les chiffres restent justes. Un filtre absent se remarque ; une page de
   * rapport en erreur pour un menu accessoire serait une régression bien plus grave.
   *
   * ⚠️ « le menu disparaît simplement » : c'est ce que disait cette phrase, et ce n'était vrai
   * que tant qu'AUCUN filtre n'était posé. Un rapport borné à une personne dont le seul
   * contrôle vient de s'évanouir est une impasse — d'où le `|| conducteurFiltre()` du gabarit,
   * qui garde le menu (et donc « Tous les conducteurs ») quand la liste est vide.
   */
  private async loadDrivers(): Promise<void> {
    // ⚠️ REMIS À FAUX À L'ENTRÉE : le rechargement d'un changement de société garderait sinon
    // un « true » périmé, et le menu réaffirmerait un motif qu'il n'a pas encore mesuré.
    this.driversRepondus.set(false);
    try {
      this.drivers.set(await this.driversApi.list());
      this.driversRepondus.set(true);
    } catch (err) {
      swallow('reports:loadDrivers', err);
      this.drivers.set([]);
    }
  }

  /** Label affiché dans le bouton du dropdown selon la sélection courante. */
  protected readonly selectedVehicleLabel = computed(() => {
    const id = this.selectedVehicleId();
    if (!id) return 'Tous les véhicules';
    const v = this.vehicles().find((x) => x.id === id);
    return v?.plate ?? 'Tous les véhicules';
  });

  protected onSelectVehicle(id: string): void {
    this.selectedVehicleId.set(id);
    this.fermerMenuVehicule();
    // Le périmètre change : la synthèse en mémoire décrit l'ancien (cf. `filtrerSurVehicule`).
    this.oublierStatsPeriode();
    this.ecrireEtatDansUrl();
    this.loadData();
  }

  /* ─── Filtre groupe (Sprint Groupes) ─── */
  protected readonly selectedGroupId = signal('');
  protected readonly groupDropdownOpen = signal(false);

  /** Groupes distincts présents dans la flotte, dérivés des véhicules chargés. */
  protected readonly groupOptions = computed(() => {
    const map = new Map<string, string>();
    for (const v of this.vehicles()) {
      if (this.fleetFilter.matches(v.fleetId) && v.group) map.set(v.group.id, v.group.name);
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });

  /** Véhicules visibles dans le sélecteur, restreints à la société (SA) puis au groupe filtré. */
  protected readonly visibleVehicles = computed(() => {
    const gid = this.selectedGroupId();
    const all = this.vehicles().filter((v) => this.fleetFilter.matches(v.fleetId));
    return gid ? all.filter((v) => v.group?.id === gid) : all;
  });

  protected readonly selectedGroupLabel = computed(() => {
    const gid = this.selectedGroupId();
    if (!gid) return 'Tous les groupes';
    return this.groupOptions().find((g) => g.id === gid)?.name ?? 'Tous les groupes';
  });

  protected onSelectGroup(id: string): void {
    this.selectedGroupId.set(id);
    this.fermerMenuGroupe();
    // Si le véhicule sélectionné ne fait pas partie du groupe filtré, on revient
    // à « tous les véhicules » (sinon le rapport montrerait un véhicule hors filtre).
    const selV = this.selectedVehicleId();
    if (selV && id && !this.vehicles().some((v) => v.id === selV && v.group?.id === id)) {
      this.selectedVehicleId.set('');
    }
    // Le périmètre change : la synthèse en mémoire décrit l'ancien.
    this.oublierStatsPeriode();
    this.ecrireEtatDansUrl();
    // Recharge KPI + trajets scopés sur le groupe (ou toute la flotte si « tous »).
    this.loadData();
  }

  /**
   * Sprint 5 — Réinitialise les filtres aux valeurs par défaut : tous groupes, tous véhicules,
   * TOUS CONDUCTEURS, période « 7 jours », et le TRI revient à son point de départ. Ferme les
   * dropdowns / panneaux ouverts et relance le chargement via setPeriod (qui appelle loadData
   * une seule fois).
   *
   * ⚠️ Cette énumération et l'infobulle du bouton doivent rester d'accord avec `filtersDirty()`.
   * Elles ne l'étaient pas : le conducteur et le tri étaient remis sans être annoncés.
   */
  protected resetFilters(): void {
    this.selectedGroupId.set('');
    this.selectedVehicleId.set('');
    this.selectedDriverId.set('');
    this.groupDropdownOpen.set(false);
    this.vehicleDropdownOpen.set(false);
    this.driverDropdownOpen.set(false);
    this.customRangeOpen.set(false);
    this.customFrom.set('');
    this.customTo.set('');
    // Le tri revient à son point de départ, comme le reste : sinon « Réinitialiser » rendait
    // les filtres mais laissait le tableau classé par vitesse max, sans plus rien pour le dire.
    this.sortBy.set(TRI_PAR_DEFAUT.col);
    this.sortDir.set(TRI_PAR_DEFAUT.dir);
    // Realigne le jour courant (anti-stale) puis applique « 7 jours » (index 1).
    this.jourCourant.set(todayIsoLocal());
    const sevenDays = this.periods()[1]!;
    this.setPeriod(sevenDays.from, sevenDays.to);
  }

  /**
   * Sprint 5 — true si les filtres ne sont PAS sur leurs valeurs par défaut
   * (un groupe ou un véhicule est sélectionné, ou la période n'est pas « 7j »).
   * Pilote l'état visuel/disabled du bouton « Réinitialiser ».
   */
  protected readonly filtersDirty = computed(() => {
    this.periodKey();
    // Le conducteur compte comme les deux autres : « Réinitialiser » doit être offert dès
    // qu'un filtre est posé, sinon le seul geste qui ramène la page à son état d'origine
    // reste grisé après le geste qui l'en a sortie.
    if (this.selectedGroupId() || this.selectedVehicleId() || this.selectedDriverId()) return true;
    /**
     * ⚠️ LE TRI COMPTE AUTANT QUE LES FILTRES.
     *
     * Cliquer un indicateur trie le tableau sur une autre colonne, et le bouton
     * « Réinitialiser » restait GRISÉ : le seul geste qui aurait remis la page dans son
     * état d'origine était refusé, précisément après le geste qui l'en avait sortie. Il
     * fallait retrouver le sélecteur de tri et deviner la valeur de départ.
     */
    if (this.sortBy() !== TRI_PAR_DEFAUT.col || this.sortDir() !== TRI_PAR_DEFAUT.dir) return true;
    const sevenDays = this.periods()[1];
    return !sevenDays || this.periodFrom !== sevenDays.from || this.periodTo !== sevenDays.to;
  });

  /**
   * Sprint 5 — l'export Excel est PAR VÉHICULE : il faut un véhicule précis
   * sélectionné. Sinon le bouton est désactivé avec un hint.
   */
  /**
   * ⚠️ CONSERVÉ mais plus utilisé pour DÉSACTIVER le bouton : l'Excel couvre désormais un
   * parc entier. Le libellé ci-dessous dit ce que le classeur contiendra — un bouton qui
   * change de portée sans le dire produit un fichier qu'on n'attendait pas.
   */
  protected readonly canExportExcel = computed(() => !!this.selectedVehicleId());

  /** Ce que le classeur contiendra, écrit dans l'infobulle du bouton. */
  protected readonly libelleExcel = computed(() => {
    const veh = this.selectedVehicleId();
    // Le conducteur figure dans l'infobulle comme il figure dans le classeur (F13). Ce n'est
    // PAS le seul endroit où il est dit — la mention sous les boutons le porte à l'écran :
    // une infobulle n'existe pas au doigt, elle complète, elle ne remplace pas.
    const cond = this.conducteurPourExport();
    const suffixe = cond
      ? ` — seulement ${cond.trajets}, sans les passages en station (ce sont des arrêts du véhicule)`
      : '';
    if (veh) return `Export Excel détaillé du véhicule ${this.vehiclePlate(veh) || ''}`.trim() + suffixe;
    if (this.selectedGroupId()) return `Export Excel du groupe ${this.selectedGroupLabel()} — une feuille de synthèse par véhicule${suffixe}`;
    return `Export Excel de toute la société — une feuille de synthèse par véhicule${suffixe}`;
  });

  /** Format une Date en YYYY-MM-DD en HEURE LOCALE (pas UTC).
   *  Important : `toISOString()` decale d'1 jour si le user est a UTC+X et qu'on est
   *  proche de minuit. Cela peut envoyer un from/to errone au backend. */
  private localIso(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Recalcule les presets a chaque appel — evite les dates stales en PWA mobile
   *  (le composant peut survivre des heures en arriere-plan ; un periods statique
   *  pointerait alors sur hier apres minuit). */
  private buildPeriods(): { label: string; from: string; to: string }[] {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = this.ajouterJours(today, 1);
    // « 7 jours » = 7 jours civils, aujourd'hui compris (J-6 → J). L'ancien J-7 → J+1
    // couvrait HUIT jours : la modale PDF affichait « 8 jours » sous une pastille « 7 jours »,
    // et le calendrier « 7 derniers jours » comptait, lui, autrement. Même règle pour 30.
    const minus6 = this.ajouterJours(today, -6);
    const minus29 = this.ajouterJours(today, -29);
    return [
      { label: 'Aujourd\'hui', from: this.localIso(today), to: this.localIso(tomorrow) },
      { label: '7 jours', from: this.localIso(minus6), to: this.localIso(tomorrow) },
      { label: '30 jours', from: this.localIso(minus29), to: this.localIso(tomorrow) },
    ];
  }

  /**
   * Les trois pastilles de période, DÉRIVÉES du jour civil courant.
   *
   * ⚠️ C'était un tableau construit une seule fois, à la création du composant. Sur une
   * PWA laissée ouverte, un clic sur « Aujourd'hui » chargeait donc la veille — et rien
   * ne le disait, puisque la pastille s'allumait normalement.
   */
  protected readonly periods = computed(() => {
    this.jourCourant();
    return this.buildPeriods();
  });

  /**
   * KPI de la periode — calcules depuis l'AGREGAT SERVEUR.
   *
   * ⚠️ AVANT : `aggregateKpis(this.trips())`, c'est-a-dire la liste AFFICHEE, demandee
   * avec `limit: '100'`. Les trois flottes de production depassent 100 trajets meme sur
   * SEPT jours (622 / 729 / 425), donc les KPI etaient faux en permanence — et surtout
   * IDENTIQUES d'une periode a l'autre, puisqu'on retombait toujours sur les cent
   * derniers trajets. Le filtre de date paraissait casse alors qu'il fonctionnait : le
   * plafond masquait son effet.
   *
   * `dailySummary` est agrege cote serveur sur exactement les memes filtres, sans limite.
   */
  protected readonly kpis = computed(() => aggregateKpisFromDaily(this.dailySummary()));

  /** Nombre de trajets REELLEMENT listes dans le tableau (borne par le plafond). */
  protected readonly listedTripCount = computed(() => this.trips().length);

  /**
   * Vrai quand le tableau ne montre qu'une PARTIE des trajets de la periode.
   *
   * ⚠️ Indispensable depuis que les KPI disent la verite : le compteur annonce 622 et le
   * tableau en affiche 100. Sans cette mention, l'ecart est incomprehensible — et c'est
   * le genre d'incoherence qui fait douter de TOUS les chiffres de la page.
   */
  protected readonly tripsTruncated = computed(
    () => this.kpis().tripCount > this.trips().length,
  );

  // ─── Tri du tableau (SERVEUR — porte sur toute la période) ───────────────
  /**
   * ⚠️ Le tri était fait EN MÉMOIRE sur la page chargée, et c'est ce qui cassait le
   * drilldown de la carte « Vitesse max ».
   *
   * Mesure en production (2026-09-02, flotte « mh cars », 30 jours) : la carte annonçait
   * 180 km/h — chiffre juste, il vient de l'agrégat serveur — et le clic surlignait un
   * trajet à **139 km/h**, le plus rapide des cent trajets chargés sur 1 896. Le trajet à
   * 180 n'était tout simplement pas dans la page. Rien ne le disait : le tableau se
   * réordonnait, une ligne s'allumait, tout avait l'air de marcher. C'est la pire forme
   * d'erreur — celle qui répond à côté avec l'assurance d'une bonne réponse.
   *
   * Le tri part donc en base (`sortBy`/`sortDir` sur `GET /trips`), sur les mêmes filtres
   * que les KPI. Toutes les colonnes sont concernées, pas seulement la vitesse : trier par
   * distance donnait « le plus long des cent derniers », jamais celui de la période.
   */
  protected readonly sortBy = signal<TripSortColumn>(TRI_PAR_DEFAUT.col);
  /** Direction de tri active. */
  protected readonly sortDir = signal<SortDirection>(TRI_PAR_DEFAUT.dir);
  /** Curseur de la page suivante (`null` = tout est chargé). */
  protected readonly nextCursor = signal<string | null>(null);
  /** Chargement d'une page SUPPLÉMENTAIRE (distinct de `loading`, qui repeint tout). */
  protected readonly loadingMore = signal(false);
  /** Re-tri en cours : le tableau reste affiché, estompé (cf. `loadTrips`). */
  protected readonly tripsBusy = signal(false);
  /**
   * Surligner la 1ʳᵉ ligne au prochain chargement — armé par le clic sur la carte KPI,
   * consommé une seule fois. Le trajet le plus rapide n'est connu qu'APRÈS la réponse
   * serveur, donc on ne peut pas le viser par son id au moment du clic.
   */
  private highlightTopAfterLoad = false;
  /** Id du trajet a surligner brievement (clic KPI « Vitesse max »). */
  protected readonly highlightTripId = signal<string | null>(null);
  /** Handle du timer de highlight, nettoye en ngOnDestroy / re-clic. */
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /** Référence au conteneur du tableau (scroll au clic KPI « Vitesse max »). */
  private readonly tableEl = viewChild<ElementRef<HTMLElement>>('tripsTable');
  private readonly recapEl = viewChild<ElementRef<HTMLElement>>('recapSection');

  /**
   * Sentinelle de pagination : quand elle entre dans la fenêtre, on charge la page
   * suivante — au pouce, « Charger plus » toutes les cent lignes est une corvée.
   * L'élément n'existe que tant qu'il reste une page ; l'observateur suit son apparition
   * et sa disparition via le signal de requête de vue.
   */
  private readonly moreSentinel = viewChild<ElementRef<HTMLElement>>('moreSentinel');
  private moreObserver: IntersectionObserver | null = null;
  private readonly moreSentinelEffect = effect(() => {
    const el = this.moreSentinel()?.nativeElement;
    this.moreObserver?.disconnect();
    this.moreObserver = null;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    this.moreObserver = new IntersectionObserver(
      (entries) => { if (!this.moreAutoPaused && entries.some((e) => e.isIntersecting)) void this.loadMoreTrips(); },
      { rootMargin: '240px 0px' },
    );
    this.moreObserver.observe(el);
  });

  /**
   * Après une page ajoutée, la sentinelle peut être restée visible (page courte) : un
   * observateur ne re-signale pas un état inchangé. Le ré-observer rejoue la notification
   * initiale, et la page suivante part si on est toujours en bas.
   */
  private rearmMoreSentinel(): void {
    const el = this.moreSentinel()?.nativeElement;
    if (!el || !this.moreObserver || this.moreAutoPaused) return;
    this.moreObserver.unobserve(el);
    this.moreObserver.observe(el);
  }

  /** Chargement automatique suspendu après un échec réseau (cf. loadMoreTrips). */
  private moreAutoPaused = false;

  /**
   * Trajets affichés dans le tableau. Le serveur renvoie déjà la page dans l'ordre
   * demandé ; un re-tri local ne ferait que réordonner l'échantillon et ré-introduirait
   * le mensonge qu'on vient d'enlever. `sortTrips` reste utilisé et testé pour les
   * listes complètes (cf. `reports.utils.spec.ts`).
   */
  protected readonly sortedTrips = computed(() => this.trips());

  /** Tri MOBILE (sélecteur + bouton de sens) : la vue en cartes n'a pas d'en-têtes à cliquer. */
  protected setSort(col: TripSortColumn, dir: SortDirection): void {
    if (this.sortBy() === col && this.sortDir() === dir) return;
    this.sortBy.set(col);
    this.sortDir.set(dir);
    this.ecrireEtatDansUrl();
    void this.loadTrips();
  }

  /** Libellés du sélecteur de tri mobile — mêmes colonnes que les en-têtes du tableau. */
  /** Exposé au gabarit pour ne pas écrire « 90 » à la main dans une phrase. */
  protected readonly maxJoursGraphique = MAX_JOURS_GRAPHIQUE;

  /**
   * La phrase que le lecteur d'écran entend quand le tableau change.
   *
   * ⚠️ Elle nomme le TRI et le nombre de trajets CHARGÉS sur le total — les deux choses
   * qu'un utilisateur voyant lit d'un coup d'œil (la flèche d'en-tête, la ligne « 100 sur
   * 391 ») et qu'un lecteur d'écran ne rencontrait nulle part.
   */
  protected readonly annonceTableau = computed(() => {
    if (this.loading()) return 'Chargement des trajets…';
    const colonne = this.sortOptions.find((o) => o.col === this.sortBy())?.label ?? 'Date';
    const sens = this.sortDir() === 'desc' ? 'décroissant' : 'croissant';
    const charges = this.listedTripCount();
    const total = this.kpis().tripCount;
    const combien = charges < total
      ? `${charges} trajets chargés sur ${total}`
      : `${charges} trajet${charges > 1 ? 's' : ''}`;
    return `Tableau trié par ${colonne}, ordre ${sens}. ${combien}.`;
  });

  /**
   * La ligne d'identité du document imprimé : société, périmètre, période, date d'édition.
   *
   * ⚠️ La date d'ÉDITION y figure. Un rapport papier circule, se photocopie et ressort d'un
   * classeur six mois plus tard ; sans elle, personne ne peut dire s'il décrit encore la
   * réalité, ni le distinguer d'une réédition de la même période après un recalcul.
   */
  protected readonly enTeteImpression = computed(() => {
    this.periodKey();
    const morceaux: string[] = [];
    const societe = this.statsPeriode()?.fleet?.name;
    if (societe) morceaux.push(societe);
    const veh = this.selectedVehicleId();
    if (veh) morceaux.push(`Véhicule ${this.vehiclePlate(veh) || veh}`);
    else if (this.selectedGroupId()) morceaux.push(`Groupe ${this.selectedGroupLabel()}`);
    else morceaux.push('Tous véhicules');
    // ⚠️ Le conducteur figure sur le papier. Un rapport imprimé circule et ressort d'un
    // classeur des mois plus tard : sans cette mention, une feuille filtrée sur une personne
    // se lirait comme le rapport de toute la flotte.
    if (this.conducteurFiltre()) morceaux.push(this.selectedDriverLabel());
    morceaux.push(this.pdfPeriodLabel());
    morceaux.push(`édité le ${new Date().toLocaleDateString('fr-FR')}`);
    return morceaux.join(' · ');
  });

  protected readonly sortOptions: ReadonlyArray<{ col: TripSortColumn; label: string }> = [
    { col: 'startedAt', label: 'Date' },
    { col: 'maxSpeed', label: 'Vitesse max' },
    { col: 'distanceMeters', label: 'Distance' },
    { col: 'durationSeconds', label: 'Durée' },
    { col: 'avgSpeed', label: 'Vitesse moyenne' },
  ];

  /**
   * Clic sur un en-tête de colonne : si déjà active → inverse la direction ;
   * sinon active la colonne avec une direction par défaut sensée (date/vitesses/
   * distance/durée = desc d'abord, plus parlant). Recharge depuis le serveur : le
   * tri porte sur la période entière, pas sur la page affichée.
   */
  protected onSort(col: TripSortColumn): void {
    if (this.sortBy() === col) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortBy.set(col);
      this.sortDir.set('desc');
    }
    this.ecrireEtatDansUrl();
    void this.loadTrips();
  }

  /** Direction affichée pour la flèche d'un en-tête (null si colonne inactive). */
  protected sortIndicator(col: TripSortColumn): SortDirection | null {
    return this.sortBy() === col ? this.sortDir() : null;
  }

  /** Icône de tri pour un en-tête : flèche directionnelle si actif, sinon
   *  l'icône neutre « triable » (affordance discrète). */
  protected sortIcon(col: TripSortColumn) {
    const dir = this.sortIndicator(col);
    if (dir === 'asc') return this.ArrowUpIcon;
    if (dir === 'desc') return this.ArrowDownIcon;
    return this.ArrowUpDownIcon;
  }

  /**
   * Clic sur la carte KPI « Vitesse max » → trie le tableau par maxSpeed desc,
   * scrolle vers le tableau et surligne brièvement la 1ʳᵉ ligne (le trajet le
   * plus rapide) ~2,5 s. Drilldown KPI→trajet (objectif #4).
   */
  /**
   * Ramène TOUT le rapport (indicateurs, graphiques, synthèse, liste) sur un seul véhicule.
   *
   * ⚠️ Le groupe est effacé en même temps : un véhicule sélectionné dans un groupe qui ne le
   * contient pas donnerait un rapport vide, et l'utilisateur croirait le véhicule à l'arrêt.
   */
  protected async filtrerSurVehicule(vehicleId: string): Promise<void> {
    if (this.selectedVehicleId() === vehicleId) return;
    this.selectedGroupId.set('');
    this.selectedVehicleId.set(vehicleId);
    this.oublierStatsPeriode();
    this.ecrireEtatDansUrl();
    await this.loadData();
    this.ramenerSurLeRecap();
  }

  protected onMaxSpeedKpiClick(): void {
    this.onKpiClick('maxSpeed');
  }

  /**
   * ── UN INDICATEUR EST UN POINT D'ENTRÉE, PAS UNE IMPASSE (F18) ─────────────────────
   *
   * Chaque carte désigne exactement les lignes qui sont en dessous ; cliquer trie la liste
   * sur cette grandeur et y amène. Le tri part EN BASE, donc il porte sur toute la période
   * et pas sur la page chargée — sans quoi « le trajet le plus rapide » serait le plus
   * rapide des cent premiers.
   */
  protected onKpiClick(kpi: 'tripCount' | 'totalDistance' | 'totalDuration' | 'maxSpeed'): void {
    const col = kpiToSortColumn(kpi);
    if (!col) return;
    this.sortBy.set(col);
    this.sortDir.set('desc');
    this.ecrireEtatDansUrl();
    // Le trajet le plus rapide de la PÉRIODE n'est connu qu'après la réponse serveur :
    // on arme le surlignage, `loadTrips` l'applique sur la 1ʳᵉ ligne reçue.
    this.highlightTopAfterLoad = true;
    void this.loadTrips();
    // Scroll tout de suite : le tableau est déjà à l'écran, l'attente de la réponse
    // se voit alors sur les lignes qu'on regarde plutôt qu'en haut de page.
    queueMicrotask(() => {
      this.tableEl()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /** Surligne un trajet ~2,5 s puis retire le highlight. Idempotent. */
  private flashHighlight(tripId: string): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTripId.set(tripId);
    this.highlightTimer = setTimeout(() => {
      this.highlightTripId.set(null);
      this.highlightTimer = null;
    }, 2500);
  }

  // ─── Charts datasets ────────────────────────────────────────────────────
  /** Series journaliere remplie (jours sans trajet a 0) entre periodFrom et
   *  periodTo. Format compact "12 mai" pour l'axe X. */
  protected readonly lineBarData = computed<LineBarChartData>(() => {
    this.periodKey(); // déclenche reactif sur changement de période
    const summary = this.dailySummary();
    const map = new Map(summary.map((s) => [s.date, s]));
    const dates = this.dateRange(this.periodFrom, this.periodTo);
    const fmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' });
    const labels: string[] = [];
    const tripCounts: number[] = [];
    const distancesKm: number[] = [];
    const durationsHours: number[] = [];
    for (const d of dates) {
      const entry = map.get(d);
      // Midi et non minuit : `new Date('AAAA-MM-JJ')` est minuit UTC, soit la VEILLE au soir
      // pour un utilisateur à l'ouest de Greenwich — l'axe se décalait d'un jour.
      labels.push(fmt.format(new Date(`${d}T12:00:00`)));
      tripCounts.push(entry?.tripCount ?? 0);
      distancesKm.push(entry ? Math.round(entry.totalDistanceMeters / 100) / 10 : 0);
      durationsHours.push(entry ? Math.round((entry.totalDurationSeconds / 3600) * 100) / 100 : 0);
    }
    return { labels, tripCounts, distancesKm, durationsHours };
  });

  /** Maxspeeds clampes pour l'histogramme (0..250 km/h). Recalcule a chaque
   *  changement de trips() (filtre vehicule, periode). */
  /**
   * Agrégat SERVEUR des deux graphiques de période (vitesses + fréquentation).
   *
   * ⚠️ Ils se calculaient depuis `trips()`, borné à 100 par la requête, tout en
   * s'annonçant « sur la période ». Sur 30 jours et 2 738 trajets, la fréquentation ne
   * couvrait qu'une journée et affichait zéro trajet le mardi, quand le tableau de la
   * même page en comptait 132. Un graphique faux mais dessiné a plus d'autorité qu'un
   * tableau juste — c'est ce qui rendait l'écart si trompeur.
   */
  protected readonly periodCharts = signal<TripPeriodChartsDto | null>(null);

  protected readonly histoValues = computed<number[]>(() => {
    const agg = this.periodCharts();
    // Repli sur l'échantillon tant que l'agrégat n'est pas arrivé (ou s'il a échoué) :
    // un graphique partiel vaut mieux qu'une zone vide, et le titre dit lequel des deux
    // est affiché.
    return agg ? agg.speeds : this.trips().map((t) => this.clampSpeed(t.maxSpeed));
  });

  /** Matrice 7×24 (lun→dim, 0h→23h) du nombre de trajets demarres à cette case horaire. */
  protected readonly heatmapData = computed<number[][]>(() => {
    const agg = this.periodCharts();
    if (agg) return agg.heatmap;
    const matrix: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const t of this.trips()) {
      if (!t.startedAt) continue;
      const d = new Date(t.startedAt);
      // Convention FR/ISO : lundi = 0, dimanche = 6
      const day = (d.getDay() + 6) % 7;
      const hour = d.getHours();
      if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
        matrix[day]![hour]! += 1;
      }
    }
    return matrix;
  });

  // ─── Sparkline KPI cards ────────────────────────────────────────────────
  /** Bars sparkline pour le KPI Trajets. Prend les 7 derniers jours du
   *  dailySummary (pas les 7 derniers de la periode, juste les 7 dernieres
   *  entrees ayant des donnees). */
  protected readonly sparkTripBars = computed(() => {
    const ds = this.dailySummary().slice(-7);
    if (ds.length === 0) return [];
    const max = Math.max(1, ...ds.map((s) => s.tripCount));
    const w = 84;
    const h = 28;
    const gap = 2;
    const barW = (w - gap * (ds.length - 1)) / ds.length;
    return ds.map((s, i) => {
      const ratio = s.tripCount / max;
      const barH = ratio * (h - 2);
      return {
        x: i * (barW + gap),
        y: h - Math.max(2, barH),
        w: barW,
        h: Math.max(2, barH),
      };
    });
  });

  /** Path SVG de la sparkline distance cumulee (toute la periode). */
  protected readonly sparkDistancePath = computed(() => {
    const ds = this.dailySummary();
    if (ds.length === 0) return '';
    const w = 84;
    const h = 28;
    let cumul = 0;
    const points = ds.map((s) => {
      cumul += s.totalDistanceMeters / 1000;
      return cumul;
    });
    const min = points[0]!;
    const max = points[points.length - 1]!;
    const range = max - min || 1;
    const stepX = ds.length > 1 ? w / (ds.length - 1) : w;
    let path = '';
    for (let i = 0; i < points.length; i++) {
      const x = i * stepX;
      const y = h - ((points[i]! - min) / range) * (h - 2) - 1;
      path += i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return path;
  });

  /** Path SVG du fill sous la ligne (zone). */
  protected readonly sparkDistanceFillPath = computed(() => {
    const linePath = this.sparkDistancePath();
    if (!linePath) return '';
    return `${linePath} L84,28 L0,28 Z`;
  });

  /** Duree moyenne par jour AYANT eu au moins un trajet. Plus parlant que
   *  une moyenne sur toute la periode (qui serait diluee par les jours off). */
  protected readonly avgDurationPerActiveDay = computed(() => {
    const ds = this.dailySummary();
    if (ds.length === 0) return '0min';
    const total = ds.reduce((a, b) => a + b.totalDurationSeconds, 0);
    return this.formatDuration(Math.round(total / ds.length));
  });

  /** Couleur du dot vitesse selon les seuils du marker live (cf
   *  shared/utils/maplibre-markers.ts speedColor). */
  protected readonly speedDotColor = computed(() => {
    const max = this.kpis().maxSpeed;
    if (max < 90) return '#10E0A0';
    if (max < 110) return '#F59E0B';
    return '#EF4444';
  });

  protected readonly speedDotLabel = computed(() => {
    const max = this.kpis().maxSpeed;
    if (max < 90) return 'Allure modérée';
    if (max < 110) return 'Vitesse soutenue';
    return 'Survitesse détectée';
  });

  /**
   * Les jours civils de [from, to[, au format AAAA-MM-JJ.
   *
   * ⚠️ PLAFONNÉ À `MAX_JOURS_GRAPHIQUE` : au-delà, les barres deviennent des traits d'un
   * pixel et le graphique ne se lit plus. Ce plafond est légitime — mais il était SILENCIEUX :
   * une période de six mois affichait les trois derniers, sous un titre qui promettait la
   * période. Le lecteur en concluait que les mois manquants n'avaient aucune activité.
   * `joursTronques()` le dit désormais sous le titre.
   */
  private dateRange(from: string, to: string): string[] {
    if (!from || !to) return [];
    const out: string[] = [];
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
    const cur = new Date(start);
    while (cur < end) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    if (out.length > MAX_JOURS_GRAPHIQUE) return out.slice(-MAX_JOURS_GRAPHIQUE);
    return out;
  }

  /**
   * Nombre de jours que le graphique d'activité NE MONTRE PAS, ou zéro.
   *
   * ⚠️ Compté sur la période demandée, pas sur les données reçues : un mois sans le moindre
   * trajet doit compter comme un mois non montré, sinon le silence se réinstalle exactement
   * là où il trompait déjà.
   */
  protected readonly joursTronques = computed(() => {
    this.periodKey();
    const f = this.periodFrom, t = this.periodTo;
    if (!f || !t) return 0;
    const debut = new Date(`${f}T00:00:00Z`).getTime();
    const fin = new Date(`${t}T00:00:00Z`).getTime();
    if (!Number.isFinite(debut) || !Number.isFinite(fin)) return 0;
    const jours = Math.round((fin - debut) / 86_400_000);
    return Math.max(0, jours - MAX_JOURS_GRAPHIQUE);
  });

  /** Delegue a `reports.utils#max0` (verrouille par tests). */
  protected max0(n: number): number {
    return max0Fn(n);
  }

  /** Delegue a `reports.utils#clampSpeed` (verrouille par tests). */
  protected clampSpeed(n: number): number {
    return clampSpeedFn(n);
  }

  /**
   * Resout la plaque d'un vehicule à partir de son id, via la liste deja
   * chargee `vehicles()`. Retourne `null` si non trouve (vehicule pas encore
   * charge ou supprime). Affiche dans le tableau sous la date de depart.
   */
  protected vehiclePlate(vehicleId: string | null | undefined): string | null {
    if (!vehicleId) return null;
    return this.vehicleById().get(vehicleId)?.plate ?? null;
  }

  /** Groupe du véhicule d'un trajet, résolu depuis la liste déjà chargée. */
  protected vehicleGroup(vehicleId: string | null | undefined): { id: string; name: string } | null {
    if (!vehicleId) return null;
    return this.vehicleById().get(vehicleId)?.group ?? null;
  }

  /** Marque + modèle d'un véhicule (ligne secondaire du tableau par véhicule). */
  protected vehicleModelLabel(vehicleId: string): string {
    const v = this.vehicleById().get(vehicleId);
    if (!v) return '—';
    return [v.brand, v.model].filter(Boolean).join(' ') || '—';
  }

  /**
   * Synthèse PAR VÉHICULE de la période (réf. maquette Rapports) : agrège les
   * trajets déjà chargés (distance / conduite / nb trajets / vitesse moy). Vue
   * complémentaire du tableau détaillé par trajet — n'enlève rien, ajoute un
   * rollup lisible. Triée par distance décroissante.
   */
  /**
   * Récapitulatif serveur de la PÉRIODE — `null` tant qu'il n'est pas arrivé, ou s'il a échoué.
   */
  /** Query de la dernière vue consultée, proposée en une ligne — ou `null`. */
  protected readonly vueProposee = signal<string | null>(null);

  /** Ce que la dernière vue contenait, en français, pour que la proposition soit lisible. */
  protected readonly libelleVueProposee = computed(() => {
    const q = this.vueProposee();
    if (!q) return '';
    const p = new URLSearchParams(q);
    const morceaux: string[] = [];
    const veh = p.get('vehicle');
    if (veh) morceaux.push(this.vehiclePlate(veh) || 'un véhicule');
    else if (p.get('group')) morceaux.push('un groupe');
    // Le conducteur est nommé, comme le véhicule : la proposition doit dire ce qu'elle va
    // appliquer. « Reprendre votre dernier rapport » ne doit poser aucun filtre en silence.
    //
    // ⚠️ NORMALISÉ ICI AUSSI, exactement comme dans `reprendreVue` juste dessous. La chaîne
    // mémorisée a pu être écrite par une version antérieure de l'écran : comparée BRUTE,
    // « NONE » n'égale pas le mot-clé et un UUID en majuscules ne retrouve pas sa ligne dans
    // `driverOptions`. La proposition annonçait alors « un conducteur » avant d'appliquer, elle,
    // la forme canonique — le libellé et le clic ne décrivaient pas le même filtre.
    const cond = normaliserFiltreConducteur(p.get('driver'));
    if (cond === CONDUCTEUR_AUCUN) morceaux.push('sans conducteur');
    else if (cond) morceaux.push(this.driverOptions().find((d) => d.id === cond)?.nom ?? 'un conducteur');
    const du = p.get('from'), au = p.get('to');
    if (du && au) morceaux.push(`du ${this.jourCourt(du)} au ${this.jourCourt(au, -1)}`);
    return morceaux.length ? morceaux.join(' · ') : 'vos derniers filtres';
  });

  /** « 12 août » à partir d'un AAAA-MM-JJ, avec décalage de jours facultatif. */
  private jourCourt(iso: string, decalage = 0): string {
    const d = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    d.setDate(d.getDate() + decalage);
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  /** Applique la vue proposée : mêmes chemins que les filtres, pas de raccourci. */
  protected reprendreVue(): void {
    const q = this.vueProposee();
    this.vueProposee.set(null);
    if (!q) return;
    const p = new URLSearchParams(q);
    const veh = p.get('vehicle'), grp = p.get('group');
    this.selectedVehicleId.set(veh ?? '');
    this.selectedGroupId.set(veh ? '' : (grp ?? ''));
    // Même normalisation qu'au démarrage : la vue mémorisée est une chaîne, pas un état de
    // confiance — elle a pu être écrite par une version antérieure de l'écran.
    this.selectedDriverId.set(normaliserFiltreConducteur(p.get('driver')) ?? '');
    const tri = p.get('sort') as TripSortColumn | null;
    if (tri && this.sortOptions.some((o) => o.col === tri)) this.sortBy.set(tri);
    const sens = p.get('dir');
    if (sens === 'asc' || sens === 'desc') this.sortDir.set(sens);
    /**
     * ⚠️ LA MÊME GARDE QUE LES SIX AUTRES CHEMINS DE PÉRIMÈTRE, et elle manquait ici seule.
     *
     * `ecrireEtatDansUrl` n'écrit `from`/`to` que si la période s'écarte du défaut : une vue
     * mémorisée sur « 7 jours » vaut donc « driver=<uuid> » tout court, et la reprise passait
     * par la branche `else`, qui rechargeait sans jamais oublier la synthèse. Or `ngOnInit` l'a
     * déjà remplie, NON filtrée. Le temps de l'aller-retour, le carburant, le parc actif, les
     * alertes et le récapitulatif décrivaient donc toute la société sous le nom d'une personne
     * — avec, à côté, les mentions de ce lot qui AFFIRMENT le filtre. Pire : un tri ou un clic
     * de KPI pendant cette fenêtre incrémente `loadSeq` sans relancer la synthèse, qui reste
     * alors fausse jusqu'au prochain changement de filtre.
     *
     * Posée AVANT le `if`, elle couvre les deux branches — donc aussi le véhicule et le groupe,
     * qui avaient le même trou. `setPeriod` la rappelle : `statsPeriode.set(null)` deux fois de
     * suite ne coûte rien.
     */
    this.oublierStatsPeriode();
    const du = p.get('from'), au = p.get('to');
    if (estJourIso(du) && estJourIso(au) && du! <= au!) {
      this.customFrom.set(du!);
      this.customTo.set(au!);
      this.setPeriod(du!, au!);
    } else {
      this.ecrireEtatDansUrl();
      void this.loadData();
    }
  }

  protected readonly statsPeriode = signal<FleetStatsReportDto | null>(null);

  /**
   * Indicateurs de la période PRÉCÉDENTE, ou `null` tant qu'ils ne sont pas là.
   *
   * ⚠️ `null` ≠ « zéro trajet ». Un zéro affiché comme référence produirait « +100 % » sur
   * une flotte qui n'a simplement pas encore répondu — la pire des tendances, parce qu'elle
   * est plausible.
   */
  protected readonly kpisPrecedents = signal<ReportsKpis | null>(null);

  /**
   * La tendance d'un indicateur, prête à écrire — ou `null` quand elle n'a pas de sens.
   *
   * ⚠️ Rend `null` AUSSI quand la période précédente était vide : passer de 0 à 65 trajets
   * n'est pas « +6 500 % ». L'écran écrit alors la phrase, au lieu d'un nombre qui
   * impressionne sans informer.
   */
  protected tendance(cle: 'tripCount' | 'totalDistance' | 'totalDuration'): { texte: string; hausse: boolean } | null {
    const avant = this.kpisPrecedents();
    if (!avant) return null;
    const e = ecartAvecPeriodePrecedente(this.kpis()[cle], avant[cle]);
    const texte = libelleEcartPeriode(this.kpis()[cle], avant[cle]);
    if (!texte) return null;
    return { texte, hausse: (e.pourcent ?? 0) > 0 };
  }

  /** Vrai quand la période précédente est connue ET vide : on le DIT plutôt qu'un taux. */
  protected readonly periodePrecedenteVide = computed(() => {
    const avant = this.kpisPrecedents();
    return !!avant && avant.tripCount === 0;
  });

  /**
   * ── LE PREMIER TABLEAU QU'ON LIT ÉTAIT FAUX DÈS L'OUVERTURE ─────────────────────────
   *
   * Ce récapitulatif agrégeait les trajets CHARGÉS — cent lignes sur 391 — et non la période.
   * C'est le tableau qu'un gestionnaire regarde en premier pour comparer ses véhicules. Il
   * portait bien la mention « sur les N trajets chargés », ce qui vaut mieux que rien, mais
   * annoncer qu'un chiffre est partiel ne le rend pas juste : on comparait deux véhicules sur
   * des échantillons différents, et le classement pouvait s'inverser à la page suivante.
   *
   * Il vient désormais de l'agrégat SERVEUR, calculé sur toute la période.
   *
   * ⚠️ LE REPLI CLIENT RESTE, et il est nécessaire : si l'agrégat n'est pas encore arrivé ou
   * a échoué, un tableau vide ferait croire à une flotte à l'arrêt. On retombe alors sur les
   * trajets chargés — et `recapPartiel()` le DIT, au lieu de le laisser deviner.
   */
  protected readonly recapPartiel = computed(() => this.statsPeriode() === null);

  /**
   * ── L'AGRÉGAT DE PÉRIODE EST MONO-SOCIÉTÉ, ET NE SAIT PAS LE DIRE ──────────────────
   *
   * `GET /reports/stats` retient UNE flotte : celle passée en paramètre, à défaut celle de
   * l'appelant, à défaut LA PLUS ANCIENNE DE LA BASE. Un super-administrateur qui regarde
   * « toutes les sociétés » recevait donc, sans un mot, la synthèse d'une société tirée au
   * sort — mesuré en recette le 2026-09-04 : 62 trajets là où le reste de l'écran en comptait
   * 481, et « 0 véhicule actif sur 7 » sous un indicateur annonçant 65 trajets.
   *
   * Tant que cette route reste mono-société, l'écran ne demande la synthèse QUE lorsqu'une
   * société est réellement désignée. Il le DIT (cf. le bandeau sous les indicateurs) plutôt
   * que de laisser un blanc : une absence inexpliquée se lit comme une panne.
   */
  protected readonly synthesePeriodePossible = computed(() => {
    if (this.authService.user()?.role !== 'SUPER_ADMIN') return true;
    return this.fleetFilter.selectedFleetId() !== null;
  });

  /**
   * Les types d'alerte les plus fréquents de la période, en clair.
   *
   * ⚠️ Le libellé vient du contrat PARTAGÉ, celui qu'emploient déjà le PDF et le centre
   * d'alertes. Une table de traduction locale aurait produit, au premier type ajouté, un écran
   * qui dit « OVERSPEED » à côté d'un PDF qui dit « Excès de vitesse ».
   */
  /**
   * Part du parc ayant roulé au moins une fois, en pourcentage entier.
   *
   * ⚠️ Un parc VIDE rend 0, jamais NaN : ce chiffre s'affiche avant même qu'un véhicule
   * existe, sur une société qu'on vient de créer.
   */
  protected readonly tauxUtilisation = computed(() => {
    const st = this.statsPeriode();
    if (!st || st.vehicles.total === 0) return 0;
    return Math.round((st.vehicles.activeDuringPeriod / st.vehicles.total) * 100);
  });

  /**
   * Part du temps de conduite passée moteur tournant à l'arrêt, en pourcentage entier.
   *
   * ⚠️ Rapportée à la DURÉE de conduite, pas à la durée de la période : un parc qui roule
   * deux heures par jour aurait un « ralenti » de 2 % du mois, chiffre exact et sans usage.
   * Rendu 0 si la durée est nulle — jamais NaN.
   */
  protected readonly partRalenti = computed(() => {
    const st = this.statsPeriode();
    if (!st || st.trips.totalDurationHours <= 0) return 0;
    return Math.round((st.consumption.idleSecondsTotal / 3600 / st.trips.totalDurationHours) * 100);
  });

  protected readonly alertesParType = computed(() => {
    const st = this.statsPeriode();
    if (!st) return [];
    return [...st.alerts.byType]
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_TYPES_ALERTE_AFFICHES)
      .map((a) => ({ type: a.type, libelle: libelleTypeAlerte(a.type), count: a.count }));
  });

  /** Ce que la liste ci-dessus ne montre pas — compté, jamais tu. */
  protected readonly alertesAutres = computed(() => {
    const st = this.statsPeriode();
    if (!st) return 0;
    const montres = this.alertesParType().reduce((n, a) => n + a.count, 0);
    return Math.max(0, st.alerts.total - montres);
  });

  protected readonly vehicleSummary = computed(() => {
    const stats = this.statsPeriode();
    if (stats) {
      return stats.topVehicles.map((v) => ({
        vehicleId: v.vehicleId,
        distance: Math.round(v.distanceKm * 1000),
        duration: Math.round(v.durationHours * 3600),
        trips: v.tripCount,
        avgSpeed: v.avgSpeedKmh,
        speedingCount: v.speedingCount as number | null,
        speedingTripCount: v.speedingTripCount,
        worstOverKmh: v.worstOverKmh,
      }));
    }
    const by = new Map<string, { vehicleId: string; distance: number; duration: number; trips: number; speedSum: number }>();
    for (const t of this.trips()) {
      if (!t.vehicleId) continue;
      const e = by.get(t.vehicleId) ?? { vehicleId: t.vehicleId, distance: 0, duration: 0, trips: 0, speedSum: 0 };
      e.distance += this.max0(t.distanceMeters);
      e.duration += t.durationSeconds || 0;
      e.trips += 1;
      e.speedSum += this.clampSpeed(t.avgSpeed);
      by.set(t.vehicleId, e);
    }
    return [...by.values()]
      .map((e) => ({
        vehicleId: e.vehicleId,
        distance: e.distance,
        duration: e.duration,
        trips: e.trips,
        avgSpeed: e.trips ? Math.round(e.speedSum / e.trips) : 0,
        // ⚠️ Valeur NULLE, pas zéro : le repli client n'a pas les analyses sous la main.
        // Écrire 0 ici innocenterait un véhicule sans l'avoir regardé — exactement le genre
        // de faux qu'on vient de retirer du reste de ce tableau.
        speedingCount: null as number | null,
        speedingTripCount: 0,
        worstOverKmh: 0,
      }))
      .sort((a, b) => b.distance - a.distance);
  });

  // ═══ RÉCAPITULATIF « PAR CONDUCTEUR OU GROUPE » (F13) ═══════════════════════════════
  //
  // La carte répondait à « quel véhicule roule et dépasse ? ». Elle répond désormais aussi
  // à « combien de kilomètres a fait tel conducteur ce mois-ci, avec combien d'excès ? ».
  // L'imputation vient du SERVEUR, avec la clé du classement des scores (conducteur si
  // connu, sinon groupe du véhicule) : la recalculer ici la ferait diverger au premier
  // changement de règle.

  /**
   * Position DEMANDÉE par l'utilisateur. Distincte de la position EFFECTIVE : on la garde
   * telle quelle quand l'imputation devient indisponible (changement de société), pour que
   * la vue revienne d'elle-même dès que la synthèse est là.
   */
  private readonly vueRecapDemandee = signal<'vehicule' | 'attribution'>('vehicule');

  /**
   * ⚠️ L'IMPUTATION N'EXISTE QUE DANS L'AGRÉGAT DE PÉRIODE. Le repli « trajets chargés »
   * (société non choisie, synthèse en échec ou pas encore arrivée) ne connaît ni conducteur
   * ni groupe : il n'a que les trajets de la page courante. Fabriquer une vue depuis lui
   * afficherait un tableau vide sous un titre qui promet une imputation — un gestionnaire y
   * lirait « aucun trajet attribué », c'est-à-dire l'inverse de la vérité.
   *
   * Un serveur antérieur à ce lot ne sert pas le bloc : `Array.isArray` distingue « absent »
   * de « vide », et l'écran se tait au lieu d'afficher zéro.
   */
  protected readonly attributionDisponible = computed(() => Array.isArray(this.statsPeriode()?.byAttribution));

  /** Position EFFECTIVE — retombe sur « Par véhicule » tant que l'imputation manque. */
  protected readonly vueRecap = computed<'vehicule' | 'attribution'>(() =>
    this.vueRecapDemandee() === 'attribution' && this.attributionDisponible() ? 'attribution' : 'vehicule',
  );

  protected setVueRecap(vue: 'vehicule' | 'attribution'): void {
    this.vueRecapDemandee.set(vue);
  }

  /**
   * Pourquoi la bascule est indisponible, en toutes lettres — `null` quand elle l'est.
   *
   * ⚠️ Une absence INEXPLIQUÉE se lit comme une panne : le bouton reste visible et désactivé,
   * et cette phrase dit ce qu'il faut faire pour l'obtenir.
   */
  protected readonly motifAttributionIndisponible = computed<string | null>(() => {
    if (this.attributionDisponible()) return null;
    if (!this.synthesePeriodePossible()) {
      return 'La synthèse par conducteur se calcule société par société : choisissez une société dans le sélecteur en haut de page.';
    }
    if (this.recapPartiel()) {
      // ⚠️ Deux états sous une seule phrase : « elle arrive » était aussi servi quand la synthèse
      // avait ÉCHOUÉ — une promesse jamais tenue, sans recours, devant une bascule morte.
      return this.statsEchouee()
        ? 'La synthèse de période n\'a pas pu être calculée : le tableau ci-dessous agrège les trajets chargés. Rechargez la page pour réessayer.'
        : 'La synthèse par conducteur arrive avec la synthèse de période ; le tableau ci-dessous agrège pour l\'instant les trajets chargés.';
    }
    return 'La synthèse par conducteur ou groupe n\'est pas servie pour cette période.';
  });

  /**
   * Les lignes d'imputation, dans la MÊME unité que `vehicleSummary` (mètres et secondes) :
   * les cellules du tableau sont partagées entre les deux vues, elles ne doivent pas avoir
   * à savoir laquelle les alimente.
   */
  protected readonly attributionSummary = computed(() =>
    (this.statsPeriode()?.byAttribution ?? []).map((l) => ({
      key: l.key,
      label: l.label,
      kind: l.kind,
      /**
       * L'identifiant du conducteur, relu sur la clé (`driver:<id>`) — c'est ce que le
       * bouton « Filtrer » pose dans le filtre conducteur (F13).
       *
       * ⚠️ `null` sur une ligne de GROUPE, et le gabarit s'en sert pour n'offrir le bouton
       * qu'aux personnes : il n'existe pas de filtre par groupe d'imputation (celui de la
       * barre porte sur les véhicules, donc sur d'autres trajets que cette ligne).
       */
      driverId: l.kind === 'driver' ? l.key.slice('driver:'.length) : null,
      distance: Math.round(l.distanceKm * 1000),
      duration: Math.round(l.durationHours * 3600),
      trips: l.tripCount,
      avgSpeed: l.avgSpeedKmh,
      speedingCount: l.speedingCount,
      speedingTripCount: l.speedingTripCount,
      worstOverKmh: l.worstOverKmh,
    })),
  );

  /** Compte RÉEL des lignes d'imputation ; la liste servie est plafonnée comme le top véhicules. */
  protected readonly attributionTotal = computed(() => this.statsPeriode()?.byAttributionTotal ?? 0);

  /** Les trajets qu'on ne peut imputer à personne — comptés, jamais une ligne du tableau. */
  protected readonly nonAttribues = computed(() => this.statsPeriode()?.unattributedTrips ?? null);

  /**
   * Dénominateur de la mention « N sur M ».
   *
   * ⚠️ MÊME source que le numérateur (l'agrégat de période), et non `kpis()`, qui vient du
   * résumé journalier : deux comptes légèrement différents dans la même phrase feraient
   * douter des deux.
   */
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   * LES SECTIONS QUI SE REPLIENT — MOBILE D'ABORD
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * Mesuré sur la production le 2026-09-06, à 375 px : la page fait 50 129 px de haut.
   * 45 360 sont la liste des trajets (100 cartes d'analyse) ; les 4 769 restants sont ce
   * qu'il faut traverser AVANT d'atteindre le premier trajet, soit près de six écrans. Deux
   * blocs en portent la moitié :
   *
   *   - les trois graphiques (activité, vitesses, fréquentation)  1 134 px ;
   *   - le réglage du rapport hebdomadaire par e-mail             1 027 px.
   *
   * Ce sont exactement les deux qu'on consulte RAREMENT : le premier se regarde, il ne se
   * lit pas ; le second se règle une fois puis s'oublie. Les replier par défaut au doigt
   * rend 2 161 px — deux écrans et demi — sans rien retirer : l'en-tête reste, avec ce qu'il
   * contient, et un appui l'ouvre.
   *
   * ⚠️ REPLIÉ N'EST PAS ABSENT. Le contenu reste dans le DOM et c'est un CHOIX, pas une
   * facilité : masqué en CSS, il n'est ni peint ni mesuré, mais il redevient visible à
   * l'IMPRESSION, où le repli n'a aucun sens. Un Ctrl+P amputé de ses graphiques parce que
   * le lecteur les avait fermés à l'écran serait exactement le genre de piège que ce dépôt
   * passe son temps à retirer. Avec un `@if`, la page imprimée aurait perdu ces blocs.
   * L'en-tête, lui, ANNONCE ce qu'il cache et porte `aria-expanded` : un lecteur d'écran le
   * parcourt et l'ouvre comme n'importe quel bouton.
   */
  private readonly SECTIONS_REPLIABLES = ['graphiques', 'hebdo'] as const;

  /**
   * Ce que le lecteur a replié LUI-MÊME, mémorisé d'une visite à l'autre.
   *
   * ⚠️ On mémorise les sections FERMÉES, jamais les ouvertes : une section ajoutée demain
   * sera donc ouverte pour tout le monde. L'inverse la ferait naître invisible.
   */
  protected readonly sectionsRepliees = signal<ReadonlySet<string>>(new Set());

  /**
   * Vrai tant que la fenêtre est étroite. Les deux replis par défaut ne valent QUE là : sur
   * un écran large, tout tient sans effort et fermer des sections d'office serait une perte.
   */
  private readonly ecranEtroit = signal(false);

  protected estRepliee(cle: string): boolean {
    return this.sectionsRepliees().has(cle);
  }

  protected basculerSection(cle: string): void {
    const suivant = new Set(this.sectionsRepliees());
    if (suivant.has(cle)) suivant.delete(cle);
    else suivant.add(cle);
    this.sectionsRepliees.set(suivant);
    // ⚠️ On n'enregistre QUE des clés connues : une préférence qui accumulerait des clés
    // mortes finirait par replier une section qui n'existe plus, sans qu'on sache pourquoi.
    const propres = this.SECTIONS_REPLIABLES.filter((c) => suivant.has(c));
    this.preferences.update({ reportsSectionsRepliees: propres.join(',') });
  }

  /**
   * L'état de départ : la préférence si le lecteur en a une, sinon les deux replis par
   * défaut au doigt. Appelé une fois, au démarrage.
   */
  private initSectionsRepliees(): void {
    this.ecranEtroit.set(typeof matchMedia === 'function' && matchMedia('(max-width: 768px)').matches);
    const memo = (this.preferences.prefs().reportsSectionsRepliees || '')
      .split(',').map((c) => c.trim()).filter((c) => (this.SECTIONS_REPLIABLES as readonly string[]).includes(c));
    if (memo.length > 0) { this.sectionsRepliees.set(new Set(memo)); return; }
    // ⚠️ `aChoisi` distingue « jamais réglé » de « réglé à vide ». Sans lui, un lecteur qui a
    // délibérément TOUT ouvert au doigt retrouverait ses sections repliées à chaque visite.
    if (this.preferences.aChoisi('reportsSectionsRepliees')) return;
    if (this.ecranEtroit()) this.sectionsRepliees.set(new Set(this.SECTIONS_REPLIABLES));
  }

  /**
   * ── LE DÉTAIL D'ANALYSE, OUVERT CARTE PAR CARTE ──────────────────────────────────────
   *
   * Mesuré en production le 2026-09-06, à 375 px : 45 360 px pour cent cartes, soit 453 px
   * chacune — 90 % de la page. Le bloc d'analyse en est le premier poste, et l'essentiel y
   * tient sur sa première ligne : la note et les excès. Les estimations (litres, CO₂,
   * fiabilité GPS) et l'extrait du récit sont ce qu'on lit sur UN trajet qu'on a choisi,
   * jamais sur cent qu'on fait défiler.
   *
   * ⚠️ ON MÉMORISE LES CARTES OUVERTES, pas les fermées — l'inverse de ce que fait le repli
   * des sections, et pour la raison inverse : ici la valeur par défaut est « fermé » pour
   * toutes, y compris les trajets qui arriveront à la page suivante. Une liste de cartes
   * fermées grandirait sans fin, et le premier « Charger plus » l'aurait déjà fait mentir.
   *
   * ⚠️ RIEN N'EST PERSISTÉ. Ce choix vaut pour la consultation en cours : retrouver, une
   * semaine plus tard, trois cartes ouvertes au milieu d'une liste dont les trajets ont
   * changé n'aurait aucun sens.
   */
  private readonly detailsTrajet = signal<ReadonlySet<string>>(new Set());

  protected detailTrajetOuvert(tripId: string): boolean {
    return this.detailsTrajet().has(tripId);
  }

  protected basculerDetailTrajet(tripId: string): void {
    const suivant = new Set(this.detailsTrajet());
    if (suivant.has(tripId)) suivant.delete(tripId);
    else suivant.add(tripId);
    this.detailsTrajet.set(suivant);
  }

  protected readonly totalTrajetsPeriode = computed(() => this.statsPeriode()?.trips.count ?? 0);

  /**
   * Part en pourcentage, sans jamais contredire les nombres qu'elle accompagne : « 1 sur
   * 1 000 » n'est pas « 0 % » et « 999 sur 1 000 » n'est pas « 100 % » — l'arrondi ne peut
   * affirmer un extrême que si les nombres l'atteignent vraiment. Dénominateur nul : « 0 % ».
   *
   * ⚠️ LA RÈGLE VIT DANS LE CONTRAT PARTAGÉ, plus ici. Elle avait été recopiée TROIS fois —
   * cet écran, celui des scores, le PDF — sur les MÊMES trajets et sous les MÊMES yeux : le
   * gestionnaire ouvre son PDF à côté de son écran, et « 99 % » ici contre « 100 % » là-bas
   * se lit comme une erreur de calcul, pas comme une nuance d'arrondi.
   *
   * ⚠️ Réexposée en propriété de classe parce que le GABARIT l'appelle : une fonction de
   * module n'est pas atteignable depuis un template Angular, et la perdre casserait le rendu
   * de la mention « N trajets sur M » sans que rien ne le signale à la compilation.
   */
  protected readonly partLibelle = partLibelle;

  // ─── Period replay ────────────────────────────────────────────────────
  /** Modal replay-periode ouverte ? Toggled par `onOpenPeriodReplay`. */
  protected readonly periodReplayOpen = signal(false);

  /** Vrai si on peut lancer un replay periode (vehicule selectionne + au
   *  moins 1 trip dans la periode). */
  protected readonly canPeriodReplay = computed(() => {
    if (!this.selectedVehicleId()) return false;
    return this.trips().length > 0;
  });

  /** Type vehicule pour le marker du period-replay. */
  protected readonly periodReplayVehicleType = computed(() => {
    const id = this.selectedVehicleId();
    if (!id) return 'OTHER';
    const v = this.vehicles().find((x) => x.id === id);
    return v?.type ?? 'OTHER';
  });

  /** Plaque du vehicule selectionne, pour le badge dans le HUD du replay. */
  protected readonly periodReplayPlate = computed<string | null>(() => {
    const id = this.selectedVehicleId();
    if (!id) return null;
    const v = this.vehicles().find((x) => x.id === id);
    return v?.plate ?? null;
  });

  /**
   * Replay de période : recharge les trajets AVEC leurs tracés, toutes pages confondues,
   * sur les mêmes filtres que la liste. C'est le seul moment où les polylignes sont
   * nécessaires — les charger ici plutôt qu'avec la liste divise par trois le poids de
   * chaque page du tableau. Borné à 20 pages (2 000 trajets) : au-delà, un replay n'est
   * plus lisible de toute façon.
   */
  protected async onOpenPeriodReplay(): Promise<void> {
    if (!this.canPeriodReplay() || this.periodReplayLoading()) return;
    this.periodReplayLoading.set(true);
    try {
      const { tripParams } = this.buildFilterParams();
      const params: Record<string, string> = { ...tripParams, sortBy: 'startedAt', sortDir: 'asc' };
      delete params['light'];
      const all: TripDto[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const res: { items: TripDto[]; nextCursor: string | null } = await firstValueFrom(
          this.tripsApi.list(cursor ? { ...params, cursor } : params),
        );
        all.push(...res.items);
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      this.periodReplayTrips.set(all);
      this.periodReplayOpen.set(true);
    } catch (err) {
      swallow('reports:onOpenPeriodReplay', err);
      this.toast.error('Replay indisponible', httpFailureMessage(err, 'les tracés de la période'));
    } finally {
      this.periodReplayLoading.set(false);
    }
  }

  /**
   * Index des véhicules par id. Les résolutions plaque / groupe / modèle se faisaient par
   * `find()` sur la liste, à chaque ligne ET à chaque cycle de détection : 400 lignes × 3
   * lookups × 44 véhicules à chaque frappe — invisible sur un portable, sensible au pouce.
   */
  protected readonly vehicleById = computed(() => new Map(this.vehicles().map((v) => [v.id, v])));

  protected readonly replayVehicleType = computed(() => {
    const trip = this.replayTrip();
    if (!trip) return 'OTHER';
    return this.vehicleById().get(trip.vehicleId)?.type ?? 'OTHER';
  });

  protected readonly isAdmin = computed(() => {
    const role = this.authService.user()?.role;
    return role === 'SUPER_ADMIN' || role === 'FLEET_ADMIN';
  });

  ngOnInit(): void {
    // Avant tout le reste : ce que le lecteur voit se déplier dépend de la largeur, et la
    // largeur ne change pas selon les filtres.
    this.initSectionsRepliees();
    /**
     * ── LA PAGE N'AVAIT AUCUN ÉTAT D'URL (F08) ────────────────────────────────────────
     *
     * Aucun `Router` n'était injecté : un rafraîchissement ramenait à « 7 jours / tous
     * véhicules », il était impossible de mettre un rapport en favori, et « regarde ce
     * véhicule sur août » ne pouvait pas s'envoyer — il fallait décrire les clics.
     *
     * Les paramètres lus ici sont ceux qu'on écrit ci-dessous ; ils sont VALIDÉS, jamais
     * appliqués tels quels : une URL bricolée à la main ne doit pas pouvoir mettre l'écran
     * dans un état qu'aucun clic ne produit.
     */
    const q = this.route.snapshot.queryParamMap;
    const veh = q.get('vehicle');
    const grp = q.get('group');
    if (veh) this.selectedVehicleId.set(veh);
    if (grp && !veh) this.selectedGroupId.set(grp);
    // Conducteur : NORMALISÉ avant d'être posé, pas seulement validé. Valider une chaîne trimée
    // puis mémoriser la chaîne brute, c'est exactement ce que ce garde prétendait interdire — un
    // état qu'aucun clic ne produit. `?driver=%20none` partait alors tel quel : 400 sur la liste,
    // 200 filtrés sur les compteurs. Ce qui est posé ici est ce qui sera envoyé.
    const cond = normaliserFiltreConducteur(q.get('driver'));
    if (cond) this.selectedDriverId.set(cond);
    const tri = q.get('sort') as TripSortColumn | null;
    if (tri && this.sortOptions.some((o) => o.col === tri)) this.sortBy.set(tri);
    const sens = q.get('dir');
    if (sens === 'asc' || sens === 'desc') this.sortDir.set(sens);

    // V1.12 — Défaut = "7 jours" (periods[1]) au lieu de "Aujourd'hui"
    // (periods[0]) : la majorité des flottes n'ont pas encore de trajets en
    // début de journée, ce qui rendait la page Rapports vide à l'ouverture
    // (impression d'UI cassée). 7 j montre du contenu immédiatement.
    const du = q.get('from'), au = q.get('to');
    if (estJourIso(du) && estJourIso(au) && du! <= au!) {
      this.customFrom.set(du!);
      this.customTo.set(au!);
      this.setPeriod(du!, au!);
    } else {
      this.setPeriod(this.periods()[1]!.from, this.periods()[1]!.to);
    }
    // ⚠️ APRÈS le chargement : le trajet du lien profond n'est pas forcément dans la page
    // affichée (il peut être le 400ᵉ), donc on va le chercher à part plutôt que de fouiller
    // une liste qui ne le contient peut-être pas.
    const trajet = q.get('trip');
    if (trajet) void this.ouvrirTrajetDuLien(trajet);
    /**
     * ⚠️ PROPOSÉE, jamais appliquée d'office, et seulement quand l'URL n'apporte AUCUN
     * filtre. Ouvrir un rapport sur une période d'il y a trois semaines parce que c'est la
     * dernière regardée serait une surprise — et le lecteur ne verrait pas forcément que les
     * dates ne sont pas celles du jour.
     */
    if (q.keys.length === 0) {
      const derniere = this.preferences.prefs().reportsLastView;
      if (derniere) this.vueProposee.set(derniere);
    }
    this.loadVehicles();
    // Le menu conducteur n'apparaît qu'une fois cette liste là ; l'écran reste utilisable
    // sans elle (cf. `loadDrivers`, qui ne montre aucun bandeau en cas d'échec).
    void this.loadDrivers();
    this.desktopMql?.addEventListener('change', this.desktopMqlListener);
    this.armerBasculeDeMinuit();
  }

  ngOnDestroy(): void {
    this.desktopMql?.removeEventListener('change', this.desktopMqlListener);
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    if (this.minuitTimer) clearTimeout(this.minuitTimer);
    this.moreObserver?.disconnect();
    this.moreObserver = null;
  }

  /**
   * Retour dans l'onglet : le jour a pu changer pendant que l'application dormait.
   * C'est le cas réel d'une tablette d'atelier laissée allumée toute la nuit.
   */
  @HostListener('document:visibilitychange')
  protected onVisibiliteChangee(): void {
    if (typeof document !== 'undefined' && !document.hidden) this.rafraichirJour();
  }

  /**
   * Échap ferme le panneau ou le menu OUVERT, du plus récent au plus ancien, et rend le
   * focus à son déclencheur.
   *
   * ⚠️ Seul le panneau « Personnalisé » était traité. Les deux menus déroulants, eux, ne
   * se fermaient qu'en tabulant hors d'eux — et leur fond `rep-dropdown-backdrop`
   * (position: fixed, z-index 50) restait posé sur la page entière, donc plus rien
   * n'était cliquable derrière.
   */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.groupDropdownOpen()) { this.fermerMenuGroupe(); return; }
    if (this.vehicleDropdownOpen()) { this.fermerMenuVehicule(); return; }
    if (this.driverDropdownOpen()) { this.fermerMenuConducteur(); return; }
    if (this.customRangeOpen()) this.fermerPlagePerso();
  }

  /**
   * ⚠️ Toute rupture de périmètre efface l'agrégat AVANT de recharger. Le laisser en place
   * afficherait, pendant une seconde, le récapitulatif de la période précédente sous le titre
   * de la nouvelle — exactement le genre de faux qu'on vient de retirer de cet écran.
   */
  private oublierStatsPeriode(): void {
    this.statsPeriode.set(null);
    this.statsEchouee.set(false);
  }

  /**
   * La synthèse de période a-t-elle ÉCHOUÉ (par opposition à « pas encore arrivée ») ? Les deux
   * laissent `statsPeriode()` nul, et l'écran doit les distinguer : « elle arrive » devant une
   * requête morte est une promesse qu'on ne tiendra pas.
   */
  private readonly statsEchouee = signal(false);

  protected setPeriod(from: string, to: string): void {
    this.oublierStatsPeriode();
    this.periodFrom = from;
    this.periodTo = to;
    this.periodKey.set(`${from}|${to}`);
    this.ecrireEtatDansUrl();
    this.loadData();
  }

  /**
   * Reporte l'état de l'écran dans l'URL — véhicule, groupe, période, tri et sens.
   *
   * ⚠️ `replaceUrl` : chaque clic de filtre empilerait sinon une entrée d'historique, et le
   * bouton « précédent » deviendrait un défilement de filtres au lieu de ramener à l'écran
   * précédent. On veut une URL PARTAGEABLE, pas un journal de navigation.
   *
   * ⚠️ Les valeurs par défaut ne sont PAS écrites : une URL qui porte tout, y compris ce qui
   * n'a pas été choisi, est illisible et se périme (« 7 jours » n'est pas une date). Seul ce
   * qui s'écarte du défaut mérite d'être transporté.
   */
  private ecrireEtatDansUrl(): void {
    const parDefaut = this.periods()[1];
    const periodePersonnalisee = !parDefaut || this.periodFrom !== parDefaut.from || this.periodTo !== parDefaut.to;
    const params: Record<string, string | null> = {
      vehicle: this.selectedVehicleId() || null,
      group: this.selectedGroupId() || null,
      // Le filtre conducteur voyage comme les autres : une URL qui montre les trajets d'une
      // personne doit pouvoir s'envoyer, sinon il faut décrire les clics (cf. F08).
      driver: this.selectedDriverId() || null,
      from: periodePersonnalisee ? this.periodFrom : null,
      to: periodePersonnalisee ? this.periodTo : null,
      sort: this.sortBy() !== TRI_PAR_DEFAUT.col ? this.sortBy() : null,
      dir: this.sortDir() !== TRI_PAR_DEFAUT.dir ? this.sortDir() : null,
      // ⚠️ Le trajet ouvert n'est PAS écrit ici : il l'est à l'ouverture du replay et effacé
      // à sa fermeture. L'écrire ici le remettrait sur chaque changement de filtre.
    };
    this.majParametresUrl(params);
    /**
     * ── LA DERNIÈRE VUE (F09) ─────────────────────────────────────────────────────────
     *
     * Un suivi récurrent — « groupe Livraisons / mois en cours » — se reposait sur la mémoire
     * de l'utilisateur : la page rouvrait sur « 7 jours / tous véhicules », et il fallait
     * reposer trois filtres à chaque visite.
     *
     * ⚠️ On retient la QUERY seule, jamais l'URL entière : une URL absolue enregistrée
     * survivrait à un changement de domaine ou de préfixe et proposerait un lien mort.
     */
    const query = Object.entries(params).filter(([, v]) => !!v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&');
    /**
     * ⚠️ On n'enregistre QUE si la vue porte quelque chose. Écrire la chaîne vide quand
     * l'écran est sur ses valeurs par défaut effacerait la vue mémorisée à la première
     * visite ordinaire — et la proposition ne serait jamais offerte à personne. « Reprendre
     * votre dernier rapport » ne désigne pas un écran sans filtre.
     */
    if (query) this.preferences.update({ reportsLastView: query });
  }

  /**
   * Reporte des paramètres dans la barre d'adresse SANS passer par le routeur.
   *
   * ⚠️ POURQUOI PAS `router.navigate`.
   *
   * Un clic de filtre n'est pas un changement de page. Le faire passer par le routeur
   * relançait la résolution de route à chaque clic et — l'application ayant activé
   * `withViewTransitions()` — déclenchait un fondu de la page ENTIÈRE, plus un
   * « InvalidStateError: Transition was aborted » dès que deux clics se suivaient de près.
   * Ce qu'on veut ici est exactement ce que fait `replaceState` : une URL qui REFLÈTE
   * l'écran, partageable et rechargeable, sans rejouer la navigation.
   *
   * ⚠️ `replaceState` et non `pushState` : chaque clic de filtre empilerait sinon une entrée
   * d'historique, et le bouton « précédent » deviendrait un défilement de filtres au lieu de
   * ramener à l'écran précédent.
   */
  private majParametresUrl(params: Record<string, string | null>): void {
    if (typeof window === 'undefined' || !window.history?.replaceState) return;
    const u = new URL(window.location.href);
    for (const [cle, valeur] of Object.entries(params)) {
      if (valeur) u.searchParams.set(cle, valeur);
      else u.searchParams.delete(cle);
    }
    window.history.replaceState(window.history.state, '', u.toString());
  }

  /**
   * Ouvre le replay d'un trajet désigné par l'URL (`/reports?trip=<id>`).
   *
   * ⚠️ Le trajet est demandé au SERVEUR et non cherché dans la liste affichée : celle-ci est
   * plafonnée à cent lignes, et un lien pointe le plus souvent sur un trajet qu'on a justement
   * dû aller chercher. Le chercher dans la page en ferait un lien qui marche une fois sur
   * quatre, sans qu'on comprenne pourquoi.
   */
  private async ouvrirTrajetDuLien(tripId: string): Promise<void> {
    try {
      const trip = await firstValueFrom(this.tripsApi.findOne(tripId));
      if (trip) this.replayTrip.set(trip);
      else this.toast.error('Trajet introuvable', "Ce lien pointe vers un trajet qui n'existe plus, ou hors de votre périmètre.");
    } catch (err) {
      swallow('reports:ouvrirTrajetDuLien', err);
      this.toast.error('Trajet introuvable', httpFailureMessage(err, 'ce trajet'));
    }
  }

  /** Ferme le replay d'un trajet et retire son paramètre de l'URL. */
  protected fermerReplay(): void {
    this.replayTrip.set(null);
    this.ecrireTrajetDansUrl(null);
  }

  /** Pose ou retire `trip=<id>` sans toucher aux autres paramètres. */
  private ecrireTrajetDansUrl(tripId: string | null): void {
    this.majParametresUrl({ trip: tripId });
  }

  /**
   * Copie le lien du trajet ouvert dans le presse-papier.
   *
   * ⚠️ `navigator.clipboard` n'existe pas hors contexte sécurisé (http nu, vieux navigateur)
   * et peut être refusé par l'utilisateur. On le DIT plutôt que d'afficher « Copié ! » sur
   * un presse-papier vide — la personne collerait alors autre chose dans son courriel.
   */
  protected async copierLienTrajet(): Promise<void> {
    const lien = this.lienDuTrajetOuvert();
    if (!lien) return;
    try {
      await navigator.clipboard.writeText(lien);
      this.toast.success('Lien copié', 'Il ouvre ce trajet, avec les filtres de cet écran.');
    } catch (err) {
      swallow('reports:copierLienTrajet', err);
      this.toast.error('Copie impossible', 'Votre navigateur a refusé l’accès au presse-papier. Le lien est dans la barre d’adresse.');
    }
  }

  /** Le lien PARTAGEABLE du trajet ouvert en replay, ou null. */
  protected lienDuTrajetOuvert(): string | null {
    const t = this.replayTrip();
    if (!t || typeof window === 'undefined') return null;
    const u = new URL(window.location.href);
    u.searchParams.set('trip', t.id);
    return u.toString();
  }

  /**
   * Si la période active est une pastille périmée (PWA restée ouverte après minuit), on
   * la réaligne sur la pastille fraîche AVANT l'export.
   *
   * ⚠️ Ce réalignement passe désormais par `setPeriod`, donc par un rechargement (cf.
   * `rafraichirJour`). Il se contentait de réécrire `periodFrom`/`periodTo` en silence :
   * le fichier exporté couvrait une période que l'écran, lui, n'avait jamais affichée.
   */
  private refreshPeriodIfStalePreset(): void {
    this.rafraichirJour();
  }

  /** Label "01 mai → 20 mai · 20 jours" affiche en sous-titre de la modal PDF. */
  protected readonly pdfPeriodLabel = computed(() => {
    this.periodKey();
    if (!this.periodFrom || !this.periodTo) return '';
    try {
      // Dates civiles lues en LOCAL (cf. `dateCivileLocale`) : parsées en UTC, elles
      // reculaient d'un jour à l'ouest de Greenwich, et le sous-titre de la modale PDF
      // annonçait une période décalée par rapport au fichier produit.
      const fDate = this.dateCivileLocale(this.periodFrom);
      // 'to' est exclusif (+1 jour cote periods) — on retire 1 jour pour l'affichage.
      const tDate = this.ajouterJours(this.dateCivileLocale(this.periodTo), -1);
      const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
      // L'arrondi absorbe l'heure gagnée ou perdue au changement d'heure : 29,96 jours se
      // lit 30. C'est le seul endroit où diviser par 86 400 000 reste juste.
      const days = Math.max(1, Math.round((tDate.getTime() - fDate.getTime()) / 86400000) + 1);
      return `${fmt(fDate)} → ${fmt(tDate)} · ${days} jour${days > 1 ? 's' : ''}`;
    } catch {
      return '';
    }
  });

  /**
   * Périmètre de l'écran transmis à la modale PDF — même règle que le CSV : le véhicule
   * choisi, sinon les véhicules du groupe filtré, sinon rien (= toute la société).
   *
   * En `computed` et non en méthode privée : un template Angular ne peut pas appeler un
   * membre privé. La modale s'ouvrait jusqu'ici sur « Tous » quoi qu'affiche l'écran — le
   * client filtrait sur un véhicule et repartait avec le PDF de toute la flotte.
   */
  protected readonly pdfPreselectedVehicleIds = computed(() => {
    const id = this.selectedVehicleId();
    if (id) return [id];
    if (this.selectedGroupId()) return this.visibleVehicles().map((v) => v.id);
    return [];
  });

  /**
   * Véhicules proposés dans la modale : ceux de la société courante, SANS le filtre de
   * groupe — c'est exactement le périmètre de la pastille « Tous ». Pour un super-admin,
   * `vehicles()` contient les véhicules de toutes les sociétés, et le compte affiché
   * n'était donc pas celui de l'écran.
   */
  protected readonly pdfModalVehicles = computed(() =>
    this.vehicles().filter((v) => this.fleetFilter.matches(v.fleetId)),
  );

  /**
   * Plage de dates du nom de fichier, dans le format composé par l'API
   * (`tracky-rapport-<plaque>-<du>_<au>.pdf`). `periodTo` est EXCLUSIF : on retire un jour
   * pour retomber sur le dernier jour inclus, comme le fait le PDF lui-même.
   */
  protected readonly pdfFileDateRange = computed(() => {
    this.periodKey();
    if (!this.periodFrom || !this.periodTo) return '';
    const last = this.ajouterJours(this.dateCivileLocale(this.periodTo), -1);
    return `${this.periodFrom}_${this.localIso(last)}`;
  });

  /** Ouvre la modal de configuration PDF. Le download lui-meme est declenche
   *  par `onPdfExportRequested` quand l'utilisateur valide ses choix. */
  protected onExportPdf(): void {
    if (this.exporting()) return;
    this.refreshPeriodIfStalePreset();
    if (!this.periodFrom || !this.periodTo) {
      this.toast.error('Échec export PDF', 'Période invalide — recharge la page.');
      return;
    }
    this.pdfModalOpen.set(true);
  }

  /** Recoit la config emise par la modal et declenche le download POST. */
  protected async onPdfExportRequested(req: PdfExportRequest): Promise<void> {
    if (this.exporting()) return;
    if (!this.periodFrom || !this.periodTo) {
      this.toast.error('Échec export PDF', 'Période invalide — recharge la page.');
      return;
    }
    this.exporting.set('pdf');
    try {
      await this.reportsApi.downloadConfiguredPdf(
        this.fleetFilter.selectedFleetId(),
        this.periodFrom,
        this.periodTo,
        {
          vehicleIds: req.vehicleIds,
          sections: req.sections,
          maxTrips: req.maxTrips,
          topN: req.topN,
          // ⚠️ Le filtre conducteur vient de la PAGE, pas de la modale : c'est l'écran qui
          // le choisit, et le document doit décrire ce que l'écran montrait. Sans lui, le
          // PDF portait toute la société sous un écran filtré sur une personne.
          driverId: this.selectedDriverId() || undefined,
        },
      );
      this.toast.success('PDF généré');
      this.pdfModalOpen.set(false);
    } catch (err) {
      this.toast.error('Échec export PDF', err instanceof Error ? err.message : '');
    } finally {
      this.exporting.set(null);
    }
  }

  /** Export CSV — `kind` détermine le contenu (trips: liste de trajets, alerts: liste d'alertes). */
  /**
   * Périmètre véhicule de l'écran pour un export : le véhicule sélectionné, sinon les
   * véhicules du groupe filtré, sinon rien (= toute la société). C'est ce que l'écran
   * montre ; un export doit montrer la même chose.
   */
  private exportVehicleIds(): string[] {
    // Une seule définition du périmètre, partagée avec la modale PDF : deux copies auraient
    // fini par diverger, et le CSV n'aurait plus exporté ce que le PDF exporte.
    return this.pdfPreselectedVehicleIds();
  }

  protected async onExportCsv(kind: 'trips' | 'alerts'): Promise<void> {
    if (this.exporting()) return;
    /**
     * ⚠️ LE MÊME REFUS QUE LE SERVEUR, MAIS AVANT LE TÉLÉCHARGEMENT (F13).
     *
     * Une alerte appartient à un VÉHICULE : ce fichier ne peut pas suivre le filtre
     * conducteur. Le bouton est déjà désactivé — cette garde couvre les chemins qui ne
     * passent pas par lui (raccourci clavier, appel programmatique) et rend un message,
     * pas un fichier qui décrirait une autre population que l'écran.
     */
    if (kind === 'alerts' && this.conducteurFiltre()) {
      this.toast.error(
        'Export CSV alertes',
        'Une alerte appartient à un véhicule, pas à un conducteur : cet export ne peut pas suivre le filtre. Retirez le filtre conducteur pour l\'obtenir.',
      );
      return;
    }
    this.refreshPeriodIfStalePreset();
    if (!this.periodFrom || !this.periodTo) {
      this.toast.error('Échec export CSV', 'Période invalide — recharge la page.');
      return;
    }
    this.exporting.set(kind === 'trips' ? 'csv-trips' : 'csv-summary');
    try {
      await this.reportsApi.downloadCsv(
        kind, this.fleetFilter.selectedFleetId(), this.periodFrom, this.periodTo,
        // Même périmètre que l'écran : le véhicule choisi, sinon les véhicules du groupe.
        this.exportVehicleIds(),
        // ⚠️ Et le même conducteur. `kind` ne vaut ici que 'trips' (le refus ci-dessus a déjà
        // écarté 'alerts'), donc ce paramètre ne peut atteindre qu'un export qui sait le porter.
        this.selectedDriverId() || undefined,
      );
      this.toast.success(kind === 'trips' ? 'CSV trajets téléchargé' : 'CSV alertes téléchargé');
    } catch (err) {
      this.toast.error('Échec export CSV', err instanceof Error ? err.message : '');
    } finally {
      this.exporting.set(null);
    }
  }

  /**
   * Sprint 5 — Export Excel « soigné » PAR VÉHICULE. Désactivé (gardé) si aucun
   * véhicule précis n'est sélectionné. Réutilise le pattern `exporting` (spinner)
   * + `downloadExcel` côté service. La période courante (to déjà exclusif) borne
   * l'export.
   */
  protected async onExportExcel(): Promise<void> {
    if (this.exporting()) return;
    const vehicleId = this.selectedVehicleId();
    /**
     * ⚠️ Sans véhicule, le classeur porte le PÉRIMÈTRE — mais il faut alors une société
     * désignée. Un super-administrateur sur « toutes les sociétés » reçoit un refus explicite
     * plutôt qu'un classeur portant le nom d'une société qu'il n'a pas demandée : celui-là
     * aurait l'air juste, ce qui est pire qu'une erreur.
     */
    const fleetId = this.fleetFilter.selectedFleetId();
    if (!vehicleId && !this.synthesePeriodePossible()) {
      this.toast.error(
        'Export Excel',
        'Choisissez une société (ou un véhicule) : un classeur de parc doit désigner son périmètre.',
      );
      return;
    }
    this.refreshPeriodIfStalePreset();
    if (!this.periodFrom || !this.periodTo) {
      this.toast.error('Échec export Excel', 'Période invalide — recharge la page.');
      return;
    }
    this.exporting.set('excel');
    try {
      // ⚠️ Le filtre conducteur voyage dans les DEUX formes (un véhicule / un périmètre) :
      // un classeur au nom d'une personne qui porterait les trajets de tout le monde est
      // exactement le fichier qu'on ne peut plus rattraper une fois envoyé.
      const driverId = this.selectedDriverId() || undefined;
      await this.reportsApi.downloadExcel(
        vehicleId
          ? { vehicleId, driverId }
          : { fleetId, groupId: this.selectedGroupId() || undefined, driverId },
        this.periodFrom,
        this.periodTo,
      );
      this.toast.success('Excel généré');
    } catch (err) {
      this.toast.error('Échec export Excel', err instanceof Error ? err.message : '');
    } finally {
      this.exporting.set(null);
    }
  }

  /**
   * Charge l'agrégat des graphiques de période.
   *
   * ⚠️ Le garde anti-course (`seq`) est le MÊME que celui de `loadData` : sans lui, la
   * réponse d'une période abandonnée pourrait repeindre les graphiques d'une période
   * plus récente — et l'écran afficherait des chiffres justes à côté de courbes fausses,
   * ce qui est plus difficile à repérer que deux écrans faux.
   *
   * ⚠️ La liste est VIDÉE avant l'appel : garder l'ancienne pendant le chargement
   * afficherait les vitesses de la période précédente sous le nouveau titre.
   */
  private async loadPeriodCharts(seq: number, params: Record<string, string>): Promise<void> {
    this.periodCharts.set(null);
    try {
      const agg = await firstValueFrom(this.tripsApi.periodCharts(params));
      if (seq !== this.loadSeq) return;
      this.periodCharts.set(agg);
    } catch (err) {
      // Non bloquant : le repli sur l'échantillon prend le relais, et le titre le dit.
      // La panne part quand même au centre d'alerte — un graphique qui se dégrade en
      // silence redeviendrait invisible, ce que tout ce lot corrige.
      swallow('reports:loadPeriodCharts', err);
    }
  }

  /** #40 — sequence anti-race : une reponse perimee ne doit pas ecraser une fraiche. */
  private loadSeq = 0;

  /**
   * Filtres actifs (véhicule / groupe / société / période) sous forme de query params.
   *
   * `summaryParams` sert aux agrégats (résumé journalier, graphiques de période) ;
   * `tripParams` y ajoute la pagination et le tri de la LISTE. Les deux sont construits
   * au même endroit pour qu'un filtre ne puisse pas s'appliquer aux chiffres sans
   * s'appliquer aux lignes — l'écart des deux périmètres est exactement ce qui rendait
   * les incohérences de cette page indéchiffrables.
   */
  private buildFilterParams(): {
    tripParams: Record<string, string>;
    summaryParams: Record<string, string>;
  } {
    const id = this.selectedVehicleId();
    const gid = this.selectedGroupId();
    const tripParams: Record<string, string> = {
      limit: String(REPORTS_TRIPS_PAGE_SIZE),
      sortBy: this.sortBy(),
      sortDir: this.sortDir(),
      // Charge allégée : ni polylignes ni fiche véhicule complète (430 → ~120 Ko la page).
      // Le tracé est demandé au moment du replay, trajet par trajet.
      light: '1',
    };
    const summaryParams: Record<string, string> = {};
    if (id) {
      tripParams['vehicleId'] = id;
      summaryParams['vehicleId'] = id;
    } else if (gid) {
      // Filtre groupe sans véhicule unique → scope les KPI/trajets sur les véhicules du groupe.
      const ids = this.visibleVehicles().map((v) => v.id).join(',');
      if (ids) {
        tripParams['vehicleIds'] = ids;
        summaryParams['vehicleIds'] = ids;
      }
    }
    /**
     * Filtre CONDUCTEUR (F13) — posé sur les DEUX jeux de paramètres, et c'est tout l'objet
     * de les construire ici : la liste et les agrégats ne peuvent pas décrire deux périmètres
     * différents. `none` demande les trajets SANS conducteur (le cas de 1 905 trajets sur
     * 1 956 chez « mh cars ») ; l'API n'accepte que cette forme ou un identifiant.
     */
    const cond = this.selectedDriverId();
    if (cond) {
      tripParams['driverId'] = cond;
      summaryParams['driverId'] = cond;
    }
    // Filtre société GLOBAL (sélecteur super-admin) : scope le rapport entier (KPI + trajets
    // + charts) à la flotte choisie, côté serveur (les agrégats ne sont pas filtrables client).
    const fleet = this.fleetFilter.selectedFleetId();
    if (fleet) {
      tripParams['fleetId'] = fleet;
      summaryParams['fleetId'] = fleet;
    }
    if (this.periodFrom) {
      tripParams['from'] = this.periodFrom;
      summaryParams['from'] = this.periodFrom;
    }
    if (this.periodTo) {
      tripParams['to'] = this.periodTo;
      summaryParams['to'] = this.periodTo;
    }
    return { tripParams, summaryParams };
  }

  /**
   * Recharge la SEULE liste de trajets (nouveau tri), sans retoucher aux KPI ni aux
   * graphiques : ils ne dépendent pas de l'ordre et les repeindre ferait clignoter la
   * moitié de l'écran pour un clic sur un en-tête de colonne.
   */
  private async loadTrips(): Promise<void> {
    const seq = ++this.loadSeq;
    // ⚠️ PAS `loading` : ce signal fait disparaître le tableau au profit d'un spinner.
    // Sur un clic d'en-tête, ça démonte les boutons de tri sous le curseur — un double
    // clic pour inverser la direction tombait alors dans le vide — et ça fait sauter la
    // position de défilement à chaque tri. `tripsBusy` garde les lignes à l'écran,
    // simplement estompées, le temps de la réponse.
    this.tripsBusy.set(true);
    try {
      const { tripParams } = this.buildFilterParams();
      const res = await firstValueFrom(this.tripsApi.list(tripParams));
      if (seq !== this.loadSeq) return;
      // ⚠️ SEULE la panne de la liste est levée ici : un re-tri ne rejoue pas le résumé
      // journalier, donc il n'a rien appris sur son état. Effacer son bandeau reviendrait
      // à déclarer réparé ce qu'on n'a pas retesté.
      this.tripsError.set(null);
      this.applyTripsPage(res, /* append */ false);
      void this.loadAnalyses(seq);
    } catch (err) {
      swallow('reports:loadTrips', err);
      // Un surlignage armé pour CE chargement ne doit pas se poser sur le suivant.
      this.highlightTopAfterLoad = false;
      if (seq === this.loadSeq) {
        this.trips.set([]);
        this.nextCursor.set(null);
        this.tripsError.set(httpFailureMessage(err, 'les trajets'));
      }
    } finally {
      // ⚠️ Les DEUX verrous, pas seulement le sien. Si ce re-tri a supplanté un chargement
      //    complet (ou l'inverse), le verrou de l'autre n'a jamais été relâché : tableau
      //    estompé à vie, ou spinner infini. Le dernier arrivé remet tout au propre.
      if (seq === this.loadSeq) { this.tripsBusy.set(false); this.loading.set(false); }
    }
  }

  /**
   * Page SUIVANTE de trajets, ajoutée à la liste courante.
   *
   * ⚠️ C'est la seule façon d'atteindre les trajets au-delà du plafond de page : le
   * tableau annonçait « 100 trajets affichés sur 1 896 » et n'offrait aucun moyen de
   * voir les 1 796 autres, à part rétrécir la période jusqu'à passer sous le plafond.
   */
  protected async loadMoreTrips(): Promise<void> {
    const cursor = this.nextCursor();
    // Un « charger plus » lancé pendant un re-tri paginerait sur l'ANCIEN ordre et
    // collerait deux jeux de résultats bout à bout.
    if (!cursor || this.loadingMore() || this.loading() || this.tripsBusy()) return;
    const seq = this.loadSeq;
    this.loadingMore.set(true);
    try {
      const { tripParams } = this.buildFilterParams();
      const res = await firstValueFrom(this.tripsApi.list({ ...tripParams, cursor }));
      // Un changement de filtre/tri pendant la requête invalide cette page : l'ajouter
      // mélangerait deux jeux de résultats dans le même tableau.
      if (seq !== this.loadSeq) return;
      this.applyTripsPage(res, /* append */ true);
      void this.loadAnalyses(seq);
    } catch (err) {
      swallow('reports:loadMoreTrips', err);
      // ⚠️ Plus de chargement AUTOMATIQUE après un échec : la sentinelle restait visible,
      //    se ré-armait, relançait la même requête, qui échouait, qui affichait un toast…
      //    en boucle, tant que le réseau était tombé. Le bouton reste ; c'est l'humain
      //    qui relance, et un succès (ou un changement de filtre) réactive l'automatique.
      this.moreAutoPaused = true;
      if (seq === this.loadSeq) {
        this.toast.error('Chargement interrompu', httpFailureMessage(err, 'les trajets'));
      }
    } finally {
      this.loadingMore.set(false);
      // Après le rendu de la page ajoutée (d'où le report à la tâche suivante).
      setTimeout(() => this.rearmMoreSentinel(), 0);
    }
  }

  /**
   * Applique une page reçue : liste + curseur + surlignage éventuel de la 1ʳᵉ ligne
   * (drilldown « Vitesse max »).
   */
  private applyTripsPage(
    res: { items: TripDto[]; nextCursor: string | null },
    append: boolean,
  ): void {
    this.trips.set(append ? [...this.trips(), ...res.items] : res.items);
    this.nextCursor.set(res.nextCursor);
    // Une page reçue = le réseau répond : l'automatique reprend.
    this.moreAutoPaused = false;
    if (!append && this.highlightTopAfterLoad) {
      this.highlightTopAfterLoad = false;
      const top = res.items[0];
      if (top) this.flashHighlight(top.id);
    }
  }

  /**
   * Agrégat serveur de la période, pour le récapitulatif par véhicule.
   *
   * ⚠️ `topN` est poussé au maximum accepté par le serveur (50). Ce récapitulatif n'est pas un
   * podium : il doit lister TOUS les véhicules qui ont roulé, sinon il redevient partiel — d'une
   * autre manière, mais tout aussi silencieuse. Au-delà de 50 véhicules dans un même périmètre,
   * la liste est tronquée par le serveur ; le repli client, lui, l'annonce.
   *
   * ⚠️ Le périmètre suit CELUI DE L'ÉCRAN. Sans lui, le récapitulatif d'un écran filtré sur un
   * véhicule afficherait toute la flotte : un tableau juste, mais qui répond à une autre question.
   */
  private async chargerStatsPeriode(seq: number): Promise<void> {
    const fleetId = this.fleetFilter.selectedFleetId();
    this.statsEchouee.set(false);
    if (!this.periodFrom || !this.periodTo) return;
    // ⚠️ Voir `synthesePeriodePossible()` : sur « toutes les sociétés », cette route répondrait
    // pour UNE société prise au hasard. Mieux vaut ne rien afficher que la mauvaise.
    if (!this.synthesePeriodePossible()) { this.statsPeriode.set(null); return; }
    try {
      const vehicleIds = this.vehicleIdsDuPerimetre();
      const stats = await firstValueFrom(
        // ⚠️ `driverId` ici AUSSI : la synthèse doit décrire le périmètre que le tableau
        // montre. Sans lui, la page filtrée sur une personne afficherait ses trajets sous
        // un récapitulatif de toute la société — deux réponses présentées comme une seule.
        this.reportsApi.stats(fleetId, this.periodFrom, this.periodTo, {
          vehicleIds,
          topN: 50,
          driverId: this.selectedDriverId() || undefined,
        }),
      );
      if (seq !== this.loadSeq) return;
      this.statsPeriode.set(stats);
    } catch (err) {
      // Pas de bandeau : ce n'est pas une panne des chiffres, c'est une synthèse indisponible.
      // Le repli client prend le relais et `recapPartiel()` le dit.
      if (seq === this.loadSeq) {
        this.statsPeriode.set(null);
        this.statsEchouee.set(true);
      }
      swallow('reports:statsPeriode', err);
    }
  }

  /**
   * Résumé journalier de la période PRÉCÉDENTE, de même durée — source de la tendance.
   *
   * ⚠️ Il passe par le RÉSUMÉ JOURNALIER, pas par `/reports/stats` : le résumé couvre le
   * périmètre réel de l'écran, y compris « toutes les sociétés », là où l'agrégat de période
   * est mono-société (cf. `synthesePeriodePossible`). Comparer un mois toutes sociétés à un
   * mois d'UNE société donnerait une tendance parfaitement fausse, et parfaitement crédible.
   */
  private async chargerPeriodePrecedente(seq: number, summaryParams: Record<string, string>): Promise<void> {
    const avant = periodePrecedente(this.periodFrom, this.periodTo);
    if (!avant) { this.kpisPrecedents.set(null); return; }
    try {
      const jours = await firstValueFrom(
        this.tripsApi.dailySummary({ ...summaryParams, from: avant.from, to: avant.to }),
      );
      if (seq !== this.loadSeq) return;
      this.kpisPrecedents.set(aggregateKpisFromDaily(jours));
    } catch (err) {
      // Pas de bandeau : une tendance manquante retire une phrase, elle ne fausse rien.
      if (seq === this.loadSeq) this.kpisPrecedents.set(null);
      swallow('reports:periodePrecedente', err);
    }
  }

  /**
   * Les véhicules que l'écran regarde : un seul s'il est filtré, ceux du groupe sinon.
   *
   * Une liste VIDE veut dire « pas de restriction » — le serveur rend alors toute la société,
   * dans la limite du périmètre d'accès de l'appelant. C'est bien ce qu'on veut quand aucun
   * filtre n'est posé.
   */
  private vehicleIdsDuPerimetre(): string[] {
    const un = this.selectedVehicleId();
    if (un) return [un];
    const groupe = this.selectedGroupId();
    if (!groupe) return [];
    return this.vehicles().filter((v) => v.group?.id === groupe).map((v) => v.id);
  }

  protected async loadData(): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    try {
      const { tripParams, summaryParams } = this.buildFilterParams();

      // Fetch trips + daily summary en parallele : meme periode, meme vehicule.
      // Si l'un fail, l'autre peut quand meme alimenter ses charts — mais on RETIENT
      // l'echec au lieu de le deguiser en liste vide.
      //
      // ⚠️ Ces deux `.catch()` renvoyaient un resultat vide SANS trace : l'ecran affichait
      // « Aucun trajet pour cette periode », c'est-a-dire une reponse metier plausible,
      // pour une panne serveur ou une session expiree. Une panne muette qui ressemble a
      // une reponse valide est pire qu'une erreur affichee : personne ne la signale.
      // Les deux échecs sont retenus SÉPARÉMENT : un re-tri ultérieur ne rejoue que la
      // liste, et il ne doit donc lever que l'avertissement de la liste (cf. `loadTrips`).
      let tripsFailure: unknown = null;
      let summaryFailure: unknown = null;
      const [tripsRes, summary] = await Promise.all([
        firstValueFrom(this.tripsApi.list(tripParams)).catch(
          (err: unknown) => { tripsFailure ??= err; return { items: [] as TripDto[], nextCursor: null }; },
        ),
        firstValueFrom(this.tripsApi.dailySummary(summaryParams)).catch(
          (err: unknown) => { summaryFailure ??= err; return [] as TripDailySummaryDto[]; },
        ),
      ]);
      // #40 — une requete plus recente a ete lancee entre-temps : on ignore ce
      // resultat perime (sinon une reponse lente ecrase des donnees plus fraiches).
      if (seq !== this.loadSeq) return;
      this.tripsError.set(tripsFailure ? httpFailureMessage(tripsFailure, 'les trajets') : null);
      this.summaryError.set(
        summaryFailure ? httpFailureMessage(summaryFailure, 'le résumé de la période') : null,
      );
      this.applyTripsPage(tripsRes, /* append */ false);
      this.dailySummary.set(summary);
      // Agrégat des deux graphiques de période. Chargé À PART et sans bloquer : il porte
      // le confort (deux graphiques), pas les chiffres — les KPI viennent du résumé
      // journalier. Un échec ici laisse l'écran utilisable, avec le repli sur
      // l'échantillon, annoncé comme tel par le titre.
      void this.loadPeriodCharts(seq, summaryParams);
      // Récapitulatif par véhicule sur TOUTE la période. Chargé à part et sans bloquer :
      // son échec laisse l'écran utilisable, avec le repli sur les trajets chargés — annoncé.
      void this.chargerStatsPeriode(seq);
      // Période PRÉCÉDENTE, pour la tendance sous chaque indicateur. Chargée à part : son
      // absence retire une phrase, elle ne fausse aucun chiffre.
      void this.chargerPeriodePrecedente(seq, summaryParams);
      // Traçabilité fine (P4c) : les badges d'analyse ne s'affichent QUE pour un véhicule choisi
      // (sinon les trajets couvrent plusieurs véhicules, pas de chargement en lot possible).
      void this.loadAnalyses(seq);
    } catch (err) {
      swallow('reports:loadData', err);
      if (seq === this.loadSeq) {
        this.trips.set([]);
        this.nextCursor.set(null);
        this.dailySummary.set([]);
        this.tripsError.set(httpFailureMessage(err, 'les trajets'));
        this.summaryError.set(httpFailureMessage(err, 'le résumé de la période'));
      }
    } finally {
      // Même règle que loadTrips : le dernier chargement relâche les deux verrous.
      if (seq === this.loadSeq) { this.loading.set(false); this.tripsBusy.set(false); }
    }
  }

  /**
   * Charge en lot les analyses des trajets AFFICHÉS (arrêts, excès, éco-conduite, récit IA).
   * Best-effort, non bloquant.
   *
   * ⚠️ Ce chargement était conditionné à la sélection d'un véhicule UNIQUE, parce qu'il
   * passait par `listForVehicle`. Conséquence : filtrer par société ou par groupe — le cas
   * le plus courant — faisait disparaître la colonne « Analyse » entière, récits IA compris,
   * sans un mot. On demande maintenant les analyses des trajets de la page, quels que
   * soient leurs véhicules.
   */
  private async loadAnalyses(seq: number): Promise<void> {
    const trips = this.trips();
    if (trips.length === 0) { this.analysesMap.set(new Map()); return; }
    // Seuls les trajets pas encore connus : après un « Charger plus », re-demander les
    // pages déjà chargées serait du gaspillage pur (et dépasserait vite le lot max).
    const known = this.analysesMap();
    /**
     * ⚠️ « Déjà connu » NE SUFFIT PAS : la table n'est écrite qu'à la FIN du chargement.
     *
     * Deux appels qui se chevauchent — un tri lancé pendant qu'un changement de période
     * charge encore, un « Charger plus » qui suit de près — calculaient donc tous deux la
     * même liste de manquants et redemandaient les mêmes analyses au serveur. Le second lot
     * arrivait pour rien ; sur une page de cent trajets, c'est une requête entière gaspillée
     * à chaque fois. Les identifiants EN VOL sont donc exclus, et relâchés quoi qu'il arrive.
     */
    const missing = trips
      .map((t) => t.id)
      .filter((id) => !known.has(id) && !this.analysesEnVol.has(id));
    if (missing.length === 0) return;
    for (const id of missing) this.analysesEnVol.add(id);
    try {
      const pages: TripAnalysisDto[][] = [];
      for (let i = 0; i < missing.length; i += ANALYSES_BATCH_SIZE) {
        pages.push(await firstValueFrom(
          this.analysisApi.listForTrips(missing.slice(i, i + ANALYSES_BATCH_SIZE)),
        ));
        if (seq !== this.loadSeq) return;
      }
      this.analysesMap.update((m) => {
        const next = new Map(m);
        for (const a of pages.flat()) next.set(a.tripId, a);
        return next;
      });
    } catch (err) {
      swallow('reports:loadAnalyses', err);
      // On GARDE ce qui était déjà chargé : vider la table transformerait une page
      // d'analyses manquantes en « aucune analyse nulle part ».
    } finally {
      // ⚠️ Dans TOUS les cas, y compris le retour anticipé sur péremption de la séquence :
      // un identifiant resté « en vol » ne serait plus jamais redemandé, et sa colonne
      // « Analyse » resterait vide pour le reste de la session.
      for (const id of missing) this.analysesEnVol.delete(id);
    }
  }

  /** Identifiants dont les analyses sont DEMANDÉES mais pas encore arrivées. */
  private readonly analysesEnVol = new Set<string>();

  protected analysisFor(tripId: string): TripAnalysisDto | null {
    return this.analysesMap().get(tripId) ?? null;
  }

  protected onAnalyzed(a: TripAnalysisDto): void {
    this.analysesMap.update((m) => { const n = new Map(m); n.set(a.tripId, a); return n; });
  }

  /**
   * Ouvre le replay d'un trajet. La liste est chargée SANS tracé (charge allégée) : on
   * demande le trajet complet ici, au clic — un seul tracé transféré au lieu de cent.
   * La modal s'ouvre tout de suite avec ce qu'on a (en-tête, chiffres) ; le tracé arrive
   * juste derrière, ce que le composant de replay sait déjà faire (tracé absent → segment
   * droit, puis vrai tracé).
   */
  protected async openReplay(trip: TripDto): Promise<void> {
    this.replayTrip.set(trip);
    // ⚠️ Le trajet ouvert entre dans l'URL : c'est ce qui rend « regarde CE trajet »
    // citable dans un courriel ou un ticket. Il en sort à la fermeture, sinon un lien
    // copié plus tard rouvrirait un replay que l'expéditeur avait quitté depuis longtemps.
    this.ecrireTrajetDansUrl(trip.id);
    if (trip.polyline) return; // déjà complet (ex. trajet rafraîchi après une note)
    try {
      const full = await firstValueFrom(this.tripsApi.findOne(trip.id));
      // L'utilisateur a pu fermer ou changer de trajet pendant la requête.
      if (this.replayTrip()?.id === trip.id) this.replayTrip.set(full);
    } catch (err) {
      swallow('reports:openReplay', err);
      this.toast.error('Tracé indisponible', httpFailureMessage(err, 'le tracé du trajet'));
    }
  }

  /** Trajets COMPLETS (avec tracés) du replay de période — chargés à l'ouverture seulement. */
  protected readonly periodReplayTrips = signal<TripDto[]>([]);
  protected readonly periodReplayLoading = signal(false);

  protected async downloadSpeedReport(trip: TripDto): Promise<void> {
    try {
      await this.reportsApi.downloadSpeedAnalysis(trip.id);
      this.toast.success('Rapport vitesse téléchargé');
    } catch (err) {
      // Avant : échec avalé, l'utilisateur cliquait, rien ne se passait, sans un mot.
      this.toast.error('Échec du rapport vitesse', err instanceof Error ? err.message : '');
    }
  }

  protected openNoteEdit(trip: TripDto): void {
    this.noteEditTrip.set(trip);
  }

  /**
   * Met a jour la ligne dans la table apres save reussi (sans re-fetch).
   * Le modal s'occupe de fermer lui-meme via `(closed)`.
   * Si on edite la note du trip en train d'etre rejoue, on rafraichit aussi
   * le trip courant du replay pour que le bandeau se mette a jour.
   */
  protected onNoteSaved(updated: TripDto): void {
    this.trips.update((list) => list.map((t) => (t.id === updated.id ? updated : t)));
    const replay = this.replayTrip();
    if (replay && replay.id === updated.id) {
      this.replayTrip.set(updated);
    }
  }

  /**
   * Quand le user clique sur "modifier la note" depuis le replay, on ouvre
   * le modal de note. On laisse le replay ouvert en arriere-plan : c'est
   * intentionnel — on a un overlay au-dessus de l'autre.
   */
  protected onEditNoteFromReplay(trip: TripDto): void {
    this.noteEditTrip.set(trip);
  }

  protected openDriverPickerForTrip(trip: TripDto): void {
    if (!this.canManageDrivers()) return;
    this.driverPickerTrip.set(trip);
  }

  /**
   * Reaffectation du conducteur sur un trip. driver=null => retire.
   * Met a jour la ligne dans la table sans re-fetch + le replay si même trip.
   *
   * ══ SAUF SOUS FILTRE CONDUCTEUR : LA LIGNE VIENT DE CHANGER DE POPULATION (F13) ══════
   *
   * Le rustinage en mémoire était inoffensif tant que la liste n'était bornée que par
   * véhicule, groupe et période : une ligne qui gagnait un nom continuait d'y appartenir.
   * Le filtre conducteur le transforme en contradiction affichée, et précisément dans le mode
   * qui EXISTE pour ce geste — « Sans conducteur », 1 905 trajets sur 1 956 chez « mh cars »,
   * la liste que le gestionnaire isole POUR LA CORRIGER. Après vingt affectations, le tableau
   * montrait vingt trajets conduits sous un en-tête de filtre disant « Sans conducteur », les
   * compteurs, les courbes et la synthèse décrivaient toujours la population d'AVANT, et la
   * modale PDF annonçait « les 55 trajets de la période » pour un document qui en portait 54 —
   * un fichier qui contredit l'écran qui l'a produit.
   *
   * ⚠️ ON RETIRE LA LIGNE, ON NE RECHARGE PAS LA LISTE. `loadData()` est le geste des poseurs
   * de filtre (`onSelectDriver`, `filtrerSurConducteur`), mais il ramène le tableau à sa
   * première page : sur un périmètre de 1 905 lignes corrigées au « Charger plus », renvoyer le
   * gestionnaire en tête à chaque affectation rendrait inutilisable le geste même que ce filtre
   * sert. On retire donc la ligne du périmètre — jamais on ne la laisse affichée — et on rejoue
   * les seuls AGRÉGATS, qui ne dépendent pas de la pagination.
   */
  protected async onDriverPickedForTrip(driver: DriverDto | null): Promise<void> {
    const trip = this.driverPickerTrip();
    if (!trip) return;
    this.driverPickerTrip.set(null);
    try {
      const updated = await firstValueFrom(
        this.driversApi.assignToTrip(trip.id, driver?.id ?? null),
      );
      const replay = this.replayTrip();
      if (replay && replay.id === updated.id) this.replayTrip.set(updated);
      const conducteurAvant = trip.driver?.id ?? null;
      const conducteurApres = updated.driver?.id ?? null;
      if (trajetHorsPerimetreConducteur(this.selectedDriverId(), conducteurApres)) {
        this.trips.update((list) => list.filter((t) => t.id !== updated.id));
        this.oublierStatsPeriode();
        void this.rafraichirAgregatsDuPerimetre();
      } else {
        this.trips.update((list) => list.map((t) => (t.id === updated.id ? updated : t)));
        /**
         * ⚠️ MÊME SANS AUCUN FILTRE CONDUCTEUR, LE RÉCAPITULATIF VIENT DE SE PÉRIMER.
         *
         * La ligne reste dans le tableau — sa population n'a pas changé —, mais elle a changé
         * de CAMP dans la carte « Par conducteur ou groupe » : elle passe de
         * `unattributedTrips` à `byAttribution` (ou d'un conducteur à un autre). Le compte
         * « N trajets sur M ni conducteur, ni groupe » et sa part en pourcentage décrivaient
         * donc l'état d'AVANT le clic, sur un écran où le nom, lui, venait de s'afficher — et
         * c'est LE geste que ce récapitulatif sert à provoquer : 1 866 trajets sur 1 886 sans
         * imputation chez « mh cars » au 2026-09-05.
         *
         * ⚠️ SEULE la synthèse est rejouée. Le résumé journalier et les graphiques comptent des
         * trajets et des kilomètres : sans filtre conducteur, affecter quelqu'un n'en change
         * pas un seul. Les rejouer serait deux allers-retours pour un résultat identique.
         *
         * ⚠️ ET SANS `oublierStatsPeriode()` : ici rien ne rompt le périmètre, donc vider la
         * grille entière ferait clignoter le carburant, le parc actif et les alertes — qui,
         * eux, ne bougent pas — pour un rafraîchissement de quelques centaines de millisecondes.
         * Un échec, lui, ne reste pas silencieux : `chargerStatsPeriode` retombe alors sur le
         * repli client, qui annonce qu'il est partiel.
         */
        if (conducteurAvant !== conducteurApres) void this.chargerStatsPeriode(this.loadSeq);
      }
      this.toast.success(
        driver ? 'Conducteur affecte' : 'Conducteur retire',
        driver ? `${driver.firstName} ${driver.lastName}` : '',
      );
    } catch (err) {
      swallow('reports:onDriverPickedForTrip', err);
      this.toast.error('Échec affectation', err instanceof Error ? err.message : '');
    }
  }

  /**
   * Rejoue les AGRÉGATS du périmètre courant, sans toucher au tableau ni à sa pagination.
   *
   * Sert le seul cas où la population change SANS que l'écran ait changé de filtre : une
   * affectation de conducteur sous un filtre conducteur. Les poseurs de filtre, eux, passent
   * par `loadData()` — ils veulent bien repartir de la première page.
   *
   * ⚠️ `loadSeq` n'est PAS incrémenté : ce rafraîchissement ne remplace aucun chargement en
   * cours, il s'y ajoute. L'incrémenter invaliderait la liste en vol (le `seq` de `loadTrips`)
   * et laisserait le tableau estompé pour de bon.
   */
  private async rafraichirAgregatsDuPerimetre(): Promise<void> {
    const seq = this.loadSeq;
    const { summaryParams } = this.buildFilterParams();
    try {
      const summary = await firstValueFrom(this.tripsApi.dailySummary(summaryParams));
      if (seq !== this.loadSeq) return;
      this.summaryError.set(null);
      this.dailySummary.set(summary);
    } catch (err) {
      swallow('reports:rafraichirAgregatsDuPerimetre', err);
      if (seq === this.loadSeq) {
        this.summaryError.set(httpFailureMessage(err, 'le résumé de la période'));
      }
      return;
    }
    void this.loadPeriodCharts(seq, summaryParams);
    void this.chargerStatsPeriode(seq);
  }

  /** Confirmation avant recalcul : ouverte par le bouton admin, fermée par la modale. */
  protected readonly recomputeConfirmOpen = signal(false);

  /** Ce que le recalcul va détruire, chiffré — pour la modale de confirmation. */
  protected readonly recomputeConsequences = computed(() => {
    const n = this.kpis().tripCount;
    const plate = this.selectedVehicleLabel();
    return `Les ${n} trajets de ${plate} sur la période seront supprimés puis redécoupés depuis les positions GPS. ` +
      `Leurs analyses et leurs récits IA seront perdus ; l'agent les réécrira au fil des prochains passages. ` +
      `Les notes que vous avez saisies, le conducteur affecté et la mission rattachée sont CONSERVÉS : ils ` +
      `sont rattachés au nouveau trajet qui couvre la même période. Si le redécoupage fond deux trajets en ` +
      `un seul, une note peut néanmoins se retrouver sans trajet d'accueil — le compte vous sera donné après ` +
      `le recalcul.`;
  });

  /**
   * Le bouton « Recalculer » ouvre une CONFIRMATION. Avant, un clic supprimait sans un mot
   * les trajets de la période avec leurs analyses et leurs récits — produits par l'agent
   * sur poste, donc irrécupérables autrement qu'en attendant qu'il repasse.
   */
  protected onRecompute(): void {
    if (!this.selectedVehicleId() || !this.periodFrom || !this.periodTo) return;
    this.recomputeConfirmOpen.set(true);
  }

  protected async confirmRecompute(): Promise<void> {
    this.recomputeConfirmOpen.set(false);
    const id = this.selectedVehicleId();
    if (!id || !this.periodFrom || !this.periodTo) return;
    this.recomputing.set(true);
    try {
      const res = await firstValueFrom(this.tripsApi.recompute({
        vehicleId: id,
        from: this.periodFrom,
        to: this.periodTo,
      }));
      this.toast.success(`Recalcul terminé`, `${res.deleted} supprimés, ${res.created} créés`);
      await this.loadData();
    } catch (err) {
      swallow('reports:onRecompute', err); this.toast.error('Échec du recalcul'); }
    finally { this.recomputing.set(false); }
  }

  /** Delegue a `reports.utils#formatDuration` (verrouille par tests). */
  protected formatDuration(seconds: number): string {
    return formatDurationFn(seconds);
  }

  /**
   * Liste des véhicules — plaques, groupes, sélecteur, modale PDF.
   *
   * ⚠️ L'échec était AVALÉ EN SILENCE (« // silent »). Un 401, un 403 ou un 5xx sur
   * /vehicles laissait donc une page de trajets sans une seule plaque, sans filtre par
   * groupe et avec un sélecteur vide : l'image exacte d'une flotte qui n'aurait aucun
   * véhicule. Une panne qui ressemble à une réponse métier plausible n'est jamais
   * signalée par personne — c'est le même piège que les KPI muets corrigés au-dessus.
   *
   * `protected` : le bandeau de l'écran offre « Réessayer », qui rappelle cette méthode.
   */
  protected async loadVehicles(): Promise<void> {
    this.vehiclesLoading.set(true);
    try {
      const list = await firstValueFrom(this.vehiclesApi.list());
      this.vehicles.set(list);
      this.vehiclesError.set(null);
    } catch (err) {
      swallow('reports:loadVehicles', err);
      const message = httpFailureMessage(err, 'les véhicules');
      this.vehiclesError.set(message);
      this.toast.error('Véhicules indisponibles', message);
    } finally {
      this.vehiclesLoading.set(false);
    }
  }

  /**
   * Déplie / replie une note sur place.
   *
   * ⚠️ C'est le seul moyen de LIRE une note complète pour un rôle sans droit d'édition :
   * le texte entier n'existait que dans un attribut `title`, c'est-à-dire nulle part sur
   * un écran tactile, et le bouton était désactivé.
   */
  protected basculerNote(tripId: string): void {
    this.noteDepliee.update((courant) => (courant === tripId ? null : tripId));
  }
}
