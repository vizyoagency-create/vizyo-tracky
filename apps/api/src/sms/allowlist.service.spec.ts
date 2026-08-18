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

/**
 * ── LA SOURCE DES NUMEROS (2026-08-18) ───────────────────────────────────────────────
 *
 * `tracker.simPhoneNumber` est une SAISIE. Quand la puce d'un boitier change sans que
 * personne ne retouche la fiche, ce champ ment — et le vrai numero n'entre jamais dans
 * l'allowlist. Tout SMS vers ce boitier part alors en 403.
 *
 * Ce n'est pas une hypothese : du 19 au 25 juillet 2026, 1476 SMS ont ete rejetes
 * « hors allowlist du tenant » sur des puces pourtant actives chez l'operateur ; et le
 * 18 aout, trois puces activees quatre jours plus tot manquaient encore a l'appel,
 * dont celles de deux vehicules en service.
 *
 * Ces tests verrouillent le remede : l'inventaire WhereverSIM fait autorite, la saisie
 * n'est qu'un repli, et on n'ouvre PAS l'allowlist aux puces dont le boitier est inconnu.
 */
describe('AllowlistService — d’ou viennent les numeros autorises', () => {
  afterEach(() => jest.restoreAllMocks());

  function avecParc(trackers: { id: string; imei: string; simPhoneNumber: string | null }[],
                    puces: { imei: string; msisdn: string }[]) {
    const majTracker = jest.fn().mockResolvedValue({});
    const prisma = {
      tracker: { findMany: jest.fn().mockResolvedValue(trackers), update: majTracker },
      sim: { findMany: jest.fn().mockResolvedValue(puces) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const systemActivity = { record: jest.fn() };
    const service = new AllowlistService(
      prisma as never,
      { get: jest.fn(() => 'x') } as never,
      { record: jest.fn(), recordBackground: jest.fn() } as never,
      systemActivity as never,
    );
    // On intercepte l'appel reseau : ce qui compte ici, c'est la LISTE poussee.
    const envoye: { entries: { phone: string; label: string }[] }[] = [];
    jest.spyOn(service as never as { call: unknown }, 'call' as never)
      .mockImplementation((async (_p: string, init: { body: string }) => {
        envoye.push(JSON.parse(init.body));
        return { added: 0, removed: 0, unchanged: 0, skipped: 0 };
      }) as never);
    return { service, envoye, majTracker, systemActivity };
  }

  it('⚠️ la puce REELLE prime sur le numero saisi — le cas qui a coute 1476 SMS', async () => {
    // Le boitier n'a pas bouge, sa puce si. La fiche porte encore l'ancien numero.
    const { service, envoye } = avecParc(
      [{ id: 't1', imei: '864035053276839', simPhoneNumber: '+33600000000' }],
      [{ imei: '864035053276839', msisdn: '345901035259773' }],
    );
    await service.syncFromTrackers();
    expect(envoye[0].entries).toEqual([
      { phone: '+345901035259773', label: 'Tracker 864035053276839' },
    ]);
  });

  it('normalise en E.164 : l’inventaire stocke le MSISDN sans le « + »', async () => {
    // Sans cette normalisation, on pousserait « 345901035259773 » et la passerelle
    // le verrait comme un numero DIFFERENT de « +345901035259773 ». Allowlist « a
    // jour », et 403 quand meme.
    const { service, envoye } = avecParc(
      [{ id: 't1', imei: '111111111111111', simPhoneNumber: null }],
      [{ imei: '111111111111111', msisdn: '345901030605196' }],
    );
    await service.syncFromTrackers();
    expect(envoye[0].entries[0].phone).toBe('+345901030605196');
  });

  it('un boitier absent de l’inventaire garde le numero saisi — le repli reste', async () => {
    const { service, envoye } = avecParc(
      [{ id: 't1', imei: '863378070030776', simPhoneNumber: '+33766754903' }],
      [],
    );
    await service.syncFromTrackers();
    expect(envoye[0].entries).toEqual([
      { phone: '+33766754903', label: 'Tracker 863378070030776' },
    ]);
  });

  it('⚠️ une puce activee dont le BOITIER est inconnu n’entre PAS dans l’allowlist', async () => {
    // Option « sure » : on ne donne pas le droit de recevoir des SMS a un equipement
    // dont on ignore ou il est. Le trou se ferme en declarant le boitier.
    const { service, envoye } = avecParc(
      [{ id: 't1', imei: '111111111111111', simPhoneNumber: '+33611111111' }],
      [
        { imei: '111111111111111', msisdn: '33611111111' },
        { imei: '999999999999999', msisdn: '345901035259758' }, // boitier non declare
      ],
    );
    await service.syncFromTrackers();
    const numeros = envoye[0].entries.map((e) => e.phone);
    expect(numeros).toEqual(['+33611111111']);
    expect(numeros).not.toContain('+345901035259758');
  });

  it('recale la fiche boitier ET le dit au journal systeme', async () => {
    // L'ecran admin doit montrer le numero vers lequel les SMS partent reellement.
    const { service, majTracker, systemActivity } = avecParc(
      [{ id: 't1', imei: '864035053276839', simPhoneNumber: '+33600000000' }],
      [{ imei: '864035053276839', msisdn: '345901035259773' }],
    );
    await service.syncFromTrackers();
    expect(majTracker).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { simPhoneNumber: '+345901035259773' },
    });
    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tracker_sim_recalee', category: 'SMS' }),
    );
  });

  it('n’ecrit RIEN quand la fiche est deja juste — pas de bruit au journal', async () => {
    const { service, majTracker, systemActivity } = avecParc(
      [{ id: 't1', imei: '864035053276839', simPhoneNumber: '+345901035259773' }],
      [{ imei: '864035053276839', msisdn: '345901035259773' }],
    );
    await service.syncFromTrackers();
    expect(majTracker).not.toHaveBeenCalled();
    expect(systemActivity.record).not.toHaveBeenCalled();
  });
});
