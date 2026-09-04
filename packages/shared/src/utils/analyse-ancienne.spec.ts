/**
 * ── CE QUI SÉPARE « PAS ENCORE REPRIS » DE « JAMAIS REPRIS » ────────────────────────
 *
 * Les deux se ressemblent à l'écran : une analyse dont les chiffres datent d'avant la règle
 * actuelle. Ils ne se traitent pas pareil — l'un attend son tour, l'autre attend pour rien.
 * Les confondre ferait promettre une correction qui n'arrivera jamais, exactement la faute
 * déjà payée sur les trajets figés.
 */
import { analyseAvantRegleActuelle, analyseHorsDePortee } from './analyse-ancienne';

describe('analyseAvantRegleActuelle — la marque est l’absence de detail.vitesse', () => {
  it('reconnaît une analyse écrite avant le lot V1', () => {
    expect(analyseAvantRegleActuelle({ detail: { speeding: [] } } as never)).toBe(true);
    expect(analyseAvantRegleActuelle({ detail: {} } as never)).toBe(true);
  });

  it('laisse tranquille une analyse récente', () => {
    expect(analyseAvantRegleActuelle({ detail: { vitesse: { pointeBruteKmh: 92, pointsEcartes: 0 } } } as never)).toBe(false);
  });

  /** Pas d'analyse du tout n'est pas « une vieille analyse » : c'est autre chose. */
  it('ne dit rien d’une analyse absente', () => {
    expect(analyseAvantRegleActuelle(null)).toBe(false);
    expect(analyseAvantRegleActuelle(undefined)).toBe(false);
  });
});

describe('analyseHorsDePortee — les positions sont-elles encore là ?', () => {
  const horizon = new Date('2026-07-06T00:00:00.000Z'); // 60 jours avant le 2026-09-04

  it('un trajet plus ancien que l’horizon ne sera jamais repris', () => {
    expect(analyseHorsDePortee('2026-06-01T08:00:00.000Z', horizon)).toBe(true);
  });

  it('un trajet plus récent reste reprenable', () => {
    expect(analyseHorsDePortee('2026-09-01T08:00:00.000Z', horizon)).toBe(false);
  });

  /**
   * ⚠️ La borne est INCLUSIVE côté perte : un trajet pile sur l'horizon est en train d'être
   * purgé. Le déclarer reprenable ferait promettre une reprise qui échouera dans l'heure.
   */
  it('la borne compte comme perdue, pas comme reprenable', () => {
    expect(analyseHorsDePortee(horizon, horizon)).toBe(true);
  });

  it('refuse de trancher sur une date illisible', () => {
    expect(analyseHorsDePortee('pas une date', horizon)).toBe(false);
    expect(analyseHorsDePortee('2026-06-01T08:00:00.000Z', 'pas une date')).toBe(false);
  });
});
