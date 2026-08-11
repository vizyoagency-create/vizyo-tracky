import { Component, inject, OnInit, signal } from '@angular/core';
import { Check, LucideAngularModule, ShieldCheck } from 'lucide-angular';
import { SecurityService } from '../../core/services/security.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Encart « Vérification en 2 étapes » (Paramètres → Organisation). Opt-in PAR
 * UTILISATEUR : chacun sécurise son propre compte. Une fois activé, un code e-mail
 * n'est demandé QUE lors d'une connexion inhabituelle (nouvel appareil / lieu
 * inhabituel) — jamais au quotidien.
 */
@Component({
  selector: 'app-security-2fa-card',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <div class="s2-card">
      <div class="s2-head">
        <lucide-icon [img]="ShieldCheck" [size]="16" />
        <span class="s2-title">Vérification en 2 étapes</span>
      </div>
      <div class="s2-row">
        <div class="s2-text">
          <p class="s2-name">Protéger mon compte par code e-mail</p>
          <p class="s2-sub">
            Une fois activée, un code par e-mail est demandé <b>uniquement</b> lors d'une
            connexion inhabituelle (nouvel appareil ou lieu inhabituel). Aucune gêne au
            quotidien.
          </p>
        </div>
        <label class="s2-toggle">
          <input
            type="checkbox"
            [checked]="enabled()"
            [disabled]="busy() || confirmingDisable()"
            (change)="toggle($any($event.target).checked)"
            aria-label="Activer la vérification en 2 étapes"
          />
          <span class="s2-track"><span class="s2-thumb"></span></span>
        </label>
      </div>
      @if (enabled() && !confirmingDisable()) {
        <p class="s2-note">
          <lucide-icon [img]="Check" [size]="12" /> Actif — votre compte est protégé lors des
          connexions inhabituelles.
        </p>
      }
      @if (confirmingDisable()) {
        <div class="s2-confirm">
          <p class="s2-confirm-title">Confirmer la désactivation</p>
          <p class="s2-confirm-sub">
            Pour votre sécurité, un code a été envoyé à <b>{{ maskedEmail() ?? 'votre e-mail' }}</b>.
            Saisissez-le pour désactiver la double authentification.
          </p>
          <div class="s2-confirm-row">
            <input
              class="s2-code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="8"
              placeholder="Code reçu"
              [value]="code()"
              (input)="code.set($any($event.target).value)"
              [disabled]="confirmBusy()"
            />
            <button
              type="button"
              class="s2-btn s2-btn-danger"
              [disabled]="confirmBusy() || code().trim().length < 4"
              (click)="confirmDisable()"
            >
              {{ confirmBusy() ? '…' : 'Désactiver' }}
            </button>
            <button type="button" class="s2-btn s2-btn-ghost" [disabled]="confirmBusy()" (click)="cancelDisable()">
              Annuler
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .s2-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; padding: 16px; }
      .s2-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .s2-head lucide-icon { color: var(--tracky-light); }
      .s2-title { font-size: 14px; font-weight: 600; color: var(--fg-primary); }
      .s2-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
      .s2-text { flex: 1; min-width: 0; }
      .s2-name { font-size: 13px; font-weight: 600; color: var(--fg-primary); margin: 0 0 3px; }
      /* --fg-tertiary est un jeton a 3:1 : lisible a 16 px, pas a 11,5. Mesure au lot
         B-pages, 3,16:1 en theme clair. Cf. point ouvert O5 de design/TOKENS.md. */
      .s2-sub { font-size: 11.5px; color: var(--fg-secondary); line-height: 1.5; margin: 0; }
      .s2-sub b { color: var(--fg-secondary); }
      .s2-note { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--tracky-light); margin: 12px 0 0; }
      .s2-toggle { position: relative; display: inline-flex; cursor: pointer; flex-shrink: 0; margin-top: 2px; }
      .s2-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
      .s2-track { width: 40px; height: 22px; border-radius: 9999px; background: var(--bg-tertiary); transition: background .2s; position: relative; display: inline-block; }
      .s2-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: left .2s; }
      .s2-toggle input:checked + .s2-track { background: var(--tracky); }
      .s2-toggle input:checked + .s2-track .s2-thumb { left: 20px; }
      .s2-toggle input:disabled + .s2-track { opacity: .55; }
      .s2-confirm { margin-top: 14px; padding: 14px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid color-mix(in srgb, #f59e0b 30%, var(--border-subtle)); }
      .s2-confirm-title { font-size: 13px; font-weight: 700; color: var(--fg-primary); margin: 0 0 4px; }
      .s2-confirm-sub { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0 0 12px; }
      .s2-confirm-sub b { color: var(--fg-secondary); }
      .s2-confirm-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .s2-code { flex: 1 1 120px; min-width: 0; padding: 9px 12px; border-radius: 9px; border: 1px solid var(--border-strong, var(--border-subtle)); background: var(--bg-secondary); color: var(--fg-primary); font-size: 15px; font-weight: 700; letter-spacing: .15em; text-align: center; }
      .s2-btn { padding: 9px 14px; border-radius: 9px; font-size: 12.5px; font-weight: 700; cursor: pointer; border: none; }
      .s2-btn:disabled { opacity: .55; cursor: default; }
      .s2-btn-danger { background: #ef4444; color: #fff; }
      .s2-btn-ghost { background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    `,
  ],
})
export class Security2faCardComponent implements OnInit {
  private readonly security = inject(SecurityService);
  private readonly toast = inject(ToastService);

  protected readonly ShieldCheck = ShieldCheck;
  protected readonly Check = Check;
  protected readonly enabled = this.security.twoFactorEnabled;
  protected readonly busy = signal(false);
  /** Étape de confirmation par code pour DÉSACTIVER le 2FA (anti session volée). */
  protected readonly confirmingDisable = signal(false);
  protected readonly code = signal('');
  protected readonly maskedEmail = signal<string | null>(null);
  protected readonly confirmBusy = signal(false);

  async ngOnInit(): Promise<void> {
    await this.security.loadTwoFactorStatus();
  }

  async toggle(next: boolean): Promise<void> {
    if (this.busy() || this.confirmingDisable()) return;
    if (next) {
      // Activer : direct (upgrade de sécurité, aucun risque).
      this.busy.set(true);
      const ok = await this.security.enableTwoFactor();
      this.busy.set(false);
      this.toast[ok ? 'success' : 'error'](
        ok ? 'Vérification en 2 étapes activée' : 'Échec de la mise à jour',
      );
    } else {
      // Désactiver : exiger un code frais (downgrade de sécurité).
      await this.startDisable();
    }
  }

  private async startDisable(): Promise<void> {
    this.busy.set(true);
    const r = await this.security.sendDisableCode();
    this.busy.set(false);
    if (r.ok) {
      this.maskedEmail.set(r.email ?? null);
      this.code.set('');
      this.confirmingDisable.set(true);
    } else {
      this.toast.error('Envoi du code impossible', 'Réessayez dans un instant.');
    }
  }

  protected async confirmDisable(): Promise<void> {
    if (this.confirmBusy() || this.code().trim().length < 4) return;
    this.confirmBusy.set(true);
    const ok = await this.security.disableTwoFactor(this.code().trim());
    this.confirmBusy.set(false);
    if (ok) {
      this.confirmingDisable.set(false);
      this.code.set('');
      this.toast.success('Vérification en 2 étapes désactivée');
    } else {
      this.toast.error('Code invalide', 'Vérifiez le code reçu par e-mail.');
    }
  }

  protected cancelDisable(): void {
    this.confirmingDisable.set(false);
    this.code.set('');
  }
}
