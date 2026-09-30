/**
 * ══ LE NUMÉRO DE CONTACT VIZYO — UNE SEULE LIGNE, POUR TOUT LE DÉPÔT ═════════════════════════
 *
 * Il vit dans `packages/shared` et nulle part ailleurs, parce qu'il est affiché des DEUX côtés :
 * par l'application (écran Assistance, liste des véhicules, écran de mise à jour) et par l'API
 * (signature des courriels). Deux copies, c'est deux vérités le jour où le numéro change.
 *
 * ── CE QUE ÇA A DÉJÀ COÛTÉ ───────────────────────────────────────────────────────────────────
 *
 * Le 27/09/2026, l'écran « Mise à jour en cours » est parti en production avec un numéro
 * d'assistance FAUX. Il n'avait pas été inventé de toutes pièces : il avait été recopié depuis
 * un exemple en commentaire de `env.validation.ts` (`+33656691615`, un numéro de test de la
 * chaîne SMS). Rien ne l'a arrêté — relecture, compilation, tests, déploiement. Un numéro se
 * relit comme du décor : l'œil vérifie la forme, pas les chiffres.
 *
 * `scripts/verif-numero-urgence.mjs` interdit désormais qu'une seconde copie réapparaisse.
 *
 * ── DEUX USAGES, UN SEUL NUMÉRO ──────────────────────────────────────────────────────────────
 *
 * C'est à la fois le contact commercial (signature des courriels, « votre interlocuteur
 * dédié ») et, depuis le 30/09/2026, la ligne d'ASTREINTE 24 h/24 communiquée à CDEF31 pour les
 * véhicules immobilisés. Les deux usages coexistent sur le même téléphone ; ce qui les sépare
 * est ce que les écrans en disent, pas le numéro lui-même. D'où les libellés explicites côté
 * application : une ligne d'astreinte qui se remplit de questions cesse de répondre la nuit.
 */

/** Tel qu'il s'écrit et se lit à l'écran. */
export const CONTACT_TEL_AFFICHE = '06 52 07 70 38';

/** Format E.164 — le seul que `tel:` et WhatsApp acceptent sans ambiguïté de pays. */
export const CONTACT_TEL_E164 = '+33652077038';

/** L'adresse écrite, compagne du numéro dans les signatures. */
export const CONTACT_EMAIL = 'contact@vizyoagency.com';
