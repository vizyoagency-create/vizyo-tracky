import { UnauthorizedException } from '@nestjs/common';
import { PartnerLinkStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { PartnerConfigService } from './partner.config';
import { PartnerTokenService } from './partner-token.service';

const SECRET = 'secret-de-lien-remis-par-le-handshake';
const HASH = createHash('sha256').update(SECRET).digest('hex');
const LINK = 'link-1';

const activeLink = (o: Record<string, unknown> = {}) => ({
  id: LINK,
  fleetId: 'fleet-1',
  status: PartnerLinkStatus.ACTIVE,
  suspendedByPlatform: false,
  secretHash: HASH,
  scopes: ['VEHICLE_IDENTITY', 'FUEL'],
  ...o,
});

function makeService(opts: { link?: unknown; tokenRow?: unknown } = {}) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    partnerLink: {
      // `'link' in opts` et non `??` : un `link: null` explicite (lien inconnu)
      // doit rester null, pas retomber sur le lien actif par défaut.
      findUnique: jest.fn(async () => ('link' in opts ? opts.link : activeLink())),
      update: jest.fn(async () => ({})),
    },
    partnerAccessToken: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
      findUnique: jest.fn(async () => opts.tokenRow ?? null),
      updateMany: jest.fn(async () => ({ count: 2 })),
    },
  } as unknown as PrismaService;
  const config = { tokenTtlSeconds: 600 } as unknown as PartnerConfigService;
  return { service: new PartnerTokenService(prisma, config), prisma, created };
}

describe('issue — crédence de lien', () => {
  it('délivre un jeton opaque et renvoie les scopes AUTORITAIRES', async () => {
    // Les scopes voyagent avec le jeton : c'est le 2e chemin de la révocation
    // partielle, celui qui rattrape un webhook perdu en moins de 10 minutes.
    const { service } = makeService();
    const res = await service.issue(LINK, SECRET);

    expect(res.accessToken).toHaveLength(43); // 32 octets base64url
    expect(res.expiresIn).toBe(600);
    expect(res.scopes).toEqual(['VEHICLE_IDENTITY', 'FUEL']);
    expect(res.linkStatus).toBe(PartnerLinkStatus.ACTIVE);
  });

  it('le jeton est stocké HASHÉ, jamais en clair', async () => {
    const { service, created } = makeService();
    const res = await service.issue(LINK, SECRET);
    expect(created[0]!.tokenHash).toBe(createHash('sha256').update(res.accessToken).digest('hex'));
    expect(JSON.stringify(created[0])).not.toContain(res.accessToken);
  });

  it('deux émissions donnent des jetons différents', async () => {
    const a = makeService();
    const b = makeService();
    const t1 = await a.service.issue(LINK, SECRET);
    const t2 = await b.service.issue(LINK, SECRET);
    expect(t1.accessToken).not.toBe(t2.accessToken);
  });

  it('mauvais secret ⇒ refus', async () => {
    const { service } = makeService();
    await expect(service.issue(LINK, 'mauvais')).rejects.toThrow(UnauthorizedException);
  });

  it('lien inconnu et mauvais secret donnent la MÊME erreur', async () => {
    // Sinon on pourrait énumérer les identifiants de liens existants.
    const unknown = makeService({ link: null });
    const wrong = makeService();
    const e1 = await unknown.service.issue(LINK, SECRET).catch((e) => e.message);
    const e2 = await wrong.service.issue(LINK, 'mauvais').catch((e) => e.message);
    expect(e1).toBe(e2);
  });
});

describe('issue — lien coupé', () => {
  it.each([PartnerLinkStatus.REVOKED, PartnerLinkStatus.SUSPENDED])(
    'statut %s ⇒ aucun jeton délivré',
    async (status) => {
      const { service } = makeService({ link: activeLink({ status }) });
      await expect(service.issue(LINK, SECRET)).rejects.toThrow(UnauthorizedException);
    },
  );

  it('suspendu par la PLATEFORME ⇒ refus, même si le statut est ACTIVE', async () => {
    // ⚠️ Les deux axes sont indépendants : le levier commercial doit couper
    // l'accès sans dépendre du statut du lien.
    const { service } = makeService({ link: activeLink({ suspendedByPlatform: true }) });
    await expect(service.issue(LINK, SECRET)).rejects.toThrow(UnauthorizedException);
  });
});

describe('resolve — validation du jeton', () => {
  const tokenRow = (o: Record<string, unknown> = {}) => ({
    linkId: LINK,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    link: activeLink(),
    ...o,
  });

  it('jeton valide ⇒ contexte du lien', async () => {
    const { service } = makeService({ tokenRow: tokenRow() });
    await expect(service.resolve('tok')).resolves.toEqual({
      linkId: LINK,
      fleetId: 'fleet-1',
      scopes: ['VEHICLE_IDENTITY', 'FUEL'],
    });
  });

  it.each([
    ['inconnu', null],
    ['révoqué', tokenRow({ revokedAt: new Date() })],
    ['expiré', tokenRow({ expiresAt: new Date(Date.now() - 1000) })],
  ])('jeton %s ⇒ refus', async (_label, row) => {
    const { service } = makeService({ tokenRow: row });
    await expect(service.resolve('tok')).rejects.toThrow(UnauthorizedException);
  });

  it('jeton encore valide mais LIEN révoqué ⇒ refus', async () => {
    // Deuxième barrière : révoquer le lien suffit à couper l'accès, même si la
    // purge des jetons avait échoué. Deux garanties indépendantes.
    const { service } = makeService({
      tokenRow: tokenRow({ link: activeLink({ status: PartnerLinkStatus.REVOKED }) }),
    });
    await expect(service.resolve('tok')).rejects.toThrow(UnauthorizedException);
  });

  it('jeton encore valide mais lien suspendu par la PLATEFORME ⇒ refus', async () => {
    const { service } = makeService({
      tokenRow: tokenRow({ link: activeLink({ suspendedByPlatform: true }) }),
    });
    await expect(service.resolve('tok')).rejects.toThrow(UnauthorizedException);
  });
});

describe('revokeAllForLink', () => {
  it('révoque tous les jetons vivants et renvoie le compte', async () => {
    const { service, prisma } = makeService();
    await expect(service.revokeAllForLink(LINK)).resolves.toBe(2);
    expect(prisma.partnerAccessToken.updateMany).toHaveBeenCalledWith({
      where: { linkId: LINK, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
