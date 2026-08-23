import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type {
  BackgroundTaskDto,
  BackgroundTasksResponse,
  BgTaskCategory,
  BgTaskCoutIa,
  BgTaskCriticality,
  BgTaskKind,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { nextFireInstant, nextPeriodicTick, SERVER_TZ } from './next-run.util';

const PARIS = 'Europe/Paris';
const DAY_MS = 86_400_000;

/**
 * Entrée du CATALOGUE STATIQUE des traitements de fond.
 *
 * Pourquoi statique : `SchedulerRegistry` ne connaît que des noms auto-générés (aucun @Cron
 * n'est nommé sauf 'sms-heartbeat') et IGNORE totalement les `setInterval` bruts (buffer
 * positions, cache, mock). Un catalogue à la main est donc le SEUL moyen d'atteindre
 * l'objectif « rien d'invisible ». On croise ensuite avec le registry pour DÉTECTER un drift
 * (un job enregistré au runtime qui ne serait pas catalogué).
 */
interface CatalogEntry {
  id: string;
  label: string;
  category: BgTaskCategory;
  kind: BgTaskKind;
  scheduleHuman: string;
  purpose: string;
  criticality: BgTaskCriticality;
  antiOverlap: boolean;
  continuous?: boolean;
  devOnly?: boolean;
  configurable?: boolean;
  settingsRoute?: string;
  note?: string;
  /** Cron haute fréquence aligné sur l'époque → prochain tick arithmétique. */
  periodic?: { everyMs: number; offsetMs: number };
  /** Cron à heure fixe → prochain instant où l'horloge murale (tz) satisfait le matcher. */
  fire?: { tz: string; matcher: (w: Date) => boolean };
  /** Automatisation IA configurable : le « prochain » se calcule depuis ses réglages DB. */
  ai?: 'trip' | 'activity' | 'agenda' | 'place';
  /**
   * Traitement qui ne tourne PAS sur ce serveur — son état se déduit du travail qu'il a écrit
   * en base, pas du registre local. Sans cette entrée, il travaillerait en silence.
   */
  externe?: 'limites-vitesse' | 'recit-trajet' | 'qualite-gps' | 'rattrapage-recits' | 'courrier-ia';
  /**
   * Lanceur .cmd du Planificateur de taches Windows, relatif a la racine du depot.
   *
   * MEME ROLE QUE `source` POUR LES CRONS SERVEUR : un garde scanne outils/*.cmd et exige
   * que chaque lanceur soit revendique ici. Le 2026-08-21, une tache de rattrapage a ete
   * creee sur le poste SANS etre cataloguee — elle tournait invisible, exactement le trou
   * que l'ecran des traitements existe pour fermer. Obligatoire pour toute entree `externe`.
   */
  poste?: string;
  /**
   * Fichier source qui porte le `@Cron`, relatif a `apps/api/src`.
   *
   * ⚠️ CE CHAMP N'EST PAS DECORATIF : un test parcourt le code, releve tous les `@Cron` et
   *    exige que chaque fichier qui en porte un soit revendique ici. C'est ce qui rend
   *    l'audit MECANIQUE — sans lui, un traitement ajoute demain tournerait en silence et
   *    personne ne s'en apercevrait avant l'incident. Verifie le 2026-08-19 : 34 crons dans
   *    le code, et il en manquait un au catalogue — la sonde qui surveille les taches
   *    silencieuses, precisement.
   *
   * Absent pour ce qui ne tourne pas sur ce serveur (agent sur poste).
   */
  source?: string;
  /** Qui paie le travail IA. Défaut déduit : `facture` pour une automatisation IA, `aucun` sinon. */
  coutIa?: BgTaskCoutIa;
}

const CATALOG: CatalogEntry[] = [
  // ───────── Sécurité & moteur ─────────
  {
    id: 'vehicle-schedules',
    source: 'vehicle-schedules/schedule-cron.service.ts', label: 'Horaires véhicules (coupe/reprise auto)', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    configurable: true, settingsRoute: '/fleet-schedules',
    purpose: 'Coupe ou rend le moteur selon les horaires programmés (jamais en mouvement ; attend 10 min d\'arrêt).',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },
  {
    id: 'audio-auto-disarm',
    source: 'audio-monitoring/audio-auto-disarm.service.ts', label: 'Auto-désarmement écoute audio', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    purpose: 'Filet de sécurité : remet un boîtier resté en écoute (micro) en mode suivi GPS pour qu\'il réapparaisse sur la carte.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },
  {
    id: 'surveillance-scheduler',
    source: 'surveillance/surveillance-scheduler.service.ts', label: 'Armement auto des surveillances', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    purpose: 'Arme/désarme automatiquement les profils de surveillance selon leurs plages horaires.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },
  {
    id: 'tracker-commands-scheduler',
    source: 'tracker-commands/tracker-commands-scheduler.service.ts', label: 'Envoi des commandes programmées', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'toutes les 30 s', criticality: 'moyenne', antiOverlap: false,
    purpose: 'Envoie aux boîtiers les commandes planifiées dont l\'heure est arrivée (10 par passage).',
    periodic: { everyMs: 30_000, offsetMs: 0 },
  },
  {
    id: 'fix-command-expiry',
    source: 'tracker-fix-mode/tracker-fix-mode.service.ts', label: 'Clôture des commandes de cadence sans réponse', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'toutes les 10 min', criticality: 'moyenne', antiOverlap: true,
    purpose: 'Ferme les commandes de cadence GPS restées sans effet : le boîtier n\'accuse jamais réception, elles resteraient « en attente » indéfiniment au centre d\'alertes.',
    periodic: { everyMs: 600_000, offsetMs: 45_000 },
  },
  {
    id: 'trips-timeout',
    source: 'trips/trips.service.ts', label: 'Clôture des trajets en cours', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'moyenne', antiOverlap: false,
    purpose: 'Ferme les trajets restés « en cours » alors que le véhicule est à l\'arrêt depuis un moment.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },

  {
    id: 'error-rate-watchdog',
    source: 'observability/error-rate-watchdog.service.ts', label: "Vigie de saturation du centre d'alerte", category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'toutes les 10 min', criticality: 'moyenne', antiOverlap: true,
    purpose: "Prévient par e-mail quand plus de 5 erreurs sont enregistrées sur l'heure glissante (1 e-mail/h max).",
    periodic: { everyMs: 600_000, offsetMs: 0 },
  },

  // ───────── IA & rapports ─────────
  {
    id: 'trip-automation',
    source: 'trip-analysis/trip-automation.service.ts', label: 'Automatisation des trajets (analyse + récit IA)', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'toutes les heures à HH:45 (si réglé)', criticality: 'moyenne', antiOverlap: true,
    configurable: true, settingsRoute: '/admin/trip-automation', ai: 'trip',
    purpose: 'Recalcule les trajets, lance l\'analyse et le récit IA pour toutes les flottes, selon la cadence réglée.',
  },
  {
    id: 'place-automation',
    source: 'fleet-places/place-automation.service.ts', label: 'Automatisation des analyses de lieux', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'chaque jour à l\'heure réglée (sondé à HH:10)', criticality: 'basse', antiOverlap: true,
    configurable: true, settingsRoute: '/admin/place-automation', ai: 'place',
    purpose: 'Analyse les lieux clés dont les faits ont changé, sous plafonds de nombre et de dépense. Désactivé par défaut.',
    // Bascule locale du 2026-08-21 (design/C1) : ce cron enfile, il ne paie plus.
    coutIa: 'aucun',
  },
  {
    // coutIa bascule 'facture' -> 'aucun' le 2026-08-21 : ce cron ne touche plus un modele,
    // il PREPARE le rapport et l'enfile pour le courrier du poste (design/C1).
    id: 'activity-report',
    source: 'user-activity/activity-report.service.ts', label: 'Rapport IA d\'activité utilisateurs', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'à échéance (vérifié chaque heure)', criticality: 'basse', antiOverlap: false,
    configurable: true, settingsRoute: '/admin/activity', ai: 'activity',
    purpose: 'Génère un rapport IA d\'observation de l\'activité (quotidien / hebdo / mensuel selon réglage).',
    coutIa: 'aucun',
  },
  {
    id: 'agenda-agent',
    source: 'agenda/agenda-agent-runner.service.ts', label: 'Agent nocturne d\'optimisation d\'agenda', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'chaque nuit à l\'heure réglée (par flotte)', criticality: 'moyenne', antiOverlap: true,
    configurable: true, settingsRoute: '/agenda', ai: 'agenda',
    note: 'Se règle dans l\'Agenda (par flotte), pas ici.',
    purpose: 'Détecte les trajets récurrents et propose (ou crée) des réservations, chaque nuit, par flotte.',
  },
  {
    id: 'reports-weekly',
    source: 'reports/reports-cron.service.ts', label: 'E-mail hebdo du rapport PDF', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'chaque lundi à 08:00', criticality: 'basse', antiOverlap: false,
    purpose: 'Envoie par e-mail le rapport PDF de la semaine passée à chaque flotte (destinataire réglé sur la fiche flotte).',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getDay() === 1 && w.getHours() === 8 && w.getMinutes() === 0 },
  },

  // ───────── Maintenance données ─────────
  {
    id: 'log-cleanup',
    source: 'observability/log-cleanup.service.ts', label: 'Purge des journaux', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 03:00', criticality: 'moyenne', antiOverlap: false,
    purpose: 'Supprime les vieux journaux (wire / erreurs / audit) et les journaux SMS de plus de 90 jours (numéros + contenu).',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 0 },
  },
  {
    id: 'recensement-suppressions',
    source: 'observability/recensement-suppressions.service.ts',
    label: 'Recensement des disparitions de lignes', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour a 03:15', criticality: 'haute', antiOverlap: false,
    note: "Nee de TRK-035 : 41 709 alertes puis des lignes d'erreur effacees hors application, sans aucune trace. Passe APRES la purge de 03:00 pour que la disparition attendue soit deja faite et deduite.",
    purpose: "Releve le nombre de lignes et la borne basse des tables surveillees, et signale toute disparition que la retention n'explique pas. C'est le seul instrument qui distingue « purge normale » de « quelqu'un a vide la table ».",
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 15 },
  },
  {
    id: 'mission-share-purge',
    source: 'depot/mission-share-purge.service.ts', label: 'Purge des liens de partage expirés', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:15', criticality: 'basse', antiOverlap: true,
    note: 'Purge REELLE. Les 30 jours de conservation servent l\'audit : qui a ouvert cet accès, quand, combien de fois.',
    purpose: 'Supprime les liens publics de suivi de mission expirés depuis plus de 30 jours (avec leurs empreintes d\'ouverture tronquées).',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 15 },
  },
  {
    id: 'trips-retention',
    source: 'trips/trips-retention.service.ts', label: 'Rétention des trajets (RGPD)', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 03:45', criticality: 'moyenne', antiOverlap: false,
    note: 'Purge REELLE et irreversible. Pour stopper : TRIPS_RETENTION_MONTHS=0.',
    purpose: 'Supprime définitivement les trajets de plus de 12 mois, avec leurs analyses IA et arrêts carburant liés.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 45 },
  },
  {
    id: 'work-time-registry',
    source: 'drivers/work-time.service.ts', label: 'Registre du temps de travail (RGPD)', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:00', criticality: 'basse', antiOverlap: false,
    purpose: 'Agrège chaque nuit les trajets attribués en un registre journalier par conducteur (sans positions, rétention 5 ans) et purge les entrées expirées.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 0 },
  },
  {
    id: 'positions-retention',
    source: 'positions/data-retention.service.ts', label: 'Rétention des positions GPS', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 03:30', criticality: 'moyenne', antiOverlap: false,
    configurable: true, settingsRoute: '/admin/retention', note: 'Purge REELLE et irreversible. Pour stopper : POSITIONS_RETENTION_DAYS=0.',
    purpose: 'Supprime définitivement les positions GPS de plus de 60 jours (rétention CNIL), par lots bornés.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 30 },
  },
  {
    id: 'user-activity-close',
    source: 'user-activity/user-activity.service.ts', label: 'Clôture des sessions inactives', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'toutes les 2 min', criticality: 'basse', antiOverlap: false,
    purpose: 'Ferme les sessions utilisateurs restées ouvertes sans signal (onglet fermé sans notification).',
    periodic: { everyMs: 120_000, offsetMs: 30_000 },
  },
  {
    id: 'user-activity-purge',
    source: 'user-activity/user-activity.service.ts', label: 'Purge de l\'historique d\'activité (>90j)', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:15', criticality: 'basse', antiOverlap: false,
    purpose: 'Supprime l\'historique d\'activité utilisateurs de plus de 90 jours.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 15 },
  },
  {
    id: 'security-login-purge',
    source: 'security/security-cleanup.service.ts', label: 'Purge des événements de connexion (>365j)', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 03:00 (Paris)', criticality: 'basse', antiOverlap: false,
    purpose: 'Supprime les événements de connexion (carte des lieux, appareils) de plus d\'un an — rétention sécurité.',
    fire: { tz: PARIS, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 0 },
  },
  {
    id: 'sims-sync',
    source: 'sims/sims-sync.service.ts', label: 'Synchronisation du parc SIM', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'toutes les 30 min', criticality: 'basse', antiOverlap: false,
    purpose: 'Met à jour l\'état des cartes SIM depuis le fournisseur (consommation, statut).',
    periodic: { everyMs: 1_800_000, offsetMs: 0 },
  },

  // ───────── Système & observabilité ─────────
  {
    id: 'metrics-purge',
    source: 'system-metrics/metrics-collector.service.ts', label: 'Purge des métriques système (>30j)', category: 'Système & observabilité',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:30', criticality: 'basse', antiOverlap: false,
    purpose: 'Supprime les mesures de charge du serveur de plus de 30 jours.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 30 },
  },
  {
    id: 'backup-health',
    source: 'backup-health/backup-health.service.ts', label: 'Contrôle santé des sauvegardes', category: 'Système & observabilité',
    kind: 'cron', scheduleHuman: 'chaque jour à 06:00', criticality: 'haute', antiOverlap: false,
    purpose: 'Vérifie qu\'une sauvegarde de la base a bien eu lieu dans les 30 dernières heures, sinon alerte.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 6 && w.getMinutes() === 0 },
  },
  {
    id: 'gps-integrity',
    source: 'gps-integrity/gps-integrity.service.ts', label: 'Détection GPS perdu (boîtiers vivants sans position)', category: 'Système & observabilité',
    kind: 'cron', scheduleHuman: 'toutes les 5 min', criticality: 'moyenne', antiOverlap: true,
    purpose: 'Repère les boîtiers qui communiquent encore mais n\'envoient plus de position GPS (antenne/ciel) et lève une alerte véhicule + centre d\'alertes.',
    periodic: { everyMs: 300_000, offsetMs: 15_000 },
  },
  {
    id: 'metrics-collect',
    source: 'system-metrics/metrics-collector.service.ts', label: 'Collecte des métriques serveur (VPS)', category: 'Système & observabilité',
    kind: 'interval', scheduleHuman: 'flux continu · toutes les 60 s', criticality: 'basse', antiOverlap: false,
    continuous: true, settingsRoute: '/admin/system',
    purpose: 'Enregistre en continu la charge CPU/mémoire/disque du serveur (monitoring VPS).',
  },
  {
    id: 'scheduled-task-heartbeat', label: 'Sonde des taches planifiees', category: 'Système & observabilité',
    source: 'observability/scheduled-task-heartbeat.service.ts',
    kind: 'cron', scheduleHuman: 'toutes les heures (a h:35)', criticality: 'haute', antiOverlap: false,
    note: "DECISION D'ARCHITECTURE (proprietaire, 2026-08-21) : reste sur l'API, par exception a la regle « recurrent = agent local ». Ses propositions de reservation font partie des interactions que le proprietaire veut instantanees et coherentes avec l'agenda ; le passage nocturne prepare exactement ces propositions. Cout mesure : 1,35 $ en deux mois — migrer dupliquerait la detection de recurrences pour une economie de quelques euros par an.",
    purpose: "Verifie que les automatisations configurees tournent vraiment. Tolerance de deux periodes manquees (plancher 4 h) : une seule est un alea, deux de suite ne s'expliquent plus. Remonte une alerte au centre d'alerte.",
    fire: { tz: SERVER_TZ, matcher: (w) => w.getMinutes() === 35 },
  },
  {
    id: 'dependency-heartbeat',
    source: 'observability/dependency-heartbeat.service.ts', label: 'Sonde active des dépendances externes', category: 'Système & observabilité',
    kind: 'cron', scheduleHuman: 'toutes les 5 min (à :30 s)', criticality: 'haute', antiOverlap: true,
    note: 'Née de la panne Vizyo Auth du 18-21/07 restée invisible 3 jours. Sonde les adresses PUBLIQUES (jamais internes).',
    purpose: 'Vérifie que les services dont Tracky dépend (Vizyo Auth, passerelle SMS…) répondent réellement ; 2 échecs consécutifs ⇒ alerte au centre d\'alertes (panne signalée en ~10 min).',
    periodic: { everyMs: 300_000, offsetMs: 30_000 },
  },
  {
    id: 'cache-cleanup',
    source: 'common/cache/in-memory-cache.service.ts', label: 'Nettoyage du cache mémoire', category: 'Système & observabilité',
    kind: 'setInterval', scheduleHuman: 'flux continu · toutes les 60 s', criticality: 'basse', antiOverlap: false,
    continuous: true,
    purpose: 'Retire du cache interne les entrées expirées pour éviter que la mémoire grossisse.',
  },

  // ───────── Temps réel ─────────
  {
    id: 'position-broadcast', label: 'Diffusion temps réel des positions', category: 'Temps réel',
    source: 'realtime/position-broadcast-buffer.service.ts',
    kind: 'interval', scheduleHuman: 'flux continu · toutes les 1 s', criticality: 'moyenne', antiOverlap: false,
    continuous: true,
    purpose: 'Regroupe et diffuse les positions aux écrans clients une fois par seconde (fluidité sous charge).',
  },
  {
    id: 'position-batch',
    source: 'positions/position-batch-buffer.service.ts', label: 'Enregistrement groupé des positions', category: 'Temps réel',
    kind: 'setInterval', scheduleHuman: 'flux continu · toutes les 100 ms', criticality: 'moyenne', antiOverlap: true,
    continuous: true,
    purpose: 'Insère les positions reçues par paquets pour tenir la charge d\'ingestion GPS.',
  },
  {
    id: 'mission-status', label: 'Bascule des statuts de mission', category: 'Temps réel',
    source: 'missions/mission-status.service.ts',
    kind: 'interval', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    note: "⚠️ ELLE MANQUAIT A CE CATALOGUE jusqu'au 2026-08-19. Le premier garde ne relevait que les @Cron : ce traitement, declare en @Interval, passait au travers. Le garde couvre desormais les deux.",
    purpose: "Fait passer les missions du depot d'un statut a l'autre a partir des faits (depart, arrivee, fin). Le statut est DERIVE, jamais saisi : sans ce passage, une mission resterait indefiniment « planifiee » alors que le vehicule est deja reparti.",
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },
  {
    id: 'ignition-cleanup',
    source: 'positions/ignition-inferred-cleanup.service.ts', label: 'Extinction contact inféré', category: 'Temps réel',
    kind: 'interval', scheduleHuman: 'flux continu · toutes les 60 s', criticality: 'moyenne', antiOverlap: false,
    continuous: true,
    purpose: 'Passe le contact à « éteint » pour les boîtiers sans fil ACC devenus silencieux (marqueur carte à jour).',
  },
  {
    id: 'realtime-revalidate', label: 'Revalidation des connexions live', category: 'Temps réel',
    source: 'realtime/realtime.gateway.ts',
    kind: 'interval', scheduleHuman: 'flux continu · toutes les 60 s', criticality: 'moyenne', antiOverlap: false,
    continuous: true,
    purpose: 'Déconnecte les sessions temps réel dont l\'utilisateur n\'est plus actif (sécurité).',
  },
  {
    id: 'mock-emitter',
    source: 'realtime/mock-position-emitter.service.ts', label: 'Émetteur de positions factices', category: 'Temps réel',
    kind: 'setInterval', scheduleHuman: 'développement uniquement', criticality: 'basse', antiOverlap: false,
    continuous: true, devOnly: true, note: 'Inactif en production.',
    purpose: 'Simule le mouvement de véhicules pour les tests (jamais actif en production).',
  },

  // ───────── Intégration partenaire (Tracky × Maestroo) ─────────
  {
    id: 'partner-sync',
    source: 'partner/partner-sync.service.ts', label: 'Synchro véhicules → Maestroo (merge à 3 voies)', category: 'Intégration partenaire',
    kind: 'cron', scheduleHuman: 'toutes les 30 min', criticality: 'moyenne', antiOverlap: true,
    settingsRoute: '/admin/partner-links',
    purpose: 'Re-pousse l\'identité des véhicules des liens partenaires ACTIFS, applique les corrections Tracky (fast-forward) et journalise les écarts détectés. Ne supprime jamais rien, respecte les catégories consenties.',
    periodic: { everyMs: 1_800_000, offsetMs: 0 },
  },
  {
    id: 'partner-outbox',
    source: 'partner/partner-outbox.service.ts', label: 'Rejeu des webhooks partenaires (révocations)', category: 'Intégration partenaire',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    settingsRoute: '/admin/partner-links',
    note: 'Un webhook de révocation perdu serait une révocation perdue : ce cron est le filet du levier commercial.',
    purpose: 'Rejoue les webhooks non délivrés au partenaire (révocation, coupure de catégorie, suspension) avec attente progressive, jusqu\'à 12 tentatives.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },

  // ───────── Notifications ─────────
  {
    id: 'escalation',
    source: 'notifications/escalation-cron.service.ts', label: 'Escalade des alertes critiques', category: 'Notifications',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    purpose: 'Relance les destinataires quand une alerte critique n\'est pas acquittée à temps.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },
  {
    id: 'maintenance-reminder',
    source: 'agenda/maintenance-reminder.service.ts', label: 'Rappels d\'échéances de maintenance', category: 'Notifications',
    kind: 'cron', scheduleHuman: 'chaque jour à 07:00', criticality: 'moyenne', antiOverlap: true,
    purpose: 'Prévient les responsables quand une échéance d\'entretien approche (préavis réglé par plan).',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 7 && w.getMinutes() === 0 },
  },
  {
    id: 'sms-heartbeat',
    source: 'sms/sms-heartbeat.service.ts', label: 'Preuve de vie SMS (passerelle)', category: 'Notifications',
    kind: 'cron', scheduleHuman: 'chaque lundi à 09:00', criticality: 'moyenne', antiOverlap: false,
    purpose: 'Envoie un SMS de test aux admins pour vérifier que la chaîne SMS fonctionne.',
    fire: { tz: PARIS, matcher: (w) => w.getDay() === 1 && w.getHours() === 9 && w.getMinutes() === 0 },
  },
  {
    id: 'notification-retention',
    source: 'notifications/notification-retention.service.ts', label: 'Purge du journal de notifications', category: 'Notifications',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:45', criticality: 'basse', antiOverlap: false,
    note: 'Retenues purgées à 30 j (volumineuses), envois réels conservés 180 j (trace d\'exploitation).',
    purpose: 'Purge le journal du centre de notifications : sans elle, ~300 000 lignes par mois une fois le push ouvert à tous les rôles.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 45 },
  },
  {
    id: 'sms-allowlist-reconcile',
    source: 'sms/allowlist.service.ts', label: 'Réconciliation de l\'allowlist SMS', category: 'Notifications',
    kind: 'cron', scheduleHuman: 'toutes les heures (à h:25)', criticality: 'haute', antiOverlap: true,
    note: 'Un numéro absent de l\'allowlist = SMS refusé (403) — dont le repli du coupe-circuit.',
    purpose: 'Repousse les numéros SIM des boîtiers et des utilisateurs vers la passerelle SMS, pour qu\'un envoi ne soit jamais refusé faute de numéro autorisé.',
    periodic: { everyMs: 3_600_000, offsetMs: 1_500_000 },
  },
  {
    id: 'agent-limites-vitesse', label: 'Limites de vitesse OSM (agent sur poste)',
    category: 'Maintenance données', kind: 'cron',
    scheduleHuman: '04:30, 08:30, 14:00, 18:30 et 22:00 — sur le poste du propriétaire',
    criticality: 'moyenne', antiOverlap: true,
    note: "Ne tourne PAS sur ce serveur. L'IP du VPS s'est fait bannir d'overpass-api.de ; depuis le poste, la même requête passe et répond trois fois plus vite. Son état ci-contre est déduit des cellules réellement écrites, pas d'un simple signal de démarrage — si le poste est éteint, ça se voit.",
    purpose: "Résout auprès d'OpenStreetMap la limite légale de chaque portion de route parcourue. Sans elle, aucun excès de vitesse n'est calculable et le score de conduite ne mesure rien. Gratuit : aucun crédit d'IA.",
    externe: 'limites-vitesse',
    poste: 'outils/agent-limites-vitesse.cmd',
    // ⚠️ PARIS, pas SERVER_TZ. Ce serveur tourne en UTC, le poste en heure de Paris : avec
    //    SERVER_TZ l'ecran annoncait « prochain passage 14:00 » en UTC, soit deux heures APRES
    //    le passage reel. Un ecran de supervision qui se trompe d'heure est pire que pas d'ecran.
    fire: {
      tz: PARIS,
      matcher: (w) =>
        (w.getHours() === 4 && w.getMinutes() === 30) ||
        (w.getHours() === 8 && w.getMinutes() === 30) ||
        (w.getHours() === 14 && w.getMinutes() === 0) ||
        (w.getHours() === 18 && w.getMinutes() === 30) ||
        (w.getHours() === 22 && w.getMinutes() === 0),
    },
  },
  {
    id: 'agent-recit-trajet', label: 'Recits de trajet (agent sur poste)',
    category: 'IA & rapports', kind: 'cron',
    scheduleHuman: '03:15 chaque nuit — sur le poste du proprietaire',
    criticality: 'basse', antiOverlap: true,
    note: "Ne tourne PAS sur ce serveur. Le recit passe par l'abonnement du poste au lieu des credits d'API : le meme travail coutait 45,89 $ sur le seul mois de juillet. Son etat ci-contre est deduit des recits reellement ecrits — si le poste est eteint ou la session expiree, ca se voit.",
    purpose: "Met en mots l'analyse deja calculee de chaque trajet (allure, arrets, exces, conseils eco). Ne recalcule rien. Absorbe par l'abonnement : aucun credit d'IA facture.",
    externe: 'recit-trajet',
    poste: 'outils/agent-recit-trajet.cmd',
    coutIa: 'absorbe',
    // ⚠️ PARIS, pas SERVER_TZ : ce serveur tourne en UTC, le poste en heure de Paris.
    fire: { tz: PARIS, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 15 },
  },
  {
    id: 'veille-accident', label: 'Veille accident (boîtier muet après avoir roulé)',
    source: 'alerts/detection-accident.service.ts',
    category: 'Sécurité & moteur', kind: 'cron',
    scheduleHuman: 'toutes les 30 minutes',
    criticality: 'haute', antiOverlap: true,
    note: "Notification restreinte aux SUPER-ADMINS, volontairement et provisoirement. L'alerte est créée et reste consultable ; seul l'envoi est retenu, le temps de vérifier sur le terrain que la règle dit vrai. Elle n'a jamais pu être validée sur un vrai accident — aucun ne figure dans la fenêtre de données conservée.",
    purpose: "Cherche les boîtiers qui se sont TUS alors qu'ils roulaient : signature d'un arrachement, d'un écrasement ou d'une coupure d'alimentation. La chute de vitesse seule ne suffit pas — mesurée à 612 fois en 30 jours, toutes suivies d'une reprise de route.",
    periodic: { everyMs: 1_800_000, offsetMs: 0 },
  },
  {
    id: 'agent-qualite-gps', label: 'Qualite GPS / zones mortes (agent sur poste)',
    category: 'Maintenance données', kind: 'cron',
    scheduleHuman: '05:00 chaque nuit — sur le poste du proprietaire',
    criticality: 'basse', antiOverlap: true,
    note: "Ne tourne PAS sur ce serveur, et n'appelle AUCUN modele : le diagnostic est un calcul geometrique. Son etat ci-contre vient de ses PASSAGES et non de ses trouvailles — contrairement aux deux autres agents locaux, celui-ci peut legitimement ne rien signaler d'une nuit, et une nuit sans rien a dire n'est pas une panne.",
    purpose: "Croise les zones de perte de signal entre vehicules d'une meme societe pour trancher : est-ce le LIEU qui est mauvais, ou le BOITIER ? Un lieu part dans l'ecran Qualite GPS, un boitier au centre d'alertes, et ce dont il n'est pas sur ne part nulle part.",
    externe: 'qualite-gps',
    poste: 'outils/agent-qualite-gps.cmd',
    // Aucun modele appele : ce n'est ni facture ni absorbe, c'est simplement du calcul.
    coutIa: 'aucun',
    // ⚠️ PARIS, pas SERVER_TZ : ce serveur tourne en UTC, le poste en heure de Paris.
    // 05:00 et non 03:15 : l'agent de recit occupe deja la tranche de 3 h et peut courir
    // jusqu'a 110 minutes. Les faire se chevaucher sur le meme poste ne servirait personne.
    fire: { tz: PARIS, matcher: (w) => w.getHours() === 5 && w.getMinutes() === 0 },
  },
  {
    id: 'rattrapage-recits', label: 'Rattrapage des recits (agent sur poste, temporaire)',
    category: 'IA & rapports', kind: 'cron',
    scheduleHuman: 'toutes les 2 h aux heures paires (70 min max) — sur le poste du proprietaire',
    criticality: 'basse', antiOverlap: true,
    note: "TEMPORAIRE, et c'est son interet : la tache resorbe l'arriere de recits (fenetre de 1 500 h) puis devient un no-op — l'agent sort immediatement quand il n'y a plus rien a narrer. Creee le 2026-08-21 apres que le rattrapage a ete perdu TROIS fois en tournant sous une session interactive : ici c'est le Planificateur de Windows qui porte le processus, il survit aux fermetures de session et aux redemarrages.",
    purpose: "Ecrit les recits manquants de l'HISTORIQUE (le creneau nocturne de 03:15 ne couvre que les 48 dernieres heures). Meme moteur, meme abonnement du poste : aucun credit d'API facture.",
    externe: 'rattrapage-recits',
    poste: 'outils/rattrapage-recits.cmd',
    coutIa: 'absorbe',
    // Heures PAIRES de Paris, pile — 02:00 Paris = 00:00 UTC, heure epoch paire, d'ou offset 0.
    periodic: { everyMs: 7_200_000, offsetMs: 0 },
  },
  {
    id: 'sms-heartbeat-verify', label: 'Verification de la preuve de vie SMS',
    source: 'sms/sms-heartbeat.service.ts',
    category: 'Notifications', kind: 'cron',
    scheduleHuman: 'chaque lundi à 09:20', criticality: 'moyenne', antiOverlap: false,
    note: "Second @Cron du MEME fichier que l'envoi de 09:00. Absent du catalogue jusqu'au 2026-08-21 : le garde d'exhaustivite raisonne PAR FICHIER, et un fichier deja revendique masquait son deuxieme traitement. C'est lui qui expliquait l'ecart permanent « 35 crons au runtime, 34 au catalogue ».",
    purpose: "Verifie vingt minutes apres l'envoi que le SMS de preuve de vie est reellement arrive (accuse de la passerelle). Un envoi sans verification rassure a tort : la chaine peut casser APRES l'acceptation du message.",
    fire: { tz: PARIS, matcher: (w) => w.getDay() === 1 && w.getHours() === 9 && w.getMinutes() === 20 },
  },
  {
    id: 'courrier-ia', label: 'Courrier IA (agent sur poste)',
    category: 'IA & rapports', kind: 'cron',
    scheduleHuman: '06:30 et 14:30 chaque jour — sur le poste du proprietaire',
    criticality: 'moyenne', antiOverlap: true,
    poste: 'outils/agent-courrier-ia.cmd',
    note: "Ne tourne PAS sur ce serveur. C'est le maillon central de la bascule locale (design/C1) : le serveur PREPARE les travaux IA (rapport d'activite, analyse de lieux) dans une file, ce courrier les redige via l'abonnement du poste, le serveur VALIDE et range. Il ne connait aucun metier — ajouter un type de travail ne le modifie pas. File vide = no-op immediat.",
    purpose: "Porte les travaux IA recurrents prepares par le serveur vers le modele, sur l'abonnement du poste : 0 credit d'API. La file en attente et les echecs sont affiches ci-contre — un echec persistant se voit, il ne se devine pas.",
    externe: 'courrier-ia',
    coutIa: 'absorbe',
    // DEUX passages, et c'est deliberement peu : le travail arrive a une heure imprevisible
    // (le producteur declare l'echeance a la minute :20 de n'importe quelle heure). Un seul
    // passage laissait jusqu'a 24 h de latence sur un rapport deja pret a rediger. Deux
    // couvrent matin et apres-midi, et une file vide sort en deux secondes SANS appeler le
    // moindre modele — le cout d'un passage inutile est nul.
    fire: { tz: PARIS, matcher: (w) => (w.getHours() === 6 || w.getHours() === 14) && w.getMinutes() === 30 },
  },
];

const FREQ_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };

