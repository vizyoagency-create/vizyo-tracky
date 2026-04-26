import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlertTriangle,
  CheckCircle,
  Database,
  HardDrive,
  LucideAngularModule,
  MessageSquare,
  Phone,
  Power,
  RefreshCw,
  Send,
  XCircle,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  AdminSmsService,
  BackupHealthResponse,
  ProvisioningDto,
  SmsLogDto,
  SmsStatus,
} from '../../core/services/admin-sms.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

type Tab = 'status' | 'provision' | 'logs' | 'backup';

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
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex items-center gap-3">
            <lucide-icon [img]="Power" [size]="32" [class]="status()?.enabled ? 'text-emerald-400' : 'text-amber-400'"></lucide-icon>
            <div>
              <div class="text-xs uppercase text-fg-tertiary">SMS Gateway</div>
              <div class="text-lg font-display font-bold"
                   [class]="status()?.enabled ? 'text-emerald-400' : 'text-amber-400'">
                {{ status()?.enabled ? 'Twilio actif' : 'No-op (dev)' }}
              </div>
              <div class="text-xs text-fg-tertiary mt-1">
                @if (status()?.enabled) {
                  Les SMS sont reellement envoyes.
                } @else {
                  Les SMS sont simules — config TWILIO_* manquante.
                }
              </div>
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
            <input [(ngModel)]="provPhone" placeholder="Numero SIM (+33...)"
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
  protected readonly MessageSquare = MessageSquare;
  protected readonly Phone = Phone;
  protected readonly Power = Power;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Send = Send;
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
