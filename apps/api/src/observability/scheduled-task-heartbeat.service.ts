import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ErrorLogger } from './error-logger.service';
import { PrismaService } from '../prisma/prisma.service';

/** État lu pour une tâche : sa cadence RÉELLE fait partie de l'état, pas d'une hypothèse. */
interface TaskState {
  enabled: boolean;
  lastRunAt: Date | null;
  /** Période attendue entre deux passages, en heures, telle que la tâche est CONFIGURÉE. */
  periodHours: number;
  /** Cadence en toutes lettres, reprise dans le message d'alerte. */
  cadence: string;
  /**
   * Depuis quand la tache est dans sa configuration actuelle (`updatedAt` des reglages).
   *
   * Sert UNIQUEMENT quand `lastRunAt` est nul : une tache qu'on vient d'activer n'a pas
   * encore eu l'occasion de tourner, et l'accuser d'etre « a l'arret » est faux.
   */
  configureeDepuis: Date | null;
}

/** Cadences nommées → période en heures. Inconnue → quotidienne (repli le plus courant). */
const PERIOD_HOURS: Record<string, number> = { hourly: 1, daily: 24, weekly: 24 * 7, monthly: 24 * 30 };
const CADENCE_LABEL: Record<string, string> = {
  hourly: 'toutes les heures',
  daily: 'quotidienne',
  weekly: 'hebdomadaire',
  monthly: 'mensuelle',
};

function periodOf(frequency: string | null | undefined): number {
  return PERIOD_HOURS[frequency ?? ''] ?? PERIOD_HOURS['daily']!;
}
function labelOf(frequency: string | null | undefined): string {
  return CADENCE_LABEL[frequency ?? ''] ?? 'quotidienne';
}

/**
 * Tolérance : DEUX périodes manquées, avec un plancher de 4 h.
 *
 * ⚠️ Une seule période manquée n'est pas une panne — un redémarrage, une migration ou un pic
 * de charge suffisent. Crier là-dessus apprendrait à ignorer la sonde, et le jour où elle a
 * raison personne ne la lirait. Deux périodes de suite, en revanche, ne s'expliquent plus par
 * un aléa.
 *
 * Le plancher couvre l'horaire : 2 h de silence sur une tâche horaire, c'est encore du bruit.
 */
function toleranceHours(periodHours: number): number {
  return Math.max(4, periodHours * 2);
}

/**
 * SONDE DES TÂCHES PLANIFIÉES — « elle est allumée, mais tourne-t-elle ? »
 *
 * ══ Pourquoi cette sonde existe (incident du 2026-08-03) ══════════════════════════════
 *
 * L'automatisation des trajets était à l'arrêt depuis CINQ JOURS. Rien ne l'a signalé :
 * pas d'erreur, pas d'alerte, pas de ligne de journal. Elle a été découverte par hasard,
 * en cherchant pourquoi les scores de conduite ne bougeaient plus — 1 334 trajets étaient
 * restés sans analyse.
 *
 * ⚠️ Une tâche qui ne tourne pas ne produit AUCUN signal. C'est ce qui la rend
 * particulièrement dangereuse : les mécanismes d'alerte de cette application se
 * déclenchent tous sur un événement — une erreur, un échec, un dépassement. L'absence
 * d'événement, elle, n'en est pas un. Il faut aller la chercher.
 *
 * ══ La cadence se LIT, elle ne se devine pas (correctif du même jour) ═════════════════
 *
 * ⚠️ La première version codait les seuils en dur. Elle a crié dès son premier passage en
 * production : « Rapport d'activité arrêté depuis 121 h ». Faux. Ce rapport est réglé en
 * HEBDOMADAIRE — il avait tourné 5 jours plus tôt et n'était dû que 2 jours plus tard.
 *
 * Les trois tâches configurables stockent pourtant leur cadence à côté de leur `lastRunAt`
 * (`frequency`, valeurs `hourly`/`daily`/`weekly`/`monthly`). La sonde la lit désormais et
 * en dérive son seuil. Une sonde qui juge sur une cadence supposée est pire qu'aucune sonde :
 * elle produit de fausses alertes, on apprend à les ignorer, et la vraie panne passe avec.
 *
 * ══ Ce qu'elle surveille, et ce qu'elle ne surveille pas ══════════════════════════════
 *
 * Uniquement les tâches ACTIVÉES qui gardent une trace de leur dernier passage. Une tâche
 * volontairement coupée n'est pas une panne : la signaler apprendrait à ignorer la sonde.
 */
