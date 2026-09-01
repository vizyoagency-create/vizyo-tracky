import { Test } from '@nestjs/testing';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DetectionAccidentService } from './detection-accident.service';

/**
 * TRK-054 — LE CHEMIN DE RETOUR DE LA VEILLE ACCIDENT.
 *
 * Le cas réel que ces tests rejouent, à l'heure près : HD-779-MA, 31/08.
 * Alerte `ACCIDENT` `CRITICAL` à 17:30 — « roulait à 113 km/h, son boîtier n'émet plus
 * depuis 2,2 h ». Le boîtier est revenu à 20:00 avec une rafale de 686 trames, batterie à
 * 100 %, et il a parcouru ~180 km depuis. **L'alerte est restée ouverte.**
 *
 * Le défaut n'était pas le déclenchement — la règle a fait ce qu'elle annonce — mais
 * l'absence de tout mécanisme pour se dédire.
 */
const ALERT_ID = '00000000-0000-0000-0000-000000000060';
const TRACKER_ID = '00000000-0000-0000-0000-000000000010';

/** 31/08 17:30 UTC — l'heure exacte de l'alerte réelle. */
const ALERTE_A = new Date('2026-08-31T17:30:00.000Z');
/** 31/08 20:00 UTC — la reprise réelle, 150 min plus tard. */
const REPRISE_A = new Date('2026-08-31T20:00:00.000Z');

