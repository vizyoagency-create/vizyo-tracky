import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, effect, inject, input, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Power, PowerOff } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import {
  EngineControlService,
  type EngineControlCommandDto,
} from '../../core/services/engine-control.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { VehicleSchedulesApiService } from '../../core/services/vehicle-schedules.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { ToastService } from '../../shared/ui/toast/toast.service';

/** Sprint 2 — fenêtre d'attente de confirmation côté UI (aligne le défaut backend 90s). */
const CONFIRM_WINDOW_MS = 90_000;

@Component({
  selector: 'app-engine-control-button',
  standalone: true,
  imports: [LucideAngularModule, ConfirmModalComponent, FormsModule],
  template: `
    <div class="inline-flex items-center shrink-0" (click)="$event.stopPropagation()">
      @if (canCut().allowed || canRestore()) {
        @if (isCutActive()) {
          <button
            (click)="openAction('restore')"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                   bg-tracky/20 text-tracky-light border border-tracky/30
                   hover:bg-tracky/30 transition-all cursor-pointer whitespace-nowrap"
          >
            <lucide-icon [img]="Power" [size]="14"></lucide-icon>
            <span class="hidden sm:inline">Rallumer le moteur</span>
            <span class="sm:hidden">Rallumer</span>
          </button>
        } @else {
          <button
            (click)="canCut().allowed ? openAction('cut') : null"
            [disabled]="!canCut().allowed"
            [title]="canCut().reason ?? ''"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                   transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            [class]="canCut().allowed
              ? 'bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30'
              : 'bg-bg-tertiary text-fg-tertiary border border-border-subtle'"
          >
            <lucide-icon [img]="PowerOff" [size]="14"></lucide-icon>
            <span class="hidden sm:inline">Couper le moteur</span>
            <span class="sm:hidden">Couper</span>
          </button>
        }
      }

      <!-- Sprint 2 — etat honnete de la derniere commande (jamais de faux succes). -->
      @if (commandState(); as st) {
        <span class="ml-2 inline-flex items-center gap-1 text-[11px] font-medium {{ st.textClass }} whitespace-nowrap"
              [title]="st.label">
          <span class="w-1.5 h-1.5 rounded-full shrink-0 {{ st.dotClass }}"></span>
          {{ st.short }}
        </span>
      }

      <app-confirm-modal
        [open]="isOpen() === 'cut' && !scheduleEnabled()"
        title="Couper le moteur ?"
        [description]="cutDescription()"
        confirmLabel="Oui, couper le moteur"
        cancelLabel="Annuler"
        [danger]="true"
        [loading]="loading()"
        (confirmed)="onConfirm('CUT')"
        (cancelled)="isOpen.set(null)"
      >
        <textarea
          [ngModel]="reason()"
          (ngModelChange)="reason.set($event)"
          placeholder="Raison (ex: véhicule volé, non-paiement...)"
          maxlength="500"
          rows="2"
          class="w-full mt-3 px-3 py-2 text-sm rounded-lg bg-bg-tertiary border border-border-subtle
                 text-fg-primary placeholder:text-fg-tertiary resize-none
                 focus:outline-none focus:border-tracky"
        ></textarea>
      </app-confirm-modal>

      <app-confirm-modal
        [open]="isOpen() === 'restore' && !scheduleEnabled()"
        title="Rallumer le moteur ?"
        [description]="'Le véhicule <strong>' + vehiclePlate() + '</strong> sera à nouveau utilisable.'"
        confirmLabel="Oui, rallumer"
        cancelLabel="Annuler"
        [danger]="false"
        [loading]="loading()"
        (confirmed)="onConfirm('RESTORE')"
        (cancelled)="isOpen.set(null)"
      />

      <!-- Modal spécifique quand le mode horaire est actif -->
      <app-confirm-modal
        [open]="isOpen() !== null && scheduleEnabled()"
        [title]="isOpen() === 'cut' ? 'Couper le moteur ?' : 'Rallumer le moteur ?'"
        [description]="scheduleWarningDescription()"
        [confirmLabel]="isOpen() === 'cut' ? 'Désactiver horaire et couper' : 'Désactiver horaire et rallumer'"
        cancelLabel="Annuler"
        [danger]="isOpen() === 'cut'"
        [loading]="loading()"
        (confirmed)="onConfirmWithScheduleDisable()"
        (cancelled)="isOpen.set(null)"
      />
    </div>
  `,
})
export class EngineControlButtonComponent implements OnInit {
  readonly trackerId = input.required<string>();
  readonly vehicleId = input<string | undefined>(undefined);
  readonly vehiclePlate = input.required<string>();
  readonly currentSpeedKmh = input<number | undefined>(undefined);
  readonly validFix = input(false);
  readonly positionAge = input<number | undefined>(undefined);
  readonly ignition = input(true);
  /** Si true, un schedule horaire est actif sur ce véhicule (input ou chargé dynamiquement). */
  readonly scheduleEnabledInput = input(false, { alias: 'scheduleEnabled' });
  /** Emis quand une action manuelle désactive le schedule horaire. */
  readonly scheduleDisabled = output<void>();

