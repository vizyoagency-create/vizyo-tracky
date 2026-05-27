import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterOutlet, RouterLink, RouterLinkActive, NavigationEnd, Router } from '@angular/router';
import {
  LucideAngularModule,
  LayoutDashboard,
  Map,
  Truck,
  Layers,
  Bell,
  Shield,
  FileBarChart,
  Users,
  Settings,
  Menu,
  X,
  MoreHorizontal,
  Activity,
  AlertTriangle,
  MessageSquare,
  Terminal,
  UserRound,
  UserCircle2,
  LogOut,
  Sun,
  Moon,
} from 'lucide-angular';
import { ThemeService } from '../core/theme/theme.service';
import { ThemeToggleComponent } from '../shared/components/theme-toggle.component';
import { AlertsBellComponent } from '../shared/ui/alerts-bell/alerts-bell.component';
import { AuthService } from '../core/services/auth.service';
import { NetworkStatusService } from '../core/services/network-status.service';
import { RealtimeService } from '../core/services/realtime.service';
import { NotificationsApiService } from '../core/services/notifications.service';
import { OnboardingService } from '../core/services/onboarding.service';
import { PermissionsService } from '../core/services/permissions.service';
import { LogoComponent } from '../shared/ui/logo/logo.component';
import { InstallBannerComponent } from '../shared/ui/install-banner/install-banner.component';
import { PushPromptComponent } from '../shared/ui/push-prompt/push-prompt.component';
import { BottomSheetComponent } from '../shared/ui/bottom-sheet/bottom-sheet.component';
import { OnboardingWizardComponent } from '../features/onboarding/onboarding-wizard.component';
import { BaanoolMapOverlayComponent } from '../features/baanool/baanool-map-overlay.component';

