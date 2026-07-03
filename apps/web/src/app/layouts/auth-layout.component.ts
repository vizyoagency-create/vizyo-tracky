import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LogoComponent } from '../shared/ui/logo/logo.component';

/**
 * Layout des pages auth (login, forgot password, accept invite).
 *
 * Refonte DS : plus d'animation carte (MapLibre) ni de globe wireframe — le
 * panneau droit est désormais STATIQUE (dot-grid masqué + glow émeraude + tracé
 * de route SVG + carte « temps réel » en verre + ligne de confiance). Un seul
 * micro-mouvement toléré : le point « live » qui clignote (respecte
 * prefers-reduced-motion). Perf : aucune instance MapLibre créée sur le login.
 *
 * Split 50/50 en desktop (formulaire à gauche via <router-outlet>, marque à
 * droite). En < lg le panneau marque est masqué et le formulaire passe pleine
 * largeur (safe-area PWA iOS préservée).
 */
@Component({
  selector: 'app-auth-layout',
  standalone: true,
  imports: [RouterOutlet, LogoComponent],
  styles: [
    `
      :host { display: block; }

      .auth-grid {
        display: grid;
        grid-template-columns: minmax(440px, 520px) 1fr;
        min-height: 100svh;
        background: var(--bg-primary);
        overflow: hidden;
      }

      /* ───────── Panneau formulaire (gauche) ───────── */
      .form-pane {
        position: relative;
        display: flex;
        flex-direction: column;
        padding: 40px 56px;
        background: var(--bg-primary);
        overflow: hidden;
      }
      /* Dot-grid subtil : évoque les coordonnées GPS sans bruiter le fond. */
      .form-pane__grid {
        position: absolute;
        inset: 0;
        opacity: 0.06;
        pointer-events: none;
        background-image: radial-gradient(var(--color-tracky-light) 1px, transparent 1px);
        background-size: 24px 24px;
        -webkit-mask-image: radial-gradient(ellipse 80% 60% at 30% 20%, #000, transparent 75%);
        mask-image: radial-gradient(ellipse 80% 60% at 30% 20%, #000, transparent 75%);
      }
      .form-pane__glow {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(
          ellipse 70% 50% at 100% 100%,
          color-mix(in srgb, var(--color-tracky-light) 7%, transparent) 0%,
          transparent 60%
        );
      }

      .auth-head {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 11px;
      }
      .brand-word {
        font-weight: 800;
        font-size: 1.06rem;
        letter-spacing: -0.01em;
        color: var(--fg-primary);
      }

      .auth-main {
        position: relative;
        z-index: 1;
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        max-width: 440px;
        width: 100%;
      }
      .auth-title {
        margin: 12px 0 0;
        font-family: var(--font-display);
        font-size: 2.3rem;
        font-weight: 800;
        letter-spacing: -0.03em;
        line-height: 1.04;
        color: var(--fg-primary);
        text-wrap: balance;
      }
      .auth-sub {
        margin: 12px 0 26px;
        font-size: 1rem;
        color: var(--fg-secondary);
        line-height: 1.5;
      }

      .form-pane__footer {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        font-family: var(--font-mono);
        font-size: 0.7rem;
        letter-spacing: 0.04em;
        color: var(--fg-tertiary);
      }

      /* ───────── Panneau marque (droite) — STATIQUE ───────── */
      .brand-pane {
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 56px;
        background: var(--surface-rail);
        overflow: hidden;
        border-left: 1px solid var(--border-subtle);
      }
      .brand-grid {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(color-mix(in srgb, var(--fg-primary) 4%, transparent) 1px, transparent 1px),
          linear-gradient(90deg, color-mix(in srgb, var(--fg-primary) 4%, transparent) 1px, transparent 1px);
        background-size: 46px 46px;
        -webkit-mask-image: radial-gradient(ellipse 90% 80% at 70% 30%, #000, transparent 80%);
        mask-image: radial-gradient(ellipse 90% 80% at 70% 30%, #000, transparent 80%);
      }
      .brand-glow {
        position: absolute;
        top: -15%;
        right: -10%;
        width: 70%;
        height: 70%;
        pointer-events: none;
        background: radial-gradient(circle, color-mix(in srgb, var(--color-tracky-light) 12%, transparent), transparent 70%);
        filter: blur(10px);
      }
      .brand-route {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0.55;
        pointer-events: none;
      }
      .auth-ping-c {
        transform-origin: 300px 300px;
        animation: auth-ping 2.8s ease-out infinite;
      }
      @keyframes auth-ping {
        0% { transform: scale(1); opacity: 0.5; }
        80%, 100% { transform: scale(2.8); opacity: 0; }
      }

      .brand-top {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .brand-live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--color-tracky-light);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-tracky-light) 18%, transparent);
        animation: vt-blink 2.4s ease-in-out infinite;
      }

      .brand-mid {
        position: relative;
        z-index: 1;
        max-width: 460px;
      }
      .brand-h2 {
        margin: 0;
        font-family: var(--font-display);
        font-size: 2.4rem;
        font-weight: 800;
        letter-spacing: -0.03em;
        line-height: 1.06;
        color: var(--fg-primary);
        text-wrap: balance;
      }
      .brand-p {
        margin: 18px 0 0;
        font-size: 1.02rem;
        color: var(--fg-secondary);
        line-height: 1.6;
      }

      .brand-bottom {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .brand-card {
        align-self: flex-start;
        max-width: 340px;
        width: 100%;
        padding: 16px 18px;
        border-radius: 18px;
        background: color-mix(in srgb, var(--surface-secondary) 82%, transparent);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border: 1px solid var(--border-strong-color);
        box-shadow: 0 14px 44px -18px rgba(0, 0, 0, 0.45);
      }
      .brand-card-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .brand-card-label {
        font-family: var(--font-mono);
        font-size: 0.66rem;
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--fg-tertiary);
      }
      .brand-card-big {
        margin: 8px 0 14px;
        font-family: var(--font-display);
        font-size: 1.5rem;
        font-weight: 800;
        letter-spacing: -0.02em;
        color: var(--fg-primary);
      }
      .brand-card-big span {
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--fg-secondary);
      }
      .brand-card-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
      }
      .brand-card-stats > div {
        padding: 9px 10px;
        border-radius: 11px;
        background: var(--surface-tertiary);
        border: 1px solid var(--border-color);
      }
      .brand-card-stats span {
        display: block;
        font-family: var(--font-mono);
        font-size: 0.6rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--fg-tertiary);
      }
      .brand-card-stats b {
        display: block;
        margin-top: 3px;
        font-family: var(--font-display);
        font-size: 1.05rem;
        font-weight: 800;
        color: var(--fg-primary);
      }
      .brand-card-stats b.accent { color: var(--color-tracky-light); }
      .brand-card-stats b.amber { color: var(--warning); }

      .brand-trust {
        display: flex;
        flex-wrap: wrap;
        gap: 22px;
        color: var(--fg-tertiary);
        font-size: 0.82rem;
      }
      .brand-trust span {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      @media (prefers-reduced-motion: reduce) {
        .brand-live-dot, .auth-ping-c { animation: none; }
      }

      /* ───────── Responsive (< lg) : marque masquée, formulaire plein écran ───────── */
      @media (max-width: 1023px) {
        .auth-grid { grid-template-columns: 1fr; }
        .brand-pane { display: none; }
        /* safe-area PWA iOS standalone (status bar black-translucent). */
        .form-pane {
          padding: max(24px, env(safe-area-inset-top)) max(22px, env(safe-area-inset-right))
                   max(24px, env(safe-area-inset-bottom)) max(22px, env(safe-area-inset-left));
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
        }
        .auth-main { justify-content: flex-start; padding-top: 8px; max-width: 460px; margin: 0 auto; }
        .auth-head { max-width: 460px; margin: 0 auto; width: 100%; }
        .form-pane__footer { max-width: 460px; margin: 0 auto; width: 100%; }
        .auth-title { font-size: 2rem; }
      }
    `,
  ],
  template: `
    <div class="auth-grid">
      <!-- ===== Panneau formulaire (gauche) ===== -->
      <section class="form-pane">
        <div class="form-pane__grid"></div>
        <div class="form-pane__glow"></div>

        <header class="auth-head">
          <app-logo variant="icon" [size]="30" />
          <span class="brand-word">Vizyo <span class="text-tracky-light">Tracky</span></span>
        </header>

        <main class="auth-main">
          <span class="vt-eyebrow">Espace client</span>
          <h1 class="auth-title">Bon retour.</h1>
          <p class="auth-sub">Connectez-vous à votre tableau de bord Vizyo Tracky.</p>
          <router-outlet />
        </main>

        <footer class="form-pane__footer">
          <span>Suivi de flotte GPS · Temps réel</span>
          <span>&copy; {{ year }} Vizyo</span>
        </footer>
      </section>

      <!-- ===== Panneau marque (droite) — statique ===== -->
      <aside class="brand-pane" aria-hidden="true">
        <div class="brand-grid"></div>
        <div class="brand-glow"></div>

        <svg class="brand-route" viewBox="0 0 600 600" preserveAspectRatio="xMidYMid slice">
          <path d="M40 470 C 160 430 180 300 300 300 S 470 220 560 120" fill="none"
                stroke="var(--color-tracky-light)" stroke-width="2.4" stroke-linecap="round"
                stroke-opacity=".55" stroke-dasharray="1 12" />
          <path d="M90 90 C 200 160 220 260 330 300 S 500 400 540 500" fill="none"
                stroke="var(--color-tracky-light)" stroke-width="2" stroke-linecap="round"
                stroke-opacity=".28" stroke-dasharray="1 14" />
          <circle cx="300" cy="300" r="7" fill="var(--color-tracky-light)" />
          <circle class="auth-ping-c" cx="300" cy="300" r="7" fill="var(--color-tracky-light)" />
          <circle cx="560" cy="120" r="5" fill="var(--color-tracky-light)" fill-opacity=".8" />
          <circle cx="40" cy="470" r="5" fill="var(--color-tracky-light)" fill-opacity=".8" />
          <circle cx="90" cy="90" r="4" fill="var(--fg-tertiary)" />
        </svg>

        <header class="brand-top">
          <span class="brand-live-dot"></span>
          <span class="vt-section-label" style="color:var(--fg-secondary)">Plateforme temps réel</span>
        </header>

        <div class="brand-mid">
          <h2 class="brand-h2">Suivez et sécurisez votre flotte, en temps réel.</h2>
          <p class="brand-p">
            Géolocalisation, coupure moteur à distance, alertes et rapports — une seule
            plateforme, matériel posé par nos techniciens et données hébergées en France.
          </p>
        </div>

        <div class="brand-bottom">
          <div class="brand-card">
            <div class="brand-card-top">
              <span class="brand-card-label">Suivi temps réel</span>
              <span class="vt-status vt-status--on"><span class="vt-status__dot"></span>En ligne</span>
            </div>
            <p class="brand-card-big">14 <span>véhicules actifs</span></p>
            <div class="brand-card-stats">
              <div><span>Roulage</span><b class="accent">9</b></div>
              <div><span>Arrêt</span><b>5</b></div>
              <div><span>Alertes</span><b class="amber">2</b></div>
            </div>
          </div>

          <div class="brand-trust">
            <span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
              Données hébergées en France
            </span>
            <span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
              Support humain local
            </span>
          </div>
        </div>
      </aside>
    </div>
  `,
})
export class AuthLayoutComponent {
  protected readonly year = new Date().getFullYear();
}
