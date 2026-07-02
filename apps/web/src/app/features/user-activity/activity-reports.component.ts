import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, Sparkles, Loader, Search, Check, AlertTriangle, Clock, RefreshCw,
  FileText, TrendingDown, ThumbsUp, Lightbulb, CalendarClock, Copy, Trash2, Users as UsersIcon,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type {
  ActivityReportDto, ActivityReportListItemDto, ActivityReportScheduleDto, ActivityReportFrequency, ActivityReportScope,
} from '@vizyo/tracky-shared';
import { ActivityReportApiService } from './activity-report-api.service';
import { UsersApiService, type TrackyUser } from '../../core/services/users.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

type Period = '7d' | '30d' | 'custom';

/**
 * Palier 3 — Onglet « Rapports IA ». Le super-admin sélectionne un/des utilisateurs + une période,
 * un agent Claude observe leur activité et produit un rapport (parcours + friction + adoption +
 * recommandations) PERSISTÉ, ré-consultable. Planification réglable en bas.
 */
@Component({
  selector: 'app-activity-reports',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, LucideAngularModule],
  template: `
    <div class="ar">
      <!-- Génération -->
      <section class="ar-card">
        <div class="ar-card-h"><lucide-icon [img]="SparkIcon" [size]="16"></lucide-icon> Générer un rapport</div>
        <div class="ar-gen">
          <div class="ar-users">
            <div class="ar-search">
              <lucide-icon [img]="SearchIcon" [size]="14"></lucide-icon>
              <input type="text" placeholder="Rechercher un utilisateur…" [value]="search()" (input)="search.set($any($event.target).value)">
            </div>
            <div class="ar-userlist">
              @for (u of filteredUsers(); track u.id) {
                <label class="ar-user" [class.on]="selected().has(u.id)">
                  <input type="checkbox" [checked]="selected().has(u.id)" (change)="toggle(u.id)">
                  <span class="ar-user-name">{{ name(u) }}</span>
                  <span class="ar-user-role">{{ u.role }}</span>
                </label>
              } @empty {
                <p class="ar-empty">Aucun utilisateur.</p>
              }
            </div>
          </div>
          <div class="ar-gen-side">
            <div class="ar-seg">
              <button type="button" [class.on]="period() === '7d'" (click)="period.set('7d')">7 jours</button>
              <button type="button" [class.on]="period() === '30d'" (click)="period.set('30d')">30 jours</button>
              <button type="button" [class.on]="period() === 'custom'" (click)="period.set('custom')">Dates</button>
            </div>
            @if (period() === 'custom') {
              <div class="ar-dates">
                <label class="ar-field">Du
                  <input type="date" [value]="customFrom()" (input)="customFrom.set($any($event.target).value)">
                </label>
                <label class="ar-field">Au
                  <input type="date" [value]="customTo()" (input)="customTo.set($any($event.target).value)">
                </label>
              </div>
            }
            <p class="ar-sel">{{ selected().size }} sélectionné(s)</p>
            <button type="button" class="ar-btn ar-btn--primary" [disabled]="!canGenerate()" (click)="generate()">
              @if (generating()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="ar-spin"></lucide-icon> Analyse en cours… }
              @else { <lucide-icon [img]="SparkIcon" [size]="14"></lucide-icon> Générer le rapport }
            </button>
            <p class="ar-hint">L'IA lit l'activité (parcours, durées, clics, formulaires, erreurs) et produit un rapport. Coût suivi dans « Coûts IA ».</p>
          </div>
        </div>
      </section>

      <div class="ar-cols">
        <!-- Historique -->
        <section class="ar-card ar-hist">
          <div class="ar-card-h"><lucide-icon [img]="FileIcon" [size]="15"></lucide-icon> Historique <button type="button" class="ar-mini" (click)="loadList()"><lucide-icon [img]="RefreshIcon" [size]="13"></lucide-icon></button></div>
          @if (reports().length === 0) {
            <p class="ar-empty">Aucun rapport pour l'instant.</p>
          } @else {
            <div class="ar-list">
              @for (r of reports(); track r.id) {
                <div class="ar-item" [class.on]="current()?.id === r.id">
                  <button type="button" class="ar-item-main" (click)="open(r.id)">
                    <div class="ar-item-top">
                      <span class="ar-item-title">{{ r.title || 'Rapport' }}</span>
                      <span class="ar-badge" [attr.data-s]="r.status">{{ statusLabel(r.status) }}</span>
                    </div>
                    <span class="ar-item-sub">{{ r.createdAt | date:'dd/MM HH:mm' }} · {{ r.targetCount }} util. @if (r.origin === 'scheduled') { · auto }</span>
                  </button>
                  <button type="button" class="ar-item-del" title="Supprimer ce rapport" (click)="remove(r.id, $event)">
                    <lucide-icon [img]="TrashIcon" [size]="13"></lucide-icon>
                  </button>
                </div>
              }
            </div>
          }
        </section>

        <!-- Détail -->
        <section class="ar-card ar-detail">
          @if (loadingDetail()) {
            <div class="ar-skel"></div><div class="ar-skel"></div>
          } @else if (current(); as r) {
            @if (r.status === 'FAILED') {
              <div class="ar-alert"><lucide-icon [img]="AlertIcon" [size]="15"></lucide-icon> Échec : {{ r.error || 'erreur inconnue' }}</div>
            } @else if (r.content; as c) {
              <div class="ar-rep-head">
                <div class="ar-rep-title-row">
                  <h3>{{ r.title }}</h3>
                  <button type="button" class="ar-mini" title="Copier le rapport (Markdown)" (click)="copyMarkdown(r)">
                    <lucide-icon [img]="CopyIcon" [size]="14"></lucide-icon>
                  </button>
                </div>
                <span class="ar-rep-meta">{{ r.from | date:'dd/MM' }} → {{ r.to | date:'dd/MM' }} · {{ r.targets.length }} util.</span>
                @if (r.targets.length > 1) {
                  <div class="ar-chips">
                    @for (t of r.targets; track t.userId) { <span class="ar-chip">{{ t.name ?? '?' }}</span> }
                  </div>
                }
              </div>
              <p class="ar-summary">{{ c.summary }}</p>

              <div class="ar-block">
                <h4><lucide-icon [img]="FileIcon" [size]="14"></lucide-icon> Parcours</h4>
                <p class="ar-text">{{ c.journey }}</p>
              </div>

              @if (c.perUser?.length) {
                <div class="ar-block">
                  <h4><lucide-icon [img]="UsersI" [size]="14"></lucide-icon> Par utilisateur</h4>
                  @for (p of c.perUser; track p.name) {
                    <div class="ar-peruser">
                      <span class="ar-peruser-n">{{ p.name }}</span>
                      <span class="ar-peruser-h">{{ p.highlight }}</span>
                      @if (p.mainFriction) { <span class="ar-peruser-f">⚠ {{ p.mainFriction }}</span> }
                    </div>
                  }
                </div>
              }

              @if (c.frictionPoints.length) {
                <div class="ar-block">
                  <h4><lucide-icon [img]="FrictionIcon" [size]="14"></lucide-icon> Points de friction</h4>
                  @for (f of c.frictionPoints; track f.title) {
                    <div class="ar-friction" [attr.data-sev]="f.severity || 'medium'">
                      <span class="ar-friction-t">{{ f.title }}</span>
                      <span class="ar-friction-d">{{ f.detail }}</span>
                    </div>
                  }
                </div>
              }

              <div class="ar-block">
                <h4><lucide-icon [img]="AdoptIcon" [size]="14"></lucide-icon> Adoption</h4>
                <div class="ar-adopt">
                  <div><span class="ar-adopt-l ar-adopt-l--ok">Utilisé</span> <div class="ar-chips">@for (x of c.adoption.used; track x) { <span class="ar-chip ar-chip--ok">{{ x }}</span> } @if (!c.adoption.used.length) { <span class="ar-dim">—</span> }</div></div>
                  <div><span class="ar-adopt-l ar-adopt-l--no">Ignoré</span> <div class="ar-chips">@for (x of c.adoption.ignored; track x) { <span class="ar-chip ar-chip--no">{{ x }}</span> } @if (!c.adoption.ignored.length) { <span class="ar-dim">—</span> }</div></div>
                  @if (c.adoption.note) { <p class="ar-note">{{ c.adoption.note }}</p> }
                </div>
              </div>

              @if (c.recommendations.length) {
                <div class="ar-block">
                  <h4><lucide-icon [img]="RecoIcon" [size]="14"></lucide-icon> Recommandations</h4>
                  @for (rec of c.recommendations; track rec.title) {
                    <div class="ar-reco">
                      <span class="ar-reco-t">{{ rec.title }} @if (rec.impact) { <span class="ar-reco-imp">{{ rec.impact }}</span> }</span>
                      <span class="ar-reco-d">{{ rec.detail }}</span>
                    </div>
                  }
                </div>
              }

              <div class="ar-rep-foot">
                Généré {{ r.createdAt | date:'dd/MM/yyyy HH:mm' }}@if (r.createdByName) { · {{ r.createdByName }} } @if (r.origin === 'scheduled') { · planifié } · coût ~{{ r.costEur.toFixed(4) }} €
              </div>
            } @else {
              <p class="ar-empty">Rapport vide.</p>
            }
          } @else {
            <div class="ar-placeholder"><lucide-icon [img]="FileIcon" [size]="30"></lucide-icon><p>Sélectionne un rapport, ou génères-en un nouveau.</p></div>
          }
        </section>
      </div>

      <!-- Planification -->
      <section class="ar-card">
        <div class="ar-card-h"><lucide-icon [img]="ClockIcon" [size]="15"></lucide-icon> Planification automatique</div>
        @if (schedule(); as s) {
          <div class="ar-sched">
            <label class="ar-switch">
              <input type="checkbox" [checked]="s.enabled" (change)="patchSchedule({ enabled: $any($event.target).checked })">
              <span>Activer</span>
            </label>
            <label class="ar-field">Fréquence
              <select [value]="s.frequency" (change)="patchSchedule({ frequency: $any($event.target).value })">
                <option value="daily">Quotidienne</option>
                <option value="weekly">Hebdomadaire</option>
                <option value="monthly">Mensuelle</option>
              </select>
            </label>
            <label class="ar-field">Portée
              <select [value]="s.scope" (change)="patchSchedule({ scope: $any($event.target).value })">
                <option value="ACTIVE">Utilisateurs actifs</option>
                <option value="ALL">Tous les utilisateurs</option>
              </select>
            </label>
            <button type="button" class="ar-btn" [disabled]="savingSchedule()" (click)="saveSchedule()">
              @if (savingSchedule()) { <lucide-icon [img]="LoaderIcon" [size]="13" class="ar-spin"></lucide-icon> } Enregistrer
            </button>
            @if (s.lastRunAt) { <span class="ar-hint">Dernier passage : {{ s.lastRunAt | date:'dd/MM HH:mm' }}</span> }
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    .ar { display: flex; flex-direction: column; gap: 14px; }
    .ar-card { padding: 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 12px; }
    .ar-card-h { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; color: var(--fg-primary); }
    .ar-card-h lucide-icon { color: var(--tracky-light); }
    .ar-mini { margin-left: auto; color: var(--fg-tertiary); }
    .ar-gen { display: grid; grid-template-columns: 1fr; gap: 14px; }
    @media (min-width: 760px) { .ar-gen { grid-template-columns: 1fr 240px; } }
    .ar-search { display: flex; align-items: center; gap: 8px; padding: 8px 11px; border-radius: 9px; background: var(--bg-primary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); }
    .ar-search input { flex: 1; background: transparent; border: 0; color: var(--fg-primary); font-size: 14px; outline: none; }
    .ar-userlist { margin-top: 8px; max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
    .ar-user { display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: 8px; cursor: pointer; font-size: 13px; }
    .ar-user:hover { background: var(--bg-tertiary); }
    .ar-user.on { background: rgba(16,224,160,.08); }
    .ar-user input { width: 15px; height: 15px; accent-color: var(--tracky-light); }
    .ar-user-name { color: var(--fg-secondary); font-weight: 600; }
    .ar-user-role { margin-left: auto; font-size: 10px; text-transform: uppercase; color: var(--fg-tertiary); }
    .ar-gen-side { display: flex; flex-direction: column; gap: 9px; }
    .ar-seg { display: inline-flex; background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: 9px; padding: 3px; }
    .ar-seg button { flex: 1; padding: 6px 10px; border-radius: 6px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); }
    .ar-seg button.on { background: var(--bg-tertiary); color: var(--fg-primary); }
    .ar-sel { font-size: 12px; color: var(--fg-tertiary); }
    .ar-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 14px; border-radius: 9px; font-size: 13px; font-weight: 700; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); }
    .ar-btn--primary { background: var(--tracky, #10B981); color: #fff; border-color: transparent; }
    .ar-btn:disabled { opacity: .5; }
    .ar-hint { font-size: 11px; color: var(--fg-tertiary); line-height: 1.4; }
    .ar-empty { font-size: 12.5px; color: var(--fg-tertiary); padding: 14px 0; text-align: center; }

    .ar-cols { display: grid; grid-template-columns: 1fr; gap: 14px; }
    @media (min-width: 900px) { .ar-cols { grid-template-columns: 300px 1fr; align-items: start; } }
    .ar-list { display: flex; flex-direction: column; gap: 6px; max-height: 460px; overflow-y: auto; }
    .ar-item { display: flex; align-items: stretch; gap: 4px; padding: 10px; border-radius: 10px; background: var(--bg-primary); border: 1px solid var(--border-subtle); }
    .ar-item:hover { border-color: var(--border-strong); }
    .ar-item.on { border-color: var(--tracky-light); background: rgba(16,224,160,.05); }
    .ar-item-main { flex: 1; min-width: 0; text-align: left; display: flex; flex-direction: column; gap: 3px; }
    .ar-item-del { color: var(--fg-tertiary); align-self: center; padding: 4px; border-radius: 6px; }
    .ar-item-del:hover { color: #f87171; background: rgba(239,68,68,.1); }
    .ar-dates { display: flex; gap: 8px; }
    .ar-dates input { padding: 7px 9px; border-radius: 8px; background: var(--bg-primary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 12.5px; }
    .ar-rep-title-row { display: flex; align-items: center; gap: 8px; }
    .ar-rep-title-row .ar-mini { margin-left: 0; }
    .ar-peruser { display: flex; flex-direction: column; gap: 2px; padding: 8px 11px; border-radius: 9px; background: var(--bg-primary); }
    .ar-peruser-n { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
    .ar-peruser-h { font-size: 12px; color: var(--fg-secondary); line-height: 1.5; }
    .ar-peruser-f { font-size: 11.5px; color: #fbbf24; }
    .ar-item-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .ar-item-title { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ar-item-sub { font-size: 11px; color: var(--fg-tertiary); }
    .ar-badge { font-size: 9.5px; font-weight: 800; padding: 2px 7px; border-radius: 999px; text-transform: uppercase; background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .ar-badge[data-s="READY"] { background: rgba(16,224,160,.15); color: var(--tracky-light); }
    .ar-badge[data-s="FAILED"] { background: rgba(239,68,68,.15); color: #f87171; }

    .ar-detail { min-height: 200px; }
    .ar-placeholder { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px; text-align: center; color: var(--fg-tertiary); font-size: 13px; }
    .ar-placeholder lucide-icon { opacity: .3; }
    .ar-rep-head { display: flex; flex-direction: column; gap: 2px; }
    .ar-rep-head h3 { font-size: 16px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .ar-rep-meta { font-size: 11.5px; color: var(--fg-tertiary); }
    .ar-summary { font-size: 13.5px; line-height: 1.6; color: var(--fg-secondary); background: var(--bg-primary); padding: 12px; border-radius: 10px; }
    .ar-block { display: flex; flex-direction: column; gap: 7px; }
    .ar-block h4 { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: var(--fg-primary); margin: 4px 0 0; }
    .ar-block h4 lucide-icon { color: var(--fg-tertiary); }
    .ar-text { font-size: 13px; line-height: 1.6; color: var(--fg-secondary); }
    .ar-friction { display: flex; flex-direction: column; gap: 2px; padding: 9px 11px; border-radius: 9px; background: var(--bg-primary); border-left: 3px solid var(--fg-tertiary); }
    .ar-friction[data-sev="high"] { border-left-color: #f87171; }
    .ar-friction[data-sev="medium"] { border-left-color: #fbbf24; }
    .ar-friction[data-sev="low"] { border-left-color: #38bdf8; }
    .ar-friction-t { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
    .ar-friction-d { font-size: 12px; color: var(--fg-secondary); line-height: 1.5; }
    .ar-adopt { display: flex; flex-direction: column; gap: 8px; }
    .ar-adopt-l { font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .ar-adopt-l--ok { color: var(--tracky-light); }
    .ar-adopt-l--no { color: #f87171; }
    .ar-chips { display: inline-flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
    .ar-chip { font-size: 11.5px; padding: 3px 9px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .ar-chip--ok { background: rgba(16,224,160,.12); color: var(--tracky-light); }
    .ar-chip--no { background: rgba(239,68,68,.1); color: #f87171; }
    .ar-dim { color: var(--fg-tertiary); font-size: 12px; }
    .ar-note { font-size: 12px; color: var(--fg-tertiary); font-style: italic; }
    .ar-reco { display: flex; flex-direction: column; gap: 2px; padding: 9px 11px; border-radius: 9px; background: rgba(56,189,248,.06); }
    .ar-reco-t { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
    .ar-reco-imp { font-size: 10px; font-weight: 800; text-transform: uppercase; color: #38bdf8; margin-left: 6px; }
    .ar-reco-d { font-size: 12px; color: var(--fg-secondary); line-height: 1.5; }
    .ar-rep-foot { font-size: 11px; color: var(--fg-tertiary); border-top: 1px solid var(--border-subtle); padding-top: 8px; }
    .ar-alert { display: flex; align-items: center; gap: 8px; padding: 11px; border-radius: 10px; background: rgba(239,68,68,.1); color: #f87171; font-size: 13px; }

    .ar-sched { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
    .ar-switch { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--fg-secondary); font-weight: 600; }
    .ar-switch input { width: 16px; height: 16px; accent-color: var(--tracky-light); }
    .ar-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--fg-tertiary); }
    .ar-field select { padding: 8px 10px; border-radius: 8px; background: var(--bg-primary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 13px; }
    .ar-skel { height: 60px; border-radius: 10px; background: linear-gradient(90deg, var(--bg-primary), var(--bg-tertiary), var(--bg-primary)); background-size: 200% 100%; animation: ar-sh 1.3s infinite; }
    @keyframes ar-sh { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
    .ar-spin { animation: ar-spin 1s linear infinite; }
    @keyframes ar-spin { to { transform: rotate(360deg) } }
  `],
})
export class ActivityReportsComponent implements OnInit {
  private readonly api = inject(ActivityReportApiService);
  private readonly usersApi = inject(UsersApiService);
  private readonly toast = inject(ToastService);

