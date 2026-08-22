import { swallow } from '../../core/error/swallow';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  HostListener,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Gauge, Wrench, CalendarClock, Plus, Check, X, Pencil, Trash2,
  CircleDot, LucideAngularModule,
} from 'lucide-angular';
import type {
  MaintenancePlanDto,
  OdometerEstimateDto,
  UpsertMaintenancePlanDto,
  VehicleEventDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { AgendaApiService } from '../../core/services/agenda.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import {
  eventColor,
  eventStatusLabel,
  eventTypeLabel,
  eventUrgency,
  severityLabel,
  urgencyColor,
} from '../agenda/agenda.utils';

/**
 * Sprint 7 — Onglet « Maintenance » du détail véhicule. Auto-suffisant
 * (mirroir de vehicle-reports-tab) : fetch ses propres données pour CE véhicule
 *   - estimation kilométrique (relevé manuel + distance GPS),
 *   - événements de maintenance à venir / passés,
 *   - plans d'entretien récurrents avec prochaine échéance,
 *   - action « Enregistrer un entretien » + éditeur de plan (gatés agenda_manage).
 */
@Component({
  selector: 'app-vehicle-maintenance-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule, DatePipe, DecimalPipe],
  template: `
    @if (loading()) {
      <div class="flex items-center justify-center h-32">
        <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
      </div>
    } @else {
      <div class="flex flex-col gap-4 sm:gap-5">
        <!-- Estimation kilométrique -->
        <div class="vmt-odo">
          <div class="vmt-odo-icon"><lucide-icon [img]="GaugeIcon" [size]="18"></lucide-icon></div>
          <div class="vmt-odo-body">
            <span class="vmt-odo-label">Kilométrage estimé</span>
            @if (odometer()?.estimatedKm != null) {
              <span class="vmt-odo-value">{{ odometer()!.estimatedKm | number:'1.0-0' }} <span class="vmt-odo-unit">km</span></span>
              <span class="vmt-odo-hint">
                estimation GPS
                @if (odometer()?.lastOdometerKm != null) {
                  · relevé {{ odometer()!.lastOdometerKm | number:'1.0-0' }} km + {{ odometer()!.gpsDistanceSinceKm | number:'1.0-0' }} km GPS
                }
              </span>
            } @else {
              <span class="vmt-odo-value vmt-odo-value--empty">—</span>
              <span class="vmt-odo-hint">Aucun relevé ni distance GPS disponible.</span>
            }
          </div>
        </div>

        <!-- Plans d'entretien -->
        <section class="flex flex-col gap-2">
          <div class="vmt-section-head">
            <h3 class="vmt-section-title">
              <lucide-icon [img]="CalendarClockIcon" [size]="15"></lucide-icon>
              Plans d'entretien
            </h3>
            @if (canManage()) {
              <button type="button" (click)="openPlanEditor(null)" class="vmt-add-btn">
                <lucide-icon [img]="PlusIcon" [size]="13"></lucide-icon> Plan
              </button>
            }
          </div>
          @if (plans().length === 0) {
            <p class="vmt-empty">Aucun plan d'entretien pour ce véhicule.</p>
          } @else {
            <div class="flex flex-col gap-2">
              @for (p of plans(); track p.id) {
                <article class="vmt-plan">
                  <div class="vmt-plan-main">
                    <div class="vmt-plan-head">
                      <span class="vmt-plan-label">{{ p.label }}</span>
                      @if (!p.enabled) { <span class="vmt-plan-off">désactivé</span> }
                    </div>
                    <p class="vmt-plan-meta">
                      {{ p.category }}
                      @if (p.intervalMonths) { · tous les {{ p.intervalMonths }} mois }
                      @if (p.intervalKm) { · tous les {{ p.intervalKm | number:'1.0-0' }} km }
                    </p>
                    <p class="vmt-plan-due">
                      @if (p.nextDueAt || p.nextDueKm != null) {
                        Prochaine échéance :
                        @if (p.nextDueAt) { <strong>{{ p.nextDueAt | date:'dd/MM/yyyy' }}</strong> }
                        @if (p.nextDueAt && p.nextDueKm != null) { ou }
                        @if (p.nextDueKm != null) { <strong>{{ p.nextDueKm | number:'1.0-0' }} km</strong> }
                      } @else {
                        <span class="vmt-plan-nodue">Échéance non calculée (aucun entretien enregistré).</span>
                      }
                    </p>
                  </div>
                  @if (canManage()) {
                    <div class="vmt-plan-actions">
                      <button type="button" (click)="openDoneEditor(p)" class="vmt-plan-btn vmt-plan-btn--done" title="Enregistrer un entretien">
                        <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon>
                      </button>
                      <button type="button" (click)="openPlanEditor(p)" class="vmt-plan-btn" title="Modifier le plan">
                        <lucide-icon [img]="PencilIcon" [size]="13"></lucide-icon>
                      </button>
                      <button type="button" (click)="deletePlan(p)" class="vmt-plan-btn vmt-plan-btn--del" title="Supprimer le plan">
                        <lucide-icon [img]="Trash2Icon" [size]="13"></lucide-icon>
                      </button>
                    </div>
                  }
                </article>
              }
            </div>
          }
        </section>

        <!-- Événements à venir -->
        <section class="flex flex-col gap-2">
          <h3 class="vmt-section-title">
            <lucide-icon [img]="WrenchIcon" [size]="15"></lucide-icon>
            À venir
          </h3>
          @if (upcomingEvents().length === 0) {
            <p class="vmt-empty">Aucun entretien ou incident à venir.</p>
          } @else {
            <div class="flex flex-col gap-2">
              @for (ev of upcomingEvents(); track ev.id) {
                <article class="vmt-event" [style.--pill]="eventColor(ev)">
                  <div class="vmt-event-row">
                    <span class="vmt-event-title">{{ ev.title }}</span>
                    <span class="vmt-event-date" [style.--u]="urgencyColor(eventUrgency(ev))">{{ ev.startAt | date:'dd MMM' }}</span>
                  </div>
                  <p class="vmt-event-meta">
                    {{ eventTypeLabel(ev.type) }} · {{ eventStatusLabel(ev.status) }}
                    @if (ev.type === 'INCIDENT' && ev.severity) { · {{ severityLabel(ev.severity) }} }
                    @if (ev.odometerKm != null) { · {{ ev.odometerKm | number:'1.0-0' }} km }
                  </p>
                  @if (canManage() && ev.status !== 'DONE' && ev.status !== 'CANCELLED') {
                    <button type="button" (click)="markEventDone(ev)" [disabled]="busyId() === ev.id" class="vmt-event-done">
                      <lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Marquer terminé
                    </button>
                  }
                </article>
              }
            </div>
          }
        </section>

        <!-- Historique -->
        <section class="flex flex-col gap-2">
          <h3 class="vmt-section-title">
            <lucide-icon [img]="CircleDotIcon" [size]="15"></lucide-icon>
            Historique
          </h3>
          @if (pastEvents().length === 0) {
            <p class="vmt-empty">Aucun entretien passé enregistré.</p>
          } @else {
            <div class="flex flex-col gap-2">
              @for (ev of pastEvents(); track ev.id) {
                <article class="vmt-event vmt-event--past" [style.--pill]="eventColor(ev)">
                  <div class="vmt-event-row">
                    <span class="vmt-event-title">{{ ev.title }}</span>
                    <span class="vmt-event-date vmt-event-date--past">{{ ev.startAt | date:'dd/MM/yy' }}</span>
                  </div>
                  <p class="vmt-event-meta">
                    {{ eventTypeLabel(ev.type) }} · {{ eventStatusLabel(ev.status) }}
                    @if (ev.odometerKm != null) { · {{ ev.odometerKm | number:'1.0-0' }} km }
                  </p>
                </article>
              }
            </div>
          }
        </section>
      </div>
    }

    <!-- ─── Modal : éditeur de plan ─── -->
    @if (planEditorOpen()) {
      <div class="vmt-modal-root" (click)="planEditorOpen.set(false)">
        <div class="vmt-modal" (click)="$event.stopPropagation()" role="dialog" aria-label="Plan d'entretien">
          <header class="vmt-modal-head">
            <h3 class="vmt-modal-title">{{ editingPlanId() ? 'Modifier le plan' : 'Nouveau plan d\\'entretien' }}</h3>
            <button type="button" (click)="planEditorOpen.set(false)" aria-label="Fermer" class="vmt-icon-btn">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </header>
          <div class="vmt-modal-body">
            <div class="vmt-field">
              <label for="vmt-p-label">Libellé</label>
              <input id="vmt-p-label" type="text" class="vmt-input" [(ngModel)]="planForm.label" placeholder="Ex. Vidange moteur" />
            </div>
            <div class="vmt-field">
              <label for="vmt-p-cat">Catégorie</label>
              <input id="vmt-p-cat" type="text" class="vmt-input" [(ngModel)]="planForm.category" placeholder="Ex. Révision" />
            </div>
            <div class="vmt-field-row">
              <div class="vmt-field">
                <label for="vmt-p-months">Intervalle (mois)</label>
                <input id="vmt-p-months" type="number" min="0" class="vmt-input" [(ngModel)]="planForm.intervalMonths" placeholder="—" />
              </div>
              <div class="vmt-field">
                <label for="vmt-p-km">Intervalle (km)</label>
                <input id="vmt-p-km" type="number" min="0" class="vmt-input" [(ngModel)]="planForm.intervalKm" placeholder="—" />
              </div>
            </div>
            <div class="vmt-field-row">
              <div class="vmt-field">
                <label for="vmt-p-rdays">Rappel (jours avant)</label>
                <input id="vmt-p-rdays" type="number" min="0" class="vmt-input" [(ngModel)]="planForm.reminderDaysBefore" />
              </div>
              <div class="vmt-field">
                <label for="vmt-p-rkm">Rappel (km avant)</label>
                <input id="vmt-p-rkm" type="number" min="0" class="vmt-input" [(ngModel)]="planForm.reminderKmBefore" placeholder="—" />
              </div>
            </div>
            <label class="vmt-check">
              <input type="checkbox" [(ngModel)]="planForm.enabled" />
              <span>Plan actif (génère des rappels)</span>
            </label>
            <p class="vmt-modal-hint">Renseignez au moins un intervalle (mois ou km) pour calculer la prochaine échéance.</p>
          </div>
          <footer class="vmt-modal-foot">
            <button type="button" (click)="planEditorOpen.set(false)" class="vmt-btn-ghost">Annuler</button>
            <button type="button" (click)="savePlan()" [disabled]="!canSavePlan() || savingPlan()" class="vmt-btn-primary">
              {{ savingPlan() ? 'Enregistrement…' : 'Enregistrer' }}
            </button>
          </footer>
        </div>
      </div>
    }

    <!-- ─── Modal : enregistrer un entretien réalisé ─── -->
    @if (doneEditorOpen()) {
      <div class="vmt-modal-root" (click)="doneEditorOpen.set(false)">
        <div class="vmt-modal" (click)="$event.stopPropagation()" role="dialog" aria-label="Enregistrer un entretien">
          <header class="vmt-modal-head">
            <h3 class="vmt-modal-title">Enregistrer un entretien</h3>
            <button type="button" (click)="doneEditorOpen.set(false)" aria-label="Fermer" class="vmt-icon-btn">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </header>
          <div class="vmt-modal-body">
            @if (donePlan(); as p) { <p class="vmt-done-plan">{{ p.label }}</p> }
            <div class="vmt-field">
              <label for="vmt-d-date">Date de réalisation</label>
              <input id="vmt-d-date" type="date" class="vmt-input" [(ngModel)]="doneForm.date" />
            </div>
            <div class="vmt-field">
              <label for="vmt-d-km">Kilométrage au compteur</label>
              <input id="vmt-d-km" type="number" min="0" class="vmt-input" [(ngModel)]="doneForm.km" placeholder="km" />
            </div>
            <div class="vmt-field">
              <label for="vmt-d-note">Note</label>
              <textarea id="vmt-d-note" class="vmt-input vmt-textarea" [(ngModel)]="doneForm.note" rows="2" placeholder="Optionnel"></textarea>
            </div>
          </div>
          <footer class="vmt-modal-foot">
            <button type="button" (click)="doneEditorOpen.set(false)" class="vmt-btn-ghost">Annuler</button>
            <button type="button" (click)="saveDone()" [disabled]="savingDone()" class="vmt-btn-primary">
              {{ savingDone() ? 'Enregistrement…' : 'Enregistrer' }}
            </button>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [`
    /* ─── Odomètre ─── */
    .vmt-odo {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 16px;
      background: color-mix(in srgb, var(--tracky) 5%, var(--bg-secondary));
      border: 1px solid color-mix(in srgb, var(--tracky-light) 22%, var(--border-subtle));
      border-radius: var(--radius-card);
    }
    .vmt-odo-icon {
      display: flex; align-items: center; justify-content: center;
      width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0;
      background: rgba(16,224,160,.14); color: var(--tracky-light);
    }
    .vmt-odo-body { display: flex; flex-direction: column; min-width: 0; }
    .vmt-odo-label { font-size: 10px; font-weight: 700; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .04em; }
    .vmt-odo-value {
      font-size: 22px; font-weight: 800; color: var(--fg-primary);
      font-family: var(--font-display); letter-spacing: -.02em; line-height: 1.1; margin-top: 2px;
    }
    .vmt-odo-value--empty { color: var(--fg-tertiary); }
    .vmt-odo-unit { font-size: 12px; font-weight: 600; color: var(--fg-tertiary); }
    .vmt-odo-hint { font-size: 11px; color: var(--fg-tertiary); margin-top: 3px; }

    /* ─── Sections ─── */
    .vmt-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .vmt-section-title {
      display: inline-flex; align-items: center; gap: 7px; margin: 0;
      font-size: 13px; font-weight: 700; color: var(--fg-primary);
    }
    .vmt-section-title lucide-icon { color: var(--fg-tertiary); }
    .vmt-empty {
      padding: 16px; text-align: center; font-size: 13px; color: var(--fg-tertiary);
      background: var(--bg-secondary); border: 1px dashed var(--border-subtle); border-radius: 12px; margin: 0;
    }
    .vmt-add-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 6px 10px; border-radius: 8px;
      background: rgba(16,224,160,.08); border: 1px dashed rgba(16,224,160,.3);
      color: var(--tracky-light); font-size: 11px; font-weight: 600; cursor: pointer; transition: all .15s;
    }
    .vmt-add-btn:hover { background: rgba(16,224,160,.15); border-style: solid; }

    /* ─── Plan card ─── */
    .vmt-plan {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: 12px;
    }
    .vmt-plan-main { flex: 1; min-width: 0; }
    .vmt-plan-head { display: flex; align-items: center; gap: 8px; }
    .vmt-plan-label { font-size: 14px; font-weight: 700; color: var(--fg-primary); }
    .vmt-plan-off {
      font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      padding: 2px 6px; border-radius: 9999px; background: var(--bg-tertiary); color: var(--fg-tertiary);
    }
    .vmt-plan-meta { font-size: 11px; color: var(--fg-tertiary); margin: 3px 0 0; }
    .vmt-plan-due { font-size: 12px; color: var(--fg-secondary); margin: 6px 0 0; }
    .vmt-plan-due strong { color: var(--tracky-light); font-weight: 700; }
    .vmt-plan-nodue { color: var(--fg-tertiary); font-style: italic; }
    .vmt-plan-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .vmt-plan-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 8px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary);
      cursor: pointer; transition: all .15s;
    }
    .vmt-plan-btn:hover { color: var(--fg-primary); border-color: var(--border-strong); }
    .vmt-plan-btn--done:hover { color: var(--tracky-light); border-color: rgba(16,224,160,.3); background: rgba(16,224,160,.06); }
    .vmt-plan-btn--del:hover { color: var(--texte-alerte); border-color: color-mix(in srgb, var(--danger) 30%, transparent); background: color-mix(in srgb, var(--danger) 6%, transparent); }

    /* ─── Event card ─── */
    .vmt-event {
      padding: 11px 13px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-left: 3px solid var(--pill, #10E0A0); border-radius: 12px;
    }
    .vmt-event--past { opacity: .82; }
    .vmt-event-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .vmt-event-title { font-size: 13px; font-weight: 700; color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vmt-event-date {
      font-size: 11px; font-weight: 700; flex-shrink: 0;
      color: var(--u, var(--fg-secondary));
    }
    .vmt-event-date--past { color: var(--fg-tertiary); }
    .vmt-event-meta { font-size: 11px; color: var(--fg-tertiary); margin: 3px 0 0; }
    .vmt-event-done {
      display: inline-flex; align-items: center; gap: 5px; margin-top: 8px;
      padding: 5px 10px; border-radius: 8px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary);
      font-size: 11px; font-weight: 600; cursor: pointer; transition: all .15s;
    }
    .vmt-event-done:hover:not(:disabled) { color: var(--tracky-light); border-color: rgba(16,224,160,.3); background: rgba(16,224,160,.06); }
    .vmt-event-done:disabled { opacity: .5; cursor: wait; }

    /* ─── Modals ─── */
    .vmt-modal-root {
      position: fixed; inset: 0; z-index: 9000;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.5); backdrop-filter: blur(2px); padding: 16px;
      animation: vmt-fade .15s ease-out;
    }
    @keyframes vmt-fade { from { opacity: 0; } to { opacity: 1; } }
    .vmt-modal {
      width: 100%; max-width: 420px; max-height: 88vh; max-height: 88dvh; display: flex; flex-direction: column;
      background: var(--bg-primary); border: 1px solid var(--border-subtle);
      border-radius: 18px; box-shadow: 0 24px 60px rgba(0,0,0,.4); overflow: hidden;
      animation: vmt-rise .2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes vmt-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    .vmt-modal-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
    }
    .vmt-modal-title { font-size: 15px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .vmt-modal-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
    .vmt-modal-foot {
      display: flex; gap: 8px; justify-content: flex-end;
      /* padding-bottom safe-area : sur mobile la modale docke en bas (bottom-sheet),
         le footer toucherait le home indicator iOS sinon. max(12px, env) = additif. */
      padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--border-subtle); flex-shrink: 0;
    }
    .vmt-modal-hint { font-size: 11px; color: var(--fg-tertiary); margin: 0; }
    .vmt-done-plan { font-size: 13px; font-weight: 700; color: var(--tracky-light); margin: 0; }
    .vmt-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; border-radius: 8px;
      background: transparent; border: 0; color: var(--fg-tertiary); cursor: pointer; transition: all .15s; flex-shrink: 0;
    }
    .vmt-icon-btn:hover { color: var(--fg-primary); background: var(--bg-tertiary); }
    .vmt-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex: 1; }
    .vmt-field-row { display: flex; gap: 10px; }
    .vmt-field label {
      font-size: 11px; font-weight: 600; color: var(--fg-tertiary);
      text-transform: uppercase; letter-spacing: .03em;
    }
    .vmt-input {
      width: 100%; padding: 9px 11px; border-radius: 10px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); font-size: 13px; font-family: inherit; transition: border-color .15s;
    }
    .vmt-input:focus { outline: none; border-color: var(--tracky-light); }
    .vmt-input::placeholder { color: var(--fg-tertiary); }
    .vmt-textarea { resize: vertical; min-height: 48px; line-height: 1.45; }
    .vmt-check {
      display: inline-flex; align-items: center; gap: 7px;
      font-size: 12px; font-weight: 600; color: var(--fg-secondary); cursor: pointer;
    }
    .vmt-check input { width: 16px; height: 16px; accent-color: var(--tracky-light); cursor: pointer; }
    .vmt-btn-primary {
      padding: 8px 14px; border-radius: 10px;
      background: var(--tracky, #10E0A0); color: #fff; border: none;
      font-size: 13px; font-weight: 700; cursor: pointer; transition: background .15s, opacity .15s;
    }
    .vmt-btn-primary:hover:not(:disabled) { background: var(--tracky-dark, #0bb586); }
    .vmt-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    .vmt-btn-ghost {
      padding: 8px 14px; border-radius: 10px;
      background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-subtle);
      font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s;
    }
    .vmt-btn-ghost:hover { color: var(--fg-primary); border-color: var(--border-strong); }

    @media (max-width: 480px) {
      .vmt-modal-root { align-items: flex-end; padding: 0; }
      .vmt-modal { max-width: none; max-height: 92vh; max-height: 92dvh; border-radius: 18px 18px 0 0; border-bottom: 0; }
      @keyframes vmt-rise { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: none; } }
    }
  `],
})
export class VehicleMaintenanceTabComponent implements OnInit {
  private readonly api = inject(AgendaApiService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  /** ID du véhicule dont on affiche la maintenance. */
  readonly vehicleId = input.required<string>();

  // Icônes
  protected readonly GaugeIcon = Gauge;
  protected readonly WrenchIcon = Wrench;
  protected readonly CalendarClockIcon = CalendarClock;
  protected readonly PlusIcon = Plus;
  protected readonly CheckIcon = Check;
  protected readonly XIcon = X;
  protected readonly PencilIcon = Pencil;
  protected readonly Trash2Icon = Trash2;
  protected readonly CircleDotIcon = CircleDot;

  // Helpers template
  protected readonly eventColor = eventColor;
  protected readonly eventTypeLabel = eventTypeLabel;
  protected readonly eventStatusLabel = eventStatusLabel;
  protected readonly eventUrgency = eventUrgency;
  protected readonly urgencyColor = urgencyColor;
  protected readonly severityLabel = severityLabel;

  // État
  protected readonly loading = signal(true);
  protected readonly odometer = signal<OdometerEstimateDto | null>(null);
  protected readonly plans = signal<MaintenancePlanDto[]>([]);
  protected readonly events = signal<VehicleEventDto[]>([]);
  protected readonly busyId = signal<string | null>(null);

  protected readonly canManage = computed(() => this.perms.can('agenda_manage', this.vehicleId()));

  /** À venir : non clôturés, triés par échéance croissante. */
  protected readonly upcomingEvents = computed(() =>
    this.events()
      .filter((e) => e.status !== 'DONE' && e.status !== 'CANCELLED')
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime()),
  );

  /** Passés : clôturés, triés par date décroissante. */
  protected readonly pastEvents = computed(() =>
    this.events()
      .filter((e) => e.status === 'DONE' || e.status === 'CANCELLED')
      .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime()),
  );

  // ─── Éditeur de plan ───────────────────────────────────────────────────────
  protected readonly planEditorOpen = signal(false);
  protected readonly editingPlanId = signal<string | null>(null);
  protected readonly savingPlan = signal(false);
  protected planForm = this.blankPlanForm();

  // Méthode (PAS un computed) : `planForm` est un objet simple muté par ngModel — un computed
  // ne lit aucun signal et resterait FIGÉ (bouton toujours grisé). Ré-évaluée à chaque cycle.
  protected canSavePlan(): boolean {
    const f = this.planForm;
    return f.label.trim().length > 0 && f.category.trim().length > 0;
  }

  // ─── Enregistrer un entretien ────────────────────────────────────────────────
  protected readonly doneEditorOpen = signal(false);
  protected readonly donePlan = signal<MaintenancePlanDto | null>(null);
  protected readonly savingDone = signal(false);
  protected doneForm = { date: this.todayIso(), km: null as number | null, note: '' };

  async ngOnInit(): Promise<void> {
    await this.loadAll();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.planEditorOpen()) { this.planEditorOpen.set(false); return; }
    if (this.doneEditorOpen()) this.doneEditorOpen.set(false);
  }

  private async loadAll(): Promise<void> {
    this.loading.set(true);
    const id = this.vehicleId();
    const [odo, plans, events] = await Promise.all([
      firstValueFrom(this.api.odometer(id)).catch(() => null),
      firstValueFrom(this.api.listPlans(id)).catch(() => [] as MaintenancePlanDto[]),
      firstValueFrom(this.api.listEvents({ vehicleId: id, type: 'MAINTENANCE' })).catch(() => [] as VehicleEventDto[]),
    ]);
    this.odometer.set(odo);
    this.plans.set(plans);
    this.events.set(events);
    this.loading.set(false);
  }

  // ─── Événements ──────────────────────────────────────────────────────────────
  protected async markEventDone(ev: VehicleEventDto): Promise<void> {
    if (!this.canManage()) return;
    this.busyId.set(ev.id);
    try {
      const updated = await firstValueFrom(this.api.updateEvent(ev.id, { status: 'DONE' }));
      this.events.update((list) => list.map((e) => (e.id === updated.id ? updated : e)));
      this.toast.success('Entretien marqué terminé');
    } catch (err) {
      swallow('vehicle-maintenance-tab:markEventDone', err);
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : '');
    } finally {
      this.busyId.set(null);
    }
  }

  // ─── Plans ──────────────────────────────────────────────────────────────────
  private blankPlanForm() {
    return {
      label: '',
      category: '',
      intervalMonths: null as number | null,
      intervalKm: null as number | null,
      reminderDaysBefore: 14 as number | null,
      reminderKmBefore: null as number | null,
      enabled: true,
    };
  }

  protected openPlanEditor(plan: MaintenancePlanDto | null): void {
    if (plan) {
      this.editingPlanId.set(plan.id);
      this.planForm = {
        label: plan.label,
        category: plan.category,
        intervalMonths: plan.intervalMonths,
        intervalKm: plan.intervalKm,
        reminderDaysBefore: plan.reminderDaysBefore,
        reminderKmBefore: plan.reminderKmBefore,
        enabled: plan.enabled,
      };
    } else {
      this.editingPlanId.set(null);
      this.planForm = this.blankPlanForm();
    }
    this.planEditorOpen.set(true);
  }

  protected async savePlan(): Promise<void> {
    if (!this.canSavePlan() || this.savingPlan()) return;
    const f = this.planForm;
    const payload: UpsertMaintenancePlanDto = {
      vehicleId: this.vehicleId(),
      category: f.category.trim(),
      label: f.label.trim(),
      enabled: f.enabled,
    };
    if (f.intervalMonths != null && !Number.isNaN(f.intervalMonths)) payload.intervalMonths = Number(f.intervalMonths);
    if (f.intervalKm != null && !Number.isNaN(f.intervalKm)) payload.intervalKm = Number(f.intervalKm);
    if (f.reminderDaysBefore != null && !Number.isNaN(f.reminderDaysBefore)) payload.reminderDaysBefore = Number(f.reminderDaysBefore);
    if (f.reminderKmBefore != null && !Number.isNaN(f.reminderKmBefore)) payload.reminderKmBefore = Number(f.reminderKmBefore);

    this.savingPlan.set(true);
    try {
      const id = this.editingPlanId();
      const saved = id
        ? await firstValueFrom(this.api.updatePlan(id, payload))
        : await firstValueFrom(this.api.createPlan(payload));
      this.plans.update((list) => {
        const idx = list.findIndex((p) => p.id === saved.id);
        return idx >= 0 ? list.map((p) => (p.id === saved.id ? saved : p)) : [...list, saved];
      });
      this.toast.success(id ? 'Plan mis à jour' : 'Plan créé', saved.label);
      this.planEditorOpen.set(false);
    } catch (err) {
      swallow('vehicle-maintenance-tab:savePlan', err);
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : 'Enregistrement impossible.');
    } finally {
      this.savingPlan.set(false);
    }
  }

  protected async deletePlan(plan: MaintenancePlanDto): Promise<void> {
    if (!this.canManage()) return;
    if (!confirm(`Supprimer le plan « ${plan.label} » ?`)) return;
    try {
      await firstValueFrom(this.api.deletePlan(plan.id));
      this.plans.update((list) => list.filter((p) => p.id !== plan.id));
      this.toast.success('Plan supprimé');
    } catch (err) {
      swallow('vehicle-maintenance-tab:deletePlan', err);
      this.toast.error('Échec suppression', err instanceof HttpErrorResponse ? err.error?.message : '');
    }
  }

  // ─── Entretien réalisé ────────────────────────────────────────────────────────
  protected openDoneEditor(plan: MaintenancePlanDto): void {
    this.donePlan.set(plan);
    this.doneForm = {
      date: this.todayIso(),
      km: this.odometer()?.estimatedKm != null ? Math.round(this.odometer()!.estimatedKm!) : null,
      note: '',
    };
    this.doneEditorOpen.set(true);
  }

  protected async saveDone(): Promise<void> {
    const plan = this.donePlan();
    if (!plan || this.savingDone()) return;
    const f = this.doneForm;
    this.savingDone.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.recordPlanDone(plan.id, {
          doneAt: f.date ? new Date(`${f.date}T00:00:00`).toISOString() : undefined,
          doneKm: f.km != null && !Number.isNaN(f.km) ? Number(f.km) : undefined,
          note: f.note.trim() || undefined,
        }),
      );
      this.plans.update((list) => list.map((p) => (p.id === updated.id ? updated : p)));
      this.toast.success('Entretien enregistré', updated.label);
      this.doneEditorOpen.set(false);
      // Recharge les événements (le backend peut générer un événement DONE) + l'odomètre.
      void this.refreshEventsAndOdometer();
    } catch (err) {
      swallow('vehicle-maintenance-tab:saveDone', err);
      this.toast.error('Échec', err instanceof HttpErrorResponse ? err.error?.message : 'Enregistrement impossible.');
    } finally {
      this.savingDone.set(false);
    }
  }

  private async refreshEventsAndOdometer(): Promise<void> {
    const id = this.vehicleId();
    const [odo, events] = await Promise.all([
      firstValueFrom(this.api.odometer(id)).catch(() => this.odometer()),
      firstValueFrom(this.api.listEvents({ vehicleId: id, type: 'MAINTENANCE' })).catch(() => this.events()),
    ]);
    this.odometer.set(odo);
    this.events.set(events);
  }

  private todayIso(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
