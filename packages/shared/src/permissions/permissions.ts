/**
 * Source unique des permissions Tracky — partagee entre apps/api et apps/web.
 *
 * Les permissions JSON portent l'autorisation granulaire d'un user sur un scope
 * donne. Aujourd'hui un user a un set de permissions globales (User.permissions)
 * ET potentiellement un override per-scope via UserVehicleAccess.permissions
 * (Phase 1 refonte — cf. plan sharded-mixing-shore.md).
 *
 * Regle de resolution per-vehicle (PermissionsResolverService cote API) :
 *   1. Trouver la ligne UserVehicleAccess qui couvre ce vehicleId.
 *   2. Tri "specifique gagne" : VEHICLE > GROUP > ALL. Prendre la premiere.
 *   3. Si sa `permissions` est null → fallback User.permissions.
 *   4. Si toujours null → getDefaultPermissions(role).
 *
 * SUPER_ADMIN et FLEET_ADMIN bypass (tous booleens true).
 */

/**
 * Espace depot (2026-08) — `DEPOT` est un role LATERAL, pas un rang.
 *
 * Ne PAS le glisser dans une comparaison de niveau : son perimetre n'est pas un
 * sous-ensemble de la flotte, c'est un axe different. Un VIEWER voit N vehicules en
 * permanence ; un DEPOT voit UN vehicule PENDANT une fenetre horaire, parce qu'une
 * mission l'y autorise, et rien du tout en dehors. Aucune relation d'inclusion ne
 * relie les deux — cf. design/A1-ROLE-DEPOT.md § 1 et design/DECISIONS.md D3.
 */
export type UserRoleSlug = 'SUPER_ADMIN' | 'FLEET_ADMIN' | 'FLEET_MANAGER' | 'VIEWER' | 'NIGHT_WATCHMAN' | 'DRIVER' | 'DEPOT';

export interface UserPermissions {
  vehicles_view: boolean;
  vehicles_create: boolean;
  vehicles_edit: boolean;
  vehicles_delete: boolean;
  /** Couper / redemarrer le moteur du vehicule. Validation metier en plus : vitesse < 20 km/h, position fraiche, fix GPS valide. */
  engine_control: boolean;
  /** Mode vie privee : activer/desactiver la pause de collecte des positions d'un vehicule. OFF par defaut sauf admin. */
  privacy_manage: boolean;
  /** Sprint 3 — gerer les horaires (schedules) marche/coupure d'un vehicule. Toggle per-user (veilleur de nuit, OFF par defaut). */
  schedules_manage: boolean;
  groups_view: boolean;
  groups_manage: boolean;
  geofences_view: boolean;
  geofences_manage: boolean;
  alerts_view: boolean;
  alerts_acknowledge: boolean;
  /** Configurer les regles d'alertes (seuils, canaux, escalade) pour la flotte ou par vehicule. */
  alerts_configure: boolean;
  reports_view: boolean;
  /** Exporter les rapports (PDF / Excel / CSV) — séparé de la simple lecture (anti-exfiltration de l'historique GPS). */
  reports_export: boolean;
  /**
   * Voir la traçabilité fine des trajets : analyse déterministe (arrêts, excès OSM, éco-conduite,
   * à-coups, ralenti, conso/CO₂), scores de conduite / classement, et suivi carburant
   * (rapport, stations, calibration « méthode du plein » en lecture).
   */
  trips_view: boolean;
  /** Renseigner / modifier / supprimer les pleins (méthode du plein) — recalibre les coûts carburant. */
  fuel_manage: boolean;
  users_view: boolean;
  users_manage: boolean;
  /** Voir la liste des conducteurs et leur affectation aux vehicules. */
  drivers_view: boolean;
  /** Creer/modifier/archiver des conducteurs et les affecter aux vehicules. */
  drivers_manage: boolean;
  /** Voir le parc de cartes SIM (de sa flotte) et leur conso data. */
  sims_view: boolean;
  /** Assigner / detacher une carte SIM a un tracker. */
  sims_assign: boolean;
  /**
   * Sprint 4 — Declencher l'ecoute audio a distance du vehicule (micro). Capacite
   * LEGALEMENT SENSIBLE : OFF par defaut PARTOUT sauf admin, gate env supplementaire
   * (desactivee en production sans flag explicite, cf. AudioMonitoringGuard).
   */
  audio_monitoring: boolean;

