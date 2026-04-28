import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Clock, Save, X, Shield, Briefcase, Calendar, Settings2, Zap } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import {
  VehicleSchedulesApiService,
  type UpsertSchedulePayload,
  type VehicleScheduleDto,
} from '../../../core/services/vehicle-schedules.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { ConfirmModalComponent } from '../../../shared/ui/confirm-modal/confirm-modal.component';

interface DayRow {
  key: string;
  label: string;
  enabled: boolean;
  start: string;
  end: string;
}

interface CustomDateRow {
  date: string;       // ISO date YYYY-MM-DD
  closed: boolean;    // true = ferme toute la journee
  start?: string;     // sinon, plage HH:MM
  end?: string;
}

const COUNTRY_CHOICES: { value: string; label: string }[] = [
  { value: '', label: 'Aucun (ignorer)' },
  { value: 'FR', label: '🇫🇷 France' },
  { value: 'MA', label: '🇲🇦 Maroc' },
  { value: 'BE', label: '🇧🇪 Belgique' },
  { value: 'LU', label: '🇱🇺 Luxembourg' },
  { value: 'CH', label: '🇨🇭 Suisse' },
];

const DAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

const DAY_LABELS: Record<string, string> = {
  monday: 'Lundi',
  tuesday: 'Mardi',
  wednesday: 'Mercredi',
  thursday: 'Jeudi',
  friday: 'Vendredi',
  saturday: 'Samedi',
  sunday: 'Dimanche',
};

const TIMEZONES = [
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Africa/Casablanca', label: 'Africa/Casablanca' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai' },
];

