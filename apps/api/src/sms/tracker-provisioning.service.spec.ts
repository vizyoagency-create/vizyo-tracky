import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from './sms-gateway.service';
import { TrackerProvisioningService } from './tracker-provisioning.service';

describe('TrackerProvisioningService.buildPayloads', () => {
  let service: TrackerProvisioningService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TrackerProvisioningService,
        { provide: PrismaService, useValue: {} },
        { provide: SmsGatewayService, useValue: { send: jest.fn(), isEnabled: jest.fn() } },
        // Dependances DI requises par le constructeur mais absentes du module de
        // test (le spec ne teste que buildPayloads, une methode pure). Mocks
        // minimaux pour que Test.createTestingModule().compile() resolve.
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ErrorLogger, useValue: { record: jest.fn() } },
      ],
    }).compile();
    service = module.get(TrackerProvisioningService);
  });

  it('builds the 9-SMS Coban init sequence', () => {
    const out = service.buildPayloads({
      imei: '865328021056352',
      phoneNumber: '+33612345678',
      apn: 'free',
      apnUser: 'orange',
      apnPasswd: 'secret',
      serverIp: '195.110.45.12',
      serverPort: 5001,
      lowBatteryPhone: '+33687654321',
    });
    expect(out).toHaveLength(9);
    expect(out[0]).toBe('begin123456');
    expect(out[1]).toBe('apn123456 free');
    expect(out[2]).toBe('apnuser123456 orange');
    expect(out[3]).toBe('apnpasswd123456 secret');
    expect(out[4]).toBe('adminip123456 195.110.45.12 5001');
    expect(out[5]).toBe('gprs123456');
    expect(out[6]).toBe('fix030s***n123456');
    expect(out[7]).toBe('acc123456 on');
    expect(out[8]).toBe('lowbattery123456 +33687654321 on');
  });

  it('handles empty optional fields (apnUser, apnPasswd, lowBatteryPhone)', () => {
    const out = service.buildPayloads({
      imei: '865328021056352',
      phoneNumber: '+33612345678',
      apn: 'internet',
      serverIp: '127.0.0.1',
      serverPort: 5001,
    });
    expect(out[2]).toBe('apnuser123456');
    expect(out[3]).toBe('apnpasswd123456');
    // lowBattery without phone fallback : should still end with " on"
    expect(out[8]).toMatch(/^lowbattery123456.* on$/);
  });

  it('preserves password in every command', () => {
    const out = service.buildPayloads({
      imei: '865328021056352',
      phoneNumber: '+33612345678',
      apn: 'free',
      serverIp: '127.0.0.1',
      serverPort: 5001,
    });
    for (const sms of out) {
      expect(sms).toContain('123456');
    }
  });
});
