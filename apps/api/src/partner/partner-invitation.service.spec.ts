import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EmailService } from '../email/email.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { PartnerClientService } from './partner-client.service';
import type { PartnerConfigService } from './partner.config';
import {
  INVITATION_TTL_HOURS,
  PartnerInvitationService,
  invitationState,
} from './partner-invitation.service';

const FLEET = 'fleet-1';
const OTHER_FLEET = 'fleet-2';
const USER = 'user-1';
const CODE = 'TRK-ABCD-EFGH-JKMN';
const APP_BASE = 'https://app.test';

function makeService(opts: {
  enabled?: boolean;
  invitations?: any[];
  liveLink?: boolean;
  emailOk?: boolean;
  vehicles?: any[];
} = {}) {
  const invitations = opts.invitations ?? [];
  const updates: any[] = [];
  const sent: any[] = [];

  const prisma = {
    fleet: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === FLEET ? { id: FLEET, name: 'Flotte Test' } : null,
      ),
    },
    partnerLink: {
      findFirst: jest.fn(async () => (opts.liveLink ? { id: 'link-1' } : null)),
    },
    partnerInvitation: {
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          invitations.find((i) => {
            if (where.pairingCode && i.pairingCode !== where.pairingCode) return false;
            if (where.fleetId?.not && i.fleetId === where.fleetId.not) return false;
            if (typeof where.fleetId === 'string' && i.fleetId !== where.fleetId) return false;
            if (where.acceptedAt === null && i.acceptedAt) return false;
            return true;
          }) ?? null
        );
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        invitations.find((i) => i.token === where.token) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => ({ id: 'inv-new', ...data })),
      update: jest.fn(async (args: any) => {
        updates.push(args);
        return args;
      }),
      findMany: jest.fn(async () => invitations.map((i) => ({ ...i, fleet: { name: 'Flotte Test' } }))),
    },
    user: {
      findFirst: jest.fn(async () => ({ firstName: 'Camille', lastName: 'Dupont', phone: null })),
    },
    vehicle: {
      // ⚠️ Reproduit fidèlement le comportement de `select` : une colonne à
      // `false` est ABSENTE de la ligne. Un mock qui renverrait tout ferait
      // passer le test alors que la donnée fuiterait en vrai.
      findMany: jest.fn(async ({ select }: any) =>
        (opts.vehicles ?? []).map((v: any) =>
          Object.fromEntries(
            Object.entries(select ?? {})
              .filter(([, wanted]) => wanted)
              .map(([key]) => [key, v[key] ?? null]),
          ),
        ),
      ),
    },
  } as unknown as PrismaService;

  const email = {
    buildPartnerConsentInvitationEmail: jest.fn(() => ({
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    })),
    send: jest.fn(async (p: any) => {
      sent.push(p);
      return { ok: opts.emailOk ?? true };
    }),
  } as unknown as EmailService;

  const config = {
    get: (k: string) => (k === 'APP_BASE_URL' ? APP_BASE : ''),
  } as unknown as ConfigService<never, true>;
  const partnerConfig = { enabled: opts.enabled ?? true } as unknown as PartnerConfigService;
  const activity = { record: jest.fn() } as unknown as SystemActivityService;

  const client = {
    provisionSpace: jest.fn(async () => ({
      organizationId: 'org-1',
      organizationName: 'Flotte Test',
      pairingCode: CODE,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      created: true,
    })),
  } as unknown as PartnerClientService;

  return {
    service: new PartnerInvitationService(
      prisma,
      email,
      config as never,
      partnerConfig,
      activity,
      client,
    ),
    prisma,
    email,
    activity,
    client,
    updates,
    sent,
  };
}

