import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'login',
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./layouts/auth-layout.component').then((m) => m.AuthLayoutComponent),
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/auth/login.component').then((m) => m.LoginComponent),
      },
    ],
  },
  {
    path: '',
    loadComponent: () =>
      import('./layouts/dashboard-layout.component').then((m) => m.DashboardLayoutComponent),
    canActivate: [authGuard],
    children: [
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'map',
        loadComponent: () =>
          import('./features/map/map.component').then((m) => m.MapComponent),
        data: { fullscreen: true },
      },
      {
        path: 'vehicles/:id',
        loadComponent: () =>
          import('./features/vehicles/vehicle-detail.component').then((m) => m.VehicleDetailComponent),
      },
      {
        path: 'alerts',
        loadComponent: () =>
          import('./features/alerts/alerts.component').then((m) => m.AlertsComponent),
      },
      {
        path: 'geofences',
        loadComponent: () =>
          import('./features/placeholder/placeholder.component').then((m) => m.PlaceholderComponent),
        data: { title: 'Geofences' },
      },
      {
        path: 'reports',
        loadComponent: () =>
          import('./features/placeholder/placeholder.component').then((m) => m.PlaceholderComponent),
        data: { title: 'Rapports' },
      },
      {
        path: 'users',
        loadComponent: () =>
          import('./features/placeholder/placeholder.component').then((m) => m.PlaceholderComponent),
        data: { title: 'Utilisateurs' },
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/settings/settings.component').then((m) => m.SettingsComponent),
      },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
