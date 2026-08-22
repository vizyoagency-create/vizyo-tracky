import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, CdkDropListGroup,
  moveItemInArray, transferArrayItem,
} from '@angular/cdk/drag-drop';
import {
  LucideAngularModule, ChevronUp, ChevronDown, ChevronLeft, CalendarDays, Info, GripVertical,
} from 'lucide-angular';
import type {
  InstallationEnergy, InstallationPlanDto, InstallationPlanSummaryDto, InstallationTaskDto,
} from '@vizyo/tracky-shared';
import { InstallationsApiService } from '../../core/services/installations.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ZoneComponent, type EtatZone } from '../../shared/ui/zone/zone.component';
import {
  DayGroup, distinctDays, ENERGY_LABELS, formatDateFr, groupByDay, installState,
  PLAN_STATUS_CLASS, PLAN_STATUS_LABELS, TASK_STATUS_LABELS, weekdayFr,
} from './installation-ui';

/**
 * V1.15 — Vue client (FLEET_ADMIN) du planning d'installation.
 * Lecture seule des informations + reordonnancement autorise du sens d'installation
 * (deplacer les vehicules / changer de jour). Le serveur n'expose que les plans
 * publies de la flotte du client.
 */
@Component({
  selector: 'app-installations-client',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule, CdkDropListGroup, CdkDropList, CdkDrag, CdkDragHandle, ZoneComponent],
  template: `
    <div class="cl">
      <div class="cl-head">
        <span class="vt-eyebrow">Déploiement</span>
        <h1>Suivi d'installation.</h1>
        <p class="cl-sub">Planning de pose de vos boîtiers GPS par nos techniciens.</p>
      </div>

      <!-- Les trois etats non nominaux passent par <app-zone> : « vide » ne peut plus
           absorber « erreur ». Avant, une API tombee laissait l'ecran annoncer
           « Aucun planning publie » — cf. le commentaire de ngOnInit. -->
      @if (etatZone() !== 'rempli') {
        <app-zone [etat]="etatZone()" quoi="votre planning d'installation"
                  vide="Aucun planning d'installation publié pour le moment"
                  videDetail="Nos techniciens n'ont pas encore publié de date de pose. Vous serez prévenu dès qu'un créneau est fixé."
                  erreur="Impossible de charger votre planning"
                  erreurDetail="Un planning est peut-être publié : c'est son chargement qui a échoué."
                  (reessayer)="recharger()" />
      } @else if (plan(); as p) {
        @if (plans().length > 1) {
          <button class="cl-back" (click)="backToList()">
            <lucide-icon [img]="ChevronLeftIcon" [size]="14"></lucide-icon> Tous les plannings
          </button>
        }

        <div class="cl-card cl-plan">
          <div class="cl-plan-top">
            <div>
              <h2>{{ p.clientName }}</h2>
              @if (p.clientAddress) { <p class="cl-addr">{{ p.clientAddress }}</p> }
              @if (p.description) { <p class="cl-desc">{{ p.description }}</p> }
              @if (p.startDate || p.endDate) {
                <p class="cl-period"><lucide-icon [img]="CalendarDaysIcon" [size]="13"></lucide-icon> {{ fmt(p.startDate) }} → {{ fmt(p.endDate) }}</p>
              }
            </div>
            <span class="st" [class]="statusClass(p.status)">{{ statusLabel(p.status) }}</span>
          </div>
          <div class="cl-progress">
            <div class="cl-bar"><span [style.width.%]="pct(p)"></span></div>
            <span class="cl-count">{{ p.doneCount }}/{{ p.totalCount }} posés</span>
          </div>
          <p class="cl-hint"><lucide-icon [img]="InfoIcon" [size]="12"></lucide-icon> Glissez-déposez les véhicules (ou utilisez les flèches) pour réordonner le passage, et changez un véhicule de jour.</p>
        </div>

        <div cdkDropListGroup>
        @for (g of daysView(); track g.date) {
          <div class="day">
            <div class="day-head">
              <span class="day-d">{{ g.date ? fmt(g.date) : 'Non planifié' }}</span>
              @if (g.date) { <span class="day-wd">{{ weekday(g.date) }}</span> }
              @if (g.theme) { <span class="day-theme">{{ g.theme }}</span> }
              <span class="day-n">{{ g.tasks.length }} véh.</span>
            </div>
            <div class="rows" cdkDropList [cdkDropListData]="g.tasks" [cdkDropListDisabled]="reordering()" (cdkDropListDropped)="onDrop($event)">
              @for (t of g.tasks; track t.id; let i = $index) {
                <div class="row" [class.done]="t.status === 'DONE'" cdkDrag [cdkDragData]="t">
                  <div class="row-order">
                    <button class="drag-handle" cdkDragHandle type="button" title="Glisser pour réordonner" aria-label="Glisser pour réordonner">
                      <lucide-icon [img]="GripVerticalIcon" [size]="14"></lucide-icon>
                    </button>
                    <button class="ord-btn" [disabled]="i === 0 || reordering()" (click)="moveUp(g, i)" title="Monter">
                      <lucide-icon [img]="ChevronUpIcon" [size]="13"></lucide-icon>
                    </button>
                    <span class="ord-n">{{ i + 1 }}</span>
                    <button class="ord-btn" [disabled]="i === g.tasks.length - 1 || reordering()" (click)="moveDown(g, i)" title="Descendre">
                      <lucide-icon [img]="ChevronDownIcon" [size]="13"></lucide-icon>
                    </button>
                  </div>
                  <div class="row-main">
                    <div class="row-line1">
                      <span class="plate">{{ t.plate }}</span>
                      <span class="model">{{ t.brand }} {{ t.model }}</span>
                      @if (t.energy) { <span class="energy">{{ energyLabel(t.energy) }}</span> }
                      <span class="tstatus" [class]="'ts-' + t.status.toLowerCase()">{{ taskStatusLabel(t.status) }}</span>
                      @if (instBadge(t); as b) { <span class="inst" [class]="'inst-' + b.cls">{{ b.label }}</span> }
                    </div>
                    @if (t.cutoffProcedure) { <p class="row-proc">{{ t.cutoffProcedure }}</p> }
                    <div class="row-meta">
                      @if (t.firstRegistrationDate) { <span>1ère MEC {{ fmt(t.firstRegistrationDate) }}</span> }
                      @if (t.imei) { <span class="mono">IMEI {{ t.imei }}</span> }
                      @if (t.simNumber) { <span class="mono">SIM {{ t.simNumber }}</span> }
                      @if (t.installedAt) { <span>Posé {{ dateTime(t.installedAt) }}</span> }
                    </div>
                  </div>
                  <select class="day-move" [ngModel]="t.scheduledDate ?? ''" (ngModelChange)="moveToDay(t, $event)"
                    [disabled]="reordering()" title="Changer de jour">
                    <option value="">Non planifié</option>
                    @for (d of days(); track d) { <option [value]="d">{{ fmt(d) }}</option> }
                  </select>
                </div>
              }
            </div>
          </div>
        }
        </div>
      } @else {
        <!-- Liste (plusieurs plannings) -->
        <div class="cl-grid">
          @for (p of plans(); track p.id) {
            <button class="cl-item" (click)="select(p.id)">
              <div>
                <p class="cl-item-name">{{ p.clientName }}</p>
                @if (p.startDate || p.endDate) { <p class="cl-item-period">{{ fmt(p.startDate) }} → {{ fmt(p.endDate) }}</p> }
              </div>
              <span class="st" [class]="statusClass(p.status)">{{ statusLabel(p.status) }}</span>
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    /* Cibles tactiles au doigt — critère de recette « iPhone 390 px : cibles ≥ 44 px ».
       Mesuré à 375 px : 54 boutons de réordonnancement et 27 poignées de glisser-déposer.
       C'est la page où l'on ORGANISE une tournée d'installation, debout, sur le terrain :
       la précision au pouce y est le premier besoin, pas le dernier.
       (La même correction vit dans installation-editor : les deux écrans partagent les
       classes mais pas la feuille de styles — l'encapsulation Angular les sépare.) */
    @media (max-width: 768px) {
      .ord-btn, .cdk-drag-handle { min-width: 44px; min-height: 44px }
    }
    :host { display: block }
    .cl { max-width: 980px }
    .cl-head h1 { font-family: var(--font-display); font-size: 1.72rem; font-weight: 800; letter-spacing: -.03em; line-height: 1.1; color: var(--fg-primary); margin: 8px 0 0 }
    .cl-sub { font-size: 14px; color: var(--fg-tertiary); margin: 8px 0 20px }
    /* .cl-loading, .cl-empty et .cl-empty-ico sont parties avec le spinner et le
       bloc « vide » maison : <app-zone> rend les trois etats. Les laisser aurait
       fait trois regles mortes de plus (cf. le § « regles CSS qui cessent de
       s'appliquer »). */
    .cl-back { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-tertiary); background: none; border: none; cursor: pointer; margin-bottom: 12px }
    .cl-back:hover { color: var(--tracky-light) }

    .cl-card { padding: 20px 22px; border-radius: 18px; background: var(--bg-secondary); border: 1px solid var(--border-subtle) }
    .cl-plan { margin-bottom: 18px }
    .cl-plan-top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start }
    .cl-plan-top h2 { font-family: var(--font-display); font-size: 19px; font-weight: 800; color: var(--fg-primary); margin: 0 }
    .cl-addr { font-size: 12px; color: var(--fg-tertiary); margin-top: 4px }
    .cl-desc { font-size: 13px; color: var(--fg-secondary); margin-top: 6px }
    .cl-period { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-tertiary); margin-top: 8px; font-family: var(--font-mono, monospace) }
    .cl-progress { display: flex; align-items: center; gap: 10px; margin-top: 14px }
    .cl-bar { flex: 1; height: 7px; border-radius: 4px; background: var(--bg-tertiary); overflow: hidden }
    .cl-bar span { display: block; height: 100%; background: linear-gradient(90deg, #10e0a0, #34d399); transition: width .4s }
    .cl-count { font-size: 11px; font-weight: 700; color: var(--fg-secondary); white-space: nowrap }
    .cl-hint { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-tertiary); margin-top: 12px }

    .st { font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 6px; white-space: nowrap; flex-shrink: 0 }
    .st-draft { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .st-published { background: color-mix(in srgb, var(--blue) 12%, transparent); color: var(--texte-info) }
    .st-progress { background: color-mix(in srgb, var(--warning) 12%, transparent); color: var(--texte-attente) }
    .st-done { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .st-cancel { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--texte-alerte) }

    .day { margin-bottom: 16px }
    .day-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; flex-wrap: wrap }
    .day-d { font-size: 14px; font-weight: 700; color: var(--fg-primary) }
    .day-wd { font-size: 11px; color: var(--fg-tertiary); text-transform: capitalize }
    .day-theme { font-size: 12px; color: var(--fg-secondary); font-style: italic }
    .day-n { font-size: 10px; color: var(--fg-tertiary); background: var(--bg-tertiary); padding: 2px 7px; border-radius: 5px }

    .rows { display: flex; flex-direction: column; gap: 8px }
    .row { display: flex; gap: 12px; padding: 12px 14px; border-radius: 12px; background: var(--bg-secondary); border: 1px solid var(--border-subtle) }
    .row.done { border-color: rgba(16,224,160,.18) }
    .row-order { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0 }
    .ord-btn { width: 22px; height: 18px; display: flex; align-items: center; justify-content: center; border-radius: 5px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); cursor: pointer }
    .ord-btn:disabled { opacity: .3; cursor: default }
    .ord-btn:not(:disabled):hover { color: var(--tracky-light) }
    .ord-n { font-size: 11px; font-weight: 700; color: var(--fg-tertiary) }
    .drag-handle { width: 22px; height: 18px; display: flex; align-items: center; justify-content: center; border-radius: 5px; background: transparent; border: none; color: var(--fg-tertiary); cursor: grab; touch-action: none }
    .drag-handle:hover { color: var(--tracky-light) }
    .drag-handle:active { cursor: grabbing }
    .row.cdk-drag-preview { box-shadow: 0 12px 32px rgba(0,0,0,.32); border-color: var(--tracky); background: var(--bg-secondary) }
    .cdk-drag-placeholder { opacity: .35 }
    .cdk-drag-animating { transition: transform .2s cubic-bezier(0,0,.2,1) }
    .rows.cdk-drop-list-dragging .row:not(.cdk-drag-placeholder) { transition: transform .2s cubic-bezier(0,0,.2,1) }
    .rows.cdk-drop-list-receiving { outline: 2px dashed rgba(16,224,160,.4); outline-offset: 4px; border-radius: 12px }
    .row-main { flex: 1; min-width: 0 }
    .row-line1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
    .plate { font-family: var(--font-mono, monospace); font-weight: 700; font-size: 13px; color: var(--fg-primary) }
    .model { font-size: 12px; color: var(--fg-secondary) }
    .energy { font-size: 10px; color: var(--fg-tertiary); background: var(--bg-tertiary); padding: 2px 7px; border-radius: 5px }
    .tstatus { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 5px }
    .ts-pending { background: color-mix(in srgb, var(--warning) 12%, transparent); color: var(--texte-attente) }
    .ts-done { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .ts-skipped { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .inst { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 5px }
    .inst-installed { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .inst-no-sim { background: color-mix(in srgb, var(--warning) 12%, transparent); color: var(--texte-attente) }
    .row-proc { font-size: 11px; color: var(--fg-tertiary); margin-top: 5px; line-height: 1.4 }
    .row-meta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; font-size: 11px; color: var(--fg-tertiary) }
    .row-meta .mono { font-family: var(--font-mono, monospace) }
    .day-move { align-self: flex-start; padding: 5px 8px; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); font-size: 11px; outline: none; max-width: 120px }

    .cl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px }
    .cl-item { display: flex; justify-content: space-between; align-items: center; gap: 10px; text-align: left; padding: 16px 18px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); cursor: pointer }
    .cl-item:hover { border-color: rgba(16,224,160,.25) }
    .cl-item-name { font-size: 14px; font-weight: 700; color: var(--fg-primary) }
    .cl-item-period { font-size: 11px; color: var(--fg-tertiary); margin-top: 3px; font-family: var(--font-mono, monospace) }
  `],
})
export class InstallationsClientComponent implements OnInit {
  private readonly api = inject(InstallationsApiService);
  private readonly toast = inject(ToastService);

