import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, effect, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Power, PowerOff } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import {
  EngineControlService,
  type EngineControlCommandDto,
} from '../../core/services/engine-control.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ConfirmModalComponent } from '../../shared/ui/confirm-modal/confirm-modal.component';
import { ToastService } from '../../shared/ui/toast/toast.service';

@Component({
  selector: 'app-engine-control-button',
  standalone: true,
  imports: [LucideAngularModule, ConfirmModalComponent, FormsModule],
  template: `
    <div class="inline-flex items-center shrink-0" (click)="$event.stopPropagation()">
      @if (canCut().allowed || canRestore()) {
        @if (isCutActive()) {
          <button
            (click)="isOpen.set('restore')"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                   bg-tracky/20 text-tracky-light border border-tracky/30
                   hover:bg-tracky/30 transition-all cursor-pointer whitespace-nowrap"
          >
            <lucide-icon [img]="Power" [size]="14"></lucide-icon>
            <span class="hidden sm:inline">Rallumer le moteur</span>
            <span class="sm:hidden">ON</span>
          </button>
        } @else {
          <button
            (click)="canCut().allowed ? isOpen.set('cut') : null"
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
            <span class="sm:hidden">CUT</span>
          </button>
        }
      }

      <app-confirm-modal
        [open]="isOpen() === 'cut'"
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
        [open]="isOpen() === 'restore'"
        title="Rallumer le moteur ?"
        [description]="'Le véhicule <strong>' + vehiclePlate() + '</strong> sera à nouveau utilisable.'"
        confirmLabel="Oui, rallumer"
        cancelLabel="Annuler"
        [danger]="false"
        [loading]="loading()"
        (confirmed)="onConfirm('RESTORE')"
        (cancelled)="isOpen.set(null)"
      />
    </div>
  `,
})
export class EngineControlButtonComponent implements OnInit {
  readonly trackerId = input.required<string>();
  readonly vehiclePlate = input.required<string>();
  readonly currentSpeedKmh = input<number | undefined>(undefined);
  readonly validFix = input(false);
  readonly positionAge = input<number | undefined>(undefined);
  readonly ignition = input(true);

  protected readonly isOpen = signal<'cut' | 'restore' | null>(null);
  protected readonly loading = signal(false);
  protected readonly reason = signal('');
  protected readonly recentCommands = signal<EngineControlCommandDto[]>([]);

  protected readonly Power = Power;
  protected readonly PowerOff = PowerOff;

  private readonly authService = inject(AuthService);
  private readonly engineControl = inject(EngineControlService);
  private readonly toast = inject(ToastService);
  private readonly realtime = inject(RealtimeService);

  readonly isCutActive = computed(() => {
    const cmds = this.recentCommands();
    if (cmds.length === 0) return false;

    const lastCut = cmds.find(
      (c) => c.action === 'CUT' && (c.status === 'SENT' || c.status === 'ACKNOWLEDGED'),
    );
    const lastRestore = cmds.find(
      (c) => c.action === 'RESTORE' && (c.status === 'SENT' || c.status === 'ACKNOWLEDGED'),
    );

    // If there's an active CUT with no subsequent RESTORE → engine is cut
    if (lastCut && (!lastRestore || new Date(lastCut.createdAt) > new Date(lastRestore.createdAt))) {
      return true;
    }

    return false;
  });

  readonly canCut = computed(() => {
    const role = this.authService.user()?.role;
    if (role !== 'FLEET_ADMIN' && role !== 'SUPER_ADMIN') {
      return { allowed: false as const, reason: 'Rôle insuffisant' };
    }
    const age = this.positionAge();
    if (age === undefined) {
      return { allowed: false as const, reason: 'Aucune position connue' };
    }
    if (age > 60) {
      return { allowed: false as const, reason: `Position trop ancienne (${Math.round(age)}s)` };
    }
    if (!this.validFix()) {
      return { allowed: false as const, reason: 'Fix GPS invalide' };
    }
    const speed = this.currentSpeedKmh();
    if (speed !== undefined && speed > 20) {
      return { allowed: false as const, reason: `Vitesse trop élevée (${speed.toFixed(1)} km/h)` };
    }
    return { allowed: true as const, reason: null };
  });

  readonly canRestore = computed(() => {
    const role = this.authService.user()?.role;
    return role === 'FLEET_ADMIN' || role === 'SUPER_ADMIN';
  });

  protected readonly cutDescription = computed(
    () =>
      `Vous êtes sur le point d'immobiliser le véhicule <strong>${this.vehiclePlate()}</strong>.<br><br>` +
      `Le conducteur sera impacté immédiatement et le véhicule deviendra inutilisable ` +
      `jusqu'à réactivation manuelle.<br><br>` +
      `<span class="text-fg-tertiary text-xs">Cette action sera enregistrée dans l'audit trail.</span>`,
  );

  ngOnInit(): void {
    this.loadRecentCommands();

    // React to real-time engine command updates for this tracker
    effect(() => {
      const updates = this.realtime.engineCommandUpdates();
      const update = updates.get(this.trackerId());
      if (update) {
        this.loadRecentCommands();
      }
    });
  }

  protected async onConfirm(action: 'CUT' | 'RESTORE'): Promise<void> {
    this.loading.set(true);
    try {
      const cmd = await firstValueFrom(
        this.engineControl.requestCommand(
          this.trackerId(),
          action,
          action === 'CUT' ? this.reason() || undefined : undefined,
        ),
      );
      this.toast.success(
        action === 'CUT' ? 'Moteur coupé' : 'Moteur rallumé',
        `Commande ${cmd.id.slice(0, 8)} envoyée (statut : ${cmd.status})`,
      );
      this.isOpen.set(null);
      this.reason.set('');
      await this.loadRecentCommands();
    } catch (err) {
      const message = this.extractErrorMessage(err);
      this.toast.error(
        action === 'CUT' ? 'Coupure refusée' : 'Rallumage refusé',
        message,
      );
    } finally {
      this.loading.set(false);
    }
  }

  private async loadRecentCommands(): Promise<void> {
    try {
      const cmds = await firstValueFrom(
        this.engineControl.listCommands(this.trackerId(), 5),
      );
      this.recentCommands.set(cmds);
    } catch {
      // Silently fail — not critical
    }
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      return err.error?.message ?? err.message ?? 'Erreur inconnue';
    }
    return String(err);
  }
}
