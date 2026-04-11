import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { RealtimeService } from '../../core/services/realtime.service';

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
            placeholder="track1@gmail.com"
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
          <input
            id="password"
            type="password"
            [(ngModel)]="password"
            name="password"
            placeholder="Votre mot de passe"
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
  protected email = 'tracky1@gmail.com';
  protected password = 'AdminTracky2026!';
  protected readonly error = signal('');
  protected readonly loading = signal(false);

  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);

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
      });
      this.realtime.connect(data.accessToken);
      this.router.navigate(['/dashboard']);
    } catch {
      this.error.set('Erreur de connexion au serveur');
    } finally {
      this.loading.set(false);
    }
  }
}
