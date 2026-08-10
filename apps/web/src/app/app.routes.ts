import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { anyPermissionGuard, permissionGuard } from './core/guards/permission.guard';
import { roleGuard } from './core/guards/role.guard';
import { superAdminGuard } from './core/guards/super-admin.guard';
import { watchmanChildGuard } from './core/guards/watchman.guard';
import { driverAwayFromDashboardGuard } from './core/guards/driver.guard';
import { depotChildGuard, depotRoleGuard } from './core/guards/depot.guard';

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
    // Prise de RDV en ligne — page PUBLIQUE (hors auth). Token porté par l'URL.
    path: 'book/:token',
    loadComponent: () =>
      import('./features/booking/public-booking.component').then((m) => m.PublicBookingComponent),
    data: { title: 'Réserver un créneau d\'installation' },
  },
  {
    // P4 — Demande de réservation de véhicule (public, hors auth). Token porté par l'URL.
    path: 'reserve/:token',
    loadComponent: () =>
      import('./features/booking/public-reservation.component').then((m) => m.PublicReservationComponent),
    data: { title: 'Demander un véhicule' },
  },
  {
    // feat/comptes-conducteurs (4b) — déverrouillage conducteur via QR. Page focalisée ;
    // route publique mais l'API exige la session (401 → « connectez-vous »). Token en ?token=.
    path: 'driver/unlock',
    loadComponent: () =>
      import('./features/drivers/driver-unlock.component').then((m) => m.DriverUnlockComponent),
    data: { title: 'Déverrouiller un véhicule' },
  },
  {
    // feat/comptes-conducteurs (6) — espace conducteur « Mes véhicules » (rôle DRIVER).
    // Authentifié, shell focalisé (hors app d'admin). Déverrouillage in-app par véhicule.
    path: 'driver',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/drivers/driver-home.component').then((m) => m.DriverHomeComponent),
    data: { title: 'Mes véhicules' },
  },
  {
    path: '',
    loadComponent: () =>
      import('./layouts/dashboard-layout.component').then((m) => m.DashboardLayoutComponent),
    // authGuard : session requise. driverAwayFromDashboardGuard : un conducteur (DRIVER) est
    // renvoyé vers son espace `/driver` (il n'entre jamais dans l'app d'admin).
    canActivate: [authGuard, driverAwayFromDashboardGuard],
    // Sprint 3 — confine le veilleur de nuit à /vehicles* (allowlist default-deny).
    // Espace dépôt (2026-08) — confine le compte DEPOT à /depot* (+ /account).
    canActivateChild: [watchmanChildGuard, depotChildGuard],
    children: [
      {
        // Espace dépôt (2026-08) — l'espace du donneur d'ordre. Vit DANS le shell :
        // A1 § 5 lui donne 4 entrées de navigation et la marque du transporteur.
        // `depotRoleGuard` referme l'entrée : un gestionnaire qui s'y égarerait ne
        // verrait qu'un espace vide et incompréhensible.
        path: 'depot',
        canActivate: [depotRoleGuard],
        loadChildren: () => import('./features/depot/depot.routes').then((m) => m.DEPOT_ROUTES),
        // Lot A3 — le titre est porté par CHAQUE onglet (Carte live · Mes missions ·
        // Historique · Documents). Le shell lit `route.firstChild`, donc cette entrée :
        // le laisser à « Mes missions » afficherait ce titre sur les quatre écrans.
        data: { title: 'Suivi de livraison' },
      },
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
        // Lot 0 intégration partenaire (2026-07-22) — écran « Intégrations » du client.
        // C'est ICI que vit l'interrupteur : le fleet-admin choisit ce qui est partagé
        // avec l'application partenaire et peut tout couper à tout moment.
        path: 'integrations',
        canActivate: [permissionGuard('integrations_manage')],
        loadComponent: () =>
          import('./features/integrations/integrations.component').then((m) => m.IntegrationsComponent),
        data: { title: 'Intégrations' },
      },
      {
        // Demande CDEF (2026-07) — Page flotte « Horaires » (vue d'ensemble + actions de masse).
        // Réservée aux détenteurs de `schedules_manage` (fleet-admin par défaut, accordable).
        path: 'fleet-schedules',
        canActivate: [permissionGuard('schedules_manage')],
        loadComponent: () =>
          import('./features/fleet-schedules/fleet-schedules.component').then((m) => m.FleetSchedulesComponent),
        data: { title: 'Horaires flotte' },
      },
      {
        // Lot 2 RGPD (2026-07-21) — « Couverture vie privée » : rend VISIBLE quels véhicules ne sont
        // pas protégés hors temps de travail. Gate `privacy_manage` : porté nativement par les
        // super/fleet-admins, et accordable par le fleet-admin à un gestionnaire ou un lecteur.
        path: 'privacy-coverage',
        canActivate: [permissionGuard('privacy_manage')],
        loadComponent: () =>
          import('./features/privacy/privacy-coverage.component').then((m) => m.PrivacyCoverageComponent),
        data: { title: 'Couverture vie privée' },
      },
      {
        // Lieux clés (2026-07) — stations-service validées par la flotte + parkings /
        // stationnements récurrents. Lecture `places_view` ; la gestion (validation d'une
        // station, pose d'un parking) est gardée finement par `places_manage` dans la page.
        path: 'places',
        canActivate: [permissionGuard('places_view')],
        loadComponent: () =>
          import('./features/places/places.component').then((m) => m.PlacesComponent),
        data: { title: 'Lieux clés' },
      },
      {
        // Consolidation IA : « Groupes » est un onglet de la page Véhicules.
        // Redirection (deep-link onglet) pour conserver les anciens liens / raccourcis PWA.
        path: 'groups',
        pathMatch: 'full',
        redirectTo: () => inject(Router).parseUrl('/vehicles?tab=groups'),
      },
      {
        // Consolidation IA : Alertes héberge aussi l'onglet Géofences → la garde
        // accepte l'une OU l'autre permission (les onglets se gèrent finement dedans).
        path: 'alerts',
        canActivate: [anyPermissionGuard('alerts_view', 'geofences_view')],
        loadComponent: () =>
          import('./features/alerts/alerts.component').then((m) => m.AlertsComponent),
        data: { title: 'Alertes' },
      },
      {
        // Consolidation IA : « Géofences » est un onglet de la page Alertes
        // (zones qui déclenchent des alertes). Redirection (deep-link onglet).
        path: 'geofences',
        pathMatch: 'full',
        redirectTo: () => inject(Router).parseUrl('/alerts?tab=geofences'),
      },
      {
        path: 'reports',
        canActivate: [permissionGuard('reports_view')],
        loadComponent: () =>
          import('./features/reports/reports.component').then((m) => m.ReportsComponent),
        data: { title: 'Rapports' },
      },
      {
        // Notation — classement noté du score de conduite (véhicules / conducteurs / groupes).
        path: 'scores',
        canActivate: [permissionGuard('reports_view')],
        loadComponent: () =>
          import('./features/trip-analysis/driving-scores.component').then((m) => m.DrivingScoresComponent),
        data: { title: 'Scores de conduite' },
      },
      {
        // Sprint 7 + Sprint 9 (consolidation) — Agenda = hub calendrier unique : maintenance,
        // incidents, réservations, optimisation et copilote IA réunis (ouverts en feuilles depuis
        // le calendrier). Gaté large pour ne pas régresser l'accès des délégués qui n'avaient que
        // reservations_*/ai_optimize ; chaque action interne reste gardée par sa permission.
        // Espace dépôt (2026-08) — `missions_view` ajoutée à la liste. L'onglet Missions
        // vit DANS l'agenda (décision client, A2 § intro), mais un FLEET_MANAGER a
        // `missions_manage: true` et `agenda_view: false` PAR DÉFAUT : sans cette
        // permission ici, le rôle qui possède les missions ne pouvait pas atteindre son
        // propre écran. Trouvé en testant l'écran, invisible en test unitaire.
        path: 'agenda',
        canActivate: [anyPermissionGuard('agenda_view', 'reservations_view', 'reservations_request', 'ai_optimize', 'missions_view')],
        loadComponent: () =>
          import('./features/agenda/agenda.component').then((m) => m.AgendaComponent),
        data: { title: 'Agenda' },
      },
      // Sprint 9 (consolidation) — anciennes pages fondues dans l'Agenda → redirections (liens conservés).
      { path: 'optimisation', redirectTo: 'agenda', pathMatch: 'full' },
      { path: 'reservations', redirectTo: 'agenda', pathMatch: 'full' },
      { path: 'ia', redirectTo: 'agenda', pathMatch: 'full' },
      {
        path: 'users/overview',
        canActivate: [permissionGuard('users_view')],
        loadComponent: () =>
          import('./features/users/permissions-overview.component').then((m) => m.PermissionsOverviewComponent),
        data: { title: 'Vue d\'ensemble' },
      },
      {
        path: 'users',
        // ⚠️ CETTE GARDE MANQUAIT alors que sa voisine `users/overview` l'avait : la liste
        // des utilisateurs (noms, e-mails, rôles, téléphones) s'ouvrait à qui tapait l'URL,
        // sans permission `users_view`. L'API refusait bien la requête — mais l'écran, lui,
        // s'affichait et transformait ce 403 en « Aucun utilisateur dans votre flotte ».
        // Deux défauts qui se couvraient l'un l'autre : la garde absente ne se voyait pas.
        canActivate: [permissionGuard('users_view')],
        loadComponent: () =>
          import('./features/users/users-list.component').then((m) => m.UsersListComponent),
        data: { title: 'Utilisateurs' },
      },
      {
        // Consolidation IA : « Conducteurs » est un onglet de la page Utilisateurs.
        // Redirection (deep-link onglet) pour conserver les anciens liens.
        path: 'drivers',
        pathMatch: 'full',
        redirectTo: () => inject(Router).parseUrl('/users?tab=drivers'),
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
        path: 'admin/vps',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-vps.component').then((m) => m.AdminVpsComponent),
        data: { title: 'VPS — performances & données' },
      },
      {
        path: 'admin/sms',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-sms.component').then((m) => m.AdminSmsComponent),
        data: { title: 'SMS & Backup' },
      },
      {
        path: 'admin/emails',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-emails.component').then((m) => m.AdminEmailsComponent),
        data: { title: 'E-mails' },
      },
      {
        // D4 + Phase 3 (chantier commercial) — abonnements clients + grille tarifaire publique.
        // Lot 0 intégration partenaire — pilotage plateforme. Porte le levier
        // commercial : suspendre un client qui ne paye pas, sans qu'il puisse le
        // rétablir lui-même.
        path: 'admin/partner-links',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-partner-links.component').then(
            (m) => m.AdminPartnerLinksComponent,
          ),
        data: { title: 'Intégrations (admin)' },
      },
      {
        path: 'admin/subscriptions',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/billing/admin-subscriptions.component').then((m) => m.AdminSubscriptionsComponent),
        data: { title: 'Abonnements & tarifs' },
      },
      {
        path: 'admin/consent',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/consent-admin/consent-admin.component').then((m) => m.ConsentAdminComponent),
        data: { title: 'Consentements RGPD' },
      },
      {
        path: 'admin/security',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/security-admin/security-admin.component').then((m) => m.SecurityAdminComponent),
        data: { title: 'Sécurité & connexions' },
      },
      {
        path: 'admin/installation-bookings',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-installation-bookings.component').then((m) => m.AdminInstallationBookingsComponent),
        data: { title: 'Réservations d\'installation' },
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
        // Centre de notifications — ce qui est parti, ce qui a été RETENU (avec son motif),
        // et à qui. Né du push d'alerte resté mort des mois sans que personne ne le voie,
        // faute d'un écran où le constater. SUPER_ADMIN uniquement (données cross-flotte).
        path: 'admin/notifications',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-notifications.component').then(
            (m) => m.AdminNotificationsComponent,
          ),
        data: { title: 'Centre de notifications' },
      },
      {
        // Observabilité du trafic API public (LP / Maestroo / API / Webhook) + intelligence IP
        // (connues vs inconnues, détection de scan/bot). SUPER_ADMIN.
        path: 'admin/api-traffic',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/admin-api-traffic.component').then((m) => m.AdminApiTrafficComponent),
        data: { title: 'Trafic API & Sources' },
      },
      {
        // Espace « Activité de la flotte » — FLEET_ADMIN (+ super-admin support). Scopé flotte
        // côté serveur, exclut les rôles élevés. Coupures/rallumages moteur + présence + historique.
        path: 'fleet-admin/activity',
        pathMatch: 'full',
        canActivate: [roleGuard('FLEET_ADMIN', 'SUPER_ADMIN')],
        loadComponent: () =>
          import('./features/fleet-activity/fleet-activity.component').then((m) => m.FleetActivityComponent),
        data: { title: 'Activité de la flotte' },
      },
      {
        // Palier « Coûts IA » — supervision des dépenses du copilote IA. Super-admin (transverse)
        // + fleet-admin (scopé à sa société côté serveur : visibilité « qui consomme quoi »).
        path: 'admin/ai-usage',
        pathMatch: 'full',
        canActivate: [roleGuard('SUPER_ADMIN', 'FLEET_ADMIN')],
        loadComponent: () =>
          import('./features/observability/admin-ai-usage.component').then((m) => m.AdminAiUsageComponent),
        data: { title: 'Coûts IA' },
      },
      {
        // Automatisation trajets — cron « recalcul → analyse → récit IA » pour toutes les flottes. SUPER_ADMIN.
        path: 'admin/trip-automation',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/trip-analysis/trip-automation.component').then((m) => m.TripAutomationComponent),
        data: { title: 'Automatisation des trajets' },
      },
      {
        // Automatisation des analyses de lieux — dépense récurrente sous plafonds. SUPER_ADMIN.
        path: 'admin/place-automation',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/places/place-automation.component').then((m) => m.PlaceAutomationComponent),
        data: { title: 'Analyses de lieux automatiques' },
      },
      {
        // Demande CDEF (2026-07) — Inventaire des tâches de fond (crons/timers) + prochain lancement. SUPER_ADMIN.
        path: 'admin/background-tasks',
        pathMatch: 'full',
        canActivate: [superAdminGuard],
        loadComponent: () =>
          import('./features/observability/background-tasks/background-tasks.component').then((m) => m.BackgroundTasksComponent),
        data: { title: 'Automatisations & tâches de fond' },
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
