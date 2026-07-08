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
  | 'Notifications';

/** cron = échéance datée ; interval/setInterval = flux continu (cadence ancrée au démarrage). */
export type BgTaskKind = 'cron' | 'interval' | 'setInterval';
export type BgTaskCriticality = 'haute' | 'moyenne' | 'basse';

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
