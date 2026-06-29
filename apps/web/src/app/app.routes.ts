import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { permissionGuard } from './core/guards/permission.guard';
import { roleGuard } from './core/guards/role.guard';
import { superAdminGuard } from './core/guards/super-admin.guard';
import { watchmanChildGuard } from './core/guards/watchman.guard';

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
    // Sprint 3 — confine le veilleur de nuit à /vehicles* (allowlist default-deny).
    canActivateChild: [watchmanChildGuard],
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
        data: { title: 'Groupes de véhicules' },
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
        // Sprint 7 — Agenda (maintenance + incidents). Gaté agenda_view
        // (FLEET_ADMIN/SUPER_ADMIN bypass via PermissionsService.can).
        path: 'agenda',
        canActivate: [permissionGuard('agenda_view')],
        loadComponent: () =>
          import('./features/agenda/agenda.component').then((m) => m.AgendaComponent),
        data: { title: 'Agenda' },
      },
      {
        // Sprint 8 — Optimisation de flotte (dispo/activité + sous-utilisation). Gaté reservations_view
        // (FLEET_ADMIN/SUPER_ADMIN bypass via PermissionsService.can).
        path: 'optimisation',
        canActivate: [permissionGuard('reservations_view')],
        loadComponent: () =>
          import('./features/optimization/fleet-optimization.component').then((m) => m.FleetOptimizationComponent),
        data: { title: 'Optimisation' },
      },
      {
        path: 'users/overview',
        canActivate: [permissionGuard('users_view')],
        loadComponent: () =>
          import('./features/users/permissions-overview.component').then((m) => m.PermissionsOverviewComponent),
        data: { title: 'Vue d\'ensemble' },
      },
      {
        path: 'users',
        loadComponent: () =>
          import('./features/users/users-list.component').then((m) => m.UsersListComponent),
        data: { title: 'Utilisateurs' },
      },
      {
        path: 'drivers',
        loadComponent: () =>
          import('./features/drivers/drivers-list.component').then((m) => m.DriversListComponent),
        data: { title: 'Conducteurs' },
      },
      {
        // Vue client (FLEET_ADMIN) — consultation + reordonnancement du sens d'installation.
        path: 'installations',
        pathMatch: 'full',
        canActivate: [roleGuard('FLEET_ADMIN', 'SUPER_ADMIN')],
        loadComponent: () =>
          import('./features/installations/installations-client.component').then((m) => m.InstallationsClientComponent),
        data: { title: 'Suivi installation' },
      },
      {
        // Vue client (FLEET_ADMIN + delegues sims_view) du parc SIM de la flotte.
        path: 'sims',
        canActivate: [permissionGuard('sims_view')],
        loadComponent: () =>
          import('./features/sims/sims-client.component').then((m) => m.SimsClientComponent),
        data: { title: 'Cartes SIM' },
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
        // Sprint 4 — N2 « Mode assistance » (fleet-admin/client). Gaté audio_monitoring
        // (FLEET_ADMIN/SUPER_ADMIN bypassent ; le backend exige l'éligibilité N1). L'écran
        // affiche un message « non disponible » si la flotte n'est pas éligible.
        path: 'settings/audio-monitoring',
        canActivate: [roleGuard('FLEET_ADMIN', 'SUPER_ADMIN'), permissionGuard('audio_monitoring')],
        loadComponent: () =>
          import('./features/audio-monitoring/audio-activation.component').then((m) => m.AudioActivationComponent),
        data: { title: 'Mode assistance' },
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
        data: { title: 'Diagnostic & Tests' },
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
        path: 'admin/trackers',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-trackers.component').then((m) => m.AdminTrackersComponent),
        data: { title: 'Trackers (admin)' },
      },
      {
        path: 'admin/unknown-trackers',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-unknown-trackers.component').then(
            (m) => m.AdminUnknownTrackersComponent,
          ),
        data: { title: 'Boîtiers non reconnus' },
      },
      {
        path: 'admin/system',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/system-metrics/admin-system.component').then((m) => m.AdminSystemComponent),
        data: { title: 'Système VPS' },
      },
      {
        path: 'admin/activity',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/user-activity/admin-activity.component').then((m) => m.AdminActivityComponent),
        data: { title: 'Activité utilisateurs' },
      },
      {
        // Sprint 4 — N1 « flottes éligibles » (super-admin/prestataire) : autorise les
        // flottes au Mode assistance. SUPER_ADMIN only.
        path: 'admin/audio-eligibility',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/audio-monitoring/audio-eligibility.component').then((m) => m.AudioEligibilityComponent),
        data: { title: 'Audio — flottes éligibles' },
      },
      {
        // Sprint 6 — Rétention des positions (état global + par flotte + recalcul). SUPER_ADMIN.
        path: 'admin/retention',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-retention.component').then((m) => m.AdminRetentionComponent),
        data: { title: 'Rétention des données' },
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
        path: 'admin/trackers/:id',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-tracker-detail.component').then((m) => m.AdminTrackerDetailComponent),
        data: { title: 'Détail tracker' },
      },
      {
        path: 'admin/commands',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/tracker-commands/admin-commands.component').then((m) => m.AdminCommandsComponent),
        data: { title: 'Commandes tracker' },
      },
      {
        path: 'admin/installations',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/installations/installations-list.component').then((m) => m.InstallationsListComponent),
        data: { title: 'Plannings d\'installation' },
      },
      {
        path: 'admin/sims',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/sims/admin-sims.component').then((m) => m.AdminSimsComponent),
        data: { title: 'Cartes SIM (admin)' },
      },
      {
        path: 'admin/installations/:id',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/installations/installation-editor.component').then((m) => m.InstallationEditorComponent),
        data: { title: 'Planning d\'installation' },
      },
    ],
  },
  { path: '**', redirectTo: 'login' },
];
