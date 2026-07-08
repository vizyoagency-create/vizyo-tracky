import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type {
  BackgroundTaskDto,
  BackgroundTasksResponse,
  BgTaskCategory,
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
  ai?: 'trip' | 'activity' | 'agenda';
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
    id: 'trips-timeout', label: 'Clôture des trajets en cours', category: 'Sécurité & moteur',
    kind: 'cron', scheduleHuman: 'chaque minute', criticality: 'moyenne', antiOverlap: false,
    purpose: 'Ferme les trajets restés « en cours » alors que le véhicule est à l\'arrêt depuis un moment.',
    periodic: { everyMs: 60_000, offsetMs: 0 },
  },

  // ───────── IA & rapports ─────────
  {
    id: 'trip-automation', label: 'Automatisation des trajets (analyse + récit IA)', category: 'IA & rapports',
    kind: 'cron', scheduleHuman: 'toutes les heures à HH:45 (si réglé)', criticality: 'moyenne', antiOverlap: true,
    configurable: true, settingsRoute: '/admin/trip-automation', ai: 'trip',
    purpose: 'Recalcule les trajets, lance l\'analyse et le récit IA pour toutes les flottes, selon la cadence réglée.',
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
    purpose: 'Supprime les vieux journaux (wire / erreurs / audit) au-delà de leur durée de rétention.',
    fire: { tz: SERVER_TZ, matcher: (w) => w.getHours() === 3 && w.getMinutes() === 0 },
  },
  {
    id: 'positions-retention', label: 'Rétention des positions GPS', category: 'Maintenance données',
    kind: 'cron', scheduleHuman: 'chaque jour à 03:30', criticality: 'moyenne', antiOverlap: false,
    configurable: true, settingsRoute: '/admin/retention', note: 'En DRY-RUN en prod : n\'efface RIEN tant que le flag n\'est pas armé.',
    purpose: 'Archive puis (une fois armé) supprime les vieilles positions GPS selon la politique de rétention.',
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
    id: 'metrics-collect', label: 'Collecte des métriques serveur (VPS)', category: 'Système & observabilité',
    kind: 'interval', scheduleHuman: 'flux continu · toutes les 60 s', criticality: 'basse', antiOverlap: false,
    continuous: true, settingsRoute: '/admin/system',
    purpose: 'Enregistre en continu la charge CPU/mémoire/disque du serveur (monitoring VPS).',
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
    const [tripS, activityS, agendaS] = await Promise.all([
      this.prisma.tripAutomationSettings.findFirst({ orderBy: { updatedAt: 'desc' } }).catch(() => null),
      this.prisma.activityReportSchedule.findFirst({ orderBy: { updatedAt: 'desc' } }).catch(() => null),
      this.prisma.agendaAgentSettings.findMany({ where: { enabled: true } }).catch(() => []),
    ]);

    const tasks: BackgroundTaskDto[] = CATALOG.map((e) => {
      const base: BackgroundTaskDto = {
        id: e.id, label: e.label, category: e.category, kind: e.kind,
        scheduleHuman: e.scheduleHuman, purpose: e.purpose, criticality: e.criticality,
        antiOverlap: e.antiOverlap, continuous: !!e.continuous, devOnly: !!e.devOnly,
        configurable: !!e.configurable, settingsRoute: e.settingsRoute ?? null,
        settingsSummary: null, enabled: null, nextRunAt: null, lastRunAt: null, note: e.note ?? null,
      };

      if (e.continuous) return base; // flux continu → pas de compte-à-rebours daté

      if (e.ai) return { ...base, ...this.aiTask(e.ai, tripS, activityS, agendaS, nowMs) };

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

  /** Calcule enabled / prochain / dernier / résumé pour une automatisation IA depuis ses réglages. */
  private aiTask(
    kind: 'trip' | 'activity' | 'agenda',
    tripS: { enabled: boolean; frequency: string; hour: number; lastRunAt: Date | null } | null,
    activityS: { enabled: boolean; frequency: string; lastRunAt: Date | null } | null,
    agendaS: Array<{ enabled: boolean; nightlyHour: number; frequency: string; triggerNightly: boolean; lastRunAt: Date | null }>,
    nowMs: number,
  ): Partial<BackgroundTaskDto> {
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