  /**
   * Sprint 7 — Voir l'agenda (calendrier maintenance/incidents) et signaler un
   * incident sur un vehicule accessible. OFF par defaut sauf SUPER_ADMIN/FLEET_ADMIN ;
   * accordable par utilisateur.
   */
  agenda_view: boolean;
  /** Sprint 7 — Gerer la maintenance : creer/editer/resoudre les evenements + plans recurrents. */
  agenda_manage: boolean;

  /**
   * Sprint 8 — Reservations de vehicules (creneau + criteres). Trois niveaux :
   * voir (reservations & disponibilites), demander (deposer une demande dans son
   * perimetre), gerer (valider/refuser/editer/annuler/supprimer/auto-affecter).
   * OFF par defaut sauf SUPER_ADMIN/FLEET_ADMIN ; accordables par utilisateur.
   */
  reservations_view: boolean;
  reservations_request: boolean;
  reservations_manage: boolean;

  /**
   * Sprint 9 — Copilote IA d'optimisation : lancer les propositions IA
   * (enrichissement de capacite du parc + classement de placement). L'IA PROPOSE
   * seulement ; l'APPLICATION d'une proposition reutilise les perms existantes
   * (vehicles_edit pour ecrire une capacite, reservations_* pour une reservation).
   * OFF par defaut sauf SUPER_ADMIN/FLEET_ADMIN ; accordable par utilisateur.
   */
  ai_optimize: boolean;
  /** Générer les récits IA d'un trajet (résumé vulgarisé + Trust Score + conseils). Appel LLM facturé. */
  ai_narrate: boolean;
  /** Configurer l'IA de la flotte : couper / activer l'assistance IA pour toute la société. */
  ai_configure: boolean;

  /**
   * Facturation & options : voir les informations d'abonnement / facturation et
   * (à terme) gérer le moyen de paiement. Par défaut réservé aux admins
   * (SUPER_ADMIN / FLEET_ADMIN) ; accordable par utilisateur. Pas encore de
   * backend de paiement — la perm gate aujourd'hui l'onglet « Facturation & options ».
   */
  billing_manage: boolean;

  /**
   * feat/comptes-conducteurs — Générer / imprimer les QR de déverrouillage des véhicules
   * (depuis la fiche véhicule, la liste, et la feuille « tous les QR »). Le QR encode un
   * deep-link signé vers l'écran conducteur. Défaut super/fleet-admin ; accordable par utilisateur.
   */
  qr_manage: boolean;

  /**
   * Lieux clés (2026-07) — consulter le référentiel des lieux de la flotte : stations-service
   * fréquentées (passages détectés avec arrêt réel) et parkings / stationnements récurrents.
   */
  places_view: boolean;

  /**
   * Lieux clés — créer / modifier / supprimer les lieux de la flotte : valider une station-service
   * détectée (elle passe en « station de la flotte » sur la carte), poser un parking ou un
   * stationnement récurrent à la main (ex. « CDEF Launaguet »). Accordé aux managers par défaut.
   */
  places_manage: boolean;

  /**
   * Lieux clés — LANCER une analyse IA d'un lieu (enrichissement OSM + synthèse LLM). Séparée de
   * `places_manage` parce qu'elle CONSOMME DES TOKENS (coût réel) : on peut donc laisser gérer les
   * lieux sans autoriser à déclencher des analyses. Réservée aux admins par défaut, accordable.
   * Ne suffit JAMAIS seule : l'IA reste soumise au kill-switch global `placeAnalysis` et à
   * l'interrupteur société `Fleet.aiEnabled` (lui-même piloté par l'abonnement).
   */
  places_analyze: boolean;

  /**
   * Integration partenaire (Tracky x Maestroo) — connecter la flotte a une application
   * partenaire, choisir les CATEGORIES de donnees partagees, et COUPER le partage (en
   * totalite ou categorie par categorie) a tout moment. C'est un acte a consequence :
   * il expose des donnees de la flotte a une application tierce. Reserve au fleet-admin
   * par defaut ; accordable, jamais implicite.
   */
  integrations_manage: boolean;

  /**
   * Espace depot (2026-08) — voir les missions dont on est le depot destinataire.
   * Le perimetre n'est PAS la flotte : il est calcule depuis Mission.depotUserId,
   * A CHAQUE REQUETE, jamais depuis UserVehicleAccess ni Fleet. OFF par defaut pour
   * tous les roles sauf DEPOT, VIEWER et DRIVER (cf. design/A1-ROLE-DEPOT.md § 2).
   */
  missions_view: boolean;
  /** Creer / modifier / annuler une mission et designer son depot destinataire. */
  missions_manage: boolean;
  /** Generer un lien public temporaire de suivi vers un client final (15 min par defaut). */
  mission_share: boolean;
  /**
   * Voir le nom et le telephone du conducteur d'une mission dont on est destinataire.
   * Le telephone est masque COTE API (« 06 12 •• •• 47 ») : le numero complet ne quitte
   * jamais le serveur, et le bouton d'appel passe par un endpoint qui journalise l'acces.
   */
  driver_contact_view: boolean;
}

