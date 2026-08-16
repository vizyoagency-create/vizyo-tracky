import { genererTokenPartage, LONGUEUR_TOKEN, tronquerAdresse } from './share-token';

/**
 * Lot A4 — le token est la SEULE chose qui protege le lien public.
 *
 * Il n'y a ni compte, ni mot de passe, ni cookie derriere lui : qui connait le token
 * voit la position. Ces tests protegent donc trois proprietes dont la perte ne se
 * verrait a l'oeil nu dans aucun ecran.
 */
describe('Token de partage public', () => {
  it('fait 22 caracteres base62, sans separateur', () => {
    for (let i = 0; i < 100; i++) {
      const token = genererTokenPartage();
      expect(token).toHaveLength(LONGUEUR_TOKEN);
      expect(token).toMatch(/^[A-Za-z0-9]{22}$/);
    }
  });

  it('ne collisionne pas sur 10 000 tirages', () => {
    const vus = new Set<string>();
    for (let i = 0; i < 10_000; i++) vus.add(genererTokenPartage());
    expect(vus.size).toBe(10_000);
  });

  it('distribue uniformement — aucun caractere sur-represente', () => {
    // 20 000 caracteres sur 62 valeurs : ~323 occurrences attendues chacune. On tolere
    // une marge large (±40 %) : ce test cherche un BIAIS SYSTEMATIQUE (un `% 62` sans
    // rejet favoriserait les 8 premiers caracteres), pas une derive statistique.
    const compte = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      for (const c of genererTokenPartage()) compte.set(c, (compte.get(c) ?? 0) + 1);
    }
    const attendu = (1000 * LONGUEUR_TOKEN) / 62;
    for (const [caractere, n] of compte) {
      expect({ caractere, n }).toMatchObject({ caractere });
      expect(n).toBeGreaterThan(attendu * 0.6);
      expect(n).toBeLessThan(attendu * 1.4);
    }
    // Les 62 caracteres doivent tous sortir : un alphabet ampute reduit l'entropie.
    expect(compte.size).toBe(62);
  });

  it('ne derive RIEN d\'un identifiant : deux appels successifs n\'ont aucun prefixe commun', () => {
    const a = genererTokenPartage();
    const b = genererTokenPartage();
    expect(a).not.toBe(b);
    // Un generateur derive (compteur, horodatage, uuid tronque) partagerait un prefixe.
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8));
  });
});

describe('Empreinte tronquee de l\'appelant (RGPD)', () => {
  it('garde deux octets d\'une IPv4, jamais les quatre', () => {
    expect(tronquerAdresse('92.184.1.2')).toBe('92.184.x.x');
    expect(tronquerAdresse('92.184.1.2')).not.toContain('1.2');
  });

  it('nettoie le prefixe IPv6 qu\'Express ajoute aux IPv4', () => {
    expect(tronquerAdresse('::ffff:92.184.1.2')).toBe('92.184.x.x');
  });

  it('garde deux groupes d\'une IPv6 — l\'operateur, pas l\'abonne', () => {
    expect(tronquerAdresse('2a01:cb08:1234:5678:9abc:def0:1234:5678')).toBe('2a01:cb08::');
  });

  it('rend null plutot qu\'une valeur douteuse', () => {
    expect(tronquerAdresse(undefined)).toBeNull();
    expect(tronquerAdresse('')).toBeNull();
    expect(tronquerAdresse('pas-une-adresse')).toBeNull();
    expect(tronquerAdresse('1.2.3')).toBeNull();
  });
});
