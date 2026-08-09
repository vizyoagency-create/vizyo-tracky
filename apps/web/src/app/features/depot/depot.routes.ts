import type { Routes } from '@angular/router';

/**
 * Espace dépôt (2026-08) — les routes du rôle DEPOT.
 *
 * Lot A1 : la route d'accueil seule, avec son état vide. Les quatre onglets
 * (Carte live · Missions · Historique · Documents) sont livrés par le lot A3, une
 * fois l'isolation prouvée par les 12 tests d'A1 § 8.
 *
 * Cf. design/A3-ESPACE-DEPOT.md.
 */
export const DEPOT_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./depot-home.component').then((m) => m.DepotHomeComponent),
    data: { title: 'Mes missions' },
  },
];
