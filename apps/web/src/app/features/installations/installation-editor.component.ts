import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  CdkDrag, CdkDragDrop, CdkDragHandle, CdkDragPlaceholder, CdkDropList, CdkDropListGroup,
  moveItemInArray, transferArrayItem,
} from '@angular/cdk/drag-drop';
import {
  LucideAngularModule, ArrowLeft, Plus, Pencil, Trash2, ChevronUp, ChevronDown,
  Wrench, X, Save, ExternalLink, RefreshCw, Check, CalendarDays, GripVertical,
  Spline, List, ArrowRight, CornerDownLeft, StickyNote, AlertTriangle,
} from 'lucide-angular';
import type {
  InstallationEnergy, InstallationPlanDto, InstallationTaskDto, InstallationTaskStatus,
} from '@vizyo/tracky-shared';
import { InstallationsApiService } from '../../core/services/installations.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import {
  DayGroup, distinctDays, ENERGY_LABELS, ENERGY_OPTIONS, formatDateFr, groupByDay,
  installState, PLAN_STATUS_CLASS, PLAN_STATUS_LABELS, PLAN_STATUS_OPTIONS, TASK_STATUS_LABELS,
  weekdayFr,
} from './installation-ui';

interface TaskForm {
  plate: string; scheduledDate: string; brand: string; model: string;
  energy: InstallationEnergy | ''; firstRegistrationDate: string;
  cutoffProcedure: string; status: InstallationTaskStatus; fieldNotes: string;
}

