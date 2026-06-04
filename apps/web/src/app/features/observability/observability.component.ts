import { Component, inject, OnInit, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  LucideAngularModule, Activity, AlertTriangle, MessageSquare, Search, RefreshCw,
  ArrowUpRight, ArrowDownLeft, Clock, Terminal, Bell, BellRing, Send, Smartphone,
  Trash2, User as UserIcon, Globe,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import {
  AdminLogsService,
  type WireLogDto,
  type TimelineEntry,
} from '../../core/services/admin-logs.service';
import { AdminSmsService, type SmsTestFallbackResult } from '../../core/services/admin-sms.service';
import { NotificationsApiService, type TestPushResultEntry } from '../../core/services/notifications.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

@Component({
  selector: 'app-observability',
  standalone: true,
  imports: [LucideAngularModule, DatePipe, JsonPipe, FormsModule],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-display font-bold text-fg-primary">Diagnostic & Tests</h1>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 border-b border-border-subtle overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        @for (tab of tabs; track tab.key) {
          <button
            (click)="onSelectTab(tab.key)"
            class="px-3 sm:px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer border-b-2 -mb-px shrink-0 whitespace-nowrap"
            [class]="activeTab() === tab.key
              ? 'text-tracky-light border-tracky-light'
              : 'text-fg-tertiary border-transparent hover:text-fg-secondary'"
          >
            {{ tab.label }}
          </button>
        }
      </div>

      <!-- Wire Logs Tab -->
      @if (activeTab() === 'wire') {
        <div class="flex flex-wrap gap-3 items-end">
          <div class="flex flex-col gap-1 flex-1 min-w-[180px]">
            <label class="text-xs text-fg-tertiary">IMEI</label>
            <input [(ngModel)]="wireImeiFilter" placeholder="865328021056352"
                   class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary w-full" />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Direction</label>
            <select [(ngModel)]="wireDirectionFilter"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option value="">Toutes</option>
              <option value="IN">IN</option>
              <option value="OUT">OUT</option>
            </select>
          </div>
          <button (click)="loadWireLogs()" class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium
                  hover:bg-tracky-dark cursor-pointer flex items-center gap-2 shrink-0">
            <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon>
            Rafraîchir
          </button>
        </div>

        @if (wireLogs().length > 0) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-x-auto">
            <table class="w-full text-sm min-w-[700px]">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase">
                <tr>
                  <th class="p-3 text-left">Date</th>
                  <th class="p-3 text-center">Dir</th>
                  <th class="p-3 text-left">IMEI</th>
                  <th class="p-3 text-left">Type</th>
                  <th class="p-3 text-left">Contenu</th>
                </tr>
              </thead>
              <tbody>
                @for (log of wireLogs(); track log.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/50">
                    <td class="p-3 text-fg-tertiary text-xs font-mono">{{ log.createdAt | date:'HH:mm:ss.SSS' }}</td>
                    <td class="p-3 text-center">
                      @if (log.direction === 'IN') {
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md bg-emerald-500/10 text-emerald-400">
                          <lucide-icon [img]="ArrowDownLeft" [size]="10"></lucide-icon> IN
                        </span>
                      } @else {
                        <span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md bg-sky-500/10 text-sky-400">
                          <lucide-icon [img]="ArrowUpRight" [size]="10"></lucide-icon> OUT
                        </span>
                      }
                    </td>
                    <td class="p-3 font-mono text-xs text-fg-primary">{{ log.imei.slice(0,4) }}...{{ log.imei.slice(-4) }}</td>
                    <td class="p-3 text-xs text-fg-tertiary">{{ log.frameType ?? '—' }}</td>
                    <td class="p-3 font-mono text-xs text-fg-primary truncate max-w-[320px] sm:max-w-[400px]">{{ log.raw }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="text-xs text-fg-tertiary">{{ wireTotal() }} résultats</p>
        } @else {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
            <lucide-icon [img]="Activity" [size]="48" class="opacity-30"></lucide-icon>
            <p>Aucun log wire</p>
          </div>
        }
      }

      <!-- Timeline Tab -->
      @if (activeTab() === 'timeline') {
        <div class="flex gap-3 items-end">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">IMEI du tracker</label>
            <input [(ngModel)]="timelineImei" placeholder="865328021056352"
                   class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary w-48" />
          </div>
          <button (click)="loadTimeline()" class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium
                  hover:bg-tracky-dark cursor-pointer flex items-center gap-2"
                  [disabled]="!timelineImei()">
            <lucide-icon [img]="Search" [size]="14"></lucide-icon>
            Charger
          </button>
        </div>

        @if (timelineEntries().length > 0) {
          <div class="relative pl-8">
            <div class="absolute left-3 top-0 bottom-0 w-px bg-border-subtle"></div>
            @for (entry of timelineEntries(); track entry.id) {
              <div class="relative mb-4">
                <div class="absolute -left-5 w-3 h-3 rounded-full border-2 border-bg-primary"
                     [class]="entry.type === 'error' ? 'bg-red-400' : entry.direction === 'IN' ? 'bg-emerald-400' : 'bg-sky-400'">
                </div>
                <div class="bg-bg-secondary border border-border-subtle rounded-lg p-3">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] font-mono text-fg-tertiary">{{ entry.createdAt | date:'HH:mm:ss.SSS' }}</span>
                    @if (entry.type === 'wire') {
                      <span class="text-[10px] px-1.5 py-0.5 rounded"
                            [class]="entry.direction === 'IN' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-sky-500/10 text-sky-400'">
                        {{ entry.direction }} {{ entry.frameType }}
                      </span>
                    } @else {
                      <span class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">
                        {{ entry.level }} {{ entry.source }}
                      </span>
                    }
                    @if (entry.commandId) {
                      <span class="text-[10px] font-mono text-purple-400">cmd:{{ entry.commandId!.slice(0,8) }}</span>
                    }
                  </div>
                  <p class="text-xs font-mono text-fg-primary">
                    {{ entry.type === 'wire' ? entry.raw : entry.message }}
                  </p>
                </div>
              </div>
            }
          </div>
        } @else if (timelineImei()) {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
            <lucide-icon [img]="Clock" [size]="48" class="opacity-30"></lucide-icon>
            <p>Aucun événement pour cet IMEI</p>
          </div>
        }
      }

      <!-- Test Notification Tab (SUPER_ADMIN) -->
      @if (activeTab() === 'test-push') {
        <!-- Statut push global serveur -->
        @if (notif.pushEnabled() === false) {
          <div class="bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-[--radius-card] p-4 text-sm flex items-start gap-3">
            <lucide-icon [img]="AlertTriangle" [size]="20" class="shrink-0 mt-0.5"></lucide-icon>
            <div>
              <p class="font-medium">Push désactivé côté serveur</p>
              <p class="text-xs mt-1 opacity-80">
                Les clés VAPID ne sont pas configurées (env <code class="font-mono">VAPID_PUBLIC_KEY</code> / <code class="font-mono">VAPID_PRIVATE_KEY</code>).
                Génère-les avec <code class="font-mono">npx web-push generate-vapid-keys</code>.
              </p>
            </div>
          </div>
        }

        <!-- Diagnostic device : iOS, standalone, permission, UA -->
        @if (diagnostic(); as d) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-3">
            <p class="text-xs uppercase text-fg-tertiary tracking-wide">Diagnostic device</p>

            @if (!d.supported && d.reason) {
              <div class="bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-lg p-3 text-xs flex items-start gap-2">
                <lucide-icon [img]="AlertTriangle" [size]="14" class="shrink-0 mt-0.5"></lucide-icon>
                <p>{{ d.reason }}</p>
              </div>
            }

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div class="bg-bg-tertiary rounded-lg px-3 py-2 flex flex-col gap-0.5">
                <span class="text-fg-tertiary text-[10px] uppercase">Push API</span>
                <span [class]="d.supported ? 'text-emerald-400' : 'text-red-400'" class="font-medium">
                  {{ d.supported ? 'Supporté' : 'Non' }}
                </span>
              </div>
              <div class="bg-bg-tertiary rounded-lg px-3 py-2 flex flex-col gap-0.5">
                <span class="text-fg-tertiary text-[10px] uppercase">Permission</span>
                <span class="font-medium"
                      [class]="d.permission === 'granted' ? 'text-emerald-400'
                        : d.permission === 'denied' ? 'text-red-400'
                        : 'text-amber-400'">
                  {{ d.permission }}
                </span>
              </div>
              <div class="bg-bg-tertiary rounded-lg px-3 py-2 flex flex-col gap-0.5">
                <span class="text-fg-tertiary text-[10px] uppercase">iOS</span>
                <span class="font-medium text-fg-primary">
                  {{ d.isIOS ? (d.iosVersion !== null ? d.iosVersion : 'oui') : 'non' }}
                </span>
              </div>
              <div class="bg-bg-tertiary rounded-lg px-3 py-2 flex flex-col gap-0.5">
                <span class="text-fg-tertiary text-[10px] uppercase">Standalone</span>
                <span class="font-medium"
                      [class]="d.isStandalone ? 'text-emerald-400' : (d.isIOS ? 'text-amber-400' : 'text-fg-secondary')">
                  {{ d.isStandalone ? 'oui (PWA)' : 'non' }}
                </span>
              </div>
            </div>

            <!-- Service Workers enregistres (utile pour diagnostiquer conflit ngsw vs /sw.js) -->
            @if (swRegs().length > 0) {
              <div class="border-t border-border-subtle pt-3 flex flex-col gap-1.5">
                <p class="text-xs uppercase text-fg-tertiary tracking-wide">Service Workers ({{ swRegs().length }})</p>
                @for (sw of swRegs(); track sw.scriptURL) {
                  <div class="flex items-center gap-2 text-[11px] bg-bg-tertiary rounded-lg px-2.5 py-1.5">
                    <span class="font-mono font-medium truncate flex-1"
                          [class]="sw.isController ? 'text-emerald-300' : 'text-fg-secondary'">
                      {{ sw.scriptURL.split('/').pop() }}
                    </span>
                    <span class="text-fg-tertiary font-mono shrink-0 hidden sm:inline">scope: {{ shortenScope(sw.scope) }}</span>
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0"
                          [class]="sw.state === 'active' ? 'bg-emerald-500/20 text-emerald-300'
                            : sw.state === 'waiting' ? 'bg-amber-500/20 text-amber-300'
                            : 'bg-sky-500/20 text-sky-300'">
                      {{ sw.state }}
                    </span>
                    @if (sw.isController) {
                      <span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/30 text-emerald-200 shrink-0">controller</span>
                    }
                  </div>
                }
                <p class="text-[10px] text-fg-tertiary mt-1">
                  Le SW <strong>controller</strong> reçoit les events push. Si c'est <code class="font-mono">ngsw-worker.js</code>, le payload est wrappé pour qu'il puisse l'afficher.
                </p>
              </div>
            }

            <details class="text-xs text-fg-tertiary">
              <summary class="cursor-pointer hover:text-fg-secondary">User-Agent complet</summary>
              <pre class="mt-2 font-mono text-[11px] bg-bg-tertiary rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">{{ d.userAgent }}</pre>
            </details>
          </div>
        }

        <!-- Statut subscription locale + activation -->
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                 [class]="notif.isSubscribed() ? 'bg-emerald-500/20 text-emerald-400' : 'bg-bg-tertiary text-fg-tertiary'">
              <lucide-icon [img]="notif.isSubscribed() ? BellRing : Bell" [size]="20"></lucide-icon>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-fg-primary">
                {{ notif.isSubscribed() ? 'Notifications activées sur ce navigateur' : 'Notifications non activées' }}
              </p>
              <p class="text-xs text-fg-tertiary mt-0.5">
                {{ notif.isSubscribed()
                    ? 'Tu peux recevoir des notifications push même app fermée.'
                    : 'Active les notifications sur ce device pour pouvoir tester.' }}
              </p>
            </div>
            @if (!notif.isSubscribed()) {
              <button
                (click)="onActivatePush()"
                [disabled]="testActivating() || notif.pushEnabled() === false || !notif.isPushSupported()"
                class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer
                       disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shrink-0"
              >
                <lucide-icon [img]="BellRing" [size]="14"></lucide-icon>
                {{ testActivating() ? '...' : 'Activer' }}
              </button>
            }
          </div>

          @if (!notif.isPushSupported()) {
            <p class="text-xs text-amber-300/80">
              Ce navigateur ne supporte pas le Web Push (Safari iOS hors PWA, anciens navigateurs).
            </p>
          }

          <!-- Liste des devices abonnes : email + UA + delete + checkbox de ciblage -->
          @if (notif.devices().length > 0) {
            <div class="border-t border-border-subtle pt-3 flex flex-col gap-2">
              <div class="flex items-center justify-between gap-3 flex-wrap">
                <p class="text-xs uppercase text-fg-tertiary tracking-wide">
                  Devices abonnés ({{ notif.devices().length }})
                </p>
                <!-- Toggle scope : mes subs vs toutes (SUPER_ADMIN) -->
                <div class="flex bg-bg-tertiary rounded-lg overflow-hidden text-[11px] font-medium">
                  <button
                    type="button"
                    (click)="onChangeDevicesScope('mine')"
                    [class]="devicesScope() === 'mine' ? 'bg-tracky text-white' : 'text-fg-secondary'"
                    class="px-3 py-1.5 cursor-pointer hover:text-fg-primary"
                  >Mes devices</button>
                  <button
                    type="button"
                    (click)="onChangeDevicesScope('all')"
                    [class]="devicesScope() === 'all' ? 'bg-tracky text-white' : 'text-fg-secondary'"
                    class="px-3 py-1.5 cursor-pointer hover:text-fg-primary"
                  >Tous les comptes</button>
                </div>
              </div>

              @if (devicesScope() === 'all') {
                <p class="text-[11px] text-amber-300/80 flex items-center gap-1.5">
                  <lucide-icon [img]="AlertTriangle" [size]="12"></lucide-icon>
                  Tu vois toutes les subscriptions de la base. Tu peux supprimer celles de comptes clients abonnés par erreur. Le test ne peut cibler que TES devices à toi.
                </p>
              }

              <div class="flex flex-col gap-1.5">
                @for (d of notif.devices(); track d.id) {
                  <div class="flex items-center gap-2 text-xs bg-bg-tertiary rounded-lg px-2.5 py-2"
                       [class.opacity-60]="!d.isMine">
                    <!-- Checkbox ciblage (uniquement pour MES subs — sinon le backend bloque) -->
                    @if (d.isMine) {
                      <input
                        type="checkbox"
                        [checked]="selectedSubIds().has(d.id)"
                        (change)="toggleSubSelection(d.id)"
                        class="shrink-0 w-4 h-4 accent-tracky cursor-pointer"
                        [title]="'Cibler ce device dans le prochain test'"
                      />
                    } @else {
                      <span class="shrink-0 w-4 h-4" title="Pas a toi — non ciblable"></span>
                    }

                    <lucide-icon [img]="Smartphone" [size]="14" class="shrink-0 opacity-60"></lucide-icon>

                    <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                      <!-- Ligne 1 : email + role badge -->
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="font-medium text-fg-primary truncate" [title]="d.userEmail ?? d.userId">
                          {{ d.userEmail ?? d.userId.slice(0, 8) + '…' }}
                        </span>
                        @if (d.userName) {
                          <span class="text-fg-tertiary truncate hidden sm:inline">{{ d.userName }}</span>
                        }
                        @if (d.userRole) {
                          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono uppercase shrink-0"
                                [class]="d.userRole === 'SUPER_ADMIN' ? 'bg-purple-500/20 text-purple-300'
                                  : d.userRole === 'FLEET_ADMIN' ? 'bg-sky-500/20 text-sky-300'
                                  : 'bg-bg-secondary text-fg-tertiary'">
                            {{ d.userRole }}
                          </span>
                        }
                        @if (d.isMine) {
                          <span class="text-[9px] px-1.5 py-0.5 rounded font-mono uppercase shrink-0 bg-emerald-500/20 text-emerald-300">
                            moi
                          </span>
                        }
                      </div>
                      <!-- Ligne 2 : UA tronque + host + last seen -->
                      <div class="flex items-center gap-2 text-[10px] text-fg-tertiary min-w-0">
                        <span class="truncate" [title]="d.userAgent ?? ''">
                          {{ d.userAgent ?? '—' }}
                        </span>
                      </div>
                      <div class="flex items-center gap-2 text-[10px] text-fg-tertiary">
                        <span class="font-mono">{{ d.endpointHost }}</span>
                        <span>·</span>
                        <span class="font-mono">{{ d.lastSeenAt | date:'dd/MM HH:mm' }}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      (click)="onDeleteDevice(d.id, d.userEmail ?? d.id)"
                      [disabled]="deletingDeviceId() === d.id"
                      class="shrink-0 p-1.5 rounded-md text-fg-tertiary hover:text-red-400 hover:bg-red-500/10 cursor-pointer disabled:opacity-50"
                      [title]="'Supprimer cette subscription'"
                    >
                      <lucide-icon [img]="Trash2" [size]="14"></lucide-icon>
                    </button>
                  </div>
                }
              </div>

              @if (selectedSubIds().size > 0) {
                <p class="text-[11px] text-emerald-300 flex items-center gap-1.5">
                  <lucide-icon [img]="Send" [size]="12"></lucide-icon>
                  {{ selectedSubIds().size }} device(s) sélectionné(s) pour le prochain test (au lieu de tous mes devices).
                </p>
              }
            </div>
          }
        </div>

        <!-- Formulaire de test -->
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-4">
          <div>
            <p class="text-sm font-medium text-fg-primary">Envoyer une notification de test</p>
            <p class="text-xs text-fg-tertiary mt-0.5">
              La notification sera envoyée à tous tes devices abonnés. Idéal pour vérifier le rendu Android Chrome PWA, iOS PWA, desktop.
            </p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="flex flex-col gap-1">
              <label class="text-xs text-fg-tertiary">Titre</label>
              <input
                [ngModel]="testTitle()"
                (ngModelChange)="testTitle.set($event)"
                placeholder="Test Tracky"
                maxlength="80"
                class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary"
              />
            </div>
            <div class="flex flex-col gap-1">
              <label class="text-xs text-fg-tertiary">Sévérité</label>
              <select
                [ngModel]="testSeverity()"
                (ngModelChange)="testSeverity.set($event)"
                class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary"
              >
                <option value="INFO">INFO</option>
                <option value="WARNING">WARNING</option>
                <option value="CRITICAL">CRITICAL (requireInteraction + vibration)</option>
              </select>
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Corps</label>
            <textarea
              [ngModel]="testBody()"
              (ngModelChange)="testBody.set($event)"
              placeholder="Ceci est une notification de test."
              rows="2"
              maxlength="200"
              class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary resize-none"
            ></textarea>
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Délai d'envoi</label>
            <div class="flex flex-wrap gap-2">
              @for (opt of delayOptions; track opt.v) {
                <button
                  type="button"
                  (click)="testDelayMs.set(opt.v)"
                  class="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer"
                  [class]="testDelayMs() === opt.v
                    ? 'bg-tracky text-white border-tracky'
                    : 'bg-bg-tertiary border-border-subtle text-fg-secondary hover:text-fg-primary'"
                >
                  {{ opt.l }}
                </button>
              }
            </div>
            <p class="text-[11px] text-fg-tertiary mt-1">
              Le délai 5/30s te laisse le temps de fermer l'app (ou verrouiller le téléphone) pour vérifier le rendu en background.
            </p>
          </div>

          <div class="flex items-center gap-3 pt-1">
            <button
              (click)="onSendTest()"
              [disabled]="testSending() || !notif.isSubscribed() || notif.pushEnabled() === false"
              class="px-4 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer
                     disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <lucide-icon [img]="Send" [size]="14"></lucide-icon>
              {{ testSending() ? 'Envoi...' : 'Envoyer le test' }}
            </button>
            @if (testLastResult(); as r) {
              <div class="text-xs flex items-center gap-1.5 flex-1 min-w-0"
                   [class]="r.ok ? 'text-emerald-400' : 'text-red-400'">
                <span class="font-mono text-fg-tertiary">{{ r.at }}</span>
                <span class="truncate">{{ r.message }}</span>
              </div>
            }
          </div>

          <!-- Detail des reponses Apple/Mozilla/Google par device -->
          @if (testLastResult()?.results?.length) {
            <div class="border-t border-border-subtle pt-3 flex flex-col gap-1.5">
              <p class="text-xs uppercase text-fg-tertiary tracking-wide">Detail par device</p>
              @for (r of testLastResult()!.results!; track r.id) {
                <div class="flex items-center gap-2 text-xs bg-bg-tertiary rounded-lg px-2.5 py-1.5">
                  <!-- Status code colore : 201 = OK Apple/Google, 410/404 = sub expiree (purgee), 403 = VAPID, 413 = payload trop gros -->
                  <span class="font-mono font-bold shrink-0 w-12 text-center"
                        [class]="r.statusCode === 201 ? 'text-emerald-400'
                          : r.statusCode === 410 || r.statusCode === 404 ? 'text-amber-400'
                          : r.statusCode ? 'text-red-400'
                          : 'text-fg-tertiary'">
                    {{ r.statusCode ?? '—' }}
                  </span>
                  <span class="font-mono text-fg-secondary truncate flex-1" [title]="r.endpointHost">
                    {{ r.endpointHost }}
                  </span>
                  @if (r.error) {
                    <span class="text-red-300/80 text-[10px] truncate" [title]="r.error">{{ r.error }}</span>
                  }
                </div>
              }
              <p class="text-[10px] text-fg-tertiary mt-1">
                201 = livré au gateway · 410/404 = subscription expirée (purgée) · 403 = problème VAPID · 413 = payload trop gros
              </p>
            </div>
          }
        </div>
      }

      <!-- Test SMS Fallback Tab -->
      @if (activeTab() === 'test-sms') {
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4 flex flex-col gap-3">
          <div class="flex items-center gap-2 text-sm font-semibold">
            <lucide-icon [img]="MessageSquare" [size]="16" class="text-tracky-light"></lucide-icon>
            Tester le fallback SMS (bypass conditions tracker)
          </div>
          <p class="text-xs text-fg-tertiary">
            Envoie une commande Coban benigne <code class="font-mono">fix030s***n123456</code> au numero
            destinataire en utilisant la gateway SMS — sans verifier que le tracker est offline ou que
            sa SIM est configuree. Sert a valider la chaine SMS + audit.
          </p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select [(ngModel)]="fbTrackerId"
                    class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm">
              <option value="">Selectionner un tracker...</option>
              @for (t of smsTrackers(); track t.id) {
                <option [value]="t.id">{{ t.imei }} — {{ t.plate ?? 'sans plaque' }}</option>
              }
            </select>
            <input [(ngModel)]="fbPhone" placeholder="+33612345678 (ton numero)"
                   class="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
          <button (click)="testFallback()" [disabled]="!fbTrackerId || !fbPhone || fbSending()"
                  class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer disabled:opacity-50 self-start flex items-center gap-2">
            <lucide-icon [img]="Send" [size]="14"></lucide-icon>
            {{ fbSending() ? 'Envoi en cours...' : 'Envoyer test fallback' }}
          </button>
          @if (fbResult(); as r) {
            <div class="text-xs font-mono rounded p-2 border"
                 [class]="r.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-300'">
              {{ r.ok ? 'OK' : 'KO' }} — payload <code>{{ r.payload }}</code> envoye au tracker
              IMEI <code>{{ r.trackerImei }}</code>
              @if (r.smsResult.twilioSid) { · sid <code>{{ r.smsResult.twilioSid }}</code> }
              @if (r.smsResult.error) { · erreur : {{ r.smsResult.error }} }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class ObservabilityComponent implements OnInit {
  private readonly logsApi = inject(AdminLogsService);
  private readonly smsApi = inject(AdminSmsService);
  private readonly http = inject(HttpClient);
  protected readonly notif = inject(NotificationsApiService);
  private readonly toast = inject(ToastService);

  protected readonly Activity = Activity;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly MessageSquare = MessageSquare;
  protected readonly Search = Search;
  protected readonly RefreshCw = RefreshCw;
  protected readonly ArrowUpRight = ArrowUpRight;
  protected readonly ArrowDownLeft = ArrowDownLeft;
  protected readonly Clock = Clock;
  protected readonly Terminal = Terminal;
  protected readonly Bell = Bell;
  protected readonly BellRing = BellRing;
  protected readonly Send = Send;
  protected readonly Smartphone = Smartphone;
  protected readonly Trash2 = Trash2;
  protected readonly UserIcon = UserIcon;
  protected readonly Globe = Globe;

  protected readonly tabs = [
    { key: 'wire' as const, label: 'Wire Logs' },
    { key: 'timeline' as const, label: 'Timeline' },
    { key: 'test-push' as const, label: 'Test Notification' },
    { key: 'test-sms' as const, label: 'Test SMS Fallback' },
  ];

  protected readonly delayOptions: { v: number; l: string }[] = [
    { v: 0, l: 'Immédiat' },
    { v: 5000, l: 'Dans 5s' },
    { v: 30000, l: 'Dans 30s' },
  ];

  protected readonly activeTab = signal<'wire' | 'timeline' | 'test-push' | 'test-sms'>('wire');
  protected readonly wireLogs = signal<WireLogDto[]>([]);
  protected readonly wireTotal = signal(0);
  protected readonly timelineEntries = signal<TimelineEntry[]>([]);

  protected readonly wireImeiFilter = signal('');
  protected readonly wireDirectionFilter = signal('');
  protected readonly timelineImei = signal('');

  // Test Notification — formulaire SUPER_ADMIN.
  protected readonly testTitle = signal('Test Tracky');
  protected readonly testBody = signal('Ceci est une notification de test.');
  protected readonly testSeverity = signal<'INFO' | 'WARNING' | 'CRITICAL'>('INFO');
  protected readonly testDelayMs = signal<number>(5000);
  protected readonly testSending = signal(false);
  protected readonly testActivating = signal(false);
  protected readonly testLastResult = signal<{
    ok: boolean;
    message: string;
    at: string;
    results?: TestPushResultEntry[];
  } | null>(null);
  // Diagnostic env (iOS/standalone/permission/UA) — calcule a chaque entree
  // dans l'onglet pour refleter un eventuel changement de mode (ex: app
  // ajoutee a l'ecran d'accueil entre-temps).
  protected readonly diagnostic = signal<ReturnType<NotificationsApiService['pushSupportDiagnostic']> | null>(null);
  // Liste des SW enregistres : utile pour diagnostiquer conflit ngsw vs /sw.js
  protected readonly swRegs = signal<Awaited<ReturnType<NotificationsApiService['swRegistrations']>>>([]);
  // Scope de la liste devices : 'mine' = mes subscriptions seulement,
  // 'all' = toutes les subs (SUPER_ADMIN uniquement, pour voir qui est abonne
  // et purger les comptes clients abonnes par erreur).
  protected readonly devicesScope = signal<'mine' | 'all'>('mine');
  // IDs des subscriptions selectionnees pour cibler le test. Vide = envoyer
  // a toutes mes subs (defaut).
  protected readonly selectedSubIds = signal<Set<string>>(new Set());
  protected readonly deletingDeviceId = signal<string | null>(null);

  // ─── Test SMS Fallback ────────────────────────────────────
  protected readonly smsTrackers = signal<
    { id: string; imei: string; plate: string | null }[]
  >([]);
  protected fbTrackerId = '';
  protected fbPhone = '';
  protected readonly fbSending = signal(false);
  protected readonly fbResult = signal<SmsTestFallbackResult | null>(null);

  async ngOnInit(): Promise<void> {
    await this.loadWireLogs();
  }

  protected async loadWireLogs(): Promise<void> {
    try {
      const params: Record<string, string> = { limit: '100' };
      const imei = this.wireImeiFilter();
      const dir = this.wireDirectionFilter();
      if (imei) params['imei'] = imei;
      if (dir) params['direction'] = dir;
      const res = await firstValueFrom(this.logsApi.listWireLogs(params));
      this.wireLogs.set(res.items);
      this.wireTotal.set(res.total);
    } catch {
      this.toast.error('Erreur de chargement des wire logs');
    }
  }

  protected async loadTimeline(): Promise<void> {
    const imei = this.timelineImei();
    if (!imei) return;
    try {
      const res = await firstValueFrom(this.logsApi.trackerTimeline(imei));
      this.timelineEntries.set(res.items);
    } catch {
      this.toast.error('Erreur de chargement de la timeline');
    }
  }

  /**
   * Routeur d'onglet — change l'onglet actif et hydrate ses donnees a la demande
   * pour les onglets qui le requierent (Test Notification charge le statut push
   * + la liste des devices abonnes).
   */
  protected onSelectTab(key: 'wire' | 'timeline' | 'test-push' | 'test-sms'): void {
    this.activeTab.set(key);
    if (key === 'test-push') {
      void this.loadTestPushData();
    }
    if (key === 'test-sms') {
      void this.loadTrackers();
    }
  }

  // ─── Test Notification ──────────────────────────────────────

  private async loadTestPushData(): Promise<void> {
    this.diagnostic.set(this.notif.pushSupportDiagnostic());
    // Snapshot SW (en parallele du loadStatus, c'est independant).
    void this.notif.swRegistrations().then((regs) => this.swRegs.set(regs)).catch(() => {/* silencieux */});
    await this.notif.loadStatus().catch(() => {/* silencieux */});
    // Charge directement les devices selon le scope choisi (SUPER_ADMIN voit
    // 'all' par defaut une fois bascule). Ne pas conditionner sur isSubscribed :
    // un SUPER_ADMIN peut vouloir voir/purger les subs des clients meme s'il
    // n'a pas active push sur ce device-ci.
    await this.notif.listDevices(this.devicesScope()).catch(() => {/* silencieux */});
  }

  protected async onChangeDevicesScope(scope: 'mine' | 'all'): Promise<void> {
    this.devicesScope.set(scope);
    // Reset la selection : les ids changent quand on switch de scope.
    this.selectedSubIds.set(new Set());
    await this.notif.listDevices(scope).catch(() => {/* silencieux */});
  }

  protected toggleSubSelection(id: string): void {
    const next = new Set(this.selectedSubIds());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selectedSubIds.set(next);
  }

  /** Affiche le scope SW sans l'origine pour gagner de la place dans l'UI. */
  protected shortenScope(scope: string): string {
    try {
      const u = new URL(scope);
      return u.pathname || '/';
    } catch {
      return scope || '/';
    }
  }

  protected async onDeleteDevice(id: string, label: string): Promise<void> {
    if (this.deletingDeviceId()) return;
    const ok = window.confirm(`Supprimer cette subscription ?\n\n${label}\n\nLe device cessera de recevoir les notifications jusqu'a une nouvelle activation.`);
    if (!ok) return;
    this.deletingDeviceId.set(id);
    try {
      await this.notif.deleteDevice(id);
      // Retire l'id de la selection s'il etait coche.
      const sel = new Set(this.selectedSubIds());
      sel.delete(id);
      this.selectedSubIds.set(sel);
      this.toast.success('Subscription supprimee');
    } catch {
      this.toast.error('Suppression echouee');
    } finally {
      this.deletingDeviceId.set(null);
    }
  }

  protected async onActivatePush(): Promise<void> {
    this.testActivating.set(true);
    try {
      const res = await this.notif.subscribePush();
      if (res.ok) {
        this.toast.success('Notifications activees sur ce device');
        await this.notif.listDevices().catch(() => {/* silencieux */});
      } else {
        this.toast.error(res.reason ?? 'Echec de l\'activation');
      }
    } finally {
      this.testActivating.set(false);
    }
  }

  protected async onSendTest(): Promise<void> {
    if (this.testSending()) return;
    this.testSending.set(true);
    try {
      // Si selection non-vide : envoyer uniquement aux subs cochees. Sinon
      // (defaut) : envoyer a toutes mes subs. Securite : backend filtrera
      // pour ne garder que les subs du user courant.
      const selected = Array.from(this.selectedSubIds());
      const res = await this.notif.sendTestPush({
        title: this.testTitle().trim() || undefined,
        body: this.testBody().trim() || undefined,
        severity: this.testSeverity(),
        delayMs: this.testDelayMs(),
        subscriptionIds: selected.length > 0 ? selected : undefined,
      });
      const at = new Date().toLocaleTimeString('fr-FR');
      if (res.scheduled) {
        const sec = Math.round(res.delayMs / 1000);
        this.testLastResult.set({
          ok: true,
          message: `Notification programmee dans ${sec}s vers ${res.targetDevices} device(s). Les statuts par push apparaitront ici lors de l'envoi immediat.`,
          at,
        });
        this.toast.success('Notification programmee', `Verifie ton device dans ~${sec}s`);
      } else {
        const sentCount = res.sent ?? 0;
        const failedCount = res.failed ?? 0;
        // ok = vrai uniquement si AU MOINS 1 envoi reussi. failed > 0 sur 1 seul
        // device = echec total.
        const ok = sentCount > 0 && failedCount === 0;
        this.testLastResult.set({
          ok,
          message: `Envoye immediatement : ${sentCount}/${res.targetDevices} livre(s)${failedCount ? `, ${failedCount} echec(s)` : ''}.`,
          at,
          results: res.results,
        });
        if (ok) this.toast.success('Notification envoyee');
        else this.toast.error('Echec d\'envoi', 'Voir le detail par device ci-dessous.');
      }
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const apiMsg = (err as { error?: { message?: string } }).error?.message;
      const message = apiMsg ?? (status === 400 ? 'Aucun device abonne — clique sur Activer d\'abord.' : 'Echec de l\'envoi.');
      this.testLastResult.set({
        ok: false,
        message,
        at: new Date().toLocaleTimeString('fr-FR'),
      });
      this.toast.error(message);
    } finally {
      this.testSending.set(false);
    }
  }

  // ─── Test SMS Fallback ──────────────────────────────────────

  private async loadTrackers(): Promise<void> {
    try {
      const list = await firstValueFrom(
        this.http.get<
          Array<{
            id: string;
            imei: string;
            vehicle?: { plate?: string | null } | null;
          }>
        >('/api/trackers'),
      );
      this.smsTrackers.set(
        list.map((t) => ({ id: t.id, imei: t.imei, plate: t.vehicle?.plate ?? null })),
      );
    } catch {
      /* silencieux */
    }
  }

  protected async testFallback(): Promise<void> {
    if (!this.fbTrackerId || !this.fbPhone) return;
    this.fbSending.set(true);
    this.fbResult.set(null);
    try {
      const r = await firstValueFrom(this.smsApi.testFallback(this.fbTrackerId, this.fbPhone));
      this.fbResult.set(r);
      if (r.ok) {
        this.toast.success(`Test fallback OK — payload envoye au ${this.fbPhone}`);
      } else {
        this.toast.error(`Test fallback KO : ${r.smsResult.error ?? 'erreur inconnue'}`);
      }
    } catch (e) {
      const msg = (e as { error?: { error?: { message?: string } } })?.error?.error?.message
        ?? (e as Error).message
        ?? 'Echec inconnu';
      this.toast.error(`Test fallback : ${msg}`);
    } finally {
      this.fbSending.set(false);
    }
  }
}
