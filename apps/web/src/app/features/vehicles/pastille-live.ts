import {
  getVehicleConnectivityState,
  isTrackerOnline,
  type VehicleConnectivityInput,
} from '@vizyo/tracky-shared';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * A-T-ON LE DROIT D'AFFICHER UNE PASTILLE « LIVE » POUR CE VÉHICULE ?
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La liste des véhicules affiche, par ligne, soit une PASTILLE LIVE (« À l'arrêt », « Roule »,
 * une vitesse en km/h), soit — dans la branche `@else` — un BADGE DE CONNECTIVITÉ qui, lui,
 * DATE la donnée (« Hors ligne · il y a 4 j », « Dormant · 19 j »).
 *
 * ⚠️ TOUT EST DANS LE `@else`. La pastille prend la priorité : dès qu'elle s'affiche, le badge
 * qui dit la vérité sur l'ancienneté ne s'affiche JAMAIS. Décider de la montrer, c'est donc
 * décider de présenter une trame AU PRÉSENT.
 *
 * ── POURQUOI CETTE DÉCISION VIT ICI, ET PLUS DANS LE COMPOSANT ────────────────────────────
 *
 * Elle s'est trompée TROIS FOIS, toujours de la même façon : un état de boîtier oublié.
 *
 *   1. DORMANT (muet > 7 j) — un véhicule tu depuis 89 jours affichait « Stationné » comme
 *      s'il venait d'être vu. Garde ajoutée après coup.
 *   2. GPS_LOST — le boîtier émet mais sans fix : la vitesse était FIGÉE à sa dernière valeur,
 *      donc « roule » pour un véhicule immobile. Garde ajoutée après coup.
 *   3. MUET ENTRE 15 MIN ET 7 JOURS — ni dormant, ni `GPS_LOST`. Mesuré en production le
 *      2026-09-07 : `GLA•KC•31` affichait « À l'arrêt · 7 km/h » alors que sa dernière
 *      position datait de 109,9 h et son dernier signal de 108,1 h, soit 4,5 jours. Les deux
 *      sources se contredisaient d'ailleurs : la position temps réel portait `ignition: true`
 *      et 7,389 km/h, le snapshot disait contact coupé.
 *
 * Trois correctifs, trois fois le même angle mort — parce que la question était posée à
 * l'envers : on ÉNUMÉRAIT les états interdits. Ici elle est posée dans le bon sens, et c'est
 * tout l'intérêt de l'extraction : **on exige un boîtier vivant**, et tout état futur qui ne
 * l'est pas est couvert d'avance, sans qu'on ait à y penser.
 */

/** Ce que le snapshot temps réel sait du boîtier. `null` = véhicule absent du snapshot. */
export type EtatBoitier = VehicleConnectivityInput | null | undefined;

/**
 * Vrai si la ligne peut porter une pastille décrivant le PRÉSENT.
 *
 * @param snap     l'état du boîtier au snapshot ; peut manquer (voir `trameAt`).
 * @param trameAt  l'horodatage de la position temps réel elle-même. ⚠️ C'est le repli quand le
 *                 véhicule n'est PAS dans le snapshot : une position poussée en direct est une
 *                 preuve de fraîcheur en soi, et la masquer faute de snapshot serait un recul.
 * @param dormant  la dormance telle que la liste la calcule déjà (muet > 7 j), lue sur la fiche
 *                 véhicule et non sur le snapshot : elle couvre aussi les véhicules absents.
 * @param now      injecté pour que le test ne dépende pas de l'horloge.
 */
export function pastilleLiveAutorisee(
  snap: EtatBoitier,
  trameAt: string | Date | number | null | undefined,
  dormant: boolean,
  now: number = Date.now(),
): boolean {
  // Muet depuis plus de 7 jours : le badge « Dormant · N j » est le seul à dire quelque chose
  // d'utile. Calculé en amont parce qu'il ne dépend pas du snapshot.
  if (dormant) return false;

  /**
   * ⚠️ L'EXIGENCE, ET NON L'ÉNUMÉRATION. `TRACKER_ONLINE_THRESHOLD_MS` (15 min) est la
   * définition même de « vivant maintenant » du tri-état de connectivité. Au-delà, aucune
   * pastille ne peut prétendre décrire l'instant : c'est ce seul test qui couvre le cas 3
   * ci-dessus, et d'avance tout état de silence à venir.
   *
   * Le snapshot fait foi quand il existe — il connaît le dernier signal du boîtier, y compris
   * sans position. Sinon on juge la trame sur son propre âge.
   */
  if (!isTrackerOnline(snap?.lastSeenAt ?? trameAt, now)) return false;

  /**
   * Le boîtier parle, mais sans lock satellite : sa dernière position — donc sa vitesse — est
   * périmée alors que la trame est fraîche. C'est le seul cas où « vivant » ne suffit pas, et
   * c'est pourquoi il reste énuméré.
   */
  if (snap && getVehicleConnectivityState(snap, now) === 'GPS_LOST') return false;

  return true;
}

/** Ce que la pastille raconte : le véhicule roule, tourne à l'arrêt, ou est immobile. */
export type GenrePastille = 'moving' | 'idle' | 'stopped';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * QUE RACONTE LA PASTILLE — ET CE QU'ELLE NE PEUT PAS SAVOIR SANS LE FIL ACC
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Trois états, mais seulement DEUX sont dérivables du GPS seul :
 *
 *   · `moving` — le véhicule se déplace : la vitesse suffit à l'affirmer ;
 *   · `stopped` — il ne se déplace pas ;
 *   · `idle` — il est immobile MOTEUR TOURNANT. Cet état-là ne se lit que sur l'entrée ACC du
 *     boîtier, c'est-à-dire sur un FIL qu'il faut avoir raccordé à la pose.
 *
 * ⚠️ QUAND CE FIL N'EST PAS RACCORDÉ, `ignition` NE VEUT RIEN DIRE — et vaut `false` en
 * permanence. Le déduire quand même produit l'inverse de la vérité.
 *
 * Mesuré en production le 2026-09-07 : `GA-490-SJ` roulait à **31 km/h** et la liste affichait
 * « À l'arrêt ». Son `accConnected` valait `false` : le statut était calculé sur un champ que
 * son installation ne renseigne pas. Six véhicules vivants sur trente étaient dans ce cas.
 *
 * Sans le fil, on s'en tient donc à ce que le GPS prouve : il roule, ou il ne roule pas.
 * `idle` n'est jamais affirmé — mieux vaut ne pas distinguer que distinguer à l'envers.
 */
export function genrePastille(
  trame: { ignition?: boolean | null; speedKmh: number },
  accRaccorde: boolean | null | undefined,
  seuilRoule = 3,
): GenrePastille {
  const vitesse = Math.round(trame.speedKmh);

  // Le fil ACC n'est pas posé : `ignition` est structurellement faux, on l'ignore.
  if (accRaccorde === false) return vitesse > seuilRoule ? 'moving' : 'stopped';

  if (trame.ignition && vitesse > seuilRoule) return 'moving';
  if (trame.ignition) return 'idle';
  /**
   * ⚠️ CONTACT COUPÉ MAIS VITESSE RÉELLE. Le fil est raccordé et dit « coupé » alors que le
   * GPS voit du mouvement : remorquage, roue libre, ou trame d'ignition en retard. Dans le
   * doute on croit le GPS — annoncer « à l'arrêt » un véhicule qui se déplace est la seule
   * des deux erreurs qu'un exploitant ne peut pas rattraper.
   */
  return vitesse > seuilRoule ? 'moving' : 'stopped';
}
