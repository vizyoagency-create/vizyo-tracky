import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { DemoConsoleService } from './demo-console.service';

/**
 * Console de démonstration — ce que ces tests protègent, par ordre de gravité :
 *
 *  1. **HORS `DEMO_MODE`, RIEN.** La MÊME image sert la production et la démo. Ces routes sont
 *     authentifiées par un secret partagé, sans utilisateur : si la garde tombait, la production
 *     exposerait ses comptes et son activité à qui détient ce secret. C'est le test qui compte.
 *  2. Les comptes de service ne se bloquent pas : ce sont les identifiants remis aux prospects,
 *     et les couper arrêterait toutes les démonstrations sans que rien ne dise pourquoi.
 *  3. Un super-administrateur ne se bloque pas depuis la console.
 *  4. La dernière connexion vient de `LoginEvent`, seule source qui distingue « jamais venu » de
 *     « venu il y a longtemps ».
 */
describe('DemoConsoleService', () => {
  const COMPTES = [
    { id: 'u-svc', email: 'demo-admin@demo.vizyoagency.com', firstName: 'Démo', lastName: 'Admin', role: UserRole.FLEET_ADMIN, isActive: true, createdAt: new Date('2026-09-01T10:00:00Z') },
    { id: 'u-pro', email: 'prospect@societe.fr', firstName: 'Alex', lastName: 'Prospect', role: UserRole.FLEET_ADMIN, isActive: true, createdAt: new Date('2026-09-05T10:00:00Z') },
    { id: 'u-sup', email: 'admin@vizyoagency.com', firstName: 'Admin', lastName: 'Vizyo', role: UserRole.SUPER_ADMIN, isActive: true, createdAt: new Date('2026-08-01T10:00:00Z') },
  ];

  function bati(options: { demo?: boolean } = {}) {
    const prisma = {
      user: {
        findMany: jest.fn(async () => COMPTES),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          const c = COMPTES.find((x) => x.id === where.id);
          return c ? { id: c.id, email: c.email, role: c.role } : null;
        }),
        findFirst: jest.fn(async () => ({ id: 'u-sup', role: UserRole.SUPER_ADMIN, fleetId: null })),
        update: jest.fn(async () => ({})),
      },
      loginEvent: {
        findMany: jest.fn(async () => [
          { userId: 'u-pro', createdAt: new Date('2026-09-07T18:30:00Z'), city: 'Toulouse' },
          { userId: 'u-pro', createdAt: new Date('2026-09-06T09:00:00Z'), city: 'Toulouse' },
        ]),
      },
      invitation: { findMany: jest.fn(async () => []) },
      fleet: { findFirst: jest.fn(async () => ({ id: 'flotte-demo' })) },
    };
    const invitations = { create: jest.fn(async () => ({ id: 'inv-1' })), revoke: jest.fn(async () => ({ ok: true })) };
    const flux = { getFeed: jest.fn(async () => []) };
    const demoMode = options.demo === undefined ? undefined : { enabled: options.demo };
    const service = new DemoConsoleService(
      prisma as never,
      invitations as never,
      flux as never,
      demoMode as never,
    );
    return { service, prisma, invitations, flux };
  }

  describe('hors DEMO_MODE, tout est refusé', () => {
    // La même image sert les deux environnements : sans cette garde, ces routes exposeraient
    // les comptes et l'activité de la PRODUCTION derrière un simple secret partagé.
    const cas: Array<[string, (s: DemoConsoleService) => Promise<unknown>]> = [
      ['comptes', (s) => s.comptes()],
      ['invitations', (s) => s.listerInvitations()],
      ['inviter', (s) => s.inviter('a@b.fr', UserRole.VIEWER, 'moi')],
      ['révoquer', (s) => s.revoquerInvitation('inv-1')],
      ['bloquer', (s) => s.definirBlocage('u-pro', true)],
      ['activité', (s) => s.activite({})],
    ];

    for (const [nom, appel] of cas) {
      it(`${nom} refuse`, async () => {
        const { service, prisma } = bati({ demo: false });
        await expect(appel(service)).rejects.toThrow(ForbiddenException);
        expect(prisma.user.findMany).not.toHaveBeenCalled();
      });
    }

    it('sans service de mode démo du tout (specs, dev), refuse aussi', async () => {
      const { service } = bati();
      await expect(service.comptes()).rejects.toThrow(ForbiddenException);
    });
  });

  describe('en DEMO_MODE', () => {
    it('liste les comptes avec leur dernière connexion et marque ceux de service', async () => {
      const { service } = bati({ demo: true });
      const comptes = await service.comptes();

      const svc = comptes.find((c) => c.id === 'u-svc')!;
      expect(svc.compteDeService).toBe(true);
      expect(svc.derniereConnexionAt).toBeNull();

      const pro = comptes.find((c) => c.id === 'u-pro')!;
      expect(pro.compteDeService).toBe(false);
      // La PLUS RÉCENTE des deux connexions, pas la première rencontrée.
      expect(pro.derniereConnexionAt).toBe('2026-09-07T18:30:00.000Z');
      expect(pro.derniereConnexionVille).toBe('Toulouse');
      expect(pro.nom).toBe('Alex Prospect');
    });

    it('refuse de bloquer un compte de service — ce sont les identifiants des prospects', async () => {
      const { service, prisma } = bati({ demo: true });
      await expect(service.definirBlocage('u-svc', true)).rejects.toThrow(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuse de bloquer un super-administrateur', async () => {
      const { service, prisma } = bati({ demo: true });
      await expect(service.definirBlocage('u-sup', true)).rejects.toThrow(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('bloque un compte de prospect en basculant isActive', async () => {
      const { service, prisma } = bati({ demo: true });
      await service.definirBlocage('u-pro', true);
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u-pro' }, data: { isActive: false } });
    });

    it('débloque en remettant isActive à vrai', async () => {
      const { service, prisma } = bati({ demo: true });
      await service.definirBlocage('u-pro', false);
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u-pro' }, data: { isActive: true } });
    });

    it("invite en passant par le service d'invitations, pas en écrivant une ligne à la main", async () => {
      // Une invitation écrite directement en base n'aurait pas de jeton haché : aucun lien ne
      // pourrait l'accepter, et le prospect recevrait un courriel qui ne mène nulle part.
      const { service, invitations } = bati({ demo: true });
      await service.inviter('prospect@nouveau.fr', UserRole.FLEET_ADMIN, 'admin@vizyoagency.com');
      expect(invitations.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'prospect@nouveau.fr', role: UserRole.FLEET_ADMIN, fleetId: 'flotte-demo' }),
      );
    });
  });
});
