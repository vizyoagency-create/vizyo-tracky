import {
  SEUIL_ARRET_KMH,
  vitesseMoyenneAgregee,
  TROU_GPS_SEC,
  apportTempsRoulantSec,
  tempsRoulantSec,
  vitesseMoyenneRoulante,
} from './vitesse-moyenne';
import { TripSegmenterService, type SegmenterPosition } from '../trips/trip-segmenter.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UNE SEULE VITESSE MOYENNE — DISTANCE ÷ TEMPS ROULANT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le produit en affichait TROIS pour le même trajet de 47,63 km en 1 h 07, mesuré en
 * production le 2026-09-06 :
 *
 *   liste et carte de trajet   31 km/h   moyenne arithmétique des vitesses des points
 *   récit du replay            53 km/h   distance ÷ temps roulant
 *   synthèse de flotte         42 km/h   distance ÷ durée totale
 *
 * ⚠️ AUCUN TEST NE TENAIT LA PREMIÈRE. La suite est passée au vert intégralement après avoir
 * changé sa définition — c'est précisément ce qui a permis à trois calculs de coexister
 * pendant si longtemps. Ce fichier ferme ce trou.
 */
function p(secOffset: number, speedKmh: number) {
  return { timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, secOffset)), speedKmh };
}

describe('Temps roulant — ce qui compte comme « en train de rouler »', () => {
  it('un intervalle entre deux points en mouvement compte en entier', () => {
    expect(tempsRoulantSec([p(0, 50), p(60, 50)])).toBe(60);
  });

  it('un véhicule immobile ne roule pas, même si le GPS dérive', () => {
    // ⚠️ Le GPS d'un véhicule à l'arrêt n'affiche jamais zéro : il dérive de 1 à 3 km/h.
    // Compter cette dérive rallongerait le temps roulant de TOUS les arrêts et écraserait la
    // moyenne — le défaut même que ce lot répare.
    expect(tempsRoulantSec([p(0, 3), p(60, 2), p(120, 1)])).toBe(0);
    expect(SEUIL_ARRET_KMH).toBe(4);
  });

  it('un freinage jusqu’à l’arrêt reste du roulage', () => {
    // Une seule des deux bornes suffit : n'accepter que les intervalles dont les DEUX bornes
    // bougent retrancherait une seconde sur deux en ville.
    expect(tempsRoulantSec([p(0, 50), p(30, 0)])).toBe(30);
    expect(tempsRoulantSec([p(0, 0), p(30, 50)])).toBe(30);
  });

  it('un trou de signal n’est ni du roulage ni un arrêt', () => {
    // Deux heures sans position ne doivent pas devenir deux heures de conduite. On ne sait
    // pas, donc on ne compte rien.
    expect(tempsRoulantSec([p(0, 90), p(TROU_GPS_SEC + 1, 90)])).toBe(0);
    // Juste en dessous du seuil, en revanche, l'intervalle compte.
    expect(tempsRoulantSec([p(0, 90), p(TROU_GPS_SEC, 90)])).toBe(TROU_GPS_SEC);
  });

  it('un horodatage qui recule est ignoré, jamais soustrait', () => {
    // Sur une trace désordonnée, mieux vaut un temps roulant trop court — donc une moyenne
    // prudente — qu'un temps négatif qui rendrait la division absurde.
    expect(tempsRoulantSec([p(60, 50), p(0, 50)])).toBe(0);
  });

  it('la forme incrémentale rend EXACTEMENT la même chose que la forme par lot', () => {
    // ⚠️ Les deux existent parce que le trajet en direct reçoit ses positions une par une.
    // Si elles divergeaient, fermer un trajet en direct et le recalculer par lot donneraient
    // deux moyennes différentes pour le même trajet, sans que rien ne l'explique.
    const trace = [p(0, 0), p(20, 12), p(50, 80), p(400, 80), p(430, 3), p(500, 60)];
    let cumul = 0;
    for (let i = 1; i < trace.length; i++) cumul += apportTempsRoulantSec(trace[i - 1]!, trace[i]!);

    expect(cumul).toBe(tempsRoulantSec(trace));
  });
});

describe('Vitesse moyenne — la division, et son refus', () => {
  it('distance ÷ temps roulant, au centième', () => {
    expect(vitesseMoyenneRoulante(47.63, 3256)).toBe(52.66);
  });

  it('sans temps roulant : zéro, et surtout pas un repli sur la durée totale', () => {
    // Un repli fabriquerait un quatrième chiffre, incomparable aux trois autres — ce que ce
    // module existe pour empêcher.
    expect(vitesseMoyenneRoulante(12, 0)).toBe(0);
    expect(vitesseMoyenneRoulante(0, 600)).toBe(0);
  });
});

