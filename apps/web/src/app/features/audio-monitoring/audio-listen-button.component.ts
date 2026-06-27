import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  computed,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlertTriangle,
  Ear,
  LucideAngularModule,
  Phone,
  PhoneOff,
  ShieldAlert,
  X,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AudioMonitoringService } from '../../core/services/audio-monitoring.service';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Sprint 4 — Bouton « Écouter » (micro embarqué). LÉGALEMENT CRITIQUE.
 *
 * Scénario A (appel live) : déclencher l'écoute ARME le micro du boîtier et renvoie le
 * n° SIM à APPELER pour entendre la cabine en direct. AUCUN audio n'est joué dans l'app.
 *
 * Le bouton est :
 *  - GATÉ par la permission per-véhicule `audio_monitoring` (exactement comme
 *    `engine_control` pour le coupe-circuit : `perms.can('audio_monitoring', vehicleId)`,
 *    bypass FLEET_ADMIN/SUPER_ADMIN) ;
 *  - MASQUÉ tant que la flotte n'a pas activé l'écoute (config `enabled=false` par défaut).
 *
 * Au clic → modale MOTIF OBLIGATOIRE (le bouton « Armer le micro » reste DÉSACTIVÉ tant
 * que le motif est vide/espaces). À la confirmation → appel `listen` → affichage du n° SIM
 * à appeler + rappel légal. Si le n° SIM est absent → « SIM non provisionnée ».
 */
