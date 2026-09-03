import {
  Component,
  HostListener,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  AlertTriangle,
  BarChart3,
  Check,
  Eye,
  FileText,
  Info,
  ListChecks,
  LucideAngularModule,
  Route,
  RotateCcw,
  Search,
  Trophy,
  Truck,
  X,
} from 'lucide-angular';
import type { VehicleDetailDto } from '../../../core/services/vehicles.service';
import type { PdfReportSection } from '../../../core/services/reports.service';

export interface PdfExportRequest {
  /** undefined => toute la flotte. Sinon liste explicite. */
  vehicleIds?: string[];
  sections: PdfReportSection[];
  maxTrips: number;
  topN: number;
}

type Scope = 'all' | 'selected';

/** Bornes des deux curseurs — alignees sur ce que le backend accepte (max 500 / 50). */
const MIN_TRIPS = 10;
const MAX_TRIPS = 200;
const TRIPS_STEP = 10;
const MIN_TOP_N = 3;
const MAX_TOP_N = 30;
const DEFAULT_MAX_TRIPS = 30;
const DEFAULT_TOP_N = 10;

/**
 * Preferences memorisees d'une session a l'autre.
 *
 * On memorise le CONTENU (sections + caps), jamais le PERIMETRE : voir le
 * commentaire de `applyOpeningState()`.
 */
const PREFS_KEY = 'tracky:export-pdf:prefs';

interface ExportPrefs {
  sections: PdfReportSection[];
  maxTrips: number;
  topN: number;
}

const KNOWN_SECTIONS: PdfReportSection[] = ['kpi', 'alerts', 'topVehicles', 'trips'];

/** Ramene une valeur stockee dans les bornes du curseur (et sur son pas). */
function clampToStep(value: unknown, min: number, max: number, step: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const snapped = Math.round(n / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

/**
 * Lecture des preferences — TOUT est sous try/catch : en navigation privee
 * (Safari iOS notamment) le seul acces a localStorage peut lever, et une modale
 * d'export qui plante a l'ouverture serait bien pire que des reglages oublies.
 */
function readPrefs(): ExportPrefs | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const source = parsed as Partial<ExportPrefs>;
    const sections = Array.isArray(source.sections)
      ? source.sections.filter((s): s is PdfReportSection =>
          KNOWN_SECTIONS.includes(s as PdfReportSection))
      : [];
    // Zero section stockee = etat inexploitable (PDF vide) : on repart des defauts.
    if (sections.length === 0) return null;
    return {
      sections,
      maxTrips: clampToStep(source.maxTrips, MIN_TRIPS, MAX_TRIPS, TRIPS_STEP, DEFAULT_MAX_TRIPS),
      topN: clampToStep(source.topN, MIN_TOP_N, MAX_TOP_N, 1, DEFAULT_TOP_N),
    };
  } catch {
    return null;
  }
}

function writePrefs(prefs: ExportPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Quota plein ou stockage refuse : le confort de memorisation saute, pas l'export.
  }
}

/** "a, b et c" — enumeration francaise pour la phrase d'apercu. */
function joinFr(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return parts.slice(0, -1).join(', ') + ' et ' + parts[parts.length - 1]!;
}

/**
 * Modal d'export PDF — point d'entree unique depuis la page Rapports.
 *
 * Refonte : la modale ne demande plus seulement « quoi cocher », elle DIT ce que
 * le client va recevoir. Trois principes s'y retrouvent partout :
 *
 *  1. le PERIMETRE suit l'ecran (`preselectedVehicleIds`). Le client qui a filtre
 *     sur une plaque croit exporter ce qu'il voit ; avant cette refonte la modale
 *     repartait sur « Tous » et lui livrait toute la flotte sans le dire.
 *  2. chaque libelle est CHIFFRE quand l'info existe (nombre de trajets, d'alertes,
 *     de vehicules du perimetre) : « Max 30 trajets » ne veut rien dire quand la
 *     periode en compte 391, « 30 des 391 » se comprend sans explication.
 *  3. une phrase d'apercu, en francais complet, resume la commande juste au-dessus
 *     du bouton — c'est la derniere chose lue avant de cliquer.
 *
 * Le contrat de sortie (`PdfExportRequest`) est INCHANGE : la page parente
 * continue de compiler et d'appeler l'API a l'identique.
 *
 * Patterns DA reutilises :
 *  - structure backdrop + dialog identique a DriverPicker / ConfirmModal
 *  - bottom-sheet sur mobile (full width, slide depuis le bas), modal centree
 *    sur desktop (max-w-2xl)
 *  - safe-area-inset-bottom pour les boutons sur iOS PWA
 *  - z-index 9100 (au-dessus des autres dialogs feature)
 */
