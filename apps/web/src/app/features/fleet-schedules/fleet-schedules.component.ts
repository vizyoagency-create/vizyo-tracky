import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type OnDestroy,
  type OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlarmClock,
  AlertTriangle,
  Car,
  Check,
  LucideAngularModule,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  Timer,
  X,
} from 'lucide-angular';
import type {
  BulkScheduleApplyItemResult,
  BulkSchedulePreviewResponse,
  FleetScheduleRowDto,
} from '@vizyo/tracky-shared';
import { AuthService } from '../../core/services/auth.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import {
  VehicleSchedulesApiService,
  type UpsertSchedulePayload,
} from '../../core/services/vehicle-schedules.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { VehicleScheduleComponent } from '../vehicles/vehicle-schedule/vehicle-schedule.component';
import { firstValueFrom } from 'rxjs';

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
type DayKey = (typeof DAY_KEYS)[number];
const DAY_LABELS: Record<DayKey, string> = {
  monday: 'Lun', tuesday: 'Mar', wednesday: 'Mer', thursday: 'Jeu',
  friday: 'Ven', saturday: 'Sam', sunday: 'Dim',
};

type CutDisplay = 'cut' | 'pending' | 'normal';
type PendingDisplay = 'DRIVING' | 'AWAITING_STOP' | 'OFFLINE' | null;
/** Type d'une icône lucide (dérivé d'une icône réelle — lucide-angular n'exporte pas le type). */
type LucideIcon = typeof Timer;

