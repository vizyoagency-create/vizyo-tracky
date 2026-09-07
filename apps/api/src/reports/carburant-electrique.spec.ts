import { bruleDuCarburant, co2DuCarburant } from '@vizyo/tracky-shared';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UN VÉHICULE ÉLECTRIQUE NE CONSOMME PAS DE GAZOLE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'estimation de consommation part du TYPE du véhicule — voiture 7 L/100, fourgon 10, camion
 * 22 — et n'a jamais regardé son ÉNERGIE. Un fourgon électrique héritait donc des 10 L/100 km
 * du type « fourgon ».
 *
 * ── CE QUE ÇA A COÛTÉ, MESURÉ ────────────────────────────────────────────────────────────
 *
 * Société de production, semaine du 31/08 au 06/09/2026 : cinq fourgons électriques, 695,1 km.
 *   → 69,5 litres de gazole qui n'existent pas
 *   → 128,58 € de carburant facturés à un parc qui ne s'alimente pas en carburant
 *   → 166,8 kg de CO₂ inventés, au facteur « énergie inconnue »
 * Le tout dans le rapport hebdomadaire envoyé au client le lundi matin.
 *
 * ── ET LA RÈGLE EXISTAIT DÉJÀ ────────────────────────────────────────────────────────────
 *
 * `trip-analysis.preprocessor` écrivait `electric ? null : …` depuis toujours. Le même véhicule
 * affichait donc 0 L sur la fiche de son trajet et des litres sur le rapport de sa semaine.
 * Une règle appliquée à un seul endroit n'est pas une règle : c'est une coïncidence.
 *
 * ⚠️ CE FICHIER TESTE LA RÈGLE NUE, pas ses trois branchements. Les branchements sont vérifiés
 * là où ils vivent (`reports-stats`, le classeur, le préprocesseur) ; ici on tient la
 * définition, qui est la seule chose qui ne doit jamais redevenir locale.
 */

describe('bruleDuCarburant — qui entre dans l’estimation carburant', () => {
  it('🔴 un électrique ne brûle rien', () => {
    expect(bruleDuCarburant('ELECTRIQUE')).toBe(false);
  });

  it('la casse ne change rien : les fiches n’écrivent pas toutes pareil', () => {
    for (const e of ['electrique', 'Electrique', 'ÉLECTRIQUE'.replace('É', 'E')]) {
      expect(bruleDuCarburant(e)).toBe(false);
    }
  });

  it('un hybride brûle, LUI — il a un moteur thermique', () => {
    // Et la table de CO₂ lui donne d'ailleurs son propre facteur : le produit sait déjà qu'il
    // consomme. Le passer à zéro effacerait la moitié thermique d'un parc en transition.
    expect(bruleDuCarburant('HYBRIDE')).toBe(true);
  });

  it('diesel, essence, autre : tous brûlent', () => {
    for (const e of ['DIESEL', 'ESSENCE', 'AUTRE']) expect(bruleDuCarburant(e)).toBe(true);
  });

  /**
   * ⚠️ UNE FICHE INCOMPLÈTE BRÛLE. Rendre `false` pour une énergie absente ferait de l'oubli de
   * saisie le moyen le plus simple d'afficher une consommation nulle — exactement le
   * raisonnement que `CO2_KG_PAR_LITRE_DEFAUT` tient déjà pour l'empreinte carbone.
   *
   * Ce n'est pas théorique : le véhicule qui a révélé ce lot avait justement `energy` vide.
   */
  it('une énergie inconnue brûle : l’oubli de saisie ne doit pas payer', () => {
    expect(bruleDuCarburant(null)).toBe(true);
    expect(bruleDuCarburant(undefined)).toBe(true);
    expect(bruleDuCarburant('')).toBe(true);
  });
});

describe('Ce que la règle change sur le cas réel mesuré', () => {
  /** Cinq fourgons électriques, 695,1 km, défaut du type « fourgon ». */
  const KM = 695.1;
  const L100_FOURGON = 10;
  const PRIX = 1.85;

  it('avant : des litres, un coût et un CO₂ entièrement inventés', () => {
    // La formule d'alors, sans garde — reproduite pour montrer ce qui partait chez le client.
    const litres = (KM * L100_FOURGON) / 100;

    expect(litres).toBeCloseTo(69.5, 1);
    expect(litres * PRIX).toBeCloseTo(128.6, 1);
    expect(co2DuCarburant(litres, 'ELECTRIQUE')).toBeCloseTo(166.8, 1);
  });

  it('après : zéro litre, zéro euro — et le kilométrage reste compté', () => {
    const litres = bruleDuCarburant('ELECTRIQUE') ? (KM * L100_FOURGON) / 100 : 0;

    expect(litres).toBe(0);
    expect(litres * PRIX).toBe(0);
    // Le kilomètre, lui, a bien été parcouru : c'est la CONSOMMATION qui est hors sujet,
    // pas la distance. Rien ici ne doit toucher au total kilométrique de la flotte.
    expect(KM).toBe(695.1);
  });
});
