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
import { DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Settings, X, Loader, Zap, ExternalLink } from 'lucide-angular';
import {
  FLEET_METIER_LABELS,
  type AgendaAgentAutonomy,
  type AgendaAgentFrequency,
  type FleetMetier,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaAgentApiService } from '../../../core/services/agenda-agent.service';
import { AiApiService } from '../../../core/services/ai.service';
import { AiUsageApiService } from '../../../core/services/ai-usage.service';
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
  imports: [DecimalPipe, RouterLink, LucideAngularModule, BottomSheetComponent],
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

            <!-- Activation -->
            <label class="aas-row aas-row--switch">
              <div><span class="aas-lbl">Activer l'agent IA</span><span class="aas-sub">L'agent analyse et optimise l'agenda de {{ fleetName() || 'cette société' }}.</span></div>
              <input type="checkbox" class="aas-sw" [checked]="enabled()" (change)="enabled.set($any($event.target).checked)">
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
          </div>

          <div class="aas-foot">
            <button type="button" class="aas-btn aas-btn--ghost" [disabled]="running() || saving()" (click)="runNow()" title="Analyser maintenant (sans attendre la nuit)">
              @if (running()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="aas-spin"></lucide-icon> } @else { <lucide-icon [img]="ZapIcon" [size]="15"></lucide-icon> }
              Lancer l'analyse
            </button>
            <button type="button" class="aas-btn" [disabled]="saving()" (click)="save()">
              @if (saving()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="aas-spin"></lucide-icon> }
              {{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
            </button>
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
    .aas-alert { background: rgba(239,68,68,.10); color: #f87171; }
    .aas-skel { height: 46px; border-radius: 12px; margin: 8px 2px; background: linear-gradient(90deg, var(--bg-tertiary), var(--bg-secondary), var(--bg-tertiary)); }
    .aas-body { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; max-height: 62dvh; padding: 10px 2px 2px; }
    .aas-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .aas-row--col { flex-direction: column; align-items: stretch; gap: 6px; }
    .aas-row--switch { padding: 4px 0; }
    .aas-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .aas-lbl { font-size: 13px; font-weight: 600; color: var(--fg-primary); display: inline-flex; align-items: center; gap: 6px; }
    .aas-sub { display: block; font-size: 11.5px; color: var(--fg-tertiary); margin-top: 2px; line-height: 1.4; }
    .aas-in { padding: 9px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-strong); color: var(--fg-primary); font-size: 16px; min-width: 130px; }
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
    .aas-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 0 max(6px, env(safe-area-inset-bottom)); margin-top: 2px; border-top: 1px solid var(--border-subtle); }
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
  private readonly ai = inject(AiApiService);
  private readonly usage = inject(AiUsageApiService);
  private readonly auth = inject(AuthService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly toast = inject(ToastService);

  readonly open = input(false);
  readonly closed = output<void>();
  readonly saved = output<void>();

  protected readonly SettingsIcon = Settings;
  protected readonly XIcon = X;
  protected readonly LoaderIcon = Loader;
  protected readonly ZapIcon = Zap;
  protected readonly ExternalLinkIcon = ExternalLink;
  protected readonly metiers = Object.keys(FLEET_METIER_LABELS) as FleetMetier[];

  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly running = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly fleetName = signal<string | null>(null);

  // Champs éditables
  protected readonly enabled = signal(false);
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

  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.fleetFilter.selectedFleetId());

  constructor() {
    effect(() => {
      if (!this.open() || this.needsFleet()) return;
      void this.load();
    });
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
    const fleetId = this.currentFleetId();
    try {
      const s = await firstValueFrom(this.agentApi.getSettings(fleetId));
      this.fleetName.set(s.fleetName);
      this.enabled.set(s.enabled);
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
      this.error.set(this.errMsg(e));
    } finally {
      this.loading.set(false);
    }
    // Répartition des coûts (best-effort : ne bloque pas les réglages).
    try {
      const sum = await firstValueFrom(this.usage.summary(undefined, undefined, fleetId));
      this.byAction.set(sum.byAction.slice(0, 4).map((r) => ({ key: r.key, label: r.label, costEur: r.costEur })));
    } catch { /* le coût du mois (settings) suffit */ }
  }

  protected async onMetierChange(m: string): Promise<void> {
    const metier = m as FleetMetier;
    const prev = this.metier();
    this.metier.set(metier);
    try {
      await firstValueFrom(this.ai.setFleetMetier({ fleetId: this.currentFleetId(), metier }));
      this.toast.success('Métier mis à jour', this.metierLabel(metier));
    } catch (e) {
      this.metier.set(prev);
      this.toast.error('Échec', this.errMsg(e));
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
      this.toast.success('Paramètres enregistrés', 'L\'agent utilisera ces réglages.');
      this.saved.emit();
      this.closed.emit();
    } catch (e) {
      this.error.set(this.errMsg(e));
    } finally {
      this.saving.set(false);
    }
  }

  /** Lance l'analyse de l'agent maintenant (sans attendre la nuit). */
  protected async runNow(): Promise<void> {
    this.running.set(true);
    this.error.set(null);
    try {
      const r = await firstValueFrom(this.agentApi.run(this.currentFleetId()));
      this.toast.success('Analyse terminée', `${r.created} réservé(s) · ${r.proposed} proposé(s)`);
      this.saved.emit(); // le parent rafraîchit le compteur de propositions
    } catch (e) {
      this.error.set(this.errMsg(e));
    } finally {
      this.running.set(false);
    }
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse) return e.error?.message ?? 'Erreur serveur.';
    return 'Une erreur est survenue.';
  }
}
