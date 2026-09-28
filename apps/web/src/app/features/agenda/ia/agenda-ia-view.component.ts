import { swallow } from '../../../core/error/swallow';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage } from '../../../core/error/api-error';
import {
  LucideAngularModule, Sparkles, Check, X, AlertTriangle, Loader, Info, MapPin, ChevronDown, ChevronRight,
  Settings, CalendarCheck, TrendingDown, Truck, Clock, Zap,
} from 'lucide-angular';
import {
  FLEET_METIER_LABELS,
  type AgendaAgentProposalDto,
  type AgendaAgentRunDto,
  type AgendaAgentRunResultDto,
  type AiCapacityLatestDto,
  type AiCapacityProposalDto,
  type FleetMetier,
  type FleetOptimizationDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaApiService } from '../../../core/services/agenda.service';
import { AgendaAgentApiService } from '../../../core/services/agenda-agent.service';
import { AiApiService } from '../../../core/services/ai.service';
import { AiJobService } from '../../../core/services/ai-job.service';
import { AiStatusService } from '../../../core/services/ai-status.service';
import { AuthService } from '../../../core/services/auth.service';
import { FleetCacheService } from '../../../core/services/fleet-cache.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';

const METIERS: FleetMetier[] = ['CHILDREN_TRANSPORT', 'PARCELS', 'RENTAL', 'GENERIC'];

/** Les propositions d'un même véhicule, ensemble : « on se perd quand plusieurs positions concernent la même voiture ». */
export interface GroupeProposals {
  vehicleId: string;
  plate: string;
  items: AgendaAgentProposalDto[];
}

/**
 * Regroupe les propositions par véhicule, chaque groupe trié par date, les groupes par plaque.
 * Exportée pour être éprouvée : c'est l'ordre dans lequel le gestionnaire décide.
 */
export function grouperParVehicule(items: AgendaAgentProposalDto[]): GroupeProposals[] {
  const map = new Map<string, GroupeProposals>();
  for (const p of items) {
    const g = map.get(p.vehicleId);
    if (g) g.items.push(p);
    else map.set(p.vehicleId, { vehicleId: p.vehicleId, plate: p.vehiclePlate || '—', items: [p] });
  }
  const groupes = [...map.values()];
  for (const g of groupes) g.items.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  return groupes.sort((a, b) => a.plate.localeCompare(b.plate));
}

/**
 * ── VUE « ASSISTANT IA » (refonte UX du 28/09, points 2, 6 et 7) ─────────────────────────────
 *
 * « J'ai même pensé qu'il serait préférable de regrouper toutes les actions IA dans un seul onglet
 * dédié, plutôt que d'avoir énormément de boutons dispersés. » Les voici, dans l'ordre où elles
 * servent, chacune disant CE QU'ELLE LIT, CE QU'ELLE PROPOSE et CE QU'ELLE CHANGE :
 *
 *  1. Vérifier le parc — l'analyse des capacités (places, équipements). Analyser ne modifie rien ;
 *     Appliquer écrit les fiches cochées. UNE analyse par jour et par société, résultat conservé.
 *  2. Valider les propositions de l'agent — regroupées par véhicule, actions en ligne.
 *  3. Réserver avec l'IA — ce que « Suggérer avec l'IA » fait dans la feuille Réserver.
 *  Puis les véhicules sous-utilisés (sans IA, déterministe).
 *
 * Remplace les feuilles « Optimisation » et « Propositions de l'agent » (supprimées).
 */
