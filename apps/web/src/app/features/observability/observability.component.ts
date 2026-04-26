import { Component, inject, OnInit, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  LucideAngularModule, Activity, AlertTriangle, Search, RefreshCw,
  ArrowUpRight, ArrowDownLeft, Clock, Terminal,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  AdminLogsService,
  type WireLogDto,
  type ErrorLogDto,
  type TimelineEntry,
} from '../../core/services/admin-logs.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

@Component({
  selector: 'app-observability',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, JsonPipe, FormsModule],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Observabilité</h1>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 border-b border-border-subtle overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        @for (tab of tabs; track tab.key) {
          <button
            (click)="activeTab.set(tab.key)"
            class="px-3 sm:px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer border-b-2 -mb-px shrink-0 whitespace-nowrap"
            [class]="activeTab() === tab.key
              ? 'text-tracky-light border-tracky-light'
              : 'text-fg-tertiary border-transparent hover:text-fg-secondary'"
          >
            {{ tab.label }}
          </button>
        }
      </div>

      <!-- Wire Logs Tab -->
      @if (activeTab() === 'wire') {
        <div class="flex flex-wrap gap-3 items-end">
          <div class="flex flex-col gap-1 flex-1 min-w-[180px]">
            <label class="text-xs text-fg-tertiary">IMEI</label>
            <input [(ngModel)]="wireImeiFilter" placeholder="865328021056352"
                   class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary w-full" />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Direction</label>
            <select [(ngModel)]="wireDirectionFilter"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option value="">Toutes</option>
              <option value="IN">IN</option>
              <option value="OUT">OUT</option>
            </select>
          </div>
          <button (click)="loadWireLogs()" class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium
                  hover:bg-tracky-dark cursor-pointer flex items-center gap-2 shrink-0">
            <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
            Rafraîchir
          </button>
        </div>

        @if (wireLogs().length > 0) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
            <table class="w-full text-sm min-w-[700px]">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Date</th>
                  <th class="p-3 text-center">Dir</th>
                  <th class="p-3 text-left">IMEI</th>
                  <th class="p-3 text-left">Type</th>
                  <th class="p-3 text-left">Contenu</th>
                </tr>
              </thead>
              <tbody>
                @for (log of wireLogs(); track log.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                    <td class="p-3 text-fg-tertiary text-xs font-mono">{{ log.createdAt | date:'HH:mm:ss.SSS' }}</td>
                    <td class="p-3 text-center">
                      @if (log.direction === 'IN') {
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md bg-emerald-500/10 text-emerald-400">
                          <lucide-icon [img]="ArrowDownLeft" [size]="10"></lucide-icon> IN
                        </span>
                      } @else {
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md bg-sky-500/10 text-sky-400">
                          <lucide-icon [img]="ArrowUpRight" [size]="10"></lucide-icon> OUT
                        </span>
                      }
                    </td>
                    <td class="p-3 font-mono text-xs text-fg-primary">{{ log.imei.slice(0,4) }}...{{ log.imei.slice(-4) }}</td>
                    <td class="p-3 text-xs text-fg-tertiary">{{ log.frameType ?? '—' }}</td>
                    <td class="p-3 font-mono text-xs text-fg-primary truncate max-w-[320px] sm:max-w-[400px]">{{ log.raw }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="text-xs text-fg-tertiary">{{ wireTotal() }} résultats</p>
        } @else {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
            <lucide-icon [img]="Activity" [size]="48" class="opacity-30"></lucide-icon>
            <p>Aucun log wire</p>
          </div>
        }
      }

      <!-- Errors Tab -->
      @if (activeTab() === 'errors') {
        <div class="flex flex-wrap gap-3 items-end">
          <div class="flex flex-col gap-1 flex-1 min-w-[140px]">
            <label class="text-xs text-fg-tertiary">Source</label>
            <select [(ngModel)]="errorSourceFilter"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary w-full">
              <option value="">Toutes</option>
              <option value="tcp-server">tcp-server</option>
              <option value="http">http</option>
              <option value="engine-control">engine-control</option>
              <option value="tracker-commands">tracker-commands</option>
              <option value="positions">positions</option>
              <option value="geofences">geofences</option>
              <option value="trips">trips</option>
              <option value="schedule-cron">schedule-cron</option>
              <option value="wire-logger">wire-logger</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Niveau</label>
            <select [(ngModel)]="errorLevelFilter"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option value="">Tous</option>
              <option value="CRITICAL">CRITICAL</option>
              <option value="ERROR">ERROR</option>
            </select>
          </div>
          <div class="flex flex-col gap-1 flex-1 min-w-[140px]">
            <label class="text-xs text-fg-tertiary">IMEI</label>
            <input [(ngModel)]="errorImeiFilter" placeholder="865328021056352"
                   class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary w-full" />
          </div>
          <button (click)="loadErrorLogs()" class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium
                  hover:bg-tracky-dark cursor-pointer flex items-center gap-2 shrink-0">
            <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
            Rafraîchir
          </button>
        </div>

        @if (errorLogs().length > 0) {
          <div class="flex flex-col gap-2">
            @for (log of errorLogs(); track log.id) {
              <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 cursor-pointer hover:bg-bg-tertiary/50"
                   (click)="toggleErrorDetail(log.id)">
                <div class="flex items-start gap-3">
                  <div class="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                       [class]="log.level === 'CRITICAL' ? 'bg-red-500/20' : 'bg-amber-500/20'">
                    <lucide-icon [img]="AlertTriangle" [size]="16"
                                 [class]="log.level === 'CRITICAL' ? 'text-red-400' : 'text-amber-400'"></lucide-icon>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-xs px-2 py-0.5 rounded-md bg-bg-tertiary text-fg-tertiary">{{ log.source }}</span>
                      <span class="text-xs text-fg-tertiary">{{ log.createdAt | date:'dd/MM HH:mm:ss' }}</span>
                    </div>
                    <p class="text-sm text-fg-primary truncate">{{ log.message }}</p>
                    @if (expandedError() === log.id && log.stack) {
                      <pre class="mt-3 text-xs text-fg-tertiary bg-bg-tertiary rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{{ log.stack }}</pre>
                    }
                    @if (expandedError() === log.id && log.context) {
                      <pre class="mt-2 text-xs text-fg-tertiary bg-bg-tertiary rounded-lg p-3 overflow-x-auto">{{ log.context | json }}</pre>
                    }
                  </div>
                </div>
              </div>
            }
          </div>
        } @else {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
            <lucide-icon [img]="AlertTriangle" [size]="48" class="opacity-30"></lucide-icon>
            <p>Aucune erreur</p>
          </div>
        }
      }

      <!-- Timeline Tab -->
      @if (activeTab() === 'timeline') {
        <div class="flex gap-3 items-end">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">IMEI du tracker</label>
            <input [(ngModel)]="timelineImei" placeholder="865328021056352"
                   class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary w-48" />
          </div>
          <button (click)="loadTimeline()" class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium
                  hover:bg-tracky-dark cursor-pointer flex items-center gap-2"
                  [disabled]="!timelineImei()">
            <lucide-icon [img]="Search" [size]="14"></lucide-icon>
            Charger
          </button>
        </div>

        @if (timelineEntries().length > 0) {
          <div class="relative pl-8">
            <div class="absolute left-3 top-0 bottom-0 w-px bg-border-subtle"></div>
            @for (entry of timelineEntries(); track entry.id) {
              <div class="relative mb-4">
                <div class="absolute -left-5 w-3 h-3 rounded-full border-2 border-bg-primary"
                     [class]="entry.type === 'error' ? 'bg-red-400' : entry.direction === 'IN' ? 'bg-emerald-400' : 'bg-sky-400'">
                </div>
                <div class="bg-bg-secondary border border-border-subtle rounded-lg p-3">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] font-mono text-fg-tertiary">{{ entry.createdAt | date:'HH:mm:ss.SSS' }}</span>
                    @if (entry.type === 'wire') {
                      <span class="text-[10px] px-1.5 py-0.5 rounded"
                            [class]="entry.direction === 'IN' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-sky-500/10 text-sky-400'">
                        {{ entry.direction }} {{ entry.frameType }}
                      </span>
                    } @else {
                      <span class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">
                        {{ entry.level }} {{ entry.source }}
                      </span>
                    }
                    @if (entry.commandId) {
                      <span class="text-[10px] font-mono text-purple-400">cmd:{{ entry.commandId!.slice(0,8) }}</span>
                    }
                  </div>
                  <p class="text-xs font-mono text-fg-primary">
                    {{ entry.type === 'wire' ? entry.raw : entry.message }}
                  </p>
                </div>
              </div>
            }
          </div>
        } @else if (timelineImei()) {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
            <lucide-icon [img]="Clock" [size]="48" class="opacity-30"></lucide-icon>
            <p>Aucun événement pour cet IMEI</p>
          </div>
        }
      }
    </div>
  `,
})
export class ObservabilityComponent implements OnInit {
  private readonly logsApi = inject(AdminLogsService);
  private readonly toast = inject(ToastService);

  protected readonly Activity = Activity;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Search = Search;
  protected readonly RefreshCw = RefreshCw;
  protected readonly ArrowUpRight = ArrowUpRight;
  protected readonly ArrowDownLeft = ArrowDownLeft;
  protected readonly Clock = Clock;
  protected readonly Terminal = Terminal;

  protected readonly tabs = [
    { key: 'wire' as const, label: 'Wire Logs' },
    { key: 'errors' as const, label: 'Erreurs' },
    { key: 'timeline' as const, label: 'Timeline' },
  ];

  protected readonly activeTab = signal<'wire' | 'errors' | 'timeline'>('wire');
  protected readonly wireLogs = signal<WireLogDto[]>([]);
  protected readonly wireTotal = signal(0);
  protected readonly errorLogs = signal<ErrorLogDto[]>([]);
  protected readonly timelineEntries = signal<TimelineEntry[]>([]);
  protected readonly expandedError = signal<string | null>(null);

  protected readonly wireImeiFilter = signal('');
  protected readonly wireDirectionFilter = signal('');
  protected readonly errorSourceFilter = signal('');
  protected readonly errorLevelFilter = signal('');
  protected readonly errorImeiFilter = signal('');
  protected readonly timelineImei = signal('');

  async ngOnInit(): Promise<void> {
    await this.loadWireLogs();
    await this.loadErrorLogs();
  }

  protected async loadWireLogs(): Promise<void> {
    try {
      const params: Record<string, string> = { limit: '100' };
      const imei = this.wireImeiFilter();
      const dir = this.wireDirectionFilter();
      if (imei) params['imei'] = imei;
      if (dir) params['direction'] = dir;
      const res = await firstValueFrom(this.logsApi.listWireLogs(params));
      this.wireLogs.set(res.items);
      this.wireTotal.set(res.total);
    } catch {
      this.toast.error('Erreur de chargement des wire logs');
    }
  }

  protected async loadErrorLogs(): Promise<void> {
    try {
      const params: Record<string, string> = { limit: '100' };
      const source = this.errorSourceFilter();
      const level = this.errorLevelFilter();
      const imei = this.errorImeiFilter();
      if (source) params['source'] = source;
      if (level) params['level'] = level;
      if (imei) params['imei'] = imei;
      const res = await firstValueFrom(this.logsApi.listErrorLogs(params));
      this.errorLogs.set(res.items);
    } catch {
      this.toast.error('Erreur de chargement des error logs');
    }
  }

  protected async loadTimeline(): Promise<void> {
    const imei = this.timelineImei();
    if (!imei) return;
    try {
      const res = await firstValueFrom(this.logsApi.trackerTimeline(imei));
      this.timelineEntries.set(res.items);
    } catch {
      this.toast.error('Erreur de chargement de la timeline');
    }
  }

  protected toggleErrorDetail(id: string): void {
    this.expandedError.set(this.expandedError() === id ? null : id);
  }
}