@Injectable()
export class ScheduledTaskHeartbeatService {
  private readonly logger = new Logger(ScheduledTaskHeartbeatService.name);

  /**
   * Tâches surveillées. Chacune sait lire SA cadence — aucun seuil n'est écrit ici.
   *
   * ⚠️ Ajouter ici toute nouvelle automatisation dotée d'un `lastRunAt`. Une tâche absente
   * de cette table n'est surveillée par personne — c'est précisément l'angle mort corrigé.
   */
  private static readonly TASKS: ReadonlyArray<{
    /** Nom lisible, repris tel quel dans le centre d'alerte. */
    name: string;
    /** Lecture de l'état + de la cadence — `null` si la tâche n'est pas configurée du tout. */
    read: (p: PrismaService) => Promise<TaskState | null>;
  }> = [
    {
      name: 'Automatisation des trajets',
      read: async (p) => {
        const r = await p.tripAutomationSettings.findFirst({
          select: { enabled: true, lastRunAt: true, frequency: true, updatedAt: true },
        });
        return r && { enabled: r.enabled, lastRunAt: r.lastRunAt, periodHours: periodOf(r.frequency), cadence: labelOf(r.frequency), configureeDepuis: r.updatedAt };
      },
    },
    {
      name: 'Agent d’agenda',
      read: async (p) => {
        const r = await p.agendaAgentSettings.findFirst({
          select: { enabled: true, lastRunAt: true, frequency: true, updatedAt: true },
        });
        return r && { enabled: r.enabled, lastRunAt: r.lastRunAt, periodHours: periodOf(r.frequency), cadence: labelOf(r.frequency), configureeDepuis: r.updatedAt };
      },
    },
    {
      name: 'Rapport d’activité',
      read: async (p) => {
        // ⚠️ LA tâche qui a produit la fausse alerte : réglée en hebdomadaire, jugée quotidienne.
        const r = await p.activityReportSchedule.findFirst({
          select: { enabled: true, lastRunAt: true, frequency: true, updatedAt: true },
        });
        return r && { enabled: r.enabled, lastRunAt: r.lastRunAt, periodHours: periodOf(r.frequency), cadence: labelOf(r.frequency), configureeDepuis: r.updatedAt };
      },
    },
    {
      name: 'Automatisation des lieux',
      read: async (p) => {
        // Seule tâche sans colonne `frequency` : elle est quotidienne par construction
        // (un passage à l'heure `hour`), et `minIntervalDays` ne borne que le RE-traitement
        // d'un même lieu, pas la fréquence du passage.
        const r = await p.placeAutomationSettings.findFirst({
          select: { enabled: true, lastRunAt: true, updatedAt: true },
        });
        return r && { enabled: r.enabled, lastRunAt: r.lastRunAt, periodHours: 24, cadence: 'quotidienne', configureeDepuis: r.updatedAt };
      },
    },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * ⚠️ RIEN ENTRE CE DÉCORATEUR ET SA MÉTHODE. Le lien décorateur → cible est perdu à la
   * compilation : une déclaration glissée entre les deux déplace silencieusement le
   * décorateur, et la tâche cesse de tourner. C'est déjà arrivé dans ce dépôt — et cette
   * sonde-ci deviendrait alors muette sur sa propre panne.
   *
   * Toutes les heures à la 35ᵉ minute. ⚠️ Surtout PAS la 20ᵉ : le rapport d'activité y tourne
   * (`@Cron('0 20 * * * *')`), et la sonde le jugerait pendant son exécution.
   */
  @Cron('0 35 * * * *')
  async check(now = Date.now()): Promise<void> {
    for (const task of ScheduledTaskHeartbeatService.TASKS) {
      let state: TaskState | null;
      try {
        state = await task.read(this.prisma);
      } catch (e) {
        // Une lecture qui échoue n'est PAS une tâche à l'arrêt : ne pas confondre les deux
        // enverrait chercher au mauvais endroit.
        this.errorLogger.recordBackground(
          e instanceof Error ? e : new Error(String(e)),
          'scheduled-task-heartbeat',
          { task: task.name, stage: 'read' },
        );
        continue;
      }

      // Tâche jamais configurée, ou volontairement coupée : ce n'est pas une panne.
      if (!state || !state.enabled) continue;

      const maxSilenceHours = toleranceHours(state.periodHours);

      // Activée mais aucun passage enregistré : elle n'a jamais démarré. C'est le cas le
      // plus discret — aucune trace d'échec, aucune trace de succès, rien du tout.
      //
      // ⚠️ MAIS « pas encore » n'est pas « en panne ». Mesuré le 2026-08-22 : « Automatisation
      // des lieux » a été activée à 06:02, elle est quotidienne à 03:00 — son premier passage
      // possible était 21 h plus tard. La sonde l'a déclarée à l'arrêt 33 min après
      // l'activation, puis TOUTES LES HEURES : 7 CRITICAL pour une tâche qui n'avait rien
      // fait de mal.
      //
      // 🔑 C'est le même défaut que TRK-030, sur un autre module : là, un boîtier neuf était
      // accusé de panne d'antenne 51 s avant son premier fix. Une branche « ça n'est jamais
      // arrivé » sans borne de durée transforme une naissance en panne.
      //
      // On laisse donc à la tâche la MÊME tolérance qu'aux autres, comptée depuis sa
      // configuration. ⚠️ Réserve assumée : `updatedAt` bouge à chaque édition des réglages,
      // donc modifier une tâche qui n'a jamais tourné lui redonne une fenêtre. La portée est
      // bornée — dès qu'un passage existe, c'est `lastRunAt` qui fait foi et cette branche
      // n'est plus empruntée.
      if (!state.lastRunAt) {
        const depuisConfigHours = state.configureeDepuis
          ? (now - state.configureeDepuis.getTime()) / 3_600_000
          : null;

        // Pas de repère de configuration : on ne peut pas dater l'attente, donc on signale
        // (l'ancien comportement) plutôt que de se taire sur une vraie panne.
        if (depuisConfigHours !== null && depuisConfigHours <= maxSilenceHours) continue;

        this.report(task.name, state.cadence, null, maxSilenceHours, depuisConfigHours);
        continue;
      }

      const silenceHours = (now - state.lastRunAt.getTime()) / 3_600_000;
      if (silenceHours > maxSilenceHours) {
        this.report(task.name, state.cadence, silenceHours, maxSilenceHours);
      }
    }
  }

  private report(
    name: string,
    cadence: string,
    silenceHours: number | null,
    maxSilenceHours: number,
    depuisConfigHours: number | null = null,
  ): void {
    // « aucun passage » sans durée ne dit pas si c'est grave. Avec la durée, le lecteur
    // tranche seul : 3 h d'attente sur une tâche quotidienne, ou 200 h ?
    const depuis =
      silenceHours === null
        ? depuisConfigHours === null
          ? 'aucun passage enregistré depuis son activation'
          : `aucun passage enregistré depuis son activation il y a ${Math.round(depuisConfigHours)} h`
        : `dernier passage il y a ${Math.round(silenceHours)} h`;

    // Le message porte la CADENCE RÉELLEMENT CONFIGURÉE : sans elle, « 121 h » ne dit pas si
    // c'est anormal — et c'est précisément en la supposant qu'on a produit une fausse alerte.
    this.errorLogger.recordBackground(
      new Error(
        `Tâche planifiée à l'arrêt : « ${name} » est ACTIVÉE mais ne tourne plus — ` +
          `${depuis} (cadence configurée : ${cadence}, seuil d'alerte ${maxSilenceHours} h).`,
      ),
      'scheduled-task-heartbeat',
      { task: name, cadence, silenceHours: silenceHours ?? null, maxSilenceHours },
      'CRITICAL',
    );
    this.logger.error(`Tâche planifiée à l'arrêt : ${name} (${depuis}).`);
  }
}
