/**
 * ══ LE NUMÉRO D'URGENCE VÉHICULE — UNE SEULE SOURCE ══════════════════════════════════════════
 *
 * Ce fichier existe à cause d'une erreur réelle. Le 27/09/2026, l'écran « Mise à jour en cours »
 * a été livré en production avec un numéro d'assistance INVENTÉ — proche du vrai, faux quand
 * même. Personne ne l'a vu : un numéro se relit comme du décor. Trois écrans devaient l'afficher,
 * et rien ne les reliait.
 *
 * Désormais tout écran qui propose d'appeler importe D'ICI. Changer de numéro, c'est changer
 * cette ligne — et le test de ce fichier interdit qu'une autre valeur réapparaisse ailleurs.
 *
 * ── CE QUE CE NUMÉRO EST, ET CE QU'IL N'EST PAS ──────────────────────────────────────────────
 *
 * Communiqué à CDEF31 le 30/09/2026, et transmis par eux « aux agent·es de nuit sollicité·es
 * pour déverrouiller les véhicules ». C'est donc une ligne d'ASTREINTE, 24 h/24, pour un
 * véhicule qu'on n'arrive pas à débloquer — pas un support produit. La distinction n'est pas
 * cosmétique : si elle s'efface, la ligne se remplit de questions et ne répond plus la nuit,
 * quand elle est le dernier recours de quelqu'un debout devant une voiture qui ne démarre pas.
 */

import { CONTACT_TEL_AFFICHE, CONTACT_TEL_E164 } from '@vizyo/tracky-shared';

/**
 * Les chiffres eux-mêmes vivent dans `packages/shared` : l'API les affiche aussi (signature des
 * courriels). Ce fichier n'ajoute que ce qui n'a de sens que dans un navigateur — les liens
 * `tel:` et `wa.me`, et le message pré-rempli.
 */
export const URGENCE_TEL_AFFICHE = CONTACT_TEL_AFFICHE;
export const URGENCE_TEL_E164 = CONTACT_TEL_E164;

/** `wa.me` veut le numéro SANS `+` ni espaces. Une seule dérivation, jamais recopiée à la main. */
export const URGENCE_WHATSAPP_URL =
  `https://wa.me/${URGENCE_TEL_E164.replace('+', '')}` as const;

export const URGENCE_TEL_URL = `tel:${URGENCE_TEL_E164}` as const;

/**
 * Le message pré-rempli de WhatsApp. Il demande la PLAQUE en premier : sans elle, la personne
 * d'astreinte ne peut rien faire et perd un aller-retour — la nuit, cet aller-retour coûte des
 * minutes à quelqu'un qui attend dans le froid.
 */
export const URGENCE_WHATSAPP_MESSAGE =
  'Urgence véhicule — plaque : \nCe que je constate : ';

/** Lien WhatsApp complet, message compris. */
export const urgenceWhatsappLien = (plaque?: string): string => {
  const texte = plaque
    ? `Urgence véhicule — plaque : ${plaque}\nCe que je constate : `
    : URGENCE_WHATSAPP_MESSAGE;
  return `${URGENCE_WHATSAPP_URL}?text=${encodeURIComponent(texte)}`;
};
