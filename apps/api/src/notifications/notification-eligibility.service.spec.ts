import { UserRole } from '@prisma/client';
import { NotificationEligibilityService } from './notification-eligibility.service';

/**
 * A-T-IL LE DROIT DE SAVOIR ? — le filtre qui manquait à toute la chaîne de notification.
 *
 * ── Ce que ces tests verrouillent (audit du 2026-08-02) ──────────────────────────────
 * Deux modèles d'autorisation coexistaient sans se parler : les permissions gardaient les
 * routes HTTP, un booléen auto-réglable gardait les notifications. Résultat mesuré : la
 * MÊME alerte était refusée en HTTP (403 sur `GET /alerts`) et servie sans contrôle en
 * push, en e-mail et en temps réel — titre, plaque et position comprises.
 *
 * Le compte type en production : `standard@cdef31.org`, FLEET_MANAGER, `alerts_view: false`.
 */
function build(over: {
  users?: Array<Record<string, unknown>>;
  access?: Array<Record<string, unknown>>;
  assignments?: Array<Record<string, unknown>>;
  usersThrow?: Error;
} = {}) {
  const userFindMany = over.usersThrow
    ? jest.fn().mockRejectedValue(over.usersThrow)
    : jest.fn().mockResolvedValue(over.users ?? []);
  const accessFindMany = jest.fn().mockResolvedValue(over.access ?? []);
  const assignFindMany = jest.fn().mockResolvedValue(over.assignments ?? []);
  const prisma = {
    user: { findMany: userFindMany },
    userVehicleAccess: { findMany: accessFindMany },
    vehicleGroupAssignment: { findMany: assignFindMany },
  };
  return {
    svc: new NotificationEligibilityService(prisma as never),
    userFindMany,
    accessFindMany,
    assignFindMany,
  };
}

