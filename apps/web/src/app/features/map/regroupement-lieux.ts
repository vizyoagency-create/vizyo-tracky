/**
 * Regroupement des repères de lieu qui se chevauchent — le mode « Discrets ».
 *
 * La planche Carte écrit « regroupe les plus proches ». C'était la moitié non livrée
 * du mode : les repères rapetissaient et passaient derrière, mais dix parkings dans la
 * même rue restaient dix pastilles empilées — plus petites, donc PLUS DIFFICILES à
 * viser qu'avant. Le mode aggravait ce qu'il prétendait résoudre.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ON REGROUPE EN PIXELS ÉCRAN, PAS EN DEGRÉS                                 │
 * │                                                                            │
 * │ C'est le CHEVAUCHEMENT VISUEL qu'on corrige. Deux points distants de 200 m  │
 * │ se superposent au zoom 11 et ne se touchent plus au zoom 17 : un seuil      │
 * │ exprimé en mètres regrouperait donc trop loin d'un côté, pas assez de       │
 * │ l'autre, et resterait faux aux deux bouts.                                  │
 * │                                                                            │
 * │ Conséquence directe : le résultat dépend de la vue, donc l'appelant doit    │
 * │ relancer le calcul à chaque `moveend`.                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Extrait du composant carte pour être testable : `map.project()` n'existe pas sans
 * une vraie instance MapLibre, alors que la règle de regroupement, elle, est de
 * l'arithmétique pure. On lui passe donc les points DÉJÀ projetés.
 */

/** Un repère, réduit à ce qui décide du regroupement : son identité et sa position écran. */
export interface PointProjete<T> {
  element: T;
  x: number;
  y: number;
}

/**
 * Regroupement glouton : on prend le premier point libre, on lui agrège tous les points
 * libres à portée, on recommence.
 *
 * O(n²) assumé — ces repères se comptent en dizaines, jamais en milliers, et une passe
 * exacte se relit mieux qu'un index spatial qu'il faudrait maintenir. Le premier point
 * d'un paquet est sa TÊTE : c'est sa position qui porte le marqueur, ce qui garde le
 * repère groupé sur un lieu réel au lieu d'un barycentre qui ne serait nulle part.
 *
 * @param rayonPx distance en dessous de laquelle deux repères se chevauchent.
 */
export function regrouperParProximite<T>(
  points: readonly PointProjete<T>[],
  rayonPx: number,
): T[][] {
  const pris = new Array<boolean>(points.length).fill(false);
  const paquets: T[][] = [];

  for (let i = 0; i < points.length; i++) {
    if (pris[i]) continue;
    pris[i] = true;
    const tete = points[i]!;
    const paquet: T[] = [tete.element];
    for (let j = i + 1; j < points.length; j++) {
      if (pris[j]) continue;
      const autre = points[j]!;
      if (Math.hypot(tete.x - autre.x, tete.y - autre.y) <= rayonPx) {
        pris[j] = true;
        paquet.push(autre.element);
      }
    }
    paquets.push(paquet);
  }

  return paquets;
}
