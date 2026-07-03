import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { LucideAngularModule, Plus, ClipboardList, ChevronRight, X, ArrowLeft } from 'lucide-angular';
import type { InstallationPlanSummaryDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { FleetsApiService, type FleetSummary } from '../../core/services/fleets.service';
import { InstallationsApiService } from '../../core/services/installations.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { formatDateFr, PLAN_STATUS_CLASS, PLAN_STATUS_LABELS } from './installation-ui';

/**
 * V1.15 — Liste des plannings d'installation (operateur SUPER_ADMIN).
 * Accessible via le hub admin → /admin/installations.
 */
@Component({
  selector: 'app-installations-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LucideAngularModule],
  template: `
    <div class="ip">
      <div class="ip-head">
        <div>
          <a routerLink="/admin" class="ip-back">
            <lucide-icon [img]="ArrowLeftIcon" [size]="14"></lucide-icon> Administration
          </a>
          <h1>Plannings d'installation</h1>
          <p class="ip-sub">{{ plans().length }} planning(s)</p>
        </div>
        <button class="ip-add" (click)="openCreate()">
          <lucide-icon [img]="PlusIcon" [size]="15"></lucide-icon> Nouveau plan
        </button>
      </div>

      @if (loading()) {
        <div class="ip-loading"><span class="spinner"></span></div>
      } @else if (plans().length === 0) {
        <div class="ip-empty">
          <div class="ip-empty-ico"><lucide-icon [img]="ClipboardListIcon" [size]="30"></lucide-icon></div>
          <p>Aucun planning d'installation</p>
          <button class="ip-empty-cta" (click)="openCreate()">Créer le premier planning</button>
        </div>
      } @else {
        <div class="ip-grid">
          @for (p of plans(); track p.id) {
            <a class="ip-card" [routerLink]="['/admin/installations', p.id]">
              <span class="ip-accent"></span>
              <div class="ip-card-top">
                <div>
                  <p class="ip-client">{{ p.clientName }}</p>
                  @if (p.startDate || p.endDate) {
                    <p class="ip-period">{{ formatDate(p.startDate) }} → {{ formatDate(p.endDate) }}</p>
                  }
                </div>
                <span class="ip-status" [class]="statusClass(p)">{{ statusLabel(p) }}</span>
              </div>
              @if (p.description) { <p class="ip-desc">{{ p.description }}</p> }
              <div class="ip-progress">
                <div class="ip-bar"><span [style.width.%]="pct(p)"></span></div>
                <span class="ip-count">{{ p.doneCount }}/{{ p.totalCount }} posés</span>
                <lucide-icon [img]="ChevronRightIcon" [size]="16" class="ip-chev"></lucide-icon>
              </div>
            </a>
          }
        </div>
      }
    </div>

    @if (showCreate()) {
      <div class="ov" (click)="closeCreate()">
        <div class="ov-panel" (click)="$event.stopPropagation()">
          <div class="ov-head">
            <h2>Nouveau planning</h2>
            <button class="ov-x" (click)="closeCreate()"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
          </div>
          <div class="ov-body">
            @if (createError()) { <div class="ov-err">{{ createError() }}</div> }
            <label class="fl">Flotte cliente *</label>
            @if (fleetsLoading()) {
              <p class="fl-hint">Chargement des flottes…</p>
            } @else {
              <select class="fi" [(ngModel)]="fleetId">
                <option value="" disabled>Sélectionnez une flotte</option>
                @for (f of fleets(); track f.id) { <option [value]="f.id">{{ f.name }}</option> }
              </select>
            }
            <label class="fl">Nom du client *</label>
            <input class="fi" [(ngModel)]="clientName" placeholder="CDEF 31 — Centre Dép. de l'Enfant" maxlength="200" />
            <label class="fl">Adresse</label>
            <input class="fi" [(ngModel)]="clientAddress" placeholder="425 rte de Launaguet, 31200 Toulouse" maxlength="300" />
            <label class="fl">Prestation / description</label>
            <input class="fi" [(ngModel)]="description" placeholder="Pose traceurs + coupure moteur · 27 véhicules" maxlength="500" />
            <div class="fl-row">
              <div>
                <label class="fl">Début</label>
                <input class="fi" type="date" [(ngModel)]="startDate" />
              </div>
              <div>
                <label class="fl">Fin</label>
                <input class="fi" type="date" [(ngModel)]="endDate" />
              </div>
            </div>
          </div>
          <div class="ov-foot">
            <button class="btn-ghost" (click)="closeCreate()">Annuler</button>
            <button class="btn-primary" [disabled]="creating() || !fleetId || !clientName.trim()" (click)="create()">
              @if (creating()) { <span class="spinner sm"></span> } Créer
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block }
    .ip { max-width: 980px }
    .ip-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 24px }
    .ip-back { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-tertiary); text-decoration: none; margin-bottom: 6px }
    .ip-back:hover { color: var(--tracky-light) }
    .ip-head h1 { font-family: var(--font-display, Poppins, sans-serif); font-size: 24px; font-weight: 800; color: var(--fg-primary); margin: 0 }
    .ip-sub { font-size: 13px; color: var(--fg-tertiary); margin: 4px 0 0 }
    .ip-add { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border-radius: 10px; font-size: 12px; font-weight: 700; background: var(--tracky-light); color: var(--accent-ink); border: none; cursor: pointer; box-shadow: var(--shadow-tracky-glow); transition: filter .15s }
    .ip-add:hover { filter: brightness(1.05) }

    .ip-loading { display: flex; justify-content: center; padding: 60px 0 }
    .spinner { width: 22px; height: 22px; border: 2px solid var(--border-subtle); border-top-color: var(--tracky-light); border-radius: 50%; animation: sp 0.7s linear infinite; display: inline-block }
    .spinner.sm { width: 14px; height: 14px; border-width: 2px }
    @keyframes sp { to { transform: rotate(360deg) } }

    .ip-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 50px 20px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary) }
    .ip-empty-ico { width: 58px; height: 58px; border-radius: 16px; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center }
    .ip-empty-cta { font-size: 13px; color: var(--tracky-light); background: none; border: none; cursor: pointer; text-decoration: underline }

    .ip-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px }
    .ip-card { position: relative; overflow: hidden; display: block; padding: 18px 20px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); text-decoration: none; transition: transform .25s, border-color .25s, box-shadow .3s }
    .ip-card:hover { transform: translateY(-2px); border-color: rgba(16,224,160,.25); box-shadow: 0 10px 30px rgba(0,0,0,.15) }
    .ip-accent { position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, #10e0a0, #34d399); border-radius: 14px 14px 0 0 }
    .ip-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px }
    .ip-client { font-size: 15px; font-weight: 700; color: var(--fg-primary) }
    .ip-period { font-size: 11px; color: var(--fg-tertiary); margin-top: 3px; font-family: var(--font-mono, monospace) }
    .ip-desc { font-size: 12px; color: var(--fg-tertiary); margin: 10px 0 0; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden }
    .ip-progress { display: flex; align-items: center; gap: 10px; margin-top: 14px }
    .ip-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden }
    .ip-bar span { display: block; height: 100%; background: linear-gradient(90deg, #10e0a0, #34d399); border-radius: 3px; transition: width .4s }
    .ip-count { font-size: 11px; font-weight: 600; color: var(--fg-secondary); white-space: nowrap }
    .ip-chev { color: var(--fg-tertiary) }

    .ip-status { font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 6px; white-space: nowrap; flex-shrink: 0 }
    .st-draft { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .st-published { background: rgba(59,130,246,.12); color: #60a5fa }
    .st-progress { background: rgba(245,158,11,.12); color: #fbbf24 }
    .st-done { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .st-cancel { background: rgba(239,68,68,.12); color: #f87171 }

    /* overlay */
    .ov { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); backdrop-filter: blur(4px); padding: 16px }
    .ov-panel { width: 100%; max-width: 460px; background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; max-height: 90vh; max-height: 90dvh }
    .ov-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-subtle) }
    .ov-head h2 { font-size: 16px; font-weight: 700; color: var(--fg-primary) }
    .ov-x { padding: 6px; border-radius: 8px; background: none; border: none; color: var(--fg-tertiary); cursor: pointer }
    .ov-x:hover { color: var(--fg-primary); background: var(--bg-tertiary) }
    .ov-body { padding: 18px 20px; overflow-y: auto }
    .ov-err { padding: 10px 12px; border-radius: 10px; background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.2); color: #f87171; font-size: 12px; margin-bottom: 12px }
    .ov-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border-subtle) }
    .fl { display: block; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); margin: 12px 0 4px }
    .fl:first-child { margin-top: 0 }
    .fl-hint { font-size: 12px; color: var(--fg-tertiary) }
    .fl-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px }
    .fi { width: 100%; padding: 9px 12px; background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); border-radius: 10px; color: var(--fg-primary); font-size: 13px; outline: none }
    .fi:focus { border-color: var(--tracky) }
    .btn-ghost { padding: 9px 16px; border-radius: 10px; font-size: 12px; font-weight: 600; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer }
    /* .btn-primary : styles globaux (styles.css) */
  `],
})
export class InstallationsListComponent implements OnInit {
  private readonly api = inject(InstallationsApiService);
  private readonly fleetsApi = inject(FleetsApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly PlusIcon = Plus;
  protected readonly ClipboardListIcon = ClipboardList;
  protected readonly ChevronRightIcon = ChevronRight;
  protected readonly XIcon = X;
  protected readonly ArrowLeftIcon = ArrowLeft;

  readonly loading = signal(true);
  readonly plans = signal<InstallationPlanSummaryDto[]>([]);

  readonly showCreate = signal(false);
  readonly creating = signal(false);
  readonly createError = signal('');
  readonly fleets = signal<FleetSummary[]>([]);
  readonly fleetsLoading = signal(false);

  protected fleetId = '';
  protected clientName = '';
  protected clientAddress = '';
  protected description = '';
  protected startDate = '';
  protected endDate = '';

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  protected formatDate = formatDateFr;
  protected statusLabel(p: InstallationPlanSummaryDto): string {
    return PLAN_STATUS_LABELS[p.status];
  }
  protected statusClass(p: InstallationPlanSummaryDto): string {
    return PLAN_STATUS_CLASS[p.status];
  }
  protected pct(p: InstallationPlanSummaryDto): number {
    return p.totalCount > 0 ? Math.round((p.doneCount / p.totalCount) * 100) : 0;
  }

  protected async openCreate(): Promise<void> {
    this.showCreate.set(true);
    if (this.fleets().length === 0) {
      this.fleetsLoading.set(true);
      try {
        const list = await firstValueFrom(this.fleetsApi.list());
        this.fleets.set(list);
      } catch {
        this.createError.set('Impossible de charger les flottes');
      } finally {
        this.fleetsLoading.set(false);
      }
    }
  }

  protected closeCreate(): void {
    if (this.creating()) return;
    this.showCreate.set(false);
    this.createError.set('');
  }

  protected async create(): Promise<void> {
    this.creating.set(true);
    this.createError.set('');
    try {
      const plan = await this.api.create({
        fleetId: this.fleetId,
        clientName: this.clientName.trim(),
        clientAddress: this.clientAddress.trim() || null,
        description: this.description.trim() || null,
        startDate: this.startDate || null,
        endDate: this.endDate || null,
      });
      this.toast.success('Planning créé');
      this.router.navigate(['/admin/installations', plan.id]);
    } catch (err) {
      this.createError.set(this.errMsg(err));
    } finally {
      this.creating.set(false);
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.plans.set(await this.api.list());
    } catch (err) {
      this.toast.error('Échec de chargement', this.errMsg(err));
    } finally {
      this.loading.set(false);
    }
  }

  private errMsg(err: unknown): string {
    const e = err as { error?: { message?: string | string[] }; message?: string };
    const m = e?.error?.message;
    if (Array.isArray(m)) return m.join(', ');
    return m ?? e?.message ?? 'Erreur inconnue';
  }
}
