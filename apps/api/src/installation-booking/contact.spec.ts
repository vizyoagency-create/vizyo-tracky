import { emailClientPropre, telephoneClientE164, telephoneLisible } from './contact';

/**
 * Le contact d'une demande est OBLIGATOIRE (16/09). Ce qui compte ici : un numéro tapé comme un
 * client français le tape devient un E.164 qui sonne, et tout ce qui ne peut pas sonner est refusé.
 */
describe('contact — téléphone client → E.164', () => {
  it.each([
    ['06 12 34 56 78', '+33612345678'],
    ['0612345678', '+33612345678'],
    ['06.12.34.56.78', '+33612345678'],
    ['05 61 00 00 00', '+33561000000'],
    ['+33 6 12 34 56 78', '+33612345678'],
    ['0033612345678', '+33612345678'],
    ['612345678', '+33612345678'],
    ['+41 79 123 45 67', '+41791234567'],
  ])('%s → %s', (saisi, attendu) => {
    expect(telephoneClientE164(saisi)).toBe(attendu);
  });

  it('refuse ce qui ne peut pas sonner', () => {
    expect(telephoneClientE164('')).toBeNull();
    expect(telephoneClientE164('   ')).toBeNull();
    expect(telephoneClientE164('06 12 34')).toBeNull();
    expect(telephoneClientE164('0012')).toBeNull();
    expect(telephoneClientE164('+0612345678')).toBeNull();
    expect(telephoneClientE164('abc')).toBeNull();
    expect(telephoneClientE164(null)).toBeNull();
  });
});

describe('contact — e-mail', () => {
  it('met en minuscules et refuse une adresse sans forme', () => {
    expect(emailClientPropre('  Marc@Legrand.FR ')).toBe('marc@legrand.fr');
    expect(emailClientPropre('marc@legrand')).toBeNull();
    expect(emailClientPropre('')).toBeNull();
  });
});

describe('contact — affichage', () => {
  it('rend un mobile français lisible et laisse les autres en E.164', () => {
    expect(telephoneLisible('+33612345678')).toBe('06 12 34 56 78');
    expect(telephoneLisible('+41791234567')).toBe('+41791234567');
    expect(telephoneLisible(null)).toBeNull();
  });
});
