import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  ChevronDown,
  Circle,
  Clock,
  Database,
  HardDrive,
  ListChecks,
  Loader,
  LucideAngularModule,
  MessageSquare,
  Phone,
  Plus,
  Power,
  RefreshCw,
  Search,
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
  ProvisioningStep,
  SmsLogDto,
  SmsStatus,
} from '../../core/services/admin-sms.service';
import { SimsApiService } from '../../core/services/sims.service';
import { TrackerDetail, TrackersApiService } from '../../core/services/trackers.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import type { SimDto } from '@vizyo/tracky-shared';

type Tab = 'status' | 'provision' | 'logs' | 'allowlist' | 'backup';

interface PrefillItem {
  key: string;
  type: 'sim' | 'vehicle';
  imei: string;
  phone: string;
  apn: string;
  plate: string;
  fleet: string;
  iccid: string;
  configured: boolean;
}

@Component({
  selector: 'app-admin-sms',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, FormsModule, RouterLink],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <a routerLink="/admin"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon>
            Administration
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary">SMS &amp; Backup admin</h1>
          <p class="text-sm text-fg-tertiary">
            Outils SUPER_ADMIN : configuration des boitiers GPS via SMS (avec
            confirmation par la reponse du boitier), audit des envois, et
            monitoring des backups Postgres.
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

        <!-- V1.15 — Heartbeat "preuve de vie" SMS : declenche le meme traitement
             que le cron hebdo (lundi 09h00 Europe/Paris) a la demande. -->
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-3">
          <div class="flex items-center gap-2 text-sm font-semibold">
            <lucide-icon [img]="Activity" [size]="16" class="text-tracky-light"></lucide-icon>
            Preuve de vie SMS (heartbeat)
          </div>
          <p class="text-xs text-fg-tertiary">
            Envoie un SMS de test aux numeros <code>SMS_HEARTBEAT_RECIPIENTS</code> via la gateway
            active. Le cron automatique tourne chaque lundi 09h00 (Europe/Paris) ; si la chaine SMS
            est cassee (SIM down), un ErrorLog CRITICAL est cree.
          </p>
          <button (click)="runHeartbeat()" [disabled]="heartbeatRunning()"
                  class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer disabled:opacity-50 self-start flex items-center gap-2">
            <lucide-icon [img]="Activity" [size]="14"></lucide-icon>
            {{ heartbeatRunning() ? 'Envoi...' : 'Tester le heartbeat maintenant' }}
          </button>
        </div>

      }

      <!-- Tab : Configuration boitier (assistant pas-a-pas) -->
      @if (activeTab() === 'provision') {
        <!-- Formulaire -->
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-3">
          <div class="flex items-center gap-2 text-sm font-semibold">
            <lucide-icon [img]="Phone" [size]="16" class="text-tracky-light"></lucide-icon>
            Configurer un boitier GPS par SMS
          </div>
          <p class="text-xs text-fg-tertiary -mt-1">
            Chaque commande part via vizyo-texto ; on attend la reponse du boitier
            (jusqu'a {{ provAckTimeout || 45 }}s) avant d'envoyer la suivante. Reponds
            depuis la SIM pour confirmer chaque etape.
          </p>

          <!-- Pre-remplissage depuis SIM ou vehicule -->
          <div class="flex flex-col gap-2">
            <label class="text-[11px] uppercase tracking-wide text-fg-tertiary">Pre-remplir depuis</label>
            <div class="relative">
              <lucide-icon [img]="Search" [size]="14" class="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none"></lucide-icon>
              <input [(ngModel)]="prefillSearch"
                     (focus)="onPrefillFocus()"
                     (input)="onPrefillInput()"
                     placeholder="Rechercher par IMEI, plaque, numero SIM, flotte..."
                     class="w-full bg-bg-tertiary border border-border-subtle rounded-lg pl-9 pr-3 py-2 text-sm text-fg-primary" />
            </div>
            @if (prefillOpen()) {
              <div class="bg-bg-tertiary border border-border-subtle rounded-lg max-h-60 overflow-y-auto -mt-1 shadow-lg">
                @if (filteredPrefillItems().length === 0) {
                  <div class="px-3 py-4 text-xs text-fg-tertiary text-center">
                    {{ prefillLoading() ? 'Chargement...' : 'Aucun resultat' }}
                  </div>
                }
                @for (item of filteredPrefillItems(); track item.key) {
                  <button (click)="applyPrefill(item)" type="button"
                          class="w-full text-left px-3 py-2.5 hover:bg-bg-secondary cursor-pointer border-b border-border-subtle/40 last:border-0 flex flex-col gap-0.5">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-[10px] px-1.5 py-0.5 rounded font-mono"
                            [class]="item.type === 'sim' ? 'bg-sky-500/10 text-sky-400' : 'bg-emerald-500/10 text-emerald-400'">
                        {{ item.type === 'sim' ? 'SIM' : 'Vehicule' }}
                      </span>
                      @if (item.configured) {
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-medium">Deja configure</span>
                      } @else {
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-medium">Non configure</span>
                      }
                      @if (item.fleet) {
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 font-medium">{{ item.fleet }}</span>
                      }
                      @if (item.plate) {
                        <span class="text-sm font-semibold text-fg-primary">{{ item.plate }}</span>
                      }
                    </div>
                    <div class="text-xs text-fg-tertiary font-mono flex flex-wrap gap-x-3">
                      @if (item.imei) { <span>IMEI {{ item.imei }}</span> }
                      @if (item.phone) { <span>Tel {{ item.phone }}</span> }
                      @if (item.apn) { <span>APN {{ item.apn }}</span> }
                      @if (item.iccid) { <span>ICCID {{ item.iccid }}</span> }
                    </div>
                  </button>
                }
              </div>
            }
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
              IMEI
              <input [(ngModel)]="provIMEI" placeholder="14-16 chiffres"
                     class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
            </label>
            <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
              Numero SIM (E.164)
              <input [(ngModel)]="provPhone" placeholder="+33612345678"
                     class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
            </label>
            <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
              APN
              <input [(ngModel)]="provApn" placeholder="wsim"
                     class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm normal-case text-fg-primary" />
            </label>
            <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
              Numero admin / SOS
              <input [(ngModel)]="provAdminNumber" placeholder="defaut : numero SIM"
                     class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
            </label>
            <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
              IP serveur
              <input [(ngModel)]="provServerIp" placeholder="72.62.26.240"
                     class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
            </label>
            <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
              Port serveur
              <input [(ngModel)]="provServerPort" type="number" placeholder="5023"
                     class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
            </label>
            <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
              Intervalle position (s)
              <input [(ngModel)]="provFixInterval" type="number" min="20" placeholder="20"
                     class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
            </label>
            <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
              Timeout reponse (s)
              <input [(ngModel)]="provAckTimeout" type="number" min="3" placeholder="45"
                     class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
            </label>
          </div>

          <!-- Options avancees -->
          <button type="button" (click)="showAdvanced.set(!showAdvanced())"
                  class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 self-start cursor-pointer">
            <lucide-icon [img]="ChevronDown" [size]="12"
                         [class]="showAdvanced() ? 'rotate-180 transition-transform' : 'transition-transform'"></lucide-icon>
            Options avancees
          </button>
          @if (showAdvanced()) {
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
                Utilisateur APN
                <input [(ngModel)]="provApnUser" placeholder="(vide pour wsim)"
                       class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
              </label>
              <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
                Mot de passe APN
                <input [(ngModel)]="provApnPasswd" placeholder="(vide pour wsim)"
                       class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
              </label>
              <label class="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-fg-tertiary">
                Tel batterie faible
                <input [(ngModel)]="provLowBatPhone" placeholder="+33... (optionnel)"
                       class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono normal-case text-fg-primary" />
              </label>
              <label class="flex items-center gap-2 text-sm text-fg-secondary normal-case self-end py-2">
                <input type="checkbox" [(ngModel)]="provAccOn"
                       class="rounded border-border-subtle bg-bg-tertiary" />
                Activer l'alarme ACC
              </label>
            </div>
          }

          <div class="text-xs text-fg-tertiary">
            Sequence : <span class="font-mono">begin → apn → admin → adminip → gprs → fix</span>
            (+ options). Le « + » du numero admin est retire automatiquement.
          </div>
          <button (click)="startProvisioning()"
                  [disabled]="!provIMEI || !provPhone || !provApn || !provServerIp || !provServerPort"
                  class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer disabled:opacity-50 self-start flex items-center gap-2">
            <lucide-icon [img]="Send" [size]="14"></lucide-icon>
            Lancer la configuration
          </button>
        </div>

        <!-- Stepper live de la sequence selectionnee -->
        @if (selectedProv(); as p) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-3">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <div class="flex items-center gap-2 text-sm font-semibold">
                <lucide-icon [img]="ListChecks" [size]="16" class="text-tracky-light"></lucide-icon>
                Sequence
                <span class="font-mono text-xs text-fg-tertiary">{{ p.phoneNumber }}</span>
                <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md font-mono"
                      [class]="provBadgeClass(p.status)">{{ p.status }}</span>
              </div>
              <div class="flex items-center gap-3">
                @if (p.status === 'IN_PROGRESS') {
                  <span class="text-xs text-sky-400 inline-flex items-center gap-1">
                    <lucide-icon [img]="Loader" [size]="12" class="animate-spin"></lucide-icon>
                    {{ p.currentStep }} / {{ p.steps.length }}
                  </span>
                  <button (click)="cancelProv(p.id)" class="text-xs text-rose-400 hover:underline cursor-pointer">Annuler</button>
                }
              </div>
            </div>
            @if (p.status === 'FAILED' && p.failureReason) {
              <div class="flex items-start gap-2 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2.5">
                <lucide-icon [img]="AlertTriangle" [size]="16" class="text-rose-400 mt-0.5 shrink-0"></lucide-icon>
                <div class="text-sm text-rose-300 font-mono break-all">{{ p.failureReason }}</div>
              </div>
            }
            <ol class="flex flex-col gap-2">
              @for (s of p.steps; track s.step) {
                <li class="flex items-start gap-3 rounded-lg border border-border-subtle/60 bg-bg-tertiary/40 p-2.5">
                  <lucide-icon [img]="stepIcon(s.status)" [size]="18"
                               [class]="stepIconClass(s.status) + (s.status === 'sent' ? ' animate-spin' : '')"></lucide-icon>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-sm font-medium text-fg-primary">{{ s.label || s.key }}</span>
                      <span class="text-[10px] px-1.5 py-0.5 rounded font-mono" [class]="stepBadgeClass(s.status)">
                        {{ stepStatusLabel(s.status) }}
                      </span>
                    </div>
                    <div class="text-xs font-mono text-fg-tertiary truncate" [title]="s.payload">→ {{ s.payload }}</div>
                    @if (s.reply) {
                      <div class="mt-1 inline-flex items-start gap-1 bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 rounded px-2 py-1 text-xs">
                        <lucide-icon [img]="MessageSquare" [size]="12" class="mt-0.5 shrink-0"></lucide-icon>
                        <span class="font-mono break-all">{{ s.reply }}</span>
                      </div>
                    }
                    @if (s.error) {
                      <div class="mt-1 text-xs text-rose-300 font-mono break-all">{{ s.error }}</div>
                    }
                  </div>
                </li>
              }
            </ol>
          </div>
        }

        <!-- Historique des sequences (cliquer pour afficher le detail) -->
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
                  <tr (click)="selectedProvId.set(p.id)"
                      class="border-b border-border-subtle/50 cursor-pointer"
                      [class]="selectedProvId() === p.id ? 'bg-bg-tertiary/60' : 'hover:bg-bg-tertiary/50'">
                    <td class="p-3 text-xs text-fg-tertiary">{{ p.createdAt | date: 'dd/MM HH:mm' }}</td>
                    <td class="p-3 font-mono text-xs">{{ p.imei }}</td>
                    <td class="p-3 font-mono text-xs">{{ p.phoneNumber }}</td>
                    <td class="p-3 text-center font-mono">{{ p.currentStep }} / {{ p.steps.length || '—' }}</td>
                    <td class="p-3">
                      <span class="inline-flex items-center px-2 py-0.5 text-[10px] rounded-md font-mono"
                            [class]="provBadgeClass(p.status)">
                        {{ p.status }}
                      </span>
                    </td>
                    <td class="p-3">
                      @if (p.status === 'IN_PROGRESS') {
                        <button (click)="$event.stopPropagation(); cancelProv(p.id)"
                                class="text-xs text-rose-400 hover:underline cursor-pointer">Annuler</button>
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
              {{ syncing() ? 'Sync...' : 'Synchroniser' }}
            </button>
          </div>
          <p class="text-xs text-fg-tertiary">
            Seuls les numeros de cette liste peuvent recevoir un SMS. "Synchroniser" pousse les SIM
            des trackers ET les numeros (phone) des utilisateurs actifs — requis pour les notifications
            SMS d'alerte (source <code>synced</code>) ; les numeros ajoutes a la main (<code>manual</code>)
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
export class AdminSmsComponent implements OnInit, OnDestroy {
  private readonly api = inject(AdminSmsService);
  private readonly simsApi = inject(SimsApiService);
  private readonly trackersApi = inject(TrackersApiService);
  private readonly toast = inject(ToastService);

  protected readonly Activity = Activity;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly ArrowLeft = ArrowLeft;
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
  protected readonly Clock = Clock;
  protected readonly MessageSquare = MessageSquare;
  protected readonly ChevronDown = ChevronDown;
  protected readonly Circle = Circle;
  protected readonly Loader = Loader;
  protected readonly Search = Search;

  readonly status = signal<SmsStatus | null>(null);
  readonly logs = signal<SmsLogDto[]>([]);
  readonly provisionings = signal<ProvisioningDto[]>([]);
  readonly backupHealth = signal<BackupHealthResponse | null>(null);
  // V1.15 — heartbeat "preuve de vie" SMS en cours (bouton run-now).
  readonly heartbeatRunning = signal(false);
  readonly activeTab = signal<Tab>('status');

  readonly tabs: { key: Tab; label: string }[] = [
    { key: 'status', label: 'Statut' },
    { key: 'provision', label: 'Configuration boîtier' },
    { key: 'logs', label: 'Logs SMS' },
    { key: 'allowlist', label: 'Allowlist' },
    { key: 'backup', label: 'Backups' },
  ];

  // Adhoc send form
  adhocTo = '';
  adhocBody = '';

  // Provisioning / config boitier form
  provIMEI = '';
  provPhone = '';
  provApn = 'wsim';
  provAdminNumber = '';
  provServerIp = '72.62.26.240';
  provServerPort: number | null = 5023;
  provFixInterval: number | null = 20;
  provAckTimeout: number | null = null; // vide => defaut backend (DEFAULT_ACK_TIMEOUT_S=45s)
  provApnUser = '';
  provApnPasswd = '';
  provAccOn = false;
  provLowBatPhone = '';
  readonly showAdvanced = signal(false);

  // ─── Pre-remplissage depuis SIM / vehicule ─────────────────────────────────
  prefillSearch = '';
  readonly prefillOpen = signal(false);
  readonly prefillLoading = signal(false);
  readonly prefillItems = signal<PrefillItem[]>([]);
  readonly filteredPrefillItems = computed(() => {
    const q = this.prefillSearch.toLowerCase().trim();
    const items = this.prefillItems();
    if (!q) return items;
    return items.filter(
      (i) =>
        (i.imei?.toLowerCase().includes(q)) ||
        (i.phone?.toLowerCase().includes(q)) ||
        (i.plate?.toLowerCase().includes(q)) ||
        (i.fleet?.toLowerCase().includes(q)) ||
        (i.iccid?.toLowerCase().includes(q)),
    );
  });

  async onPrefillFocus(): Promise<void> {
    this.prefillOpen.set(true);
    if (this.prefillItems().length === 0) await this.loadPrefillItems();
  }

  onPrefillInput(): void {
    this.prefillOpen.set(true);
  }

  private async loadPrefillItems(): Promise<void> {
    this.prefillLoading.set(true);
    try {
      const [sims, trackers] = await Promise.all([
        this.simsApi.list(),
        firstValueFrom(this.trackersApi.list()),
      ]);

      // Un tracker qui a deja envoye des positions (lastSeenAt) = configure
      const activeImeis = new Set(
        trackers
          .filter((t) => t.lastSeenAt)
          .map((t) => t.imei),
      );

      const items: PrefillItem[] = [];

      // SIMs avec un msisdn
      for (const s of sims) {
        if (!s.msisdn) continue;
        const imei = s.tracker?.imei ?? s.imei ?? '';
        items.push({
          key: `sim-${s.id}`,
          type: 'sim',
          imei,
          phone: s.msisdn,
          apn: s.apn ?? '',
          plate: s.tracker?.vehiclePlate ?? '',
          fleet: s.fleet?.name ?? '',
          iccid: s.iccid,
          configured: !!imei && activeImeis.has(imei),
        });
      }

      // Trackers avec SIM qui n'ont pas ete couverts par les SIMs
      const coveredImeis = new Set(items.map((i) => i.imei).filter(Boolean));
      for (const t of trackers) {
        if (coveredImeis.has(t.imei)) continue;
        if (!t.simPhoneNumber && !t.vehicle) continue;
        items.push({
          key: `tracker-${t.id}`,
          type: 'vehicle',
          imei: t.imei,
          phone: t.simPhoneNumber ?? '',
          apn: '',
          plate: t.vehicle?.plate ?? '',
          fleet: t.vehicle?.fleet?.name ?? '',
          iccid: '',
          configured: activeImeis.has(t.imei),
        });
      }

      this.prefillItems.set(items);
    } catch {
      /* silencieux */
    } finally {
      this.prefillLoading.set(false);
    }
  }

  applyPrefill(item: PrefillItem): void {
    if (item.imei) this.provIMEI = item.imei;
    if (item.phone) {
      // Normalise E.164 : ajoute le + si absent
      this.provPhone = item.phone.startsWith('+') ? item.phone : `+${item.phone}`;
    }
    if (item.apn) this.provApn = item.apn;
    this.prefillOpen.set(false);
    this.prefillSearch = '';
    this.toast.success(`Pre-rempli depuis ${item.type === 'sim' ? 'SIM' : 'vehicule'} ${item.plate || item.imei}`);
  }

  readonly selectedProvId = signal<string | null>(null);
  readonly selectedProv = computed(
    () =>
      this.provisionings().find((p) => p.id === this.selectedProvId()) ??
      this.provisionings().find((p) => p.status === 'IN_PROGRESS') ??
      this.provisionings()[0] ??
      null,
  );

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
      if (provs.items.some((p) => p.status === 'IN_PROGRESS')) this.startPolling();
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

  // V1.15 — Force un heartbeat "preuve de vie" SMS (POST /heartbeat/run-now).
  async runHeartbeat(): Promise<void> {
    this.heartbeatRunning.set(true);
    try {
      const r = await firstValueFrom(this.api.runHeartbeat());
      if (r.skipped) {
        this.toast.error('Heartbeat ignore — aucun numero (SMS_HEARTBEAT_RECIPIENTS vide)');
      } else if (r.failed === 0) {
        this.toast.success(`Heartbeat OK — ${r.sent}/${r.recipients} SMS via ${r.provider}`);
      } else {
        this.toast.error(`Heartbeat : ${r.failed}/${r.recipients} echec(s) via ${r.provider} — voir ErrorLogs`);
      }
      this.reload();
    } catch {
      this.toast.error('Echec du heartbeat (acces SUPER_ADMIN requis)');
    } finally {
      this.heartbeatRunning.set(false);
    }
  }

  async startProvisioning(): Promise<void> {
    if (!this.provServerPort) return;
    try {
      const res = await firstValueFrom(
        this.api.startProvisioning({
          imei: this.provIMEI.trim(),
          phoneNumber: this.provPhone.trim(),
          apn: this.provApn.trim(),
          adminNumber: this.provAdminNumber.trim() || undefined,
          serverIp: this.provServerIp.trim(),
          serverPort: this.provServerPort,
          fixIntervalS: this.provFixInterval ?? undefined,
          ackTimeoutS: this.provAckTimeout ?? undefined,
          apnUser: this.provApnUser.trim() || undefined,
          apnPasswd: this.provApnPasswd.trim() || undefined,
          accOn: this.provAccOn || undefined,
          lowBatteryPhone: this.provLowBatPhone.trim() || undefined,
        }),
      );
      this.selectedProvId.set(res.id);
      this.toast.success('Configuration lancee — le boitier repond automatiquement');
      await this.refreshProvisionings();
      this.startPolling();
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

  // ─── Suivi live de la sequence (polling tant qu'un provisioning tourne) ─────

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refreshProvisionings(), 2500);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async refreshProvisionings(): Promise<void> {
    try {
      const provs = await firstValueFrom(this.api.listProvisionings(50));
      this.provisionings.set(provs.items);
      if (!provs.items.some((p) => p.status === 'IN_PROGRESS')) this.stopPolling();
    } catch {
      /* transitoire : on retentera au prochain tick */
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  // ─── Rendu d'une etape du stepper ─────────────────────────────────────────

  stepIcon(status: ProvisioningStep['status']) {
    switch (status) {
      case 'acked':
        return CheckCircle;
      case 'failed':
        return XCircle;
      case 'no-ack':
        return Clock;
      case 'sent':
        return Loader;
      default:
        return Circle; // pending / noop
    }
  }

  stepIconClass(status: ProvisioningStep['status']): string {
    switch (status) {
      case 'acked':
        return 'text-emerald-400';
      case 'failed':
        return 'text-rose-400';
      case 'no-ack':
        return 'text-amber-400';
      case 'sent':
        return 'text-sky-400';
      default:
        return 'text-fg-tertiary';
    }
  }

  stepBadgeClass(status: ProvisioningStep['status']): string {
    switch (status) {
      case 'acked':
        return 'bg-emerald-500/10 text-emerald-400';
      case 'failed':
        return 'bg-rose-500/10 text-rose-400';
      case 'no-ack':
        return 'bg-amber-500/10 text-amber-400';
      case 'sent':
        return 'bg-sky-500/10 text-sky-400';
      default:
        return 'bg-fg-tertiary/10 text-fg-tertiary';
    }
  }

  stepStatusLabel(status: ProvisioningStep['status']): string {
    switch (status) {
      case 'pending':
        return 'en attente';
      case 'sent':
        return 'envoyé…';
      case 'acked':
        return 'confirmé';
      case 'no-ack':
        return 'sans réponse';
      case 'failed':
        return 'échec';
      case 'noop':
        return 'simulé';
      default:
        return status;
    }
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