const VIEWER_DEFAULTS: UserPermissions = {
  reports_export: false,
  trips_view: true,
  fuel_manage: false,
  ai_narrate: false,
  ai_configure: false,
  vehicles_view: true,
  vehicles_create: false,
  vehicles_edit: false,
  vehicles_delete: false,
  engine_control: false,
  privacy_manage: false,
  schedules_manage: false,
  groups_view: true,
  groups_manage: false,
  geofences_view: true,
  geofences_manage: false,
  alerts_view: true,
  alerts_acknowledge: false,
  alerts_configure: false,
  reports_view: true,
  users_view: false,
  users_manage: false,
  drivers_view: true,
  drivers_manage: false,
  sims_view: false,
  sims_assign: false,
  audio_monitoring: false,
  agenda_view: false,
  agenda_manage: false,
  reservations_view: false,
  reservations_request: false,
  reservations_manage: false,
  ai_optimize: false,
  billing_manage: false,
  qr_manage: false,
  places_view: true,
  places_manage: false,
  places_analyze: false,
  integrations_manage: false,
  // Le lecteur voit les missions de la flotte, mais n'en cree aucune, ne partage
  // rien et n'accede pas aux coordonnees des conducteurs.
  missions_view: true,
  missions_manage: false,
  mission_share: false,
  driver_contact_view: false,
};

const FLEET_MANAGER_DEFAULTS: UserPermissions = {
  reports_export: true,
  trips_view: true,
  fuel_manage: true,
  ai_narrate: true,
  ai_configure: false,
  vehicles_view: true,
  vehicles_create: true,
  vehicles_edit: true,
  vehicles_delete: true,
  engine_control: false,
  privacy_manage: false,
  schedules_manage: true,
  groups_view: true,
  groups_manage: true,
  geofences_view: true,
  geofences_manage: true,
  alerts_view: true,
  alerts_acknowledge: true,
  alerts_configure: false,
  reports_view: true,
  users_view: true,
  users_manage: false,
  drivers_view: true,
  drivers_manage: true,
  sims_view: true,
  sims_assign: false,
  audio_monitoring: false,
  agenda_view: false,
  agenda_manage: false,
  reservations_view: false,
  reservations_request: false,
  reservations_manage: false,
  ai_optimize: false,
  billing_manage: false,
  qr_manage: false,
  places_view: true,
  // Le manager gère les lieux clés par défaut (validation de stations, pose de parkings).
  places_manage: true,
  // …mais PAS l'analyse IA (elle consomme des tokens) : un admin peut l'accorder.
  places_analyze: false,
  integrations_manage: false,
  // Le gestionnaire est l'exploitant : c'est lui qui cree les missions, designe le
  // depot destinataire et partage un suivi.
  missions_view: true,
  missions_manage: true,
  mission_share: true,
  driver_contact_view: true,
};

const ADMIN_DEFAULTS: UserPermissions = {
  reports_export: true,
  trips_view: true,
  fuel_manage: true,
  ai_narrate: true,
  ai_configure: true,
  vehicles_view: true,
  vehicles_create: true,
  vehicles_edit: true,
  vehicles_delete: true,
  engine_control: true,
  privacy_manage: true,
  schedules_manage: true,
  groups_view: true,
  groups_manage: true,
  geofences_view: true,
  geofences_manage: true,
  alerts_view: true,
  alerts_acknowledge: true,
  alerts_configure: true,
  reports_view: true,
  users_view: true,
  users_manage: true,
  drivers_view: true,
  drivers_manage: true,
  sims_view: true,
  sims_assign: true,
  audio_monitoring: true,
  agenda_view: true,
  agenda_manage: true,
  reservations_view: true,
  reservations_request: true,
  reservations_manage: true,
  ai_optimize: true,
  billing_manage: true,
  qr_manage: true,
  places_view: true,
  places_manage: true,
  places_analyze: true,
  integrations_manage: true,
  missions_view: true,
  missions_manage: true,
  mission_share: true,
  driver_contact_view: true,
};

/**
 * Sprint 3 — « veilleur de nuit » : voit les vehicules et peut couper/redemarrer
 * le moteur (bloquer/debloquer), rien d'autre. `schedules_manage` est OFF par
 * defaut (toggle per-user accorde par un admin). Aucune autre capacite.
 */
