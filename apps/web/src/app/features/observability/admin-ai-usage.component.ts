import { ChangeDetectionStrategy, Component, computed, effect, inject, OnInit, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, ChevronLeft, Zap, Wallet, Users, Building2, Layers, TrendingUp,
  RefreshCw, AlertTriangle, Loader, Check, Save, Cpu, Calendar, Power, Tag,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type {
  AiFeatureFlagsDto, AiFeatureKey, AiProviderMode, AiProviderSettingsDto, AiUsageBreakdownRowDto, AiUsageLogRowDto, AiUsageSummaryDto,
} from '@vizyo/tracky-shared';
import { AiUsageApiService } from '../../core/services/ai-usage.service';
import { AiStatusService } from '../../core/services/ai-status.service';
import { BillingApiService } from '../../core/services/billing.service';
import { AuthService } from '../../core/services/auth.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
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
            <p>Dépenses du copilote IA — {{ periodLabel() }}.</p>
          </div>
        </div>
        <div class="au-actions">
          <div class="au-seg">
            @for (p of periods; track p.key) {
              <button type="button" (click)="setPeriod(p.key)" [class.on]="period() === p.key && !day()">{{ p.label }}</button>
            }
          </div>
          <label class="au-day" [class.au-day--on]="day()" title="Filtrer sur un jour précis">
            <lucide-icon [img]="CalendarIcon" [size]="14"></lucide-icon>
            <input type="date" [value]="day()" (change)="setDay($any($event.target).value)" [max]="todayIso()">
          </label>
          <button type="button" class="au-refresh" (click)="reload()" [disabled]="loading()" aria-label="Rafraîchir">
            <lucide-icon [img]="RefreshIcon" [size]="15" [class.au-spin]="loading()"></lucide-icon>
          </button>
        </div>
      </header>

      @if (error()) {
        <div class="au-alert"><lucide-icon [img]="AlertIcon" [size]="15"></lucide-icon> {{ error() }}</div>
      }

      @if (summary(); as s) {
        <!-- ── ASSISTANCE IA PAR SOCIÉTÉ (opt-in owner) ── -->
        @if (isSuperAdmin()) {
          @if (s.scopedFleet; as sf) {
            <section class="au-ai" [attr.data-on]="sf.aiEnabled">
              <div class="au-ai-main">
                <div class="au-ai-ico" [attr.data-on]="sf.aiEnabled"><lucide-icon [img]="PowerIcon" [size]="18"></lucide-icon></div>
                <div class="au-ai-txt">
                  <span class="au-ai-title">Assistance IA — {{ sf.name }}</span>
                  <span class="au-ai-sub">
                    @if (sf.aiEnabled) { <strong>Active</strong> — récit de trajet, agent d'agenda, optimiseur et saisie vocale sont disponibles pour cette société. }
                    @else { <strong>Désactivée</strong> — l'analyse déterministe (trajets, stations, scores) reste disponible ; seuls les services IA sont coupés. }
                  </span>
                </div>
              </div>
              <label class="au-ai-sw" [class.au-ai-sw--busy]="savingAi()">
                @if (savingAi()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="au-spin"></lucide-icon> }
                <input type="checkbox" [checked]="sf.aiEnabled" [disabled]="savingAi()" (change)="toggleFleetAi($any($event.target).checked)" aria-label="Activer l'IA pour cette société">
                <span class="au-ai-sw-track"><span class="au-ai-sw-knob"></span></span>
              </label>
            </section>
          } @else {
            <div class="au-ai-hint"><lucide-icon [img]="PowerIcon" [size]="14"></lucide-icon> Sélectionnez une société dans le sélecteur en haut pour activer ou couper son IA (l'IA est <strong>désactivée par défaut</strong>).</div>
          }
        }

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

        <!-- ── PRIX DE L'OPTION IA (super-admin — configurable) ── -->
        @if (isSuperAdmin()) {
          <section class="au-prov-panel">
            <div class="au-prov-head">
              <span class="au-budget-label"><lucide-icon [img]="TagIcon" [size]="14"></lucide-icon> Prix de l'option IA</span>
              <span class="au-prov-note">Ce que paie une société pour activer l'IA (abonnement mensuel). Modifiable à tout moment ; l'IA « offerte » (toggle ci-dessus) ne facture rien.</span>
            </div>
            <div class="au-budget-edit">
              <input type="number" min="0" step="0.5" inputmode="decimal" [value]="priceInput()" (input)="priceInput.set($any($event.target).value)" placeholder="ex. 5" />
              <span class="au-price-unit">€ /
                <select class="au-price-select" [value]="pricingUnit()" (change)="pricingUnit.set($any($event.target).value)">
                  <option value="per_vehicle">véhicule</option>
                  <option value="flat">société</option>
                </select>
                / mois</span>
              <button type="button" class="au-btn" [disabled]="savingPrice()" (click)="savePrice()">
                @if (savingPrice()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="au-spin"></lucide-icon> } @else { <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon> }
                Enregistrer
              </button>
              @if (priceUpdatedAt()) { <span class="au-budget-hint">Dernière mise à jour : {{ priceUpdatedAt() | date:'dd/MM HH:mm' }}</span> }
            </div>
          </section>
        }

        <!-- ── SWITCHBOARD IA (kill-switches globaux par fonctionnalité, super-admin) ── -->
        @if (isSuperAdmin() && features(); as ff) {
          <section class="au-prov-panel">
            <div class="au-prov-head">
              <span class="au-budget-label"><lucide-icon [img]="LayersIcon" [size]="14"></lucide-icon> Fonctionnalités IA</span>
              <span class="au-prov-note">Coupe une fonction IA <strong>pour tout le monde</strong> (par-dessus l'abonnement des sociétés). Défaut : tout actif.</span>
            </div>
            <div class="au-feat-list">
              @for (f of aiFeatures; track f.key) {
                <div class="au-feat" [class.au-feat--owner]="f.owner">
                  <div class="au-feat-txt">
                    <span class="au-feat-lbl">{{ f.label }}@if (f.owner) { <span class="au-feat-tag">Mon outil</span> }</span>
                    <span class="au-feat-desc">{{ f.desc }}</span>
                  </div>
                  <label class="au-ai-sw" [class.au-ai-sw--busy]="savingFeature() === f.key">
                    @if (savingFeature() === f.key) { <lucide-icon [img]="LoaderIcon" [size]="14" class="au-spin"></lucide-icon> }
                    <input type="checkbox" [checked]="ff[f.key]" [disabled]="savingFeature() !== null" (change)="toggleFeature(f.key, $any($event.target).checked)" [attr.aria-label]="f.label">
                    <span class="au-ai-sw-track"><span class="au-ai-sw-knob"></span></span>
                  </label>
                </div>
              }
            </div>
          </section>
        }

        <!-- ── MOTEUR IA (switch Claude ↔ GPT, super-admin) ── -->
        @if (isSuperAdmin() && provider(); as prov) {
          <section class="au-prov-panel">
            <div class="au-prov-head">
              <span class="au-budget-label"><lucide-icon [img]="CpuIcon" [size]="14"></lucide-icon> Moteur IA</span>
              <span class="au-prov-note">Appliqué à tous les appels IA (agenda, rapports, analyse de trajets…).</span>
            </div>
            <div class="au-prov-grid">
              @for (p of prov.providers; track p.id) {
                <button type="button" class="au-prov"
                        [class.on]="prov.provider === p.id"
                        [disabled]="savingProvider() !== null"
                        (click)="switchProvider(p.id)">
                  <div class="au-prov-top">
                    <span class="au-prov-name">{{ p.label }}</span>
                    @if (savingProvider() === p.id) {
                      <lucide-icon [img]="LoaderIcon" [size]="13" class="au-spin"></lucide-icon>
                    } @else if (prov.provider === p.id) {
                      <span class="au-prov-badge"><lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Actif</span>
                    } @else if (!p.configured) {
                      <span class="au-prov-badge au-prov-badge--off">Clé manquante</span>
                    }
                  </div>
                  <span class="au-prov-hint">{{ p.hint }}</span>
                </button>
              }
              <!-- Mode MIXTE : les 2 moteurs + un agent qui combine. -->
              <button type="button" class="au-prov au-prov--mixte"
                      [class.on]="prov.provider === 'both'"
                      [disabled]="savingProvider() !== null || !prov.mixteAvailable"
                      (click)="switchProvider('both')">
                <div class="au-prov-top">
                  <span class="au-prov-name">Les 2 — Mixte ✨</span>
                  @if (savingProvider() === 'both') {
                    <lucide-icon [img]="LoaderIcon" [size]="13" class="au-spin"></lucide-icon>
                  } @else if (prov.provider === 'both') {
                    <span class="au-prov-badge"><lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Actif</span>
                  } @else if (!prov.mixteAvailable) {
                    <span class="au-prov-badge au-prov-badge--off">2 clés requises</span>
                  }
                </div>
                <span class="au-prov-hint">GPT et Claude analysent chacun, puis un agent Tracky combine le meilleur des deux. Résultat optimal (coût plus élevé) — sur l'analyse de trajets.</span>
              </button>
            </div>
            @if (activeProviderUnconfigured(); as name) {
              <div class="au-prov-warn">
                <lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon>
                Le moteur « {{ name }} » n'a pas de clé API côté serveur : les appels basculent sur un moteur disponible. Ajoutez la clé pour l'activer réellement.
              </div>
            }
          </section>
        }

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

    /* Filtre JOUR précis */
    .au-day { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); }
    .au-day--on { border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 45%, transparent); color: var(--fg-secondary); }
    .au-day input { border: 0; background: transparent; color: var(--fg-primary); font-size: 12.5px; font-family: inherit; padding: 0; }

    /* Assistance IA par société (opt-in owner) */
    .au-ai { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px 18px; border-radius: 16px; background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); }
    .au-ai[data-on="true"] { border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 42%, transparent); background: color-mix(in srgb, var(--tracky-light, #10E0A0) 6%, var(--bg-secondary)); }
    .au-ai-main { display: flex; align-items: center; gap: 13px; min-width: 0; }
    .au-ai-ico { width: 40px; height: 40px; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: var(--bg-tertiary); color: var(--fg-tertiary); flex-shrink: 0; }
    .au-ai-ico[data-on="true"] { background: rgba(16,224,160,.14); color: var(--tracky-light, #10E0A0); }
    .au-ai-txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .au-ai-title { font-size: 14.5px; font-weight: 800; color: var(--fg-primary); }
    .au-ai-sub { font-size: 12px; color: var(--fg-tertiary); line-height: 1.4; }
    .au-ai-sub strong { color: var(--fg-secondary); }
    /* Interrupteur */
    .au-ai-sw { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; flex-shrink: 0; }
    .au-ai-sw input { position: absolute; opacity: 0; width: 0; height: 0; }
    .au-ai-sw-track { width: 46px; height: 26px; border-radius: 999px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); position: relative; transition: background .18s; }
    .au-ai-sw-knob { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: var(--fg-tertiary); transition: transform .18s, background .18s; }
    .au-ai-sw input:checked + .au-ai-sw-track { background: var(--tracky, #10B981); border-color: transparent; }
    .au-ai-sw input:checked + .au-ai-sw-track .au-ai-sw-knob { transform: translateX(20px); background: #fff; }
    .au-ai-sw--busy { opacity: .6; pointer-events: none; }
    .au-ai-hint { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-radius: 12px; background: var(--bg-secondary); border: 1px dashed var(--border-subtle); color: var(--fg-tertiary); font-size: 12.5px; }
    .au-ai-hint strong { color: var(--fg-secondary); }

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
    .au-price-unit { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--fg-secondary); }
    .au-price-select { padding: 6px 8px; border-radius: 8px; background: var(--bg-primary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 12.5px; font-family: inherit; }
    /* Switchboard fonctionnalités IA */
    .au-feat-list { display: flex; flex-direction: column; gap: 8px; }
    .au-feat { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 13px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .au-feat--owner { border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 30%, transparent); background: color-mix(in srgb, var(--tracky-light, #10E0A0) 5%, var(--bg-tertiary)); }
    .au-feat-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .au-feat-lbl { font-size: 13px; font-weight: 700; color: var(--fg-primary); display: inline-flex; align-items: center; gap: 7px; }
    .au-feat-tag { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 6px; border-radius: 999px; background: rgba(16,224,160,.16); color: var(--tracky-light, #10E0A0); }
    .au-feat-desc { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.4; }

    /* Moteur IA (switch Claude ↔ GPT) */
    .au-prov-panel { padding: 18px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 12px; }
    .au-prov-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    .au-prov-note { font-size: 11.5px; color: var(--fg-tertiary); }
    .au-prov-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    @media (max-width: 720px) { .au-prov-grid { grid-template-columns: 1fr; } }
    .au-prov--mixte.on { border-color: #A78BFA; background: color-mix(in srgb, #A78BFA 9%, var(--bg-tertiary)); }
    .au-prov--mixte .au-prov-name { color: var(--fg-primary); }
    .au-prov { text-align: left; display: flex; flex-direction: column; gap: 5px; padding: 13px 14px; border-radius: 12px; border: 1.5px solid var(--border-subtle); background: var(--bg-tertiary); cursor: pointer; transition: border-color .15s, background .15s; }
    .au-prov:hover:not(:disabled) { border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 45%, transparent); }
    .au-prov.on { border-color: var(--tracky-light, #10E0A0); background: color-mix(in srgb, var(--tracky-light, #10E0A0) 8%, var(--bg-tertiary)); }
    .au-prov:disabled { cursor: not-allowed; opacity: .6; }
    .au-prov.on:disabled { opacity: 1; }
    .au-prov-top { display: flex; align-items: center; gap: 8px; }
    .au-prov-name { font-size: 13.5px; font-weight: 800; color: var(--fg-primary); }
    .au-prov-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--tracky-light, #10E0A0) 18%, transparent); color: var(--tracky-light, #10E0A0); }
    .au-prov-badge--off { background: color-mix(in srgb, var(--danger, #EF4444) 14%, transparent); color: var(--danger, #EF4444); }
    .au-prov-hint { font-size: 11.5px; color: var(--fg-secondary); line-height: 1.35; }
    .au-prov-warn { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; line-height: 1.4; color: var(--danger, #EF4444); background: color-mix(in srgb, var(--danger, #EF4444) 9%, transparent); border-radius: 9px; padding: 8px 10px; }

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
  private readonly aiStatus = inject(AiStatusService);
  private readonly billing = inject(BillingApiService);
  private readonly auth = inject(AuthService);
  private readonly fleet = inject(FleetFilterService);
  private readonly toast = inject(ToastService);
  /** Le budget (plafond global) n'est éditable que par un super-admin ; un fleet-admin est en lecture seule scopée. */
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  /** Société filtrée dans le sélecteur global du top-bar (null = toutes). */
  protected readonly selectedFleetId = this.fleet.selectedFleetId;

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
  protected readonly CpuIcon = Cpu;
  protected readonly CalendarIcon = Calendar;
  protected readonly PowerIcon = Power;
  protected readonly TagIcon = Tag;

  protected readonly periods: { key: Period; label: string }[] = [
    { key: '24h', label: '24 h' },
    { key: '7d', label: '7 j' },
    { key: '30d', label: '30 j' },
  ];

  protected readonly period = signal<Period>('30d');
  /** Filtre JOUR précis (YYYY-MM-DD) — prime sur la période quand renseigné ('' = période active). */
  protected readonly day = signal<string>('');
  protected readonly tab = signal<BreakdownTab>('user');
  protected readonly summary = signal<AiUsageSummaryDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly budgetInput = signal<string>('');
  protected readonly savingBudget = signal(false);
  /** Bascule de l'interrupteur maître IA de la société scopée. */
  protected readonly savingAi = signal(false);
  /** Prix configurable de l'option IA (super-admin). `priceInput` en EUROS (converti en centimes). */
  protected readonly priceInput = signal<string>('');
  protected readonly pricingUnit = signal<'per_vehicle' | 'flat'>('per_vehicle');
  protected readonly savingPrice = signal(false);
  protected readonly priceUpdatedAt = signal<string | null>(null);
  /** Switchboard — interrupteurs globaux par fonctionnalité IA (super-admin). */
  protected readonly features = signal<AiFeatureFlagsDto | null>(null);
  protected readonly savingFeature = signal<AiFeatureKey | null>(null);
  protected readonly aiFeatures: { key: AiFeatureKey; label: string; desc: string; owner?: boolean }[] = [
    { key: 'tripAnalysis', label: 'Récit IA de trajet', desc: 'Résumé vulgarisé + Trust Score + conseils, par trajet.' },
    { key: 'agendaAgent', label: 'Agent d’agenda', desc: 'Analyse nocturne + propositions de réservation.' },
    { key: 'capacity', label: 'Optimiseur — capacités', desc: 'Déduction des places / sièges-enfant par modèle.' },
    { key: 'placement', label: 'Optimiseur — placement', desc: 'Classement des véhicules pour une réservation.' },
    { key: 'bookingParse', label: 'Saisie vocale (réservations)', desc: 'Dictée du besoin sur les liens publics.' },
    { key: 'activityReport', label: 'Rapport d’activité IA', desc: 'Ton outil super-admin (analyse de l’activité). Personne d’autre n’y a accès.', owner: true },
  ];

  /** Dernière société chargée (undefined = pas encore initialisé) — pour ne recharger QUE sur vrai changement. */
  private lastFleetId: string | null | undefined = undefined;

  constructor() {
    // Rechargement AUTO quand la société du sélecteur global change (le filtre société doit « marcher »).
    // On track UNIQUEMENT selectedFleetId ; le reload (qui lit période/jour) tourne en untracked.
    // Le 1er run enregistre juste la valeur initiale (le chargement initial est fait par ngOnInit).
    effect(() => {
      const fid = this.selectedFleetId();
      untracked(() => {
        if (this.lastFleetId === undefined) { this.lastFleetId = fid; return; }
        if (fid === this.lastFleetId) return;
        this.lastFleetId = fid;
        void this.reload();
      });
    });
  }

  /** Switch de moteur IA (Claude ↔ GPT) — super-admin. */
  protected readonly provider = signal<AiProviderSettingsDto | null>(null);
  protected readonly savingProvider = signal<AiProviderMode | null>(null);

  protected readonly logRows = signal<AiUsageLogRowDto[]>([]);
  protected readonly logCursor = signal<string | null>(null);
  protected readonly loadingMore = signal(false);
  protected readonly logAction = signal<string | undefined>(undefined);

  protected readonly activeBreakdown = computed<AiUsageBreakdownRowDto[]>(() => {
    const s = this.summary();
    if (!s) return [];
    return this.tab() === 'user' ? s.byUser : this.tab() === 'fleet' ? s.byFleet : s.byAction;
  });

  /** Libellé du moteur actif s'il n'a PAS de clé (→ avertissement de repli), sinon null. */
  protected readonly activeProviderUnconfigured = computed<string | null>(() => {
    const p = this.provider();
    if (!p) return null;
    const active = p.providers.find((x) => x.id === p.provider);
    return active && !active.configured ? active.label : null;
  });

  protected periodLabel(): string {
    const d = this.day();
    if (d) return `le ${d.split('-').reverse().join('/')}`;
    return this.period() === '24h' ? '24 dernières heures' : this.period() === '7d' ? '7 derniers jours' : '30 derniers jours';
  }

  /** Date du jour (YYYY-MM-DD) — borne max de l'input date (pas de filtre sur le futur). */
  protected todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  ngOnInit(): void {
    this.lastFleetId = this.selectedFleetId();
    void this.reload();
  }

  protected setPeriod(p: Period): void {
    // Période et JOUR précis sont exclusifs : choisir une période efface le filtre jour.
    if (p === this.period() && !this.day()) return;
    this.period.set(p);
    this.day.set('');
    void this.reload();
  }

  /** Filtre sur un JOUR précis (input date). '' = revenir à la période glissante. */
  protected setDay(value: string): void {
    if (value === this.day()) return;
    this.day.set(value);
    void this.reload();
  }

  /** Fenêtre [from,to] envoyée à l'API : un JOUR précis si `day` est renseigné, sinon la période glissante. */
  private range(): { from: string; to?: string } {
    const d = this.day();
    if (d) {
      // Bornes du jour choisi en heure LOCALE de l'opérateur (converties en UTC pour l'API).
      return { from: new Date(`${d}T00:00:00`).toISOString(), to: new Date(`${d}T23:59:59.999`).toISOString() };
    }
    const days = this.period() === '24h' ? 1 : this.period() === '7d' ? 7 : 30;
    return { from: new Date(Date.now() - days * 24 * 3600 * 1000).toISOString() };
  }

  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const { from, to } = this.range();
      const fleetId = this.selectedFleetId() ?? undefined;
      const s = await firstValueFrom(this.api.summary(from, to, fleetId));
      this.summary.set(s);
      if (this.budgetInput() === '' && s.budget.monthlyBudgetEur > 0) {
        this.budgetInput.set(String(s.budget.monthlyBudgetEur));
      }
      await this.loadLogs(true);
      // Moteur IA + prix de l'option IA (super-admin uniquement ; endpoints gardés). Non bloquant.
      if (this.isSuperAdmin()) {
        try {
          this.provider.set(await firstValueFrom(this.api.getProvider()));
        } catch {
          /* ignore : le switch reste masqué si l'appel échoue */
        }
        try {
          const p = await firstValueFrom(this.billing.getPrice());
          if (this.priceInput() === '') this.priceInput.set((p.aiUnitAmountEurCents / 100).toString());
          this.pricingUnit.set(p.aiPricingUnit);
          this.priceUpdatedAt.set(p.updatedAt);
        } catch {
          /* ignore : l'éditeur de prix garde ses valeurs */
        }
        try {
          this.features.set(await firstValueFrom(this.api.getFeatures()));
        } catch {
          /* ignore : le switchboard reste masqué si l'appel échoue */
        }
      }
    } catch (e) {
      this.error.set(this.errMsg(e));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * OFFERT (COMP) — l'owner active/coupe l'IA d'une société GRATUITEMENT (sans abonnement). Passe par
   * /api/billing/comp (statut COMP + synchro aiEnabled) au lieu de l'ancien toggle brut. Le paiement,
   * lui, se fait côté fleet-admin (onglet Facturation).
   */
  protected async toggleFleetAi(enabled: boolean): Promise<void> {
    const scoped = this.summary()?.scopedFleet;
    if (!scoped || this.savingAi()) return;
    this.savingAi.set(true);
    try {
      await firstValueFrom(this.billing.comp(scoped.id, enabled));
      const s = this.summary();
      if (s?.scopedFleet) this.summary.set({ ...s, scopedFleet: { ...s.scopedFleet, aiEnabled: enabled } });
      this.aiStatus.refresh(); // resynchronise l'état IA global du front
      this.toast.success('Assistance IA', enabled ? `Offerte à ${scoped.name}.` : `Coupée pour ${scoped.name}.`);
    } catch (e) {
      this.toast.error('Assistance IA', this.errMsg(e));
    } finally {
      this.savingAi.set(false);
    }
  }

  /** Enregistre le prix configurable de l'option IA (super-admin). Saisi en euros → stocké en centimes. */
  protected async savePrice(): Promise<void> {
    const euros = Number(this.priceInput().replace(',', '.'));
    if (!Number.isFinite(euros) || euros < 0) {
      this.toast.error('Prix invalide', 'Entrez un montant ≥ 0.');
      return;
    }
    this.savingPrice.set(true);
    try {
      const p = await firstValueFrom(this.billing.setPrice(Math.round(euros * 100), this.pricingUnit()));
      this.priceUpdatedAt.set(p.updatedAt);
      this.toast.success('Prix enregistré', `${euros.toFixed(2)} € / ${this.pricingUnit() === 'per_vehicle' ? 'véhicule' : 'société'} / mois`);
    } catch (e) {
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.savingPrice.set(false);
    }
  }

  /** Coupe/active une fonctionnalité IA POUR TOUT LE MONDE (kill-switch global, super-admin). */
  protected async toggleFeature(key: AiFeatureKey, enabled: boolean): Promise<void> {
    if (this.savingFeature()) return;
    this.savingFeature.set(key);
    try {
      this.features.set(await firstValueFrom(this.api.setFeature(key, enabled)));
      this.aiStatus.refresh();
      this.toast.success('Fonctionnalité IA', enabled ? 'Activée pour tout le monde.' : 'Coupée pour tout le monde.');
    } catch (e) {
      this.toast.error('Fonctionnalité IA', this.errMsg(e));
    } finally {
      this.savingFeature.set(null);
    }
  }

  /** Bascule le mode IA global (Claude / GPT / les 2 mixte). */
  protected async switchProvider(id: AiProviderMode): Promise<void> {
    const cur = this.provider();
    if (!cur || cur.provider === id || this.savingProvider() !== null) return;
    this.savingProvider.set(id);
    try {
      const updated = await firstValueFrom(this.api.setProvider(id));
      this.provider.set(updated);
      const name = id === 'both' ? 'Mixte (les 2 IA)' : (updated.providers.find((p) => p.id === id)?.label ?? id);
      this.toast.success('Moteur IA', `Bascule sur ${name}.`);
    } catch (e) {
      this.toast.error('Moteur IA', this.errMsg(e));
    } finally {
      this.savingProvider.set(null);
    }
  }

  private async loadLogs(reset: boolean): Promise<void> {
    // Journal scopé par SOCIÉTÉ (sélecteur global) et, si un JOUR précis est filtré, borné à ce jour.
    const { from, to } = this.range();
    const dayFilter = !!this.day();
    const fleetId = this.selectedFleetId() ?? undefined;
    const before = reset ? (dayFilter ? to : undefined) : (this.logCursor() ?? undefined);
    const page = await firstValueFrom(
      this.api.logs({ limit: 30, action: this.logAction(), fleetId, before, after: dayFilter ? from : undefined }),
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
  private static readonly ACTION_LABELS: Record<string, string> = {
    capacity: 'Capacité', placement: 'Placement', agenda_optimization: 'Agenda (agent)',
    agenda_agent: 'Agent agenda', activity_report: "Rapport d'activité",
    trip_analysis: 'Analyse de trajet', booking_parse: 'Réservation (vocal)',
  };
  protected actionLabel(a: string): string {
    return AdminAiUsageComponent.ACTION_LABELS[a] ?? a;
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
