import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterOutlet, RouterLink, RouterLinkActive, NavigationEnd, Router } from '@angular/router';
import {
  LucideAngularModule,
  LayoutDashboard,
  Map,
  Truck,
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
} from 'lucide-angular';
import { ThemeToggleComponent } from '../shared/components/theme-toggle.component';
import { AlertsBellComponent } from '../shared/ui/alerts-bell/alerts-bell.component';
import { AuthService } from '../core/services/auth.service';
import { NetworkStatusService } from '../core/services/network-status.service';
import { OnboardingService } from '../core/services/onboarding.service';
import { PermissionsService } from '../core/services/permissions.service';
import { LogoComponent } from '../shared/ui/logo/logo.component';
import { InstallBannerComponent } from '../shared/ui/install-banner/install-banner.component';
import { ToastContainerComponent } from '../shared/ui/toast/toast-container.component';
import { OnboardingWizardComponent } from '../features/onboarding/onboarding-wizard.component';

@Component({
  selector: 'app-dashboard-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideAngularModule, ThemeToggleComponent, AlertsBellComponent, LogoComponent, InstallBannerComponent, ToastContainerComponent, OnboardingWizardComponent],
  template: `
    <a href="#main-content" class="skip-link">Aller au contenu principal</a>
    <div class="layout" [class.layout--fullscreen]="fullscreen()">
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

      <!-- MOBILE DRAWER OVERLAY -->
      @if (mobileMenuOpen()) {
        <div class="mobile-overlay" (click)="mobileMenuOpen.set(false)" aria-hidden="true"></div>
        <aside class="mobile-drawer"
               role="dialog"
               aria-modal="true"
               aria-label="Menu de navigation">
          <div class="drawer-top">
            <app-logo variant="icon" [size]="28" />
            <span class="sidebar-brand">Vizyo <span class="text-tracky-light">Tracky</span></span>
            <button (click)="mobileMenuOpen.set(false)" class="drawer-close" aria-label="Fermer le menu">
              <lucide-icon [img]="XIcon" [size]="18" aria-hidden="true"></lucide-icon>
            </button>
          </div>
          <nav class="drawer-nav" aria-label="Sections">
            @for (item of navItems(); track item.label) {
              <a [routerLink]="item.route" routerLinkActive="active"
                 #rla="routerLinkActive"
                 class="drawer-link"
                 [attr.aria-current]="rla.isActive ? 'page' : null"
                 (click)="mobileMenuOpen.set(false)">
                <lucide-icon [img]="item.icon" [size]="20" aria-hidden="true"></lucide-icon>
                <span>{{ item.label }}</span>
              </a>
            }
          </nav>
        </aside>
      }

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
            <a routerLink="/account"
               routerLinkActive="active"
               class="top-account-link"
               aria-label="Mon compte">
              <lucide-icon [img]="UserCircle2Icon" [size]="20" aria-hidden="true"></lucide-icon>
            </a>
            <app-theme-toggle />
          </div>
        </header>
        <main id="main-content" class="content" [class.fullscreen]="fullscreen()" tabindex="-1">
          <router-outlet />
        </main>
      </div>

      <!-- MOBILE BOTTOM BAR — cachee en mode fullscreen (page /map) pour
           liberer toute la hauteur ecran a la carte. -->
      <nav class="bottom-bar" [class.bottom-bar--hidden]="fullscreen()">
        @for (item of bottomItems; track item.label) {
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
      <app-toast-container />
      <app-onboarding-wizard />
    </div>
  `,
  styles: [`
    .layout {
      /* 100vh = fallback navigateurs anciens, 100dvh = dynamic viewport (corrige iOS Safari) */
      height: 100vh;
      height: 100dvh;
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
      display: flex; flex-direction: column; width: 240px; border-right: 1px solid var(--border-subtle);
      background: var(--bg-secondary); transition: width .3s; shrink: 0;
    }
    .desktop-sidebar.collapsed { width: 64px }
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
    .mobile-overlay { display: none }
    .mobile-drawer { display: none }

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
      /* Safe-area : top pour notch/Dynamic Island en standalone, lateral pour iPhone Pro paysage */
      padding-top: env(safe-area-inset-top);
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

    .top-bar-left { display: flex; align-items: center; gap: 12px; min-width: 0; position: relative; z-index: 1 }
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
    .top-actions { display: flex; align-items: center; gap: 12px; position: relative; z-index: 1 }
    .top-account-link {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; border-radius: 9999px;
      color: var(--fg-secondary); text-decoration: none;
      border: 1px solid transparent; background: transparent;
      transition: color .2s, background .2s, border-color .2s;
    }
    .top-account-link:hover { color: var(--fg-primary); background: var(--bg-tertiary) }
    .top-account-link.active {
      color: var(--tracky-light, #10E0A0);
      background: rgba(16,224,160,.1);
      border-color: rgba(16,224,160,.25);
    }

    /* ─── MAIN ─── */
    .main-area { flex: 1; display: flex; flex-direction: column; min-width: 0 }
    .content { flex: 1; padding: 24px; overflow: auto; position: relative }
    .content.fullscreen { padding: 0; overflow: hidden }


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

      /* Padding-bottom du content pour ne pas masquer le dernier element
         derriere la bottom-bar (56px barre + safe-area + petit espace). */
      .content {
        padding-bottom: calc(72px + env(safe-area-inset-bottom)) !important;
      }
      /* En fullscreen la bottom-bar est cachee : pas besoin de reserver de place
         pour elle, juste la safe-area pour les iPhones a notch. */
      .content.fullscreen {
        padding-bottom: env(safe-area-inset-bottom) !important;
      }

      .mobile-burger {
        display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px;
        background: transparent; border: none; color: var(--fg-secondary); cursor: pointer;
      }
      .mobile-burger:hover { background: var(--bg-tertiary) }

      .mobile-overlay {
        display: block; position: fixed; inset: 0; z-index: 8000; background: rgba(0,0,0,.5); backdrop-filter: blur(4px);
        animation: fadeIn .2s ease;
      }
      .mobile-drawer {
        display: flex; flex-direction: column; position: fixed; top: 0; left: 0; bottom: 0; width: 280px; z-index: 8001;
        background: var(--bg-secondary); border-right: 1px solid var(--border-subtle); box-shadow: 8px 0 32px rgba(0,0,0,.3);
        animation: slideRight .25s ease-out;
        /* Drawer : tient compte du notch en standalone */
        padding-top: env(safe-area-inset-top);
        padding-bottom: env(safe-area-inset-bottom);
        padding-left: env(safe-area-inset-left);
      }
      .drawer-top {
        display: flex; align-items: center; gap: 8px; padding: 0 16px; height: 56px;
        border-bottom: 1px solid var(--border-subtle);
      }
      .drawer-close {
        margin-left: auto; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
        background: transparent; border: none; color: var(--fg-tertiary); cursor: pointer;
      }
      .drawer-close:hover { color: var(--fg-primary); background: var(--bg-tertiary) }
      .drawer-nav { flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 12px }
      .drawer-link {
        display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px;
        color: var(--fg-secondary); text-decoration: none; font-size: 14px; font-weight: 500; transition: all .2s;
      }
      .drawer-link:hover { background: var(--bg-tertiary) }
      .drawer-link.active { background: var(--bg-tertiary); color: var(--tracky-light) }

      .top-bar { padding: 0 14px; height: 56px }
      /* Sur mobile, on cache le titre de page (présent dans la page) et on affiche
         le logo + brand pour rappeler l'identité Vizyo Tracky. */
      .top-title { display: none }
      .top-bar-brand { display: flex }
      .top-bar-brand-text { font-size: 13px }

      .content {
        padding: 16px;
        padding-bottom: calc(env(safe-area-inset-bottom) + 24px);
      }
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
  protected readonly collapsed = signal(false);
  protected readonly fullscreen = signal(false);
  protected readonly pageTitle = signal('Tableau de bord');
  protected readonly mobileMenuOpen = signal(false);
  protected readonly MenuIcon = Menu;
  protected readonly XIcon = X;
  protected readonly MoreIcon = MoreHorizontal;
  protected readonly UserCircle2Icon = UserCircle2;

  protected readonly bottomItems = [
    { label: 'Dashboard', route: '/dashboard', icon: LayoutDashboard },
    { label: 'Carte', route: '/map', icon: Map },
    { label: 'Véhicules', route: '/vehicles', icon: Truck },
    { label: 'Alertes', route: '/alerts', icon: Bell },
    { label: 'Plus', route: 'more', icon: MoreHorizontal },
  ];

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly onboarding = inject(OnboardingService);

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        const child = this.route.firstChild;
        const data = child?.snapshot.data ?? {};
        this.fullscreen.set(data['fullscreen'] === true);
        const title = typeof data['title'] === 'string' ? data['title'] : 'Tableau de bord';
        this.pageTitle.set(title);
      }
    });
    // V1.5 (Sprint J) — au mount du layout (= apres login), charger le profil
    // et ouvrir le wizard si onboardingCompletedAt est null.
    void this.onboarding.loadProfileAndDecide();
  }

  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  protected readonly network = inject(NetworkStatusService);

  protected readonly navItems = computed(() => {
    const isSuperAdmin = this.auth.user()?.role === 'SUPER_ADMIN';
    return [
      { label: 'Tableau de bord', route: '/dashboard', icon: LayoutDashboard },
      { label: 'Carte', route: '/map', icon: Map },
      { label: 'Véhicules', route: '/vehicles', icon: Truck },
      { label: 'Alertes', route: '/alerts', icon: Bell },
      { label: 'Géofences', route: '/geofences', icon: Shield },
      { label: 'Rapports', route: '/reports', icon: FileBarChart },
      ...(this.perms.can('drivers_view') ? [{ label: 'Conducteurs', route: '/drivers', icon: UserRound }] : []),
      ...(this.perms.can('users_view') ? [{ label: 'Utilisateurs', route: '/users', icon: Users }] : []),
      { label: 'Paramètres', route: '/settings', icon: Settings },
      // V1.6 — Section admin : visible uniquement pour SUPER_ADMIN.
      // /admin/trackers/:id/sampling et /fix-mode sont accessibles depuis
      // /admin/alerts (bouton "Inspecter") et la fiche vehicule, pas dans
      // le menu (necessitent un trackerId).
      ...(isSuperAdmin ? [
        { label: 'Centre d\'alertes', route: '/admin/alerts', icon: AlertTriangle },
        { label: 'Observabilité', route: '/admin/observability', icon: Activity },
        { label: 'Commandes tracker', route: '/admin/commands', icon: Terminal },
        { label: 'SMS & Backup', route: '/admin/sms', icon: MessageSquare },
      ] : []),
    ];
  });
}
