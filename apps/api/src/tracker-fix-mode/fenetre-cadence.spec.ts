import {
  MIN_ECHANTILLONS_DECISION,
  TAILLE_FENETRE_CADENCE,
  fenetreExploitable,
  medianeCadence,
  partEcartsCourts,
  pousserEcart,
} from './fenetre-cadence';

/**
 * TRK-056 — la cadence observée doit être une MESURE, pas un tirage.
 *
 * Le cas réel que ces tests rejouent : FM-772-JH, 01/09, cible 99 s, garé,
 * `currentFixIntervalS` affiché à **2 s** alors que ses écarts réels étaient
 * `1,53 · 3,00 · 9,39 · 98,91 · 20,15 · 1,92 · 37,43 · 35,20 · 4,30 · 4,06 · 1,62`.
 */
const ECARTS_REELS_FM772JH = [2, 55, 2, 3, 9, 99, 20, 2, 73, 4, 4, 2];

describe('fenêtre de cadence (TRK-056)', () => {
  describe('pousserEcart', () => {
    it('conserve les N derniers écarts, le plus ancien évincé', () => {
      let f: number[] = [];
      for (let i = 1; i <= TAILLE_FENETRE_CADENCE + 3; i++) f = pousserEcart(f, i);
      expect(f).toHaveLength(TAILLE_FENETRE_CADENCE);
      expect(f[0]).toBe(4);
      expect(f[f.length - 1]).toBe(TAILLE_FENETRE_CADENCE + 3);
    });

    it('ne mute pas la fenêtre reçue — la fonction reste pure', () => {
      const origine = [10, 20];
      const suivante = pousserEcart(origine, 30);
      expect(origine).toEqual([10, 20]);
      expect(suivante).toEqual([10, 20, 30]);
    });

    it('accepte une fenêtre absente (colonne fraîchement ajoutée)', () => {
      expect(pousserEcart(null, 42)).toEqual([42]);
      expect(pousserEcart(undefined, 42)).toEqual([42]);
    });

    it('ignore un écart absurde plutôt que de polluer la mesure', () => {
      expect(pousserEcart([5], 0)).toEqual([5]);
      expect(pousserEcart([5], -3)).toEqual([5]);
      expect(pousserEcart([5], Number.NaN)).toEqual([5]);
    });
  });

  describe('medianeCadence', () => {
    it('rend null sur une fenêtre vide — on ne devine pas une cadence', () => {
      expect(medianeCadence([])).toBeNull();
      expect(medianeCadence(null)).toBeNull();
    });

    // 🔑 LE TEST QUI PORTE LA FICHE — et il n'affirme PAS une valeur « juste ».
    //
    // ⚠️ La médiane de TOUS les écarts de FM-772-JH vaut 4 s, pas 47 s. Les 47 s citées dans la
    // fiche sont la médiane des écarts LONGS seulement — une autre statistique. Sur un émetteur
    // bimodal, aucun nombre unique n'est « la » cadence : c'est le sens de `partEcartsCourts`.
    //
    // Ce que le correctif apporte n'est donc pas l'exactitude, c'est la STABILITÉ : la mesure
    // cesse d'être un tirage. Le test compare les deux instruments sur la même séquence réelle.
    it('cesse d être un tirage : l échantillon varie de 2 à 99, la médiane reste dans une bande étroite', () => {
      const echantillons: number[] = [];
      const medianes: number[] = [];
      let f: number[] = [];
      for (const ecart of ECARTS_REELS_FM772JH) {
        f = pousserEcart(f, ecart);
        echantillons.push(ecart); // ce que l'ancien code persistait : la trame courante
        medianes.push(medianeCadence(f)!);
      }

      const amplitude = (xs: number[]) => Math.max(...xs) / Math.min(...xs);

      // L'ancien instrument balaie deux ordres de grandeur…
      expect(Math.min(...echantillons)).toBe(2);
      expect(Math.max(...echantillons)).toBe(99);
      expect(amplitude(echantillons)).toBeGreaterThan(20);

      // …le nouveau reste borné, et ne descend jamais au tirage minimal.
      expect(amplitude(medianes)).toBeLessThan(5);
      expect(medianes[medianes.length - 1]).not.toBe(99);
    });

    it('rend toujours une valeur RÉELLEMENT observée, jamais une valeur inventée', () => {
      let f: number[] = [];
      for (const ecart of ECARTS_REELS_FM772JH) {
        f = pousserEcart(f, ecart);
        expect(f).toContain(medianeCadence(f));
      }
    });

    // ⚠️ La moyenne tomberait entre les deux modes, là où le boîtier n'émet JAMAIS.
    it('ne rend pas la moyenne : la valeur doit avoir été réellement observée', () => {
      const bimodal = [2, 2, 2, 99, 99, 99];
      const moyenne = bimodal.reduce((a, b) => a + b, 0) / bimodal.length;
      const mediane = medianeCadence(bimodal)!;
      expect(mediane).not.toBeCloseTo(moyenne, 0);
      expect(bimodal).toContain(mediane);
    });

    it('rend toujours un écart présent dans la fenêtre, pair ou impair', () => {
      expect(medianeCadence([5, 9, 40])).toBe(9);
      expect(medianeCadence([5, 9, 40, 80])).toBe(9);
      for (const f of [[1], [1, 2], [3, 1, 2], [4, 1, 3, 2]]) {
        expect(f).toContain(medianeCadence(f));
      }
    });

    it('une salve isolée ne renverse pas une fenêtre majoritairement lente', () => {
      expect(medianeCadence([30, 30, 30, 30, 30, 2, 30])).toBe(30);
    });
  });

  describe('fenetreExploitable', () => {
    // ⚠️ Montrer une mesure partielle est honnête ; AGIR dessus ne l'est pas.
    it('exige plus d échantillons pour décider que pour afficher', () => {
      expect(fenetreExploitable([])).toBe(false);
      expect(fenetreExploitable([1, 2, 3])).toBe(false);
      expect(fenetreExploitable(new Array(MIN_ECHANTILLONS_DECISION).fill(30))).toBe(true);
    });
  });

  describe('partEcartsCourts', () => {
    // Une médiane seule redirait le défaut d'origine sous une forme plus propre :
    // un nombre unique pour une émission qui n'en a pas.
    it('expose la dispersion, pour qu un boîtier bimodal se voie comme bimodal', () => {
      expect(partEcartsCourts([2, 2, 99, 99])).toBe(50);
      expect(partEcartsCourts([30, 30, 30, 30])).toBe(0);
      expect(partEcartsCourts([1, 2, 3, 4])).toBe(100);
      expect(partEcartsCourts([])).toBeNull();
    });
  });
});
