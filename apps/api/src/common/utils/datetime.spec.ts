import {
  formatFleetDate,
  formatFleetDateShort,
  formatFleetDateTime,
  formatFleetDateTimeLong,
  formatFleetTime,
} from './datetime';

/**
 * ⚠️ CE TEST DÉCRIT UNE PANNE RÉELLE (2026-07-24). Le serveur tourne en UTC :
 * `toLocaleString('fr-FR')` sans fuseau affichait les heures 2 h en arrière.
 * Une alerte SOS de 07:38 partait par e-mail annoncée « 05:38 », alors que le
 * SMS de la MÊME alerte disait 07:38.
 *
 * Les cas d'ÉTÉ **et** d'HIVER sont testés ensemble, exprès : c'est le seul
 * moyen de prouver qu'on n'a pas « corrigé » avec un +2 h en dur — un décalage
 * figé passerait l'été et casserait fin octobre, quand plus personne ne
 * regarde.
 */

// 03:38 UTC en JUILLET = 05:38 à Paris (CEST, UTC+2).
const ETE = new Date('2026-07-24T03:38:20.444Z');
// 03:38 UTC en JANVIER = 04:38 à Paris (CET, UTC+1) — décalage DIFFÉRENT.
const HIVER = new Date('2026-01-15T03:38:20.444Z');

describe('formatage des dates client — toujours en heure de Paris', () => {
  it('été (CEST, UTC+2) : 03:38 UTC ⇒ 05:38', () => {
    expect(formatFleetDateTime(ETE)).toBe('24/07/2026 05:38');
  });

  it('hiver (CET, UTC+1) : 03:38 UTC ⇒ 04:38 — le décalage n\'est PAS constant', () => {
    // Si quelqu'un « répare » un jour en ajoutant 2 h en dur, CE test tombe.
    expect(formatFleetDateTime(HIVER)).toBe('15/01/2026 04:38');
  });

  it('l\'heure seule suit le même fuseau (cohérence e-mail / SMS)', () => {
    expect(formatFleetTime(ETE)).toBe('05:38');
    expect(formatFleetTime(HIVER)).toBe('04:38');
  });

  it('⚠️ le fuseau peut changer le JOUR, pas seulement l\'heure', () => {
    // 22:30 UTC le 23/07 = 00:30 le 24/07 à Paris. Sans fuseau, un rapport
    // « du 24 » aurait porté la date du 23 — une erreur invisible et fausse.
    const veille = new Date('2026-07-23T22:30:00.000Z');
    expect(formatFleetDate(veille)).toBe('24/07/2026');
    expect(formatFleetDateShort(veille)).toBe('24/07/26');
  });

  it('format long : lisible et localisé', () => {
    const long = formatFleetDateTimeLong(ETE);
    expect(long).toContain('24 juillet 2026');
    expect(long).toContain('05:38');
  });

  it('accepte une chaîne ISO comme une Date (les payloads arrivent en JSON)', () => {
    expect(formatFleetDateTime(ETE.toISOString())).toBe('24/07/2026 05:38');
  });

  it('⚠️ le résultat NE DÉPEND PAS du fuseau du processus', () => {
    // Le VPS est en UTC, un poste de dev en Europe/Paris : la sortie doit être
    // identique. C'est toute la raison d'être de ces helpers.
    const avant = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      expect(formatFleetDateTime(ETE)).toBe('24/07/2026 05:38');
      process.env.TZ = 'Europe/Paris';
      expect(formatFleetDateTime(ETE)).toBe('24/07/2026 05:38');
    } finally {
      if (avant === undefined) delete process.env.TZ;
      else process.env.TZ = avant;
    }
  });
});
