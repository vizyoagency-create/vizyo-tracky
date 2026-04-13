import { Component, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Terminal, RefreshCw } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  TrackerCommandsApiService,
  type TrackerCommandDto,
} from '../../core/services/tracker-commands.service';
import { relativeTime } from '../../shared/utils/relative-time';

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'En attente',
  SCHEDULED: 'Planifiee',
  SENT: 'Envoyee',
  ACKNOWLEDGED: 'Confirmee',
  FAILED: 'Echouee',
  CANCELLED: 'Annulee',
};

@Component({
  selector: 'app-admin-commands',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, FormsModule],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Commandes tracker</h1>
        <button (click)="load()" class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium
                hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
          Rafraichir
        </button>
      </div>

      <!-- Filters -->
      <div class="flex gap-3 items-end">
        <div class="flex flex-col gap-1">
          <label class="text-xs text-fg-tertiary">Statut</label>
          <select [(ngModel)]="statusFilter"
                  class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
            <option value="">Tous</option>
            <option value="PENDING">En attente</option>
            <option value="SENT">Envoyee</option>
            <option value="ACKNOWLEDGED">Confirmee</option>
            <option value="FAILED">Echouee</option>
            <option value="SCHEDULED">Planifiee</option>
            <option value="CANCELLED">Annulee</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-fg-tertiary">Categorie</label>
          <select [(ngModel)]="categoryFilter"
                  class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
            <option value="">Toutes</option>
            <option value="info">Information</option>
            <option value="power">Alimentation</option>
            <option value="reporting">Reporting</option>
            <option value="alarm">Alarmes</option>
            <option value="geofence">Geofence</option>
            <option value="config_initial">Configuration</option>
            <option value="custom">Personnalise</option>
          </select>
        </div>
        <button (click)="load()" class="px-3 py-2 bg-bg-secondary border border-border-subtle rounded-lg text-sm text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          Filtrer
        </button>
      </div>

      @if (commands().length > 0) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
          <table class="w-full text-sm">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">Date</th>
                <th class="p-3 text-left">Template</th>
                <th class="p-3 text-left">Categorie</th>
                <th class="p-3 text-left">Statut</th>
                <th class="p-3 text-left">Payload</th>
                <th class="p-3 text-left">Reponse</th>
                <th class="p-3 text-left">Utilisateur</th>
              </tr>
            </thead>
            <tbody>
              @for (cmd of commands(); track cmd.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                  <td class="p-3 text-fg-tertiary text-xs">{{ relativeTime(cmd.createdAt) }}</td>
                  <td class="p-3 text-fg-primary text-xs font-medium">{{ cmd.templateId }}</td>
                  <td class="p-3 text-xs text-fg-tertiary">{{ cmd.category }}</td>
                  <td class="p-3">
                    <span class="px-2 py-0.5 text-xs rounded-md" [class]="statusClass(cmd.status)">
                      {{ statusLabel(cmd.status) }}
                    </span>
                  </td>
                  <td class="p-3 font-mono text-xs text-fg-tertiary truncate max-w-[200px]">{{ cmd.payload }}</td>
                  <td class="p-3 font-mono text-xs text-fg-tertiary truncate max-w-[200px]">
                    {{ cmd.ackResponse ?? cmd.lastError ?? '—' }}
                  </td>
                  <td class="p-3 text-xs text-fg-tertiary">{{ cmd.requestedByUser?.email ?? '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
          <lucide-icon [img]="Terminal" [size]="48" class="opacity-30"></lucide-icon>
          <p>Aucune commande</p>
        </div>
      }
    </div>
  `,
})
export class AdminCommandsComponent implements OnInit {
  private readonly api = inject(TrackerCommandsApiService);

  protected readonly Terminal = Terminal;
  protected readonly RefreshCw = RefreshCw;
  protected readonly relativeTime = relativeTime;

  protected readonly commands = signal<TrackerCommandDto[]>([]);
  protected readonly statusFilter = signal('');
  protected readonly categoryFilter = signal('');

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  protected async load(): Promise<void> {
    const params: Record<string, string> = { limit: '100' };
    if (this.statusFilter()) params['status'] = this.statusFilter();
    if (this.categoryFilter()) params['category'] = this.categoryFilter();
    try {
      const list = await firstValueFrom(this.api.list(params));
      this.commands.set(list);
    } catch { /* silent */ }
  }

  protected statusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status;
  }

  protected statusClass(status: string): string {
    if (status === 'SENT' || status === 'ACKNOWLEDGED') return 'bg-tracky/10 text-tracky-light';
    if (status === 'FAILED') return 'bg-red-600/10 text-red-400';
    if (status === 'CANCELLED') return 'bg-fg-tertiary/10 text-fg-tertiary';
    if (status === 'SCHEDULED') return 'bg-sky-500/10 text-sky-400';
    return 'bg-bg-tertiary text-fg-tertiary';
  }
}
