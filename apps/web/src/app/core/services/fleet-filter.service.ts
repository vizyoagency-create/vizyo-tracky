import { computed, inject, Injectable, signal } from '@angular/core';
import { AuthService } from './auth.service';

/**
 * Filtre flotte global (SUPER_ADMIN uniquement).
 *
 * Un SUPER_ADMIN a fleetId=null et voit TOUTES les societes. Ce service porte
 * la societe actuellement selectionnee dans le selecteur global du top-bar
 * (`<app-fleet-selector>`), et les pages "liste" s'y abonnent pour restreindre
 * les lignes affichees à cette flotte.
 *
 * - `selectedFleetId() === null` => "Toutes les societes" (aucun filtre).
 * - Persistant en localStorage : le choix survit a un reload / navigation.
 * - No-op pour les non-SA : `matches()` renvoie toujours true (ils n'ont
 *   qu'une seule flotte, deja scopee cote serveur), donc brancher ce service
 *   sur une page ne change rien pour eux.
 *
 * Cote donnees : la plupart des listes (vehicules, users, conducteurs,
 * geofences, groupes) sont deja renvoyees en entier au SA avec un `fleetId`
 * par ligne => le filtre est applique client-side via `matches(row.fleetId)`.
 * Les rapports passent en plus `selectedFleetId()` a l'API (`?fleetId=`, deja
 * supporte cote back).
 */
@Injectable({ providedIn: 'root' })
export class FleetFilterService {
  private readonly auth = inject(AuthService);
  private static readonly STORAGE_KEY = 'vizyo-fleet-filter';

  private readonly _selectedFleetId = signal<string | null>(this.readInitial());

  /** Societe selectionnee (null = toutes). Lecture seule pour les consommateurs. */
  readonly selectedFleetId = this._selectedFleetId.asReadonly();

  /** True si un filtre societe est reellement actif (SA + une flotte choisie). */
  readonly isActive = computed(
    () => this.auth.user()?.role === 'SUPER_ADMIN' && this._selectedFleetId() !== null,
  );

  private readInitial(): string | null {
    try {
      return localStorage.getItem(FleetFilterService.STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }

  /** Definit (ou efface avec null) la societe filtree + persiste. */
  set(fleetId: string | null): void {
    this._selectedFleetId.set(fleetId);
    try {
      if (fleetId) localStorage.setItem(FleetFilterService.STORAGE_KEY, fleetId);
      else localStorage.removeItem(FleetFilterService.STORAGE_KEY);
    } catch {
      /* stockage indispo (mode prive) : le filtre reste en memoire de session */
    }
  }

  /**
   * Une ligne portant `fleetId` doit-elle etre visible sous le filtre courant ?
   * - Non-SUPER_ADMIN : toujours true (scope serveur suffit).
   * - SA sans filtre : toujours true.
   * - SA avec filtre : true seulement si la ligne appartient a la flotte choisie.
   */
  matches(fleetId: string | null | undefined): boolean {
    if (this.auth.user()?.role !== 'SUPER_ADMIN') return true;
    const sel = this._selectedFleetId();
    if (!sel) return true;
    return fleetId === sel;
  }
}
