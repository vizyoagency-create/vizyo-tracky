import { AiServiceError } from '../ai/ai-client.types';
import { ErrorLogger, isTransient } from './error-logger.service';

/**
 * Échecs PASSAGERS d'un service tiers.
 *
 * 2026-07-20 : des 529 « Overloaded » d'Anthropic remontaient au centre d'alerte en ERROR pendant
 * les récits de trajet. Ce n'est ni un bug de l'app ni une action à mener — et ça pouvait
 * déclencher la vigie de saturation (> 5 erreurs/h) pour du bruit fournisseur.
 *
 * Le test qui compte le plus est le dernier : une VRAIE erreur doit toujours être archivée. Filtrer
 * trop large serait pire que le problème d'origine.
 */
describe('ErrorLogger — échecs passagers', () => {
  function build() {
    const create = jest.fn().mockResolvedValue({ id: 'log-1' });
    const logger = new ErrorLogger({ errorLog: { create } } as never);
    return { logger, create };
  }

  it('n\'archive PAS un fournisseur IA saturé (529 → overloaded)', async () => {
    const { logger, create } = build();

    const res = await logger.record(new AiServiceError('overloaded', 'Service IA momentanément saturé.'), 'TRIP_ANALYSIS_AI');

    expect(res).toBe('transient');
    expect(create).not.toHaveBeenCalled();
  });

  it('n\'archive pas non plus quota / réseau / timeout (mêmes causes passagères)', async () => {
    for (const kind of ['quota', 'network', 'timeout'] as const) {
      const { logger, create } = build();
      await logger.record(new AiServiceError(kind, `échec ${kind}`), 'AI');
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('ARCHIVE une clé invalide : ce n\'est pas passager, il faut agir', async () => {
    const { logger, create } = build();

    await logger.record(new AiServiceError('invalid_key', 'Clé IA invalide.'), 'AI', {}, 'CRITICAL');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ARCHIVE une erreur HTTP non classée (500 : vraie panne du service)', async () => {
    const { logger, create } = build();

    await logger.record(new AiServiceError('http', 'Erreur du service IA (500).'), 'AI');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('⚠️ ARCHIVE toute erreur ordinaire — le filtre ne doit rien avaler d\'autre', async () => {
    const { logger, create } = build();

    await logger.record(new Error('bug applicatif'), 'engine-control');
    // Un message qui CONTIENT « 529 » n'est pas passager pour autant : le tri est structurel.
    await logger.record(new Error('529 véhicules à traiter — échec du lot'), 'reports');

    expect(create).toHaveBeenCalledTimes(2);
  });

  /**
   * Une MÊME panne rattrapée par plusieurs couches ne doit produire qu'UNE ligne.
   *
   * 2026-07-27 : `TripAnalysisLlmService` archivait l'échec IA sous `TRIP_ANALYSIS_AI` puis
   * re-levait ; `TripAutomationService` le rattrapait et l'archivait sous `TRIP_AUTOMATION` → deux
   * lignes à la milliseconde près pour un seul incident. La dédup par empreinte ne pouvait pas le
   * voir : elle porte sur `source|niveau|message`, et c'est justement la source qui diffère.
   */
  describe('double journalisation d\'une même instance d\'erreur', () => {
    it('n\'archive QU\'UNE fois la même erreur remontée par deux couches (sources différentes)', async () => {
      const { logger, create } = build();
      const boom = new Error('Erreur du service IA (400) : Grammar compilation timed out.');

      const first = await logger.record(boom, 'TRIP_ANALYSIS_AI', { tripId: 't-1' });
      const second = await logger.record(boom, 'TRIP_AUTOMATION', { tripId: 't-1', phase: 'narrate' });

      expect(first).toBe('log-1');
      expect(second).toBe('already-recorded');
      expect(create).toHaveBeenCalledTimes(1);
      // C'est la couche la PLUS PROCHE de la panne qui écrit (contexte le plus précis).
      expect(create.mock.calls[0][0].data.source).toBe('TRIP_ANALYSIS_AI');
    });

    it('⚠️ deux erreurs DISTINCTES restent archivées séparément (pas de sur-filtrage)', async () => {
      const { logger, create } = build();

      await logger.record(new Error('panne A'), 'engine-control');
      await logger.record(new Error('panne B'), 'schedule-cron');

      expect(create).toHaveBeenCalledTimes(2);
    });

    it('une erreur passée en chaîne de caractères n\'est jamais marquée (rien à marquer)', async () => {
      const { logger, create } = build();

      await logger.record('panne texte', 'engine-control');
      await logger.record('panne texte', 'autre-source');

      expect(create).toHaveBeenCalledTimes(2);
    });
  });

  describe('isTransient', () => {
    it('ne se déclenche que sur un marqueur explicite', () => {
      expect(isTransient(new AiServiceError('overloaded', 'x'))).toBe(true);
      expect(isTransient(new AiServiceError('http', 'x'))).toBe(false);
      expect(isTransient(new Error('overloaded'))).toBe(false);
      expect(isTransient('overloaded')).toBe(false);
      expect(isTransient(null)).toBe(false);
      expect(isTransient({ transient: 'oui' })).toBe(false); // strictement true, pas truthy
    });
  });
});