describe('DetectionAccidentService — rétractation (TRK-054)', () => {
  let service: DetectionAccidentService;
  let prisma: {
    alert: { findMany: jest.Mock; update: jest.Mock; count: jest.Mock };
    tracker: { findUnique: jest.Mock; findMany: jest.Mock };
    position: { findFirst: jest.Mock };
    user: { findMany: jest.Mock };
  };
  let gateway: { broadcastAlert: jest.Mock; broadcastAlertAcknowledged: jest.Mock };

  const alerteOuverte = (o: Record<string, unknown> = {}) => ({
    id: ALERT_ID,
    trackerId: TRACKER_ID,
    createdAt: ALERTE_A,
    payload: { detection: 'telemetrie', derniereVitesseKmh: 113.268, silenceH: 2.2 },
    ...o,
  });

  beforeEach(async () => {
    prisma = {
      alert: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: ALERT_ID, ...data })),
        count: jest.fn().mockResolvedValue(0),
      },
      tracker: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      position: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    gateway = { broadcastAlert: jest.fn(), broadcastAlertAcknowledged: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DetectionAccidentService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: NotificationDispatchService, useValue: { dispatchAlert: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(DetectionAccidentService);
  });

  it('rétracte l alerte quand le boîtier a réémis APRÈS elle — le cas HD-779-MA', async () => {
    prisma.alert.findMany.mockResolvedValue([alerteOuverte()]);
    prisma.tracker.findUnique.mockResolvedValue({
      lastSeenAt: REPRISE_A,
      lastBatteryPercent: 100,
      vehicle: { plate: 'HD-779-MA' },
    });

    const n = await service.retracterLesRevenus(new Date('2026-08-31T20:15:00.000Z'));

    expect(n).toBe(1);
    expect(prisma.alert.update).toHaveBeenCalledTimes(1);
    expect(gateway.broadcastAlertAcknowledged).toHaveBeenCalledTimes(1);
  });

  it('écrit le MOTIF, la reprise et le silence réel — une rétractation muette est pire que rien', async () => {
    prisma.alert.findMany.mockResolvedValue([alerteOuverte()]);
    prisma.tracker.findUnique.mockResolvedValue({
      lastSeenAt: REPRISE_A,
      lastBatteryPercent: 100,
      vehicle: { plate: 'HD-779-MA' },
    });

    await service.retracterLesRevenus();

    const data = prisma.alert.update.mock.calls[0][0].data;
    expect(data.payload.retractation.silenceApresAlerteMin).toBe(150);
    expect(data.payload.retractation.batteriePct).toBe(100);
    expect(data.payload.retractation.repriseA).toBe(REPRISE_A.toISOString());
    expect(String(data.payload.retractation.motif)).toContain('a repris');
    // Le payload d'origine n'est pas écrasé : la vitesse constatée reste lisible.
    expect(data.payload.derniereVitesseKmh).toBe(113.268);
  });

  it('referme SANS attribuer l acquittement à un humain — c est le système qui se dédit', async () => {
    prisma.alert.findMany.mockResolvedValue([alerteOuverte()]);
    prisma.tracker.findUnique.mockResolvedValue({
      lastSeenAt: REPRISE_A,
      lastBatteryPercent: 100,
      vehicle: { plate: 'HD-779-MA' },
    });

    await service.retracterLesRevenus();

    const data = prisma.alert.update.mock.calls[0][0].data;
    expect(data.acknowledgedAt).toBeInstanceOf(Date);
    expect(data.acknowledgedBy).toBeUndefined();
  });

  // ⚠️ LE CONTREPOINT — celui qui empêche de « corriger » en refermant tout.
  it('ne rétracte PAS tant que le silence dure — c est le cas qu il ne faut jamais refermer', async () => {
    prisma.alert.findMany.mockResolvedValue([alerteOuverte()]);
    prisma.tracker.findUnique.mockResolvedValue({
      // Dernière trame ANTÉRIEURE à l'alerte : le boîtier est toujours muet.
      lastSeenAt: new Date('2026-08-31T15:20:00.000Z'),
      lastBatteryPercent: 100,
      vehicle: { plate: 'HD-779-MA' },
    });

    const n = await service.retracterLesRevenus();

    expect(n).toBe(0);
    expect(prisma.alert.update).not.toHaveBeenCalled();
    expect(gateway.broadcastAlertAcknowledged).not.toHaveBeenCalled();
  });

  // 🔴 LE TEST QUI PROTEGE LE VRAI POSITIF.
  //
  // Le type ACCIDENT a DEUX emetteurs : cette veille (qui infere d'un SILENCE) et le
  // CAPTEUR DE CHOC du boitier. Un boitier qui signale un choc CONTINUE d'emettre — donc
  // une retractation aveugle refermerait toutes les alertes de choc reelles en moins de
  // trente minutes, en ecrivant « aucun choc confirme » sur la seule alerte du systeme qui
  // en ait mesure un.
  it('ne rétracte JAMAIS une alerte du capteur de choc, même si le boîtier émet encore', async () => {
    prisma.alert.findMany.mockResolvedValue([
      // Le payload du chemin trame : pas de `detection`, mais l'alarme brute du boitier.
      alerteOuverte({ payload: { raw: '[coban]', alarm: 'accident', speedKmh: 92 } }),
    ]);
    prisma.tracker.findUnique.mockResolvedValue({
      lastSeenAt: REPRISE_A,
      lastBatteryPercent: 100,
      vehicle: { plate: 'HD-779-MA' },
    });

    const n = await service.retracterLesRevenus();

    expect(n).toBe(0);
    expect(prisma.alert.update).not.toHaveBeenCalled();
    // Et on n'est meme pas alle interroger le boitier : la garde tranche avant.
    expect(prisma.tracker.findUnique).not.toHaveBeenCalled();
  });

  it('ne rétracte pas un boîtier qui n a JAMAIS émis', async () => {
    prisma.alert.findMany.mockResolvedValue([alerteOuverte()]);
    prisma.tracker.findUnique.mockResolvedValue({
      lastSeenAt: null,
      lastBatteryPercent: null,
      vehicle: { plate: 'HD-779-MA' },
    });

    expect(await service.retracterLesRevenus()).toBe(0);
    expect(prisma.alert.update).not.toHaveBeenCalled();
  });

  // ── Le cas REEL, et il a failli passer a travers ────────────────────────────────────
  //
  // L'alerte de HD-779-MA avait ete ACQUITTEE par un exploitant a 19:15, quarante-cinq
  // minutes AVANT que le boitier ne revienne. Une retractation qui ne reprendrait que les
  // alertes non acquittees n'aurait jamais pu s'exercer sur son propre cas de reference —
  // et surtout, une fausse alerte acquittee reste indiscernable d'un vrai accident traite.
  it('annote une alerte DEJA ACQUITTEE sans toucher au geste de l exploitant', async () => {
    const acquitteeA = new Date('2026-08-31T19:15:38.593Z');
    prisma.alert.findMany.mockResolvedValue([alerteOuverte({ acknowledgedAt: acquitteeA })]);
    prisma.tracker.findUnique.mockResolvedValue({
      lastSeenAt: REPRISE_A,
      lastBatteryPercent: 100,
      vehicle: { plate: 'HD-779-MA' },
    });

    const n = await service.retracterLesRevenus();

    expect(n).toBe(1);
    const data = prisma.alert.update.mock.calls[0][0].data;
    // L'annotation est ecrite...
    expect(data.payload.retractation).toBeDefined();
    // ...et l'acquittement humain n'est PAS reecrit.
    expect(data.acknowledgedAt).toBeUndefined();
  });

  // Idempotence : elle ne repose plus sur `acknowledgedAt` (la requete ne filtre plus
  // dessus) mais sur la PRESENCE de la retractation. Sans elle, le cron reecrirait le meme
  // motif toutes les trente minutes, indefiniment.
  it('ne repasse jamais sur une alerte déjà rétractée', async () => {
    prisma.alert.findMany.mockResolvedValue([
      alerteOuverte({
        payload: { detection: 'telemetrie', retractation: { motif: 'deja fait' } },
      }),
    ]);
    prisma.tracker.findUnique.mockResolvedValue({
      lastSeenAt: REPRISE_A,
      lastBatteryPercent: 100,
      vehicle: { plate: 'HD-779-MA' },
    });

    expect(await service.retracterLesRevenus()).toBe(0);
    expect(prisma.alert.update).not.toHaveBeenCalled();
    expect(prisma.tracker.findUnique).not.toHaveBeenCalled();
  });

  it('reprend TOUTES les alertes accident, acquittées ou non', async () => {
    await service.retracterLesRevenus();
    const where = prisma.alert.findMany.mock.calls[0][0].where;
    expect(where.type).toBe('ACCIDENT');
    expect(where).not.toHaveProperty('acknowledgedAt');
  });

  it('le balayage rétracte AVANT d examiner — ce qui se referme passe avant ce qui s ouvre', async () => {
    const ordre: string[] = [];
    jest.spyOn(service, 'retracterLesRevenus').mockImplementation(async () => {
      ordre.push('retracte');
      return 0;
    });
    jest.spyOn(service, 'examiner').mockImplementation(async () => {
      ordre.push('examine');
      return [];
    });

    await service.balayer();

    expect(ordre).toEqual(['retracte', 'examine']);
  });

  it('une rétractation en échec ne fait pas tomber la veille', async () => {
    jest.spyOn(service, 'retracterLesRevenus').mockRejectedValue(new Error('DB timeout'));
    await expect(service.balayer()).resolves.toBeUndefined();
  });
});
