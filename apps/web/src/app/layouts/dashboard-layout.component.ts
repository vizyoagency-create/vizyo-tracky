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
} from 'lucide-angular';
import { ThemeToggleComponent } from '../shared/components/theme-toggle.component';
import { AlertsBellComponent } from '../shared/ui/alerts-bell/alerts-bell.component';
import { AuthService } from '../core/services/auth.service';
import { NetworkStatusService } from '../core/services/network-status.service';
import { PermissionsService } from '../core/services/permissions.service';
import { LogoComponent } from '../shared/ui/logo/logo.component';
import { InstallBannerComponent } from '../shared/ui/install-banner/install-banner.component';
import { ToastContainerComponent } from '../shared/ui/toast/toast-container.component';

@Component({
  selector: 'app-dashboard-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideAngularModule, ThemeToggleComponent, AlertsBellComponent, LogoComponent, InstallBannerComponent, ToastContainerComponent],
  template: `
    <div class="layout">
      @if (!network.online()) {
        <div class="offline-banner" role="status" aria-live="polite">
          <span class="offline-dot"></span>
          Hors-ligne — les donnees affichees datent de votre derniere session
        </div>
      }

      <!-- DESKTOP SIDEBAR -->
      <aside class="desktop-sidebar" [class.collapsed]="collapsed()">
        <div class="sidebar-top">
          <app-logo variant="icon" [size]="30" />
          @if (!collapsed()) {
            <span class="sidebar-brand">Vizyo <span class="text-tracky-light">Tracky</span></span>
          }
          <button (click)="collapsed.set(!collapsed())" class="sidebar-toggle">
            <lucide-icon [img]="MenuIcon" [size]="18"></lucide-icon>
          </button>
        </div>
        <nav class="sidebar-nav">
          @for (item of navItems(); track item.label) {
            <a [routerLink]="item.route" routerLinkActive="active" class="sidebar-link">
              <lucide-icon [img]="item.icon" [size]="20"></lucide-icon>
              @if (!collapsed()) { <span>{{ item.label }}</span> }
            </a>
          }
        </nav>
      </aside>

      <!-- MOBILE DRAWER OVERLAY -->
      @if (mobileMenuOpen()) {
        <div class="mobile-overlay" (click)="mobileMenuOpen.set(false)"></div>
        <aside class="mobile-drawer">
          <div class="drawer-top">
            <app-logo variant="icon" [size]="28" />
            <span class="sidebar-brand">Vizyo <span class="text-tracky-light">Tracky</span></span>
            <button (click)="mobileMenuOpen.set(false)" class="drawer-close">
              <lucide-icon [img]="XIcon" [size]="18"></lucide-icon>
            </button>
          </div>
          <nav class="drawer-nav">
            @for (item of navItems(); track item.label) {
              <a [routerLink]="item.route" routerLinkActive="active" class="drawer-link" (click)="mobileMenuOpen.set(false)">
                <lucide-icon [img]="item.icon" [size]="20"></lucide-icon>
                <span>{{ item.label }}</span>
              </a>
            }
          </nav>
        </aside>
      }

      <!-- MAIN CONTENT -->
      <div class="main-area">
        <header class="top-bar">
          <button (click)="mobileMenuOpen.set(true)" class="mobile-burger">
            <lucide-icon [img]="MenuIcon" [size]="20"></lucide-icon>
          </button>
          <h2 class="top-title">{{ pageTitle() }}</h2>
          <div class="top-actions">
            <app-alerts-bell />
            <app-theme-toggle />
          </div>
        </header>
        <main class="content" [class.fullscreen]="fullscreen()">
          <router-outlet />
        </main>
      </div>

      <!-- MOBILE BOTTOM BAR -->
      <nav class="bottom-bar">
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

    /* ─── TOP BAR ─── */
    .top-bar {
      display: flex; align-items: center; justify-content: space-between; height: 56px;
      border-bottom: 1px solid var(--border-subtle); background: var(--bg-secondary); shrink: 0;
      /* Safe-area : top pour notch/Dynamic Island en standalone, lateral pour iPhone Pro paysage */
      padding-top: env(safe-area-inset-top);
      padding-left: max(24px, env(safe-area-inset-left));
      padding-right: max(24px, env(safe-area-inset-right));
      box-sizing: content-box;
    }
    .mobile-burger { display: none }
    .top-title { font-size: 16px; font-weight: 700; color: var(--fg-primary) }
    .top-actions { display: flex; align-items: center; gap: 12px }

    /* ─── MAIN ─── */
    .main-area { flex: 1; display: flex; flex-direction: column; min-width: 0 }
    .content { flex: 1; padding: 24px; overflow: auto; position: relative }
    .content.fullscreen { padding: 0; overflow: hidden }

    /* ─── BOTTOM BAR ─── */
    .bottom-bar { display: none }

    /* ════════════════════════════════════════════════════════
       MOBILE (< 768px)
       ════════════════════════════════════════════════════════ */
    @media (max-width: 768px) {
      .desktop-sidebar { display: none }

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

      .top-bar { padding: 0 12px; height: 52px }
      .top-title { font-size: 14px }

      .content {
        padding: 16px;
        /* 60px bottom bar + safe-area inset + 24px breathing room */
        padding-bottom: calc(60px + env(safe-area-inset-bottom) + 24px);
      }
      .content.fullscreen {
        padding-bottom: calc(60px + env(safe-area-inset-bottom));
      }

      /* Bottom bar */
      .bottom-bar {
        display: flex; align-items: center; justify-content: space-around;
        position: fixed; bottom: 0; left: 0; right: 0; z-index: 7000;
        height: 60px; background: var(--bg-secondary); border-top: 1px solid var(--border-subtle);
        padding-bottom: env(safe-area-inset-bottom);
        padding-left: env(safe-area-inset-left);
        padding-right: env(safe-area-inset-right);
      }
      .bottom-item {
        display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 0; min-width: 56px;
        color: var(--fg-tertiary); text-decoration: none; font-size: 10px; font-weight: 600;
        background: transparent; border: none; cursor: pointer; transition: color .2s;
      }
      .bottom-item.active { color: var(--tracky-light) }
      .bottom-item:hover { color: var(--fg-secondary) }
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

  protected readonly bottomItems = [
    { label: 'Dashboard', route: '/dashboard', icon: LayoutDashboard },
    { label: 'Carte', route: '/map', icon: Map },
    { label: 'Véhicules', route: '/vehicles', icon: Truck },
    { label: 'Alertes', route: '/alerts', icon: Bell },
    { label: 'Plus', route: 'more', icon: MoreHorizontal },
  ];

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

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
  }

  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  protected readonly network = inject(NetworkStatusService);

  protected readonly navItems = computed(() => {
    return [
      { label: 'Tableau de bord', route: '/dashboard', icon: LayoutDashboard },
      { label: 'Carte', route: '/map', icon: Map },
      { label: 'Véhicules', route: '/vehicles', icon: Truck },
      { label: 'Alertes', route: '/alerts', icon: Bell },
      { label: 'Géofences', route: '/geofences', icon: Shield },
      { label: 'Rapports', route: '/reports', icon: FileBarChart },
      ...(this.perms.can('users_view') ? [{ label: 'Utilisateurs', route: '/users', icon: Users }] : []),
      { label: 'Paramètres', route: '/settings', icon: Settings },
      ...(this.auth.user()?.role === 'SUPER_ADMIN' ? [{ label: 'Observabilité', route: '/admin/observability', icon: Activity }] : []),
    ];
  });
}