const NIGHT_WATCHMAN_DEFAULTS: UserPermissions = {
  reports_export: false,
  trips_view: false,
  fuel_manage: false,
  ai_narrate: false,
  ai_configure: false,
  vehicles_view: true,
  vehicles_create: false,
  vehicles_edit: false,
  vehicles_delete: false,
  engine_control: true,
  privacy_manage: false,
  schedules_manage: false,
  groups_view: false,
  groups_manage: false,
  geofences_view: false,
  geofences_manage: false,
  alerts_view: false,
  alerts_acknowledge: false,
  alerts_configure: false,
  reports_view: false,
  users_view: false,
  users_manage: false,
  drivers_view: false,
  drivers_manage: false,
  sims_view: false,
  sims_assign: false,
  audio_monitoring: false,
  agenda_view: false,
  agenda_manage: false,
  reservations_view: false,
  reservations_request: false,
  reservations_manage: false,
  ai_optimize: false,
  billing_manage: false,
  qr_manage: false,
  // Veilleur de nuit : périmètre volontairement minimal (seuls vehicles_view + engine_control
  // sont vrais par défaut — invariant vérifié par night-watchman.security.spec).
  places_view: false,
  places_manage: false,
  places_analyze: false,
  integrations_manage: false,
  // Le veilleur reste a zero sur les missions : son metier est nocturne, les missions
  // sont diurnes, et il travaille sans aucune donnee de conducteur (A1 § 2).
  missions_view: false,
  missions_manage: false,
  mission_share: false,
  driver_contact_view: false,
};

/**
 * feat/comptes-conducteurs — « conducteur » : voit ses véhicules, rien d'autre par défaut.
 * `engine_control` (déverrouiller le moteur) et `privacy_manage` (mode vie privée) sont OFF par
 * défaut mais ACCORDABLES par le fleet-admin sur le périmètre du conducteur (UserVehicleAccess).
 * Volontairement plus restreint que le veilleur (qui a engine_control ON d'office).
 */
const DRIVER_DEFAULTS: UserPermissions = {
  reports_export: false,
  trips_view: false,
  fuel_manage: false,
  ai_narrate: false,
  ai_configure: false,
  vehicles_view: true,
  vehicles_create: false,
  vehicles_edit: false,
  vehicles_delete: false,
  engine_control: false,
  // Lot 2 — le conducteur gère SES exceptions de vie privée. Bornes serveur inchangées :
  // uniquement le véhicule qu'il conduit, et JAMAIS pendant une plage de temps de travail.
  privacy_manage: true,
  schedules_manage: false,
  groups_view: false,
  groups_manage: false,
  geofences_view: false,
  geofences_manage: false,
  alerts_view: false,
  alerts_acknowledge: false,
  alerts_configure: false,
  reports_view: false,
  users_view: false,
  users_manage: false,
  drivers_view: false,
  drivers_manage: false,
  sims_view: false,
  sims_assign: false,
  audio_monitoring: false,
  agenda_view: false,
  agenda_manage: false,
  reservations_view: false,
  reservations_request: false,
  reservations_manage: false,
  ai_optimize: false,
  billing_manage: false,
  qr_manage: false,
  places_view: false,
  places_manage: false,
  places_analyze: false,
  integrations_manage: false,
  // Le conducteur voit LES SIENNES (borne serveur : missions dont il est le driver).
  // `driver_contact_view` n'a pas de sens pour lui : c'est son propre numero.
  missions_view: true,
  missions_manage: false,
  mission_share: false,
  driver_contact_view: false,
};

/**
 * Espace depot (2026-08) — « depot » : un TIERS EN LECTURE SEULE, dont le perimetre est
 * borne par la mission. Ce n'est pas un utilisateur de la flotte.
 *
 * TOUT est a false sauf quatre lignes. Ces quatre-la ne donnent aucun acces general :
 * elles ouvrent une porte que `DepotScopeGuard` referme a chaque requete sur le
 * perimetre reel (Mission.depotUserId + fenetre horaire). Hors perimetre, l'API repond
 * 403 — jamais 200 avec un tableau vide.
 *
 * Ce qui reste explicitement FERME, et pourquoi :
 *   vehicles_view      — jamais d'acces flotte. La cle du depot est la plaque.
 *   reports_*          — l'export depot passe par un endpoint dedie (A3 § 8).
 *   engine_control     — aucune ecriture sur un vehicule, jamais.
 *   agenda_*, reservations_* — l'agenda est l'outil du transporteur.
 *
 * cf. design/A1-ROLE-DEPOT.md § 2.
 */