@Component({
  selector: 'app-installation-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LucideAngularModule, ConfirmModalComponent, CdkDropListGroup, CdkDropList, CdkDrag, CdkDragHandle, CdkDragPlaceholder],
  template: `
    <div class="ed">
      <a routerLink="/admin/installations" class="ed-back">
        <lucide-icon [img]="ArrowLeftIcon" [size]="14"></lucide-icon> Plannings
      </a>

      @if (loading()) {
        <div class="ed-loading"><span class="spinner"></span></div>
      } @else if (plan(); as p) {
        <!-- ── HEADER ── -->
        <div class="ed-head">
          <div class="ed-head-main">
            <div class="ed-title-row">
              <h1>{{ p.clientName }}</h1>
              <span class="st" [class]="statusClass(p.status)">{{ statusLabel(p.status) }}</span>
            </div>
            @if (p.clientAddress) { <p class="ed-addr">{{ p.clientAddress }}</p> }
            @if (p.description) { <p class="ed-desc">{{ p.description }}</p> }
            @if (p.startDate || p.endDate) {
              <p class="ed-period">
                <lucide-icon [img]="CalendarDaysIcon" [size]="13"></lucide-icon>
                {{ fmt(p.startDate) }} → {{ fmt(p.endDate) }}
              </p>
            }
          </div>
          <div class="ed-head-side">
            <div class="ed-progress">
              <div class="ed-bar"><span [style.width.%]="pct(p)"></span></div>
              <span class="ed-count">{{ p.doneCount }}/{{ p.totalCount }} posés</span>
            </div>
            <label class="ed-status-lbl">Statut</label>
            <select class="fi" [ngModel]="p.status" (ngModelChange)="changeStatus($event)">
              @for (s of statusOptions; track s) { <option [value]="s">{{ statusLabel(s) }}</option> }
            </select>
            <div class="ed-head-actions">
              <button class="btn-ghost sm" (click)="openEditPlan(p)">
                <lucide-icon [img]="PencilIcon" [size]="13"></lucide-icon> Modifier
              </button>
              <button class="btn-ghost sm danger" (click)="showDeletePlan.set(true)">
                <lucide-icon [img]="Trash2Icon" [size]="13"></lucide-icon>
              </button>
            </div>
          </div>
        </div>

        <!-- ── BASCULE DE VUE : Serpent / Liste (meme plumbing CDK) ── -->
        <div class="vmode">
          <div class="vmode-seg" role="tablist" aria-label="Mode d'affichage du planning">
            <button class="vmode-btn" type="button" role="tab" [class.active]="viewMode() === 'snake'"
              [attr.aria-selected]="viewMode() === 'snake'" (click)="viewMode.set('snake')">
              <lucide-icon [img]="SplineIcon" [size]="14"></lucide-icon> Serpent
            </button>
            <button class="vmode-btn" type="button" role="tab" [class.active]="viewMode() === 'list'"
              [attr.aria-selected]="viewMode() === 'list'" (click)="viewMode.set('list')">
              <lucide-icon [img]="ListIcon" [size]="14"></lucide-icon> Liste
            </button>
          </div>
        </div>

        @if (viewMode() === 'list') {
        <!-- ── DAY GROUPS (glisser-déposer CDK pour réordonner) ── -->
        <div cdkDropListGroup>
        @for (g of daysView(); track g.date) {
          <div class="day">
            <div class="day-head">
              <div class="day-date">
                <span class="day-d">{{ g.date ? fmt(g.date) : 'Non planifié' }}</span>
                @if (g.date) { <span class="day-wd">{{ weekday(g.date) }}</span> }
                <span class="day-n">{{ g.tasks.length }} véh.</span>
              </div>
              @if (g.date) {
                <input class="day-theme" [ngModel]="g.theme ?? ''" (blur)="commitTheme(g.date, $any($event.target).value)"
                  placeholder="Thème de la journée (ex : Vieux diesels — coupure simple)" />
              }
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
                      @if (t.vehicleId) {
                        <a class="veh-link" [routerLink]="['/vehicles', t.vehicleId]">
                          <lucide-icon [img]="ExternalLinkIcon" [size]="11"></lucide-icon> Véhicule
                        </a>
                      }
                      @if (t.fieldNotes) { <span class="notes"><lucide-icon [img]="StickyNoteIcon" [size]="11"></lucide-icon> {{ t.fieldNotes }}</span> }
                    </div>
                  </div>

                  <div class="row-actions">
                    <select class="day-move" [ngModel]="t.scheduledDate ?? ''" (ngModelChange)="moveToDay(t, $event)" [disabled]="reordering()" title="Changer de jour">
                      <option value="">Non planifié</option>
                      @for (d of days(); track d) { <option [value]="d">{{ fmt(d) }}</option> }
                    </select>
                    @if (t.status !== 'DONE') {
                      <button class="act primary" (click)="openPose(t)" title="Poser">
                        <lucide-icon [img]="WrenchIcon" [size]="13"></lucide-icon> Poser
                      </button>
                    } @else {
                      <button class="act" (click)="openPose(t)" title="Modifier la pose">
                        <lucide-icon [img]="PencilIcon" [size]="13"></lucide-icon>
                      </button>
                      @if (!t.vehicleId) {
                        <button class="act" (click)="retryProvision(t)" title="Re-provisionner">
                          <lucide-icon [img]="RefreshCwIcon" [size]="13"></lucide-icon>
                        </button>
                      }
                    }
                    <button class="act" (click)="openEditTask(t)" title="Modifier la fiche">
                      <lucide-icon [img]="PencilIcon" [size]="13"></lucide-icon>
                    </button>
                    <button class="act danger" (click)="askDeleteTask(t)" title="Supprimer">
                      <lucide-icon [img]="Trash2Icon" [size]="13"></lucide-icon>
                    </button>
                  </div>
                </div>
              }
            </div>

            @if (g.date) {
              <button class="add-row" (click)="openAddTask(g.date)">
                <lucide-icon [img]="PlusIcon" [size]="13"></lucide-icon> Ajouter un véhicule à ce jour
              </button>
            }
          </div>
        }
        </div>

        <button class="add-day" (click)="openAddTask(null)">
          <lucide-icon [img]="PlusIcon" [size]="14"></lucide-icon> Ajouter un véhicule
        </button>
        } @else {
        <!-- ══════════════════════════════════════════════════════════════
             VUE SERPENT (boustrophedon) — meme plumbing CDK que la liste.
             Chaque station = un DayGroup ; chips = tasks (cdkDrag) ; toutes
             les stations dans un seul cdkDropListGroup → drag inter-jours.
             L'effet serpent est PUREMENT CSS : l'ordre DOM = ordre logique,
             les rangees impaires sont inversees via flex-direction: row-reverse.
             ══════════════════════════════════════════════════════════════ -->
        <div class="snake" cdkDropListGroup>
          @for (row of snakeRows(); track $index; let ri = $index) {
            <div class="snake-row" [class.rev]="ri % 2 === 1">
              @for (g of row; track g.date; let ci = $index) {
                <div class="station"
                  [class.unsched]="!g.date"
                  [class.overloaded]="!!g.date && g.tasks.length >= 6"
                  [style.animationDelay]="((ri * 4 + ci) * 60) + 'ms'">

                  <div class="station-head">
                    @if (g.date) {
                      <div class="station-date">
                        <span class="station-d">{{ fmt(g.date) }}</span>
                        <span class="station-wd">{{ weekday(g.date) }}</span>
                      </div>
                      <span class="station-n">{{ g.tasks.length }} véh.</span>
                    } @else {
                      <div class="station-date">
                        <span class="station-d unsched-d">Non programmés</span>
                        <span class="station-wd">à planifier</span>
                      </div>
                      <span class="station-n">{{ g.tasks.length }} véh.</span>
                    }
                  </div>

                  @if (g.date) {
                    @if (g.theme) { <p class="station-theme" [title]="g.theme">{{ g.theme }}</p> }
                    @if (g.tasks.length >= 6) {
                      <p class="station-warn">
                        <lucide-icon [img]="AlertTriangleIcon" [size]="11"></lucide-icon> à étaler
                      </p>
                    }
                  } @else {
                    <p class="station-theme muted">À planifier — glissez une plaque vers un jour</p>
                  }

                  <!-- chips : cdkDropList (chaque chip = cdkDrag) → meme onDrop() que la liste -->
                  <div class="chips" cdkDropList [cdkDropListData]="g.tasks"
                    [cdkDropListDisabled]="reordering()" (cdkDropListDropped)="onDrop($event)">
                    @for (t of g.tasks; track t.id; let i = $index) {
                      <div class="chip" cdkDrag [cdkDragData]="t" [style.animationDelay]="(i * 35) + 'ms'"
                        [title]="chipTitle(t)">
                        <span class="chip-dot"
                          [class.pulse]="t.status === 'PENDING'"
                          [style.background]="chipDot(t)"></span>
                        <span class="chip-plate">{{ t.plate }}</span>
                        <div class="chip-ph" *cdkDragPlaceholder></div>
                      </div>
                    }
                    @if (g.tasks.length === 0) {
                      <span class="chips-empty">Vide</span>
                    }
                  </div>

                  @if (g.date) {
                    <button class="station-add" (click)="openAddTask(g.date)" title="Ajouter un véhicule à ce jour">
                      <lucide-icon [img]="PlusIcon" [size]="12"></lucide-icon>
                    </button>
                  }

                  <!-- connecteur horizontal vers la station suivante de la rangee -->
                  @if (ci < row.length - 1) {
                    <span class="conn-h" aria-hidden="true">
                      <lucide-icon [img]="ArrowRightIcon" [size]="16"></lucide-icon>
                    </span>
                  }
                </div>
              }

              <!-- connecteur en U : descend vers la rangee suivante -->
              @if (ri < snakeRows().length - 1) {
                <span class="conn-u" aria-hidden="true">
                  <lucide-icon [img]="CornerDownLeftIcon" [size]="16"></lucide-icon>
                </span>
              }
            </div>
          }

          <button class="add-day snake-add" (click)="openAddTask(null)">
            <lucide-icon [img]="PlusIcon" [size]="14"></lucide-icon> Ajouter un véhicule
          </button>
        </div>
        }
      } @else {
        <div class="ed-empty">Planning introuvable.</div>
      }
    </div>

    <!-- ── POSE OVERLAY ── -->
    @if (poseTask(); as t) {
      <div class="ov" (click)="closePose()">
        <div class="ov-panel" (click)="$event.stopPropagation()">
          <div class="ov-head">
            <h2>Poser — {{ t.plate }}</h2>
            <button class="ov-x" (click)="closePose()"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
          </div>
          <div class="ov-body">
            <p class="ov-note">À la validation, le véhicule + tracker sont créés et liés automatiquement dans la flotte.</p>
            <label class="fl">IMEI du tracker *</label>
            <input class="fi mono" [(ngModel)]="poseImei" placeholder="123456789012345" maxlength="15" inputmode="numeric" />
            <p class="fl-hint">15 chiffres, sur l'étiquette du boîtier.</p>
            <label class="fl">N° SIM du boîtier</label>
            <input class="fi mono" [(ngModel)]="poseSim" placeholder="+33612345678" maxlength="16" />
            <p class="fl-hint">Format international E.164. Requis pour le statut « Installé ».</p>
            <label class="fl">Date / heure de pose</label>
            <input class="fi" type="datetime-local" [(ngModel)]="poseAt" />
            <label class="fl">Notes terrain</label>
            <textarea class="fi" rows="2" [(ngModel)]="poseNotes" maxlength="2000"></textarea>
          </div>
          <div class="ov-foot">
            <button class="btn-ghost" (click)="closePose()">Annuler</button>
            <button class="btn-primary" [disabled]="posing() || poseImei.trim().length !== 15" (click)="submitPose()">
              @if (posing()) { <span class="spinner sm"></span> } Valider la pose
            </button>
          </div>
        </div>
      </div>
    }

    <!-- ── TASK ADD/EDIT OVERLAY ── -->
    @if (taskForm(); as f) {
      <div class="ov" (click)="closeTaskForm()">
        <div class="ov-panel" (click)="$event.stopPropagation()">
          <div class="ov-head">
            <h2>{{ editingTaskId() ? 'Modifier la fiche' : 'Ajouter un véhicule' }}</h2>
            <button class="ov-x" (click)="closeTaskForm()"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
          </div>
          <div class="ov-body">
            <label class="fl">Immatriculation *</label>
            <input class="fi mono" [(ngModel)]="f.plate" placeholder="AB-123-CD" maxlength="20" />
            <div class="fl-row">
              <div><label class="fl">Marque</label><input class="fi" [(ngModel)]="f.brand" maxlength="100" /></div>
              <div><label class="fl">Modèle</label><input class="fi" [(ngModel)]="f.model" maxlength="100" /></div>
            </div>
            <div class="fl-row">
              <div>
                <label class="fl">Énergie</label>
                <select class="fi" [(ngModel)]="f.energy">
                  <option value="">—</option>
                  @for (e of energyOptions; track e) { <option [value]="e">{{ energyLabel(e) }}</option> }
                </select>
              </div>
              <div><label class="fl">1ère MEC</label><input class="fi" type="date" [(ngModel)]="f.firstRegistrationDate" /></div>
            </div>
            <div class="fl-row">
              <div><label class="fl">Jour planifié</label><input class="fi" type="date" [(ngModel)]="f.scheduledDate" /></div>
              <div>
                <label class="fl">Statut</label>
                <select class="fi" [(ngModel)]="f.status">
                  @for (s of taskStatusOptions; track s) { <option [value]="s">{{ taskStatusLabel(s) }}</option> }
                </select>
              </div>
            </div>
            <label class="fl">Coupure / procédure</label>
            <textarea class="fi" rows="2" [(ngModel)]="f.cutoffProcedure" maxlength="1000"></textarea>
            <label class="fl">Notes terrain</label>
            <textarea class="fi" rows="2" [(ngModel)]="f.fieldNotes" maxlength="2000"></textarea>
          </div>
          <div class="ov-foot">
            <button class="btn-ghost" (click)="closeTaskForm()">Annuler</button>
            <button class="btn-primary" [disabled]="savingTask() || !f.plate.trim()" (click)="saveTask()">
              @if (savingTask()) { <span class="spinner sm"></span> } Enregistrer
            </button>
          </div>
        </div>
      </div>
    }

    <!-- ── EDIT PLAN OVERLAY ── -->
    @if (editPlanOpen()) {
      <div class="ov" (click)="closeEditPlan()">
        <div class="ov-panel" (click)="$event.stopPropagation()">
          <div class="ov-head">
            <h2>Modifier le planning</h2>
            <button class="ov-x" (click)="closeEditPlan()"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
          </div>
          <div class="ov-body">
            <label class="fl">Nom du client *</label>
            <input class="fi" [(ngModel)]="editClientName" maxlength="200" />
            <label class="fl">Adresse</label>
            <input class="fi" [(ngModel)]="editClientAddress" maxlength="300" />
            <label class="fl">Prestation / description</label>
            <input class="fi" [(ngModel)]="editDescription" maxlength="500" />
            <div class="fl-row">
              <div><label class="fl">Début</label><input class="fi" type="date" [(ngModel)]="editStartDate" /></div>
              <div><label class="fl">Fin</label><input class="fi" type="date" [(ngModel)]="editEndDate" /></div>
            </div>
          </div>
          <div class="ov-foot">
            <button class="btn-ghost" (click)="closeEditPlan()">Annuler</button>
            <button class="btn-primary" [disabled]="savingPlan() || !editClientName.trim()" (click)="saveEditPlan()">
              @if (savingPlan()) { <span class="spinner sm"></span> } Enregistrer
            </button>
          </div>
        </div>
      </div>
    }

    <app-confirm-modal
      [open]="showDeletePlan()" title="Supprimer le planning"
      description="Le planning et ses lignes sont supprimés. Les véhicules et trackers déjà créés dans la flotte sont conservés."
      confirmLabel="Supprimer" [danger]="true" [loading]="deletingPlan()"
      (confirmed)="deletePlan()" (cancelled)="showDeletePlan.set(false)" />

    <app-confirm-modal
      [open]="!!taskToDelete()" title="Supprimer cette ligne"
      [description]="deleteTaskDesc()"
      confirmLabel="Supprimer" [danger]="true" [loading]="deletingTask()"
      (confirmed)="deleteTask()" (cancelled)="taskToDelete.set(null)" />
  `,
  styles: [`
    :host { display: block }
    .ed { max-width: 1000px }
    .ed-back { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-tertiary); text-decoration: none; margin-bottom: 14px }
    .ed-back:hover { color: var(--tracky-light) }
    .ed-loading { display: flex; justify-content: center; padding: 60px 0 }
    .spinner { width: 22px; height: 22px; border: 2px solid var(--border-subtle); border-top-color: var(--tracky-light); border-radius: 50%; animation: sp .7s linear infinite; display: inline-block }
    .spinner.sm { width: 14px; height: 14px }
    @keyframes sp { to { transform: rotate(360deg) } }
    .ed-empty { padding: 40px; text-align: center; color: var(--fg-tertiary) }

    .ed-head { display: flex; gap: 20px; justify-content: space-between; flex-wrap: wrap; padding: 20px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); margin-bottom: 18px }
    .ed-head-main { min-width: 240px; flex: 1 }
    .ed-title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap }
    .ed-head h1 { font-family: var(--font-display, Poppins, sans-serif); font-size: 24px; font-weight: 800; color: var(--fg-primary); margin: 0 }
    .ed-addr { font-size: 12px; color: var(--fg-tertiary); margin-top: 4px }
    .ed-desc { font-size: 13px; color: var(--fg-secondary); margin-top: 6px }
    .ed-period { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-tertiary); margin-top: 8px; font-family: var(--font-mono, monospace) }
    .ed-head-side { min-width: 200px; display: flex; flex-direction: column; gap: 8px }
    .ed-progress { display: flex; align-items: center; gap: 10px }
    .ed-bar { flex: 1; height: 7px; border-radius: 4px; background: var(--bg-tertiary); overflow: hidden }
    .ed-bar span { display: block; height: 100%; background: linear-gradient(90deg, #10e0a0, #34d399); transition: width .4s }
    .ed-count { font-size: 11px; font-weight: 700; color: var(--fg-secondary); white-space: nowrap }
    .ed-status-lbl { font-size: 10px; font-weight: 600; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .04em }
    .ed-head-actions { display: flex; gap: 8px; margin-top: 2px }

    .st { font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 6px }
    .st-draft { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .st-published { background: rgba(59,130,246,.12); color: #60a5fa }
    .st-progress { background: rgba(245,158,11,.12); color: #fbbf24 }
    .st-done { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .st-cancel { background: rgba(239,68,68,.12); color: #f87171 }

    .day { margin-bottom: 16px }
    .day-head { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; flex-wrap: wrap }
    .day-date { display: flex; align-items: baseline; gap: 8px }
    .day-d { font-size: 14px; font-weight: 700; color: var(--fg-primary) }
    .day-wd { font-size: 11px; color: var(--fg-tertiary); text-transform: capitalize }
    .day-n { font-size: 10px; color: var(--fg-tertiary); background: var(--bg-tertiary); padding: 2px 7px; border-radius: 5px }
    .day-theme { flex: 1; min-width: 200px; padding: 5px 10px; background: transparent; border: 1px dashed var(--border-subtle); border-radius: 8px; color: var(--fg-secondary); font-size: 12px; outline: none }
    .day-theme:focus { border-style: solid; border-color: var(--tracky) }

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
    /* CDK drag&drop */
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
    .ts-pending { background: rgba(245,158,11,.12); color: #fbbf24 }
    .ts-done { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .ts-skipped { background: var(--bg-tertiary); color: var(--fg-tertiary) }
    .inst { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 5px }
    .inst-installed { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .inst-no-sim { background: rgba(245,158,11,.12); color: #fbbf24 }
    .row-proc { font-size: 11px; color: var(--fg-tertiary); margin-top: 5px; line-height: 1.4 }
    .row-meta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; font-size: 11px; color: var(--fg-tertiary) }
    .row-meta .mono { font-family: var(--font-mono, monospace) }
    .row-meta .notes { display: inline-flex; align-items: center; gap: 4px; font-style: italic }
    .veh-link { display: inline-flex; align-items: center; gap: 4px; color: var(--tracky-light); text-decoration: none }
    .veh-link:hover { text-decoration: underline }

    .row-actions { display: flex; align-items: flex-start; gap: 6px; flex-shrink: 0; flex-wrap: wrap; max-width: 230px; justify-content: flex-end }
    .day-move { padding: 5px 8px; border-radius: 8px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); font-size: 11px; outline: none; max-width: 120px }
    .act { display: inline-flex; align-items: center; gap: 4px; padding: 5px 9px; border-radius: 8px; font-size: 11px; font-weight: 600; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); cursor: pointer }
    .act:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.2) }
    .act.primary { background: var(--tracky); color: var(--accent-ink); border-color: transparent }
    .act.primary:hover { filter: brightness(1.06) }
    .act.danger:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 25%, transparent) }

    .add-row { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; padding: 7px 12px; border-radius: 8px; font-size: 11px; font-weight: 600; background: transparent; border: 1px dashed var(--border-subtle); color: var(--fg-tertiary); cursor: pointer }
    .add-row:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.3) }
    .add-day { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; padding: 10px 18px; border-radius: 10px; font-size: 12px; font-weight: 700; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer }
    .add-day:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.3) }

    /* overlay (partage avec la liste) */
    .ov { position: fixed; inset: 0; z-index: 9000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); backdrop-filter: blur(4px); padding: 16px }
    .ov-panel { width: 100%; max-width: 480px; background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: 16px; display: flex; flex-direction: column; max-height: 92vh; max-height: 92dvh }
    .ov-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-subtle) }
    .ov-head h2 { font-size: 16px; font-weight: 700; color: var(--fg-primary) }
    .ov-x { padding: 6px; border-radius: 8px; background: none; border: none; color: var(--fg-tertiary); cursor: pointer }
    .ov-x:hover { color: var(--fg-primary); background: var(--bg-tertiary) }
    .ov-body { padding: 18px 20px; overflow-y: auto }
    .ov-note { font-size: 12px; color: var(--fg-tertiary); background: rgba(16,224,160,.06); border: 1px solid rgba(16,224,160,.15); border-radius: 10px; padding: 9px 11px; margin-bottom: 12px }
    .ov-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border-subtle) }
    .fl { display: block; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); margin: 12px 0 4px }
    .fl-hint { font-size: 10px; color: var(--fg-tertiary); margin-top: 3px }
    .fl-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px }
    .fi { width: 100%; padding: 9px 12px; background: var(--bg-secondary); border: 1.5px solid var(--border-subtle); border-radius: 10px; color: var(--fg-primary); font-size: 13px; outline: none; font-family: inherit }
    .fi:focus { border-color: var(--tracky) }
    .fi.mono { font-family: var(--font-mono, monospace) }
    .btn-ghost { padding: 9px 16px; border-radius: 10px; font-size: 12px; font-weight: 600; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer }
    .btn-ghost.sm { padding: 6px 10px; font-size: 11px }
    .btn-ghost.sm.danger:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 25%, transparent) }
    /* .btn-primary : styles globaux (styles.css) */

    /* ════════════════════════════════════════════════════════════
       BASCULE DE VUE (segmented control Serpent / Liste)
       ════════════════════════════════════════════════════════════ */
    .vmode { display: flex; justify-content: flex-end; margin-bottom: 18px }
    .vmode-seg { display: inline-flex; border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-secondary); overflow: hidden }
    .vmode-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; font-size: 12px; font-weight: 600;
      background: transparent; color: var(--fg-tertiary); cursor: pointer; border: none; transition: color .18s, background .18s;
    }
    .vmode-btn:hover { color: var(--fg-secondary) }
    .vmode-btn.active { background: var(--tracky); color: var(--accent-ink) }

    /* ════════════════════════════════════════════════════════════
       VUE SERPENT (boustrophedon) — stations + connecteurs + chips
       Surfaces/textes 100% via variables CSS (dark + light OK).
       ════════════════════════════════════════════════════════════ */
    .snake { display: flex; flex-direction: column; gap: 4px }
    .snake-row { display: flex; flex-wrap: nowrap; align-items: stretch; gap: 4px; position: relative }
    /* rangees impaires : on inverse VISUELLEMENT (le DOM reste en ordre logique) */
    .snake-row.rev { flex-direction: row-reverse }

    .station {
      position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column;
      padding: 13px 14px 12px; border-radius: 14px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      transition: transform .18s var(--ease-tracky, ease), box-shadow .18s ease, border-color .18s ease;
      animation: stationIn .42s var(--ease-tracky, cubic-bezier(.16,1,.3,1)) both;
    }
    @keyframes stationIn { from { opacity: 0; transform: translateY(14px) } to { opacity: 1; transform: none } }
    .station:hover {
      transform: translateY(-3px);
      border-color: var(--tracky); box-shadow: 0 10px 28px rgba(0,0,0,.18), 0 0 0 1px rgba(16,224,160,.12);
    }
    .station.overloaded { border-color: rgba(251,191,36,.5) }
    .station.unsched { background: transparent; border-style: dashed; border-color: var(--border-subtle); opacity: .92 }
    .station.unsched:hover { opacity: 1 }

    .station-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px }
    .station-date { display: flex; flex-direction: column; gap: 1px; min-width: 0 }
    .station-d { font-family: var(--font-display, Poppins, sans-serif); font-size: 17px; font-weight: 800; color: var(--fg-primary); line-height: 1.05; letter-spacing: -.01em }
    .station-d.unsched-d { font-size: 13px; font-weight: 700; color: var(--fg-secondary) }
    .station-wd { font-size: 10px; color: var(--fg-tertiary); text-transform: capitalize }
    .station-n { flex-shrink: 0; font-size: 10px; font-weight: 700; color: var(--fg-tertiary); background: var(--bg-tertiary); padding: 2px 7px; border-radius: 6px; white-space: nowrap }
    .station-theme { margin-top: 7px; font-size: 11px; color: var(--fg-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3 }
    .station-theme.muted { white-space: normal; opacity: .8 }
    .station-warn { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; font-size: 10px; font-weight: 700; color: #fbbf24 }

    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; min-height: 30px; align-content: flex-start; border-radius: 10px; transition: outline-color .18s }
    .chips-empty { font-size: 11px; color: var(--fg-tertiary); font-style: italic; padding: 4px 2px }
    .chip {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle); cursor: grab; touch-action: none;
      transition: transform .14s var(--ease-tracky, ease), border-color .14s, box-shadow .14s;
      animation: chipIn .34s var(--ease-tracky, ease) both;
    }
    @keyframes chipIn { from { opacity: 0; transform: scale(.82) } to { opacity: 1; transform: none } }
    .chip:hover { transform: scale(1.06); border-color: rgba(16,224,160,.35); box-shadow: 0 2px 8px rgba(0,0,0,.16) }
    .chip:active { cursor: grabbing }
    .chip-plate { font-family: var(--font-mono, monospace); font-size: 10px; font-weight: 600; color: var(--fg-primary); white-space: nowrap }
    .chip-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 2px rgba(0,0,0,.04) }
    .chip-dot.pulse { animation: dotPulse 1.8s ease-in-out infinite }
    @keyframes dotPulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(251,191,36,.5) }
      50% { box-shadow: 0 0 0 4px rgba(251,191,36,0) }
    }

    .station-add {
      align-self: flex-start; margin-top: 9px; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 8px; background: transparent; border: 1px dashed var(--border-subtle); color: var(--fg-tertiary); cursor: pointer; transition: color .15s, border-color .15s;
    }
    .station-add:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.4) }

    /* Connecteur horizontal entre stations (la fleche suit le sens de lecture
       de la rangee : les rangees inversees la retournent automatiquement). */
    .conn-h {
      position: absolute; top: 50%; right: -4px; transform: translate(50%, -50%); z-index: 2;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--tracky-light); pointer-events: none;
      filter: drop-shadow(0 0 6px rgba(16,224,160,.35));
      animation: connGlow 2.6s ease-in-out infinite;
    }
    .snake-row.rev .conn-h { transform: translate(50%, -50%) scaleX(-1) }
    @keyframes connGlow { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }

    /* Connecteur en U (demi-tour) : descend vers la rangee suivante, ancre au
       bord ou la rangee se termine (droite sur rangees paires, gauche sur rev). */
    .conn-u {
      position: absolute; bottom: -4px; right: 8px; transform: translateY(50%); z-index: 2;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--tracky-light); pointer-events: none;
      filter: drop-shadow(0 0 6px rgba(16,224,160,.35));
      animation: connGlow 2.6s ease-in-out infinite;
    }
    .snake-row.rev .conn-u { right: auto; left: 8px }

    .snake-add { margin-top: 10px; align-self: flex-start }

    /* CDK drag&drop (vue serpent) — preview/placeholder on-theme */
    .chip.cdk-drag-preview {
      box-shadow: 0 10px 26px rgba(0,0,0,.34); border-color: var(--tracky); background: var(--bg-secondary);
      opacity: .95;
    }
    .chip.cdk-drag-placeholder, .chip-ph { opacity: .4 }
    .chip.cdk-drag-animating { transition: transform .2s cubic-bezier(0,0,.2,1) }
    .chips.cdk-drop-list-dragging .chip:not(.cdk-drag-placeholder) { transition: transform .2s cubic-bezier(0,0,.2,1) }
    .chips.cdk-drop-list-receiving { outline: 2px dashed rgba(16,224,160,.45); outline-offset: 3px }

    /* Responsive : sous 720px, on empile (le serpent perd son sens visuel) */
    @media (max-width: 720px) {
      .snake-row, .snake-row.rev { flex-direction: column }
      .conn-h, .conn-u { display: none }
    }

    /* Respect des preferences moteur reduit : on coupe le gros du mouvement. */
    @media (prefers-reduced-motion: reduce) {
      .station, .chip { animation: none }
      .station:hover { transform: none }
      .chip:hover { transform: none }
      .chip-dot.pulse { animation: none }
      .conn-h, .conn-u { animation: none; opacity: .8 }
    }
  `],
})
export class InstallationEditorComponent implements OnInit {
  private readonly api = inject(InstallationsApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeftIcon = ArrowLeft;
  protected readonly PlusIcon = Plus;
  protected readonly PencilIcon = Pencil;
  protected readonly Trash2Icon = Trash2;
  protected readonly ChevronUpIcon = ChevronUp;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly WrenchIcon = Wrench;
  protected readonly XIcon = X;
  protected readonly SaveIcon = Save;
  protected readonly ExternalLinkIcon = ExternalLink;
  protected readonly RefreshCwIcon = RefreshCw;
  protected readonly CheckIcon = Check;
  protected readonly CalendarDaysIcon = CalendarDays;
  protected readonly GripVerticalIcon = GripVertical;
  protected readonly SplineIcon = Spline;
  protected readonly ListIcon = List;
  protected readonly ArrowRightIcon = ArrowRight;
  protected readonly CornerDownLeftIcon = CornerDownLeft;
  protected readonly StickyNoteIcon = StickyNote;
  protected readonly AlertTriangleIcon = AlertTriangle;

  protected readonly energyOptions = ENERGY_OPTIONS;
  protected readonly statusOptions = PLAN_STATUS_OPTIONS;
  protected readonly taskStatusOptions: InstallationTaskStatus[] = ['PENDING', 'DONE', 'SKIPPED'];

  readonly loading = signal(true);
  readonly plan = signal<InstallationPlanDto | null>(null);
  // linkedSignal : re-derive de plan() a chaque changement, mais reste writable
  // pour le drag&drop optimiste (CDK mute les tableaux ; persistReorder confirme).
  readonly daysView = linkedSignal<DayGroup[]>(() => {
    const p = this.plan();
    return p ? groupByDay(p.tasks, p.dayThemes) : [];
  });
  readonly days = computed<string[]>(() => {
    const p = this.plan();
    return p ? distinctDays(p.tasks, p.dayThemes) : [];
  });

  // Mode d'affichage : « serpent » (boustrophedon visuel) ou « liste » (classique).
  // Les deux partagent EXACTEMENT le meme plumbing CDK (daysView / onDrop / persistReorder).
  readonly viewMode = signal<'snake' | 'list'>('snake');
  /** Decoupe daysView() en rangees de 4 stations — l'ordre DOM reste l'ordre logique
   *  (jamais inverse) ; l'effet serpent est purement CSS (flex-direction sur les rangees impaires). */
  readonly snakeRows = computed<DayGroup[][]>(() => {
    const groups = this.daysView();
    const rows: DayGroup[][] = [];
    for (let i = 0; i < groups.length; i += 4) rows.push(groups.slice(i, i + 4));
    return rows;
  });

  // Pose
  readonly poseTask = signal<InstallationTaskDto | null>(null);
  readonly posing = signal(false);
  protected poseImei = '';
  protected poseSim = '';
  protected poseAt = '';
  protected poseNotes = '';

  // Task add/edit
  readonly taskForm = signal<TaskForm | null>(null);
  readonly editingTaskId = signal<string | null>(null);
  readonly savingTask = signal(false);

  // Plan edit (overlay)
  readonly editPlanOpen = signal(false);
  readonly savingPlan = signal(false);
  protected editClientName = '';
  protected editClientAddress = '';
  protected editDescription = '';
  protected editStartDate = '';
  protected editEndDate = '';

  readonly showDeletePlan = signal(false);
  readonly deletingPlan = signal(false);
  readonly taskToDelete = signal<InstallationTaskDto | null>(null);
  readonly deletingTask = signal(false);
  /** Sérialise les réordonnancements pour éviter les courses (drag rapides / réponses stale). */
  readonly reordering = signal(false);

  private planId = '';

  async ngOnInit(): Promise<void> {
    this.planId = this.route.snapshot.paramMap.get('id') ?? '';
    await this.reload();
  }

  protected fmt = formatDateFr;
  protected weekday = weekdayFr;
  protected statusLabel(s: InstallationPlanDto['status']): string { return PLAN_STATUS_LABELS[s]; }
  protected statusClass(s: InstallationPlanDto['status']): string { return PLAN_STATUS_CLASS[s]; }
  protected taskStatusLabel(s: InstallationTaskStatus): string { return TASK_STATUS_LABELS[s]; }
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

  /** Infobulle d'une chip serpent : « PLAQUE — Marque Modèle (Statut) ». */
  protected chipTitle(t: InstallationTaskDto): string {
    const model = [t.brand, t.model].filter(Boolean).join(' ').trim();
    const head = model ? `${t.plate} — ${model}` : t.plate;
    return `${head} · ${this.taskStatusLabel(t.status)}`;
  }

  /** Couleur semantique de la pastille d'une chip serpent (statut + SIM manquante). */
  protected chipDot(t: InstallationTaskDto): string {
    if (t.status === 'DONE') {
      // Posé mais sans SIM = installation incomplete → orange (signal terrain).
      return installState(t.imei, t.simNumber) === 'no-sim' ? '#fb923c' : '#10e0a0';
    }
    if (t.status === 'SKIPPED') return '#6b7280';
    return '#fbbf24'; // PENDING
  }
  protected deleteTaskDesc = computed(() => {
    const t = this.taskToDelete();
    return t ? `Supprimer la ligne <strong>${t.plate}</strong> du planning ?` : '';
  });

  // ── Plan ──
  protected async changeStatus(status: InstallationPlanDto['status']): Promise<void> {
    try {
      const p = await this.api.update(this.planId, { status });
      this.plan.set(p);
      this.toast.success('Statut mis à jour');
    } catch (err) { this.toast.error('Échec', this.errMsg(err)); }
  }

  protected openEditPlan(p: InstallationPlanDto): void {
    this.editClientName = p.clientName;
    this.editClientAddress = p.clientAddress ?? '';
    this.editDescription = p.description ?? '';
    this.editStartDate = p.startDate ?? '';
    this.editEndDate = p.endDate ?? '';
    this.editPlanOpen.set(true);
  }

  protected closeEditPlan(): void {
    if (!this.savingPlan()) this.editPlanOpen.set(false);
  }

  protected async saveEditPlan(): Promise<void> {
    if (!this.editClientName.trim()) return;
    this.savingPlan.set(true);
    try {
      const np = await this.api.update(this.planId, {
        clientName: this.editClientName.trim(),
        clientAddress: this.editClientAddress.trim() || null,
        description: this.editDescription.trim() || null,
        startDate: this.editStartDate || null,
        endDate: this.editEndDate || null,
      });
      this.plan.set(np);
      this.editPlanOpen.set(false);
      this.toast.success('Planning mis à jour');
    } catch (err) {
      this.toast.error('Échec', this.errMsg(err));
    } finally {
      this.savingPlan.set(false);
    }
  }

  protected async deletePlan(): Promise<void> {
    this.deletingPlan.set(true);
    try {
      await this.api.remove(this.planId);
      this.toast.success('Planning supprimé');
      this.router.navigate(['/admin/installations']);
    } catch (err) {
      this.toast.error('Échec', this.errMsg(err));
    } finally {
      this.deletingPlan.set(false);
      this.showDeletePlan.set(false);
    }
  }

  protected async commitTheme(date: string, value: string): Promise<void> {
    const p = this.plan();
    if (!p) return;
    const current = p.dayThemes?.[date] ?? '';
    const next = value.trim();
    if (next === current) return;
    const themes = { ...(p.dayThemes ?? {}) };
    if (next) themes[date] = next; else delete themes[date];
    try {
      const np = await this.api.update(this.planId, { dayThemes: themes });
      this.plan.set(np);
    } catch (err) { this.toast.error('Échec thème', this.errMsg(err)); }
  }

  // ── Reorder (sérialisé via `reordering` pour éviter les courses) ──
  protected async moveUp(g: DayGroup, i: number): Promise<void> {
    if (i <= 0 || this.reordering()) return;
    await this.swapOrder(g.tasks[i], g.tasks[i - 1]);
  }
  protected async moveDown(g: DayGroup, i: number): Promise<void> {
    if (i >= g.tasks.length - 1 || this.reordering()) return;
    await this.swapOrder(g.tasks[i], g.tasks[i + 1]);
  }
  private async swapOrder(a: InstallationTaskDto, b: InstallationTaskDto): Promise<void> {
    await this.persistReorder([
      { id: a.id, orderIndex: b.orderIndex, scheduledDate: a.scheduledDate },
      { id: b.id, orderIndex: a.orderIndex, scheduledDate: b.scheduledDate },
    ]);
  }
  protected async moveToDay(t: InstallationTaskDto, newDate: string): Promise<void> {
    const target = newDate || null;
    if ((t.scheduledDate ?? null) === target || this.reordering()) return;
    const p = this.plan();
    if (!p) return;
    // place en fin du jour cible
    const sameDay = p.tasks.filter((x) => (x.scheduledDate ?? null) === target);
    const nextOrder = sameDay.reduce((m, x) => Math.max(m, x.orderIndex), -1) + 1;
    await this.persistReorder([{ id: t.id, orderIndex: nextOrder, scheduledDate: target }]);
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
    // Re-render optimiste : nouvelles références (le linkedSignal sera réécrasé
    // par la réponse API authoritative dans persistReorder).
    this.daysView.set(this.daysView().map((g) => ({ ...g, tasks: [...g.tasks] })));
    // Payload : orderIndex = position dans le jour, scheduledDate = date du jour.
    const tasks = this.daysView().flatMap((g) =>
      g.tasks.map((t, i) => ({ id: t.id, orderIndex: i, scheduledDate: g.date })),
    );
    void this.persistReorder(tasks);
  }

  private async persistReorder(
    tasks: { id: string; orderIndex: number; scheduledDate: string | null }[],
  ): Promise<void> {
    this.reordering.set(true);
    try {
      const np = await this.api.reorder(this.planId, { tasks });
      this.plan.set(np);
    } catch (err) {
      this.toast.error('Échec réordonnancement', this.errMsg(err));
      await this.reload();
    } finally {
      this.reordering.set(false);
    }
  }

  // ── Pose ──
  protected openPose(t: InstallationTaskDto): void {
    this.poseTask.set(t);
    this.poseImei = t.imei ?? '';
    this.poseSim = t.simNumber ?? '';
    this.poseNotes = t.fieldNotes ?? '';
    this.poseAt = t.installedAt ? this.toLocalInput(t.installedAt) : '';
  }
  protected closePose(): void { if (!this.posing()) this.poseTask.set(null); }
  protected async submitPose(): Promise<void> {
    const t = this.poseTask();
    if (!t) return;
    this.posing.set(true);
    try {
      const res = await this.api.completeTask(this.planId, t.id, {
        imei: this.poseImei.trim(),
        simNumber: this.poseSim.trim() || null,
        fieldNotes: this.poseNotes.trim() || null,
        installedAt: this.poseAt ? new Date(this.poseAt).toISOString() : null,
      });
      if (res.provisioned) this.toast.success('Pose enregistrée — véhicule + tracker créés');
      else this.toast.error('Pose enregistrée, provisioning à vérifier', res.provisionError ?? '');
      this.poseTask.set(null);
      await this.reload();
    } catch (err) {
      this.toast.error('Échec de la pose', this.errMsg(err));
    } finally {
      this.posing.set(false);
    }
  }
  protected async retryProvision(t: InstallationTaskDto): Promise<void> {
    try {
      await this.api.provision(this.planId, t.id);
      this.toast.success('Véhicule + tracker provisionnés');
      await this.reload();
    } catch (err) { this.toast.error('Échec provisioning', this.errMsg(err)); }
  }

  // ── Task add/edit ──
  protected openAddTask(dayDate: string | null): void {
    this.editingTaskId.set(null);
    this.taskForm.set({
      plate: '', scheduledDate: dayDate ?? '', brand: '', model: '', energy: '',
      firstRegistrationDate: '', cutoffProcedure: '', status: 'PENDING', fieldNotes: '',
    });
  }
  protected openEditTask(t: InstallationTaskDto): void {
    this.editingTaskId.set(t.id);
    this.taskForm.set({
      plate: t.plate, scheduledDate: t.scheduledDate ?? '', brand: t.brand ?? '', model: t.model ?? '',
      energy: t.energy ?? '', firstRegistrationDate: t.firstRegistrationDate ?? '',
      cutoffProcedure: t.cutoffProcedure ?? '', status: t.status, fieldNotes: t.fieldNotes ?? '',
    });
  }
  protected closeTaskForm(): void { if (!this.savingTask()) this.taskForm.set(null); }
  protected async saveTask(): Promise<void> {
    const f = this.taskForm();
    if (!f || !f.plate.trim()) return;
    this.savingTask.set(true);
    const payload = {
      plate: f.plate.trim(),
      scheduledDate: f.scheduledDate || null,
      brand: f.brand.trim() || null,
      model: f.model.trim() || null,
      energy: f.energy || null,
      firstRegistrationDate: f.firstRegistrationDate || null,
      cutoffProcedure: f.cutoffProcedure.trim() || null,
      status: f.status,
      fieldNotes: f.fieldNotes.trim() || null,
    };
    try {
      const id = this.editingTaskId();
      if (id) await this.api.updateTask(this.planId, id, payload);
      else await this.api.addTask(this.planId, payload);
      this.toast.success(id ? 'Fiche mise à jour' : 'Véhicule ajouté');
      this.taskForm.set(null);
      await this.reload();
    } catch (err) {
      this.toast.error('Échec', this.errMsg(err));
    } finally {
      this.savingTask.set(false);
    }
  }

  protected askDeleteTask(t: InstallationTaskDto): void { this.taskToDelete.set(t); }
  protected async deleteTask(): Promise<void> {
    const t = this.taskToDelete();
    if (!t) return;
    this.deletingTask.set(true);
    try {
      await this.api.removeTask(this.planId, t.id);
      this.toast.success('Ligne supprimée');
      await this.reload();
    } catch (err) {
      this.toast.error('Échec', this.errMsg(err));
    } finally {
      this.deletingTask.set(false);
      this.taskToDelete.set(null);
    }
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    try {
      this.plan.set(await this.api.findOne(this.planId));
    } catch (err) {
      this.plan.set(null);
      this.toast.error('Échec de chargement', this.errMsg(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** ISO -> "YYYY-MM-DDTHH:mm" pour datetime-local (heure locale). */
  private toLocalInput(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private errMsg(err: unknown): string {
    const e = err as { error?: { message?: string | string[] }; message?: string };
    const m = e?.error?.message;
    if (Array.isArray(m)) return m.join(', ');
    return m ?? e?.message ?? 'Erreur inconnue';
  }
}
