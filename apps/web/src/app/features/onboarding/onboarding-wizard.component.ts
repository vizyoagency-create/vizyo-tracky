import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Compass,
  LucideAngularModule,
  Moon,
  Sun,
  UserCircle2,
  X,
} from 'lucide-angular';
import { OnboardingService } from '../../core/services/onboarding.service';
import { UsersApiService } from '../../core/services/users.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ThemeService } from '../../core/theme/theme.service';
import { LogoComponent } from '../../shared/ui/logo/logo.component';

type Step = 1 | 2;

/**
 * Assistant de démarrage du premier login — DEUX étapes, pour tout le monde.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI CE FICHIER A MAIGRI (lot B0′)                                     │
 * │                                                                            │
 * │ Il déclarait `Step = 1|2|3|4|5` alors que le parcours réel dépendait du     │
 * │ rôle : un non-admin faisait 1 → 2 → 5, et la barre de progression bondissait│
 * │ de 40 % à 100 %. Deux systèmes coexistaient — un numéro d'étape figé et un  │
 * │ index calculé — et c'est le figé qui pilotait l'affichage.                  │
 * │                                                                            │
 * │ Le défaut se résout en SUPPRIMANT, pas en corrigeant (design/B0-SOCLE.md    │
 * │ § « Compteurs d'étapes codés en dur », décision client) :                   │
 * │                                                                            │
 * │  · « Premier véhicule » et « Premier collègue » disparaissent. Les deux     │
 * │    écrans existent ailleurs, mieux faits, sans se faire passer pour une     │
 * │    formalité d'inscription — et un compte neuf n'a de toute façon ni        │
 * │    boîtier à associer ni collègue à inviter dans la minute.                 │
 * │  · Le récapitulatif disparaît avec eux : « 0 véhicule ajouté, 0 invitation  │
 * │    envoyée » n'est pas un bilan, c'est un reproche.                         │
 * │                                                                            │
 * │ Reste ce qu'un premier login doit vraiment faire : dire ce qu'est le        │
 * │ produit, et demander comment s'appelle la personne. Deux étapes. Le         │
 * │ compteur n'a plus rien à calculer, donc plus rien à contredire.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Design : drawer plein écran mobile-first avec vague glacée en en-tête
 * (réutilise les keyframes `tracky-nav-wave-1/2` du dashboard-layout).
 *
 * Étapes :
 *   1. Bienvenue — présentation produit + bouton « Commencer »
 *   2. Profil    — prénom, nom, téléphone (E.164), puis le tableau de bord
 */
