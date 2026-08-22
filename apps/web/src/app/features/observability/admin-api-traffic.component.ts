import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, ChevronLeft, Globe, RefreshCw, AlertTriangle, Loader,
  Radio, Bot, Network, ShieldQuestion, UserCheck, Fingerprint,
  ArrowRightLeft, ScanSearch, Gauge, Filter,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { relativeTime } from '../../shared/utils/relative-time';
import {
  ApiTrafficService,
  type ApiTrafficEntryDto,
  type ApiTrafficKind,
  type ApiTrafficSummaryDto,
  type IpIntelligenceRowDto,
  type StatusClass,
} from '../../core/services/api-traffic.service';

type WindowKey = '24h' | '7d' | '30d';
type IpScope = 'all' | 'known' | 'unknown';
type StatusFilter = '' | StatusClass;

const STATUS_CLASSES: StatusClass[] = ['2xx', '3xx', '4xx', '5xx'];
const STATUS_COLORS: Record<StatusClass, string> = {
  '2xx': '#34d399',
  '3xx': '#60a5fa',
  '4xx': '#fbbf24',
  '5xx': '#f87171',
};

/**
 * Observabilité API publique — supervision du trafic entrant (LP / Maestroo / API / Webhook)
 * et intelligence IP (connues vs inconnues, détection de scan/bot). Réservé SUPER_ADMIN.
 *
 * Trois sections : bandeau de KPIs (/summary), tableau d'intelligence IP (/ips) et flux
 * paginé par curseur (/api-traffic). Fenêtre glissante 24h / 7j / 30j.
 */
