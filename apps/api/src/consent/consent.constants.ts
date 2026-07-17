/**
 * Version courante des documents (CGU + Politique de confidentialité). Incrémenter
 * cette valeur (ex. quand le texte change) force TOUS les utilisateurs à ré-accepter
 * au prochain accès — le gate compare cette version à la dernière acceptation.
 */
export const CONSENT_VERSION = '2026-07-16';

/**
 * Interrupteur d'ENFORCEMENT du gate — déploiement sûr sur une base d'utilisateurs
 * existante. `CONSENT_ENFORCE=true` active le blocage réel (écran obligatoire côté
 * front + 403 CONSENT_REQUIRED côté API). **OFF par défaut** : on déploie le code, la
 * migration et la capture LP/admin SANS bloquer personne, puis on bascule à `true`
 * une fois le flux vérifié en conditions réelles.
 */
export const CONSENT_ENFORCE = process.env.CONSENT_ENFORCE === 'true';

export const CONSENT_DOC_TYPES = ['CGU', 'PRIVACY'] as const;
export type ConsentDocType = (typeof CONSENT_DOC_TYPES)[number];
