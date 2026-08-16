import { swallow } from '../../core/error/swallow';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  AlertTriangle, ArrowRight, Check, Eye, EyeOff, KeyRound, Lock, LucideAngularModule,
  Moon, ShieldAlert, Sun, UserCircle2,
} from 'lucide-angular';
import { AuthService, type AuthUser } from '../../core/services/auth.service';
import { UsersApiService } from '../../core/services/users.service';
import { RealtimeService } from '../../core/services/realtime.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ThemeService } from '../../core/theme/theme.service';
import { LogoComponent } from '../../shared/ui/logo/logo.component';

/**
 * V1.5 (Sprint J) — Page publique pour accepter une invitation.
 * Refonte DS (maquette 01c) : page pleine centrée sur fond branded, 3 états
 * (formulaire / bienvenue / lien invalide), jauge de robustesse 12 car., toggle
 * mot de passe. Le fonctionnel est INCHANGÉ : token en query, acceptInvitation()
 * → /auth/me → AuthService.setSession() → /dashboard (le wizard onboarding
 * s'ouvre ensuite). Gestion « déjà activé / expiré / invalide » conservée.
 */
@Component({
  selector: 'app-accept-invite',
  standalone: true,
  imports: [LucideAngularModule, FormsModule, RouterLink, LogoComponent],
  template: `
    <div class="ai-page">
      <div class="ai-grid" aria-hidden="true"></div>
      <div class="ai-glow" aria-hidden="true"></div>

      <button type="button" class="ai-theme" (click)="theme.toggle()" aria-label="Changer de thème">
        <lucide-icon [img]="theme.theme() === 'dark' ? MoonIcon : SunIcon" [size]="17"></lucide-icon>
      </button>

      <div class="ai-logo">
        <app-logo variant="icon" [size]="32" />
        <span class="ai-brand">Vizyo <span class="text-tracky-light">Tracky</span></span>
      </div>

      <div class="ai-card">
        @if (errorMessage()) {
          <!-- ═══ ÉTAT LIEN INVALIDE / EXPIRÉ ═══ -->
          <div class="ai-state">
            <span class="ai-state-ic ai-state-ic--err"><lucide-icon [img]="ShieldAlert" [size]="30"></lucide-icon></span>
            <h1>Lien invalide ou expiré.</h1>
            <p>{{ errorMessage() }}</p>
            <a routerLink="/login" class="ai-back">Retour à la connexion</a>
          </div>
        } @else if (success()) {
          <!-- ═══ ÉTAT SUCCÈS ═══ -->
          <div class="ai-state ai-pop">
            <span class="ai-state-ic ai-state-ic--ok"><lucide-icon [img]="Check" [size]="32"></lucide-icon></span>
            <div class="ai-eyebrow">Compte activé</div>
            <h1>Bienvenue sur Vizyo Tracky&nbsp;!</h1>
            <p>
              Votre compte @if (userEmail()) { <strong>{{ userEmail() }}</strong> } est prêt.
              Vous êtes connecté — redirection vers votre tableau de bord…
            </p>
            <a [routerLink]="homeRoute()" class="ai-submit ai-submit--link">
              <span>Accéder à mon tableau de bord</span>
              <lucide-icon [img]="ArrowRightIcon" [size]="16"></lucide-icon>
            </a>
          </div>
        } @else {
          <!-- ═══ ÉTAT FORMULAIRE ═══ -->
          <div class="ai-head">
            <span class="ai-head-ic"><lucide-icon [img]="UserCircle2" [size]="28"></lucide-icon></span>
            <div class="ai-eyebrow">Invitation</div>
            <h1>Activez votre accès.</h1>
            <p>Créez votre mot de passe pour rejoindre <strong>Vizyo Tracky</strong>.</p>
          </div>

          <form (submit)="$event.preventDefault(); submit()" class="ai-form">
            <div class="ai-field">
              <label for="ai-name">Nom complet</label>
              <input id="ai-name" class="ai-in" [(ngModel)]="displayName" name="displayName"
                     placeholder="Prénom Nom" autocomplete="name" required />
            </div>

            <div class="ai-field">
              <label for="ai-pw">Mot de passe</label>
              <div class="ai-pw-wrap">
                <input id="ai-pw" class="ai-in" [(ngModel)]="password" name="password"
                       [type]="showPassword() ? 'text' : 'password'"
                       placeholder="12 caractères minimum" autocomplete="new-password" required minlength="12" />
                <button type="button" class="ai-pw-toggle" (click)="showPassword.set(!showPassword())"
                        [attr.aria-label]="showPassword() ? 'Masquer le mot de passe' : 'Afficher le mot de passe'">
                  <lucide-icon [img]="showPassword() ? EyeOffIcon : EyeIcon" [size]="17"></lucide-icon>
                </button>
              </div>
              <div class="ai-meter">
                <div class="ai-meter-track"><div class="ai-meter-fill" [style.width.%]="pwPct()" [style.background]="pwColor()"></div></div>
                <span class="ai-meter-label" [style.color]="pwColor()">{{ pwLabel() }}</span>
              </div>
            </div>

            <div class="ai-field">
              <label for="ai-pw2">Confirmer le mot de passe</label>
              <div class="ai-pw-wrap">
                <input id="ai-pw2" class="ai-in" [(ngModel)]="passwordConfirm" name="passwordConfirm"
                       [type]="showConfirm() ? 'text' : 'password'"
                       placeholder="Saisir à nouveau" autocomplete="new-password" required />
                <button type="button" class="ai-pw-toggle" (click)="showConfirm.set(!showConfirm())"
                        [attr.aria-label]="showConfirm() ? 'Masquer le mot de passe' : 'Afficher le mot de passe'">
                  <lucide-icon [img]="showConfirm() ? EyeOffIcon : EyeIcon" [size]="17"></lucide-icon>
                </button>
              </div>
              @if (passwordConfirm.length > 0 && !passwordsMatch()) {
                <span class="ai-mismatch"><lucide-icon [img]="AlertTriangleIcon" [size]="13"></lucide-icon>Les mots de passe ne correspondent pas.</span>
              }
            </div>

            @if (submitError()) {
              <div class="ai-alert" role="alert"><lucide-icon [img]="ShieldAlert" [size]="16"></lucide-icon><span>{{ submitError() }}</span></div>
            }

            <button type="submit" class="ai-submit" [disabled]="loading() || !canSubmit()">
              @if (loading()) {
                <span class="ai-spin"></span><span>Validation…</span>
              } @else {
                <lucide-icon [img]="KeyRound" [size]="15"></lucide-icon><span>Activer mon compte</span>
              }
            </button>
          </form>

          <p class="ai-terms">En activant votre compte, vous acceptez les conditions d'utilisation de Vizyo Tracky.</p>
        }
      </div>

      <div class="ai-trust">
        <span><lucide-icon [img]="LockIcon" [size]="14"></lucide-icon>Connexion chiffrée</span>
        <span><lucide-icon [img]="ShieldAlert" [size]="14"></lucide-icon>Données hébergées en France</span>
      </div>
    </div>
  `,
  styles: [`
    .ai-page {
      position: relative; min-height: 100svh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 0;
      padding: 40px max(22px, env(safe-area-inset-left)); background: var(--bg-primary); overflow: hidden;
    }
    .ai-grid {
      position: absolute; inset: 0; pointer-events: none;
      background-image:
        linear-gradient(color-mix(in srgb, var(--fg-primary) 4%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--fg-primary) 4%, transparent) 1px, transparent 1px);
      background-size: 46px 46px;
      -webkit-mask-image: radial-gradient(ellipse 70% 55% at 50% 40%, #000, transparent 78%);
      mask-image: radial-gradient(ellipse 70% 55% at 50% 40%, #000, transparent 78%);
    }
    .ai-glow {
      position: absolute; top: -10%; left: 50%; transform: translateX(-50%);
      width: 640px; height: 420px; pointer-events: none;
      background: radial-gradient(ellipse at center, color-mix(in srgb, var(--tracky-light) 12%, transparent), transparent 68%);
      filter: blur(8px);
    }
    .ai-theme {
      position: absolute; top: 22px; right: 22px; z-index: 2;
      display: inline-flex; align-items: center; justify-content: center;
      width: 38px; height: 38px; border-radius: 10px;
      border: 1px solid var(--border-subtle); background: var(--bg-secondary);
      color: var(--fg-secondary); cursor: pointer; transition: color .2s, border-color .2s;
    }
    .ai-theme:hover { color: var(--fg-primary); border-color: var(--border-strong); }

    .ai-logo { position: relative; z-index: 1; display: flex; align-items: center; gap: 11px; margin-bottom: 24px; }
    .ai-brand { font-weight: 800; font-size: 1.15rem; letter-spacing: -.01em; color: var(--fg-primary); }

    .ai-card {
      position: relative; z-index: 1; width: 100%; max-width: 432px;
      padding: 30px 30px 32px; border-radius: 22px;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle);
      box-shadow: 0 1px 2px rgba(0,0,0,.35), 0 30px 70px -22px rgba(0,0,0,.55);
    }

    .ai-head { text-align: center; margin-bottom: 22px; }
    .ai-head-ic {
      display: inline-flex; align-items: center; justify-content: center;
      width: 58px; height: 58px; border-radius: 50%; margin-bottom: 14px;
      background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--tracky-light);
    }
    .ai-eyebrow {
      font-family: var(--font-mono, monospace); font-size: .66rem; font-weight: 600;
      letter-spacing: .16em; text-transform: uppercase; color: var(--tracky-light); margin-bottom: 8px;
    }
    .ai-head h1 { margin: 0; font-family: var(--font-display, inherit); font-size: 1.5rem; font-weight: 800; letter-spacing: -.02em; line-height: 1.15; color: var(--fg-primary); }
    .ai-head p { margin: 9px 0 0; font-size: .92rem; color: var(--fg-secondary); line-height: 1.5; }
    .ai-head p strong { color: var(--fg-primary); font-weight: 700; }

    .ai-form { display: flex; flex-direction: column; gap: 15px; }
    .ai-field { display: flex; flex-direction: column; gap: 7px; }
    .ai-field label {
      font-family: var(--font-mono, monospace); font-size: .66rem; font-weight: 600;
      letter-spacing: .1em; text-transform: uppercase; color: var(--fg-tertiary);
    }
    .ai-in {
      width: 100%; padding: 12px 14px; border-radius: 11px;
      background: var(--bg-tertiary); border: 1px solid var(--border-strong);
      color: var(--fg-primary); font-family: inherit; font-size: .95rem; outline: none;
      transition: border-color .18s, box-shadow .18s;
    }
    .ai-in::placeholder { color: var(--fg-tertiary); }
    .ai-in:focus { border-color: var(--tracky-light); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tracky-light) 20%, transparent); }

    .ai-pw-wrap { position: relative; display: flex; align-items: center; }
    .ai-pw-wrap .ai-in { padding-right: 44px; }
    .ai-pw-toggle {
      position: absolute; right: 8px; display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 8px; border: none; background: transparent;
      color: var(--fg-tertiary); cursor: pointer; transition: color .15s;
    }
    .ai-pw-toggle:hover { color: var(--fg-secondary); }

    .ai-meter { display: flex; align-items: center; gap: 9px; margin-top: 1px; }
    .ai-meter-track { flex: 1; height: 5px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden; }
    .ai-meter-fill { height: 100%; border-radius: 3px; transition: width .2s, background .2s; }
    .ai-meter-label { font-family: var(--font-mono, monospace); font-size: .68rem; font-weight: 600; white-space: nowrap; }

    .ai-mismatch { display: inline-flex; align-items: center; gap: 6px; font-size: .76rem; color: var(--warning); }

    .ai-alert {
      display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 10px;
      background: color-mix(in srgb, var(--danger) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
      color: var(--danger); font-size: 13px; line-height: 1.4;
    }
    .ai-alert lucide-icon { flex-shrink: 0; margin-top: 1px; }

    .ai-submit {
      margin-top: 4px; display: inline-flex; align-items: center; justify-content: center; gap: 9px;
      width: 100%; padding: 13px; border-radius: 12px; border: none;
      background: var(--tracky-light); color: var(--accent-ink); font-family: inherit; font-weight: 700; font-size: .96rem;
      cursor: pointer; box-shadow: 0 10px 26px -8px color-mix(in srgb, var(--tracky-light) 45%, transparent);
      transition: transform .2s, box-shadow .2s, opacity .2s;
    }
    .ai-submit:hover:not([disabled]) { transform: translateY(-2px); box-shadow: 0 16px 34px -10px color-mix(in srgb, var(--tracky-light) 55%, transparent); }
    .ai-submit[disabled] { opacity: .55; cursor: not-allowed; }
    /* Bouton « Accéder au tableau de bord » de l'état succès (rendu <a>, auto-connecté). */
    .ai-submit--link { margin-top: 22px; text-decoration: none; }

    .ai-terms { margin: 16px 0 0; font-size: .76rem; color: var(--fg-tertiary); line-height: 1.5; text-align: center; }

    .ai-state { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0; padding: 8px 0; }
    .ai-state-ic { display: inline-flex; align-items: center; justify-content: center; width: 64px; height: 64px; border-radius: 50%; margin-bottom: 16px; }
    .ai-state-ic--ok { background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--tracky-light); }
    .ai-state-ic--err { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }
    .ai-state h1 { margin: 0; font-family: var(--font-display, inherit); font-size: 1.5rem; font-weight: 800; letter-spacing: -.02em; color: var(--fg-primary); }
    .ai-state p { margin: 12px 0 0; font-size: .95rem; color: var(--fg-secondary); line-height: 1.55; }
    .ai-prep { margin-top: 20px; display: inline-flex; align-items: center; gap: 9px; color: var(--fg-tertiary); font-size: .82rem; }
    .ai-back {
      margin-top: 20px; display: inline-flex; align-items: center; gap: 8px; padding: 11px 18px;
      border-radius: 11px; border: 1px solid var(--border-strong); font-size: .86rem; font-weight: 700;
      color: var(--fg-primary); transition: border-color .2s; cursor: pointer;
    }
    .ai-back:hover { border-color: var(--tracky-light); }

    .ai-trust {
      position: relative; z-index: 1; margin-top: 24px; display: flex; flex-wrap: wrap;
      justify-content: center; gap: 20px; color: var(--fg-tertiary); font-size: .78rem;
    }
    .ai-trust span { display: inline-flex; align-items: center; gap: 7px; }

    .ai-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--accent-ink) 30%, transparent); border-top-color: var(--accent-ink); animation: ai-spin .7s linear infinite; }
    .ai-spin--sm { width: 15px; height: 15px; border-color: var(--border-strong); border-top-color: var(--tracky-light); }
    @keyframes ai-spin { to { transform: rotate(360deg); } }
    .ai-pop { animation: ai-pop .4s cubic-bezier(.16,1,.3,1); }
    @keyframes ai-pop { 0% { transform: scale(.7); opacity: 0 } 60% { transform: scale(1.06) } 100% { transform: scale(1); opacity: 1 } }
    @media (prefers-reduced-motion: reduce) { .ai-spin, .ai-pop { animation: none; } }
  `],
})
export class AcceptInviteComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly usersApi = inject(UsersApiService);
  private readonly auth = inject(AuthService);
  private readonly realtime = inject(RealtimeService);
  private readonly preferences = inject(PreferencesService);
  private readonly toast = inject(ToastService);
  protected readonly theme = inject(ThemeService);

  protected readonly Check = Check;
  protected readonly KeyRound = KeyRound;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly UserCircle2 = UserCircle2;
  protected readonly EyeIcon = Eye;
  protected readonly EyeOffIcon = EyeOff;
  protected readonly MoonIcon = Moon;
  protected readonly SunIcon = Sun;
  protected readonly LockIcon = Lock;
  protected readonly AlertTriangleIcon = AlertTriangle;
  protected readonly ArrowRightIcon = ArrowRight;

  readonly token = signal<string>('');
  readonly errorMessage = signal<string>('');
  readonly submitError = signal<string>('');
  readonly success = signal(false);
  readonly loading = signal(false);
  readonly showPassword = signal(false);
  readonly showConfirm = signal(false);
  /** E-mail du compte activé (affiché dans l'état succès). */
  readonly userEmail = signal<string>('');
  /** Destination post-activation, role-aware : dashboard, sauf veilleur → /vehicles. */
  readonly homeRoute = signal('/dashboard');

  displayName = '';
  password = '';
  passwordConfirm = '';

  /** Jauge de robustesse : 0 → gris, < 12 → ambre, ≥ 12 → émeraude « Robuste ». */
  protected pwPct(): number { return Math.min(100, Math.round((this.password.length / 12) * 100)); }
  protected pwColor(): string {
    const n = this.password.length;
    return n === 0 ? 'var(--fg-tertiary)' : n < 12 ? 'var(--warning)' : 'var(--tracky-light)';
  }
  protected pwLabel(): string {
    const n = this.password.length;
    return n === 0 ? '0/12' : n < 12 ? `${n}/12` : 'Robuste';
  }

  passwordsMatch(): boolean {
    return this.password === this.passwordConfirm;
  }

  canSubmit(): boolean {
    return this.displayName.trim().length >= 2
      && this.password.length >= 12
      && this.passwordsMatch();
  }

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token');
    if (!token) {
      this.errorMessage.set('Token d\'invitation manquant dans l\'URL.');
      return;
    }
    this.token.set(token);
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.loading.set(true);
    this.submitError.set('');
    try {
      const result = await this.usersApi.acceptInvitation({
        token: this.token(),
        password: this.password,
        displayName: this.displayName.trim(),
      });
      // Fetch the local Tracky user via /auth/me with the new access token,
      // then build a complete AuthUser for setSession.
      const meRes = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${result.accessToken}` },
      });
      if (!meRes.ok) {
        const body = await meRes.text().catch(() => '');
        throw new Error(`Échec de la création de session (HTTP ${meRes.status}${body ? ': ' + body.slice(0, 200) : ''})`);
      }
      const me = await meRes.json() as { id: string; email: string; role: string; fleetId: string | null };
      // Compte créé → AUTO-CONNEXION (demande user) : on ouvre la session tout de suite
      // et on branche temps réel + préférences comme un login normal (app.ts ne le fait
      // qu'au bootstrap, pas sur une navigation interne). On affiche l'état succès
      // « Bienvenue », puis redirection automatique. Le bouton « Accéder » saute l'attente.
      this.auth.setSession(result.accessToken, {
        sub: me.id,
        email: me.email,
        role: me.role as AuthUser['role'],
        fleetId: me.fleetId ?? null,
        permissions: null,
      }, result.refreshToken);
      this.preferences.load(me.id);
      this.realtime.connect(result.accessToken);
      this.userEmail.set(me.email);
      this.homeRoute.set(this.auth.isWatchman() ? '/vehicles' : '/dashboard');
      this.success.set(true);
      this.toast.success('Compte activé. Bienvenue sur Tracky !');
      setTimeout(() => this.router.navigate([this.homeRoute()]), 2200);
    } catch (err: unknown) {
      swallow('accept-invite:submit', err);
      const message = err instanceof Error ? err.message : 'Echec de l\'activation';
      console.error('[accept-invite] submit failed:', err);
      // Compte deja active : redirection vers login
      if (message.includes('deja active')) {
        this.toast.info('Votre compte est déjà activé. Connectez-vous.');
        this.router.navigate(['/login']);
        return;
      }
      // Si le lien a expire ou est invalide, afficher l'etat d'erreur plein ecran
      // au lieu du formulaire (l'utilisateur ne peut rien faire de plus).
      if (message.includes('expire') || message.includes('invalide')) {
        this.errorMessage.set(message);
      } else {
        this.submitError.set(message);
      }
      this.toast.error(message);
    } finally {
      this.loading.set(false);
    }
  }
}
