import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InstallationBookingService, VISIT_RETENTION_DAYS } from './installation-booking.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA PAGE PUBLIQUE DE PRISE DE RDV — CE QU'ELLE RETIENT D'UN VISITEUR, ET CE QU'ELLE PROMET
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Trois familles de tests :
 *  - les VISITES : ce qui est stocké (IP tronquée, famille d'appareil, hôte du referrer),
 *    ce qui ne l'est pas, qui compte (les humains) et qui ne compte pas (les robots) ;
 *  - le WEEK-END : ses horaires propres, et les configurations qu'on refuse à la création ;
 *  - « PRÉVENEZ-MOI » : la promesse tenue par l'entretien quotidien — une fois par inscription,
 *    jamais sur un lien fermé, jamais sans créneau.
 */

const FLEET = 'aaaaaaaa-0000-4000-8000-000000000001';
const LINK = 'bbbbbbbb-0000-4000-8000-000000000002';
const VISITE = 'cccccccc-0000-4000-8000-000000000003';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Un lien vivant, tel que la base le rendrait. Semaine 08:00–21:00, créneaux de 2 h. */
function lien(over: Record<string, unknown> = {}) {
  return {
    id: LINK, fleetId: FLEET, fleet: { name: 'Transports Legrand' }, planId: null, label: 'Pose Legrand',
    token: 'tok', clientName: null, clientEmail: null, clientPhone: null, clientAddress: null,
    slotMinutes: 120, dayStartMinutes: 480, dayEndMinutes: 1260, workingDays: [1, 2, 3, 4, 5],
    weekendStartMinutes: null, weekendEndMinutes: null, horizonDays: 14, leadDays: 1,
    active: true, singleUse: false, expiresAt: null, openCount: 0, firstOpenedAt: null, lastOpenedAt: null,
    createdBy: null, createdAt: new Date('2026-09-01T08:00:00Z'), updatedAt: new Date('2026-09-01T08:00:00Z'),
    ...over,
  };
}

function service(o: { lien?: Record<string, unknown> | null; executeRaw?: number; abonnes?: unknown[]; envoiOk?: boolean } = {}) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const visitCreate = jest.fn(async ({ data }: any) => ({ id: VISITE, ...data }));
  const linkUpdate = jest.fn(async ({ data }: any) => lien({ ...data, fleet: { name: 'Transports Legrand' } }));
  const executeRaw = jest.fn().mockResolvedValue(o.executeRaw ?? 1);
  const bookingCreate = jest.fn(async ({ data }: any) => ({ id: 'book-1', ...data }));
  const watcherUpsert = jest.fn().mockResolvedValue({});
  const watcherUpdate = jest.fn().mockResolvedValue({});
  const prisma: any = {
    fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET, name: 'Transports Legrand' }) },
    installationPlan: { findUnique: jest.fn() },
    installationBookingLink: {
      findUnique: jest.fn().mockResolvedValue(o.lien === null ? null : lien(o.lien ?? {})),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => lien({ ...data, id: LINK, fleet: { name: 'Transports Legrand' } })),
      update: linkUpdate,
      delete: jest.fn(),
    },
    installationBookingLinkVisit: {
      create: visitCreate,
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    installationBooking: {
      findMany: jest.fn().mockResolvedValue([]),
      create: bookingCreate,
      groupBy: jest.fn().mockResolvedValue([]),
    },
    installationSlotWatcher: {
      upsert: watcherUpsert,
      findMany: jest.fn().mockResolvedValue(o.abonnes ?? []),
      update: watcherUpdate,
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: executeRaw,
  };
  const send = jest.fn().mockResolvedValue(o.envoiOk === false ? { ok: false, error: 'smtp' } : { ok: true });
  const email: any = {
    send,
    buildInstallationSlotRequestedEmail: () => ({ subject: 's', html: '<p>h</p>', text: 't' }),
    buildInstallationSlotAvailableEmail: jest.fn(() => ({ subject: 'dispo', html: '<p>h</p>', text: 't' })),
  };
  const config: any = {
    get: (k: string) => ({
      APP_BASE_URL: 'https://app-tracky.vizyoagency.com',
      VITRINE_BASE_URL: 'https://tracky.vizyoagency.com',
      INSTALLATION_PUBLIC_PHONE: '05 61 00 00 00',
    })[k],
  };
  const activity: any = { record: jest.fn() };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const svc = new InstallationBookingService(prisma, email, config, activity);
  return { svc, prisma, visitCreate, linkUpdate, executeRaw, bookingCreate, watcherUpdate, send, email, activity };
}

