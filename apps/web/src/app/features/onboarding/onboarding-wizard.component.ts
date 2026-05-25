import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Compass,
  LucideAngularModule,
  Mail,
  PartyPopper,
  Truck,
  UserCircle2,
  X,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { OnboardingService } from '../../core/services/onboarding.service';
import { UsersApiService } from '../../core/services/users.service';
import { VehiclesApiService } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

type Step = 1 | 2 | 3 | 4 | 5;

/**
 * V1.5 (Sprint J) — Wizard d'onboarding 5 etapes pour le premier login.
 *
 * Design : drawer plein ecran mobile-first avec wave glassy en header
 * (reutilise les keyframes `tracky-nav-wave-1/2` du dashboard-layout).
 * Toutes les etapes sont skippables sauf la derniere (Termine).
 *
 * Etapes :
 *   1. Bienvenue          — presentation produit + bouton "Commencer"
 *   2. Profil             — firstName, lastName, phone (E.164)
 *   3. Premier vehicule   — plate, type, marque/modele (optionnel)
 *   4. Premier collegue   — email + role (envoie une invitation, optionnel)
 *   5. Termine            — CTA "Aller au tableau de bord"
 */
@Component({
  selector: 'app-onboarding-wizard',
  standalone: true,
  imports: [LucideAngularModule, FormsModule],
  template: `
    @if (onboarding.shouldShow()) {
      <div class="wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div class="wizard-shell">
          <!-- Header avec wave glassy -->
          <header class="wizard-header">
            <span class="header-wave header-wave--1" aria-hidden="true"></span>
            <span class="header-wave header-wave--2" aria-hidden="true"></span>
            <div class="header-content">
              <div class="header-title-block">
                <h1 id="onboarding-title" class="header-title">Bienvenue sur Vizyo Tracky</h1>
                <p class="header-step">Etape {{ stepIndex() }} sur {{ totalSteps() }}</p>
              </div>
              <button (click)="dismiss()" class="header-close" aria-label="Fermer le wizard">
                <lucide-icon [img]="X" [size]="18"></lucide-icon>
              </button>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" [style.width.%]="(stepIndex() / totalSteps()) * 100"></div>
            </div>
          </header>

          <!-- Body — etape active -->
          <main class="wizard-body">
            @switch (step()) {
              @case (1) {
                <div class="step-icon"><lucide-icon [img]="Compass" [size]="56"></lucide-icon></div>
                <h2 class="step-title">Pret a piloter votre flotte ?</h2>
                <p class="step-lead">
                  Vizyo Tracky vous donne une vue temps reel sur tous vos vehicules.
                  Configurons ensemble votre compte en quelques minutes.
                </p>
                <ul class="step-bullets">
                  <li><lucide-icon [img]="Check" [size]="14"></lucide-icon> Suivi GPS en direct</li>
                  <li><lucide-icon [img]="Check" [size]="14"></lucide-icon> Coupure moteur securisee a distance</li>
                  <li><lucide-icon [img]="Check" [size]="14"></lucide-icon> Alertes et rapports automatises</li>
                </ul>
              }
              @case (2) {
                <div class="step-icon"><lucide-icon [img]="UserCircle2" [size]="48"></lucide-icon></div>
                <h2 class="step-title">Votre profil</h2>
                <p class="step-lead">Quelques infos pour personnaliser votre experience.</p>
                <div class="form-grid">
                  <div class="field">
                    <label>Prenom</label>
                    <input [(ngModel)]="firstName" placeholder="Jean" autocomplete="given-name" />
                  </div>
                  <div class="field">
                    <label>Nom</label>
                    <input [(ngModel)]="lastName" placeholder="Dupont" autocomplete="family-name" />
                  </div>
                  <div class="field field--full">
                    <label>Telephone (optionnel)</label>
                    <input [(ngModel)]="phone" placeholder="+33612345678" type="tel" autocomplete="tel" />
                    <small>Format international (E.164). Utilise pour les notifications WhatsApp.</small>
                  </div>
                </div>
              }
              @case (3) {
                <div class="step-icon"><lucide-icon [img]="Truck" [size]="48"></lucide-icon></div>
                <h2 class="step-title">Votre premier vehicule</h2>
                <p class="step-lead">Vous pouvez l'ajouter maintenant ou plus tard depuis "Vehicules".</p>
                <div class="form-grid">
                  <div class="field">
                    <label>Plaque</label>
                    <input [(ngModel)]="plate" placeholder="AB-123-CD" />
                  </div>
                  <div class="field">
                    <label>Type</label>
                    <select [(ngModel)]="vehicleType">
                      <option value="CAR">Voiture</option>
                      <option value="TRUCK">Camion</option>
                      <option value="VAN">Utilitaire</option>
                      <option value="MOTORCYCLE">Moto</option>
                      <option value="BUS">Bus</option>
                      <option value="OTHER">Autre</option>
                    </select>
                  </div>
                  <div class="field">
                    <label>Marque (optionnel)</label>
                    <input [(ngModel)]="brand" placeholder="Renault" />
                  </div>
                  <div class="field">
                    <label>Modele (optionnel)</label>
                    <input [(ngModel)]="model" placeholder="Trafic" />
                  </div>
                </div>
                <p class="hint">Le tracker pourra etre associe ulterieurement depuis la fiche vehicule.</p>
              }
              @case (4) {
                <div class="step-icon"><lucide-icon [img]="Mail" [size]="48"></lucide-icon></div>
                <h2 class="step-title">Inviter un collegue</h2>
                <p class="step-lead">Optionnel — un email d'invitation sera envoye automatiquement.</p>
                <div class="form-grid">
                  <div class="field field--full">
                    <label>Email</label>
                    <input [(ngModel)]="inviteEmail" placeholder="collegue@example.com" type="email" autocomplete="email" />
                  </div>
                  <div class="field field--full">
                    <label>Role</label>
                    <select [(ngModel)]="inviteRole">
                      <option value="FLEET_MANAGER">Gestionnaire (gere les vehicules / commandes)</option>
                      <option value="VIEWER">Lecteur (consultation seule)</option>
                    </select>
                  </div>
                </div>
              }
              @case (5) {
                <div class="step-icon"><lucide-icon [img]="PartyPopper" [size]="56"></lucide-icon></div>
                <h2 class="step-title">Tout est pret !</h2>
                <p class="step-lead">
                  Votre compte est configure. Le tableau de bord va s'ouvrir avec vos vehicules,
                  vos alertes et la carte en temps reel.
                </p>
                <p class="hint">
                  Vous pouvez modifier vos preferences a tout moment depuis "Mon compte".
                </p>
              }
            }
          </main>

          <!-- Footer actions -->
          <footer class="wizard-footer">
            @if (step() > 1) {
              <button (click)="back()" class="btn btn-ghost">
                <lucide-icon [img]="ArrowLeft" [size]="14"></lucide-icon> Retour
              </button>
            }
            <span class="footer-spacer"></span>
            @if (step() < 5) {
              @if (step() > 1) {
                <button (click)="next()" class="btn btn-ghost">Passer</button>
              }
              <button (click)="continueStep()" class="btn btn-primary" [disabled]="loading()">
                {{ continueLabel() }}
                <lucide-icon [img]="ArrowRight" [size]="14"></lucide-icon>
              </button>
            } @else {
              <button (click)="finish()" class="btn btn-primary" [disabled]="loading()">
                Aller au tableau de bord
                <lucide-icon [img]="ArrowRight" [size]="14"></lucide-icon>
              </button>
            }
          </footer>
        </div>
      </div>
    }
  `,
  styles: [`
    .wizard-overlay {
      position: fixed; inset: 0;
      background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
      backdrop-filter: blur(8px) saturate(1.2);
      -webkit-backdrop-filter: blur(8px) saturate(1.2);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .wizard-shell {
      background: var(--bg-secondary);
      width: 100%;
      max-width: 640px;
      max-height: 100dvh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--border-subtle);
    }
    @media (min-width: 768px) {
      .wizard-overlay { padding: 24px; }
      .wizard-shell { height: auto; max-height: 90dvh; border-radius: var(--radius-card, 16px); }
    }
    .wizard-header {
      position: relative;
      padding: 20px 20px 12px;
      overflow: hidden;
      border-bottom: 1px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 14%, var(--border-subtle));
    }
    .header-wave {
      position: absolute;
      top: 0; bottom: 0;
      width: 250%;
      pointer-events: none;
      z-index: 0;
    }
    .header-wave--1 {
      left: -75%;
      background:
        radial-gradient(ellipse 30% 140% at 20% 50%, rgba(16,224,160,.30), transparent 70%),
        radial-gradient(ellipse 25% 120% at 55% 40%, rgba(94,234,212,.20), transparent 60%),
        radial-gradient(ellipse 20% 100% at 80% 55%, rgba(167,243,208,.14), transparent 55%);
      animation: wiz-wave-1 8s ease-in-out infinite alternate;
    }
    .header-wave--2 {
      right: -75%;
      background:
        radial-gradient(ellipse 28% 130% at 35% 55%, rgba(52,211,153,.22), transparent 65%),
        radial-gradient(ellipse 22% 110% at 65% 45%, rgba(103,232,249,.16), transparent 55%),
        radial-gradient(ellipse 30% 120% at 85% 50%, rgba(16,224,160,.28), transparent 60%);
      animation: wiz-wave-2 11s ease-in-out infinite alternate;
    }
    @keyframes wiz-wave-1 {
      0% { transform: translateX(0); opacity: .55 }
      50% { transform: translateX(18%); opacity: .7 }
      100% { transform: translateX(35%); opacity: .65 }
    }
    @keyframes wiz-wave-2 {
      0% { transform: translateX(0); opacity: .5 }
      50% { transform: translateX(-12%); opacity: .65 }
      100% { transform: translateX(-30%); opacity: .6 }
    }
    @media (prefers-reduced-motion: reduce) {
      .header-wave { animation: none; opacity: .5 }
    }
    .header-content {
      position: relative; z-index: 1;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }
    .header-title { margin: 0; font-size: 18px; font-weight: 700; color: var(--fg-primary); }
    .header-step { margin: 4px 0 0; font-size: 12px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; }
    .header-close {
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      width: 36px; height: 36px;
      border-radius: 10px;
      display: grid; place-items: center;
      cursor: pointer;
    }
    .header-close:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .progress-bar {
      position: relative; z-index: 1;
      margin-top: 14px;
      height: 4px;
      background: color-mix(in srgb, var(--bg-tertiary) 70%, transparent);
      border-radius: 2px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--tracky-light, #10E0A0);
      transition: width 220ms ease;
    }
    .wizard-body {
      flex: 1; min-height: 0;
      padding: 28px 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    @media (min-width: 768px) {
      .wizard-body { padding: 32px 32px; }
    }
    .step-icon {
      color: var(--tracky-light, #10E0A0);
      align-self: flex-start;
    }
    .step-title { margin: 0; font-size: 22px; font-weight: 700; color: var(--fg-primary); }
    .step-lead { margin: 0; color: var(--fg-secondary); line-height: 1.5; }
    .step-bullets {
      list-style: none; padding: 0; margin: 8px 0 0;
      display: flex; flex-direction: column; gap: 8px;
      color: var(--fg-secondary);
    }
    .step-bullets li {
      display: flex; align-items: center; gap: 8px;
      font-size: 14px;
    }
    .step-bullets lucide-icon { color: var(--tracky-light, #10E0A0); }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 8px;
    }
    @media (max-width: 640px) {
      .form-grid { grid-template-columns: 1fr }
    }
    .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .field--full { grid-column: 1 / -1 }
    .field label {
      font-size: 12px;
      color: var(--fg-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .field input, .field select {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
      color: var(--fg-primary);
    }
    .field input:focus, .field select:focus {
      outline: 2px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 60%, transparent);
      outline-offset: 1px;
      border-color: var(--tracky-light, #10E0A0);
    }
    .field small { font-size: 11px; color: var(--fg-tertiary); }
    .hint { font-size: 12px; color: var(--fg-tertiary); margin: 4px 0 0; }
    .wizard-footer {
      flex-shrink: 0;
      padding: 16px 20px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      gap: 8px;
      background: color-mix(in srgb, var(--bg-secondary) 85%, transparent);
    }
    @media (min-width: 768px) {
      .wizard-footer { padding: 16px 32px; }
    }
    .footer-spacer { flex: 1 }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 10px 16px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 120ms ease, opacity 120ms ease;
    }
    .btn[disabled] { opacity: 0.6; cursor: not-allowed }
    .btn-primary {
      background: var(--tracky-light, #10E0A0);
      color: var(--bg-primary);
      font-weight: 600;
    }
    .btn-primary:hover:not([disabled]) { filter: brightness(1.05); }
    .btn-ghost {
      background: transparent;
      border-color: var(--border-subtle);
      color: var(--fg-secondary);
    }
    .btn-ghost:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
  `],
})
export class OnboardingWizardComponent {
  protected readonly onboarding = inject(OnboardingService);
  private readonly auth = inject(AuthService);
  private readonly usersApi = inject(UsersApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly ArrowRight = ArrowRight;
  protected readonly Check = Check;
  protected readonly Compass = Compass;
  protected readonly Mail = Mail;
  protected readonly PartyPopper = PartyPopper;
  protected readonly Truck = Truck;
  protected readonly UserCircle2 = UserCircle2;
  protected readonly X = X;

  readonly step = signal<Step>(1);
  readonly loading = signal(false);

  // Step 2 — profil (pré-rempli depuis le profil chargé par OnboardingService)
  firstName = this.onboarding.profile()?.firstName ?? '';
  lastName = this.onboarding.profile()?.lastName ?? '';
  phone = this.onboarding.profile()?.phone ?? '';

  // Step 3 — vehicule
  plate = '';
  vehicleType: 'CAR' | 'TRUCK' | 'VAN' | 'MOTORCYCLE' | 'BUS' | 'OTHER' = 'CAR';
  brand = '';
  model = '';

  // Step 4 — invitation
  inviteEmail = '';
  inviteRole: 'FLEET_MANAGER' | 'VIEWER' = 'FLEET_MANAGER';

  /** Steps 3 et 4 uniquement pour FLEET_ADMIN (le reste voit 1→2→5). */
  protected isAdmin(): boolean {
    const role = this.auth.user()?.role;
    return role === 'FLEET_ADMIN' || role === 'SUPER_ADMIN';
  }

  /** Total de steps visibles pour cet user. */
  readonly totalSteps = computed(() => this.isAdmin() ? 5 : 3);

  /** Index courant par rapport aux steps visibles. */
  readonly stepIndex = computed(() => {
    const s = this.step();
    if (this.isAdmin()) return s;
    // Non-admin : steps visibles sont 1, 2, 5
    if (s <= 2) return s;
    return 3; // step 5 = index 3
  });

  readonly continueLabel = computed(() => {
    switch (this.step()) {
      case 1: return 'Commencer';
      case 2: return 'Continuer';
      case 3: return 'Continuer';
      case 4: return 'Continuer';
      default: return 'Continuer';
    }
  });

  back(): void {
    const s = this.step();
    if (s === 5 && !this.isAdmin()) {
      this.step.set(2);
    } else if (s > 1) {
      this.step.update((v) => (v - 1) as Step);
    }
  }

  next(): void {
    const s = this.step();
    if (!this.isAdmin() && s === 2) {
      // Non-admin : skip steps 3 et 4, aller direct à 5
      this.step.set(5);
    } else if (s < 5) {
      this.step.update((v) => (v + 1) as Step);
    }
  }

  async continueStep(): Promise<void> {
    this.loading.set(true);
    try {
      switch (this.step()) {
        case 2: await this.saveProfile(); break;
        case 3: await this.saveVehicle(); break;
        case 4: await this.sendInvitation(); break;
      }
      this.next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erreur lors de l\'enregistrement';
      this.toast.error(message);
    } finally {
      this.loading.set(false);
    }
  }

  private async saveProfile(): Promise<void> {
    const data: { firstName?: string; lastName?: string; phone?: string | null } = {};
    if (this.firstName.trim()) data.firstName = this.firstName.trim();
    if (this.lastName.trim()) data.lastName = this.lastName.trim();
    if (this.phone.trim()) data.phone = this.phone.trim();
    if (Object.keys(data).length === 0) return;
    await this.usersApi.updateMe(data);
  }

  private async saveVehicle(): Promise<void> {
    if (!this.plate.trim()) return;
    await firstValueFrom(
      this.vehiclesApi.create({
        plate: this.plate.trim().toUpperCase(),
        type: this.vehicleType,
        brand: this.brand.trim() || undefined,
        model: this.model.trim() || undefined,
      }),
    );
    this.toast.success('Vehicule cree');
  }

  private async sendInvitation(): Promise<void> {
    if (!this.inviteEmail.trim()) return;
    await this.usersApi.invite({
      email: this.inviteEmail.trim().toLowerCase(),
      role: this.inviteRole,
    });
    this.toast.success(`Invitation envoyee a ${this.inviteEmail}`);
  }

  async finish(): Promise<void> {
    this.loading.set(true);
    try {
      await this.onboarding.markComplete();
      this.router.navigate(['/dashboard']);
    } finally {
      this.loading.set(false);
    }
  }

  dismiss(): void {
    this.onboarding.close();
  }
}
