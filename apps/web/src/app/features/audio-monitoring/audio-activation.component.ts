import { swallow } from '../../core/error/swallow';
import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { FleetAudioConfigDto } from '@vizyo/tracky-shared';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Ear,
  Info,
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
 * Sprint 4 — Écran « Mode assistance » de la flotte (fleet-admin / client). N2 du
 * gating à deux étages. LÉGALEMENT CRITIQUE.
 *
 * GATING (N1) : le Mode assistance n'est consultable que si le prestataire a rendu la
 * flotte ÉLIGIBLE (`superAdminEnabled`). Sinon → message neutre « non disponible » et
 * AUCUN toggle. Si éligible → consentement : obligations + attestation (le toggle reste
 * DÉSACTIVÉ tant que la case n'est pas cochée) + toggle « Mode assistance »
 * (`assistanceEnabled`, OFF par défaut). À l'activation, le serveur envoie un mail
 * OBLIGATIONS à la flotte et horodate l'attestation. Désactivable à tout moment.
 */
@Component({
  selector: 'app-audio-activation',
  standalone: true,
  imports: [LucideAngularModule, RouterLink, DatePipe],
  template: `
    <div class="aa-page">
      <a routerLink="/settings"
         class="aa-retour text-xs text-fg-tertiary hover:text-fg-secondary inline-flex items-center gap-1 mb-1">
        <lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon> Paramètres
      </a>
      <h1 class="font-display font-extrabold text-[1.72rem] tracking-[-0.03em] leading-[1.1] text-fg-primary">Mode assistance.</h1>
      <p class="text-[0.95rem] text-fg-secondary leading-relaxed mt-2 mb-5">
        Capacité légalement sensible : en cas d'accident, le prestataire peut activer l'écoute
        de la cabine pour vous porter assistance.
      </p>

      @if (loading()) {
        <div class="flex items-center justify-center h-40">
          <span class="w-6 h-6 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (noFleet()) {
        <div class="s-card p-5 text-sm text-fg-tertiary">
          Aucune flotte associée à votre compte — Mode assistance indisponible.
        </div>
      } @else if (!eligible()) {
        <!-- N1 NON ÉLIGIBLE — message neutre, AUCUN toggle. -->
        <div class="s-card">
          <div class="s-card-head">
            <div class="s-icon off"><lucide-icon [img]="Info" [size]="16"></lucide-icon></div>
            <div class="s-card-title">Mode assistance non disponible</div>
          </div>
          <div class="s-card-body">
            <p class="text-sm text-fg-secondary">
              Le Mode assistance n'est pas disponible pour votre flotte. Pour l'activer,
              contactez le prestataire.
            </p>
          </div>
        </div>
      } @else {
        <!-- État courant (éligible) -->
        <div class="s-card">
          <div class="s-card-head">
            <div class="s-icon" [class]="assistanceOn() ? 'on' : 'off'">
              <lucide-icon [img]="assistanceOn() ? ShieldCheck : ShieldAlert" [size]="16"></lucide-icon>
            </div>
            <div class="s-card-title">État du Mode assistance</div>
            <span class="ml-auto state-pill" [class]="assistanceOn() ? 'on' : 'off'">
              {{ assistanceOn() ? 'Activé' : 'Désactivé' }}
            </span>
          </div>
          <div class="s-card-body">
            @if (assistanceOn()) {
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
                Le Mode assistance est actuellement désactivé pour votre flotte. Tant qu'il
                n'est pas activé ci-dessous, aucune écoute de cabine ne peut avoir lieu.
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
                <span>En activant le Mode assistance :</span>
              </div>
              <p class="obl-lead">
                Vous autorisez le prestataire à activer l'écoute de la cabine de vos véhicules
                <strong>en cas d'accident</strong>, pour vous porter assistance. Vous attestez avoir
                informé vos conducteurs et posé la signalétique réglementaire.
              </p>
              <ul>
                <li>Informer les conducteurs et occupants des véhicules concernés.</li>
                <li>Poser la signalétique réglementaire dans la cabine.</li>
                <li>Chaque écoute est tracée dans l'audit (finalité limitée et proportionnée).</li>
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
                <div class="enable-label">{{ assistanceOn() ? 'Mode assistance activé' : 'Activer le Mode assistance' }}</div>
                <p class="enable-desc">
                  @if (!assistanceOn()) {
                    Cochez l'attestation pour pouvoir activer.
                  } @else {
                    Vous pouvez désactiver le Mode assistance à tout moment.
                  }
                </p>
              </div>
              <button
                type="button"
                role="switch"
                [attr.aria-checked]="assistanceOn()"
                (click)="toggle()"
                [disabled]="saving() || (!assistanceOn() && !attested())"
                class="switch"
                [class.on]="assistanceOn()"
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
    /* Lien de retour mesure a 343x36, sous le plancher de 44 px.
       ⚠️ La classe utilitaire min-h-[44px] NE MARCHE PAS ici : le plancher global
       de styles.css (button, a { min-height: 36px } sous pointer: coarse) est
       ecrit HORS COUCHE, et une regle sans couche bat toujours une regle placee
       dans @layer utilities — quelle que soit la specificite. Il faut donc une
       regle de composant, elle aussi hors couche. */
    .aa-retour { min-height: 44px }
    .aa-page { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px }
    .s-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 18px; overflow: hidden }
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
    .obl-lead { font-size: 12px; color: var(--fg-secondary); line-height: 1.5; margin: 0 0 8px }
    .obligations ul { margin: 0; padding-left: 26px; display: flex; flex-direction: column; gap: 4px }
    .obligations li { font-size: 12px; color: var(--fg-secondary); line-height: 1.5 }

    .attest { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 4px 0 }
    .attest input { position: absolute; opacity: 0; width: 0; height: 0 }
    .attest-box {
      width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(--border-strong);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px;
      color: transparent; transition: all .15s;
    }
    .attest input:checked + .attest-box { background: var(--tracky); border-color: var(--tracky); color: var(--accent-ink) }
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
  protected readonly Info = Info;
  protected readonly Mail = Mail;
  protected readonly Check = Check;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly ShieldCheck = ShieldCheck;

  private readonly fleetId = computed(() => this.auth.user()?.fleetId ?? null);
  protected readonly noFleet = computed(() => this.fleetId() === null);

  /** N1 — la flotte est-elle éligible (autorisée par le prestataire) ? */
  protected readonly eligible = computed(() => this.config()?.superAdminEnabled === true);
  /** N2 — le Mode assistance est-il consenti par le client ? */
  protected readonly assistanceOn = computed(() => this.config()?.assistanceEnabled === true);

  async ngOnInit(): Promise<void> {
    const fid = this.fleetId();
    if (!fid) {
      this.loading.set(false);
      return;
    }
    try {
      const cfg = await firstValueFrom(this.audio.getFleetAudioConfig(fid));
      this.config.set(cfg);
      // Si déjà activé, l'attestation est réputée acquise (réactivable sans recocher).
      this.attested.set(cfg.assistanceEnabled);
    } catch (err) {
      swallow('audio-activation:ngOnInit', err);
      this.toast.error('Chargement impossible', "Impossible de lire l'état du Mode assistance.");
    } finally {
      this.loading.set(false);
    }
  }

  protected async toggle(): Promise<void> {
    const fid = this.fleetId();
    if (!fid || this.saving()) return;
    // Garde-fou : on ne touche au consentement que si la flotte est éligible (N1).
    if (!this.eligible()) return;
    const enable = !this.assistanceOn();
    // Garde-fou : activer exige l'attestation cochée (double du [disabled] du toggle).
    if (enable && !this.attested()) return;
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.audio.setFleetAssistanceMode(fid, {
          assistanceEnabled: enable,
          ...(enable ? { attestation: true, attestationVersion: ATTESTATION_VERSION } : {}),
        }),
      );
      this.config.set(updated);
      this.attested.set(updated.assistanceEnabled);
      if (enable) {
        this.toast.success(
          'Mode assistance activé',
          updated.activationEmailSentAt
            ? 'Un mail d\'information a été envoyé à votre flotte.'
            : 'Activation enregistrée.',
        );
      } else {
        this.toast.success('Mode assistance désactivé', 'Aucune écoute de cabine ne peut désormais avoir lieu.');
      }
    } catch (err) {
      swallow('audio-activation:toggle', err);
      this.toast.error(
        enable ? 'Activation refusée' : 'Désactivation refusée',
        'L\'opération n\'a pas abouti.',
      );
    } finally {
      this.saving.set(false);
    }
  }
}
