import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { FleetAudioConfigDto } from '@vizyo/tracky-shared';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Ear,
  LucideAngularModule,
  Mail,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AudioMonitoringService } from '../../core/services/audio-monitoring.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/** Version de l'attestation posée à l'activation (suit l'audit côté serveur). */
const ATTESTATION_VERSION = 'v1';

/**
 * Sprint 4 — Écran d'ACTIVATION de l'écoute audio pour la flotte (fleet-admin).
 * LÉGALEMENT CRITIQUE.
 *
 * L'écoute est OFF par défaut. Activer EXIGE de cocher l'attestation (le toggle reste
 * DÉSACTIVÉ tant que la case n'est pas cochée). À l'activation, le serveur envoie un mail
 * OBLIGATIONS à tous les utilisateurs de la flotte et horodate l'attestation. La
 * désactivation est possible à tout moment.
 */
@Component({
  selector: 'app-audio-activation',
  standalone: true,
  imports: [LucideAngularModule, RouterLink, DatePipe],
  template: `
    <div class="aa-page">
      <a routerLink="/settings"
         class="text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
        <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon> Paramètres
      </a>
      <h1 class="text-2xl font-display font-bold text-fg-primary">Écoute audio (micro embarqué)</h1>
      <p class="text-sm text-fg-tertiary mb-5">
        Capacité légalement sensible. Activez-la pour votre flotte en attestant des obligations.
      </p>

      @if (loading()) {
        <div class="flex items-center justify-center h-40">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (noFleet()) {
        <div class="s-card p-5 text-sm text-fg-tertiary">
          Aucune flotte associée à votre compte — activation indisponible.
        </div>
      } @else {
        <!-- État courant -->
        <div class="s-card">
          <div class="s-card-head">
            <div class="s-icon" [class]="config()?.enabled ? 'on' : 'off'">
              <lucide-icon [img]="config()?.enabled ? ShieldCheck : ShieldAlert" [size]="16"></lucide-icon>
            </div>
            <div class="s-card-title">État de l'écoute audio</div>
            <span class="ml-auto state-pill" [class]="config()?.enabled ? 'on' : 'off'">
              {{ config()?.enabled ? 'Activée' : 'Désactivée' }}
            </span>
          </div>
          <div class="s-card-body">
            @if (config()?.enabled) {
              <div class="info-row">
                <lucide-icon [img]="Check" [size]="14" class="text-tracky-light shrink-0"></lucide-icon>
                <span>
                  Attestation enregistrée
                  @if (config()?.attestedAt) {
                    le <strong>{{ config()?.attestedAt | date: 'dd/MM/yyyy à HH:mm' }}</strong>
                  }
                  @if (config()?.attestationVersion) {
                    (version {{ config()?.attestationVersion }})
                  }.
                </span>
              </div>
              <div class="info-row">
                <lucide-icon [img]="Mail" [size]="14" class="text-fg-tertiary shrink-0"></lucide-icon>
                @if (config()?.activationEmailSentAt) {
                  <span>
                    Un mail d'information a été envoyé à la flotte le
                    <strong>{{ config()?.activationEmailSentAt | date: 'dd/MM/yyyy à HH:mm' }}</strong>.
                  </span>
                } @else {
                  <span>Mail d'information à la flotte : non confirmé.</span>
                }
              </div>
            } @else {
              <p class="text-sm text-fg-secondary">
                L'écoute est actuellement désactivée pour toute la flotte. Aucun véhicule ne peut être
                écouté tant qu'elle n'est pas activée ci-dessous.
              </p>
            }
          </div>
        </div>

        <!-- Obligations + attestation + toggle -->
        <div class="s-card">
          <div class="s-card-head">
            <div class="s-icon violet"><lucide-icon [img]="Ear" [size]="16"></lucide-icon></div>
            <div class="s-card-title">Obligations et activation</div>
          </div>
          <div class="s-card-body">
            <div class="obligations">
              <div class="obl-head">
                <lucide-icon [img]="AlertTriangle" [size]="15" class="text-amber-400 shrink-0"></lucide-icon>
                <span>Avant d'activer, vous devez :</span>
              </div>
              <ul>
                <li>Informer les conducteurs et occupants des véhicules concernés.</li>
                <li>Poser la signalétique réglementaire dans la cabine.</li>
                <li>Limiter l'usage à une finalité légitime et proportionnée (chaque écoute est tracée).</li>
              </ul>
            </div>

            <!-- Case d'attestation : conditionne le toggle d'activation -->
            <label class="attest">
              <input type="checkbox" [checked]="attested()" (change)="attested.set(!attested())" [disabled]="saving()" />
              <span class="attest-box"><lucide-icon [img]="Check" [size]="12"></lucide-icon></span>
              <span class="attest-text">
                J'atteste, au nom de mon organisation, avoir informé les occupants/conducteurs et posé la
                signalétique réglementaire.
              </span>
            </label>

            <!-- Toggle d'activation : DÉSACTIVÉ tant que l'attestation n'est pas cochée -->
            <div class="enable-row">
              <div class="enable-text">
                <div class="enable-label">{{ config()?.enabled ? 'Écoute activée' : 'Activer l\\'écoute pour la flotte' }}</div>
                <p class="enable-desc">
                  @if (!config()?.enabled) {
                    Cochez l'attestation pour pouvoir activer.
                  } @else {
                    Vous pouvez désactiver l'écoute à tout moment.
                  }
                </p>
              </div>
              <button
                type="button"
                role="switch"
                [attr.aria-checked]="config()?.enabled"
                (click)="toggle()"
                [disabled]="saving() || (!config()?.enabled && !attested())"
                class="switch"
                [class.on]="config()?.enabled"
              >
                <span class="knob"></span>
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .aa-page { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px }
    .s-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden }
    .s-card-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle) }
    .s-card-title { font-size: 13px; font-weight: 700; color: var(--fg-primary) }
    .s-card-body { padding: 18px; display: flex; flex-direction: column; gap: 14px }
    .s-icon { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
    .s-icon.violet { background: rgba(139,92,246,.12); color: #a78bfa }
    .s-icon.on { background: rgba(16,224,160,.12); color: var(--tracky-light) }
    .s-icon.off { background: rgba(148,163,184,.12); color: var(--fg-tertiary) }

    .state-pill { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 3px 10px; border-radius: 20px }
    .state-pill.on { background: rgba(16,224,160,.15); color: var(--tracky-light) }
    .state-pill.off { background: var(--bg-tertiary); color: var(--fg-tertiary) }

    .info-row { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--fg-secondary); line-height: 1.5 }

    .obligations { border-radius: 12px; background: rgba(245,158,11,.06); border: 1px solid rgba(245,158,11,.16); padding: 12px 14px }
    .obl-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--fg-primary); margin-bottom: 6px }
    .obligations ul { margin: 0; padding-left: 26px; display: flex; flex-direction: column; gap: 4px }
    .obligations li { font-size: 12px; color: var(--fg-secondary); line-height: 1.5 }

    .attest { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 4px 0 }
    .attest input { position: absolute; opacity: 0; width: 0; height: 0 }
    .attest-box {
      width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(--border-strong);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px;
      color: transparent; transition: all .15s;
    }
    .attest input:checked + .attest-box { background: var(--tracky); border-color: var(--tracky); color: white }
    .attest input:disabled ~ .attest-text { opacity: .6 }
    .attest-text { font-size: 13px; color: var(--fg-secondary); line-height: 1.5 }

    .enable-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-top: 14px; border-top: 1px solid var(--border-subtle) }
    .enable-label { font-size: 13px; font-weight: 600; color: var(--fg-primary) }
    .enable-desc { font-size: 11px; color: var(--fg-tertiary); margin: 2px 0 0; line-height: 1.4 }

    .switch {
      position: relative; flex-shrink: 0; width: 46px; height: 26px; border-radius: 9999px; border: none; cursor: pointer;
      background: var(--bg-tertiary); transition: background .2s;
    }
    .switch.on { background: var(--tracky) }
    .switch:disabled { opacity: .45; cursor: not-allowed }
    .knob { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: white; transition: left .2s }
    .switch.on .knob { left: 23px }
  `],
})
export class AudioActivationComponent implements OnInit {
  private readonly audio = inject(AudioMonitoringService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly config = signal<FleetAudioConfigDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly attested = signal(false);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Ear = Ear;
  protected readonly Mail = Mail;
  protected readonly Check = Check;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly ShieldCheck = ShieldCheck;

  private readonly fleetId = computed(() => this.auth.user()?.fleetId ?? null);
  protected readonly noFleet = computed(() => this.fleetId() === null);

  async ngOnInit(): Promise<void> {
    const fid = this.fleetId();
    if (!fid) {
      this.loading.set(false);
      return;
    }
    try {
      const cfg = await firstValueFrom(this.audio.getFleetAudioConfig(fid));
      this.config.set(cfg);
      // Si déjà activée, l'attestation est réputée acquise (réactivable sans recocher).
      this.attested.set(cfg.enabled);
    } catch {
      this.toast.error('Chargement impossible', "Impossible de lire l'état de l'écoute audio.");
    } finally {
      this.loading.set(false);
    }
  }

  protected async toggle(): Promise<void> {
    const fid = this.fleetId();
    if (!fid || this.saving()) return;
    const enable = !this.config()?.enabled;
    // Garde-fou : activer exige l'attestation cochée (double du [disabled] du toggle).
    if (enable && !this.attested()) return;
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.audio.setFleetAudioConfig(fid, {
          enabled: enable,
          ...(enable ? { attestation: true, attestationVersion: ATTESTATION_VERSION } : {}),
        }),
      );
      this.config.set(updated);
      this.attested.set(updated.enabled);
      if (enable) {
        this.toast.success(
          'Écoute audio activée',
          updated.activationEmailSentAt
            ? 'Un mail d\'information a été envoyé à votre flotte.'
            : 'Activation enregistrée.',
        );
      } else {
        this.toast.success('Écoute audio désactivée', 'L\'écoute est désormais refusée pour la flotte.');
      }
    } catch {
      this.toast.error(
        enable ? 'Activation refusée' : 'Désactivation refusée',
        'L\'opération n\'a pas abouti.',
      );
    } finally {
      this.saving.set(false);
    }
  }
}
