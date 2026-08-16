import { calculerDevis, euros, libelleTranche, type Devis, type GrilleTarifaire } from './devis-tarifaire';

/**
 * Tests Jasmine de l'apercu de devis du depot (lot A6, § 3 et § 7bis).
 *
 * ┌─ CE QUI EST PROTEGE ICI ──────────────────────────────────────────────────┐
 * │ 1. CE CALCUL EST UN MIROIR DU SERVEUR. Les memes bornes, les memes         │
 * │    arrondis. Un ecart d'un kilometre ou d'un centime, et l'ecran annonce   │
 * │    un prix que le devis recu dementira — pire qu'un ecran sans prix.       │
 * │                                                                            │
 * │ 2. LA REGLE DE SELECTION D'UNE TRANCHE. La grille du client saute de       │
 * │    « 0 a 50 » a « 51 a 100 » : un encadrement litteral [fromKm, toKm]      │
 * │    laisserait 50,4 km SANS TRANCHE.                                        │
 * │                                                                            │
 * │ 3. L'AVERTISSEMENT DE BORNE. C'est la raison d'etre de tout l'ecran : il   │
 * │    evite l'appel « pourquoi ai-je paye le double pour deux kilometres ».   │
 * │    Un avertissement faux d'un kilometre decredibilise tous les autres.     │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
describe('devis-tarifaire — l\'aperçu côté dépôt', () => {
  /** La grille réelle du client, telle que la migration l'écrit (§ 3). */
  const GRILLE: GrilleTarifaire = {
    fleetId: 'f-1',
    enabled: true,
    vatPct: 20,
    quoteValidityHours: 48,
    extraStopCents: 0,
    waitingHourCents: 0,
    quoteFooterNote: null,
    category: 'Transport de marchandise',
    updatedAt: '2026-08-13T12:00:00Z',
    tiers: [
      { position: 0, fromKm: 0, toKm: 50, priceCents: 7900 },
      { position: 1, fromKm: 51, toKm: 100, priceCents: 16900 },
      { position: 2, fromKm: 101, toKm: 150, priceCents: 25900 },
      { position: 3, fromKm: 151, toKm: 200, priceCents: 34900 },
      { position: 4, fromKm: 201, toKm: 250, priceCents: 44900 },
      { position: 5, fromKm: 251, toKm: 300, priceCents: 53900 },
      { position: 6, fromKm: 301, toKm: 350, priceCents: 62900 },
      { position: 7, fromKm: 351, toKm: 400, priceCents: 71900 },
      { position: 8, fromKm: 401, toKm: null, priceCents: null },
    ],
  };

  const tarif = (km: number, grille: GrilleTarifaire = GRILLE) => {
    const d = calculerDevis(km, grille);
    if (d.statut !== 'TARIF') throw new Error(`tarif attendu pour ${km} km, reçu ${d.statut}`);
    return d;
  };

  /** Jasmine n'a pas `toHaveProperty` : on regarde le champ, pas la forme. */
  const champ = (d: Devis, nom: string): unknown => (d as unknown as Record<string, unknown>)[nom];

  // ═══ LA GRILLE RÉELLE, BORNE PAR BORNE ═══════════════════════════════════

  describe('le tarif appliqué, borne par borne', () => {
    const attendu: Array<[number, number]> = [
      [1, 7900], [50, 7900],
      [51, 16900], [100, 16900],
      [101, 25900], [150, 25900],
      [151, 34900], [200, 34900],
      [201, 44900], [250, 44900],
      [251, 53900], [300, 53900],
      [301, 62900], [350, 62900],
      [351, 71900], [400, 71900],
    ];
    for (const [km, cents] of attendu) {
      it(`${km} km → ${cents} centimes HT`, () => {
        expect(tarif(km).htCents).toBe(cents);
      });
    }
  });

  /**
   * Le trou de la grille. « 0 a 50 » puis « 51 a 100 » : entre les deux, 50,4 km
   * n'appartient litteralement a aucun intervalle. La regle retenue — la premiere
   * tranche dont `toKm` couvre la distance, sur des kilometres arrondis au superieur —
   * le range dans la seconde, exactement comme le serveur.
   */
  it('50,4 km ne tombe dans aucun trou : 51 km facturés, tranche 51 à 100', () => {
    const d = tarif(50.4);
    expect(d.distanceKm).toBe(51);
    expect(d.htCents).toBe(16900);
    expect(d.trancheLibelle).toBe('51 à 100 km');
  });

  it('arrondit au SUPÉRIEUR : 50,001 km sont 51 km à facturer', () => {
    // Arrondir au plus proche ferait basculer 50,4 dans la tranche basse — un cadeau
    // involontaire, et surtout une règle que personne n'a décidée.
    expect(tarif(50.001).distanceKm).toBe(51);
    expect(tarif(50).distanceKm).toBe(50);
  });

  it('calcule la TVA en une seule fois, sur des entiers de centimes', () => {
    const d = tarif(43);
    expect(d.htCents).toBe(7900);
    expect(d.tvaCents).toBe(1580);
    expect(d.ttcCents).toBe(9480);
    // Le total retombe sur ses composantes : c'est l'écart d'un centime qu'un
    // comptable remonte six mois plus tard.
    expect(d.htCents + d.tvaCents).toBe(d.ttcCents);
  });

  // ═══ « SUR DEVIS » N'EST PAS ZÉRO ═════════════════════════════════════════

  describe('au-delà de 400 km', () => {
    it('répond SUR_DEVIS, jamais un montant', () => {
      const d = calculerDevis(420, GRILLE);
      expect(d.statut).toBe('SUR_DEVIS');
      expect(champ(d, 'htCents')).toBeUndefined();
      expect(champ(d, 'ttcCents')).toBeUndefined();
    });

    it('dit à partir d\'où, pour que le dépôt sache ce qui a déclenché', () => {
      const d = calculerDevis(420, GRILLE);
      if (d.statut !== 'SUR_DEVIS') throw new Error('sur devis attendu');
      expect(d.motif).toContain('401');
    });

    it('bascule à 401 km, pas à 400', () => {
      expect(calculerDevis(400, GRILLE).statut).toBe('TARIF');
      expect(calculerDevis(401, GRILLE).statut).toBe('SUR_DEVIS');
    });

    it('répond SUR_DEVIS quand la dernière tranche est bornée et ne couvre pas', () => {
      const bornee: GrilleTarifaire = {
        ...GRILLE,
        tiers: [{ position: 0, fromKm: 0, toKm: 50, priceCents: 7900 }],
      };
      expect(calculerDevis(80, bornee).statut).toBe('SUR_DEVIS');
    });
  });

  // ═══ L'AVERTISSEMENT DE BORNE ═════════════════════════════════════════════

  /**
   * L'exemple litteral du § 7bis : « 3 km de plus font passer a la tranche suivante,
   * 169 € au lieu de 79 € ». Il doit tomber JUSTE. A 48 km sur une tranche qui s'arrete
   * a 50, ce sont bien 49, 50, 51 — trois kilometres, et 51 est dans la tranche d'apres.
   */
  describe('l\'avertissement de borne — ce qui évite l\'appel', () => {
    it('à 48 km : « 3 km de plus », 169 € au lieu de 79 €', () => {
      expect(tarif(48).borne).toEqual({ kmAvant: 3, actuelCents: 7900, suivantCents: 16900 });
    });

    it('à 50 km, la borne même : 1 km de plus suffit', () => {
      expect(tarif(50).borne?.kmAvant).toBe(1);
    });

    it('se tait quand la bascule est loin — sinon il devient un décor', () => {
      expect(tarif(20).borne).toBeNull();
      expect(tarif(44).borne).toBeNull();
    });

    it('prévient dès 5 km avant, pas moins : à 1 km on ne peut plus rien changer', () => {
      expect(tarif(46).borne?.kmAvant).toBe(5);
      expect(tarif(45).borne).toBeNull();
    });

    it('annonce « sur devis » quand c\'est la tranche suivante', () => {
      expect(tarif(399).borne).toEqual({ kmAvant: 2, actuelCents: 71900, suivantCents: null });
    });

    it('se tait sur la dernière tranche : rien ne bascule après', () => {
      const uneSeule: GrilleTarifaire = {
        ...GRILLE,
        tiers: [{ position: 0, fromKm: 0, toKm: 50, priceCents: 7900 }],
      };
      expect(tarif(49, uneSeule).borne).toBeNull();
    });

    it('se tait si la tranche suivante coûte MOINS : la phrase serait inutilisable', () => {
      const decroissante: GrilleTarifaire = {
        ...GRILLE,
        tiers: [
          { position: 0, fromKm: 0, toKm: 50, priceCents: 16900 },
          { position: 1, fromKm: 51, toKm: null, priceCents: 7900 },
        ],
      };
      expect(tarif(49, decroissante).borne).toBeNull();
    });
  });

  // ═══ GRILLE ABSENTE OU INUTILISABLE ═══════════════════════════════════════

  describe('sans grille utilisable', () => {
    it('aucune grille : la demande n\'a pas d\'objet, on le dit', () => {
      const d = calculerDevis(43, null);
      expect(d.statut).toBe('PAS_DE_GRILLE');
      if (d.statut !== 'PAS_DE_GRILLE') throw new Error('pas de grille attendu');
      expect(d.motif).toContain('publié ses tarifs');
    });

    it('grille désactivée : même issue', () => {
      expect(calculerDevis(43, { ...GRILLE, enabled: false }).statut).toBe('PAS_DE_GRILLE');
    });

    it('grille vide de tranches : même issue', () => {
      expect(calculerDevis(43, { ...GRILLE, tiers: [] }).statut).toBe('PAS_DE_GRILLE');
    });

    it('distance nulle : on invite à saisir, on n\'invente pas un prix', () => {
      const d = calculerDevis(0, GRILLE);
      expect(d.statut).toBe('PAS_DE_GRILLE');
      expect(champ(d, 'htCents')).toBeUndefined();
    });

    it('ne renvoie JAMAIS un montant quand la grille manque', () => {
      const d = calculerDevis(43, null);
      expect(champ(d, 'htCents')).toBeUndefined();
      expect(champ(d, 'ttcCents')).toBeUndefined();
    });
  });

  // ═══ L'ORDRE DES TRANCHES ═════════════════════════════════════════════════

  it('trie sur `position` : une grille rendue dans le désordre reste juste', () => {
    const desordre: GrilleTarifaire = { ...GRILLE, tiers: [...GRILLE.tiers].reverse() };
    expect(tarif(43, desordre).htCents).toBe(7900);
    expect(tarif(87, desordre).htCents).toBe(16900);
  });

  // ═══ AFFICHAGE ════════════════════════════════════════════════════════════

  describe('les libellés', () => {
    it('nomme la tranche comme le serveur', () => {
      expect(libelleTranche({ fromKm: 51, toKm: 100 })).toBe('51 à 100 km');
      expect(libelleTranche({ fromKm: 401, toKm: null })).toBe('au-delà de 401 km');
    });

    it('formate les montants en français, deux décimales', () => {
      // Les espaces insécables du séparateur de milliers varient selon l'environnement
      // d'exécution : on les normalise plutôt que de figer un octet précis.
      const normalise = (s: string) => s.replace(/\s/g, ' ');
      expect(normalise(euros(7900))).toBe('79,00 €');
      expect(normalise(euros(169000))).toBe('1 690,00 €');
    });
  });
});
