import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, ChevronLeft, Zap, Wallet, Users, Building2, Layers, TrendingUp,
  RefreshCw, AlertTriangle, Loader, Check, Save,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { AiUsageBreakdownRowDto, AiUsageLogRowDto, AiUsageSummaryDto } from '@vizyo/tracky-shared';
import { AiUsageApiService } from '../../core/services/ai-usage.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

type Period = '24h' | '7d' | '30d';
type BreakdownTab = 'user' | 'fleet' | 'action';

/**
 * Palier « Coûts IA » — tableau de bord super-admin des dépenses du copilote IA (Claude).
 * Qui consomme combien (utilisateur / flotte / type / jour), tendance du mois, journal des
 * appels, et budget mensuel avec marqueur rouge à l'approche du plafond.
 */
@Component({
  selector: 'app-admin-ai-usage',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, DecimalPipe, LucideAngularModule],
  template: `
    <div class="au">
      <!-- Header -->
      <a routerLink="/admin" class="au-back"><lucide-icon [img]="BackIcon" [size]="15"></lucide-icon> Administration</a>
      <header class="au-head">
        <div class="au-title">
          <div class="au-ico"><lucide-icon [img]="ZapIcon" [size]="22"></lucide-icon></div>
          <div>
            <h1>Coûts IA</h1>
            <p>Dépenses du copilote IA (Claude) — {{ periodLabel() }}.</p>
          </div>
        </div>
        <div class="au-actions">
          <div class="au-seg">
            @for (p of periods; track p.key) {
              <button type="button" (click)="setPeriod(p.key)" [class.on]="period() === p.key">{{ p.label }}</button>
            }
          </div>
          <button type="button" class="au-refresh" (click)="reload()" [disabled]="loading()" aria-label="Rafraîchir">
            <lucide-icon [img]="RefreshIcon" [size]="15" [class.au-spin]="loading()"></lucide-icon>
          </button>
        </div>
      </header>

      @if (error()) {
        <div class="au-alert"><lucide-icon [img]="AlertIcon" [size]="15"></lucide-icon> {{ error() }}</div>
      }

      @if (summary(); as s) {
        <!-- ── BUDGET ── -->
        <section class="au-budget" [attr.data-status]="s.budget.status">
          <div class="au-budget-head">
            <div>
              <span class="au-budget-label"><lucide-icon [img]="WalletIcon" [size]="14"></lucide-icon> {{ isSuperAdmin() ? 'Budget du mois' : 'Coûts IA de votre société (ce mois)' }}</span>
              <div class="au-budget-spent">
                {{ eur(s.budget.spentThisMonthEur) }}
                @if (s.budget.monthlyBudgetEur > 0) { <span class="au-budget-of">/ {{ eur(s.budget.monthlyBudgetEur) }}</span> }
              </div>
            </div>
            <span class="au-budget-badge" [attr.data-status]="s.budget.status">{{ budgetBadge(s.budget.status) }}</span>
          </div>
          @if (s.budget.monthlyBudgetEur > 0) {
            <div class="au-bar"><div class="au-bar-fill" [attr.data-status]="s.budget.status" [style.width.%]="budgetPct(s)"></div></div>
          }
          @if (isSuperAdmin()) {
            <div class="au-budget-edit">
              <label>Plafond mensuel (€)</label>
              <input type="number" min="0" step="1" inputmode="decimal" [value]="budgetInput()" (input)="budgetInput.set($any($event.target).value)" placeholder="ex. 10" />
              <button type="button" class="au-btn" [disabled]="savingBudget()" (click)="saveBudget()">
                @if (savingBudget()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="au-spin"></lucide-icon> } @else { <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon> }
                Enregistrer
              </button>
              <span class="au-budget-hint">0 = pas de budget. Marqueur rouge dès {{ '100 %' }} (orange à 80 %).</span>
            </div>
          }
        </section>

        <!-- ── KPIs ── -->
        <section class="au-kpis">
          <div class="au-kpi">
            <span class="au-kpi-n">{{ eur(s.totalCostEur) }}</span>
            <span class="au-kpi-l">Coût ({{ periodLabel() }})</span>
            <span class="au-kpi-sub">{{ usd(s.totalCostUsd) }}</span>
          </div>
          <div class="au-kpi">
            <span class="au-kpi-n">{{ num(s.totalCalls) }}</span>
            <span class="au-kpi-l">Appels</span>
          </div>
          <div class="au-kpi">
            <span class="au-kpi-n">{{ compact(s.totalInputTokens + s.totalOutputTokens) }}</span>
            <span class="au-kpi-l">Tokens</span>
            <span class="au-kpi-sub">{{ compact(s.totalInputTokens) }} in · {{ compact(s.totalOutputTokens) }} out</span>
          </div>
          <div class="au-kpi">
            <span class="au-kpi-n">{{ perCall(s) }}</span>
            <span class="au-kpi-l">Coût / appel</span>
          </div>
        </section>

        <!-- ── RÉPARTITION ── -->
        <section class="au-panel">
          <div class="au-panel-head">
            <h2>Répartition</h2>
            <div class="au-seg au-seg--sm">
              <button type="button" (click)="tab.set('user')" [class.on]="tab() === 'user'"><lucide-icon [img]="UsersIcon" [size]="13"></lucide-icon> Utilisateur</button>
              <button type="button" (click)="tab.set('fleet')" [class.on]="tab() === 'fleet'"><lucide-icon [img]="FleetIcon" [size]="13"></lucide-icon> Flotte</button>
              <button type="button" (click)="tab.set('action')" [class.on]="tab() === 'action'"><lucide-icon [img]="LayersIcon" [size]="13"></lucide-icon> Type</button>
            </div>
          </div>
          @if (activeBreakdown().length === 0) {
            <p class="au-empty-sm">Aucune dépense sur la période.</p>
          } @else {
            <div class="au-bars">
              @for (r of activeBreakdown(); track r.key) {
                <div class="au-brow">
                  <div class="au-brow-top">
                    <span class="au-brow-label" [title]="r.label">{{ r.label }}</span>
                    <span class="au-brow-cost">{{ eur(r.costEur) }}</span>
                  </div>
                  <div class="au-bar au-bar--thin"><div class="au-bar-fill au-bar-fill--accent" [style.width.%]="pctOfMax(r, activeBreakdown())"></div></div>
                  <span class="au-brow-sub">{{ num(r.calls) }} appel(s) · {{ compact(r.inputTokens + r.outputTokens) }} tokens</span>
                </div>
              }
            </div>
          }
        </section>

        <!-- ── TENDANCE ── -->
        <section class="au-panel">
          <div class="au-panel-head"><h2><lucide-icon [img]="TrendIcon" [size]="15"></lucide-icon> Tendance quotidienne</h2></div>
          @if (s.byDay.length === 0) {
            <p class="au-empty-sm">Aucune donnée.</p>
          } @else {
            <div class="au-trend">
              @for (d of s.byDay; track d.key) {
                <div class="au-trend-col" [title]="d.label + ' — ' + eur(d.costEur)">
                  <div class="au-trend-bar" [style.height.%]="trendPct(d, s.byDay)"></div>
                  <span class="au-trend-x">{{ d.label.slice(8, 10) }}</span>
                </div>
              }
            </div>
          }
        </section>

        <!-- ── JOURNAL ── -->
        <section class="au-panel">
          <div class="au-panel-head">
            <h2>Journal des appels</h2>
            <div class="au-seg au-seg--sm">
              <button type="button" (click)="setLogAction(undefined)" [class.on]="!logAction()">Tous</button>
              <button type="button" (click)="setLogAction('capacity')" [class.on]="logAction() === 'capacity'">Capacité</button>
              <button type="button" (click)="setLogAction('placement')" [class.on]="logAction() === 'placement'">Placement</button>
            </div>
          </div>
          <div class="au-table-wrap">
            <table class="au-table">
              <thead>
                <tr><th>Date</th><th>Utilisateur</th><th>Flotte</th><th>Type</th><th class="r">Tokens</th><th class="r">Coût</th><th class="r">Latence</th></tr>
              </thead>
              <tbody>
                @for (l of logRows(); track l.id) {
                  <tr [class.au-row-ko]="!l.ok">
                    <td>{{ l.createdAt | date:'dd/MM HH:mm' }}</td>
                    <td class="au-td-ell" [title]="l.userEmail || '—'">{{ l.userEmail || '—' }}</td>
                    <td class="au-td-ell" [title]="l.fleetName || '—'">{{ l.fleetName || '—' }}</td>
                    <td>{{ actionLabel(l.action) }}</td>
                    <td class="r">{{ compact(l.inputTokens + l.outputTokens) }}</td>
                    <td class="r au-cost">{{ eur(l.costEur) }}</td>
                    <td class="r au-dim">{{ l.latencyMs != null ? (l.latencyMs / 1000 | number:'1.1-1') + 's' : '—' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="7" class="au-empty-sm">Aucun appel enregistré.</td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (logCursor()) {
            <button type="button" class="au-more" (click)="loadMore()" [disabled]="loadingMore()">
              @if (loadingMore()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="au-spin"></lucide-icon> } Charger plus
            </button>
          }
        </section>
      } @else if (loading()) {
        <div class="au-skel"></div><div class="au-skel"></div>
      }
    </div>
  `,
  styles: [`
    .au { max-width: 1000px; display: flex; flex-direction: column; gap: 16px; }
    .au-back { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--fg-tertiary); text-decoration: none; width: fit-content; }
    .au-back:hover { color: var(--fg-secondary); }
    .au-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .au-title { display: flex; align-items: center; gap: 12px; }
    .au-ico { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: rgba(245,158,11,.12); color: #fbbf24; flex-shrink: 0; }
    .au-head h1 { font-family: var(--font-display, Poppins, sans-serif); font-size: 24px; font-weight: 800; color: var(--fg-primary); margin: 0; }
    .au-head p { font-size: 12.5px; color: var(--fg-tertiary); margin: 3px 0 0; }
    .au-actions { display: flex; align-items: center; gap: 8px; }
    .au-seg { display: inline-flex; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 3px; gap: 2px; }
    .au-seg button { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 7px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); background: transparent; }
    .au-seg button.on { background: var(--bg-tertiary); color: var(--fg-primary); }
    .au-seg--sm button { padding: 5px 10px; font-size: 12px; }
    .au-refresh { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); }
    .au-alert { display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-radius: 11px; background: rgba(239,68,68,.1); color: #EF4444; font-size: 13px; }

    /* Budget */
    .au-budget { padding: 18px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 12px; }
    .au-budget[data-status="warn"] { border-color: rgba(245,158,11,.4); }
    .au-budget[data-status="over"] { border-color: rgba(239,68,68,.5); background: rgba(239,68,68,.04); }
    .au-budget-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .au-budget-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .03em; }
    .au-budget-spent { font-family: var(--font-display, Poppins, sans-serif); font-size: 30px; font-weight: 800; color: var(--fg-primary); margin-top: 4px; }
    .au-budget[data-status="over"] .au-budget-spent, .au-budget[data-status="warn"] .au-budget-spent { color: #f87171; }
    .au-budget[data-status="warn"] .au-budget-spent { color: #fbbf24; }
    .au-budget-of { font-size: 16px; font-weight: 600; color: var(--fg-tertiary); }
    .au-budget-badge { font-size: 11px; font-weight: 800; padding: 4px 10px; border-radius: 999px; height: fit-content; background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .au-budget-badge[data-status="ok"] { background: rgba(16,224,160,.14); color: var(--tracky-light); }
    .au-budget-badge[data-status="warn"] { background: rgba(245,158,11,.16); color: #fbbf24; }
    .au-budget-badge[data-status="over"] { background: rgba(239,68,68,.16); color: #f87171; }
    .au-bar { height: 8px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
    .au-bar--thin { height: 6px; }
    .au-bar-fill { height: 100%; border-radius: 999px; background: var(--tracky-light); transition: width .4s; }
    .au-bar-fill[data-status="warn"] { background: #fbbf24; }
    .au-bar-fill[data-status="over"] { background: #f87171; }
    .au-bar-fill--accent { background: linear-gradient(90deg, #38bdf8, #22d3ee); }
    .au-budget-edit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .au-budget-edit label { font-size: 12px; color: var(--fg-tertiary); }
    .au-budget-edit input { width: 110px; padding: 8px 10px; border-radius: 9px; background: var(--bg-primary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 16px; }
    .au-budget-hint { font-size: 11px; color: var(--fg-tertiary); flex-basis: 100%; }
    .au-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 9px; font-size: 12.5px; font-weight: 700; background: var(--tracky, #10B981); color: #fff; }
    .au-btn:disabled { opacity: .5; }

    /* KPIs */
    .au-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    @media (max-width: 640px) { .au-kpis { grid-template-columns: 1fr 1fr; } }
    .au-kpi { padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 3px; }
    .au-kpi-n { font-family: var(--font-display, Poppins, sans-serif); font-size: 22px; font-weight: 800; color: var(--fg-primary); }
    .au-kpi-l { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); font-weight: 600; }
    .au-kpi-sub { font-size: 11px; color: var(--fg-tertiary); }

    /* Panels */
    .au-panel { padding: 16px 18px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 12px; }
    .au-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .au-panel-head h2 { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .au-empty-sm { font-size: 12.5px; color: var(--fg-tertiary); padding: 10px 0; text-align: center; }

    .au-bars { display: flex; flex-direction: column; gap: 12px; }
    .au-brow { display: flex; flex-direction: column; gap: 5px; }
    .au-brow-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .au-brow-label { font-size: 13px; color: var(--fg-secondary); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .au-brow-cost { font-size: 13px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .au-brow-sub { font-size: 11px; color: var(--fg-tertiary); }

    /* Trend */
    .au-trend { display: flex; align-items: flex-end; gap: 4px; height: 120px; padding-top: 8px; }
    .au-trend-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; height: 100%; min-width: 0; }
    .au-trend-bar { width: 100%; max-width: 26px; min-height: 2px; border-radius: 4px 4px 0 0; background: linear-gradient(180deg, #38bdf8, #0ea5e9); }
    .au-trend-x { font-size: 9px; color: var(--fg-tertiary); }

    /* Table */
    .au-table-wrap { overflow-x: auto; }
    .au-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .au-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--fg-tertiary); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--border-subtle); white-space: nowrap; }
    .au-table td { padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); color: var(--fg-secondary); white-space: nowrap; }
    .au-table th.r, .au-table td.r { text-align: right; font-variant-numeric: tabular-nums; }
    .au-td-ell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
    .au-cost { font-weight: 800; color: var(--fg-primary); }
    .au-dim { color: var(--fg-tertiary); }
    .au-row-ko { opacity: .6; }
    .au-more { align-self: center; padding: 8px 16px; border-radius: 9px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); font-size: 12.5px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }

    .au-skel { height: 120px; border-radius: 16px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: au-sh 1.3s infinite; }
    @keyframes au-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .au-spin { animation: au-spin 1s linear infinite; }
    @keyframes au-spin { to { transform: rotate(360deg); } }
  `],
})
export class AdminAiUsageComponent implements OnInit {
  private readonly api = inject(AiUsageApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  /** Le budget (plafond global) n'est éditable que par un super-admin ; un fleet-admin est en lecture seule scopée. */
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');

  protected readonly BackIcon = ChevronLeft;
  protected readonly ZapIcon = Zap;
  protected readonly WalletIcon = Wallet;
  protected readonly UsersIcon = Users;
  protected readonly FleetIcon = Building2;
  protected readonly LayersIcon = Layers;
  protected readonly TrendIcon = TrendingUp;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly CheckIcon = Check;
  protected readonly SaveIcon = Save;

  protected readonly periods: { key: Period; label: string }[] = [
    { key: '24h', label: '24 h' },
    { key: '7d', label: '7 j' },
    { key: '30d', label: '30 j' },
  ];

  protected readonly period = signal<Period>('30d');
  protected readonly tab = signal<BreakdownTab>('user');
  protected readonly summary = signal<AiUsageSummaryDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly budgetInput = signal<string>('');
  protected readonly savingBudget = signal(false);

  protected readonly logRows = signal<AiUsageLogRowDto[]>([]);
  protected readonly logCursor = signal<string | null>(null);
  protected readonly loadingMore = signal(false);
  protected readonly logAction = signal<string | undefined>(undefined);

  protected readonly activeBreakdown = computed<AiUsageBreakdownRowDto[]>(() => {
    const s = this.summary();
    if (!s) return [];
    return this.tab() === 'user' ? s.byUser : this.tab() === 'fleet' ? s.byFleet : s.byAction;
  });

  protected periodLabel(): string {
    return this.period() === '24h' ? '24 dernières heures' : this.period() === '7d' ? '7 derniers jours' : '30 derniers jours';
  }

  ngOnInit(): void {
    void this.reload();
  }

  protected setPeriod(p: Period): void {
    if (p === this.period()) return;
    this.period.set(p);
    void this.reload();
  }

  private fromIso(): string {
    const days = this.period() === '24h' ? 1 : this.period() === '7d' ? 7 : 30;
    return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  }

  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const s = await firstValueFrom(this.api.summary(this.fromIso()));
      this.summary.set(s);
      if (this.budgetInput() === '' && s.budget.monthlyBudgetEur > 0) {
        this.budgetInput.set(String(s.budget.monthlyBudgetEur));
      }
      await this.loadLogs(true);
    } catch (e) {
      this.error.set(this.errMsg(e));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadLogs(reset: boolean): Promise<void> {
    const page = await firstValueFrom(
      this.api.logs({ limit: 30, action: this.logAction(), before: reset ? undefined : this.logCursor() ?? undefined }),
    );
    this.logRows.set(reset ? page.rows : [...this.logRows(), ...page.rows]);
    this.logCursor.set(page.nextCursor);
  }

  protected async loadMore(): Promise<void> {
    if (this.loadingMore() || !this.logCursor()) return;
    this.loadingMore.set(true);
    try {
      await this.loadLogs(false);
    } catch (e) {
      this.toast.error('Chargement', this.errMsg(e));
    } finally {
      this.loadingMore.set(false);
    }
  }

  protected setLogAction(action: string | undefined): void {
    if (action === this.logAction()) return;
    this.logAction.set(action);
    this.logCursor.set(null);
    void this.loadLogs(true).catch((e) => this.toast.error('Chargement', this.errMsg(e)));
  }

  protected async saveBudget(): Promise<void> {
    const value = Number(this.budgetInput());
    if (!Number.isFinite(value) || value < 0) {
      this.toast.error('Budget invalide', 'Entrez un montant ≥ 0.');
      return;
    }
    this.savingBudget.set(true);
    try {
      const budget = await firstValueFrom(this.api.setBudget(value));
      const s = this.summary();
      if (s) this.summary.set({ ...s, budget });
      this.toast.success('Budget enregistré', budget.monthlyBudgetEur > 0 ? `${this.eur(budget.monthlyBudgetEur)} / mois` : 'Budget retiré');
    } catch (e) {
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.savingBudget.set(false);
    }
  }

  // ─── Helpers d'affichage ───
  protected eur(v: number): string {
    const n = Math.abs(v) >= 1 || v === 0 ? v.toFixed(2) : v.toFixed(4);
    return `${n} €`;
  }
  protected usd(v: number): string {
    return `${(Math.abs(v) >= 1 || v === 0 ? v.toFixed(2) : v.toFixed(4))} $`;
  }
  protected num(v: number): string {
    return v.toLocaleString('fr-FR');
  }
  protected compact(v: number): string {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return String(v);
  }
  protected perCall(s: AiUsageSummaryDto): string {
    return this.eur(s.totalCalls > 0 ? s.totalCostEur / s.totalCalls : 0);
  }
  protected budgetPct(s: AiUsageSummaryDto): number {
    const b = s.budget;
    if (b.monthlyBudgetEur <= 0) return 0;
    return Math.min(100, (b.spentThisMonthEur / b.monthlyBudgetEur) * 100);
  }
  protected budgetBadge(status: string): string {
    return status === 'over' ? 'Dépassé' : status === 'warn' ? 'Proche du plafond' : status === 'ok' ? 'Sous contrôle' : 'Pas de budget';
  }
  protected pctOfMax(r: AiUsageBreakdownRowDto, rows: AiUsageBreakdownRowDto[]): number {
    const max = Math.max(...rows.map((x) => x.costEur), 0);
    return max > 0 ? Math.max(2, (r.costEur / max) * 100) : 0;
  }
  protected trendPct(d: AiUsageBreakdownRowDto, rows: AiUsageBreakdownRowDto[]): number {
    const max = Math.max(...rows.map((x) => x.costEur), 0);
    return max > 0 ? Math.max(2, (d.costEur / max) * 100) : 0;
  }
  protected actionLabel(a: string): string {
    return a === 'capacity' ? 'Capacité' : a === 'placement' ? 'Placement' : a;
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string } | null)?.message;
      if (m) return Array.isArray(m) ? m.join(', ') : m;
      return `Erreur (${e.status}).`;
    }
    return 'Une erreur est survenue.';
  }
}