  protected readonly ChevronUpIcon = ChevronUp;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly ChevronLeftIcon = ChevronLeft;
  protected readonly CalendarDaysIcon = CalendarDays;
  protected readonly InfoIcon = Info;
  protected readonly GripVerticalIcon = GripVertical;

  readonly loading = signal(true);
  readonly plans = signal<InstallationPlanSummaryDto[]>([]);
  readonly plan = signal<InstallationPlanDto | null>(null);
  readonly reordering = signal(false);
  readonly error = signal<string | null>(null);

  /** L'ordre compte : une erreur n'est pas un vide, et prime sur lui. */
  protected readonly etatZone = computed<EtatZone>(() => {
    if (this.loading()) return 'chargement';
    if (this.error()) return 'erreur';
    if (this.plans().length === 0) return 'vide';
    return 'rempli';
  });

  // linkedSignal : re-derive de plan(), writable pour le drag&drop optimiste.
  readonly daysView = linkedSignal<DayGroup[]>(() => {
    const p = this.plan();
    return p ? groupByDay(p.tasks, p.dayThemes) : [];
  });
  readonly days = computed<string[]>(() => {
    const p = this.plan();
    return p ? distinctDays(p.tasks, p.dayThemes) : [];
  });

  async ngOnInit(): Promise<void> {
    await this.recharger();
  }

