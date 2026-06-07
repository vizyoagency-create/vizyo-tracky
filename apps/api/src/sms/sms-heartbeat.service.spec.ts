import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ErrorLogger } from '../observability/error-logger.service';
import { SmsGatewayService } from './sms-gateway.service';
import { SmsHeartbeatService } from './sms-heartbeat.service';

describe('SmsHeartbeatService', () => {
  let service: SmsHeartbeatService;
  let send: jest.Mock;
  let record: jest.Mock;
  let recipientsEnv: string;

  beforeEach(async () => {
    recipientsEnv = '';
    send = jest.fn().mockResolvedValue({ ok: true });
    record = jest.fn().mockResolvedValue('error-log-id');

    const module = await Test.createTestingModule({
      providers: [
        SmsHeartbeatService,
        {
          provide: SmsGatewayService,
          useValue: { send, currentProvider: () => 'vizyo-texto' },
        },
        { provide: ErrorLogger, useValue: { record } },
        {
          provide: ConfigService,
          useValue: { get: () => recipientsEnv },
        },
      ],
    }).compile();
    service = module.get(SmsHeartbeatService);
  });

  it('skips (no-op safe) when no recipient is configured', async () => {
    recipientsEnv = '';
    const result = await service.runHeartbeat();
    expect(result.skipped).toBe(true);
    expect(result.recipients).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('parses a CSV of recipients, trimming blanks', async () => {
    recipientsEnv = ' +33656691615 , ,+33687654321 ';
    expect(service.recipients()).toEqual(['+33656691615', '+33687654321']);
  });

  it('sends one heartbeat SMS per recipient with source=sms-heartbeat', async () => {
    recipientsEnv = '+33656691615,+33687654321';
    const result = await service.runHeartbeat();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      '+33656691615',
      expect.stringContaining('[Vizyo Tracky] Heartbeat'),
      { source: 'sms-heartbeat' },
    );
    expect(result.skipped).toBe(false);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it('records a CRITICAL ErrorLog when a send fails', async () => {
    recipientsEnv = '+33656691615';
    send.mockResolvedValueOnce({ ok: false, error: 'relay 403' });

    const result = await service.runHeartbeat();

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.stringContaining('+33656691615'),
      'sms-heartbeat',
      expect.objectContaining({ provider: 'vizyo-texto', toNumber: '+33656691615', error: 'relay 403' }),
      'CRITICAL',
    );
  });
});
