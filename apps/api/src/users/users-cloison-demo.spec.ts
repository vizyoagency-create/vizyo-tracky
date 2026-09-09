import { UserRole } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { UsersController } from './users.controller';

/**
 * ── LA CLOISON DE LA DÉMONSTRATION ───────────────────────────────────────────────────────
 *
 * Ce que ces tests protègent : **le prospect 1 ne doit jamais lire l'adresse du prospect 2,
 * ni celle des collègues que le prospect 2 a invités.**
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
 *
 * La cloison est un ARBRE, pas un mur : un prospect garde le droit d'inviter, donc il doit
 * voir SES invités — sinon la fonction qu'on lui laisse ne lui montre rien.
 */
describe('UsersController — cloison de la démonstration', () => {
  const FLOTTE = 'flotte-demo';

  // Deux lignées sœurs, plus un commercial au-dessus. C'est la situation redoutée.
  const COMMERCIAL = { id: 'u-com', email: 'commerciale@vizyoagency.com' };
  const PROSPECT_1 = { id: 'u-p1', email: 'prospect1@societe-a.fr' };
  const COLLEGUE_1 = { id: 'u-c1', email: 'collegue1@societe-a.fr' };
  const PROSPECT_2 = { id: 'u-p2', email: 'prospect2@societe-b.fr' };
  const COLLEGUE_2 = { id: 'u-c2', email: 'collegue2@societe-b.fr' };
  const SERVICE = { id: 'u-svc', email: 'demo-admin@demo.vizyoagency.com' };

  const COMPTES = [COMMERCIAL, PROSPECT_1, COLLEGUE_1, PROSPECT_2, COLLEGUE_2, SERVICE];

  /** Qui a invité qui : le commercial fait venir les deux prospects, chacun son collègue. */
  const INVITATIONS = [
    { email: PROSPECT_1.email, createdById: COMMERCIAL.id },
    { email: PROSPECT_2.email, createdById: COMMERCIAL.id },
    { email: COLLEGUE_1.email, createdById: PROSPECT_1.id },
    { email: COLLEGUE_2.email, createdById: PROSPECT_2.id },
  ];

  /** Typage explicite : un `jest.fn` inféré rend `mock.calls` non indexable. */
  type Args = { where: Record<string, unknown> };

  function prismaEspion() {
    const userFindMany = jest.fn(async (a?: Args): Promise<unknown[]> =>
      // L'appel SANS `where` est celui que la cloison fait pour reconstruire l'arbre.
      a?.where ? [] : COMPTES,
    );
    const invitationFindMany = jest.fn(async (a?: Args): Promise<unknown[]> =>
      a?.where ? [] : INVITATIONS,
    );
    return {
      espion: {
        user: { findMany: userFindMany },
        invitation: { findMany: invitationFindMany },
        vehicleGroup: { findMany: jest.fn(async (_a?: Args): Promise<unknown[]> => []) },
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

  const requete = (id: string, role: UserRole) =>
    ({ user: { id, role, fleetId: FLOTTE, permissions: null } }) as never;

  /** Le `where` de la requête qui RAMÈNE les utilisateurs (pas celui qui bâtit l'arbre). */
  function whereDeLaListe(userFindMany: ReturnType<typeof prismaEspion>['userFindMany']) {
    const avecWhere = userFindMany.mock.calls.map((c) => c[0]).filter((a) => a?.where);
    expect(avecWhere).toHaveLength(1);
    return avecWhere[0]!.where as { OR?: Array<Record<string, unknown>> };
  }

  /** Les identifiants que la cloison autorise, extraits du `where`. */
  function idsAutorises(where: { OR?: Array<Record<string, unknown>> }): string[] {
    const clause = where.OR?.find((c) => 'id' in c) as { id: { in: string[] } } | undefined;
    return clause?.id.in ?? [];
  }

  describe('en DEMO_MODE', () => {
    it("le prospect 1 voit SON collègue, jamais le prospect 2 ni le collègue du prospect 2", async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, true).findAll(requete(PROSPECT_1.id, UserRole.FLEET_ADMIN));

      const ids = idsAutorises(whereDeLaListe(userFindMany));
      expect(ids).toEqual(expect.arrayContaining([PROSPECT_1.id, COLLEGUE_1.id]));
      expect(ids).not.toContain(PROSPECT_2.id);
      expect(ids).not.toContain(COLLEGUE_2.id);
    });

    it("ne remonte JAMAIS vers l'inviteur — l'adresse du commercial ne le regarde pas", async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, true).findAll(requete(PROSPECT_1.id, UserRole.FLEET_ADMIN));

      expect(idsAutorises(whereDeLaListe(userFindMany))).not.toContain(COMMERCIAL.id);
    });

    it('le commercial voit toute sa descendance : les deux prospects et leurs collègues', async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, true).findAll(requete(COMMERCIAL.id, UserRole.FLEET_ADMIN));

      expect(idsAutorises(whereDeLaListe(userFindMany))).toEqual(
        expect.arrayContaining([COMMERCIAL.id, PROSPECT_1.id, PROSPECT_2.id, COLLEGUE_1.id, COLLEGUE_2.id]),
      );
    });

    it('laisse voir les comptes de rôle du seed, qui sont fictifs', async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, true).findAll(requete(PROSPECT_1.id, UserRole.FLEET_ADMIN));

      expect(whereDeLaListe(userFindMany).OR).toContainEqual({
        email: { endsWith: '@demo.vizyoagency.com' },
      });
    });

    it('applique la MÊME cloison au panorama, qui rend aussi les permissions', async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, true).panorama(requete(PROSPECT_1.id, UserRole.FLEET_ADMIN));

      const ids = idsAutorises(whereDeLaListe(userFindMany));
      expect(ids).toContain(COLLEGUE_1.id);
      expect(ids).not.toContain(PROSPECT_2.id);
    });

    it("borne les invitations en attente à la même lignée", async () => {
      // Une invitation en attente EST une adresse en clair : la masquer dans la liste des
      // comptes sans la masquer ici n'aurait rien protégé du tout.
      const { espion, invitationFindMany } = prismaEspion();
      await controleur(espion, true).findAll(
        requete(PROSPECT_1.id, UserRole.FLEET_ADMIN), undefined, 'true',
      );

      const avecWhere = invitationFindMany.mock.calls.map((c) => c[0]).filter((a) => a?.where);
      const where = avecWhere[0]!.where as { createdById: { in: string[] } };
      expect(where.createdById.in).toContain(PROSPECT_1.id);
      expect(where.createdById.in).not.toContain(PROSPECT_2.id);
    });

    it("ne cloisonne PAS le super-administrateur — c'est l'exploitant", async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, true).findAll(requete(COMMERCIAL.id, UserRole.SUPER_ADMIN));

      expect(whereDeLaListe(userFindMany).OR).toBeUndefined();
    });
  });

  describe('hors DEMO_MODE', () => {
    it("ne change RIEN en production — le filtre par flotte reste seul maître", async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, false).findAll(requete(PROSPECT_1.id, UserRole.FLEET_ADMIN));

      const where = whereDeLaListe(userFindMany) as Record<string, unknown>;
      expect(where.OR).toBeUndefined();
      expect(where.fleetId).toBe(FLOTTE);
    });

    it('sans service de mode démo du tout (specs, dev), ne cloisonne pas non plus', async () => {
      const { espion, userFindMany } = prismaEspion();
      await controleur(espion, undefined).findAll(requete(PROSPECT_1.id, UserRole.FLEET_ADMIN));

      expect(whereDeLaListe(userFindMany).OR).toBeUndefined();
    });
  });
});