@Injectable()
export class BackgroundTasksService {
  private readonly logger = new Logger(BackgroundTasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SchedulerRegistry,
  ) {}

  async list(): Promise<BackgroundTasksResponse> {
    const now = new Date();
    const nowMs = now.getTime();

    // Réglages des 3 automatisations IA (pour un « prochain lancement » fidèle à leur cadence).
    // Revue : même lecture que les crons consommateurs (orderBy updatedAt desc) pour lire
    // EXACTEMENT la ligne de réglages que le cron utilise, si plusieurs coexistent.
    const [tripS, activityS, agendaS, placeS, agentLimites, agentRecit, agentQualiteGps, rattrapageRecits, courrierIa, tripGarde] = await Promise.all([
      this.prisma.tripAutomationSettings.findFirst({ orderBy: { updatedAt: 'desc' } }).catch(() => null),
      this.prisma.activityReportSchedule.findFirst({ orderBy: { updatedAt: 'desc' } }).catch(() => null),
      this.prisma.agendaAgentSettings.findMany({ where: { enabled: true } }).catch(() => []),
      this.prisma.placeAutomationSettings.findFirst({ orderBy: { createdAt: 'asc' } }).catch(() => null),
      this.etatAgentLimites(),
      this.etatAgentRecit(),
      this.etatAgentQualiteGps(),
      this.etatRattrapageRecits(),
      this.etatCourrierIa(),
      this.gardeTrajets(nowMs),
    ]);

    const tasks: BackgroundTaskDto[] = CATALOG.map((e) => {
      const base: BackgroundTaskDto = {
        id: e.id, label: e.label, category: e.category, kind: e.kind,
        scheduleHuman: e.scheduleHuman, purpose: e.purpose, criticality: e.criticality,
        antiOverlap: e.antiOverlap, continuous: !!e.continuous, devOnly: !!e.devOnly,
        configurable: !!e.configurable, settingsRoute: e.settingsRoute ?? null,
        settingsSummary: null, enabled: null, nextRunAt: null, lastRunAt: null, note: e.note ?? null,
        // OÙ ça tourne et QUI paie — deux dimensions indépendantes. Un traitement peut tourner sur
        // le poste sans rien absorber (l'agent de limites de vitesse interroge OpenStreetMap, qui
        // est gratuit), et un traitement serveur peut ne consommer aucune IA.
        executor: e.externe ? 'poste-local' : 'serveur',
        coutIa: e.coutIa ?? (e.ai ? 'facture' : 'aucun'),
      };

      if (e.continuous) return base; // flux continu → pas de compte-à-rebours daté

      if (e.ai) return { ...base, ...this.aiTask(e.ai, tripS, activityS, agendaS, placeS, tripGarde, nowMs) };

      // Traitement externe : son etat vient du travail ECRIT en base, pas du registre local.
      if (e.externe === 'recit-trajet') {
        const next = e.fire ? nextFireInstant(e.fire.matcher, nowMs, e.fire.tz, nowMs) : null;
        return { ...base, ...agentRecit, nextRunAt: next ? next.toISOString() : null };
      }
      if (e.externe === 'limites-vitesse') {
        const next = e.fire ? nextFireInstant(e.fire.matcher, nowMs, e.fire.tz, nowMs) : null;
        return { ...base, ...agentLimites, nextRunAt: next ? next.toISOString() : null };
      }
      if (e.externe === 'courrier-ia') {
        const next = e.fire ? nextFireInstant(e.fire.matcher, nowMs, e.fire.tz, nowMs) : null;
        return { ...base, ...courrierIa, nextRunAt: next ? next.toISOString() : null };
      }
      if (e.externe === 'rattrapage-recits') {
        const next = e.periodic ? nextPeriodicTick(e.periodic.everyMs, e.periodic.offsetMs, nowMs) : null;
        return { ...base, ...rattrapageRecits, nextRunAt: next ? next.toISOString() : null };
      }
      if (e.externe === 'qualite-gps') {
        const next = e.fire ? nextFireInstant(e.fire.matcher, nowMs, e.fire.tz, nowMs) : null;
        return { ...base, ...agentQualiteGps, nextRunAt: next ? next.toISOString() : null };
      }

      // Cron daté (heure fixe ou haute fréquence).
      const next = e.periodic
        ? nextPeriodicTick(e.periodic.everyMs, e.periodic.offsetMs, nowMs)
        : e.fire
          ? nextFireInstant(e.fire.matcher, nowMs, e.fire.tz, nowMs)
          : null;
      return { ...base, nextRunAt: next ? next.toISOString() : null };
    });

    return {
      tasks,
      serverNow: now.toISOString(),
      serverTimezone: SERVER_TZ,
      health: this.buildHealth(),
    };
  }