@Component({
  selector: 'app-fleet-schedules',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, LucideAngularModule, VehicleScheduleComponent],
  templateUrl: './fleet-schedules.component.html',
  styleUrl: './fleet-schedules.component.css',
})
export class FleetSchedulesComponent implements OnInit, OnDestroy {
  private readonly api = inject(VehicleSchedulesApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly perms = inject(PermissionsService);

  /** Super-admin : voit toutes les flottes → un bulk SANS société choisie toucherait tout le monde. */
  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  /** Bulk interdit tant qu'un super-admin n'a pas choisi une société (filtre du haut). */
  protected readonly bulkBlocked = computed(() => this.isSuperAdmin() && !this.fleetFilter.selectedFleetId());

  // Icônes
  protected readonly AlarmClockIcon = AlarmClock;
  protected readonly AlertTriangleIcon = AlertTriangle;
  protected readonly CarIcon = Car;
  protected readonly CheckIcon = Check;
  protected readonly TimerIcon = Timer;
  protected readonly PencilIcon = Pencil;
  protected readonly PowerIcon = Power;
  protected readonly PowerOffIcon = PowerOff;
  protected readonly RefreshCwIcon = RefreshCw;
  protected readonly XIcon = X;

  // ── État liste ──
  protected readonly rows = signal<FleetScheduleRowDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly nowMs = signal(Date.now());
  /** Décalage horloge serveur − client (aligne les compte-à-rebours sur l'heure serveur). */
  protected readonly skew = signal(0);
  protected readonly cutMinStoppedSec = signal(600);
  protected readonly truncated = signal(false);
  protected readonly lastUpdated = signal<number | null>(null);

  // Overlays temps réel (Sets d'IDs tracker) — plus frais que le poll entre 2 rafraîchissements.
  private readonly cutActive = this.realtime.cutActiveTrackerIds;
  private readonly cutPendingIds = this.realtime.cutPendingTrackerIds;
  private readonly movingIds = this.realtime.movingTrackerIds;

  // ── Drawer d'édition (réutilise l'éditeur de la fiche véhicule) ──
  protected readonly editingVehicleId = signal<string | null>(null);
  protected readonly editingHasTracker = signal(false);
  protected readonly editingPlate = signal<string | null>(null);

  // ── Bulk ──
  protected readonly bulkStart = signal('08:00');
  protected readonly bulkEnd = signal('22:00');
  protected readonly bulkDays = signal<Record<DayKey, boolean>>({
    monday: true, tuesday: true, wednesday: true, thursday: true,
    friday: true, saturday: true, sunday: true,
  });
  protected readonly previewData = signal<BulkSchedulePreviewResponse | null>(null);
  protected readonly previewLoading = signal(false);
  protected readonly applying = signal(false);
  protected readonly pendingDisable = signal(false);

  // Panneau de SUIVI après application (pensé pour des utilisateurs pressés / non-techniques).
  protected readonly applyResults = signal<BulkScheduleApplyItemResult[] | null>(null);
  protected readonly applyCut = computed(() => (this.applyResults() ?? []).filter((r) => r.ok && r.immediate === 'cut'));
  protected readonly applyPending = computed(() => (this.applyResults() ?? []).filter((r) => r.ok && r.immediate === 'deferred'));
  protected readonly applyNone = computed(() => (this.applyResults() ?? []).filter((r) => r.ok && r.immediate === 'none'));
  protected readonly applyFailed = computed(() => (this.applyResults() ?? []).filter((r) => !r.ok));
  /** Combien de « en attente » ont FINI par être coupés (synchro live) — pour la barre de progression. */
  protected readonly applyPendingDoneCount = computed(
    () => this.applyPending().filter((r) => this.pendingResolved(r.vehicleId)).length,
  );
  protected readonly DAY_KEYS = DAY_KEYS;
  protected readonly DAY_LABELS = DAY_LABELS;

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && !document.hidden) {
      this.nowMs.set(Date.now());
      void this.load(true);
    }
  };

  // ── Filtre société (SUPER_ADMIN) : la liste renvoie tout, on filtre côté client ──
  protected readonly filteredRows = computed(() => {
    const sel = this.fleetFilter.selectedFleetId();
    const all = this.rows();
    return sel ? all.filter((r) => r.fleetId === sel) : all;
  });

  protected readonly summary = computed(() => {
    const rows = this.filteredRows();
    let enabled = 0, outOfWindow = 0, cut = 0, driving = 0, awaiting = 0, noTracker = 0;
    for (const r of rows) {
      if (r.scheduleEnabled) enabled++;
      if (r.windowState === 'OUT_OF_WINDOW') outOfWindow++;
      // Revue : ne compter que les coupes CONFIRMÉES (pas les 'pending' non confirmées par le boîtier).
      if (this.displayCut(r) === 'cut') cut++;
      const pr = this.displayPending(r);
      if (pr === 'DRIVING') driving++;
      else if (pr === 'AWAITING_STOP') awaiting++;
      if (!r.hasTracker) noTracker++;
    }
    return { total: rows.length, enabled, outOfWindow, cut, driving, awaiting, noTracker };
  });

  /** Véhicules qui ROULENT ENCORE après leur heure de coupe → à surveiller en priorité. */
  protected readonly drivingRows = computed(() =>
    this.filteredRows().filter((r) => this.displayPending(r) === 'DRIVING'),
  );

  ngOnInit(): void {
    void this.load();
    this.pollHandle = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void this.load(true);
    }, 20_000);
    this.tickHandle = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) this.nowMs.set(Date.now());
    }, 1_000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  protected async load(isRefresh = false): Promise<void> {
    if (isRefresh) this.refreshing.set(true);
    else this.loading.set(true);
    try {
      const res = await firstValueFrom(this.api.listFleet());
      this.rows.set(res.items);
      this.cutMinStoppedSec.set(res.scheduleCutMinStoppedSec);
      this.truncated.set(res.awaitingStopScanTruncated);
      this.skew.set(new Date(res.serverNow).getTime() - Date.now());
      // Revue : réconcilier l'overlay live « en mouvement » avec la source de vérité (poll).
      // seedMovingState ajoute les moving=true ET retire les moving=false → un event d'arrêt
      // manqué (ou une reconnexion socket) ne laisse plus un véhicule figé sur « roule encore ».
      this.realtime.seedMovingState(
        res.items.filter((r) => r.trackerId).map((r) => ({ trackerId: r.trackerId as string, moving: r.moving })),
      );
      this.nowMs.set(Date.now());
      this.lastUpdated.set(Date.now());
      this.error.set(null);
    } catch (e) {
      const msg = (e as { error?: { message?: string } })?.error?.message ?? 'Chargement impossible';
      this.error.set(msg);
      if (isRefresh) {
        // Silencieux sur un poll de fond raté ; on garde les dernières données.
      } else {
        this.toast.error('Horaires flotte', msg);
      }
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  // ─────────────────── État d'affichage (poll + overlay temps réel) ───────────────────

  protected displayCut(r: FleetScheduleRowDto): CutDisplay {
    const tid = r.trackerId;
    if (tid && this.cutActive().has(tid)) return 'cut';
    if (tid && this.cutPendingIds().has(tid)) return 'pending';
    return (r.engineCutState as CutDisplay) ?? 'normal';
  }

  protected displayMoving(r: FleetScheduleRowDto): boolean {
    const tid = r.trackerId;
    if (tid && this.movingIds().has(tid)) return true;
    return r.moving;
  }

  /** Recalcule le motif de report avec la fraîcheur temps réel (mouvement + coupe live). */
  protected displayPending(r: FleetScheduleRowDto): PendingDisplay {
    if (!r.scheduleEnabled || r.overrideActive) return null;
    if (r.windowState !== 'OUT_OF_WINDOW') return null;
    if (this.displayCut(r) !== 'normal') return null; // déjà coupé / en cours
    if (this.displayMoving(r)) return 'DRIVING';
    return r.pendingReason === 'OFFLINE' ? 'OFFLINE' : 'AWAITING_STOP';
  }

  protected stateChip(r: FleetScheduleRowDto): { label: string; cls: string; icon: LucideIcon } {
    if (!r.hasTracker) return { label: 'Sans boîtier', cls: 'chip-muted', icon: this.CarIcon };
    if (!r.scheduleEnabled) return { label: 'Automatisation off', cls: 'chip-muted', icon: this.PowerIcon };
    if (r.overrideActive) return { label: 'Suspendu (manuel)', cls: 'chip-info', icon: this.AlarmClockIcon };

    const cut = this.displayCut(r);
    const pending = this.displayPending(r);
    if (pending === 'DRIVING') return { label: 'Roule encore', cls: 'chip-danger', icon: this.AlertTriangleIcon };
    if (pending === 'AWAITING_STOP') return { label: "En attente d'arrêt", cls: 'chip-warn', icon: this.TimerIcon };
    if (pending === 'OFFLINE') return { label: 'Coupe en attente (hors ligne)', cls: 'chip-warn', icon: this.TimerIcon };
    if (cut === 'cut') return { label: 'Coupé (horaire)', cls: 'chip-cut', icon: this.PowerOffIcon };
    if (cut === 'pending') return { label: 'Coupe envoyée', cls: 'chip-warn', icon: this.PowerOffIcon };
    if (r.windowState === 'IN_WINDOW') return { label: 'Autorisé', cls: 'chip-ok', icon: this.PowerIcon };
    return { label: 'Hors plage', cls: 'chip-muted', icon: this.PowerOffIcon };
  }

  /** Compte-à-rebours vers la prochaine bascule (coupe/reprise). */
  protected countdown(r: FleetScheduleRowDto): string | null {
    if (!r.nextTransitionAt) return null;
    const ms = new Date(r.nextTransitionAt).getTime() - (this.nowMs() + this.skew());
    if (ms <= 0) return 'imminent';
    return this.fmtDuration(ms);
  }

  protected countdownVerb(r: FleetScheduleRowDto): string {
    return r.nextTransitionAction === 'CUT' ? 'Coupe dans' : 'Reprise dans';
  }

  /** Compte-à-rebours « coupe possible une fois immobile 10 min ». */
  protected awaitingCountdown(r: FleetScheduleRowDto): string | null {
    if (this.displayPending(r) !== 'AWAITING_STOP' || !r.awaitingStopUntil) return null;
    const ms = new Date(r.awaitingStopUntil).getTime() - (this.nowMs() + this.skew());
    if (ms <= 0) return 'imminent';
    return this.fmtDuration(ms);
  }

  private fmtDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
    if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`;
    return `${s} s`;
  }

  protected canEdit(r: FleetScheduleRowDto): boolean {
    return this.perms.can('schedules_manage', r.vehicleId);
  }

  // ─────────────────── Drawer édition ───────────────────

  protected openEditor(r: FleetScheduleRowDto): void {
    if (!this.canEdit(r)) return;
    this.editingVehicleId.set(r.vehicleId);
    this.editingHasTracker.set(r.hasTracker);
    this.editingPlate.set(r.plate);
  }

  protected closeEditor(): void {
    this.editingVehicleId.set(null);
    // L'éditeur écrit via le même endpoint per-véhicule → on rafraîchit pour refléter le changement.
    void this.load(true);
  }

  // ─────────────────── Bulk ───────────────────

  protected toggleDay(key: DayKey): void {
    this.bulkDays.update((d) => ({ ...d, [key]: !d[key] }));
  }

  private buildPayload(enabled: boolean): UpsertSchedulePayload {
    const days = this.bulkDays();
    const start = this.bulkStart();
    const end = this.bulkEnd();
    // Revue : on n'envoie NI timezone NI countryCode → l'upsert (merge) PRÉSERVE le fuseau/pays
    // propre à chaque véhicule (une flotte hors Europe/Paris n'est pas écrasée en fériés FR).
    // On envoie des *Slots vides + customDates:[] pour que la plage simple s'applique vraiment
    // (efface les multi-plages/dates spéciales éventuelles) et que l'aperçu reflète le résultat réel.
    const rec: Record<string, unknown> = { enabled, customDates: [] };
    for (const d of DAY_KEYS) {
      const on = enabled && days[d];
      rec[`${d}Enabled`] = on;
      rec[`${d}Start`] = on ? start : null;
      rec[`${d}End`] = on ? end : null;
      rec[`${d}Slots`] = [];
    }
    return rec as unknown as UpsertSchedulePayload;
  }

  /** Ouvre l'aperçu (enable) ou prépare la désactivation de masse (disable). */
  protected async openPreview(disable = false): Promise<void> {
    if (this.bulkBlocked()) {
      this.toast.warning('Choisissez une société', 'Sélectionnez une flotte (filtre en haut) avant d\'appliquer en masse.');
      return;
    }
    this.pendingDisable.set(disable);
    this.previewLoading.set(true);
    this.previewData.set(null);
    try {
      const payload = this.buildPayload(!disable);
      const res = await firstValueFrom(
        this.api.bulkPreview({ fleetId: this.fleetFilter.selectedFleetId() ?? undefined, schedule: payload }),
      );
      this.previewData.set(res);
    } catch (e) {
      const msg = (e as { error?: { message?: string } })?.error?.message ?? 'Aperçu impossible';
      this.toast.error('Aperçu', msg);
    } finally {
      this.previewLoading.set(false);
    }
  }

  protected cancelPreview(): void {
    this.previewData.set(null);
  }

  protected async confirmApply(): Promise<void> {
    const disable = this.pendingDisable();
    this.applying.set(true);
    try {
      const payload = this.buildPayload(!disable);
      const res = await firstValueFrom(
        this.api.bulkApply({ fleetId: this.fleetFilter.selectedFleetId() ?? undefined, schedule: payload }),
      );
      this.previewData.set(null);
      await this.load(true); // rafraîchit d'abord les lignes (pour la synchro live des cartes en attente)
      if (disable) {
        // Désactivation : pas de suivi de coupe → simple message.
        this.toast.success('Automatisation désactivée', `${res.applied} véhicule(s).`);
      } else {
        // Activation : on ouvre le PANNEAU DE SUIVI (explique tout, cartes en attente live).
        this.applyResults.set(res.results);
        if (res.failed > 0) {
          this.toast.warning('Appliqué partiellement', `${res.failed} véhicule(s) en échec — voir le détail.`);
        }
      }
    } catch (e) {
      const msg = (e as { error?: { message?: string } })?.error?.message ?? 'Application impossible';
      this.toast.error('Application', msg);
    } finally {
      this.applying.set(false);
    }
  }

  /** Une voiture « en attente » a-t-elle fini par être coupée ? (synchro live via poll + WS coupe) */
  protected pendingResolved(vehicleId: string): boolean {
    const row = this.rows().find((r) => r.vehicleId === vehicleId);
    return row ? this.displayCut(row) !== 'normal' : false;
  }

  /** Motif live d'une voiture encore « en attente » (pour l'étiqueter correctement dans le panneau). */
  protected pendingKind(vehicleId: string): 'resolved' | 'DRIVING' | 'AWAITING_STOP' | 'OFFLINE' | 'unknown' {
    const row = this.rows().find((r) => r.vehicleId === vehicleId);
    if (!row) return 'unknown';
    if (this.displayCut(row) !== 'normal') return 'resolved';
    return this.displayPending(row) ?? 'unknown';
  }

  /** Nb de « en attente » qui NE se résoudront pas seules pour l'instant (hors ligne). */
  protected readonly applyPendingOffline = computed(
    () => this.applyPending().filter((r) => this.pendingKind(r.vehicleId) === 'OFFLINE').length,
  );

  protected closeApplyPanel(): void {
    this.applyResults.set(null);
  }

  protected trackByVehicle = (_: number, r: FleetScheduleRowDto): string => r.vehicleId;
}
