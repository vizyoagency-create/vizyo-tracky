import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Clock, Save, X, Shield } from 'lucide-angular';
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
      <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] overflow-hidden">
        <!-- Header -->
        <div class="flex items-center justify-between gap-3 p-3 sm:p-4 border-b border-border-subtle">
          <div class="flex items-center gap-2 sm:gap-3 min-w-0">
            <lucide-icon [img]="ShieldIcon" [size]="20" class="text-tracky-light shrink-0"></lucide-icon>
            <span class="text-sm font-semibold text-fg-primary truncate">Automatisation horaire</span>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <!-- Global toggle -->
            <label class="flex items-center gap-2 cursor-pointer">
              <span class="text-xs text-fg-tertiary hidden sm:inline">{{ globalEnabled() ? 'Active' : 'Inactive' }}</span>
              <button
                type="button"
                (click)="onToggleGlobal()"
                [disabled]="readonly()"
                class="relative w-10 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-50"
                [class]="globalEnabled() ? 'bg-tracky' : 'bg-bg-tertiary border border-border-subtle'"
              >
                <span
                  class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                  [class]="globalEnabled() ? 'translate-x-5' : 'translate-x-0.5'"
                ></span>
              </button>
            </label>
          </div>
        </div>

        <!-- Timezone -->
        <div class="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3 border-b border-border-subtle/50">
          <lucide-icon [img]="ClockIcon" [size]="14" class="text-fg-tertiary shrink-0"></lucide-icon>
          <span class="text-xs text-fg-tertiary shrink-0">Fuseau horaire</span>
          <select
            [ngModel]="timezone()"
            (ngModelChange)="timezone.set($event); dirty.set(true)"
            [disabled]="readonly()"
            class="ml-auto min-w-0 max-w-[60%] text-xs bg-bg-tertiary text-fg-primary border border-border-subtle
                   rounded-lg px-2 py-1 outline-none focus:border-tracky/50 truncate"
          >
            @for (tz of timezones; track tz.value) {
              <option [value]="tz.value">{{ tz.label }}</option>
            }
          </select>
        </div>

        <!-- Days -->
        <div class="divide-y divide-border-subtle/50">
          @for (day of days(); track day.key) {
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-4 py-3"
                 [class]="day.enabled ? '' : 'opacity-50'">
              <!-- Day toggle -->
              <button
                type="button"
                (click)="toggleDay(day.key)"
                [disabled]="readonly()"
                class="relative w-8 h-4 rounded-full transition-colors cursor-pointer shrink-0 disabled:opacity-50"
                [class]="day.enabled ? 'bg-tracky' : 'bg-bg-tertiary border border-border-subtle'"
              >
                <span
                  class="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
                  [class]="day.enabled ? 'translate-x-4' : 'translate-x-0.5'"
                ></span>
              </button>

              <!-- Day name: takes remaining row on mobile, fixed width on sm+ -->
              <span class="flex-1 min-w-0 sm:flex-none sm:w-24 text-sm font-medium text-fg-primary">
                {{ day.label }}
              </span>

              @if (day.enabled) {
                <!-- Time inputs: full new row on mobile, inline on sm+ -->
                <div class="flex items-center gap-2 w-full sm:w-auto sm:ml-0">
                  <input
                    type="time"
                    [ngModel]="day.start"
                    (ngModelChange)="updateDayTime(day.key, 'start', $event)"
                    [disabled]="readonly()"
                    class="flex-1 sm:flex-none text-xs bg-bg-tertiary text-fg-primary border border-border-subtle
                           rounded-lg px-2 py-1.5 outline-none focus:border-tracky/50
                           disabled:opacity-50"
                  />
                  <span class="text-fg-tertiary text-xs shrink-0">→</span>
                  <input
                    type="time"
                    [ngModel]="day.end"
                    (ngModelChange)="updateDayTime(day.key, 'end', $event)"
                    [disabled]="readonly()"
                    class="flex-1 sm:flex-none text-xs bg-bg-tertiary text-fg-primary border border-border-subtle
                           rounded-lg px-2 py-1.5 outline-none focus:border-tracky/50
                           disabled:opacity-50"
                  />
                </div>
              } @else {
                <span class="text-xs text-fg-tertiary italic w-full sm:w-auto">— vehicule immobilise —</span>
              }
            </div>
          }
        </div>

        <!-- Preview -->
        @if (todayPreview(); as preview) {
          <div class="px-4 py-3 border-t border-border-subtle bg-bg-tertiary/30">
            <p class="text-xs text-fg-secondary">
              {{ preview }}
            </p>
          </div>
        }

        <!-- Override warning -->
        @if (schedule()?.overrideUntil; as overrideUntil) {
          @if (isOverrideActive(overrideUntil)) {
            <div class="px-4 py-2 border-t border-amber-500/20 bg-amber-500/5">
              <p class="text-xs text-amber-400">
                Commande manuelle en cours — automatisation suspendue temporairement
              </p>
            </div>
          }
        }

        <!-- Actions -->
        @if (!readonly()) {
          <div class="flex items-center justify-end gap-2 p-4 border-t border-border-subtle">
            @if (dirty()) {
              <button
                (click)="reset()"
                class="px-3 py-1.5 text-xs rounded-lg bg-bg-tertiary text-fg-tertiary
                       border border-border-subtle hover:text-fg-primary transition-colors cursor-pointer"
              >
                <lucide-icon [img]="XIcon" [size]="12" class="inline mr-1"></lucide-icon>
                Annuler
              </button>
            }
            <button
              (click)="save()"
              [disabled]="saving() || !dirty()"
              class="px-4 py-1.5 text-xs rounded-lg bg-tracky hover:bg-tracky-dark text-white
                     transition-colors cursor-pointer disabled:opacity-50"
            >
              @if (saving()) {
                <span class="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block mr-1"></span>
              } @else {
                <lucide-icon [img]="SaveIcon" [size]="12" class="inline mr-1"></lucide-icon>
              }
              Enregistrer
            </button>
          </div>
        }
      </div>

      <!-- Confirmation modal for disabling when vehicle is cut -->
      <app-confirm-modal
        [open]="showDisableConfirm()"
        title="Desactiver l'automatisation"
        description="Ce vehicule est actuellement immobilise par l'automatisation horaire. Desactiver va rallumer le moteur automatiquement."
        confirmLabel="Desactiver et rallumer"
        cancelLabel="Annuler"
        [danger]="true"
        [loading]="saving()"
        (confirmed)="confirmDisable()"
        (cancelled)="cancelDisable()"
      />
    }
  `,
})
export class VehicleScheduleComponent {
  readonly vehicleId = input.required<string>();
  readonly hasTracker = input(false);

  private readonly schedulesApi = inject(VehicleSchedulesApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly ClockIcon = Clock;
  protected readonly SaveIcon = Save;
  protected readonly XIcon = X;
  protected readonly ShieldIcon = Shield;
  protected readonly timezones = TIMEZONES;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly dirty = signal(false);
  protected readonly schedule = signal<VehicleScheduleDto | null>(null);
  protected readonly globalEnabled = signal(false);
  protected readonly timezone = signal('Europe/Paris');
  protected readonly days = signal<DayRow[]>(this.defaultDays());
  protected readonly showDisableConfirm = signal(false);

  protected readonly readonly = computed(() => {
    const role = this.auth.user()?.role;
    return role !== 'FLEET_ADMIN' && role !== 'SUPER_ADMIN';
  });

  protected readonly todayPreview = computed(() => {
    if (!this.globalEnabled()) return null;
    const now = new Date();
    const jsDay = now.getDay();
    const idx = jsDay === 0 ? 6 : jsDay - 1;
    const day = this.days()[idx];
    if (!day) return null;

    const dayLabel = day.label;
    if (!day.enabled) {
      return `Aujourd'hui (${dayLabel}) : vehicule immobilise toute la journee`;
    }
    if (!day.start || !day.end) {
      return `Aujourd'hui (${dayLabel}) : aucune restriction horaire`;
    }
    return `Aujourd'hui (${dayLabel}) : autorise de ${day.start} a ${day.end} (${this.timezone()})`;
  });

  constructor() {
    effect(() => {
      const vid = this.vehicleId();
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
      } else {
        this.globalEnabled.set(false);
        this.timezone.set('Europe/Paris');
        this.days.set(this.defaultDays());
      }
      this.dirty.set(false);
    } catch {
      // No schedule yet → use defaults
    } finally {
      this.loading.set(false);
    }
  }

  /** Toggle global: if disabling while vehicle is cut, show confirmation first. */
  protected onToggleGlobal(): void {
    const currentlyEnabled = this.globalEnabled();
    if (currentlyEnabled) {
      // Disabling — check if vehicle is currently cut by scheduler
      const isCutByScheduler = this.schedule()?.lastEvaluatedState === 'OUT_OF_WINDOW';
      if (isCutByScheduler) {
        this.showDisableConfirm.set(true);
        return;
      }
    }
    // Enable, or disable without cut state → direct toggle
    this.globalEnabled.update((v) => !v);
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
      this.toast.success('Horaires enregistres');
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

    const dayPayload = (key: string) => {
      const row = get(key);
      return {
        [`${key}Enabled`]: row.enabled,
        [`${key}Start`]: row.enabled && row.start ? row.start : null,
        [`${key}End`]: row.enabled && row.end ? row.end : null,
      };
    };

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
    } as UpsertSchedulePayload;
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
