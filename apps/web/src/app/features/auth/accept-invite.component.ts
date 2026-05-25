import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Check, KeyRound, LucideAngularModule, ShieldAlert, UserCircle2 } from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { UsersApiService } from '../../core/services/users.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * V1.5 (Sprint J) — Page publique pour accepter une invitation.
 *
 * URL : /accept-invite?token=<JWT>
 * Public (pas de JWT auth requis) — auth via le token.
 * Sur succes : appelle backend → recupere session → AuthService.setSession() →
 * redirect vers /dashboard ou le wizard onboarding s'ouvre.
 */
@Component({
  selector: 'app-accept-invite',
  standalone: true,
  imports: [LucideAngularModule, FormsModule],
  template: `
    <div class="page">
      <div class="card">
        @if (errorMessage()) {
          <div class="state state--error">
            <lucide-icon [img]="ShieldAlert" [size]="40"></lucide-icon>
            <h1>Lien invalide</h1>
            <p>{{ errorMessage() }}</p>
          </div>
        } @else if (success()) {
          <div class="state state--success">
            <lucide-icon [img]="Check" [size]="40"></lucide-icon>
            <h1>Bienvenue !</h1>
            <p>Connexion en cours...</p>
          </div>
        } @else {
          <div class="header">
            <div class="header-icon">
              <lucide-icon [img]="UserCircle2" [size]="32"></lucide-icon>
            </div>
            <h1>Acceptez votre invitation</h1>
            <p>Creez votre mot de passe pour acceder a Vizyo Tracky.</p>
          </div>
          <form (submit)="$event.preventDefault(); submit()" class="form">
            <div class="field">
              <label>Nom complet</label>
              <input [(ngModel)]="displayName" name="displayName"
                     placeholder="Jean Dupont" autocomplete="name" required />
            </div>
            <div class="field">
              <label>Mot de passe</label>
              <input [(ngModel)]="password" name="password" type="password"
                     placeholder="8 caractères minimum" autocomplete="new-password" required minlength="8" />
            </div>
            <div class="field">
              <label>Confirmer le mot de passe</label>
              <input [(ngModel)]="passwordConfirm" name="passwordConfirm" type="password"
                     placeholder="Saisir à nouveau" autocomplete="new-password" required />
              @if (passwordConfirm.length > 0 && !passwordsMatch()) {
                <small class="warn">Les mots de passe ne correspondent pas.</small>
              }
            </div>
            @if (submitError()) {
              <div class="alert" role="alert">
                <lucide-icon [img]="ShieldAlert" [size]="16"></lucide-icon>
                <span>{{ submitError() }}</span>
              </div>
            }
            <button type="submit" class="btn-primary"
                    [disabled]="loading() || !canSubmit()">
              <lucide-icon [img]="KeyRound" [size]="14"></lucide-icon>
              {{ loading() ? 'Validation...' : 'Activer mon compte' }}
            </button>
          </form>
        }
      </div>
    </div>
  `,
  styles: [`
    .page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--bg-primary);
    }
    .card {
      width: 100%;
      max-width: 440px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-card, 16px);
      padding: 32px 28px;
    }
    .header { text-align: center; margin-bottom: 24px; }
    .header-icon {
      display: inline-grid;
      place-items: center;
      width: 64px; height: 64px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--tracky-light, #10E0A0) 18%, transparent);
      color: var(--tracky-light, #10E0A0);
      margin-bottom: 12px;
    }
    .header h1 { margin: 0 0 6px; font-size: 22px; color: var(--fg-primary); }
    .header p { margin: 0; color: var(--fg-secondary); font-size: 14px; }
    .form { display: flex; flex-direction: column; gap: 14px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field label {
      font-size: 12px; color: var(--fg-tertiary);
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .field input {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
      color: var(--fg-primary);
    }
    .field input:focus {
      outline: 2px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 60%, transparent);
      outline-offset: 1px;
      border-color: var(--tracky-light, #10E0A0);
    }
    .warn { font-size: 11px; color: var(--accent-warning, #f59e0b); }
    .alert {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 10px 12px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--accent-danger, #ef4444) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent-danger, #ef4444) 35%, transparent);
      color: var(--accent-danger, #ef4444);
      font-size: 13px;
      line-height: 1.4;
    }
    .alert lucide-icon { flex-shrink: 0; margin-top: 1px; }
    .btn-primary {
      margin-top: 8px;
      background: var(--tracky-light, #10E0A0);
      color: var(--bg-primary);
      border: none;
      padding: 12px 20px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn-primary[disabled] { opacity: 0.55; cursor: not-allowed; }
    .btn-primary:hover:not([disabled]) { filter: brightness(1.05); }
    .state {
      display: flex; flex-direction: column; align-items: center;
      text-align: center; gap: 12px;
    }
    .state--error lucide-icon { color: var(--accent-danger, #ef4444); }
    .state--success lucide-icon { color: var(--tracky-light, #10E0A0); }
    .state h1 { margin: 0; font-size: 22px; color: var(--fg-primary); }
    .state p { margin: 0; color: var(--fg-secondary); font-size: 14px; }
    .link { color: var(--tracky-light, #10E0A0); font-size: 14px; }
  `],
})
export class AcceptInviteComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly usersApi = inject(UsersApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly Check = Check;
  protected readonly KeyRound = KeyRound;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly UserCircle2 = UserCircle2;

  readonly token = signal<string>('');
  readonly errorMessage = signal<string>('');
  readonly submitError = signal<string>('');
  readonly success = signal(false);
  readonly loading = signal(false);

  displayName = '';
  password = '';
  passwordConfirm = '';

  passwordsMatch(): boolean {
    return this.password === this.passwordConfirm;
  }

  canSubmit(): boolean {
    return this.displayName.trim().length >= 2
      && this.password.length >= 8
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
        throw new Error(`Echec de la creation de session (HTTP ${meRes.status}${body ? ': ' + body.slice(0, 200) : ''})`);
      }
      const me = await meRes.json() as { id: string; email: string; role: string; fleetId: string | null };
      this.auth.setSession(
        result.accessToken,
        {
          sub: me.id,
          email: me.email,
          role: me.role as 'SUPER_ADMIN' | 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER',
          fleetId: me.fleetId ?? null,
          permissions: null,
        },
        result.refreshToken,
      );
      this.success.set(true);
      this.toast.success('Compte active. Bienvenue sur Tracky !');
      setTimeout(() => this.router.navigate(['/dashboard']), 800);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Echec de l\'activation';
      console.error('[accept-invite] submit failed:', err);
      // Compte deja active : redirection vers login
      if (message.includes('deja active')) {
        this.toast.info('Votre compte est deja active. Connectez-vous.');
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
