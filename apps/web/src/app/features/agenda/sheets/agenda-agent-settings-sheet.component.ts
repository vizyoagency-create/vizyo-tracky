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
import { apiErrorMessage } from '../../../core/error/api-error';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Settings, X, Loader, Zap, ExternalLink, Link2, Copy, Plus, Power, History } from 'lucide-angular';
import {
  FLEET_METIER_LABELS,
  type AgendaAgentAutonomy,
  type AgendaAgentFrequency,
  type AgendaAgentRunDto,
  type FleetMetier,
  type ReservationBookingLinkDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaAgentApiService } from '../../../core/services/agenda-agent.service';
import { ReservationBookingApiService } from '../../../core/services/reservation-booking.service';
import { AiApiService } from '../../../core/services/ai.service';
import { AiStatusService } from '../../../core/services/ai-status.service';
import { BillingApiService } from '../../../core/services/billing.service';
import { AiUsageApiService } from '../../../core/services/ai-usage.service';
import { AiJobService } from '../../../core/services/ai-job.service';
import { AuthService } from '../../../core/services/auth.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../../shared/ui/bottom-sheet/bottom-sheet.component';

/**
 * Refonte agenda/IA (2026-07) — ⚙️ « Paramètres de l'agenda » (PAR FLOTTE).
 * Pilote l'agent d'optimisation : activation, analyse nocturne (heure/fréquence), autonomie
 * (suggestions vs auto si confiance haute), auto-complétion, déclencheurs, métier, + coût IA du mois.
 * Source de vérité de la société = le sélecteur global (FleetFilterService).
 */
