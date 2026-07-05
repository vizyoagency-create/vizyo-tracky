import { BadRequestException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import type { ErrorLogger } from './error-logger.service';

/**
 * Couvre le tri « faute serveur » vs « abandon client » : un `request aborted`
 * (mobile parti en cours de POST) ne doit PAS remonter au centre d'alerte, alors
 * qu'une vraie 500 non gérée reste un CRITICAL journalisé.
 */
function makeHost(method = 'POST', url = '/api/activity/batch'): { host: ArgumentsHost; res: { status: jest.Mock; json: jest.Mock } } {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const req = { id: 'req-1', method, url, headers: {}, ip: '127.0.0.1' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe('AllExceptionsFilter — tri abandon client vs faute serveur', () => {
  let errorLogger: { record: jest.Mock };
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    errorLogger = { record: jest.fn().mockResolvedValue('id') };
    filter = new AllExceptionsFilter(errorLogger as unknown as ErrorLogger);
  });

  it('request aborted (raw-body) → NON journalisé, aucune réponse tentée', async () => {
    const err = Object.assign(new Error('request aborted'), { type: 'request.aborted', code: 'ECONNABORTED' });
    const { host, res } = makeHost();
    await filter.catch(err, host);
    expect(errorLogger.record).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('ECONNRESET (socket client reset) → NON journalisé', async () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const { host } = makeHost();
    await filter.catch(err, host);
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('erreur non gérée (vraie 500) → journalisée en CRITICAL', async () => {
    const { host, res } = makeHost();
    await filter.catch(new Error('boom'), host);
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    expect(errorLogger.record.mock.calls[0][3]).toBe('CRITICAL');
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('HttpException 5xx volontaire (ex. 503) → journalisée en ERROR, pas CRITICAL', async () => {
    const { host } = makeHost();
    await filter.catch(new BadRequestException('bad'), host); // 400 → non journalisé (<500 + HttpException)
    expect(errorLogger.record).not.toHaveBeenCalled();
  });
});
