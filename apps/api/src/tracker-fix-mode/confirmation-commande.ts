/**
 * ══ TRK-055 — LA RÈGLE A DÉMÉNAGÉ DANS `shared`, ET CE FICHIER N'EST PLUS QU'UN RELAIS ══
 *
 * TRK-051 avait écrit ici la règle « qu'est-ce qui a confirmé cette commande ? », une fois,
 * exportée et testée. C'était le bon geste au mauvais endroit : rangée dans `apps/api`, elle
 * était **inatteignable depuis le web**. Les trois écrans web qui affichent un statut de
 * commande n'avaient donc qu'un seul moyen de l'appliquer — la réécrire — et deux d'entre eux
 * ne l'ont pas fait : ils peignaient encore `ACKNOWLEDGED` en VERT sous le libellé « Confirmée ».
 * Mesure du 01/09 : **394 commandes vertes sur 7 jours, dont 0 avec réponse de boîtier.**
 *
 * 🔑 **Une règle partagée doit vivre là où tous ses lecteurs peuvent l'atteindre.** Sinon elle
 * n'est pas partagée : elle est simplement écrite une fois de plus que les autres.
 *
 * Ce fichier est conservé en RELAIS pour ne pas casser les imports existants côté API. La
 * définition, elle, vit désormais dans `packages/shared/src/dto/confirmation-commande.ts`.
 */
export {
  confirmationDeCommande,
  ventilerConfirmations,
  libelleStatutCommande,
  tonStatutCommande,
  LIBELLE_CONFIRMATION,
} from '@vizyo/tracky-shared';
export type { ConfirmationCommande, TonStatutCommande } from '@vizyo/tracky-shared';
