import { messageAucunVehicule, motifPlacesInsuffisantes } from './aucun-vehicule.message';

/**
 * C8 × T4 (relecture du 29/09) — UNE phrase pour « véhicule choisi trop petit », levée à l'écriture
 * (`assertAssezDePlaces`) et annoncée dès la simulation de « Réorganiser → Réaffecter ».
 */
describe('motifPlacesInsuffisantes', () => {
  it('places connues sous le plancher : nomme la plaque, les places et le plancher, dit quoi faire', () => {
    expect(motifPlacesInsuffisantes('CT-008', 4, 8)).toBe(
      'CT-008 a 4 places, moins que les 8 demandées (conducteur compris). ' +
        'Choisissez un véhicule plus grand, ou répartissez le groupe : une réservation par véhicule, sans « Places min. ».',
    );
    expect(motifPlacesInsuffisantes('CT-001', 1, 2)).toMatch(/^CT-001 a 1 place, moins que les 2 demandées/);
    expect(motifPlacesInsuffisantes(null, 4, 8)).toMatch(/^Ce véhicule a 4 places/);
  });

  it('rien à refuser : pas de plancher, places inconnues ou nulles, assez de places', () => {
    expect(motifPlacesInsuffisantes('CT-008', 4, undefined)).toBeNull();
    expect(motifPlacesInsuffisantes('CT-008', 4, 0)).toBeNull();
    expect(motifPlacesInsuffisantes('CT-008', null, 8)).toBeNull();
    expect(motifPlacesInsuffisantes('CT-008', 0, 8)).toBeNull();
    expect(motifPlacesInsuffisantes('CT-008', 8, 8)).toBeNull();
    expect(motifPlacesInsuffisantes('CT-008', 9, 8)).toBeNull();
  });
});

/**
 * « AUCUN VÉHICULE » QUI DIT POURQUOI (29/09, « 12 places »).
 *
 * Le 29/09 à 05:10, sur Client test (3 véhicules de 9 places, 4 de 5, 1 de 4), une demande de
 * 12 places a reçu trois fois « Aucun véhicule libre ne correspond aux critères sur ce créneau. »
 * pendant que le panneau du jour affichait « 7 / 8 véhicules disponibles ». Le refus était juste,
 * le message parlait d'un créneau au lieu d'une taille.
 */
