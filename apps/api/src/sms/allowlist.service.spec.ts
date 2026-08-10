import { AllowlistService, type AllowlistSyncResult } from './allowlist.service';

/**
 * Ce que ces tests verrouillent (TRK-017, 2026-08-10) :
 *
 *  1. Une réconciliation qui ne change RIEN laisse quand même une trace d'exécution.
 *     C'est ce qui manquait : sans elle, « a tourné, tout allait bien » et « n'a pas
 *     tourné » sont indiscernables, et l'audit a mis deux passages à trancher.
 *  2. Un trou qui se rouvre en boucle ne produit plus six lignes identiques par jour —
 *     mais il n'est JAMAIS rendu muet : premier trou signalé tout de suite, rappel
 *     quotidien tant qu'il dure, fermeture tracée.
 *  3. Une suppression de masse retenue par la passerelle alerte toujours.
 */

const OK: AllowlistSyncResult = { added: 0, removed: 0, unchanged: 41, skipped: 0 };
const HOLE: AllowlistSyncResult = { added: 25, removed: 0, unchanged: 16, skipped: 0 };

const HOUR = 60 * 60 * 1000;

function makeService() {
  const errorLogger = { record: jest.fn(), recordBackground: jest.fn() };
  const systemActivity = { record: jest.fn() };
  const config = {
    get: jest.fn((key: string) =>
      key === 'VIZYO_TEXTO_URL' ? 'https://relay.example' : 'api-key',
    ),
  };
  const service = new AllowlistService(
    {} as never,
    config as never,
    errorLogger as never,
    systemActivity as never,
  );
  return { service, errorLogger, systemActivity };
}

/** Joue une réconciliation à un instant donné, avec un résultat de synchro imposé. */
async function runAt(
  service: AllowlistService,
  result: AllowlistSyncResult,
  atMs: number,
): Promise<void> {
  jest.spyOn(service, 'syncFromTrackers').mockResolvedValue(result);
  jest.spyOn(Date, 'now').mockReturnValue(atMs);
  await service.reconcilePeriodically();
}

describe('AllowlistService — preuve d’exécution', () => {
  afterEach(() => jest.restoreAllMocks());

  it('trace CHAQUE réconciliation au journal système, même quand rien ne change', async () => {
    const { service, systemActivity, errorLogger } = makeService();
    await runAt(service, OK, 0);

    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'allowlist_reconciled', status: 'SUCCESS' }),
    );
    // Une exécution normale n'est pas une faute : rien au centre d'alerte.
    expect(errorLogger.recordBackground).not.toHaveBeenCalled();
  });
});

describe('AllowlistService — un trou qui se rouvre ne spamme plus', () => {
  afterEach(() => jest.restoreAllMocks());

  it('signale le PREMIER trou immédiatement', async () => {
    const { service, errorLogger } = makeService();
    await runAt(service, HOLE, 0);

    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(1);
    expect(errorLogger.recordBackground.mock.calls[0][0]).toContain('25 numéro(s) manquant(s)');
  });

  it('ne réécrit PAS une ligne à chaque réparation de la même journée', async () => {
    const { service, errorLogger } = makeService();
    // Le scénario réel du 10/08 : six réparations en dix-neuf heures.
    for (const h of [0, 1, 5, 7, 8, 9]) await runAt(service, HOLE, h * HOUR);

    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(1);
  });

  it('rappelle une fois par jour tant que l’épisode dure — jamais muet', async () => {
    const { service, errorLogger } = makeService();
    await runAt(service, HOLE, 0);
    await runAt(service, HOLE, 12 * HOUR); // même journée : silencieux
    await runAt(service, HOLE, 25 * HOUR); // le lendemain : on redit

    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(2);
    const second = errorLogger.recordBackground.mock.calls[1][0] as string;
    expect(second).toContain('Le trou se ROUVRE');
    expect(second).toContain('3 réparations');
  });

  it('trace la fermeture de l’épisode, et réalerte si un NOUVEAU trou s’ouvre', async () => {
    const { service, errorLogger, systemActivity } = makeService();
    await runAt(service, HOLE, 0);
    await runAt(service, OK, 3 * HOUR); // couverture rétablie durablement
    await runAt(service, HOLE, 6 * HOUR); // nouvel épisode

    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'allowlist_episode_closed' }),
    );
    // Deux épisodes distincts = deux alertes, même à moins de 24 h d'écart.
    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(2);
  });
});

describe('AllowlistService — suppression de masse retenue', () => {
  afterEach(() => jest.restoreAllMocks());

  it('alerte dès qu’une synchro aurait retiré la couverture de plusieurs destinataires', async () => {
    const { service, errorLogger } = makeService();
    await runAt(service, { ...OK, removalsBlocked: 25 }, 0);

    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(1);
    expect(errorLogger.recordBackground.mock.calls[0][0]).toContain('25 suppression(s) retenues');
  });

  it('reste silencieux avec une passerelle ancienne qui ne renvoie pas le champ', async () => {
    const { service, errorLogger } = makeService();
    await runAt(service, OK, 0);
    expect(errorLogger.recordBackground).not.toHaveBeenCalled();
  });
});