@Component({
  selector: 'app-pdf-export-modal',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[9100] flex flex-col sm:items-center sm:justify-center"
           role="dialog" aria-modal="true"
           [attr.aria-labelledby]="'pem-title-' + uid">
        <div class="absolute inset-0 bg-black/50 sm:backdrop-blur-sm"
             (click)="onClose()" aria-hidden="true"></div>

        <!-- Spacer mobile : pousse la sheet en bas en preservant le clic outside -->
        <div class="flex-1 sm:hidden" (click)="onClose()" aria-hidden="true"></div>

        <div class="pem-container">
          <!-- Header -->
          <header class="pem-header">
            <div class="w-9 h-9 rounded-xl flex items-center justify-center
                        bg-tracky/15 text-tracky-light shrink-0">
              <lucide-icon [img]="FileTextIcon" [size]="18"></lucide-icon>
            </div>
            <div class="flex-1 min-w-0">
              <h3 [id]="'pem-title-' + uid"
                  class="text-base font-display font-semibold text-fg-primary">
                Rapport PDF
              </h3>
              @if (periodLabel()) {
                <p class="text-xs text-fg-tertiary mt-0.5">
                  {{ periodLabel() }}
                </p>
              }
            </div>
            <button type="button" (click)="onClose()" aria-label="Fermer"
                    class="p-2 -m-1 rounded-lg text-fg-tertiary hover:text-fg-primary
                           hover:bg-bg-tertiary transition-colors cursor-pointer">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </header>

          <!-- Body scrollable -->
          <div class="pem-body">
            <!-- Pourquoi trois boutons d'export : la page propose aussi CSV et Excel,
                 personne ne savait lequel choisir. -->
            <p class="pem-note">
              <lucide-icon [img]="InfoIcon" [size]="14" class="pem-note-icon"></lucide-icon>
              <span>
                Le PDF est un document mis en page, à imprimer ou à transmettre tel quel.
                Pour retravailler les chiffres, la page propose aussi l'export CSV
                (liste brute des trajets ou des alertes) et l'export Excel
                (un véhicule, feuilles détaillées).
              </span>
            </p>

            <!-- Section 1 : Perimetre vehicules -->
            <section class="space-y-3">
              <header class="flex items-center gap-2">
                <lucide-icon [img]="TruckIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                <h4 class="text-xs font-display font-semibold uppercase tracking-wider text-fg-secondary">
                  Périmètre véhicules
                </h4>
              </header>

              <!-- Bandeau « comme a l'ecran » : le client doit voir, sans chercher,
                   que la modale a repris le filtre de la page. -->
              @if (screenScopeIds().length > 0) {
                @if (matchesScreenScope()) {
                  <p class="pem-scope-banner">
                    <lucide-icon [img]="CheckIcon" [size]="14" class="shrink-0"></lucide-icon>
                    <span>Comme à l'écran : {{ screenScopeLabel() }}</span>
                  </p>
                } @else {
                  <div class="pem-scope-banner pem-scope-banner--changed">
                    <lucide-icon [img]="InfoIcon" [size]="14" class="shrink-0"></lucide-icon>
                    <span class="flex-1 min-w-0">
                      L'écran est filtré sur {{ screenScopeLabel() }} — vous exportez
                      autre chose.
                    </span>
                    <button type="button" (click)="restoreScreenScope()" class="pem-inline-btn">
                      <lucide-icon [img]="RotateCcwIcon" [size]="13"></lucide-icon>
                      <span>Revenir à l'écran</span>
                    </button>
                  </div>
                }
              }

              <div class="grid grid-cols-2 gap-2">
                <button type="button" (click)="onScopeAll()"
                        class="pem-pill"
                        [class.pem-pill--active]="scope() === 'all'">
                  <span class="pem-pill-label">Toute la flotte</span>
                  <span class="pem-pill-count">{{ vehicles().length }}</span>
                </button>
                <button type="button" (click)="onScopeSelected()"
                        class="pem-pill"
                        [class.pem-pill--active]="scope() === 'selected'">
                  <span class="pem-pill-label">Sélection</span>
                  <span class="pem-pill-count">{{ selectedIds().size }}</span>
                </button>
              </div>

              @if (scope() === 'selected') {
                <div class="space-y-2">
                  <div class="flex items-center gap-2">
                    <div class="relative flex-1">
                      <lucide-icon [img]="SearchIcon" [size]="14"
                        class="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary"></lucide-icon>
                      <input type="text" [value]="search()" (input)="onSearchInput($event)"
                        class="w-full pl-9 pr-3 py-2.5 bg-bg-tertiary border border-border-subtle
                               rounded-xl text-fg-primary text-sm focus:outline-none focus:border-tracky"
                        aria-label="Filtrer les véhicules"
                        placeholder="Plaque, marque, modèle..." />
                    </div>
                    <button type="button" (click)="onToggleAllFiltered()"
                      class="px-3 py-2.5 min-h-[44px] text-xs font-medium rounded-xl
                             bg-bg-tertiary text-fg-secondary border border-border-subtle
                             hover:text-fg-primary transition-colors cursor-pointer whitespace-nowrap">
                      {{ allFilteredSelected() ? 'Décocher' : 'Tout cocher' }}
                    </button>
                  </div>

                  <div class="border border-border-subtle rounded-xl overflow-hidden">
                    @if (filteredVehicles().length === 0) {
                      <p class="text-center text-fg-tertiary text-sm py-6 px-3">
                        @if (search()) { Aucun véhicule trouvé. }
                        @else { Aucun véhicule enregistré dans cette flotte. }
                      </p>
                    } @else {
                      <div class="max-h-64 overflow-y-auto divide-y divide-border-subtle">
                        @for (v of filteredVehicles(); track v.id) {
                          <label class="pem-row">
                            <input type="checkbox"
                                   class="pem-checkbox"
                                   [checked]="selectedIds().has(v.id)"
                                   (change)="onToggleVehicle(v.id)" />
                            <span class="flex-1 min-w-0">
                              <span class="text-sm font-semibold text-fg-primary block truncate">
                                {{ v.plate }}
                              </span>
                              @if (v.brand || v.model) {
                                <span class="text-xs text-fg-tertiary block truncate">
                                  {{ v.brand }} {{ v.model }}
                                </span>
                              }
                            </span>
                            @if (selectedIds().has(v.id)) {
                              <lucide-icon [img]="CheckIcon" [size]="14"
                                class="text-tracky-light shrink-0"></lucide-icon>
                            }
                          </label>
                        }
                      </div>
                    }
                  </div>
                </div>
              }
            </section>

            <!-- Section 2 : Contenu du rapport -->
            <section class="space-y-3">
              <header class="flex items-center gap-2">
                <lucide-icon [img]="ListChecksIcon" [size]="14" class="text-fg-tertiary"></lucide-icon>
                <h4 class="text-xs font-display font-semibold uppercase tracking-wider text-fg-secondary">
                  Contenu du rapport
                </h4>
              </header>

              <div class="space-y-1.5">
                <label class="pem-row pem-row--option">
                  <input type="checkbox" class="pem-checkbox"
                         [checked]="includeKpi()" (change)="includeKpi.set(!includeKpi())" />
                  <lucide-icon [img]="BarChart3Icon" [size]="16"
                    class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="flex-1 min-w-0">
                    <span class="text-sm font-medium text-fg-primary block">Indicateurs clés</span>
                    <span class="text-xs text-fg-tertiary block">{{ kpiHint }}</span>
                  </span>
                </label>

                <label class="pem-row pem-row--option">
                  <input type="checkbox" class="pem-checkbox"
                         [checked]="includeAlerts()" (change)="includeAlerts.set(!includeAlerts())" />
                  <lucide-icon [img]="AlertTriangleIcon" [size]="16"
                    class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="flex-1 min-w-0">
                    <span class="text-sm font-medium text-fg-primary block">Alertes</span>
                    <span class="text-xs text-fg-tertiary block">{{ alertsHint() }}</span>
                  </span>
                </label>

                <label class="pem-row pem-row--option">
                  <input type="checkbox" class="pem-checkbox"
                         [checked]="includeTopVehicles()" (change)="includeTopVehicles.set(!includeTopVehicles())" />
                  <lucide-icon [img]="TrophyIcon" [size]="16"
                    class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="flex-1 min-w-0">
                    <span class="text-sm font-medium text-fg-primary block">Top véhicules</span>
                    <span class="text-xs text-fg-tertiary block">{{ topHint() }}</span>
                  </span>
                </label>
                @if (includeTopVehicles()) {
                  <div class="pem-suboption">
                    <div class="pem-suboption-head">
                      <label class="pem-suboption-label" [attr.for]="'pem-topn-' + uid">
                        Top {{ topN() }}
                      </label>
                    </div>
                    <!-- Bornes en dur : les liaisons [min]/[max] du DOM attendent des
                         chaines, les constantes TS restent la reference du code. -->
                    <input type="range" min="3" max="30" step="1"
                           [id]="'pem-topn-' + uid"
                           [value]="topN()" (input)="onTopNInput($event)"
                           class="pem-range" />
                    <p class="pem-suboption-hint">{{ topSliderHint() }}</p>
                  </div>
                }

                <label class="pem-row pem-row--option">
                  <input type="checkbox" class="pem-checkbox"
                         [checked]="includeTrips()" (change)="includeTrips.set(!includeTrips())" />
                  <lucide-icon [img]="RouteIcon" [size]="16"
                    class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="flex-1 min-w-0">
                    <span class="text-sm font-medium text-fg-primary block">Trajets détaillés</span>
                    <span class="text-xs text-fg-tertiary block">{{ tripsHint() }}</span>
                  </span>
                </label>
                @if (includeTrips()) {
                  <div class="pem-suboption">
                    <div class="pem-suboption-head">
                      <label class="pem-suboption-label" [attr.for]="'pem-max-trips-' + uid">
                        Jusqu'à {{ maxTrips() }} trajets
                      </label>
                      @if (canTakeAllTrips()) {
                        <button type="button" (click)="takeAllTrips()" class="pem-inline-btn">
                          Prendre les {{ tripCount() }}
                        </button>
                      }
                    </div>
                    <input type="range" min="10" max="200" step="10"
                           [id]="'pem-max-trips-' + uid"
                           [value]="maxTrips()" (input)="onMaxTripsInput($event)"
                           class="pem-range" />
                    <p class="pem-suboption-hint">{{ tripsSliderHint() }}</p>
                    @if (tripsOverflow()) {
                      <p class="pem-suboption-hint pem-suboption-hint--warn">
                        Au-delà de {{ maxTripsBound }} lignes un PDF ne se lit plus :
                        l'export CSV « trajets » les contient tous.
                      </p>
                    }
                  </div>
                }
              </div>
            </section>
          </div>

          <!-- Footer sticky : apercu en phrase, nom du fichier, puis actions -->
          <footer class="pem-footer">
            <p class="pem-preview" [class.pem-preview--blocked]="!canExport()"
               aria-live="polite">
              <lucide-icon [img]="canExport() ? EyeIcon : InfoIcon" [size]="14"
                class="pem-preview-icon"></lucide-icon>
              <span>{{ previewSentence() }}</span>
            </p>
            @if (canExport()) {
              <p class="pem-file">Fichier : <span class="pem-file-name">{{ fileName() }}</span></p>
            }
            <div class="pem-actions">
              <button type="button" (click)="onClose()" [disabled]="loading()"
                class="px-4 py-2.5 min-h-[44px] text-sm font-medium rounded-xl
                       bg-bg-tertiary text-fg-secondary border border-border-subtle
                       hover:text-fg-primary transition-colors cursor-pointer
                       disabled:opacity-50 disabled:cursor-not-allowed">
                Annuler
              </button>
              <button type="button" (click)="onExport()" [disabled]="!canExport() || loading()"
                class="px-4 py-2.5 min-h-[44px] text-sm font-medium rounded-xl text-white
                       bg-tracky hover:bg-tracky-dark transition-colors cursor-pointer
                       disabled:opacity-50 disabled:cursor-not-allowed
                       flex items-center gap-2">
                @if (loading()) {
                  <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
                        aria-hidden="true"></span>
                  <span>Export…</span>
                } @else {
                  <lucide-icon [img]="FileTextIcon" [size]="14"></lucide-icon>
                  <span>Générer le PDF</span>
                }
              </button>
            </div>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [`
    /* Container : bottom-sheet sur mobile, modal centree sur desktop */
    .pem-container {
      position: relative;
      width: 100%;
      max-width: 100%;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-subtle);
      border-left: 0;
      border-right: 0;
      border-bottom: 0;
      border-top-left-radius: 20px;
      border-top-right-radius: 20px;
      display: flex;
      flex-direction: column;
      max-height: 92dvh;
      box-shadow: 0 -8px 32px rgba(0, 0, 0, .35);
      animation: pem-slide-up .22s ease-out;
    }
    @media (min-width: 640px) {
      .pem-container {
        max-width: 42rem;
        margin: auto 1rem;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-card, 16px);
        max-height: 85dvh;
        box-shadow: 0 24px 48px rgba(0, 0, 0, .45);
        animation: pem-fade-in .18s ease-out;
      }
    }
    @keyframes pem-slide-up {
      from { transform: translateY(20px); opacity: .7 }
      to   { transform: translateY(0);    opacity: 1  }
    }
    @keyframes pem-fade-in {
      from { transform: scale(.98); opacity: 0 }
      to   { transform: scale(1);   opacity: 1 }
    }

    .pem-header {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 18px 20px 12px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }
    .pem-body {
      flex: 1 1 auto;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      -webkit-overflow-scrolling: touch;
    }
    .pem-footer {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      padding: 12px 20px;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }
    .pem-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }

    /* Rappel « pourquoi PDF plutot que CSV / Excel » */
    .pem-note {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-tertiary);
      font-size: 12px;
      line-height: 1.5;
    }
    .pem-note-icon { flex-shrink: 0; margin-top: 2px }

    /* Bandeau perimetre : vert quand la modale colle a l'ecran, ambre sinon.
       Texte en jetons --texte-* : les couleurs de marque brutes sont illisibles
       sur fond clair. */
    .pem-scope-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px 12px;
      border-radius: 12px;
      font-size: 12px;
      line-height: 1.45;
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 30%, transparent);
      color: var(--texte-succes);
    }
    .pem-scope-banner--changed {
      background: color-mix(in srgb, var(--texte-attente, var(--warning)) 12%, transparent);
      border-color: color-mix(in srgb, var(--texte-attente, var(--warning)) 30%, transparent);
      color: var(--texte-attente, var(--warning));
    }
    .pem-inline-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 44px;
      padding: 0 12px;
      border-radius: 10px;
      border: 1px solid var(--border-subtle);
      background: var(--bg-secondary);
      color: var(--fg-secondary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: color .15s, border-color .15s;
    }
    .pem-inline-btn:hover { color: var(--fg-primary) }

    /* Pills "Toute la flotte / Selection" */
    .pem-pill {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 14px;
      min-height: 44px;
      border-radius: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color .15s, border-color .15s, color .15s;
    }
    .pem-pill:hover { color: var(--fg-primary) }
    .pem-pill--active {
      /* Etat actif : --texte-succes, le vert de marque rend ~3:1 en clair sur ce lavis. */
      background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
      border-color: color-mix(in srgb, var(--color-tracky-light) 35%, transparent);
      color: var(--texte-succes);
    }
    .pem-pill-label { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis }
    .pem-pill-count {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .06);
      color: var(--fg-tertiary);
    }
    .pem-pill--active .pem-pill-count {
      background: color-mix(in srgb, var(--color-tracky-light) 18%, transparent);
      color: var(--texte-succes);
    }

    /* Lignes vehicule + lignes option */
    .pem-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      min-height: 48px;
      background: transparent;
      cursor: pointer;
      transition: background-color .12s;
    }
    .pem-row:hover { background: var(--bg-tertiary) }
    .pem-row--option {
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
    }
    .pem-row--option:has(input:checked) {
      background: color-mix(in srgb, var(--color-tracky-light) 6%, transparent);
      border-color: color-mix(in srgb, var(--color-tracky-light) 25%, transparent);
    }

    /* Checkbox custom — touch-friendly */
    .pem-checkbox {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border-radius: 5px;
      accent-color: var(--color-tracky-light);
      cursor: pointer;
    }

    /* Sous-option (curseur + sa phrase de contexte) */
    .pem-suboption {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 2px 14px 10px 46px;
      animation: pem-fade-in .18s ease-out;
    }
    @media (max-width: 420px) {
      .pem-suboption { padding-left: 14px }
    }
    .pem-suboption-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      min-height: 28px;
    }
    .pem-suboption-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg-secondary);
      white-space: nowrap;
    }
    .pem-suboption-hint {
      font-size: 11px;
      line-height: 1.5;
      color: var(--fg-tertiary);
    }
    .pem-suboption-hint--warn { color: var(--texte-attente, var(--warning)) }
    .pem-range {
      width: 100%;
      max-width: 100%;
      height: 44px;
      accent-color: var(--color-tracky-light);
      cursor: pointer;
    }

    /* Apercu : la derniere phrase lue avant de cliquer. */
    .pem-preview {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 12px;
      font-size: 12px;
      line-height: 1.5;
      background: color-mix(in srgb, var(--color-tracky-light) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 22%, transparent);
      color: var(--fg-secondary);
    }
    .pem-preview-icon { flex-shrink: 0; margin-top: 2px; color: var(--texte-succes) }
    .pem-preview--blocked {
      background: color-mix(in srgb, var(--texte-alerte, var(--danger)) 10%, transparent);
      border-color: color-mix(in srgb, var(--texte-alerte, var(--danger)) 28%, transparent);
      color: var(--texte-alerte, var(--danger));
    }
    .pem-preview--blocked .pem-preview-icon { color: var(--texte-alerte, var(--danger)) }
    .pem-file {
      font-size: 11px;
      color: var(--fg-tertiary);
      overflow-wrap: anywhere;
    }
    .pem-file-name { font-weight: 600; color: var(--fg-secondary) }
  `],
})
export class PdfExportModalComponent {
  readonly open = input.required<boolean>();
  readonly vehicles = input.required<VehicleDetailDto[]>();
  /** Periode courante de la page rapports (affichee en sous-titre, non modifiable ici). */
  readonly periodLabel = input<string>('');
  readonly loading = input(false);

