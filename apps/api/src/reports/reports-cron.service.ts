import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { formatFleetDate } from '../common/utils/datetime';
import { EmailService } from '../email/email.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportPdfService } from './report-pdf.service';
import { ReportsStatsService } from './reports-stats.service';

/**
 * V1.5 (Sprint L) — Email automatique du rapport hebdomadaire.
 *
 * Cron : tous les lundis a 08:00 UTC. Pour chaque flotte avec un email
 * destinataire valide (Fleet.weeklyReportEmail OU 1er FLEET_ADMIN), genere
 * un rapport PDF de la semaine S-1 (lundi 00:00 -> dimanche 23:59) et l'envoie
 * en piece jointe.
 *
 * Si Fleet.weeklyReportEmail = '-' (sentinel), on ne genere pas de rapport
 * pour cette flotte. Si la flotte n'a aucun trip dans la semaine, on skippe
 * pour ne pas spam.
 */
@Injectable()
export class ReportsCronService {
  private readonly logger = new Logger(ReportsCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: ReportsStatsService,
    private readonly pdf: ReportPdfService,
    private readonly email: EmailService,
    @Optional() private readonly errorLogger?: ErrorLogger,
  ) {}

  @Cron('0 0 8 * * 1')
  async sendWeeklyReports(): Promise<void> {
    const { from, to } = this.lastWeekRange();
    const fleets = await this.prisma.fleet.findMany();

    for (const fleet of fleets) {
      try {
        if (fleet.weeklyReportEmail === '-') continue;

        let recipient = fleet.weeklyReportEmail;
        if (!recipient) {
          const fleetAdmin = await this.prisma.user.findFirst({
            where: { fleetId: fleet.id, role: UserRole.FLEET_ADMIN, isActive: true },
            orderBy: { createdAt: 'asc' },
          });
          recipient = fleetAdmin?.email ?? null;
        }
        if (!recipient) {
          this.logger.debug(`Fleet ${fleet.id}: no recipient — skip`);
          continue;
        }

        const report = await this.stats.compute(fleet.id, from, to);
        if (report.trips.count === 0) {
          this.logger.debug(`Fleet ${fleet.id}: 0 trips this week — skip`);
          continue;
        }

        const pdfBuffer = await this.pdf.generate(report);
        const subject = `Rapport hebdomadaire — ${fleet.name}`;
        const fromStr = formatFleetDate(from);
        const toStr = formatFleetDate(to);
        const body = `Bonjour,\n\nVotre rapport Vizyo Tracky pour la semaine du ${fromStr} au ${toStr} est en piece jointe.\n\nResume :\n- ${report.trips.count} trajets, ${report.trips.totalKm.toFixed(1)} km\n- ${report.alerts.total} alertes\n- Conso estimee : ${report.consumption.estimatedLiters.toFixed(1)} L (${report.consumption.estimatedCostEur.toFixed(2)} EUR)\n\nL'equipe Vizyo`;

        await this.email.send({
          to: recipient,
          subject,
          html: this.email.buildWeeklyReportEmail({
            fromStr,
            toStr,
            tripsCount: report.trips.count,
            totalKm: report.trips.totalKm,
            alertsTotal: report.alerts.total,
            liters: report.consumption.estimatedLiters,
            costEur: report.consumption.estimatedCostEur,
            pdfName: `rapport-${fromStr.replace(/\//g, '-')}.pdf`,
          }),
          text: body,
          template: 'weekly_report',
          context: { fleetId: fleet.id, weekly: true, pdfBytes: pdfBuffer.length },
        });

        this.logger.log(`Weekly report sent for fleet ${fleet.name} -> ${recipient} (${pdfBuffer.length} bytes)`);
      } catch (err) {
        this.logger.warn(
          `Weekly report failed for fleet ${fleet.id}: ${err instanceof Error ? err.message : err}`,
        );
        this.errorLogger?.recordBackground(
          err instanceof Error ? err : new Error(String(err)),
          'cron:reports',
          { fleetId: fleet.id },
        );
      }
    }
  }

  /**
   * Renvoie la fenetre [lundi 00:00 UTC, dimanche 23:59:59 UTC] de la semaine
   * precedente. Le cron tourne lundi 08:00, donc la semaine S-1 vient de finir.
   */
  private lastWeekRange(): { from: Date; to: Date } {
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0=dim, 1=lun, ..., 6=sam
    // Distance jusqu'au dernier lundi (semaine en cours).
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday, 0, 0, 0));
    const lastMonday = new Date(thisMonday.getTime() - 7 * 24 * 3600 * 1000);
    const lastSundayEnd = new Date(thisMonday.getTime() - 1);
    return { from: lastMonday, to: lastSundayEnd };
  }
}