const DEPOT_DEFAULTS: UserPermissions = {
  // — Les quatre seules capacites ouvertes —
  /** Ses missions uniquement : `where` Prisma sur depotUserId. */
  missions_view: true,
  /** Les trajets rattaches a ses missions uniquement. */
  trips_view: true,
  /** Un lien public temporaire, pour ses propres missions uniquement. */
  mission_share: true,
  /** Le conducteur de la mission en cours uniquement, telephone masque cote API. */
  driver_contact_view: true,

  // — Tout le reste est ferme —
  missions_manage: false,
  vehicles_view: false,
  vehicles_create: false,
  vehicles_edit: false,
  vehicles_delete: false,
  engine_control: false,
  privacy_manage: false,
  schedules_manage: false,
  groups_view: false,
  groups_manage: false,
  geofences_view: false,
  geofences_manage: false,
  alerts_view: false,
  alerts_acknowledge: false,
  alerts_configure: false,
  reports_view: false,
  reports_export: false,
  fuel_manage: false,
  users_view: false,
  users_manage: false,
  drivers_view: false,
  drivers_manage: false,
  sims_view: false,
  sims_assign: false,
  audio_monitoring: false,
  agenda_view: false,
  agenda_manage: false,
  reservations_view: false,
  reservations_request: false,
  reservations_manage: false,
  ai_optimize: false,
  ai_narrate: false,
  ai_configure: false,
  billing_manage: false,
  qr_manage: false,
  places_view: false,
  places_manage: false,
  places_analyze: false,
  integrations_manage: false,
};

export function getDefaultPermissions(role: UserRoleSlug): UserPermissions {
  switch (role) {
    case 'VIEWER':
      return { ...VIEWER_DEFAULTS };
    case 'FLEET_MANAGER':
      return { ...FLEET_MANAGER_DEFAULTS };
    case 'NIGHT_WATCHMAN':
      return { ...NIGHT_WATCHMAN_DEFAULTS };
    case 'DRIVER':
      return { ...DRIVER_DEFAULTS };
    case 'DEPOT':
      return { ...DEPOT_DEFAULTS };
    case 'FLEET_ADMIN':
    case 'SUPER_ADMIN':
      return { ...ADMIN_DEFAULTS };
    default:
      // Role inconnu/absent : on retombe sur le set le plus restrictif.
      return { ...VIEWER_DEFAULTS };
  }
}

export const PERMISSION_KEYS = Object.keys(VIEWER_DEFAULTS) as (keyof UserPermissions)[];

/**
 * Roles FERMES : leur jeu de permissions est fixe par le role lui-meme et ne se
 * negocie pas — ni en accordant (ils ne delèguent rien), ni en recevant (on ne
 * peut pas leur ajouter une capacite depuis l'interface ni depuis l'API).
 *
 * `DEPOT` est ferme parce que son perimetre n'est pas un jeu de cases a cocher :
 * il est calcule a chaque requete depuis `Mission.depotUserId` et la fenetre
 * horaire. Lui accorder `vehicles_view` ne lui ouvrirait pas « la flotte » — ca
 * produirait un etat incoherent ou l'interface promet un acces que le garde
 * refuse. Cf. A5 § 4 : « Le perimetre d'un depot est fixe par ses missions. »
 */
export const CLOSED_ROLES: readonly UserRoleSlug[] = ['DEPOT'] as const;

export function isClosedRole(role: UserRoleSlug): boolean {
  return CLOSED_ROLES.includes(role);
}

/** Un jeu de permissions exhaustif, tout a `false`. */
function allPermissionsFalse(): UserPermissions {
  const out = {} as UserPermissions;
  for (const key of PERMISSION_KEYS) out[key] = false;
  return out;
}

/**
 * Permissions a ecrire pour un utilisateur d'un role CIBLE donne.
 *
 * C'est le point d'entree que doivent employer les routes qui creent ou editent un
 * compte (users.controller, invitations) — `clampPermissions` seul ne suffit pas :
 * il borne au GRANTER, pas a la CIBLE. Un FLEET_ADMIN (qui detient tout) passant
 * `{ vehicles_view: true }` sur un compte DEPOT franchirait le clamp sans encombre.
 *
 * Pour un role ferme, la demande est ignoree : on ecrit les defauts du role, point.
 */
export function permissionsForTargetRole(
  targetRole: UserRoleSlug,
  requested: Partial<UserPermissions> | null | undefined,
  granter: { role: UserRoleSlug; permissions?: Partial<UserPermissions> | null },
): UserPermissions {
  const targetDefaults = getDefaultPermissions(targetRole);
  if (isClosedRole(targetRole)) return targetDefaults;
  return clampPermissions(requested, granter, targetDefaults);
}