  /**
   * État de l'agent de limites de vitesse, qui tourne sur le POSTE du propriétaire.
   *
   * ⚠️ On ne lui demande pas s'il va bien : on regarde ce qu'il a ÉCRIT. La date de la dernière
   * cellule résolue prouve du travail réel — un agent qui démarre puis échoue silencieusement
   * (poste éteint, Overpass qui refuse, session fermée) n'avancera pas cette date, et ça se verra
   * ici. Un simple signal de démarrage aurait menti.
   *
   * `enabled` reflète la même chose : « a-t-il produit quelque chose récemment ? ». Le serveur ne
   * peut pas savoir si la tâche planifiée existe encore sur le poste ; il peut savoir si elle
   * travaille.
   */
  private async etatAgentLimites(): Promise<{ enabled: boolean | null; lastRunAt: string | null; settingsSummary: string | null }> {
    try {
      const [dernier, resolues, restantes] = await Promise.all([
        this.prisma.speedLimitCache.aggregate({ _max: { createdAt: true } }),
        this.prisma.speedLimitCache.count({ where: { maxspeed: { not: null } } }),
        this.prisma.tripAnalysis.count({ where: { limitsKnown: false } }),
      ]);
      const at = dernier._max.createdAt ?? null;
      // Deux creneaux d'ecart (le plus long trou de la journee est 22:00 -> 04:30, soit 6h30) :
      // au-dela, l'agent ne travaille plus et ce n'est pas un simple alea.
      const frais = at !== null && Date.now() - at.getTime() < 13 * 3_600_000;
      return {
        enabled: at === null ? null : frais,
        lastRunAt: at ? at.toISOString() : null,
        settingsSummary: `${resolues.toLocaleString('fr-FR')} limites résolues · ${restantes.toLocaleString('fr-FR')} trajets encore sans limite`,
      };
    } catch {
      // La supervision ne doit jamais faire tomber la page qu'elle supervise.
      return { enabled: null, lastRunAt: null, settingsSummary: null };
    }
  }
  /**
   * État du COURRIER IA — le maillon central de la bascule locale (design/C1).
   *
   * Deux sources croisées, parce qu'aucune ne suffit seule : le JOURNAL DES PASSAGES dit s'il
   * a tourné (il peut légitimement ne rien livrer — file vide un mardi), et la FILE dit si du
   * travail attend ou a échoué. Un courrier « sain » avec des échecs en file est un mensonge ;
   * une file vide avec un courrier muet depuis deux jours en est un autre.
   */
  private async etatCourrierIa(): Promise<{ enabled: boolean | null; lastRunAt: string | null; settingsSummary: string | null }> {
    try {
      const [passage, aFaire, faits, echecs] = await Promise.all([
        this.prisma.passageAgentLocal.findFirst({ where: { agent: 'agent-courrier-ia' }, orderBy: { finiA: 'desc' } }),
        this.prisma.travailIaLocal.count({ where: { statut: 'a-faire' } }),
        this.prisma.travailIaLocal.count({ where: { statut: 'fait' } }),
        this.prisma.travailIaLocal.count({ where: { statut: 'echec' } }),
      ]);
      const resume =
        `file : ${aFaire} en attente · ${faits} a ranger` +
        (echecs > 0 ? ` · ⚠ ${echecs} en echec definitif` : '');
      if (!passage) {
        return { enabled: null, lastRunAt: null, settingsSummary: resume };
      }
      // Passage quotidien : 30 h de silence couvrent un creneau manque + la marge de rattrapage.
      const frais = Date.now() - passage.finiA.getTime() < 30 * 3_600_000;
      return {
        enabled: frais && passage.succes && echecs === 0,
        lastRunAt: passage.finiA.toISOString(),
        settingsSummary: resume,
      };
    } catch {
      return { enabled: null, lastRunAt: null, settingsSummary: null };
    }
  }

