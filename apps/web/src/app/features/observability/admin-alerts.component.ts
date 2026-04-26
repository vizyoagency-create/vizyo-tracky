import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  LucideAngularModule,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  AdminAlertsDto,
  AdminFixModeService,
} from '../../core/services/admin-fix-mode.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

@Component({
  selector: 'app-admin-alerts',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, RouterLink],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 class="text-2xl font-display font-bold text-fg-primary">Centre d'alertes</h1>
          <p class="text-sm text-fg-tertiary">
            Trackers en echec, hors ligne prolonge, ou commandes en attente.
          </p>
        </div>
        <button (click)="reload()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
          Rafraichir
        </button>
      </div>

      <!-- Summary -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="bg-bg-secondary border border-rose-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="AlertTriangle" [size]="32" class="text-rose-400"></lucide-icon>
          <div>
            <div class="text-xs uppercase text-fg-tertiary">Trackers FAILING</div>
            <div class="text-2xl font-display font-bold text-rose-400">
              {{ data()?.summary?.failing ?? 0 }}
            </div>
          </div>
        </div>
        <div class="bg-bg-secondary border border-amber-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="WifiOff" [size]="32" class="text-amber-400"></lucide-icon>
          <div>
            <div class="text-xs uppercase text-fg-tertiary">Offline > 1h</div>
            <div class="text-2xl font-display font-bold text-amber-400">
              {{ data()?.summary?.offline ?? 0 }}
            </div>
          </div>
        </div>
        <div class="bg-bg-secondary border border-sky-500/20 rounded-[--radius-card] p-4 flex items-center gap-3">
          <lucide-icon [img]="Clock" [size]="32" class="text-sky-400"></lucide-icon>
          <div>
            <div class="text-xs uppercase text-fg-tertiary">Commandes en attente</div>
            <div class="text-2xl font-display font-bold text-sky-400">
              {{ data()?.summary?.pending ?? 0 }}
            </div>
          </div>
        </div>
      </div>

      <!-- FAILING -->
      @if (data() && data()!.failing.length > 0) {
        <section class="flex flex-col gap-3">
          <h2 class="text-lg font-display font-semibold text-fg-primary flex items-center gap-2">
            <lucide-icon [img]="AlertTriangle" [size]="18" class="text-rose-400"></lucide-icon>
            Trackers en echec ({{ data()!.failing.length }})
          </h2>
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
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
                      @if (a.lastSeenAt) {
                        {{ a.lastSeenAt | date: 'dd/MM HH:mm' }}
                      } @else {
                        jamais
                      }
                    </td>
                    <td class="p-3 flex gap-2">
                      <a [routerLink]="['/admin/trackers', a.trackerId, 'fix-mode']"
                         class="text-xs text-tracky-light hover:underline">Inspecter</a>
                      <button (click)="clearFailing(a.trackerId)"
                              class="text-xs text-fg-tertiary hover:text-emerald-400">
                        Acquitter
                      </button>
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
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
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
                      @if (a.lastSeenAt) {
                        {{ a.lastSeenAt | date: 'dd/MM HH:mm' }}
                      } @else {
                        jamais
                      }
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
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
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
                              class="text-xs text-tracky-light hover:underline">
                        Acquitter
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      @if (data() && data()!.failing.length === 0 && data()!.offline.length === 0 && data()!.pendingCommands.length === 0) {
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

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly CheckCircle = CheckCircle;
  protected readonly Clock = Clock;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Wifi = Wifi;
  protected readonly WifiOff = WifiOff;

  readonly data = signal<AdminAlertsDto | null>(null);
  readonly loading = signal(false);

  ngOnInit(): void {
    this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await firstValueFrom(this.api.alerts()));
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

  formatDuration(ms: number | null): string {
    if (!ms) return '—';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 24) return `${Math.floor(h / 24)} j`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m} min`;
  }
}
