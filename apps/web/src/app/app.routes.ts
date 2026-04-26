import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { superAdminGuard } from './core/guards/super-admin.guard';

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
        data: { title: 'Tableau de bord' },
      },
      {
        path: 'map',
        loadComponent: () =>
          import('./features/map/map.component').then((m) => m.MapComponent),
        data: { fullscreen: true, title: 'Carte' },
      },
      {
        path: 'vehicles',
        loadComponent: () =>
          import('./features/vehicles/vehicles-list.component').then((m) => m.VehiclesListComponent),
        data: { title: 'Véhicules' },
      },
      {
        path: 'vehicles/:id',
        loadComponent: () =>
          import('./features/vehicles/vehicle-detail.component').then((m) => m.VehicleDetailComponent),
        data: { title: 'Détail véhicule' },
      },
      {
        path: 'alerts',
        loadComponent: () =>
          import('./features/alerts/alerts.component').then((m) => m.AlertsComponent),
        data: { title: 'Alertes' },
      },
      {
        path: 'geofences',
        loadComponent: () =>
          import('./features/geofences/geofences-list.component').then((m) => m.GeofencesListComponent),
        data: { title: 'Géofences' },
      },
      {
        path: 'reports',
        loadComponent: () =>
          import('./features/reports/reports.component').then((m) => m.ReportsComponent),
        data: { title: 'Rapports' },
      },
      {
        path: 'users',
        loadComponent: () =>
          import('./features/users/users-list.component').then((m) => m.UsersListComponent),
        data: { title: 'Utilisateurs' },
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/settings/settings.component').then((m) => m.SettingsComponent),
        data: { title: 'Paramètres' },
      },
      {
        path: 'admin/observability',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/observability.component').then((m) => m.ObservabilityComponent),
        data: { title: 'Observabilité' },
      },
      {
        path: 'admin/alerts',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-alerts.component').then((m) => m.AdminAlertsComponent),
        data: { title: 'Centre d\'alertes' },
      },
      {
        path: 'admin/sms',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-sms.component').then((m) => m.AdminSmsComponent),
        data: { title: 'SMS & Backup' },
      },
      {
        path: 'admin/trackers/:id/sampling',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-sampling.component').then((m) => m.AdminSamplingComponent),
        data: { title: 'Sampling adaptatif' },
      },
      {
        path: 'admin/trackers/:id/fix-mode',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-fix-mode.component').then((m) => m.AdminFixModeComponent),
        data: { title: 'Fix mode tracker' },
      },
      {
        path: 'admin/commands',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/tracker-commands/admin-commands.component').then((m) => m.AdminCommandsComponent),
        data: { title: 'Commandes tracker' },
      },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
