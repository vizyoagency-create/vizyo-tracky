import { UserRole } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { UsersController } from './users.controller';

/**
 * ── LA CLOISON DE LA DÉMONSTRATION ───────────────────────────────────────────────────────
 *
 * Ce que ces tests protègent : **un prospect ne doit jamais lire l'adresse d'un autre
 * prospect.**
 *
 * L'isolation de ce produit se fait par FLOTTE, et la démonstration n'en a qu'une — par
 * choix, pour qu'on invite sans jamais créer de société. Tous les prospects sont donc
 * voisins, et chacun est FLEET_ADMIN pour que la démonstration soit complète. Mesuré le
 * 2026-09-09 sur l'environnement en service : le compte remis aux prospects rendait six
 * adresses, dont celle de l'exploitant et celle d'une invitation en attente.
 *
 * ⚠️ Les permissions ne peuvent PAS servir de garde ici : `PermissionsGuard` laisse
 * explicitement passer SUPER_ADMIN et FLEET_ADMIN. Retirer `users_view` ne change rien.
 * C'est pourquoi la cloison est dans la REQUÊTE, et pourquoi elle mérite un test.
 */
describe('UsersController — cloison de la démonstration', () => {
  const FLOTTE = 'flotte-demo';
  const MOI = 'u-prospect';

  /** Typage explicite : un `jest.fn` inféré rend `mock.calls` non indexable. */
  type Args = { where: Record<string, unknown> };

  function prismaEspion() {
    const userFindMany = jest.fn(async (_a: Args): Promise<unknown[]> => []);
    const invitationFindMany = jest.fn(async (_a: Args): Promise<unknown[]> => []);
    return {
      espion: {
        user: { findMany: userFindMany },
        invitation: { findMany: invitationFindMany },
        vehicleGroup: { findMany: jest.fn(async (_a: Args): Promise<unknown[]> => []) },
      } as unknown as PrismaService,
      userFindMany,
      invitationFindMany,
    };
  }

  function controleur(prisma: PrismaService, demo: boolean | undefined) {
    return new UsersController(
      prisma,
      {} as never,
      { applyStatus: jest.fn() } as never,
      { list: jest.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { isMasked: () => false } as never,
      { fermerLiensDuCompte: jest.fn() } as never,
      demo === undefined ? (undefined as never) : ({ enabled: demo } as never),
    );
  }

  const requete = (role: UserRole) =>
    ({ user: { id: MOI, role, fleetId: FLOTTE, permissions: null } }) as never;

  /** La contrainte que la cloison ajoute, quand elle s'applique. */
  const CLOISON = {
    OR: [{ id: MOI }, { email: { endsWith: '@demo.vizyoagency.com' } }],
  };

  describe('en DEMO_MODE', () => {
    it("borne la liste des utilisateurs à soi-même et aux comptes de rôle", async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, true).findAll(requete(UserRole.FLEET_ADMIN));

      expect(userFindMany).toHaveBeenCalledTimes(1);
      expect(userFindMany.mock.calls[0]![0].where).toMatchObject(CLOISON);
    });

    it('applique la MÊME cloison au panorama, qui rend aussi les permissions', async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, true).panorama(requete(UserRole.FLEET_ADMIN));

      expect(userFindMany.mock.calls[0]![0].where).toMatchObject(CLOISON);
    });

    it("ne montre que les invitations que l'appelant a émises lui-même", async () => {
      // Une invitation en attente EST une adresse en clair : la masquer dans la liste des
      // comptes sans la masquer ici n'aurait rien protégé du tout.
      const { espion, invitationFindMany } = prismaEspion();
      await controleur(espion, true).findAll(requete(UserRole.FLEET_ADMIN), undefined, 'true');

      expect(invitationFindMany.mock.calls[0]![0].where).toMatchObject({ createdById: MOI });
    });

    it("ne cloisonne PAS le super-administrateur — c'est l'exploitant", async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, true).findAll(requete(UserRole.SUPER_ADMIN));

      expect(userFindMany.mock.calls[0]![0].where.OR).toBeUndefined();
    });
  });

  describe('hors DEMO_MODE', () => {
    it("ne change RIEN en production — le filtre par flotte reste seul maître", async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, false).findAll(requete(UserRole.FLEET_ADMIN));

      const where = userFindMany.mock.calls[0]![0].where;
      expect(where.OR).toBeUndefined();
      expect(where.fleetId).toBe(FLOTTE);
    });

    it('sans service de mode démo du tout (specs, dev), ne cloisonne pas non plus', async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, undefined).findAll(requete(UserRole.FLEET_ADMIN));

      expect(userFindMany.mock.calls[0]![0].where.OR).toBeUndefined();
    });
  });
});