@Component({
  selector: 'app-audio-listen-button',
  standalone: true,
  imports: [LucideAngularModule, FormsModule],
  template: `
    @if (visible()) {
      <div class="inline-flex items-center shrink-0" (click)="$event.stopPropagation()">
        <button
          type="button"
          (click)="openModal()"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                 bg-violet-600/20 text-violet-300 border border-violet-600/30
                 hover:bg-violet-600/30 transition-all cursor-pointer whitespace-nowrap"
          title="Écouter la cabine (micro embarqué)"
        >
          <lucide-icon [img]="Ear" [size]="14"></lucide-icon>
          <span class="hidden sm:inline">Écouter</span>
        </button>

        <!-- ── MODALE ── motif obligatoire puis résultat (n° SIM à appeler). ── -->
        @if (isOpen()) {
          <div
            class="fixed inset-0 z-[9000] flex items-center justify-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audio-listen-title"
          >
            <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" (click)="close()" aria-hidden="true"></div>
            <div class="relative bg-bg-secondary border border-border-subtle rounded-[--radius-card]
                        p-6 max-w-md w-full mx-4 shadow-2xl">
              <!-- En-tête -->
              <div class="flex items-start gap-3 mb-4">
                <lucide-icon [img]="ShieldAlert" [size]="24" class="text-violet-300 shrink-0 mt-0.5" aria-hidden="true"></lucide-icon>
                <div class="min-w-0">
                  <h3 id="audio-listen-title" class="text-lg font-display font-semibold text-fg-primary">
                    Écouter la cabine
                  </h3>
                  <p class="text-sm text-fg-secondary mt-1">
                    Véhicule <strong>{{ vehiclePlate() }}</strong>.
                  </p>
                </div>
                <button (click)="close()" aria-label="Fermer"
                        class="ml-auto p-1 rounded-lg text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary cursor-pointer">
                  <lucide-icon [img]="X" [size]="16"></lucide-icon>
                </button>
              </div>

              <!-- ÉTAPE 1 : MOTIF OBLIGATOIRE -->
              @if (!result()) {
                <p class="text-sm text-fg-secondary mb-2">
                  L'écoute du micro est une action <strong>légalement sensible</strong>. Un motif est
                  obligatoire et cette action sera enregistrée dans l'audit.
                </p>
                <label class="text-xs text-fg-tertiary" for="audio-listen-reason">Motif de l'écoute</label>
                <textarea
                  id="audio-listen-reason"
                  [ngModel]="reason()"
                  (ngModelChange)="reason.set($event)"
                  placeholder="Ex : suspicion de vol, vérification d'un incident signalé…"
                  maxlength="500"
                  rows="3"
                  class="w-full mt-1 px-3 py-2 text-sm rounded-lg bg-bg-tertiary border border-border-subtle
                         text-fg-primary placeholder:text-fg-tertiary resize-none
                         focus:outline-none focus:border-tracky"
                ></textarea>

                <div class="flex items-center justify-end gap-3 mt-5">
                  <button
                    type="button"
                    (click)="close()"
                    [disabled]="loading()"
                    class="px-4 py-2 text-sm font-medium rounded-xl
                           bg-bg-tertiary text-fg-secondary border border-border-subtle
                           hover:text-fg-primary transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Annuler
                  </button>
                  <button
                    type="button"
                    (click)="confirm()"
                    [disabled]="!canConfirm()"
                    class="px-4 py-2 text-sm font-medium rounded-xl text-white flex items-center gap-2
                           bg-violet-600 hover:bg-violet-700 transition-all cursor-pointer
                           disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    @if (loading()) {
                      <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                    } @else {
                      <lucide-icon [img]="Ear" [size]="14"></lucide-icon>
                    }
                    Armer le micro
                  </button>
                </div>
              } @else {
                <!-- ÉTAPE 2 : RÉSULTAT (n° SIM à appeler, ou SIM non provisionnée) -->
                @if (result()?.simPhoneNumber; as sim) {
                  <div class="rounded-xl bg-violet-600/10 border border-violet-600/25 p-4 flex flex-col items-center gap-2 text-center">
                    <lucide-icon [img]="Phone" [size]="22" class="text-violet-300"></lucide-icon>
                    <p class="text-sm text-fg-secondary">
                      Micro armé — appelez le numéro ci-dessous pour écouter la cabine en direct :
                    </p>
                    <a [href]="'tel:' + sim"
                       class="text-xl font-display font-bold text-violet-200 tracking-wide hover:underline">
                      {{ sim }}
                    </a>
                  </div>
                } @else {
                  <div class="rounded-xl bg-amber-500/10 border border-amber-500/25 p-4 flex items-start gap-3">
                    <lucide-icon [img]="PhoneOff" [size]="20" class="text-amber-400 shrink-0 mt-0.5"></lucide-icon>
                    <p class="text-sm text-amber-200">
                      <strong>SIM non provisionnée</strong> — écoute impossible. Le boîtier n'a pas de
                      numéro à appeler.
                    </p>
                  </div>
                }

                <!-- Rappel légal (toujours affiché après déclenchement) -->
                <div class="flex items-start gap-2 mt-3 text-[11px] text-fg-tertiary leading-relaxed">
                  <lucide-icon [img]="AlertTriangle" [size]="13" class="shrink-0 mt-0.5"></lucide-icon>
                  <span>
                    Finalité limitée et proportionnée. Les occupants doivent avoir été informés et la
                    signalétique réglementaire posée. Usage tracé dans l'audit.
                  </span>
                </div>

                <div class="flex items-center justify-end mt-5">
                  <button
                    type="button"
                    (click)="close()"
                    class="px-4 py-2 text-sm font-medium rounded-xl text-white
                           bg-tracky hover:bg-tracky-dark transition-all cursor-pointer"
                  >
                    Fermer
                  </button>
                </div>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
})
export class AudioListenButtonComponent implements OnInit {
  /** Tracker ciblé (l'écoute s'arme par tracker, comme le coupe-circuit). */
  readonly trackerId = input.required<string>();
  /** Véhicule — requis pour la résolution de permission per-véhicule (audio_monitoring). */
  readonly vehicleId = input.required<string>();
  readonly vehiclePlate = input.required<string>();
  /** FleetId de la flotte du véhicule — pour charger l'état d'activation. */
  readonly fleetId = input<string | null>(null);

  protected readonly isOpen = signal(false);
  protected readonly loading = signal(false);
  protected readonly reason = signal('');
  protected readonly result = signal<{ simPhoneNumber: string | null } | null>(null);
  /** État d'activation de la flotte (null = pas encore chargé / inconnu → masqué). */
  private readonly fleetEnabled = signal(false);

  protected readonly Ear = Ear;
  protected readonly Phone = Phone;
  protected readonly PhoneOff = PhoneOff;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly X = X;

  private readonly audio = inject(AudioMonitoringService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  /** Gate per-véhicule, identique au coupe-circuit (perms.can bypass admin). */
  // Sprint 4 — temporairement SUPER_ADMIN only (Vizyo) ; rouvrir aux fleet-admins à l'activation.
  private readonly allowed = computed(
    () => this.auth.user()?.role === 'SUPER_ADMIN' && this.perms.can('audio_monitoring', this.vehicleId()),
  );

  /** Le bouton n'apparaît que si l'utilisateur a la permission ET la flotte a activé l'écoute. */
  protected readonly visible = computed(() => this.allowed() && this.fleetEnabled());

  /** Bouton de confirmation actif uniquement si un motif non vide est saisi (et pas en cours). */
  protected readonly canConfirm = computed(() => this.reason().trim().length > 0 && !this.loading());

  ngOnInit(): void {
    // Charge l'état d'activation de la flotte pour décider de l'affichage du bouton.
    // On ne tente le chargement que si l'utilisateur peut écouter (évite un 403 inutile)
    // et qu'on connaît la flotte (FLEET_ADMIN/SUPER_ADMIN ont un fleetId ou null).
    if (!this.allowed()) return;
    const fid = this.fleetId() ?? this.auth.user()?.fleetId ?? null;
    if (!fid) return;
    firstValueFrom(this.audio.getFleetAudioConfig(fid))
      .then((cfg) => this.fleetEnabled.set(cfg.enabled))
      .catch(() => {
        // Échec silencieux → fail-closed : le bouton reste masqué.
      });
  }

  protected openModal(): void {
    this.reason.set('');
    this.result.set(null);
    this.isOpen.set(true);
  }

  protected close(): void {
    if (this.loading()) return;
    this.isOpen.set(false);
    this.reason.set('');
    this.result.set(null);
  }

  protected async confirm(): Promise<void> {
    if (!this.canConfirm()) return; // garde-fou : motif obligatoire (double du [disabled])
    this.loading.set(true);
    try {
      const res = await firstValueFrom(this.audio.listen(this.trackerId(), this.reason().trim()));
      this.result.set({ simPhoneNumber: res.simPhoneNumber });
      if (res.simPhoneNumber) {
        this.toast.success('Micro armé', `Appelez le ${res.simPhoneNumber} pour écouter la cabine.`);
      } else {
        this.toast.error('SIM non provisionnée', 'Aucun numéro à appeler — écoute impossible.');
      }
    } catch (err) {
      this.toast.error('Écoute refusée', this.extractErrorMessage(err));
      this.isOpen.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const body = err.error as { error?: { message?: string }; message?: string } | null;
      return body?.error?.message ?? body?.message ?? err.message ?? 'Erreur inconnue';
    }
    return String(err);
  }
}