  /**
   * Perimetre de l'ecran appelant (vehicule choisi, ou vehicules du groupe filtre).
   * Optionnel : sans lui la modale se comporte comme avant (flotte entiere).
   */
  readonly preselectedVehicleIds = input<string[]>([]);
  /** Nombre de trajets de la periode — rend le curseur « max trajets » comprehensible. */
  readonly tripCount = input<number | null>(null);
  /** Nombre d'alertes de la periode — idem pour la section Alertes. */
  readonly alertCount = input<number | null>(null);
  /**
   * Suffixe de dates du fichier genere, format backend "2026-08-27_2026-09-02".
   * Optionnel : sans lui, le nom affiche reste vrai mais laisse les dates en pointilles.
   */
  readonly fileDateRange = input<string>('');

  readonly closed = output<void>();
  readonly exportRequested = output<PdfExportRequest>();

  // ─── State ──────────────────────────────────────────────────────────────
  protected readonly scope = signal<Scope>('all');
  protected readonly selectedIds = signal<Set<string>>(new Set<string>());
  /** Signal (et non champ simple) : `filteredVehicles` est un computed, il ne se
   *  recalculerait jamais sur une propriete non reactive — la recherche restait morte. */
  protected readonly search = signal('');

  protected readonly includeKpi = signal(true);
  protected readonly includeAlerts = signal(true);
  protected readonly includeTopVehicles = signal(true);
  protected readonly includeTrips = signal(true);