  /**
   * État du RATTRAPAGE des récits — la tâche temporaire du poste (fenêtre 1 500 h).
   *
   * Même production que l'agent nocturne (des récits `provider = 'local'`), donc même preuve de
   * travail. Ce qui change est la LECTURE DU ZÉRO : quand il ne reste plus rien à narrer, l'agent
   * sort immédiatement sans rien écrire — le « dernier travail » stagne alors LÉGITIMEMENT. Sans
   * ce cas, la tâche serait déclarée en panne précisément au moment où elle a fini son travail,
   * et l'écran crierait sur un succès.
   */
  private async etatRattrapageRecits(): Promise<{ enabled: boolean | null; lastRunAt: string | null; settingsSummary: string | null }> {
    try {
      const [dernier, restants] = await Promise.all([
        this.prisma.tripAnalysis.aggregate({ where: { provider: 'local' }, _max: { updatedAt: true } }),
        this.prisma.tripAnalysis.count({ where: { narrative: null } }),
      ]);
      const at = dernier._max.updatedAt ?? null;
      if (restants === 0) {
        return {
          enabled: at !== null,
          lastRunAt: at ? at.toISOString() : null,
          settingsSummary: 'arriéré résorbé — la tâche est devenue sans objet et peut être désinscrite du poste',
        };
      }
      // Trois creneaux de 2 h sans production alors qu'il reste du travail : ce n'est plus un alea.
      const frais = at !== null && Date.now() - at.getTime() < 6 * 3_600_000;
      return {
        enabled: at === null ? null : frais,
        lastRunAt: at ? at.toISOString() : null,
        settingsSummary: restants.toLocaleString('fr-FR') + ' récit(s) encore à écrire (rattrapage + flux courant)',
      };
    } catch {
      // La supervision ne doit jamais faire tomber la page qu'elle supervise.
      return { enabled: null, lastRunAt: null, settingsSummary: null };
    }
  }