  protected readonly SparkIcon = Sparkles;
  protected readonly LoaderIcon = Loader;
  protected readonly SearchIcon = Search;
  protected readonly CheckIcon = Check;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly ClockIcon = Clock;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly FileIcon = FileText;
  protected readonly FrictionIcon = TrendingDown;
  protected readonly AdoptIcon = ThumbsUp;
  protected readonly RecoIcon = Lightbulb;
  protected readonly SchedIcon = CalendarClock;
  protected readonly CopyIcon = Copy;
  protected readonly TrashIcon = Trash2;
  protected readonly UsersI = UsersIcon;

  protected readonly users = signal<TrackyUser[]>([]);
  protected readonly search = signal('');
  protected readonly selected = signal<Set<string>>(new Set());
  protected readonly period = signal<Period>('7d');
  protected readonly customFrom = signal('');
  protected readonly customTo = signal('');
  protected readonly generating = signal(false);

  protected readonly canGenerate = computed(() => {
    if (this.selected().size === 0 || this.generating()) return false;
    if (this.period() !== 'custom') return true;
    const f = this.customFrom();
    const t = this.customTo();
    return !!f && !!t && f <= t;
  });

  protected readonly reports = signal<ActivityReportListItemDto[]>([]);
  protected readonly current = signal<ActivityReportDto | null>(null);
  protected readonly loadingDetail = signal(false);