@Component({
  selector: 'app-vehicle-schedule',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, ConfirmModalComponent],
  template: `
    @if (loading()) {
      <div class="flex items-center justify-center h-40">
        <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
      </div>
    } @else {
      <div class="vsched-container">
        <!-- Header avec status pill -->
        <div class="vsched-header">
          <div class="vsched-header-left">
            <div class="vsched-header-icon">
              <lucide-icon [img]="ShieldIcon" [size]="18"></lucide-icon>
            </div>
            <div>
              <h3 class="vsched-header-title">Automatisation horaire</h3>
              <p class="vsched-header-sub">
                @if (globalEnabled()) {
                  <span class="vsched-status vsched-status--on">● Activée</span>
                } @else {
                  <span class="vsched-status vsched-status--off">○ Désactivée</span>
                }
                · {{ enabledDaysCount() }} jour{{ enabledDaysCount() > 1 ? 's' : '' }} actif{{ enabledDaysCount() > 1 ? 's' : '' }}
              </p>
            </div>
          </div>
          <button
            type="button"
            (click)="onToggleGlobal()"
            [disabled]="readonly()"
            class="vsched-toggle"
            [class.vsched-toggle--on]="globalEnabled()"
            aria-label="Activer / désactiver l'automatisation"
          >
            <span class="vsched-toggle-knob"></span>
          </button>
        </div>

        <!-- Aperçu d'aujourd'hui -->
        @if (todayPreview(); as preview) {
          <div class="vsched-today">
            <lucide-icon [img]="ClockIcon" [size]="14"></lucide-icon>
            <span>{{ preview }}</span>
          </div>
        }

        <!-- Presets rapides -->
        @if (!readonly()) {
          <div class="vsched-presets">
            <p class="vsched-section-title">
              <lucide-icon [img]="ZapIcon" [size]="12"></lucide-icon>
              Presets rapides
            </p>
            <div class="vsched-preset-grid">
              <button type="button" (click)="applyPreset('weekday')" class="vsched-preset">
                <lucide-icon [img]="BriefcaseIcon" [size]="14"></lucide-icon>
                <span>Bureau</span>
                <small>Lun–Ven · 8h–18h</small>
              </button>
              <button type="button" (click)="applyPreset('all-day')" class="vsched-preset">
                <lucide-icon [img]="CalendarIcon" [size]="14"></lucide-icon>
                <span>7j/7</span>
                <small>Tous les jours</small>
              </button>
              <button type="button" (click)="applyPreset('reset-default')" class="vsched-preset">
                <lucide-icon [img]="Settings2Icon" [size]="14"></lucide-icon>
                <span>Standard</span>
                <small>Lun–Ven · 8h–20h</small>
              </button>
            </div>
          </div>
        }

        <!-- Fuseau horaire -->
        <div class="vsched-timezone">
          <span class="vsched-section-title">
            <lucide-icon [img]="ClockIcon" [size]="12"></lucide-icon>
            Fuseau horaire
          </span>
          <select
            [ngModel]="timezone()"
            (ngModelChange)="timezone.set($event); dirty.set(true)"
            [disabled]="readonly()"
            class="vsched-tz-select"
          >
            @for (tz of timezones; track tz.value) {
              <option [value]="tz.value">{{ tz.label }}</option>
            }
          </select>
        </div>

        <!-- Jours sous forme de cards -->
        <div class="vsched-days">
          <p class="vsched-section-title">Planning hebdomadaire</p>
          <div class="vsched-days-grid">
            @for (day of days(); track day.key) {
              <div class="vsched-day-card"
                   [class.vsched-day-card--off]="!day.enabled">
                <div class="vsched-day-header">
                  <span class="vsched-day-name">{{ day.label }}</span>
                  <button
                    type="button"
                    (click)="toggleDay(day.key)"
                    [disabled]="readonly()"
                    class="vsched-day-toggle"
                    [class.vsched-day-toggle--on]="day.enabled"
                    [attr.aria-label]="(day.enabled ? 'Désactiver ' : 'Activer ') + day.label"
                  >
                    <span class="vsched-day-toggle-knob"></span>
                  </button>
                </div>

                @if (day.enabled) {
                  <div class="vsched-day-times">
                    <input
                      type="time"
                      [ngModel]="day.start"
                      (ngModelChange)="updateDayTime(day.key, 'start', $event)"
                      [disabled]="readonly()"
                      class="vsched-time-input"
                    />
                    <span class="vsched-time-arrow">→</span>
                    <input
                      type="time"
                      [ngModel]="day.end"
                      (ngModelChange)="updateDayTime(day.key, 'end', $event)"
                      [disabled]="readonly()"
                      class="vsched-time-input"
                    />
                  </div>
                } @else {
                  <p class="vsched-day-off">Véhicule immobilisé</p>
                }
              </div>
            }
          </div>
        </div>

        <!-- Override warning -->
        @if (schedule()?.overrideUntil; as overrideUntil) {
          @if (isOverrideActive(overrideUntil)) {
            <div class="vsched-override">
              <lucide-icon [img]="ZapIcon" [size]="14"></lucide-icon>
              <span>Commande manuelle en cours — automatisation suspendue temporairement</span>
            </div>
          }
        }

        <!-- Actions sticky en bas -->
        @if (!readonly() && dirty()) {
          <div class="vsched-actions">
            <button
              (click)="reset()"
              class="vsched-btn vsched-btn--ghost"
            >
              <lucide-icon [img]="XIcon" [size]="14"></lucide-icon>
              Annuler
            </button>
            <button
              (click)="save()"
              [disabled]="saving()"
              class="vsched-btn vsched-btn--primary"
            >
              @if (saving()) {
                <span class="vsched-spinner"></span>
              } @else {
                <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon>
              }
              Enregistrer
            </button>
          </div>
        }
      </div>

      <!-- V1.6 (P1) — Options avancees : multi-plages + jours feries + dates speciales -->
      @if (globalEnabled()) {
        <div class="vsched-advanced">
          <button type="button" class="vsched-advanced-toggle" (click)="toggleAdvanced()">
            <lucide-icon [img]="Settings2Icon" [size]="14"></lucide-icon>
            Options avancees
            <span class="vsched-advanced-arrow" [class.vsched-advanced-arrow--open]="advancedExpanded()">▶</span>
          </button>

          @if (advancedExpanded()) {
            <div class="vsched-advanced-body">
              <!-- Multi-plages par jour -->
              <div class="vsched-adv-section">
                <h4>Plages multiples par jour</h4>
                <p class="vsched-adv-desc">
                  Ajoute jusqu'a 2 plages supplementaires en plus de la plage principale (ex: 08-12h + 14-18h).
                </p>
                @for (d of days(); track d.key) {
                  @if (d.enabled) {
                    <div class="vsched-adv-day">
                      <span class="vsched-adv-day-label">{{ d.label }}</span>
                      <span class="vsched-adv-base">{{ d.start }}–{{ d.end }}</span>
                      @for (slot of slotsForDay(d.key); track $index; let i = $index) {
                        <span class="vsched-adv-slot">
                          <input type="time" [value]="slot.start" [disabled]="readonly()"
                                 (input)="updateSlot(d.key, i, 'start', $any($event.target).value)" />
                          <span>–</span>
                          <input type="time" [value]="slot.end" [disabled]="readonly()"
                                 (input)="updateSlot(d.key, i, 'end', $any($event.target).value)" />
                          @if (!readonly()) {
                            <button type="button" class="vsched-adv-slot-remove" (click)="removeSlot(d.key, i)">
                              <lucide-icon [img]="XIcon" [size]="12"></lucide-icon>
                            </button>
                          }
                        </span>
                      }
                      @if (!readonly() && slotsForDay(d.key).length < 2) {
                        <button type="button" class="vsched-adv-slot-add" (click)="addSlot(d.key)">
                          + plage
                        </button>
                      }
                    </div>
                  }
                }
              </div>

              <!-- Jours feries -->
              <div class="vsched-adv-section">
                <h4>Jours feries</h4>
                <p class="vsched-adv-desc">
                  Le vehicule est automatiquement coupe les jours feries du pays selectionne.
                </p>
                <select [value]="countryCode()" (change)="onCountryChange($any($event.target).value)"
                        [disabled]="readonly()" class="vsched-adv-select">
                  @for (c of countryChoices; track c.value) {
                    <option [value]="c.value">{{ c.label }}</option>
                  }
                </select>
              </div>

              <!-- Dates speciales -->
              <div class="vsched-adv-section">
                <h4>Dates speciales</h4>
                <p class="vsched-adv-desc">
                  Override ponctuel pour une date precise (ex: ferme le 24/12 a 16:00, ferme toute la journee, ...).
                </p>
                @for (cd of customDates(); track $index; let i = $index) {
                  <div class="vsched-adv-cdate">
                    <input type="date" [value]="cd.date" [disabled]="readonly()"
                           (input)="updateCustomDate(i, { date: $any($event.target).value })" />
                    <label class="vsched-adv-checkbox">
                      <input type="checkbox" [checked]="cd.closed" [disabled]="readonly()"
                             (change)="updateCustomDate(i, { closed: $any($event.target).checked })" />
                      Ferme toute la journee
                    </label>
                    @if (!cd.closed) {
                      <input type="time" [value]="cd.start ?? '08:00'" [disabled]="readonly()"
                             (input)="updateCustomDate(i, { start: $any($event.target).value })" />
                      <span>–</span>
                      <input type="time" [value]="cd.end ?? '18:00'" [disabled]="readonly()"
                             (input)="updateCustomDate(i, { end: $any($event.target).value })" />
                    }
                    @if (!readonly()) {
                      <button type="button" class="vsched-adv-slot-remove" (click)="removeCustomDate(i)">
                        <lucide-icon [img]="XIcon" [size]="12"></lucide-icon>
                      </button>
                    }
                  </div>
                }
                @if (!readonly()) {
                  <button type="button" class="vsched-adv-slot-add" (click)="addCustomDate()">
                    + ajouter une date speciale
                  </button>
                }
              </div>
            </div>
          }
        </div>
      }

      <!-- Confirmation modal for disabling when vehicle is cut -->
      <app-confirm-modal
        [open]="showDisableConfirm()"
        title="Désactiver l'automatisation"
        description="Ce véhicule est actuellement immobilisé par l'automatisation horaire. Désactiver va rallumer le moteur automatiquement."
        confirmLabel="Désactiver et rallumer"
        cancelLabel="Annuler"
        [danger]="true"
        [loading]="saving()"
        (confirmed)="confirmDisable()"
        (cancelled)="cancelDisable()"
      />
    }
  `,
  styles: [`
    .vsched-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card);
      overflow: hidden;
    }

    /* Header */
    .vsched-header {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .vsched-header-left { display: flex; align-items: center; gap: 12px; min-width: 0 }
    .vsched-header-icon {
      width: 36px; height: 36px; border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(16,224,160,.12); color: var(--tracky-light);
      flex-shrink: 0;
    }
    .vsched-header-title { font-size: 15px; font-weight: 700; color: var(--fg-primary); line-height: 1.2 }
    .vsched-header-sub { font-size: 11px; color: var(--fg-tertiary); margin-top: 3px; line-height: 1.2 }
    .vsched-status { font-weight: 700 }
    .vsched-status--on { color: var(--tracky-light) }
    .vsched-status--off { color: var(--fg-tertiary) }

    /* Toggle global */
    .vsched-toggle {
      position: relative; flex-shrink: 0;
      width: 44px; height: 24px;
      border-radius: 9999px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      cursor: pointer;
      transition: background .2s;
    }
    .vsched-toggle--on { background: var(--tracky); border-color: var(--tracky) }
    .vsched-toggle:disabled { opacity: .5; cursor: not-allowed }
    .vsched-toggle-knob {
      position: absolute; top: 2px; left: 2px;
      width: 18px; height: 18px;
      border-radius: 50%;
      background: white;
      transition: transform .25s cubic-bezier(0.34, 1.56, 0.64, 1);
      box-shadow: 0 2px 4px rgba(0,0,0,.15);
    }
    .vsched-toggle--on .vsched-toggle-knob { transform: translateX(20px) }

    /* Today preview */
    .vsched-today {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 10px 16px;
      background: rgba(16,224,160,.06);
      border-bottom: 1px solid var(--border-subtle);
      color: var(--tracky-light);
      font-size: 12px;
      line-height: 1.4;
    }
    .vsched-today lucide-icon { flex-shrink: 0; margin-top: 1px }

    /* Section title */
    .vsched-section-title {
      display: flex; align-items: center; gap: 6px;
      font-size: 10px; font-weight: 700;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 8px;
    }

    /* Presets */
    .vsched-presets { padding: 14px 16px; border-bottom: 1px solid var(--border-subtle) }
    .vsched-preset-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .vsched-preset {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 4px;
      padding: 10px 6px;
      border-radius: 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      cursor: pointer;
      transition: all .2s;
      min-height: 64px;
    }
    .vsched-preset:hover, .vsched-preset:active {
      border-color: var(--tracky);
      color: var(--tracky-light);
      transform: translateY(-1px);
    }
    .vsched-preset lucide-icon { color: var(--tracky-light) }
    .vsched-preset span { font-size: 12px; font-weight: 700 }
    .vsched-preset small { font-size: 9px; color: var(--fg-tertiary); line-height: 1.2 }

    /* Timezone */
    .vsched-timezone {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .vsched-timezone .vsched-section-title { margin: 0 }
    .vsched-tz-select {
      max-width: 60%;
      font-size: 12px;
      background: var(--bg-tertiary);
      color: var(--fg-primary);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 6px 10px;
      outline: none;
    }
    .vsched-tz-select:focus { border-color: var(--tracky) }
    .vsched-tz-select:disabled { opacity: .5 }

    /* Days grid */
    .vsched-days { padding: 14px 16px }
    .vsched-days-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .vsched-day-card {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 10px 12px;
      transition: opacity .2s, border-color .2s;
    }
    .vsched-day-card--off { opacity: .55 }
    .vsched-day-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px;
    }
    .vsched-day-name {
      font-size: 13px; font-weight: 700;
      color: var(--fg-primary);
    }
    .vsched-day-toggle {
      position: relative;
      width: 32px; height: 18px;
      border-radius: 9999px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      cursor: pointer;
      transition: background .2s;
    }
    .vsched-day-toggle--on { background: var(--tracky); border-color: var(--tracky) }
    .vsched-day-toggle:disabled { opacity: .5; cursor: not-allowed }
    .vsched-day-toggle-knob {
      position: absolute; top: 1px; left: 1px;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: white;
      transition: transform .25s cubic-bezier(0.34, 1.56, 0.64, 1);
      box-shadow: 0 1px 2px rgba(0,0,0,.15);
    }
    .vsched-day-toggle--on .vsched-day-toggle-knob { transform: translateX(14px) }

    .vsched-day-times {
      display: flex; align-items: center; gap: 6px;
    }
    .vsched-time-input {
      flex: 1; min-width: 0;
      font-size: 12px; font-weight: 600;
      background: var(--bg-secondary);
      color: var(--fg-primary);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 6px 8px;
      outline: none;
      font-family: var(--font-mono, monospace);
    }
    .vsched-time-input:focus { border-color: var(--tracky) }
    .vsched-time-input:disabled { opacity: .5 }
    .vsched-time-arrow { color: var(--fg-tertiary); font-size: 11px; flex-shrink: 0 }
    .vsched-day-off { font-size: 11px; color: var(--fg-tertiary); font-style: italic }

    /* Override warning */
    .vsched-override {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px;
      border-top: 1px solid rgba(245,158,11,.2);
      background: rgba(245,158,11,.06);
      color: #f59e0b;
      font-size: 12px;
    }

    /* Actions sticky */
    .vsched-actions {
      display: flex; align-items: center; justify-content: flex-end; gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-tertiary);
    }
    .vsched-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 12px; font-weight: 700;
      cursor: pointer;
      transition: all .15s;
      border: 0;
    }
    .vsched-btn:disabled { opacity: .5; cursor: not-allowed }
    .vsched-btn--ghost {
      background: var(--bg-secondary);
      color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
    }
    .vsched-btn--ghost:hover { color: var(--fg-primary) }
    .vsched-btn--primary {
      background: var(--tracky);
      color: white;
    }
    .vsched-btn--primary:hover:not(:disabled) { background: var(--tracky-dark) }
    .vsched-spinner {
      width: 12px; height: 12px;
      border: 2px solid rgba(255,255,255,.3);
      border-top-color: white;
      border-radius: 50%;
      animation: vsched-spin 0.6s linear infinite;
      display: inline-block;
    }
    @keyframes vsched-spin { to { transform: rotate(360deg) } }

    /* Tablet & Desktop : grille 2 colonnes pour les jours */
    @media (min-width: 600px) {
      .vsched-days-grid { grid-template-columns: repeat(2, 1fr) }
    }
    @media (min-width: 1024px) {
      .vsched-days-grid { grid-template-columns: repeat(7, 1fr) }
      .vsched-day-card { padding: 10px }
      .vsched-day-name { font-size: 11px }
      .vsched-time-input { font-size: 11px; padding: 5px 6px }
    }

    /* V1.6 (P1) — Section avancee */
    .vsched-advanced { border-top: 1px solid var(--border-subtle) }
    .vsched-advanced-toggle {
      width: 100%; display: flex; align-items: center; gap: 8px;
      padding: 12px 16px;
      background: transparent; border: 0;
      color: var(--fg-secondary); font-size: 12px; font-weight: 600;
      cursor: pointer;
    }
    .vsched-advanced-toggle:hover { background: var(--bg-tertiary) }
    .vsched-advanced-arrow { margin-left: auto; transition: transform .2s; font-size: 9px }
    .vsched-advanced-arrow--open { transform: rotate(90deg) }
    .vsched-advanced-body {
      padding: 12px 16px 16px;
      display: flex; flex-direction: column; gap: 18px;
      background: rgba(255,255,255,.02);
    }
    .vsched-adv-section h4 {
      font-size: 12px; font-weight: 700; color: var(--fg-primary);
      text-transform: uppercase; letter-spacing: .04em;
      margin: 0 0 4px;
    }
    .vsched-adv-desc { font-size: 11px; color: var(--fg-tertiary); margin: 0 0 10px; line-height: 1.4 }
    .vsched-adv-day {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 8px 0;
      border-bottom: 1px dashed var(--border-subtle);
    }
    .vsched-adv-day:last-child { border-bottom: 0 }
    .vsched-adv-day-label { width: 80px; font-size: 12px; color: var(--fg-secondary); font-weight: 600 }
    .vsched-adv-base { font-size: 11px; color: var(--fg-tertiary); font-family: monospace }
    .vsched-adv-slot {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 8px;
      background: var(--bg-tertiary);
      border-radius: 6px;
      font-size: 11px;
    }
    .vsched-adv-slot input[type="time"] {
      background: transparent; border: 0; color: var(--fg-primary);
      font-size: 11px; font-family: monospace;
      width: 60px;
    }
    .vsched-adv-slot-remove {
      background: transparent; border: 0; color: var(--fg-tertiary);
      cursor: pointer; padding: 2px;
    }
    .vsched-adv-slot-remove:hover { color: rgb(244, 63, 94) }
    .vsched-adv-slot-add {
      background: transparent; border: 1px dashed var(--border-subtle);
      color: var(--tracky-light); padding: 4px 10px; border-radius: 6px;
      font-size: 11px; cursor: pointer;
    }
    .vsched-adv-slot-add:hover { border-color: var(--tracky-light); background: rgba(16,224,160,.06) }
    .vsched-adv-select {
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); font-size: 12px;
      padding: 6px 10px; border-radius: 6px;
      max-width: 220px;
    }
    .vsched-adv-cdate {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 6px 0;
    }
    .vsched-adv-cdate input[type="date"], .vsched-adv-cdate input[type="time"] {
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-primary); padding: 4px 6px; border-radius: 4px;
      font-size: 11px; font-family: monospace;
    }
    .vsched-adv-checkbox {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--fg-secondary); cursor: pointer;
    }
  `],
})
export class VehicleScheduleComponent {
  readonly vehicleId = input.required<string>();
  readonly hasTracker = input(false);
  /** Incrémenté depuis l'extérieur pour forcer un rechargement des données schedule. */
  readonly reloadTrigger = input(0);