  /**
   * État de l'agent de RÉCIT, qui tourne sur le POSTE du propriétaire.
   *
   * Même principe que pour les limites de vitesse : on ne lui demande pas s'il va bien, on regarde
   * ce qu'il a ÉCRIT. `provider = 'local'` distingue ses récits de ceux produits par l'API — sans
   * cette marque, un récit fait la nuit sur le poste serait indiscernable d'un récit facturé, et
   * l'écran ne saurait pas dire si l'agent travaille encore.
   *
   * `enabled` répond à « a-t-il produit quelque chose récemment ? ». Le serveur ne peut pas savoir
   * si la tâche planifiée existe toujours sur le poste, ni si la session Claude Code y est encore
   * ouverte ; il peut savoir si des récits arrivent.
   */
  private async etatAgentRecit(): Promise<{ enabled: boolean | null; lastRunAt: string | null; settingsSummary: string | null }> {
    try {
      const [dernier, ecrits, restants] = await Promise.all([
        this.prisma.tripAnalysis.aggregate({ where: { provider: 'local' }, _max: { updatedAt: true } }),
        this.prisma.tripAnalysis.count({ where: { provider: 'local' } }),
        this.prisma.tripAnalysis.count({ where: { narrative: null } }),
      ]);
      const at = dernier._max.updatedAt ?? null;
      // Un passage par nuit : au-delà de 36 h sans récit, ce n'est plus un aléa.
      const frais = at !== null && Date.now() - at.getTime() < 36 * 3_600_000;
      return {
        enabled: at === null ? null : frais,
        lastRunAt: at ? at.toISOString() : null,
        settingsSummary: `${ecrits.toLocaleString('fr-FR')} récit(s) écrits sur le poste · ${restants.toLocaleString('fr-FR')} trajet(s) encore sans récit`,
      };
    } catch {
      // La supervision ne doit jamais faire tomber la page qu'elle supervise.
      return { enabled: null, lastRunAt: null, settingsSummary: null };
    }
  }

