import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  ActivityFeedItemDto,
  ActivityStatsDto,
  AudioCommandAuditDto,
  EngineCommandAuditDto,
  OnlineUserDto,
  PresenceStatus,
  SystemActivityDto,
} from '@vizyo/tracky-shared';
import { SYSTEM_ACTIVITY_CATEGORY_LABELS } from '@vizyo/tracky-shared';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Ear,
  LogIn,
  LogOut,
  LucideAngularModule,
  MapPin,
  Moon,
  MousePointer2,
  MoveVertical,
  Bell,
  Building2,
  CreditCard,
  Cpu,
  Download,
  Mail,
  MessageSquare,
  Pencil,
  Server,
  ShieldAlert,
  ShieldOff,
  Sparkles,
  Trash2,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Send,
  Users,
  CalendarClock,
} from 'lucide-angular';
import { AudioMonitoringService } from '../../core/services/audio-monitoring.service';
import { UsersApiService } from '../../core/services/users.service';
import { relativeTime } from '../../shared/utils/relative-time';
import { UserActivityApiService } from './user-activity-api.service';
import { ActivityReportsComponent } from './activity-reports.component';

type Tab = 'live' | 'history' | 'reports' | 'analytics' | 'engine-commands' | 'audio-listens' | 'system';
type Period = '24h' | '7d' | '30d';