  private readonly schedulesApi = inject(VehicleSchedulesApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly ClockIcon = Clock;
  protected readonly SaveIcon = Save;
  protected readonly XIcon = X;
  protected readonly ShieldIcon = Shield;
  protected readonly BriefcaseIcon = Briefcase;
  protected readonly CalendarIcon = Calendar;
  protected readonly Settings2Icon = Settings2;
  protected readonly ZapIcon = Zap;
  protected readonly timezones = TIMEZONES;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly dirty = signal(false);
  protected readonly schedule = signal<VehicleScheduleDto | null>(null);
  protected readonly globalEnabled = signal(false);
  protected readonly timezone = signal('Europe/Paris');
  protected readonly days = signal<DayRow[]>(this.defaultDays());
  protected readonly showDisableConfirm = signal(false);

  // V1.6 (P1) — multi-plages par jour + jours feries + dates speciales.
  // mondaySlots = 2-3 plages cumulables sur un meme jour (ex: 08:00-12:00 + 14:00-18:00).
  // Si un jour a des slots, ils prennent le pas sur start/end "simple".
  // Le type Record autorise `undefined` pour les jours sans extras — d'ou le `?? []`
  // explicite dans le template.
  protected readonly extraSlotsByDay = signal<Record<string, Array<{ start: string; end: string }> | undefined>>({});
  protected readonly countryCode = signal<string>('FR');
  protected readonly customDates = signal<CustomDateRow[]>([]);
  protected readonly advancedExpanded = signal(false);
  protected readonly countryChoices = COUNTRY_CHOICES;

  protected readonly readonly = computed(() => {
    const role = this.auth.user()?.role;
    return role !== 'FLEET_ADMIN' && role !== 'SUPER_ADMIN';
  });

  /** Nombre de jours actifs (utilisé dans le sub-titre header). */
  protected readonly enabledDaysCount = computed(() =>
    this.days().filter((d) => d.enabled).length,
  );

  /** Applique un preset rapide aux jours. */
  protected applyPreset(preset: 'weekday' | 'all-day' | 'reset-default'): void {
    const map: Record<typeof preset, (key: string) => DayRow> = {
      'weekday': (key) => ({
        key,
        label: DAY_LABELS[key]!,
        enabled: !['saturday', 'sunday'].includes(key),
        start: '08:00',
        end: '18:00',
      }),
      'all-day': (key) => ({
        key,
        label: DAY_LABELS[key]!,
        enabled: true,
        start: '00:00',
        end: '23:59',
      }),
      'reset-default': (key) => ({
        key,
        label: DAY_LABELS[key]!,
        enabled: !['saturday', 'sunday'].includes(key),
        start: '08:00',
        end: '20:00',
      }),
    };
    this.days.set(DAY_KEYS.map((key) => map[preset](key)));
    this.dirty.set(true);
  }

  protected readonly todayPreview = computed(() => {
    if (!this.globalEnabled()) return null;
    const now = new Date();
    const jsDay = now.getDay();
    const idx = jsDay === 0 ? 6 : jsDay - 1;
    const day = this.days()[idx];
    if (!day) return null;

    const dayLabel = day.label;
    if (!day.enabled) {
      return `Aujourd'hui (${dayLabel}) : véhicule immobilisé toute la journée`;
    }
    if (!day.start || !day.end) {
      return `Aujourd'hui (${dayLabel}) : aucune restriction horaire`;
    }
    return `Aujourd'hui (${dayLabel}) : autorisé de ${day.start} à ${day.end} (${this.timezone()})`;
  });

  constructor() {
    effect(() => {
      const vid = this.vehicleId();
      this.reloadTrigger(); // re-fetch quand le trigger change (ex: schedule désactivé par bouton CUT)
      if (vid) this.load(vid);
    });
  }

  private async load(vehicleId: string): Promise<void> {
    this.loading.set(true);
    try {
      const schedule = await firstValueFrom(this.schedulesApi.get(vehicleId));
      this.schedule.set(schedule);
      if (schedule) {
        this.globalEnabled.set(schedule.enabled);
        this.timezone.set(schedule.timezone);
        this.days.set(this.scheduleToDays(schedule));
        // V1.6 (P1) — charge les sections avancees si presentes en DB.
        this.countryCode.set(schedule.countryCode ?? 'FR');
        const extras: Record<string, Array<{ start: string; end: string }>> = {};
        for (const k of DAY_KEYS) {
          const slots = (schedule as unknown as Record<string, Array<{ start: string; end: string }> | null>)[`${k}Slots`];
          if (slots && slots.length > 1) {
            // Le 1er slot represente start/end "simple" — on le saute.
            extras[k] = slots.slice(1);
          }
        }
        this.extraSlotsByDay.set(extras);
        const cd = (schedule.customDates ?? []).map((c) => ({
          date: c.date,
          closed: c.closed === true,
          start: c.slots?.[0]?.start,
          end: c.slots?.[0]?.end,
        }));
        this.customDates.set(cd);
        if (Object.keys(extras).length > 0 || cd.length > 0 || (schedule.countryCode && schedule.countryCode !== 'FR')) {
          this.advancedExpanded.set(true);
        }
      } else {
        this.globalEnabled.set(false);
        this.timezone.set('Europe/Paris');
        this.days.set(this.defaultDays());
        this.countryCode.set('FR');
        this.extraSlotsByDay.set({});
        this.customDates.set([]);
      }
      this.dirty.set(false);
    } catch {
      // No schedule yet → use defaults
    } finally {
      this.loading.set(false);
    }
  }

  /** Toggle global: disabling always auto-saves to trigger RESTORE if needed. */
  protected onToggleGlobal(): void {
    const currentlyEnabled = this.globalEnabled();
    if (currentlyEnabled) {
      // Désactivation → toujours confirmer + auto-save (le backend envoie RESTORE si CUT actif)
      this.showDisableConfirm.set(true);
      return;
    }
    // Activation → toggle + dirty (l'utilisateur doit cliquer Enregistrer)
    this.globalEnabled.set(true);
    this.dirty.set(true);
  }

  protected confirmDisable(): void {
    this.showDisableConfirm.set(false);
    this.globalEnabled.set(false);
    this.dirty.set(true);
    // Auto-save immediately so the RESTORE is emitted right away
    this.save();
  }

  protected cancelDisable(): void {
    this.showDisableConfirm.set(false);
  }

  protected toggleDay(key: string): void {
    this.days.update((rows) =>
      rows.map((r) =>
        r.key === key ? { ...r, enabled: !r.enabled } : r,
      ),
    );
    this.dirty.set(true);
  }

  protected updateDayTime(key: string, field: 'start' | 'end', value: string): void {
    this.days.update((rows) =>
      rows.map((r) =>
        r.key === key ? { ...r, [field]: value } : r,
      ),
    );
    this.dirty.set(true);
  }

  protected reset(): void {
    const s = this.schedule();
    if (s) {
      this.globalEnabled.set(s.enabled);
      this.timezone.set(s.timezone);
      this.days.set(this.scheduleToDays(s));
    } else {
      this.globalEnabled.set(false);
      this.timezone.set('Europe/Paris');
      this.days.set(this.defaultDays());
    }
    this.dirty.set(false);
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    try {
      const payload = this.buildPayload();
      const result = await firstValueFrom(
        this.schedulesApi.upsert(this.vehicleId(), payload),
      );
      this.schedule.set(result);
      this.dirty.set(false);
      this.toast.success('Horaires enregistrés');
    } catch (err: any) {
      this.toast.error(
        'Erreur',
        err?.error?.message ?? 'Impossible de sauvegarder',
      );
    } finally {
      this.saving.set(false);
    }
  }

  protected isOverrideActive(overrideUntil: string): boolean {
    return new Date(overrideUntil) > new Date();
  }

  private buildPayload(): UpsertSchedulePayload {
    const d = this.days();
    const get = (key: string) => d.find((r) => r.key === key)!;
    const extras = this.extraSlotsByDay();

    const dayPayload = (key: string) => {
      const row = get(key);
      const dayExtras = extras[key] ?? [];
      // Reconstitue les slots a partir de start/end + extras.
      const slots = row.enabled && row.start && row.end
        ? [{ start: row.start, end: row.end }, ...dayExtras.filter((s) => s.start && s.end)]
        : [];
      return {
        [`${key}Enabled`]: row.enabled,
        [`${key}Start`]: row.enabled && row.start ? row.start : null,
        [`${key}End`]: row.enabled && row.end ? row.end : null,
        [`${key}Slots`]: slots.length > 1 ? slots : undefined,
      };
    };

    const customDates = this.customDates()
      .filter((cd) => cd.date)
      .map((cd) => ({
        date: cd.date,
        closed: cd.closed,
        slots: cd.closed || !cd.start || !cd.end ? undefined : [{ start: cd.start, end: cd.end }],
      }));

    return {
      enabled: this.globalEnabled(),
      timezone: this.timezone(),
      ...dayPayload('monday'),
      ...dayPayload('tuesday'),
      ...dayPayload('wednesday'),
      ...dayPayload('thursday'),
      ...dayPayload('friday'),
      ...dayPayload('saturday'),
      ...dayPayload('sunday'),
      countryCode: this.countryCode() || undefined,
      customDates: customDates.length > 0 ? customDates : undefined,
    } as UpsertSchedulePayload;
  }

  /** V1.6 (P1) — Helper qui retourne toujours un array (jamais undefined) pour le @for du template. */
  protected slotsForDay(dayKey: string): Array<{ start: string; end: string }> {
    return this.extraSlotsByDay()[dayKey] ?? [];
  }

  // V1.6 (P1) — gestion des plages additionnelles par jour.
  protected addSlot(dayKey: string): void {
    const current = this.extraSlotsByDay();
    const list = [...(current[dayKey] ?? [])];
    if (list.length >= 2) return; // 1 (start/end) + 2 extras = 3 max par jour
    list.push({ start: '14:00', end: '18:00' });
    this.extraSlotsByDay.set({ ...current, [dayKey]: list });
    this.dirty.set(true);
  }

  protected removeSlot(dayKey: string, idx: number): void {
    const current = this.extraSlotsByDay();
    const list = [...(current[dayKey] ?? [])];
    list.splice(idx, 1);
    this.extraSlotsByDay.set({ ...current, [dayKey]: list });
    this.dirty.set(true);
  }

  protected updateSlot(dayKey: string, idx: number, field: 'start' | 'end', value: string): void {
    const current = this.extraSlotsByDay();
    const list = [...(current[dayKey] ?? [])];
    if (!list[idx]) return;
    list[idx] = { ...list[idx], [field]: value };
    this.extraSlotsByDay.set({ ...current, [dayKey]: list });
    this.dirty.set(true);
  }

  protected onCountryChange(value: string): void {
    this.countryCode.set(value);
    this.dirty.set(true);
  }

  protected addCustomDate(): void {
    const today = new Date().toISOString().slice(0, 10);
    this.customDates.update((list) => [...list, { date: today, closed: true }]);
    this.dirty.set(true);
  }

  protected removeCustomDate(idx: number): void {
    this.customDates.update((list) => list.filter((_, i) => i !== idx));
    this.dirty.set(true);
  }

  protected updateCustomDate(idx: number, patch: Partial<CustomDateRow>): void {
    this.customDates.update((list) => list.map((cd, i) => (i === idx ? { ...cd, ...patch } : cd)));
    this.dirty.set(true);
  }

  protected toggleAdvanced(): void {
    this.advancedExpanded.update((v) => !v);
  }

  private defaultDays(): DayRow[] {
    return DAY_KEYS.map((key) => ({
      key,
      label: DAY_LABELS[key],
      enabled: !['saturday', 'sunday'].includes(key),
      start: '08:00',
      end: '20:00',
    }));
  }

  private scheduleToDays(s: VehicleScheduleDto): DayRow[] {
    return DAY_KEYS.map((key) => ({
      key,
      label: DAY_LABELS[key],
      enabled: (s as any)[`${key}Enabled`] ?? false,
      start: (s as any)[`${key}Start`] ?? '08:00',
      end: (s as any)[`${key}End`] ?? '20:00',
    }));
  }
}
