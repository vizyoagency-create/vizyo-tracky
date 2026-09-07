import { Prisma } from '@prisma/client';
import { ALLOWLIST, EXCLUS } from './allowlist';

/**
 * ═══ LE FILET : chaque modèle et chaque champ du schéma a un sort DÉCIDÉ ════════════════
 *
 * Ce test lit le schéma tel que Prisma le connaît (DMMF) et exige :
 *   1. que chaque modèle soit dans l'allowlist OU dans les exclusions, avec une raison ;
 *   2. que, pour un modèle allowlisté, CHAQUE colonne soit copiée, transformée ou imposée —
 *      ni plus (un champ listé qui n'existe plus), ni moins (un champ neuf non décidé).
 *
 * Il échoue donc dès qu'une migration ajoute une table ou une colonne. C'est le but : une
 * colonne `driverPhone` ajoutée un lundi ne doit pas partir en démo le dimanche suivant parce
 * que personne n'a pensé à l'importeur. Le correctif est toujours d'une ligne — dans
 * `allowlist.ts` — mais c'est une ligne qu'un humain écrit en sachant ce qu'elle contient.
 */
describe("allowlist de l'import de démonstration — couverture du schéma Prisma", () => {
  const modeles = Prisma.dmmf.datamodel.models;
  const colonnes = (nom: string): string[] =>
    modeles.find((m) => m.name === nom)!.fields.filter((f) => f.kind !== 'object').map((f) => f.name);

  it('chaque modèle du schéma est allowlisté ou exclu avec une raison', () => {
    const sansSort = modeles
      .map((m) => m.name)
      .filter((nom) => !ALLOWLIST[nom] && !EXCLUS[nom]);
    expect(sansSort).toEqual([]);
  });

  it("aucun modèle n'est à la fois allowlisté et exclu", () => {
    const doubles = Object.keys(ALLOWLIST).filter((nom) => EXCLUS[nom]);
    expect(doubles).toEqual([]);
  });

  it("chaque modèle allowlisté ou exclu existe encore dans le schéma", () => {
    const connus = new Set(modeles.map((m) => m.name));
    const fantomes = [...Object.keys(ALLOWLIST), ...Object.keys(EXCLUS)].filter((nom) => !connus.has(nom));
    expect(fantomes).toEqual([]);
  });

  it('chaque raison d\'exclusion est une phrase, pas un vide', () => {
    for (const [nom, raison] of Object.entries(EXCLUS)) {
      expect({ nom, raison: raison.length > 20 }).toEqual({ nom, raison: true });
    }
  });

  describe.each(Object.keys(ALLOWLIST))('modèle %s', (nom) => {
    const regle = ALLOWLIST[nom]!;
    const decides = [...regle.copies, ...regle.transformes, ...regle.imposes];

    it('a une raison', () => {
      expect(regle.pourquoi.length).toBeGreaterThan(20);
    });

    it("ne liste aucun champ deux fois", () => {
      const doublons = decides.filter((c, i) => decides.indexOf(c) !== i);
      expect(doublons).toEqual([]);
    });

    it('couvre exactement les colonnes du schéma (un champ neuf = une décision à prendre)', () => {
      const schema = colonnes(nom).sort();
      const nonDecides = schema.filter((c) => !decides.includes(c));
      const disparus = decides.filter((c) => !schema.includes(c));
      expect({ nonDecides, disparus }).toEqual({ nonDecides: [], disparus: [] });
    });
  });
});
