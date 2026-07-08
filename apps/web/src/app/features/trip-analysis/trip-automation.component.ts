import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  LucideAngularModule, Bot, ChevronLeft, Loader, Play, Save, Info, CheckCircle2, Gauge,
  History, ChevronDown, Truck, ArrowUpRight, Sparkles,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { SetTripAutomationSettingsDto, TripAutomationRunDto, TripAutomationRunStats, TripAutomationSettingsDto } from '@vizyo/tracky-shared';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorMessage } from '../../core/error/api-error';

/**
 * Espace SUPER-ADMIN — automatisation des trajets. Pilote le cron qui, pour TOUTES les flottes,
 * exécute « recalcul des trajets → analyse déterministe → récit IA », de façon bornée. Pensé pour
 * être limpide (le pipeline est expliqué en clair, bouton « Lancer maintenant » pour tester).
 */
@Component({
  selector: 'app-trip-automation',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, LucideAngularModule],
  template: `
    <div class="ta">
      <a routerLink="/admin/observability" class="ta-back">
        <lucide-icon [img]="BackIcon" [size]="16"></lucide-icon> Administration
      </a>

      <div class="ta-head">
        <div class="ta-ico"><lucide-icon [img]="BotIcon" [size]="24"></lucide-icon></div>
        <div>
          <h1>Automatisation des trajets</h1>
          <p>Analyse & récits IA générés tout seuls, pour toutes les flottes.</p>
        </div>
        @if (settings(); as s) {
          <span class="ta-state" [class.on]="s.enabled">
            <span class="ta-dot"></span>{{ s.enabled ? 'Active' : 'En pause' }}
          </span>
        }
      </div>

      <!-- Comment ça marche -->
      <section class="ta-card ta-explain">
        <div class="ta-card-h"><lucide-icon [img]="InfoIcon" [size]="15"></lucide-icon> Comment ça marche</div>
        <ol class="ta-steps">
          <li><span class="ta-step-n">1</span><div><strong>Recalcul</strong> — on nettoie d'abord le découpage des trajets (sinon on analyserait 10 fragments au lieu de 3 vrais trajets).</div></li>
          <li><span class="ta-step-n">2</span><div><strong>Analyse</strong> — arrêts, excès (limites OSM), éco-conduite, à-coups, ralenti, conso/CO₂. 100% automatique, sans IA.</div></li>
          <li><span class="ta-step-n">3</span><div><strong>Récit IA</strong> — l'agent Tracky rédige un résumé clair + Trust Score + conseils, et l'enregistre. Sauté si l'IA est coupée pour la flotte.</div></li>
        </ol>
      </section>

      @if (loading()) {
        <div class="ta-loading"><lucide-icon [img]="LoaderIcon" [size]="22" class="spin"></lucide-icon></div>
      } @else if (draft(); as d) {
        <!-- Réglages -->
        <section class="ta-card">
          <div class="ta-card-h"><lucide-icon [img]="GaugeIcon" [size]="15"></lucide-icon> Réglages</div>

          <label class="ta-row ta-toggle">
            <div>
              <span class="ta-row-t">Activer l'automatisation</span>
              <span class="ta-row-d">Interrupteur maître. En pause, rien ne se lance automatiquement.</span>
            </div>
            <input type="checkbox" [checked]="d.enabled" (change)="patch('enabled', $any($event.target).checked)">
          </label>

          <div class="ta-row">
            <div>
              <span class="ta-row-t">Cadence</span>
              <span class="ta-row-d">Commence en « toutes les heures » pour tester, puis passe en quotidien.</span>
            </div>
            <div class="ta-seg">
              <button type="button" [class.on]="d.frequency === 'hourly'" (click)="patch('frequency', 'hourly')">Toutes les heures</button>
              <button type="button" [class.on]="d.frequency === 'daily'" (click)="patch('frequency', 'daily')">Quotidien</button>
            </div>
          </div>

          @if (d.frequency === 'daily') {
            <div class="ta-row">
              <div>
                <span class="ta-row-t">Heure du run quotidien</span>
                <span class="ta-row-d">Heure de Paris (0-23). La nuit = idéal (2h par défaut).</span>
              </div>
              <input class="ta-num" type="number" min="0" max="23" [value]="d.hour" (change)="patchInt('hour', $any($event.target).value, 0, 23)">
            </div>
          }

          <label class="ta-row ta-toggle">
            <div>
              <span class="ta-row-t">Recalculer les trajets avant l'analyse</span>
              <span class="ta-row-d">Évite d'analyser des trajets fragmentés (recommandé).</span>
            </div>
            <input type="checkbox" [checked]="d.recomputeTrips" (change)="patch('recomputeTrips', $any($event.target).checked)">
          </label>

          <label class="ta-row ta-toggle">
            <div>
              <span class="ta-row-t">Générer les récits IA</span>
              <span class="ta-row-d">Décoché = seulement l'analyse (aucun appel IA). Sinon, ignoré flotte par flotte si l'IA y est coupée.</span>
            </div>
            <input type="checkbox" [checked]="d.narrateEnabled" (change)="patch('narrateEnabled', $any($event.target).checked)">
          </label>

          <button type="button" class="ta-adv-toggle" (click)="showAdvanced.set(!showAdvanced())">
            {{ showAdvanced() ? '▾' : '▸' }} Réglages avancés (fenêtre & plafonds)
          </button>
          @if (showAdvanced()) {
            <div class="ta-adv">
              <div class="ta-row">
                <div><span class="ta-row-t">Fenêtre balayée (heures)</span><span class="ta-row-d">Ancienneté max des trajets traités à chaque run.</span></div>
                <input class="ta-num" type="number" min="1" max="720" [value]="d.lookbackHours" (change)="patchInt('lookbackHours', $any($event.target).value, 1, 720)">
              </div>
              <div class="ta-row">
                <div><span class="ta-row-t">Max analyses / run</span><span class="ta-row-d">Plafond de charge (protège le serveur).</span></div>
                <input class="ta-num" type="number" min="0" max="5000" [value]="d.maxAnalysesPerRun" (change)="patchInt('maxAnalysesPerRun', $any($event.target).value, 0, 5000)">
              </div>
              <div class="ta-row">
                <div><span class="ta-row-t">Max récits IA / run</span><span class="ta-row-d">Plafond de coût IA (chaque récit = 1 appel).</span></div>
                <input class="ta-num" type="number" min="0" max="2000" [value]="d.maxNarrationsPerRun" (change)="patchInt('maxNarrationsPerRun', $any($event.target).value, 0, 2000)">
              </div>
            </div>
          }

          <div class="ta-actions">
            <button type="button" class="ta-btn ta-btn--primary" [disabled]="saving() || !dirty()" (click)="save()">
              @if (saving()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="spin"></lucide-icon> Enregistrement… }
              @else { <lucide-icon [img]="SaveIcon" [size]="15"></lucide-icon> Enregistrer }
            </button>
            @if (dirty()) { <span class="ta-dirty">Modifications non enregistrées</span> }
          </div>
        </section>

        <!-- Lancer maintenant -->
        <section class="ta-card">
          <div class="ta-card-h"><lucide-icon [img]="PlayIcon" [size]="15"></lucide-icon> Tester maintenant</div>
          <p class="ta-hint">Lance un run tout de suite (ignore la cadence) pour vérifier le pipeline sur les données réelles.</p>
          <button type="button" class="ta-btn ta-btn--run" [disabled]="running()" (click)="runNow()">
            @if (running()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="spin"></lucide-icon> Traitement en cours… }
            @else { <lucide-icon [img]="PlayIcon" [size]="15"></lucide-icon> Lancer maintenant }
          </button>

          @if (lastRun(); as r) {
            <div class="ta-result">
              <div class="ta-result-h"><lucide-icon [img]="CheckIcon" [size]="15"></lucide-icon> Dernier run — {{ r.at | date:'dd/MM HH:mm' }} ({{ dur(r.durationMs) }})</div>
              <div class="ta-kpis">
                <div class="ta-kpi"><span>{{ r.fleets }}</span>flottes</div>
                <div class="ta-kpi"><span>{{ r.vehicles }}</span>véhicules</div>
                <div class="ta-kpi"><span>{{ r.recomputed }}</span>recalculés</div>
                <div class="ta-kpi"><span>{{ r.analyzed }}</span>analysés</div>
                <div class="ta-kpi"><span>{{ r.narrated }}</span>récits IA</div>
                <div class="ta-kpi" [class.err]="r.failed > 0"><span>{{ r.failed }}</span>échecs</div>
              </div>
            </div>
          } @else if (settings()?.lastRunAt; as at) {
            <p class="ta-hint">Dernier passage automatique : {{ at | date:'dd/MM/yyyy HH:mm' }}.</p>
          }
        </section>

        <!-- Historique / audit — tout sous contrôle -->
        <section class="ta-card">
          <div class="ta-card-h"><lucide-icon [img]="HistoryIcon" [size]="15"></lucide-icon> Historique des passages</div>
          <p class="ta-hint">Chaque passage : quand, pour qui, ce qui a été fait. Clique un trajet pour ouvrir son récit.</p>
          @if (runs().length === 0) {
            <p class="ta-empty">Aucun passage pour l'instant — lances-en un avec « Lancer maintenant ».</p>
          } @else {
            <div class="ta-runs">
              @for (r of runs(); track r.id) {
                <div class="ta-run">
                  <button type="button" class="ta-run-head" (click)="toggleRun(r.id)">
                    <span class="ta-run-when">{{ r.startedAt | date:'dd/MM HH:mm' }}</span>
                    <span class="ta-run-origin" [class.manual]="r.origin === 'manual'">{{ r.origin === 'manual' ? 'Manuel' : 'Auto' }}</span>
                    <span class="ta-run-sum">{{ r.analyzed }} analysés · {{ r.narrated }} récits@if (r.failed > 0) { · <b class="err">{{ r.failed }} échecs</b> }</span>
                    <lucide-icon [img]="ChevronDownIcon" [size]="16" class="ta-run-chev" [class.open]="expandedRun() === r.id"></lucide-icon>
                  </button>
                  @if (expandedRun() === r.id) {
                    <div class="ta-run-body">
                      <div class="ta-run-meta">{{ r.fleets }} flotte(s) · {{ r.vehicles }} véhicule(s) · {{ dur(r.durationMs) }}</div>
                      @if (r.items.length === 0) {
                        <p class="ta-empty sm">Rien de nouveau à traiter sur ce passage.</p>
                      } @else {
                        <div class="ta-items">
                          @for (it of r.items; track it.tripId) {
                            <a class="ta-item" [routerLink]="['/vehicles', it.vehicleId]" [queryParams]="{ tab: 'reports' }">
                              <lucide-icon [img]="it.action === 'narrated' ? SparklesIcon : TruckIcon" [size]="14" class="ta-item-ico" [class.ai]="it.action === 'narrated'"></lucide-icon>
                              <span class="ta-item-plate">{{ it.plate }}</span>
                              <span class="ta-item-fleet">{{ it.fleetName }}</span>
                              <span class="ta-item-date">{{ it.tripStartedAt | date:'dd/MM HH:mm' }}</span>
                              <span class="ta-item-act" [class.ai]="it.action === 'narrated'">{{ it.action === 'narrated' ? 'Récit IA' : 'Analyse' }}</span>
                              <lucide-icon [img]="LinkIcon" [size]="13" class="ta-item-link"></lucide-icon>
                            </a>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ta { max-width: 760px; }
    .ta-back { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); text-decoration: none; margin-bottom: 18px; }
    .ta-back:hover { color: var(--fg-secondary); }
    .ta-head { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
    .ta-ico { width: 48px; height: 48px; border-radius: 13px; display: flex; align-items: center; justify-content: center; background: rgba(139,92,246,.12); color: #a78bfa; flex-shrink: 0; }
    .ta-head h1 { font-family: var(--font-display, Poppins, sans-serif); font-size: 24px; font-weight: 800; letter-spacing: -.4px; color: var(--fg-primary); margin: 0; }
    .ta-head p { color: var(--fg-tertiary); font-size: 13px; margin: 3px 0 0; }
    .ta-state { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; background: var(--bg-tertiary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
    .ta-state.on { background: rgba(16,224,160,.08); color: var(--tracky-light); border-color: rgba(16,224,160,.18); }
    .ta-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }

    .ta-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; padding: 20px 22px; margin-bottom: 16px; }
    .ta-card-h { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px; color: var(--fg-tertiary); margin-bottom: 14px; }

    .ta-explain { background: color-mix(in srgb, #a78bfa 6%, var(--bg-secondary)); border-color: color-mix(in srgb, #a78bfa 18%, transparent); }
    .ta-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .ta-steps li { display: flex; align-items: flex-start; gap: 12px; font-size: 13px; line-height: 1.5; color: var(--fg-secondary); }
    .ta-step-n { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: rgba(139,92,246,.15); color: #a78bfa; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
    .ta-steps strong { color: var(--fg-primary); }

    .ta-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-top: 1px solid var(--border-subtle); }
    .ta-row:first-of-type { border-top: none; }
    .ta-toggle { cursor: pointer; }
    .ta-row-t { display: block; font-size: 13.5px; font-weight: 700; color: var(--fg-primary); }
    .ta-row-d { display: block; font-size: 11.5px; color: var(--fg-tertiary); margin-top: 2px; max-width: 440px; line-height: 1.45; }
    .ta-row input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--tracky, #10E0A0); cursor: pointer; flex-shrink: 0; }
    .ta-num { width: 92px; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--border-strong, var(--border-subtle)); background: var(--bg-tertiary); color: var(--fg-primary); font-size: 13px; font-weight: 700; text-align: center; }

    .ta-seg { display: inline-flex; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 3px; gap: 2px; }
    .ta-seg button { padding: 7px 14px; border: none; background: transparent; color: var(--fg-tertiary); font-size: 12.5px; font-weight: 700; border-radius: 7px; cursor: pointer; }
    .ta-seg button.on { background: var(--tracky, #10E0A0); color: var(--accent-ink, #04130D); }

    .ta-adv-toggle { margin-top: 12px; background: none; border: none; color: var(--fg-tertiary); font-size: 12px; font-weight: 700; cursor: pointer; padding: 4px 0; }
    .ta-adv-toggle:hover { color: var(--fg-secondary); }
    .ta-adv { border-top: 1px dashed var(--border-subtle); margin-top: 4px; }

    .ta-actions { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
    .ta-btn { display: inline-flex; align-items: center; gap: 7px; padding: 10px 16px; border-radius: 10px; font-size: 13px; font-weight: 800; cursor: pointer; border: none; }
    .ta-btn:disabled { opacity: .55; cursor: default; }
    .ta-btn--primary { background: var(--tracky, #10E0A0); color: var(--accent-ink, #04130D); }
    .ta-btn--run { background: transparent; color: #a78bfa; border: 1px solid color-mix(in srgb, #a78bfa 40%, transparent); }
    .ta-btn--run:hover:not(:disabled) { background: rgba(139,92,246,.08); }
    .ta-dirty { font-size: 11.5px; font-weight: 600; color: #f59e0b; }
    .ta-hint { font-size: 12.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0 0 14px; }

    .ta-result { margin-top: 16px; padding: 14px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ta-result-h { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 700; color: var(--tracky-light, #10E0A0); margin-bottom: 12px; }
    .ta-kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    @media (max-width: 520px) { .ta-kpis { grid-template-columns: repeat(2, 1fr); } }
    .ta-kpi { display: flex; flex-direction: column; align-items: center; padding: 10px; border-radius: 10px; background: var(--bg-secondary); font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; color: var(--fg-tertiary); font-weight: 600; }
    .ta-kpi span { font-family: var(--font-display, Poppins, sans-serif); font-size: 22px; font-weight: 800; color: var(--fg-primary); margin-bottom: 3px; }
    .ta-kpi.err span { color: #f87171; }

    .ta-loading { display: flex; justify-content: center; padding: 40px; color: var(--fg-tertiary); }
    .spin { animation: taspin .8s linear infinite; }
    @keyframes taspin { to { transform: rotate(360deg); } }

    /* Historique */
    .ta-empty { font-size: 12.5px; color: var(--fg-tertiary); margin: 8px 0 0; }
    .ta-empty.sm { margin: 6px 0 0; }
    .ta-runs { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
    .ta-run { border: 1px solid var(--border-subtle); border-radius: 12px; overflow: hidden; background: var(--bg-tertiary); }
    .ta-run-head { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: none; border: none; cursor: pointer; text-align: left; color: var(--fg-primary); }
    .ta-run-when { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ta-run-origin { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 3px 8px; border-radius: 6px; background: color-mix(in srgb, var(--fg-tertiary) 18%, transparent); color: var(--fg-secondary); }
    .ta-run-origin.manual { background: rgba(139,92,246,.14); color: #a78bfa; }
    .ta-run-sum { font-size: 12px; color: var(--fg-tertiary); flex: 1; min-width: 0; }
    .ta-run-sum .err { color: #f87171; }
    .ta-run-chev { color: var(--fg-tertiary); transition: transform .2s; flex-shrink: 0; }
    .ta-run-chev.open { transform: rotate(180deg); }
    .ta-run-body { padding: 2px 14px 14px; border-top: 1px solid var(--border-subtle); }
    .ta-run-meta { font-size: 11.5px; color: var(--fg-tertiary); padding: 10px 0; }
    .ta-items { display: flex; flex-direction: column; gap: 4px; }
    .ta-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; text-decoration: none; color: var(--fg-secondary); background: var(--bg-secondary); border: 1px solid transparent; transition: border-color .15s; }
    .ta-item:hover { border-color: color-mix(in srgb, var(--tracky, #10E0A0) 40%, transparent); }
    .ta-item-ico { color: var(--fg-tertiary); flex-shrink: 0; }
    .ta-item-ico.ai { color: #a78bfa; }
    .ta-item-plate { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); white-space: nowrap; }
    .ta-item-fleet { font-size: 11.5px; color: var(--fg-tertiary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ta-item-date { font-size: 11px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ta-item-act { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 5px; background: color-mix(in srgb, var(--tracky, #10E0A0) 14%, transparent); color: var(--tracky-light, #10E0A0); white-space: nowrap; }
    .ta-item-act.ai { background: rgba(139,92,246,.14); color: #a78bfa; }
    .ta-item-link { color: var(--fg-tertiary); flex-shrink: 0; }
  `],
})
export class TripAutomationComponent implements OnInit {
  private readonly api = inject(TripAnalysisApiService);
  private readonly toast = inject(ToastService);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly running = signal(false);
  protected readonly showAdvanced = signal(false);
  protected readonly settings = signal<TripAutomationSettingsDto | null>(null);
  protected readonly draft = signal<TripAutomationSettingsDto | null>(null);
  protected readonly lastRun = signal<TripAutomationRunStats | null>(null);
  protected readonly runs = signal<TripAutomationRunDto[]>([]);
  protected readonly expandedRun = signal<string | null>(null);