@Component({
  selector: 'app-agenda-ia-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, LucideAngularModule],
  template: `
    <section class="ia" aria-label="Assistant IA">
      <!-- En-tête : ce que l'assistant est, et la règle qui rassure. -->
      <header class="ia-hero">
        <span class="ia-hero-ico"><lucide-icon [img]="SparklesIcon" [size]="20"></lucide-icon></span>
        <div class="ia-hero-txt">
          <h2 class="ia-hero-t">Assistant IA @if (fleetName(); as n) { <span class="ia-hero-fleet">· {{ n }}</span> }</h2>
          <p class="ia-hero-l">Trois gestes, dans l'ordre. <strong>Rien n'est écrit sans votre validation</strong> : l'IA lit et propose, vous décidez.</p>
        </div>
        @if (canEditMetier()) {
          <label class="ia-metier">
            <span>Métier de la flotte</span>
            <select class="ia-in" [value]="metier() ?? ''" (change)="onMetierChange($any($event.target).value)" [disabled]="!metier()">
              @for (m of metiers; track m) { <option [value]="m" [selected]="m === metier()">{{ metierLabel(m) }}</option> }
            </select>
          </label>
        } @else if (metier(); as m) {
          <span class="ia-metier ia-metier--ro"><span>Métier de la flotte</span><strong>{{ metierLabel(m) }}</strong></span>
        }
      </header>

      @if (needsFleet()) {
        <div class="ia-note"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Choisissez une société dans le bandeau en haut de page : l'assistant travaille sur un parc à la fois.</div>
      } @else if (!aiMaster()) {
        <div class="ia-note"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> L'assistance IA est désactivée pour cette société (Paramètres de l'agenda). Les véhicules sous-utilisés, calculés sans IA, restent visibles plus bas.</div>
      }

      <!-- ───── Étape 1 — Vérifier le parc ───── -->
      @if (!needsFleet() && aiCapacity()) {
        <article class="ia-step" [class.ia-step--fait]="etape1Faite()">
          <div class="ia-step-head">
            <span class="ia-n" [class.ia-n--ok]="etape1Faite()">@if (etape1Faite()) { <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> } @else { 1 }</span>
            <h3 class="ia-step-t">Vérifier le parc</h3>
            @if (latest()?.analysis; as a) {
              <span class="ia-badge">{{ restantes().length }} à appliquer</span>
            }
          </div>
          <dl class="ia-lit">
            <div><dt>Ce que ça lit</dt><dd>la marque et le modèle de chaque véhicule (Jumpy, Trafic, Kangoo…), et ce que sa fiche dit déjà.</dd></div>
            <div><dt>Ce que ça propose</dt><dd>le nombre de places et les équipements qui manquent sur la fiche, avec un indice de confiance.</dd></div>
            <div><dt>Ce que ça change</dt><dd><strong>rien</strong> tant que vous n'appliquez pas. « Appliquer » écrit les fiches cochées ; les réservations et l'IA de placement s'en servent ensuite.</dd></div>
          </dl>

          <div class="ia-quota" [class.ia-quota--bloque]="latest() && !latest()!.canRun">
            <lucide-icon [img]="ClockIcon" [size]="13"></lucide-icon>
            <span>
              @if (latest()?.analysis; as a) {
                Dernière analyse le <strong>{{ a.analysedAt | date:'dd/MM à HH:mm' }}</strong>
                @if (latest()!.canRun) { — une nouvelle est possible. } @else { — prochaine possible le <strong>{{ latest()!.nextAllowedAt | date:'EEEE d MMM à HH:mm' }}</strong>. }
              } @else if (latestLoading()) {
                Lecture de la dernière analyse…
              } @else {
                Aucune analyse pour l'instant.
              }
              <span class="ia-quota-why">Une analyse par jour et par société : le parc ne change pas d'heure en heure, et chaque analyse est facturée. Relancer sans avoir rien changé redonne le même résultat.</span>
            </span>
          </div>

          <div class="ia-actions">
            @if (canRunCapacity()) {
              <button type="button" class="ia-btn ia-btn--primary" [disabled]="!peutLancer()" [title]="titreLancement()" (click)="lancerAnalyse()">
                @if (analyseEnCours()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="ia-spin"></lucide-icon> Analyse en cours… } @else { <lucide-icon [img]="SparklesIcon" [size]="14"></lucide-icon> Analyser le parc }
              </button>
            }
            <button type="button" class="ia-btn" (click)="parc.emit()"><lucide-icon [img]="TruckIcon" [size]="14"></lucide-icon> Vérifier à la main dans la vue Parc</button>
          </div>
          @if (latestError(); as e) { <div class="ia-alert ia-alert--err"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ e }}</div> }

          @if (latest()?.analysis; as a) {
            @if (a.proposals.length === 0) {
              <p class="ia-muted">Aucune proposition : le parc semble déjà renseigné.</p>
            } @else {
              @if (restantes().length > 0) {
                @if (canApply()) {
                  <div class="ia-selbar">
                    <button type="button" class="ia-link" (click)="toggleAll()">{{ allSelected() ? 'Tout désélectionner' : 'Tout sélectionner' }}</button>
                    <span class="ia-selc">{{ selected().size }}/{{ restantes().length }} cochée(s)</span>
                  </div>
                } @else {
                  <div class="ia-alert ia-alert--info"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Consultation seule — le droit « Modifier un véhicule » est requis pour appliquer.</div>
                }
                <div class="ia-cards">
                  @for (p of restantes(); track p.vehicleId) {
                    <button type="button" class="ia-card" [class.ia-card--on]="canApply() && selected().has(p.vehicleId)" [disabled]="!canApply()" (click)="toggleSel(p.vehicleId)">
                      <div class="ia-card-top">
                        <span class="ia-plate">{{ p.plate || '—' }}@if (p.model) { <span class="ia-model">{{ p.model }}</span> }</span>
                        <span class="ia-chip" [class.ia-chip--hi]="p.confidence >= 0.7" [class.ia-chip--mid]="p.confidence >= 0.4 && p.confidence < 0.7" [class.ia-chip--lo]="p.confidence < 0.4">{{ p.confidence * 100 | number:'1.0-0' }}%</span>
                      </div>
                      <div class="ia-vals"><span>{{ valOf(p.seats) }} places</span>@if (p.features.length > 0) { <span>{{ p.features.join(', ') }}</span> }</div>
                      @if (p.reasoning) { <p class="ia-reason">{{ p.reasoning }}</p> }
                    </button>
                  }
                </div>
                @if (canApply()) {
                  <div class="ia-apply">
                    <button type="button" class="ia-btn ia-btn--primary" [disabled]="applying() || selected().size === 0" (click)="appliquer()">
                      @if (applying()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="ia-spin"></lucide-icon> }
                      {{ applying() ? 'Application…' : 'Appliquer sur ' + selected().size + ' fiche(s)' }}
                    </button>
                  </div>
                }
              }
              @if (appliquees().length > 0) {
                <p class="ia-done"><lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> Déjà appliqué : {{ appliqueesPlaques() }}</p>
              }
            }
          }
        </article>
      }

      <!-- ───── Étape 2 — Propositions de l'agent ───── -->
      @if (!needsFleet() && (aiAgent() || proposals().length > 0)) {
        <article class="ia-step" [class.ia-step--fait]="proposals().length === 0">
          <div class="ia-step-head">
            <span class="ia-n" [class.ia-n--ok]="proposals().length === 0">@if (proposals().length === 0) { <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> } @else { 2 }</span>
            <h3 class="ia-step-t">Valider les propositions de l'agent</h3>
            @if (proposals().length > 0) { <span class="ia-badge ia-badge--n">{{ proposals().length }}</span> }
            @if (groupes().length > 1) {
              <button type="button" class="ia-link ia-link--right" (click)="toutReplierOuDeplier()">{{ toutReplie() ? 'Tout déplier' : 'Tout replier' }}</button>
            }
          </div>
          <dl class="ia-lit">
            <div><dt>Ce que ça lit</dt><dd>les trajets des dernières semaines, la nuit ({{ heureNuit() }}).</dd></div>
            <div><dt>Ce que ça propose</dt><dd>une réservation quand un véhicule part au même moment chaque semaine (même jour, même heure, même destination). Elle apparaît en pointillé dans le calendrier et <strong>ne bloque rien</strong>.</dd></div>
            <div><dt>Ce que ça change</dt><dd>« Réserver » pose une vraie réservation sur le créneau. « Écarter » ne change rien : la proposition disparaît.</dd></div>
          </dl>

          @if (proposals().length === 0) {
            <p class="ia-muted">Aucune proposition en attente.
              @if (dernierPassage(); as r) { Dernier passage le {{ r.startedAt | date:'dd/MM à HH:mm' }} : @if (r.status === 'error') { échec. } @else if (r.patterns === 0) { aucune habitude assez nette. } @else { {{ r.patterns }} habitude(s), {{ r.proposed }} proposée(s). } }
            </p>
          } @else {
            <div class="ia-groupes">
              @for (g of groupes(); track g.vehicleId) {
                <div class="ia-g" [class.ia-g--replie]="replies().has(g.vehicleId)">
                  <div class="ia-g-head">
                    <button type="button" class="ia-g-toggle" (click)="basculer(g.vehicleId)" [attr.aria-expanded]="!replies().has(g.vehicleId)">
                      <lucide-icon [img]="replies().has(g.vehicleId) ? ChevronRightIcon : ChevronDownIcon" [size]="15"></lucide-icon>
                      <span class="ia-plate">{{ g.plate }}</span>
                      <span class="ia-g-n">{{ g.items.length }} proposition{{ g.items.length > 1 ? 's' : '' }}</span>
                    </button>
                    @if (canManage() && g.items.length > 1) {
                      <div class="ia-g-bulk">
                        <button type="button" class="ia-mini ia-mini--ok" [disabled]="busyGroupe() === g.vehicleId" (click)="toutReserver(g)"><lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Tout réserver</button>
                        <button type="button" class="ia-mini" [disabled]="busyGroupe() === g.vehicleId" (click)="toutEcarter(g)"><lucide-icon [img]="XIcon" [size]="12"></lucide-icon> Tout écarter</button>
                      </div>
                    }
                  </div>
                  @if (!replies().has(g.vehicleId)) {
                    <ul class="ia-rows">
                      @for (p of g.items; track p.id) {
                        <li class="ia-row" [class.ia-row--busy]="busy().has(p.id)">
                          <span class="ia-row-when">{{ p.startAt | date:'EEE d MMM' }} <strong>{{ p.startAt | date:'HH:mm' }} → {{ p.endAt | date:'HH:mm' }}</strong></span>
                          @if (p.destinationLabel) { <span class="ia-row-dest"><lucide-icon [img]="MapPinIcon" [size]="11"></lucide-icon> {{ p.destinationLabel }}</span> }
                          <span class="ia-row-conf" [class.ia-chip--hi]="p.confidence >= 0.7" [title]="p.reasoning">{{ p.confidence * 100 | number:'1.0-0' }}%</span>
                          @if (canManage()) {
                            <span class="ia-row-act">
                              <button type="button" class="ia-mini ia-mini--ok" [disabled]="busy().has(p.id)" (click)="reserverProposition(p)" title="Réserver ce créneau"><lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Réserver</button>
                              <button type="button" class="ia-mini" [disabled]="busy().has(p.id)" (click)="ecarter(p)" title="Écarter cette proposition" aria-label="Écarter"><lucide-icon [img]="XIcon" [size]="12"></lucide-icon></button>
                            </span>
                          }
                        </li>
                      }
                    </ul>
                  }
                </div>
              }
            </div>
          }

          <div class="ia-actions ia-actions--foot">
            @if (canConfigureAgent() && aiAgent()) {
              <button type="button" class="ia-btn" [disabled]="passageEnCours() || agentEnabled() === false" [title]="agentEnabled() === false ? 'L’agent est désactivé : activez-le dans les réglages.' : 'Préparer les propositions maintenant, sans attendre la nuit'" (click)="lancerPassage()">
                @if (passageEnCours()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="ia-spin"></lucide-icon> } @else { <lucide-icon [img]="ZapIcon" [size]="14"></lucide-icon> } Lancer un passage maintenant
              </button>
            }
            @if (canConfigureAgent()) {
              <button type="button" class="ia-btn" (click)="reglages.emit()"><lucide-icon [img]="SettingsIcon" [size]="14"></lucide-icon> Réglages de l'agent</button>
            }
          </div>
        </article>
      }

      <!-- ───── Étape 3 — Réserver avec l'IA ───── -->
      @if (!needsFleet() && aiPlacement()) {
        <article class="ia-step ia-step--info">
          <div class="ia-step-head">
            <span class="ia-n">3</span>
            <h3 class="ia-step-t">Réserver avec l'IA</h3>
          </div>
          <dl class="ia-lit">
            <div><dt>Où</dt><dd>dans <strong>Réserver</strong>, le bouton « Suggérer avec l'IA », une fois le créneau et le besoin saisis.</dd></div>
            <div><dt>Ce que ça lit</dt><dd>les véhicules libres sur le créneau : places, sièges auto à bord ou en stock, énergie, coût au kilomètre, utilisation récente.</dd></div>
            <div><dt>Ce que ça change</dt><dd>rien : elle classe les trois meilleurs et pré-sélectionne le premier. C'est « Réserver » qui réserve.</dd></div>
          </dl>
          @if (canReserve()) {
            <div class="ia-actions"><button type="button" class="ia-btn ia-btn--primary" (click)="reserver.emit()"><lucide-icon [img]="CalendarCheckIcon" [size]="14"></lucide-icon> Ouvrir Réserver</button></div>
          }
        </article>
      }

      <!-- ───── Sous-utilisés (déterministe, sans IA) ───── -->
      @if (!needsFleet()) {
        <article class="ia-step ia-step--plain">
          <div class="ia-step-head">
            <span class="ia-n ia-n--plain"><lucide-icon [img]="TrendingDownIcon" [size]="13"></lucide-icon></span>
            <h3 class="ia-step-t">Véhicules sous-utilisés <span class="ia-sans">sans IA</span></h3>
          </div>
          <p class="ia-muted">Calculé sur les trajets réels des 28 derniers jours : les véhicules qui roulent peu, et quand ils sont libres. Utile avant de réserver ou de mutualiser.</p>
          @if (utilLoading()) { <div class="ia-skel"></div> }
          @else if (underutilized().length === 0) { <p class="ia-muted">Aucun véhicule franchement sous-utilisé.</p> }
          @else {
            <div class="ia-under">
              @for (v of underutilized(); track v.vehicleId) {
                <div class="ia-u">
                  <div class="ia-u-top"><span class="ia-plate">{{ v.vehiclePlate || '—' }}</span><span class="ia-u-pct">{{ v.utilizationRatio * 100 | number:'1.0-0' }}% utilisé</span></div>
                  @if (v.freePatterns.length > 0) { <div class="ia-free">@for (fp of v.freePatterns; track fp) { <span class="ia-free-c">Libre {{ fp }}</span> }</div> }
                </div>
              }
            </div>
          }
        </article>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ia { display: flex; flex-direction: column; gap: 12px; }
    .ia-hero { display: flex; gap: 12px; align-items: flex-start; padding: 14px 15px; border-radius: 14px; border: 1px solid var(--border-subtle);
               background: color-mix(in srgb, var(--tracky) 5%, var(--bg-secondary)); flex-wrap: wrap; }
    .ia-hero-ico { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 12px; background: var(--tracky); color: var(--accent-ink); flex-shrink: 0; }
    .ia-hero-txt { flex: 1; min-width: 220px; }
    .ia-hero-t { margin: 0; font-size: 16px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .ia-hero-fleet { font-weight: 600; color: var(--fg-secondary); }
    .ia-hero-l { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-secondary); line-height: 1.5; }
    .ia-hero-l strong { color: var(--fg-primary); }
    .ia-metier { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .ia-metier--ro strong { font-size: 13px; text-transform: none; letter-spacing: 0; color: var(--fg-primary); }
    .ia-in { padding: 7px 10px; border-radius: 9px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 13px; text-transform: none; letter-spacing: 0; font-weight: 600; }
    .ia-note { display: flex; align-items: center; gap: 7px; padding: 10px 12px; border-radius: 11px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); font-size: 12.5px; }

    .ia-step { display: flex; flex-direction: column; gap: 10px; padding: 14px 15px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .ia-step--fait { border-color: color-mix(in srgb, var(--tracky-light) 35%, transparent); }
    .ia-step-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .ia-n { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 8px; font-family: var(--font-mono); font-size: 12px; font-weight: 800;
            background: color-mix(in srgb, var(--tracky) 12%, transparent); color: var(--texte-succes); flex-shrink: 0; }
    .ia-n--ok { background: var(--tracky-light); color: var(--accent-ink); }
    .ia-n--plain { background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .ia-step-t { margin: 0; font-size: 14.5px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .ia-sans { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-tertiary); margin-left: 6px; }
    .ia-badge { font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .ia-badge--n { background: color-mix(in srgb, var(--violet) 16%, transparent); color: var(--texte-violet); }

    /* « Ce que ça lit / propose / change » : trois lignes, toujours les mêmes, pour que l'œil les retrouve. */
    .ia-lit { display: grid; grid-template-columns: 1fr; gap: 4px; margin: 0; font-size: 12.5px; line-height: 1.45; }
    .ia-lit div { display: flex; gap: 8px; }
    .ia-lit dt { flex: 0 0 118px; font-weight: 700; color: var(--fg-tertiary); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; padding-top: 2px; }
    .ia-lit dd { margin: 0; color: var(--fg-secondary); }
    .ia-lit dd strong { color: var(--fg-primary); }

    .ia-quota { display: flex; gap: 8px; align-items: flex-start; padding: 9px 11px; border-radius: 10px; background: var(--bg-tertiary); font-size: 12px; color: var(--fg-secondary); line-height: 1.45; }
    .ia-quota lucide-icon { color: var(--tracky-light); flex-shrink: 0; margin-top: 2px; }
    .ia-quota strong { color: var(--fg-primary); }
    .ia-quota--bloque { background: color-mix(in srgb, var(--warning) 10%, transparent); }
    .ia-quota-why { display: block; margin-top: 3px; font-size: 11.5px; color: var(--fg-tertiary); }

    .ia-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .ia-actions--foot { padding-top: 6px; border-top: 1px dashed var(--border-subtle); }
    .ia-btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 700; min-height: 40px;
              background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; }
    .ia-btn:hover:not(:disabled) { color: var(--fg-primary); border-color: var(--border-strong); }
    .ia-btn--primary { background: var(--tracky); color: var(--accent-ink); border-color: transparent; }
    .ia-btn--primary:hover:not(:disabled) { background: var(--tracky-dark); color: var(--accent-ink); }
    .ia-btn:disabled { opacity: .55; cursor: not-allowed; }
    .ia-link { font-size: 12px; font-weight: 600; color: var(--tracky-light); }
    .ia-link--right { margin-left: auto; }
    .ia-selbar { display: flex; align-items: center; justify-content: space-between; }
    .ia-selc { font-size: 12px; color: var(--fg-tertiary); }
    .ia-cards { display: grid; grid-template-columns: 1fr; gap: 8px; }
    @media (min-width: 640px) { .ia-cards { grid-template-columns: 1fr 1fr; } }
    @media (min-width: 1100px) { .ia-cards { grid-template-columns: 1fr 1fr 1fr; } }
    .ia-card { text-align: left; padding: 10px 11px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ia-card--on { border-color: var(--tracky-light); box-shadow: 0 0 0 1px var(--tracky-light) inset; background: color-mix(in srgb, var(--tracky-light) 7%, var(--bg-tertiary)); }
    .ia-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .ia-plate { font-weight: 800; color: var(--fg-primary); letter-spacing: .3px; font-family: var(--font-mono, monospace); }
    .ia-model { display: block; font-size: 11px; color: var(--fg-tertiary); font-weight: 400; margin-top: 1px; font-family: inherit; }
    .ia-vals { display: flex; gap: 12px; margin-top: 6px; font-size: 12px; font-weight: 700; color: var(--fg-secondary); flex-wrap: wrap; }
    .ia-reason { font-size: 11.5px; color: var(--fg-secondary); margin: 6px 0 0; line-height: 1.4; }
    .ia-chip { font-size: 11.5px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: var(--bg-secondary); color: var(--fg-tertiary); }
    .ia-chip--hi { color: var(--texte-succes); background: color-mix(in srgb, var(--tracky-light) 14%, transparent); }
    .ia-chip--mid { color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 14%, transparent); }
    .ia-chip--lo { color: var(--texte-alerte); background: color-mix(in srgb, var(--danger) 13%, transparent); }
    .ia-apply { display: flex; justify-content: flex-end; }
    .ia-done { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: var(--texte-succes); font-weight: 600; }
    .ia-muted { margin: 0; font-size: 12.5px; color: var(--fg-tertiary); line-height: 1.45; }
    .ia-alert { display: flex; align-items: center; gap: 7px; padding: 9px 11px; border-radius: 10px; font-size: 12px; }
    .ia-alert--err { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--texte-alerte); }
    .ia-alert--info { background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .ia-skel { height: 56px; border-radius: 12px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: ia-sh 1.3s infinite; }
    @keyframes ia-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .ia-spin { animation: ia-spin 1s linear infinite; }
    @keyframes ia-spin { to { transform: rotate(360deg); } }

    /* Propositions groupées par véhicule : une ligne par proposition, les actions au bout de la ligne. */
    .ia-groupes { display: flex; flex-direction: column; gap: 8px; }
    .ia-g { border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-tertiary); overflow: hidden; }
    .ia-g-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px 6px 4px; flex-wrap: wrap; }
    .ia-g-toggle { display: inline-flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 8px; color: var(--fg-secondary); min-height: 40px; }
    .ia-g-toggle:hover { background: var(--bg-secondary); }
    .ia-g-n { font-size: 11.5px; color: var(--fg-tertiary); }
    .ia-g-bulk { display: flex; gap: 6px; }
    .ia-rows { list-style: none; margin: 0; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 4px; }
    .ia-row { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 9px; background: var(--bg-secondary); font-size: 12.5px; color: var(--fg-secondary); flex-wrap: wrap; }
    .ia-row--busy { opacity: .55; }
    .ia-row-when { text-transform: capitalize; white-space: nowrap; }
    .ia-row-when strong { color: var(--fg-primary); text-transform: none; }
    .ia-row-dest { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; color: var(--texte-succes); }
    .ia-row-conf { font-size: 11px; font-weight: 800; padding: 1px 7px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-tertiary); cursor: help; }
    .ia-row-act { margin-left: auto; display: inline-flex; gap: 6px; }
    .ia-mini { display: inline-flex; align-items: center; gap: 4px; padding: 6px 9px; border-radius: 8px; font-size: 12px; font-weight: 700; min-height: 32px;
               background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; }
    .ia-mini--ok { background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--texte-succes); border-color: color-mix(in srgb, var(--tracky-light) 30%, transparent); }
    .ia-mini:disabled { opacity: .5; }

    .ia-under { display: grid; grid-template-columns: 1fr; gap: 8px; }
    @media (min-width: 640px) { .ia-under { grid-template-columns: 1fr 1fr; } }
    @media (min-width: 1100px) { .ia-under { grid-template-columns: 1fr 1fr 1fr; } }
    .ia-u { padding: 9px 11px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ia-u-top { display: flex; align-items: center; justify-content: space-between; }
    .ia-u-pct { font-size: 12px; font-weight: 800; color: var(--texte-attente); }
    .ia-free { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .ia-free-c { font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 6px; background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--texte-succes); }

    @media (max-width: 480px) {
      .ia-lit dt { flex-basis: 96px; }
      .ia-row-act { margin-left: 0; width: 100%; justify-content: flex-end; }
    }
  `],
})
export class AgendaIaViewComponent {
  private readonly ai = inject(AiApiService);
  private readonly aiStatus = inject(AiStatusService);
  private readonly aiJob = inject(AiJobService);
  private readonly agentApi = inject(AgendaAgentApiService);
  private readonly agendaApi = inject(AgendaApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetCache = inject(FleetCacheService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  /** Propositions en attente — chargées par la page (elle en porte le compteur). */
  readonly proposals = input<AgendaAgentProposalDto[]>([]);
  /** Ouvrir la feuille Réserver. */
  readonly reserver = output<void>();
  /** Ouvrir les réglages de l'agent (feuille Paramètres). */
  readonly reglages = output<void>();
  /** Basculer sur la vue Parc. */
  readonly parc = output<void>();
  /** Une proposition a été réservée / écartée : la page recharge l'agenda et le compteur. */
  readonly changed = output<void>();
  /** Des fiches véhicule ont été écrites : la page relit le parc. */
  readonly capaciteAppliquee = output<void>();

  protected readonly SparklesIcon = Sparkles;
  protected readonly CheckIcon = Check;
  protected readonly XIcon = X;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly InfoIcon = Info;
  protected readonly MapPinIcon = MapPin;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly SettingsIcon = Settings;
  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly TrendingDownIcon = TrendingDown;
  protected readonly TruckIcon = Truck;
  protected readonly ClockIcon = Clock;
  protected readonly ZapIcon = Zap;
  protected readonly metiers = METIERS;

  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly selectedFleetId = computed(() => (this.isSuperAdmin() ? this.fleetFilter.selectedFleetId() : null));
  protected readonly fleetName = computed(() => this.fleetCache.getName(this.selectedFleetId()));
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.selectedFleetId());
  protected readonly aiMaster = computed(() => this.aiStatus.can('capacity') || this.aiStatus.can('agendaAgent') || this.aiStatus.can('placement'));
  protected readonly aiCapacity = computed(() => this.aiStatus.can('capacity'));
  protected readonly aiAgent = computed(() => this.aiStatus.can('agendaAgent'));
  protected readonly aiPlacement = computed(() => this.aiStatus.can('placement'));
  protected readonly canRunCapacity = computed(() => this.perms.can('ai_optimize'));
  protected readonly canApply = computed(() => this.perms.can('vehicles_edit'));
  protected readonly canManage = computed(() => this.perms.can('reservations_manage'));
  protected readonly canReserve = computed(() => this.perms.can('reservations_request'));
  protected readonly canConfigureAgent = computed(() => {
    const r = this.auth.user()?.role;
    return r === 'SUPER_ADMIN' || r === 'FLEET_ADMIN';
  });
  protected readonly canEditMetier = computed(() => this.canConfigureAgent() && this.perms.can('ai_optimize'));

  // ─── Étape 1 ───
  protected readonly latest = signal<AiCapacityLatestDto | null>(null);
  protected readonly latestLoading = signal(false);
  protected readonly latestError = signal<string | null>(null);
  protected readonly selected = signal<Set<string>>(new Set());
  protected readonly applying = signal(false);
  protected readonly metier = signal<FleetMetier | null>(null);
  /** Propositions pas encore appliquées. */
  protected readonly restantes = computed<AiCapacityProposalDto[]>(() => {
    const a = this.latest()?.analysis;
    if (!a) return [];
    const faites = new Set(a.appliedVehicleIds);
    return a.proposals.filter((p) => !faites.has(p.vehicleId));
  });
  protected readonly appliquees = computed<AiCapacityProposalDto[]>(() => {
    const a = this.latest()?.analysis;
    if (!a) return [];
    const faites = new Set(a.appliedVehicleIds);
    return a.proposals.filter((p) => faites.has(p.vehicleId));
  });
  protected readonly appliqueesPlaques = computed(() => this.appliquees().map((p) => p.plate || '—').join(', '));
  /** L'étape est « faite » quand il y a une analyse et plus rien à appliquer. */
  protected readonly etape1Faite = computed(() => !!this.latest()?.analysis && this.restantes().length === 0);
  protected readonly allSelected = computed(() => {
    const r = this.restantes();
    return r.length > 0 && r.every((p) => this.selected().has(p.vehicleId));
  });
  protected readonly analyseEnCours = computed(() => this.aiJob.hasRunning() && this.aiJob.jobs().some((j) => j.kind === 'optimization' && j.status === 'running'));
  protected readonly peutLancer = computed(() => !this.analyseEnCours() && !this.latestLoading() && (this.latest()?.canRun ?? true) && !this.needsFleet());
  protected readonly titreLancement = computed(() => {
    const l = this.latest();
    if (l && !l.canRun) return 'Une analyse par jour et par société — voir la date de la prochaine.';
    return 'L\'IA lit le parc et propose ; rien n\'est écrit.';
  });

  // ─── Étape 2 ───
  protected readonly groupes = computed(() => grouperParVehicule(this.proposals()));
  /**
   * Véhicules DÉPLIÉS (le premier seulement à l'ouverture) : « on peut rapidement se perdre lorsque
   * plusieurs positions concernent le même véhicule » — 418 propositions sur 20 véhicules se lisent
   * comme 20 lignes, et chaque véhicule s'ouvre d'un geste. `replies()` rend l'ensemble des repliés.
   */
  private readonly deplies = signal<Set<string> | null>(null);
  protected readonly replies = computed<Set<string>>(() => {
    const groupes = this.groupes();
    const ouverts = this.deplies() ?? new Set(groupes.slice(0, 1).map((g) => g.vehicleId));
    return new Set(groupes.filter((g) => !ouverts.has(g.vehicleId)).map((g) => g.vehicleId));
  });
  protected readonly toutReplie = computed(() => this.groupes().length > 0 && this.replies().size === this.groupes().length);
  protected readonly busy = signal<Set<string>>(new Set());
  protected readonly busyGroupe = signal<string | null>(null);
  protected readonly dernierPassage = signal<AgendaAgentRunDto | null>(null);
  protected readonly agentEnabled = signal<boolean | null>(null);
  protected readonly nightlyHour = signal<number | null>(null);
  protected readonly heureNuit = computed(() => (this.nightlyHour() === null ? 'à l\'heure réglée' : `vers ${this.nightlyHour()} h`));
  protected readonly passageEnCours = computed(() => this.aiJob.jobs().some((j) => j.kind === 'agent-run' && j.status === 'running'));

  // ─── Sous-utilisés ───
  protected readonly utilLoading = signal(false);
  protected readonly util = signal<FleetOptimizationDto | null>(null);
  protected readonly underutilized = computed(() => (this.util()?.vehicles ?? []).filter((v) => v.underutilized).slice(0, 12));

  constructor() {
    this.aiStatus.ensureLoaded();
    void this.fleetCache.loadIfNeeded();
    // À l'affichage et à chaque changement de société : tout est relu.
    effect(() => {
      this.selectedFleetId();
      if (this.needsFleet()) { this.latest.set(null); this.metier.set(null); this.util.set(null); return; }
      this.selected.set(new Set());
      void this.chargerLatest();
      void this.chargerMetier();
      void this.chargerUtil();
      void this.chargerAgent();
    });
    // Quand une analyse lancée en arrière-plan se termine, la dernière analyse est relue.
    effect(() => {
      const fini = this.aiJob.jobs().find((j) => j.kind === 'optimization' && j.status !== 'running');
      if (fini) void this.chargerLatest();
    });
  }

  protected metierLabel(m: FleetMetier): string { return FLEET_METIER_LABELS[m]; }
  protected valOf(n: number | null): string { return n === null || n === undefined ? '—' : String(n); }

  private fleetParam(): string | undefined { return this.selectedFleetId() ?? undefined; }

  private async chargerLatest(): Promise<void> {
    if (!this.canRunCapacity() || !this.aiCapacity()) return;
    this.latestLoading.set(true);
    this.latestError.set(null);
    try {
      this.latest.set(await firstValueFrom(this.ai.capacityLatest(this.fleetParam())));
    } catch (e) {
      swallow('agenda-ia-view:latest', e);
      this.latestError.set(this.errMsg(e));
    } finally {
      this.latestLoading.set(false);
    }
  }

  private async chargerMetier(): Promise<void> {
    if (!this.perms.can('ai_optimize')) return;
    try {
      this.metier.set((await firstValueFrom(this.ai.getFleetMetier(this.fleetParam()))).metier);
    } catch (e) {
      swallow('agenda-ia-view:metier', e);
    }
  }

  protected async onMetierChange(m: string): Promise<void> {
    const metier = m as FleetMetier;
    const prev = this.metier();
    this.metier.set(metier);
    try {
      await firstValueFrom(this.ai.setFleetMetier({ fleetId: this.fleetParam(), metier }));
      this.toast.success('Métier mis à jour', this.metierLabel(metier));
    } catch (e) {
      swallow('agenda-ia-view:onMetierChange', e);
      this.metier.set(prev);
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  private async chargerUtil(): Promise<void> {
    if (!this.perms.can('reservations_view')) return;
    this.utilLoading.set(true);
    try {
      this.util.set(await firstValueFrom(this.agendaApi.getUtilization({ fleetId: this.fleetParam() })));
    } catch (e) {
      swallow('agenda-ia-view:util', e);
      this.util.set(null);
    } finally {
      this.utilLoading.set(false);
    }
  }

  /** Dernier passage et réglage « activé » — best-effort, réservés à qui peut régler l'agent. */
  private async chargerAgent(): Promise<void> {
    if (!this.canConfigureAgent()) return;
    try {
      const runs = await firstValueFrom(this.agentApi.listRuns(this.fleetParam(), 1));
      this.dernierPassage.set(runs[0] ?? null);
    } catch (e) {
      swallow('agenda-ia-view:runs', e);
    }
    try {
      const s = await firstValueFrom(this.agentApi.getSettings(this.fleetParam()));
      this.agentEnabled.set(s.enabled);
      this.nightlyHour.set(s.nightlyHour);
    } catch (e) {
      swallow('agenda-ia-view:settings', e);
    }
  }

  // ─── Étape 1 : analyser / appliquer ───

  /**
   * Lance l'analyse EN ARRIÈRE-PLAN (pastille en haut de l'agenda) ; à la fin, la dernière analyse
   * est relue ici. Le serveur refuse (429) une seconde analyse dans les 24 h : le bouton est
   * grisé avant, et le refus se lit dans la pastille si la course a lieu quand même.
   */
  protected lancerAnalyse(): void {
    if (!this.peutLancer()) return;
    if (this.aiJob.hasRunningOf('optimization')) return;
    const fleetId = this.fleetParam();
    this.aiJob.run({
      kind: 'optimization',
      title: 'Analyse du parc',
      hint: 'L\'IA lit la marque et le modèle de chaque véhicule pour proposer les places et les équipements manquants. Rien n\'est écrit. Ça prend quelques secondes…',
      task: firstValueFrom(this.ai.capacitySuggest({ fleetId })),
      summarize: (r) =>
        r.proposals.length
          ? `${r.proposals.length} fiche(s) véhicule à compléter — à cocher puis appliquer dans l'Assistant IA.`
          : 'Aucune capacité à compléter : le parc semble déjà renseigné.',
    });
  }

  protected toggleSel(id: string): void {
    if (!this.canApply()) return;
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selected.set(next);
  }

  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.restantes().map((p) => p.vehicleId)));
  }

