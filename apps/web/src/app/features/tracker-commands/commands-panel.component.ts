import { libelleStatutCommande, tonStatutCommande } from '@vizyo/tracky-shared';
import { swallow } from '../../core/error/swallow';
import { Component, computed, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import {
  LucideAngularModule, Send, Clock, X, Terminal, AlertTriangle, Loader, Check, Minus,
  ChevronDown, RefreshCw, Eye,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import {
  TrackerCommandsApiService,
  type TrackerCommandDto,
  type CatalogTemplate,
} from '../../core/services/tracker-commands.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { relativeTime } from '../../shared/utils/relative-time';

const CATEGORY_LABELS: Record<string, string> = {
  info: 'Information',
  power: 'Alimentation',
  reporting: 'Reporting',
  alarm: 'Alarmes',
  geofence: 'Géofence',
  config_initial: 'Configuration',
  custom: 'Personnalisé',
};

/**
 * TRK-055 — les libellés et la couleur viennent de `@vizyo/tracky-shared`, PAS d'une table
 * locale. L'ancienne table mappait `ACKNOWLEDGED` sur « Confirmée » et le peignait en vert :
 * 394 commandes sur 7 jours, dont ZÉRO avec réponse de boîtier. Le mot « Confirmée » et le
 * vert affirmaient tous deux une confirmation sans dire par quoi.
 *
 * ⚠️ Ne pas réintroduire de table locale : c'est le placement de la règle, et non l'oubli,
 * qui avait laissé cet écran diverger de celui du mode fix.
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
  selector: 'app-commands-panel',
  standalone: true,
  imports: [LucideAngularModule, FormsModule, DatePipe, ConfirmModalComponent],
  template: `
    <div class="flex flex-col gap-4">
      <!-- Command Builder -->
      <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
        <div class="flex items-center gap-2 mb-3">
          <lucide-icon [img]="Terminal" [size]="16" class="text-tracky-light"></lucide-icon>
          <h3 class="text-sm font-semibold text-fg-primary">Envoyer une commande</h3>
        </div>

        <div class="flex flex-wrap gap-3 mb-3">
          <!-- Category -->
          <select [ngModel]="selectedCategory()" (ngModelChange)="selectedCategory.set($event)"
                  (ngModelChange)="onCategoryChange()"
                  class="cmd-select">
            <option value="">Catégorie...</option>
            @for (cat of categories(); track cat) {
              <option [value]="cat">{{ categoryLabel(cat) }}</option>
            }
          </select>

          <!-- Template -->
          @if (selectedCategory()) {
            <select [ngModel]="selectedTemplateId()" (ngModelChange)="selectedTemplateId.set($event)"
                    (ngModelChange)="onTemplateChange()"
                    class="cmd-select cmd-select--flex">
              <option value="">Commande...</option>
              @for (tpl of filteredTemplates(); track tpl.id) {
                <option [value]="tpl.id" [disabled]="smsOnlySansSim(tpl)">
                  {{ tpl.label }}{{ smsOnlySansSim(tpl) ? ' — SMS requis, aucune SIM enregistrée' : '' }}
                </option>
              }
            </select>
          }
        </div>

        <!-- Params -->
        @if (selectedTemplate(); as tpl) {
          <p class="text-xs text-fg-tertiary mb-3">{{ tpl.description }}</p>

          @if (tpl.params.length > 0) {
            <div class="flex flex-wrap gap-3 mb-3">
              @for (param of tpl.params; track param.name) {
                @if (param.type === 'select' && param.options) {
                  <div class="flex flex-col gap-1">
                    <label class="text-xs text-fg-tertiary">{{ param.label }}</label>
                    <select [(ngModel)]="paramValues[param.name]"
                            class="cmd-select">
                      @for (opt of param.options; track opt.value) {
                        <option [value]="opt.value">{{ opt.label }}</option>
                      }
                    </select>
                  </div>
                } @else {
                  <div class="flex flex-col gap-1">
                    <label class="text-xs text-fg-tertiary">{{ param.label }}</label>
                    <input [(ngModel)]="paramValues[param.name]"
                           [type]="param.type === 'number' ? 'number' : 'text'"
                           [min]="param.min"
                           [max]="param.max"
                           class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary w-40" />
                  </div>
                }
              }
            </div>
          }

          <!-- Raw mode for SUPER_ADMIN -->
          @if (tpl.id === 'raw') {
            <div class="mb-3 p-3 rounded-lg border border-red-600/30 bg-red-600/5">
              <p class="text-xs text-red-400 font-semibold mb-2">Mode avancé — Aucune validation</p>
              <textarea [(ngModel)]="paramValues['raw_payload']" rows="2"
                        placeholder="Ex: **,imei:XXXXX,B;  ou  reset123456"
                        class="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono text-fg-primary">
              </textarea>
            </div>
          }

          <!-- Send button -->
          <div class="flex items-center gap-3">
            <button (click)="onSend()"
                    [disabled]="sending()"
                    class="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 cursor-pointer
                           disabled:opacity-60 disabled:cursor-not-allowed"
                    [class]="tpl.dangerous
                      ? 'bg-red-600 hover:bg-red-700 text-white'
                      : 'bg-tracky hover:bg-tracky-dark text-white'">
              <lucide-icon [img]="Send" [size]="14"></lucide-icon>
              {{ sending() ? 'Envoi en cours…' : 'Envoyer maintenant' }}
            </button>
          </div>

          <!-- ══ TRK-045 — SUIVI D'ENVOI PAR ÉTAPES ═══════════════════════════════════
               Le bouton passait à « Envoi... » et plus rien ne bougeait jusqu'au toast :
               sur un boîtier injoignable, l'attente peut durer et l'écran donnait
               l'impression d'être figé. On nomme désormais CE QUI SE PASSE, dans l'ordre
               réel : liaison directe (gratuite) d'abord, SMS en rattrapage seulement.

               ⚠️ On n'invente aucune progression. L'API répond en une fois : on ne peut
               donc pas OBSERVER le passage d'une étape à l'autre. Ce panneau affiche donc
               l'étape en cours d'après ce qu'on sait avec certitude (la requête est
               partie), un chronomètre qui prouve que l'application vit, et — à l'arrivée —
               le canal RÉELLEMENT emprunté, lu dans la réponse. Une barre qui avancerait
               toute seule serait une animation, pas une information. -->
          @if (sending() || dernierEnvoi()) {
            <div class="rounded-[--radius-card] border border-border-subtle bg-bg-secondary p-3 space-y-2">
              @for (e of etapes(); track e.cle) {
                <div class="flex items-start gap-2.5 text-xs">
                  <span class="mt-0.5 shrink-0">
                    @switch (e.etat) {
                      @case ('en-cours') {
                        <lucide-icon [img]="Loader" [size]="14" class="animate-spin text-tracky"></lucide-icon>
                      }
                      @case ('fait') {
                        <lucide-icon [img]="Check" [size]="14" class="text-tracky"></lucide-icon>
                      }
                      @case ('echoue') {
                        <lucide-icon [img]="X" [size]="14" class="text-red-400"></lucide-icon>
                      }
                      @case ('ignore') {
                        <lucide-icon [img]="Minus" [size]="14" class="text-fg-tertiary opacity-50"></lucide-icon>
                      }
                    }
                  </span>
                  <span class="flex-1">
                    <span [class]="e.etat === 'ignore' ? 'text-fg-tertiary opacity-60' : 'text-fg-primary'">
                      {{ e.titre }}
                    </span>
                    <span class="block text-fg-tertiary">{{ e.detail }}</span>
                  </span>
                </div>
              }
              @if (sending()) {
                <p class="text-[11px] text-fg-tertiary pt-1 border-t border-border-subtle">
                  {{ secondesEcoulees() }} s écoulées — l'application n'est pas bloquée, elle
                  attend la réponse du serveur. Ne fermez pas la page.
                </p>
              }
            </div>
          }
        }
      </div>

      <!-- Confirm modal -->
      <app-confirm-modal
        [open]="showConfirm()"
        [title]="'Confirmer l\\'envoi ?'"
        [description]="confirmDescription()"
        [consequences]="confirmConsequences()"
        [confirmLabel]="'Envoyer la commande'"
        [danger]="selectedTemplate()?.dangerous ?? false"
        [loading]="sending()"
        (confirmed)="doSend()"
        (cancelled)="showConfirm.set(false)"
      />

      <!-- History -->
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-fg-primary">Historique des commandes</h3>
        <button (click)="loadHistory()" class="text-xs text-fg-tertiary hover:text-tracky-light cursor-pointer flex items-center gap-1">
          <lucide-icon [img]="RefreshCw" [size]="12"></lucide-icon> Rafraîchir
        </button>
      </div>

      @if (history().length > 0) {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
          <table class="w-full text-sm">
            <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
              <tr>
                <th class="p-3 text-left">Date</th>
                <th class="p-3 text-left">Commande</th>
                <th class="p-3 text-left">Statut</th>
                <th class="p-3 text-left">Utilisateur</th>
                <th class="p-3 text-left">Réponse</th>
              </tr>
            </thead>
            <tbody>
              @for (cmd of history(); track cmd.id) {
                <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50 cursor-pointer"
                    (click)="toggleDetail(cmd.id)">
                  <td class="p-3 text-fg-tertiary text-xs">{{ relativeTime(cmd.createdAt) }}</td>
                  <td class="p-3">
                    <span class="px-2 py-0.5 text-xs rounded-md bg-bg-tertiary text-fg-primary">
                      {{ cmd.templateId }}
                    </span>
                  </td>
                  <td class="p-3">
                    <span class="px-2 py-0.5 text-xs rounded-md" [class]="statusClass(cmd)">
                      {{ statusLabel(cmd) }}
                    </span>
                  </td>
                  <td class="p-3 text-xs text-fg-tertiary">{{ cmd.requestedByUser?.email ?? '—' }}</td>
                  <td class="p-3 text-xs text-fg-tertiary font-mono truncate max-w-[200px]">
                    {{ cmd.ackResponse ?? cmd.lastError ?? '—' }}
                  </td>
                </tr>
                @if (expandedId() === cmd.id) {
                  <tr>
                    <td colspan="5" class="p-3 bg-bg-tertiary/30">
                      <div class="grid grid-cols-2 gap-2 text-xs">
                        <div><span class="text-fg-tertiary">Payload:</span> <code class="text-fg-primary">{{ cmd.payload }}</code></div>
                        <div><span class="text-fg-tertiary">Canal:</span> {{ cmd.channel }}</div>
                        <div><span class="text-fg-tertiary">Envoyé:</span> {{ cmd.sentAt ? (cmd.sentAt | date:'HH:mm:ss') : '—' }}</div>
                        <div><span class="text-fg-tertiary">ACK:</span> {{ cmd.ackedAt ? (cmd.ackedAt | date:'HH:mm:ss') : '—' }}</div>
                        @if (cmd.lastError) {
                          <div class="col-span-2 text-red-400">Erreur: {{ cmd.lastError }}</div>
                        }
                        @if (cmd.status === 'SCHEDULED' || cmd.status === 'PENDING') {
                          <div>
                            <button (click)="cancelCommand(cmd.id); $event.stopPropagation()"
                                    class="text-xs px-2 py-1 rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 cursor-pointer">
                              Annuler
                            </button>
                          </div>
                        }
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>
      } @else {
        <div class="flex flex-col items-center justify-center h-24 rounded-[--radius-card]
                    bg-bg-secondary border border-border-subtle text-fg-tertiary gap-1">
          <lucide-icon [img]="Terminal" [size]="32" class="opacity-30"></lucide-icon>
          <p class="text-xs">Aucune commande envoyée</p>
        </div>
      }
    </div>
  `,
  styles: [`
    /* Select stylé cohérent avec le reste de l'app (chevron custom, no native arrow) */
    .cmd-select {
      appearance: none; -webkit-appearance: none; -moz-appearance: none;
      background-color: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 8px 32px 8px 12px;
      font-size: 13px;
      font-weight: 600;
      color: var(--fg-primary);
      cursor: pointer;
      outline: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2310E0A0' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 10px center;
      transition: all .15s;
    }
    .cmd-select:hover, .cmd-select:focus { border-color: var(--tracky); }
    .cmd-select--flex { flex: 1; min-width: 0; }
  `],
})
export class CommandsPanelComponent implements OnInit, OnDestroy {
  trackerId = input.required<string>();
  /** TRK-021 (correctif #3) — sans numéro de SIM, un gabarit SMS-only ne peut pas partir. */
  simPhoneNumber = input<string | null>(null);

  private readonly api = inject(TrackerCommandsApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly Send = Send;
  protected readonly Clock = Clock;
  protected readonly X = X;
  protected readonly Terminal = Terminal;
  // TRK-045 — icônes du suivi d'envoi par étapes.
  protected readonly Loader = Loader;
  protected readonly Check = Check;
  protected readonly Minus = Minus;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly ChevronDown = ChevronDown;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Eye = Eye;
  protected readonly relativeTime = relativeTime;

  protected readonly catalog = signal<CatalogTemplate[]>([]);
  protected readonly history = signal<TrackerCommandDto[]>([]);
  protected readonly sending = signal(false);
  protected readonly showConfirm = signal(false);

  // ══ TRK-045 — état du suivi d'envoi par étapes ════════════════════════════════════════
  /** Résultat du dernier envoi : le canal réellement emprunté, lu dans la réponse. */
  protected readonly dernierEnvoi = signal<{ canal: string | null; statut: string; erreur?: string } | null>(null);
  /** Chronomètre : la seule preuve honnête que l'application vit pendant l'attente. */
  protected readonly secondesEcoulees = signal(0);
  private chrono: ReturnType<typeof setInterval> | null = null;

  /**
   * Les étapes affichées, dérivées de l'état réel — jamais d'une animation.
   *
   * Pendant l'envoi on ne sait qu'une chose : la requête est partie. On dit donc « liaison
   * directe en cours » et on laisse les suivantes en attente. À l'arrivée, la réponse nous
   * apprend le canal EMPRUNTÉ (`channel`) : on marque alors le TCP réussi et le SMS
   * « non nécessaire », ou le TCP échoué et le SMS emprunté. C'est rétrospectif, et c'est
   * assumé : mieux vaut une étape nommée en retard qu'une barre qui ment en temps réel.
   */
  protected readonly etapes = computed<{ cle: string; titre: string; detail: string; etat: 'attente' | 'en-cours' | 'fait' | 'echoue' | 'ignore' }[]>(() => {
    const fini = this.dernierEnvoi();
    const enCours = this.sending();

    if (enCours || !fini) {
      return [
        {
          cle: 'tcp', titre: 'Liaison directe (TCP)', etat: 'en-cours',
          detail: 'La trame part sur la connexion que le boîtier tient ouverte. Ce canal est gratuit — c\'est pourquoi il est essayé en premier.',
        },
        {
          cle: 'reponse', titre: 'Réponse du boîtier', etat: 'attente',
          detail: 'Le firmware Coban n\'accuse pas toujours réception : l\'effet se vérifie sur les trames suivantes, pas sur une réponse immédiate.',
        },
        {
          cle: 'sms', titre: 'Repli SMS', etat: 'attente',
          detail: 'Uniquement si la liaison directe est fermée. Un SMS est facturé, donc il ne part qu\'en rattrapage.',
        },
      ];
    }

    const parSms = fini.canal === 'SMS';
    const echec = fini.statut === 'FAILED' || !!fini.erreur;
    return [
      {
        cle: 'tcp', titre: 'Liaison directe (TCP)',
        etat: parSms ? 'echoue' : echec ? 'echoue' : 'fait',
        detail: parSms
          ? 'Socket fermée : le boîtier n\'était pas joignable en direct.'
          : echec
            ? (fini.erreur ?? 'La trame n\'a pas pu être écrite sur la socket.')
            : 'Trame écrite sur la socket du boîtier.',
      },
      {
        cle: 'reponse', titre: 'Réponse du boîtier',
        etat: echec ? 'ignore' : 'fait',
        detail: echec
          ? 'Non applicable : la commande n\'est pas partie.'
          : `Commande enregistrée avec le statut « ${fini.statut} ». L'effet réel se lit sur les trames suivantes.`,
      },
      {
        cle: 'sms', titre: 'Repli SMS',
        etat: parSms ? 'fait' : 'ignore',
        detail: parSms
          ? 'La commande est partie par SMS, en forme texte (la trame TCP n\'est pas lisible dans un texto).'
          : 'Non nécessaire — la liaison directe a suffi, donc aucun SMS facturé.',
      },
    ];
  });
  protected readonly expandedId = signal<string | null>(null);

  protected readonly selectedCategory = signal('');
  protected readonly selectedTemplateId = signal('');
  protected paramValues: Record<string, unknown> = {};

  protected readonly categories = computed(() => {
    const cats = new Set(this.catalog().map((t) => t.category));
    return [...cats];
  });

  protected readonly filteredTemplates = computed(() =>
    this.catalog().filter((t) => t.category === this.selectedCategory()),
  );

  protected readonly selectedTemplate = computed(() =>
    this.catalog().find((t) => t.id === this.selectedTemplateId()),
  );

  protected readonly confirmDescription = computed(() => {
    const tpl = this.selectedTemplate();
    if (!tpl) return '';
    return `Vous allez envoyer <strong>${tpl.label}</strong> au boîtier.`;
  });

  /**
   * Ce qu'une commande dangereuse fait réellement — « potentiellement dangereuse » ne
   * dit rien de ce qu'on risque. Une commande SMS part vers le matériel : elle ne
   * s'annule pas, et le boîtier peut mettre plusieurs minutes à répondre.
   */
  protected readonly confirmConsequences = computed(() => {
    const tpl = this.selectedTemplate();
    if (!tpl) return '';
    return tpl.dangerous
      ? 'La commande part vers le boîtier et ne peut pas être rappelée. Elle modifie sa configuration : '
        + 'une valeur erronée peut le rendre muet jusqu\'à une intervention sur le véhicule.'
      : 'La commande part vers le boîtier et ne peut pas être rappelée. La réponse peut prendre plusieurs minutes.';
  });

  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadCatalog(), this.loadHistory()]);
  }

  protected categoryLabel(cat: string): string {
    return CATEGORY_LABELS[cat] ?? cat;
  }

  /**
   * TRK-055 — prend la COMMANDE, jamais le seul statut. C'est parce que ces deux méthodes ne
   * recevaient que `status` qu'elles ne pouvaient pas distinguer une vraie réponse de boîtier
   * d'une cible atteinte par la mesure — et qu'elles peignaient les deux en vert.
   */
  protected statusLabel(cmd: { status: string; ackResponse?: string | null }): string {
    return libelleStatutCommande(cmd);
  }

  protected statusClass(cmd: { status: string; ackResponse?: string | null }): string {
    return CLASSE_PAR_TON[tonStatutCommande(cmd)] ?? CLASSE_PAR_TON['neutre'];
  }

  /** TRK-021 (correctif #3) — gabarit déclaré SMS-only ET boîtier sans numéro de SIM. */
  protected smsOnlySansSim(tpl: CatalogTemplate): boolean {
    return !tpl.availableVia.includes('tcp') && !this.simPhoneNumber();
  }

  protected onCategoryChange(): void {
    this.selectedTemplateId.set('');
    this.paramValues = {};
  }

  protected onTemplateChange(): void {
    this.paramValues = {};
  }

  protected onSend(): void {
    const tpl = this.selectedTemplate();
    if (!tpl) return;
    if (tpl.requiresConfirmation || tpl.dangerous) {
      this.showConfirm.set(true);
    } else {
      this.doSend();
    }
  }

  protected async doSend(): Promise<void> {
    const tpl = this.selectedTemplate();
    if (!tpl) return;

    this.sending.set(true);
    this.showConfirm.set(false);
    // TRK-045 — on repart d'un suivi vierge et on démarre le chronomètre : c'est lui qui
    // dit à l'opérateur que l'attente est normale et que l'écran n'est pas figé.
    this.dernierEnvoi.set(null);
    this.demarrerChrono();

    try {
      const result = await firstValueFrom(this.api.create({
        trackerId: this.trackerId(),
        templateId: tpl.id,
        params: this.paramValues,
      }));
      // Le canal est lu dans la RÉPONSE, jamais deviné : c'est la seule source qui sache
      // si le SMS de rattrapage a servi.
      const canal = (result as { channel?: string | null }).channel ?? null;
      this.dernierEnvoi.set({ canal, statut: result.status });
      this.toast.success(
        canal === 'SMS' ? 'Commande envoyée par SMS' : 'Commande envoyée',
        `${tpl.label} — ${result.status}${canal === 'SMS' ? ' (liaison directe indisponible)' : ''}`,
      );
      this.selectedTemplateId.set('');
      this.paramValues = {};
      await this.loadHistory();
    } catch (err: unknown) {
      swallow('commands-panel:doSend', err);
      const msg = (err as any)?.error?.message ?? (err as any)?.error?.error?.message ?? 'Erreur inconnue';
      this.dernierEnvoi.set({ canal: null, statut: 'FAILED', erreur: msg });
      this.toast.error('Erreur', msg);
    } finally {
      this.sending.set(false);
      this.arreterChrono();
    }
  }

  private demarrerChrono(): void {
    this.arreterChrono();
    this.secondesEcoulees.set(0);
    this.chrono = setInterval(() => this.secondesEcoulees.update((n) => n + 1), 1000);
  }

  /** ⚠️ Appelé aussi à la destruction : un intervalle qui survit au composant fuit. */
  private arreterChrono(): void {
    if (this.chrono !== null) {
      clearInterval(this.chrono);
      this.chrono = null;
    }
  }

  ngOnDestroy(): void {
    this.arreterChrono();
  }

  protected async cancelCommand(id: string): Promise<void> {
    try {
      await firstValueFrom(this.api.cancel(id));
      this.toast.success('Commande annulée');
      await this.loadHistory();
    } catch (err) {
      swallow('commands-panel:cancelCommand', err);
      this.toast.error('Erreur d\'annulation');
    }
  }

  protected toggleDetail(id: string): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  private async loadCatalog(): Promise<void> {
    try {
      const catalog = await firstValueFrom(this.api.getCatalog());
      this.catalog.set(catalog);
    } catch (err) {
      // silent
      swallow('commands-panel:loadCatalog', err);
    }
  }

  protected async loadHistory(): Promise<void> {
    try {
      const list = await firstValueFrom(this.api.list({ trackerId: this.trackerId(), limit: '50' }));
      this.history.set(list);
    } catch (err) {
      // silent
      swallow('commands-panel:loadHistory', err);
    }
  }
}