/**
 * ══ LE SEGMENTEUR ÉCRIT BIEN CETTE DÉFINITION-LÀ ═══════════════════════════════════════
 *
 * C'est lui qui remplit `Trip.avgSpeed` pour les trajets reconstitués par lot. Il calculait
 * `somme des vitesses ÷ nombre de points`, ce qui pondère chaque relevé pareil quelle que
 * soit sa durée : le chiffre dépendait de la cadence du boîtier, pas de la conduite.
 */
describe('TripSegmenterService — la vitesse moyenne ne dépend plus de la cadence du boîtier', () => {
  const segmenter = new TripSegmenterService();

  /**
   * Une position : instant (minutes, décimal) ET point kilométrique (index de pas de 0,01°
   * de latitude), donnés SÉPARÉMENT.
   *
   * ⚠️ LES DEUX NE SE DÉDUISENT PAS L'UN DE L'AUTRE, et une première version les avait
   * confondus : la latitude suivait l'horloge, si bien qu'un véhicule « à l'arrêt » avançait
   * quand même d'un kilomètre par minute. Le test échouait alors pour un défaut qui n'existait
   * que dans son propre décor.
   */
  const pos = (minute: number, pk: number, speedKmh: number): SegmenterPosition => ({
    lat: 33.57 + pk * 0.01,
    lng: -7.59,
    speedKmh,
    timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, Math.round(minute * 60))),
  });

  it('un arrêt au milieu du trajet ne tire PLUS la moyenne vers le bas', () => {
    // On roule trois minutes, on s'arrête quatre minutes SANS bouger, on repart trois minutes.
    // L'ancienne formule comptait les points d'arrêt comme des relevés à 0 km/h.
    // ⚠️ 70 km/h ANNONCÉS pour un pas de 0,01° par minute, qui vaut 66,7 km/h réels : la
    // vitesse déclarée doit couvrir le déplacement, sinon la garde de plausibilité se
    // déclenche — à juste titre — et le test mesure la garde au lieu de la moyenne.
    const positions = [
      pos(0, 0, 70), pos(1, 1, 70), pos(2, 2, 70),
      pos(3, 3, 0), pos(4, 3, 0), pos(5, 3, 0), pos(6, 3, 0),
      pos(7, 4, 70), pos(8, 5, 70), pos(9, 6, 70),
      pos(10, 7, 0), pos(15, 7, 0), pos(20, 7, 0),
    ];
    const t = segmenter.segmentPositions(positions)[0]!;

    // Le temps roulant exclut les quatre minutes d'arrêt…
    expect(t.movingSeconds).toBeLessThan(t.durationSeconds);
    expect(t.movingSeconds).toBeGreaterThan(0);
    // … et la moyenne est exactement la division, pas une moyenne de relevés.
    expect(t.avgSpeed).toBe(vitesseMoyenneRoulante(t.distanceMeters / 1000, t.movingSeconds));
    // L'ancienne formule (somme des vitesses ÷ nombre de points) aurait rendu bien moins.
    const ancienne = positions.reduce((s, x) => s + x.speedKmh, 0) / positions.length;
    expect(t.avgSpeed).toBeGreaterThan(ancienne);
  });

  it('deux boîtiers de cadences différentes sur le même trajet rendent la même moyenne', () => {
    // ⚠️ LE CŒUR DU DÉFAUT, isolé : MÊMES points de roulage de part et d'autre, et seulement
    // des relevés d'ARRÊT en plus dans le second. La conduite est identique au mètre près.
    //
    // Sous l'ancienne formule, ces relevés supplémentaires à 0 km/h entraient au dénominateur
    // comme les autres et écrasaient la moyenne : deux boîtiers, deux chiffres, une seule
    // conduite. La distance et le temps roulant, eux, n'en dépendent pas.
    //
    // (On ne fait pas varier la cadence de ROULAGE : elle déplacerait le dernier point mobile,
    // donc la fin du trajet elle-même — une différence réelle de segmentation, pas de calcul.)
    const roulage = [pos(0, 0, 80), pos(1, 1, 80), pos(2, 2, 80)];
    const rare = [...roulage, pos(3, 3, 0), pos(8, 3, 0), pos(13, 3, 0)];
    const dense = [
      ...roulage,
      pos(3, 3, 0), pos(3.5, 3, 0), pos(4, 3, 0), pos(4.5, 3, 0), pos(5, 3, 0),
      pos(8, 3, 0), pos(13, 3, 0),
    ];

    const a = segmenter.segmentPositions(rare)[0]!;
    const b = segmenter.segmentPositions(dense)[0]!;

    expect(a.movingSeconds).toBe(b.movingSeconds);
    expect(Math.round(a.avgSpeed)).toBe(Math.round(b.avgSpeed));
  });

  it('un temps roulant IMPOSSIBLE retombe sur la durée : la garde de plausibilité', () => {
    /**
     * ⚠️ CE CAS A ARRÊTÉ LA REPRISE DE DONNÉES EN PRODUCTION. Un trajet de 23,98 km n'avait
     * que 302 secondes de roulage OBSERVÉ — le boîtier s'était tu pendant la conduite — et la
     * division annonçait 286 km/h pour un véhicule dont la pointe mesurée était de 72. La
     * contrainte `trips_avg_speed_in_range` a refusé l'écriture, ce qui est son rôle.
     *
     * La garde ne compare à aucune vitesse « raisonnable » : couvrir 23,98 km à 72 km/h
     * demande 1 191 s au minimum, donc 302 s est prouvé incomplet.
     */
    const trace = [
      pos(0, 0, 70), pos(1, 1, 70), pos(2, 2, 70),
      // Six minutes de silence, puis on réapparaît neuf kilomètres plus loin : l'intervalle
      // dépasse le trou de signal, sa distance est comptée mais pas ses secondes.
      pos(8, 10, 70), pos(9, 11, 70),
      pos(10, 12, 0), pos(15, 12, 0), pos(20, 12, 0),
    ];
    const t = segmenter.segmentPositions(trace)[0]!;

    expect(t.movingSeconds).toBeLessThan(t.durationSeconds);
    // Sans la garde, la division rendrait une vitesse supérieure à la pointe du trajet.
    expect(vitesseMoyenneRoulante(t.distanceMeters / 1000, t.movingSeconds)).toBeGreaterThan(t.maxSpeed);
    // Avec elle, la moyenne reste sous la pointe — la seule borne dont on soit sûr.
    expect(t.avgSpeed).toBeLessThanOrEqual(t.maxSpeed);
    expect(t.avgSpeed).toBeGreaterThan(0);
  });
});

