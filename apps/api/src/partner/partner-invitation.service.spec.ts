import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EmailService } from '../email/email.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
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

  return {
    service: new PartnerInvitationService(prisma, email, config as never, partnerConfig, activity),
    prisma,
    email,
    activity,
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
