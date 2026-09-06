/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * « VITESSE MOYENNE » — UNE SEULE DÉFINITION : LA DISTANCE DIVISÉE PAR LE TEMPS ROULANT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le produit en affichait TROIS pour un même trajet, côte à côte, sans jamais dire laquelle :
 *
 *   - la liste et la carte de trajet montraient `Trip.avgSpeed`, la moyenne ARITHMÉTIQUE des
 *     vitesses des points GPS ;
 *   - le récit du replay montrait `TripAnalysis.avgSpeedKmh`, distance ÷ temps roulant ;
 *   - la synthèse de flotte calculait distance ÷ durée totale.
 *
 * Mesuré en production le 2026-09-06 sur un trajet de 47,63 km en 1 h 07 : 31, 53 et 42 km/h.
 * Et sur les 12 314 trajets analysés de la base, l'écart moyen entre les deux premières est de
 * +7,7 km/h — pas un arrondi, une population entière décalée.
 *
 * ── POURQUOI LA MOYENNE DES POINTS EST LA MAUVAISE ───────────────────────────────────────
 *
 * Elle pondère chaque relevé pareil, quelle que soit sa DURÉE. Un véhicule qui envoie une
 * position toutes les 10 s à l'arrêt et une toutes les 60 s sur autoroute voit ses minutes
 * d'arrêt compter six fois plus que ses minutes de route. Le chiffre dépend alors de la
 * cadence du boîtier — pas de la conduite. C'est aussi le seul des trois qu'un gestionnaire ne
 * peut REFAIRE : ni la distance ni la durée affichées ne permettent de retomber dessus.
 *
 * ── CE QUE « ROULANT » VEUT DIRE, ET POURQUOI CE MODULE EXISTE ────────────────────────────
 *
 * Deux règles, et elles étaient déjà écrites — dans le préprocesseur d'analyse, en local.
 * Le segmenteur de trajets, lui, n'en savait rien. Les mettre ICI est ce qui empêche les deux
 * producteurs de `Trip.avgSpeed` (la segmentation par lot ET le trajet en direct) de diverger
 * du calcul de l'analyse, qui est la référence.
 *
 * ⚠️ LES DEUX SEUILS SONT DES DÉCISIONS, pas des détails d'implémentation :
 *
 *   - sous 4 km/h on est à l'arrêt. Le GPS d'un véhicule immobile n'affiche jamais zéro : il
 *     dérive de 1 à 3 km/h. Compter cette dérive comme du roulage rallongerait le temps
 *     roulant de tous les arrêts, et écraserait la moyenne — précisément le défaut qu'on
 *     répare ;
 *   - au-delà de 5 minutes entre deux points, on ne sait pas ce qui s'est passé. L'intervalle
 *     n'est compté NI en roulage NI en ralenti : un trou de signal de deux heures ne doit pas
 *     devenir deux heures de conduite, ni deux heures d'arrêt.
 */

/** Sous ce seuil, le véhicule est à l'arrêt : c'est de la dérive GPS, pas du mouvement. */
export const SEUIL_ARRET_KMH = 4;

/** Au-delà de cet intervalle entre deux positions, on ne compte rien : signal perdu. */
export const TROU_GPS_SEC = 300;

/** Le minimum qu'il faut connaître d'une position pour en tirer du temps roulant. */
export interface PositionRoulante {
  timestamp: Date;
  speedKmh: number;
}

/**
 * Le temps, en secondes, pendant lequel le véhicule a RÉELLEMENT roulé.
 *
 * Un intervalle compte comme roulant si l'une de ses deux bornes dépasse le seuil d'arrêt :
 * un démarrage comme un freinage jusqu'à l'arrêt sont du roulage, et n'en retenir que les
 * intervalles dont les DEUX bornes bougent retrancherait une seconde sur deux en ville.
 *
 * ⚠️ Les positions doivent être TRIÉES par horodatage. Un intervalle négatif est ignoré
 * plutôt que soustrait : sur une trace désordonnée, mieux vaut un temps roulant trop court —
 * donc une moyenne prudente — qu'un temps négatif qui rendrait la division absurde.
 */
export function tempsRoulantSec(positions: readonly PositionRoulante[]): number {
  let roulant = 0;
  for (let i = 1; i < positions.length; i++) {
    const p = positions[i]!;
    const prec = positions[i - 1]!;
    const dt = (p.timestamp.getTime() - prec.timestamp.getTime()) / 1000;
    if (dt <= 0 || dt > TROU_GPS_SEC) continue;
    if (p.speedKmh > SEUIL_ARRET_KMH || prec.speedKmh > SEUIL_ARRET_KMH) roulant += dt;
  }
  return Math.round(roulant);
}

/**
 * Ce qu'ajoute UNE position au temps roulant, connaissant la précédente. La forme
 * incrémentale du calcul ci-dessus, pour le trajet en cours de constitution : le service des
 * trajets reçoit les positions une par une et ne peut pas les relire toutes à chaque fois.
 *
 * ⚠️ MÊME RÈGLE, DÉLIBÉRÉMENT DÉRIVÉE DE LA MÊME FONCTION EN TEST : un trajet fermé en direct
 * et le même trajet recalculé par lot doivent porter le même chiffre, sinon le recalcul
 * déplacerait des moyennes sans que personne ne comprenne pourquoi.
 */
export function apportTempsRoulantSec(
  precedente: PositionRoulante | null,
  courante: PositionRoulante,
): number {
  if (!precedente) return 0;
  return tempsRoulantSec([precedente, courante]);
}

