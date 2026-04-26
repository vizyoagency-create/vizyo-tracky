import { DatePipe, JsonPipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  ArrowLeft,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  LucideAngularModule,
  RefreshCw,
  ShieldAlert,
  Zap,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  AdminFixModeService,
  FixModeStateDto,
  FixModeTimelineEntry,
} from '../../core/services/admin-fix-mode.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

@Component({
  selector: 'app-admin-fix-mode',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, JsonPipe, FormsModule, RouterLink],
  template: `
    <div class="flex flex-col gap-6">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <a routerLink="/admin/alerts"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon>
            Centre d'alertes
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary mt-1">
            Fix mode tracker
          </h1>
          @if (state(); as s) {
            <p class="text-sm text-fg-tertiary">
              {{ s.vehiclePlate ?? '—' }}
              <span class="font-mono ml-2">{{ s.imei.slice(0,4) }}...{{ s.imei.slice(-4) }}</span>
            </p>
          }
        </div>
        <button (click)="reload()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
          Rafraichir
        </button>
      </div>

      <!-- State banner -->
      @if (state(); as s) {
        <div class="bg-bg-secondary border rounded-[--radius-card] p-4 flex flex-col gap-3"
             [class.border-rose-500\\/40]="s.fixCommandFailing"
             [class.border-amber-500\\/30]="!s.fixCommandFailing && pendingDelta()"
             [class.border-emerald-500\\/30]="!s.fixCommandFailing && !pendingDelta()">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2">
              @if (s.fixCommandFailing) {
                <lucide-icon [img]="ShieldAlert" [size]="20" class="text-rose-400"></lucide-icon>
                <span class="text-rose-400 font-semibold">FAILING — {{ s.fixCommandFailureCount }} commandes sans effet</span>
              } @else if (pendingDelta()) {
                <lucide-icon [img]="Clock" [size]="20" class="text-amber-400"></lucide-icon>
                <span class="text-amber-400 font-semibold">PENDING — boitier n'a pas encore confirme</span>
              } @else {
                <lucide-icon [img]="CheckCircle" [size]="20" class="text-emerald-400"></lucide-icon>
                <span class="text-emerald-400 font-semibold">OK — fix interval honore</span>
              }
            </div>
            <span class="text-xs font-mono px-2 py-0.5 rounded"
                  [class]="s.status === 'ONLINE' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'">
              {{ s.status }}
            </span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <div class="text-xs text-fg-tertiary uppercase">Cible serveur</div>
              <div class="font-mono font-bold">{{ s.desiredFixIntervalS }}s</div>
            </div>
            <div>
              <div class="text-xs text-fg-tertiary uppercase">Reel observe</div>
              <div class="font-mono font-bold">
                {{ s.currentFixIntervalS ?? '—' }}{{ s.currentFixIntervalS != null ? 's' : '' }}
              </div>
            </div>
            <div>
              <div class="text-xs text-fg-tertiary uppercase">Derniere sync</div>
              <div class="text-xs font-mono">
                {{ s.lastFixIntervalSyncAt ? (s.lastFixIntervalSyncAt | date: 'dd/MM HH:mm') : '—' }}
              </div>
            </div>
            <div>
              <div class="text-xs text-fg-tertiary uppercase">Etat sampling</div>
              <div class="text-xs font-mono">{{ s.lastSampledState ?? '—' }}</div>
            </div>
          </div>
          @if (s.fixModeOverrideUntil) {
            <div class="text-xs text-amber-400 bg-amber-500/10 rounded px-2 py-1">
              Override admin actif jusqu'a {{ s.fixModeOverrideUntil | date: 'dd/MM HH:mm' }}.
            </div>
          }
          @if (!s.adaptiveFixModeEnabled) {
            <div class="text-xs text-fg-tertiary bg-bg-tertiary rounded px-2 py-1">
              Le pilotage adaptatif est desactive sur cette flotte (mode tracage continu).
            </div>
          }
        </div>
      }

      <!-- Override panel -->
      <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-wrap items-end gap-3">
        <div class="flex-1 min-w-[180px]">
          <div class="text-sm font-semibold text-fg-primary">Override manuel</div>
          <div class="text-xs text-fg-tertiary">
            Force un intervalle pour la duree choisie. Bloque les transitions automatiques.
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-fg-tertiary">Intervalle force</label>
          <select [(ngModel)]="overrideIntervalS"
                  class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm">
            <option [value]="null">Aucun (laisse l'algo)</option>
            <option [value]="30">30s (haute frequence)</option>
            <option [value]="60">60s</option>
            <option [value]="120">120s</option>
            <option [value]="300">300s (5 min)</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-fg-tertiary">Duree</label>
          <select [(ngModel)]="overrideMinutes"
                  class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm">
            <option [value]="0">Lever override</option>
            <option [value]="60">1 h</option>
            <option [value]="240">4 h</option>
            <option [value]="1440">24 h</option>
          </select>
        </div>
        <button (click)="applyOverride()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer">
          Appliquer
        </button>
      </div>

      <!-- Filter -->
      <div class="flex items-center gap-2">
        <label class="text-xs text-fg-tertiary">Filtrer la timeline</label>
        <select [(ngModel)]="filter" (change)="reloadTimeline()"
                class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-1.5 text-xs">
          <option value="">Toutes</option>
          <option value="failed">Echouees</option>
          <option value="pending">En attente</option>
        </select>
      </div>

      <!-- Timeline -->
      @if (timeline().length > 0) {
        <div class="flex flex-col gap-2">
          @for (e of timeline(); track e.id) {
            <div class="bg-bg-secondary border rounded-[--radius-card]"
                 [class.border-rose-500\\/30]="e.status === 'FAILED'"
                 [class.border-emerald-500\\/30]="e.status === 'ACKNOWLEDGED'"
                 [class.border-border-subtle]="e.status !== 'FAILED' && e.status !== 'ACKNOWLEDGED'">
              <button (click)="toggleExpand(e.id)"
                      class="w-full px-4 py-3 flex items-center gap-3 hover:bg-bg-tertiary/30 cursor-pointer text-left">
                <lucide-icon [img]="expanded()[e.id] ? ChevronDown : ChevronRight" [size]="14" class="text-fg-tertiary shrink-0"></lucide-icon>
                <div class="flex flex-col flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs font-mono text-fg-secondary">
                      {{ e.createdAt | date: 'dd/MM HH:mm:ss' }}
                    </span>
                    <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md font-mono"
                          [class]="statusBadgeClass(e.status)">
                      {{ e.status }}
                    </span>
                    @if (e.outcomeReason) {
                      <span class="text-xs text-fg-tertiary">{{ e.outcomeReason }}</span>
                    }
                  </div>
                  <div class="text-xs text-fg-secondary font-mono mt-1 truncate">
                    {{ e.payload }}
                  </div>
                </div>
              </button>
              @if (expanded()[e.id]) {
                <div class="border-t border-border-subtle/50 px-4 py-3 flex flex-col gap-3 text-xs">
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <div class="text-fg-tertiary uppercase text-[10px]">Attendu</div>
                      <div class="text-fg-secondary">{{ e.expectedResult ?? '—' }}</div>
                    </div>
                    <div>
                      <div class="text-fg-tertiary uppercase text-[10px]">Observe</div>
                      <div class="text-fg-secondary">{{ e.observedResult ?? '—' }}</div>
                    </div>
                  </div>
                  @if (e.diagnosticHint) {
                    <div class="bg-amber-500/10 text-amber-400 rounded px-2 py-1.5">
                      <span class="font-semibold">Diagnostic suggere :</span> {{ e.diagnosticHint }}
                    </div>
                  }
                  @if (e.lastError) {
                    <div class="bg-rose-500/10 text-rose-400 rounded px-2 py-1.5">
                      <span class="font-semibold">Erreur :</span> {{ e.lastError }}
                    </div>
                  }
                  @if (e.contextSnapshot) {
                    <details class="text-fg-tertiary">
                      <summary class="cursor-pointer hover:text-fg-secondary text-xs">Contexte au moment de la commande</summary>
                      <pre class="mt-2 text-[10px] bg-bg-tertiary p-2 rounded overflow-x-auto">{{ e.contextSnapshot | json }}</pre>
                    </details>
                  }
                  <div class="flex items-center gap-2 text-fg-tertiary">
                    <span>Cree {{ e.createdAt | date: 'dd/MM HH:mm:ss' }}</span>
                    @if (e.sentAt) { <span>· Envoye {{ e.sentAt | date: 'HH:mm:ss' }}</span> }
                    @if (e.ackedAt) { <span>· ACK {{ e.ackedAt | date: 'HH:mm:ss' }}</span> }
                  </div>
                </div>
              }
            </div>
          }
        </div>
      } @else if (!loading()) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-8 text-center">
          <lucide-icon [img]="Zap" [size]="32" class="mx-auto mb-2 opacity-40"></lucide-icon>
          <p class="text-sm text-fg-tertiary">Aucune commande fix mode dans la fenetre.</p>
        </div>
      }
    </div>
  `,
})
export class AdminFixModeComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AdminFixModeService);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly CheckCircle = CheckCircle;
  protected readonly ChevronDown = ChevronDown;
  protected readonly ChevronRight = ChevronRight;
  protected readonly Clock = Clock;
  protected readonly RefreshCw = RefreshCw;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly Zap = Zap;

  readonly trackerId = signal('');
  readonly state = signal<FixModeStateDto | null>(null);
  readonly timeline = signal<FixModeTimelineEntry[]>([]);
  readonly loading = signal(false);
  readonly expanded = signal<Record<string, boolean>>({});

  filter: '' | 'failed' | 'pending' = '';
  overrideIntervalS: number | null = null;
  overrideMinutes = 0;

  readonly pendingDelta = computed(() => {
    const s = this.state();
    if (!s) return false;
    return s.currentFixIntervalS != null && s.desiredFixIntervalS !== s.currentFixIntervalS;
  });

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.toast.error('Tracker ID manquant');
      return;
    }
    this.trackerId.set(id);
    this.reload();
  }

  toggleExpand(id: string): void {
    this.expanded.update((m) => ({ ...m, [id]: !m[id] }));
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const [state, timeline] = await Promise.all([
        firstValueFrom(this.api.state(this.trackerId())),
        firstValueFrom(this.api.timeline(this.trackerId(), 90, this.filter || undefined)),
      ]);
      this.state.set(state);
      this.timeline.set(timeline.items);
    } catch {
      this.toast.error('Echec du chargement');
    } finally {
      this.loading.set(false);
    }
  }

  async reloadTimeline(): Promise<void> {
    try {
      const t = await firstValueFrom(
        this.api.timeline(this.trackerId(), 90, this.filter || undefined),
      );
      this.timeline.set(t.items);
    } catch {
      this.toast.error('Echec du chargement de la timeline');
    }
  }

  async applyOverride(): Promise<void> {
    try {
      const result = await firstValueFrom(
        this.api.setOverride(
          this.trackerId(),
          Number(this.overrideMinutes),
          this.overrideIntervalS != null ? Number(this.overrideIntervalS) : null,
        ),
      );
      if (result.overrideUntil) {
        this.toast.success(`Override actif jusqu'a ${new Date(result.overrideUntil).toLocaleString('fr-FR')}`);
      } else {
        this.toast.success('Override leve');
      }
      this.reload();
    } catch {
      this.toast.error('Echec de l\'override');
    }
  }

  statusBadgeClass(status: string): string {
    if (status === 'ACKNOWLEDGED') return 'bg-emerald-500/10 text-emerald-400';
    if (status === 'SENT') return 'bg-sky-500/10 text-sky-400';
    if (status === 'FAILED') return 'bg-rose-500/10 text-rose-400';
    if (status === 'PENDING') return 'bg-amber-500/10 text-amber-400';
    if (status === 'CANCELLED') return 'bg-fg-tertiary/10 text-fg-tertiary';
    return 'bg-fg-tertiary/10 text-fg-tertiary';
  }
}
