/**
 * Sécurité des connexions — 2FA app ADAPTATIF & OPT-IN par utilisateur.
 *
 * Rien n'est imposé : l'utilisateur active lui-même le 2FA. Une fois activé, le
 * code e-mail n'est demandé QUE sur une vraie anomalie (nouvel appareil / zone
 * inhabituelle) et seulement quand on a assez d'historique pour juger. Objectif
 * = ergonomique, ne jamais harceler.
 */

/** Interrupteur global de secours (kill-switch). `=false` désactive TOUT (gate + proposition). */
export const SECURITY_ENABLED = process.env.SECURITY_ENABLED !== 'false';

/** En-tête HTTP portant l'identifiant d'appareil (localStorage `tracky.device.id`). */
export const DEVICE_ID_HEADER = 'x-device-id';

/** Durée de validité du code, en minutes (aligné sur Vizyo Auth : 10 min). */
export const DEVICE_CODE_TTL_MINUTES = 10;

/** Code d'erreur renvoyé par le gate (le front affiche l'écran de saisie). */
export const DEVICE_VERIFICATION_REQUIRED = 'DEVICE_VERIFICATION_REQUIRED';

/**
 * Nb minimum de connexions GÉOLOCALISÉES avant de pouvoir juger une « zone
 * inhabituelle » (sinon on apprend, sans jamais challenger sur la position).
 */
export const MIN_BASELINE_LOCATED = 3;

/**
 * Rayon (km) au-delà duquel une position est considérée « hors zone habituelle ».
 * Large volontairement : les trajets régionaux ne déclenchent rien (ergonomie).
 */
export const USUAL_RADIUS_KM = 200;

/** Nb de dernières positions gardées comme référence des « zones habituelles ». */
export const USUAL_POINTS_SAMPLE = 60;

/** On ne re-propose pas le 2FA avant ce délai (jours) après une proposition. */
export const PROPOSE_COOLDOWN_DAYS = 14;

/** RGPD — rétention des positions de connexion (login_events). Purge auto au-delà. */
export const LOGIN_EVENT_RETENTION_DAYS = 365;
