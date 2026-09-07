import { identiteDemo, imeiDemo, nomGroupeDemo, nomLieuDemo, nomZoneDemo, plaqueDemo } from './pseudonymes';
import { idDemo, uuidV5 } from './uuid-deterministe';

const SEL = 'un-sel-de-test-suffisamment-long';

describe('pseudonymes déterministes', () => {
  it('plaqueDemo : format SIV, stable pour un même sel, différente pour un autre sel', () => {
    const a = plaqueDemo(SEL, 'FV-941-LZ');
    expect(a).toMatch(/^[A-HJ-NP-TV-Z]{2}-\d{3}-[A-HJ-NP-TV-Z]{2}$/);
    expect(plaqueDemo(SEL, 'fv-941-lz ')).toBe(a); // casse et espaces indifférents
    expect(plaqueDemo('autre-sel-tout-aussi-long', 'FV-941-LZ')).not.toBe(a);
    expect(plaqueDemo(SEL, 'FV-941-LZ', 1)).not.toBe(a); // la tentative change la valeur
  });

  it('plaqueDemo : jamais SS à gauche ni à droite, jamais WW à gauche, numéro 001-999', () => {
    for (let i = 0; i < 2000; i++) {
      const p = plaqueDemo(SEL, `PLAQUE-${i}`);
      const [g, n, d] = p.split('-');
      expect(g).not.toBe('SS');
      expect(g).not.toBe('WW');
      expect(d).not.toBe('SS');
      expect(Number(n)).toBeGreaterThanOrEqual(1);
      expect(Number(n)).toBeLessThanOrEqual(999);
    }
  });

  it('imeiDemo : 15 chiffres, clé de Luhn valide, stable', () => {
    const imei = imeiDemo(SEL, '864035054756169');
    expect(imei).toMatch(/^35\d{13}$/);
    expect(imeiDemo(SEL, '864035054756169')).toBe(imei);
    // Vérification de Luhn indépendante.
    let somme = 0;
    let doubler = false;
    for (let i = imei.length - 1; i >= 0; i--) {
      let d = Number(imei[i]);
      if (doubler) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      somme += d;
      doubler = !doubler;
    }
    expect(somme % 10).toBe(0);
  });

  it('identiteDemo : un prénom et un nom des listes, stables', () => {
    const id = identiteDemo(SEL, 'driver-42');
    expect(id.firstName.length).toBeGreaterThan(1);
    expect(id.lastName.length).toBeGreaterThan(1);
    expect(identiteDemo(SEL, 'driver-42')).toEqual(id);
    expect(identiteDemo(SEL, 'driver-43')).not.toEqual(id);
  });

  it('noms de lieux et de zones : le genre et un numéro, rien du client', () => {
    expect(nomLieuDemo('DEPOT', 1)).toBe('Dépôt 1');
    expect(nomLieuDemo('FUEL_STATION', 2)).toBe('Station 2');
    expect(nomLieuDemo('INCONNU', 3)).toBe('Site 3');
    expect(nomZoneDemo(4)).toBe('Zone 4');
  });

  it("noms de groupes : inventés, jamais repris de la source, et uniques même au-delà de la liste", () => {
    // Le cas réel qui a motivé la règle : les groupes de la société source portent les noms de
    // ses foyers (« ARC EN CIEL », « ESCALE »…). Aucun ne doit ressortir.
    expect(nomGroupeDemo(0)).toBe('Secteur Nord');
    expect(nomGroupeDemo(5)).toBe('Atelier');
    // Vingt-cinq groupes fusionnés : vingt-cinq noms distincts, sans exception.
    const noms = Array.from({ length: 25 }, (_, i) => nomGroupeDemo(i));
    expect(new Set(noms).size).toBe(25);
    expect(noms[20]).toBe('Groupe 21');
    expect(noms.some((n) => /arc en ciel|escale|havre|eden/i.test(n))).toBe(false);
  });
});

describe('identifiants déterministes (UUID v5)', () => {
  it('reproduit le vecteur de référence de la RFC 4122 (espace DNS, www.example.com)', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('idDemo : stable pour (sel, modèle, id), distinct entre modèles et entre sels', () => {
    const a = idDemo(SEL, 'Vehicle', 'v-1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idDemo(SEL, 'Vehicle', 'v-1')).toBe(a);
    expect(idDemo(SEL, 'Tracker', 'v-1')).not.toBe(a);
    expect(idDemo('un-autre-sel-assez-long', 'Vehicle', 'v-1')).not.toBe(a);
  });
});