@Component({
  selector: 'app-admin-api-traffic',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, DecimalPipe, LucideAngularModule],
  template: `
    <div class="at">
      <!-- ── Header ── -->
      <a routerLink="/admin" class="at-back"><lucide-icon [img]="BackIcon" [size]="15"></lucide-icon> Administration</a>
      <header class="at-head">
        <div class="at-title">
          <div class="at-ico"><lucide-icon [img]="GlobeIcon" [size]="22"></lucide-icon></div>
          <div>
            <h1>Observabilité API publique</h1>
            <p>Trafic entrant &amp; intelligence IP — {{ windowLabel() }}.</p>
          </div>
        </div>
        <div class="at-actions">
          <div class="at-seg">
            @for (w of windows; track w.key) {
              <button type="button" (click)="setWindow(w.key)" [class.on]="windowKey() === w.key">{{ w.label }}</button>
            }
          </div>
          <label class="at-auto" [class.at-auto--on]="autoRefresh()" title="Rafraîchissement automatique (10 s)">
            <input type="checkbox" [checked]="autoRefresh()" (change)="toggleAuto($any($event.target).checked)">
            <span class="at-auto-dot"></span> Auto
          </label>
          <button type="button" class="at-refresh" (click)="reload()" [disabled]="loading()" aria-label="Rafraîchir">
            <lucide-icon [img]="RefreshIcon" [size]="15" [class.at-spin]="loading()"></lucide-icon>
          </button>
        </div>
      </header>

      @if (error()) {
        <div class="at-alert"><lucide-icon [img]="AlertIcon" [size]="15"></lucide-icon> {{ error() }}</div>
      }

      <!-- ════════════ 1) KPIs ════════════ -->
      @if (summary(); as s) {
        <section class="at-kpis">
          <div class="at-kpi">
            <span class="at-kpi-n">{{ s.totalRequests | number:'1.0-0' }}</span>
            <span class="at-kpi-l"><lucide-icon [img]="ArrowsIcon" [size]="12"></lucide-icon> Requêtes</span>
          </div>
          <div class="at-kpi">
            <span class="at-kpi-n">{{ s.totalPartnerEvents | number:'1.0-0' }}</span>
            <span class="at-kpi-l"><lucide-icon [img]="BotIcon" [size]="12"></lucide-icon> Évts partenaires</span>
          </div>
          <div class="at-kpi">
            <span class="at-kpi-n">{{ s.uniqueIps | number:'1.0-0' }}</span>
            <span class="at-kpi-l"><lucide-icon [img]="NetworkIcon" [size]="12"></lucide-icon> IP uniques</span>
            <span class="at-kpi-sub">{{ s.knownIps | number:'1.0-0' }} connues</span>
          </div>
          <div class="at-kpi" [class.at-kpi--hot]="unknownHot()">
            <span class="at-kpi-n">{{ s.unknownIps | number:'1.0-0' }}</span>
            <span class="at-kpi-l"><lucide-icon [img]="ShieldQIcon" [size]="12"></lucide-icon> IP inconnues</span>
            @if (unknownHot()) { <span class="at-kpi-flag"><lucide-icon [img]="ScanIcon" [size]="11"></lucide-icon> à surveiller</span> }
          </div>
        </section>

        <div class="at-split">
          <!-- Répartition par source -->
          <section class="at-panel">
            <div class="at-panel-head"><h2><lucide-icon [img]="RadioIcon" [size]="15"></lucide-icon> Par source</h2></div>
            @if (sourceRows(s).length === 0) {
              <p class="at-empty-sm">Aucun trafic sur la période.</p>
            } @else {
              <div class="at-bars">
                @for (r of sourceRows(s); track r.key) {
                  <div class="at-brow">
                    <div class="at-brow-top">
                      <span class="at-src" [style.--c]="sourceColor(r.key)">{{ sourceLabel(r.key) }}</span>
                      <span class="at-brow-n">{{ r.value | number:'1.0-0' }}</span>
                    </div>
                    <div class="at-bar"><div class="at-bar-fill" [style.width.%]="pct(r.value, maxSource(s))" [style.background]="sourceColor(r.key)"></div></div>
                  </div>
                }
              </div>
            }
          </section>

          <!-- Répartition par classe de statut -->
          <section class="at-panel">
            <div class="at-panel-head"><h2><lucide-icon [img]="GaugeIcon" [size]="15"></lucide-icon> Par statut</h2></div>
            @if (statusTotal(s) === 0) {
              <p class="at-empty-sm">Aucune réponse enregistrée.</p>
            } @else {
              <div class="at-stackbar">
                @for (c of statusClasses; track c) {
                  @if (s.byStatusClass[c] > 0) {
                    <span class="at-stackseg" [style.width.%]="pct(s.byStatusClass[c], statusTotal(s))"
                          [style.background]="statusColor(c)" [title]="c + ' — ' + s.byStatusClass[c]"></span>
                  }
                }
              </div>
              <div class="at-status-legend">
                @for (c of statusClasses; track c) {
                  <span class="at-leg"><span class="at-leg-dot" [style.background]="statusColor(c)"></span>{{ c }} <b>{{ s.byStatusClass[c] | number:'1.0-0' }}</b></span>
                }
              </div>
            }
          </section>
        </div>

        <!-- Top chemins + top IP inconnues -->
        <div class="at-split">
          <section class="at-panel">
            <div class="at-panel-head"><h2>Chemins les plus appelés</h2></div>
            @if (s.topPaths.length === 0) {
              <p class="at-empty-sm">Aucune donnée.</p>
            } @else {
              <div class="at-list">
                @for (p of s.topPaths; track p.path) {
                  <div class="at-li"><span class="at-li-txt mono" [title]="p.path">{{ p.path }}</span><span class="at-li-n">{{ p.count | number:'1.0-0' }}</span></div>
                }
              </div>
            }
          </section>
          <section class="at-panel">
            <div class="at-panel-head"><h2><lucide-icon [img]="ScanIcon" [size]="15"></lucide-icon> Top IP inconnues</h2></div>
            @if (s.topUnknownIps.length === 0) {
              <p class="at-empty-sm">Aucune IP inconnue sur la période.</p>
            } @else {
              <div class="at-list">
                @for (u of s.topUnknownIps; track u.ip) {
                  <div class="at-li">
                    <span class="at-li-txt mono">{{ u.ip }}</span>
                    <span class="at-li-meta">{{ relativeTime(u.lastSeen) }}</span>
                    <span class="at-li-n at-li-n--warn">{{ u.count | number:'1.0-0' }}</span>
                  </div>
                }
              </div>
            }
          </section>
        </div>
      } @else if (loading()) {
        <div class="at-skel"></div><div class="at-skel"></div>
      }

      <!-- ════════════ 2) Intelligence IP ════════════ -->
      <section class="at-panel">
        <div class="at-panel-head">
          <h2><lucide-icon [img]="FingerIcon" [size]="15"></lucide-icon> Intelligence IP</h2>
          <div class="at-seg at-seg--sm">
            <button type="button" (click)="setIpScope('all')" [class.on]="ipScope() === 'all'">Toutes</button>
            <button type="button" (click)="setIpScope('known')" [class.on]="ipScope() === 'known'">Connues</button>
            <button type="button" (click)="setIpScope('unknown')" [class.on]="ipScope() === 'unknown'">Inconnues</button>
          </div>
        </div>
        <p class="at-hint"><lucide-icon [img]="ScanIcon" [size]="13"></lucide-icon> Une IP <strong>inconnue</strong> à forte fréquence est signalée (bot / scan potentiel).</p>
        <div class="at-table-wrap">
          <table class="at-table">
            <thead>
              <tr><th>IP</th><th>Origine</th><th class="r">Occur.</th><th>Sources</th><th>Statuts</th><th>Dernier chemin</th><th class="r">Vue</th></tr>
            </thead>
            <tbody>
              @for (r of filteredIps(); track r.ip) {
                <tr [class.at-row-suspect]="isSuspect(r)">
                  <td class="mono at-td-ip">
                    {{ r.ip }}
                    @if (isSuspect(r)) { <span class="at-suspect"><lucide-icon [img]="ScanIcon" [size]="10"></lucide-icon> scan?</span> }
                  </td>
                  <td>
                    @if (r.known) {
                      <span class="at-badge at-badge--known"><lucide-icon [img]="UserCheckIcon" [size]="11"></lucide-icon> {{ r.knownUserName || 'Connue' }}</span>
                    } @else {
                      <span class="at-badge at-badge--unknown"><lucide-icon [img]="ShieldQIcon" [size]="11"></lucide-icon> Inconnue</span>
                    }
                  </td>
                  <td class="r"><b>{{ r.count | number:'1.0-0' }}</b></td>
                  <td>
                    <div class="at-chips">
                      @for (src of r.sources; track src) {
                        <span class="at-chip" [style.--c]="sourceColor(src)">{{ sourceLabel(src) }}</span>
                      } @empty { <span class="at-dim">—</span> }
                    </div>
                  </td>
                  <td>
                    <div class="at-ministack" [title]="ipStatusTitle(r)">
                      @for (seg of ipStatusSegments(r); track seg.cls) {
                        <span class="at-ministack-seg" [style.width.%]="seg.pct" [style.background]="seg.color"></span>
                      } @empty { <span class="at-dim">—</span> }
                    </div>
                  </td>
                  <td class="mono at-td-path" [title]="r.lastPath || ''">{{ r.lastPath || '—' }}</td>
                  <td class="r at-dim" [title]="(r.lastSeen | date:'dd/MM/yyyy HH:mm:ss') || ''">{{ relativeTime(r.lastSeen) }}</td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="at-empty-sm">{{ loading() ? 'Chargement…' : 'Aucune IP sur la période.' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <!-- ════════════ 3) Flux ════════════ -->
      <section class="at-panel">
        <div class="at-panel-head">
          <h2><lucide-icon [img]="ArrowsIcon" [size]="15"></lucide-icon> Flux</h2>
        </div>

        <!-- Filtres -->
        <div class="at-filters">
          <label class="at-field">
            <span><lucide-icon [img]="FilterIcon" [size]="12"></lucide-icon> Source</span>
            <select [value]="fSource()" (change)="setSource($any($event.target).value)">
              <option value="">Toutes</option>
              @for (o of sourceOptions(); track o) { <option [value]="o">{{ sourceLabel(o) }}</option> }
            </select>
          </label>
          <label class="at-field">
            <span>Type</span>
            <select [value]="fKind()" (change)="setKind($any($event.target).value)">
              <option value="">Tous</option>
              <option value="REQUEST">Requêtes</option>
              <option value="PARTNER_EVENT">Évts partenaires</option>
            </select>
          </label>
          <label class="at-field">
            <span>Statut</span>
            <select [value]="fStatus()" (change)="setStatus($any($event.target).value)">
              <option value="">Tous</option>
              @for (c of statusClasses; track c) { <option [value]="c">{{ c }}</option> }
            </select>
          </label>
          <div class="at-field">
            <span>IP</span>
            <div class="at-seg at-seg--sm">
              <button type="button" (click)="setFluxScope('all')" [class.on]="fluxScope() === 'all'">Toutes</button>
              <button type="button" (click)="setFluxScope('known')" [class.on]="fluxScope() === 'known'">Connues</button>
              <button type="button" (click)="setFluxScope('unknown')" [class.on]="fluxScope() === 'unknown'">Inconnues</button>
            </div>
          </div>
        </div>

        <div class="at-table-wrap">
          <table class="at-table">
            <thead>
              <tr><th>Heure</th><th>Type</th><th>Source</th><th>Détail</th><th class="r">Statut</th><th>IP</th><th class="r">Durée</th></tr>
            </thead>
            <tbody>
              @for (e of entries(); track e.id) {
                <tr>
                  <td class="at-dim at-td-time" [title]="(e.createdAt | date:'dd/MM/yyyy HH:mm:ss') || ''">{{ e.createdAt | date:'dd/MM HH:mm:ss' }}</td>
                  <td>
                    @if (e.kind === 'PARTNER_EVENT') {
                      <span class="at-kind at-kind--evt"><lucide-icon [img]="BotIcon" [size]="11"></lucide-icon> évt</span>
                    } @else {
                      <span class="at-method" [attr.data-m]="e.method">{{ e.method || '—' }}</span>
                    }
                  </td>
                  <td><span class="at-chip" [style.--c]="sourceColor(e.source)">{{ sourceLabel(e.source) }}</span></td>
                  <td class="at-td-detail">
                    @if (e.kind === 'PARTNER_EVENT') {
                      <span class="at-evt">{{ e.action || 'événement' }}@if (e.target) { <span class="at-evt-target"> · {{ e.target }}</span> }</span>
                    } @else {
                      <span class="mono at-path" [title]="e.path || ''">{{ e.path || '—' }}</span>
                    }
                  </td>
                  <td class="r">
                    @if (e.statusCode != null) {
                      <span class="at-code" [style.color]="statusColor(statusClassOf(e.statusCode))">{{ e.statusCode }}</span>
                    } @else { <span class="at-dim">—</span> }
                  </td>
                  <td class="mono at-td-ip2">
                    @if (e.ip) {
                      <span class="at-ip-dot" [class.at-ip-dot--known]="e.ipKnown" [title]="e.ipKnown ? 'IP connue' : 'IP inconnue'"></span>{{ e.ip }}
                    } @else { <span class="at-dim">—</span> }
                  </td>
                  <td class="r at-dim">{{ e.durationMs != null ? (e.durationMs | number:'1.0-0') + ' ms' : '—' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="at-empty-sm">{{ loading() ? 'Chargement…' : 'Aucune entrée pour ces filtres.' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
        @if (hasMore()) {
          <button type="button" class="at-more" (click)="loadMore()" [disabled]="loadingMore()">
            @if (loadingMore()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="at-spin"></lucide-icon> } Charger plus
          </button>
        }
      </section>
    </div>
  `,
  styles: [`
    .at { max-width: 1120px; display: flex; flex-direction: column; gap: 16px; }
    .mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
    .at-back { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--fg-tertiary); text-decoration: none; width: fit-content; }
    .at-back:hover { color: var(--fg-secondary); }
    .at-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .at-title { display: flex; align-items: center; gap: 12px; }
    .at-ico { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: rgba(6,182,212,.12); color: #22d3ee; flex-shrink: 0; }
    .at-head h1 { font-family: var(--font-display, Manrope, sans-serif); font-size: 24px; font-weight: 800; color: var(--fg-primary); margin: 0; }
    .at-head p { font-size: 12.5px; color: var(--fg-tertiary); margin: 3px 0 0; }
    .at-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

    .at-seg { display: inline-flex; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 3px; gap: 2px; }
    .at-seg button { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 7px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); background: transparent; cursor: pointer; }
    .at-seg button.on { background: var(--bg-tertiary); color: var(--fg-primary); }
    .at-seg--sm button { padding: 5px 10px; font-size: 12px; }

    .at-auto { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; }
    .at-auto input { position: absolute; opacity: 0; width: 0; height: 0; }
    .at-auto-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-tertiary); }
    .at-auto--on { border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 45%, transparent); color: var(--fg-secondary); }
    .at-auto--on .at-auto-dot { background: var(--tracky-light, #10E0A0); animation: at-pulse 1.6s ease-in-out infinite; }
    @keyframes at-pulse { 50% { opacity: .35; } }

    .at-refresh { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; }
    .at-refresh:disabled { opacity: .6; }
    .at-alert { display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-radius: 11px; background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--texte-alerte); font-size: 13px; }

    /* KPIs */
    .at-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    @media (max-width: 640px) { .at-kpis { grid-template-columns: 1fr 1fr; } }
    .at-kpi { position: relative; padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 3px; }
    .at-kpi-n { font-family: var(--font-display, Manrope, sans-serif); font-size: 24px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .at-kpi-l { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); font-weight: 600; }
    .at-kpi-sub { font-size: 11px; color: var(--fg-tertiary); }
    .at-kpi--hot { border-color: rgba(239,68,68,.4); background: rgba(239,68,68,.05); }
    .at-kpi--hot .at-kpi-n { color: var(--texte-alerte); }
    .at-kpi-flag { position: absolute; top: 10px; right: 10px; display: inline-flex; align-items: center; gap: 3px; font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; padding: 2px 6px; border-radius: 999px; background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--texte-alerte); }

    .at-split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 820px) { .at-split { grid-template-columns: 1fr; } }

    /* Panels */
    .at-panel { padding: 16px 18px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 12px; }
    .at-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .at-panel-head h2 { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .at-empty-sm { font-size: 12.5px; color: var(--fg-tertiary); padding: 10px 0; text-align: center; }
    .at-hint { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--fg-tertiary); margin: 0; }
    .at-hint strong { color: var(--fg-secondary); }
    .at-dim { color: var(--fg-tertiary); }

    /* Bars (par source) */
    .at-bars { display: flex; flex-direction: column; gap: 10px; }
    .at-brow { display: flex; flex-direction: column; gap: 5px; }
    .at-brow-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .at-src { display: inline-flex; align-items: center; font-size: 12.5px; font-weight: 700; color: var(--c, var(--fg-secondary)); }
    .at-brow-n { font-size: 12.5px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .at-bar { height: 7px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
    .at-bar-fill { height: 100%; border-radius: 999px; transition: width .4s; }

    /* Stacked status bar */
    .at-stackbar { display: flex; height: 12px; border-radius: 999px; overflow: hidden; background: var(--bg-tertiary); }
    .at-stackseg { height: 100%; min-width: 2px; }
    .at-status-legend { display: flex; flex-wrap: wrap; gap: 12px; }
    .at-leg { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-tertiary); }
    .at-leg b { color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .at-leg-dot { width: 8px; height: 8px; border-radius: 2px; }

    /* Simple lists */
    .at-list { display: flex; flex-direction: column; gap: 2px; }
    .at-li { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; }
    .at-li:hover { background: var(--bg-tertiary); }
    .at-li-txt { flex: 1; min-width: 0; font-size: 12.5px; color: var(--fg-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .at-li-meta { font-size: 11px; color: var(--fg-tertiary); flex-shrink: 0; }
    .at-li-n { font-size: 12.5px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .at-li-n--warn { color: var(--texte-attente); }

    /* Badges / chips */
    .at-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
    .at-badge--known { background: rgba(16,224,160,.14); color: var(--tracky-light, #10E0A0); }
    .at-badge--unknown { background: color-mix(in srgb, var(--danger) 13%, transparent); color: var(--texte-alerte); }
    .at-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .at-chip { display: inline-flex; align-items: center; font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 6px; white-space: nowrap; color: var(--c, var(--fg-secondary)); background: color-mix(in srgb, var(--c, #888) 14%, transparent); }

    /* Mini stacked status per IP */
    .at-ministack { display: flex; width: 78px; height: 8px; border-radius: 999px; overflow: hidden; background: var(--bg-tertiary); }
    .at-ministack-seg { height: 100%; min-width: 2px; }

    /* Suspect row */
    .at-row-suspect td { background: rgba(239,68,68,.05); }
    .at-row-suspect td:first-child { box-shadow: inset 3px 0 0 #f87171; }
    .at-suspect { display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; font-size: 9.5px; font-weight: 800; text-transform: uppercase; padding: 1px 5px; border-radius: 5px; background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--texte-alerte); }

    /* Flux method / kind / code */
    .at-method { display: inline-flex; font-family: ui-monospace, monospace; font-size: 10.5px; font-weight: 800; padding: 2px 6px; border-radius: 5px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .at-method[data-m="GET"] { color: #34d399; }
    .at-method[data-m="POST"] { color: var(--texte-info); }
    .at-method[data-m="PUT"], .at-method[data-m="PATCH"] { color: var(--texte-attente); }
    .at-method[data-m="DELETE"] { color: var(--texte-alerte); }
    .at-kind--evt { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; font-weight: 800; padding: 2px 7px; border-radius: 5px; background: color-mix(in srgb, var(--violet) 10%, transparent); color: var(--texte-violet); }
    .at-code { font-weight: 800; font-variant-numeric: tabular-nums; }
    .at-evt { font-size: 12.5px; color: var(--fg-primary); font-weight: 600; }
    .at-evt-target { color: var(--fg-tertiary); font-weight: 500; }
    .at-ip-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #f87171; margin-right: 6px; vertical-align: middle; }
    .at-ip-dot--known { background: var(--tracky-light, #10E0A0); }

    /* Filters */
    .at-filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
    .at-field { display: flex; flex-direction: column; gap: 4px; }
    .at-field > span { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fg-tertiary); font-weight: 600; }
    .at-field select { padding: 7px 10px; border-radius: 9px; background: var(--bg-primary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 12.5px; font-family: inherit; min-width: 120px; }

    /* Table */
    .at-table-wrap { overflow-x: auto; }
    .at-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .at-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--fg-tertiary); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--border-subtle); white-space: nowrap; }
    .at-table td { padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); color: var(--fg-secondary); white-space: nowrap; vertical-align: middle; }
    .at-table tbody tr:hover td, .at-table tbody tr:hover td { background: var(--bg-tertiary); }
    .at-table th.r, .at-table td.r { text-align: right; font-variant-numeric: tabular-nums; }
    .at-td-ip { font-weight: 700; color: var(--fg-primary); }
    .at-td-path, .at-td-detail { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
    .at-path { color: var(--fg-secondary); }
    .at-td-time { white-space: nowrap; }
    .at-td-ip2 { color: var(--fg-secondary); }
    .at-more { align-self: center; margin-top: 4px; padding: 8px 16px; border-radius: 9px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); font-size: 12.5px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    .at-more:disabled { opacity: .6; }

    .at-skel { height: 96px; border-radius: 16px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: at-sh 1.3s infinite; }
    @keyframes at-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .at-spin { animation: at-spin 1s linear infinite; }
    @keyframes at-spin { to { transform: rotate(360deg); } }
  `],
})
export class AdminApiTrafficComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiTrafficService);

  protected readonly BackIcon = ChevronLeft;
  protected readonly GlobeIcon = Globe;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly RadioIcon = Radio;
  protected readonly BotIcon = Bot;
  protected readonly NetworkIcon = Network;
  protected readonly ShieldQIcon = ShieldQuestion;
  protected readonly UserCheckIcon = UserCheck;
  protected readonly FingerIcon = Fingerprint;
  protected readonly ArrowsIcon = ArrowRightLeft;
  protected readonly ScanIcon = ScanSearch;
  protected readonly GaugeIcon = Gauge;
  protected readonly FilterIcon = Filter;
  protected readonly relativeTime = relativeTime;
  protected readonly statusClasses = STATUS_CLASSES;

  protected readonly windows: { key: WindowKey; label: string; days: number }[] = [
    { key: '24h', label: '24 h', days: 1 },
    { key: '7d', label: '7 j', days: 7 },
    { key: '30d', label: '30 j', days: 30 },
  ];

  protected readonly windowKey = signal<WindowKey>('7d');
  protected readonly summary = signal<ApiTrafficSummaryDto | null>(null);
  protected readonly ips = signal<IpIntelligenceRowDto[]>([]);
  protected readonly entries = signal<ApiTrafficEntryDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly hasMore = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly autoRefresh = signal(false);

  /** Filtre de la section Intelligence IP (client-side sur la liste chargée). */
  protected readonly ipScope = signal<IpScope>('all');

  /** Filtres du flux (serveur). */
  protected readonly fSource = signal<string>('');
  protected readonly fKind = signal<ApiTrafficKind | ''>('');
  protected readonly fStatus = signal<StatusFilter>('');
  protected readonly fluxScope = signal<IpScope>('all');

  private readonly pageSize = 50;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  /** Liste IP filtrée + triée par fréquence décroissante (défensif : le serveur trie déjà). */
  protected readonly filteredIps = computed<IpIntelligenceRowDto[]>(() => {
    const scope = this.ipScope();
    const rows = this.ips().filter((r) =>
      scope === 'all' ? true : scope === 'known' ? r.known : !r.known,
    );
    return [...rows].sort((a, b) => b.count - a.count);
  });

  /** Seuil « forte fréquence » pour signaler une IP inconnue : relatif au pic inconnu, plancher 20. */
  private readonly suspectThreshold = computed<number>(() => {
    const maxUnknown = Math.max(0, ...this.ips().filter((r) => !r.known).map((r) => r.count));
    return Math.max(20, Math.round(maxUnknown * 0.5));
  });

  /** IP inconnues « élevées » vs connues → met en avant le KPI. */
  protected readonly unknownHot = computed<boolean>(() => {
    const s = this.summary();
    return !!s && s.unknownIps > 0 && s.unknownIps >= Math.max(5, s.knownIps);
  });

  /** Sources proposées dans le filtre : celles vues dans la synthèse + secours statique. */
  protected readonly sourceOptions = computed<string[]>(() => {
    const fromSummary = Object.keys(this.summary()?.bySource ?? {});
    const base = ['LP', 'Maestroo', 'API', 'Webhook', 'Unknown'];
    return Array.from(new Set([...fromSummary, ...base]));
  });

  ngOnInit(): void {
    void this.reload();
  }

  ngOnDestroy(): void {
    this.stopPoll();
  }

  private currentDays(): number {
    return this.windows.find((w) => w.key === this.windowKey())?.days ?? 7;
  }

  protected windowLabel(): string {
    return this.windowKey() === '24h' ? '24 dernières heures' : this.windowKey() === '7d' ? '7 derniers jours' : '30 derniers jours';
  }

  protected setWindow(key: WindowKey): void {
    if (key === this.windowKey()) return;
    this.windowKey.set(key);
    void this.reload();
  }

  protected toggleAuto(on: boolean): void {
    this.autoRefresh.set(on);
    if (on) {
      this.pollHandle = setInterval(() => {
        if (!this.loading() && !this.loadingMore()) void this.refreshLight();
      }, 10_000);
    } else {
      this.stopPoll();
    }
  }

  private stopPoll(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /** Chargement complet des 3 sections. */
  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const days = this.currentDays();
    try {
      const [summary, ips] = await Promise.all([
        firstValueFrom(this.api.summary(days)),
        firstValueFrom(this.api.ips(days)),
      ]);
      this.summary.set(summary);
      this.ips.set(ips);
      await this.loadEntries(true);
    } catch (e) {
      swallow('admin-api-traffic:reload', e);
      this.error.set(this.errMsg(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Rafraîchissement léger (auto) : synthèse + IP + 1re page du flux, sans spinner global. */
  private async refreshLight(): Promise<void> {
    const days = this.currentDays();
    try {
      const [summary, ips] = await Promise.all([
        firstValueFrom(this.api.summary(days)),
        firstValueFrom(this.api.ips(days)),
      ]);
      this.summary.set(summary);
      this.ips.set(ips);
      await this.loadEntries(true);
    } catch (err) {
      // silencieux en auto
      swallow('admin-api-traffic:reloadAuto', err);
    }
  }

  /** Charge le flux : `reset` = première page (remplace) ; sinon page suivante (curseur). */
  private async loadEntries(reset: boolean): Promise<void> {
    const scope = this.fluxScope();
    const last = reset ? undefined : this.entries()[this.entries().length - 1];
    const page = await firstValueFrom(
      this.api.entries({
        limit: this.pageSize,
        before: last?.createdAt,
        beforeId: last?.id,
        source: this.fSource() || undefined,
        kind: this.fKind() || undefined,
        status: this.fStatus() || undefined,
        ipKnown: scope === 'all' ? undefined : scope === 'known',
      }),
    );
    this.entries.set(reset ? page : [...this.entries(), ...page]);
    this.hasMore.set(page.length >= this.pageSize);
  }

  protected async loadMore(): Promise<void> {
    if (this.loadingMore() || !this.hasMore()) return;
    this.loadingMore.set(true);
    try {
      await this.loadEntries(false);
    } catch (e) {
      this.error.set(this.errMsg(e));
    } finally {
      this.loadingMore.set(false);
    }
  }

  /** Rechargement du flux uniquement (changement de filtre). */
  private reloadEntries(): void {
    void this.loadEntries(true).catch((e) => this.error.set(this.errMsg(e)));
  }

  protected setIpScope(s: IpScope): void {
    this.ipScope.set(s);
  }
  protected setSource(v: string): void {
    this.fSource.set(v);
    this.reloadEntries();
  }
  protected setKind(v: string): void {
    this.fKind.set((v as ApiTrafficKind) || '');
    this.reloadEntries();
  }
  protected setStatus(v: string): void {
    this.fStatus.set((v as StatusFilter) || '');
    this.reloadEntries();
  }
  protected setFluxScope(s: IpScope): void {
    if (s === this.fluxScope()) return;
    this.fluxScope.set(s);
    this.reloadEntries();
  }

  // ─── Helpers d'affichage ───
  protected isSuspect(r: IpIntelligenceRowDto): boolean {
    return !r.known && r.count >= this.suspectThreshold();
  }

  protected sourceRows(s: ApiTrafficSummaryDto): { key: string; value: number }[] {
    return Object.entries(s.bySource)
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => b.value - a.value);
  }
  protected maxSource(s: ApiTrafficSummaryDto): number {
    return Math.max(1, ...Object.values(s.bySource));
  }
  protected statusTotal(s: ApiTrafficSummaryDto): number {
    return STATUS_CLASSES.reduce((acc, c) => acc + (s.byStatusClass[c] ?? 0), 0);
  }
  protected pct(v: number, max: number): number {
    return max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0;
  }

  protected statusColor(c: StatusClass): string {
    return STATUS_COLORS[c];
  }
  protected statusClassOf(code: number | string | null | undefined): StatusClass {
    const n = typeof code === 'string' ? parseInt(code, 10) : (code ?? 0);
    if (n >= 500) return '5xx';
    if (n >= 400) return '4xx';
    if (n >= 300) return '3xx';
    return '2xx';
  }

  /** Segments (par classe) de la mini-répartition de statuts d'une IP, en % de largeur. */
  protected ipStatusSegments(r: IpIntelligenceRowDto): { cls: StatusClass; count: number; color: string; pct: number }[] {
    const buckets: Record<StatusClass, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    for (const [code, n] of Object.entries(r.statuses ?? {})) {
      buckets[this.statusClassOf(code)] += n;
    }
    const total = STATUS_CLASSES.reduce((acc, c) => acc + buckets[c], 0) || 1;
    return STATUS_CLASSES
      .filter((c) => buckets[c] > 0)
      .map((c) => ({ cls: c, count: buckets[c], color: STATUS_COLORS[c], pct: Math.max(4, Math.round((buckets[c] / total) * 100)) }));
  }
  protected ipStatusTitle(r: IpIntelligenceRowDto): string {
    const parts = Object.entries(r.statuses ?? {}).map(([code, n]) => `${code}×${n}`);
    return parts.length ? parts.join(' · ') : 'Aucun statut';
  }

  private static readonly SOURCE_COLORS: Record<string, string> = {
    lp: '#22d3ee',
    maestroo: '#a78bfa',
    api: '#10E0A0',
    webhook: '#fbbf24',
    unknown: '#f87171',
  };
  protected sourceColor(source: string): string {
    return AdminApiTrafficComponent.SOURCE_COLORS[(source || '').toLowerCase()] ?? '#94a3b8';
  }
  private static readonly SOURCE_LABELS: Record<string, string> = {
    lp: 'Landing (LP)',
    maestroo: 'Maestroo',
    api: 'API',
    webhook: 'Webhook',
    unknown: 'Inconnu',
  };
  protected sourceLabel(source: string): string {
    return AdminApiTrafficComponent.SOURCE_LABELS[(source || '').toLowerCase()] ?? source;
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
