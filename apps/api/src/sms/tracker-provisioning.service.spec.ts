import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
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
