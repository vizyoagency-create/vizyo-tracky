import { getDefaultPermissions, permissionsForTargetRole } from '@vizyo/tracky-shared';

/**
 * Espace depot (2026-08) — les invariants d'A5 sur les comptes.
 *
 * Ces tests portent sur la SOURCE PARTAGEE, la ou la decision se prend. Les gardes
 * de route (users.controller, invitations.service) les appliquent ; l'isolation
 * reelle est verifiee de bout en bout par `prisma/verif-depot-http.sh`.
 */
describe('Comptes DEPOT — A5', () => {
  describe('un depot ne recoit jamais de capacite de flotte', () => {
    it('meme demandee explicitement par un FLEET_ADMIN', async () => {
      // Le cas qui compte : un fleet-admin detient TOUT. `clampPermissions` seul
      // bornait au granter, donc laissait passer. C'est le role CIBLE qui refuse.
      const ecrit = permissionsForTargetRole(
        'DEPOT',
        { vehicles_view: true, engine_control: true, reports_export: true, users_manage: true },
        { role: 'FLEET_ADMIN' },
      );
      expect(ecrit.vehicles_view).toBe(false);
      expect(ecrit.engine_control).toBe(false);
      expect(ecrit.reports_export).toBe(false);
      expect(ecrit.users_manage).toBe(false);
    });

    it('mais garde ses 4 capacites legitimes', async () => {
      const ecrit = permissionsForTargetRole('DEPOT', null, { role: 'FLEET_ADMIN' });
      expect(ecrit.missions_view).toBe(true);
      expect(ecrit.trips_view).toBe(true);
      expect(ecrit.mission_share).toBe(true);
      expect(ecrit.driver_contact_view).toBe(true);
    });

    it('les autres roles ne sont PAS affectes par ce verrou', async () => {
      // Le court-circuit ne doit toucher que les roles fermes : un VIEWER continue
      // de recevoir ce que son granter lui accorde.
      const ecrit = permissionsForTargetRole(
        'VIEWER',
        { reports_export: true },
        { role: 'FLEET_ADMIN' },
      );
      expect(ecrit.reports_export).toBe(true);
    });
  });

  describe('le changement de role est interdit dans les deux sens', () => {
    /** Reproduit la condition posee dans users.controller. */
    const changementInterdit = (ancien: string, nouveau: string) =>
      ancien !== nouveau && (ancien === 'DEPOT' || nouveau === 'DEPOT');

    it('DEPOT -> FLEET_MANAGER est refuse', () => {
      // Le sens qui compte : cela ouvrirait TOUTE la flotte d'un clic, depuis un
      // ecran qui ne le dit pas.
      expect(changementInterdit('DEPOT', 'FLEET_MANAGER')).toBe(true);
    });

    it('FLEET_MANAGER -> DEPOT est refuse aussi', () => {
      // L'autre sens compte : le compte garderait ses lignes UserVehicleAccess, ce
      // qu'A1 § 7 interdit — perimetre incoherent, mi-flotte mi-mission.
      expect(changementInterdit('FLEET_MANAGER', 'DEPOT')).toBe(true);
    });

    it.each([
      ['VIEWER', 'FLEET_MANAGER'],
      ['DRIVER', 'VIEWER'],
      ['NIGHT_WATCHMAN', 'VIEWER'],
    ])('%s -> %s reste autorise', (a, b) => {
      expect(changementInterdit(a, b)).toBe(false);
    });

    it('DEPOT -> DEPOT n\'est pas un changement', () => {
      expect(changementInterdit('DEPOT', 'DEPOT')).toBe(false);
    });
  });

  describe('le rôle est FERMÉ — la matrice ne peut rien lui accorder', () => {
    it('les defauts du DEPOT ne contiennent aucune capacite de flotte', () => {
      const p = getDefaultPermissions('DEPOT');
      const capacitesFlotte = [
        'vehicles_view', 'vehicles_edit', 'engine_control', 'privacy_manage',
        'reports_view', 'reports_export', 'users_view', 'alerts_view',
        'geofences_view', 'groups_view', 'agenda_view', 'reservations_view',
      ] as const;
      for (const c of capacitesFlotte) expect(p[c]).toBe(false);
    });
  });
});
