import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PartnerLinkStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { PartnerClientService } from './partner-client.service';
import type { PartnerConfigService } from './partner.config';
import type { PartnerInvitationService } from './partner-invitation.service';
import { PartnerPairingService, hashSecret } from './partner-pairing.service';

const FLEET = 'fleet-1';
const USER = 'user-1';
const CODE = 'TRK-ABCD-EFGH-JKMN';

const DETAILS = {
  organizationId: 'org-1',
  organizationName: 'PegaseExpress',
  siret: '12345678900011',
  requestedByUserId: 'maestroo-user',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

function makeService(opts: {
  existingLinks?: unknown[];
  enabled?: boolean;
  createThrows?: boolean;
  completeThrows?: boolean;
  codeInvitedElsewhere?: boolean;
} = {}) {
  const calls = { complete: [] as unknown[], abort: [] as unknown[], created: null as any };
  const links = opts.existingLinks ?? [];

  const prisma = {
    partnerLink: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.suspendedByPlatform === true) {
          return links.find((l: any) => l.suspendedByPlatform) ?? null;
        }
        if (where.liveKey) return links.find((l: any) => l.liveKey) ?? null;
        return links[0] ?? null;
      }),
      create: jest.fn(async ({ data }: { data: unknown }) => {
        if (opts.createThrows) throw new Error('DB down');
        calls.created = data;
        return data;
      }),
    },
    fleet: { findUnique: jest.fn(async () => ({ name: 'Flotte Test' })) },
  } as unknown as PrismaService;

  const client = {
    readPairing: jest.fn(async () => DETAILS),
    completePairing: jest.fn(async (code: string, body: unknown) => {
      if (opts.completeThrows) throw new Error('partenaire injoignable');
      calls.complete.push({ code, body });
    }),
    abortPairing: jest.fn(async (code: string, linkId: string) => {
      calls.abort.push({ code, linkId });
    }),
  } as unknown as PartnerClientService;

  const config = { enabled: opts.enabled ?? true } as unknown as PartnerConfigService;
  const activity = { record: jest.fn() } as unknown as SystemActivityService;
  // Par défaut le code n'est promis à personne : c'est le parcours manuel, où
  // celui qui génère le code est celui qui le saisit. Le refus par invitation a
  // ses propres tests (partner-invitation.service.spec.ts).
  const invitations = {
    assertCodeUsableBy: opts.codeInvitedElsewhere
      ? jest.fn(async () => {
          throw new ForbiddenException('Ce code a ete emis pour une autre flotte.');
        })
      : jest.fn(async () => undefined),
    markAccepted: jest.fn(async () => undefined),
    // Pas de pré-remplissage par défaut : c'est le cas d'un client qui avait
    // déjà son Maestroo. Le parcours provisionné a ses propres tests.
    seedVehicles: jest.fn(async () => []),
  } as unknown as PartnerInvitationService;

  return {
    service: new PartnerPairingService(prisma, client, config, activity, invitations),
    calls,
    client,
    prisma,
    invitations,
  };
}

describe('claim — n\'active rien', () => {
  it('renvoie le catalogue de scopes avec les défauts', async () => {
    const { service, prisma } = makeService();
    const result = await service.claim(FLEET, CODE);

    expect(result.organizationName).toBe('PegaseExpress');
    expect(result.scopes).toHaveLength(9);
    // Les scopes SENSIBLES arrivent DÉCOCHÉS : c'est le client qui les allume.
    const live = result.scopes.find((s) => s.key === 'LIVE_POSITION');
    const behavior = result.scopes.find((s) => s.key === 'DRIVING_BEHAVIOR');
    expect(live?.defaultOn).toBe(false);
    expect(behavior?.defaultOn).toBe(false);
    expect(result.scopes.find((s) => s.key === 'VEHICLE_IDENTITY')?.defaultOn).toBe(true);
    // Aucune écriture : le client doit pouvoir regarder avant de décider.
    expect(prisma.partnerLink.create).not.toHaveBeenCalled();
  });

  it('module éteint ⇒ 404', async () => {
    const { service } = makeService({ enabled: false });
    await expect(service.claim(FLEET, CODE)).rejects.toThrow(NotFoundException);
  });
});

