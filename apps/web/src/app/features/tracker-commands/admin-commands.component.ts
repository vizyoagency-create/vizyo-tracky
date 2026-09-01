import { swallow } from '../../core/error/swallow';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, ArrowLeft, Terminal, RefreshCw } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  TrackerCommandsApiService,
  type TrackerCommandDto,
} from '../../core/services/tracker-commands.service';
import { relativeTime } from '../../shared/utils/relative-time';
import { libelleStatutCommande, tonStatutCommande } from '@vizyo/tracky-shared';

/**
 * TRK-055 — libellés et couleur dérivés de `@vizyo/tracky-shared`, jamais d'une table locale.
 * L'ancienne table peignait `ACKNOWLEDGED` en vert sous le mot « Confirmée » : 394 commandes
 * sur 7 jours, dont ZÉRO avec réponse de boîtier.
 */
const CLASSE_PAR_TON: Record<string, string> = {
  succes: 'bg-tracky/10 text-tracky-light',
  mesure: 'bg-amber-500/10 text-amber-400',
  echec: 'bg-red-600/10 text-red-400',
  attente: 'bg-bg-tertiary text-fg-tertiary',
  planifie: 'bg-sky-500/10 text-sky-400',
  neutre: 'bg-fg-tertiary/10 text-fg-tertiary',
};

@Component({
  selector: 'app-admin-commands',
  standalone: true,
  imports: [LucideAngularModule, FormsModule, RouterLink],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <div>
          <a routerLink="/admin"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon>
            Administration
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary">Commandes tracker</h1>
        </div>
        <button (click)="load()" class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium
                hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
          Rafraîchir
        </button>
      </div>

      <!-- Filters -->
      <div class="flex gap-3 items-end">
        <div class="flex flex-col gap-1">
          <label class="text-xs text-fg-tertiary">Statut</label>
          <select [ngModel]="statusFilter()" (ngModelChange)="statusFilter.set($event)"
                  class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
            <option value="">Tous</option>
            <option value="PENDING">En attente</option>
            <option value="SENT">Envoyée</option>
            <option value="ACKNOWLEDGED">Cible atteinte / acquittée</option>
            <option value="FAILED">Échouée</option>
            <option value="SCHEDULED">Planifiée</option>
            <option value="CANCELLED">Annulée</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-fg-tertiary">Catégorie</label>
          <select [ngModel]="categoryFilter()" (ngModelChange)="categoryFilter.set($event)"
                  class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
            <option value="">Toutes</option>
            <option value="info">Information</option>
            <option value="power">Alimentation</option>
            <option value="reporting">Reporting</option>
            <option value="alarm">Alarmes</option>
            <option value="geofence">Géofence</option>
            <option value="config_initial">Configuration</option>
            <option value="custom">Personnalisé</option>
          </select>
        </div>
        <button (click)="load()" class="px-3 py-2 bg-bg-secondary border border-border-subtle rounded-lg text-sm text-fg-primary hover:bg-bg-tertiary cursor-pointer">
          Filtrer
        </button>
      </div>

      @if (commands().length > 0) {
        <!-- ⚠️ LE MASQUAGE DU DÉBORDEMENT COUPAIT LE TABLEAU AU LIEU DE LE LAISSER
             DÉFILER. Il réclame 841 px et le téléphone en offre 375 : les colonnes de
             droite — dont l'accusé de réception, la raison d'être de ce lot — étaient
             simplement invisibles, sans le moindre indice qu'il en manquait.
             Le défilement horizontal garde le coin arrondi ET rend les colonnes
             atteignables. -->
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">Date</th>
                <th class="p-3 text-left">Template</th>
                <th class="p-3 text-left">Catégorie</th>
                <th class="p-3 text-left">Statut</th>
                <th class="p-3 text-left">Payload</th>
                <th class="p-3 text-left">Réponse</th>
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
                    <span class="px-2 py-0.5 text-xs rounded-md" [class]="statusClass(cmd)">
                      {{ statusLabel(cmd) }}
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

  protected readonly ArrowLeft = ArrowLeft;
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
    } catch (err) {
      // silent
      swallow('admin-commands:load', err);
    }
  }

  /** TRK-055 — prend la COMMANDE, jamais le seul statut. */
  protected statusLabel(cmd: { status: string; ackResponse?: string | null }): string {
    return libelleStatutCommande(cmd);
  }

  protected statusClass(cmd: { status: string; ackResponse?: string | null }): string {
    return CLASSE_PAR_TON[tonStatutCommande(cmd)] ?? CLASSE_PAR_TON['neutre'];
  }
}