  protected readonly isOpen = signal<'cut' | 'restore' | null>(null);
  protected readonly loading = signal(false);
  protected readonly reason = signal('');
  protected readonly recentCommands = signal<EngineControlCommandDto[]>([]);
  private readonly _scheduleEnabled = signal(false);
  protected readonly scheduleEnabled = computed(() => this.scheduleEnabledInput() || this._scheduleEnabled());

  protected readonly Power = Power;
  protected readonly PowerOff = PowerOff;

  private readonly authService = inject(AuthService);
  private readonly engineControl = inject(EngineControlService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);
  private readonly realtime = inject(RealtimeService);
  private readonly schedulesApi = inject(VehicleSchedulesApiService);

  /**
   * V1.11 Phase 1 — VehicleId effectif : prend l'input si fourni, sinon resout
   * via le snapshot realtime (compat avec usages historiques). Necessaire pour
   * la verification de permission per-vehicle (engine_control).
   */
  protected readonly effectiveVehicleId = computed<string | undefined>(() => {
    const direct = this.vehicleId();
    if (direct) return direct;
    return this.realtime.snapshot().find((v) => v.trackerId === this.trackerId())?.vehicleId;
  });

  readonly isCutActive = computed(() => {
    const cmds = this.recentCommands();
    // Sprint 2 (Obj 3) — etat "coupe" = derniere commande CONFIRMEE (ACKNOWLEDGED),
    // TOUTES sources incluses (DEVICE_OBSERVED = coupure SMS/externe detectee par la
    // chute d'ignition). Une coupure seulement SENT (pas encore confirmee) NE compte
    // PAS : l'etat ne bascule qu'a la preuve reelle — jamais de faux succes.
    const lastCut = cmds.find((c) => c.action === 'CUT' && c.status === 'ACKNOWLEDGED');
    // Revue #1 — un RESTORE nettoie l'etat des l'ENVOI (SENT||ACK) : rallumer est
    // toujours sur, on ne requiert PAS de preuve device pour CESSER d'afficher
    // "coupe". Sinon le bouton resterait colle sur « Rallumer » (un RESTORE app
    // n'atteint jamais ACKNOWLEDGED : seul un CUT est confirme par la chute d'ignition).
    const lastRestore = cmds.find(
      (c) => c.action === 'RESTORE' && (c.status === 'SENT' || c.status === 'ACKNOWLEDGED'),
    );
    if (!lastCut) return false;
    if (!lastRestore) return true;
    return new Date(lastCut.createdAt) > new Date(lastRestore.createdAt);
  });

