import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { TrackerStatus } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { AllowlistService } from './allowlist.service';
import { SmsGatewayService } from './sms-gateway.service';
import { TrackerProvisioningService } from './tracker-provisioning.service';

describe('TrackerProvisioningService.buildSteps', () => {
  let service: TrackerProvisioningService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TrackerProvisioningService,
        { provide: PrismaService, useValue: {} },
        { provide: SmsGatewayService, useValue: { send: jest.fn(), isEnabled: jest.fn() } },
        // Dependances DI requises par le constructeur mais absentes du module de
        // test (les tests ne portent que sur buildSteps/buildPayloads, methodes
        // pures). Mocks minimaux pour que Test.createTestingModule().compile() resolve.
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ErrorLogger, useValue: { record: jest.fn() } },
        { provide: AllowlistService, useValue: { add: jest.fn() } },
      ],
    }).compile();
    service = module.get(TrackerProvisioningService);
  });

  it('builds the default 6-command sequence (begin → apn → admin → adminip → gprs → fix)', () => {
    const out = service.buildPayloads({
      imei: '865328021056352',
      phoneNumber: '+33612345678',
      apn: 'wsim',
      serverIp: '72.62.26.240',
      serverPort: 5023,
    });
    expect(out).toEqual([
      'begin123456',
      'apn123456 wsim',
      'admin123456 33612345678', // admin par defaut = numero SIM, sans le +
      'adminip123456 72.62.26.240 5023',
      'gprs123456',
      'fix020s***n123456', // 20s par defaut (plancher Coban)
    ]);
  });

  it('strips the + from an explicit admin number and pads the fix interval to 3 digits', () => {
    const steps = service.buildSteps({
      imei: '865328021056352',
      phoneNumber: '+33611112222',
      apn: 'wsim',
      serverIp: '1.2.3.4',
      serverPort: 5023,
      adminNumber: '+33656691615',
      fixIntervalS: 30,
    });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.payload]));
    expect(byKey['admin']).toBe('admin123456 33656691615');
    expect(byKey['fix']).toBe('fix030s***n123456');
  });

  it('clamps the fix interval to the 20s Coban minimum', () => {
    const steps = service.buildSteps({
      imei: '865328021056352',
      phoneNumber: '+33611112222',
      apn: 'wsim',
      serverIp: '1.2.3.4',
      serverPort: 5023,
      fixIntervalS: 5,
    });
    expect(steps.find((s) => s.key === 'fix')?.payload).toBe('fix020s***n123456');
  });

  it('adds optional steps only when their fields are provided', () => {
    const steps = service.buildSteps({
      imei: '865328021056352',
      phoneNumber: '+33611112222',
      apn: 'wsim',
      serverIp: '1.2.3.4',
      serverPort: 5023,
      apnUser: 'u',
      apnPasswd: 'p',
      accOn: true,
      lowBatteryPhone: '+33600000000',
    });
    expect(steps.map((s) => s.key)).toEqual([
      'begin',
      'apn',
      'apnuser',
      'apnpasswd',
      'admin',
      'adminip',
      'gprs',
      'fix',
      'acc',
      'lowbattery',
    ]);
  });

  it('preserves the password in every command', () => {
    const out = service.buildPayloads({
      imei: '865328021056352',
      phoneNumber: '+33612345678',
      apn: 'wsim',
      serverIp: '127.0.0.1',
      serverPort: 5023,
    });
    for (const sms of out) expect(sms).toContain('123456');
  });

  it('reply guard #19: ignore une reponse trop precoce (etape precedente), consomme la vraie', async () => {
    jest.useFakeTimers();
    try {
      const phone = '+33612345678';
      const svc = service as unknown as {
        armReplyWaiter: (p: string, t: number, g: number) => { promise: Promise<unknown> };
        onSmsInbound: (e: unknown) => void;
      };
      // guardMs=3000, timeout long (ne doit pas expirer pendant le test).
      const waiter = svc.armReplyWaiter(phone, 60_000, 3000);
      let settled: unknown = 'PENDING';
      void waiter.promise.then((v) => { settled = v; });
      const inbound = (body: string) =>
        svc.onSmsInbound({ fromNumber: phone, body, receivedAt: '', smsLogId: 's' });

      // Reponse arrivant immediatement (< 3s) -> ignoree, le waiter RESTE arme.
      inbound('reponse tardive de l etape precedente');
      await Promise.resolve();
      expect(settled).toBe('PENDING');

      // 3,5s plus tard -> la vraie reponse de l'etape courante est consommee.
      jest.advanceTimersByTime(3500);
      inbound('gprs ok');
      await Promise.resolve();
      await Promise.resolve();
      expect((settled as { body?: string })?.body).toBe('gprs ok');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ─── V1.18 — enrichissement « état live du tracker » (découplage de l'ACK SMS) ──
// Le retour SMS est fragile (le téléphone passerelle doit forwarder les SMS reçus).
// On expose donc l'état de reconnexion TCP du boîtier (tracker.lastSeenAt) pour que
// l'UI confirme « Tracker connecté » sans dépendre des ACK.
describe('TrackerProvisioningService — état live du tracker (V1.18)', () => {
  const IMEI = '865328021056352';
  const START = new Date('2026-06-14T08:00:00.000Z');
  const provRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'prov-1',
    imei: IMEI,
    phoneNumber: '+33612345678',
    status: 'COMPLETED',
    currentStep: 6,
    startedAt: START,
    completedAt: new Date(START.getTime() + 200_000),
    failedAt: null,
    failureReason: null,
    createdAt: START,
    steps: [],
    ...overrides,
  });

  let service: TrackerProvisioningService;
  let prisma: {
    trackerProvisioning: { findMany: jest.Mock; findUnique: jest.Mock };
    tracker: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock };
  };
  let errorLog: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      trackerProvisioning: {
        findMany: jest.fn().mockResolvedValue([provRow()]),
        findUnique: jest.fn().mockResolvedValue(provRow()),
      },
      tracker: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: 'tracker-1' }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    errorLog = { record: jest.fn().mockResolvedValue('err-id') };

    const module = await Test.createTestingModule({
      providers: [
        TrackerProvisioningService,
        { provide: PrismaService, useValue: prisma },
        { provide: SmsGatewayService, useValue: { isEnabled: jest.fn(() => true), send: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ErrorLogger, useValue: errorLog },
        { provide: AllowlistService, useValue: { add: jest.fn() } },
      ],
    }).compile();

    service = module.get(TrackerProvisioningService);
  });

  it('list attache l\'état live du tracker (seenSinceStart=true si vu en ligne après le lancement)', async () => {
    const seenAfter = new Date(START.getTime() + 90_000); // +90s après le start
    prisma.tracker.findMany.mockResolvedValue([
      { imei: IMEI, status: TrackerStatus.ONLINE, lastSeenAt: seenAfter, lastPositionAt: seenAfter },
    ]);

    const rows = await service.list(50); // SUPER_ADMIN (pas de requestedBy)

    expect(rows[0]!.tracker).toEqual({
      status: TrackerStatus.ONLINE,
      lastSeenAt: seenAfter,
      lastPositionAt: seenAfter,
      seenSinceStart: true,
    });
    // Une seule requête tracker pour l'enrichissement, indexée par imei.
    expect(prisma.tracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { imei: { in: [IMEI] } } }),
    );
  });

  it('seenSinceStart=false si le boîtier a été vu en ligne AVANT le lancement', async () => {
    const seenBefore = new Date(START.getTime() - 60_000);
    prisma.tracker.findMany.mockResolvedValue([
      { imei: IMEI, status: TrackerStatus.OFFLINE, lastSeenAt: seenBefore, lastPositionAt: null },
    ]);

    const rows = await service.list(50);

    expect(rows[0]!.tracker?.seenSinceStart).toBe(false);
  });

  it('seenSinceStart=false quand startedAt est null (impossible de prouver « depuis le lancement »)', async () => {
    prisma.trackerProvisioning.findMany.mockResolvedValue([provRow({ startedAt: null })]);
    prisma.tracker.findMany.mockResolvedValue([
      { imei: IMEI, status: TrackerStatus.ONLINE, lastSeenAt: new Date(START.getTime() + 1000), lastPositionAt: null },
    ]);

    const rows = await service.list(50);

    expect(rows[0]!.tracker?.seenSinceStart).toBe(false);
  });

  it('tracker=null si aucun tracker n\'existe pour cet imei', async () => {
    prisma.tracker.findMany.mockResolvedValue([]); // aucun tracker en base

    const rows = await service.list(50);

    expect(rows[0]!.tracker).toBeNull();
  });

  it('findOne enrichit la ligne unique avec l\'état du tracker', async () => {
    const seenAfter = new Date(START.getTime() + 30_000);
    prisma.tracker.findMany.mockResolvedValue([
      { imei: IMEI, status: TrackerStatus.ONLINE, lastSeenAt: seenAfter, lastPositionAt: seenAfter },
    ]);

    const row = await service.findOne('prov-1'); // SUPER_ADMIN

    expect(row?.tracker?.status).toBe(TrackerStatus.ONLINE);
    expect(row?.tracker?.seenSinceStart).toBe(true);
  });

  // ─── Remontee au centre d'alerte : boitier injoignable (sans faux positif) ───

  const callAlert = (svc: TrackerProvisioningService, id: string, imei: string) =>
    (svc as unknown as { alertIfBoitierSilent: (i: string, m: string) => Promise<void> }).alertIfBoitierSilent(id, imei);

  it('alertIfBoitierSilent remonte une ERROR si 0 ACK ET boitier non connecté', async () => {
    prisma.trackerProvisioning.findUnique.mockResolvedValue(
      provRow({ steps: [{ status: 'no-ack' }, { status: 'sent' }] }),
    );
    prisma.tracker.findUnique.mockResolvedValue({ status: TrackerStatus.OFFLINE, lastSeenAt: null });

    await callAlert(service, 'prov-1', IMEI);

    expect(errorLog.record).toHaveBeenCalledTimes(1);
    expect(errorLog.record).toHaveBeenCalledWith(
      expect.stringContaining('injoignable'),
      'sms-provisioning',
      expect.objectContaining({ imei: IMEI, provisioningId: 'prov-1' }),
      'ERROR',
    );
  });

  it('alertIfBoitierSilent n\'alerte PAS si le boîtier s\'est connecté au serveur (en ligne)', async () => {
    prisma.trackerProvisioning.findUnique.mockResolvedValue(provRow({ steps: [{ status: 'no-ack' }] }));
    prisma.tracker.findUnique.mockResolvedValue({
      status: TrackerStatus.ONLINE,
      lastSeenAt: new Date(START.getTime() + 60_000),
    });

    await callAlert(service, 'prov-1', IMEI);

    expect(errorLog.record).not.toHaveBeenCalled();
  });

  it('alertIfBoitierSilent n\'alerte PAS si le boîtier a fini par répondre (un ACK) — court-circuit', async () => {
    prisma.trackerProvisioning.findUnique.mockResolvedValue(
      provRow({ steps: [{ status: 'acked' }, { status: 'no-ack' }] }),
    );

    await callAlert(service, 'prov-1', IMEI);

    expect(errorLog.record).not.toHaveBeenCalled();
    expect(prisma.tracker.findUnique).not.toHaveBeenCalled(); // sort avant de chercher le tracker
  });
});
