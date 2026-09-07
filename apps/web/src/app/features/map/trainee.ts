/**
 * La traînée d'un véhicule sur la carte temps réel — ce qui y entre, et quand elle s'efface.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CE QUE LA PRODUCTION A MONTRÉ (2026-09-07, 90 dernières minutes)           │
 * │                                                                            │
 * │ Un véhicule qui roule émet toutes les 10 à 16 s — pas 30. Un véhicule à   │
 * │ l'arrêt émet toutes les 2 à 6 min, avec un bruit GPS de 100 à 240 m       │
 * │ entre deux trames. L'ancienne règle n'ajoutait un point que si les        │
 * │ coordonnées changeaient EXACTEMENT : chaque trame bruitée d'un véhicule   │
 * │ immobile allongeait donc sa traînée, jusqu'à vingt points, et rien ne     │
 * │ l'effaçait jamais. À vingt points, la traînée d'un véhicule qui roule     │
 * │ faisait trois à cinq minutes de route : le « en retard » ressenti.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Demande du propriétaire : deux ou trois traînées pour ceux qui roulent, aucune pour ceux
 * à l'arrêt depuis trois minutes.
 *
 * ⚠️ LE GPS SEUL DÉCIDE — JAMAIS LE CONTACT. Six véhicules sur trente n'ont pas de fil ACC
 * raccordé (`accConnected: false`) : leur `ignition` vaut `false` en permanence, et le lire
 * donnerait l'inverse de la réalité. Ici, « rouler » se prouve par la vitesse annoncée ou par
 * celle déduite du déplacement entre deux trames fiables. Un boîtier Coban annonce souvent 0
 * en roulant : la vitesse déduite rattrape ce cas.
 *
 * Extraite du composant carte pour être PROUVÉE : la règle vivait dans `applyPositions`, au
 * milieu de deux cents lignes de lissage, et personne ne pouvait la tester.
 */

export interface EtatTrainee {
  /** Les points de la traînée, en [lng, lat], du plus ancien au plus récent. */
  readonly points: readonly [number, number][];
  /** Horloge du poste (`Date.now()`) au dernier mouvement prouvé par le GPS. */
  readonly dernierMouvementMs: number | null;
  /** L'horodatage boîtier de la dernière trame traitée. */
  readonly derniereTrame: string | null;
}

export const ETAT_TRAINEE_VIDE: EtatTrainee = { points: [], dernierMouvementMs: null, derniereTrame: null };

/** À l'arrêt depuis ce délai, la traînée s'efface. Demande du propriétaire : trois minutes. */
export const TRAINEE_ARRET_MS = 3 * 60_000;
/** Au-dessus de cette vitesse ANNONCÉE, le véhicule roule. Sous 3 km/h, un GPS immobile en annonce parfois. */
export const TRAINEE_VITESSE_ANNONCEE_MIN_KMH = 3;
/**
 * Au-dessus de cette vitesse DÉDUITE du déplacement, le véhicule roule. Le bruit GPS d'un
 * véhicule immobile — 240 m en 4 min, mesuré — vaut 3 à 4 km/h : le seuil est au-dessus.
 */
export const TRAINEE_VITESSE_DEDUITE_MIN_KMH = 8;

export interface TrameTrainee {
  readonly lng: number;
  readonly lat: number;
  /** Horodatage boîtier de la trame, tel quel — sert seulement à reconnaître une trame rejouée. */
  readonly horodatage: string;
  /** La vitesse que le boîtier annonce. */
  readonly vitesseRapporteeKmh: number | null | undefined;
  /** La vitesse déduite du déplacement entre deux trames fiables (`deriveMotion`). */
  readonly vitesseDeriveeKmh: number | null | undefined;
  /** Horloge du poste au moment du traitement. */
  readonly nowMs: number;
}

export function vehiculeRoule(
  vitesseRapporteeKmh: number | null | undefined,
  vitesseDeriveeKmh: number | null | undefined,
): boolean {
  if ((vitesseRapporteeKmh ?? 0) > TRAINEE_VITESSE_ANNONCEE_MIN_KMH) return true;
  return (vitesseDeriveeKmh ?? 0) > TRAINEE_VITESSE_DEDUITE_MIN_KMH;
}

/**
 * Fait entrer une trame dans la traînée — ou la fait sortir.
 *
 * ⚠️ `applyPositions` rejoue la DERNIÈRE trame de chaque véhicule à chaque rafraîchissement,
 * même sans nouveauté pour lui. Une trame rejouée n'est donc jamais une preuve de mouvement :
 * seul un horodatage boîtier jamais vu compte. Sans cela, un véhicule entré dans un tunnel
 * avec « 40 km/h » sur sa dernière trame garderait sa traînée pour toujours.
 */
export function mettreAJourTrainee(etat: EtatTrainee, trame: TrameTrainee, longueurMax: number): EtatTrainee {
  const neuve = etat.derniereTrame !== trame.horodatage;
  const roule = neuve && vehiculeRoule(trame.vitesseRapporteeKmh, trame.vitesseDeriveeKmh);

  if (roule) {
    const points = [...etat.points];
    const dernier = points[points.length - 1];
    if (!dernier || dernier[0] !== trame.lng || dernier[1] !== trame.lat) {
      points.push([trame.lng, trame.lat]);
      while (points.length > longueurMax) points.shift();
    }
    return { points, dernierMouvementMs: trame.nowMs, derniereTrame: trame.horodatage };
  }

  // À l'arrêt, ou trame rejouée : rien n'entre. Passé le délai, tout s'efface.
  const depuis = etat.dernierMouvementMs;
  const efface = depuis === null || trame.nowMs - depuis >= TRAINEE_ARRET_MS;
  return {
    points: efface ? [] : etat.points,
    dernierMouvementMs: depuis,
    derniereTrame: neuve ? trame.horodatage : etat.derniereTrame,
  };
}
