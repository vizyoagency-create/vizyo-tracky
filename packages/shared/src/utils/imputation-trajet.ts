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

/** La sorte que porte une clé rendue par `cleImputationTrajet`. */
export function sorteImputation(cle: string): SorteImputation {
  if (cle.startsWith('driver:')) return 'driver';
  if (cle.startsWith('group:')) return 'group';
  return 'non-attribue';
}
