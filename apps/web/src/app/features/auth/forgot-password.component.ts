import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-8">
      <h2 class="text-xl font-display font-semibold text-fg-primary mb-2">
        Mot de passe oublie ?
      </h2>
      <p class="text-sm text-fg-tertiary mb-6">
        Entrez votre adresse email et nous vous enverrons un lien pour reinitialiser votre mot de passe.
      </p>

      @if (sent()) {
        <div class="flex flex-col items-center gap-4 py-4">
          <div class="w-14 h-14 rounded-full bg-tracky/10 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-tracky-light">
              <path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>
            </svg>
          </div>
          <p class="text-sm text-fg-secondary text-center">
            Si un compte existe avec l'adresse <strong class="text-fg-primary">{{ email }}</strong>,
            un email de reinitialisation a ete envoye.
          </p>
          <p class="text-xs text-fg-tertiary text-center">
            Verifiez votre boite de reception (et vos spams).
          </p>
          <a routerLink="/login" class="mt-2 text-sm text-tracky-light hover:underline cursor-pointer">
            Retour a la connexion
          </a>
        </div>
      } @else {
        <form (ngSubmit)="onSubmit()" class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <label for="email" class="text-sm font-medium text-fg-secondary">Email</label>
            <input
              id="email"
              type="email"
              [(ngModel)]="email"
              name="email"
              placeholder="vous{'@'}example.com"
              autocomplete="email"
              class="w-full px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border-subtle
                     text-fg-primary placeholder:text-fg-tertiary
                     focus:outline-none focus:border-tracky focus:ring-1 focus:ring-tracky
                     transition-all duration-200"
              required
            />
          </div>

          @if (error()) {
            <p class="text-sm text-red-400">{{ error() }}</p>
          }

          <button
            type="submit"
            [disabled]="loading()"
            class="mt-2 w-full py-2.5 rounded-xl font-medium text-white
                   bg-tracky-gradient hover:opacity-90
                   disabled:opacity-50 disabled:cursor-not-allowed
                   transition-opacity duration-200 cursor-pointer"
          >
            @if (loading()) {
              Envoi en cours...
            } @else {
              Envoyer le lien
            }
          </button>

          <a routerLink="/login" class="text-sm text-fg-tertiary hover:text-fg-secondary text-center cursor-pointer">
            Retour a la connexion
          </a>
        </form>
      }
    </div>
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
