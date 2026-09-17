import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InstallationBookingService, PLAQUE_A_CONFIRMER, VISIT_RETENTION_DAYS } from './installation-booking.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA PAGE PUBLIQUE DE PRISE DE RDV — CE QU'ELLE RETIENT D'UN VISITEUR, ET CE QU'ELLE PROMET
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Les familles de tests :
 *  - les VISITES : ce qui est stocké (IP tronquée, famille d'appareil, hôte du referrer),
 *    ce qui ne l'est pas, qui compte (les humains) et qui ne compte pas (les robots) ;
 *  - le WEEK-END : ses horaires propres, et les configurations qu'on refuse à la création ;
 *  - « PRÉVENEZ-MOI » : la promesse tenue par l'entretien quotidien — une fois par inscription,
 *    jamais sur un lien fermé, jamais sans créneau ;
 *  - LOT A (conception v2, 17/09) : le lien PROSPECT (sans flotte), le CONTACT obligatoire, le
 *    MULTI-VÉHICULES (2 h × n), la VALIDATION qui rattache ou crée la société, l'ANNULATION par
 *    l'opérateur, le REFUS qui prévient vraiment, et la SUPPRESSION d'un lien qui demande quoi
 *    faire des demandes.
 */

const FLEET = 'aaaaaaaa-0000-4000-8000-000000000001';
const LINK = 'bbbbbbbb-0000-4000-8000-000000000002';
const VISITE = 'cccccccc-0000-4000-8000-000000000003';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Un lien vivant, tel que la base le rendrait. Semaine 08:00–21:00, créneaux de 2 h. */
function lien(over: Record<string, unknown> = {}) {
  return {
    id: LINK, fleetId: FLEET, fleet: { name: 'Transports Legrand' }, companyName: null, maxVehicles: 3,
    creator: { firstName: 'Youness', lastName: 'Haddou', email: 'y@vizyo.fr' },
    planId: null, label: 'Pose Legrand',
    token: 'tok', clientName: null, clientEmail: null, clientPhone: null, clientAddress: null,
    slotMinutes: 120, dayStartMinutes: 480, dayEndMinutes: 1260, workingDays: [1, 2, 3, 4, 5],
    weekendStartMinutes: null, weekendEndMinutes: null, horizonDays: 14, leadDays: 1,
    active: true, singleUse: false, expiresAt: null, openCount: 0, firstOpenedAt: null, lastOpenedAt: null,
    createdBy: null, createdAt: new Date('2026-09-01T08:00:00Z'), updatedAt: new Date('2026-09-01T08:00:00Z'),
    ...over,
  };
}

/** Un lien PROSPECT : pas de flotte, juste le nom de la société. */
const PROSPECT = { fleetId: null, fleet: null, companyName: 'Garage Martin', planId: null };

/** Un client qui remplit tout — le contact est obligatoire depuis le lot A. */
const CONTACT = { clientName: 'Marc Legrand', clientEmail: 'marc@legrand.fr', clientPhone: '06 12 34 56 78' };
const UN_VEHICULE = { vehicleCount: 1, vehicles: [{ plate: 'AB-123-CD' }] };

/** Une demande telle que la base la rendrait (avec ses inclusions). */
function demande(over: Record<string, unknown> = {}) {
  return {
    id: 'book-1', linkId: LINK, link: { label: 'Pose Legrand', planId: null }, linkLabel: 'Pose Legrand',
    fleetId: FLEET, fleet: { name: 'Transports Legrand' }, companyName: 'Transports Legrand', vehicleCount: 1,
    startAt: new Date('2026-09-24T08:00:00Z'), endAt: new Date('2026-09-24T10:00:00Z'), status: 'PENDING',
    clientName: 'Marc Legrand', clientEmail: 'marc@legrand.fr', clientPhone: '+33612345678', clientAddress: null,
    notes: null, rejectionReason: null, cancelledAt: null, cancelledBy: null, cancelReason: null,
    confirmedAt: null, confirmedBy: null, confirmer: null,
    vehicles: [{ id: 'v1', bookingId: 'book-1', position: 0, plate: 'AB-123-CD', brand: 'Renault', model: 'Master', energy: 'DIESEL', taskId: null }],
    tasks: [],
    createdAt: new Date('2026-09-20T08:00:00Z'), updatedAt: new Date('2026-09-20T08:00:00Z'),
    ...over,
  };
}

function service(o: {
  lien?: Record<string, unknown> | null; executeRaw?: number; abonnes?: unknown[]; envoiOk?: boolean;
  demande?: Record<string, unknown> | null; managerConfigure?: boolean;
} = {}) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const visitCreate = jest.fn(async ({ data }: any) => ({ id: VISITE, ...data }));
  const linkUpdate = jest.fn(async ({ data }: any) => lien({ ...data, fleet: { name: 'Transports Legrand' } }));
  const executeRaw = jest.fn().mockResolvedValue(o.executeRaw ?? 1);
  const bookingCreate = jest.fn(async ({ data }: any) => ({ id: 'book-1', ...data }));
  const bookingUpdate = jest.fn(async ({ data }: any) => demande({ ...(o.demande ?? {}), ...data }));
  let nTaches = 0;
  const taskCreate = jest.fn(async ({ data }: any) => ({ id: `task-${nTaches++}`, ...data }));
  const watcherUpsert = jest.fn().mockResolvedValue({});
  const watcherUpdate = jest.fn().mockResolvedValue({});
  const prisma: any = {
    fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET, name: 'Transports Legrand' }) },
    user: { findUnique: jest.fn().mockResolvedValue({ firstName: 'Youness', lastName: 'Haddou', email: 'y@vizyo.fr' }) },
    installationPlan: {
      findUnique: jest.fn(),
      create: jest.fn(async ({ data }: any) => ({ id: 'plan-1', ...data })),
    },
    installationTask: {
      aggregate: jest.fn().mockResolvedValue({ _max: { orderIndex: null } }),
      create: taskCreate,
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    installationBookingVehicle: { update: jest.fn().mockResolvedValue({}) },
    installationBookingLink: {
      findUnique: jest.fn().mockResolvedValue(o.lien === null ? null : lien(o.lien ?? {})),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => lien({ ...data, id: LINK, fleet: data.fleetId ? { name: 'Transports Legrand' } : null })),
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
      findUnique: jest.fn().mockResolvedValue(o.demande === null ? null : demande(o.demande ?? {})),
      create: bookingCreate,
      update: bookingUpdate,
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    installationSlotWatcher: {
      upsert: watcherUpsert,
      findMany: jest.fn().mockResolvedValue(o.abonnes ?? []),
      update: watcherUpdate,
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: executeRaw,
    // La transaction interactive rejoue les mêmes mocks : ce qu'on vérifie, c'est la SÉQUENCE.
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const send = jest.fn().mockResolvedValue(o.envoiOk === false ? { ok: false, error: 'smtp' } : { ok: true });
  const email: any = {
    send,
    buildInstallationSlotRequestedEmail: jest.fn(() => ({ subject: 's', html: '<p>h</p>', text: 't' })),
    buildInstallationSlotAvailableEmail: jest.fn(() => ({ subject: 'dispo', html: '<p>h</p>', text: 't' })),
    buildInstallationSlotConfirmedEmail: jest.fn(() => ({ subject: 'ok', html: '<p>h</p>', text: 't' })),
    buildInstallationSlotRejectedEmail: jest.fn(() => ({ subject: 'refus', html: '<p>h</p>', text: 't' })),
    buildInstallationSlotCancelledEmail: jest.fn(() => ({ subject: 'annulé', html: '<p>h</p>', text: 't' })),
  };
  const config: any = {
    get: (k: string) => ({
      APP_BASE_URL: 'https://app-tracky.vizyoagency.com',
      VITRINE_BASE_URL: 'https://tracky.vizyoagency.com',
      INSTALLATION_PUBLIC_PHONE: '05 61 00 00 00',
    })[k],
  };
  const activity: any = { record: jest.fn() };
  const manager: any = {
    estConfigure: jest.fn(() => o.managerConfigure ?? false),
    urlNouveauClient: jest.fn(() => 'https://manager.vizyoagency.com/admin/clients/new?companyName=Garage+Martin'),
    creerClient: jest.fn().mockResolvedValue({ clientId: 'cli-1', trackyFleetId: FLEET }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const svc = new InstallationBookingService(prisma, email, config, activity, manager);
  return { svc, prisma, visitCreate, linkUpdate, executeRaw, bookingCreate, bookingUpdate, taskCreate, watcherUpdate, send, email, activity, manager };
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
    const res = await svc.createPublicBooking('tok', { startAt, ...CONTACT, ...UN_VEHICULE, visiteId: VISITE });
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
    await svc.createPublicBooking('tok', { startAt, ...CONTACT, ...UN_VEHICULE });
    expect(prisma.installationBookingLinkVisit.updateMany).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('un créneau pris entre-temps (EXCLUDE) → 409, et la chronologie dit « reservation_echec »', async () => {
    const { svc, bookingCreate, executeRaw } = service();
    const startAt = await premierCreneau(svc);
    bookingCreate.mockRejectedValueOnce(Object.assign(new Error('no_overlap_installation_booking'), { code: '23P01' }));
    executeRaw.mockClear();
    await expect(svc.createPublicBooking('tok', { startAt, ...CONTACT, ...UN_VEHICULE, visiteId: VISITE }))
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

// ─── Lot A — le lien prospect ────────────────────────────────────────────────

describe('lot A — un lien sans flotte (prospect) porte au moins le nom de la société', () => {
  it('sans flotte ni société → 400 : la page publique n’aurait rien à afficher', async () => {
    const { svc } = service();
    await expect(svc.createLink('u1', { label: 'Pose' })).rejects.toThrow(/nom de la société/);
  });

  it('sans flotte mais avec une société : créé, `fleetId` null, société conservée, créateur nommé', async () => {
    const { svc, prisma } = service();
    const l = await svc.createLink('u1', { label: 'Pose', companyName: '  Garage Martin ', maxVehicles: 2 });
    expect(prisma.installationBookingLink.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      fleetId: null, companyName: 'Garage Martin', maxVehicles: 2, createdBy: 'u1',
    }));
    expect(l.fleetId).toBeNull();
    expect(l.fleetName).toBeNull();
    expect(l.companyName).toBe('Garage Martin');
    expect(l.createdByName).toBe('Youness Haddou');
  });

  it('un planning ne se rattache qu’avec une flotte → 400', async () => {
    const { svc } = service();
    await expect(svc.createLink('u1', { label: 'Pose', companyName: 'Garage Martin', planId: 'plan-x' })).rejects.toThrow(/flotte/);
  });

  it('une flotte inconnue → 404', async () => {
    const { svc, prisma } = service();
    prisma.fleet.findUnique.mockResolvedValue(null);
    await expect(svc.createLink('u1', { label: 'Pose', fleetId: FLEET })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la page publique d’un lien prospect annonce la société, et le contact est toujours demandé', async () => {
    const { svc } = service({ lien: PROSPECT });
    const page = await svc.getPublicLink('tok', {});
    expect(page.companyName).toBe('Garage Martin');
    expect(page.needsClientInfo).toBe(true);
    expect(page.contactRequis).toEqual({ email: true, telephone: true });
    expect(page.maxVehicles).toBe(3);
  });

  it('à la modification, on peut RATTACHER une flotte à un lien prospect — et ses demandes la reçoivent', async () => {
    const { svc, prisma, linkUpdate } = service({ lien: PROSPECT });
    await svc.updateLink(LINK, { fleetId: FLEET });
    expect(linkUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ fleetId: FLEET }) }));
    expect(prisma.installationBooking.updateMany).toHaveBeenCalledWith({
      where: { linkId: LINK, fleetId: null }, data: { fleetId: FLEET },
    });
  });

  it('mais on ne CHANGE jamais la flotte d’un lien qui en a une → 400', async () => {
    const { svc } = service();
    await expect(svc.updateLink(LINK, { fleetId: 'dddddddd-0000-4000-8000-000000000004' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── Lot A — le contact et les véhicules d'une demande ───────────────────────

describe('lot A — la demande exige un contact joignable et décrit ses véhicules', () => {
  const premierCreneau = async (svc: InstallationBookingService, n = 1) => {
    const page = await svc.getPublicLink('tok', {}, n);
    return page.days[0].slots[0].startAt;
  };

  it('sans téléphone valide → 400, avec l’exemple attendu', async () => {
    const { svc } = service();
    const startAt = await premierCreneau(svc);
    await expect(svc.createPublicBooking('tok', { startAt, ...CONTACT, ...UN_VEHICULE, clientPhone: '12' }))
      .rejects.toThrow(/06 12 34 56 78/);
  });

  it('un e-mail invalide → 400 ; un nom qui est un e-mail → 400', async () => {
    const { svc } = service();
    const startAt = await premierCreneau(svc);
    await expect(svc.createPublicBooking('tok', { startAt, ...CONTACT, ...UN_VEHICULE, clientEmail: 'pas-un-mail' })).rejects.toThrow(/e-mail/);
    await expect(svc.createPublicBooking('tok', { startAt, ...CONTACT, ...UN_VEHICULE, clientName: 'marc@legrand.fr' })).rejects.toThrow(/nom/);
  });

  it('le téléphone est stocké en E.164 (+33…) et l’e-mail en minuscules — la plaque en majuscules', async () => {
    const { svc, bookingCreate } = service();
    const startAt = await premierCreneau(svc);
    await svc.createPublicBooking('tok', {
      startAt, ...UN_VEHICULE, clientName: 'Marc Legrand', clientEmail: 'Marc@Legrand.FR', clientPhone: '06 12 34 56 78',
      vehicles: [{ plate: 'ab-123-cd', brand: ' Renault ' }],
    });
    const data = bookingCreate.mock.calls[0][0].data;
    expect(data.clientPhone).toBe('+33612345678');
    expect(data.clientEmail).toBe('marc@legrand.fr');
    expect(data.vehicles.create).toEqual([{ position: 0, plate: 'AB-123-CD', brand: 'Renault', model: null, energy: null }]);
  });

  it('`vehicleCount` et la liste doivent concorder → sinon 400', async () => {
    const { svc } = service();
    const startAt = await premierCreneau(svc, 2);
    await expect(svc.createPublicBooking('tok', { startAt, ...CONTACT, vehicleCount: 2, vehicles: [{}] })).rejects.toThrow(/2 véhicule/);
  });

  it('au-delà du plafond du lien → 400', async () => {
    const { svc } = service({ lien: { maxVehicles: 2 } });
    const startAt = await premierCreneau(svc);
    await expect(svc.createPublicBooking('tok', { startAt, ...CONTACT, vehicleCount: 3, vehicles: [{}, {}, {}] })).rejects.toThrow(/Au plus 2/);
  });

  it('DEUX véhicules = un créneau de 4 h : la grille le propose, la demande le réserve, les deux lignes sont créées', async () => {
    const { svc, bookingCreate } = service();
    const page = await svc.getPublicLink('tok', {}, 2);
    expect(page.vehicleCount).toBe(2);
    expect(page.days[0].slots[0].label).toBe('08:00 – 12:00');
    const startAt = page.days[0].slots[0].startAt;
    const res = await svc.createPublicBooking('tok', {
      startAt, ...CONTACT, vehicleCount: 2, vehicles: [{ plate: 'AA-111-AA' }, { brand: 'Peugeot', model: 'Expert', energy: 'DIESEL' }],
    });
    expect(res.slotLabel).toMatch(/08:00 – 12:00/);
    const data = bookingCreate.mock.calls[0][0].data;
    expect(data.vehicleCount).toBe(2);
    expect(data.endAt.getTime() - data.startAt.getTime()).toBe(240 * 60_000);
    expect(data.vehicles.create).toHaveLength(2);
    expect(data.vehicles.create[1]).toEqual({ position: 1, plate: null, brand: 'Peugeot', model: 'Expert', energy: 'DIESEL' });
  });

  it('un créneau de 1 véhicule ne vaut pas pour 2 : la demande de 2 sur une heure de fin de journée → 409', async () => {
    const { svc } = service();
    const page = await svc.getPublicLink('tok', {}, 1);
    const dernier = page.days[0].slots[page.days[0].slots.length - 1].startAt; // 19:00 – 21:00 : 2 h avant la fermeture
    await expect(svc.createPublicBooking('tok', { startAt: dernier, ...CONTACT, vehicleCount: 2, vehicles: [{}, {}] }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('la demande d’un lien PROSPECT naît sans flotte, avec le nom de la société, et l’opérateur le lit dans son e-mail', async () => {
    const { svc, bookingCreate, email, activity } = service({ lien: PROSPECT });
    const startAt = await premierCreneau(svc);
    await svc.createPublicBooking('tok', { startAt, ...CONTACT, ...UN_VEHICULE });
    const data = bookingCreate.mock.calls[0][0].data;
    expect(data.fleetId).toBeNull();
    expect(data.companyName).toBe('Garage Martin');
    expect(data.linkLabel).toBe('Pose Legrand');
    expect(email.buildInstallationSlotRequestedEmail).toHaveBeenCalledWith(expect.objectContaining({
      companyName: 'Garage Martin (prospect, sans flotte)', clientPhone: '06 12 34 56 78',
    }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'booking_requested', meta: expect.objectContaining({ prospect: true, vehicleCount: 1 }),
    }));
  });
});

// ─── Lot A — la validation ───────────────────────────────────────────────────

describe('lot A — valider une demande : une pose par véhicule, dans le planning de la société', () => {
  it('une demande SANS flotte, validée sans rien dire → 409 « sansFlotte » avec le secours Manager', async () => {
    const { svc, manager } = service({ demande: { fleetId: null, fleet: null, companyName: 'Garage Martin' } });
    const err = await svc.confirmBooking('u1', 'book-1', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(expect.objectContaining({
      sansFlotte: true, creationManagerConfiguree: false, urlManager: expect.stringContaining('manager.vizyoagency.com'),
    }));
    expect(manager.creerClient).not.toHaveBeenCalled();
  });

  it('rattacher une flotte existante : planning créé au nom de la SOCIÉTÉ, n poses reliées à la demande, lien prospect rattaché', async () => {
    const { svc, prisma, taskCreate, bookingUpdate, linkUpdate } = service({
      demande: {
        fleetId: null, fleet: null, companyName: 'Garage Martin', vehicleCount: 2,
        vehicles: [
          { id: 'v1', bookingId: 'book-1', position: 0, plate: 'AA-111-AA', brand: null, model: null, energy: null, taskId: null },
          { id: 'v2', bookingId: 'book-1', position: 1, plate: null, brand: 'Peugeot', model: 'Expert', energy: 'DIESEL', taskId: null },
        ],
      },
    });
    prisma.installationBookingLink.findUnique.mockResolvedValue({ fleetId: null, singleUse: false });
    await svc.confirmBooking('u1', 'book-1', { fleetId: FLEET, vehicles: [{ position: 1, plate: 'bb-222-bb' }] });

    expect(prisma.installationPlan.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fleetId: FLEET, clientName: 'Garage Martin', status: 'PUBLISHED' }),
    }));
    expect(taskCreate).toHaveBeenCalledTimes(2);
    expect(taskCreate.mock.calls[0][0].data).toEqual(expect.objectContaining({ planId: 'plan-1', orderIndex: 0, plate: 'AA-111-AA', bookingId: 'book-1' }));
    // La correction de l'opérateur (position 1) l'emporte sur la saisie du client, et la plaque remonte en majuscules.
    expect(taskCreate.mock.calls[1][0].data).toEqual(expect.objectContaining({ orderIndex: 1, plate: 'BB-222-BB', brand: 'Peugeot', energy: 'DIESEL' }));
    // Chaque véhicule de la demande pointe sa pose.
    expect(prisma.installationBookingVehicle.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'v2' }, data: expect.objectContaining({ plate: 'BB-222-BB', taskId: 'task-1' }),
    }));
    expect(bookingUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CONFIRMED', fleetId: FLEET, confirmedBy: 'u1' }),
    }));
    // Le lien prospect reçoit la flotte, et ses autres demandes aussi.
    expect(linkUpdate).toHaveBeenCalledWith({ where: { id: LINK }, data: { fleetId: FLEET } });
    expect(prisma.installationBooking.updateMany).toHaveBeenCalledWith({ where: { linkId: LINK, fleetId: null }, data: { fleetId: FLEET } });
  });

  it('un véhicule sans plaque devient une pose « À confirmer » — la plaque sera exigée au moment de poser', async () => {
    const { svc, taskCreate } = service({
      demande: { vehicles: [{ id: 'v1', bookingId: 'book-1', position: 0, plate: null, brand: null, model: null, energy: null, taskId: null }] },
    });
    await svc.confirmBooking('u1', 'book-1', {});
    expect(taskCreate.mock.calls[0][0].data.plate).toBe(PLAQUE_A_CONFIRMER);
    expect(taskCreate.mock.calls[0][0].data.fieldNotes).toBeNull();
  });

  it('la note du client suit la pose ; le lien à usage unique se referme', async () => {
    const { svc, prisma, taskCreate, linkUpdate } = service({ demande: { notes: 'Portail à code 1234' } });
    prisma.installationBookingLink.findUnique.mockResolvedValue({ fleetId: FLEET, singleUse: true });
    await svc.confirmBooking('u1', 'book-1', {});
    expect(taskCreate.mock.calls[0][0].data.fieldNotes).toBe('Note du client : Portail à code 1234');
    expect(linkUpdate).toHaveBeenCalledWith({ where: { id: LINK }, data: { active: false } });
  });

  it('« créer dans Manager » : Tracky ne crée JAMAIS la flotte lui-même, il rattache celle que Manager rend', async () => {
    const { svc, prisma, manager, activity } = service({
      demande: { fleetId: null, fleet: null, companyName: 'Garage Martin' }, managerConfigure: true,
    });
    await svc.confirmBooking('u1', 'book-1', { creerClient: true });
    expect(manager.creerClient).toHaveBeenCalledWith(expect.objectContaining({
      companyName: 'Garage Martin', email: 'marc@legrand.fr', contactFirstName: 'Marc', contactLastName: 'Legrand',
      phone: '+33612345678', externalRef: 'book-1',
    }));
    expect(prisma.fleet.create).toBeUndefined();
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'client_created_via_manager' }));
    expect(prisma.installationBooking.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fleetId: FLEET }),
    }));
  });

  it('une demande qui n’est plus en attente ne se valide pas', async () => {
    const { svc } = service({ demande: { status: 'CANCELLED' } });
    await expect(svc.confirmBooking('u1', 'book-1', {})).rejects.toThrow(/en attente/);
  });
});

