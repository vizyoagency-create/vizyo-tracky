import { isE164, toE164 } from './phone';

/**
 * Normalisation E.164. Le test central est le DERNIER : un numéro national ne doit JAMAIS être
 * préfixé — mieux vaut un envoi refusé qu'un SMS parti à un inconnu.
 */
describe('toE164', () => {
  it('préfixe un numéro international arrivé sans « + » (cas WhereverSIM de l\'incident)', () => {
    expect(toE164('345901030605196')).toBe('+345901030605196');
  });

  it('laisse intact un numéro déjà normalisé', () => {
    expect(toE164('+33656691615')).toBe('+33656691615');
  });

  it('ignore les séparateurs de mise en forme', () => {
    expect(toE164('+33 6 56 69 16 15')).toBe('+33656691615');
    expect(toE164('34 590 103 060 5196')).toBe('+345901030605196');
  });

  it('renvoie null sur une valeur vide ou absente', () => {
    expect(toE164(null)).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164('   ')).toBeNull();
  });

  it('NE préfixe PAS un numéro national (0…) — il resterait faux et partirait au mauvais numéro', () => {
    expect(toE164('0612345678')).toBe('0612345678'); // inchangé → sera refusé plus loin
    expect(isE164(toE164('0612345678'))).toBe(false);
  });

  it('NE préfixe PAS ce qui n\'est pas un numéro plausible', () => {
    expect(toE164('12345')).toBe('12345'); // trop court
    expect(toE164('1234567890123456')).toBe('1234567890123456'); // trop long (>15)
    expect(toE164('ABC123')).toBe('ABC123');
  });
});

describe('isE164', () => {
  it('accepte un numéro complet, refuse le reste', () => {
    expect(isE164('+345901030605196')).toBe(true);
    expect(isE164('345901030605196')).toBe(false);
    expect(isE164(null)).toBe(false);
  });
});