describe('messageAucunVehicule', () => {
  /** Le parc de Client test, tel que le vivier le compte pour un plancher donné. */
  const PARC = [9, 9, 9, 5, 5, 5, 5, 4];
  const vivierPour = (minSeats: number, parc = PARC) => ({
    minSeats,
    excludedTooSmall: parc.filter((s) => s < minSeats).length,
    largestSeats: parc.length > 0 ? Math.max(...parc) : null,
  });

  it('parc [9,9,9,5,5,5,5,4] + 12 places : parle de TAILLE, nomme le plus grand — pas d’un créneau', () => {
    const m = messageAucunVehicule(vivierPour(12));
    expect(m).toContain('12 places');
    expect(m).toContain('le plus grand en a 9');
    expect(m).toContain('conducteur compris');
    expect(m).not.toContain('sur ce créneau');
    expect(m).toBe('Aucun véhicule de 12 places ou plus (conducteur compris) : le plus grand en a 9.');
  });

  it('libres sur le créneau, toutes tailles : 7 véhicules de 4 à 9 places → « répartissez le groupe »', () => {
    const m = messageAucunVehicule({ ...vivierPour(12), libresToutesTailles: { n: 7, min: 4, max: 9 } });
    expect(m).toBe(
      'Aucun véhicule de 12 places ou plus (conducteur compris) : le plus grand en a 9. ' +
        'Sur ce créneau, 7 véhicules sont libres, de 4 à 9 places : répartissez le groupe sur plusieurs véhicules (une réservation par véhicule).',
    );
  });

  /**
   * Relecture du 29/09 : le constructeur ne juge PAS la faisabilité de la répartition (il ne reçoit
   * pas la somme des places). Un seul 9 places libre pour 12 : « répartissez » serait un conseil
   * impossible — `request()` ne lui passe donc les libres que si la répartition tient (au moins deux
   * véhicules, places connues suffisantes) et dit « pas assez » lui-même sinon (cf.
   * reservations.service.spec, « répartissez seulement quand c'est possible »). Ce test-ci ne porte
   * plus que sur la forme de la fourchette, sur un cas où la répartition est possible.
   */
  it('tous de la même taille : la fourchette se dit en un nombre (3 × 5 places = 15 ≥ 12)', () => {
    expect(messageAucunVehicule({ ...vivierPour(12), libresToutesTailles: { n: 3, min: 5, max: 5 } })).toContain(
      'Sur ce créneau, 3 véhicules sont libres (5 places) : répartissez le groupe',
    );
  });

  it('aucun véhicule libre, quelle que soit sa taille : le dit, sans inventer de répartition', () => {
    const m = messageAucunVehicule({ ...vivierPour(12), libresToutesTailles: { n: 0, min: null, max: null } });
    expect(m).toContain('le plus grand en a 9');
    expect(m).toContain("Aucun véhicule n'est libre sur ce créneau, quelle que soit sa taille.");
    expect(m).not.toContain('répartissez');
  });

  it('libres non relus (absent) : pas de phrase inventée', () => {
    const m = messageAucunVehicule({ ...vivierPour(12), libresToutesTailles: null });
    expect(m).not.toContain('Sur ce créneau');
    expect(m).not.toContain('quelle que soit');
  });

  it('des véhicules assez grands existent mais sont pris : c’est alors le créneau qui manque', () => {
    // 8 places demandées : les trois 9 places suffisent, mais aucun n'est libre.
    const m = messageAucunVehicule({ ...vivierPour(8), libresToutesTailles: { n: 5, min: 4, max: 5 } });
    expect(m).toBe(
      "Aucun véhicule d'au moins 8 places n'est libre sur ce créneau. " +
        'Sur ce créneau, 5 véhicules sont libres, de 4 à 5 places : répartissez le groupe sur plusieurs véhicules (une réservation par véhicule).',
    );
  });

  describe('capacité inconnue', () => {
    it('aucun nombre de places renseigné dans le parc : pas de « plus grand » inventé', () => {
      expect(messageAucunVehicule({ minSeats: 12, excludedTooSmall: 1, largestSeats: null })).toBe(
        'Aucun véhicule de 12 places ou plus (conducteur compris).',
      );
    });

    it('véhicules sans places renseignées : comptés et nommés, avec le geste pour réparer', () => {
      const un = messageAucunVehicule({ ...vivierPour(12), excludedUnknownCapacity: 1 });
      expect(un).toContain("(1 véhicule sans nombre de places renseigné n'a pas été compté : complétez-le dans la vue Parc.)");
      const deux = messageAucunVehicule({ minSeats: 12, excludedTooSmall: 0, excludedUnknownCapacity: 2 });
      expect(deux).toBe(
        "Aucun véhicule libre ne correspond aux critères sur ce créneau (au moins 12 places). (2 véhicules sans nombre de places renseigné n'ont pas été comptés : complétez-le dans la vue Parc.)",
      );
    });

    it('boîtiers muets : la note s’ajoute, elle ne remplace pas la cause', () => {
      const m = messageAucunVehicule({ ...vivierPour(12), excludedDormant: 2, excludedUnknownCapacity: 1 });
      expect(m).toMatch(/^Aucun véhicule de 12 places ou plus/);
      expect(m).toContain('1 véhicule sans nombre de places renseigné');
      expect(m).toContain('2 écarté(s) : boîtier muet depuis plus de 7 jours');
    });
  });

  describe('sièges auto', () => {
    it('quand ce sont les sièges qui vident le vivier, c’est la seule chose à dire', () => {
      const m = messageAucunVehicule({ excludedChildSeats: 3 });
      expect(m).toMatch(/^Aucun véhicule libre ne peut recevoir les sièges auto demandés sur ce créneau \(3 véhicule\(s\) écarté\(s\)/);
      expect(m).not.toContain('places ou plus');
    });

    /**
     * Seulement quand le parc n'a AUCUN véhicule assez grand (`largestSeats` 9 < 12). Quand des
     * véhicules assez grands existent, ce sont les sièges qui manquent : le service passe alors
     * `excludedTooSmall: 0` (relecture du 29/09, cf. `contexteAucunVehicule` et
     * reservations.service.spec, « sièges auto avant la taille »).
     */
    it('sièges ET taille : la taille l’emporte (aucun véhicule assez grand, les sièges n’y changent rien)', () => {
      const m = messageAucunVehicule({ ...vivierPour(12), excludedChildSeats: 2 });
      expect(m).toMatch(/^Aucun véhicule de 12 places ou plus/);
      expect(m).not.toContain('sièges auto');
    });

    /**
     * La règle vit désormais DANS le constructeur (raccord du 29/09) : un appelant qui transmettrait
     * les petits véhicules du parc tels quels (le 4 places de Client test pour 5 places demandées) ne
     * fait plus dire « aucun véhicule d'au moins 5 places n'est libre » à 7 véhicules libres à qui il
     * manque un siège bébé.
     */
    it('sièges + petits véhicules dans un parc qui a des véhicules assez grands : les sièges', () => {
      const m = messageAucunVehicule({ ...vivierPour(5), excludedChildSeats: 7 });
      expect(m).toMatch(/^Aucun véhicule libre ne peut recevoir les sièges auto/);
      expect(m).not.toContain("d'au moins 5 places");
    });

    it('la branche sièges garde les notes (places non renseignées, boîtiers muets)', () => {
      const m = messageAucunVehicule({ excludedChildSeats: 2, excludedUnknownCapacity: 1, excludedDormant: 1 });
      expect(m).toMatch(/^Aucun véhicule libre ne peut recevoir les sièges auto/);
      expect(m).toContain('sans nombre de places renseigné');
      expect(m).toContain('boîtier muet');
    });
  });

  describe('`autre: true` — un REMPLAÇANT (réaffectation)', () => {
    it('« Aucun autre véhicule » dans les cas créneau et critères', () => {
      expect(messageAucunVehicule({ ...vivierPour(8), autre: true })).toBe("Aucun autre véhicule d'au moins 8 places n'est libre sur ce créneau.");
      expect(messageAucunVehicule({ minSeats: 4, autre: true })).toBe(
        'Aucun autre véhicule libre ne correspond aux critères sur ce créneau (au moins 4 places).',
      );
      expect(messageAucunVehicule({ excludedChildSeats: 1, autre: true })).toMatch(/^Aucun autre véhicule libre ne peut recevoir les sièges auto/);
    });

    it('le parc n’a pas de véhicule assez grand : la phrase de taille, sans « autre » (aucun, tout court)', () => {
      expect(messageAucunVehicule({ ...vivierPour(12), autre: true })).toBe(
        'Aucun véhicule de 12 places ou plus (conducteur compris) : le plus grand en a 9.',
      );
    });
  });

  it('sans plancher ni exclusion : le message d’origine, inchangé', () => {
    expect(messageAucunVehicule({})).toBe('Aucun véhicule libre ne correspond aux critères sur ce créneau.');
    expect(messageAucunVehicule({ minSeats: 0, excludedTooSmall: 0 })).toBe('Aucun véhicule libre ne correspond aux critères sur ce créneau.');
  });
});
