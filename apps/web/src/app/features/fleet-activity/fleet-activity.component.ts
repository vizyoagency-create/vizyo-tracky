import { ToastService } from '../../shared/ui/toast/toast.service';
import { httpFailureMessage } from '../../core/services/http-failure';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Activity, CircleDot, LucideAngularModule, Power, PowerOff, RefreshCw, Users, Zap,
} from 'lucide-angular';
import type { ActivityFeedItemDto, EngineCommandAuditDto, OnlineUserDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { FleetActivityApiService } from './fleet-activity-api.service';

type Tab = 'engine' | 'live' | 'history';

/**
 * Espace « Activité de la flotte » — FLEET_ADMIN (demande 2026-07).
 *
 * Permet à un responsable de flotte (ex. Mr Hendricks) de CONTRÔLER qui agit sur ses véhicules,
 * notamment QUI a COUPÉ / RALLUMÉ un moteur et QUAND (ex. vérifier au matin si un veilleur de
 * nuit a rallumé une voiture cette nuit). Trois vues : Moteurs (coupures/rallumages), En ligne
 * (présence temps réel), Historique (flux d'actions). AUCUN rapport/analytics.
 *
 * SÉCURITÉ : le back borne à la flotte de l'appelant ET exclut les rôles ÉLEVÉS
 * (super-admin / owner) — un fleet-admin ne voit JAMAIS l'activité des rôles au-dessus de lui.
 */
@Component({
  selector: 'app-fleet-activity',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, LucideAngularModule],
  template: `
    <div class="fa">
      <header class="fa-head">
        <div class="fa-title">
          <lucide-icon [img]="ActivityIcon" [size]="20" />
          <div>
            <h1>Activité de la flotte</h1>
            <p class="fa-sub">Qui agit sur vos véhicules — coupures/rallumages moteur, présence et historique.</p>
          </div>
        </div>
        <button class="fa-refresh" (click)="reloadActive()" [disabled]="loading()" title="Rafraîchir">
          <lucide-icon [img]="RefreshIcon" [size]="16" [class.spin]="loading()" />
        </button>
      </header>

      <nav class="fa-tabs">
        <button [class.on]="tab() === 'engine'" (click)="setTab('engine')">
          <lucide-icon [img]="ZapIcon" [size]="15" /> Moteurs
        </button>
        <button [class.on]="tab() === 'live'" (click)="setTab('live')">
          <lucide-icon [img]="UsersIcon" [size]="15" /> En ligne
          @if (online().length) { <span class="fa-badge">{{ online().length }}</span> }
        </button>
        <button [class.on]="tab() === 'history'" (click)="setTab('history')">
          <lucide-icon [img]="DotIcon" [size]="15" /> Historique
        </button>
      </nav>

      <!-- ───────── MOTEURS ───────── -->
      @if (tab() === 'engine') {
        <div class="fa-note">
          Historique des <strong>coupures</strong> et <strong>rallumages</strong> moteur de votre flotte :
          par qui, quand, et comment (manuel, planning horaire, ou détecté sur le boîtier).
        </div>
        <div class="fa-filters">
          <select [ngModel]="engineAction()" (ngModelChange)="setEngineAction($event)">
            <option value="">Toutes actions</option>
            <option value="CUT">Coupures</option>
            <option value="RESTORE">Rallumages</option>
          </select>
          <select [ngModel]="engineStatus()" (ngModelChange)="setEngineStatus($event)">
            <option value="">Tous statuts</option>
            <option value="SENT">Envoyée</option>
            <option value="ACKNOWLEDGED">Confirmée</option>
            <option value="PENDING">En attente</option>
            <option value="FAILED">Échec</option>
            <option value="REJECTED_SPEED">Refusée (en mouvement)</option>
          </select>
        </div>
        @if (engine().length === 0 && !loading()) {
          <div class="fa-empty">Aucune action moteur sur cette flotte.</div>
        } @else {
          <div class="fa-table-wrap">
            <table class="fa-table">
              <thead>
                <tr><th>Quand</th><th>Véhicule</th><th>Action</th><th>Par</th><th>Statut</th><th>Source</th></tr>
              </thead>
              <tbody>
                @for (c of engine(); track c.id) {
                  <tr>
                    <td class="fa-when">{{ c.createdAt | date:'dd/MM HH:mm' }}</td>
                    <td><strong>{{ c.vehiclePlate ?? '—' }}</strong></td>
                    <td>
                      <span class="fa-act" [class.cut]="c.action === 'CUT'" [class.restore]="c.action === 'RESTORE'">
                        <lucide-icon [img]="c.action === 'CUT' ? PowerOffIcon : PowerIcon" [size]="13" />
                        {{ c.action === 'CUT' ? 'Coupure' : 'Rallumage' }}
                      </span>
                    </td>
                    <td>
                      {{ c.requestedByName }}
                      @if (c.requestedByRole) { <span class="fa-role">{{ roleLabel(c.requestedByRole) }}</span> }
                    </td>
                    <td><span class="fa-status" [attr.data-s]="c.status">{{ statusLabel(c.status) }}</span></td>
                    <td class="fa-source">{{ sourceLabel(c.source) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (engine().length >= pageSize) {
            <button class="fa-more" (click)="loadMoreEngine()" [disabled]="loading()">Charger plus</button>
          }
        }
      }

      <!-- ───────── EN LIGNE ───────── -->
      @if (tab() === 'live') {
        <div class="fa-note">Utilisateurs de votre flotte connectés en ce moment (rafraîchi automatiquement).</div>
        @if (online().length === 0) {
          <div class="fa-empty">Personne en ligne actuellement.</div>
        } @else {
          <div class="fa-online">
            @for (u of online(); track u.userId) {
              <div class="fa-online-card">
                <span class="fa-dot" [class.idle]="u.status !== 'ACTIVE'"></span>
                <div class="fa-online-main">
                  <div class="fa-online-name">{{ u.name }} <span class="fa-role">{{ roleLabel(u.role) }}</span></div>
                  <div class="fa-online-meta">
                    {{ u.currentRouteLabel ?? u.currentRoute ?? '—' }}
                    · vu il y a {{ u.lastSeenSec }} s
                  </div>
                </div>
              </div>
            }
          </div>
        }
      }

      <!-- ───────── HISTORIQUE ───────── -->
      @if (tab() === 'history') {
        <div class="fa-note">Flux des actions des utilisateurs de votre flotte (les plus récentes d'abord).</div>
        @if (feed().length === 0 && !loading()) {
          <div class="fa-empty">Aucune activité récente.</div>
        } @else {
          <ul class="fa-feed">
            @for (f of feed(); track f.id) {
              <li>
                <span class="fa-feed-when">{{ f.at | date:'dd/MM HH:mm' }}</span>
                <span class="fa-feed-user">{{ f.userName }}</span>
                <span class="fa-feed-type">{{ typeLabel(f.type) }}</span>
                <span class="fa-feed-target">{{ f.routeLabel ?? f.route ?? f.target ?? '' }}</span>
              </li>
            }
          </ul>
          @if (feed().length >= pageSize) {
            <button class="fa-more" (click)="loadMoreFeed()" [disabled]="loading()">Charger plus</button>
          }
        }
      }
    </div>
  `,
  styles: [`
    .fa { padding: 16px; max-width: 1000px; margin: 0 auto; }
    .fa-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .fa-title { display: flex; gap: 10px; align-items: center; color: var(--text-primary); }
    .fa-title h1 { font-size: 20px; font-weight: 800; margin: 0; }
    .fa-sub { margin: 2px 0 0; font-size: 12.5px; color: var(--text-secondary); }
    .fa-refresh { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 8px; cursor: pointer; color: var(--text-secondary); }
    .fa-refresh:disabled { opacity: .5; }
    .spin { animation: fa-spin 1s linear infinite; } @keyframes fa-spin { to { transform: rotate(360deg); } }
    .fa-tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
    .fa-tabs button { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--text-secondary); font-weight: 700; font-size: 13px; cursor: pointer; }
    .fa-tabs button.on { background: #10b981; color: #fff; border-color: #10b981; }
    .fa-badge { background: rgba(255,255,255,.25); border-radius: 9999px; padding: 0 6px; font-size: 11px; }
    .fa-note { font-size: 12.5px; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
    .fa-filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .fa-filters select { padding: 7px 10px; border-radius: 9px; border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--text-primary); font-size: 13px; }
    .fa-empty { text-align: center; color: var(--text-secondary); padding: 30px; font-size: 13px; }
    .fa-table-wrap { overflow-x: auto; border: 1px solid var(--border-subtle); border-radius: 12px; }
    .fa-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .fa-table th { text-align: left; padding: 10px 12px; background: var(--bg-secondary); color: var(--text-secondary); font-weight: 700; font-size: 11.5px; text-transform: uppercase; letter-spacing: .02em; white-space: nowrap; }
    .fa-table td { padding: 10px 12px; border-top: 1px solid var(--border-subtle); color: var(--text-primary); white-space: nowrap; }
    .fa-when, .fa-feed-when { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .fa-act { display: inline-flex; align-items: center; gap: 5px; font-weight: 700; padding: 2px 8px; border-radius: 9999px; font-size: 12px; }
    .fa-act.cut { color: #ef4444; background: rgba(239,68,68,.12); }
    .fa-act.restore { color: #10b981; background: rgba(16,185,129,.12); }
    .fa-role { display: inline-block; font-size: 10.5px; font-weight: 700; color: var(--text-secondary); background: var(--bg-tertiary, rgba(120,120,120,.12)); border-radius: 6px; padding: 1px 6px; margin-left: 4px; }
    .fa-status { font-weight: 700; font-size: 12px; }
    .fa-status[data-s="ACKNOWLEDGED"] { color: #10b981; }
    .fa-status[data-s="SENT"] { color: #f59e0b; }
    .fa-status[data-s="PENDING"] { color: #94a3b8; }
    .fa-status[data-s="FAILED"], .fa-status[data-s="REJECTED_SPEED"] { color: #ef4444; }
    .fa-source { color: var(--text-secondary); font-size: 12px; }
    .fa-more { display: block; margin: 12px auto 0; padding: 8px 18px; border-radius: 9px; border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--text-primary); font-weight: 700; cursor: pointer; }
    .fa-online { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
    .fa-online-card { display: flex; gap: 10px; align-items: center; padding: 12px; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-secondary); }
    .fa-dot { width: 9px; height: 9px; border-radius: 9999px; background: #10b981; flex-shrink: 0; } .fa-dot.idle { background: #f59e0b; }
    .fa-online-name { font-weight: 700; font-size: 13.5px; color: var(--text-primary); }
    .fa-online-meta { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
    .fa-feed { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-subtle); border-radius: 12px; overflow: hidden; }
    .fa-feed li { display: flex; gap: 10px; align-items: baseline; padding: 9px 12px; border-top: 1px solid var(--border-subtle); font-size: 13px; }
    .fa-feed li:first-child { border-top: none; }
    .fa-feed-user { font-weight: 700; color: var(--text-primary); }
    .fa-feed-type { font-size: 11px; text-transform: uppercase; color: var(--text-secondary); }
    .fa-feed-target { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; }
  `],
})
export class FleetActivityComponent implements OnInit, OnDestroy {
  private readonly api = inject(FleetActivityApiService);
  private readonly toast = inject(ToastService);

