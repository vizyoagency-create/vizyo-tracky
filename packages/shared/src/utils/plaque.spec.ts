import {
  formaterPlaqueFr,
  messagePlaque,
  normaliserPlaque,
  plaqueEtrangereValide,
  plaqueFrValide,
} from './plaque';

describe('formaterPlaqueFr — les tirets se posent pendant la frappe', () => {
  it('remplit le gabarit au fur et a mesure', () => {
    expect(formaterPlaqueFr('A')).toBe('A');
    expect(formaterPlaqueFr('AB')).toBe('AB');
    expect(formaterPlaqueFr('AB1')).toBe('AB-1');
    expect(formaterPlaqueFr('AB123')).toBe('AB-123');
    expect(formaterPlaqueFr('AB123C')).toBe('AB-123-C');
    expect(formaterPlaqueFr('AB123CD')).toBe('AB-123-CD');
  });

  it('accepte les minuscules, les espaces et les tirets deja tapes', () => {
    expect(formaterPlaqueFr('ab123cd')).toBe('AB-123-CD');
    expect(formaterPlaqueFr('ab 123 cd')).toBe('AB-123-CD');
    expect(formaterPlaqueFr('AB-123-CD')).toBe('AB-123-CD');
  });

  it('⚠️ ECARTE le surplus au lieu d’inserer un tiret absurde', () => {
    // Sans la coupe a 7, « AB123CDEF » rendrait « AB-123-CDEF » — une plaque
    // impossible, presentee comme bien formee.
    expect(formaterPlaqueFr('AB123CDEF')).toBe('AB-123-CD');
  });

  it('rend une chaine vide quand il n’y a rien d’exploitable', () => {
    expect(formaterPlaqueFr('')).toBe('');
    expect(formaterPlaqueFr('---')).toBe('');
  });
});

describe('plaqueFrValide', () => {
  it('accepte le format SIV', () => {
    expect(plaqueFrValide('AB-123-CD')).toBe(true);
    expect(plaqueFrValide('fl-787-kv')).toBe(true);
  });

  it('⚠️ REFUSE la saisie tronquee qui est passee en production', () => {
    // Le cas reel : un vehicule cree avec « FT- » pour toute plaque.
    expect(plaqueFrValide('FT-')).toBe(false);
    expect(plaqueFrValide('FT')).toBe(false);
    expect(plaqueFrValide('AB-123-C')).toBe(false);
    expect(plaqueFrValide('AB-12-CD')).toBe(false);
  });

  it('refuse une plaque sans tiret, meme complete', () => {
    // La base doit contenir une seule forme : sinon deux vehicules identiques
    // coexistent sous deux ecritures.
    expect(plaqueFrValide('AB123CD')).toBe(false);
  });
});

describe('plaqueEtrangere — on n’essaie pas de deviner le pays', () => {
  it('accepte la plaque allemande reelle du parc', () => {
    expect(plaqueEtrangereValide('KSR370')).toBe(true);
  });

  it('accepte des formats varies', () => {
    expect(plaqueEtrangereValide('M-AB 1234')).toBe(true);
    expect(plaqueEtrangereValide('1234 ABC')).toBe(true);
  });

  it('⚠️ ecarte quand meme la saisie interrompue', () => {
    expect(plaqueEtrangereValide('FT-')).toBe(false);
    expect(plaqueEtrangereValide('AB')).toBe(false);
  });
});

/**
 * ── LE MESSAGE DOIT DIRE QUOI TAPER, PAS SEULEMENT QU'ON A TORT ──────────────────────
 *
 * « Format invalide » laisse l'utilisateur relire son écran sans savoir ce qui cloche.
 * Chaque message ci-dessous nomme ce qui manque.
 */
describe('messagePlaque', () => {
  it('une plaque valide ne dit rien', () => {
    expect(messagePlaque('AB-123-CD', false)).toBeNull();
    expect(messagePlaque('KSR370', true)).toBeNull();
  });

  it('vide : on le dit', () => {
    expect(messagePlaque('', false)).toContain('obligatoire');
  });

  it('compte les chiffres manquants', () => {
    expect(messagePlaque('AB-1', false)).toContain('2 chiffres');
    expect(messagePlaque('AB-12', false)).toContain('1 chiffre');
  });

  it('compte les lettres manquantes a la fin', () => {
    expect(messagePlaque('AB-123-C', false)).toContain('1 lettre');
    expect(messagePlaque('AB-123', false)).toContain('2 lettres');
  });

  it('le cas « FT- » : on dit qu’il manque des chiffres', () => {
    expect(messagePlaque('FT-', false)).toContain('chiffre');
  });

  it('oriente vers la case « etrangere » quand la forme ne colle pas', () => {
    // Une plaque allemande saisie sans cocher la case doit apprendre que la case existe.
    expect(messagePlaque('KSR370X', false)).toContain('étrangère');
  });

  it('en mode etranger, la forme francaise n’est plus exigee', () => {
    expect(messagePlaque('KSR370', true)).toBeNull();
    expect(messagePlaque('FT-', true)).toContain('trop courte');
  });
});

describe('normaliserPlaque', () => {
  it('majuscules, sans separateurs', () => {
    expect(normaliserPlaque('fl-787-kv')).toBe('FL787KV');
    expect(normaliserPlaque(' ab 123 cd ')).toBe('AB123CD');
  });
});
