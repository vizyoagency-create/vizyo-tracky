import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  DbStatsDto,
  SystemHistoryDto,
  SystemRange,
  SystemSnapshotDto,
} from '@vizyo/tracky-shared';
import { SYSTEM_RANGES } from '@vizyo/tracky-shared';
import {
  ArrowLeft,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  LucideAngularModule,
  MemoryStick,
  RefreshCw,
} from 'lucide-angular';
import { SystemMetricsChartComponent } from './system-metrics-chart.component';
import { SystemMetricsApiService } from './system-metrics.service';

const RANGE_LABELS: Record<SystemRange, string> = {
  live: 'Live',
  '1h': '1h',
  today: "Aujourd'hui",
  yesterday: 'Hier',
  '7d': '7j',
  '30d': '30j',
};

@Component({
  selector: 'app-admin-system',
  standalone: true,
  imports: [DecimalPipe, RouterLink, LucideAngularModule, SystemMetricsChartComponent],
  template: `
    <div class="flex flex-col gap-6">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <a routerLink="/admin"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon>
            Administration
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary">Système VPS</h1>
          <p class="text-sm text-fg-tertiary">
            Perfs serveur (CPU / RAM / charge) et base de données — pour anticiper les purges.
          </p>
        </div>
        <button (click)="refresh()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
          Rafraichir
        </button>
      </div>

      <!-- KPI cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <!-- CPU -->
        <div class="p-4 rounded-[--radius-card] bg-bg-secondary border" [class]="borderFor(cpuLevel())">
          <div class="flex items-center justify-between">
            <span class="text-xs uppercase text-fg-tertiary">CPU</span>
            <lucide-icon [img]="Cpu" [size]="18" [class]="textFor(cpuLevel())"></lucide-icon>
          </div>
          <div class="text-2xl font-display font-bold mt-1" [class]="textFor(cpuLevel())">
            {{ snapshot()?.cpuPercent ?? '—' }}<span class="text-base">%</span>
          </div>
          <div class="text-[11px] text-fg-tertiary mt-0.5">{{ snapshot()?.cpuCount ?? '—' }} vCPU</div>
        </div>
        <!-- RAM -->
        <div class="p-4 rounded-[--radius-card] bg-bg-secondary border" [class]="borderFor(ramLevel())">
          <div class="flex items-center justify-between">
            <span class="text-xs uppercase text-fg-tertiary">RAM</span>
            <lucide-icon [img]="MemoryStick" [size]="18" [class]="textFor(ramLevel())"></lucide-icon>
          </div>
          <div class="text-2xl font-display font-bold mt-1" [class]="textFor(ramLevel())">
            {{ ramPct() }}<span class="text-base">%</span>
          </div>
          <div class="text-[11px] text-fg-tertiary mt-0.5">
            {{ fmtMb(snapshot()?.memUsedMb) }} / {{ fmtMb(snapshot()?.memTotalMb) }}
          </div>
        </div>
        <!-- Load -->
        <div class="p-4 rounded-[--radius-card] bg-bg-secondary border" [class]="borderFor(loadLevel())">
          <div class="flex items-center justify-between">
            <span class="text-xs uppercase text-fg-tertiary">Charge</span>
            <lucide-icon [img]="Gauge" [size]="18" [class]="textFor(loadLevel())"></lucide-icon>
          </div>
          <div class="text-2xl font-display font-bold mt-1" [class]="textFor(loadLevel())">
            {{ snapshot()?.loadAvg1 ?? '—' }}
          </div>
          <div class="text-[11px] text-fg-tertiary mt-0.5">
            {{ loadPerCore() | number: '1.2-2' }}/cœur · 5m {{ snapshot()?.loadAvg5 ?? '—' }}
          </div>
        </div>
        <!-- DB -->
        <div class="p-4 rounded-[--radius-card] bg-bg-secondary border border-sky-500/20">
          <div class="flex items-center justify-between">
            <span class="text-xs uppercase text-fg-tertiary">Base de données</span>
            <lucide-icon [img]="Database" [size]="18" class="text-sky-400"></lucide-icon>
          </div>
          <div class="text-2xl font-display font-bold mt-1 text-sky-400">{{ fmtMb(snapshot()?.dbSizeMb) }}</div>
          <div class="text-[11px] text-fg-tertiary mt-0.5">
            @if (db()?.dbGrowthMbPerDay != null) {
              +{{ db()!.dbGrowthMbPerDay | number: '1.0-1' }} Mo/j
            } @else {
              croissance: mesure en cours (≥24h)
            }
          </div>
        </div>
      </div>

      <!-- Chart + range -->
      <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
        <div class="flex items-center justify-between gap-2 flex-wrap mb-3">
          <span class="text-sm font-medium text-fg-secondary">CPU / RAM / Charge</span>
          <div class="flex items-center gap-1 flex-wrap">
            @for (r of ranges; track r) {
              <button (click)="setRange(r)"
                      class="px-2.5 py-1 text-xs rounded-md border transition-colors"
                      [class]="r === range()
                        ? 'bg-tracky text-white border-tracky'
                        : 'bg-bg-tertiary text-fg-secondary border-border-subtle hover:border-tracky'">
                @if (r === 'live') { <span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-400 mr-1 animate-pulse"></span> }
                {{ rangeLabel(r) }}
              </button>
            }
          </div>
        </div>
        @if (points().length > 0) {
          <app-system-metrics-chart [points]="points()" [memTotalMb]="memTotalMb()"></app-system-metrics-chart>
        } @else {
          <div class="h-[300px] flex items-center justify-center text-sm text-fg-tertiary">
            {{ loading() ? 'Chargement…' : 'Pas encore de données sur cette plage (collecte toutes les 60s).' }}
          </div>
        }
      </div>

      <!-- DB tables -->
      <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
        <div class="p-4 flex items-center gap-2 border-b border-border-subtle">
          <lucide-icon [img]="HardDrive" [size]="16" class="text-fg-tertiary"></lucide-icon>
          <span class="text-sm font-medium text-fg-secondary">Tables (taille décroissante)</span>
          <span class="text-xs text-fg-tertiary ml-auto">
            positions ≈ {{ db()?.positionsCount | number }} lignes
          </span>
        </div>
        <table class="w-full text-sm min-w-[520px]">
          <thead class="text-fg-tertiary text-xs uppercase border-b border-border-subtle">
            <tr>
              <th class="p-3 text-left">Table</th>
              <th class="p-3 text-right">Lignes (est.)</th>
              <th class="p-3 text-right">Total</th>
              <th class="p-3 text-right">Index</th>
            </tr>
          </thead>
          <tbody>
            @for (t of db()?.tables ?? []; track t.table) {
              <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                <td class="p-3 font-mono text-xs text-fg-primary">{{ t.table }}</td>
                <td class="p-3 text-right text-fg-secondary">{{ t.rows | number }}</td>
                <td class="p-3 text-right font-medium text-fg-primary">{{ fmtMb(t.totalMb) }}</td>
                <td class="p-3 text-right text-fg-tertiary">{{ fmtMb(t.indexMb) }}</td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="p-6 text-center text-sm text-fg-tertiary">Chargement…</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class AdminSystemComponent implements OnInit, OnDestroy {
  private readonly api = inject(SystemMetricsApiService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Cpu = Cpu;
  protected readonly Database = Database;
  protected readonly Gauge = Gauge;
  protected readonly HardDrive = HardDrive;
  protected readonly MemoryStick = MemoryStick;
  protected readonly RefreshCw = RefreshCw;

  readonly snapshot = signal<SystemSnapshotDto | null>(null);
  readonly history = signal<SystemHistoryDto | null>(null);
  readonly db = signal<DbStatsDto | null>(null);
  readonly range = signal<SystemRange>('1h');
  readonly loading = signal(false);

  readonly ranges = SYSTEM_RANGES;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  readonly points = computed(() => this.history()?.points ?? []);
  readonly memTotalMb = computed(
    () => this.history()?.memTotalMb ?? this.snapshot()?.memTotalMb ?? 0,
  );
  readonly ramPct = computed(() => {
    const s = this.snapshot();
    return s && s.memTotalMb ? Math.round((s.memUsedMb / s.memTotalMb) * 100) : 0;
  });
  readonly loadPerCore = computed(() => {
    const s = this.snapshot();
    return s && s.cpuCount ? s.loadAvg1 / s.cpuCount : 0;
  });
  readonly cpuLevel = computed(() => level(this.snapshot()?.cpuPercent ?? 0, 70, 90));
  readonly ramLevel = computed(() => level(this.ramPct(), 70, 85));
  readonly loadLevel = computed(() => level(this.loadPerCore() * 100, 70, 100));

  ngOnInit(): void {
    this.refresh();
    this.pollHandle = setInterval(() => {
      this.refreshCurrent();
      if (this.range() === 'live') this.loadHistory();
    }, 5000);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = null;
  }

  refresh(): void {
    this.refreshCurrent();
    this.loadHistory();
    this.loadDb();
  }

  setRange(r: SystemRange): void {
    this.range.set(r);
    this.loadHistory();
  }

  protected rangeLabel(r: SystemRange): string {
    return RANGE_LABELS[r];
  }

  protected fmtMb(mb: number | null | undefined): string {
    if (mb == null) return '—';
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} Go`;
    return `${Math.round(mb)} Mo`;
  }

  protected borderFor(lvl: Level): string {
    return lvl === 'red'
      ? 'border-rose-500/30'
      : lvl === 'amber'
        ? 'border-amber-500/30'
        : 'border-emerald-500/20';
  }
  protected textFor(lvl: Level): string {
    return lvl === 'red' ? 'text-rose-400' : lvl === 'amber' ? 'text-amber-400' : 'text-emerald-400';
  }

  private refreshCurrent(): void {
    this.api.current().subscribe({
      next: (s) => this.snapshot.set(s),
      error: () => undefined,
    });
  }
  private loadHistory(): void {
    this.loading.set(true);
    this.api.history(this.range()).subscribe({
      next: (h) => {
        this.history.set(h);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
  private loadDb(): void {
    this.api.db().subscribe({ next: (d) => this.db.set(d), error: () => undefined });
  }
}

type Level = 'green' | 'amber' | 'red';
function level(value: number, amberAt: number, redAt: number): Level {
  if (value >= redAt) return 'red';
  if (value >= amberAt) return 'amber';
  return 'green';
}