  /**
   * État de l'agent de QUALITÉ GPS, qui tourne sur le POSTE du propriétaire.
   *
   * ⚠️ ET QUI NE SE DÉDUIT PAS DE LA MÊME FAÇON QUE LES DEUX AUTRES. Pour les limites de vitesse
   * et les récits, on regarde ce que l'agent a ÉCRIT, parce qu'ils ont toujours du travail en
   * attente : une date qui n'avance plus y signifie vraiment une panne.
   *
   * Celui-ci peut légitimement ne RIEN écrire d'une nuit. S'il ne trouve aucune zone partagée par
   * deux véhicules et aucun boîtier dispersé, il n'a rien à signaler — et c'est le résultat
   * normal, celui qu'on espère. Copier le raisonnement des deux autres ferait donc afficher
   * « agent à l'arrêt » précisément quand le parc va bien. Une supervision qui crie au loup les
   * bonnes nuits finit par ne plus être lue.
   *
   * D'où la séparation stricte :
   *   « a-t-il TOURNÉ ? »  → `passages_agents_locaux`, une ligne par passage, même vide.
   *   « a-t-il TROUVÉ ? »  → le résumé ci-dessous, qui compte les diagnostics ouverts.
   *
   * Et la ligne de passage n'est écrite qu'à la FIN, avec son issue : un signal de démarrage
   * mentirait exactement comme le faisait `psql` en sortant en 0 sur une erreur SQL.
   */
  private async etatAgentQualiteGps(): Promise<{ enabled: boolean | null; lastRunAt: string | null; settingsSummary: string | null }> {
    try {
      const [passage, ouverts] = await Promise.all([
        this.prisma.passageAgentLocal.findFirst({
          where: { agent: 'agent-qualite-gps' },
          orderBy: { finiA: 'desc' },
        }),
        this.prisma.gpsZoneDiagnostic.count({ where: { traiteAt: null } }),
      ]);
      if (!passage) {
        // Jamais vu passer : on ne prétend pas savoir. `null` affiche « inconnu », pas « en panne ».
        return { enabled: null, lastRunAt: null, settingsSummary: `${ouverts} zone(s) en attente de relecture` };
      }
      // Un passage par nuit : au-delà de 36 h, ce n'est plus un aléa. Même seuil que le récit.
      const frais = Date.now() - passage.finiA.getTime() < 36 * 3_600_000;
      return {
        // Un passage FRAIS mais en ÉCHEC reste un problème : l'agent tourne et n'aboutit pas.
        enabled: frais && passage.succes,
        lastRunAt: passage.finiA.toISOString(),
        settingsSummary: passage.succes
          ? `${passage.resume} · ${ouverts} zone(s) en attente de relecture`
          : `Dernier passage en échec : ${passage.erreur ?? 'motif non consigné'}`,
      };
    } catch {
      // La supervision ne doit jamais faire tomber la page qu'elle supervise.
      return { enabled: null, lastRunAt: null, settingsSummary: null };
    }
  }

