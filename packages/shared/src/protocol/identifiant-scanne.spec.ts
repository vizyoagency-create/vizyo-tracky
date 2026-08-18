import { candidatsDepuisScan, luhnValide, normaliserScan } from './identifiant-scanne';

/**
 * Les valeurs de ce fichier viennent du parc RÉEL (relevé du 2026-08-18), pas d'exemples
 * inventés : c'est la seule façon de savoir que la reconnaissance marche sur les
 * étiquettes que le technicien a réellement en main.
 */
const IMEI_FL = '864035054756409';
const IMEI_FV = '864035053276839';
const ICCID_FL = '8934075700126838215';
const MSISDN_FL = '345901035259762';

describe('luhnValide', () => {
  it('valide les IMEI reels du parc', () => {
    expect(luhnValide(IMEI_FL)).toBe(true);
    expect(luhnValide(IMEI_FV)).toBe(true);
    expect(luhnValide('863378070030776')).toBe(true);
  });

  it('valide l’ICCID reel', () => {
    expect(luhnValide(ICCID_FL)).toBe(true);
  });

  it('rejette un IMEI dont un chiffre a ete mal saisi', () => {
    // Le cas vecu : quatre boitiers du parc portaient un IMEI faux a 1-3 chiffres pres.
    expect(luhnValide('864035054756419')).toBe(false);
  });

  it('refuse ce qui n’est pas une suite de chiffres', () => {
    expect(luhnValide('')).toBe(false);
    expect(luhnValide('86403505475640X')).toBe(false);
  });
});

describe('normaliserScan — ce que rendent les lecteurs', () => {
  it('accepte la suite nue', () => {
    expect(normaliserScan(IMEI_FL)).toBe(IMEI_FL);
  });

  it('retire un prefixe d’etiquette', () => {
    expect(normaliserScan(`IMEI:${IMEI_FL}`)).toBe(IMEI_FL);
    expect(normaliserScan(`IMEI ${IMEI_FL}`)).toBe(IMEI_FL);
  });

  it('retire les separateurs de lisibilite', () => {
    expect(normaliserScan('8640 3505 4756 409')).toBe(IMEI_FL);
    expect(normaliserScan('864035-054756-409')).toBe(IMEI_FL);
  });

  it('⚠️ garde la PLUS LONGUE suite quand l’etiquette en porte plusieurs', () => {
    // Etiquette type : un numero de lot court a cote de l'identifiant long.
    expect(normaliserScan(`LOT 2026 SN ${IMEI_FL} V2`)).toBe(IMEI_FL);
    expect(normaliserScan(`https://baanool.com/add?imei=${IMEI_FL}&v=3`)).toBe(IMEI_FL);
  });

  it('rend une chaine vide quand il n’y a rien d’exploitable', () => {
    expect(normaliserScan('')).toBe('');
    expect(normaliserScan('SANS CHIFFRE')).toBe('');
  });
});

describe('candidatsDepuisScan — proposer, jamais trancher seul', () => {
  it('un IMEI valide passe en tete, avec confiance sure', () => {
    const c = candidatsDepuisScan(IMEI_FL);
    expect(c[0]).toEqual({ type: 'imei', valeur: IMEI_FL, confiance: 'sure' });
  });

  it('⚠️ un IMEI de 15 chiffres propose AUSSI le numero — seule la base tranche', () => {
    // IMEI et MSISDN font tous deux 15 chiffres sur ce parc. On refuse de deviner.
    const types = candidatsDepuisScan(IMEI_FL).map((x) => x.type);
    expect(types).toEqual(['imei', 'msisdn']);
  });

  it('15 chiffres SANS clé de Luhn : le numero passe devant', () => {
    // Le MSISDN reel du FL. Un « IMEI » qui echoue a sa propre cle est douteux.
    const c = candidatsDepuisScan(MSISDN_FL);
    expect(c.map((x) => x.type)).toEqual(['msisdn', 'imei']);
  });

  it('reconnait un ICCID a son prefixe 89 et sa longueur', () => {
    const c = candidatsDepuisScan(ICCID_FL);
    expect(c[0]).toEqual({ type: 'iccid', valeur: ICCID_FL, confiance: 'sure' });
  });

  it('un numero court n’est propose que comme MSISDN', () => {
    expect(candidatsDepuisScan('+33656691615').map((x) => x.type)).toEqual(['msisdn']);
  });

  it('rend une liste VIDE plutot qu’un candidat invente', () => {
    // L'appelant doit alors proposer la saisie manuelle. Inventer un candidat ici
    // enverrait l'interface interroger la base sur du bruit.
    expect(candidatsDepuisScan('ETIQUETTE ILLISIBLE')).toEqual([]);
    expect(candidatsDepuisScan('12345')).toEqual([]);
  });
});
