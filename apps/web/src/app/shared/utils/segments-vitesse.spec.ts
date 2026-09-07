import { BANDES_VITESSE, couleurVitesse } from './couleurs-carte';
import { pointsDepuisHistorique, segmentsColores, type PointVitesse } from './segments-vitesse';

/**
 * Le tracé coloré par la vitesse — le même générateur pour le rejeu de trajet, le rejeu de
 * période et la page publique de partage. Ce qui est prouvé ici : pas de trou entre deux
 * couleurs, pas de tronçon inutile, et la couleur vient de l'échelle unique.
 */
const p = (lng: number, lat: number, speedKmh: number): PointVitesse => ({ lng, lat, speedKmh });
const [gris, vert, orange, rouge, fonce] = BANDES_VITESSE.map((b) => b.couleur);

describe('segmentsColores', () => {
  it('rend une collection vide sans point ou avec un seul point', () => {
    expect(segmentsColores([]).features).toEqual([]);
    expect(segmentsColores([p(1, 1, 50)]).features).toEqual([]);
  });

  it('deux points : un tronçon, coloré par la vitesse du point d’ARRIVÉE, en [lng, lat]', () => {
    const fc = segmentsColores([p(1.1, 43.6, 0), p(1.2, 43.7, 80)]);

    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.length).toBe(1);
    expect(fc.features[0].geometry.coordinates).toEqual([[1.1, 43.6], [1.2, 43.7]]);
    expect(fc.features[0].properties.color).toBe(orange);
  });

  it('fusionne les points consécutifs de même bande en une seule ligne', () => {
    const fc = segmentsColores([p(0, 0, 30), p(1, 0, 40), p(2, 0, 65), p(3, 0, 1)]);

    expect(fc.features.length).toBe(1);
    expect(fc.features[0].properties.color).toBe(vert);
    expect(fc.features[0].geometry.coordinates.length).toBe(4);
  });

  it('change de tronçon à chaque changement de bande, en répétant le point frontière', () => {
    const fc = segmentsColores([p(0, 0, 30), p(1, 0, 40), p(2, 0, 90), p(3, 0, 120), p(4, 0, 150)]);

    expect(fc.features.map((f) => f.properties.color)).toEqual([vert, orange, rouge, fonce]);
    // La fin d'un tronçon est le début du suivant : aucun trou dans le tracé.
    for (let i = 1; i < fc.features.length; i++) {
      const fin = fc.features[i - 1].geometry.coordinates.at(-1);
      const debut = fc.features[i].geometry.coordinates[0];
      expect(debut).toEqual(fin!);
    }
    // Et chaque point du trajet est dessiné : n points + (tronçons - 1) répétitions.
    const total = fc.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
    expect(total).toBe(5 + (fc.features.length - 1));
  });

  it('une vitesse absente peint le tronçon « à l’arrêt », pas en rouge foncé', () => {
    const fc = segmentsColores([p(0, 0, 10), p(1, 0, Number.NaN)]);

    expect(fc.features[0].properties.color).toBe(gris);
  });

  it('pointsDepuisHistorique écarte les coordonnées invalides et les sauts de plus de 5 km', () => {
    const pts = pointsDepuisHistorique([
      { lat: 43.6, lng: 1.43, speedKmh: 20 },
      { lat: 0, lng: 0, speedKmh: 20 },              // (0,0) : invalide, écarté
      { lat: 43.601, lng: 1.431, speedKmh: 30 },
      { lat: 44.9, lng: 1.43, speedKmh: 30 },        // à 145 km : un saut, écarté
      { lat: 43.602, lng: 1.432, speedKmh: null },   // vitesse absente → NaN → gris
    ]);

    expect(pts.map((p) => [p.lng, p.lat])).toEqual([[1.43, 43.6], [1.431, 43.601], [1.432, 43.602]]);
    expect(pts.map((p) => p.speedKmh)).toEqual([20, 30, Number.NaN]);
  });

  it('suit exactement couleurVitesse — un seul endroit décide de la couleur', () => {
    const vitesses = [0, 12, 65, 66, 99, 100, 101, 139, 140, 141, 180];
    const pts = vitesses.map((v, i) => p(i, 0, v));
    const fc = segmentsColores(pts);

    // Reconstruit la couleur attendue de chaque paire depuis l'échelle, et la compare à celle
    // du tronçon qui contient cette paire.
    for (let i = 1; i < pts.length; i++) {
      const attendue = couleurVitesse(vitesses[i]);
      const tron = fc.features.find((f) =>
        f.geometry.coordinates.some((c, k) => k > 0 && c[0] === i && f.geometry.coordinates[k - 1][0] === i - 1),
      );
      expect(tron?.properties.color).withContext(`paire ${i - 1}→${i}`).toBe(attendue);
    }
  });
});
