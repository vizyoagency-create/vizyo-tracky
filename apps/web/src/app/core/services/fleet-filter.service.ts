import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
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
 * - No-op pour les non-SA : `matches()` renvoie toujours true et `selectedFleetId()`
 *   vaut null (ils n'ont qu'une seule flotte, deja scopee cote serveur), donc brancher
 *   ce service sur une page ne change rien pour eux.
 *
 * Cote donnees : la plupart des listes (vehicules, users, conducteurs,
 * geofences, groupes) sont deja renvoyees en entier au SA avec un `fleetId`
 * par ligne => le filtre est applique client-side via `matches(row.fleetId)`.
 * Les rapports passent en plus `selectedFleetId()` a l'API (`?fleetId=`, deja
 * supporte cote back).
 *
 * ── LE CHOIX EST CELUI DU NAVIGATEUR, PAS DU COMPTE (défaut latent trouvé le 29/09) ──────────────
 *
 * Le localStorage survit à la déconnexion. `selectedFleetId()` le rendait tel quel à TOUT compte :
 * un gestionnaire qui se connectait sur un navigateur où un super-admin avait choisi une société
 * héritait de celle d'un AUTRE client, et les pages l'envoyaient à l'API (`?fleetId=`). Les routes
 * qui refusent une société étrangère (agent d'agenda, sièges, liens de réservation…) répondaient 403,
 * avalé par l'écran : plus AUCUNE proposition de l'agent dans l'agenda du gestionnaire, sans un mot.
 * Désormais, pour un compte connecté qui n'est pas super-admin :
 *   1. `selectedFleetId()` vaut null — tout de suite, sans attendre aucun effet ;
 *   2. la valeur restée (mémoire et stockage) est effacée ;
 *   3. `set()` n'en pose pas de nouvelle.
 * Déconnecté, rien ne bouge : une page encore ouverte au moment de la déconnexion n'a pas à se
 * recharger pour une société que plus personne ne regarde, et un super-admin qui se reconnecte
 * retrouve la sienne.
 */
@Injectable({ providedIn: 'root' })
export class FleetFilterService {
  private readonly auth = inject(AuthService);
  private static readonly STORAGE_KEY = 'vizyo-fleet-filter';

  private readonly _selectedFleetId = signal<string | null>(this.readInitial());

  /** Un compte est connecté, et ce n'est pas un super-admin : le filtre n'existe pas pour lui. */
  private readonly autreCompte = computed(() => {
    const u = this.auth.user();
    return !!u && u.role !== 'SUPER_ADMIN';
  });

  /** Societe selectionnee (null = toutes). Lecture seule pour les consommateurs ; null hors super-admin. */
  readonly selectedFleetId = computed(() => (this.autreCompte() ? null : this._selectedFleetId()));

  /** True si un filtre societe est reellement actif (SA + une flotte choisie). */
  readonly isActive = computed(
    () => this.auth.user()?.role === 'SUPER_ADMIN' && this._selectedFleetId() !== null,
  );

  constructor() {
    // Point 2 : la société laissée par une session super-admin n'attend pas le suivant.
    effect(() => {
      if (this.autreCompte() && untracked(this._selectedFleetId) !== null) this.set(null);
    });
  }

  private readInitial(): string | null {
    try {
      return localStorage.getItem(FleetFilterService.STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }

  /** Definit (ou efface avec null) la societe filtree + persiste. Sans effet hors super-admin (point 3). */
  set(fleetId: string | null): void {
    if (fleetId !== null && this.autreCompte()) return;
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
