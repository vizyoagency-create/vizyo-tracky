/**
 * Demande CDEF (2026-07) — Module admin « Automatisations & tâches de fond ».
 *
 * Inventaire de TOUS les traitements qui tournent en arrière-plan (crons, @Interval,
 * setInterval) avec leur période, leur but en langage simple, leur criticité, leurs
 * réglages (pour les configurables) et un compte-à-rebours « prochain lancement dans X ».
 * Objectif : plus rien d'invisible dans l'espace administrateur.
 */

export type BgTaskCategory =
  | 'IA & rapports'
  | 'Sécurité & moteur'
  | 'Maintenance données'
  | 'Temps réel'
  | 'Système & observabilité'
  | 'Notifications'
  | 'Intégration partenaire';

/** cron = échéance datée ; interval/setInterval = flux continu (cadence ancrée au démarrage). */
export type BgTaskKind = 'cron' | 'interval' | 'setInterval';
export type BgTaskCriticality = 'haute' | 'moyenne' | 'basse';

/**
 * OÙ le traitement s'exécute réellement.
 *
 * - `serveur`     : dans l'API, sur le VPS. Un appel IA y consomme des crédits facturés.
 * - `poste-local` : agent sur le poste du propriétaire. Le travail est ABSORBÉ (abonnement
 *                   Claude Code, ou service public gratuit comme Overpass) — mais il dépend
 *                   d'un PC allumé, ce que le serveur ne peut ni garantir ni surveiller
 *                   autrement qu'en regardant le travail réellement écrit en base.
 *
 * Cette distinction n'est pas cosmétique : elle explique pourquoi un traitement peut être
 * « à l'arrêt » sans qu'aucune erreur serveur n'existe.
 */
export type BgTaskExecutor = 'serveur' | 'poste-local';

/**
 * QUI paie le travail IA d'un traitement. Volontairement distinct de `BgTaskExecutor` : les deux
 * dimensions sont indépendantes, et les confondre produit des affirmations fausses.
 *
 * - `facture` : consomme des crédits Anthropic — de l'argent réellement dépensé.
 * - `absorbe` : travail IA exécuté sur le poste, couvert par l'abonnement Claude Code. Gratuit
 *               pour la société, mais suspendu à un PC allumé.
 * - `aucun`   : aucune IA n'intervient. L'agent de limites de vitesse tourne sur le poste ET ne
 *               coûte rien — non pas parce qu'un abonnement l'absorbe, mais parce qu'il
 *               interroge OpenStreetMap, un service public gratuit. Le ranger dans `absorbe`
 *               ferait croire à une dépense évitée qui n'a jamais existé.
 */
export type BgTaskCoutIa = 'facture' | 'absorbe' | 'aucun';

export interface BackgroundTaskDto {
  id: string;
  label: string;
  category: BgTaskCategory;
  kind: BgTaskKind;
  /** Période en langage simple : « chaque jour à 03:00 », « toutes les 30 s ». */
  scheduleHuman: string;
  /** Ce que ça fait, en une phrase compréhensible. */
  purpose: string;
  criticality: BgTaskCriticality;
  /** true si un verrou anti-chevauchement empêche un tick de se lancer si le précédent tourne encore. */
  antiOverlap: boolean;
  /** true = flux continu (pas de compte-à-rebours daté ; cadence depuis le démarrage). */
  continuous: boolean;
  /** true = actif seulement en développement (jamais en production). */
  devOnly: boolean;

  /** Réglable par un admin (activer/fréquence) ? */
  configurable: boolean;
  /** Route de la page de réglage existante, ou null. */
  settingsRoute: string | null;
  /** Résumé du réglage courant : « Actif · quotidien à 02:00 » / « En pause ». Null si non configurable. */
  settingsSummary: string | null;
  /** Pour les configurables : est-ce actuellement actif ? null sinon. */
  enabled: boolean | null;

  /** ISO — prochain lancement (absolu), ou null (flux continu / en pause / inconnu). */
  nextRunAt: string | null;
  /** ISO — dernier passage connu, ou null (non tracé pour cette tâche). */
  lastRunAt: string | null;

  /** Remarque importante à afficher (ex. « DRY-RUN : n'efface rien », « dev uniquement »). */
  note: string | null;

  /**
   * Où le traitement tourne. Optionnel à la lecture : un client déployé avant ce champ doit
   * continuer de fonctionner, et un client neuf face à une API plus ancienne retombe sur
   * `serveur` — le cas de figure qui était vrai partout jusqu'ici.
   */
  executor?: BgTaskExecutor;
  /** Qui paie le travail IA de ce traitement. Optionnel à la lecture, défaut `aucun`. */
  coutIa?: BgTaskCoutIa;
}

export interface BackgroundTasksHealth {
  /** Nombre de jobs cron réellement enregistrés au runtime (SchedulerRegistry). */
  registeredCronCount: number;
  /** Nombre d'@Interval réellement enregistrés au runtime. */
  registeredIntervalCount: number;
  /** Nombre de crons présents dans le catalogue (métadonnées humaines). */
  catalogCronCount: number;
  /** Nombre d'@Interval présents dans le catalogue. */
  catalogIntervalCount: number;
  /**
   * Clés de jobs enregistrés au runtime mais NON rapprochées du catalogue (drift) :
   * signale qu'un traitement tourne sans être documenté/visible. Vide = tout est catalogué.
   */
  uncataloguedJobs: string[];
}

export interface BackgroundTasksResponse {
  tasks: BackgroundTaskDto[];
  /** ISO — horloge serveur, pour aligner les compte-à-rebours côté client. */
  serverNow: string;
  /** Fuseau serveur (les crons sans fuseau explicite tournent dessus). */
  serverTimezone: string;
  health: BackgroundTasksHealth;
}
