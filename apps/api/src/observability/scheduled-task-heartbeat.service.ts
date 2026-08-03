import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ErrorLogger } from './error-logger.service';
import { PrismaService } from '../prisma/prisma.service';

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
 * Le même jour, la sonde a immédiatement révélé un SECOND cas : le rapport d'activité,
 * activé, sans passage depuis 120 heures.
 *
 * ⚠️ Une tâche qui ne tourne pas ne produit AUCUN signal. C'est ce qui la rend
 * particulièrement dangereuse : les mécanismes d'alerte de cette application se
 * déclenchent tous sur un événement — une erreur, un échec, un dépassement. L'absence
 * d'événement, elle, n'en est pas un. Il faut aller la chercher.
 *
 * ══ Ce qu'elle surveille, et ce qu'elle ne surveille pas ══════════════════════════════
 *
 * Uniquement les tâches ACTIVÉES qui gardent une trace de leur dernier passage. Une tâche
 * volontairement coupée n'est pas une panne : la signaler apprendrait à ignorer la sonde.
 *
 * ⚠️ Les seuils sont larges à dessein (au moins trois fois la cadence). Le but n'est pas
 * de détecter un passage manqué — ça arrive, un redémarrage suffit — mais un ARRÊT. Une
 * sonde qui crie pour un retard normal finit désactivée, et on retombe à zéro surveillance.
 */
@Injectable()
export class ScheduledTaskHeartbeatService {
  private readonly logger = new Logger(ScheduledTaskHeartbeatService.name);

  /**
   * Tâches surveillées, avec le silence maximal toléré.
   *
   * ⚠️ Ajouter ici toute nouvelle automatisation dotée d'un `lastRunAt`. Une tâche absente
   * de cette table n'est surveillée par personne — c'est précisément l'angle mort corrigé.
   */
  private static readonly TASKS: ReadonlyArray<{
    /** Nom lisible, repris tel quel dans le centre d'alerte. */
    name: string;
    /** Cadence annoncée, pour que le message dise ce qu'on attendait. */
    cadence: string;
    /** Au-delà, on considère la tâche à l'arrêt. */
    maxSilenceHours: number;
    /** Lecture de l'état — `null` si la tâche n'est pas configurée du tout. */
    read: (p: PrismaService) => Promise<{ enabled: boolean; lastRunAt: Date | null } | null>;
  }> = [
    {
      name: 'Automatisation des trajets',
      cadence: 'toutes les heures',
      maxSilenceHours: 4,
      read: async (p) => {
        const r = await p.tripAutomationSettings.findFirst({
          select: { enabled: true, lastRunAt: true },
        });
        return r ?? null;
      },
    },
    {
      name: 'Agent d’agenda',
      cadence: 'quotidienne',
      maxSilenceHours: 30,
      read: async (p) => {
        const r = await p.agendaAgentSettings.findFirst({
          select: { enabled: true, lastRunAt: true },
        });
        return r ?? null;
      },
    },
    {
      name: 'Rapport d’activité',
      cadence: 'quotidienne',
      maxSilenceHours: 30,
      read: async (p) => {
        const r = await p.activityReportSchedule.findFirst({
          select: { enabled: true, lastRunAt: true },
        });
        return r ?? null;
      },
    },
    {
      name: 'Automatisation des lieux',
      cadence: 'quotidienne',
      maxSilenceHours: 30,
      read: async (p) => {
        const r = await p.placeAutomationSettings.findFirst({
          select: { enabled: true, lastRunAt: true },
        });
        return r ?? null;
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
   * Toutes les heures à la 20ᵉ minute : décalé des tâches surveillées (45ᵉ) pour ne pas
   * les juger pendant qu'elles s'exécutent.
   */
  @Cron('0 20 * * * *')
  async check(now = Date.now()): Promise<void> {
    for (const task of ScheduledTaskHeartbeatService.TASKS) {
      let state: { enabled: boolean; lastRunAt: Date | null } | null;
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

      // Activée mais aucun passage enregistré : elle n'a jamais démarré. C'est le cas le
      // plus discret — aucune trace d'échec, aucune trace de succès, rien du tout.
      if (!state.lastRunAt) {
        this.report(task.name, task.cadence, null, task.maxSilenceHours);
        continue;
      }

      const silenceHours = (now - state.lastRunAt.getTime()) / 3_600_000;
      if (silenceHours > task.maxSilenceHours) {
        this.report(task.name, task.cadence, silenceHours, task.maxSilenceHours);
      }
    }
  }

  private report(
    name: string,
    cadence: string,
    silenceHours: number | null,
    maxSilenceHours: number,
  ): void {
    const depuis =
      silenceHours === null
        ? 'aucun passage enregistré depuis son activation'
        : `dernier passage il y a ${Math.round(silenceHours)} h`;

    // Le message porte la CADENCE ATTENDUE : sans elle, « 120 h » ne dit pas si c'est
    // anormal. Avec elle, l'écart saute aux yeux et l'exploitant sait quoi vérifier.
    this.errorLogger.recordBackground(
      new Error(
        `Tâche planifiée à l'arrêt : « ${name} » est ACTIVÉE mais ne tourne plus — ` +
          `${depuis} (cadence attendue : ${cadence}, seuil d'alerte ${maxSilenceHours} h).`,
      ),
      'scheduled-task-heartbeat',
      { task: name, cadence, silenceHours: silenceHours ?? null, maxSilenceHours },
      'CRITICAL',
    );
    this.logger.error(`Tâche planifiée à l'arrêt : ${name} (${depuis}).`);
  }
}
