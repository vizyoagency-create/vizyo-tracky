/**
 * LES ZONES LES PLUS LENTES — l'angle mort du seuil de candidature (2026-09-04).
 *
 * Une limite n'était demandée qu'au-dessus de 33 km/h, seuil choisi pour couvrir les zones 30
 * avec marge. Conséquence jamais mesurée : en zone 20, un excès commence à 25 km/h, et sur une
 * voie à 10 il commence à 15. Un véhicule à 30 km/h dans une rue à 20 dépassait donc la limite de
 * dix kilomètres-heure sans qu'aucune limite ne soit seulement DEMANDÉE. Ces rues sont
 * précisément celles où l'on croise des piétons.
 *
 * Ces tests protègent les deux moitiés de la correction : l'excès lent est détecté quand la
 * limite est connue, et il ne coûte AUCUNE requête cartographique supplémentaire.
 */
import { analyzeTrip, EXCES_CANDIDAT_LENT_KMH, SPEEDING_CANDIDATE_KMH, type RawPosition } from './trip-analysis.preprocessor';

/** ~111 320 m par degré de latitude. */
function nord(lat: number, metres: number): number {
  return lat + metres / 111_320;
}

/** Trajet cohérent : le déplacement colle à la vitesse annoncée (garde-fou de corroboration). */
function trajet(vitesses: number[], pasSec = 20): RawPosition[] {
  let lat = 43.6;
  return vitesses.map((v, i) => {
    const p: RawPosition = {
      lat, lng: 1.4, speedKmh: v,
      timestamp: new Date(Date.UTC(2026, 8, 4, 10, 0, i * pasSec)),
      valid: true, ignition: true,
    };
    lat = nord(lat, (v / 3.6) * pasSec);
    return p;
  });
}

describe('Les seuils de candidature, et ce qu’ils laissent passer', () => {
  it('le palier lent couvre la plus basse limite portée par la carte', () => {
    // Sur une voie à 10, un excès commence à 15 : le palier doit être à 15 ou en dessous.
    expect(EXCES_CANDIDAT_LENT_KMH).toBeLessThanOrEqual(10 + 5);
    // Et il reste sous le palier rapide, sinon il ne servirait à rien.
    expect(EXCES_CANDIDAT_LENT_KMH).toBeLessThan(SPEEDING_CANDIDATE_KMH);
  });
});

describe('Un excès en zone 20, désormais vu', () => {
  it('30 km/h dans une rue à 20 est un excès établi', () => {
    const r = analyzeTrip(trajet([30, 31, 30, 29]), {}, () => 20);

    expect(r.speedingCount).toBe(1);
    expect(r.detail.speeding[0]).toMatchObject({ limitKmh: 20, maxSpeedKmh: 31, overKmh: 11 });
  });

  it('22 km/h dans la même rue reste dans la tolérance — on n’invente pas une faute', () => {
    // 20 + 5 de tolérance = 25 : en dessous, affirmer un dépassement reviendrait à opposer à
    // quelqu'un l'imprécision de notre propre instrument.
    const r = analyzeTrip(trajet([22, 23, 22]), {}, () => 20);
    expect(r.speedingCount).toBe(0);
  });

  it('18 km/h sur une voie à 10 est un excès — la plus basse limite de la carte', () => {
    const r = analyzeTrip(trajet([18, 19, 18]), {}, () => 10);
    expect(r.speedingCount).toBe(1);
    expect(r.detail.speeding[0]!.limitKmh).toBe(10);
  });

  it('⚠️ le même trajet sans limite connue ne produit RIEN — l’ignorance n’est pas une innocence', () => {
    // C'est le prix nommé de la correction : sur une rue jamais rencontrée, dont aucune cellule
    // n'est en cache, l'excès en zone 20 reste invisible. Le taux de couverture le dit.
    const r = analyzeTrip(trajet([30, 31, 30]), {}, () => null);
    expect(r.speedingCount).toBe(0);
  });
});

describe('Ce que le palier lent ne change PAS', () => {
  it('un trajet rapide compte ses excès exactement comme avant', () => {
    const r = analyzeTrip(trajet([100, 102, 101]), {}, () => 90);
    expect(r.speedingCount).toBe(1);
    expect(r.detail.speeding[0]).toMatchObject({ limitKmh: 90, overKmh: 12 });
  });

  it('⚠️ le taux de couverture continue de porter sur la population RAPIDE seule', () => {
    // Les points lents ne sont résolus que depuis le cache : les compter dans le taux ferait
    // chuter la couverture de tous les trajets urbains, et déclencherait des rejeux sans objet.
    let appels = 0;
    const r = analyzeTrip(
      // Deux points lents (20, 25) et deux points rapides (80, 82).
      trajet([20, 25, 80, 82]),
      {},
      () => { appels++; return 90; },
    );
    // Le résolveur est interrogé pour TOUS les points — c'est le service qui décide lesquels
    // sont pré-résolus — mais seuls les rapides entrent dans le taux.
    expect(appels).toBeGreaterThan(0);
    expect(r.limitsCoverage).toBe(1);
  });

  it('un véhicule à l’arrêt ou au pas ne déclenche aucune recherche de limite', () => {
    const r = analyzeTrip(trajet([0, 3, 6, 4]), {}, () => 10);
    // Sous le palier lent, aucune limite n'est demandée : le taux reste indéfini.
    expect(r.limitsCoverage).toBeNull();
    expect(r.speedingCount).toBe(0);
  });
});