describe('NotificationEligibilityService', () => {
  describe('le droit de base', () => {
    it('⚠️ un FLEET_MANAGER sans `alerts_view` est ECARTE — le cas de production', async () => {
      const t = build({
        users: [{ id: 'fm', role: UserRole.FLEET_MANAGER, permissions: { alerts_view: false } }],
      });
      const v = await t.svc.check(['fm'], 'v1');
      expect(v.get('fm')).toBe('no_permission');
    });

    it('le même compte AVEC la permission passe', async () => {
      const t = build({
        users: [{ id: 'fm', role: UserRole.FLEET_MANAGER, permissions: { alerts_view: true } }],
      });
      expect((await t.svc.check(['fm'], 'v1')).get('fm')).toBe('ok');
    });

    it('un NIGHT_WATCHMAN est écarté par son DÉFAUT DE RÔLE, sans réglage explicite', async () => {
      // Son set par défaut porte `alerts_view: false`. Le filtre ne doit pas exiger une
      // ligne explicite pour refuser : l'absence de permission EST un refus.
      const t = build({ users: [{ id: 'nw', role: UserRole.NIGHT_WATCHMAN, permissions: null }] });
      expect((await t.svc.check(['nw'], 'v1')).get('nw')).toBe('no_permission');
    });

    it('un DRIVER est écarté par son défaut de rôle', async () => {
      const t = build({ users: [{ id: 'dr', role: UserRole.DRIVER, permissions: null }] });
      expect((await t.svc.check(['dr'], 'v1')).get('dr')).toBe('no_permission');
    });

    it('les administrateurs passent sans consulter leur périmètre', async () => {
      // Court-circuit identique à `PermissionsResolverService.isAdmin`. Deux réponses
      // différentes à « a-t-il le droit ? » selon le canal seraient pires que pas de filtre.
      const t = build({
        users: [
          { id: 'sa', role: UserRole.SUPER_ADMIN, permissions: null },
          { id: 'fa', role: UserRole.FLEET_ADMIN, permissions: null },
        ],
      });
      const v = await t.svc.check(['sa', 'fa'], 'v1');
      expect(v.get('sa')).toBe('ok');
      expect(v.get('fa')).toBe('ok');
      expect(t.accessFindMany).not.toHaveBeenCalled();
    });

    it('⚠️ un FLEET_ADMIN qui s’est vu RETIRER `alerts_view` passe quand même', async () => {
      // Comportement ASSUMÉ, pas un oubli : le court-circuit administrateur reproduit
      // exactement `PermissionsResolverService.isAdmin`, qui gouverne déjà les routes HTTP.
      // Diverger ici ferait qu'un même compte serait autorisé à l'écran et refusé en
      // notification — l'incohérence qu'on vient de supprimer, remise à l'envers.
      const t = build({
        users: [{ id: 'fa', role: UserRole.FLEET_ADMIN, permissions: { alerts_view: false } }],
      });
      expect((await t.svc.check(['fa'], 'v1')).get('fa')).toBe('ok');
    });
  });

  describe('le périmètre véhicule', () => {
    const restreint = { id: 'fm', role: UserRole.FLEET_MANAGER, permissions: { alerts_view: true } };

    it('⚠️ véhicule hors périmètre → `out_of_scope`, motif DISTINCT du refus de droit', async () => {
      // Les deux se corrigent à des endroits différents : élargir le périmètre, ou
      // accorder une permission. Les confondre rend le diagnostic impossible.
      const t = build({
        users: [restreint],
        access: [{ userId: 'fm', accessType: 'VEHICLE', vehicleId: 'autre', groupId: null, permissions: null }],
      });
      expect((await t.svc.check(['fm'], 'v1')).get('fm')).toBe('out_of_scope');
    });

    it('véhicule dans le périmètre → passe', async () => {
      const t = build({
        users: [restreint],
        access: [{ userId: 'fm', accessType: 'VEHICLE', vehicleId: 'v1', groupId: null, permissions: null }],
      });
      expect((await t.svc.check(['fm'], 'v1')).get('fm')).toBe('ok');
    });

    it('périmètre ALL → tout véhicule passe', async () => {
      const t = build({
        users: [restreint],
        access: [{ userId: 'fm', accessType: 'ALL', vehicleId: null, groupId: null, permissions: null }],
      });
      expect((await t.svc.check(['fm'], 'v1')).get('fm')).toBe('ok');
    });

    it('périmètre par GROUPE : le véhicule appartenant au groupe passe', async () => {
      const t = build({
        users: [restreint],
        access: [{ userId: 'fm', accessType: 'GROUP', vehicleId: null, groupId: 'g1', permissions: null }],
        assignments: [{ groupId: 'g1' }],
      });
      expect((await t.svc.check(['fm'], 'v1')).get('fm')).toBe('ok');
    });

    it('périmètre par GROUPE : un véhicule hors du groupe est écarté', async () => {
      const t = build({
        users: [restreint],
        access: [{ userId: 'fm', accessType: 'GROUP', vehicleId: null, groupId: 'g1', permissions: null }],
        assignments: [], // ce véhicule n'est dans aucun groupe accessible
      });
      expect((await t.svc.check(['fm'], 'v1')).get('fm')).toBe('out_of_scope');
    });

    it('les permissions du PÉRIMÈTRE écrasent celles du compte', async () => {
      // Compte à `alerts_view: false`, mais le scope qui couvre ce véhicule l'accorde.
      const t = build({
        users: [{ id: 'fm', role: UserRole.FLEET_MANAGER, permissions: { alerts_view: false } }],
        access: [{ userId: 'fm', accessType: 'VEHICLE', vehicleId: 'v1', groupId: null, permissions: { alerts_view: true } }],
      });
      expect((await t.svc.check(['fm'], 'v1')).get('fm')).toBe('ok');
    });

    it('un scope qui RETIRE la permission sur ce véhicule écarte, même si le compte l’a', async () => {
      const t = build({
        users: [{ id: 'fm', role: UserRole.FLEET_MANAGER, permissions: { alerts_view: true } }],
        access: [{ userId: 'fm', accessType: 'VEHICLE', vehicleId: 'v1', groupId: null, permissions: { alerts_view: false } }],
      });
      expect((await t.svc.check(['fm'], 'v1')).get('fm')).toBe('no_permission');
    });

    it('alerte SANS véhicule : le périmètre ne s’applique pas, seul le droit compte', async () => {
      // Une alerte de flotte n'a rien à cadrer. Appliquer le périmètre reviendrait à la
      // taire pour tout compte restreint — alors qu'elle ne concerne aucun véhicule précis.
      const t = build({
        users: [restreint],
        access: [{ userId: 'fm', accessType: 'VEHICLE', vehicleId: 'autre', groupId: null, permissions: null }],
      });
      expect((await t.svc.check(['fm'], null)).get('fm')).toBe('ok');
      expect(t.assignFindMany).not.toHaveBeenCalled();
    });
  });

  describe('robustesse', () => {
    it('⚠️ panne de lecture → on écarte TOUT LE MONDE (fail-closed)', async () => {
      // À l'inverse de l'anti-spam, qui laisse passer en cas de panne. Son pire cas est
      // une notification de trop ; ici c'est la divulgation d'une alerte — plaque et
      // position — à quelqu'un qui n'y a pas droit. Une panne ne doit jamais ÉLARGIR
      // une audience.
      const t = build({ usersThrow: new Error('base indisponible') });
      const v = await t.svc.check(['a', 'b'], 'v1');
      expect(v.get('a')).toBe('no_permission');
      expect(v.get('b')).toBe('no_permission');
    });

    it('un compte disparu entre-temps n’est pas autorisé par défaut', async () => {
      const t = build({ users: [] });
      expect((await t.svc.check(['fantome'], 'v1')).get('fantome')).toBe('no_permission');
    });

    it('aucun destinataire : aucune requête', async () => {
      const t = build();
      expect((await t.svc.check([], 'v1')).size).toBe(0);
      expect(t.userFindMany).not.toHaveBeenCalled();
    });

    it('les doublons d’identifiant ne produisent qu’une seule évaluation', async () => {
      const t = build({ users: [{ id: 'fm', role: UserRole.FLEET_MANAGER, permissions: { alerts_view: true } }] });
      await t.svc.check(['fm', 'fm', 'fm'], 'v1');
      expect(t.userFindMany.mock.calls[0][0].where.id.in).toEqual(['fm']);
    });

    it('deux requêtes au maximum quel que soit le nombre de destinataires', async () => {
      // Le dispatch tourne des centaines de fois par jour : une requête par destinataire
      // serait une régression de charge, pas un détail.
      const many = Array.from({ length: 25 }, (_, i) => ({
        id: `u${i}`,
        role: UserRole.FLEET_MANAGER,
        permissions: { alerts_view: true },
      }));
      const t = build({ users: many });
      await t.svc.check(many.map((u) => u.id), null);
      expect(t.userFindMany).toHaveBeenCalledTimes(1);
      expect(t.accessFindMany).toHaveBeenCalledTimes(1);
    });
  });
});