  protected async appliquer(): Promise<void> {
    const items = this.restantes()
      .filter((p) => this.selected().has(p.vehicleId))
      .map((p) => ({ vehicleId: p.vehicleId, seats: p.seats, features: p.features }));
    if (items.length === 0) return;
    this.applying.set(true);
    this.latestError.set(null);
    try {
      const res = await firstValueFrom(this.ai.capacityApply({ items }));
      this.toast.success('Fiches mises à jour', `${res.updated} véhicule(s) : places et équipements écrits.`);
      this.selected.set(new Set());
      await this.chargerLatest();
      this.capaciteAppliquee.emit();
    } catch (e) {
      swallow('agenda-ia-view:appliquer', e);
      this.latestError.set(this.errMsg(e));
    } finally {
      this.applying.set(false);
    }
  }

  // ─── Étape 2 : propositions ───

  protected basculer(vehicleId: string): void {
    const ouverts = new Set(this.deplies() ?? this.groupes().slice(0, 1).map((g) => g.vehicleId));
    if (ouverts.has(vehicleId)) ouverts.delete(vehicleId); else ouverts.add(vehicleId);
    this.deplies.set(ouverts);
  }

  protected toutReplierOuDeplier(): void {
    this.deplies.set(this.toutReplie() ? new Set(this.groupes().map((g) => g.vehicleId)) : new Set());
  }

