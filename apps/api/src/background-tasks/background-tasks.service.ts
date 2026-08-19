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
  externe?: 'limites-vitesse';
  /** Qui paie le travail IA. Défaut déduit : `facture` pour une automatisation IA, `aucun` sinon. */
  coutIa?: BgTaskCoutIa;
}

const CATALOG: CatalogEntry[] = [
  // ───────── Sécurité & moteur ─────────
  {
    id: 'vehicle-schedules', label: 'Horaires véhicules (coupe/reprise auto)', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    configurable: true, settingsRoute: '/fleet-schedules',
    purpose: 'Coupe ou rend le moteur selon les horaires programmés (jamais en mouvement ; attend 10 min d\'arrêt).',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },
  {
    id: 'audio-auto-disarm', label: 'Auto-désarmement écoute audio', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    purpose: 'Filet de sécurité : remet un boîtier resté en écoute (micro) en mode suivi GPS pour qu\'il réapparaisse sur la carte.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },
  {
    id: 'surveillance-scheduler', label: 'Armement auto des surveillances', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    purpose: 'Arme/désarme automatiquement les profils de surveillance selon leurs plages horaires.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },
  {
    id: 'tracker-commands-scheduler', label: 'Envoi des commandes programmées', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'toutes les 30 s', criticality: 'moyenne', antiOverlap: false,
    purpose: 'Envoie aux boîtiers les commandes planifiées dont l\'heure est arrivée (10 par passage).',
    periodic: { everyMs: 30_000, offsetMs: 0 },
  },
  {
    id: 'fix-command-expiry', label: 'Clôture des commandes de cadence sans réponse', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'toutes les 10 min', criticality: 'moyenne', antiOverlap: true,
    purpose: 'Ferme les commandes de cadence GPS restées sans effet : le boîtier n\'accuse jamais réception, elles resteraient « en attente » indéfiniment au centre d\'alertes.',
    periodic: { everyMs: 600_000, offsetMs: 45_000 },
  },
  {
    id: 'trips-timeout', label: 'Clôture des trajets en cours', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'moyenne', antiOverlap: false,
    purpose: 'Ferme les trajets restés « en cours » alors que le véhicule est à l\'arrêt depuis un moment.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },

  {
    id: 'error-rate-watchdog', label: "Vigie de saturation du centre d'alerte", category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'toutes les 10 min', criticality: 'moyenne', antiOverlap: true,
    purpose: "Prévient par e-mail quand plus de 5 erreurs sont enregistrées sur l'heure glissante (1 e-mail/h max).",
    periodic: { everyMs: 600_000, offsetMs: 0 },
  },

  // ───────── IA & rapports ─────────
  {
    id: 'trip-automation', label: 'Automatisation des trajets (analyse + récit IA)', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'toutes les heures à HH:45 (si réglé)', criticality: 'moyenne', antiOverlap: true,
    configurable: true, settingsRoute: '/admin/trip-automation', ai: 'trip',
    purpose: 'Recalcule les trajets, lance l\'analyse et le récit IA pour toutes les flottes, selon la cadence réglée.',
  },
  {
    id: 'place-automation', label: 'Automatisation des analyses de lieux', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'chaque jour à l\'heure réglée (sondé à HH:10)', criticality: 'basse', antiOverlap: true,
    configurable: true, settingsRoute: '/admin/place-automation', ai: 'place',
    purpose: 'Analyse les lieux clés dont les faits ont changé, sous plafonds de nombre et de dépense. Désactivé par défaut.',
  },
  {
    id: 'activity-report', label: 'Rapport IA d\'activité utilisateurs', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'à échéance (vérifié chaque heure)', criticality: 'basse', antiOverlap: false,
    configurable: true, settingsRoute: '/admin/activity', ai: 'activity',
    purpose: 'Génère un rapport IA d\'observation de l\'activité (quotidien / hebdo / mensuel selon réglage).',
  },
  {
    id: 'agenda-agent', label: 'Agent nocturne d\'optimisation d\'agenda', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'chaque nuit à l\'heure réglée (par flotte)', criticality: 'moyenne', antiOverlap: true,
    configurable: true, settingsRoute: '/agenda', ai: 'agenda',
    note: 'Se règle dans l\'Agenda (par flotte), pas ici.',
    purpose: 'Détecte les trajets récurrents et propose (ou crée) des réservations, chaque nuit, par flotte.',
  },
  {
    id: 'reports-weekly', label: 'E-mail hebdo du rapport PDF', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'chaque lundi à 08:00', criticality: 'basse', antiOverlap: false,
    purpose: 'Envoie par e-mail le rapport PDF de la semaine passée à chaque flotte (destinataire réglé sur la fiche flotte).',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getDay() === 1 && w.getHours() === 8 && w.getMinutes() === 0 },
  },

  // ───────── Maintenance données ─────────
  {
    id: 'log-cleanup', label: 'Purge des journaux', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 03:00', criticality: 'moyenne', antiOverlap: false,
    purpose: 'Supprime les vieux journaux (wire / erreurs / audit) et les journaux SMS de plus de 90 jours (numéros + contenu).',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 0 },
  },
  {
    id: 'mission-share-purge', label: 'Purge des liens de partage expirés', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:15', criticality: 'basse', antiOverlap: true,
    note: 'Purge REELLE. Les 30 jours de conservation servent l\'audit : qui a ouvert cet accès, quand, combien de fois.',
    purpose: 'Supprime les liens publics de suivi de mission expirés depuis plus de 30 jours (avec leurs empreintes d\'ouverture tronquées).',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 15 },
  },
  {
    id: 'trips-retention', label: 'Rétention des trajets (RGPD)', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 03:45', criticality: 'moyenne', antiOverlap: false,
    note: 'Purge REELLE et irreversible. Pour stopper : TRIPS_RETENTION_MONTHS=0.',
    purpose: 'Supprime définitivement les trajets de plus de 12 mois, avec leurs analyses IA et arrêts carburant liés.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 45 },
  },
  {
    id: 'work-time-registry', label: 'Registre du temps de travail (RGPD)', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:00', criticality: 'basse', antiOverlap: false,
    purpose: 'Agrège chaque nuit les trajets attribués en un registre journalier par conducteur (sans positions, rétention 5 ans) et purge les entrées expirées.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 0 },
  },
  {
    id: 'positions-retention', label: 'Rétention des positions GPS', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 03:30', criticality: 'moyenne', antiOverlap: false,
    configurable: true, settingsRoute: '/admin/retention', note: 'Purge REELLE et irreversible. Pour stopper : POSITIONS_RETENTION_DAYS=0.',
    purpose: 'Supprime définitivement les positions GPS de plus de 60 jours (rétention CNIL), par lots bornés.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 30 },
  },
  {
    id: 'user-activity-close', label: 'Clôture des sessions inactives', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'toutes les 2 min', criticality: 'basse', antiOverlap: false,
    purpose: 'Ferme les sessions utilisateurs restées ouvertes sans signal (onglet fermé sans notification).',
    periodic: { everyMs: 120_000, offsetMs: 30_000 },
  },
  {
    id: 'user-activity-purge', label: 'Purge de l\'historique d\'activité (>90j)', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:15', criticality: 'basse', antiOverlap: false,
    purpose: 'Supprime l\'historique d\'activité utilisateurs de plus de 90 jours.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 15 },
  },
  {
    id: 'security-login-purge', label: 'Purge des événements de connexion (>365j)', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 03:00 (Paris)', criticality: 'basse', antiOverlap: false,
    purpose: 'Supprime les événements de connexion (carte des lieux, appareils) de plus d\'un an — rétention sécurité.',
    fire: { tz: PARIS, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 0 },
  },
  {
    id: 'sims-sync', label: 'Synchronisation du parc SIM', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'toutes les 30 min', criticality: 'basse', antiOverlap: false,
    purpose: 'Met à jour l\'état des cartes SIM depuis le fournisseur (consommation, statut).',
    periodic: { everyMs: 1_800_000, offsetMs: 0 },
  },

  // ───────── Système & observabilité ─────────
  {
    id: 'metrics-purge', label: 'Purge des métriques système (>30j)', category: 'Système & observabilité',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:30', criticality: 'basse', antiOverlap: false,
    purpose: 'Supprime les mesures de charge du serveur de plus de 30 jours.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 30 },
  },
  {
    id: 'backup-health', label: 'Contrôle santé des sauvegardes', category: 'Système & observabilité',
    kind: 'cron', scheduleHuman: 'chaque jour à 06:00', criticality: 'haute', antiOverlap: false,
    purpose: 'Vérifie qu\'une sauvegarde de la base a bien eu lieu dans les 30 dernières heures, sinon alerte.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 6 && w.getMinutes() === 0 },
  },
  {
    id: 'gps-integrity', label: 'Détection GPS perdu (boîtiers vivants sans position)', category: 'Système & observabilité',
    kind: 'cron', scheduleHuman: 'toutes les 5 min', criticality: 'moyenne', antiOverlap: true,
    purpose: 'Repère les boîtiers qui communiquent encore mais n\'envoient plus de position GPS (antenne/ciel) et lève une alerte véhicule + centre d\'alertes.',
    periodic: { everyMs: 300_000, offsetMs: 15_000 },
  },
  {
    id: 'metrics-collect', label: 'Collecte des métriques serveur (VPS)', category: 'Système & observabilité',
    kind: 'interval', scheduleHuman: 'flux continu · toutes les 60 s', criticality: 'basse', antiOverlap: false,
    continuous: true, settingsRoute: '/admin/system',
    purpose: 'Enregistre en continu la charge CPU/mémoire/disque du serveur (monitoring VPS).',
  },
  {
    id: 'dependency-heartbeat', label: 'Sonde active des dépendances externes', category: 'Système & observabilité',
    kind: 'cron', scheduleHuman: 'toutes les 5 min (à :30 s)', criticality: 'haute', antiOverlap: true,
    note: 'Née de la panne Vizyo Auth du 18-21/07 restée invisible 3 jours. Sonde les adresses PUBLIQUES (jamais internes).',
    purpose: 'Vérifie que les services dont Tracky dépend (Vizyo Auth, passerelle SMS…) répondent réellement ; 2 échecs consécutifs ⇒ alerte au centre d\'alertes (panne signalée en ~10 min).',
    periodic: { everyMs: 300_000, offsetMs: 30_000 },
  },
  {
    id: 'cache-cleanup', label: 'Nettoyage du cache mémoire', category: 'Système & observabilité',
    kind: 'setInterval', scheduleHuman: 'flux continu · toutes les 60 s', criticality: 'basse', antiOverlap: false,
    continuous: true,
    purpose: 'Retire du cache interne les entrées expirées pour éviter que la mémoire grossisse.',
  },

  // ───────── Temps réel ─────────
  {
    id: 'position-broadcast', label: 'Diffusion temps réel des positions', category: 'Temps réel',
    kind: 'interval', scheduleHuman: 'flux continu · toutes les 1 s', criticality: 'moyenne', antiOverlap: false,
    continuous: true,
    purpose: 'Regroupe et diffuse les positions aux écrans clients une fois par seconde (fluidité sous charge).',
  },
  {
    id: 'position-batch', label: 'Enregistrement groupé des positions', category: 'Temps réel',
    kind: 'setInterval', scheduleHuman: 'flux continu · toutes les 100 ms', criticality: 'moyenne', antiOverlap: true,
    continuous: true,
    purpose: 'Insère les positions reçues par paquets pour tenir la charge d\'ingestion GPS.',
  },
  {
    id: 'ignition-cleanup', label: 'Extinction contact inféré', category: 'Temps réel',
    kind: 'interval', scheduleHuman: 'flux continu · toutes les 60 s', criticality: 'moyenne', antiOverlap: false,
    continuous: true,
    purpose: 'Passe le contact à « éteint » pour les boîtiers sans fil ACC devenus silencieux (marqueur carte à jour).',
  },
  {
    id: 'realtime-revalidate', label: 'Revalidation des connexions live', category: 'Temps réel',
    kind: 'interval', scheduleHuman: 'flux continu · toutes les 60 s', criticality: 'moyenne', antiOverlap: false,
    continuous: true,
    purpose: 'Déconnecte les sessions temps réel dont l\'utilisateur n\'est plus actif (sécurité).',
  },
  {
    id: 'mock-emitter', label: 'Émetteur de positions factices', category: 'Temps réel',
    kind: 'setInterval', scheduleHuman: 'développement uniquement', criticality: 'basse', antiOverlap: false,
    continuous: true, devOnly: true, note: 'Inactif en production.',
    purpose: 'Simule le mouvement de véhicules pour les tests (jamais actif en production).',
  },

  // ───────── Intégration partenaire (Tracky × Maestroo) ─────────
  {
    id: 'partner-sync', label: 'Synchro véhicules → Maestroo (merge à 3 voies)', category: 'Intégration partenaire',
    kind: 'cron', scheduleHuman: 'toutes les 30 min', criticality: 'moyenne', antiOverlap: true,
    settingsRoute: '/admin/partner-links',
    purpose: 'Re-pousse l\'identité des véhicules des liens partenaires ACTIFS, applique les corrections Tracky (fast-forward) et journalise les écarts détectés. Ne supprime jamais rien, respecte les catégories consenties.',
    periodic: { everyMs: 1_800_000, offsetMs: 0 },
  },
  {
    id: 'partner-outbox', label: 'Rejeu des webhooks partenaires (révocations)', category: 'Intégration partenaire',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    settingsRoute: '/admin/partner-links',
    note: 'Un webhook de révocation perdu serait une révocation perdue : ce cron est le filet du levier commercial.',
    purpose: 'Rejoue les webhooks non délivrés au partenaire (révocation, coupure de catégorie, suspension) avec attente progressive, jusqu\'à 12 tentatives.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },

  // ───────── Notifications ─────────
  {
    id: 'escalation', label: 'Escalade des alertes critiques', category: 'Notifications',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'haute', antiOverlap: true,
    purpose: 'Relance les destinataires quand une alerte critique n\'est pas acquittée à temps.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },
  {
    id: 'maintenance-reminder', label: 'Rappels d\'échéances de maintenance', category: 'Notifications',
    kind: 'cron', scheduleHuman: 'chaque jour à 07:00', criticality: 'moyenne', antiOverlap: true,
    purpose: 'Prévient les responsables quand une échéance d\'entretien approche (préavis réglé par plan).',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 7 && w.getMinutes() === 0 },
  },
  {
    id: 'sms-heartbeat', label: 'Preuve de vie SMS (passerelle)', category: 'Notifications',
    kind: 'cron', scheduleHuman: 'chaque lundi à 09:00', criticality: 'moyenne', antiOverlap: false,
    purpose: 'Envoie un SMS de test aux admins pour vérifier que la chaîne SMS fonctionne.',
    fire: { tz: PARIS, matcher: (w) => w.getDay() === 1 && w.getHours() === 9 && w.getMinutes() === 0 },
  },
  {
    id: 'notification-retention', label: 'Purge du journal de notifications', category: 'Notifications',
    kind: 'cron', scheduleHuman: 'chaque jour à 04:45', criticality: 'basse', antiOverlap: false,
    note: 'Retenues purgées à 30 j (volumineuses), envois réels conservés 180 j (trace d\'exploitation).',
    purpose: 'Purge le journal du centre de notifications : sans elle, ~300 000 lignes par mois une fois le push ouvert à tous les rôles.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 4 && w.getMinutes() === 45 },
  },
  {
    id: 'sms-allowlist-reconcile', label: 'Réconciliation de l\'allowlist SMS', category: 'Notifications',
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
    const [tripS, activityS, agendaS, placeS, agentLimites] = await Promise.all([
      this.prisma.tripAutomationSettings.findFirst({ orderBy: { updatedAt: 'desc' } }).catch(() => null),
      this.prisma.activityReportSchedule.findFirst({ orderBy: { updatedAt: 'desc' } }).catch(() => null),
      this.prisma.agendaAgentSettings.findMany({ where: { enabled: true } }).catch(() => []),
      this.prisma.placeAutomationSettings.findFirst({ orderBy: { createdAt: 'asc' } }).catch(() => null),
      this.etatAgentLimites(),
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

      if (e.ai) return { ...base, ...this.aiTask(e.ai, tripS, activityS, agendaS, placeS, nowMs) };

      // Traitement externe : son etat vient du travail ECRIT en base, pas du registre local.
      if (e.externe === 'limites-vitesse') {
        const next = e.fire ? nextFireInstant(e.fire.matcher, nowMs, e.fire.tz, nowMs) : null;
        return { ...base, ...agentLimites, nextRunAt: next ? next.toISOString() : null };
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
  /** Calcule enabled / prochain / dernier / résumé pour une automatisation IA depuis ses réglages. */
  private aiTask(
    kind: 'trip' | 'activity' | 'agenda' | 'place',
    tripS: { enabled: boolean; frequency: string; hour: number; lastRunAt: Date | null } | null,
    activityS: { enabled: boolean; frequency: string; lastRunAt: Date | null } | null,
    agendaS: Array<{ enabled: boolean; nightlyHour: number; frequency: string; triggerNightly: boolean; lastRunAt: Date | null }>,
    placeS: { enabled: boolean; hour: number; minIntervalDays: number; maxAnalysesPerRun: number; maxCostEurPerRun: number; lastRunAt: Date | null } | null,
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
      const lastMs = tripS.lastRunAt?.getTime() ?? 0;
      const daily = tripS.frequency === 'daily';
      const guardMs = daily ? 22 * 3600_000 : 50 * 60_000;
      const earliest = lastMs ? lastMs + guardMs : nowMs;
      const matcher = daily
        ? (w: Date) => w.getHours() === tripS.hour && w.getMinutes() === 45
        : (w: Date) => w.getMinutes() === 45;
      const next = nextFireInstant(matcher, earliest, PARIS, nowMs);
      return {
        enabled: true, nextRunAt: next?.toISOString() ?? null, lastRunAt: tripS.lastRunAt?.toISOString() ?? null,
        settingsSummary: `Actif · ${daily ? `quotidien à ${tripS.hour}h` : 'chaque heure'}`,
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

    const catalogCronCount = CATALOG.filter((e) => e.kind === 'cron').length;
    const catalogIntervalCount = CATALOG.filter((e) => e.kind === 'interval').length;

    // Les noms de jobs étant auto-générés (non nommés), on ne peut pas mapper 1:1. On signale
    // donc un drift UNIQUEMENT s'il y a PLUS de jobs enregistrés que catalogués, en listant les
    // clés runtime pour investigation. Un compte égal = tout est catalogué.
    const uncataloguedJobs = registeredCronCount > catalogCronCount ? cronKeys : [];

    return { registeredCronCount, registeredIntervalCount, catalogCronCount, catalogIntervalCount, uncataloguedJobs };
  }
}