/**
 * ══ UN ENSEMBLE DE TRAJETS — LA MÊME DIVISION, JAMAIS UNE MOYENNE DE MOYENNES ═══════════
 *
 * C'est la fonction que le PDF (synthèse, top véhicules, récapitulatif par conducteur) et
 * l'Excel appellent tous les deux. Tant qu'elle était recopiée de part et d'autre, le même
 * véhicule sortait à 45,1 km/h dans l'un et 39,3 dans l'autre.
 */
describe('Vitesse moyenne agrégée — flotte, véhicule, conducteur', () => {
  it('Σ km ÷ Σ temps roulant, et pas la moyenne des moyennes', () => {
    // Deux trajets : 180 km à 90 km/h (2 h roulantes) et 0,4 km à 8 km/h (3 min roulantes).
    // La moyenne des moyennes rendrait 49 ; la bonne réponse est 89.
    const ensemble = { distanceKm: 180.4, durationSeconds: 9000, movingSeconds: 7380 };

    expect(vitesseMoyenneAgregee(ensemble)).toBe(88);
    expect(vitesseMoyenneAgregee(ensemble)).not.toBe(Math.round((90 + 8) / 2));
  });

  it('sans temps roulant connu, la durée totale — jamais zéro', () => {
    // ⚠️ Un cinquième de la base n'a ni analyse ni positions : afficher 0 km/h sous des
    // centaines de kilomètres bien réels ferait douter des chiffres voisins, qui sont justes.
    expect(vitesseMoyenneAgregee({ distanceKm: 100, durationSeconds: 7200, movingSeconds: 0 })).toBe(50);
  });

  it('ni distance ni durée : rien à diviser', () => {
    expect(vitesseMoyenneAgregee({ distanceKm: 0, durationSeconds: 7200, movingSeconds: 3600 })).toBe(0);
    expect(vitesseMoyenneAgregee({ distanceKm: 10, durationSeconds: 0, movingSeconds: 0 })).toBe(0);
  });
});

