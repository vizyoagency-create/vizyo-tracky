import { ErrorLogger } from './error-logger.service';

/**
 * ── UNE LIGNE PAR INCIDENT, MÊME QUAND DEUX COUCHES ARCHIVENT ────────────────────────
 *
 * `ErrorLogger` marque l'instance d'erreur pour qu'une couche supérieure ne réécrive pas la
 * même panne sous une autre source. Mais la marque était posée APRÈS l'`await` de l'INSERT :
 * entre les deux, la couche du dessus voyait une erreur non marquée et écrivait sa propre ligne.
 *
 * Mesure du 2026-08-21 : chaque refus d'analyse produisait DEUX lignes à la même milliseconde
 * (`trip-analysis` + `TRIP_AUTOMATION`), doublant le bruit du centre d'alerte — l'endroit même
 * que la déduplication protège. Le cas se reproduit ici sans dépendre du minutage : la couche
 * basse n'attend pas son propre archivage avant de relever, exactement comme en production.
 */
describe('ErrorLogger — la course entre deux couches', () => {
  function build() {
    let resoudre: (v: unknown) => void = () => undefined;
    const enAttente = new Promise((r) => {
      resoudre = r;
    });
    const create = jest.fn().mockImplementation(() => enAttente.then(() => ({ id: 'log-1' })));
    const logger = new ErrorLogger({ errorLog: { create } } as never);
    return { logger, create, libererInsert: () => resoudre({ id: 'log-1' }) };
  }

  it('⚠️ la couche du dessus n’écrit PAS de seconde ligne pendant que l’INSERT est en vol', async () => {
    const { logger, create, libererInsert } = build();
    const panne = new Error('Analyse impossible : positions purgées');

    // Couche basse : lance l'archivage SANS l'attendre, puis relève (le `void` de production).
    const basse = logger.record(panne, 'trip-analysis', { tripId: 't1' });

    // Couche haute : reçoit la même instance et tente d'archiver à son tour, INSERT non terminé.
    const haute = await logger.record(panne, 'TRIP_AUTOMATION', { tripId: 't1' });

    expect(haute).toBe('already-recorded');
    expect(create).toHaveBeenCalledTimes(1);

    libererInsert();
    await basse;
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('deux erreurs DISTINCTES restent deux lignes — la marque ne doit pas fuir d’une instance à l’autre', async () => {
    const { logger, create, libererInsert } = build();

    const a = logger.record(new Error('panne A'), 'source-a');
    const b = logger.record(new Error('panne B'), 'source-b');

    expect(create).toHaveBeenCalledTimes(2);
    libererInsert();
    await Promise.all([a, b]);
  });
});