  protected readonly schedule = signal<ActivityReportScheduleDto | null>(null);
  protected readonly savingSchedule = signal(false);
  private schedDraft: Partial<ActivityReportScheduleDto> = {};

  protected readonly filteredUsers = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.users();
    if (!q) return list;
    return list.filter((u) => this.name(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  });

  async ngOnInit(): Promise<void> {
    try {
      const [{ users }] = await Promise.all([this.usersApi.findAll()]);
      this.users.set(users);
    } catch { /* silencieux */ }
    await Promise.all([this.loadList(), this.loadSchedule()]);
  }

  protected name(u: TrackyUser): string {
    return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
  }

  protected toggle(id: string): void {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.selected.set(next);
  }

  protected async generate(): Promise<void> {
    const userIds = [...this.selected()];
    if (!this.canGenerate()) return;
    let from: string;
    let to: string | undefined;
    if (this.period() === 'custom') {
      from = new Date(this.customFrom()).toISOString();
      // Borne de fin EXCLUSIVE au lendemain minuit : un seul jour (from = to) reste valide.
      to = new Date(new Date(this.customTo()).getTime() + 86_400_000).toISOString();
    } else {
      const days = this.period() === '7d' ? 7 : 30;
      from = new Date(Date.now() - days * 86_400_000).toISOString();
    }
    this.generating.set(true);
    try {
      const report = await firstValueFrom(this.api.generate({ userIds, from, to }));
      this.current.set(report);
      await this.loadList();
      if (report.status === 'FAILED') this.toast.error('Rapport en échec', report.error ?? undefined);
      else this.toast.success('Rapport généré', report.title ?? undefined);
    } catch (e) {
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.generating.set(false);
    }
  }

