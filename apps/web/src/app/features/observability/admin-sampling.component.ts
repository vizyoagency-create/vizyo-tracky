import { swallow } from '../../core/error/swallow';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ArrowLeft,
  Clock,
  Database,
  Gauge,
  LucideAngularModule,
  Power,
  RefreshCw,
  Zap,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  AdminSamplingService,
  SamplingDecisionDto,
  SamplingHistogramBucket,
  SamplingStatsDto,
} from '../../core/services/admin-sampling.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

@Component({
  selector: 'app-admin-sampling',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, DecimalPipe, FormsModule, RouterLink],
  template: `
    <div class="flex flex-col gap-6">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="flex flex-col gap-1">
          <a routerLink="/admin/observability"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon>
            Diagnostic & Tests
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary">
            Sampling adaptatif
          </h1>
          <p class="text-sm text-fg-tertiary">
            Tracker <span class="font-mono">{{ trackerId().slice(0, 8) }}…</span>
            — fenetre {{ rangeHours() }}h
          </p>
        </div>

        <div class="flex flex-wrap items-end gap-2">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Fenetre</label>
            <select [(ngModel)]="rangeHoursValue" (change)="onRangeChange()"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option [value]="24">24h</option>
              <option [value]="72">3 jours</option>
              <option [value]="168">7 jours</option>
            </select>
          </div>
          <button (click)="reload()"
                  class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
            <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
            Rafraichir
          </button>
        </div>
      </div>

      <!-- KPIs -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-2">
          <div class="flex items-center gap-2 text-fg-tertiary text-xs uppercase">
            <lucide-icon [img]="Database" [size]="14"></lucide-icon>
            Trames recues
          </div>
          <div class="text-2xl font-display font-bold text-fg-primary">
            {{ stats()?.received ?? 0 }}
          </div>
        </div>

        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-2">
          <div class="flex items-center gap-2 text-fg-tertiary text-xs uppercase">
            <lucide-icon [img]="Database" [size]="14"></lucide-icon>
            Persistees
          </div>
          <div class="text-2xl font-display font-bold text-emerald-400">
            {{ stats()?.inserted ?? 0 }}
          </div>
        </div>

        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-2">
          <div class="flex items-center gap-2 text-fg-tertiary text-xs uppercase">
            <lucide-icon [img]="Gauge" [size]="14"></lucide-icon>
            Skippees
          </div>
          <div class="text-2xl font-display font-bold text-amber-400">
            {{ stats()?.skipped ?? 0 }}
          </div>
        </div>

        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-2">
          <div class="flex items-center gap-2 text-fg-tertiary text-xs uppercase">
            <lucide-icon [img]="Zap" [size]="14"></lucide-icon>
            Ratio insert
          </div>
          <div class="text-2xl font-display font-bold text-fg-primary">
            {{ (insertRatioPct() | number: '1.0-1') }}%
          </div>
          <div class="text-[10px] text-fg-tertiary">
            Plus le ratio est bas, plus le sampling economise.
          </div>
        </div>
      </div>

      <!-- Verbose toggle -->
      <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex items-start gap-3 flex-wrap">
        <lucide-icon [img]="Power" [size]="18" class="text-amber-400 mt-0.5"></lucide-icon>
        <div class="flex-1 min-w-[200px]">
          <div class="text-sm font-semibold text-fg-primary">Mode verbose (debugging)</div>
          <div class="text-xs text-fg-tertiary mt-0.5">
            Force la persistance de chaque trame entrante pendant la duree choisie. Utile pour
            diagnostiquer un boitier qui semble mal sample.
          </div>
        </div>
        <div class="flex items-center gap-2">
          <select [(ngModel)]="verboseDurationMinutes"
                  class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm">
            <option [value]="0">Desactiver</option>
            <option [value]="15">15 min</option>
            <option [value]="60">1 h</option>
            <option [value]="240">4 h</option>
            <option [value]="1440">24 h</option>
          </select>
          <button (click)="applyVerbose()"
                  class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer">
            Appliquer
          </button>
        </div>
      </div>

      <!-- Repartition par etat -->
      @if (stats() && stats()!.byState.length > 0) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
          <h2 class="text-sm font-semibold text-fg-primary mb-3">Repartition par etat</h2>
          <div class="flex flex-col gap-2">
            @for (row of stats()!.byState; track row.state) {
              <div class="flex items-center gap-3 text-sm">
                <div class="w-32 font-mono text-xs text-fg-secondary">{{ row.state }}</div>
                <div class="flex-1 h-6 bg-bg-tertiary rounded overflow-hidden flex">
                  <div class="bg-emerald-500 h-full" [style.width.%]="rowInsertedPct(row)"
                       [title]="row.inserted + ' inserees'"></div>
                  <div class="bg-amber-500 h-full" [style.width.%]="rowSkippedPct(row)"
                       [title]="row.skipped + ' skippees'"></div>
                </div>
                <div class="text-xs text-fg-tertiary w-20 text-right">
                  {{ row.inserted }}/{{ row.inserted + row.skipped }}
                </div>
              </div>
            }
          </div>
        </div>
      }

      <!-- Histogramme par heure -->
      @if (histogram().length > 0) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
          <h2 class="text-sm font-semibold text-fg-primary mb-3">Activite par heure (7 derniers jours)</h2>
          <div class="flex items-end gap-0.5 h-32 overflow-x-auto">
            @for (b of histogram(); track b.hour) {
              <div class="flex flex-col gap-0.5 min-w-[6px]" [title]="bucketTooltip(b)">
                @if (b.inserted > 0) {
                  <div class="bg-emerald-500" [style.height.px]="bucketPx(b, 'inserted')"></div>
                }
                @if (b.skipped > 0) {
                  <div class="bg-amber-500" [style.height.px]="bucketPx(b, 'skipped')"></div>
                }
              </div>
            }
          </div>
          <div class="flex items-center gap-4 mt-2 text-xs text-fg-tertiary">
            <span class="flex items-center gap-1">
              <span class="w-2 h-2 bg-emerald-500"></span> Inserees
            </span>
            <span class="flex items-center gap-1">
              <span class="w-2 h-2 bg-amber-500"></span> Skippees
            </span>
          </div>
        </div>
      }

      <!-- Recent decisions -->
      @if (recentDecisions().length > 0) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
          <table class="w-full text-sm min-w-[700px]">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">Heure</th>
                <th class="p-3 text-left">Etat</th>
                <th class="p-3 text-left">Decision</th>
                <th class="p-3 text-right">Vitesse</th>
                <th class="p-3 text-right">Distance</th>
                <th class="p-3 text-left">Raison</th>
              </tr>
            </thead>
            <tbody>
              @for (d of recentDecisions(); track d.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                  <td class="p-3 text-fg-tertiary text-xs font-mono">
                    {{ d.receivedAt | date: 'dd/MM HH:mm:ss' }}
                  </td>
                  <td class="p-3 text-xs font-mono text-fg-secondary">{{ d.state }}</td>
                  <td class="p-3">
                    <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md font-mono"
                          [class]="badgeClass(d.decision)">
                      {{ d.decision }}
                    </span>
                  </td>
                  <td class="p-3 text-right text-xs font-mono text-fg-secondary">
                    {{ (d.speedKmh ?? 0) | number: '1.0-1' }}
                  </td>
                  <td class="p-3 text-right text-xs font-mono text-fg-secondary">
                    @if (d.distanceM !== null) {
                      {{ d.distanceM | number: '1.0-1' }}m
                    } @else {
                      —
                    }
                  </td>
                  <td class="p-3 text-xs text-fg-tertiary">{{ d.reason ?? '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else if (!loading()) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-8 text-center text-sm text-fg-tertiary">
          <lucide-icon [img]="Clock" [size]="32" class="mx-auto mb-2 opacity-40"></lucide-icon>
          Aucune decision de sampling enregistree pour ce tracker dans la fenetre.
        </div>
      }
    </div>
  `,
})
export class AdminSamplingComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AdminSamplingService);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Clock = Clock;
  protected readonly Database = Database;
  protected readonly Gauge = Gauge;
  protected readonly Power = Power;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Zap = Zap;

  readonly trackerId = signal<string>('');
  readonly stats = signal<SamplingStatsDto | null>(null);
  readonly histogram = signal<SamplingHistogramBucket[]>([]);
  readonly recentDecisions = signal<SamplingDecisionDto[]>([]);
  readonly loading = signal<boolean>(false);

  readonly rangeHours = signal<number>(24);
  rangeHoursValue = 24;
  verboseDurationMinutes = 0;

  readonly insertRatioPct = computed(() => (this.stats()?.insertRatio ?? 0) * 100);

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.toast.error('Tracker ID manquant dans l\'URL');
      return;
    }
    this.trackerId.set(id);
    this.reload();
  }

  onRangeChange(): void {
    this.rangeHours.set(Number(this.rangeHoursValue));
    this.reload();
  }

  async reload(): Promise<void> {
    if (!this.trackerId()) return;
    this.loading.set(true);
    try {
      const [stats, histo, recent] = await Promise.all([
        firstValueFrom(this.api.stats(this.trackerId(), this.rangeHours())),
        firstValueFrom(this.api.histogram(this.trackerId(), 7)),
        firstValueFrom(this.api.recent(this.trackerId(), 100)),
      ]);
      this.stats.set(stats);
      this.histogram.set(histo.buckets);
      this.recentDecisions.set(recent.items);
    } catch (err: unknown) {
      swallow('admin-sampling:reload', err);
      this.toast.error('Echec du chargement des stats sampling');
    } finally {
      this.loading.set(false);
    }
  }

  async applyVerbose(): Promise<void> {
    try {
      const result = await firstValueFrom(
        this.api.toggleVerbose(this.trackerId(), Number(this.verboseDurationMinutes)),
      );
      if (result.verboseUntil) {
        this.toast.success(
          `Mode verbose actif jusqu'a ${new Date(result.verboseUntil).toLocaleString('fr-FR')}`,
        );
      } else {
        this.toast.success('Mode verbose desactive');
      }
    } catch (err) {
      swallow('admin-sampling:applyVerbose', err);
      this.toast.error('Echec de la mise a jour du mode verbose');
    }
  }

  rowInsertedPct(row: { inserted: number; skipped: number }): number {
    const total = row.inserted + row.skipped;
    return total > 0 ? (row.inserted / total) * 100 : 0;
  }

  rowSkippedPct(row: { inserted: number; skipped: number }): number {
    const total = row.inserted + row.skipped;
    return total > 0 ? (row.skipped / total) * 100 : 0;
  }

  bucketPx(b: SamplingHistogramBucket, kind: 'inserted' | 'skipped'): number {
    const max = Math.max(...this.histogram().map((h) => h.inserted + h.skipped), 1);
    const value = kind === 'inserted' ? b.inserted : b.skipped;
    return Math.round((value / max) * 110);
  }

  bucketTooltip(b: SamplingHistogramBucket): string {
    const date = new Date(b.hour);
    return `${date.toLocaleDateString('fr-FR')} ${date.getHours()}h — ${b.inserted} inserees, ${b.skipped} skippees`;
  }

  badgeClass(decision: SamplingDecisionDto['decision']): string {
    if (decision === 'INSERTED') return 'bg-emerald-500/10 text-emerald-400';
    if (decision === 'INSERTED_VERBOSE') return 'bg-sky-500/10 text-sky-400';
    // Trame fantome rejetee (replay buffer / teleportation) — distincte d'un
    // simple skip de throttle pour reperage rapide en diagnostic.
    if (decision === 'SKIPPED_REPLAY') return 'bg-rose-500/10 text-rose-400';
    return 'bg-amber-500/10 text-amber-400';
  }
}
