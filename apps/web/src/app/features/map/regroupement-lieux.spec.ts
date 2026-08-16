import { regrouperParProximite, type PointProjete } from './regroupement-lieux';

const p = (nom: string, x: number, y: number): PointProjete<string> => ({ element: nom, x, y });

describe('regrouperParProximite', () => {
  it('laisse seuls les repères qui ne se touchent pas', () => {
    const paquets = regrouperParProximite([p('a', 0, 0), p('b', 100, 0), p('c', 200, 0)], 34);
    expect(paquets).toEqual([['a'], ['b'], ['c']]);
  });

  it('regroupe ceux qui se chevauchent', () => {
    const paquets = regrouperParProximite([p('a', 0, 0), p('b', 10, 10), p('c', 300, 300)], 34);
    expect(paquets).toEqual([['a', 'b'], ['c']]);
  });

  it('mesure une vraie distance, pas seulement un écart en x', () => {
    // 30 px en x ET 30 px en y font 42 px de distance : au-delà du rayon de 34.
    // Comparer les axes séparément aurait regroupé à tort.
    const paquets = regrouperParProximite([p('a', 0, 0), p('b', 30, 30)], 34);
    expect(paquets).toEqual([['a'], ['b']]);
  });

  it('inclut la limite exacte du rayon', () => {
    const paquets = regrouperParProximite([p('a', 0, 0), p('b', 34, 0)], 34);
    expect(paquets).toEqual([['a', 'b']]);
  });

  it('garde le premier point comme tête du paquet', () => {
    // La tête porte la position du marqueur : le repère groupé doit rester sur un
    // lieu réel, pas sur un barycentre qui ne serait nulle part.
    const paquets = regrouperParProximite([p('tete', 0, 0), p('suivant', 5, 5)], 34);
    expect(paquets[0]![0]).toBe('tete');
  });

  it('n’affecte jamais un repère à deux paquets', () => {
    // Chaîne a—b—c où b est à portée des deux : b doit tomber dans UN seul paquet,
    // sinon le total affiché dépasse le nombre réel de lieux.
    const paquets = regrouperParProximite([p('a', 0, 0), p('b', 30, 0), p('c', 60, 0)], 34);
    const total = paquets.reduce((n, q) => n + q.length, 0);
    expect(total).toBe(3);
    expect(paquets).toEqual([['a', 'b'], ['c']]);
  });

  it('ne renvoie rien quand il n’y a rien', () => {
    expect(regrouperParProximite([], 34)).toEqual([]);
  });
});
