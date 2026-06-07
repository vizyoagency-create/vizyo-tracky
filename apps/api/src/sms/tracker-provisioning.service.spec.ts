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
});
