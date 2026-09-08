import { vitessesSurTrace } from './vitesse-sur-trace';

/**
 * La vitesse de chaque sommet d'un tracé, prêtée par le relevé le plus proche EN AVANÇANT.
 * Mesuré en production le 2026-09-08 : un tracé recalé porte des dizaines de sommets entre
 * deux relevés, et un relevé peut manquer sur 2,5 km. La fonction doit rester juste dans les
 * deux sens — et à un aller-retour, ne jamais prêter la vitesse de l'aller au retour.
 */
const P = (lng: number, lat: number): readonly [number, number] => [lng, lat];
const R = (lng: number, lat: number, speedKmh: number | null) => ({ lat, lng, speedKmh });

describe('vitessesSurTrace', () => {
  it('sans relevé, chaque sommet est sans vitesse (NaN), jamais 0', () => {
    const v = vitessesSurTrace([P(1.43, 43.6), P(1.44, 43.6)], []);
    expect(v.length).toBe(2);
    expect(v.every((x) => Number.isNaN(x))).toBe(true);
  });

  it('un sommet prend la vitesse du relevé le plus proche, et un tracé dense entre deux relevés hérite du suivant', () => {
    // Tracé de 5 sommets alignés ; relevés aux sommets 0 et 4.
    const trace = [P(1.400, 43.6), P(1.401, 43.6), P(1.402, 43.6), P(1.403, 43.6), P(1.404, 43.6)];
    const v = vitessesSurTrace(trace, [R(1.400, 43.6, 20), R(1.404, 43.6, 80)]);
    // Les deux premiers sommets sont plus près du premier relevé, les trois autres du second.
    expect(v).toEqual([20, 20, 80, 80, 80]);
  });

  it('à un aller-retour, le retour reçoit les vitesses du RETOUR, pas celles de l’aller', () => {
    // A → B → C puis C → B → A, sur la même route.
    const A = P(1.400, 43.6), B = P(1.410, 43.6), C = P(1.420, 43.6);
    const trace = [A, B, C, B, A];
    const releves = [R(1.400, 43.6, 10), R(1.410, 43.6, 30), R(1.420, 43.6, 50), R(1.410, 43.6, 70), R(1.400, 43.6, 90)];
    expect(vitessesSurTrace(trace, releves)).toEqual([10, 30, 50, 70, 90]);
  });

  it('un relevé sans vitesse donne NaN à ses sommets — jamais une vitesse inventée', () => {
    const v = vitessesSurTrace([P(1.400, 43.6), P(1.410, 43.6)], [R(1.400, 43.6, 40), R(1.410, 43.6, null)]);
    expect(v[0]).toBe(40);
    expect(Number.isNaN(v[1])).toBe(true);
  });

  it('un tracé recalé de cent sommets entre trois relevés reçoit trois vitesses, dans l’ordre', () => {
    const trace = Array.from({ length: 100 }, (_, i) => P(1.4 + i * 0.0002, 43.6));
    const releves = [R(1.4, 43.6, 30), R(1.4 + 50 * 0.0002, 43.6, 90), R(1.4 + 99 * 0.0002, 43.6, 40)];
    const v = vitessesSurTrace(trace, releves);
    expect(v[0]).toBe(30);
    expect(v[24]).toBe(30);
    expect(v[50]).toBe(90);
    expect(v[74]).toBe(90);
    expect(v[99]).toBe(40);
    // Monotone : jamais un retour à 30 après être passé à 90.
    const premier90 = v.indexOf(90);
    expect(v.slice(premier90).includes(30)).toBe(false);
  });
});