// ─── Les visites ─────────────────────────────────────────────────────────────

describe('page publique — ce qu’une visite retient du visiteur', () => {
  it('une ouverture crée une visite : IP tronquée, famille d’appareil, hôte du referrer — jamais les bruts', async () => {
    const { svc, visitCreate, linkUpdate, activity } = service();
    const res = await svc.getPublicLink('tok', {
      ip: '92.184.101.7', userAgent: IPHONE,
      referrer: 'https://mail.google.com/mail/u/0/#inbox/abc?token=secret',
    });

    expect(res.visite).toEqual({ id: VISITE });
    const data = visitCreate.mock.calls[0][0].data;
    expect(data.ipTruncated).toBe('92.184.x.x');
    expect(data.device).toBe('mobile');
    expect(data.os).toBe('iOS');
    expect(data.browser).toBe('Safari');
    expect(data.referrerHost).toBe('mail.google.com');
    expect(data.robot).toBe(false);
    expect(JSON.stringify(data)).not.toContain('92.184.101.7');
    expect(JSON.stringify(data)).not.toContain('AppleWebKit');
    expect(JSON.stringify(data)).not.toContain('secret');
    // Le premier geste est l'ouverture, horodaté par le serveur.
    expect(data.events).toEqual([expect.objectContaining({ type: 'ouverture', target: 'nouvelle' })]);
    // Un humain compte : le compteur du lien bouge, et la 1re ouverture va au feed Système.
    expect(linkUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ openCount: { increment: 1 }, firstOpenedAt: expect.any(Date) }),
    }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'booking_link_opened' }));
  });

  it('un lien NOMINATIF pose une identité PRÉSUMÉE (LIEN_DIRECT) — pas certaine', async () => {
    const { svc, visitCreate } = service({ lien: { clientName: 'Marc Legrand', clientEmail: 'marc@legrand.fr' } });
    await svc.getPublicLink('tok', { ip: '10.0.0.1', userAgent: IPHONE });
    const data = visitCreate.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({
      contactName: 'Marc Legrand', contactEmail: 'marc@legrand.fr', identitySource: 'LIEN_DIRECT',
    }));
  });

  it('un lien anonyme ne pose AUCUNE identité', async () => {
    const { svc, visitCreate } = service();
    await svc.getPublicLink('tok', { ip: '10.0.0.1', userAgent: IPHONE });
    const data = visitCreate.mock.calls[0][0].data;
    expect(data.contactName).toBeNull();
    expect(data.contactEmail).toBeNull();
    expect(data.identitySource).toBeNull();
  });

  it('un ROBOT d’aperçu (WhatsApp) est enregistré comme tel, mais ne compte pas comme « le client a ouvert »', async () => {
    const { svc, visitCreate, linkUpdate, activity } = service();
    await svc.getPublicLink('tok', { ip: '31.13.0.1', userAgent: 'WhatsApp/2.23.20.0 A' });
    expect(visitCreate.mock.calls[0][0].data.robot).toBe(true);
    expect(linkUpdate).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('un RECHARGEMENT réutilise la visite passée en `visiteId` : aucune visite créée, un geste « rechargement »', async () => {
    const { svc, visitCreate, executeRaw, linkUpdate } = service({ executeRaw: 1 });
    const res = await svc.getPublicLink('tok', { ip: '10.0.0.1', userAgent: IPHONE, visiteId: VISITE });
    expect(res.visite).toEqual({ id: VISITE });
    expect(visitCreate).not.toHaveBeenCalled();
    expect(linkUpdate).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sql = executeRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('"events" || ');
    expect(sql).toContain('"linkId" = ');
    expect(executeRaw.mock.calls[0].slice(1)).toEqual(expect.arrayContaining([
      expect.stringContaining('"rechargement"'), VISITE, LINK,
    ]));
  });

  it('une `visiteId` inconnue (purgée, ou d’un autre lien) ouvre une visite neuve, sans bruit', async () => {
    const { svc, visitCreate } = service({ executeRaw: 0 });
    const res = await svc.getPublicLink('tok', { ip: '10.0.0.1', userAgent: IPHONE, visiteId: VISITE });
    expect(visitCreate).toHaveBeenCalledTimes(1);
    expect(res.visite).toEqual({ id: VISITE });
  });

  it('le suivi est BEST-EFFORT : une base qui refuse la visite ne prive pas le client de ses créneaux', async () => {
    const { svc, prisma } = service();
    prisma.installationBookingLinkVisit.create.mockRejectedValue(new Error('disque plein'));
    const res = await svc.getPublicLink('tok', { ip: '10.0.0.1', userAgent: IPHONE });
    expect(res.visite).toBeNull();
    expect(res.days.length).toBeGreaterThan(0);
  });

  it('la page ne peut poser que SES gestes : un événement est concaténé côté base, borné, sur le bon lien', async () => {
    const { svc, executeRaw } = service();
    await expect(svc.enregistrerEvenement('tok', VISITE, { type: 'decouverte', target: 'video:supervision' })).resolves.toEqual({ ok: true });
    const params = executeRaw.mock.calls[0].slice(1);
    expect(params[0]).toContain('"type":"decouverte"');
    expect(params[0]).toContain('"target":"video:supervision"');
    expect(params).toEqual(expect.arrayContaining([VISITE, LINK]));
  });

  it('un token inconnu → 404 (et pas un « ok » qui cacherait un lien mort)', async () => {
    const { svc } = service({ lien: null });
    await expect(svc.enregistrerEvenement('nope', VISITE, { type: 'jour' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('page publique — la réservation identifie la visite, un échec s’y lit aussi', () => {
  const premierCreneau = async (svc: InstallationBookingService) => {
    const page = await svc.getPublicLink('tok', {});
    return page.days[0].slots[0].startAt;
  };

  it('une réservation pose une identité CERTAINE (RESERVATION), rattache la demande et ajoute le geste', async () => {
    const { svc, prisma, executeRaw } = service();
    const startAt = await premierCreneau(svc);
    executeRaw.mockClear();
    const res = await svc.createPublicBooking('tok', {
      startAt, clientName: 'Marc Legrand', clientEmail: 'marc@legrand.fr', visiteId: VISITE,
    });
    expect(res.ok).toBe(true);
    expect(prisma.installationBookingLinkVisit.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: VISITE, linkId: LINK, bookingId: null }),
      data: expect.objectContaining({
        contactName: 'Marc Legrand', contactEmail: 'marc@legrand.fr', identitySource: 'RESERVATION', bookingId: 'book-1',
      }),
    }));
    expect(executeRaw.mock.calls[0].slice(1)[0]).toContain('"type":"reservation"');
  });

  it('sans `visiteId`, la réservation fonctionne exactement comme avant', async () => {
    const { svc, prisma, executeRaw } = service();
    const startAt = await premierCreneau(svc);
    executeRaw.mockClear();
    await svc.createPublicBooking('tok', { startAt, clientName: 'Marc', clientEmail: 'm@l.fr' });
    expect(prisma.installationBookingLinkVisit.updateMany).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('un créneau pris entre-temps (EXCLUDE) → 409, et la chronologie dit « reservation_echec »', async () => {
    const { svc, bookingCreate, executeRaw } = service();
    const startAt = await premierCreneau(svc);
    bookingCreate.mockRejectedValueOnce(Object.assign(new Error('no_overlap_installation_booking'), { code: '23P01' }));
    executeRaw.mockClear();
    await expect(svc.createPublicBooking('tok', { startAt, clientName: 'Marc', clientEmail: 'm@l.fr', visiteId: VISITE }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(executeRaw.mock.calls[0].slice(1)[0]).toContain('"type":"reservation_echec"');
  });

  it('« prévenez-moi » pose ABONNEMENT — sans jamais rétrograder une RESERVATION', async () => {
    const { svc, prisma, executeRaw } = service();
    await svc.watchSlots('tok', 'Marc@Legrand.fr', VISITE);
    const call = prisma.installationBookingLinkVisit.updateMany.mock.calls[0][0];
    expect(call.data).toEqual(expect.objectContaining({ contactEmail: 'marc@legrand.fr', identitySource: 'ABONNEMENT' }));
    // Le WHERE énumère ce qu'un abonnement a le droit d'écraser (null, LIEN_DIRECT, ABONNEMENT).
    expect(call.where.OR).toEqual([{ identitySource: null }, { identitySource: { in: ['LIEN_DIRECT', 'ABONNEMENT'] } }]);
    expect(executeRaw.mock.calls[0].slice(1)[0]).toContain('"type":"abonnement"');
  });
});

describe('page publique — ce qu’elle annonce', () => {
  it('les liens « découvrir » pointent sur la vitrine avec `?from=rdv-installation` et leurs ancres', async () => {
    const { svc } = service();
    const page = await svc.getPublicLink('tok', {});
    expect(page.decouverte.presentationUrl).toBe('https://tracky.vizyoagency.com/decouvrir.html?from=rdv-installation');
    expect(page.decouverte.depotUrl).toBe('https://tracky.vizyoagency.com/decouvrir-depot.html?from=rdv-installation');
    expect(page.decouverte.videos.map((v) => v.id)).toEqual(['supervision', 'analyse', 'administration', 'depot']);
    expect(page.decouverte.videos[0].url).toBe('https://tracky.vizyoagency.com/decouvrir.html?from=rdv-installation#supervision');
    expect(page.decouverte.videos[3].url).toBe('https://tracky.vizyoagency.com/decouvrir-depot.html?from=rdv-installation#suivre');
    expect(page.telephonePublic).toBe('05 61 00 00 00');
  });

  it('`weekendOuvert` suit les jours cochés, et chaque jour dit s’il est un week-end', async () => {
    const semaine = await service().svc.getPublicLink('tok', {});
    expect(semaine.weekendOuvert).toBe(false);
    expect(semaine.days.every((d) => d.weekend === false)).toBe(true);

    const we = await service({ lien: { workingDays: [1, 2, 3, 4, 5, 6], weekendStartMinutes: 540, weekendEndMinutes: 780 } }).svc.getPublicLink('tok', {});
    expect(we.weekendOuvert).toBe(true);
    const samedi = we.days.find((d) => d.weekend)!;
    expect(samedi).toBeDefined();
    expect(samedi.slots.map((s) => s.label)).toEqual(['09:00 – 11:00', '11:00 – 13:00']);
  });
});

// ─── Le week-end à la création / modification d'un lien ──────────────────────

describe('liens — les horaires du week-end sont validés à la création', () => {
  const base = { fleetId: FLEET, label: 'Pose' };

  it('semaine seule, sans horaires week-end : accepté (le comportement d’avant)', async () => {
    const { svc } = service();
    const l = await svc.createLink(null, { ...base });
    expect(l.weekendStartMinutes).toBeNull();
    expect(l.weekendEndMinutes).toBeNull();
  });

  it('samedi coché avec une matinée 09:00–13:00 : accepté et conservé', async () => {
    const { svc, prisma } = service();
    const l = await svc.createLink(null, { ...base, workingDays: [1, 2, 3, 4, 5, 6], weekendStartMinutes: 540, weekendEndMinutes: 780 });
    expect(l.weekendStartMinutes).toBe(540);
    expect(l.weekendEndMinutes).toBe(780);
    expect(prisma.installationBookingLink.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      weekendStartMinutes: 540, weekendEndMinutes: 780,
    }));
  });

  it('un début SANS fin (ou l’inverse) → 400', async () => {
    const { svc } = service();
    await expect(svc.createLink(null, { ...base, workingDays: [6], weekendStartMinutes: 540 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createLink(null, { ...base, workingDays: [6], weekendEndMinutes: 780 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('une plage week-end plus courte qu’un créneau → 400 (sinon la page dirait « aucun créneau » sans raison)', async () => {
    const { svc } = service();
    await expect(svc.createLink(null, { ...base, workingDays: [6, 7], weekendStartMinutes: 540, weekendEndMinutes: 600 }))
      .rejects.toThrow(/week-end/);
  });

  it('une plage de SEMAINE plus courte qu’un créneau → 400 aussi', async () => {
    const { svc } = service();
    await expect(svc.createLink(null, { ...base, dayStartMinutes: 480, dayEndMinutes: 540 })).rejects.toThrow(/semaine/);
  });

  it('aucun jour coché → 400', async () => {
    const { svc } = service();
    await expect(svc.createLink(null, { ...base, workingDays: [] })).rejects.toThrow(/au moins un jour/);
  });

  it('à la MODIFICATION, c’est la configuration résultante qui est validée (existant + changement)', async () => {
    // Le lien a une matinée de week-end (4 h) ; on allonge les créneaux à 5 h : la matinée ne les contient plus.
    const { svc } = service({ lien: { workingDays: [1, 6], weekendStartMinutes: 540, weekendEndMinutes: 780 } });
    await expect(svc.updateLink(LINK, { slotMinutes: 300 })).rejects.toThrow(/week-end/);
    // Repasser le week-end sur « comme la semaine » (null explicite) le répare.
    await expect(svc.updateLink(LINK, { slotMinutes: 300, weekendStartMinutes: null, weekendEndMinutes: null })).resolves.toBeDefined();
  });
});

// ─── « Prévenez-moi » : la promesse tenue ────────────────────────────────────

describe('entretien — prévenir les abonnés quand des créneaux réapparaissent', () => {
  const abonne = (over: Record<string, unknown> = {}) => ({
    id: 'w1', linkId: LINK, email: 'client@ex.fr', notifiedAt: null,
    expiresAt: new Date(Date.now() + 30 * 86_400_000), link: lien(), ...over,
  });

  it('un lien ouvert avec des créneaux : e-mail envoyé, `notifiedAt` posé, feed Système alimenté', async () => {
    const { svc, send, watcherUpdate, email, activity } = service({ abonnes: [abonne(), abonne({ id: 'w2', email: 'autre@ex.fr' })] });
    const n = await svc.notifierAbonnesCreneauxLibres(new Date('2026-09-14T06:00:00Z'));
    expect(n).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'client@ex.fr', template: 'installation_slot_available' }));
    expect(email.buildInstallationSlotAvailableEmail).toHaveBeenCalledWith(expect.objectContaining({
      companyName: 'Transports Legrand',
      bookingUrl: 'https://app-tracky.vizyoagency.com/book/tok',
      nextSlotLabel: expect.stringMatching(/\d{2}:\d{2} – \d{2}:\d{2}/),
    }));
    expect(watcherUpdate).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { notifiedAt: expect.any(Date) } });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'slot_watch_notified' }));
  });

  it('un lien FERMÉ ne prévient personne : la promesse ne vaut que tant qu’on peut réserver', async () => {
    const { svc, send } = service({ abonnes: [abonne({ link: lien({ active: false }) })] });
    expect(await svc.notifierAbonnesCreneauxLibres()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('sans créneau proposable, on attend le lendemain', async () => {
    // Fenêtre de semaine trop courte pour un créneau → aucune disponibilité.
    const { svc, send } = service({ abonnes: [abonne({ link: lien({ dayStartMinutes: 480, dayEndMinutes: 540 }) })] });
    expect(await svc.notifierAbonnesCreneauxLibres()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('un envoi qui échoue ne marque PAS l’abonné prévenu : il le sera au passage suivant', async () => {
    const { svc, watcherUpdate } = service({ abonnes: [abonne()], envoiOk: false });
    expect(await svc.notifierAbonnesCreneauxLibres()).toBe(0);
    expect(watcherUpdate).not.toHaveBeenCalled();
  });

  it('la purge des visites vise `openedAt` plus vieux que la rétention', async () => {
    const { svc, prisma } = service();
    const maintenant = new Date('2026-09-14T06:00:00Z');
    expect(await svc.purgerVisitesAnciennes(maintenant)).toBe(3);
    const plancher = prisma.installationBookingLinkVisit.deleteMany.mock.calls[0][0].where.openedAt.lt as Date;
    expect(maintenant.getTime() - plancher.getTime()).toBe(VISIT_RETENTION_DAYS * 86_400_000);
  });
});

// ─── L'écran admin ───────────────────────────────────────────────────────────

describe('admin — les visites d’un lien, lisibles', () => {
  it('rend la provenance dérivée et les compteurs humains / robots / avec réservation', async () => {
    const { svc, prisma } = service();
    prisma.installationBookingLinkVisit.findMany.mockResolvedValue([{
      id: VISITE, openedAt: new Date('2026-09-14T08:00:00Z'), lastSeenAt: new Date('2026-09-14T08:05:00Z'),
      ipTruncated: '92.184.x.x', device: 'mobile', os: 'iOS', browser: 'Safari', referrerHost: 'mail.google.com',
      robot: false, contactName: 'Marc', contactEmail: 'm@l.fr', identitySource: 'RESERVATION',
      events: [{ t: '2026-09-14T08:00:00.000Z', type: 'ouverture', target: 'nouvelle' }], eventCount: 1, bookingId: 'book-1',
    }]);
    prisma.installationBookingLinkVisit.count
      .mockResolvedValueOnce(4).mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const res = await svc.listerVisites(LINK);
    expect(res).toEqual(expect.objectContaining({ linkId: LINK, humaines: 4, robots: 2, avecReservation: 1 }));
    expect(res.visites[0]).toEqual(expect.objectContaining({
      provenance: 'Gmail', device: 'mobile', identitySource: 'RESERVATION', bookingId: 'book-1',
    }));
    expect(res.visites[0].events).toHaveLength(1);
  });

  it('la liste des liens porte les visites humaines et les robots séparément', async () => {
    const { svc, prisma } = service();
    prisma.installationBookingLink.findMany.mockResolvedValue([lien()]);
    prisma.installationBookingLinkVisit.groupBy.mockResolvedValue([
      { linkId: LINK, robot: false, _count: { _all: 5 } },
      { linkId: LINK, robot: true, _count: { _all: 2 } },
    ]);
    const [l] = await svc.listLinks();
    expect(l.visitCount).toBe(5);
    expect(l.robotVisitCount).toBe(2);
  });
});