  // Sprint 2 — tick 5s : fait basculer l'affichage "en attente" -> "non confirmee"
  // au depassement de la fenetre, sans refetch.
  private readonly _now = signal(Date.now());
  constructor() {
    const id = setInterval(() => this._now.set(Date.now()), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  /** Sprint 2 — derniere commande APP (hors DEVICE_OBSERVED) = l'action en cours. */
  private readonly lastAppCommand = computed(
    () => this.recentCommands().find((c) => c.source !== 'DEVICE_OBSERVED') ?? null,
  );

  /**
   * Sprint 2 — etat honnete de la derniere commande app : en attente / confirmee /
   * non confirmee / non verifiable / echec. Garantit qu'on n'affiche JAMAIS un faux
   * succes (l'etat "coupe" du bouton ne passe qu'a la confirmation reelle).
   */
  readonly commandState = computed<{ short: string; label: string; textClass: string; dotClass: string } | null>(() => {
    const c = this.lastAppCommand();
    if (!c || c.status === 'PENDING' || c.status === 'REJECTED_SPEED') return null;
    const verb = c.action === 'CUT' ? 'Coupure' : 'Rallumage';
    if (c.status === 'ACKNOWLEDGED') {
      return {
        short: c.action === 'CUT' ? 'Coupure confirmée' : 'Rallumage confirmé',
        label: `${verb} confirmé(e) par le boîtier (chute d'ignition).`,
        textClass: 'text-tracky-light',
        dotClass: 'bg-tracky-light',
      };
    }
    if (c.status === 'FAILED') {
      return {
        short: 'Échec d\'envoi',
        label: c.lastError ?? 'La commande n\'a pas pu être envoyée au boîtier.',
        textClass: 'text-red-400',
        dotClass: 'bg-red-500',
      };
    }
    // status === 'SENT'
    if (c.confirmationExpected === false) {
      return {
        short: 'Envoyée',
        label: `${verb} envoyée — confirmation par ignition indisponible (véhicule à l'arrêt). À vérifier physiquement.`,
        textClass: 'text-fg-tertiary',
        dotClass: 'bg-fg-tertiary',
      };
    }
    const ageMs = this._now() - new Date(c.sentAt ?? c.createdAt).getTime();
    if (ageMs < CONFIRM_WINDOW_MS) {
      return {
        short: 'En attente…',
        label: `${verb} envoyée — en attente de confirmation du boîtier…`,
        textClass: 'text-amber-400',
        dotClass: 'bg-amber-400 animate-pulse',
      };
    }
    return {
      short: 'Non confirmée',
      label: `${verb} envoyée mais NON confirmée par le boîtier — à vérifier.`,
      textClass: 'text-red-400',
      dotClass: 'bg-red-500',
    };
  });

  readonly canCut = computed(() => {
    // V1.11 Phase 1 — Permission per-vehicle. Admin bypass deja gere par perms.can.
    const vid = this.effectiveVehicleId();
    if (!vid) {
      return { allowed: false as const, reason: 'Vehicule non identifie' };
    }
    if (!this.perms.can('engine_control', vid)) {
      return { allowed: false as const, reason: 'Permission insuffisante' };
    }

    const age = this.positionAge();
    if (age === undefined) {
      return { allowed: false as const, reason: 'Aucune position connue' };
    }
    const speed = this.currentSpeedKmh();
    // À l'arrêt (≤5 km/h) → pas de seuil stale, véhicule garé sans risque.
    // En mouvement → position fraîche (<60s) exigée pour confirmer la vitesse.
    const isAtRest = speed === undefined || speed <= 5;
    if (!isAtRest && age > 60) {
      return { allowed: false as const, reason: `Position trop ancienne (${Math.round(age)}s)` };
    }
    if (!this.validFix()) {
      return { allowed: false as const, reason: 'Fix GPS invalide' };
    }
    if (speed !== undefined && speed > 20) {
      return { allowed: false as const, reason: `Vitesse trop élevée (${speed.toFixed(1)} km/h)` };
    }
    return { allowed: true as const, reason: null };
  });

  readonly canRestore = computed(() => {
    const vid = this.effectiveVehicleId();
    if (!vid) return false;
    return this.perms.can('engine_control', vid);
  });

  protected readonly cutDescription = computed(
    () =>
      `Vous êtes sur le point d'immobiliser le véhicule <strong>${this.vehiclePlate()}</strong>.<br><br>` +
      `Le conducteur sera impacté immédiatement et le véhicule deviendra inutilisable ` +
      `jusqu'à réactivation manuelle.<br><br>` +
      `<span class="text-fg-tertiary text-xs">Cette action sera enregistrée dans l'audit trail.</span>`,
  );

  protected readonly scheduleWarningDescription = computed(() => {
    const plate = this.vehiclePlate();
    const action = this.isOpen() === 'cut'
      ? `immobiliser le véhicule <strong>${plate}</strong>`
      : `rallumer le véhicule <strong>${plate}</strong>`;
    return (
      `Vous êtes sur le point de ${action}.<br><br>` +
      `<strong>Le mode horaire est actuellement actif.</strong> ` +
      `Cette action le désactivera automatiquement. ` +
      `Vous devrez le réactiver manuellement dans l'onglet Horaires.<br><br>` +
      `<span class="text-fg-tertiary text-xs">Cette action sera enregistrée dans l'audit trail.</span>`
    );
  });

  // React to real-time engine command updates for this tracker (field initializer = injection context)
  private readonly engineUpdateEffect = effect(() => {
    const updates = this.realtime.engineCommandUpdates();
    const update = updates.get(this.trackerId());
    if (update) {
      this.loadRecentCommands();
    }
  });

  ngOnInit(): void {
    this.loadRecentCommands();
    this.loadScheduleStatus();
  }

  protected async openAction(action: 'cut' | 'restore'): Promise<void> {
    // Rafraîchir l'état schedule avant d'ouvrir le modal (état le plus frais)
    await this.loadScheduleStatus();
    this.isOpen.set(action);
  }

  protected async onConfirmWithScheduleDisable(): Promise<void> {
    const action = this.isOpen() === 'cut' ? 'CUT' as const : 'RESTORE' as const;
    if (this.loading()) return;
    this.loading.set(true);
    const reasonText = action === 'CUT' ? this.reason() || 'Action manuelle (horaire désactivé)' : undefined;
    // Fermer la modal DÈS la soumission (avant l'attente réseau), succès comme erreur/409 :
    // sinon elle reste ouverte par-dessus et masque le toast + la pastille. Cf smoke prod 2026-06-18.
    this.isOpen.set(null);
    this.reason.set('');
    try {
      await firstValueFrom(
        this.engineControl.requestCommand(this.trackerId(), action, reasonText, true /* disableSchedule */),
      );
      this.toast.success(
        action === 'CUT' ? 'Coupure envoyée' : 'Rallumage envoyé',
        'Mode horaire désactivé — en attente de confirmation du boîtier…',
      );
      this._scheduleEnabled.set(false);
      this.scheduleDisabled.emit();
      await this.loadRecentCommands();
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 409) {
        this.toast.error(
          'Commande déjà en cours',
          'Une coupure est déjà en attente de confirmation sur ce véhicule.',
        );
      } else {
        this.toast.error(
          action === 'CUT' ? 'Coupure refusée' : 'Rallumage refusé',
          this.extractErrorMessage(err),
        );
      }
    } finally {
      this.loading.set(false);
    }
  }

  protected async onConfirm(action: 'CUT' | 'RESTORE'): Promise<void> {
    if (this.loading()) return; // Protection double-clic
    this.loading.set(true);
    const reasonText = action === 'CUT' ? this.reason() || undefined : undefined;
    // Fermer la modal DÈS la soumission (avant l'attente réseau), succès comme erreur/409 :
    // sinon elle reste ouverte par-dessus et masque le toast + la pastille. Cf smoke prod 2026-06-18.
    this.isOpen.set(null);
    this.reason.set('');
    try {
      const cmd = await firstValueFrom(
        this.engineControl.requestCommand(this.trackerId(), action, reasonText),
      );
      // Sprint 2 — PAS de faux succes : on annonce "envoyee" ; la confirmation
      // (chute d'ignition) fera basculer l'etat coupe via le WS + commandState.
      this.toast.success(
        action === 'CUT' ? 'Coupure envoyée' : 'Rallumage envoyé',
        action === 'CUT'
          ? `Commande ${cmd.id.slice(0, 8)} — en attente de confirmation du boîtier…`
          : `Commande ${cmd.id.slice(0, 8)} transmise au véhicule.`,
      );
      await this.loadRecentCommands();
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 409) {
        this.toast.error(
          'Commande déjà en cours',
          'Une coupure est déjà en attente de confirmation sur ce véhicule.',
        );
      } else {
        this.toast.error(
          action === 'CUT' ? 'Coupure refusée' : 'Rallumage refusé',
          this.extractErrorMessage(err),
        );
      }
    } finally {
      this.loading.set(false);
    }
  }

