import { Component } from '@angular/core';

/**
 * Fond statique des pages auth en mode mobile/tablet portrait : un
 * wireframe de globe (paralleles + meridiens) avec un halo vert subtil
 * derriere et un pattern de dots discret. Tout est SVG inline + CSS,
 * aucune dependance, aucune animation -- volontairement calme pour ne
 * pas distraire de la card de connexion.
 *
 * Sur desktop (>= lg), ce composant n'est pas rendu (cf. auth-layout).
 */
@Component({
  selector: 'app-auth-background',
  standalone: true,
  template: `
    <div class="auth-bg" aria-hidden="true">
      <!-- 1. Pattern de dots subtils, plein ecran -->
      <div class="auth-bg__dots"></div>

      <!-- 2. Halo tracky -->
      <div class="auth-bg__halo"></div>

      <!-- 3. Globe wireframe statique (paralleles + meridiens) -->
      <svg
        class="auth-bg__globe"
        viewBox="-150 -150 300 300"
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
      >
        <defs>
          <radialGradient id="globe-fill">
            <stop offset="0%" stop-color="rgba(16, 185, 129, 0.08)" />
            <stop offset="80%" stop-color="rgba(16, 185, 129, 0.02)" />
            <stop offset="100%" stop-color="transparent" />
          </radialGradient>
        </defs>

        <!-- Disque de fond avec gradient subtil -->
        <circle cx="0" cy="0" r="120" fill="url(#globe-fill)" />

        <!-- Cercle principal du globe (bord) -->
        <circle
          cx="0"
          cy="0"
          r="120"
          fill="none"
          stroke="currentColor"
          stroke-width="0.8"
          stroke-opacity="0.45"
        />

        <!-- Paralleles : 5 ellipses horizontales pour evoquer les
             latitudes vues en perspective -->
        <g stroke="currentColor" fill="none" stroke-width="0.6">
          <ellipse cx="0" cy="0" rx="120" ry="20"  stroke-opacity="0.32" />
          <ellipse cx="0" cy="0" rx="120" ry="55"  stroke-opacity="0.28" />
          <ellipse cx="0" cy="0" rx="120" ry="85"  stroke-opacity="0.22" />
          <ellipse cx="0" cy="0" rx="120" ry="105" stroke-opacity="0.16" />
          <ellipse cx="0" cy="0" rx="120" ry="118" stroke-opacity="0.10" />
        </g>

        <!-- Meridiens : 5 ellipses verticales (effet sphere wireframe) -->
        <g stroke="currentColor" fill="none" stroke-width="0.6">
          <ellipse cx="0" cy="0" rx="120" ry="120" stroke-opacity="0.28" />
          <ellipse cx="0" cy="0" rx="100" ry="120" stroke-opacity="0.24" />
          <ellipse cx="0" cy="0" rx="70"  ry="120" stroke-opacity="0.22" />
          <ellipse cx="0" cy="0" rx="40"  ry="120" stroke-opacity="0.20" />
          <ellipse cx="0" cy="0" rx="15"  ry="120" stroke-opacity="0.18" />
        </g>
      </svg>
    </div>
  `,
  styles: [
    `
      :host {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }

      .auth-bg {
        position: absolute;
        inset: 0;
        color: #ffffff;
      }
      :host-context([data-theme='light']) .auth-bg {
        color: #0a0f0d;
      }

      /* === Layer 1 : pattern de dots ============================ */
      .auth-bg__dots {
        position: absolute;
        inset: 0;
        background-image: radial-gradient(
          circle,
          currentColor 0.7px,
          transparent 1.4px
        );
        background-size: 24px 24px;
        opacity: 0.07;
        -webkit-mask-image: radial-gradient(
          ellipse 90% 80% at center,
          black 25%,
          transparent 95%
        );
        mask-image: radial-gradient(
          ellipse 90% 80% at center,
          black 25%,
          transparent 95%
        );
      }
      :host-context([data-theme='light']) .auth-bg__dots {
        opacity: 0.06;
      }

      /* === Layer 2 : halo statique ============================== */
      .auth-bg__halo {
        position: absolute;
        top: 50%;
        left: 50%;
        width: min(130vmin, 1200px);
        height: min(130vmin, 1200px);
        margin-left: calc(min(130vmin, 1200px) / -2);
        margin-top: calc(min(130vmin, 1200px) / -2);
        background: radial-gradient(
          circle,
          rgba(16, 185, 129, 0.16),
          transparent 55%
        );
        filter: blur(60px);
      }
      :host-context([data-theme='light']) .auth-bg__halo {
        background: radial-gradient(
          circle,
          rgba(5, 150, 105, 0.14),
          transparent 55%
        );
      }

      /* === Layer 3 : globe SVG ================================== */
      .auth-bg__globe {
        position: absolute;
        top: 50%;
        left: 50%;
        width: min(140vmin, 1000px);
        height: min(140vmin, 1000px);
        margin-left: calc(min(140vmin, 1000px) / -2);
        margin-top: calc(min(140vmin, 1000px) / -2);
        opacity: 1;
      }
      :host-context([data-theme='light']) .auth-bg__globe {
        opacity: 0.55;
      }

      /* Mobile : opacite legerement reduite pour la lisibilite */
      @media (max-width: 640px) {
        .auth-bg__globe { opacity: 0.85; }
        .auth-bg__dots { opacity: 0.05; }
      }
    `,
  ],
})
export class AuthBackgroundComponent {}
