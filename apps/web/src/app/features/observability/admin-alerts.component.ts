import { DatePipe, JsonPipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AlertTriangle,
  ArrowLeft,
  Bug,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  LucideAngularModule,
  Radio,
  TrendingDown,
  TrendingUp,
  RefreshCw,
  User,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  AdminAlertsDto,
  AdminFixModeService,
  type ErrorTimelineBucket,
} from '../../core/services/admin-fix-mode.service';
import { ActivityTrackerService } from '../../core/services/activity-tracker.service';
import { ErrorTimelineChartComponent } from '../../shared/ui/charts/error-timeline-chart.component';
import { ToastService } from '../../shared/ui/toast/toast.service';

@Component({
  selector: 'app-admin-alerts',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, JsonPipe, RouterLink, ErrorTimelineChartComponent],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <a routerLink="/admin"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon>
            Administration
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary">Centre d'alertes</h1>
          <p class="text-sm text-fg-tertiary">
            Trackers en echec, hors ligne prolonge, commandes en attente et erreurs applicatives.
          </p>
        </div>
        <div class="flex gap-2">
          <button (click)="downloadExport()" [disabled]="exporting()"
                  class="px-3 py-2 bg-bg-secondary border border-border-subtle text-fg-secondary rounded-lg text-sm font-medium hover:text-fg-primary cursor-pointer flex items-center gap-2 disabled:opacity-50"
                  title="Telecharger le rapport d'erreurs (.md) pour debug IA">
            <lucide-icon [img]="Download" [size]="14"></lucide-icon>
            <span class="hidden sm:inline">{{ exporting() ? '...' : 'Rapport IA' }}</span>
          </button>
          <button (click)="exportForAI()" [disabled]="exporting()"
                  class="px-3 py-2 bg-bg-secondary border border-border-subtle text-fg-secondary rounded-lg text-sm font-medium hover:text-fg-primary cursor-pointer flex items-center gap-2 disabled:opacity-50"
                  title="Copier le rapport dans le clipboard">
            <lucide-icon [img]="Copy" [size]="14"></lucide-icon>
          </button>
          <button (click)="reload()"
                  class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
            <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
          </button>
        </div>
      </div>

      <!-- Etat de sante -->
      @if (data()) {
        <div class="rounded-[--radius-card] px-4 py-3 text-sm flex items-center gap-3"
             [class]="healthStatus().level === 'critical' ? 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
               : healthStatus().level === 'warn' ? 'bg-amber-500/10 border border-amber-500/30 text-amber-300'
               : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'">
          <lucide-icon
            [img]="healthStatus().level === 'critical' ? Zap : healthStatus().level === 'warn' ? AlertTriangle : CheckCircle"
            [size]="18" class="shrink-0"></lucide-icon>
          <span>{{ healthStatus().text }}</span>
          @if (data()!.summary.errorsSinceLastVisit !== null && data()!.summary.errorsSinceLastVisit! > 0) {
            <span class="ml-auto text-xs font-mono opacity-80 shrink-0">
              +{{ data()!.summary.errorsSinceLastVisit }} depuis derniere visite
            </span>
          }
        </div>
      }

      <!-- Summary -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div class="bg-bg-secondary border border-rose-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="AlertTriangle" [size]="28" class="text-rose-400 shrink-0"></lucide-icon>
          <div>
            <div class="text-[10px] uppercase text-fg-tertiary">Trackers FAILING</div>
            <div class="text-2xl font-display font-bold text-rose-400">
              {{ data()?.summary?.failing ?? 0 }}
            </div>
          </div>
        </div>
        <div class="bg-bg-secondary border border-amber-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="WifiOff" [size]="28" class="text-amber-400 shrink-0"></lucide-icon>
          <div>
            <div class="text-[10px] uppercase text-fg-tertiary">Offline > 1h</div>
            <div class="text-2xl font-display font-bold text-amber-400">
              {{ data()?.summary?.offline ?? 0 }}
            </div>
          </div>
        </div>
        <div class="bg-bg-secondary border border-sky-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="Clock" [size]="28" class="text-sky-400 shrink-0"></lucide-icon>
          <div>
            <div class="text-[10px] uppercase text-fg-tertiary">Commandes en attente</div>
            <div class="text-2xl font-display font-bold text-sky-400">
              {{ data()?.summary?.pending ?? 0 }}
            </div>
          </div>
        </div>
        <div class="bg-bg-secondary border rounded-[--radius-card] p-4 flex items-center gap-3"
             [class]="(data()?.summary?.errorsLast24h ?? 0) > 0 ? 'border-orange-500/20' : 'border-border-subtle'">
          <lucide-icon [img]="Bug" [size]="28" class="shrink-0"
                       [class]="(data()?.summary?.errorsLast24h ?? 0) > 0 ? 'text-orange-400' : 'text-fg-tertiary'"></lucide-icon>
          <div>
            <div class="text-[10px] uppercase text-fg-tertiary">Erreurs 24h</div>
            <div class="flex items-center gap-1.5">
              <span class="text-2xl font-display font-bold"
                   [class]="(data()?.summary?.errorsLast24h ?? 0) > 0 ? 'text-orange-400' : 'text-fg-tertiary'">
                {{ data()?.summary?.errorsLast24h ?? 0 }}
              </span>
              @if (errorTrend() !== 0) {
                <span class="flex items-center text-[10px] font-mono"
                      [class]="errorTrend() > 0 ? 'text-rose-400' : 'text-emerald-400'">
                  <lucide-icon [img]="errorTrend() > 0 ? TrendingUp : TrendingDown" [size]="12"></lucide-icon>
                  {{ errorTrend() > 0 ? '+' : '' }}{{ errorTrend() }}
                </span>
              }
            </div>
          </div>
        </div>
        <div class="bg-bg-secondary border rounded-[--radius-card] p-4 flex items-center gap-3"
             [class]="(data()?.summary?.criticalLastHour ?? 0) > 0 ? 'border-rose-500/30' : 'border-border-subtle'">
          <lucide-icon [img]="Zap" [size]="28" class="shrink-0"
                       [class]="(data()?.summary?.criticalLastHour ?? 0) > 0 ? 'text-rose-400' : 'text-fg-tertiary'"></lucide-icon>
          <div>
            <div class="text-[10px] uppercase text-fg-tertiary">Critical 1h</div>
            <div class="text-2xl font-display font-bold"
                 [class]="(data()?.summary?.criticalLastHour ?? 0) > 0 ? 'text-rose-400' : 'text-fg-tertiary'">
              {{ data()?.summary?.criticalLastHour ?? 0 }}
            </div>
          </div>
        </div>
      </div>

      <!-- Error Timeline Chart -->
      @if (timelineBuckets().length > 0) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="text-xs font-semibold text-fg-tertiary uppercase">Erreurs par heure (24h)</div>
            <div class="flex items-center gap-3 text-[10px]">
              <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-orange-400/70"></span> ERROR</span>
              <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-rose-500/80"></span> CRITICAL</span>
            </div>
          </div>
          <app-error-timeline-chart [buckets]="timelineBuckets()" [height]="180"></app-error-timeline-chart>
        </div>
      }

      <!-- FAILING -->
      @if (data() && data()!.failing.length > 0) {
        <section class="flex flex-col gap-3">
          <h2 class="text-lg font-display font-semibold text-fg-primary flex items-center gap-2">
            <lucide-icon [img]="AlertTriangle" [size]="18" class="text-rose-400"></lucide-icon>
            Trackers en echec ({{ data()!.failing.length }})
          </h2>
          <!-- Mobile cards -->
          <div class="flex flex-col gap-2 sm:hidden">
            @for (a of data()!.failing; track a.trackerId) {
              <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-3">
                <div class="flex justify-between items-start">
                  <div>
                    <div class="font-medium text-fg-primary text-sm">{{ a.plate ?? '—' }}</div>
                    <div class="text-[10px] font-mono text-fg-tertiary mt-0.5">{{ a.imei.slice(0,4) }}...{{ a.imei.slice(-4) }}</div>
                  </div>
                  <span class="text-rose-400 font-mono text-sm font-bold">{{ a.fixCommandFailureCount }}</span>
                </div>
                <div class="flex items-center gap-3 mt-2 text-xs text-fg-tertiary">
                  <span>{{ a.desiredFixIntervalS }}s / {{ a.currentFixIntervalS ?? '?' }}s</span>
                  <span>{{ a.lastSeenAt ? (a.lastSeenAt | date: 'dd/MM HH:mm') : 'jamais' }}</span>
                </div>
                <div class="flex gap-3 mt-2">
                  <a [routerLink]="['/admin/trackers', a.trackerId, 'fix-mode']"
                     class="text-xs text-tracky-light hover:underline">Inspecter</a>
                  <button (click)="clearFailing(a.trackerId)"
                          class="text-xs text-fg-tertiary hover:text-emerald-400">Acquitter</button>
                </div>
              </div>
            }
          </div>
          <!-- Desktop table -->
          <div class="hidden sm:block bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
            <table class="w-full text-sm min-w-[700px]">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Vehicule</th>
                  <th class="p-3 text-left">IMEI</th>
                  <th class="p-3 text-left">Fleet</th>
                  <th class="p-3 text-right">Echecs</th>
                  <th class="p-3 text-right">Cible / Reel</th>
                  <th class="p-3 text-left">Dernier vu</th>
                  <th class="p-3"></th>
                </tr>
              </thead>
              <tbody>
                @for (a of data()!.failing; track a.trackerId) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                    <td class="p-3 font-medium text-fg-primary">{{ a.plate ?? '—' }}</td>
                    <td class="p-3 font-mono text-xs text-fg-secondary">{{ a.imei.slice(0,4) }}...{{ a.imei.slice(-4) }}</td>
                    <td class="p-3 text-fg-tertiary text-xs">{{ a.fleetName ?? '—' }}</td>
                    <td class="p-3 text-right font-mono text-rose-400">{{ a.fixCommandFailureCount }}</td>
                    <td class="p-3 text-right font-mono text-xs">
                      {{ a.desiredFixIntervalS }}s / {{ a.currentFixIntervalS ?? '?' }}s
                    </td>
                    <td class="p-3 text-fg-tertiary text-xs">
                      {{ a.lastSeenAt ? (a.lastSeenAt | date: 'dd/MM HH:mm') : 'jamais' }}
                    </td>
                    <td class="p-3 flex gap-2">
                      <a [routerLink]="['/admin/trackers', a.trackerId, 'fix-mode']"
                         class="text-xs text-tracky-light hover:underline">Inspecter</a>
                      <button (click)="clearFailing(a.trackerId)"
                              class="text-xs text-fg-tertiary hover:text-emerald-400">Acquitter</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      <!-- OFFLINE -->
      @if (data() && data()!.offline.length > 0) {
        <section class="flex flex-col gap-3">
          <h2 class="text-lg font-display font-semibold text-fg-primary flex items-center gap-2">
            <lucide-icon [img]="WifiOff" [size]="18" class="text-amber-400"></lucide-icon>
            Trackers hors ligne > 1h ({{ data()!.offline.length }})
          </h2>
          <!-- Mobile cards -->
          <div class="flex flex-col gap-2 sm:hidden">
            @for (a of data()!.offline; track a.trackerId) {
              <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-3">
                <div class="flex justify-between items-start">
                  <div>
                    <div class="font-medium text-fg-primary text-sm">{{ a.plate ?? '—' }}</div>
                    <div class="text-[10px] font-mono text-fg-tertiary mt-0.5">{{ a.imei.slice(0,4) }}...{{ a.imei.slice(-4) }}</div>
                  </div>
                  <span class="text-amber-400 font-mono text-xs">{{ formatDuration(a.offlineSinceMs) }}</span>
                </div>
                <div class="text-xs text-fg-tertiary mt-1">
                  {{ a.lastSeenAt ? (a.lastSeenAt | date: 'dd/MM HH:mm') : 'jamais vu' }}
                </div>
              </div>
            }
          </div>
          <!-- Desktop table -->
          <div class="hidden sm:block bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
            <table class="w-full text-sm min-w-[700px]">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Vehicule</th>
                  <th class="p-3 text-left">IMEI</th>
                  <th class="p-3 text-left">Fleet</th>
                  <th class="p-3 text-left">Dernier vu</th>
                  <th class="p-3 text-right">Duree</th>
                </tr>
              </thead>
              <tbody>
                @for (a of data()!.offline; track a.trackerId) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                    <td class="p-3 font-medium text-fg-primary">{{ a.plate ?? '—' }}</td>
                    <td class="p-3 font-mono text-xs text-fg-secondary">{{ a.imei.slice(0,4) }}...{{ a.imei.slice(-4) }}</td>
                    <td class="p-3 text-fg-tertiary text-xs">{{ a.fleetName ?? '—' }}</td>
                    <td class="p-3 text-fg-tertiary text-xs">
                      {{ a.lastSeenAt ? (a.lastSeenAt | date: 'dd/MM HH:mm') : 'jamais' }}
                    </td>
                    <td class="p-3 text-right text-amber-400 text-xs font-mono">
                      {{ formatDuration(a.offlineSinceMs) }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      <!-- PENDING -->
      @if (data() && data()!.pendingCommands.length > 0) {
        <section class="flex flex-col gap-3">
          <h2 class="text-lg font-display font-semibold text-fg-primary flex items-center gap-2">
            <lucide-icon [img]="Clock" [size]="18" class="text-sky-400"></lucide-icon>
            Commandes en attente > 10 min ({{ data()!.pendingCommands.length }})
          </h2>
          <!-- Mobile cards -->
          <div class="flex flex-col gap-2 sm:hidden">
            @for (c of data()!.pendingCommands; track c.commandId) {
              <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-3">
                <div class="flex justify-between items-start">
                  <div class="font-medium text-fg-primary text-sm">{{ c.plate ?? '—' }}</div>
                  <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md bg-sky-500/10 text-sky-400 font-mono">
                    {{ c.status }}
                  </span>
                </div>
                <div class="text-[10px] font-mono text-fg-tertiary mt-1">{{ c.templateId }}</div>
                <div class="text-xs text-fg-tertiary mt-1 truncate">
                  {{ c.diagnosticHint ?? c.outcomeReason ?? '—' }}
                </div>
                <div class="flex justify-between items-center mt-2">
                  <span class="text-[10px] text-fg-tertiary">{{ c.createdAt | date: 'dd/MM HH:mm' }}</span>
                  <button (click)="ackCommand(c.commandId)"
                          class="text-xs text-tracky-light hover:underline">Acquitter</button>
                </div>
              </div>
            }
          </div>
          <!-- Desktop table -->
          <div class="hidden sm:block bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
            <table class="w-full text-sm min-w-[700px]">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Vehicule</th>
                  <th class="p-3 text-left">Commande</th>
                  <th class="p-3 text-left">Statut</th>
                  <th class="p-3 text-left">Cree le</th>
                  <th class="p-3 text-left">Indice</th>
                  <th class="p-3"></th>
                </tr>
              </thead>
              <tbody>
                @for (c of data()!.pendingCommands; track c.commandId) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                    <td class="p-3 font-medium text-fg-primary">{{ c.plate ?? '—' }}</td>
                    <td class="p-3 text-xs font-mono text-fg-secondary">{{ c.templateId }}</td>
                    <td class="p-3">
                      <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md bg-sky-500/10 text-sky-400 font-mono">
                        {{ c.status }}
                      </span>
                    </td>
                    <td class="p-3 text-fg-tertiary text-xs">{{ c.createdAt | date: 'dd/MM HH:mm' }}</td>
                    <td class="p-3 text-fg-tertiary text-xs max-w-[260px] truncate">
                      {{ c.diagnosticHint ?? c.outcomeReason ?? '—' }}
                    </td>
                    <td class="p-3">
                      <button (click)="ackCommand(c.commandId)"
                              class="text-xs text-tracky-light hover:underline">Acquitter</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      <!-- ERRORS -->
      @if (data()?.errors?.last24h) {
        <section class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <h2 class="text-lg font-display font-semibold text-fg-primary flex items-center gap-2">
              <lucide-icon [img]="Bug" [size]="18" class="text-orange-400"></lucide-icon>
              Erreurs applicatives ({{ data()!.errors.last24h }} / 24h)
            </h2>
            <a routerLink="/admin/observability"
               class="text-xs text-tracky-light hover:underline">Voir les wire logs</a>
          </div>

          <!-- CRITICAL récentes -->
          @if (data()!.errors.recentCritical.length > 0) {
            <div class="flex flex-col gap-2">
              <div class="text-xs font-semibold text-rose-400 uppercase">Erreurs critiques recentes</div>
              @for (e of data()!.errors.recentCritical; track e.id) {
                <div class="bg-bg-secondary border border-rose-500/30 rounded-[--radius-card]">
                  <button (click)="toggleErrorExpand(e.id)"
                          class="w-full px-4 py-3 flex items-center gap-3 hover:bg-bg-tertiary/30 cursor-pointer text-left">
                    <lucide-icon [img]="expandedErrors()[e.id] ? ChevronDown : ChevronRight"
                                 [size]="14" class="text-fg-tertiary shrink-0"></lucide-icon>
                    <div class="flex flex-col flex-1 min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md bg-rose-500/10 text-rose-400 font-mono">
                          CRITICAL
                        </span>
                        <span class="text-[10px] font-mono text-fg-tertiary">{{ e.source }}</span>
                        <span class="text-[10px] font-mono text-fg-tertiary">{{ e.createdAt | date: 'dd/MM HH:mm:ss' }}</span>
                        @if (e.imei) {
                          <span class="text-[10px] font-mono text-fg-tertiary">{{ e.imei }}</span>
                        }
                      </div>
                      <div class="text-xs text-fg-secondary mt-1 truncate">{{ e.message }}</div>
                      @if (who(e); as w) {
                        <div class="text-[11px] text-amber-300/90 mt-0.5 truncate"><lucide-icon [img]="User" [size]="11" class="inline-block align-[-2px]"></lucide-icon> {{ w }}</div>
                      }
                    </div>
                  </button>
                  @if (expandedErrors()[e.id]) {
                    <div class="border-t border-border-subtle/50 px-4 py-3 flex flex-col gap-2 text-xs">
                      @if (e.stack) {
                        <pre class="text-[10px] text-fg-tertiary bg-bg-tertiary p-2 rounded overflow-x-auto whitespace-pre-wrap">{{ e.stack }}</pre>
                      }
                      @if (e.context) {
                        <details class="text-fg-tertiary">
                          <summary class="cursor-pointer hover:text-fg-secondary text-xs">Contexte</summary>
                          <pre class="mt-2 text-[10px] bg-bg-tertiary p-2 rounded overflow-x-auto">{{ e.context | json }}</pre>
                        </details>
                      }
                    </div>
                  }
                </div>
              }
            </div>
          }

          <!-- Dernières erreurs (toutes catégories) avec "chez qui" -->
          @if (data()!.errors.recent.length > 0) {
            <div class="flex flex-col gap-2 mt-2">
              <div class="text-xs font-semibold text-fg-tertiary uppercase">Dernières erreurs · chez qui</div>
              @for (e of data()!.errors.recent; track e.id) {
                <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] px-4 py-2.5">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="inline-flex items-center px-1.5 py-0.5 text-[9px] rounded font-mono"
                          [class]="e.level === 'CRITICAL' ? 'bg-rose-500/10 text-rose-400' : 'bg-amber-500/10 text-amber-400'">{{ e.level }}</span>
                    <span class="text-[10px] font-mono text-fg-tertiary">{{ e.source }}</span>
                    <span class="text-[10px] font-mono text-fg-tertiary">{{ e.createdAt | date: 'dd/MM HH:mm:ss' }}</span>
                  </div>
                  <div class="text-xs text-fg-secondary mt-1 truncate">{{ e.message }}</div>
                  @if (who(e); as w) {
                    <div class="text-[11px] text-amber-300/90 mt-0.5 truncate"><lucide-icon [img]="User" [size]="11" class="inline-block align-[-2px]"></lucide-icon> {{ w }}</div>
                  } @else if (e.imei) {
                    <div class="text-[11px] text-fg-tertiary mt-0.5"><lucide-icon [img]="Radio" [size]="11" class="inline-block align-[-2px]"></lucide-icon> {{ e.imei }} · erreur tracker (sans user)</div>
                  }
                </div>
              }
            </div>
          }

          <!-- Erreurs groupées par source -->
          @if (data()!.errors.bySource.length > 0) {
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                  <tr>
                    <th class="p-3 text-left">Source</th>
                    <th class="p-3 text-right">Occurrences</th>
                    <th class="p-3 text-left">Derniere</th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of data()!.errors.bySource; track s.source) {
                    <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                      <td class="p-3 font-mono text-xs text-fg-secondary">{{ s.source }}</td>
                      <td class="p-3 text-right font-mono"
                          [class]="s.count >= 10 ? 'text-orange-400' : 'text-fg-secondary'">{{ s.count }}</td>
                      <td class="p-3 text-fg-tertiary text-xs">{{ s.lastAt | date: 'dd/MM HH:mm' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          <!-- Top messages recurrents -->
          @if (data()!.errors.topMessages.length > 0) {
            <div class="flex flex-col gap-2">
              <div class="text-xs font-semibold text-fg-tertiary uppercase">Erreurs recurrentes (top 20)</div>
              <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
                <table class="w-full text-sm">
                  <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                    <tr>
                      <th class="p-3 text-left">Message</th>
                      <th class="p-3 text-left">Source</th>
                      <th class="p-3 text-left">Niveau</th>
                      <th class="p-3 text-right">x</th>
                      <th class="p-3 text-left">Derniere</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (m of data()!.errors.topMessages; track m.lastId) {
                      <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                        <td class="p-3 text-xs text-fg-secondary max-w-[400px] truncate">{{ m.message }}</td>
                        <td class="p-3 font-mono text-[10px] text-fg-tertiary">{{ m.source }}</td>
                        <td class="p-3">
                          <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md font-mono"
                                [class]="m.level === 'CRITICAL' ? 'bg-rose-500/10 text-rose-400' : 'bg-orange-500/10 text-orange-400'">
                            {{ m.level }}
                          </span>
                        </td>
                        <td class="p-3 text-right font-mono font-bold"
                            [class]="m.count >= 5 ? 'text-orange-400' : 'text-fg-secondary'">{{ m.count }}</td>
                        <td class="p-3 text-fg-tertiary text-xs">{{ m.lastAt | date: 'dd/MM HH:mm' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
          }
        </section>
      }

      @if (data() && data()!.failing.length === 0 && data()!.offline.length === 0 && data()!.pendingCommands.length === 0 && !data()!.errors.last24h) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-12 text-center">
          <lucide-icon [img]="CheckCircle" [size]="48" class="mx-auto mb-3 text-emerald-400"></lucide-icon>
          <h2 class="text-lg font-display font-semibold text-fg-primary">Tout va bien</h2>
          <p class="text-sm text-fg-tertiary mt-1">Aucune alerte ouverte sur les flottes accessibles.</p>
        </div>
      }
    </div>
  `,
})
export class AdminAlertsComponent implements OnInit {
  private readonly api = inject(AdminFixModeService);
  private readonly toast = inject(ToastService);
  private readonly tracker = inject(ActivityTrackerService);

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Bug = Bug;
  protected readonly CheckCircle = CheckCircle;
  protected readonly Copy = Copy;
  protected readonly Download = Download;
  protected readonly TrendingDown = TrendingDown;
  protected readonly TrendingUp = TrendingUp;
  protected readonly ChevronDown = ChevronDown;
  protected readonly ChevronRight = ChevronRight;
  protected readonly Clock = Clock;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Wifi = Wifi;
  protected readonly User = User;
  protected readonly Radio = Radio;
  protected readonly WifiOff = WifiOff;
  protected readonly Zap = Zap;

  private static readonly LAST_VISIT_KEY = 'tracky_alerts_last_visit';

  readonly data = signal<AdminAlertsDto | null>(null);
  readonly loading = signal(false);
  readonly expandedErrors = signal<Record<string, boolean>>({});
  readonly timelineBuckets = signal<ErrorTimelineBucket[]>([]);
  readonly exporting = signal(false);
  readonly lastVisitAt = signal<string | null>(null);

  /** Tendance erreurs : delta entre 24h actuelles et 24h precedentes. */
  readonly errorTrend = computed(() => {
    const s = this.data()?.summary;
    if (!s) return 0;
    return s.errorsLast24h - s.errorsPrev24h;
  });

  /** Bandeau etat de sante : texte + niveau (ok / warn / critical). */
  readonly healthStatus = computed<{ level: 'ok' | 'warn' | 'critical'; text: string }>(() => {
    const s = this.data()?.summary;
    if (!s) return { level: 'ok', text: 'Chargement...' };

    if (s.criticalLastHour > 0) {
      return {
        level: 'critical',
        text: `${s.criticalLastHour} erreur(s) CRITICAL dans la derniere heure — action requise.`,
      };
    }
    if (s.failing > 0 || s.errorsLast24h >= 10) {
      const parts: string[] = [];
      if (s.failing > 0) parts.push(`${s.failing} tracker(s) FAILING`);
      if (s.errorsLast24h >= 10) parts.push(`${s.errorsLast24h} erreurs en 24h`);
      return { level: 'warn', text: `${parts.join(', ')} — a investiguer.` };
    }
    if (s.errorsLast24h > 0) {
      return {
        level: 'ok',
        text: `${s.errorsLast24h} erreur(s) mineures en 24h — aucune action requise.`,
      };
    }
    return { level: 'ok', text: 'Aucune erreur detectee. Systeme nominal.' };
  });

  ngOnInit(): void {
    // Lire la derniere visite depuis localStorage.
    const stored = localStorage.getItem(AdminAlertsComponent.LAST_VISIT_KEY);
    if (stored) this.lastVisitAt.set(stored);
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const since = this.lastVisitAt() ?? undefined;
      const [alertsData, timeline] = await Promise.all([
        firstValueFrom(this.api.alerts(undefined, since)),
        firstValueFrom(this.api.errorsTimeline()).catch(() => ({ buckets: [] })),
      ]);
      this.data.set(alertsData);
      this.timelineBuckets.set(timeline.buckets);
      // Sauvegarder la visite actuelle.
      const now = new Date().toISOString();
      localStorage.setItem(AdminAlertsComponent.LAST_VISIT_KEY, now);
      this.lastVisitAt.set(now);
    } catch {
      this.toast.error('Echec du chargement des alertes');
    } finally {
      this.loading.set(false);
    }
  }

  async ackCommand(commandId: string): Promise<void> {
    try {
      await firstValueFrom(this.api.acknowledgeCommand(commandId));
      this.toast.success('Commande acquittee');
      this.reload();
    } catch {
      this.toast.error('Echec de l\'acquittement');
    }
  }

  async clearFailing(trackerId: string): Promise<void> {
    try {
      await firstValueFrom(this.api.clearFailing(trackerId));
      this.toast.success('Etat FAILING reinitialise');
      this.reload();
    } catch {
      this.toast.error('Echec de la reinitialisation');
    }
  }

  async exportForAI(): Promise<void> {
    this.exporting.set(true);
    try {
      const result = await firstValueFrom(this.api.errorsExport());
      await navigator.clipboard.writeText(result.markdown);
      this.toast.success(
        `${result.errorCount} erreurs copiees`,
        'Colle le rapport dans un chat Claude pour debug.',
      );
    } catch {
      this.toast.error('Echec de l\'export');
    } finally {
      this.exporting.set(false);
    }
  }

  async downloadExport(): Promise<void> {
    this.exporting.set(true);
    try {
      const result = await firstValueFrom(this.api.errorsExport());
      const date = new Date().toISOString().slice(0, 10);
      // Trace explicite : l'ancre détachée ci-dessous n'émet aucun clic capturable.
      this.tracker.trackClick(`export:tracky-errors-${date}.md`);
      const blob = new Blob([result.markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tracky-errors-${date}.md`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast.success(`${result.errorCount} erreurs exportees en fichier .md`);
    } catch {
      this.toast.error('Echec du telechargement');
    } finally {
      this.exporting.set(false);
    }
  }

  toggleErrorExpand(id: string): void {
    this.expandedErrors.update((m) => ({ ...m, [id]: !m[id] }));
  }

  /** Construit la ligne "chez qui · où · device" depuis le contexte d'une erreur. */
  protected who(e: { context: Record<string, unknown> | null }): string | null {
    const c = e.context;
    if (!c) return null;
    const str = (k: string): string | null => (typeof c[k] === 'string' ? (c[k] as string) : null);
    const email = str('userEmail');
    const page = str('page') ?? str('route');
    const ua = str('userAgent');
    const device = ua
      ? /Mobi|Android|iPhone/i.test(ua)
        ? 'Mobile'
        : /iPad|Tablet/i.test(ua)
          ? 'Tablet'
          : 'Desktop'
      : null;
    const parts = [email, page, device].filter((x): x is string => !!x);
    return parts.length ? parts.join(' · ') : null;
  }

  formatDuration(ms: number | null): string {
    if (!ms) return '—';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 24) return `${Math.floor(h / 24)} j`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m} min`;
  }
}