/**
 * La vitesse moyenne affichée : distance ÷ temps roulant, arrondie au centième.
 *
 * ⚠️ SANS TEMPS ROULANT, ZÉRO — et surtout pas un repli sur la durée totale. Un trajet sans
 * une seule seconde de roulage n'a pas de vitesse moyenne à montrer ; en inventer une à partir
 * d'un autre dénominateur rendrait à nouveau deux chiffres incomparables, ce que ce module
 * existe pour empêcher.
 */
export function vitesseMoyenneRoulante(distanceKm: number, movingSec: number): number {
  if (!(movingSec > 0) || !(distanceKm > 0)) return 0;
  return Math.round((distanceKm / (movingSec / 3600)) * 100) / 100;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * QUAND LE TEMPS ROULANT NE PEUT PAS SERVIR DE DÉNOMINATEUR — ET COMMENT LE PROUVER
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La distance s'accumule sur TOUS les intervalles ; le temps roulant, lui, saute les trous de
 * signal. Sur un trajet où le boîtier s'est tu pendant la conduite, le numérateur contient donc
 * des kilomètres dont le dénominateur ne contient pas les secondes, et la division s'emballe.
 *
 * Mesuré sur les 12 314 trajets analysés de la production : 31 dépassent 130 km/h de MOYENNE,
 * dont 7 dépassent 200 — au point que la contrainte `trips_avg_speed_in_range` (0 à 250) a
 * refusé la reprise de données, ce qui est exactement son rôle. Le pire relevé : 23,98 km en
 * 302 secondes de roulage observé, soit 286 km/h annoncés pour un véhicule dont la pointe
 * mesurée est de 72 km/h.
 *
 * ── LA GARDE EST UNE PREUVE, PAS UN SEUIL ────────────────────────────────────────────────
 *
 * On ne compare à aucune vitesse « raisonnable » choisie à la main. On compare au trajet
 * lui-même : couvrir `d` kilomètres demande au minimum `d / vitesse maximale` heures. Si le
 * temps roulant observé est INFÉRIEUR à ce minimum, il est incomplet — démontré, pas estimé :
 * le véhicule ne peut pas avoir parcouru cette distance en si peu de temps, même en roulant à
 * sa propre pointe tout du long.
 *
 * Dans ce cas seulement, on retombe sur la durée totale. C'est le seul dénominateur restant
 * qui contienne à coup sûr toutes les secondes des kilomètres comptés. Sur l'exemple ci-dessus :
 * 302 s observées contre 1 191 s minimum → on prend les 1 860 s de durée, soit 46 km/h.
 *
 * ⚠️ CETTE GARDE NE S'APPLIQUE QU'À LA MOYENNE. `movingSec` reste la mesure de ce qu'on a
 * OBSERVÉ, et continue d'alimenter le ralenti et la note de conduite : le corriger ici
 * déplacerait des scores sur la foi d'une déduction.
 */
export function vitesseMoyenneTrajet(t: {
  distanceKm: number;
  movingSec: number;
  durationSec: number;
  maxSpeedKmh: number;
}): number {
  const { distanceKm, movingSec, durationSec, maxSpeedKmh } = t;
  if (!(distanceKm > 0)) return 0;

  // Le temps qu'il faudrait au MINIMUM pour couvrir cette distance, à la pointe du trajet.
  const minimumPossibleSec = maxSpeedKmh > 0 ? (distanceKm / maxSpeedKmh) * 3600 : 0;
  const roulantIncomplet = !(movingSec > 0) || movingSec < minimumPossibleSec;

  // ⚠️ `Math.max` et non un remplacement sec : sur une trace où la durée serait plus COURTE
  // que le temps roulant (horodatages désordonnés), reculer le dénominateur aggraverait la
  // division au lieu de la corriger.
  const denominateur = roulantIncomplet ? Math.max(movingSec, durationSec) : movingSec;
  return vitesseMoyenneRoulante(distanceKm, denominateur);
}

/**
 * La vitesse moyenne d'un ENSEMBLE de trajets — une flotte, un véhicule, un conducteur.
 *
 * ⚠️ Σ kilomètres ÷ Σ temps roulant, JAMAIS la moyenne des moyennes. Un trajet de 400 m à
 * 8 km/h pèserait autant qu'un trajet de 180 km à 110 : c'est le défaut que le PDF et l'Excel
 * avaient déjà payé une fois (45,1 contre 39,3 pour le même véhicule et la même période).
 *
 * ⚠️ ET LE MÊME REPLI QUE POUR UN TRAJET SEUL : quand aucun trajet de l'ensemble n'a de temps
 * roulant connu — données d'avant la reprise, positions purgées — on divise par la durée
 * totale. Sans ce repli, la fiche d'un véhicule ancien afficherait 0 km/h sous des centaines
 * de kilomètres bien réels.
 *
 * ⚠️ RENDU SANS ARRONDI, et c'est délibéré : chaque surface n'a pas le même besoin. Les
 * tableaux de l'écran veulent un entier, le classeur une décimale, le PDF l'imprime avec
 * `toFixed(1)`. Une version qui arrondissait ici à l'entier faisait afficher 49 au classeur
 * là où le PDF imprimait 49,2 — deux documents qui décrivent la même flotte et ne se
 * répondent pas tout à fait. La règle calcule ; la mise en forme appartient à qui affiche.
 */
export function vitesseMoyenneAgregee(t: {
  distanceKm: number;
  durationSeconds: number;
  movingSeconds: number;
}): number {
  const denominateur = t.movingSeconds > 0 ? t.movingSeconds : t.durationSeconds;
  if (!(denominateur > 0) || !(t.distanceKm > 0)) return 0;
  return t.distanceKm / (denominateur / 3600);
}