describe('send — l\'invitation à consentir', () => {
  it('crée l\'invitation PUIS envoie l\'e-mail', async () => {
    // Un e-mail parti sans trace en base est un e-mail qu'on ne retrouve pas :
    // ni pour prouver le consentement, ni pour comprendre un clic.
    const { service, prisma, email } = makeService();
    await service.send({ fleetId: FLEET, pairingCode: CODE, email: 'client@test.fr', sentByUserId: USER });

    const createOrder = (prisma.partnerInvitation.create as jest.Mock).mock.invocationCallOrder[0];
    const sendOrder = (email.send as jest.Mock).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(sendOrder!);
  });

  it('le lien de l\'e-mail passe par l\'API, pas directement par le front', async () => {
    // C'est ce détour qui permet de distinguer « n'a pas cliqué » de « a cliqué
    // puis renoncé devant l'écran de connexion ».
    const { service, email } = makeService();
    await service.send({ fleetId: FLEET, pairingCode: CODE, email: 'client@test.fr', sentByUserId: USER });

    const built = (email.buildPartnerConsentInvitationEmail as jest.Mock).mock.calls[0]![0];
    expect(built.consentUrl).toContain('/api/integrations/partner/invite/');
    expect(built.consentUrl).not.toContain('?code=');
  });

  it('le code d\'appairage ne voyage PAS dans l\'e-mail', async () => {
    // Il est remis au moment du clic, par redirection. Une boîte mail n'est pas
    // un canal maîtrisé : moins elle en contient, mieux c'est.
    const { service, email } = makeService();
    await service.send({ fleetId: FLEET, pairingCode: CODE, email: 'client@test.fr', sentByUserId: USER });

    const built = (email.buildPartnerConsentInvitationEmail as jest.Mock).mock.calls[0]![0];
    expect(JSON.stringify(built)).not.toContain(CODE);
  });

  it('l\'échec d\'envoi est tracé en ÉCHEC, pas avalé', async () => {
    const { service, activity } = makeService({ emailOk: false });
    const res = await service.send({
      fleetId: FLEET,
      pairingCode: CODE,
      email: 'client@test.fr',
      sentByUserId: USER,
    });
    expect(res.emailSent).toBe(false);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILURE' }));
  });

  it('flotte DÉJÀ connectée ⇒ refus', async () => {
    // L'inviter l'enverrait vers un écran qui refuse, en lui laissant croire
    // qu'on lui redemande son accord.
    const { service } = makeService({ liveLink: true });
    await expect(
      service.send({ fleetId: FLEET, pairingCode: CODE, email: 'c@test.fr', sentByUserId: USER }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('code DÉJÀ promis à une autre flotte ⇒ refus', async () => {
    const { service } = makeService({
      invitations: [{ fleetId: OTHER_FLEET, pairingCode: CODE, partner: 'MAESTROO' }],
    });
    await expect(
      service.send({ fleetId: FLEET, pairingCode: CODE, email: 'c@test.fr', sentByUserId: USER }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('module éteint ⇒ 404 avant toute écriture', async () => {
    const { service, prisma } = makeService({ enabled: false });
    await expect(
      service.send({ fleetId: FLEET, pairingCode: CODE, email: 'c@test.fr', sentByUserId: USER }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.partnerInvitation.create).not.toHaveBeenCalled();
  });

  it('l\'échéance vaut bien la durée annoncée', async () => {
    const { service } = makeService();
    const before = Date.now();
    const res = await service.send({
      fleetId: FLEET,
      pairingCode: CODE,
      email: 'c@test.fr',
      sentByUserId: USER,
    });
    const expected = before + INVITATION_TTL_HOURS * 3600_000;
    expect(Math.abs(res.expiresAt.getTime() - expected)).toBeLessThan(5_000);
  });
});

describe('provisionAndInvite — le client qui n\'a PAS de Maestroo', () => {
  it('fait creer l\'espace AVANT d\'ecrire quoi que ce soit chez nous', async () => {
    // Si le partenaire echoue, rien ne doit exister nulle part : le super-admin
    // recommence. L'ordre inverse laisserait une invitation vers un espace
    // inexistant, donc un lien qui mene dans le vide.
    const { service, client, prisma } = makeService();
    await service.provisionAndInvite({ fleetId: FLEET, email: 'client@test.fr', sentByUserId: USER });

    const provisionOrder = (client.provisionSpace as jest.Mock).mock.invocationCallOrder[0];
    const createOrder = (prisma.partnerInvitation.create as jest.Mock).mock.invocationCallOrder[0];
    expect(provisionOrder).toBeLessThan(createOrder!);
  });

  it('n\'envoie AUCUNE donnee de flotte a la creation de l\'espace', async () => {
    // Creer l'espace n'est pas consentir au partage. Le contenu ne part qu'apres.
    const { service, client } = makeService({
      vehicles: [{ plate: 'AA-123-BB', brand: 'Renault' }],
    });
    await service.provisionAndInvite({ fleetId: FLEET, email: 'client@test.fr', sentByUserId: USER });

    const body = (client.provisionSpace as jest.Mock).mock.calls[0]![0];
    expect(JSON.stringify(body)).not.toContain('AA-123-BB');
    expect(body).toMatchObject({ fleetId: FLEET, fleetName: 'Flotte Test', contactEmail: 'client@test.fr' });
  });

  it('utilise le code rendu par le partenaire — jamais un code invente', async () => {
    const { service, prisma } = makeService();
    await service.provisionAndInvite({ fleetId: FLEET, email: 'client@test.fr', sentByUserId: USER });
    const created = (prisma.partnerInvitation.create as jest.Mock).mock.calls[0]![0];
    expect(created.data.pairingCode).toBe(CODE);
  });

  it('flotte DEJA connectee ⇒ refus, sans creer de second espace', async () => {
    const { service, client } = makeService({ liveLink: true });
    await expect(
      service.provisionAndInvite({ fleetId: FLEET, email: 'c@test.fr', sentByUserId: USER }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.provisionSpace).not.toHaveBeenCalled();
  });

  it('module eteint ⇒ 404 avant tout appel au partenaire', async () => {
    const { service, client } = makeService({ enabled: false });
    await expect(
      service.provisionAndInvite({ fleetId: FLEET, email: 'c@test.fr', sentByUserId: USER }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.provisionSpace).not.toHaveBeenCalled();
  });
});

describe('seedVehicles — le pre-remplissage suit les scopes', () => {
  const FLOTTE = [
    { id: 'veh-uuid-1', plate: 'AA-123-BB', brand: 'Renault', model: 'Master', year: 2021, type: 'VAN', energy: 'DIESEL', seats: 3, fuelConsumptionL100km: 9.1, lastOdometerKm: 84000 },
  ];

  it('sans VEHICLE_IDENTITY ⇒ liste VIDE, le pre-remplissage ne contourne pas l\'interrupteur', async () => {
    const { service } = makeService({ vehicles: FLOTTE });
    expect(await service.seedVehicles(FLEET, ['FUEL', 'ALERTS'])).toEqual([]);
  });

  it('avec VEHICLE_IDENTITY ⇒ l\'identite part', async () => {
    const { service } = makeService({ vehicles: FLOTTE });
    const seed = await service.seedVehicles(FLEET, ['VEHICLE_IDENTITY']);
    expect(seed).toHaveLength(1);
    expect(seed[0]).toMatchObject({ plate: 'AA-123-BB', brand: 'Renault', year: 2021 });
  });

  it('chaque vehicule part avec son identifiant STABLE (C2) — la cle de jointure', async () => {
    // Sans lui, le partenaire joint par plaque : un renommage de plaque chez
    // nous cree un doublon fantome chez lui. Ce champ ne doit JAMAIS redevenir
    // optionnel dans l'envoi.
    const { service } = makeService({ vehicles: FLOTTE });
    const seed = await service.seedVehicles(FLEET, ['VEHICLE_IDENTITY']);
    expect(seed[0]!.trackyVehicleId).toBe('veh-uuid-1');
  });

  it('le compteur ne part QUE si le kilometrage est consenti', async () => {
    // Le kilometrage est un fait d'usage, pas de l'identite : il a son propre
    // interrupteur et doit le respecter.
    const { service } = makeService({ vehicles: FLOTTE });
    const sansKm = await service.seedVehicles(FLEET, ['VEHICLE_IDENTITY']);
    expect(sansKm[0]!.odometerKm).toBeNull();

    const avecKm = await service.seedVehicles(FLEET, ['VEHICLE_IDENTITY', 'MILEAGE_TRIPS']);
    expect(avecKm[0]!.odometerKm).toBe(84000);
  });
});

describe('recordOpen — le clic', () => {
  const live = () => ({
    id: 'inv-1',
    token: 'tok',
    pairingCode: CODE,
    fleetId: FLEET,
    openedAt: null,
    expiresAt: new Date(Date.now() + 3600_000),
  });

  it('redirige vers l\'écran AVEC le code pré-rempli', async () => {
    const { service } = makeService({ invitations: [live()] });
    const url = await service.recordOpen('tok', '1.2.3.4', 'Mozilla');
    expect(url).toBe(`${APP_BASE}/integrations?code=${CODE}&inv=tok`);
  });

  it('enregistre l\'IP et l\'agent — la preuve du clic', async () => {
    const { service, updates } = makeService({ invitations: [live()] });
    await service.recordOpen('tok', '1.2.3.4', 'Mozilla');
    expect(updates[0].data).toMatchObject({ openIp: '1.2.3.4', openUserAgent: 'Mozilla' });
  });

  it('le PREMIER clic fait foi — les suivants ne l\'écrasent pas', async () => {
    // `openedAt` répond à « quand le client a-t-il réagi ? ». L'écraser au 3e
    // clic ferait mentir la réponse.
    const first = new Date('2026-07-01T10:00:00Z');
    const { service, updates } = makeService({ invitations: [{ ...live(), openedAt: first }] });
    await service.recordOpen('tok', '1.2.3.4', 'Mozilla');
    expect(updates[0].data.openedAt).toBe(first);
    expect(updates[0].data.openCount).toEqual({ increment: 1 });
  });

  it('jeton INCONNU ⇒ même écran, sans rien révéler', async () => {
    // Répondre différemment dirait à un curieux quels jetons existent.
    const { service } = makeService();
    expect(await service.recordOpen('inexistant', null, null)).toBe(`${APP_BASE}/integrations`);
  });

  it('invitation EXPIRÉE ⇒ clic tracé, mais aucun code proposé', async () => {
    // Le clic dit « le client a réagi, trop tard » — information utile. Servir
    // un code périmé ne ferait que l'envoyer vers une erreur.
    const expired = { ...live(), expiresAt: new Date(Date.now() - 1000) };
    const { service, updates } = makeService({ invitations: [expired] });
    const url = await service.recordOpen('tok', '1.2.3.4', null);
    expect(url).toBe(`${APP_BASE}/integrations?invite=expired`);
    expect(updates).toHaveLength(1);
    expect(url).not.toContain(CODE);
  });
});

describe('assertCodeUsableBy — le garde anti-transfert', () => {
  it('code promis à UNE AUTRE flotte ⇒ refus', async () => {
    const { service } = makeService({
      invitations: [{ fleetId: OTHER_FLEET, pairingCode: CODE }],
    });
    await expect(service.assertCodeUsableBy(FLEET, CODE)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('code promis à CETTE flotte ⇒ autorisé', async () => {
    const { service } = makeService({ invitations: [{ fleetId: FLEET, pairingCode: CODE }] });
    await expect(service.assertCodeUsableBy(FLEET, CODE)).resolves.toBeUndefined();
  });

  it('code SANS invitation ⇒ autorisé (parcours manuel)', async () => {
    // Celui qui a généré le code est celui qui le saisit : rien à contraindre.
    const { service } = makeService();
    await expect(service.assertCodeUsableBy(FLEET, CODE)).resolves.toBeUndefined();
  });

  it('la casse et les espaces d\'un copier-coller ne contournent pas le garde', async () => {
    const { service } = makeService({ invitations: [{ fleetId: OTHER_FLEET, pairingCode: CODE }] });
    await expect(
      service.assertCodeUsableBy(FLEET, `  ${CODE.toLowerCase()} `),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('invitationState — ce que voit l\'admin', () => {
  const base = { acceptedAt: null, openedAt: null, expiresAt: new Date(Date.now() + 1000) };

  it('accepté l\'emporte sur tout le reste, même expiré', () => {
    // Une invitation acceptée puis expirée reste un consentement obtenu.
    const state = invitationState({
      ...base,
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(state).toBe('ACCEPTED');
  });

  it('expiré l\'emporte sur ouvert', () => {
    const state = invitationState({
      ...base,
      openedAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(state).toBe('EXPIRED');
  });

  it('ouvert, puis envoyé', () => {
    expect(invitationState({ ...base, openedAt: new Date() })).toBe('OPENED');
    expect(invitationState(base)).toBe('SENT');
  });
});