@Component({
  selector: 'app-onboarding-wizard',
  standalone: true,
  imports: [LucideAngularModule, FormsModule, LogoComponent],
  template: `
    @if (onboarding.shouldShow()) {
      <div class="wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div class="wizard-shell">
          <!-- Header avec wave glassy -->
          <header class="wizard-header">
            <span class="header-wave header-wave--1" aria-hidden="true"></span>
            <span class="header-wave header-wave--2" aria-hidden="true"></span>
            <div class="header-content">
              <div class="header-brand">
                <app-logo variant="icon" [size]="26" />
                <div class="header-title-block">
                  <h1 id="onboarding-title" class="header-title">Bienvenue sur Tracky</h1>
                  <p class="header-step">Étape {{ stepIndex() }} sur {{ totalSteps }}</p>
                </div>
              </div>
              <div class="header-actions">
                <button type="button" (click)="theme.toggle()" class="header-close" aria-label="Changer de thème">
                  <lucide-icon [img]="theme.theme() === 'dark' ? MoonIcon : SunIcon" [size]="16"></lucide-icon>
                </button>
                <button (click)="dismiss()" class="header-close" aria-label="Fermer le wizard">
                  <lucide-icon [img]="X" [size]="17"></lucide-icon>
                </button>
              </div>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" [style.width.%]="(stepIndex() / totalSteps) * 100"></div>
            </div>
          </header>

          <!-- Body — etape active -->
          <main class="wizard-body">
            @switch (step()) {
              @case (1) {
                <div class="step-icon"><lucide-icon [img]="Compass" [size]="56"></lucide-icon></div>
                <h2 class="step-title">Prêt à piloter votre flotte ?</h2>
                <!-- La phrase annonçait « une seule question » devant un écran qui en pose
                     trois. Un assistant qui commence par sous-estimer ce qu'il demande
                     n'inspire pas confiance sur le reste. Elle dit maintenant ce qu'il en
                     est vraiment : un écran, facultatif, et c'est fini. -->
                <p class="step-lead">
                  Vizyo Tracky vous donne une vue en temps réel sur tous vos véhicules.
                  Un écran de profil — facultatif — et le tableau de bord s'ouvre.
                </p>
                <ul class="step-bullets">
                  <li><span class="bullet-chip"><lucide-icon [img]="Check" [size]="14"></lucide-icon></span> Suivi GPS en direct</li>
                  <li><span class="bullet-chip"><lucide-icon [img]="Check" [size]="14"></lucide-icon></span> Coupure moteur sécurisée à distance</li>
                  <li><span class="bullet-chip"><lucide-icon [img]="Check" [size]="14"></lucide-icon></span> Alertes et rapports automatisés</li>
                </ul>
              }
              @case (2) {
                <div class="step-icon"><lucide-icon [img]="UserCircle2" [size]="48"></lucide-icon></div>
                <h2 class="step-title">Votre profil</h2>
                <p class="step-lead">Quelques informations pour personnaliser votre expérience.</p>
                <div class="form-grid">
                  <div class="field">
                    <label>Prénom</label>
                    <input [(ngModel)]="firstName" placeholder="Votre prénom" autocomplete="given-name" />
                  </div>
                  <div class="field">
                    <label>Nom</label>
                    <input [(ngModel)]="lastName" placeholder="Votre nom" autocomplete="family-name" />
                  </div>
                  <div class="field field--full">
                    <label>Téléphone (optionnel)</label>
                    <input [(ngModel)]="phone" placeholder="+33612345678" type="tel" autocomplete="tel" />
                    <small>Format international (E.164). Utilisé pour les notifications WhatsApp.</small>
                  </div>
                </div>
                <p class="hint">
                  Vous pouvez modifier ces informations à tout moment depuis « Mon compte ».
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
            @if (step() === 1) {
              <button (click)="next()" class="btn btn-primary" [disabled]="loading()">
                Commencer
                <lucide-icon [img]="ArrowRight" [size]="14"></lucide-icon>
              </button>
            } @else {
              <!-- « Passer » reste : le profil est facultatif, et l'assistant ne doit
                   enfermer personne. Il n'y a plus d'étape suivante à atteindre, donc
                   il termine — c'est la même sortie, dite honnêtement. -->
              <button (click)="finish()" class="btn btn-ghost" [disabled]="loading()">Passer</button>
              <button (click)="continueStep()" class="btn btn-primary" [disabled]="loading()">
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
      max-height: 100vh; max-height: 100dvh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--border-subtle);
    }
    @media (min-width: 768px) {
      .wizard-overlay { padding: 24px; }
      .wizard-shell { height: auto; max-height: 90vh; max-height: 90dvh; border-radius: var(--radius-card, 16px); }
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
    /* --fg-tertiary est un jeton a 3:1 : 3,16 en clair et 3,75 en sombre sur du
       texte de 12 px, sous le seuil des DEUX cotes. Cf. point ouvert O5 de
       design/TOKENS.md — traite localement, comme sur les autres pages reprises. */
    .header-step { margin: 4px 0 0; font-size: 12px; color: var(--fg-secondary); font-variant-numeric: tabular-nums; }
    /* 44 px : ces deux boutons mesuraient 36 x 36. C'est le premier ecran qu'un
       compte neuf voit, et il est vu au telephone. */
    .header-close {
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      width: 44px; height: 44px;
      border-radius: 10px;
      display: grid; place-items: center;
      cursor: pointer;
    }
    .header-close:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .header-brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
    .header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
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
    /* La coche mesurait 2,99 en clair sur son propre lavis — le lavis eclaircit le
       fond vers le vert et mange le peu de contraste qui restait. --texte-succes
       est la valeur assombrie prevue pour ca. */
    .step-bullets lucide-icon { color: var(--texte-succes); }
    .bullet-chip { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 8px; background: color-mix(in srgb, var(--tracky-light) 12%, transparent); color: var(--texte-succes); flex-shrink: 0; }
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
      color: var(--fg-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .field input, .field select {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      min-height: 44px;
      padding: 10px 12px;
      font-size: 14px;
      color: var(--fg-primary);
    }
    .field input:focus, .field select:focus {
      outline: 2px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 60%, transparent);
      outline-offset: 1px;
      border-color: var(--tracky-light, #10E0A0);
    }
    .field small { font-size: 11px; color: var(--fg-secondary); }
    .hint { font-size: 12px; color: var(--fg-secondary); margin: 4px 0 0; }
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
    /* 44 px : le remplissage donnait 43. Un pixel manquant reste un echec. */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      min-height: 44px;
      padding: 10px 16px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 120ms ease, opacity 120ms ease;
    }
    .btn[disabled] { opacity: 0.6; cursor: not-allowed }
    /* Encre FONCEE sur l'accent — regle non negociable de B0-SOCLE. Ici la couleur
       etait --bg-primary, qui vaut #080B0A en sombre (juste) mais #FBFCFB en clair :
       du quasi-blanc sur du vert menthe, mesure a 3,34:1. Le jeton --accent-ink
       existe precisement pour ne pas dependre du theme. */
    .btn-primary {
      background: var(--tracky-light);
      color: var(--accent-ink);
      font-weight: 600;
    }
    .btn-primary:hover:not([disabled]) { filter: brightness(1.05); }
    .btn-ghost {
      background: transparent;
      border-color: var(--border-subtle);
      color: var(--fg-secondary);
    }
    .btn-ghost:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    /* A 375 px, les trois boutons du pied ne tiennent pas sur une ligne : l'action
       PRINCIPALE se faisait ecraser a 133 px et repliait son libelle sur deux
       lignes, coincee entre deux boutons secondaires qui, eux, tenaient. Sous
       480 px elle prend donc toute la largeur, en premier, et les deux sorties se
       partagent la ligne du dessous. */
    @media (max-width: 480px) {
      .wizard-footer { flex-wrap: wrap; row-gap: 10px; }
      .footer-spacer { display: none; }
      .btn-primary { order: -1; width: 100%; }
      .wizard-footer .btn-ghost { flex: 1 1 0; min-width: 0; }
    }
  `],
})
export class OnboardingWizardComponent {
  protected readonly onboarding = inject(OnboardingService);
  protected readonly theme = inject(ThemeService);
  private readonly usersApi = inject(UsersApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly ArrowRight = ArrowRight;
  protected readonly Check = Check;
  protected readonly Compass = Compass;
  protected readonly UserCircle2 = UserCircle2;
  protected readonly X = X;
  protected readonly MoonIcon = Moon;
  protected readonly SunIcon = Sun;

  readonly step = signal<Step>(1);
  readonly loading = signal(false);

  // Step 2 — profil (pré-rempli depuis le profil chargé par OnboardingService)
  firstName = '';
  lastName = '';
  phone = '';

  // Pré-remplir les champs quand le profil est chargé (async)
  private prefillEffect = effect(() => {
    const p = this.onboarding.profile();
    if (p) {
      if (p.firstName && !this.firstName) this.firstName = p.firstName;
      if (p.lastName && !this.lastName) this.lastName = p.lastName;
      if (p.phone && !this.phone) this.phone = p.phone;
    }
  });

  /**
   * Deux étapes, pour tout le monde. Ce n'est plus un calcul : c'est le nombre
   * d'écrans que l'assistant contient.
   *
   * L'ancienne version dérivait ce total du rôle ET du profil déjà rempli, sans que
   * `step()` — le numéro qui pilotait réellement l'affichage — en tienne compte. Un
   * compteur qui se calcule pendant qu'un autre décide finit toujours par mentir ;
   * ici, il n'y a plus de second système à contredire.
   */
  readonly totalSteps = 2;

  /**
   * L'index affiché EST le numéro d'étape. Ils étaient deux, ils n'en font plus qu'un.
   * La barre de progression avance donc de 50 % puis de 50 % — jamais de 40 % à 100 %.
   */
  readonly stepIndex = computed(() => this.step());

  back(): void {
    if (this.step() > 1) this.step.update((v) => (v - 1) as Step);
  }

  next(): void {
    if (this.step() < 2) this.step.update((v) => (v + 1) as Step);
  }

  /** Étape 2 : on enregistre le profil, puis on ouvre le tableau de bord. */
  async continueStep(): Promise<void> {
    this.loading.set(true);
    try {
      await this.saveProfile();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Erreur lors de l\'enregistrement';
      this.toast.error(message);
      this.loading.set(false);
      return;
    }
    // `finish()` reprend la main sur `loading` — et surtout, il n'est PAS appelé si
    // l'enregistrement a échoué : sortir de l'assistant sur une erreur perdrait la
    // saisie sans le dire.
    await this.finish();
  }

  private async saveProfile(): Promise<void> {
    const data: { firstName?: string; lastName?: string; phone?: string | null } = {};
    if (this.firstName.trim()) data.firstName = this.firstName.trim();
    if (this.lastName.trim()) data.lastName = this.lastName.trim();
    if (this.phone.trim()) data.phone = this.phone.trim();
    if (Object.keys(data).length === 0) return;
    await this.usersApi.updateMe(data);
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
