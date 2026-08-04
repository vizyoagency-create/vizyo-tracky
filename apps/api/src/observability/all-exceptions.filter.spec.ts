import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ExpectedRefusalException } from '../common/expected-refusal.exception';
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

  // --- TRK-004 : un refus DÉLIBÉRÉ n'est pas une panne ----------------------------------

  it('refus délibéré (plafond IA atteint) → NON archivé, mais la réponse HTTP est intacte', async () => {
    const { host, res } = makeHost();
    const refus = new ExpectedRefusalException('Le budget IA mensuel est atteint.');

    await filter.catch(refus, host);

    // C'est la gouvernance qui FONCTIONNE : rien à signaler au centre d'alerte.
    expect(errorLogger.record).not.toHaveBeenCalled();
    // ⚠️ Et le client doit voir exactement la même chose qu'avant : c'est pour ça que la
    // classe hérite de `ServiceUnavailableException` au lieu de composer un HttpException nu.
    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.error.message).toBe('Le budget IA mensuel est atteint.');
    expect(body.error.code).toBe('Service Unavailable');
  });

  it('un 503 ORDINAIRE reste archivé (le refus délibéré ne doit pas déteindre)', async () => {
    const { host } = makeHost();

    await filter.catch(new ServiceUnavailableException('vizyo-texto injoignable'), host);

    // Une dépendance qui tombe est une vraie panne : elle doit continuer de remonter.
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    expect(errorLogger.record.mock.calls[0][3]).toBe('ERROR');
  });
});