  protected async loadList(): Promise<void> {
    try {
      this.reports.set(await firstValueFrom(this.api.list(40)));
    } catch { /* silencieux */ }
  }

  protected async open(id: string): Promise<void> {
    this.loadingDetail.set(true);
    try {
      this.current.set(await firstValueFrom(this.api.get(id)));
    } catch (e) {
      this.toast.error('Chargement', this.errMsg(e));
    } finally {
      this.loadingDetail.set(false);
    }
  }

  private async loadSchedule(): Promise<void> {
    try {
      this.schedule.set(await firstValueFrom(this.api.getSchedule()));
    } catch { /* silencieux */ }
  }

  protected patchSchedule(p: Partial<ActivityReportScheduleDto>): void {
    this.schedDraft = { ...this.schedDraft, ...p };
    const s = this.schedule();
    if (s) this.schedule.set({ ...s, ...p });
  }

  protected async saveSchedule(): Promise<void> {
    const s = this.schedule();
    if (!s || this.savingSchedule()) return;
    this.savingSchedule.set(true);
    try {
      const saved = await firstValueFrom(this.api.setSchedule({ enabled: s.enabled, frequency: s.frequency as ActivityReportFrequency, scope: s.scope as ActivityReportScope }));
      this.schedule.set(saved);
      this.schedDraft = {};
      this.toast.success('Planification enregistrée', saved.enabled ? `${saved.frequency}` : 'Désactivée');
    } catch (e) {
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.savingSchedule.set(false);
    }
  }