describe('approve — le code promis par e-mail', () => {
  it('code invité pour UNE AUTRE flotte ⇒ REFUS, avant même de joindre le partenaire', async () => {
    // ⚠️ L'e-mail transféré. Sans ce garde, le fleet-admin qui reçoit le lien
    // d'un confrère branche SA flotte sur l'organisation Maestroo de ce confrère.
    // C'est le bug d'ambiguïté d'organisation, vu depuis l'autre bout.
    const { service, client, prisma } = makeService({ codeInvitedElsewhere: true });
    await expect(service.approve(FLEET, USER, CODE, ['FUEL'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Rien n'a bougé nulle part : ni chez nous, ni chez le partenaire.
    expect(client.completePairing).not.toHaveBeenCalled();
    expect(prisma.partnerLink.create).not.toHaveBeenCalled();
  });

  it('appairage réussi ⇒ l\'invitation est marquée acceptée APRÈS la création du lien', async () => {
    // Une invitation « acceptée » alors que l'appairage a échoué serait un faux
    // dans un registre qui sert de preuve de consentement.
    const { service, invitations, prisma } = makeService();
    await service.approve(FLEET, USER, CODE, ['FUEL']);

    const acceptOrder = (invitations.markAccepted as jest.Mock).mock.invocationCallOrder[0];
    const createOrder = (prisma.partnerLink.create as jest.Mock).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(acceptOrder!);
    expect(invitations.markAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ fleetId: FLEET, pairingCode: CODE, scopes: ['FUEL'] }),
    );
  });

  it('appairage en échec ⇒ AUCUNE acceptation enregistrée', async () => {
    const { service, invitations } = makeService({ completeThrows: true });
    await expect(service.approve(FLEET, USER, CODE, ['FUEL'])).rejects.toThrow();
    expect(invitations.markAccepted).not.toHaveBeenCalled();
  });
});

describe('approve — ordre et compensation', () => {
  it('prévient le partenaire AVANT de créer le lien local', async () => {
    const { service, client, prisma } = makeService();
    await service.approve(FLEET, USER, CODE, ['VEHICLE_IDENTITY', 'FUEL']);

    const completeOrder = (client.completePairing as jest.Mock).mock.invocationCallOrder[0];
    const createOrder = (prisma.partnerLink.create as jest.Mock).mock.invocationCallOrder[0];
    expect(completeOrder).toBeLessThan(createOrder);
  });

  it('partenaire en échec ⇒ AUCUN lien local créé', async () => {
    // Le cas courant (réseau, pair indisponible) : rien n'existe nulle part.
    const { service, prisma, client } = makeService({ completeThrows: true });
    await expect(service.approve(FLEET, USER, CODE, ['FUEL'])).rejects.toThrow();
    expect(prisma.partnerLink.create).not.toHaveBeenCalled();
    expect(client.abortPairing).not.toHaveBeenCalled();
  });

  it('écriture locale en échec ⇒ COMPENSATION chez le partenaire', async () => {
    // Cas résiduel : le partenaire nous a acquittés mais on n'a pas pu écrire.
    // Sans compensation il afficherait « connecté » alors que rien ne marcherait.
    const { service, client, calls } = makeService({ createThrows: true });
    await expect(service.approve(FLEET, USER, CODE, ['FUEL'])).rejects.toThrow('DB down');
    expect(client.abortPairing).toHaveBeenCalledTimes(1);
    expect(calls.abort[0]).toMatchObject({ code: CODE });
  });

  it('le même identifiant est envoyé au partenaire et utilisé en base', async () => {
    // L'UUID est généré AVANT l'appel : le partenaire a besoin du remoteLinkId
    // alors que la ligne n'existe pas encore de notre côté.
    const { service, calls } = makeService();
    const result = await service.approve(FLEET, USER, CODE, ['FUEL']);
    expect((calls.complete[0] as any).body.remoteLinkId).toBe(result.linkId);
    expect(calls.created.id).toBe(result.linkId);
  });
});

describe('approve — secret', () => {
  it('le secret est envoyé au partenaire mais stocké HASHÉ', async () => {
    const { service, calls } = makeService();
    await service.approve(FLEET, USER, CODE, ['FUEL']);

    const sent = (calls.complete[0] as any).body.linkSecret as string;
    expect(sent).toHaveLength(43); // 32 octets en base64url
    expect(calls.created.secretHash).toBe(hashSecret(sent));
    // Le clair ne doit JAMAIS atteindre la base.
    expect(JSON.stringify(calls.created)).not.toContain(sent);
  });

  it('deux appairages produisent des secrets différents', async () => {
    const a = makeService();
    const b = makeService();
    await a.service.approve(FLEET, USER, CODE, ['FUEL']);
    await b.service.approve(FLEET, USER, CODE, ['FUEL']);
    expect((a.calls.complete[0] as any).body.linkSecret).not.toBe(
      (b.calls.complete[0] as any).body.linkSecret,
    );
  });
});

describe('approve — scopes', () => {
  it('les scopes inconnus sont écartés (fail-closed)', async () => {
    const { service, calls } = makeService();
    await service.approve(FLEET, USER, CODE, ['FUEL', 'SCOPE_DU_FUTUR', 42]);
    expect(calls.created.scopes).toEqual(['FUEL']);
  });

  it('aucun scope demandé ⇒ liste VIDE, jamais un repli sur les défauts', async () => {
    const { service, calls } = makeService();
    await service.approve(FLEET, USER, CODE, []);
    expect(calls.created.scopes).toEqual([]);
  });

  it('chaque scope activé est tracé dans le journal du lien', async () => {
    const { service, calls } = makeService();
    await service.approve(FLEET, USER, CODE, ['FUEL', 'ALERTS']);
    const events = calls.created.events.create as Array<{ action: string; scope?: string }>;
    expect(events.filter((e) => e.action === 'scope_enabled').map((e) => e.scope)).toEqual([
      'FUEL',
      'ALERTS',
    ]);
    expect(events[0].action).toBe('approved');
  });

  it('le lien est créé ACTIVE avec son créneau d\'unicité occupé', async () => {
    const { service, calls } = makeService();
    await service.approve(FLEET, USER, CODE, ['FUEL']);
    expect(calls.created).toMatchObject({
      status: PartnerLinkStatus.ACTIVE,
      liveKey: 'MAESTROO',
      externalOrgId: 'org-1',
    });
  });
});

describe('assertPairable — le levier commercial', () => {
  it('flotte suspendue par la PLATEFORME ⇒ un nouveau handshake est REFUSÉ', async () => {
    // ⚠️ Le point qui fait tenir le levier « le client ne paye pas ». Sans ce
    // contrôle au niveau du handshake, il révoque, recommence, et se reconnecte
    // en trente secondes.
    const { service } = makeService({
      existingLinks: [{ suspendedByPlatform: true, status: PartnerLinkStatus.REVOKED, liveKey: null }],
    });
    await expect(service.claim(FLEET, CODE)).rejects.toThrow(ForbiddenException);
    await expect(service.approve(FLEET, USER, CODE, ['FUEL'])).rejects.toThrow(ForbiddenException);
  });

  it('lien déjà vivant ⇒ conflit', async () => {
    const { service } = makeService({
      existingLinks: [{ liveKey: 'MAESTROO', status: PartnerLinkStatus.ACTIVE }],
    });
    await expect(service.approve(FLEET, USER, CODE, ['FUEL'])).rejects.toThrow(ConflictException);
  });

  it('lien révoqué (créneau libéré) ⇒ ré-appairage autorisé', async () => {
    const { service } = makeService({
      existingLinks: [{ liveKey: null, status: PartnerLinkStatus.REVOKED, suspendedByPlatform: false }],
    });
    await expect(service.approve(FLEET, USER, CODE, ['FUEL'])).resolves.toHaveProperty('linkId');
  });
});