  /** Le formulaire diffère-t-il des réglages enregistrés ? (active le bouton Enregistrer). */
  protected readonly dirty = computed(() => {
    const s = this.settings(), d = this.draft();
    if (!s || !d) return false;
    return (['enabled', 'frequency', 'hour', 'lookbackHours', 'recomputeTrips', 'narrateEnabled', 'maxAnalysesPerRun', 'maxNarrationsPerRun'] as const)
      .some((k) => s[k] !== d[k]);
  });

  protected readonly BotIcon = Bot;
  protected readonly BackIcon = ChevronLeft;
  protected readonly LoaderIcon = Loader;
  protected readonly PlayIcon = Play;
  protected readonly SaveIcon = Save;
  protected readonly InfoIcon = Info;
  protected readonly CheckIcon = CheckCircle2;
  protected readonly GaugeIcon = Gauge;
  protected readonly HistoryIcon = History;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly TruckIcon = Truck;
  protected readonly LinkIcon = ArrowUpRight;
  protected readonly SparklesIcon = Sparkles;

  ngOnInit(): void { void this.load(); void this.loadRuns(); }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const s = await firstValueFrom(this.api.getAutomation());
      this.settings.set(s);
      this.draft.set({ ...s });
      this.lastRun.set(s.lastRunStats);
    } catch (e) {
      this.toast.error('Chargement impossible', apiErrorMessage(e, ''));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadRuns(): Promise<void> {
    try {
      this.runs.set(await firstValueFrom(this.api.listAutomationRuns(30)));
    } catch { /* l'historique n'est pas bloquant */ }
  }

  protected toggleRun(id: string): void {
    this.expandedRun.set(this.expandedRun() === id ? null : id);
  }

  protected patch<K extends keyof TripAutomationSettingsDto>(key: K, value: TripAutomationSettingsDto[K]): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, [key]: value });
  }

  protected patchInt(key: keyof TripAutomationSettingsDto, raw: string, min: number, max: number): void {
    const n = Math.round(Number(raw));
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
    this.patch(key, v as never);
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d || this.saving()) return;
    this.saving.set(true);
    try {
      const dto: SetTripAutomationSettingsDto = {
        enabled: d.enabled,
        frequency: d.frequency,
        hour: d.hour,
        lookbackHours: d.lookbackHours,
        recomputeTrips: d.recomputeTrips,
        narrateEnabled: d.narrateEnabled,
        maxAnalysesPerRun: d.maxAnalysesPerRun,
        maxNarrationsPerRun: d.maxNarrationsPerRun,
      };
      const updated = await firstValueFrom(this.api.setAutomation(dto));
      this.settings.set(updated);
      this.draft.set({ ...updated });
      this.toast.success('Réglages enregistrés');
    } catch (e) {
      this.toast.error('Échec de l\'enregistrement', apiErrorMessage(e, ''));
    } finally {
      this.saving.set(false);
    }
  }

  protected async runNow(): Promise<void> {
    if (this.running()) return;
    this.running.set(true);
    try {
      const stats = await firstValueFrom(this.api.runAutomationNow());
      this.lastRun.set(stats);
      this.toast.success('Run terminé', `${stats.analyzed} analysé(s) · ${stats.narrated} récit(s) IA`);
      void this.load();
      void this.loadRuns();
    } catch (e) {
      this.toast.error('Le run a échoué', apiErrorMessage(e, ''));
    } finally {
      this.running.set(false);
    }
  }

  protected dur(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}min ${s % 60}s`;
  }
}