  protected statusLabel(s: string): string {
    return s === 'READY' ? 'Prêt' : s === 'FAILED' ? 'Échec' : 'En cours';
  }

  /** Supprime un rapport (avec confirmation navigateur — action rare, super-admin). */
  protected async remove(id: string, ev: Event): Promise<void> {
    ev.stopPropagation();
    if (!confirm('Supprimer ce rapport ? (définitif)')) return;
    try {
      await firstValueFrom(this.api.delete(id));
      if (this.current()?.id === id) this.current.set(null);
      await this.loadList();
      this.toast.success('Rapport supprimé');
    } catch (e) {
      this.toast.error('Suppression impossible', this.errMsg(e));
    }
  }

  /** Copie le rapport courant en Markdown (partage client / équipe). */
  protected async copyMarkdown(r: ActivityReportDto): Promise<void> {
    const c = r.content;
    if (!c) return;
    const md = [
      `# ${r.title ?? 'Rapport d\'activité'}`,
      ``,
      `_Période : ${r.from.slice(0, 10)} → ${r.to.slice(0, 10)} · ${r.targets.length} utilisateur(s)_`,
      ``,
      `## Synthèse`,
      c.summary,
      ``,
      `## Parcours`,
      c.journey,
      ...(c.perUser?.length
        ? [``, `## Par utilisateur`, ...c.perUser.map((p) => `- **${p.name}** : ${p.highlight}${p.mainFriction ? ` _(friction : ${p.mainFriction})_` : ''}`)]
        : []),
      ``,
      `## Points de friction`,
      ...(c.frictionPoints.length ? c.frictionPoints.map((f) => `- **${f.title}**${f.severity ? ` (${f.severity})` : ''} — ${f.detail}`) : ['_Aucun._']),
      ``,
      `## Adoption`,
      `- Utilisé : ${c.adoption.used.join(', ') || '—'}`,
      `- Ignoré : ${c.adoption.ignored.join(', ') || '—'}`,
      ...(c.adoption.note ? [`- Note : ${c.adoption.note}`] : []),
      ``,
      `## Recommandations`,
      ...(c.recommendations.length ? c.recommendations.map((x) => `- **${x.title}**${x.impact ? ` [${x.impact}]` : ''} — ${x.detail}`) : ['_Aucune._']),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(md);
      this.toast.success('Rapport copié (Markdown)');
    } catch {
      this.toast.error('Copie impossible');
    }
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string } | null)?.message;
      if (m) return Array.isArray(m) ? m.join(', ') : m;
      return `Erreur (${e.status}).`;
    }
    return 'Une erreur est survenue.';
  }
}
