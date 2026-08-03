/**
 * GARDE-FOUS ANTI-SPAM du push d'alerte.
 *
 * Ces valeurs ne sont pas des réglages de confort : elles sont calibrées sur les volumes
 * RÉELS mesurés en production le 2026-07-27, sur 30 jours.
 *
 *   POWER_CUT      CRITICAL   9 903  →  330 / jour
 *   OVERSPEED      WARNING    4 933  →  164 / jour
 *   GEOFENCE_*     WARNING       54  →    2 / jour
 *   GPS_LOST       WARNING       14  →  0,5 / jour
 *   LOW_BATTERY    WARNING        4  →  4 PAR AN
 *   SOS            CRITICAL       3  →  3 PAR AN
 *
 * Deux enseignements qui dictent toute la conception :
 *
 * 1. **La sévérité seule ne protège de rien.** `POWER_CUT` est classé CRITICAL et représente
 *    à lui seul 330 notifications par jour. Un défaut « critique uniquement », qui paraît
 *    prudent, est en réalité le PIRE choix possible. Origine : la trame Coban `ac alarm` se
 *    déclenche à chaque coupure de contact sur un boîtier câblé après contact — du
 *    stationnement normal, lu comme une alarme critique. Les 9 902 lignes ont d'ailleurs été
 *    acquittées EN MASSE à la même seconde par un humain : quelqu'un balayait déjà ce bruit
 *    à la main.
 *
 * 2. **Les alertes qui comptent vraiment sont RARES.** SOS et batterie faible : 3 et 4 par AN.
 *    Elles ne seront jamais noyées par un plafond horaire — mais elles seraient invisibles
 *    au milieu de 330 fausses alarmes quotidiennes.
 *
 * D'où la stratégie : couper le bruit connu PAR TYPE, et borner le reste PAR DÉBIT.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 3. **UNE ALERTE N'EST PAS UNE NOTIFICATION** — l'enseignement le plus cher, ajouté
 *    le 2026-08-03 après un incident client.
 *
 *    Le tableau ci-dessus compte des ALERTES. Les décisions de coupure par type, elles,
 *    ont été prises comme s'il comptait des notifications. C'est faux : entre les deux il
 *    y a {@link PUSH_COOLDOWN_MS}, qui replie 15 minutes d'événements identiques en un
 *    seul push. Recompté par ÉPISODES, OVERSPEED ne vaut pas 164 notifications par jour
 *    mais **1,6** — cent fois moins. On avait rendu tout un type muet pour un bruit que
 *    l'anti-spam absorbait déjà, et un gérant de flotte n'a reçu aucune alerte de vitesse
 *    sur ses véhicules pendant des semaines.
 *
 *    ⚠️ AVANT DE COUPER UN TYPE PAR DÉFAUT : compter les épisodes, jamais les lignes.
 *    La requête est simple — regrouper les alertes d'un même véhicule séparées de plus de
 *    15 minutes — et l'écart entre les deux comptages peut être d'un facteur 100.
 * ══════════════════════════════════════════════════════════════════════════════════════
 */

import type { AlertType } from './alert.dto';

/**
 * Types coupés PAR DÉFAUT.
 *
 * ⚠️ Ce n'est PAS un jugement sur leur importance : un vrai arrachement de batterie compte.
 * C'est un constat de RAPPORT SIGNAL/BRUIT. L'utilisateur les rallume en un geste depuis
 * ses réglages, et le centre de notifications montre en permanence combien d'événements ont
 * été retenus — donc rien n'est caché, c'est juste silencieux par défaut.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ OVERSPEED A ÉTÉ RETIRÉ DE CETTE LISTE (2026-08-03) — et le POURQUOI compte, parce
 * que l'erreur d'origine est facile à refaire.
 *
 * Le défaut coupait OVERSPEED sur la foi d'un chiffre : « 164 alertes par jour ». Le chiffre
 * était juste, la conclusion fausse — **une alerte n'est pas une notification**. Entre les
 * deux il y a {@link PUSH_COOLDOWN_MS} : 15 minutes par (utilisateur, type, véhicule).
 *
 * Mesure sur 30 jours de production, en regroupant les alertes en épisodes séparés de plus
 * de 15 minutes, c'est-à-dire en comptant les push qui SERAIENT réellement partis :
 *
 *     alertes OVERSPEED brutes ................ 5 401   (un seul véhicule, une seule flotte)
 *     notifications réellement envoyées .......    48   soit 1,6 par jour
 *     pire journée (15/07 : 1 337 alertes) ....     3 notifications
 *     maximum absolu observé (20/07) ..........     7 notifications
 *
 * Un boîtier Coban émet une trame toutes les 3 secondes ; un véhicule qui roule 9 minutes
 * au-dessus du seuil produit donc 28 alertes — et UN SEUL push. On avait rendu tout un type
 * muet pour un bruit que l'anti-spam absorbait déjà.
 *
 * Le coût de l'erreur, lui, était réel : le gérant d'une flotte ne recevait AUCUNE alerte de
 * vitesse sur ses propres véhicules, sans l'avoir demandé et sans le savoir. C'est la
 * fonction qu'il attend en premier d'un traceur.
 *
 * ⚠️ POWER_CUT reste coupé, sur décision explicite : il est réservé au super-admin, et sa
 * mesure d'origine (330/jour) n'a pas été refaite avec la même méthode. Avant de le retirer
 * à son tour, REFAIRE LE COMPTAGE PAR ÉPISODES — pas par alertes.
 * ══════════════════════════════════════════════════════════════════════════════════════
 */