@Component({
  selector: 'app-agenda-agent-settings-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, DatePipe, RouterLink, LucideAngularModule, BottomSheetComponent],
  template: `
    <app-bottom-sheet [open]="open()" ariaLabel="Paramètres de l'agenda" (closed)="closed.emit()">
      <div class="aas">
        <div class="aas-head">
          <h3 class="aas-title"><lucide-icon [img]="SettingsIcon" [size]="15"></lucide-icon> Paramètres de l'agenda</h3>
          <button type="button" class="aas-x" (click)="closed.emit()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>

        @if (needsFleet()) {
          <div class="aas-note">Choisis une société dans le sélecteur en haut de page pour régler son agent.</div>
        } @else if (loading()) {
          <div class="aas-skel"></div><div class="aas-skel"></div><div class="aas-skel"></div>
        } @else {
          <div class="aas-body">
            @if (error()) { <div class="aas-alert">{{ error() }}</div> }

            <!-- Interrupteur MAÎTRE de l'IA (globale). Option PAYANTE : super-admin peut l'OFFRIR
                 (toggle → COMP) ; un fleet-admin l'active via son onglet Facturation (abonnement). -->
            <label class="aas-row aas-row--switch aas-row--master">
              <div>
                <span class="aas-lbl"><lucide-icon [img]="ZapIcon" [size]="13"></lucide-icon> Assistance IA</span>
                <span class="aas-sub"><strong>Toute l'IA</strong> de cette société (récit de trajet, agent d'agenda, optimiseur, saisie vocale). Option payante (abonnement mensuel) ; l'app fonctionne parfaitement sans IA (analyse des trajets, stations, scores restent inclus).</span>
              </div>
              @if (isSuperAdmin()) {
                <input type="checkbox" class="aas-sw" [checked]="aiMasterEnabled()" [disabled]="savingAi()" (change)="onToggleAi($any($event.target).checked)">
              } @else {
                <a routerLink="/settings" (click)="closed.emit()" class="aas-manage">{{ aiMasterEnabled() ? 'Gérer' : 'Activer' }}</a>
              }
            </label>
            @if (!aiMasterEnabled()) {
              <!-- Vrai, et rien de plus : la détection des habitudes est DÉTERMINISTE (elle ne passe
                   pas par l'IA). L'ancienne note prétendait les réglages « sans effet », alors qu'un
                   agent déjà activé continue ses passages planifiés sans avis de l'IA. -->
              <div class="aas-note">L'IA est désactivée pour cette société : l'agent ne peut pas être activé d'ici. S'il l'était déjà, ses passages planifiés continuent sans avis de l'IA — détection déterministe des habitudes, propositions et réservations selon l'autonomie réglée.</div>
            }

            <!-- Activation de l'agent d'agenda (sous-ensemble de l'IA). -->
            <label class="aas-row aas-row--switch">
              <div><span class="aas-lbl">Activer l'agent IA</span><span class="aas-sub">L'agent analyse et optimise l'agenda de {{ fleetName() || 'cette société' }}.</span></div>
              <input type="checkbox" class="aas-sw" [checked]="enabled()" [disabled]="!aiMasterEnabled()" (change)="enabled.set($any($event.target).checked)">
            </label>

            <!-- Métier -->
            <div class="aas-row">
              <div><span class="aas-lbl">Métier de la flotte</span><span class="aas-sub">Oriente l'objectif de l'IA (ex. sécurité enfants).</span></div>
              <select class="aas-in" [value]="metier()" (change)="onMetierChange($any($event.target).value)">
                @for (m of metiers; track m) { <option [value]="m">{{ metierLabel(m) }}</option> }
              </select>
            </div>

            <!-- Analyse nocturne -->
            <div class="aas-grid">
              <label class="aas-row aas-row--col"><span class="aas-lbl">Heure d'analyse nocturne</span>
                <input type="number" min="0" max="23" class="aas-in" [value]="nightlyHour()" (input)="nightlyHour.set(clampHour($any($event.target).value))"></label>
              <label class="aas-row aas-row--col"><span class="aas-lbl">Fréquence</span>
                <select class="aas-in" [value]="frequency()" (change)="frequency.set($any($event.target).value)">
                  <option value="daily">Quotidienne</option><option value="weekly">Hebdomadaire</option>
                </select></label>
            </div>

            <!-- Autonomie -->
            <div class="aas-row aas-row--col">
              <span class="aas-lbl">Niveau d'autonomie</span>
              <div class="aas-seg">
                <button type="button" class="aas-seg-btn" [class.aas-seg-btn--on]="autonomy() === 'suggest'" (click)="autonomy.set('suggest')">Suggestions seules</button>
                <button type="button" class="aas-seg-btn" [class.aas-seg-btn--on]="autonomy() === 'auto_high_confidence'" (click)="autonomy.set('auto_high_confidence')">Auto si confiance haute</button>
              </div>
              @if (autonomy() === 'auto_high_confidence') {
                <div class="aas-slider">
                  <span class="aas-sub">Réserve fermement au-dessus de <strong>{{ confidenceThreshold() }} %</strong> de confiance ; le reste reste en suggestions.</span>
                  <input type="range" min="50" max="100" step="5" [value]="confidenceThreshold()" (input)="confidenceThreshold.set(+$any($event.target).value)">
                </div>
              } @else {
                <span class="aas-sub">L'IA propose, rien n'entre dans l'agenda sans ta validation.</span>
              }
            </div>

            <!-- Auto-complétion -->
            <label class="aas-row aas-row--switch">
              <div><span class="aas-lbl">Auto-complétion après une réservation</span><span class="aas-sub">Quand quelqu'un réserve, l'IA optimise autour (mutualisation, coût).</span></div>
              <input type="checkbox" class="aas-sw" [checked]="autoComplete()" (change)="autoComplete.set($any($event.target).checked)">
            </label>

            <!-- Déclencheurs -->
            <div class="aas-row aas-row--col">
              <span class="aas-lbl">Déclencheurs de (re)analyse</span>
              <div class="aas-checks">
                <label class="aas-chk"><input type="checkbox" [checked]="trigNightly()" (change)="trigNightly.set($any($event.target).checked)"> Analyse nocturne</label>
                <label class="aas-chk"><input type="checkbox" [checked]="trigIncident()" (change)="trigIncident.set($any($event.target).checked)"> À un incident</label>
                <label class="aas-chk"><input type="checkbox" [checked]="trigMaintenance()" (change)="trigMaintenance.set($any($event.target).checked)"> À une maintenance</label>
                <label class="aas-chk"><input type="checkbox" [checked]="trigReservation()" (change)="trigReservation.set($any($event.target).checked)"> À une réservation</label>
              </div>
            </div>

            <!-- Coûts IA -->
            <div class="aas-cost">
              <div class="aas-cost-top">
                <span class="aas-lbl"><lucide-icon [img]="ZapIcon" [size]="13"></lucide-icon> Coûts IA · ce mois</span>
                <span class="aas-cost-amount">≈ {{ monthCostEur() | number:'1.2-2' }} €</span>
              </div>
              @if (byAction().length > 0) {
                <ul class="aas-cost-list">
                  @for (r of byAction(); track r.key) { <li><span>{{ r.label }}</span><span>{{ r.costEur | number:'1.2-2' }} €</span></li> }
                </ul>
              }
              <a routerLink="/admin/ai-usage" class="aas-cost-link" (click)="closed.emit()">Ouvrir le centre Coûts IA <lucide-icon [img]="ExternalLinkIcon" [size]="12"></lucide-icon></a>
            </div>

            <!-- Liens publics de réservation (P4) -->
            <div class="aas-links">
              <div class="aas-links-head">
                <span class="aas-lbl"><lucide-icon [img]="LinkIcon" [size]="13"></lucide-icon> Liens publics de réservation</span>
                <button type="button" class="aas-mini aas-mini--accent" [disabled]="creatingLink()" (click)="createLink()">
                  @if (creatingLink()) { <lucide-icon [img]="LoaderIcon" [size]="12" class="aas-spin"></lucide-icon> } @else { <lucide-icon [img]="PlusIcon" [size]="12"></lucide-icon> } Créer
                </button>
              </div>
              <span class="aas-sub">Un tiers décrit son besoin sur une page publique, l'app propose des véhicules ; la demande arrive dans « Demandes ».</span>
              @for (l of links(); track l.id) {
                <div class="aas-link" [class.aas-link--off]="!l.active">
                  <div class="aas-link-main">
                    <span class="aas-link-url">{{ l.publicUrl }}</span>
                    <span class="aas-link-meta">{{ l.active ? 'Actif' : 'Inactif' }} · ouvert {{ l.openCount }}×</span>
                  </div>
                  <button type="button" class="aas-mini" (click)="copyUrl(l.publicUrl)" title="Copier"><lucide-icon [img]="CopyIcon" [size]="13"></lucide-icon></button>
                  <button type="button" class="aas-mini" (click)="toggleLink(l)" [title]="l.active ? 'Désactiver' : 'Activer'"><lucide-icon [img]="PowerIcon" [size]="13"></lucide-icon></button>
                </div>
              }
            </div>
          </div>

          <!--
            Derniers passages de l'agent. C'est ici qu'on règle l'agent, c'est donc ici qu'on doit
            voir ce qu'il a RÉELLEMENT fait — sinon « rien ne se passe » reste sans explication.
          -->
          <div class="aas-runs">
            <div class="aas-links-head">
              <span class="aas-lbl"><lucide-icon [img]="HistoryIcon" [size]="13"></lucide-icon> Derniers passages</span>
              @if (runs().length > 0) {
                <button type="button" class="aas-mini" (click)="loadRuns()" [disabled]="runsLoading()" title="Rafraîchir">
                  <lucide-icon [img]="LoaderIcon" [size]="12" [class.aas-spin]="runsLoading()"></lucide-icon>
                </button>
              }
            </div>

            @if (runsLoading() && runs().length === 0) {
              <div class="aas-skel"></div>
            } @else if (runs().length === 0) {
              <span class="aas-sub">Aucun passage enregistré pour l'instant. L'agent archive chaque analyse dès qu'il tourne.</span>
            } @else {
              @for (r of runs(); track r.id) {
                <div class="aas-run" [class.aas-run--err]="r.status === 'error'">
                  <div class="aas-run-main">
                    <span class="aas-run-when">
                      {{ r.startedAt | date: 'dd/MM HH:mm' }}
                      <span class="aas-run-origin">{{ r.origin === 'manual' ? 'manuel' : 'auto' }}</span>
                      @if (r.aiUsed) { <span class="aas-run-ai">IA</span> }
                    </span>
                    @if (r.status === 'error') {
                      <span class="aas-run-detail aas-run-detail--err">Échec : {{ r.error }}</span>
                    } @else if (r.patterns === 0) {
                      <!-- Le cas le plus fréquent d'un « il n'a rien fait » : aucune habitude détectée. -->
                      <span class="aas-run-detail">Aucune habitude récurrente détectée — rien à proposer.</span>
                    } @else {
                      <span class="aas-run-detail">
                        {{ r.patterns }} habitude{{ r.patterns > 1 ? 's' : '' }} ·
                        {{ r.created }} réservée{{ r.created > 1 ? 's' : '' }} ·
                        {{ r.proposed }} proposée{{ r.proposed > 1 ? 's' : '' }} ·
                        {{ r.skipped }} ignorée{{ r.skipped > 1 ? 's' : '' }}
                      </span>
                    }
                  </div>
                  <span class="aas-run-dur">{{ runDuration(r.durationMs) }}</span>
                </div>
              }
            }
          </div>

          <div class="aas-foot">
            <!-- Grisé sur la valeur ENREGISTRÉE de l'interrupteur, pas sur la case cochée : le
                 serveur juge le réglage en base (409 sinon), et un clic entre « cocher » et
                 « enregistrer » serait refusé. Le motif est écrit sous les boutons. -->
            <button type="button" class="aas-btn aas-btn--ghost" [disabled]="running() || saving() || !lancementPossible()" (click)="runNow()" [title]="motifLancement() ?? 'Analyser maintenant (sans attendre la nuit)'">
              @if (running()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="aas-spin"></lucide-icon> } @else { <lucide-icon [img]="ZapIcon" [size]="15"></lucide-icon> }
              Lancer l'analyse
            </button>
            <button type="button" class="aas-btn" [disabled]="saving()" (click)="save()">
              @if (saving()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="aas-spin"></lucide-icon> }
              {{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
            </button>
            @if (motifLancement(); as motif) {
              <span class="aas-foot-note">{{ motif }}</span>
            }
          </div>
        }
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    .aas { display: flex; flex-direction: column; padding: 2px 2px 0; }
    .aas-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); }
    .aas-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .aas-x { width: 34px; height: 34px; border-radius: 9px; color: var(--fg-tertiary); display: inline-flex; align-items: center; justify-content: center; }
    .aas-x:hover { color: var(--fg-primary); background: var(--bg-tertiary); }
    .aas-note, .aas-alert { margin: 12px 2px; padding: 12px; border-radius: 12px; background: rgba(56,189,248,.10); color: #38BDF8; font-size: 12.5px; }
    .aas-alert { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--texte-alerte); }
    .aas-skel { height: 46px; border-radius: 12px; margin: 8px 2px; background: linear-gradient(90deg, var(--bg-tertiary), var(--bg-secondary), var(--bg-tertiary)); }
    .aas-body { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; max-height: 62dvh; padding: 10px 2px 2px; }
    .aas-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .aas-row--col { flex-direction: column; align-items: stretch; gap: 6px; }
    .aas-row--switch { padding: 4px 0; }
    .aas-row--master { padding: 12px 14px; border-radius: 12px; background: color-mix(in srgb, var(--tracky-light, #10E0A0) 7%, var(--bg-tertiary)); border: 1px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 20%, transparent); align-items: flex-start; }
    .aas-row--master .aas-lbl lucide-icon { color: var(--tracky-light, #10E0A0); }
    .aas-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .aas-lbl { font-size: 13px; font-weight: 600; color: var(--fg-primary); display: inline-flex; align-items: center; gap: 6px; }
    .aas-sub { display: block; font-size: 11.5px; color: var(--fg-tertiary); margin-top: 2px; line-height: 1.4; }
    .aas-in { padding: 9px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-strong); color: var(--fg-primary); font-size: 16px; min-width: 130px; }
    .aas-manage { flex: 0 0 auto; padding: 7px 12px; border-radius: 9px; background: var(--tracky, #10B981); color: #fff; font-size: 12.5px; font-weight: 700; text-decoration: none; white-space: nowrap; }
    .aas-sw { width: 42px; height: 24px; appearance: none; border-radius: 999px; background: var(--bg-tertiary); border: 1px solid var(--border-strong); position: relative; cursor: pointer; flex: 0 0 auto; transition: background .15s; }
    .aas-sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .aas-sw:checked { background: var(--tracky, #10B981); border-color: var(--tracky, #10B981); }
    .aas-sw:checked::after { transform: translateX(18px); }
    .aas-seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aas-seg-btn { flex: 1; padding: 8px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); }
    .aas-seg-btn--on { background: var(--bg-primary); color: var(--tracky-light); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .aas-slider { display: flex; flex-direction: column; gap: 6px; }
    .aas-slider input { width: 100%; }
    .aas-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .aas-chk { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--fg-secondary); }
    .aas-cost { border: 1px solid var(--border-subtle); border-radius: 12px; padding: 12px; background: var(--bg-tertiary); display: flex; flex-direction: column; gap: 8px; }
    .aas-cost-top { display: flex; align-items: center; justify-content: space-between; }
    .aas-cost-amount { font-size: 18px; font-weight: 800; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .aas-cost-list { display: flex; flex-direction: column; gap: 4px; }
    .aas-cost-list li { display: flex; justify-content: space-between; font-size: 12px; color: var(--fg-tertiary); }
    .aas-cost-link { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--tracky-light); }
    .aas-links { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border-subtle); padding-top: 12px; }
    .aas-links-head { display: flex; align-items: center; justify-content: space-between; }
    .aas-mini { display: inline-flex; align-items: center; gap: 4px; padding: 6px 8px; border-radius: 8px; font-size: 11.5px; font-weight: 700; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); flex: 0 0 auto; }
    .aas-mini--accent { background: rgba(16,224,160,.12); color: var(--tracky-light); border-color: rgba(16,224,160,.25); }
    .aas-link { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aas-link--off { opacity: .55; }
    .aas-link-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .aas-link-url { font-size: 11.5px; color: var(--fg-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .aas-link-meta { font-size: 10.5px; color: var(--fg-tertiary); }
    /* Derniers passages de l'agent */
    .aas-runs { display: flex; flex-direction: column; gap: 7px; border-top: 1px solid var(--border-subtle); padding-top: 12px; margin-top: 12px; }
    .aas-run { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .aas-run--err { border-color: color-mix(in srgb, var(--danger) 35%, var(--border-subtle)); }
    .aas-run-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .aas-run-when { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-mono, monospace); }
    .aas-run-origin { padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; background: color-mix(in srgb, var(--fg-tertiary) 16%, transparent); color: var(--fg-tertiary); font-family: var(--font-sans, sans-serif); }
    .aas-run-ai { padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 800; background: color-mix(in srgb, var(--violet) 10%, transparent); color: var(--texte-violet); font-family: var(--font-sans, sans-serif); }
    .aas-run-detail { font-size: 11px; color: var(--fg-tertiary); line-height: 1.4; }
    .aas-run-detail--err { color: var(--danger); }
    .aas-run-dur { flex: 0 0 auto; font-size: 10.5px; color: var(--fg-tertiary); font-family: var(--font-mono, monospace); }
    .aas-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 12px 0 max(6px, env(safe-area-inset-bottom)); margin-top: 2px; border-top: 1px solid var(--border-subtle); }
    /* Le motif d'un bouton grisé, sous les boutons, sur toute la largeur. */
    .aas-foot-note { flex-basis: 100%; font-size: 11.5px; line-height: 1.4; color: var(--fg-tertiary); text-align: right; }
    .aas-btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 18px; border-radius: 10px; font-size: 13px; font-weight: 700; background: var(--tracky, #10B981); color: #fff; }
    .aas-btn--ghost { background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .aas-btn:disabled { opacity: .55; }
    .aas-spin { animation: aas-spin 1s linear infinite; }
    @keyframes aas-spin { to { transform: rotate(360deg); } }
    @media (max-width: 480px) { .aas-grid, .aas-checks { grid-template-columns: 1fr; } }
  `],
})
export class AgendaAgentSettingsSheetComponent {
  private readonly agentApi = inject(AgendaAgentApiService);
  private readonly bookingApi = inject(ReservationBookingApiService);
  private readonly ai = inject(AiApiService);
  private readonly aiStatus = inject(AiStatusService);
  private readonly billing = inject(BillingApiService);
  private readonly usage = inject(AiUsageApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly toast = inject(ToastService);
  private readonly aiJob = inject(AiJobService);

  readonly open = input(false);
  readonly closed = output<void>();
  readonly saved = output<void>();

  protected readonly SettingsIcon = Settings;
  protected readonly XIcon = X;
  protected readonly LoaderIcon = Loader;
  protected readonly ZapIcon = Zap;
  protected readonly ExternalLinkIcon = ExternalLink;
  protected readonly LinkIcon = Link2;
  protected readonly CopyIcon = Copy;
  protected readonly PlusIcon = Plus;
  protected readonly PowerIcon = Power;
  protected readonly HistoryIcon = History;
  protected readonly metiers = Object.keys(FLEET_METIER_LABELS) as FleetMetier[];

  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly running = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly fleetName = signal<string | null>(null);

  // Interrupteur MAÎTRE de l'IA (globale) pour la flotte — distinct de l'agent d'agenda.
  protected readonly aiMasterEnabled = signal(true);
  protected readonly savingAi = signal(false);

  // Champs éditables
  protected readonly enabled = signal(false);
  /**
   * Valeur ENREGISTRÉE de l'interrupteur de l'agent (chargée par `load()`, mise à jour après
   * `save()`), distincte de la case `enabled()` en cours d'édition. C'est elle que le serveur
   * juge : « Lancer l'analyse » répond 409 quand l'agent est désactivé en base (design/C3
   * point 2). Griser sur la case cochée aurait laissé cliquer entre « cocher » et
   * « enregistrer », pour un refus.
   */
  protected readonly enregistre = signal(false);
  protected readonly nightlyHour = signal(2);
  protected readonly frequency = signal<AgendaAgentFrequency>('daily');
  protected readonly autonomy = signal<AgendaAgentAutonomy>('suggest');
  protected readonly confidenceThreshold = signal(80);
  protected readonly autoComplete = signal(false);
  protected readonly trigNightly = signal(true);
  protected readonly trigIncident = signal(true);
  protected readonly trigMaintenance = signal(true);
  protected readonly trigReservation = signal(false);
  protected readonly metier = signal<FleetMetier>('GENERIC');

  // Coûts
  protected readonly monthCostEur = signal(0);
  protected readonly byAction = signal<{ key: string; label: string; costEur: number }[]>([]);

  // Liens publics de réservation (P4)
  protected readonly links = signal<ReservationBookingLinkDto[]>([]);
  protected readonly creatingLink = signal(false);

  /**
   * Historique des passages de l'agent. Répond à la question qu'on se pose devant un agenda qui
   * n'a pas bougé : « a-t-il seulement tourné, et qu'a-t-il vu ? ». Chargé en best-effort — son
   * indisponibilité ne doit pas empêcher de régler l'agent.
   */
  protected readonly runs = signal<AgendaAgentRunDto[]>([]);
  protected readonly runsLoading = signal(false);

  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.fleetFilter.selectedFleetId());