  /** Calcule enabled / prochain / dernier / résumé pour une automatisation IA depuis ses réglages. */
  private aiTask(
    kind: 'trip' | 'activity' | 'agenda' | 'place',
    tripS: { enabled: boolean; frequency: string; hour: number; lastRunAt: Date | null } | null,
    activityS: { enabled: boolean; frequency: string; lastRunAt: Date | null } | null,
    agendaS: Array<{ enabled: boolean; nightlyHour: number; frequency: string; triggerNightly: boolean; lastRunAt: Date | null }>,
    placeS: { enabled: boolean; hour: number; minIntervalDays: number; maxAnalysesPerRun: number; maxCostEurPerRun: number; lastRunAt: Date | null } | null,
    tripGarde: { dernierDepart: Date | null; ticksAnnules24h: number },
    nowMs: number,
  ): Partial<BackgroundTaskDto> {
    if (kind === 'place') {
      if (!placeS?.enabled) {
        return { enabled: false, settingsSummary: 'En pause', lastRunAt: placeS?.lastRunAt?.toISOString() ?? null };
      }
      const lastMs = placeS.lastRunAt?.getTime() ?? 0;
      const earliest = lastMs ? lastMs + 22 * 3600_000 : nowMs;
      const next = nextFireInstant((w) => w.getHours() === placeS.hour && w.getMinutes() === 10, earliest, PARIS, nowMs);
      return {
        enabled: true, nextRunAt: next?.toISOString() ?? null, lastRunAt: placeS.lastRunAt?.toISOString() ?? null,
        // Le résumé affiche les PLAFONDS : c'est la question qu'on se pose devant une tâche IA.
        settingsSummary: `Actif · ${placeS.hour}h · max ${placeS.maxAnalysesPerRun} / ${placeS.maxCostEurPerRun} € par passage · 1 lieu / ${placeS.minIntervalDays} j`,
      };
    }
    if (kind === 'trip') {
      if (!tripS?.enabled) return { enabled: false, settingsSummary: 'En pause', lastRunAt: tripS?.lastRunAt?.toISOString() ?? null };
      const daily = tripS.frequency === 'daily';
      const guardMs = daily ? 22 * 3600_000 : 50 * 60_000;
      // TRK-043 — la garde runtime mesure l'espacement depuis le DÉPART du dernier passage,
      // plus depuis sa fin : l'écran doit prédire le MÊME prochain tick, sinon il annonce une
      // heure de retard qui n'existe plus. Repli sur la fin (`lastRunAt`) si l'historique des
      // passages est illisible — le même repli que la garde elle-même.
      const refMs = tripGarde.dernierDepart?.getTime() ?? tripS.lastRunAt?.getTime() ?? 0;
      const earliest = refMs ? refMs + guardMs : nowMs;
      const matcher = daily
        ? (w: Date) => w.getHours() === tripS.hour && w.getMinutes() === 45
        : (w: Date) => w.getMinutes() === 45;
      const next = nextFireInstant(matcher, earliest, PARIS, nowMs);
      // Correctif n°4 de TRK-043 : les ticks annulés s'affichent À CÔTÉ de la cadence déclarée.
      // « Actif · chaque heure » qui n'exécute que 14 passages sur 24 ne doit plus pouvoir se
      // lire comme un traitement sain.
      const annules = tripGarde.ticksAnnules24h > 0 ? ` · ${tripGarde.ticksAnnules24h} tick(s) annulé(s) sur 24 h` : '';
      return {
        enabled: true, nextRunAt: next?.toISOString() ?? null, lastRunAt: tripS.lastRunAt?.toISOString() ?? null,
        settingsSummary: `Actif · ${daily ? `quotidien à ${tripS.hour}h` : 'chaque heure'}${annules}`,
      };
    }
    if (kind === 'activity') {
      if (!activityS?.enabled) return { enabled: false, settingsSummary: 'En pause', lastRunAt: activityS?.lastRunAt?.toISOString() ?? null };
      const periodDays = FREQ_DAYS[activityS.frequency] ?? 7;
      const lastMs = activityS.lastRunAt?.getTime() ?? 0;
      const earliest = lastMs ? lastMs + periodDays * DAY_MS : nowMs;
      const next = nextFireInstant((w) => w.getMinutes() === 20, earliest, SERVER_TZ, nowMs);
      const label = activityS.frequency === 'daily' ? 'quotidien' : activityS.frequency === 'monthly' ? 'mensuel' : 'hebdomadaire';
      return {
        enabled: true, nextRunAt: next?.toISOString() ?? null, lastRunAt: activityS.lastRunAt?.toISOString() ?? null,
        settingsSummary: `Actif · ${label}`,
      };
    }
    // agenda : par flotte → on prend la PROCHAINE échéance la plus proche parmi les flottes actives.
    const eligible = agendaS.filter((a) => a.enabled && a.triggerNightly);
    if (eligible.length === 0) return { enabled: false, settingsSummary: 'Aucune flotte active' };
    let soonest: number | null = null;
    let lastMax = 0;
    for (const a of eligible) {
      const periodMs = (a.frequency === 'weekly' ? 7 : 1) * DAY_MS - 2 * 3600_000;
      const lastMs = a.lastRunAt?.getTime() ?? 0;
      if (lastMs > lastMax) lastMax = lastMs;
      const earliest = lastMs ? lastMs + periodMs : nowMs;
      const next = nextFireInstant((w) => w.getHours() === a.nightlyHour && w.getMinutes() === 0, earliest, PARIS, nowMs);
      if (next && (soonest === null || next.getTime() < soonest)) soonest = next.getTime();
    }
    return {
      enabled: true,
      nextRunAt: soonest ? new Date(soonest).toISOString() : null,
      lastRunAt: lastMax ? new Date(lastMax).toISOString() : null,
      settingsSummary: `${eligible.length} flotte(s) active(s)`,
    };
  }

