import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { ThemeService } from '../../core/theme/theme.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <!-- Card glassmorphism : tres transparente pour laisser voir le globe
         en arriere-plan, blur eleve pour conserver la lisibilite des
         inputs, bord lumineux haut tracky pour la signature visuelle. -->
    <div
      class="relative rounded-[--radius-card] p-7 sm:p-8
             bg-bg-secondary/30 backdrop-blur-2xl backdrop-saturate-150
             border border-white/10
             shadow-[0_12px_48px_-16px_rgba(0,0,0,0.55)]
             before:absolute before:-top-px before:left-1/2 before:-translate-x-1/2
             before:h-px before:w-2/3 before:bg-gradient-to-r
             before:from-transparent before:via-tracky-light/70 before:to-transparent
             before:pointer-events-none"
    >
      <div class="mb-6">
        <h2 class="text-2xl font-display font-semibold text-fg-primary tracking-tight">
          Connexion
        </h2>
        <p class="text-sm text-fg-tertiary mt-1">
          Acces a votre tableau de bord
        </p>
      </div>

      <form (ngSubmit)="onSubmit()" class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <label for="email" class="text-[13px] font-medium text-fg-secondary"
            >Email</label
          >
          <div class="relative">
            <span
              class="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-tertiary
                     pointer-events-none"
              aria-hidden="true"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="m3 7 9 6 9-6" />
              </svg>
            </span>
            <input
              id="email"
              type="email"
              [(ngModel)]="email"
              name="email"
              placeholder="vous@example.com"
              autocomplete="email"
              class="w-full pl-10 pr-4 py-2.5 rounded-xl
                     bg-bg-tertiary/40 border border-white/10
                     text-fg-primary placeholder:text-fg-tertiary
                     focus:outline-none focus:border-tracky focus:ring-2 focus:ring-tracky/30
                     focus:bg-bg-tertiary/70
                     transition-all duration-200"
              required
            />
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="password" class="text-[13px] font-medium text-fg-secondary"
            >Mot de passe</label
          >
          <div class="relative">
            <span
              class="absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-tertiary
                     pointer-events-none"
              aria-hidden="true"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
            <input
              id="password"
              [type]="showPassword() ? 'text' : 'password'"
              [(ngModel)]="password"
              name="password"
              placeholder="........"
              autocomplete="current-password"
              class="w-full pl-10 pr-11 py-2.5 rounded-xl
                     bg-bg-tertiary/40 border border-white/10
                     text-fg-primary placeholder:text-fg-tertiary
                     focus:outline-none focus:border-tracky focus:ring-2 focus:ring-tracky/30
                     focus:bg-bg-tertiary/70
                     transition-all duration-200"
              required
            />
            <button type="button" (click)="showPassword.set(!showPassword())"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-fg-tertiary
                     hover:text-fg-secondary transition-colors cursor-pointer
                     p-1 rounded-md"
              [attr.aria-label]="showPassword() ? 'Masquer le mot de passe' : 'Afficher le mot de passe'">
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

        <div class="flex justify-end">
          <a routerLink="/forgot-password"
             class="text-[13px] text-tracky-light hover:text-tracky transition-colors cursor-pointer">
            Mot de passe oublie ?
          </a>
        </div>

        @if (error()) {
          <div
            class="flex items-start gap-2 p-3 rounded-lg
                   bg-red-500/10 border border-red-500/30 text-red-400 text-sm"
            role="alert"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                 class="shrink-0 mt-0.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{{ error() }}</span>
          </div>
        }

        <button
          type="submit"
          [disabled]="loading()"
          class="mt-1 group relative w-full py-3 rounded-xl
                 font-semibold text-white text-sm
                 bg-tracky-gradient
                 shadow-[0_4px_20px_-4px_rgba(5,150,105,0.5)]
                 hover:shadow-[0_6px_28px_-4px_rgba(5,150,105,0.65)]
                 hover:-translate-y-px
                 active:translate-y-0
                 disabled:opacity-60 disabled:cursor-not-allowed
                 disabled:hover:translate-y-0 disabled:hover:shadow-[0_4px_20px_-4px_rgba(5,150,105,0.5)]
                 transition-all duration-200 cursor-pointer
                 flex items-center justify-center gap-2"
        >
          @if (loading()) {
            <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
                  aria-hidden="true"></span>
            <span>Connexion en cours...</span>
          } @else {
            <span>Se connecter</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                 class="transition-transform group-hover:translate-x-0.5">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          }
        </button>
      </form>
    </div>
  `,
})
export class LoginComponent implements OnInit {
  protected email = '';
  protected password = '';
  protected readonly showPassword = signal(false);
  protected readonly error = signal('');
  protected readonly loading = signal(false);

  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly preferences = inject(PreferencesService);
  private readonly themeService = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);

  constructor(private readonly router: Router) {}

  ngOnInit(): void {
    const emailParam = this.route.snapshot.queryParamMap.get('email');
    if (emailParam) this.email = emailParam;
  }

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