  /**
   * « Lancer l'analyse » n'est proposé que si l'agent est activé EN BASE — c'est exactement ce que
   * le serveur refuse (409). L'IA maître coupée ne grise PAS le bouton : le serveur accepte ce
   * lancement et produit un passage déterministe (détection, propositions, réservations selon
   * l'autonomie) sans avis de l'IA — comportement voulu, décrit dans design/C3. Griser ici ce que
   * le serveur accepte aurait caché une fonction qui marche.
   */
  protected readonly lancementPossible = computed(() => this.enregistre() && !this.error());
  /** Le motif du bouton grisé — écrit sous le bouton, jamais deviné. `null` quand le lancement est possible. */
  protected readonly motifLancement = computed<string | null>(() => {
    if (this.error()) return 'Réglage indisponible : impossible de savoir si l\'agent est activé.';
    if (!this.enregistre()) return 'L\'agent est désactivé : activez-le et enregistrez pour lancer une analyse.';
    return null;
  });

  constructor() {
    effect(() => {
      if (!this.open() || this.needsFleet()) return;
      void this.load();
    });
  }

  /** Charge l'historique. Best-effort : jamais bloquant pour le reste de la feuille. */
  protected async loadRuns(): Promise<void> {
    if (this.needsFleet()) return;
    this.runsLoading.set(true);
    try {
      this.runs.set(await firstValueFrom(this.agentApi.listRuns(this.currentFleetId(), 10)));
    } catch (err) {
      // l'historique est un confort : son échec ne doit pas masquer les réglages
      swallow('agenda-agent-settings-sheet:loadRuns', err);
    } finally {
      this.runsLoading.set(false);
    }
  }

