/**
 * Version courante des documents (CGU + Politique de confidentialité). Incrémenter
 * cette valeur (ex. quand le texte change) force TOUS les utilisateurs à ré-accepter
 * au prochain accès — le gate compare cette version à la dernière acceptation.
 */
export const CONSENT_VERSION = '2026-07-16';

export const CONSENT_DOC_TYPES = ['CGU', 'PRIVACY'] as const;
export type ConsentDocType = (typeof CONSENT_DOC_TYPES)[number];
