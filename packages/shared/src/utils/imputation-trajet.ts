/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * À QUI IMPUTE-T-ON UN TRAJET ? — conducteur, sinon groupe, sinon personne
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mesuré en production le 2026-09-05 : chez cdef31, 2 675 trajets sur 2 707 n'ont PAS de
 * conducteur mais appartiennent à un véhicule qui a un groupe ; chez mh cars, 1 866 sur 1 886
 * n'ont NI l'un NI l'autre. Un classement « par conducteur » y est vide ou assis sur neuf
 * trajets ; un classement « par groupe » ignore les conducteurs quand il y en a. Aucun des
 * deux ne répond à la question du gestionnaire : « qui conduit comment ? ».
 *
 * D'où cette règle unique : le CONDUCTEUR s'il est renseigné, sinon le GROUPE du véhicule,
 * sinon « non attribué » — une ligne comptée, jamais classée (on ne note pas « personne »).
 *
 * ⚠️ UNE seule définition, parce que DEUX écrans la posent : le classement des notes
 * (portée `attribution`) et le récapitulatif de la page Rapports (F13). Deux copies
 * finiraient par diverger, et le produit rendrait deux réponses différentes à la même
 * question — la faute qu'il a déjà payée sur « reste à faire » et sur « avec excès ».
 */

/** Clé des trajets sans conducteur NI groupe. Comptée, jamais rendue comme une ligne classée. */
export const CLE_NON_ATTRIBUE = 'non-attribue';

/** Ce que la clé désigne, une fois calculée — utile pour le libellé et le sous-libellé. */
export type SorteImputation = 'driver' | 'group' | 'non-attribue';

/**
 * La clé d'imputation d'un trajet.
 *
 * @param driverId  conducteur du TRAJET (`Trip.driverId`), pas du véhicule : c'est celui qui
 *                  a conduit ce jour-là, et un même véhicule peut en changer.
 * @param groupId   groupe du véhicule : le PREMIER PAR NOM quand il y en aurait plusieurs (le
 *                  modèle est mono-groupe de facto — aucun véhicule n'a deux groupes au
 *                  2026-09-05 — mais les deux appelants trient pareil pour que le jour où cela
 *                  arrive, un même trajet ne soit pas imputé à deux groupes différents), ou `null`.
 */
export function cleImputationTrajet(driverId: string | null | undefined, groupId: string | null | undefined): string {
  if (driverId) return `driver:${driverId}`;
  return groupId ? `group:${groupId}` : CLE_NON_ATTRIBUE;
}

/**
 * ── LE FILTRE CONDUCTEUR, DEUX FORMES ET RIEN D'AUTRE (F13, seconde moitié) ─────────────
 *
 * Le récapitulatif dit « combien a roulé tel conducteur » ; le geste suivant — voir SES
 * trajets — est un filtre, qui accepte un identifiant de conducteur OU le mot-clé ci-dessous
 * pour les trajets sans conducteur.
 *
 * ⚠️ La forme vit ICI parce que les DEUX côtés la posent : le serveur valide ce qu'il reçoit
 * (quatre routes, dont trois lisent des paramètres bruts sans DTO), et l'écran valide ce
 * qu'il relit de l'URL avant de le renvoyer. Deux expressions écrites séparément finiraient
 * par diverger, et c'est le côté le plus permissif qui gagnerait — celui qui laisse passer.
 */
export const CONDUCTEUR_AUCUN = 'none';

/**
 * UUID canonique (toutes versions) OU le mot-clé `none`. Rien d'autre n'entre : la valeur
 * finit dans un `where` Prisma côté serveur, et dans l'URL côté écran.
 *
 * ⚠️ Sans drapeau `g` : une expression globale garde un curseur entre deux appels de `test`,
 * et rendrait faux un appel sur deux.
 */
export const FILTRE_CONDUCTEUR_REGEX =
  /^(?:none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Le filtre demandé sous la forme CANONIQUE que les deux côtés savent lire, ou `null` s'il n'en
 * est pas une.
 *
 * ⚠️ Cette fonction rend la VALEUR, jamais un simple verdict, et c'est tout son intérêt. Une
 * première version rendait un booléen après avoir testé `valeur.trim()` : les appelants
 * validaient donc une chaîne et en mémorisaient une autre. Relevé en revue contradictoire, avec
 * les deux dégâts que cela produisait sur `/rapports?driver=…` :
 *
 *   - `%20none` (une espace de trop, une adresse recopiée) était jugée valide, posée telle
 *     quelle, puis envoyée aux deux familles de routes : la LISTE la refusait (400, son DTO ne
 *     trime pas) pendant que les compteurs, les graphiques et la synthèse répondaient 200 filtrés
 *     sur « sans conducteur ». Un écran, deux populations — précisément ce que ce filtre existe
 *     pour empêcher ;
 *   - `NONE` passait partout (l'expression porte le drapeau `i`, le serveur compare en
 *     minuscules) mais l'écran, lui, compare avec `===` : le bouton affichait « Conducteur », la
 *     mention d'export promettait « les trajets de Conducteur », et le PDF imprimait au même
 *     moment le vrai nom résolu en base. Même faute, mais en silence.
 *
 * Mettre un UUID en minuscules est sans perte : la colonne est `@db.Uuid`, Postgres le stocke et
 * le rend en minuscules — c'est exactement la forme que portent les listes de conducteurs et les
 * clés `driver:<id>` de l'imputation.
 */
export function normaliserFiltreConducteur(valeur: string | null | undefined): string | null {
  const brut = (valeur ?? '').trim();
  return FILTRE_CONDUCTEUR_REGEX.test(brut) ? brut.toLowerCase() : null;
}

/** La sorte que porte une clé rendue par `cleImputationTrajet`. */
export function sorteImputation(cle: string): SorteImputation {
  if (cle.startsWith('driver:')) return 'driver';
  if (cle.startsWith('group:')) return 'group';
  return 'non-attribue';
}