  /** Durée lisible d'un passage (les passages sont courts : secondes, sinon minutes). */
  protected runDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min`;
  }

  protected metierLabel(m: FleetMetier): string { return FLEET_METIER_LABELS[m]; }
  protected clampHour(v: string): number {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(23, n)) : 0;
  }

  private currentFleetId(): string | undefined {
    return this.fleetFilter.selectedFleetId() ?? undefined;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.enregistre.set(false); // inconnu tant que le réglage n'est pas relu : pas de bouton, pas de faux motif
    const fleetId = this.currentFleetId();
    try {
      const s = await firstValueFrom(this.agentApi.getSettings(fleetId));
      this.fleetName.set(s.fleetName);
      this.enabled.set(s.enabled);
      this.enregistre.set(s.enabled);
      this.nightlyHour.set(s.nightlyHour);
      this.frequency.set(s.frequency);
      this.autonomy.set(s.autonomy);
      this.confidenceThreshold.set(s.confidenceThreshold);
      this.autoComplete.set(s.autoCompleteAfterReservation);
      this.trigNightly.set(s.triggerNightly);
      this.trigIncident.set(s.triggerIncident);
      this.trigMaintenance.set(s.triggerMaintenance);
      this.trigReservation.set(s.triggerReservation);
      this.metier.set(s.metier);
      this.monthCostEur.set(s.monthCostEur);
    } catch (e) {
      swallow('agenda-agent-settings-sheet:load', e);
      this.error.set(this.errMsg(e));
    } finally {
      this.loading.set(false);
    }
    void this.loadRuns();
    // Interrupteur maître IA de la flotte (best-effort : ne bloque pas les autres réglages).
    try {
      const ai = await firstValueFrom(this.aiStatus.getFleetEnabled(fleetId));
      this.aiMasterEnabled.set(ai.enabled);
    } catch (err) {
      // garde l'optimiste
      swallow('agenda-agent-settings-sheet:load', err);
    }
    // Répartition des coûts (best-effort : ne bloque pas les réglages).
    try {
      const sum = await firstValueFrom(this.usage.summary(undefined, undefined, fleetId));
      this.byAction.set(sum.byAction.slice(0, 4).map((r) => ({ key: r.key, label: r.label, costEur: r.costEur })));
    } catch (err) {
      // le coût du mois (settings) suffit
      swallow('agenda-agent-settings-sheet:load', err);
    }
    // Liens publics de réservation (best-effort).
    try {
      this.links.set(await firstValueFrom(this.bookingApi.listLinks(fleetId)));
    } catch (err) {
      swallow('agenda-agent-settings-sheet:load', err);
      this.links.set([]);
    }
  }

  /** Crée un lien public pour la société active + copie l'URL. */
  protected async createLink(): Promise<void> {
    this.creatingLink.set(true);
    try {
      const link = await firstValueFrom(this.bookingApi.createLink({ fleetId: this.currentFleetId() }));
      this.links.update((l) => [link, ...l]);
      await this.copyUrl(link.publicUrl);
      this.toast.success('Lien créé', 'URL copiée dans le presse-papier.');
    } catch (e) {
      swallow('agenda-agent-settings-sheet:createLink', e);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.creatingLink.set(false);
    }
  }

  protected async copyUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.toast.success('Lien copié');
    } catch {
      /* presse-papier indisponible (contexte non sécurisé) */
    }
  }

  protected async toggleLink(link: ReservationBookingLinkDto): Promise<void> {
    try {
      const updated = await firstValueFrom(this.bookingApi.setActive(link.id, !link.active));
      this.links.update((l) => l.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      swallow('agenda-agent-settings-sheet:toggleLink', e);
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  protected async onMetierChange(m: string): Promise<void> {
    const metier = m as FleetMetier;
    const prev = this.metier();
    this.metier.set(metier);
    try {
      await firstValueFrom(this.ai.setFleetMetier({ fleetId: this.currentFleetId(), metier }));
      this.toast.success('Métier mis à jour', this.metierLabel(metier));
    } catch (e) {
      swallow('agenda-agent-settings-sheet:onMetierChange', e);
      this.metier.set(prev);
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  /**
   * Interrupteur MAÎTRE (SUPER-ADMIN uniquement) : OFFRE (COMP) ou coupe TOUTE l'IA d'une société,
   * GRATUITEMENT, via /api/billing/comp. Un fleet-admin, lui, active l'IA en s'abonnant (onglet
   * Facturation) — d'où le lien « Gérer » à sa place dans le template.
   */
  protected async onToggleAi(next: boolean): Promise<void> {
    const fleetId = this.currentFleetId();
    if (!fleetId) { this.toast.error('Société', 'Choisissez une société.'); return; }
    const prev = this.aiMasterEnabled();
    this.aiMasterEnabled.set(next);
    this.savingAi.set(true);
    try {
      await firstValueFrom(this.billing.comp(fleetId, next)); // offert (COMP) + synchro aiEnabled
      this.aiStatus.refresh(); // met à jour le masquage des boutons IA dans toute l'app
      this.toast.success(next ? 'IA offerte' : 'IA coupée', next ? 'L\'assistance IA est offerte à cette société.' : 'Toute l\'IA est coupée pour cette société.');
    } catch (e) {
      swallow('agenda-agent-settings-sheet:toggleAiMaster', e);
      this.aiMasterEnabled.set(prev);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.savingAi.set(false);
    }
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.agentApi.setSettings({
        fleetId: this.currentFleetId(),
        enabled: this.enabled(),
        nightlyHour: this.nightlyHour(),
        frequency: this.frequency(),
        autonomy: this.autonomy(),
        confidenceThreshold: this.confidenceThreshold(),
        autoCompleteAfterReservation: this.autoComplete(),
        triggerNightly: this.trigNightly(),
        triggerIncident: this.trigIncident(),
        triggerMaintenance: this.trigMaintenance(),
        triggerReservation: this.trigReservation(),
      }));
      this.enregistre.set(this.enabled()); // la valeur en base est désormais celle de la case
      this.toast.success('Paramètres enregistrés', 'L\'agent utilisera ces réglages.');
      this.saved.emit();
      this.closed.emit();
    } catch (e) {
      swallow('agenda-agent-settings-sheet:save', e);
      this.error.set(this.errMsg(e));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Lance l'analyse de l'agent EN ARRIÈRE-PLAN (sans attendre la nuit) : on ferme la modal
   * immédiatement et une PASTILLE en haut de l'agenda montre « l'IA travaille… » puis les
   * résultats (cliquables pour ouvrir les propositions). Fini l'attente bloquée sans retour.
   */
  protected runNow(): void {
    // Le bouton est grisé dans ce cas ; la garde évite un clic clavier ou un état intermédiaire.
    // Le serveur refuserait de toute façon (409, design/C3 point 2).
    if (!this.lancementPossible()) return;
    // Anti-double-lancement : la feuille reste montée ~220 ms après fermeture (animation de sortie).
    // Sans cette garde, un double-tap créerait 2 analyses → coût IA doublé ET double placement auto possible.
    if (this.aiJob.hasRunningOf('agent-run')) { this.closed.emit(); return; }
    this.aiJob.run({
      kind: 'agent-run',
      title: 'Analyse de l\'agenda',
      hint: 'L\'IA parcourt les trajets récurrents et l\'agenda pour proposer (ou placer automatiquement) les réservations utiles. Ça prend quelques secondes…',
      task: firstValueFrom(this.agentApi.run(this.currentFleetId())),
      summarize: (r) =>
        // Verrou serveur (passage nocturne ou événementiel en cours) : rien n'a été lancé — ne pas
        // le résumer en « rien à proposer », qui ferait passer un agent occupé pour un agent vide.
        r.alreadyRunning
          ? 'Une analyse était déjà en cours pour cette société : rien de nouveau n\'a été lancé.'
          : r.created || r.proposed
            ? `${r.created} réservation(s) placée(s) automatiquement · ${r.proposed} proposition(s) à valider.`
            : 'Aucune optimisation à proposer pour l\'instant : aucun trajet récurrent assez net sur la période analysée.',
    });
    this.closed.emit(); // suivi désormais dans la pastille : plus de blocage de la modal.
  }

  private errMsg(e: unknown): string {
    return apiErrorMessage(e, 'Erreur serveur.');
  }
}
