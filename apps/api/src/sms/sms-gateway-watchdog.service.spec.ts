import { Test } from '@nestjs/testing';
import { ErrorLogger } from '../observability/error-logger.service';
import { SmsGatewayService } from './sms-gateway.service';
import { SmsGatewayWatchdogService } from './sms-gateway-watchdog.service';

describe('SmsGatewayWatchdogService', () => {
  let service: SmsGatewayWatchdogService;
  let healthCheck: jest.Mock;
  let record: jest.Mock;

  beforeEach(async () => {
    healthCheck = jest.fn();
    record = jest.fn().mockResolvedValue('alert-id');
    const module = await Test.createTestingModule({
      providers: [
        SmsGatewayWatchdogService,
        {
          provide: SmsGatewayService,
          useValue: { currentProvider: () => 'vizyo-texto', healthCheck },
        },
        { provide: ErrorLogger, useValue: { record } },
      ],
    }).compile();
    service = module.get(SmsGatewayWatchdogService);
  });

  it('ouvre une seule alerte pendant un même épisode de téléphone absent', async () => {
    healthCheck.mockResolvedValue({
      reachable: true,
      error: 'téléphone Android absent ou périmé',
      gateway: {
        operational: false,
        device: { fresh: false, freshestLastSeenAt: null, ageSeconds: 300 },
        queue: { pending: 2 },
      },
    });
    await service.inspect();
    await service.inspect();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.stringContaining('coupes automatiques sont bloquées'),
      'sms-gateway-watchdog',
      expect.objectContaining({ androidFresh: false, relayQueueDepth: 2 }),
      'CRITICAL',
    );
  });

  it('réarme la sentinelle après une récupération', async () => {
    healthCheck
      .mockResolvedValueOnce({
        reachable: true,
        error: 'stale',
        gateway: { operational: false, device: {}, queue: {} },
      })
      .mockResolvedValueOnce({
        reachable: true,
        gateway: { operational: true },
      })
      .mockResolvedValueOnce({ reachable: false, error: 'timeout' });
    await service.inspect();
    await service.inspect();
    await service.inspect();
    expect(record).toHaveBeenCalledTimes(2);
  });
});
