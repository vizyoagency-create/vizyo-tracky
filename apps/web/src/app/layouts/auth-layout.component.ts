import { Component, OnDestroy, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LogoComponent } from '../shared/ui/logo/logo.component';
import { AuthBackgroundComponent } from '../shared/ui/auth-background/auth-background.component';
import { AuthMapAnimationComponent } from '../shared/ui/auth-map-animation/auth-map-animation.component';

/**
 * Layout des pages auth (login, forgot password, accept invite).
 *
 * Mobile (< lg) : empilage vertical compact dans 100svh, avec globe
 * wireframe en hero et mini-carte 3D en footer.
 *
 * Desktop (>= lg) : refonte en split 50/50 -- formulaire a gauche
 * (panneau sobre, dot-grid subtil), carte 3D plein-cadre a droite avec
 * badge "Temps reel". Le globe wireframe est masque (la carte plein-cadre
 * fait deja le travail visuel).
 */
@Component({
  selector: 'app-auth-layout',
  standalone: true,
  imports: [RouterOutlet, LogoComponent, AuthBackgroundComponent, AuthMapAnimationComponent],
  styles: [
    `
      :host {
        display: block;
      }

      /* Tagline : blanc en dark pour contraster avec le fond sombre +
         globe vert, gris discret en light pour ne pas ecraser. */
      .auth-tagline {
        color: var(--color-fg-tertiary);
      }
      :host-context([data-theme='dark']) .auth-tagline {
        color: rgba(255, 255, 255, 0.92);
      }

      /* Dot-grid subtil sur le panneau formulaire desktop : evoque les
         coordonnees GPS sans bruiter le fond. */
      .form-pane__grid {
        position: absolute;
        inset: 0;
        opacity: 0.05;
        pointer-events: none;
        background-image: radial-gradient(currentColor 1px, transparent 1px);
        background-size: 22px 22px;
        color: #10e0a0;
      }

      /* Voile diagonal vers le bas-droite : ajoute une legere profondeur
         lumineuse a partir de la carte. */
      .form-pane__glow {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(
          ellipse 70% 50% at 100% 100%,
          rgba(16, 224, 160, 0.06) 0%,
          transparent 60%
        );
      }

      /* Footer du panneau form : version + tagline. Couleur tertiaire. */
      .form-pane__footer {
        color: var(--color-fg-tertiary);
        font-size: 12px;
        letter-spacing: 0.04em;
      }
      :host-context([data-theme='dark']) .form-pane__footer {
        color: rgba(255, 255, 255, 0.45);
      }

      /* Shell mobile : safe-area top/bottom pour PWA iOS standalone (status bar
         black-translucent qui se superpose). py-4 garde le padding vertical
         minimal precedent, additionne aux insets via max(). */
      .auth-mobile-shell {
        padding-top: max(1rem, env(safe-area-inset-top));
        padding-bottom: max(1rem, env(safe-area-inset-bottom));
        padding-left: env(safe-area-inset-left);
        padding-right: env(safe-area-inset-right);
      }
    `,
  ],
  template: `
    @if (isDesktop()) {
      <!-- ================== DESKTOP (>= lg) ================== -->
      <!-- Split layout : formulaire a gauche (largeur fixe), carte 3D
           plein-cadre a droite (le reste). Hauteur figee a 100svh,
           jamais de scroll. -->
      <div
        class="grid grid-cols-[minmax(440px,520px)_1fr]
               h-[100svh] bg-bg-primary overflow-hidden"
      >
        <!-- ===== Panneau formulaire (gauche) ===== -->
        <section class="relative flex flex-col px-12 xl:px-16 py-10 bg-bg-primary">
          <div class="form-pane__grid"></div>
          <div class="form-pane__glow"></div>

          <header class="relative z-10 flex items-center justify-between">
            <app-logo variant="lockup" [size]="120" />
          </header>

          <main class="relative z-10 flex-1 flex flex-col justify-center max-w-[440px] w-full">
            <div class="mb-8">
              <h1 class="text-[32px] xl:text-4xl font-display font-semibold
                         text-fg-primary tracking-tight leading-[1.05]">
                Bon retour.
              </h1>
              <p class="text-fg-tertiary mt-3 text-[15px]">
                Connectez-vous a votre tableau de bord Vizyo Tracky.
              </p>
            </div>
            <router-outlet />
          </main>

          <footer class="relative z-10 form-pane__footer flex items-center justify-between">
            <span>Suivi de flotte GPS · Temps reel</span>
            <span>&copy; {{ year }} Vizyo</span>
          </footer>
        </section>

        <!-- ===== Panneau carte plein-cadre (droite) ===== -->
        <section class="relative">
          <app-auth-map-animation [fullBleed]="true" />
        </section>
      </div>
    } @else {
      <!-- ================== MOBILE / TABLET PORTRAIT (< lg) ================== -->
      <!-- min-h-[100svh] (au lieu de h-[100svh]) : permet au contenu de s'etendre
           si la hauteur dispo est inferieure (iOS Safari/Chrome avec URL bar visible
           qui reduit le viewport effectif). overflow-y-auto au lieu de overflow-hidden :
           autorise un scroll fallback plutot que de clipper le logo en haut.
           padding-top: env(safe-area-inset-top) : respecte le notch / status bar
           en mode PWA iOS standalone (apple-mobile-web-app-status-bar-style: black-translucent). -->
      <div
        class="min-h-[100svh] flex flex-col items-center justify-center
               bg-bg-primary relative overflow-y-auto auth-mobile-shell"
      >
        <app-auth-background />

        <div class="relative z-10 w-full max-w-md px-5 flex flex-col items-stretch">
          <div class="flex flex-col items-center mb-5">
            <app-logo variant="lockup" [size]="96" />
            <p class="auth-tagline text-[13px] mt-2.5 tracking-wide">
              Suivi de flotte GPS · Temps reel
            </p>
          </div>
          <router-outlet />

          <div class="mt-5 px-2">
            <app-auth-map-animation />
          </div>
        </div>
      </div>
    }
  `,
})
export class AuthLayoutComponent implements OnDestroy {
  protected readonly year = new Date().getFullYear();

  /** Track desktop breakpoint via matchMedia : on conditionne le rendu
   *  via @if pour qu'un seul des deux layouts soit instancie a la fois
   *  (evite de creer deux maps MapLibre, dont une cachee). */
  private readonly mql =
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null;
  protected readonly isDesktop = signal(this.mql?.matches ?? false);
  private readonly onMqlChange = (e: MediaQueryListEvent): void => {
    this.isDesktop.set(e.matches);
  };

  constructor() {
    this.mql?.addEventListener('change', this.onMqlChange);
  }

  ngOnDestroy(): void {
    this.mql?.removeEventListener('change', this.onMqlChange);
  }
}