  protected readonly maxTrips = signal(DEFAULT_MAX_TRIPS);
  protected readonly topN = signal(DEFAULT_TOP_N);

  /** Vrai une fois la premiere ouverture appliquee — garde-fou d'ecriture localStorage. */
  private readonly prefsReady = signal(false);

  /** Plafond de trajets, cite dans l'avertissement « au-dela de 200 lignes ». */
  protected readonly maxTripsBound = MAX_TRIPS;

  /**
   * A chaque ouverture : le CONTENU repart du dernier choix memorise, le
   * PERIMETRE repart de l'ecran.
   *
   * POURQUOI cette asymetrie : un perimetre memorise est un piege. Le client
   * filtre sa page sur EP-047-TY, ouvre l'export, et recevrait le perimetre
   * d'un export fait la semaine derniere sur trois autres camions — sans
   * jamais le voir, puisque le PDF sort tout seul. Le perimetre doit donc
   * toujours dire la meme chose que l'ecran. Les sections et les caps, eux,
   * sont un gout personnel stable : les redemander chaque semaine est une
   * corvee, pas une securite.
   *
   * `untracked` : le parent passe souvent un tableau recree a chaque cycle de
   * detection ; sans lui l'effet se rejouerait en boucle et effacerait la
   * selection en cours de l'utilisateur.
   */
  private readonly openingEffect = effect(() => {
    if (!this.open()) return;
    untracked(() => this.applyOpeningState());
  });

