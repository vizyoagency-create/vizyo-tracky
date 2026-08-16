import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule, ShieldCheck } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { ConsentService } from '../../core/services/consent.service';
import { PortesAccesService } from '../../core/services/portes-acces.service';
import { SecurityService } from '../../core/services/security.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { LogoComponent } from '../../shared/ui/logo/logo.component';

/**
 * Écran de saisie du code (2FA app) — overlay bloquant, rendu par DashboardLayout
 * quand `security.mustVerify()` ET que le consentement ne bloque pas. Le code a
 * déjà été envoyé par /connection ; ici on le saisit (ou on le renvoie / se
 * déconnecte). Ne s'affiche QUE sur une vraie anomalie pour un utilisateur qui a
 * activé le 2FA — jamais imposé.
 */
@Component({
  selector: 'app-device-verification-gate',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, LogoComponent],
  template: `
    @if (security.mustVerify() && !consent.mustAccept()) {
      <div class="dv-overlay" role="dialog" aria-modal="true" aria-labelledby="dv-title">
        <div class="dv-shell">
          <div class="dv-head">
            <span class="dv-badge"><lucide-icon [img]="ShieldCheck" [size]="22"></lucide-icon></span>
            <div>
              <h1 id="dv-title" class="dv-title">Confirmez cette connexion</h1>
              <p class="dv-sub">
                @if (portes.libelle('verification'); as rang) { {{ rang }} · }
                Connexion inhabituelle détectée
              </p>
            </div>
            <app-logo variant="icon" [size]="26" class="dv-logo" />
          </div>

          <p class="dv-lead">
            Vous avez activé la vérification en 2 étapes. Un code vient d'être envoyé à
            <strong>{{ security.maskedEmail() || 'votre adresse e-mail' }}</strong> — saisissez-le
            pour continuer.
          </p>

          <!--
            SIX CASES SEPAREES (B1 § F). Le champ unique se contentait d'un interlettrage qui
            IMITAIT des cases : on ne voyait pas combien de chiffres restaient, et un collage
            depuis l'e-mail — le geste le plus naturel quand le code arrive par mail — n'avait
            aucun traitement particulier.
          -->
          <div class="dv-otp" (paste)="onPaste($event)">
            @for (n of positions; track n) {
              <input
                class="dv-case"
                [class.dv-case--on]="chiffres()[n] !== ''"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="1"
                [value]="chiffres()[n]"
                (input)="onCase(n, $event)"
                (keydown)="onTouche(n, $event)"
                [attr.aria-label]="'Chiffre ' + (n + 1) + ' sur 6'" />
            }
          </div>
          <p class="dv-astuce">Vous pouvez coller le code reçu par e-mail : il remplit les six cases d'un coup.</p>

          @if (error()) { <p class="dv-error">{{ error() }}</p> }

          <div class="dv-actions">
            <button type="button" class="dv-btn dv-btn--ghost" (click)="logout()" [disabled]="verifying()">
              Se déconnecter
            </button>
            <button type="button" class="dv-btn dv-btn--primary"
                    (click)="verify()" [disabled]="code().length !== 6 || verifying()">
              {{ verifying() ? 'Vérification…' : 'Vérifier' }}
            </button>
          </div>

          <button type="button" class="dv-resend" (click)="resend()"
                  [disabled]="sending() || cooldown() > 0">
            {{ sending() ? 'Envoi…' : cooldown() > 0 ? 'Renvoyer le code (' + cooldown() + 's)' : 'Renvoyer le code' }}
          </button>
        </div>
      </div>
    }
  `,
  styles: [
    `
    .dv-overlay {
      position: fixed; inset: 0; z-index: 3950;
      background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
      backdrop-filter: blur(8px) saturate(1.2);
      display: flex; align-items: center; justify-content: center; padding: 16px; font-family: inherit;
    }
    .dv-shell {
      width: 100%; max-width: 460px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 18px);
      padding: 26px 26px 20px;
      max-height: calc(100dvh - 32px); overflow-y: auto; text-align: left;
    }
    .dv-head { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
    .dv-badge {
      width: 46px; height: 46px; border-radius: 13px; flex: none;
      background: color-mix(in srgb, var(--color-tracky-light) 16%, transparent);
      color: var(--texte-succes); display: flex; align-items: center; justify-content: center;
    }
    .dv-title { margin: 0; font-size: 1.25rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .dv-sub { margin: 2px 0 0; font-size: .82rem; color: var(--fg-secondary); }
    .dv-logo { margin-left: auto; opacity: .9; }
    .dv-lead { margin: 0 0 18px; font-size: .92rem; line-height: 1.6; color: var(--fg-secondary); }
    .dv-lead strong { color: var(--fg-primary); font-weight: 700; }
    /* Six cases : on VOIT combien il en reste, au lieu de compter des caracteres. */
    .dv-otp { display: flex; gap: 9px; }
    .dv-case {
      flex: 1; min-width: 0; min-height: 56px; box-sizing: border-box;
      font: inherit; font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 1.5rem; font-weight: 600; text-align: center;
      border-radius: 12px; color: var(--fg-primary);
      background: var(--bg-tertiary); border: 1px solid var(--border-strong); outline: none;
    }
    .dv-case--on { border-color: color-mix(in srgb, var(--color-tracky-light) 45%, transparent); }
    .dv-case:focus { border-color: var(--color-tracky-light); }
    .dv-astuce { margin: 9px 0 0; font-size: .78rem; line-height: 1.45; color: var(--fg-secondary); text-wrap: pretty; }
    .dv-error { margin: 12px 0 0; font-size: .85rem; color: var(--texte-alerte); font-weight: 600; }
    .dv-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; margin-top: 18px; }
    .dv-btn {
      font: inherit; font-weight: 700; font-size: .9rem; padding: 11px 18px; border-radius: 11px;
      cursor: pointer; min-height: 44px; border: 1px solid var(--border-strong); background: transparent; color: var(--fg-primary);
    }
    .dv-btn:disabled { opacity: .5; cursor: not-allowed; }
    .dv-btn--ghost { color: var(--fg-secondary); }
    .dv-btn--primary { border: 0; background: var(--color-tracky-light); color: var(--accent-ink); }
    .dv-resend {
      display: block; margin: 16px auto 0; font: inherit; font-size: .84rem; font-weight: 600;
      background: none; border: 0; color: var(--texte-succes); cursor: pointer; min-height: 44px; padding: 4px 8px;
    }
    .dv-resend:disabled { color: var(--fg-secondary); cursor: default; }
    /*
     * Sous 420 px, l'espacement de 9 px ramenait chaque case a 41 px de LARGE (mesure a
     * 375 px) — sous le seuil, alors que la hauteur, elle, etait bonne. Une cible n'est
     * atteignable que si ses deux dimensions le sont : l'espacement cede, pas la case.
     */
    @media (max-width: 420px) { .dv-otp { gap: 5px; } .dv-shell { padding: 22px 18px 18px; } }
    @media (max-width: 480px) { .dv-actions { flex-direction: column-reverse; } .dv-btn { width: 100%; } }
    `,
  ],
})
export class DeviceVerificationGateComponent {
  readonly security = inject(SecurityService);
  readonly consent = inject(ConsentService);
  /** Le rang de cette porte dans la file — calculé, jamais écrit (lot B0′). */
  readonly portes = inject(PortesAccesService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly realtime = inject(RealtimeService);
  private readonly toast = inject(ToastService);

  readonly ShieldCheck = ShieldCheck;

  /** Les six positions, pour le `@for` du gabarit. */
  readonly positions = [0, 1, 2, 3, 4, 5];
  readonly chiffres = signal<string[]>(['', '', '', '', '', '']);
  /** Le code reste la concaténation : le reste du composant n'a pas changé. */
  readonly code = computed(() => this.chiffres().join(''));

  readonly sending = signal(false);
  readonly verifying = signal(false);
  readonly error = signal<string | null>(null);
  readonly cooldown = signal(0);

  private cooldownTimer?: ReturnType<typeof setInterval>;

  private cases(depuis: HTMLElement): HTMLInputElement[] {
    const grille = depuis.closest('.dv-otp');
    return grille ? Array.from(grille.querySelectorAll<HTMLInputElement>('.dv-case')) : [];
  }

  private poser(valeurs: string[]): void {
    this.chiffres.set(valeurs);
    if (this.error()) this.error.set(null);
  }

  /** Saisie dans une case : on avance tout seul, comme sur un pavé de code. */
  onCase(i: number, e: Event): void {
    const el = e.target as HTMLInputElement;
    const saisi = el.value.replace(/\D/g, '');
    const v = [...this.chiffres()];
    v[i] = saisi.slice(-1);
    this.poser(v);
    el.value = v[i];
    if (v[i] && i < 5) this.cases(el)[i + 1]?.focus();
    this.verifierSiComplet(el);
  }

  /**
   * Retour arrière depuis une case VIDE : on remonte d'une case. Sans ça, effacer un code
   * demande de viser chaque case au doigt — l'inverse de ce que la séparation apporte.
   */
  onTouche(i: number, e: KeyboardEvent): void {
    const el = e.target as HTMLInputElement;
    if (e.key === 'Backspace' && !this.chiffres()[i] && i > 0) {
      e.preventDefault();
      const v = [...this.chiffres()];
      v[i - 1] = '';
      this.poser(v);
      this.cases(el)[i - 1]?.focus();
      return;
    }
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); this.cases(el)[i - 1]?.focus(); }
    if (e.key === 'ArrowRight' && i < 5) { e.preventDefault(); this.cases(el)[i + 1]?.focus(); }
    if (e.key === 'Enter') this.verify();
  }

  /**
   * LE COLLAGE DEPUIS L'E-MAIL. C'est le geste naturel quand le code arrive par mail, et il
   * n'était traité nulle part. On accepte n'importe quel texte collé et on n'en garde que
   * les chiffres : « Votre code : 472913 » remplit les six cases aussi bien que « 472913 ».
   */
  onPaste(e: ClipboardEvent): void {
    const brut = e.clipboardData?.getData('text') ?? '';
    const chiffres = brut.replace(/\D/g, '').slice(0, 6);
    if (!chiffres) return;
    e.preventDefault();
    const v = ['', '', '', '', '', ''];
    for (let i = 0; i < chiffres.length; i++) v[i] = chiffres[i];
    this.poser(v);
    const el = e.target as HTMLElement;
    const liste = this.cases(el);
    liste.forEach((c, i) => { c.value = v[i]; });
    liste[Math.min(chiffres.length, 5)]?.focus();
    this.verifierSiComplet(el);
  }

  /** Les 6 chiffres sont là : on vérifie sans demander un tap de plus. */
  private verifierSiComplet(el: HTMLElement): void {
    if (this.code().length === 6 && !this.verifying()) {
      el.blur();
      void this.verify();
    }
  }

  async resend(): Promise<void> {
    if (this.sending() || this.cooldown() > 0) return;
    this.error.set(null);
    this.sending.set(true);
    const r = await this.security.resend();
    this.sending.set(false);
    if (!r.ok) this.error.set("L'envoi du code a échoué. Patientez un instant puis réessayez.");
    this.startCooldown(30);
  }

  async verify(): Promise<void> {
    if (this.code().length !== 6 || this.verifying()) return;
    this.verifying.set(true);
    this.error.set(null);
    const ok = await this.security.verify(this.code());
    if (ok) {
      window.location.reload();
    } else {
      this.verifying.set(false);
      this.error.set('Code incorrect ou expiré. Réessayez, ou renvoyez un nouveau code.');
    }
  }

  logout(): void {
    this.realtime.disconnect();
    this.auth.logout();
    this.toast.error('Déconnecté', 'Confirmez la connexion pour accéder à Vizyo Tracky.');
    void this.router.navigate(['/login']);
  }

  private startCooldown(seconds: number): void {
    this.cooldown.set(seconds);
    if (this.cooldownTimer) clearInterval(this.cooldownTimer);
    this.cooldownTimer = setInterval(() => {
      const n = this.cooldown() - 1;
      this.cooldown.set(n);
      if (n <= 0 && this.cooldownTimer) {
        clearInterval(this.cooldownTimer);
        this.cooldownTimer = undefined;
      }
    }, 1000);
  }
}
