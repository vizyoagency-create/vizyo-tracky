import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AudioCommandStatus } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { AudioAutoDisarmService } from './audio-auto-disarm.service';

const TRACKER_A = '00000000-0000-0000-0000-0000000000aa';
const TRACKER_B = '00000000-0000-0000-0000-0000000000bb';

/**
 * Sprint 4 — filet de sécurité auto-disarm. JAMAIS de vrai SMS (passerelle mockée).
 * On prouve que le cron désarme les écoutes ARMÉES expirées (status=SENT,
 * disarmedAt=null, sentAt < seuil), un seul SMS `tracker<pwd>` par tracker distinct,
 * puis pose disarmedAt.
 */
describe('AudioAutoDisarmService', () => {
  let service: AudioAutoDisarmService;
  let prisma: {
    audioMonitoringCommand: { findMany: jest.Mock; updateMany: jest.Mock };
  };
  let sms: { isEnabled: jest.Mock; send: jest.Mock };
  let errorLogger: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      audioMonitoringCommand: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    sms = {
      isEnabled: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue({ ok: true }),
    };
    errorLogger = { record: jest.fn().mockResolvedValue('error-id') };

    const config = {
      get: (key: string) =>
        key === 'AUDIO_AUTO_DISARM_MINUTES'
          ? 5
          : key === 'AUDIO_DEVICE_PASSWORD'
            ? '123456'
            : undefined,
    } as unknown as ConfigService;

    const module = await Test.createTestingModule({
      providers: [
        AudioAutoDisarmService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: SmsGatewayService, useValue: sms },
        { provide: ErrorLogger, useValue: errorLogger },
      ],
    }).compile();

    service = module.get(AudioAutoDisarmService);
  });

  const armedRow = (id: string, trackerId: string, sim: string | null) => ({
    id,
    trackerId,
    fleetId: '00000000-0000-0000-0000-000000000001',
    vehicleId: '00000000-0000-0000-0000-000000000002',
    tracker: { imei: '123456789012345', simPhoneNumber: sim },
  });

  it('queries only armed-and-stale commands (SENT, disarmedAt null, sentAt < threshold)', async () => {
    await service.run();
    expect(prisma.audioMonitoringCommand.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: AudioCommandStatus.SENT,
          disarmedAt: null,
          sentAt: { lt: expect.any(Date) },
        }),
      }),
    );
  });

  it('disarms a stale armed command: sends tracker123456 then stamps disarmedAt', async () => {
    prisma.audioMonitoringCommand.findMany.mockResolvedValue([
      armedRow('cmd-a', TRACKER_A, '+33656691615'),
    ]);

    await service.run();

    expect(sms.send).toHaveBeenCalledWith(
      '+33656691615',
      'tracker123456',
      expect.objectContaining({ imei: '123456789012345', source: 'audio-auto-disarm' }),
    );
    expect(prisma.audioMonitoringCommand.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['cmd-a'] } },
      data: { disarmedAt: expect.any(Date) },
    });
  });

  it('sends a single disarm SMS per distinct tracker (groups multiple armed rows)', async () => {
    prisma.audioMonitoringCommand.findMany.mockResolvedValue([
      armedRow('cmd-a1', TRACKER_A, '+33656691615'),
      armedRow('cmd-a2', TRACKER_A, '+33656691615'),
      armedRow('cmd-b1', TRACKER_B, '+33700000000'),
    ]);

    await service.run();

    // un seul SMS par tracker distinct → 2 envois (A et B), pas 3.
    expect(sms.send).toHaveBeenCalledTimes(2);
    // toutes les lignes du tracker A sont estampillées ensemble.
    expect(prisma.audioMonitoringCommand.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['cmd-a1', 'cmd-a2'] } },
      data: { disarmedAt: expect.any(Date) },
    });
  });

  it('does nothing (no SMS) when there are no stale armed commands', async () => {
    prisma.audioMonitoringCommand.findMany.mockResolvedValue([]);
    await service.run();
    expect(sms.send).not.toHaveBeenCalled();
    expect(prisma.audioMonitoringCommand.updateMany).not.toHaveBeenCalled();
  });

  it('skips entirely when the SMS gateway is disabled (no query side-effects)', async () => {
    sms.isEnabled.mockReturnValue(false);
    await service.run();
    expect(prisma.audioMonitoringCommand.findMany).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('alerts and does NOT stamp disarmedAt when the disarm SMS fails (retry next tick)', async () => {
    prisma.audioMonitoringCommand.findMany.mockResolvedValue([
      armedRow('cmd-a', TRACKER_A, '+33656691615'),
    ]);
    sms.send.mockResolvedValue({ ok: false, error: 'HTTP 500' });

    await service.run();

    expect(prisma.audioMonitoringCommand.updateMany).not.toHaveBeenCalled();
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(String),
      'audio-monitoring',
      expect.objectContaining({ trackerId: TRACKER_A }),
      'CRITICAL',
    );
  });

  it('alerts and does NOT stamp when a stale armed command has no SIM', async () => {
    prisma.audioMonitoringCommand.findMany.mockResolvedValue([
      armedRow('cmd-a', TRACKER_A, null),
    ]);

    await service.run();

    expect(sms.send).not.toHaveBeenCalled();
    expect(prisma.audioMonitoringCommand.updateMany).not.toHaveBeenCalled();
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(String),
      'audio-monitoring',
      expect.objectContaining({ trackerId: TRACKER_A }),
      'CRITICAL',
    );
  });

  it('guards against self-overlap (a second concurrent run skips)', async () => {
    // findMany lent → la 1re exécution tient le verrou pendant qu'on lance la 2e.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    prisma.audioMonitoringCommand.findMany.mockImplementation(async () => {
      await gate;
      return [];
    });

    const first = service.run();
    const second = service.run(); // doit voir running=true et sortir immédiatement
    await second;
    // le 2e run n'a déclenché aucune requête supplémentaire (skip).
    expect(prisma.audioMonitoringCommand.findMany).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
