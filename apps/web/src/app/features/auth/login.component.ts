import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ThemeService } from '../../core/theme/theme.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div
      class="bg-bg-secondary border border-border-subtle rounded-[--radius-card] p-8"
    >
      <h2 class="text-xl font-display font-semibold text-fg-primary mb-6">
        Connexion
      </h2>

      <form (ngSubmit)="onSubmit()" class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <label for="email" class="text-sm font-medium text-fg-secondary"
            >Email</label
          >
          <input
            id="email"
            type="email"
            [(ngModel)]="email"
            name="email"
            placeholder=""
            class="w-full px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border-subtle
                   text-fg-primary placeholder:text-fg-tertiary
                   focus:outline-none focus:border-tracky focus:ring-1 focus:ring-tracky
                   transition-all duration-200"
            required
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="password" class="text-sm font-medium text-fg-secondary"
            >Mot de passe</label
          >
          <div class="relative">
            <input
              id="password"
              [type]="showPassword() ? 'text' : 'password'"
              [(ngModel)]="password"
              name="password"
              placeholder=""
              class="w-full px-4 py-2.5 pr-11 rounded-xl bg-bg-tertiary border border-border-subtle
                     text-fg-primary placeholder:text-fg-tertiary
                     focus:outline-none focus:border-tracky focus:ring-1 focus:ring-tracky
                     transition-all duration-200"
              required
            />
            <button type="button" (click)="showPassword.set(!showPassword())"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-fg-tertiary hover:text-fg-secondary transition-colors cursor-pointer">
              @if (!showPassword()) {
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                </svg>
              }
              @if (showPassword()) {
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              }
            </button>
          </div>
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
            Connexion en cours...
          } @else {
            Se connecter
          }
        </button>
      </form>
    </div>
  `,
})
export class LoginComponent {
  protected email = '';
  protected password = '';
  protected readonly showPassword = signal(false);
  protected readonly error = signal('');
  protected readonly loading = signal(false);

  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly preferences = inject(PreferencesService);
  private readonly themeService = inject(ThemeService);

  constructor(private readonly router: Router) {}

  async onSubmit(): Promise<void> {
    this.error.set('');
    this.loading.set(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.email, password: this.password }),
      });

      if (!res.ok) {
        this.error.set('Identifiants invalides');
        return;
      }

      const data = await res.json();
      this.auth.setSession(data.accessToken, {
        sub: data.user.id,
        email: data.user.email,
        role: data.user.role,
        fleetId: data.user.fleetId ?? null,
        permissions: data.user.permissions ?? null,
      }, data.refreshToken);
      this.preferences.load(data.user.id);
      this.themeService.init();
      this.realtime.connect(data.accessToken);
      this.router.navigate(['/dashboard']);
    } catch {
      this.error.set('Erreur de connexion au serveur');
    } finally {
      this.loading.set(false);
    }
  }
}