  protected readonly ActivityIcon = Activity;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly ZapIcon = Zap;
  protected readonly UsersIcon = Users;
  protected readonly DotIcon = CircleDot;
  protected readonly PowerIcon = Power;
  protected readonly PowerOffIcon = PowerOff;

  protected readonly pageSize = 50;
  protected readonly tab = signal<Tab>('engine');
  protected readonly loading = signal(false);
  protected readonly online = signal<OnlineUserDto[]>([]);
  protected readonly feed = signal<ActivityFeedItemDto[]>([]);
  protected readonly engine = signal<EngineCommandAuditDto[]>([]);
  protected readonly engineAction = signal<string>('');
  protected readonly engineStatus = signal<string>('');

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    void this.loadEngine();
    // « En ligne » rafraîchi en continu (léger polling) — on garde la présence à jour même
    // hors de l'onglet Live pour le compteur de l'onglet.
    void this.loadOnline();
    this.pollTimer = setInterval(() => void this.loadOnline(), 5000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  protected setTab(t: Tab): void {
    if (t === this.tab()) return;
    this.tab.set(t);
    this.reloadActive();
  }

  protected reloadActive(): void {
    if (this.tab() === 'engine') void this.loadEngine();
    else if (this.tab() === 'live') void this.loadOnline();
    else void this.loadFeed();
  }

  protected setEngineAction(v: string): void { this.engineAction.set(v); void this.loadEngine(); }
  protected setEngineStatus(v: string): void { this.engineStatus.set(v); void this.loadEngine(); }

  private async loadOnline(): Promise<void> {
    try { this.online.set(await firstValueFrom(this.api.online())); } catch { /* silencieux (polling) */ }
  }

  private async loadEngine(): Promise<void> {
    this.loading.set(true);
    try {
      this.engine.set(await firstValueFrom(this.api.engineCommands(this.pageSize, undefined, this.engineAction() || undefined, this.engineStatus() || undefined)));
    } catch { this.engine.set([]); } finally { this.loading.set(false); }
  }

  protected async loadMoreEngine(): Promise<void> {
    const last = this.engine()[this.engine().length - 1];
    if (!last) return;
    this.loading.set(true);
    try {
      const more = await firstValueFrom(this.api.engineCommands(this.pageSize, last.createdAt, this.engineAction() || undefined, this.engineStatus() || undefined));
      if (more.length) this.engine.update((cur) => [...cur, ...more]);
    } catch (err) {
      // Chargement declenche par l'utilisateur (choix d'onglet ou de filtre) : une panne
      // muette lui laisserait croire qu'il n'y a rien a montrer. Le sondage de presence,
      // lui, reste volontairement silencieux — il tourne toutes les 5 s sans qu'on le
      // lui demande, et le signaler a chaque tour serait du harcelement, pas de
      // l'information.
      this.toast.error('Chargement impossible', httpFailureMessage(err, 'cette activité'));
    } finally { this.loading.set(false); }
  }

  private async loadFeed(): Promise<void> {
    this.loading.set(true);
    try { this.feed.set(await firstValueFrom(this.api.feed({ limit: this.pageSize }))); }
    catch { this.feed.set([]); } finally { this.loading.set(false); }
  }

  protected async loadMoreFeed(): Promise<void> {
    const last = this.feed()[this.feed().length - 1];
    if (!last) return;
    this.loading.set(true);
    try {
      const more = await firstValueFrom(this.api.feed({ limit: this.pageSize, before: last.at, beforeId: last.id }));
      if (more.length) this.feed.update((cur) => [...cur, ...more]);
    } catch { /* ignore */ } finally { this.loading.set(false); }
  }

  // ── Libellés ──────────────────────────────────────────────────────────────
  protected roleLabel(role: string): string {
    switch (role) {
      case 'FLEET_ADMIN': return 'Admin flotte';
      case 'FLEET_MANAGER': return 'Gestionnaire';
      case 'NIGHT_WATCHMAN': return 'Veilleur';
      case 'VIEWER': return 'Observateur';
      default: return role;
    }
  }
  protected statusLabel(s: string): string {
    switch (s) {
      case 'ACKNOWLEDGED': return 'Confirmée';
      case 'SENT': return 'Envoyée';
      case 'PENDING': return 'En attente';
      case 'FAILED': return 'Échec';
      case 'REJECTED_SPEED': return 'Refusée (en mouvement)';
      default: return s;
    }
  }
  protected sourceLabel(s: string): string {
    switch (s) {
      case 'MANUAL': return 'Manuel';
      case 'SCHEDULER': return 'Planning horaire';
      case 'DEVICE_OBSERVED': return 'Détecté (boîtier)';
      default: return s;
    }
  }
  protected typeLabel(t: string): string {
    switch (t) {
      case 'PAGE_VIEW': return 'Page';
      case 'CLICK': return 'Clic';
      case 'FORM_SUBMIT': return 'Formulaire';
      case 'SCROLL': return 'Défilement';
      default: return t;
    }
  }
}