  private marquer(id: string, occupe: boolean): void {
    this.busy.update((s) => { const n = new Set(s); if (occupe) n.add(id); else n.delete(id); return n; });
  }

  protected async reserverProposition(p: AgendaAgentProposalDto): Promise<void> {
    this.marquer(p.id, true);
    try {
      await firstValueFrom(this.agentApi.applyProposal(p.id));
      this.toast.success('Réservé', `${p.vehiclePlate ?? ''} — la réservation est dans l'agenda.`);
      this.changed.emit();
    } catch (e) {
      swallow('agenda-ia-view:reserverProposition', e);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.marquer(p.id, false);
    }
  }

  protected async ecarter(p: AgendaAgentProposalDto): Promise<void> {
    this.marquer(p.id, true);
    try {
      await firstValueFrom(this.agentApi.dismissProposal(p.id));
      this.changed.emit();
    } catch (e) {
      swallow('agenda-ia-view:ecarter', e);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.marquer(p.id, false);
    }
  }

  /** Tout réserver pour un véhicule : une par une (un refus n'arrête pas les autres), un bilan à la fin. */
  protected async toutReserver(g: GroupeProposals): Promise<void> {
    await this.enLot(g, 'reserver');
  }

  protected async toutEcarter(g: GroupeProposals): Promise<void> {
    await this.enLot(g, 'ecarter');
  }

