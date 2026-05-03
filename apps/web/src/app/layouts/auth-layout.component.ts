import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LogoComponent } from '../shared/ui/logo/logo.component';
import { AuthBackgroundComponent } from '../shared/ui/auth-background/auth-background.component';
import { AuthMapAnimationComponent } from '../shared/ui/auth-map-animation/auth-map-animation.component';

@Component({
  selector: 'app-auth-layout',
  standalone: true,
  imports: [RouterOutlet, LogoComponent, AuthBackgroundComponent, AuthMapAnimationComponent],
  styles: [
    `
      /* Tagline : blanc en dark pour contraster avec le fond sombre +
         globe vert, gris discret en light pour ne pas ecraser. */
      .auth-tagline {
        color: var(--color-fg-tertiary);
      }
      :host-context([data-theme='dark']) .auth-tagline {
        color: rgba(255, 255, 255, 0.92);
      }
    `,
  ],
  template: `
    <!-- 100svh = small viewport height, prend en compte la barre d'URL
         repliee sur mobile et evite le saut au scroll. overflow-hidden
         pour qu'aucun ecran ne defile : tout doit tenir dans la fenetre. -->
    <div
      class="h-[100svh] flex flex-col items-center justify-center bg-bg-primary
             relative overflow-hidden py-4 sm:py-10"
    >
      <!-- Fond anime : globe wireframe + stations + arcs + dots -->
      <app-auth-background />

      <!-- Contenu : logo + form + mini-map, centres verticalement.
           Spacing compact sur mobile pour tenir dans 100svh. -->
      <div class="relative z-10 w-full max-w-md px-5 flex flex-col items-stretch">
        <div class="flex flex-col items-center mb-5 sm:mb-12">
          <app-logo class="sm:hidden" variant="lockup" [size]="80" />
          <app-logo class="hidden sm:block" variant="lockup" [size]="104" />
          <p class="auth-tagline text-[13px] sm:text-sm mt-2.5 sm:mt-3.5 tracking-wide">
            Suivi de flotte GPS · Temps reel
          </p>
        </div>
        <router-outlet />

        <!-- Animation 3D : un vehicule sillonne la France pour evoquer
             concretement le metier de Vizyo Tracky (suivi de flotte GPS) -->
        <div class="mt-5 sm:mt-10 px-2">
          <app-auth-map-animation />
        </div>
      </div>
    </div>
  `,
})
export class AuthLayoutComponent {}