@Component({
  selector: 'app-dashboard-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideAngularModule, ThemeToggleComponent, AlertsBellComponent, LogoComponent, InstallBannerComponent, PushPromptComponent, BottomSheetComponent, OnboardingWizardComponent, BaanoolMapOverlayComponent],
  template: `
    <a href="#main-content" class="skip-link">Aller au contenu principal</a>
    <div class="layout" [class.layout--fullscreen]="fullscreen()" [class.layout--ios-pwa]="isIosPwa" [class.layout--baanool]="isBaanoolMode()">
      @if (!network.online()) {
        <div class="offline-banner" role="status" aria-live="polite">
          <span class="offline-dot"></span>
          Hors-ligne — les donnees affichees datent de votre derniere session
        </div>
      }

      <!-- DESKTOP SIDEBAR -->
      <aside class="desktop-sidebar" [class.collapsed]="collapsed()" aria-label="Navigation principale">
        <div class="sidebar-top">
          <app-logo variant="icon" [size]="30" />
          @if (!collapsed()) {
            <span class="sidebar-brand">Vizyo <span class="text-tracky-light">Tracky</span></span>
          }
          <button (click)="collapsed.set(!collapsed())"
                  class="sidebar-toggle"
                  [attr.aria-label]="collapsed() ? 'Déplier le menu' : 'Replier le menu'"
                  [attr.aria-expanded]="!collapsed()">
            <lucide-icon [img]="MenuIcon" [size]="18"></lucide-icon>
          </button>
        </div>
        <nav class="sidebar-nav" aria-label="Sections">
          @for (item of navItems(); track item.label) {
            <a [routerLink]="item.route" routerLinkActive="active"
               #rla="routerLinkActive"
               class="sidebar-link"
               [attr.aria-current]="rla.isActive ? 'page' : null"
               [attr.aria-label]="collapsed() ? item.label : null">
              <lucide-icon [img]="item.icon" [size]="20" aria-hidden="true"></lucide-icon>
              @if (!collapsed()) { <span>{{ item.label }}</span> }
            </a>
          }
        </nav>
      </aside>

      <!-- MOBILE BOTTOM SHEET — remplace l'ancien drawer lateral.
           Pattern UX iOS/Android natif : glisse depuis le bas, accessible
           au pouce. Ouvert via le hamburger top-left ou le bouton "Plus" du
           bottom-bar — tous deux pointent vers le meme signal mobileMenuOpen. -->
      <app-bottom-sheet
        [open]="mobileMenuOpen()"
        ariaLabel="Menu de navigation"
        (closed)="mobileMenuOpen.set(false)">
        <div class="bs-header">
          <app-logo variant="icon" [size]="22" />
          <span class="bs-brand">Vizyo <span class="text-tracky-light">Tracky</span></span>
        </div>
        <nav class="bs-nav" aria-label="Sections">
          @for (item of navItems(); track item.label) {
            <a [routerLink]="item.route" routerLinkActive="active"
               #rla="routerLinkActive"
               class="bs-link"
               [attr.aria-current]="rla.isActive ? 'page' : null"
               (click)="mobileMenuOpen.set(false)">
              <lucide-icon [img]="item.icon" [size]="20" aria-hidden="true"></lucide-icon>
              <span>{{ item.label }}</span>
            </a>
          }
        </nav>
      </app-bottom-sheet>

      <!-- MAIN CONTENT -->
      <div class="main-area">
        <header class="top-bar" role="banner">
          <!-- Wave layers (effet vague glassy tracky) — wrapper a overflow:hidden
               pour ne pas couper les popups (alerts-bell) qui debordent du top-bar. -->
          <div class="top-bar-waves" aria-hidden="true">
            <span class="top-bar-wave top-bar-wave--1"></span>
            <span class="top-bar-wave top-bar-wave--2"></span>
          </div>

          <div class="top-bar-left">
            <button (click)="mobileMenuOpen.set(true)"
                    class="mobile-burger"
                    aria-label="Ouvrir le menu de navigation"
                    [attr.aria-expanded]="mobileMenuOpen()">
              <lucide-icon [img]="MenuIcon" [size]="18" aria-hidden="true"></lucide-icon>
            </button>
            <a routerLink="/dashboard" class="top-bar-brand" aria-label="Vizyo Tracky — Tableau de bord">
              <app-logo variant="icon" [size]="26" />
              <span class="top-bar-brand-text" aria-hidden="true">
                <span class="top-bar-brand-name">Vizyo</span>
                <span class="top-bar-brand-name top-bar-brand-name--accent">Tracky</span>
              </span>
            </a>
            <h2 class="top-title">{{ pageTitle() }}</h2>
          </div>
          <div class="top-actions">
            <app-alerts-bell />
            <div class="user-menu-wrapper">
              <button (click)="userMenuOpen.set(!userMenuOpen())" class="user-menu-trigger">
                <span class="user-avatar">{{ userInitials() }}</span>
              </button>
              @if (userMenuOpen()) {
                <div class="user-menu-backdrop" (click)="userMenuOpen.set(false)"></div>
                <div class="user-menu">
                  <div class="user-menu-header">
                    <span class="user-avatar user-avatar--lg">{{ userInitials() }}</span>
                    <div>
                      <p class="user-menu-name">{{ userEmail().split('&#64;')[0] }}</p>
                      <p class="user-menu-email">{{ userEmail() }}</p>
                    </div>
                  </div>
                  <div class="user-menu-divider"></div>
                  <a routerLink="/account" class="user-menu-item" (click)="userMenuOpen.set(false)">
                    <lucide-icon [img]="UserCircle2Icon" [size]="16"></lucide-icon>
                    Mon profil
                  </a>
                  <a routerLink="/settings" class="user-menu-item" (click)="userMenuOpen.set(false)">
                    <lucide-icon [img]="SettingsIcon" [size]="16"></lucide-icon>
                    Parametres
                  </a>
                  @if (isSuperAdmin()) {
                    <a routerLink="/admin" class="user-menu-item" (click)="userMenuOpen.set(false)">
                      <lucide-icon [img]="TerminalIcon" [size]="16"></lucide-icon>
                      Administration
                    </a>
                  }
                  <div class="user-menu-divider"></div>
                  <button class="user-menu-item" (click)="toggleTheme(); userMenuOpen.set(false)">
                    <lucide-icon [img]="themeService.theme() === 'dark' ? SunIcon : MoonIcon" [size]="16"></lucide-icon>
                    {{ themeService.theme() === 'dark' ? 'Mode clair' : 'Mode sombre' }}
                  </button>
                  <div class="user-menu-divider"></div>
                  <button class="user-menu-item user-menu-item--danger" (click)="confirmLogout()">
                    <lucide-icon [img]="LogOutIcon" [size]="16"></lucide-icon>
                    Se deconnecter
                  </button>
                </div>
              }
            </div>
          </div>
        </header>
        <main id="main-content" class="content" [class.fullscreen]="fullscreen()" tabindex="-1">
          <router-outlet />
        </main>
      </div>

      <!-- MOBILE BOTTOM BAR — cachee en mode fullscreen (page /map) pour
           liberer toute la hauteur ecran a la carte. -->
      <nav class="bottom-bar" [class.bottom-bar--hidden]="fullscreen()">
        @for (item of bottomItems(); track item.label) {
          @if (item.route === 'more') {
            <button (click)="mobileMenuOpen.set(true)" class="bottom-item press-feedback">
              <lucide-icon [img]="item.icon" [size]="20"></lucide-icon>
              <span>{{ item.label }}</span>
            </button>
          } @else {
            <a [routerLink]="item.route" routerLinkActive="active" class="bottom-item press-feedback">
              <lucide-icon [img]="item.icon" [size]="20"></lucide-icon>
              <span>{{ item.label }}</span>
            </a>
          }
        }
      </nav>

      <app-install-banner />
      <app-push-prompt />
      <app-onboarding-wizard />

      <!-- V1.12 — Mode Baanool : overlay UI style Baanool affiche UNIQUEMENT
           sur la page /map. Boutons cercles flottants (burger, recentrer,
           alertes, profile) + boutons droite verticaux (vehicules, coupe-
           circuit, GPS, satellite) + panel central toggleable. -->
      @if (isBaanoolMapPage()) {
        <app-baanool-map-overlay
          (menuClick)="mobileMenuOpen.set(true)"
        />
      }
    </div>
  `,
  styles: [`
    .layout {
      /* Hauteur viewport :
       *   - 100vh : fallback navigateurs anciens (≈ lvh sur iOS).
       *   - 100svh : "small viewport height", STABLE — ne change pas quand Safari
       *     replie/deploie sa barre navigateur. Sans ca, en mode browser iOS,
       *     le layout entier se redimensionne pendant le scroll = jitter et top-bar
       *     qui "saute". En PWA standalone le viewport est de toute facon stable
       *     donc svh = lvh = dvh.
       *   - On evite 100dvh qui s'anime en continu et provoque le bug "tout
       *     decale au scroll" rapporte par les utilisateurs iPhone.
       */
      height: 100vh;
      height: 100svh;
      display: flex;
      background: var(--bg-primary);
      overflow: hidden;
      position: relative;
    }

    /* ─── OFFLINE BANNER ─── */
    .offline-banner {
      position: absolute;
      top: 0; left: 0; right: 0;
      z-index: 9500;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      height: 28px;
      background: #f59e0b;
      color: #1f1300;
      font-size: 12px; font-weight: 600;
      padding-top: env(safe-area-inset-top);
      box-sizing: content-box;
      animation: offline-slide 200ms ease-out;
    }
    .offline-dot {
      width: 6px; height: 6px; border-radius: 9999px; background: currentColor;
      animation: offline-pulse 1.4s ease-in-out infinite;
    }
    @keyframes offline-slide { from { transform: translateY(-100%) } to { transform: translateY(0) } }
    @keyframes offline-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }

    /* ─── DESKTOP SIDEBAR ─── */
    .desktop-sidebar {
      display: flex; flex-direction: column;
      /* flex: 0 0 240px au lieu de width: 240px : en flex-row, le shorthand
       * fixe flex-basis (taille de reference) ce qui evite le delta entre la
       * width fixe et le calcul flex-basis: auto. Sans ca, lors du toggle de
       * la classe .collapsed, la transition CSS sur width ne se reflete pas
       * dans le flex-basis et la .main-area ne reprend pas l'espace libere. */
      flex: 0 0 240px;
      width: 240px;
      border-right: 1px solid var(--border-subtle);
      background: var(--bg-secondary); transition: flex-basis .3s, width .3s;
    }
    .desktop-sidebar.collapsed { flex-basis: 64px; width: 64px }
    .sidebar-top {
      display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 56px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .sidebar-brand { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: var(--fg-primary); white-space: nowrap }
    .sidebar-toggle {
      margin-left: auto; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
      color: var(--fg-tertiary); background: transparent; border: none; cursor: pointer;
    }
    .sidebar-toggle:hover { color: var(--fg-primary); background: var(--bg-tertiary) }
    .sidebar-nav { flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 8px }
    .sidebar-link {
      display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 12px;
      color: var(--fg-secondary); text-decoration: none; font-size: 13px; font-weight: 500;
      border: 1px solid transparent; transition: all .2s;
    }
    .sidebar-link:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .sidebar-link.active { background: var(--bg-tertiary); color: var(--tracky-light); border-color: var(--border-strong) }

    /* ─── MOBILE DRAWER ─── */
    /* Anciens drawers mobiles supprimes (remplaces par <app-bottom-sheet>). */

    /* ─── TOP BAR avec effet vague glassy ─── */
    .top-bar {
      display: flex; align-items: center; justify-content: space-between;
      height: 56px;
      flex-shrink: 0;
      position: relative;
      /* Pas d'overflow:hidden ici : la popup alerts-bell deborde et serait clippee.
         L'overflow est confine au .top-bar-waves wrapper ci-dessous. */
      /* z-index: 1800 -- doit etre superieur aux FAB de la map (jusqu'a 1700)
         pour que la popup alerts-bell (rendue dans le top-bar) s'affiche
         au-dessus de ces boutons. Reste sous les modals (toast 6000, drawer 8000). */
      z-index: 1800;
      border-bottom: 1px solid color-mix(in srgb, var(--tracky-light, #10E0A0) 14%, var(--border-subtle));
      background: color-mix(in srgb, var(--bg-secondary) 70%, transparent);
      backdrop-filter: blur(14px) saturate(1.5);
      -webkit-backdrop-filter: blur(14px) saturate(1.5);
      /* Safe-area :
       *   - top : env(safe-area-inset-top) clear le notch/Dynamic Island en PWA iOS
       *     standalone, MAIS sans buffer additionnel les icones se retrouvent a
       *     ~10px de la status bar iOS, visuellement colles. On ajoute +10px de
       *     respiration entre le bord bas de la status bar et le contenu du top-bar.
       *   - lateral : iPhone Pro Max paysage.
       */
      padding-top: calc(env(safe-area-inset-top) + 10px);
      padding-left: max(20px, env(safe-area-inset-left));
      padding-right: max(20px, env(safe-area-inset-right));
      box-sizing: content-box;
    }
    .top-bar-waves {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      z-index: 0;
      border-bottom-left-radius: inherit;
      border-bottom-right-radius: inherit;
    }
    .top-bar-wave {
      content: '';
      position: absolute;
      top: 0; bottom: 0;
      width: 250%;
      pointer-events: none;
      z-index: 0;
    }
    .top-bar-wave--1 {
      left: -75%;
      background:
        radial-gradient(ellipse 30% 140% at 20% 50%, rgba(16,224,160,.30), transparent 70%),
        radial-gradient(ellipse 25% 120% at 55% 40%, rgba(94,234,212,.20), transparent 60%),
        radial-gradient(ellipse 20% 100% at 80% 55%, rgba(167,243,208,.14), transparent 55%);
      animation: tracky-nav-wave-1 8s ease-in-out infinite alternate;
    }
    .top-bar-wave--2 {
      right: -75%;
      background:
        radial-gradient(ellipse 28% 130% at 35% 55%, rgba(52,211,153,.22), transparent 65%),
        radial-gradient(ellipse 22% 110% at 65% 45%, rgba(103,232,249,.16), transparent 55%),
        radial-gradient(ellipse 30% 120% at 85% 50%, rgba(16,224,160,.28), transparent 60%);
      animation: tracky-nav-wave-2 11s ease-in-out infinite alternate;
    }
    @keyframes tracky-nav-wave-1 {
      0%   { transform: translateX(0%);  opacity: .55 }
      30%  { opacity: .85 }
      50%  { transform: translateX(18%); opacity: .6 }
      70%  { opacity: .9 }
      100% { transform: translateX(35%); opacity: .65 }
    }
    @keyframes tracky-nav-wave-2 {
      0%   { transform: translateX(0%);   opacity: .5 }
      25%  { opacity: .8 }
      50%  { transform: translateX(-12%); opacity: .55 }
      75%  { opacity: .85 }
      100% { transform: translateX(-30%); opacity: .6 }
    }
    /* Light theme : version plus douce (le fond est déjà clair) */
    :host-context([data-theme='light']) .top-bar-wave--1 {
      background:
        radial-gradient(ellipse 30% 140% at 20% 50%, rgba(16,224,160,.16), transparent 70%),
        radial-gradient(ellipse 25% 120% at 55% 40%, rgba(94,234,212,.10), transparent 60%),
        radial-gradient(ellipse 20% 100% at 80% 55%, rgba(5,150,105,.06), transparent 55%);
    }
    :host-context([data-theme='light']) .top-bar-wave--2 {
      background:
        radial-gradient(ellipse 28% 130% at 35% 55%, rgba(52,211,153,.10), transparent 65%),
        radial-gradient(ellipse 22% 110% at 65% 45%, rgba(103,232,249,.08), transparent 55%),
        radial-gradient(ellipse 30% 120% at 85% 50%, rgba(16,224,160,.14), transparent 60%);
    }
    /* Respecter prefers-reduced-motion */
    @media (prefers-reduced-motion: reduce) {
      .top-bar-wave--1, .top-bar-wave--2 { animation: none }
    }

    .top-bar-left { display: flex; align-items: center; gap: 10px; min-width: 0; position: relative; z-index: 1 }
    .top-bar-brand {
      display: none;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      transition: opacity .2s;
    }
    .top-bar-brand:hover { opacity: .85 }
    .top-bar-brand-text {
      display: flex; align-items: baseline; gap: 4px;
      font-size: 14px; font-weight: 800;
      letter-spacing: -.01em;
      line-height: 1;
    }
    .top-bar-brand-name { color: var(--fg-primary) }
    .top-bar-brand-name--accent { color: var(--tracky-light) }

    .mobile-burger { display: none }
    .top-title { font-size: 16px; font-weight: 700; color: var(--fg-primary); position: relative; z-index: 1 }
    .top-actions { display: flex; align-items: center; gap: 8px; position: relative; z-index: 1 }
    /* User menu dropdown */
    .user-menu-wrapper { position: relative }
    .user-menu-trigger {
      display: flex; align-items: center; justify-content: center;
      background: transparent; border: 2px solid var(--border-subtle);
      border-radius: 9999px; cursor: pointer; padding: 0;
      transition: border-color .2s;
    }
    .user-menu-trigger:hover { border-color: var(--tracky-light) }
    .user-avatar {
      width: 36px; height: 36px; border-radius: 9999px;
      background: var(--tracky); color: white;
      font-size: 12px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
    }
    .user-avatar--lg { width: 40px; height: 40px; font-size: 14px }
    .user-menu-backdrop { position: fixed; inset: 0; z-index: 8999 }
    .user-menu {
      position: absolute; top: calc(100% + 8px); right: 0; z-index: 9000;
      width: 240px; background: var(--bg-secondary);
      border: 1px solid var(--border-subtle); border-radius: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,.25); overflow: hidden;
      animation: menuFadeIn .15s ease-out;
    }
    @keyframes menuFadeIn { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: translateY(0) } }
    .user-menu-header {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px;
    }
    .user-menu-name { font-size: 13px; font-weight: 700; color: var(--fg-primary); margin: 0 }
    .user-menu-email { font-size: 11px; color: var(--fg-tertiary); margin: 2px 0 0 }
    .user-menu-divider { height: 1px; background: var(--border-subtle) }
    .user-menu-item {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 10px 16px;
      background: transparent; border: 0;
      color: var(--fg-secondary); font-size: 13px; font-weight: 500;
      text-decoration: none; cursor: pointer; transition: all .12s;
    }
    .user-menu-item:hover { background: var(--bg-tertiary); color: var(--fg-primary) }
    .user-menu-item--danger { color: var(--fg-tertiary) }
    .user-menu-item--danger:hover { color: #f87171; background: rgba(239,68,68,.06) }

    /* ─── MAIN ─── */
    .main-area { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0 }
    /* .content est LE seul scroller du shell PWA.
     *   - overscroll-behavior: contain : sur un scroller interne, ca MARCHE sur iOS
     *     (contrairement au document body). Bloque le rubber band et empeche le
     *     scroll de "fuir" vers le parent fixed.
     *   - -webkit-overflow-scrolling: touch : active le momentum scrolling iOS
     *     (smooth, inertie). Toujours utile en 2026 meme si officiellement deprecate
     *     (iOS continue de l'honorer pour ne pas casser des millions de sites).
     *   - min-height: 0 sur le flex parent : sans ca, le flex item peut depasser
     *     son parent et casser overflow:auto (bug flexbox classique). */
    .content {
      flex: 1;
      min-height: 0;
      padding: 24px;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      position: relative;
    }
    .content.fullscreen { padding: 0; overflow: hidden }

    /* ════════════════════════════════════════════════════════
       MODE BAANOOL (V1.12) — UI simplifiee per-user
       Cache sidebar desktop + bottom-bar mobile, la navigation se fait
       UNIQUEMENT via le burger top-left qui ouvre le bottom-sheet existant.
       Le content prend toute la largeur, comportement equivalent au mode
       fullscreen mais applique sur TOUTES les pages.
       Toggle dans /settings > Apparence > "Mode interface simplifiee".
       ════════════════════════════════════════════════════════ */
    .layout--baanool .desktop-sidebar { display: none !important; }
    .layout--baanool .bottom-bar { display: none !important; }
    .layout--baanool .main-area { width: 100%; }
    .layout--baanool .content { padding: 0; overflow: hidden; }
    /* En mode baanool sur la page /map, on cache aussi le top-bar standard
     * car l'overlay Baanool fournit ses propres boutons (burger, alertes,
     * profile) en cercles flottants. Sur les autres pages, le top-bar reste
     * visible pour avoir le titre + retour. */
    .layout--baanool.layout--fullscreen .top-bar { display: none; }
    /* Note : les overrides pour cacher les overlays UI natifs du map.component
       en mode baanool (.tracky-mobile-topbar, .tracky-mobile-fab-main, etc.)
       sont dans styles.css global car ils traversent l'encapsulation Angular
       de map.component. */


    /* ════════════════════════════════════════════════════════
       MOBILE BOTTOM BAR (visible < 768px uniquement)
       ════════════════════════════════════════════════════════ */
    .bottom-bar { display: none }


    /* ════════════════════════════════════════════════════════
       MOBILE (< 768px)
       ════════════════════════════════════════════════════════ */
    @media (max-width: 768px) {
      .desktop-sidebar { display: none }

      .bottom-bar {
        display: flex;
        position: fixed;
        bottom: 0; left: 0; right: 0;
        z-index: 7000;
        background: var(--bg-secondary);
        border-top: 1px solid var(--border-subtle);
        backdrop-filter: blur(12px);
        padding: 6px 8px;
        padding-bottom: calc(env(safe-area-inset-bottom) + 6px);
        gap: 4px;
      }
      /* Quand la page est en fullscreen (route data { fullscreen:true }, ex: /map),
         on cache la barre du bas pour donner toute la place a la carte. */
      .bottom-bar.bottom-bar--hidden { display: none !important; }
      .bottom-item {
        flex: 1;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 3px;
        padding: 8px 4px;
        background: transparent; border: 0;
        color: var(--fg-tertiary);
        font-size: 10px; font-weight: 600;
        text-decoration: none;
        border-radius: 10px;
        transition: color .15s, background .15s;
        min-height: 48px;
      }
      .bottom-item:hover { background: var(--bg-tertiary) }
      .bottom-item.active { color: var(--tracky-light); background: var(--bg-tertiary) }
      .bottom-item lucide-icon { display: block }

      /* Mobile : touch targets 44x44 minimum (Apple HIG iOS, materiel design Android).
         Sur l'ancien 36x36 le user reportait "trop petit pour mon doigt" + clics
         rates 2-3 fois (cible too small, finger covers the icon entirely). */
      .mobile-burger {
        display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 10px;
        background: transparent; border: none; color: var(--fg-secondary); cursor: pointer;
      }
      .mobile-burger:hover { background: var(--bg-tertiary) }

      /* Bottom-sheet content (remplace l'ancien drawer lateral) */
      .bs-header {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 4px 12px;
        border-bottom: 1px solid var(--border-subtle);
        margin-bottom: 8px;
      }
      .bs-brand {
        font-size: 13px; font-weight: 800; text-transform: uppercase;
        letter-spacing: .08em; color: var(--fg-primary);
      }
      .bs-nav {
        display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
        padding: 4px 0 8px;
      }
      .bs-link {
        display: flex; align-items: center; gap: 12px;
        padding: 14px 14px; border-radius: 14px;
        color: var(--fg-secondary); text-decoration: none;
        font-size: 14px; font-weight: 600;
        background: var(--bg-tertiary);
        border: 1px solid transparent;
        transition: all .15s;
        min-height: 56px;
      }
      .bs-link:active { transform: scale(.97) }
      .bs-link.active {
        background: rgba(16,224,160,.1);
        color: var(--tracky-light);
        border-color: rgba(16,224,160,.25);
      }
      /* Mode sombre : un peu plus de contraste sur les cartes */
      :host-context([data-theme="dark"]) .bs-link {
        background: rgba(255,255,255,.04);
      }

      /* Mobile : on conserve le padding-top: env(safe-area-inset-top) de la regle de base
         (notch / Dynamic Island en PWA iOS standalone). Utiliser les longhand
         left/right au lieu du shorthand qui ecraserait le padding-top.
         Height: 64px sur mobile (vs 56 desktop) pour respirer les nouveaux
         tap-targets 44x44 et ne pas que les icones touchent les bords du top-bar. */
      .top-bar { padding-left: 14px; padding-right: 14px; height: 64px }
      /* Sur mobile, on cache le titre de page (présent dans la page) et on affiche
         le logo + brand pour rappeler l'identité Vizyo Tracky. */
      .top-title { display: none }
      .top-bar-brand { display: flex }
      .top-bar-brand-text { font-size: 13px }

      /* Padding-bottom du content : reserve la place pour la bottom-bar fixe.
         Bottom-bar = padding-top 6px + bottom-item (52px ios-pwa) +
                      padding-bottom (6px + safe-area-inset-bottom)
                    ≈ 64px (base) + safe-area-inset-bottom.
         On reserve 80px + safe-area-inset-bottom :
           - sur iPhone Pro (env=34) -> total 114px, bar=98px, gap=16px ✓
           - sur iPhone sans notch (env=0) -> total 80px, bar=64px, gap=16px ✓
         Gap visuel constant de ~16px au-dessus de la bar, peu importe le device.
         Avant : 160+env donnait jusqu'a 194px de padding = vaste zone vide
         visible sur les pages courtes (ex: "Mon compte"). */
      .content {
        padding: 16px;
        padding-bottom: calc(80px + env(safe-area-inset-bottom));
      }
      /* En fullscreen la bottom-bar est cachee : pas besoin de reserver de place
         pour elle, juste la safe-area pour les iPhones a notch. */
      .content.fullscreen {
        padding-bottom: env(safe-area-inset-bottom);
        padding-left: env(safe-area-inset-left);
        padding-right: env(safe-area-inset-right);
      }
    }

    @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
    @keyframes slideRight { from { transform: translateX(-100%) } to { transform: translateX(0) } }
  `],
})
export class DashboardLayoutComponent {
  protected readonly isIosPwa = (() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches
      || (navigator as any).standalone === true;
    return isIos && isStandalone;
  })();
  protected readonly collapsed = signal(false);
  protected readonly fullscreen = signal(false);
  protected readonly pageTitle = signal('Tableau de bord');
  protected readonly mobileMenuOpen = signal(false);
  /** V1.12 — Mode UI Baanool : layout simplifie, sidebar+bottom-bar cachees,
   *  navigation via burger uniquement, contenu en pleine largeur. */
  protected readonly isBaanoolMode = computed(() =>
    this.auth.user()?.preferences?.uiMode === 'baanool',
  );
  /** URL courante (mise a jour via NavigationEnd) — utilisee pour ne montrer
   *  l'overlay Baanool QUE sur la page /map. */
  protected readonly currentUrl = signal('');
  protected readonly isBaanoolMapPage = computed(() =>
    this.isBaanoolMode() && this.currentUrl().startsWith('/map'),
  );
  protected readonly MenuIcon = Menu;
  protected readonly XIcon = X;
  protected readonly MoreIcon = MoreHorizontal;
  protected readonly UserCircle2Icon = UserCircle2;
  protected readonly LogOutIcon = LogOut;
  protected readonly SunIcon = Sun;
  protected readonly MoonIcon = Moon;
  protected readonly SettingsIcon = Settings;
  protected readonly TerminalIcon = Terminal;

  protected isSuperAdmin(): boolean {
    return this.auth.user()?.role === 'SUPER_ADMIN';
  }
  private readonly realtime = inject(RealtimeService);
  protected readonly themeService = inject(ThemeService);
  protected readonly userMenuOpen = signal(false);

  protected userInitials(): string {
    return (this.auth.user()?.email ?? '??').slice(0, 2).toUpperCase();
  }

  protected userEmail(): string {
    return this.auth.user()?.email ?? '';
  }

  protected toggleTheme(): void {
    this.themeService.setTheme(this.themeService.theme() === 'dark' ? 'light' : 'dark');
  }

  protected confirmLogout(): void {
    this.userMenuOpen.set(false);
    if (confirm('Se deconnecter de Vizyo Tracky ?')) {
      this.realtime.disconnect();
      this.auth.logout();
      this.router.navigate(['/login']);
    }
  }

  protected logout(): void {
    this.realtime.disconnect();
    this.auth.logout();
    this.router.navigate(['/login']);
  }

  protected readonly bottomItems = computed(() => [
    { label: 'Dashboard', route: '/dashboard', icon: LayoutDashboard },
    ...(this.perms.can('vehicles_view') ? [
      { label: 'Carte', route: '/map', icon: Map },
      { label: 'Véhicules', route: '/vehicles', icon: Truck },
    ] : []),
    ...(this.perms.can('alerts_view') ? [{ label: 'Alertes', route: '/alerts', icon: Bell }] : []),
    { label: 'Plus', route: 'more', icon: MoreHorizontal },
  ]);

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly onboarding = inject(OnboardingService);
  private readonly notif = inject(NotificationsApiService);

  constructor() {
    // V1.10 (Sprint 5 stabilite) — takeUntilDestroyed evite l'accumulation de
    // subscriptions sur router.events si le layout est detruit/recree (cas
    // logout puis re-login dans la meme session navigateur).
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationEnd) {
        const child = this.route.firstChild;
        const data = child?.snapshot.data ?? {};
        this.fullscreen.set(data['fullscreen'] === true);
        const title = typeof data['title'] === 'string' ? data['title'] : 'Tableau de bord';
        this.pageTitle.set(title);
        this.currentUrl.set(event.urlAfterRedirects);
      }
    });
    // V1.5 (Sprint J) — au mount du layout (= apres login), charger le profil
    // et ouvrir le wizard si onboardingCompletedAt est null.
    void this.onboarding.loadProfileAndDecide();
    // V1.8 (web-push-finalize) — bridge SW <-> client pose des le boot session,
    // pour que les actions "Acquitter" / "Voir" depuis une notif systeme soient
    // capturees meme si l'utilisateur n'a pas visite /account dans cette session.
    this.notif.installSwMessageBridge();
    void this.notif.loadStatus();
  }

  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  protected readonly network = inject(NetworkStatusService);

  protected readonly navItems = computed(() => {
    const isSuperAdmin = this.auth.user()?.role === 'SUPER_ADMIN';
    // V1.12 — Mode Baanool : menu reduit aux essentiels. Pas de dashboard,
    // groupes, geofences, rapports, conducteurs, utilisateurs. Garde Carte,
    // Vehicules (pour accéder au detail), Alertes, et les pages personnelles
    // (Compte/Parametres sont accessibles via top-right ou directement).
    if (this.isBaanoolMode()) {
      return [
        ...(this.perms.can('vehicles_view') ? [
          { label: 'Carte', route: '/map', icon: Map },
          { label: 'Véhicules', route: '/vehicles', icon: Truck },
        ] : []),
        ...(this.perms.can('alerts_view') ? [{ label: 'Alertes', route: '/alerts', icon: Bell }] : []),
        { label: 'Paramètres', route: '/settings', icon: Settings },
      ];
    }
    return [
      { label: 'Tableau de bord', route: '/dashboard', icon: LayoutDashboard },
      ...(this.perms.can('vehicles_view') ? [
        { label: 'Carte', route: '/map', icon: Map },
        { label: 'Véhicules', route: '/vehicles', icon: Truck },
      ] : []),
      ...(this.perms.can('groups_view') ? [{ label: 'Groupes', route: '/groups', icon: Layers }] : []),
      ...(this.perms.can('alerts_view') ? [{ label: 'Alertes', route: '/alerts', icon: Bell }] : []),
      ...(this.perms.can('geofences_view') ? [{ label: 'Géofences', route: '/geofences', icon: Shield }] : []),
      ...(this.perms.can('reports_view') ? [{ label: 'Rapports', route: '/reports', icon: FileBarChart }] : []),
      ...(this.perms.can('drivers_view') ? [{ label: 'Conducteurs', route: '/drivers', icon: UserRound }] : []),
      ...(this.perms.can('users_view') ? [{ label: 'Utilisateurs', route: '/users', icon: Users }] : []),
    ];
  });
}
