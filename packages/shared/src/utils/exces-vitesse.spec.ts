/**
 * Lot V7 — « CECI EST-IL UN EXCÈS ? », posé une seule fois.
 *
 * Quatre réponses coexistaient. Le rapport de vitesse — pièce disciplinaire — comptait ses
 * excès au-dessus d'un seuil fixe de 90 km/h sans jamais consulter la limite de la voie : un
 * trajet entier sur une voie à 110 y affichait des dizaines d'« excès », et 80 km/h dans une
 * zone 50 n'en produisait aucun.
 *
 * Ces tests protègent la règle unique, et surtout son ARITHMÉTIQUE : le nombre d'excès d'un
 * trajet doit être le même quel que soit l'écran qui le demande.
 */
import {
  EXCES_DUREE_MIN_SEC,
  TOLERANCE_EXCES_KMH,
  ecartCredible,
  estEnExces,
  excesContenant,
  excesDuTrajet,
  excesEtabli,
  resumeExces,
} from './exces-vitesse';
import type { SpeedingSegmentDto } from '../dto/trip-analysis.dto';

const seg = (p: Partial<SpeedingSegmentDto> = {}): SpeedingSegmentDto => ({
  startAt: '2026-09-04T12:00:00.000Z',
  endAt: '2026-09-04T12:00:40.000Z',
  durationSec: 40,
  maxSpeedKmh: 125, limitKmh: 90, overKmh: 35,
  lat: 43.6, lng: 1.4,
  ...p,
});

describe('estEnExces — la limite de la VOIE, jamais un seuil fixe', () => {
  it('80 km/h dans une zone 50 est un excès ; l’ancien seuil de 90 n’en voyait aucun', () => {
    expect(estEnExces(50, 80)).toBe(true);
  });

  it('100 km/h sur une voie à 110 n’est pas un excès ; l’ancien seuil de 90 en voyait un', () => {
    expect(estEnExces(110, 100)).toBe(false);
  });

  it('applique la tolérance, et pas un chiffre rond de plus', () => {
    expect(estEnExces(90, 90 + TOLERANCE_EXCES_KMH)).toBe(false);
    expect(estEnExces(90, 90 + TOLERANCE_EXCES_KMH + 0.1)).toBe(true);
  });

  it('ne SAIT pas n’est pas une innocence, mais ce n’est pas un fait non plus', () => {
    expect(estEnExces(null, 180)).toBe(false);
    expect(estEnExces(undefined, 180)).toBe(false);
    expect(estEnExces(Number.NaN, 180)).toBe(false);
  });
});

describe('ecartCredible — un dépassement énorme sur une voie lente est un rattachement raté', () => {
  it('refuse 102 km/h sur une voie à 30 — le point est sur le pont, pas dans la rue', () => {
    expect(ecartCredible(30, 102)).toBe(false);
  });

  it('accepte un gros écart sur une voie rapide, où il reste plausible', () => {
    expect(ecartCredible(90, 150)).toBe(true);
    expect(ecartCredible(110, 168)).toBe(true);
  });

  it('accepte un écart modéré sur une voie lente', () => {
    expect(ecartCredible(50, 85)).toBe(true);
  });
});

describe('excesEtabli — un point isolé ne prouve rien', () => {
  it('refuse un segment de durée nulle', () => {
    expect(excesEtabli({ durationSec: 0 })).toBe(false);
  });

  it('accepte dès que le dépassement a été vu deux fois', () => {
    expect(excesEtabli({ durationSec: EXCES_DUREE_MIN_SEC })).toBe(true);
  });
});

describe('resumeExces — LE compte, celui que tous les écrans doivent lire', () => {
  it('compte, cumule la durée, et désigne le pire', () => {
    const r = resumeExces([seg({ overKmh: 12, durationSec: 30 }), seg({ overKmh: 58, durationSec: 45 }), seg({ overKmh: 20, durationSec: 10 })]);
    expect(r.nombre).toBe(3);
    expect(r.dureeSec).toBe(85);
    expect(r.pire?.overKmh).toBe(58);
  });

  it('à dépassement égal, le pire est le plus long', () => {
    const r = resumeExces([seg({ overKmh: 30, durationSec: 10 }), seg({ overKmh: 30, durationSec: 120 })]);
    expect(r.pire?.durationSec).toBe(120);
  });

  it('⚠️ écarte les segments de durée nulle des analyses ANCIENNES', () => {
    // Avant le lot V2, une position aberrante produisait un « excès confirmé » de durée nulle.
    // Les compter ferait dire au rapport disciplinaire ce que l'analyse a cessé d'affirmer.
    const r = resumeExces([seg({ durationSec: 0, overKmh: 72 }), seg({ durationSec: 40, overKmh: 12 })]);
    expect(r.nombre).toBe(1);
    expect(r.pire?.overKmh).toBe(12);
  });

  it('rend un compte nul, jamais une exception, sur une analyse absente', () => {
    expect(resumeExces(null)).toEqual({ nombre: 0, dureeSec: 0, pire: null });
    expect(resumeExces(undefined).nombre).toBe(0);
    expect(resumeExces([]).nombre).toBe(0);
  });
});

