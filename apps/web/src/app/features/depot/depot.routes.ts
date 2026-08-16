import type { Routes } from '@angular/router';

/**
 * Espace dépôt (2026-08) — les routes du rôle DEPOT.
 *
 * Quatre onglets, et rien d'autre : Carte live · Missions · Historique · Documents
 * (A3 § 1). Le dépôt n'est pas un utilisateur de la flotte, c'est un tiers en lecture
 * seule ; son menu ne promet donc que ce qu'il tient.
 *
 * ⚠️ **Aucun identifiant interne dans une URL** (A3 § 7, règle 3). Le détail d'une
 * mission ou d'un trajet s'ouvre en MODALE, jamais en route paramétrée : une URL
 * comme `/depot/missions/<uuid>` exposerait une clé de base — qu'on partage par
 * copier-coller, qu'on retrouve dans un historique de navigation, et qui invite à
 * énumérer. La plaque et la référence suffisent à désigner ce que le dépôt regarde.
 *
 * Cf. design/A3-ESPACE-DEPOT.md.
 */
export const DEPOT_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./depot-live.component').then((m) => m.DepotLiveComponent),
    data: { title: 'Carte live', fullscreen: true },
  },
  {
    path: 'missions',
    loadComponent: () => import('./depot-missions.component').then((m) => m.DepotMissionsComponent),
    data: { title: 'Mes missions' },
  },
  {
    path: 'history',
    loadComponent: () => import('./depot-history.component').then((m) => m.DepotHistoryComponent),
    data: { title: 'Historique' },
  },
  {
    path: 'documents',
    loadComponent: () => import('./depot-documents.component').then((m) => m.DepotDocumentsComponent),
    data: { title: 'Documents' },
  },
];