  /**
   * Persistance du CONTENU seulement. Les signaux sont lus AVANT le garde-fou :
   * un `return` anticipe casserait le suivi des dependances et l'effet ne se
   * rejouerait plus.
   */
  private readonly persistEffect = effect(() => {
    const prefs: ExportPrefs = {
      sections: this.currentSections(),
      maxTrips: this.maxTrips(),
      topN: this.topN(),
    };
    if (!this.prefsReady()) return;
    if (prefs.sections.length === 0) return;
    writePrefs(prefs);
  });

  // ─── Icons ──────────────────────────────────────────────────────────────
  protected readonly FileTextIcon = FileText;
  protected readonly XIcon = X;
  protected readonly SearchIcon = Search;
  protected readonly CheckIcon = Check;
  protected readonly TruckIcon = Truck;
  protected readonly ListChecksIcon = ListChecks;
  protected readonly BarChart3Icon = BarChart3;
  protected readonly AlertTriangleIcon = AlertTriangle;
  protected readonly TrophyIcon = Trophy;
  protected readonly RouteIcon = Route;
  protected readonly InfoIcon = Info;
  protected readonly EyeIcon = Eye;
  protected readonly RotateCcwIcon = RotateCcw;

  protected readonly uid = Math.random().toString(36).slice(2, 9);