/**
 * Permissions effectives d'un "granter" (inviteur / editeur) pour borner ce
 * qu'il peut accorder a autrui. SUPER_ADMIN et FLEET_ADMIN sont privilegies
 * (bypass = toutes permissions true). Les autres roles partent de leurs defauts
 * de role, surcharges par leur set explicite (User.permissions).
 */
export function effectiveGranterPermissions(granter: {
  role: UserRoleSlug;
  permissions?: Partial<UserPermissions> | null;
}): UserPermissions {
  if (granter.role === 'SUPER_ADMIN' || granter.role === 'FLEET_ADMIN') {
    return { ...ADMIN_DEFAULTS };
  }
  // Roles FERMES : ils ne delèguent rien, quoi que porte leur set explicite.
  // Un DEPOT n'invite personne. Le court-circuit est le pendant exact du bypass
  // admin ci-dessus — sans lui, `effectiveGranterPermissions` renverrait les
  // defauts du role, dont les 4 capacites ouvertes, et un depot pourrait les
  // conferer a autrui. Exigence explicite d'A1 § 2.
  if (isClosedRole(granter.role)) {
    return allPermissionsFalse();
  }
  const out = getDefaultPermissions(granter.role);
  const explicit = granter.permissions;
  if (explicit) {
    for (const key of PERMISSION_KEYS) {
      if (typeof explicit[key] === 'boolean') {
        out[key] = explicit[key] as boolean;
      }
    }
  }
  return out;
}

/**
 * Borne (clamp) un set de permissions demande pour qu'AUCUNE permission ne
 * depasse ce que le granter detient lui-meme. Invariant de securite : un
 * inviteur/editeur ne peut jamais accorder une capacite qu'il n'a pas — ce qui
 * empeche l'escalade de privileges via un compte-pantin (ex: un FLEET_MANAGER
 * sans engine_control qui inviterait un VIEWER avec engine_control=true).
 *
 * `requested` peut etre partiel ou non-fiable (corps de requete) : les cles
 * absentes retombent sur `fallback` (typiquement les defauts du role cible),
 * puis l'ensemble est borne au granter. Renvoie un UserPermissions exhaustif.
 */
export function clampPermissions(
  requested: Partial<UserPermissions> | null | undefined,
  granter: { role: UserRoleSlug; permissions?: Partial<UserPermissions> | null },
  fallback: UserPermissions,
): UserPermissions {
  const granterPerms = effectiveGranterPermissions(granter);
  const out = {} as UserPermissions;
  for (const key of PERMISSION_KEYS) {
    const wanted =
      requested && typeof requested[key] === 'boolean'
        ? (requested[key] as boolean)
        : fallback[key];
    out[key] = wanted && granterPerms[key];
  }
  return out;
}

/**
 * Variante "partielle" du clamp, pour les overrides par scope
 * (UserVehicleAccess.permissions). Ne touche QUE les cles presentes dans
 * `requested` — preserve la semantique d'heritage (cle absente = herite, on ne
 * la materialise pas) — et borne chaque cle presente aux permissions du granter
 * (anti-escalade). Pas de `fallback` : ne depend donc pas du role cible.
 */
export function clampPartialPermissions(
  requested: Partial<UserPermissions>,
  granter: { role: UserRoleSlug; permissions?: Partial<UserPermissions> | null },
): Partial<UserPermissions> {
  const granterPerms = effectiveGranterPermissions(granter);
  const out: Partial<UserPermissions> = {};
  for (const key of PERMISSION_KEYS) {
    if (typeof requested[key] === 'boolean') {
      out[key] = (requested[key] as boolean) && granterPerms[key];
    }
  }
  return out;
}

export interface PermissionLabel {
  group: string;
  label: string;
  /** Description courte affichee en tooltip dans la matrice 2D. */
  description?: string;
}

/**
 * Labels FR pour l'UI matrice (apps/web) et le drawer. Regroupes par module metier.
 * Toute nouvelle permission DOIT etre ajoutee ici sinon TS rale (Record exhaustif).
 */
