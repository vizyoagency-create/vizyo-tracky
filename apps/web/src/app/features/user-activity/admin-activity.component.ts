import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type {
  ActivityFeedItemDto,
  ActivityStatsDto,
  EngineCommandAuditDto,
  OnlineUserDto,
  PresenceStatus,
} from '@vizyo/tracky-shared';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  LogIn,
  LogOut,
  LucideAngularModule,
  MapPin,
  Moon,
  MousePointer2,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Users,
} from 'lucide-angular';
import { relativeTime } from '../../shared/utils/relative-time';
import { UserActivityApiService } from './user-activity-api.service';

type Tab = 'live' | 'history' | 'analytics' | 'engine-commands';
type Period = '24h' | '7d' | '30d';

@Component({
  selector: 'app-admin-activity',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, LucideAngularModule],
  template: `
    <div class="flex flex-col gap-5">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <a routerLink="/admin"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon> Administration
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary">Activité utilisateurs</h1>
          <p class="text-sm text-fg-tertiary">Qui est en ligne, sur quelle page, et ce que font les utilisateurs.</p>
        </div>
        <button (click)="reload()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon> Rafraichir
        </button>
      </div>

      <!-- Tabs -->
      <div class="flex items-center gap-1 border-b border-border-subtle">
        @for (t of tabs; track t.id) {
          <button (click)="setTab(t.id)"
                  class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors"
                  [class]="t.id === tab()
                    ? 'border-tracky text-fg-primary'
                    : 'border-transparent text-fg-tertiary hover:text-fg-secondary'">
            {{ t.label }}
            @if (t.id === 'live') {
              <span class="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">{{ online().length }}</span>
            }
          </button>
        }
      </div>

      <!-- ─────────── LIVE ─────────── -->
      @if (tab() === 'live') {
        <div class="grid lg:grid-cols-2 gap-4">
          <!-- Online users -->
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="flex items-center gap-2 mb-3">
              <lucide-icon [img]="Users" [size]="16" class="text-tracky-light"></lucide-icon>
              <span class="text-sm font-medium text-fg-secondary">En ligne maintenant ({{ online().length }})</span>
              <span class="ml-auto inline-block w-2 h-2 rounded-full bg-rose-400 animate-pulse"></span>
            </div>
            <div class="flex flex-col gap-2">
              @for (u of online(); track u.userId) {
                <div class="flex items-center gap-3 p-2.5 rounded-lg bg-bg-tertiary/40 border border-border-subtle/60">
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" [style.background]="statusColor(u.status)"
                        [title]="statusLabel(u.status)"></span>
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-fg-primary truncate flex items-center gap-1.5">
                      {{ u.name }}
                      <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-bg-tertiary text-fg-tertiary uppercase tracking-wide">{{ u.role }}</span>
                    </div>
                    <div class="text-xs text-fg-tertiary truncate flex items-center gap-1">
                      <lucide-icon [img]="MapPin" [size]="11" class="shrink-0"></lucide-icon>
                      {{ u.currentRouteLabel ?? u.currentRoute ?? '—' }}
                      · {{ statusLabel(u.status) }}
                    </div>
                  </div>
                  <div class="text-right shrink-0">
                    <div class="text-[11px] text-fg-secondary">{{ fmtDur(u.sinceMs) }}</div>
                    <div class="text-[10px] text-fg-tertiary">{{ u.deviceType ?? '' }}</div>
                  </div>
                </div>
              } @empty {
                <p class="text-sm text-fg-tertiary text-center py-6">Personne en ligne actuellement.</p>
              }
            </div>
          </div>

          <!-- Live feed -->
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="text-sm font-medium text-fg-secondary mb-3">Flux en direct</div>
            <div class="flex flex-col gap-1 max-h-[420px] overflow-y-auto">
              @for (a of feed(); track a.id) {
                <div class="flex items-center gap-2 text-xs py-1 px-1.5 rounded-md hover:bg-bg-tertiary/40">
                  <span class="text-fg-tertiary tabular-nums shrink-0 font-mono">{{ a.at | date: 'HH:mm:ss' }}</span>
                  <lucide-icon [img]="typeIcon(a.type)" [size]="13" class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="font-medium text-fg-secondary shrink-0">{{ a.userName }}</span>
                  <span class="text-fg-tertiary truncate">{{ describe(a) }}</span>
                </div>
              } @empty {
                <p class="text-sm text-fg-tertiary text-center py-6">Aucune activité pour l'instant.</p>
              }
            </div>
          </div>
        </div>
      }

      <!-- ─────────── HISTORIQUE ─────────── -->
      @if (tab() === 'history') {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
          <div class="flex flex-col">
            @for (a of history(); track a.id) {
              <div class="flex items-center gap-2 text-xs py-1.5 px-1.5 rounded-md border-b border-border-subtle/30 hover:bg-bg-tertiary/40">
                <span class="text-fg-tertiary tabular-nums shrink-0 w-[112px] font-mono">{{ a.at | date: 'dd/MM HH:mm:ss' }}</span>
                <lucide-icon [img]="typeIcon(a.type)" [size]="13" class="text-fg-tertiary shrink-0"></lucide-icon>
                <span class="font-medium text-fg-secondary shrink-0">{{ a.userName }}</span>
                <span class="text-fg-tertiary truncate">{{ describe(a) }}</span>
              </div>
            } @empty {
              <p class="text-sm text-fg-tertiary text-center py-6">Aucun historique.</p>
            }
          </div>
          @if (history().length > 0) {
            <button (click)="loadMore()" [disabled]="loadingMore()"
                    class="mt-3 w-full py-2 text-sm text-fg-secondary border border-border-subtle rounded-lg hover:border-tracky disabled:opacity-50">
              {{ loadingMore() ? 'Chargement…' : 'Charger plus' }}
            </button>
          }
        </div>
      }

      <!-- ─────────── ANALYTICS ─────────── -->
      @if (tab() === 'analytics') {
        <div class="flex items-center gap-1">
          @for (p of periods; track p.id) {
            <button (click)="setPeriod(p.id)"
                    class="px-2.5 py-1 text-xs rounded-md border"
                    [class]="p.id === period()
                      ? 'bg-tracky text-white border-tracky'
                      : 'bg-bg-tertiary text-fg-secondary border-border-subtle hover:border-tracky'">
              {{ p.label }}
            </button>
          }
        </div>

        @if (stats(); as s) {
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div class="p-4 rounded-[--radius-card] bg-bg-secondary border border-border-subtle">
              <div class="text-xs uppercase text-fg-tertiary">Utilisateurs</div>
              <div class="text-2xl font-display font-bold text-fg-primary">{{ s.uniqueUsers }}</div>
            </div>
            <div class="p-4 rounded-[--radius-card] bg-bg-secondary border border-border-subtle">
              <div class="text-xs uppercase text-fg-tertiary">Sessions</div>
              <div class="text-2xl font-display font-bold text-fg-primary">{{ s.totalSessions }}</div>
            </div>
            <div class="p-4 rounded-[--radius-card] bg-bg-secondary border border-border-subtle">
              <div class="text-xs uppercase text-fg-tertiary">Pages vues</div>
              <div class="text-2xl font-display font-bold text-fg-primary">{{ s.totalPageViews }}</div>
            </div>
            <div class="p-4 rounded-[--radius-card] bg-bg-secondary border border-border-subtle">
              <div class="text-xs uppercase text-fg-tertiary">Durée moy. session</div>
              <div class="text-2xl font-display font-bold text-fg-primary">{{ fmtSec(s.avgSessionSec) }}</div>
            </div>
          </div>

          <div class="grid lg:grid-cols-2 gap-4">
            <!-- Top pages -->
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
              <div class="text-sm font-medium text-fg-secondary mb-3">Pages les plus visitées</div>
              <div class="flex flex-col gap-2">
                @for (p of s.topPages; track p.route) {
                  <div>
                    <div class="flex items-center justify-between text-xs mb-0.5">
                      <span class="text-fg-secondary truncate">{{ p.label }}</span>
                      <span class="text-fg-tertiary shrink-0 ml-2">{{ p.views }} · {{ fmtMs(p.avgDurationMs) }}</span>
                    </div>
                    <div class="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                      <div class="h-full bg-tracky-light rounded-full" [style.width.%]="barPct(p.views, s.topPages[0].views)"></div>
                    </div>
                  </div>
                } @empty {
                  <p class="text-sm text-fg-tertiary py-4 text-center">Pas encore de données.</p>
                }
              </div>
            </div>

            <!-- Top clicks -->
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
              <div class="text-sm font-medium text-fg-secondary mb-3">Clics les plus fréquents</div>
              <div class="flex flex-col gap-1.5">
                @for (c of s.topClicks; track c.target; let i = $index) {
                  <div class="flex items-center justify-between text-xs">
                    <span class="text-fg-secondary truncate">{{ i + 1 }}. {{ c.target }}</span>
                    <span class="text-fg-tertiary shrink-0 ml-2 tabular-nums">{{ c.count }}×</span>
                  </div>
                } @empty {
                  <p class="text-sm text-fg-tertiary py-4 text-center">
                    Aucun clic tracké (ajouter <code>trackClick</code> aux boutons).
                  </p>
                }
              </div>
            </div>
          </div>

          <!-- Sessions / day -->
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="text-sm font-medium text-fg-secondary mb-3">Sessions par jour</div>
            <div class="flex items-end gap-1.5 h-28">
              @for (d of s.sessionsPerDay; track d.date) {
                <div class="flex-1 flex flex-col items-center gap-1 min-w-0">
                  <div class="w-full bg-tracky-light/70 rounded-t" [style.height.%]="barPct(d.count, maxSessions())"
                       [title]="d.count + ' sessions'"></div>
                  <span class="text-[9px] text-fg-tertiary truncate w-full text-center">{{ d.date | date: 'dd/MM' }}</span>
                </div>
              } @empty {
                <p class="text-sm text-fg-tertiary w-full text-center self-center">Pas encore de données.</p>
              }
            </div>
          </div>
        } @else {
          <p class="text-sm text-fg-tertiary text-center py-6">Chargement…</p>
        }
      }

      <!-- ─────────── COMMANDES MOTEUR ─────────── -->
      @if (tab() === 'engine-commands') {
        <!-- Filters -->
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Action</label>
            <select [ngModel]="actionFilter()" (ngModelChange)="setActionFilter($event)"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option value="">Toutes</option>
              <option value="CUT">Coupure</option>
              <option value="RESTORE">Redémarrage</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Statut</label>
            <select [ngModel]="statusFilter()" (ngModelChange)="setStatusFilter($event)"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option value="">Tous</option>
              <option value="ACKNOWLEDGED">Confirmé</option>
              <option value="SENT">Envoyé</option>
              <option value="PENDING">En attente</option>
              <option value="FAILED">Échec</option>
              <option value="REJECTED_SPEED">Refusé (vitesse)</option>
            </select>
          </div>
        </div>

        @if (enginecmds().length > 0) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
            <table class="w-full text-sm">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase tracking-wide">
                <tr>
                  <th class="px-4 py-3 text-left font-medium">Quand</th>
                  <th class="px-4 py-3 text-left font-medium">Véhicule</th>
                  <th class="px-4 py-3 text-left font-medium">Action</th>
                  <th class="px-4 py-3 text-left font-medium">Par</th>
                  <th class="px-4 py-3 text-left font-medium">Statut</th>
                  <th class="px-4 py-3 text-left font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                @for (c of enginecmds(); track c.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/40 align-top">
                    <!-- Quand -->
                    <td class="px-4 py-3 text-fg-tertiary whitespace-nowrap" [title]="(c.createdAt | date: 'dd/MM/yyyy HH:mm:ss') ?? ''">
                      {{ relativeTime(c.createdAt) }}
                    </td>
                    <!-- Véhicule -->
                    <td class="px-4 py-3">
                      <span class="font-mono text-fg-primary">{{ c.vehiclePlate ?? c.trackerImei }}</span>
                      @if (!c.vehiclePlate) {
                        <span class="block text-[10px] text-fg-tertiary">IMEI</span>
                      }
                    </td>
                    <!-- Action -->
                    <td class="px-4 py-3">
                      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full"
                            [class]="c.action === 'CUT' ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'">
                        <lucide-icon [img]="c.action === 'CUT' ? PowerOff : Power" [size]="12"></lucide-icon>
                        {{ c.action === 'CUT' ? 'Coupé' : 'Redémarré' }}
                      </span>
                    </td>
                    <!-- Par -->
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="text-fg-secondary">{{ c.requestedByName }}</span>
                        @if (c.requestedByRole) {
                          <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-bg-tertiary text-fg-tertiary uppercase tracking-wide">{{ c.requestedByRole }}</span>
                        }
                      </div>
                    </td>
                    <!-- Statut -->
                    <td class="px-4 py-3">
                      <span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full" [class]="statusClass(c.status)">
                        {{ cmdStatusLabel(c.status) }}
                      </span>
                      @if (c.reason || c.lastError) {
                        <span class="block text-[11px] text-fg-tertiary mt-1 max-w-[260px] truncate"
                              [title]="c.lastError ?? c.reason ?? ''">
                          {{ c.lastError ?? c.reason }}
                        </span>
                      }
                    </td>
                    <!-- Source -->
                    <td class="px-4 py-3">
                      <span class="inline-block px-2 py-0.5 text-xs rounded-md bg-bg-tertiary text-fg-tertiary">
                        {{ sourceLabel(c.source) }}
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <button (click)="loadMoreEngine()" [disabled]="loadingMore()"
                  class="w-full py-2 text-sm text-fg-secondary border border-border-subtle rounded-lg hover:border-tracky disabled:opacity-50">
            {{ loadingMore() ? 'Chargement…' : 'Charger plus' }}
          </button>
        } @else {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
            <lucide-icon [img]="PowerOff" [size]="40" class="opacity-30"></lucide-icon>
            <p class="text-sm">Aucune commande moteur.</p>
          </div>
        }
      }
    </div>
  `,
})
export class AdminActivityComponent implements OnInit, OnDestroy {
  private readonly api = inject(UserActivityApiService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Users = Users;
  protected readonly MapPin = MapPin;
  protected readonly Power = Power;
  protected readonly PowerOff = PowerOff;
  protected readonly relativeTime = relativeTime;

  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'live', label: 'Live' },
    { id: 'history', label: 'Historique' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'engine-commands', label: 'Commandes moteur' },
  ];
  readonly periods: { id: Period; label: string }[] = [
    { id: '24h', label: '24h' },
    { id: '7d', label: '7 jours' },
    { id: '30d', label: '30 jours' },
  ];

  readonly tab = signal<Tab>('live');
  readonly online = signal<OnlineUserDto[]>([]);
  readonly feed = signal<ActivityFeedItemDto[]>([]);
  readonly history = signal<ActivityFeedItemDto[]>([]);
  readonly loadingMore = signal(false);
  readonly stats = signal<ActivityStatsDto | null>(null);
  readonly period = signal<Period>('7d');

  // Commandes moteur (audit coupe-circuit).
  readonly enginecmds = signal<EngineCommandAuditDto[]>([]);
  readonly actionFilter = signal('');
  readonly statusFilter = signal('');

  readonly maxSessions = computed(() =>
    Math.max(1, ...(this.stats()?.sessionsPerDay ?? []).map((d) => d.count)),
  );

  private pollHandle: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.loadLive();
    this.pollHandle = setInterval(() => {
      if (this.tab() === 'live') this.loadLive();
    }, 5000);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  setTab(t: Tab): void {
    this.tab.set(t);
    if (t === 'live') this.loadLive();
    else if (t === 'history') this.loadHistory();
    else if (t === 'engine-commands') this.loadEngine();
    else this.loadStats();
  }

  reload(): void {
    if (this.tab() === 'live') this.loadLive();
    else if (this.tab() === 'history') this.loadHistory();
    else if (this.tab() === 'engine-commands') this.loadEngine();
    else this.loadStats();
  }

  setPeriod(p: Period): void {
    this.period.set(p);
    this.loadStats();
  }

  loadMore(): void {
    const last = this.history()[this.history().length - 1];
    if (!last) return;
    this.loadingMore.set(true);
    this.api.feed(50, last.at).subscribe({
      next: (items) => {
        this.history.update((h) => [...h, ...items]);
        this.loadingMore.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }

  setActionFilter(v: string): void {
    this.actionFilter.set(v);
    this.loadEngine();
  }
  setStatusFilter(v: string): void {
    this.statusFilter.set(v);
    this.loadEngine();
  }

  loadMoreEngine(): void {
    const last = this.enginecmds()[this.enginecmds().length - 1];
    if (!last) return;
    this.loadingMore.set(true);
    this.api
      .engineCommands(50, last.createdAt, this.actionFilter() || undefined, this.statusFilter() || undefined)
      .subscribe({
        next: (items) => {
          this.enginecmds.update((l) => [...l, ...items]);
          this.loadingMore.set(false);
        },
        error: () => this.loadingMore.set(false),
      });
  }

  private loadEngine(): void {
    this.api
      .engineCommands(50, undefined, this.actionFilter() || undefined, this.statusFilter() || undefined)
      .subscribe({ next: (l) => this.enginecmds.set(l), error: () => undefined });
  }

  private loadLive(): void {
    this.api.online().subscribe({ next: (u) => this.online.set(u), error: () => undefined });
    this.api.feed(50).subscribe({ next: (f) => this.feed.set(f), error: () => undefined });
  }
  private loadHistory(): void {
    this.api.feed(80).subscribe({ next: (f) => this.history.set(f), error: () => undefined });
  }
  private loadStats(): void {
    this.stats.set(null);
    const from = this.periodFrom();
    this.api.stats(from).subscribe({ next: (s) => this.stats.set(s), error: () => undefined });
  }

  private periodFrom(): string {
    const now = Date.now();
    const days = this.period() === '24h' ? 1 : this.period() === '7d' ? 7 : 30;
    return new Date(now - days * 86_400_000).toISOString();
  }

  // ── helpers d'affichage ──
  protected statusColor(s: PresenceStatus): string {
    return s === 'ACTIVE' ? '#34d399' : s === 'IDLE' ? '#fbbf24' : s === 'AWAY' ? '#fb923c' : '#6b7280';
  }
  protected statusLabel(s: PresenceStatus): string {
    return s === 'ACTIVE' ? 'actif' : s === 'IDLE' ? 'inactif' : s === 'AWAY' ? 'absent' : 'hors ligne';
  }
  protected typeIcon(t: ActivityFeedItemDto['type']) {
    switch (t) {
      case 'PAGE_VIEW': return ArrowRight;
      case 'CLICK': return MousePointer2;
      case 'SESSION_START': return LogIn;
      case 'SESSION_END': return LogOut;
      case 'SESSION_RESUME': return RotateCcw;
      case 'IDLE': return Moon;
      case 'AWAY': return CircleAlert;
      default: return Activity;
    }
  }

  // ── helpers commandes moteur ──
  protected cmdStatusLabel(s: EngineCommandAuditDto['status']): string {
    switch (s) {
      case 'ACKNOWLEDGED': return 'Confirmé';
      case 'SENT': return 'Envoyé';
      case 'PENDING': return 'En attente';
      case 'FAILED': return 'Échec';
      case 'REJECTED_SPEED': return 'Refusé (vitesse)';
      default: return s;
    }
  }
  protected statusClass(s: EngineCommandAuditDto['status']): string {
    switch (s) {
      case 'ACKNOWLEDGED': return 'bg-emerald-500/15 text-emerald-400';
      case 'SENT': return 'bg-sky-500/15 text-sky-400';
      case 'PENDING': return 'bg-amber-500/15 text-amber-400';
      case 'FAILED': return 'bg-rose-500/15 text-rose-400';
      case 'REJECTED_SPEED': return 'bg-orange-500/15 text-orange-400';
      default: return 'bg-bg-tertiary text-fg-tertiary';
    }
  }
  protected sourceLabel(src: string): string {
    switch (src) {
      case 'MANUAL': return 'Manuel';
      case 'SCHEDULER': return 'Planning';
      case 'DEVICE_OBSERVED': return 'Boîtier';
      default: return src;
    }
  }
  protected describe(a: ActivityFeedItemDto): string {
    switch (a.type) {
      case 'PAGE_VIEW':
        return `${a.routeLabel ?? a.route ?? ''}${a.durationMs != null ? ` (${this.fmtMs(a.durationMs)})` : ''}`;
      case 'CLICK': return `cliqué « ${a.target} »`;
      case 'SESSION_START': return 'connecté';
      case 'SESSION_END': return 'déconnecté';
      case 'SESSION_RESUME': return 'session reprise';
      case 'IDLE': return 'inactif';
      case 'AWAY': return 'absent';
      default: return a.type;
    }
  }
  protected barPct(v: number, max: number): number {
    return max > 0 ? Math.round((v / max) * 100) : 0;
  }
  protected fmtDur(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  protected fmtMs(ms: number): string {
    return this.fmtDur(ms);
  }
  protected fmtSec(sec: number): string {
    return this.fmtDur(sec * 1000);
  }
}