  /**
   * Compte EXACT des cartes rendues par report-pdf.service : neuf indicateurs,
   * onze quand un prix carburant a ete releve en station. Le libelle disait
   * « 8 cartes » : le client comptait et ne trouvait pas ses chiffres.
   */
  protected readonly kpiHint =
    '9 chiffres de synthèse — véhicules ayant roulé, trajets, distance, '
    + 'distance moyenne, durée, vitesses, conso et coût. 11 si un prix carburant '
    + 'a été relevé en station.';

  // ─── Derived ────────────────────────────────────────────────────────────
  private readonly vehicleById = computed(() => {
    const map = new Map<string, VehicleDetailDto>();
    for (const v of this.vehicles()) map.set(v.id, v);
    return map;
  });

  protected readonly filteredVehicles = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.vehicles();
    if (!q) return list;
    return list.filter((v) =>
      (v.plate + ' ' + (v.brand ?? '') + ' ' + (v.model ?? '')).toLowerCase().includes(q),
    );
  });

  protected readonly allFilteredSelected = computed(() => {
    const filtered = this.filteredVehicles();
    if (filtered.length === 0) return false;
    const sel = this.selectedIds();
    return filtered.every((v) => sel.has(v.id));
  });

  /** Perimetre de l'ecran, nettoye des identifiants vides. */
  protected readonly screenScopeIds = computed(() =>
    this.preselectedVehicleIds().filter((id) => !!id),
  );

  /** « EP-047-TY » / « EP-047-TY, AB-123-CD » / « 5 véhicules ». */
  protected readonly screenScopeLabel = computed(() =>
    this.plateSummary(this.screenScopeIds()),
  );

  /** Vrai quand la selection courante est exactement celle de l'ecran. */
  protected readonly matchesScreenScope = computed(() => {
    const ids = this.screenScopeIds();
    if (ids.length === 0) return false;
    if (this.scope() !== 'selected') return false;
    const sel = this.selectedIds();
    return sel.size === ids.length && ids.every((id) => sel.has(id));
  });

  protected readonly currentSections = computed<PdfReportSection[]>(() => {
    const sections: PdfReportSection[] = [];
    if (this.includeKpi()) sections.push('kpi');
    if (this.includeAlerts()) sections.push('alerts');
    if (this.includeTopVehicles()) sections.push('topVehicles');
    if (this.includeTrips()) sections.push('trips');
    return sections;
  });

  /** Nombre de vehicules reellement couverts par le rapport. */
  protected readonly scopeVehicleCount = computed(() =>
    this.scope() === 'all' ? this.vehicles().length : this.selectedIds().size,
  );

  /** Un top 10 sur un perimetre de 4 vehicules ne sort que 4 lignes : on le dit. */
  protected readonly effectiveTopN = computed(() => {
    const count = this.scopeVehicleCount();
    return count > 0 ? Math.min(this.topN(), count) : this.topN();
  });

  /** Le cap ne peut pas produire plus de trajets que la periode n'en contient. */
  protected readonly effectiveMaxTrips = computed(() => {
    const total = this.tripCount();
    return total != null && total >= 0 ? Math.min(this.maxTrips(), total) : this.maxTrips();
  });

  protected readonly coversAllTrips = computed(() => {
    const total = this.tripCount();
    return total != null && this.maxTrips() >= total;
  });

  /** Bouton « Prendre les 391 » : visible seulement si le cap peut vraiment y aller. */
  protected readonly canTakeAllTrips = computed(() => {
    const total = this.tripCount();
    return total != null && total > 0 && total <= MAX_TRIPS && !this.coversAllTrips();
  });

  /** La periode contient plus de trajets que le PDF ne peut en porter. */
  protected readonly tripsOverflow = computed(() => {
    const total = this.tripCount();
    return total != null && total > MAX_TRIPS;
  });

  protected readonly alertsHint = computed(() => {
    const n = this.alertCount();
    const detail = 'total, répartition par type et par sévérité';
    if (n == null) return 'Sur la période : ' + detail + '.';
    if (n === 0) return 'Aucune alerte sur la période — la section le dira noir sur blanc.';
    if (n === 1) return '1 alerte sur la période — ' + detail + '.';
    return n + ' alertes sur la période — ' + detail + '.';
  });

  protected readonly topHint = computed(() => {
    const n = this.effectiveTopN();
    const base = n > 1
      ? 'Les ' + n + ' véhicules qui ont le plus roulé'
      : 'Le véhicule qui a le plus roulé';
    return base + ' — plaque, distance, trajets, carburant estimé.';
  });

  protected readonly topSliderHint = computed(() => {
    const asked = this.topN();
    const effective = this.effectiveTopN();
    if (effective < asked) {
      return 'Le périmètre ne compte que ' + effective
        + ' véhicule' + (effective > 1 ? 's' : '') + ' : le classement s\'arrêtera là.';
    }
    return 'Classement par kilomètres parcourus sur la période.';
  });

  protected readonly tripsHint = computed(() => {
    const total = this.tripCount();
    const effective = this.effectiveMaxTrips();
    if (total == null) {
      return 'Les ' + effective + ' plus récents — date, plaque, durée, distance, conducteur, note.';
    }
    if (this.coversAllTrips()) {
      return total === 0
        ? 'Aucun trajet sur la période : la section ne sortira pas.'
        : 'Les ' + total + ' trajets de la période — date, plaque, durée, distance, conducteur, note.';
    }
    return 'Les ' + effective + ' plus récents sur ' + total
      + ' — date, plaque, durée, distance, conducteur, note.';
  });

  protected readonly tripsSliderHint = computed(() => {
    const total = this.tripCount();
    const effective = this.effectiveMaxTrips();
    if (total == null) {
      return effective + ' trajets, du plus récent au plus ancien.';
    }
    if (total === 0) {
      return 'Aucun trajet sur la période : ce curseur ne changera rien.';
    }
    if (this.coversAllTrips()) {
      return 'Tous les trajets de la période (' + total + '), du plus récent au plus ancien.';
    }
    return effective + ' des ' + total
      + ' trajets de la période, du plus récent au plus ancien.';
  });

  /**
   * « du 27 août au 02 sept. inclus » — reconstruit depuis le libelle parent
   * (« 27 août → 02 sept. · 7 jours »), qui reste l'unique source de verite de
   * la periode. Si le format change, on retombe sur le libelle brut plutot que
   * d'inventer des dates.
   */
  protected readonly periodPhrase = computed(() => {
    const raw = this.periodLabel().trim();
    if (!raw) return '';
    const main = (raw.split('·')[0] ?? '').trim();
    const parts = main.split('→');
    if (parts.length === 2) {
      const from = parts[0]!.trim();
      const to = parts[1]!.trim();
      if (from && to) return 'du ' + from + ' au ' + to + ' inclus';
    }
    return 'sur la période ' + raw;
  });

  protected readonly scopePhrase = computed(() => {
    if (this.scope() === 'all') {
      const n = this.vehicles().length;
      return n > 0
        ? 'pour toute la flotte (' + n + ' véhicule' + (n > 1 ? 's' : '') + ')'
        : 'pour toute la flotte';
    }
    const label = this.plateSummary(Array.from(this.selectedIds()));
    return label ? 'pour ' + label : 'pour aucun véhicule';
  });

  /**
   * Phrase complete lue juste avant de cliquer. C'est elle qui remplace le
   * « 12 véhicules · 4 sections » d'avant, qui ne disait ni la periode, ni le
   * volume, ni ce que le client allait recevoir.
   */
  protected readonly previewSentence = computed(() => {
    if (this.currentSections().length === 0) {
      return 'Cochez au moins une section : un PDF sans contenu n\'a rien à montrer.';
    }
    if (this.scope() === 'selected' && this.selectedIds().size === 0) {
      return 'Cochez au moins un véhicule, ou revenez à « Toute la flotte ».';
    }
    const period = this.periodPhrase();
    const head = period
      ? 'Vous allez recevoir un PDF ' + period
      : 'Vous allez recevoir un PDF';
    return head + ', ' + this.scopePhrase() + ', avec ' + joinFr(this.sectionPhrases()) + '.';
  });

  /**
   * Nom du fichier tel que le backend le compose : « tracky-rapport- », la plaque
   * quand le rapport ne porte que sur un vehicule, puis les dates de la periode.
   */
  protected readonly fileName = computed(() => {
    let scopePart = '';
    if (this.scope() === 'selected' && this.selectedIds().size === 1) {
      const id = Array.from(this.selectedIds())[0]!;
      const plate = this.vehicleById().get(id)?.plate;
      if (plate) scopePart = plate.replace(/[^A-Za-z0-9-]+/g, '-') + '-';
    }
    const dates = this.fileDateRange().trim() || '…';
    return 'tracky-rapport-' + scopePart + dates + '.pdf';
  });

  protected readonly canExport = computed(() => {
    if (this.currentSections().length === 0) return false;
    if (this.scope() === 'selected' && this.selectedIds().size === 0) return false;
    return true;
  });

  // ─── Handlers ───────────────────────────────────────────────────────────
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open() && !this.loading()) this.onClose();
  }

  protected onClose(): void {
    if (this.loading()) return;
    this.closed.emit();
  }

  protected onSearchInput(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected onScopeAll(): void {
    this.scope.set('all');
  }

  /** Passer en « Sélection » sans rien de coché n'aide personne : on repropose l'écran. */
  protected onScopeSelected(): void {
    this.scope.set('selected');
    if (this.selectedIds().size === 0 && this.screenScopeIds().length > 0) {
      this.selectedIds.set(new Set(this.screenScopeIds()));
    }
  }

  protected restoreScreenScope(): void {
    const ids = this.screenScopeIds();
    if (ids.length === 0) return;
    this.scope.set('selected');
    this.selectedIds.set(new Set(ids));
  }

  protected onToggleVehicle(id: string): void {
    const next = new Set(this.selectedIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selectedIds.set(next);
  }

  protected onToggleAllFiltered(): void {
    const filtered = this.filteredVehicles();
    const next = new Set(this.selectedIds());
    if (this.allFilteredSelected()) {
      for (const v of filtered) next.delete(v.id);
    } else {
      for (const v of filtered) next.add(v.id);
    }
    this.selectedIds.set(next);
  }

  protected onMaxTripsInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isNaN(value)) this.maxTrips.set(value);
  }

  protected onTopNInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isNaN(value)) this.topN.set(value);
  }

  /** Monte le cap au premier cran qui couvre toute la periode. */
  protected takeAllTrips(): void {
    const total = this.tripCount();
    if (total == null || total <= 0) return;
    const rounded = Math.ceil(total / TRIPS_STEP) * TRIPS_STEP;
    this.maxTrips.set(Math.min(MAX_TRIPS, Math.max(MIN_TRIPS, rounded)));
  }

  protected onExport(): void {
    if (!this.canExport() || this.loading()) return;

    this.exportRequested.emit({
      vehicleIds: this.scope() === 'selected' ? Array.from(this.selectedIds()) : undefined,
      sections: this.currentSections(),
      maxTrips: this.maxTrips(),
      topN: this.topN(),
    });
  }

  // ─── Interne ────────────────────────────────────────────────────────────
  /** Etat d'ouverture : perimetre = ecran, contenu = dernier choix memorise. */
  private applyOpeningState(): void {
    this.search.set('');

    const preset = this.screenScopeIds();
    if (preset.length > 0) {
      this.scope.set('selected');
      this.selectedIds.set(new Set(preset));
    } else {
      this.scope.set('all');
      this.selectedIds.set(new Set());
    }

    const prefs = readPrefs();
    if (prefs) {
      this.includeKpi.set(prefs.sections.includes('kpi'));
      this.includeAlerts.set(prefs.sections.includes('alerts'));
      this.includeTopVehicles.set(prefs.sections.includes('topVehicles'));
      this.includeTrips.set(prefs.sections.includes('trips'));
      this.maxTrips.set(prefs.maxTrips);
      this.topN.set(prefs.topN);
    } else {
      this.includeKpi.set(true);
      this.includeAlerts.set(true);
      this.includeTopVehicles.set(true);
      this.includeTrips.set(true);
      this.maxTrips.set(DEFAULT_MAX_TRIPS);
      this.topN.set(DEFAULT_TOP_N);
    }

    this.prefsReady.set(true);
  }

  /**
   * Nomme les vehicules quand on peut TOUS les nommer, sinon donne un compte.
   * Une liste partielle (« EP-047-TY, … ») laisserait croire a un perimetre plus
   * petit qu'il ne l'est.
   */
  private plateSummary(ids: string[]): string {
    if (ids.length === 0) return '';
    if (ids.length > 3) return ids.length + ' véhicules';
    const byId = this.vehicleById();
    const plates: string[] = [];
    for (const id of ids) {
      const plate = byId.get(id)?.plate;
      if (plate) plates.push(plate);
    }
    if (plates.length !== ids.length) return ids.length + ' véhicules';
    return plates.sort((a, b) => a.localeCompare(b, 'fr')).join(', ');
  }

  /** Morceaux de l'enumeration « avec … » de la phrase d'apercu. */
  private sectionPhrases(): string[] {
    const out: string[] = [];
    if (this.includeKpi()) out.push('les indicateurs clés');
    if (this.includeAlerts()) {
      const n = this.alertCount();
      if (n == null) out.push('les alertes');
      else if (n === 0) out.push('la section alertes (aucune sur la période)');
      else if (n === 1) out.push('l\'unique alerte');
      else out.push('les ' + n + ' alertes');
    }
    if (this.includeTopVehicles()) {
      const n = this.effectiveTopN();
      out.push(n > 1 ? 'le top ' + n + ' des véhicules' : 'le véhicule qui a le plus roulé');
    }
    if (this.includeTrips()) {
      const total = this.tripCount();
      const effective = this.effectiveMaxTrips();
      if (total != null && this.coversAllTrips()) {
        out.push(total === 0 ? 'aucun trajet à détailler' : 'les ' + total + ' trajets de la période');
      } else if (effective === 1) {
        out.push('le trajet le plus récent');
      } else {
        out.push('les ' + effective + ' trajets les plus récents');
      }
    }
    return out;
  }
}