// ─── Lot A — refus et annulation ─────────────────────────────────────────────

describe('lot A — refuser prévient vraiment ; annuler libère le créneau et retire les poses', () => {
  it('un refus avec « prévenir » envoie le modèle REFUS (plus le modèle « confirmé »), avec le lien s’il est ouvert', async () => {
    const { svc, send, email } = service();
    await svc.rejectBooking('book-1', { reason: 'Équipe absente', notifyClient: true });
    await new Promise((r) => setImmediate(r));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'marc@legrand.fr', template: 'installation_slot_rejected' }));
    expect(email.buildInstallationSlotRejectedEmail).toHaveBeenCalledWith(expect.objectContaining({
      companyName: 'Transports Legrand', reason: 'Équipe absente', bookingUrl: 'https://app-tracky.vizyoagency.com/book/tok',
    }));
  });

  it('une demande confirmée ne se refuse pas : on l’annule', async () => {
    const { svc } = service({ demande: { status: 'CONFIRMED' } });
    await expect(svc.rejectBooking('book-1', {})).rejects.toThrow(/annulez/);
  });

  it('annuler une demande CONFIRMÉE retire ses poses non faites, pose qui/quand/pourquoi, et prévient si demandé', async () => {
    const { svc, prisma, bookingUpdate, send, activity } = service({
      demande: { status: 'CONFIRMED', tasks: [{ id: 't1', planId: 'plan-1', plate: 'AB-123-CD', status: 'PENDING' }] },
    });
    const res = await svc.cancelBooking('u1', 'book-1', { reason: 'Client injoignable', notifyClient: true });
    await new Promise((r) => setImmediate(r));
    expect(prisma.installationTask.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['t1'] } } });
    expect(bookingUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CANCELLED', cancelledBy: 'Youness Haddou', cancelReason: 'Client injoignable', cancelledAt: expect.any(Date) }),
    }));
    expect(res.status).toBe('CANCELLED');
    expect(res.cancelledByName).toBe('Youness Haddou');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ template: 'installation_slot_cancelled' }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'booking_cancelled', meta: expect.objectContaining({ posesRetirees: 1 }) }));
  });

  it('une pose déjà FAITE interdit l’annulation : le boîtier est posé', async () => {
    const { svc } = service({ demande: { status: 'CONFIRMED', tasks: [{ id: 't1', planId: 'plan-1', plate: 'AB-123-CD', status: 'DONE' }] } });
    await expect(svc.cancelBooking('u1', 'book-1', {})).rejects.toThrow(/déjà été faite/);
  });

  it('sans « prévenir », aucun e-mail ne part ; une demande refusée n’a rien à annuler', async () => {
    const { svc, send } = service();
    await svc.cancelBooking('u1', 'book-1', {});
    await new Promise((r) => setImmediate(r));
    expect(send).not.toHaveBeenCalled();
    await expect(service({ demande: { status: 'REJECTED' } }).svc.cancelBooking('u1', 'book-1', {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── Lot A — supprimer un lien ───────────────────────────────────────────────

describe('lot A — supprimer un lien demande quoi faire des demandes (Q8)', () => {
  const avecDemandes = (prisma: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    prisma.installationBooking.groupBy.mockResolvedValue([
      { status: 'PENDING', _count: { _all: 2 } }, { status: 'CONFIRMED', _count: { _all: 1 } },
    ]);
    prisma.installationBookingLinkVisit.count.mockResolvedValue(7);
    prisma.installationSlotWatcher.count.mockResolvedValue(1);
  };

  it('sans demande : supprimé directement', async () => {
    const { svc, prisma, activity } = service();
    await svc.deleteLink(LINK, undefined, 'u1');
    expect(prisma.installationBookingLink.delete).toHaveBeenCalledWith({ where: { id: LINK } });
    expect(prisma.installationBooking.deleteMany).not.toHaveBeenCalled();
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'booking_link_deleted', triggeredByUserId: 'u1' }));
  });

  it('avec des demandes et sans réponse → 409 qui porte le décompte (c’est le dialogue)', async () => {
    const { svc, prisma } = service();
    avecDemandes(prisma);
    const err = await svc.deleteLink(LINK).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().consequences).toEqual({ demandes: { total: 3, enAttente: 2, confirmees: 1 }, visites: 7, abonnes: 1 });
    expect(prisma.installationBookingLink.delete).not.toHaveBeenCalled();
  });

  it('« conserver » : les demandes survivent avec le libellé du lien recopié, puis le lien part', async () => {
    const { svc, prisma } = service();
    avecDemandes(prisma);
    await svc.deleteLink(LINK, 'conserver');
    expect(prisma.installationBooking.updateMany).toHaveBeenCalledWith({ where: { linkId: LINK, linkLabel: null }, data: { linkLabel: 'Pose Legrand' } });
    expect(prisma.installationBooking.deleteMany).not.toHaveBeenCalled();
    expect(prisma.installationBookingLink.delete).toHaveBeenCalled();
  });

  it('« effacer » : les demandes partent avec le lien', async () => {
    const { svc, prisma } = service();
    avecDemandes(prisma);
    await svc.deleteLink(LINK, 'effacer');
    expect(prisma.installationBooking.deleteMany).toHaveBeenCalledWith({ where: { linkId: LINK } });
    expect(prisma.installationBookingLink.delete).toHaveBeenCalled();
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
