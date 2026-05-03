import { Component } from '@angular/core';

/**
 * Fond anime des pages auth (login, forgot password, accept invite).
 *
 * Concept : evoquer le tracking GPS mondial via un globe wireframe statique
 * (effet sphere donne par les ellipses concentriques de rx differents) avec
 * un arc-radar qui balaie continuellement, des stations pulsantes
 * connectees par des arcs de donnees, et un pattern de dots subtil en
 * arriere-plan. Tout est SVG inline + CSS -- aucune dependance, ~zero
 * impact bundle, theme-adaptive (light/dark).
 *
 * Le globe est suffisamment grand (140vmin) pour deborder largement de la
 * card de login et rester visible sur les cotes / au-dessus / en-dessous.
 */
@Component({
  selector: 'app-auth-background',
  standalone: true,
  template: `
    <div class="auth-bg" aria-hidden="true">
      <!-- 1. Pattern de dots subtils, plein ecran -->
      <div class="auth-bg__dots"></div>

      <!-- 2. Halo tracky qui respire -->
      <div class="auth-bg__halo"></div>

      <!-- 3+4+5. Globe + stations + arcs -->
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
          <radialGradient id="station-glow">
            <stop offset="0%" stop-color="rgba(16, 224, 160, 0.7)" />
            <stop offset="100%" stop-color="transparent" />
          </radialGradient>
          <!-- Gradient pour l'arc-radar (effet trail qui balaie) -->
          <linearGradient id="radar-sweep" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="transparent" />
            <stop offset="50%" stop-color="rgba(16, 224, 160, 0.0)" />
            <stop offset="95%" stop-color="rgba(16, 224, 160, 0.85)" />
            <stop offset="100%" stop-color="rgba(16, 224, 160, 1)" />
          </linearGradient>
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
          class="globe__outline"
        />

        <!-- Paralleles : 7 ellipses horizontales de ry decroissant pour
             evoquer les latitudes vues en perspective -->
        <g class="globe__parallels" stroke="currentColor" fill="none" stroke-width="0.6">
          <ellipse cx="0" cy="0" rx="120" ry="20"  stroke-opacity="0.32" />
          <ellipse cx="0" cy="0" rx="120" ry="55"  stroke-opacity="0.28" />
          <ellipse cx="0" cy="0" rx="120" ry="85"  stroke-opacity="0.22" />
          <ellipse cx="0" cy="0" rx="120" ry="105" stroke-opacity="0.16" />
          <ellipse cx="0" cy="0" rx="120" ry="118" stroke-opacity="0.10" />
        </g>

        <!-- Meridiens : 6 ellipses verticales de rx differents (wireframe
             sphere). Statiques pour garantir le rendu cross-browser ;
             l'animation est gerree par l'arc-radar qui balaie au-dessus. -->
        <g class="globe__meridians" stroke="currentColor" fill="none" stroke-width="0.6">
          <ellipse cx="0" cy="0" rx="120" ry="120" stroke-opacity="0.28" />
          <ellipse cx="0" cy="0" rx="100" ry="120" stroke-opacity="0.24" />
          <ellipse cx="0" cy="0" rx="70"  ry="120" stroke-opacity="0.22" />
          <ellipse cx="0" cy="0" rx="40"  ry="120" stroke-opacity="0.20" />
          <ellipse cx="0" cy="0" rx="15"  ry="120" stroke-opacity="0.18" />
        </g>

        <!-- Arc-radar : un demi-cercle qui tourne autour du globe pour
             donner la sensation de "scan" continu, comme un radar. -->
        <g class="globe__radar">
          <path
            d="M 0 -120 A 120 120 0 0 1 0 120"
            fill="none"
            stroke="url(#radar-sweep)"
            stroke-width="2"
            stroke-linecap="round"
          />
        </g>

        <!-- Arcs de connexion entre stations (effet "data flow") -->
        <g class="globe__arcs" fill="none" stroke="#10E0A0" stroke-width="0.9" stroke-linecap="round">
          <path class="arc a1" d="M -85 -30 Q -20 -90 70 -55" />
          <path class="arc a2" d="M 70 -55 Q 90 30 -10 80" />
          <path class="arc a3" d="M -10 80 Q -90 50 -85 -30" />
        </g>

        <!-- Stations : dots tracky qui pulsent (positions evoquant des
             villes connectees a travers le monde) -->
        <g class="globe__stations">
          <g class="station s1" transform="translate(-85, -30)">
            <circle r="9" fill="url(#station-glow)" class="station__halo" />
            <circle r="2.6" fill="#10E0A0" class="station__dot" />
          </g>
          <g class="station s2" transform="translate(70, -55)">
            <circle r="9" fill="url(#station-glow)" class="station__halo" />
            <circle r="2.6" fill="#10E0A0" class="station__dot" />
          </g>
          <g class="station s3" transform="translate(-10, 80)">
            <circle r="9" fill="url(#station-glow)" class="station__halo" />
            <circle r="2.6" fill="#10E0A0" class="station__dot" />
          </g>
          <g class="station s4" transform="translate(45, 40)">
            <circle r="9" fill="url(#station-glow)" class="station__halo" />
            <circle r="2.6" fill="#10E0A0" class="station__dot" />
          </g>
          <g class="station s5" transform="translate(-50, 50)">
            <circle r="9" fill="url(#station-glow)" class="station__halo" />
            <circle r="2.6" fill="#10E0A0" class="station__dot" />
          </g>
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
        color: #ffffff; /* dark mode default */
      }
      :host-context([data-theme='light']) .auth-bg {
        color: #0a0f0d;
      }

      /* === Layer 1 : pattern de dots ============================ */
      .auth-bg__dots {
        position: absolute;
        inset: -10%;
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
        animation: dots-drift 80s linear infinite;
      }
      :host-context([data-theme='light']) .auth-bg__dots {
        opacity: 0.07;
      }

      /* === Layer 2 : halo qui respire =========================== */
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
          rgba(16, 185, 129, 0.18),
          transparent 55%
        );
        filter: blur(60px);
        animation: halo-breathe 7s ease-in-out infinite;
      }
      :host-context([data-theme='light']) .auth-bg__halo {
        background: radial-gradient(
          circle,
          rgba(5, 150, 105, 0.14),
          transparent 55%
        );
      }

      /* === Layer 3+4+5 : globe SVG ============================== */
      .auth-bg__globe {
        position: absolute;
        top: 50%;
        left: 50%;
        /* Largement plus grand que la card de login pour deborder
           sur les cotes / haut / bas et rester visible */
        width: min(140vmin, 1000px);
        height: min(140vmin, 1000px);
        margin-left: calc(min(140vmin, 1000px) / -2);
        margin-top: calc(min(140vmin, 1000px) / -2);
        opacity: 1;
      }
      :host-context([data-theme='light']) .auth-bg__globe {
        opacity: 0.7;
      }

      /* Radar : rotation continue autour du globe */
      .globe__radar {
        transform-origin: center;
        animation: radar-spin 14s linear infinite;
      }

      /* Stations : pulsation du halo et du dot central */
      .station__halo {
        transform-origin: center;
        animation: station-pulse 3.4s ease-in-out infinite;
      }
      .station__dot {
        animation: station-glow 3.4s ease-in-out infinite;
      }
      .s1 .station__halo, .s1 .station__dot { animation-delay: 0s; }
      .s2 .station__halo, .s2 .station__dot { animation-delay: 0.7s; }
      .s3 .station__halo, .s3 .station__dot { animation-delay: 1.4s; }
      .s4 .station__halo, .s4 .station__dot { animation-delay: 2.1s; }
      .s5 .station__halo, .s5 .station__dot { animation-delay: 2.8s; }

      /* Arcs de connexion : stroke-dashoffset anime */
      .arc {
        stroke-dasharray: 70 240;
        stroke-dashoffset: 310;
        opacity: 0;
        animation: arc-draw 9s linear infinite;
      }
      .a1 { animation-delay: 0s; }
      .a2 { animation-delay: 3s; }
      .a3 { animation-delay: 6s; }

      /* === Animations =========================================== */
      @keyframes dots-drift {
        from { transform: translate(0, 0); }
        to   { transform: translate(24px, 24px); }
      }
      @keyframes halo-breathe {
        0%, 100% { opacity: 0.85; transform: scale(1); }
        50%      { opacity: 1;    transform: scale(1.05); }
      }
      @keyframes radar-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
      @keyframes station-pulse {
        0%, 100% { transform: scale(0.5); opacity: 0; }
        50%      { transform: scale(2);   opacity: 0.9; }
      }
      @keyframes station-glow {
        0%, 100% { filter: drop-shadow(0 0 0 transparent); }
        50%      { filter: drop-shadow(0 0 7px #10e0a0); }
      }
      @keyframes arc-draw {
        0%   { stroke-dashoffset: 310; opacity: 0; }
        15%  { opacity: 0.95; }
        70%  { opacity: 0.95; }
        85%  { stroke-dashoffset: -240; opacity: 0; }
        100% { stroke-dashoffset: -240; opacity: 0; }
      }

      /* Reduced motion : composition statique */
      @media (prefers-reduced-motion: reduce) {
        .auth-bg__dots,
        .auth-bg__halo,
        .globe__radar,
        .station__halo,
        .station__dot,
        .arc {
          animation: none !important;
        }
        .station__halo { opacity: 0.6; transform: scale(1); }
        .station__dot { filter: drop-shadow(0 0 4px #10e0a0); }
        .arc { opacity: 0.5; stroke-dashoffset: 0; }
      }

      /* Mobile : simplification pour perf et lisibilite */
      @media (max-width: 640px) {
        .auth-bg__globe { opacity: 0.85; }
        .auth-bg__dots { opacity: 0.05; }
      }
    `,
  ],
})
export class AuthBackgroundComponent {}