  /**
   * TRK-043 — ce que l'écran doit savoir de la garde anti double-run des trajets : le DERNIER
   * DÉPART persisté (`trip_automation_runs`) et le nombre de ticks annulés sur 24 h (lignes
   * `trip_automation_tick_annule` que la garde écrit désormais au journal système).
   *
   * Défensif de bout en bout (même style que les `etat*` ci-dessus) : un échec de lecture rend
   * { null, 0 } et l'écran retombe sur l'affichage d'avant — jamais d'écran cassé pour une
   * décoration. C'est aussi ce qui laisse vivre les specs à mock prisma partiel.
   */
  private async gardeTrajets(nowMs: number): Promise<{ dernierDepart: Date | null; ticksAnnules24h: number }> {
    try {
      const [depart, annules] = await Promise.all([
        this.prisma.tripAutomationRun.findFirst({ orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
        this.prisma.systemActivityLog.count({
          where: { action: 'trip_automation_tick_annule', createdAt: { gte: new Date(nowMs - 24 * 3600_000) } },
        }),
      ]);
      return { dernierDepart: depart?.startedAt ?? null, ticksAnnules24h: annules };
    } catch {
      return { dernierDepart: null, ticksAnnules24h: 0 };
    }
  }

  /** Croise le catalogue avec le SchedulerRegistry runtime pour détecter un drift (job non catalogué). */
  private buildHealth(): BackgroundTasksResponse['health'] {
    let registeredCronCount = 0;
    let registeredIntervalCount = 0;
    let cronKeys: string[] = [];
    try {
      const crons = this.registry.getCronJobs();
      registeredCronCount = crons.size;
      cronKeys = Array.from(crons.keys());
    } catch { /* registry indisponible */ }
    try {
      registeredIntervalCount = this.registry.getIntervals().length;
    } catch { /* idem */ }

    // SANS le filtre `!e.externe`, les agents du poste comptaient comme des crons NestJS :
    // le bandeau « ecart runtime/catalogue » etait affiche EN PERMANENCE (35 contre 37 releve
    // en production le 2026-08-21). Un faux positif permanent apprend a ignorer l'alerte — le
    // jour ou elle dit vrai, personne ne la lit. Les taches du poste ont leur PROPRE preuve de
    // vie (le travail ecrit en base) ; elles n'ont rien a faire dans ce comptage-ci.
    const catalogCronCount = CATALOG.filter((e) => !e.externe && e.kind === 'cron').length;
    const catalogIntervalCount = CATALOG.filter((e) => !e.externe && e.kind === 'interval').length;

    // Les noms de jobs étant auto-générés (non nommés), on ne peut pas mapper 1:1. On signale
    // donc un drift UNIQUEMENT s'il y a PLUS de jobs enregistrés que catalogués, en listant les
    // clés runtime pour investigation. Un compte égal = tout est catalogué.
    const uncataloguedJobs = registeredCronCount > catalogCronCount ? cronKeys : [];

    return { registeredCronCount, registeredIntervalCount, catalogCronCount, catalogIntervalCount, uncataloguedJobs };
  }
}