export const DEFAULT_MUTED_TYPES: readonly AlertType[] = ['POWER_CUT'];

/**
 * Délai minimal entre deux push de MÊME (utilisateur, type, véhicule).
 *
 * 15 min : au-delà d'une notification par quart d'heure pour le même problème sur le même
 * véhicule, on n'informe plus, on harcèle. Les événements survenus pendant ce délai ne sont
 * pas jetés — ils sont COMPTÉS et repliés dans le push suivant (« ×4 »).
 */
export const PUSH_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Plafond ABSOLU de push par utilisateur et par heure, tous types confondus.
 *
 * 12/heure. Dernier rempart : même si l'utilisateur active tout, même si un nouveau type
 * d'alerte se met à tomber en boucle, même si un garde-fou par type est contourné par un
 * cas non prévu, son téléphone ne vibrera pas plus de 12 fois dans l'heure. Le dépassement
 * est TRACÉ (statut SUPPRESSED, raison « plafond horaire ») pour rester visible.
 */
export const PUSH_MAX_PER_HOUR = 12;

/**
 * Le plafond horaire ne doit JAMAIS retenir ces types : ils sont à la fois rarissimes
 * (quelques unités par an) et vitaux. Mieux vaut une notification de trop qu'un appel SOS
 * avalé par un compteur.
 */
export const PUSH_BYPASS_RATE_LIMIT: readonly AlertType[] = [
  'SOS',
  'ACCIDENT',
  'COLLISION',
  'TOW',
  'TAMPER',
  'ILLEGAL_IGNITION',
];

/** Vrai si ce type traverse le plafond horaire sans être retenu. */
export function bypassesRateLimit(type: AlertType): boolean {
  return PUSH_BYPASS_RATE_LIMIT.includes(type);
}

/** Motif de non-envoi — repris tel quel dans le centre de notifications. */
export type SuppressionReason =
  | 'rollout'
  | 'preference_disabled'
  | 'preference_type_muted'
  /**
   * FAMILLE coupée (entretien, rapports…). Distinct de `preference_type_muted` : ce n'est
   * pas le même réglage, et les confondre enverrait l'administrateur chercher un type
   * d'alerte coupé alors que c'est une famille entière qui l'est.
   */
  | 'preference_category_muted'
  /**
   * L'utilisateur n'a pas `alerts_view`. Distinct de tous les autres motifs : ce n'est
   * pas un choix de sa part, c'est un refus du systeme — et cela ne se corrige pas dans
   * ses reglages mais dans ses permissions.
   */
  | 'no_permission'
  /**
   * Il a le droit de voir des alertes, mais ce vehicule n'est pas dans son perimetre
   * d'acces (UserVehicleAccess). Separe de `no_permission` parce que la correction est
   * ailleurs : elargir le perimetre, pas accorder une permission.
   */
  | 'out_of_scope'
  | 'preference_severity'
  /**
   * Coupé par le DÉFAUT DU SYSTÈME, pas par l'utilisateur : il n'a aucune ligne de
   * préférences, il n'a jamais ouvert cet écran.
   *
   * ⚠️ Pourquoi ce motif existe (incident du 2026-08-03). Le gérant d'une flotte n'a jamais
   * reçu une seule alerte de vitesse sur ses véhicules. Le centre de notifications affichait
   * « Ce type est coupé dans ses réglages » — 28 fois. C'est faux : il n'avait pas de
   * réglages. Le système avait décidé, et le journal le faisait passer pour lui.
   *
   * Un motif qui désigne le mauvais responsable ne fait pas que se tromper : il envoie
   * chercher la correction là où elle n'est pas. On aurait pu passer des heures à regarder
   * l'écran de réglages d'un client qui n'y avait jamais touché.
   *
   * Le code SAVAIT déjà distinguer les deux cas — mais seulement dans une ligne de log,
   * jamais dans le motif enregistré. L'information existait, elle n'allait pas jusqu'à
   * l'écran ; c'est exactement la même chose que ne pas l'avoir.
   */
  | 'default_type_muted'
  /** Idem pour le SEUIL : sous le seuil par défaut, sans réglage personnel. */
  | 'default_severity'
  | 'cooldown'
  | 'hourly_cap'
  | 'no_device';

/** Libellés FR des motifs, source unique pour l'API et l'écran d'administration. */
export const SUPPRESSION_LABELS: Record<SuppressionReason, string> = {
  rollout: 'Push non ouvert à ce rôle',
  preference_disabled: 'Notifications désactivées par l’utilisateur',
  preference_type_muted: 'Ce type est coupé dans ses réglages',
  preference_category_muted: 'Cette famille est coupée dans ses réglages',
  no_permission: 'Pas la permission de consulter les alertes',
  out_of_scope: 'Ce véhicule est hors de son périmètre d’accès',
  preference_severity: 'Sous le seuil de sévérité choisi',
  // ⚠️ Ces deux libellés ne doivent JAMAIS dire « ses réglages » : c'est précisément ce
  // mensonge qu'ils corrigent. Ils nomment le système comme responsable, et indiquent
  // l'action utile — ouvrir les réglages une première fois.
  default_type_muted: 'Coupé par défaut — cet utilisateur n’a aucun réglage personnel',
  default_severity: 'Sous le seuil par défaut — cet utilisateur n’a aucun réglage personnel',
  cooldown: 'Regroupée — même alerte trop récente',
  hourly_cap: 'Plafond horaire atteint',
  no_device: 'Aucun appareil abonné',
};
