import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterOutlet, RouterLink, RouterLinkActive, NavigationEnd, Router } from '@angular/router';
import {
  LucideAngularModule,
  LayoutDashboard,
  Map,
  Bell,
  Shield,
  FileBarChart,
  Users,
  Settings,
  Menu,
} from 'lucide-angular';
import { ThemeToggleComponent } from '../shared/components/theme-toggle.component';

@Component({
  selector: 'app-dashboard-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideAngularModule, ThemeToggleComponent],
  template: `
    <div class="h-screen flex bg-bg-primary overflow-hidden">
      <aside
        class="flex flex-col border-r border-border-subtle bg-bg-secondary transition-all duration-300 ease-tracky shrink-0"
        [class]="collapsed() ? 'w-16' : 'w-60'"
      >
        <div class="flex items-center gap-3 px-4 h-16 border-b border-border-subtle">
          @if (!collapsed()) {
            <span class="text-lg font-display font-bold bg-tracky-gradient bg-clip-text text-transparent">
              Vizyo Tracky
            </span>
          }
          <button
            (click)="collapsed.set(!collapsed())"
            class="ml-auto flex items-center justify-center w-8 h-8 rounded-lg
                   text-fg-tertiary hover:text-fg-primary hover:bg-bg-tertiary
                   transition-colors duration-200 cursor-pointer"
          >
            <lucide-icon [img]="Menu" [size]="18"></lucide-icon>
          </button>
        </div>

        <nav class="flex-1 flex flex-col gap-1 p-2 mt-2">
          @for (item of navItems; track item.label) {
            <a
              [routerLink]="item.route"
              routerLinkActive="bg-bg-tertiary text-tracky-light border-border-strong"
              class="flex items-center gap-3 px-3 py-2.5 rounded-xl
                     text-fg-secondary border border-transparent
                     hover:bg-bg-tertiary hover:text-fg-primary
                     transition-all duration-200"
            >
              <lucide-icon [img]="item.icon" [size]="20"></lucide-icon>
              @if (!collapsed()) {
                <span class="text-sm font-medium">{{ item.label }}</span>
              }
            </a>
          }
        </nav>
      </aside>

      <div class="flex-1 flex flex-col min-w-0">
        <header class="flex items-center justify-between px-6 h-16 border-b border-border-subtle bg-bg-secondary shrink-0">
          <h2 class="text-lg font-display font-semibold text-fg-primary">Tableau de bord</h2>
          <div class="flex items-center gap-3">
            <app-theme-toggle />
          </div>
        </header>
        <main class="flex-1 relative" [class]="fullscreen() ? 'overflow-hidden' : 'p-6 overflow-auto'">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
})
export class DashboardLayoutComponent {
  protected readonly collapsed = signal(false);
  protected readonly fullscreen = signal(false);
  protected readonly Menu = Menu;

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        const child = this.route.firstChild;
        this.fullscreen.set(child?.snapshot.data?.['fullscreen'] === true);
      }
    });
  }

  protected readonly navItems = [
    { label: 'Tableau de bord', route: '/dashboard', icon: LayoutDashboard },
    { label: 'Carte', route: '/map', icon: Map },
    { label: 'Alertes', route: '/alerts', icon: Bell },
    { label: 'Geofences', route: '/geofences', icon: Shield },
    { label: 'Rapports', route: '/reports', icon: FileBarChart },
    { label: 'Utilisateurs', route: '/users', icon: Users },
    { label: 'Parametres', route: '/settings', icon: Settings },
  ];
}