  private async enLot(g: GroupeProposals, geste: 'reserver' | 'ecarter'): Promise<void> {
    if (this.busyGroupe()) return;
    this.busyGroupe.set(g.vehicleId);
    let faits = 0;
    const refus: string[] = [];
    try {
      for (const p of g.items) {
        try {
          await firstValueFrom(geste === 'reserver' ? this.agentApi.applyProposal(p.id) : this.agentApi.dismissProposal(p.id));
          faits++;
        } catch (e) {
          swallow('agenda-ia-view:enLot', e);
          refus.push(`${new Date(p.startAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} : ${this.errMsg(e)}`);
        }
      }
      const verbe = geste === 'reserver' ? 'réservée(s)' : 'écartée(s)';
      if (refus.length === 0) this.toast.success(`${g.plate} : ${faits} proposition(s) ${verbe}`, '');
      else this.toast.error(`${g.plate} : ${faits} ${verbe}, ${refus.length} refusée(s)`, refus.slice(0, 3).join(' · '));
      if (faits > 0 || refus.length > 0) this.changed.emit();
    } finally {
      this.busyGroupe.set(null);
    }
  }

  /** Lance un passage de l'agent en arrière-plan (même pastille que depuis les réglages). */
  protected lancerPassage(): void {
    if (this.passageEnCours() || this.agentEnabled() === false) return;
    if (this.aiJob.hasRunningOf('agent-run')) return;
    this.aiJob.run({
      kind: 'agent-run',
      title: 'Passage de l\'agent',
      hint: 'L\'agent parcourt les trajets récurrents et l\'agenda pour préparer les propositions. Ça prend quelques secondes…',
      task: firstValueFrom(this.agentApi.run(this.fleetParam())).then((r) => { this.changed.emit(); return r; }),
      summarize: (r: AgendaAgentRunResultDto) =>
        r.alreadyRunning
          ? 'Une analyse était déjà en cours pour cette société : rien de nouveau n\'a été lancé.'
          : r.proposed
            ? `${r.proposed} proposition(s) préparée(s) — à valider dans l'Assistant IA.`
            : 'Aucune habitude assez nette pour proposer une réservation.',
    });
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse && e.status === 503) {
      return apiErrorMessage(e, 'Copilote IA non configuré côté serveur (ANTHROPIC_API_KEY).');
    }
    return apiErrorMessage(e, e instanceof HttpErrorResponse ? `Erreur (${e.status}).` : 'Une erreur est survenue.');
  }
}
