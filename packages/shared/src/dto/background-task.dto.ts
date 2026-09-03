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

/**
 * ÉTAT D'UN AGENT QUI TOURNE SUR LE POSTE, tel qu'un humain doit le lire en une seconde.
 *
 * `enabled` (booléen) ne suffit pas : il confond « je n'ai jamais rien vu » et « il est en
 * panne », et il ne dit jamais DEPUIS QUAND. Un agent arrêté depuis trois jours y ressemble
 * exactement à un agent arrêté depuis une heure — donc personne ne remarque les trois jours.
 *
 * - `sain`       : passage récent, issue correcte.
 * - `retard`     : plus de trace depuis plus longtemps que sa cadence annoncée, sans être encore
 *                  anormal au point de crier. On surveille.
 * - `silencieux` : plus rien depuis plus de DEUX fois sa cadence. Là, on le dit fort.
 * - `echec`      : il a bien tourné, et il a échoué. Différent d'un silence : le poste répond.
 * - `inconnu`    : jamais vu passer. On n'accuse pas sans preuve.
 * - `sans-objet` : silence NORMAL — la tâche n'a plus rien à traiter (arriéré résorbé) ou a été
 *                  volontairement coupée. Crier ici apprendrait à ignorer l'écran.
 */
export type BgTaskEtatLocal = 'sain' | 'retard' | 'silencieux' | 'echec' | 'inconnu' | 'sans-objet';

/** D'où vient la preuve de vie affichée — les deux ne valent pas la même chose. */
export type BgTaskPreuveLocale =
  /** Journal dédié des passages : dit « a-t-il TOURNÉ ? », même quand il n'a rien trouvé. */
  | 'journal-passages'
  /** Travail réellement écrit en base : dit « a-t-il PRODUIT ? ». Repli quand aucun passage n'est journalisé. */
  | 'travail-ecrit'
  /** Aucune trace exploitable (table absente, lecture en échec, agent jamais lancé). */
  | 'aucune';

/** Traçabilité d'un agent du poste : quand est-il passé, avec quelle issue, et depuis combien de temps. */
export interface BgTaskTraceLocale {
  etat: BgTaskEtatLocal;
  /** ISO du dernier passage connu (identique à `lastRunAt`, repris ici pour que le bloc se lise seul). */
  dernierPassageAt: string | null;
  /** Écart en millisecondes depuis ce passage. `null` = jamais vu passer. */
  depuisMs: number | null;
  /** Le même écart en français prêt à lire : « 3 jours », « 5 heures », « 12 min ». */
  depuis: string | null;
  /** Écart NORMAL maximal entre deux passages, déclaré au catalogue (ms). */
  cadenceMs: number;
  /** Au-delà de cet écart, le silence n'est plus un aléa (ms) — deux fois la cadence, au minimum. */
  seuilSilenceMs: number;
  /** Issue du dernier passage. `inconnu` quand la preuve est un travail écrit (elle ne dit pas l'échec). */
  issue: 'succes' | 'echec' | 'inconnu';
  /** Ce que le dernier passage a produit, en une phrase lisible sans contexte. */
  resume: string | null;
  preuve: BgTaskPreuveLocale;
  /** Phrase à afficher telle quelle, déjà écrite pour un humain. */
  message: string;
}

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
  /**
   * Écran dédié à ce traitement, ou null.
   *
   * ⚠️ PAS FORCÉMENT UN ÉCRAN DE RÉGLAGE, et c'est volontaire. Un agent du poste ne se règle pas
   * depuis le serveur, mais ce qu'il produit se CONSTATE quelque part (ses diagnostics, son
   * arriéré). Le lien mène donc à l'écran qui parle de lui ; c'est `configurable` qui dit si on
   * peut y toucher un réglage. Les fondre laissait trois entrées avec une route jamais affichée.
   */
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

  /**
   * Traçabilité d'un agent du POSTE : dernier passage, issue, ancienneté, et le mot à afficher.
   *
   * Renseigné pour les seuls `executor === 'poste-local'` — un cron du serveur a le registre
   * NestJS pour preuve de vie, un agent du poste n'a que ce qu'il a laissé en base. `null` quand
   * la lecture a échoué : la supervision ne fait jamais tomber la page qu'elle supervise.
   */
  traceLocale?: BgTaskTraceLocale | null;
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