  /**
   * Le `catch` qui laisse l'ecran mentir — 6e occurrence, 6e ecran sans rapport
   * (SUIVI-REFONTE.md § 8.5), et une VARIANTE : il n'ecrasait pas un tableau, il
   * ne posait RIEN. `plans` restait a sa valeur initiale `[]` et l'erreur partait
   * dans un `toast.error` EPHEMERE.
   *
   * Resultat mesure au navigateur en faisant echouer `api.list()` : la page
   * affichait « Aucun planning d'installation publie pour le moment » — un
   * mensonge rassurant — pendant que le toast passait et disparaissait. Le toast
   * s'efface, le mensonge reste.
   *
   * L'erreur est donc bien SIGNALEE et l'ecran ment quand meme : un toast n'est
   * pas un etat. Il faut POSER l'etat, c'est ce que fait `error`.
   */
  protected async recharger(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const list = await this.api.list();
      this.plans.set(list);
      if (list.length === 1) await this.select(list[0].id);
    } catch (err) {
      this.error.set(this.errMsg(err));
      this.toast.error('Échec de chargement', this.errMsg(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected fmt = formatDateFr;
  protected weekday = weekdayFr;
  protected statusLabel(s: InstallationPlanDto['status']): string { return PLAN_STATUS_LABELS[s]; }
  protected statusClass(s: InstallationPlanDto['status']): string { return PLAN_STATUS_CLASS[s]; }
  protected taskStatusLabel(s: InstallationTaskDto['status']): string { return TASK_STATUS_LABELS[s]; }
  protected energyLabel(e: InstallationEnergy): string { return ENERGY_LABELS[e]; }
  protected pct(p: InstallationPlanDto): number {
    return p.totalCount > 0 ? Math.round((p.doneCount / p.totalCount) * 100) : 0;
  }
  protected dateTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }
  protected instBadge(t: InstallationTaskDto): { cls: string; label: string } | null {
    const s = installState(t.imei, t.simNumber);
    if (s === 'installed') return { cls: 'installed', label: 'Installé' };
    if (s === 'no-sim') return { cls: 'no-sim', label: 'SIM manquante' };
    return null;
  }

  protected async select(id: string): Promise<void> {
    this.loading.set(true);
    try {
      this.plan.set(await this.api.findOne(id));
    } catch (err) {
      this.toast.error('Échec de chargement', this.errMsg(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected backToList(): void {
    this.plan.set(null);
  }

  protected async moveUp(g: DayGroup, i: number): Promise<void> {
    if (i <= 0) return;
    await this.swapOrder(g.tasks[i], g.tasks[i - 1]);
  }
  protected async moveDown(g: DayGroup, i: number): Promise<void> {
    if (i >= g.tasks.length - 1) return;
    await this.swapOrder(g.tasks[i], g.tasks[i + 1]);
  }
  private async swapOrder(a: InstallationTaskDto, b: InstallationTaskDto): Promise<void> {
    const p = this.plan();
    if (!p) return;
    this.reordering.set(true);
    try {
      const np = await this.api.reorder(p.id, {
        tasks: [
          { id: a.id, orderIndex: b.orderIndex },
          { id: b.id, orderIndex: a.orderIndex },
        ],
      });
      this.plan.set(np);
    } catch (err) {
      this.toast.error('Échec réordonnancement', this.errMsg(err));
    } finally {
      this.reordering.set(false);
    }
  }
  protected async moveToDay(t: InstallationTaskDto, newDate: string): Promise<void> {
    const target = newDate || null;
    if ((t.scheduledDate ?? null) === target) return;
    const p = this.plan();
    if (!p) return;
    const sameDay = p.tasks.filter((x) => (x.scheduledDate ?? null) === target);
    const nextOrder = sameDay.reduce((m, x) => Math.max(m, x.orderIndex), -1) + 1;
    this.reordering.set(true);
    try {
      const np = await this.api.reorder(p.id, {
        tasks: [{ id: t.id, orderIndex: nextOrder, scheduledDate: target }],
      });
      this.plan.set(np);
    } catch (err) {
      this.toast.error('Échec', this.errMsg(err));
    } finally {
      this.reordering.set(false);
    }
  }

  /** Glisser-déposer (CDK) : réordonne dans un jour ou déplace vers un autre jour. */
  protected onDrop(event: CdkDragDrop<InstallationTaskDto[]>): void {
    if (this.reordering()) return;
    if (event.previousContainer === event.container) {
      if (event.previousIndex === event.currentIndex) return;
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
    } else {
      transferArrayItem(
        event.previousContainer.data,
        event.container.data,
        event.previousIndex,
        event.currentIndex,
      );
    }
    this.daysView.set(this.daysView().map((g) => ({ ...g, tasks: [...g.tasks] })));
    const tasks = this.daysView().flatMap((g) =>
      g.tasks.map((t, i) => ({ id: t.id, orderIndex: i, scheduledDate: g.date })),
    );
    void this.persistReorder(tasks);
  }

  private async persistReorder(
    tasks: { id: string; orderIndex: number; scheduledDate: string | null }[],
  ): Promise<void> {
    const p = this.plan();
    if (!p) return;
    this.reordering.set(true);
    try {
      const np = await this.api.reorder(p.id, { tasks });
      this.plan.set(np);
    } catch (err) {
      this.toast.error('Échec réordonnancement', this.errMsg(err));
      await this.select(p.id);
    } finally {
      this.reordering.set(false);
    }
  }

  private errMsg(err: unknown): string {
    const e = err as { error?: { message?: string | string[] }; message?: string };
    const m = e?.error?.message;
    if (Array.isArray(m)) return m.join(', ');
    return m ?? e?.message ?? 'Erreur inconnue';
  }
}
