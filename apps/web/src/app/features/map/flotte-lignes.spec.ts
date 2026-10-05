import {
  compteursFlotte,
  construireLignesFlotte,
  filtrerFlotte,
  type EntreeFlotte,
} from './flotte-lignes';

const MAINTENANT = new Date('2026-08-12T12:00:00.000Z').getTime();
const ilYA = (ms: number) => new Date(MAINTENANT - ms).toISOString();
const MINUTE = 60_000;
const JOUR = 24 * 60 * MINUTE;

function vehicule(p: Partial<EntreeFlotte> = {}): EntreeFlotte {
  return {
    vehicleId: 'v1',
    plate: 'AA-111-BB',
    brand: 'Renault',
    model: 'Clio',
    trackerId: 't1',
    lastSeenAt: ilYA(30_000),
    lastPositionAt: ilYA(30_000),
    lastSpeedKmh: 0,
    lastIgnition: true,
    ...p,
  };
}

describe('construireLignesFlotte', () => {
  it('affiche la vitesse en direct d’un véhicule en ligne', () => {
    const [l] = construireLignesFlotte([vehicule()], () => 72, MAINTENANT);
    expect(l.etat).toBe('route');
    expect(l.vitesse).toBe(72);
  });

  it('classe à l’arrêt un véhicule en ligne à 0 km/h', () => {
    const [l] = construireLignesFlotte([vehicule()], () => 0, MAINTENANT);
    expect(l.etat).toBe('arret');
    expect(l.vitesse).toBe(0);
  });

  // ⚠️ Le test qui protège de l'incident FS-253.
  it('N’AFFICHE PAS la vitesse d’un boîtier hors ligne, même si la dernière trame la portait', () => {
    const gare = vehicule({
      lastSeenAt: ilYA(5 * JOUR),
      lastPositionAt: ilYA(5 * JOUR),
      lastSpeedKmh: 88,
      lastIgnition: true,
    });
    const [l] = construireLignesFlotte([gare], () => 88, MAINTENANT);
    expect(l.etat).toBe('hors-ligne');
    expect(l.vitesse).toBeNull();
  });

  it('ne prend pas la vitesse en direct d’un tracker hors ligne', () => {
    const muet = vehicule({ lastSeenAt: ilYA(5 * JOUR), lastPositionAt: ilYA(5 * JOUR) });
    const [l] = construireLignesFlotte([muet], () => 120, MAINTENANT);
    expect(l.vitesse).toBeNull();
  });

  it('traite un véhicule sans boîtier comme hors ligne, pas comme à l’arrêt', () => {
    const sansBoitier = vehicule({ trackerId: null, lastSeenAt: null, lastPositionAt: null });
    const [l] = construireLignesFlotte([sansBoitier], () => undefined, MAINTENANT);
    expect(l.etat).toBe('hors-ligne');
    expect(l.connectivite).toBe('NOT_CONFIGURED');
  });

  it('replie sur un libellé explicite quand marque et modèle manquent', () => {
    const [l] = construireLignesFlotte(
      [vehicule({ brand: null, model: null })],
      () => 0,
      MAINTENANT,
    );
    expect(l.modele).toBe('Modèle non renseigné');
  });

  it('ordonne en route, puis arrêt, puis hors ligne, et alphabétiquement à égalité', () => {
    const lignes = construireLignesFlotte(
      [
        vehicule({ vehicleId: 'c', plate: 'CC-333-CC', lastSeenAt: ilYA(5 * JOUR), lastPositionAt: ilYA(5 * JOUR) }),
        vehicule({ vehicleId: 'b', plate: 'BB-222-BB' }),
        vehicule({ vehicleId: 'a', plate: 'AA-111-AA' }),
      ],
      (t) => (t === 't1' ? 0 : 0),
      MAINTENANT,
    );
    expect(lignes.map((l) => l.plate)).toEqual(['AA-111-AA', 'BB-222-BB', 'CC-333-CC']);
    expect(lignes.map((l) => l.etat)).toEqual(['arret', 'arret', 'hors-ligne']);
  });

  /**
   * Boîtier DÉBRANCHÉ déclaré sur la fiche (05/10/2026) : la ligne le dit, comme le marqueur
   * barré de la carte — et la déclaration prime sur une trame qui arriverait encore.
   */
  describe('boîtier débranché déclaré', () => {
    it('est rangé hors ligne et le dit (DZ-034-CA, muet depuis août)', () => {
      const [l] = construireLignesFlotte(
        [vehicule({ plate: 'DZ-034-CA', outOfServiceReason: 'TRACKER_UNPLUGGED', lastSeenAt: ilYA(45 * JOUR), lastPositionAt: ilYA(45 * JOUR) })],
        () => 0,
        MAINTENANT,
      );
      expect(l.debranche).toBeTrue();
      expect(l.etat).toBe('hors-ligne');
      expect(l.vitesse).toBeNull();
    });

    it('🔴 n’affiche pas de vitesse même si le boîtier émet encore (fiche pas remise à jour)', () => {
      const [l] = construireLignesFlotte([vehicule({ outOfServiceReason: 'TRACKER_UNPLUGGED' })], () => 72, MAINTENANT);
      expect(l.debranche).toBeTrue();
      expect(l.etat).toBe('hors-ligne');
      expect(l.vitesse).toBeNull();
    });

    it('ne touche pas aux autres motifs de hors service ni aux véhicules en service', () => {
      const lignes = construireLignesFlotte(
        [
          vehicule({ vehicleId: 'a', plate: 'AA-111-AA', outOfServiceReason: 'IMMOBILIZED' }),
          vehicule({ vehicleId: 'b', plate: 'BB-222-BB', outOfServiceReason: null }),
        ],
        () => 30,
        MAINTENANT,
      );
      expect(lignes.map((l) => l.debranche)).toEqual([false, false]);
      expect(lignes.map((l) => l.etat)).toEqual(['route', 'route']);
    });
  });

  /** Immobilisé déclaré (06/10/2026) : la ligne le dit, son rangement reste celui que mesure le boîtier. */
  describe('véhicule immobilisé déclaré', () => {
    it('est marqué immobilisé et garde l’état mesuré (au garage, le boîtier peut émettre)', () => {
      const [l] = construireLignesFlotte([vehicule({ plate: 'HD-998-XY', outOfServiceReason: 'IMMOBILIZED' })], () => 0, MAINTENANT);
      expect(l.immobilise).toBeTrue();
      expect(l.debranche).toBeFalse();
      expect(l.etat).toBe('arret');
    });

    it('n’est pas marqué immobilisé quand il est débranché (une seule déclaration)', () => {
      const [l] = construireLignesFlotte([vehicule({ outOfServiceReason: 'TRACKER_UNPLUGGED' })], () => 0, MAINTENANT);
      expect(l.debranche).toBeTrue();
      expect(l.immobilise).toBeFalse();
    });
  });
});

describe('compteursFlotte et filtrerFlotte', () => {
  const lignes = construireLignesFlotte(
    [
      vehicule({ vehicleId: 'a', plate: 'AA-111-AA' }),
      vehicule({ vehicleId: 'b', plate: 'BB-222-BB', lastSeenAt: ilYA(5 * JOUR), lastPositionAt: ilYA(5 * JOUR) }),
    ],
    () => 0,
    MAINTENANT,
  );

  it('compte sur la liste entière', () => {
    const c = compteursFlotte(lignes);
    expect(c.tous).toBe(2);
    expect(c.arret).toBe(1);
    expect(c['hors-ligne']).toBe(1);
    expect(c.route).toBe(0);
  });

  it('la somme des trois états redonne le total', () => {
    const c = compteursFlotte(lignes);
    expect(c.route + c.arret + c['hors-ligne']).toBe(c.tous);
  });

  it('« tous » ne filtre rien', () => {
    expect(filtrerFlotte(lignes, 'tous').length).toBe(lignes.length);
  });

  it('un filtre sans résultat renvoie une liste vide, pas la liste entière', () => {
    expect(filtrerFlotte(lignes, 'route')).toEqual([]);
  });
});