export const PERMISSION_LABELS: Record<keyof UserPermissions, PermissionLabel> = {
  vehicles_view: { group: 'Vehicules', label: 'Voir les vehicules' },
  vehicles_create: { group: 'Vehicules', label: 'Ajouter un vehicule' },
  vehicles_edit: { group: 'Vehicules', label: 'Modifier un vehicule' },
  vehicles_delete: { group: 'Vehicules', label: 'Supprimer un vehicule' },
  engine_control: {
    group: 'Vehicules',
    label: 'Couper / redemarrer le moteur',
    description: 'Action sensible. Soumise aux contraintes metier (vitesse, fix GPS).',
  },
  privacy_manage: {
    group: 'Vehicules',
    label: 'Gerer le mode vie privee',
    description: 'Activer/desactiver la pause de collecte des positions d\'un vehicule (aucune position enregistree pendant le mode prive).',
  },

  schedules_manage: {
    group: 'Horaires',
    label: 'Gerer les horaires marche/coupure',
    description: 'Definir les plages horaires d\'allumage/coupure automatique d\'un vehicule.',
  },
  groups_view: { group: 'Groupes', label: 'Voir les groupes de vehicules' },
  groups_manage: { group: 'Groupes', label: 'Gerer les groupes (creer, renommer, supprimer)' },
  geofences_view: { group: 'Geofences', label: 'Voir les geofences' },
  geofences_manage: { group: 'Geofences', label: 'Gerer les geofences' },
  alerts_view: { group: 'Alertes', label: 'Voir les alertes' },
  alerts_acknowledge: { group: 'Alertes', label: 'Acquitter les alertes' },
  alerts_configure: { group: 'Alertes', label: 'Configurer les regles d\'alertes', description: 'Creer, modifier et supprimer les regles de notification et seuils par vehicule.' },
  reports_view: { group: 'Rapports', label: 'Voir les rapports' },
  reports_export: {
    group: 'Rapports',
    label: 'Exporter les rapports (PDF / Excel / CSV)',
    description: 'Telecharger les rapports et exports de donnees. Separe de la simple lecture pour eviter l\'exfiltration de l\'historique GPS.',
  },
  trips_view: {
    group: 'Trajets & analyse',
    label: 'Voir l\'analyse des trajets & les scores',
    description: 'Tracabilite fine : arrets, exces de vitesse (limites OSM), eco-conduite, conso/CO2, scores de conduite / classement et suivi carburant.',
  },
  fuel_manage: {
    group: 'Trajets & analyse',
    label: 'Renseigner les pleins (calibration carburant)',
    description: 'Saisir / modifier / supprimer les pleins (methode du plein) pour calibrer la consommation reelle et les couts.',
  },
  users_view: { group: 'Utilisateurs', label: 'Voir les utilisateurs' },
  users_manage: { group: 'Utilisateurs', label: 'Gerer les utilisateurs (inviter, editer)' },
  drivers_view: { group: 'Conducteurs', label: 'Voir les conducteurs' },
  drivers_manage: { group: 'Conducteurs', label: 'Gerer les conducteurs' },
  sims_view: {
    group: 'Cartes SIM',
    label: 'Voir les cartes SIM',
    description: 'Voir le parc SIM de la flotte et la conso data.',
  },
  sims_assign: {
    group: 'Cartes SIM',
    label: 'Assigner une carte SIM a un tracker',
    description: 'Poser / detacher une SIM sur un boitier de la flotte.',
  },
  audio_monitoring: {
    group: 'Audio',
    label: 'Écouter l\'audio du véhicule',
    description:
      'Capacite legalement sensible (micro embarque). Desactivee en production sans flag dedie, attestation flotte requise. OFF par defaut.',
  },
  agenda_view: {
    group: 'Agenda',
    label: 'Voir l\'agenda + signaler un incident',
    description:
      'Calendrier maintenance/incidents. Permet aussi de signaler un incident sur un vehicule accessible.',
  },
  agenda_manage: {
    group: 'Agenda',
    label: 'Gerer la maintenance (evenements, plans, echeances)',
    description:
      'Creer/editer/resoudre les evenements de maintenance et les plans recurrents (CT, vidange...).',
  },
  reservations_view: {
    group: 'Reservations',
    label: 'Voir les reservations & disponibilites',
    description:
      'Voir les reservations de vehicules et les creneaux de disponibilite (activite reelle, dashboard d\'optimisation).',
  },
  reservations_request: {
    group: 'Reservations',
    label: 'Demander une reservation',
    description:
      'Deposer une demande de reservation (creneau + criteres) sur un vehicule accessible ; validee ensuite par un gestionnaire.',
  },
  reservations_manage: {
    group: 'Reservations',
    label: 'Gerer les reservations',
    description:
      'Valider / refuser / editer / annuler / supprimer les reservations et auto-affecter un vehicule libre.',
  },
  ai_optimize: {
    group: 'Intelligence artificielle',
    label: 'Lancer les propositions IA (optimisation agenda)',
    description:
      'Demander a l\'IA des propositions (capacite du parc, placement optimise). L\'IA propose ; l\'application reutilise vehicles_edit / reservations_*.',
  },
  ai_narrate: {
    group: 'Intelligence artificielle',
    label: 'Generer les recits IA de trajet',
    description:
      'Produire le recit IA d\'un trajet (resume vulgarise + Trust Score + conseils). Chaque generation est un appel LLM facture.',
  },
  ai_configure: {
    group: 'Intelligence artificielle',
    label: 'Configurer l\'IA de la flotte',
    description:
      'Couper ou activer l\'assistance IA pour toute la societe (interrupteur maitre).',
  },
  billing_manage: {
    group: 'Facturation',
    label: 'Facturation & options',
    description:
      'Voir les informations d\'abonnement / facturation et (a terme) gerer le moyen de paiement. Reserve aux admins par defaut, accordable par utilisateur.',
  },
  qr_manage: {
    group: 'Vehicules',
    label: 'Generer / imprimer les QR de deverrouillage',
    description:
      'Generer et imprimer les QR codes de deverrouillage des vehicules (fiche, liste, feuille « tous les QR »). Reserve aux admins par defaut, accordable.',
  },
  places_view: {
    group: 'Lieux cles',
    label: 'Voir les lieux cles',
    description:
      'Consulter les stations-service frequentees (passages detectes avec arret reel) et les parkings / stationnements recurrents de la flotte.',
  },
  places_manage: {
    group: 'Lieux cles',
    label: 'Gerer les lieux cles',
    description:
      'Valider une station-service detectee (elle devient une station de la flotte sur la carte), creer / modifier / supprimer un parking ou un stationnement recurrent. Accorde aux managers par defaut.',
  },
  places_analyze: {
    group: 'Lieux cles',
    label: 'Lancer une analyse IA d\'un lieu',
    description:
      'Declencher l\'analyse IA d\'un lieu (enrichissement OSM + synthese). CONSOMME DES TOKENS (cout reel) : reserve aux admins par defaut, accordable. Reste soumis a l\'interrupteur IA de la societe et au kill-switch global.',
  },
  integrations_manage: {
    group: 'Integrations',
    label: 'Gerer les integrations partenaires',
    description:
      'Connecter la flotte a une application partenaire (Maestroo), choisir les categories de donnees partagees, et couper le partage a tout moment. Acte a consequence : expose des donnees de la flotte a une application tierce. Reserve au fleet-admin par defaut.',
  },
  missions_view: {
    group: 'Missions & depots',
    label: 'Voir les missions',
    description:
      'Consulter les missions (trajet planifie avec creneau, vehicule et depot destinataire). Pour un compte DEPOT, limite a SES propres missions et a leur fenetre horaire.',
  },
  missions_manage: {
    group: 'Missions & depots',
    label: 'Creer / modifier une mission',
    description:
      'Creer, modifier et annuler une mission, et designer son depot destinataire. Acte a consequence : ouvre a un tiers la position du vehicule pendant le creneau, et rend le vehicule indisponible a la reservation.',
  },
  mission_share: {
    group: 'Missions & depots',
    label: 'Partager un suivi (lien 15 min)',
    description:
      'Generer un lien public temporaire vers un client final. Le lien n\'affiche que la position et l\'heure d\'arrivee estimee, expire automatiquement et reste revocable.',
  },
  driver_contact_view: {
    group: 'Missions & depots',
    label: 'Contacter le conducteur d\'une mission',
    description:
      'Voir le nom et le telephone du conducteur d\'une mission dont on est destinataire. Le numero est masque cote serveur ; l\'appel passe par un endpoint qui journalise l\'acces.',
  },
};

/** Ordre d'affichage canonique des groupes dans l'UI. */
export const PERMISSION_GROUP_ORDER: readonly string[] = [
  'Vehicules',
  'Horaires',
  'Groupes',
  'Geofences',
  'Alertes',
  'Rapports',
  'Trajets & analyse',
  'Lieux cles',
  'Utilisateurs',
  'Conducteurs',
  'Cartes SIM',
  'Audio',
  'Agenda',
  'Reservations',
  'Intelligence artificielle',
  'Facturation',
  'Integrations',
  // Espace depot (2026-08) — section en BAS de la matrice, avec sa 6e colonne « Depot »
  // et son marqueur ◆ (accorde, mais limite a ses propres missions). Cf. A5 § 4.
  'Missions & depots',
] as const;
