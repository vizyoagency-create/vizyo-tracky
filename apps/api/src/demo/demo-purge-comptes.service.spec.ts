import { UserRole } from '@prisma/client';
import { DemoPurgeComptesService } from './demo-purge-comptes.service';

/**
 * Purge des comptes de démonstration — ce que ces tests protègent, par ordre de gravité :
 *
 *  1. **HORS `DEMO_MODE`, RIEN.** La même image sert la production. Une purge de comptes qui
 *     s'y déclencherait serait irréparable : c'est le test qui compte, et il vérifie qu'on ne
 *     LIT même pas la base.
 *  2. Les comptes de service ne sont pas purgés : ce sont les identifiants remis aux prospects.
 *  3. Les commerciaux inscrits dans `DEMO_COMPTES_PERMANENTS` non plus — rien ne les distingue
 *     structurellement d'un prospect, et les effacer couperait la personne qui fait visiter.
 *  4. Une connexion récente sauve un compte, même créé il y a longtemps : c'est l'inactivité
 *     qui purge, pas l'ancienneté.
 *  5. L'effacement suspend d'abord dans Vizyo Auth. Sans ce geste, le mot de passe resterait
 *     valide chez le fournisseur d'identité — l'écart qui avait fait croire pendant des mois
 *     qu'un compte « archivé » l'était.
 */