@Component({
  selector: 'app-admin-activity',
  standalone: true,
  imports: [DatePipe, NgTemplateOutlet, FormsModule, RouterLink, LucideAngularModule, ActivityReportsComponent],
  template: `
    <div class="flex flex-col gap-5">
      <!-- Header -->
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <a routerLink="/admin"
             class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
            <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon> Administration
          </a>
          <h1 class="text-2xl font-display font-bold text-fg-primary">Activité utilisateurs</h1>
          <p class="text-sm text-fg-tertiary">Qui est en ligne, sur quelle page, et ce que font les utilisateurs.</p>
        </div>
        <button (click)="reload()"
                class="px-3 py-2 bg-tracky text-white rounded-lg text-sm font-medium hover:bg-tracky-dark cursor-pointer flex items-center gap-2">
          <lucide-icon [img]="RefreshCw" [size]="14"></lucide-icon> Rafraichir
        </button>
      </div>

      <!-- Tabs (défilables horizontalement sur mobile — même pattern que véhicule détail / admin-sms) -->
      <div class="flex items-center gap-1 border-b border-border-subtle overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        @for (t of tabs; track t.id) {
          <button (click)="setTab(t.id)"
                  [attr.data-track]="'Onglet ' + t.label"
                  class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors shrink-0 whitespace-nowrap"
                  [class]="t.id === tab()
                    ? 'border-tracky text-fg-primary'
                    : 'border-transparent text-fg-tertiary hover:text-fg-secondary'">
            {{ t.label }}
            @if (t.id === 'live') {
              <span class="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">{{ visibleOnline().length }}</span>
            }
          </button>
        }
      </div>

      <!-- Filtre multi-utilisateurs (le compte owner est décoché par défaut) — partagé Live + Historique. -->
      <ng-template #userFilter>
        <details class="relative">
          <summary class="list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none inline-flex items-center gap-2 bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary hover:border-tracky">
            <lucide-icon [img]="Users" [size]="14" class="text-fg-tertiary"></lucide-icon>
            Utilisateurs
            <span class="text-xs text-fg-tertiary tabular-nums">{{ shownUserCount() }}/{{ filterUsers().length }}</span>
          </summary>
          <div class="absolute right-0 z-30 mt-1 w-64 max-h-72 overflow-y-auto bg-bg-secondary border border-border-subtle rounded-lg shadow-xl p-2 flex flex-col gap-0.5">
            <div class="flex gap-3 px-1 pb-2 mb-1 border-b border-border-subtle/50">
              <button type="button" (click)="selectAllUsers()" class="text-xs text-tracky-light hover:underline">Tout cocher</button>
              <button type="button" (click)="clearUsers()" class="text-xs text-fg-tertiary hover:underline">Tout décocher</button>
            </div>
            @for (u of filterUsers(); track u.id) {
              <label class="flex items-center gap-2 px-1.5 py-1.5 rounded-md hover:bg-bg-tertiary/50 cursor-pointer text-sm">
                <input type="checkbox" [checked]="isUserShown(u.id)" (change)="toggleUser(u.id)" class="accent-[var(--color-tracky,#10E0A0)] shrink-0">
                <span class="truncate text-fg-secondary">{{ u.name }}</span>
              </label>
            } @empty {
              <p class="text-xs text-fg-tertiary px-1.5 py-2">Chargement…</p>
            }
          </div>
        </details>
      </ng-template>

      <!-- ─────────── LIVE ─────────── -->
      @if (tab() === 'live') {
        <div class="flex items-center justify-end mb-3">
          <ng-container [ngTemplateOutlet]="userFilter"></ng-container>
        </div>
        <div class="grid lg:grid-cols-2 gap-4">
          <!-- Online users -->
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="flex items-center gap-2 mb-3">
              <lucide-icon [img]="Users" [size]="16" class="text-tracky-light"></lucide-icon>
              <span class="text-sm font-medium text-fg-secondary">En ligne maintenant ({{ visibleOnline().length }})</span>
              <span class="ml-auto inline-block w-2 h-2 rounded-full bg-rose-400 animate-pulse"></span>
            </div>
            <div class="flex flex-col gap-2">
              @for (u of visibleOnline(); track u.userId) {
                <div class="flex items-center gap-3 p-2.5 rounded-lg bg-bg-tertiary/40 border border-border-subtle/60">
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" [style.background]="statusColor(u.status)"
                        [title]="statusLabel(u.status)"></span>
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-fg-primary truncate flex items-center gap-1.5">
                      {{ u.name }}
                      <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-bg-tertiary text-fg-tertiary uppercase tracking-wide">{{ u.role }}</span>
                    </div>
                    <div class="text-xs text-fg-tertiary truncate flex items-center gap-1">
                      <lucide-icon [img]="MapPin" [size]="11" class="shrink-0"></lucide-icon>
                      {{ u.currentRouteLabel ?? u.currentRoute ?? '—' }}
                      · {{ statusLabel(u.status) }}
                    </div>
                  </div>
                  <div class="text-right shrink-0">
                    <div class="text-[11px] text-fg-secondary">{{ fmtDur(u.sinceMs) }}</div>
                    <div class="text-[10px] text-fg-tertiary">{{ u.deviceType ?? '' }}</div>
                  </div>
                </div>
              } @empty {
                <p class="text-sm text-fg-tertiary text-center py-6">Personne en ligne actuellement.</p>
              }
            </div>
          </div>

          <!-- Live feed -->
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="text-sm font-medium text-fg-secondary mb-3">Flux en direct</div>
            <div class="flex flex-col gap-1 max-h-[420px] overflow-y-auto">
              @for (a of visibleFeed(); track a.id) {
                <div class="flex items-center gap-2 text-xs py-1 px-1.5 rounded-md hover:bg-bg-tertiary/40">
                  <span class="text-fg-tertiary tabular-nums shrink-0 font-mono">{{ a.at | date: 'HH:mm:ss' }}</span>
                  <lucide-icon [img]="typeIcon(a.type)" [size]="13" class="text-fg-tertiary shrink-0"></lucide-icon>
                  <span class="font-medium text-fg-secondary shrink-0">{{ a.userName }}</span>
                  <span class="text-fg-tertiary truncate">{{ describe(a) }}</span>
                </div>
              } @empty {
                <p class="text-sm text-fg-tertiary text-center py-6">Aucune activité pour l'instant.</p>
              }
            </div>
          </div>
        </div>
      }

      <!-- ─────────── HISTORIQUE ─────────── -->
      @if (tab() === 'history') {
        <!-- Filtres : « qu'a fait l'utilisateur X ? » / « tous les exports » … -->
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Utilisateurs</label>
            <ng-container [ngTemplateOutlet]="userFilter"></ng-container>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Type</label>
            <select [ngModel]="historyType()" (ngModelChange)="setHistoryType($event)"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option value="">Tous</option>
              <option value="PAGE_VIEW">Pages vues</option>
              <option value="CLICK">Clics</option>
              <option value="FORM_SUBMIT">Formulaires</option>
              <option value="SCROLL">Défilements</option>
              <option value="SESSION_START">Connexions</option>
              <option value="SESSION_END">Déconnexions</option>
            </select>
          </div>
        </div>
        <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
          <div class="flex flex-col">
            @for (a of visibleHistory(); track a.id) {
              <div class="flex items-center gap-2 text-xs py-1.5 px-1.5 rounded-md border-b border-border-subtle/30 hover:bg-bg-tertiary/40">
                <span class="text-fg-tertiary tabular-nums shrink-0 w-[112px] font-mono">{{ a.at | date: 'dd/MM HH:mm:ss' }}</span>
                <lucide-icon [img]="typeIcon(a.type)" [size]="13" class="text-fg-tertiary shrink-0"></lucide-icon>
                <span class="font-medium text-fg-secondary shrink-0">{{ a.userName }}</span>
                <span class="text-fg-tertiary truncate">{{ describe(a) }}</span>
              </div>
            } @empty {
              <p class="text-sm text-fg-tertiary text-center py-6">Aucun historique.</p>
            }
          </div>
          @if (visibleHistory().length > 0) {
            <button (click)="loadMore()" [disabled]="loadingMore()"
                    class="mt-3 w-full py-2 text-sm text-fg-secondary border border-border-subtle rounded-lg hover:border-tracky disabled:opacity-50">
              {{ loadingMore() ? 'Chargement…' : 'Charger plus' }}
            </button>
          }
        </div>
      }

      <!-- ─────────── RAPPORTS IA ─────────── -->
      @if (tab() === 'reports') {
        <app-activity-reports />
      }

      <!-- ─────────── ANALYTICS ─────────── -->
      @if (tab() === 'analytics') {
        <div class="flex items-center gap-1">
          @for (p of periods; track p.id) {
            <button (click)="setPeriod(p.id)"
                    class="px-2.5 py-1 text-xs rounded-md border"
                    [class]="p.id === period()
                      ? 'bg-tracky text-white border-tracky'
                      : 'bg-bg-tertiary text-fg-secondary border-border-subtle hover:border-tracky'">
              {{ p.label }}
            </button>
          }
        </div>

        @if (stats(); as s) {
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div class="p-4 rounded-[--radius-card] bg-bg-secondary border border-border-subtle">
              <div class="text-xs uppercase text-fg-tertiary">Utilisateurs</div>
              <div class="text-2xl font-display font-bold text-fg-primary">{{ s.uniqueUsers }}</div>
            </div>
            <div class="p-4 rounded-[--radius-card] bg-bg-secondary border border-border-subtle">
              <div class="text-xs uppercase text-fg-tertiary">Sessions</div>
              <div class="text-2xl font-display font-bold text-fg-primary">{{ s.totalSessions }}</div>
            </div>
            <div class="p-4 rounded-[--radius-card] bg-bg-secondary border border-border-subtle">
              <div class="text-xs uppercase text-fg-tertiary">Pages vues</div>
              <div class="text-2xl font-display font-bold text-fg-primary">{{ s.totalPageViews }}</div>
            </div>
            <div class="p-4 rounded-[--radius-card] bg-bg-secondary border border-border-subtle">
              <div class="text-xs uppercase text-fg-tertiary">Durée moy. session</div>
              <div class="text-2xl font-display font-bold text-fg-primary">{{ fmtSec(s.avgSessionSec) }}</div>
            </div>
          </div>

          <div class="grid lg:grid-cols-2 gap-4">
            <!-- Top pages -->
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
              <div class="text-sm font-medium text-fg-secondary mb-3">Pages les plus visitées</div>
              <div class="flex flex-col gap-2">
                @for (p of s.topPages; track p.route) {
                  <div>
                    <div class="flex items-center justify-between text-xs mb-0.5">
                      <span class="text-fg-secondary truncate">{{ p.label }}</span>
                      <span class="text-fg-tertiary shrink-0 ml-2">{{ p.views }} · {{ fmtMs(p.avgDurationMs) }}</span>
                    </div>
                    <div class="h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                      <div class="h-full bg-tracky-light rounded-full" [style.width.%]="barPct(p.views, s.topPages[0].views)"></div>
                    </div>
                  </div>
                } @empty {
                  <p class="text-sm text-fg-tertiary py-4 text-center">Pas encore de données.</p>
                }
              </div>
            </div>

            <!-- Top clicks -->
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
              <div class="text-sm font-medium text-fg-secondary mb-3">Clics les plus fréquents</div>
              <div class="flex flex-col gap-1.5">
                @for (c of s.topClicks; track c.target; let i = $index) {
                  <div class="flex items-center justify-between text-xs">
                    <span class="text-fg-secondary truncate">{{ i + 1 }}. {{ c.target }}</span>
                    <span class="text-fg-tertiary shrink-0 ml-2 tabular-nums">{{ c.count }}×</span>
                  </div>
                } @empty {
                  <p class="text-sm text-fg-tertiary py-4 text-center">Aucun clic sur la période.</p>
                }
              </div>
            </div>
          </div>

          <div class="grid lg:grid-cols-2 gap-4">
            <!-- Événements par type -->
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
              <div class="text-sm font-medium text-fg-secondary mb-3">Événements par type</div>
              <div class="flex flex-wrap gap-2">
                @for (e of s.eventsByType; track e.type) {
                  <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg-tertiary text-xs">
                    <lucide-icon [img]="typeIcon($any(e.type))" [size]="12" class="text-fg-tertiary"></lucide-icon>
                    <span class="text-fg-secondary">{{ eventTypeLabel(e.type) }}</span>
                    <span class="text-fg-primary font-semibold tabular-nums">{{ e.count }}</span>
                  </span>
                } @empty {
                  <p class="text-sm text-fg-tertiary py-4 text-center w-full">Pas encore de données.</p>
                }
              </div>
            </div>

            <!-- Formulaires les plus soumis -->
            <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
              <div class="text-sm font-medium text-fg-secondary mb-3">Formulaires les plus soumis</div>
              <div class="flex flex-col gap-1.5">
                @for (f of s.topForms; track f.target; let i = $index) {
                  <div class="flex items-center justify-between text-xs">
                    <span class="text-fg-secondary truncate">{{ i + 1 }}. {{ f.target }}</span>
                    <span class="text-fg-tertiary shrink-0 ml-2 tabular-nums">{{ f.count }}×</span>
                  </div>
                } @empty {
                  <p class="text-sm text-fg-tertiary py-4 text-center">Aucun formulaire soumis sur la période.</p>
                }
              </div>
            </div>
          </div>

          <!-- Sessions / day -->
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-4">
            <div class="text-sm font-medium text-fg-secondary mb-3">Sessions par jour</div>
            <div class="flex items-end gap-1.5 h-28">
              @for (d of s.sessionsPerDay; track d.date) {
                <div class="flex-1 flex flex-col items-center gap-1 min-w-0">
                  <div class="w-full bg-tracky-light/70 rounded-t" [style.height.%]="barPct(d.count, maxSessions())"
                       [title]="d.count + ' sessions'"></div>
                  <span class="text-[9px] text-fg-tertiary truncate w-full text-center">{{ d.date | date: 'dd/MM' }}</span>
                </div>
              } @empty {
                <p class="text-sm text-fg-tertiary w-full text-center self-center">Pas encore de données.</p>
              }
            </div>
          </div>
        } @else {
          <p class="text-sm text-fg-tertiary text-center py-6">Chargement…</p>
        }
      }

      <!-- ─────────── COMMANDES MOTEUR ─────────── -->
      @if (tab() === 'engine-commands') {
        <!-- Filters -->
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Action</label>
            <select [ngModel]="actionFilter()" (ngModelChange)="setActionFilter($event)"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option value="">Toutes</option>
              <option value="CUT">Coupure</option>
              <option value="RESTORE">Redémarrage</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Statut</label>
            <select [ngModel]="statusFilter()" (ngModelChange)="setStatusFilter($event)"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option value="">Tous</option>
              <option value="ACKNOWLEDGED">Confirmé</option>
              <option value="SENT">Envoyé</option>
              <option value="PENDING">En attente</option>
              <option value="FAILED">Échec</option>
              <option value="REJECTED_SPEED">Refusé (vitesse)</option>
            </select>
          </div>
        </div>

        @if (enginecmds().length > 0) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
            <table class="w-full text-sm">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase tracking-wide">
                <tr>
                  <th class="px-4 py-3 text-left font-medium">Quand</th>
                  <th class="px-4 py-3 text-left font-medium">Véhicule</th>
                  <th class="px-4 py-3 text-left font-medium">Action</th>
                  <th class="px-4 py-3 text-left font-medium">Par</th>
                  <th class="px-4 py-3 text-left font-medium">Statut</th>
                  <th class="px-4 py-3 text-left font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                @for (c of enginecmds(); track c.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/40 align-top">
                    <!-- Quand -->
                    <td class="px-4 py-3 text-fg-tertiary whitespace-nowrap" [title]="(c.createdAt | date: 'dd/MM/yyyy HH:mm:ss') ?? ''">
                      {{ relativeTime(c.createdAt) }}
                    </td>
                    <!-- Véhicule -->
                    <td class="px-4 py-3">
                      <span class="font-mono text-fg-primary">{{ c.vehiclePlate ?? c.trackerImei }}</span>
                      @if (!c.vehiclePlate) {
                        <span class="block text-[10px] text-fg-tertiary">IMEI</span>
                      }
                    </td>
                    <!-- Action -->
                    <td class="px-4 py-3">
                      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full"
                            [class]="c.action === 'CUT' ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'">
                        <lucide-icon [img]="c.action === 'CUT' ? PowerOff : Power" [size]="12"></lucide-icon>
                        {{ c.action === 'CUT' ? 'Coupé' : 'Redémarré' }}
                      </span>
                    </td>
                    <!-- Par -->
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="text-fg-secondary">{{ c.requestedByName }}</span>
                        @if (c.requestedByRole) {
                          <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-bg-tertiary text-fg-tertiary uppercase tracking-wide">{{ c.requestedByRole }}</span>
                        }
                      </div>
                    </td>
                    <!-- Statut -->
                    <td class="px-4 py-3">
                      <span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full" [class]="statusClass(c.status)">
                        {{ cmdStatusLabel(c.status) }}
                      </span>
                      @if (c.reason || c.lastError) {
                        <span class="block text-[11px] text-fg-tertiary mt-1 max-w-[260px] truncate"
                              [title]="c.lastError ?? c.reason ?? ''">
                          {{ c.lastError ?? c.reason }}
                        </span>
                      }
                    </td>
                    <!-- Source -->
                    <td class="px-4 py-3">
                      <span class="inline-block px-2 py-0.5 text-xs rounded-md bg-bg-tertiary text-fg-tertiary">
                        {{ sourceLabel(c.source) }}
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <button (click)="loadMoreEngine()" [disabled]="loadingMore()"
                  class="w-full py-2 text-sm text-fg-secondary border border-border-subtle rounded-lg hover:border-tracky disabled:opacity-50">
            {{ loadingMore() ? 'Chargement…' : 'Charger plus' }}
          </button>
        } @else {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
            <lucide-icon [img]="PowerOff" [size]="40" class="opacity-30"></lucide-icon>
            <p class="text-sm">Aucune commande moteur.</p>
          </div>
        }
      }

      <!-- ─────────── SYSTÈME (actions auto / arrière-plan) ─────────── -->
      @if (tab() === 'system') {
        <!-- Ces lignes sont AUTO/système (pas des actions manuelles utilisateur). -->
        <div class="flex items-start gap-2 text-xs text-fg-tertiary bg-bg-secondary border border-border-subtle rounded-[--radius-card] px-3 py-2.5">
          <lucide-icon [img]="Server" [size]="14" class="text-tracky-light shrink-0 mt-0.5"></lucide-icon>
          <span>
            Actions <strong class="text-fg-secondary">automatiques / en arrière-plan</strong> de l'application :
            e-mails, SMS, notifications push, commandes moteur, purges de rétention, rapports IA planifiés.
            Distinct de l'activité <em>manuelle</em> des utilisateurs (onglets Live / Historique).
          </span>
        </div>

        <!-- Filtre par catégorie -->
        <div class="flex flex-wrap items-center gap-1.5">
          <button (click)="setSystemCategory('')"
                  class="px-3 py-1.5 text-xs font-medium rounded-full border transition-colors"
                  [class]="systemCategory() === ''
                    ? 'border-tracky text-fg-primary bg-tracky/10'
                    : 'border-border-subtle text-fg-tertiary hover:text-fg-secondary'">
            Tout
          </button>
          @for (c of systemCategories; track c.id) {
            <button (click)="setSystemCategory(c.id)"
                    class="px-3 py-1.5 text-xs font-medium rounded-full border transition-colors inline-flex items-center gap-1.5"
                    [class]="systemCategory() === c.id
                      ? 'border-tracky text-fg-primary bg-tracky/10'
                      : 'border-border-subtle text-fg-tertiary hover:text-fg-secondary'">
              <lucide-icon [img]="sysIcon(c.id)" [size]="12"></lucide-icon>
              {{ c.label }}
            </button>
          }
        </div>

        <!-- Filtre statut : « lister uniquement les échecs » = cas d'usage n°1 du journal. -->
        <div class="flex flex-wrap items-center gap-1.5">
          @for (s of systemStatuses; track s.id) {
            <button (click)="setSystemStatus(s.id)"
                    class="px-3 py-1 text-xs font-medium rounded-full border transition-colors"
                    [class]="systemStatus() === s.id
                      ? 'border-tracky text-fg-primary bg-tracky/10'
                      : 'border-border-subtle text-fg-tertiary hover:text-fg-secondary'">
              {{ s.label }}
            </button>
          }
        </div>

        @if (systemActs().length > 0) {
          <div class="flex flex-col gap-1.5">
            @for (a of systemActs(); track a.id) {
              <div class="flex items-start gap-3 bg-bg-secondary border border-border-subtle rounded-xl px-3 py-2.5">
                <!-- Icône catégorie -->
                <div class="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center" [class]="sysIconBg(a.category)">
                  <lucide-icon [img]="sysIcon(a.category)" [size]="15"></lucide-icon>
                </div>
                <!-- Corps -->
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-medium text-fg-primary">{{ sysCategoryLabel(a.category) }}</span>
                    @if (sysActionBadge(a); as b) {
                      <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md" [class]="b.cls">{{ b.label }}</span>
                    }
                    @if (a.triggeredByName) {
                      <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-sky-500/15 text-sky-400">déclenché par {{ a.triggeredByName }}</span>
                    } @else {
                      <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-bg-tertiary text-fg-tertiary uppercase tracking-wide">{{ a.actor ?? 'système' }}</span>
                    }
                    <span class="inline-flex items-center gap-1 text-[11px]" [style.color]="sysStatusColor(a.status)">
                      <span class="w-1.5 h-1.5 rounded-full" [style.background]="sysStatusColor(a.status)"></span>
                      {{ sysStatusLabel(a.status) }}
                    </span>
                  </div>
                  @if (a.target || a.detail) {
                    <p class="text-xs text-fg-secondary truncate mt-0.5"
                       [title]="(a.detail ?? '') + (a.target ? ' — ' + a.target : '')">
                      @if (a.target) { <span class="text-fg-primary">{{ a.target }}</span> }
                      @if (a.target && a.detail) { <span class="text-fg-tertiary"> · </span> }
                      @if (a.detail) { <span>{{ a.detail }}</span> }
                    </p>
                  }
                  @if (a.error && a.status !== 'SUCCESS') {
                    <p class="text-xs text-rose-400 truncate mt-0.5" [title]="a.error">{{ a.error }}</p>
                  }
                  @if (a.fleetName) {
                    <span class="text-[10px] text-fg-tertiary">{{ a.fleetName }}</span>
                  }
                </div>
                <!-- Quand -->
                <span class="shrink-0 text-[11px] text-fg-tertiary whitespace-nowrap"
                      [title]="(a.createdAt | date: 'dd/MM/yyyy HH:mm:ss') ?? ''">
                  {{ relativeTime(a.createdAt) }}
                </span>
              </div>
            }
          </div>
          <button (click)="loadMoreSystem()" [disabled]="loadingMore()"
                  class="w-full py-2 text-sm text-fg-secondary border border-border-subtle rounded-lg hover:border-tracky disabled:opacity-50">
            {{ loadingMore() ? 'Chargement…' : 'Charger plus' }}
          </button>
        } @else {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
            <lucide-icon [img]="Server" [size]="40" class="opacity-30"></lucide-icon>
            <p class="text-sm">Aucune action système enregistrée.</p>
          </div>
        }
      }

      <!-- ─────────── ÉCOUTES AUDIO ─────────── -->
      @if (tab() === 'audio-listens') {
        <!-- Clarification : METADATA d'audit uniquement (qui a écouté quoi / quand), AUCUN
             contenu audio (Scénario A — appel live, rien n'est enregistré ni stocké). -->
        <div class="flex items-start gap-2 text-xs text-fg-tertiary bg-bg-secondary border border-border-subtle rounded-[--radius-card] px-3 py-2.5">
          <lucide-icon [img]="Ear" [size]="14" class="text-tracky-light shrink-0 mt-0.5"></lucide-icon>
          <span>
            Journal d'audit : <strong class="text-fg-secondary">qui a écouté quoi et quand</strong>.
            Aucun contenu audio n'est enregistré ni conservé (écoute en direct, Scénario A).
          </span>
        </div>

        <!-- Filtre statut (miroir de l'onglet commandes moteur). -->
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-fg-tertiary">Statut</label>
            <select [ngModel]="audioStatusFilter()" (ngModelChange)="setAudioStatusFilter($event)"
                    class="bg-bg-secondary border border-border-subtle rounded-lg px-3 py-2 text-sm text-fg-primary">
              <option value="">Tous</option>
              <option value="ACKNOWLEDGED">Confirmé</option>
              <option value="SENT">Armé</option>
              <option value="PENDING">En attente</option>
              <option value="FAILED">Échec</option>
              <option value="REJECTED">Refusé</option>
            </select>
          </div>
        </div>

        @if (audioListens().length > 0) {
          <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
            <table class="w-full text-sm">
              <thead class="border-b border-border-subtle text-fg-tertiary text-xs uppercase tracking-wide">
                <tr>
                  <th class="px-4 py-3 text-left font-medium">Par</th>
                  <th class="px-4 py-3 text-left font-medium">Quand</th>
                  <th class="px-4 py-3 text-left font-medium">Véhicule</th>
                  <th class="px-4 py-3 text-left font-medium">Statut</th>
                  <th class="px-4 py-3 text-left font-medium">Motif</th>
                  <th class="px-4 py-3 text-left font-medium">Env.</th>
                </tr>
              </thead>
              <tbody>
                @for (a of audioListens(); track a.id) {
                  <tr class="border-b border-border-subtle/50 hover:bg-bg-tertiary/40 align-top">
                    <!-- Par (qui) -->
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="text-fg-secondary">{{ a.requestedByName }}</span>
                        @if (a.requestedByRole) {
                          <span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-bg-tertiary text-fg-tertiary uppercase tracking-wide">{{ a.requestedByRole }}</span>
                        }
                      </div>
                    </td>
                    <!-- Quand -->
                    <td class="px-4 py-3 text-fg-tertiary whitespace-nowrap" [title]="(a.createdAt | date: 'dd/MM/yyyy HH:mm:ss') ?? ''">
                      {{ relativeTime(a.createdAt) }}
                    </td>
                    <!-- Véhicule -->
                    <td class="px-4 py-3">
                      <span class="font-mono text-fg-primary">{{ a.vehiclePlate ?? a.trackerImei }}</span>
                      @if (!a.vehiclePlate) {
                        <span class="block text-[10px] text-fg-tertiary">IMEI</span>
                      }
                    </td>
                    <!-- Statut -->
                    <td class="px-4 py-3">
                      <span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full" [class]="audioStatusClass(a.status)">
                        {{ audioStatusLabel(a.status) }}
                      </span>
                    </td>
                    <!-- Motif -->
                    <td class="px-4 py-3">
                      <span class="text-fg-secondary block max-w-[320px] truncate" [title]="a.reason">{{ a.reason }}</span>
                      @if (a.lastError) {
                        <span class="block text-[11px] text-rose-400 mt-1 max-w-[320px] truncate" [title]="a.lastError">{{ a.lastError }}</span>
                      }
                    </td>
                    <!-- Env -->
                    <td class="px-4 py-3">
                      <span class="inline-block px-2 py-0.5 text-xs rounded-md"
                            [class]="a.requestedInEnv === 'production' ? 'bg-rose-500/15 text-rose-400' : 'bg-bg-tertiary text-fg-tertiary'">
                        {{ a.requestedInEnv }}
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <button (click)="loadMoreAudio()" [disabled]="loadingMore()"
                  class="w-full py-2 text-sm text-fg-secondary border border-border-subtle rounded-lg hover:border-tracky disabled:opacity-50">
            {{ loadingMore() ? 'Chargement…' : 'Charger plus' }}
          </button>
        } @else {
          <div class="flex flex-col items-center justify-center h-40 rounded-[--radius-card]
                      bg-bg-secondary border border-border-subtle text-fg-tertiary gap-2">
            <lucide-icon [img]="Ear" [size]="40" class="opacity-30"></lucide-icon>
            <p class="text-sm">Aucune écoute audio.</p>
          </div>
        }
      }
    </div>
  `,
})
export class AdminActivityComponent implements OnInit, OnDestroy {
  private readonly api = inject(UserActivityApiService);
  private readonly audioApi = inject(AudioMonitoringService);
  private readonly usersApi = inject(UsersApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Users = Users;
  protected readonly MapPin = MapPin;
  protected readonly Power = Power;
  protected readonly PowerOff = PowerOff;
  protected readonly Ear = Ear;
  protected readonly relativeTime = relativeTime;

  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'live', label: 'Live' },
    { id: 'history', label: 'Historique' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'reports', label: 'Rapports IA' },
    { id: 'engine-commands', label: 'Commandes moteur' },
    { id: 'audio-listens', label: 'Écoutes audio' },
    { id: 'system', label: 'Système' },
  ];
  /** Catégories du journal des actions système (chips de filtre). */
  readonly systemCategories: { id: string; label: string }[] = [
    { id: 'MUTATION', label: 'Actions API' },
    { id: 'EMAIL', label: 'E-mails' },
    { id: 'SMS', label: 'SMS' },
    { id: 'PUSH', label: 'Push' },
    { id: 'ENGINE', label: 'Moteur' },
    { id: 'SURVEILLANCE', label: 'Antivol' },
    { id: 'TRACKER_CMD', label: 'Cmd boîtier' },
    { id: 'EXPORT', label: 'Exports' },
    { id: 'SIM', label: 'SIM' },
    { id: 'AI', label: 'IA' },
    { id: 'AI_REPORT', label: 'Rapports IA' },
    { id: 'AUDIO', label: 'Audio' },
    { id: 'RETENTION', label: 'Rétention' },
    { id: 'INSTALLATION', label: 'Installations' },
    { id: 'PRIVACY', label: 'Vie privée' },
    { id: 'INTERNAL', label: 'Interne' },
  ];
  readonly systemStatuses: { id: string; label: string }[] = [
    { id: '', label: 'Tous statuts' },
    { id: 'SUCCESS', label: 'Succès' },
    { id: 'FAILURE', label: 'Échecs' },
    { id: 'SKIPPED', label: 'Ignorés' },
  ];
  readonly periods: { id: Period; label: string }[] = [
    { id: '24h', label: '24h' },
    { id: '7d', label: '7 jours' },
    { id: '30d', label: '30 jours' },
  ];

  readonly tab = signal<Tab>('live');
  readonly online = signal<OnlineUserDto[]>([]);
  readonly feed = signal<ActivityFeedItemDto[]>([]);
  readonly history = signal<ActivityFeedItemDto[]>([]);
  readonly loadingMore = signal(false);
  readonly stats = signal<ActivityStatsDto | null>(null);
  readonly period = signal<Period>('7d');

  // Commandes moteur (audit coupe-circuit).
  readonly enginecmds = signal<EngineCommandAuditDto[]>([]);
  readonly actionFilter = signal('');
  readonly statusFilter = signal('');

  // Écoutes audio (audit micro embarqué — qui/quand/véhicule/motif/env/statut).
  readonly audioListens = signal<AudioCommandAuditDto[]>([]);
  readonly audioStatusFilter = signal('');

  // Système (actions auto / arrière-plan : e-mails, SMS, push, moteur, rétention, rapports IA).
  readonly systemActs = signal<SystemActivityDto[]>([]);
  readonly systemCategory = signal('');
  readonly systemStatus = signal('');

  // Filtres historique (« qu'a fait X hier ? »).
  readonly historyUser = signal('');
  readonly historyType = signal('');
  readonly filterUsers = signal<{ id: string; name: string; email: string }[]>([]);
  private filterUsersLoaded = false;

  /** Compte owner : jamais coché par défaut (l'admin ne veut pas voir SES propres actions polluer le flux). */
  private readonly ownerEmail = 'admin@vizyoagency.com';
  /** Utilisateurs à AFFICHER (multi-sélection). null = pas encore initialisé → tout afficher. */
  readonly shownUserIds = signal<Set<string> | null>(null);

  protected isUserShown(userId: string): boolean {
    const s = this.shownUserIds();
    return s === null ? true : s.has(userId);
  }
  protected shownUserCount(): number {
    const s = this.shownUserIds();
    return s === null ? this.filterUsers().length : s.size;
  }
  protected toggleUser(id: string): void {
    const next = new Set(this.shownUserIds() ?? this.filterUsers().map((u) => u.id));
    if (next.has(id)) next.delete(id); else next.add(id);
    this.shownUserIds.set(next);
  }
  protected selectAllUsers(): void {
    this.shownUserIds.set(new Set(this.filterUsers().map((u) => u.id)));
  }
  protected clearUsers(): void {
    this.shownUserIds.set(new Set());
  }

  /** Flux/liste bornés à la sélection (owner décoché par défaut). */
  readonly visibleOnline = computed(() => this.online().filter((u) => this.isUserShown(u.userId)));
  readonly visibleFeed = computed(() => this.feed().filter((a) => this.isUserShown(a.userId)));
  readonly visibleHistory = computed(() => this.history().filter((a) => this.isUserShown(a.userId)));

  readonly maxSessions = computed(() =>
    Math.max(1, ...(this.stats()?.sessionsPerDay ?? []).map((d) => d.count)),
  );

  private pollHandle: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    // Deep-link ?tab= (et cohérence PAGE_VIEW du tracker : « Admin · Activité · Système »).
    const tab = this.route.snapshot.queryParamMap.get('tab');
    if (tab && this.tabs.some((t) => t.id === tab)) this.tab.set(tab as Tab);
    if (this.tab() !== 'live') this.setTab(this.tab());
    this.loadLive();
    this.pollHandle = setInterval(() => {
      if (this.tab() === 'live') this.loadLive();
    }, 5000);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  setTab(t: Tab): void {
    this.tab.set(t);
    // Synchro URL → NavigationEnd → PAGE_VIEW distinct avec durée par onglet.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: t === 'live' ? null : t },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    if (t === 'live') this.loadLive();
    else if (t === 'history') this.loadHistory();
    else if (t === 'engine-commands') this.loadEngine();
    else if (t === 'audio-listens') this.loadAudio();
    else if (t === 'system') this.loadSystem();
    else this.loadStats();
  }

  reload(): void {
    if (this.tab() === 'live') this.loadLive();
    else if (this.tab() === 'history') this.loadHistory();
    else if (this.tab() === 'engine-commands') this.loadEngine();
    else if (this.tab() === 'audio-listens') this.loadAudio();
    else if (this.tab() === 'system') this.loadSystem();
    else this.loadStats();
  }

  setPeriod(p: Period): void {
    this.period.set(p);
    this.loadStats();
  }

  loadMore(): void {
    const last = this.history()[this.history().length - 1];
    if (!last) return;
    this.loadingMore.set(true);
    // Cursor composite (at, id) : les events d'un même batch partagent le timestamp.
    this.api
      .feed({
        limit: 50,
        before: last.at,
        beforeId: last.id,
        userId: this.historyUser() || undefined,
        type: this.historyType() || undefined,
      })
      .subscribe({
        next: (items) => {
          this.history.update((h) => [...h, ...items]);
          this.loadingMore.set(false);
        },
        error: () => this.loadingMore.set(false),
      });
  }

  setHistoryType(v: string): void {
    this.historyType.set(v);
    this.loadHistory();
  }

  setActionFilter(v: string): void {
    this.actionFilter.set(v);
    this.loadEngine();
  }
  setStatusFilter(v: string): void {
    this.statusFilter.set(v);
    this.loadEngine();
  }

  loadMoreEngine(): void {
    const last = this.enginecmds()[this.enginecmds().length - 1];
    if (!last) return;
    this.loadingMore.set(true);
    this.api
      .engineCommands(50, last.createdAt, this.actionFilter() || undefined, this.statusFilter() || undefined)
      .subscribe({
        next: (items) => {
          this.enginecmds.update((l) => [...l, ...items]);
          this.loadingMore.set(false);
        },
        error: () => this.loadingMore.set(false),
      });
  }

  private loadEngine(): void {
    this.api
      .engineCommands(50, undefined, this.actionFilter() || undefined, this.statusFilter() || undefined)
      .subscribe({ next: (l) => this.enginecmds.set(l), error: () => undefined });
  }

  setAudioStatusFilter(v: string): void {
    this.audioStatusFilter.set(v);
    this.loadAudio();
  }

  private loadAudio(): void {
    this.audioApi
      .getAudit({ limit: 50, status: this.audioStatusFilter() || undefined })
      .subscribe({ next: (l) => this.audioListens.set(l), error: () => undefined });
  }

  loadMoreAudio(): void {
    const last = this.audioListens()[this.audioListens().length - 1];
    if (!last) return;
    this.loadingMore.set(true);
    this.audioApi
      .getAudit({ limit: 50, before: last.createdAt, status: this.audioStatusFilter() || undefined })
      .subscribe({
        next: (items) => {
          this.audioListens.update((l) => [...l, ...items]);
          this.loadingMore.set(false);
        },
        error: () => this.loadingMore.set(false),
      });
  }

  setSystemCategory(c: string): void {
    this.systemCategory.set(c);
    this.loadSystem();
  }
  setSystemStatus(s: string): void {
    this.systemStatus.set(s);
    this.loadSystem();
  }

  private loadSystem(): void {
    this.api
      .systemFeed({
        limit: 60,
        category: this.systemCategory() || undefined,
        status: this.systemStatus() || undefined,
      })
      .subscribe({ next: (l) => this.systemActs.set(l), error: () => undefined });
  }

  loadMoreSystem(): void {
    const last = this.systemActs()[this.systemActs().length - 1];
    if (!last) return;
    this.loadingMore.set(true);
    this.api
      .systemFeed({
        limit: 60,
        before: last.createdAt,
        beforeId: last.id,
        category: this.systemCategory() || undefined,
        status: this.systemStatus() || undefined,
      })
      .subscribe({
        next: (items) => {
          this.systemActs.update((l) => [...l, ...items]);
          this.loadingMore.set(false);
        },
        error: () => this.loadingMore.set(false),
      });
  }

  private loadLive(): void {
    this.api.online().subscribe({ next: (u) => this.online.set(u), error: () => undefined });
    this.api.feed({ limit: 50 }).subscribe({ next: (f) => this.feed.set(f), error: () => undefined });
    this.loadFilterUsers();
  }
  private loadHistory(): void {
    this.api
      .feed({ limit: 80, userId: this.historyUser() || undefined, type: this.historyType() || undefined })
      .subscribe({ next: (f) => this.history.set(f), error: () => undefined });
    this.loadFilterUsers();
  }

  /** Charge la liste d'utilisateurs (filtre) + initialise la sélection par défaut : tout coché SAUF l'owner. */
  private loadFilterUsers(): void {
    if (this.filterUsersLoaded) return;
    this.filterUsersLoaded = true;
    this.usersApi
      .findAll()
      .then(({ users }) => {
        this.filterUsers.set(
          users.map((u) => ({
            id: u.id,
            name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
            email: u.email,
          })),
        );
        if (this.shownUserIds() === null) {
          const owner = this.ownerEmail.toLowerCase();
          this.shownUserIds.set(
            new Set(users.filter((u) => (u.email ?? '').toLowerCase() !== owner).map((u) => u.id)),
          );
        }
      })
      .catch(() => {
        this.filterUsersLoaded = false;
      });
  }
  private loadStats(): void {
    this.stats.set(null);
    const from = this.periodFrom();
    this.api.stats(from).subscribe({ next: (s) => this.stats.set(s), error: () => undefined });
  }

  private periodFrom(): string {
    const now = Date.now();
    const days = this.period() === '24h' ? 1 : this.period() === '7d' ? 7 : 30;
    return new Date(now - days * 86_400_000).toISOString();
  }

  // ── helpers d'affichage ──
  protected statusColor(s: PresenceStatus): string {
    return s === 'ACTIVE' ? '#34d399' : s === 'IDLE' ? '#fbbf24' : s === 'AWAY' ? '#fb923c' : '#6b7280';
  }
  protected statusLabel(s: PresenceStatus): string {
    return s === 'ACTIVE' ? 'actif' : s === 'IDLE' ? 'inactif' : s === 'AWAY' ? 'absent' : 'hors ligne';
  }
  protected eventTypeLabel(t: string): string {
    switch (t) {
      case 'PAGE_VIEW': return 'Pages vues';
      case 'CLICK': return 'Clics';
      case 'SCROLL': return 'Défilements';
      case 'FORM_SUBMIT': return 'Formulaires';
      case 'SESSION_START': return 'Connexions';
      case 'SESSION_END': return 'Déconnexions';
      case 'SESSION_RESUME': return 'Reprises';
      case 'IDLE': return 'Inactifs';
      case 'AWAY': return 'Absents';
      default: return t;
    }
  }

  protected typeIcon(t: ActivityFeedItemDto['type']) {
    switch (t) {
      case 'PAGE_VIEW': return ArrowRight;
      case 'CLICK': return MousePointer2;
      case 'SCROLL': return MoveVertical;
      case 'FORM_SUBMIT': return Send;
      case 'SESSION_START': return LogIn;
      case 'SESSION_END': return LogOut;
      case 'SESSION_RESUME': return RotateCcw;
      case 'IDLE': return Moon;
      case 'AWAY': return CircleAlert;
      default: return Activity;
    }
  }

  // ── helpers Système (actions auto / arrière-plan) ──
  protected readonly Server = Server;
  protected sysIcon(category: string) {
    switch (category) {
      case 'EMAIL': return Mail;
      case 'SMS': return MessageSquare;
      case 'PUSH': return Bell;
      case 'ENGINE': return Power;
      case 'RETENTION': return Trash2;
      case 'AI_REPORT': return Sparkles;
      case 'SURVEILLANCE': return ShieldAlert;
      case 'TRACKER_CMD': return Cpu;
      case 'EXPORT': return Download;
      case 'SIM': return CreditCard;
      case 'AI': return Sparkles;
      case 'AUDIO': return Ear;
      case 'INSTALLATION': return CalendarClock;
      case 'PRIVACY': return ShieldOff;
      case 'INTERNAL': return Building2;
      case 'MUTATION': return Pencil;
      default: return Server;
    }
  }
  protected sysIconBg(category: string): string {
    switch (category) {
      case 'EMAIL': return 'bg-sky-500/15 text-sky-400';
      case 'SMS': return 'bg-violet-500/15 text-violet-400';
      case 'PUSH': return 'bg-amber-500/15 text-amber-400';
      case 'ENGINE': return 'bg-rose-500/15 text-rose-400';
      case 'RETENTION': return 'bg-emerald-500/15 text-emerald-400';
      case 'AI_REPORT': return 'bg-fuchsia-500/15 text-fuchsia-400';
      case 'SURVEILLANCE': return 'bg-orange-500/15 text-orange-400';
      case 'TRACKER_CMD': return 'bg-cyan-500/15 text-cyan-400';
      case 'EXPORT': return 'bg-teal-500/15 text-teal-400';
      case 'SIM': return 'bg-indigo-500/15 text-indigo-400';
      case 'AI': return 'bg-fuchsia-500/15 text-fuchsia-400';
      case 'AUDIO': return 'bg-red-500/15 text-red-400';
      case 'INSTALLATION': return 'bg-emerald-500/15 text-emerald-400';
      case 'PRIVACY': return 'bg-sky-500/15 text-sky-400';
      case 'INTERNAL': return 'bg-slate-500/15 text-slate-400';
      case 'MUTATION': return 'bg-lime-500/15 text-lime-400';
      default: return 'bg-bg-tertiary text-fg-tertiary';
    }
  }

  /**
   * Badge d'action affiché SEULEMENT quand il ajoute de l'info vs la catégorie
   * (ex. ENGINE : Coupure vs Rétablissement — indistinguables sinon dès qu'un
   * motif remplit detail). null = action triviale 1:1 (email_sent, push_sent…).
   */
  protected sysActionBadge(a: SystemActivityDto): { label: string; cls: string } | null {
    switch (a.action) {
      case 'engine_cut': return { label: 'Coupure', cls: 'bg-rose-500/15 text-rose-400' };
      case 'engine_restore': return { label: 'Rétablissement', cls: 'bg-emerald-500/15 text-emerald-400' };
      case 'surveillance_armed': return { label: 'Armement', cls: 'bg-orange-500/15 text-orange-400' };
      case 'surveillance_disarmed': return { label: 'Désarmement', cls: 'bg-emerald-500/15 text-emerald-400' };
      case 'push_test': return { label: 'Test', cls: 'bg-bg-tertiary text-fg-tertiary' };
      default:
        if (a.action.startsWith('sms_') && a.action !== 'sms_sent') {
          return { label: a.action.slice(4).replace(/-/g, ' '), cls: 'bg-violet-500/15 text-violet-400' };
        }
        if (a.action.startsWith('http_')) {
          return { label: a.action.slice(5).toUpperCase(), cls: 'bg-lime-500/15 text-lime-400' };
        }
        return null;
    }
  }
  protected sysCategoryLabel(category: string): string {
    return SYSTEM_ACTIVITY_CATEGORY_LABELS[category] ?? category;
  }
  protected sysStatusColor(s: string): string {
    return s === 'SUCCESS' ? '#34d399' : s === 'FAILURE' ? '#f87171' : '#fbbf24';
  }
  protected sysStatusLabel(s: string): string {
    return s === 'SUCCESS' ? 'ok' : s === 'FAILURE' ? 'échec' : s === 'SKIPPED' ? 'ignoré' : s.toLowerCase();
  }

  // ── helpers commandes moteur ──
  protected cmdStatusLabel(s: EngineCommandAuditDto['status']): string {
    switch (s) {
      case 'ACKNOWLEDGED': return 'Confirmé';
      case 'SENT': return 'Envoyé';
      case 'PENDING': return 'En attente';
      case 'FAILED': return 'Échec';
      case 'REJECTED_SPEED': return 'Refusé (vitesse)';
      default: return s;
    }
  }
  protected statusClass(s: EngineCommandAuditDto['status']): string {
    switch (s) {
      case 'ACKNOWLEDGED': return 'bg-emerald-500/15 text-emerald-400';
      case 'SENT': return 'bg-sky-500/15 text-sky-400';
      case 'PENDING': return 'bg-amber-500/15 text-amber-400';
      case 'FAILED': return 'bg-rose-500/15 text-rose-400';
      case 'REJECTED_SPEED': return 'bg-orange-500/15 text-orange-400';
      default: return 'bg-bg-tertiary text-fg-tertiary';
    }
  }
  protected sourceLabel(src: string): string {
    switch (src) {
      case 'MANUAL': return 'Manuel';
      case 'SCHEDULER': return 'Planning';
      case 'DEVICE_OBSERVED': return 'Boîtier';
      default: return src;
    }
  }

  // ── helpers écoutes audio (statut) ──
  // SENT = micro armé (Scénario A), ACKNOWLEDGED = confirmé par le boîtier.
  protected audioStatusLabel(s: AudioCommandAuditDto['status']): string {
    switch (s) {
      case 'ACKNOWLEDGED': return 'Confirmé';
      case 'SENT': return 'Armé';
      case 'PENDING': return 'En attente';
      case 'FAILED': return 'Échec';
      case 'REJECTED': return 'Refusé';
      default: return s;
    }
  }
  protected audioStatusClass(s: AudioCommandAuditDto['status']): string {
    switch (s) {
      case 'SENT':
      case 'ACKNOWLEDGED':
        return 'bg-emerald-500/15 text-emerald-400';
      case 'FAILED':
      case 'REJECTED':
        return 'bg-rose-500/15 text-rose-400';
      case 'PENDING':
      default:
        return 'bg-bg-tertiary text-fg-tertiary';
    }
  }
  protected describe(a: ActivityFeedItemDto): string {
    switch (a.type) {
      case 'PAGE_VIEW':
        return `${a.routeLabel ?? a.route ?? ''}${a.durationMs != null ? ` (${this.fmtMs(a.durationMs)})` : ''}`;
      case 'CLICK': {
        const page = a.routeLabel ?? a.route;
        return `cliqué « ${a.target} »${page ? ` — ${page}` : ''}`;
      }
      case 'SCROLL': {
        const page = a.routeLabel ?? a.route;
        return `défilé${a.target ? ` (${a.target})` : ''}${page ? ` — ${page}` : ''}`;
      }
      case 'FORM_SUBMIT': {
        const page = a.routeLabel ?? a.route;
        return `formulaire envoyé${a.target ? ` « ${a.target} »` : ''}${page ? ` — ${page}` : ''}`;
      }
      case 'SESSION_START': return 'connecté';
      case 'SESSION_END': {
        const r = a.target === 'manual' ? 'volontaire' : a.target === 'tab_close' ? 'onglet fermé' : a.target === 'auto' ? 'expiration/système' : null;
        return `déconnecté${r ? ` (${r})` : ''}`;
      }
      case 'SESSION_RESUME': return 'session reprise';
      case 'IDLE': return 'inactif';
      case 'AWAY': return 'absent';
      default: return a.type;
    }
  }
  protected barPct(v: number, max: number): number {
    return max > 0 ? Math.round((v / max) * 100) : 0;
  }
  protected fmtDur(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  protected fmtMs(ms: number): string {
    return this.fmtDur(ms);
  }
  protected fmtSec(sec: number): string {
    return this.fmtDur(sec * 1000);
  }
}
