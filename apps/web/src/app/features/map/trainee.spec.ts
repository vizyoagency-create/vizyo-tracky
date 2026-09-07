import {
  ETAT_TRAINEE_VIDE,
  TRAINEE_ARRET_MS,
  mettreAJourTrainee,
  vehiculeRoule,
  type EtatTrainee,
  type TrameTrainee,
} from './trainee';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA TRAÎNÉE SUIT CEUX QUI ROULENT, ET S'EFFACE DERRIÈRE CEUX QUI SONT À L'ARRÊT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Demande du propriétaire (2026-09-07) : deux ou trois traînées pour ceux qui roulent, aucune
 * pour ceux à l'arrêt depuis trois minutes.
 *
 * Ce que la base de production a montré le même jour (90 dernières minutes) : un véhicule
 * qui roule émet toutes les 10 à 16 s ; un véhicule à l'arrêt émet toutes les 2 à 6 min, avec
 * un bruit GPS de 100 à 240 m entre deux trames. L'ancienne règle n'ajoutait un point que si
 * les coordonnées changeaient EXACTEMENT — donc chaque trame bruitée d'un véhicule immobile
 * allongeait sa traînée, et rien ne l'effaçait jamais.
 *
 * ⚠️ AUCUNE DÉPENDANCE AU CONTACT, par construction : six véhicules sur trente n'ont pas de
 * fil ACC raccordé et leur `ignition` vaut `false` en permanence. Seul le GPS décide ici —
 * la vitesse annoncée, ou celle déduite du déplacement.
 */
const T0 = 1_700_000_000_000;
const trame = (over: Partial<TrameTrainee> & { i: number }): TrameTrainee => ({
  lng: 1.43 + over.i * 0.001,
  lat: 43.6,
  horodatage: `2026-09-07T10:00:${String(over.i).padStart(2, '0')}Z`,
  vitesseRapporteeKmh: 40,
  vitesseDeriveeKmh: 40,
  nowMs: T0 + over.i * 15_000,
  ...over,
});

/** Un bruit GPS de ~60 m : 0,00054° de latitude à cette latitude. */
const BRUIT_DEG = 0.00054;

describe('vehiculeRoule — le GPS seul décide, jamais le contact', () => {
  it('une vitesse annoncée au-dessus du bruit prouve le mouvement', () => {
    expect(vehiculeRoule(12, 0)).toBeTrue();
  });

  it('un Coban qui annonce 0 en roulant est rattrapé par la vitesse déduite du déplacement', () => {
    expect(vehiculeRoule(0, 25)).toBeTrue();
  });

  it('🔴 à l’arrêt, le bruit GPS donne une vitesse déduite de 3 km/h : ce n’est PAS rouler', () => {
    expect(vehiculeRoule(0, 3)).toBeFalse();
    expect(vehiculeRoule(null, undefined)).toBeFalse();
  });
});

describe('mettreAJourTrainee', () => {
  it('un véhicule qui roule accumule ses points, plafonnés à la longueur demandée', () => {
    let etat: EtatTrainee = ETAT_TRAINEE_VIDE;
    for (let i = 0; i < 6; i++) etat = mettreAJourTrainee(etat, trame({ i }), 4);

    expect(etat.points.length).toBe(4);
    expect(etat.points[3]).toEqual([1.43 + 5 * 0.001, 43.6]);
    expect(etat.dernierMouvementMs).toBe(T0 + 5 * 15_000);
  });

  it('🔴 une trame à l’arrêt décalée par le bruit GPS n’ajoute AUCUN point', () => {
    let etat: EtatTrainee = ETAT_TRAINEE_VIDE;
    etat = mettreAJourTrainee(etat, trame({ i: 0 }), 4);
    etat = mettreAJourTrainee(etat, trame({ i: 1 }), 4);
    const avant = etat.points.length;

    etat = mettreAJourTrainee(etat, trame({
      i: 2, lat: 43.6 + BRUIT_DEG, vitesseRapporteeKmh: 0, vitesseDeriveeKmh: 3,
    }), 4);

    expect(etat.points.length).toBe(avant);
  });

  it('🔴 un véhicule immobile depuis trois minutes n’a plus de traînée', () => {
    let etat: EtatTrainee = ETAT_TRAINEE_VIDE;
    etat = mettreAJourTrainee(etat, trame({ i: 0 }), 4);
    etat = mettreAJourTrainee(etat, trame({ i: 1 }), 4);
    expect(etat.points.length).toBe(2);

    // Deux minutes plus tard, une trame à l'arrêt : la traînée tient encore.
    const arret1 = trame({ i: 2, vitesseRapporteeKmh: 0, vitesseDeriveeKmh: 0, nowMs: T0 + 15_000 + 2 * 60_000 });
    etat = mettreAJourTrainee(etat, arret1, 4);
    expect(etat.points.length).toBe(2);

    // Trois minutes après le dernier mouvement : effacée.
    const arret2 = trame({ i: 3, vitesseRapporteeKmh: 0, vitesseDeriveeKmh: 0, nowMs: T0 + 15_000 + TRAINEE_ARRET_MS });
    etat = mettreAJourTrainee(etat, arret2, 4);
    expect(etat.points).toEqual([]);
  });

  /**
   * ⚠️ `applyPositions` rejoue la DERNIÈRE trame de chaque véhicule à chaque rafraîchissement,
   * même quand rien de neuf n'est arrivé pour lui. Une trame qui disait « 40 km/h » il y a dix
   * minutes ne prouve pas qu'il roule maintenant : un véhicule entré dans un tunnel garderait
   * sa traînée pour toujours.
   */
  it('🔴 la même trame rejouée n’est pas une preuve de mouvement : la traînée s’efface quand même', () => {
    let etat: EtatTrainee = ETAT_TRAINEE_VIDE;
    etat = mettreAJourTrainee(etat, trame({ i: 0 }), 4);
    const derniere = trame({ i: 1 });
    etat = mettreAJourTrainee(etat, derniere, 4);

    // Rejouée pendant quatre minutes, sans trame neuve.
    for (let k = 1; k <= 16; k++) {
      etat = mettreAJourTrainee(etat, { ...derniere, nowMs: derniere.nowMs + k * 15_000 }, 4);
    }

    expect(etat.points).toEqual([]);
  });

  it('après un arrêt effacé, la traînée repart de zéro au premier mouvement', () => {
    let etat: EtatTrainee = ETAT_TRAINEE_VIDE;
    etat = mettreAJourTrainee(etat, trame({ i: 0 }), 4);
    etat = mettreAJourTrainee(etat, trame({ i: 1 }), 4);
    etat = mettreAJourTrainee(etat, trame({ i: 2, vitesseRapporteeKmh: 0, vitesseDeriveeKmh: 0, nowMs: T0 + 15_000 + TRAINEE_ARRET_MS }), 4);
    expect(etat.points).toEqual([]);

    etat = mettreAJourTrainee(etat, trame({ i: 3, nowMs: T0 + 15_000 + TRAINEE_ARRET_MS + 15_000 }), 4);
    expect(etat.points).toEqual([[1.43 + 3 * 0.001, 43.6]]);
  });
});
