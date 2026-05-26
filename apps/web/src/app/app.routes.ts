import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { permissionGuard } from './core/guards/permission.guard';
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
    path: 'forgot-password',
    loadComponent: () =>
      import('./layouts/auth-layout.component').then((m) => m.AuthLayoutComponent),
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/auth/forgot-password.component').then((m) => m.ForgotPasswordComponent),
      },
    ],
  },
  {
    path: 'accept-invite',
    loadComponent: () =>
      import('./features/auth/accept-invite.component').then((m) => m.AcceptInviteComponent),
    data: { title: 'Accepter l\'invitation' },
  },
  {
    path: 'install',
    loadComponent: () =>
      import('./features/install/install-page.component').then((m) => m.InstallPageComponent),
    data: { title: 'Installer Vizyo Tracky' },
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
        canActivate: [permissionGuard('vehicles_view')],
        loadComponent: () =>
          import('./features/map/map.component').then((m) => m.MapComponent),
        data: { fullscreen: true, title: 'Carte' },
      },
      {
        path: 'vehicles',
        canActivate: [permissionGuard('vehicles_view')],
        loadComponent: () =>
          import('./features/vehicles/vehicles-list.component').then((m) => m.VehiclesListComponent),
        data: { title: 'Véhicules' },
      },
      {
        path: 'vehicles/:id',
        canActivate: [permissionGuard('vehicles_view')],
        loadComponent: () =>
          import('./features/vehicles/vehicle-detail.component').then((m) => m.VehicleDetailComponent),
        data: { title: 'Détail véhicule' },
      },
      {
        path: 'groups',
        canActivate: [permissionGuard('groups_view')],
        loadComponent: () =>
          import('./features/vehicle-groups/vehicle-groups.page').then((m) => m.VehicleGroupsPageComponent),
        data: { title: 'Groupes de vehicules' },
      },
      {
        path: 'alerts',
        canActivate: [permissionGuard('alerts_view')],
        loadComponent: () =>
          import('./features/alerts/alerts.component').then((m) => m.AlertsComponent),
        data: { title: 'Alertes' },
      },
      {
        path: 'geofences',
        canActivate: [permissionGuard('geofences_view')],
        loadComponent: () =>
          import('./features/geofences/geofences-list.component').then((m) => m.GeofencesListComponent),
        data: { title: 'Géofences' },
      },
      {
        path: 'reports',
        canActivate: [permissionGuard('reports_view')],
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
        path: 'users/overview',
        canActivate: [permissionGuard('users_view')],
        loadComponent: () =>
          import('./features/users/permissions-overview.component').then((m) => m.PermissionsOverviewComponent),
        data: { title: 'Vue d\'ensemble' },
      },
      {
        path: 'drivers',
        loadComponent: () =>
          import('./features/drivers/drivers-list.component').then((m) => m.DriversListComponent),
        data: { title: 'Conducteurs' },
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/settings/settings.component').then((m) => m.SettingsComponent),
        data: { title: 'Paramètres' },
      },
      {
        path: 'account',
        loadComponent: () =>
          import('./features/account/account.component').then((m) => m.AccountComponent),
        data: { title: 'Mon compte' },
      },
      {
        path: 'settings/alert-rules',
        canActivate: [permissionGuard('alerts_view')],
        loadComponent: () =>
          import('./features/settings/alert-rules.component').then((m) => m.AlertRulesComponent),
        data: { title: 'Regles de notification' },
      },
      {
        path: 'admin',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-hub.component').then((m) => m.AdminHubComponent),
        data: { title: 'Administration' },
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
        path: 'admin/auth-sync',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-auth-sync.component').then((m) => m.AdminAuthSyncComponent),
        data: { title: 'Sync Auth / Tracky' },
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