describe('excesContenant — situer une mesure dans un excès établi', () => {
  const segments = [seg({ startAt: '2026-09-04T12:00:00.000Z', endAt: '2026-09-04T12:00:40.000Z', limitKmh: 90 })];

  it('reconnaît une mesure prise pendant l’excès, avec SA limite', () => {
    expect(excesContenant(segments, '2026-09-04T12:00:20.000Z')?.limitKmh).toBe(90);
    // Bornes incluses : la première et la dernière mesure font partie de l'excès.
    expect(excesContenant(segments, '2026-09-04T12:00:00.000Z')).not.toBeNull();
    expect(excesContenant(segments, '2026-09-04T12:00:40.000Z')).not.toBeNull();
  });

  it('rejette une mesure hors de la fenêtre', () => {
    expect(excesContenant(segments, '2026-09-04T11:59:59.000Z')).toBeNull();
    expect(excesContenant(segments, '2026-09-04T12:00:41.000Z')).toBeNull();
  });

  it('ignore un segment non établi, même si la mesure y tombe', () => {
    const zero = [seg({ durationSec: 0, startAt: '2026-09-04T12:00:00.000Z', endAt: '2026-09-04T12:00:00.000Z' })];
    expect(excesContenant(zero, '2026-09-04T12:00:00.000Z')).toBeNull();
  });

  it('ne jette pas sur une date illisible ni sur une liste absente', () => {
    expect(excesContenant(segments, 'pas une date')).toBeNull();
    expect(excesContenant(null, '2026-09-04T12:00:20.000Z')).toBeNull();
  });
});

describe('excesDuTrajet — le détail fait foi, le compteur est le repli', () => {
  it('préfère le détail au compteur écrit à l’époque', () => {
    // Analyse antérieure au lot V2 : le compteur retient un segment de durée nulle que la
    // règle actuelle écarte. L'écran doit dire ce que la règle dit AUJOURD'HUI.
    const r = excesDuTrajet({ speedingCount: 3, detail: { speeding: [seg({ durationSec: 0 }), seg(), seg()] } });
    expect(r.nombre).toBe(2);
  });

  it('retombe sur le compteur quand le détail n’a pas été chargé', () => {
    expect(excesDuTrajet({ speedingCount: 4 }).nombre).toBe(4);
    expect(excesDuTrajet({ speedingCount: 4, detail: null }).nombre).toBe(4);
  });

  it('ne jette pas sur une analyse absente', () => {
    expect(excesDuTrajet(null).nombre).toBe(0);
    expect(excesDuTrajet(undefined).nombre).toBe(0);
    expect(excesDuTrajet({}).nombre).toBe(0);
  });
});

describe('⚠️ RECETTE DU LOT — un trajet, un seul nombre d’excès', () => {
  /**
   * Le trajet de référence : deux excès établis contre la limite légale, plus une pointe non
   * établie. L'ancien rapport de vitesse comptait des POSITIONS au-dessus de 90 ; le replay
   * comptait des SEGMENTS contre la limite de la voie. Deux écrans, deux réponses.
   */
  const trajet = [
    seg({ startAt: '2026-09-04T12:00:00.000Z', endAt: '2026-09-04T12:00:40.000Z', durationSec: 40, limitKmh: 90, maxSpeedKmh: 125, overKmh: 35 }),
    seg({ startAt: '2026-09-04T12:10:00.000Z', endAt: '2026-09-04T12:10:20.000Z', durationSec: 20, limitKmh: 50, maxSpeedKmh: 78, overKmh: 28 }),
    seg({ startAt: '2026-09-04T12:20:00.000Z', endAt: '2026-09-04T12:20:00.000Z', durationSec: 0, limitKmh: 110, maxSpeedKmh: 168, overKmh: 58 }),
  ];

  it('le replay, le rapport et le PDF lisent le même 2', () => {
    // Une seule fonction, donc une seule réponse : c'est la garantie structurelle du lot.
    expect(resumeExces(trajet).nombre).toBe(2);
    // Et l'écran, qui part de l'analyse entière, lit exactement le même chiffre — même quand
    // le compteur stocké dit autre chose, comme sur les analyses antérieures au lot V2.
    expect(excesDuTrajet({ speedingCount: 3, detail: { speeding: trajet } }).nombre).toBe(2);
  });

  it('le trajet en ville à 78 dans une zone 50 COMPTE, ce que le seuil fixe ratait', () => {
    const ville = resumeExces([trajet[1]!]);
    expect(ville.nombre).toBe(1);
    expect(ville.pire?.limitKmh).toBe(50);
    // Sous l'ancienne règle, 78 km/h ne dépassait pas 90 : aucun excès n'était rapporté.
    expect(78 > 90).toBe(false);
  });

  it('le trajet sur voie rapide à 100 ne compte PAS, ce que le seuil fixe inventait', () => {
    expect(estEnExces(110, 100)).toBe(false);
    expect(100 > 90).toBe(true); // l'ancienne règle, elle, y voyait un excès
  });
});
