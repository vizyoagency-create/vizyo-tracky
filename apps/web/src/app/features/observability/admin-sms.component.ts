import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlertTriangle,
  CheckCircle,
  Database,
  HardDrive,
  ListChecks,
  LucideAngularModule,
  Phone,
  Plus,
  Power,
  RefreshCw,
  Send,
  Trash2,
  XCircle,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  AdminSmsService,
  AllowlistEntryDto,
  AllowlistStatus,
  BackupHealthResponse,
  ProvisioningDto,
  SmsLogDto,
  SmsStatus,
} from '../../core/services/admin-sms.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

type Tab = 'status' | 'provision' | 'logs' | 'allowlist' | 'backup';

@Component({
  selector: 'app-admin-sms',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, FormsModule],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 class="text-2xl font-display font-bold text-fg-primary">SMS &amp; Backup admin</h1>
          <p class="text-sm text-fg-tertiary">
            Outils SUPER_ADMIN : provisionnement de trackers neufs via SMS, audit
            des envois Twilio, et monitoring des backups Postgres.
          </p>
        </div>
        <button (click)="reload()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
          Rafraichir
        </button>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 border-b border-border-subtle overflow-x-auto scrollbar-none">
        @for (t of tabs; track t.key) {
          <button (click)="activeTab.set(t.key)"
                  class="px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer border-b-2 -mb-px shrink-0"
                  [class]="activeTab() === t.key ? 'text-tracky-light border-tracky-light' : 'text-fg-tertiary border-transparent hover:text-fg-secondary'">
            {{ t.label }}
          </button>
        }
      </div>

      <!-- Tab : Status -->
      @if (activeTab() === 'status') {
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <!-- V1.13 — Card SMS Gateway avec vrai verdict :
               vert = twilio (auth OK) / rouge = twilio-broken (auth KO) /
               orange = noop (dev). Auparavant le card disait "Twilio actif"
               meme quand l'auth echouait silencieusement (errorCode 20003). -->
          <div class="bg-bg-secondary border rounded-[--radius-card] p-4 flex items-start gap-3"
               [class]="cardBorderClass()">
            <lucide-icon [img]="Power" [size]="32" [class]="cardIconClass()"></lucide-icon>
            <div class="flex-1 min-w-0">
              <div class="text-xs uppercase text-fg-tertiary">SMS Gateway</div>
              <div class="text-lg font-display font-bold" [class]="cardTitleClass()">
                {{ cardTitleText() }}
              </div>
              <div class="text-xs text-fg-tertiary mt-1">
                {{ cardSubText() }}
              </div>
              @if (status()?.errorCode || status()?.error) {
                <div class="mt-2 text-xs font-mono bg-rose-500/10 text-rose-300 border border-rose-500/30 rounded px-2 py-1 truncate"
                     [title]="(status()?.errorCode ?? '') + ' ' + (status()?.error ?? '')">
                  {{ status()?.errorCode }} — {{ status()?.error }}
                </div>
              }
              @if ((status()?.recentFailures24h ?? 0) > 0) {
                <div class="mt-2 text-xs text-amber-300">
                  ⚠ {{ status()?.recentFailures24h }} SMS en echec sur les 24h
                  @if (status()?.lastFailure; as lf) {
                    · dernier : {{ lf.errorCode ?? '—' }} vers {{ lf.toNumber }}
                  }
                </div>
              }
              @if (status()?.fromNumber) {
                <div class="mt-1 text-xs font-mono text-fg-tertiary">From : {{ status()?.fromNumber }}</div>
              }
            </div>
          </div>

          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex items-center gap-3">
            <lucide-icon [img]="HardDrive" [size]="32" [class]="backupHealth()?.stale ? 'text-rose-400' : 'text-emerald-400'"></lucide-icon>
            <div>
              <div class="text-xs uppercase text-fg-tertiary">Dernier backup</div>
              @if (backupHealth()?.lastSuccess; as ls) {
                <div class="text-lg font-display font-bold"
                     [class]="backupHealth()?.stale ? 'text-rose-400' : 'text-emerald-400'">
                  Il y a {{ ls.ageHours }}h
                </div>
                <div class="text-xs text-fg-tertiary mt-1">
                  {{ ls.createdAt | date: 'dd/MM HH:mm' }}
                </div>
              } @else {
                <div class="text-lg font-display font-bold text-rose-400">Aucun</div>
                <div class="text-xs text-fg-tertiary mt-1">Le script bash n'a jamais ping.</div>
              }
            </div>
          </div>
        </div>

        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-3">
          <div class="flex items-center gap-2 text-sm font-semibold">
            <lucide-icon [img]="Send" [size]="16" class="text-tracky-light"></lucide-icon>
            Envoi SMS arbitraire (debug)
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input [(ngModel)]="adhocTo" placeholder="+33612345678"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono" />
            <input [(ngModel)]="adhocBody" placeholder="Message..."
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm sm:col-span-2" />
          </div>
          <button (click)="sendAdhoc()" [disabled]="!adhocTo || !adhocBody"
                  class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer disabled:opacity-50 self-start flex items-center gap-2">
            <lucide-icon [img]="Send" [size]="14"></lucide-icon>
            Envoyer
          </button>
        </div>

      }

      <!-- Tab : Provisioning -->
      @if (activeTab() === 'provision') {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-3">
          <div class="flex items-center gap-2 text-sm font-semibold">
            <lucide-icon [img]="Phone" [size]="16" class="text-tracky-light"></lucide-icon>
            Provisionner un nouveau tracker
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input [(ngModel)]="provIMEI" placeholder="IMEI (14-16 chiffres)"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono" />
            <input [(ngModel)]="provPhone" placeholder="Numéro SIM (+33...)"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono" />
            <input [(ngModel)]="provApn" placeholder="APN"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm" />
            <input [(ngModel)]="provServerIp" placeholder="Server IP"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono" />
            <input [(ngModel)]="provServerPort" type="number" placeholder="Server port (5001)"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono" />
            <input [(ngModel)]="provLowBatPhone" placeholder="Tel batterie faible (optionnel)"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
          <div class="text-xs text-fg-tertiary">
            La sequence enverra 9 SMS espaces de 30s. Duree totale ~5 min.
          </div>
          <button (click)="startProvisioning()"
                  [disabled]="!provIMEI || !provPhone || !provApn || !provServerIp || !provServerPort"
                  class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer disabled:opacity-50 self-start">
            Demarrer la sequence
          </button>
        </div>

        @if (provisionings().length > 0) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
            <table class="w-full text-sm min-w-[700px]">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Date</th>
                  <th class="p-3 text-left">IMEI</th>
                  <th class="p-3 text-left">Tel</th>
                  <th class="p-3 text-center">Etape</th>
                  <th class="p-3 text-left">Statut</th>
                  <th class="p-3"></th>
                </tr>
              </thead>
              <tbody>
                @for (p of provisionings(); track p.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                    <td class="p-3 text-xs text-fg-tertiary">{{ p.createdAt | date: 'dd/MM HH:mm' }}</td>
                    <td class="p-3 font-mono text-xs">{{ p.imei }}</td>
                    <td class="p-3 font-mono text-xs">{{ p.phoneNumber }}</td>
                    <td class="p-3 text-center font-mono">{{ p.currentStep }} / 9</td>
                    <td class="p-3">
                      <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md font-mono"
                            [class]="provBadgeClass(p.status)">
                        {{ p.status }}
                      </span>
                    </td>
                    <td class="p-3">
                      @if (p.status === 'IN_PROGRESS') {
                        <button (click)="cancelProv(p.id)"
                                class="text-xs text-rose-400 hover:underline">Annuler</button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }

      <!-- Tab : Logs -->
      @if (activeTab() === 'logs') {
        <div class="flex items-end gap-2">
          <div class="flex flex-col gap-1 flex-1 max-w-xs">
            <label class="text-xs text-fg-tertiary">Filtre IMEI</label>
            <input [(ngModel)]="logsImei" (change)="reload()" placeholder="865328021056352"
                   class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
        </div>

        @if (logs().length > 0) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
            <table class="w-full text-sm min-w-[700px]">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Date</th>
                  <th class="p-3 text-center">Dir</th>
                  <th class="p-3 text-left">From / To</th>
                  <th class="p-3 text-left">Body</th>
                  <th class="p-3 text-left">Statut</th>
                </tr>
              </thead>
              <tbody>
                @for (l of logs(); track l.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                    <td class="p-3 text-xs text-fg-tertiary font-mono">
                      {{ l.createdAt | date: 'dd/MM HH:mm:ss' }}
                    </td>
                    <td class="p-3 text-center">
                      <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md font-mono"
                            [class]="l.direction === 'OUT' ? 'bg-sky-500/10 text-sky-400' : 'bg-emerald-500/10 text-emerald-400'">
                        {{ l.direction }}
                      </span>
                    </td>
                    <td class="p-3 font-mono text-xs">
                      {{ l.direction === 'OUT' ? l.toNumber : l.fromNumber }}
                    </td>
                    <td class="p-3 font-mono text-xs truncate max-w-[300px]">{{ l.body }}</td>
                    <td class="p-3 text-xs">{{ l.status ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-8 text-center text-fg-tertiary text-sm">
            Aucun SMS dans la fenetre de filtre.
          </div>
        }
      }

      <!-- Tab : Allowlist -->
      @if (activeTab() === 'allowlist') {
        <!-- Actions : sync trackers + ajout manuel -->
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2 text-sm font-semibold">
              <lucide-icon [img]="ListChecks" [size]="16" class="text-tracky-light"></lucide-icon>
              Numeros autorises ({{ allowlistEntries().length }})
            </div>
            <button (click)="syncTrackers()" [disabled]="syncing()"
                    class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer disabled:opacity-50 flex items-center gap-2">
              <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
              {{ syncing() ? 'Sync...' : 'Sync trackers' }}
            </button>
          </div>
          <p class="text-xs text-fg-tertiary">
            Seuls les numeros de cette liste peuvent recevoir un SMS. "Sync trackers" pousse les SIM
            des trackers (source <code>synced</code>) ; les numeros ajoutes a la main (<code>manual</code>)
            sont preserves au resync.
          </p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input [(ngModel)]="newPhone" placeholder="+33612345678"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono" />
            <input [(ngModel)]="newLabel" placeholder="Label (optionnel)"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm" />
            <button (click)="addNumber()" [disabled]="!newPhone"
                    class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2">
              <lucide-icon [img]="Plus" [size]="14"></lucide-icon>
              Ajouter
            </button>
          </div>
        </div>

        <!-- Diff / reconciliation -->
        @if (allowlistStatus(); as st) {
          @if (st.missing.length > 0 || st.orphans.length > 0) {
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              @if (st.missing.length > 0) {
                <div class="bg-amber-500/10 border border-amber-500/30 rounded-[--radius-card] p-4">
                  <div class="text-sm font-semibold text-amber-300 mb-2">
                    {{ st.missing.length }} tracker(s) a synchroniser
                  </div>
                  <ul class="text-xs font-mono text-fg-tertiary flex flex-col gap-1">
                    @for (m of st.missing; track m.phone) {
                      <li>{{ m.phone }} — {{ m.imei }}</li>
                    }
                  </ul>
                </div>
              }
              @if (st.orphans.length > 0) {
                <div class="bg-rose-500/10 border border-rose-500/30 rounded-[--radius-card] p-4">
                  <div class="text-sm font-semibold text-rose-300 mb-2">
                    {{ st.orphans.length }} numero(s) orphelin(s) / mort(s)
                  </div>
                  <ul class="text-xs font-mono text-fg-tertiary flex flex-col gap-1">
                    @for (o of st.orphans; track o.phone) {
                      <li>{{ o.phone }} — {{ o.label ?? '—' }}</li>
                    }
                  </ul>
                </div>
              }
            </div>
          } @else {
            <div class="bg-emerald-500/10 border border-emerald-500/30 rounded-[--radius-card] p-3 text-sm text-emerald-300">
              ✓ Tous les SIM trackers sont synchronises ({{ st.trackersWithSim }} tracker(s) avec SIM).
            </div>
          }
        }

        <!-- Table des numeros -->
        @if (allowlistEntries().length > 0) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
            <table class="w-full text-sm min-w-[600px]">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Telephone</th>
                  <th class="p-3 text-left">Label</th>
                  <th class="p-3 text-center">Source</th>
                  <th class="p-3 text-right"></th>
                </tr>
              </thead>
              <tbody>
                @for (e of allowlistEntries(); track e.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                    <td class="p-3 font-mono text-xs">{{ e.phone }}</td>
                    <td class="p-3 text-xs">{{ e.label ?? '—' }}</td>
                    <td class="p-3 text-center">
                      <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md font-mono"
                            [class]="e.source === 'synced' ? 'bg-sky-500/10 text-sky-400' : 'bg-fg-tertiary/10 text-fg-tertiary'">
                        {{ e.source }}
                      </span>
                    </td>
                    <td class="p-3 text-right">
                      @if (e.source === 'manual') {
                        <button (click)="removeNumber(e.phone)" title="Supprimer"
                                class="text-rose-400 hover:text-rose-300 cursor-pointer">
                          <lucide-icon [img]="Trash2" [size]="14"></lucide-icon>
                        </button>
                      } @else {
                        <span class="text-[10px] text-fg-tertiary">via tracker</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-8 text-center text-fg-tertiary text-sm">
            Aucun numero dans l'allowlist. Ajoute-en un, ou clique "Sync trackers".
          </div>
        }

      }

      <!-- Tab : Backup -->
      @if (activeTab() === 'backup') {
        @if (backupHealth(); as bh) {
          @if (bh.stale) {
            <div class="bg-rose-500/10 border border-rose-500/30 rounded-[--radius-card] p-4 flex items-center gap-3">
              <lucide-icon [img]="AlertTriangle" [size]="20" class="text-rose-400"></lucide-icon>
              <div>
                <div class="font-semibold text-rose-400">Backup en retard</div>
                <div class="text-xs text-fg-tertiary">Aucun backup reussi dans les 30 dernieres heures.</div>
              </div>
            </div>
          }

          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
            <table class="w-full text-sm min-w-[700px]">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Date</th>
                  <th class="p-3 text-left">Statut</th>
                  <th class="p-3 text-left">Fichier</th>
                  <th class="p-3 text-right">Taille</th>
                  <th class="p-3 text-right">Duree</th>
                  <th class="p-3 text-left">Destination</th>
                </tr>
              </thead>
              <tbody>
                @for (b of bh.items; track b.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                    <td class="p-3 text-xs font-mono text-fg-tertiary">{{ b.createdAt | date: 'dd/MM HH:mm' }}</td>
                    <td class="p-3">
                      @if (b.status === 'OK') {
                        <span class="inline-flex items-center gap-1 text-emerald-400 text-xs">
                          <lucide-icon [img]="CheckCircle" [size]="12"></lucide-icon> OK
                        </span>
                      } @else {
                        <span class="inline-flex items-center gap-1 text-rose-400 text-xs">
                          <lucide-icon [img]="XCircle" [size]="12"></lucide-icon> FAILED
                        </span>
                      }
                    </td>
                    <td class="p-3 font-mono text-xs truncate max-w-[260px]">{{ b.filename ?? '—' }}</td>
                    <td class="p-3 text-right text-xs font-mono">{{ formatBytes(b.sizeBytes) }}</td>
                    <td class="p-3 text-right text-xs font-mono">{{ b.durationMs ? (b.durationMs + 'ms') : '—' }}</td>
                    <td class="p-3 text-xs">{{ b.destination ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    </div>
  `,
})
export class AdminSmsComponent implements OnInit {
  private readonly api = inject(AdminSmsService);
  private readonly toast = inject(ToastService);

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly CheckCircle = CheckCircle;
  protected readonly Database = Database;
  protected readonly HardDrive = HardDrive;
  protected readonly ListChecks = ListChecks;
  protected readonly Phone = Phone;
  protected readonly Plus = Plus;
  protected readonly Power = Power;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Send = Send;
  protected readonly Trash2 = Trash2;
  protected readonly XCircle = XCircle;

  readonly status = signal<SmsStatus | null>(null);
  readonly logs = signal<SmsLogDto[]>([]);
  readonly provisionings = signal<ProvisioningDto[]>([]);
  readonly backupHealth = signal<BackupHealthResponse | null>(null);
  readonly activeTab = signal<Tab>('status');

  readonly tabs: { key: Tab; label: string }[] = [
    { key: 'status', label: 'Statut' },
    { key: 'provision', label: 'Provisionnement' },
    { key: 'logs', label: 'Logs SMS' },
    { key: 'allowlist', label: 'Allowlist' },
    { key: 'backup', label: 'Backups' },
  ];

  // Adhoc send form
  adhocTo = '';
  adhocBody = '';

  // Provisioning form
  provIMEI = '';
  provPhone = '';
  provApn = '';
  provServerIp = '';
  provServerPort: number | null = 5001;
  provLowBatPhone = '';

  // Logs filter
  logsImei = '';

  // V1.14 — Allowlist vizyo-texto state
  readonly allowlistEntries = signal<AllowlistEntryDto[]>([]);
  readonly allowlistStatus = signal<AllowlistStatus | null>(null);
  newPhone = '';
  newLabel = '';
  readonly syncing = signal(false);

  // V1.13 — Verdict reel SMS Gateway (utilise dans card status).
  private modeOk(): boolean {
    const m = this.status()?.mode;
    return m === 'twilio' || m === 'vizyo-texto';
  }
  private modeBroken(): boolean {
    const m = this.status()?.mode;
    return m === 'twilio-broken' || m === 'vizyo-texto-broken';
  }
  protected cardBorderClass(): string {
    if (this.modeOk()) return 'border-emerald-500/30';
    if (this.modeBroken()) return 'border-rose-500/40';
    return 'border-amber-500/30';
  }
  protected cardIconClass(): string {
    if (this.modeOk()) return 'text-emerald-400';
    if (this.modeBroken()) return 'text-rose-400';
    return 'text-amber-400';
  }
  protected cardTitleClass(): string {
    if (this.modeOk()) return 'text-emerald-400';
    if (this.modeBroken()) return 'text-rose-400';
    return 'text-amber-400';
  }
  protected cardTitleText(): string {
    const m = this.status()?.mode;
    if (m === 'vizyo-texto') return 'vizyo-texto actif';
    if (m === 'vizyo-texto-broken') return 'vizyo-texto injoignable';
    if (m === 'twilio') return 'Twilio actif';
    if (m === 'twilio-broken') return 'Twilio configure mais auth KO';
    return 'No-op (dev)';
  }
  protected cardSubText(): string {
    const m = this.status()?.mode;
    if (m === 'vizyo-texto') return 'Les SMS partent via la passerelle maison vizyo-texto.';
    if (m === 'vizyo-texto-broken')
      return 'vizyo-texto est configure mais injoignable — verifier le relay (texto.vizyoagency.com).';
    if (m === 'twilio') return 'Les SMS sont reellement envoyes (Twilio).';
    if (m === 'twilio-broken')
      return 'Les credentials TWILIO_* sont presents mais Twilio refuse l\'authentification — verifier sid/token.';
    return 'Les SMS sont simules — aucune gateway configuree.';
  }

  ngOnInit(): void {
    this.reload();
  }

  async reload(): Promise<void> {
    try {
      const [status, logs, provs, bh] = await Promise.all([
        firstValueFrom(this.api.status()),
        firstValueFrom(this.api.logs(100, this.logsImei || undefined)),
        firstValueFrom(this.api.listProvisionings(50)),
        firstValueFrom(this.api.backupHealth(30)),
      ]);
      this.status.set(status);
      this.logs.set(logs.items);
      this.provisionings.set(provs.items);
      this.backupHealth.set(bh);
    } catch {
      this.toast.error('Echec du chargement (acces SUPER_ADMIN requis)');
    }
    await this.loadAllowlist();
  }

  async sendAdhoc(): Promise<void> {
    try {
      const result = await firstValueFrom(this.api.send(this.adhocTo, this.adhocBody));
      if (result.ok) {
        this.toast.success('SMS envoye');
        this.adhocBody = '';
        this.reload();
      } else {
        this.toast.error(result.error ?? 'Echec d\'envoi');
      }
    } catch {
      this.toast.error('Echec d\'envoi SMS');
    }
  }

  async startProvisioning(): Promise<void> {
    if (!this.provServerPort) return;
    try {
      await firstValueFrom(
        this.api.startProvisioning({
          imei: this.provIMEI.trim(),
          phoneNumber: this.provPhone.trim(),
          apn: this.provApn.trim(),
          serverIp: this.provServerIp.trim(),
          serverPort: this.provServerPort,
          lowBatteryPhone: this.provLowBatPhone.trim() || undefined,
        }),
      );
      this.toast.success('Sequence demarree (9 SMS sur ~5 min)');
      this.reload();
    } catch (err: unknown) {
      const message = err && typeof err === 'object' && 'error' in err
        ? (err as { error?: { message?: string } }).error?.message
        : null;
      this.toast.error(message ?? 'Echec du demarrage');
    }
  }

  async cancelProv(id: string): Promise<void> {
    try {
      await firstValueFrom(this.api.cancelProvisioning(id));
      this.toast.success('Sequence annulee');
      this.reload();
    } catch {
      this.toast.error('Echec annulation');
    }
  }

  // ─── Allowlist vizyo-texto (V1.14) ─────────────────────────────────────────

  private async loadAllowlist(): Promise<void> {
    try {
      const [entries, st] = await Promise.all([
        firstValueFrom(this.api.allowlist()),
        firstValueFrom(this.api.allowlistStatus()),
      ]);
      this.allowlistEntries.set(entries);
      this.allowlistStatus.set(st);
    } catch {
      /* silencieux : vizyo-texto peut etre injoignable / non configure */
    }
  }

  async addNumber(): Promise<void> {
    if (!this.newPhone.trim()) return;
    try {
      await firstValueFrom(
        this.api.addAllowlist(this.newPhone.trim(), this.newLabel.trim() || undefined),
      );
      this.toast.success('Numero ajoute a l\'allowlist');
      this.newPhone = '';
      this.newLabel = '';
      await this.loadAllowlist();
    } catch (e) {
      this.toast.error(this.errMsg(e) ?? 'Echec ajout');
    }
  }

  async removeNumber(phone: string): Promise<void> {
    try {
      await firstValueFrom(this.api.removeAllowlist(phone));
      this.toast.success('Numero retire');
      await this.loadAllowlist();
    } catch {
      this.toast.error('Echec suppression');
    }
  }

  async syncTrackers(): Promise<void> {
    this.syncing.set(true);
    try {
      const r = await firstValueFrom(this.api.syncAllowlist());
      const extra = r.skipped ? `, ${r.skipped} ignores` : '';
      this.toast.success(`Sync OK — +${r.added} / -${r.removed} (${r.unchanged} inchanges${extra})`);
      await this.loadAllowlist();
    } catch (e) {
      this.toast.error(this.errMsg(e) ?? 'Echec sync');
    } finally {
      this.syncing.set(false);
    }
  }

  private errMsg(e: unknown): string | null {
    if (e && typeof e === 'object' && 'error' in e) {
      return (e as { error?: { message?: string } }).error?.message ?? null;
    }
    return null;
  }

  provBadgeClass(status: ProvisioningDto['status']): string {
    if (status === 'COMPLETED') return 'bg-emerald-500/10 text-emerald-400';
    if (status === 'IN_PROGRESS') return 'bg-sky-500/10 text-sky-400';
    if (status === 'FAILED') return 'bg-rose-500/10 text-rose-400';
    if (status === 'CANCELLED') return 'bg-fg-tertiary/10 text-fg-tertiary';
    return 'bg-amber-500/10 text-amber-400';
  }

  formatBytes(s: string | null): string {
    if (!s) return '—';
    const n = Number(s);
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  }
}
