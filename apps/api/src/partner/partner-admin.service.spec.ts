import { NotFoundException } from '@nestjs/common';
import { PartnerLinkStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { PartnerClientService } from './partner-client.service';
import type { PartnerConfigService } from './partner.config';
import type { PartnerTokenService } from './partner-token.service';
import { PartnerAdminService } from './partner-admin.service';
import { verifyRevocationStatement } from './partner-signature';

const SECRET = 'secret-de-plateforme';
const LINK = 'link-1';
const ACTOR = 'admin-1';

const link = (o: Record<string, unknown> = {}) => ({
  id: LINK,
  fleetId: 'fleet-1',
  externalOrgName: 'PegaseExpress',
  status: PartnerLinkStatus.ACTIVE,
  suspendedByPlatform: false,
  billingStatus: 'COMP',
  scopes: ['VEHICLE_IDENTITY', 'FUEL'],
  lastSeenAt: null,
  ...o,
});

function makeService(opts: { link?: unknown; previewThrows?: boolean } = {}) {
  const calls = { updates: [] as any[], events: [] as any[], outbox: [] as any[], tokensRevoked: 0 };
  const tx = {
    partnerLink: {
      update: jest.fn(async ({ data }: any) => {
        calls.updates.push(data);
        return data;
      }),
    },
    partnerAccessToken: {
      updateMany: jest.fn(async () => {
        calls.tokensRevoked += 1;
        return { count: 2 };
      }),
    },
    partnerLinkEvent: {
      create: jest.fn(async ({ data }: any) => {
        calls.events.push(data);
        return data;
      }),
    },
    partnerOutboxEvent: {
      create: jest.fn(async ({ data }: any) => {
        calls.outbox.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    ...tx,
    partnerLink: {
      ...tx.partnerLink,
      findUnique: jest.fn(async () => ('link' in opts ? opts.link : link())),
      findMany: jest.fn(async () => [{ ...link(), fleet: { name: 'Flotte Test' }, externalOrgSiret: null, approvedAt: null, revokedAt: null, partner: 'MAESTROO', suspendedReason: null }]),
    },
    partnerAccessToken: { ...tx.partnerAccessToken, count: jest.fn(async () => 3) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  } as unknown as PrismaService;

  const client = {
    purgePreview: jest.fn(async () => {
      if (opts.previewThrows) throw new Error('injoignable');
      return { byScope: { FUEL: 12 }, total: 12, alerts: 3, linked: true };
    }),
  } as unknown as PartnerClientService;

  const config = { platformSecret: SECRET } as unknown as PartnerConfigService;
  const tokens = {} as unknown as PartnerTokenService;
  const activity = { record: jest.fn() } as unknown as SystemActivityService;

  return { service: new PartnerAdminService(prisma, tokens, client, config, activity), calls, prisma, client };
}

describe('platformSuspend — le levier impayé', () => {
  it('lève le drapeau plateforme SANS toucher au statut du lien', async () => {
    // ⚠️ C'est ce qui permet de rétablir exactement l'état antérieur quand le
    // client régularise, sans lui faire refaire un handshake.
    const { service, calls } = makeService();
    await service.platformSuspend(LINK, 'Impaye facture 2026-07', ACTOR);

    expect(calls.updates[0]).toEqual({
      suspendedByPlatform: true,
      suspendedReason: 'Impaye facture 2026-07',
    });
    expect(calls.updates[0].status).toBeUndefined();
  });

  it('coupe les jetons vivants tout de suite', async () => {
    // Sans ça le partenaire continuerait de lire pendant 10 minutes.
    const { service, calls } = makeService();
    await service.platformSuspend(LINK, 'raison', ACTOR);
    expect(calls.tokensRevoked).toBe(1);
  });

  it('met en file un webhook LINK_SUSPENDED SIGNÉ', async () => {
    const { service, calls } = makeService();
    await service.platformSuspend(LINK, 'raison', ACTOR);

    expect(calls.outbox[0].type).toBe('link.suspended');
    const statement = calls.outbox[0].payload;
    expect(statement.event).toBe('LINK_SUSPENDED');
    // La signature doit vraiment vérifier — sinon le partenaire la traiterait
    // comme une panne et ne purgerait rien.
    expect(() => verifyRevocationStatement(SECRET, statement)).not.toThrow();
    expect(() => verifyRevocationStatement('autre', statement)).toThrow();
  });

  it('journalise l\'acte dans l\'audit du lien', async () => {
    const { service, calls } = makeService();
    await service.platformSuspend(LINK, 'Impaye', ACTOR);
    expect(calls.events[0]).toMatchObject({
      action: 'platform_suspended',
      actorType: 'PLATFORM',
      actorId: ACTOR,
      detail: 'Impaye',
    });
  });

  it('idempotent : déjà suspendu ⇒ aucune ré-émission', async () => {
    const { service, calls } = makeService({ link: link({ suspendedByPlatform: true }) });
    await expect(service.platformSuspend(LINK, 'r', ACTOR)).resolves.toMatchObject({ changed: false });
    expect(calls.outbox).toHaveLength(0);
  });
});

describe('platformResume', () => {
  it('lève le drapeau et le journalise', async () => {
    const { service, calls } = makeService({ link: link({ suspendedByPlatform: true }) });
    await service.platformResume(LINK, ACTOR);
    expect(calls.updates[0]).toEqual({ suspendedByPlatform: false, suspendedReason: null });
    expect(calls.events[0].action).toBe('platform_resumed');
  });

  it('idempotent : pas suspendu ⇒ rien', async () => {
    const { service, calls } = makeService();
    await expect(service.platformResume(LINK, ACTOR)).resolves.toMatchObject({ changed: false });
    expect(calls.updates).toHaveLength(0);
  });
});

describe('setBilling (D8)', () => {
  it('bascule COMP → ACTIVE et trace la transition', async () => {
    const { service, calls } = makeService();
    await service.setBilling(LINK, 'ACTIVE', ACTOR);
    expect(calls.updates[0]).toEqual({ billingStatus: 'ACTIVE' });
    expect(calls.events[0].detail).toBe('COMP -> ACTIVE');
  });

  it('axe INDÉPENDANT de la suspension', async () => {
    // Un client peut être COMP (offert) ET suspendu pour impayé sur son
    // abonnement Tracky principal.
    const { service, calls } = makeService({ link: link({ suspendedByPlatform: true }) });
    await service.setBilling(LINK, 'ACTIVE', ACTOR);
    expect(calls.updates[0]).toEqual({ billingStatus: 'ACTIVE' });
    expect(calls.updates[0].suspendedByPlatform).toBeUndefined();
  });

  it('idempotent', async () => {
    const { service, calls } = makeService();
    await expect(service.setBilling(LINK, 'COMP', ACTOR)).resolves.toMatchObject({ changed: false });
    expect(calls.updates).toHaveLength(0);
  });
});

describe('revocationPreview — dry-run', () => {
  it('N\'ÉCRIT RIEN, ni ici ni chez le partenaire', async () => {
    // Couper un client a des conséquences financières : on doit pouvoir regarder
    // avant d'appuyer.
    const { service, calls, prisma } = makeService();
    await service.revocationPreview(LINK);
    expect(calls.updates).toHaveLength(0);
    expect(calls.outbox).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('agrège la vue locale et celle du partenaire', async () => {
    const { service } = makeService();
    await expect(service.revocationPreview(LINK)).resolves.toMatchObject({
      organizationName: 'PegaseExpress',
      scopes: ['VEHICLE_IDENTITY', 'FUEL'],
      activeTokens: 3,
      partnerReachable: true,
      remote: { total: 12, alerts: 3 },
    });
  });

  it('partenaire injoignable ⇒ vue locale quand même, pas d\'échec', async () => {
    // Une panne du pair ne doit pas empêcher de préparer une décision commerciale.
    const { service } = makeService({ previewThrows: true });
    await expect(service.revocationPreview(LINK)).resolves.toMatchObject({
      partnerReachable: false,
      remote: null,
      organizationName: 'PegaseExpress',
    });
  });
});

describe('lien inconnu', () => {
  it.each(['platformSuspend', 'platformResume', 'revocationPreview'] as const)('%s ⇒ 404', async (method) => {
    const { service } = makeService({ link: null });
    const call =
      method === 'platformSuspend'
        ? service.platformSuspend(LINK, 'r', ACTOR)
        : method === 'platformResume'
          ? service.platformResume(LINK, ACTOR)
          : service.revocationPreview(LINK);
    await expect(call).rejects.toThrow(NotFoundException);
  });
});
