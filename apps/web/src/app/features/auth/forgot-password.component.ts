import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

/**
 * Écran « Mot de passe oublié » (maquette 01b). Rendu dans le split-auth
 * (auth-layout) : le panneau marque à droite est fourni par le layout, ce
 * composant remplit `.auth-main` avec son propre titre + ses 2 états.
 *
 * Fonctionnel conservé : POST /api/auth/forgot-password + message NEUTRE
 * (anti-énumération : on n'indique jamais si le compte existe).
 */
@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [FormsModule, RouterLink],
  styles: [`
    @keyframes fp-pop { 0% { transform: scale(.7); opacity: 0 } 60% { transform: scale(1.06) } 100% { transform: scale(1); opacity: 1 } }
    .fp-pop { animation: fp-pop .4s cubic-bezier(.16,1,.3,1); }
    @media (prefers-reduced-motion: reduce) { .fp-pop { animation: none } }
  `],
  template: `
    @if (sent()) {
      <!-- ═══ État ENVOYÉ ═══ -->
      <div class="fp-pop text-center">
        <span class="inline-flex items-center justify-center w-16 h-16 rounded-full"
              style="background:color-mix(in srgb, var(--tracky-light) 12%, transparent); color:var(--tracky-light)">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>
          </svg>
        </span>
        <h1 class="font-display text-[1.85rem] font-extrabold tracking-[-0.02em] leading-[1.1] text-fg-primary mt-4">
          Vérifiez votre boîte mail.
        </h1>
        <p class="text-[.98rem] text-fg-secondary leading-[1.55] mt-3.5">
          Si un compte existe pour
          <strong class="text-fg-primary font-bold">{{ email || 'votre adresse' }}</strong>,
          un lien de réinitialisation vient d'être envoyé.
        </p>
        <div class="mt-5 flex items-start gap-2.5 p-3.5 rounded-xl bg-bg-secondary border border-border-subtle text-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 mt-0.5 text-fg-tertiary">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          <span class="text-[.83rem] text-fg-secondary leading-[1.5]">Le lien expire dans 60 minutes. Pensez à vérifier vos courriers indésirables.</span>
        </div>
        <a routerLink="/login" class="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-fg-secondary hover:text-tracky-light transition-colors cursor-pointer">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          Retour à la connexion
        </a>
      </div>
    } @else {
      <!-- ═══ État FORMULAIRE ═══ -->
      <div>
        <span class="vt-eyebrow">Espace client</span>
        <h1 class="font-display text-[2.15rem] font-extrabold tracking-[-0.03em] leading-[1.07] text-fg-primary mt-3">
          Mot de passe oublié ?
        </h1>
        <p class="text-[1.02rem] text-fg-secondary leading-[1.5] mt-3">
          Saisissez votre adresse e-mail : nous vous enverrons un lien pour réinitialiser votre mot de passe.
        </p>

        <form (ngSubmit)="onSubmit()" class="mt-7 flex flex-col gap-4">
          <div class="flex flex-col gap-2">
            <label for="fp-email" class="text-[13px] font-medium text-fg-secondary">Adresse e-mail</label>
            <div class="relative">
              <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>
                </svg>
              </span>
              <input
                id="fp-email"
                type="email"
                [(ngModel)]="email"
                name="email"
                placeholder="vous@societe.fr"
                autocomplete="email"
                required
                class="w-full pl-10 pr-4 py-2.5 rounded-xl
                       bg-bg-tertiary/40 border border-border-strong
                       text-fg-primary placeholder:text-fg-tertiary
                       focus:outline-none focus:border-tracky focus:ring-2 focus:ring-tracky/30
                       focus:bg-bg-tertiary/70 transition-all duration-200"
              />
            </div>
          </div>

          @if (error()) {
            <p class="text-sm" style="color:var(--danger)">{{ error() }}</p>
          }

          <button
            type="submit"
            [disabled]="loading()"
            class="mt-1 group w-full py-3.5 rounded-xl font-semibold text-sm
                   bg-tracky-light text-[var(--accent-ink)]
                   shadow-[0_10px_26px_-8px_rgba(16,224,160,0.5)]
                   hover:shadow-[0_16px_34px_-10px_rgba(16,224,160,0.62)] hover:-translate-y-px
                   active:translate-y-0 disabled:opacity-60 disabled:cursor-not-allowed
                   disabled:hover:translate-y-0 transition-all duration-200 cursor-pointer
                   flex items-center justify-center gap-2"
          >
            @if (loading()) {
              <span class="w-4 h-4 rounded-full animate-spin" aria-hidden="true"
                    style="border:2px solid color-mix(in srgb, var(--accent-ink) 30%, transparent); border-top-color: var(--accent-ink)"></span>
              <span>Envoi en cours…</span>
            } @else {
              <span>Envoyer le lien</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="transition-transform group-hover:translate-x-0.5">
                <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
              </svg>
            }
          </button>
        </form>

        <a routerLink="/login" class="mt-6 flex items-center justify-center gap-2 text-sm font-semibold text-fg-secondary hover:text-tracky-light transition-colors cursor-pointer">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          Retour à la connexion
        </a>
      </div>
    }
  `,
})
export class ForgotPasswordComponent {
  protected email = '';
  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly sent = signal(false);

  async onSubmit(): Promise<void> {
    if (!this.email) return;
    this.error.set('');
    this.loading.set(true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.email }),
      });

      if (!res.ok) throw new Error('Erreur serveur');
      this.sent.set(true);
    } catch {
      this.error.set('Erreur de connexion au serveur');
    } finally {
      this.loading.set(false);
    }
  }
}