  private async loadScheduleStatus(): Promise<void> {
    // Trouver le vehicleId depuis l'input ou le snapshot (fallback)
    let vid = this.vehicleId();
    if (!vid) {
      const snap = this.realtime.snapshot().find((v) => v.trackerId === this.trackerId());
      vid = snap?.vehicleId;
    }
    if (!vid) return;
    try {
      const schedule = await firstValueFrom(this.schedulesApi.get(vid));
      this._scheduleEnabled.set(!!schedule?.enabled);
    } catch {
      // Non critique
    }
  }

  private async loadRecentCommands(retries = 2): Promise<void> {
    try {
      const cmds = await firstValueFrom(
        this.engineControl.listCommands(this.trackerId(), 5),
      );
      this.recentCommands.set(cmds);
    } catch {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 1000));
        return this.loadRecentCommands(retries - 1);
      }
      // Après retries épuisés, le bouton garde le dernier état connu
    }
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      // L'API enveloppe ses erreurs : `{ error: { code, message, requestId } }`.
      // On lit d'abord le message de l'enveloppe, puis les formes plates en repli —
      // sinon l'opérateur verrait « Http failure response … 403 » au lieu de la vraie
      // raison (ex. « Véhicule en mouvement (10 km/h) — coupure réservée à l'arrêt »).
      const body = err.error as { error?: { message?: string }; message?: string } | null;
      return body?.error?.message ?? body?.message ?? err.message ?? 'Erreur inconnue';
    }
    return String(err);
  }
}
