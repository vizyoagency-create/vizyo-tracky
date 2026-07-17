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
            [disabled]="busy()"
            (change)="toggle($any($event.target).checked)"
            aria-label="Activer la vérification en 2 étapes"
          />
          <span class="s2-track"><span class="s2-thumb"></span></span>
        </label>
      </div>
      @if (enabled()) {
        <p class="s2-note">
          <lucide-icon [img]="Check" [size]="12" /> Actif — votre compte est protégé lors des
          connexions inhabituelles.
        </p>
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
      .s2-sub { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0; }
      .s2-sub b { color: var(--fg-secondary); }
      .s2-note { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--tracky-light); margin: 12px 0 0; }
      .s2-toggle { position: relative; display: inline-flex; cursor: pointer; flex-shrink: 0; margin-top: 2px; }
      .s2-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
      .s2-track { width: 40px; height: 22px; border-radius: 9999px; background: var(--bg-tertiary); transition: background .2s; position: relative; display: inline-block; }
      .s2-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: left .2s; }
      .s2-toggle input:checked + .s2-track { background: var(--tracky); }
      .s2-toggle input:checked + .s2-track .s2-thumb { left: 20px; }
      .s2-toggle input:disabled + .s2-track { opacity: .55; }
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

  async ngOnInit(): Promise<void> {
    await this.security.loadTwoFactorStatus();
  }

  async toggle(next: boolean): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    const ok = next
      ? await this.security.enableTwoFactor()
      : await this.security.disableTwoFactor();
    this.busy.set(false);
    if (ok) {
      this.toast.success(
        next ? 'Vérification en 2 étapes activée' : 'Vérification en 2 étapes désactivée',
      );
    } else {
      this.toast.error('Échec de la mise à jour');
    }
  }
}
