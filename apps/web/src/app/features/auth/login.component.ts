import { swallow } from '../../core/error/swallow';
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
    <!-- Card glassmorphism (mobile/tablet) : tres transparente pour laisser
         voir le globe en arriere-plan, blur eleve pour conserver la
         lisibilite des inputs, bord lumineux haut tracky.
         Desktop (lg+) : on retire la card -- le panneau formulaire de
         auth-layout fournit deja le contenant et le titre. -->
    <div class="mb-6">
      <span class="vt-eyebrow">Espace pro</span>
      <h1 class="font-display text-[2.15rem] font-extrabold tracking-[-0.03em] leading-[1.07] text-fg-primary mt-3">Bon retour.</h1>
      <p class="text-[1.02rem] text-fg-secondary leading-[1.5] mt-3">Connectez-vous à votre tableau de bord Vizyo Tracky.</p>
    </div>
    <form (ngSubmit)="onSubmit()" class="flex flex-col gap-4 w-full">
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
                     bg-bg-tertiary/40 border border-border-strong
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
                     bg-bg-tertiary/40 border border-border-strong
                     text-fg-primary placeholder:text-fg-tertiary
                     focus:outline-none focus:border-tracky focus:ring-2 focus:ring-tracky/30
                     focus:bg-bg-tertiary/70
                     transition-all duration-200"
              required
            />
            <button type="button" (click)="showPassword.set(!showPassword())"
              class="lg-oeil absolute right-3 top-1/2 -translate-y-1/2 text-fg-tertiary
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

        <div class="flex items-center justify-between gap-3">
          <label class="flex items-center gap-2 cursor-pointer select-none text-[13px] text-fg-secondary">
            <input
              type="checkbox"
              [(ngModel)]="remember"
              name="remember"
              class="lg-case w-4 h-4 rounded cursor-pointer"
              style="accent-color: var(--tracky)"
            />
            Rester connecté
          </label>
          <!-- « oublie » sans accent est reste ici alors que /forgot-password ecrit
               le mot avec son accent, a deux ecrans d'ecart. La garde verif:accents
               est VERTE : le mot n'est pas dans sa liste, et volontairement — « il
               oublie » est un verbe valide sans accent. Une garde-liste ne rattrape
               que ce qu'on y inscrit. -->
          <a routerLink="/forgot-password"
             class="lg-oubli text-[13px] text-texte-succes hover:text-tracky transition-colors cursor-pointer">
            Mot de passe oublié ?
          </a>
        </div>

        @if (error()) {
          <div
            class="flex items-start gap-2 p-3 rounded-lg text-sm"
            style="background:color-mix(in srgb, var(--danger) 12%, transparent); border:1px solid color-mix(in srgb, var(--danger) 32%, transparent); color:var(--danger)"
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
          class="mt-1 group relative w-full py-3.5 rounded-xl
                 font-semibold text-sm
                 bg-tracky-light text-[var(--accent-ink)]
                 shadow-[0_10px_26px_-8px_rgba(16,224,160,0.5)]
                 hover:shadow-[0_16px_34px_-10px_rgba(16,224,160,0.62)]
                 hover:-translate-y-px
                 active:translate-y-0
                 disabled:opacity-60 disabled:cursor-not-allowed
                 disabled:hover:translate-y-0
                 transition-all duration-200 cursor-pointer
                 flex items-center justify-center gap-2"
        >
          @if (loading()) {
            <span class="w-4 h-4 rounded-full animate-spin" aria-hidden="true"
                  style="border:2px solid color-mix(in srgb, var(--accent-ink) 30%, transparent); border-top-color: var(--accent-ink)"></span>
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

      <!-- Crédit discret : l'auth déléguée à Vizyo Auth (fournisseur d'identité). -->
      <div class="mt-7 flex flex-col items-center gap-1 text-center">
        <span class="inline-flex items-center gap-1.5 text-[11px] text-fg-tertiary">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" />
          </svg>
          Authentification sécurisée par
          <span class="font-semibold text-fg-secondary">Vizyo&nbsp;Auth</span>
        </span>
        <span class="text-[10px] text-fg-tertiary">
          Plateforme d'identité dédiée à la sécurité des applications Vizyo
        </span>
      </div>
  `,
  styles: [`
    /* ─── Cibles tactiles — la page la plus ouverte de l'application ────────────
     *
     * Critère de recette « iPhone 390 px : cibles ≥ 44 px ». B1 § A rappelle que
     * les pages hors session sont « quasi exclusivement mobiles, ouvertes depuis un
     * SMS ou un QR : concevoir mobile d'abord, le PC est un repli ».
     *
     * Mesuré à 375 px : l'œil qui montre le mot de passe faisait 26 × 36, la case
     * « Rester connecté » 16 × 16, le lien d'oubli 36 de haut. Trois commandes ratées
     * sur l'écran où l'on n'est même pas encore entré. */
    @media (max-width: 768px) {
      .lg-oeil { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center }
      .lg-oubli { min-height: 44px; display: inline-flex; align-items: center }
      /* La case garde sa taille visuelle — une case à cocher de 44 px est une tache.
         C'est son ÉTIQUETTE qui devient la cible : elle enveloppe déjà la case. */
      .lg-case { width: 20px; height: 20px }
      label:has(.lg-case) { min-height: 44px }
    }
  `],
})
export class LoginComponent implements OnInit {
  protected email = '';
  protected password = '';
  /** « Rester connecté » — défaut activé (la plupart des utilisateurs veulent rester connectés). */
  protected remember = true;
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
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.email, password: this.password, remember: this.remember }),
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
        isOwner: data.user.isOwner ?? false,
        fleetId: data.user.fleetId ?? null,
        permissions: data.user.permissions ?? null,
        preferences: data.user.preferences ?? null,
      }, data.refreshToken, this.remember);
      this.preferences.load(data.user.id);
      this.themeService.init();
      this.realtime.connect(data.accessToken);
      // V1.12 — Mode Baanool : connexion directe sur la carte au lieu du dashboard.
      // Sprint 3 — veilleur de nuit : connexion directe sur sa liste véhicules (seul périmètre).
      const baanool = data.user.preferences?.uiMode === 'baanool';
      // feat/comptes-conducteurs — retour post-login vers la page d'origine (ex. scan QR
      // /driver/unlock alors qu'on n'était pas connecté). URL INTERNE uniquement (anti open-redirect).
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
      const safeReturn = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : null;
      // Espace dépôt (2026-08) — un DEPOT arrive sur `/depot`, jamais sur `/dashboard`.
      // Placé en tête, au même endroit que la redirection du conducteur (A1 § 5).
      const home = this.auth.isDepot()
        ? '/depot'
        : this.auth.isDriver()
          ? '/driver'
          : this.auth.isWatchman()
            ? '/vehicles'
            : baanool
              ? '/map'
              : '/dashboard';
      this.router.navigateByUrl(safeReturn ?? home);
    } catch (err) {
      swallow('login:onSubmit', err);
      this.error.set('Erreur de connexion au serveur');
    } finally {
      this.loading.set(false);
    }
  }
}
