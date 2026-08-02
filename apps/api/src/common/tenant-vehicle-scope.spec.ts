import { UserRole } from '@prisma/client';
import { NO_VEHICLE, tenantVehicleWhere } from './tenant-vehicle-scope';

/**
 * LE PIÈGE DU SENTINEL `'ALL'`.
 *
 * ── L'incident (2026-08-02) ──────────────────────────────────────────────────────────
 * Un FLEET_ADMIN de « cdef31 » voyait les véhicules de « mh cars » en cliquant sur une
 * station-service de la carte. Fuite de données entre deux clients.
 *
 * La cause n'était pas un `where` oublié mais une ambiguïté de vocabulaire :
 * `getAccessibleVehicleIds()` renvoie `'ALL'` pour un FLEET_ADMIN — dans l'intention
 * « tous les véhicules DE SA FLOTTE », lu par les appelants comme « aucun filtre » :
 *
 *     accessible === 'ALL' ? (fleetId ? { fleetId } : {}) : { vehicleId: { in: … } }
 *
 * Et comme les contrôleurs ne transmettent `fleetId` qu'aux SUPER_ADMIN — à juste titre,
 * un client ne choisit pas la flotte qu'il consulte — la branche `{}` était celle de tous
 * les clients. **Le filtre le plus permissif était atteint par le chemin le plus courant.**
 */
const fleetAdmin = { role: UserRole.FLEET_ADMIN, fleetId: 'cdef31' };
const superAdmin = { role: UserRole.SUPER_ADMIN, fleetId: null };

describe('tenantVehicleWhere', () => {
  describe('la règle non négociable', () => {
    it('⚠️ un FLEET_ADMIN est TOUJOURS borné à sa flotte — jamais de clause vide', () => {
      // LE test de la fuite. Avant, ce cas produisait `{}`.
      expect(tenantVehicleWhere('ALL', fleetAdmin)).toEqual({ fleetId: 'cdef31' });
    });

    it('⚠️ un FLEET_ADMIN ne peut pas consulter une AUTRE flotte via la query string', () => {
      // Le paramètre `fleetId` vient de l'URL. L'honorer pour un non-super-admin
      // transformerait le sélecteur de société en outil d'espionnage inter-clients.
      expect(tenantVehicleWhere('ALL', fleetAdmin, 'mh-cars')).toEqual({ fleetId: 'cdef31' });
    });

    it('aucun rôle non-super-admin ne produit de clause vide', () => {
      // Balayage : la clause vide est le seul résultat réellement dangereux.
      for (const role of [UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER, UserRole.NIGHT_WATCHMAN, UserRole.DRIVER]) {
        const where = tenantVehicleWhere('ALL', { role, fleetId: 'cdef31' });
        expect(where).not.toEqual({});
        expect(where).toEqual({ fleetId: 'cdef31' });
      }
    });
  });

  describe('le super-admin', () => {
    it('sans société choisie : périmètre illimité — le SEUL cas légitime', () => {
      expect(tenantVehicleWhere('ALL', superAdmin)).toEqual({});
    });

    it('avec une société choisie : borné à cette société', () => {
      expect(tenantVehicleWhere('ALL', superAdmin, 'mh-cars')).toEqual({ fleetId: 'mh-cars' });
    });

    it('une chaîne vide ne vaut pas « société choisie »', () => {
      // Une query string absente arrive parfois en `''`. La traiter comme un choix
      // produirait `{ fleetId: '' }`, qui ne matche rien : l'écran serait vide sans raison.
      expect(tenantVehicleWhere('ALL', superAdmin, '')).toEqual({});
    });
  });

  describe('le périmètre par véhicule', () => {
    it('l’emporte sur la flotte — une règle plus fine ne doit pas être élargie', () => {
      const where = tenantVehicleWhere(['v1', 'v2'], { role: UserRole.FLEET_MANAGER, fleetId: 'cdef31' });
      expect(where).toEqual({ vehicleId: { in: ['v1', 'v2'] } });
    });

    it('s’applique même à un super-admin dont l’accès serait restreint', () => {
      expect(tenantVehicleWhere(['v1'], superAdmin)).toEqual({ vehicleId: { in: ['v1'] } });
    });

    it('aucun véhicule accessible → matche ZÉRO ligne, jamais toutes', () => {
      // Un `in: []` matcherait zéro ligne lui aussi, mais se relit mal : est-ce voulu,
      // ou un oubli ? L'identifiant impossible dit l'intention.
      expect(tenantVehicleWhere([], fleetAdmin)).toEqual({ vehicleId: { in: [NO_VEHICLE] } });
    });
  });

  describe('fail-closed', () => {
    it('⚠️ un compte SANS flotte et non super-admin ne voit RIEN', () => {
      // Le seul défaut acceptable : un écran vide se signale tout seul, une fuite non.
      expect(tenantVehicleWhere('ALL', { role: UserRole.FLEET_ADMIN, fleetId: null })).toEqual({
        vehicleId: { in: [NO_VEHICLE] },
      });
    });

    it('même avec une société demandée dans l’URL', () => {
      expect(tenantVehicleWhere('ALL', { role: UserRole.VIEWER, fleetId: undefined }, 'mh-cars')).toEqual({
        vehicleId: { in: [NO_VEHICLE] },
      });
    });
  });
});