describe('DemoPurgeComptesService', () => {
  const MAINTENANT = new Date('2026-11-01T05:35:00Z');

  const DORMANT = {
    id: 'u-dormant',
    email: 'prospect@societe.fr',
    authUserId: 'auth-dormant',
  };
  const SERVICE = {
    id: 'u-svc',
    email: 'demo-admin@demo.vizyoagency.com',
    authUserId: 'auth-svc',
  };
  const COMMERCIALE = {
    id: 'u-com',
    email: 'commerciale@vizyoagency.com',
    authUserId: 'auth-com',
  };

  type OuUser = { where: Record<string, unknown> };

  function bati(options: {
    demo?: boolean;
    candidats?: Array<typeof DORMANT>;
    revenus?: string[];
    permanents?: string;
    jours?: string;
  } = {}) {
    const userFindMany = jest.fn(async (_a: OuUser) => options.candidats ?? [DORMANT]);
    const userUpdate = jest.fn(async (_a: unknown) => ({}));
    const invitationDeleteMany = jest.fn(async (_a: unknown) => ({ count: 0 }));
    const loginEventFindMany = jest.fn(async (_a: unknown) =>
      (options.revenus ?? []).map((userId) => ({ userId })),
    );
    const applyStatus = jest.fn(async (..._a: unknown[]) => true);

    const prisma = {
      user: { findMany: userFindMany, update: userUpdate },
      invitation: { deleteMany: invitationDeleteMany },
      loginEvent: { findMany: loginEventFindMany },
    };
    const config = {
      get: (cle: string) =>
        cle === 'DEMO_COMPTES_PERMANENTS' ? (options.permanents ?? '') : (options.jours ?? ''),
    };
    const service = new DemoPurgeComptesService(
      prisma as never,
      { applyStatus } as never,
      config as never,
      options.demo === undefined ? (undefined as never) : ({ enabled: options.demo } as never),
    );
    return { service, userFindMany, userUpdate, invitationDeleteMany, applyStatus };
  }

  describe('hors DEMO_MODE', () => {
    it("ne lit MÊME PAS la base — la garde est avant toute lecture", async () => {
      const { service, userFindMany, userUpdate, applyStatus } = bati({ demo: false });
      await service.purger(MAINTENANT);

      expect(userFindMany).not.toHaveBeenCalled();
      expect(userUpdate).not.toHaveBeenCalled();
      expect(applyStatus).not.toHaveBeenCalled();
    });

    it('sans service de mode démo du tout (specs, dev), ne fait rien non plus', async () => {
      const { service, userFindMany } = bati({ demo: undefined });
      await service.purger(MAINTENANT);

      expect(userFindMany).not.toHaveBeenCalled();
    });
  });

  describe('en DEMO_MODE', () => {
    it('efface un compte dormant : suspension, invitations, données personnelles', async () => {
      const { service, userUpdate, invitationDeleteMany, applyStatus } = bati({ demo: true });
      await service.purger(MAINTENANT);

      // 1. La suspension chez le fournisseur d'identité, sans laquelle rien n'est vraiment coupé.
      expect(applyStatus).toHaveBeenCalledWith(DORMANT.authUserId, false, expect.stringContaining('purge-demo'));
      // 2. Les invitations, reçues comme émises — elles portent l'adresse en clair.
      expect(invitationDeleteMany).toHaveBeenCalledWith({
        where: { OR: [{ email: DORMANT.email }, { createdById: DORMANT.id }] },
      });
      // 3. Plus rien qui désigne quelqu'un.
      const donnees = userUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(donnees.data.email).not.toContain('societe.fr');
      expect(donnees.data.email).toContain('@compte-efface.invalid');
      expect(donnees.data.isActive).toBe(false);
      expect(donnees.data.phone).toBeNull();
    });

    it("exclut les comptes de service dès la REQUÊTE — ce sont les identifiants des prospects", async () => {
      const { service, userFindMany } = bati({ demo: true });
      await service.purger(MAINTENANT);

      const where = userFindMany.mock.calls[0]![0].where as Record<string, unknown>;
      expect(where.NOT).toEqual({ email: { endsWith: '@demo.vizyoagency.com' } });
      expect(where.role).toEqual({ not: UserRole.SUPER_ADMIN });
      expect(where.isOwner).toBe(false);
    });

    it("n'efface pas une adresse inscrite dans DEMO_COMPTES_PERMANENTS", async () => {
      const { service, userUpdate } = bati({
        demo: true,
        candidats: [COMMERCIALE],
        permanents: ' Commerciale@vizyoagency.com , autre@x.fr ',
      });
      await service.purger(MAINTENANT);

      // La comparaison ignore la casse et les espaces : une liste tapée à la main en contient.
      expect(userUpdate).not.toHaveBeenCalled();
    });

    it("une connexion récente sauve le compte — c'est l'inactivité qui purge, pas l'ancienneté", async () => {
      const { service, userUpdate } = bati({ demo: true, revenus: [DORMANT.id] });
      await service.purger(MAINTENANT);

      expect(userUpdate).not.toHaveBeenCalled();
    });

    it('un compte qui résiste n\'arrête pas les suivants', async () => {
      const AUTRE = { id: 'u-2', email: 'autre@societe.fr', authUserId: 'auth-2' };
      const { service, userUpdate, applyStatus } = bati({ demo: true, candidats: [DORMANT, AUTRE] });
      applyStatus.mockImplementationOnce(async () => {
        throw new Error('Vizyo Auth injoignable');
      });

      await service.purger(MAINTENANT);

      expect(userUpdate).toHaveBeenCalledTimes(1);
      expect((userUpdate.mock.calls[0]![0] as { where: { id: string } }).where.id).toBe(AUTRE.id);
    });

    it('respecte le délai configuré plutôt que les 30 jours par défaut', async () => {
      const { service, userFindMany } = bati({ demo: true, jours: '7' });
      await service.purger(MAINTENANT);

      const where = userFindMany.mock.calls[0]![0].where as { createdAt: { lt: Date } };
      const joursEcoules = (MAINTENANT.getTime() - where.createdAt.lt.getTime()) / 86_400_000;
      expect(joursEcoules).toBe(7);
    });

    it('sans rien à purger, laisse quand même une trace du passage', async () => {
      const { service } = bati({ demo: true, candidats: [] });
      const journal = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

      await service.purger(MAINTENANT);

      expect(journal).toHaveBeenCalledTimes(1);
      journal.mockRestore();
    });
  });
});
