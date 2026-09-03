import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReportScheduleService } from './report-schedule.service';

/**
 * Rapport hebdomadaire — déclencheur horaire.
 *
 * Avant (V1.5, Sprint L) : `@Cron('0 0 8 * * 1')`, lundi 08:00 UTC pour toutes les flottes,
 * un destinataire, sans PDF joint. Depuis 2026-09 : chaque société règle son jour et son
 * heure (Paris) sur sa page Rapports ; ce cron passe toutes les heures et délègue à
 * ReportScheduleService.runDue(), qui envoie ce qui est dû et journalise chaque passage.
 *
 * ⚠️ RIEN ENTRE LE DÉCORATEUR ET SA MÉTHODE (cf. scheduled-task-heartbeat.service.ts) : une
 * déclaration glissée entre les deux déplace silencieusement le décorateur.
 *
 * Minute 5 : la sonde des tâches tourne à :35, le rapport d'activité à :20, l'automatisation
 * des trajets à :00 — on évite de partager la minute avec elles.
 */
@Injectable()
export class ReportsCronService {
  private readonly logger = new Logger(ReportsCronService.name);

  constructor(private readonly schedule: ReportScheduleService) {}

  @Cron('0 5 * * * *')
  async sendDueWeeklyReports(): Promise<void> {
    try {
      await this.schedule.runDue();
    } catch (err) {
      this.logger.error(`Rapport hebdo — passage en échec : ${err instanceof Error ? err.message : err}`);
    }
  }
}
