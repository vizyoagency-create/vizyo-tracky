import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InstallationBookingService } from './installation-booking.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * L'ENTRETIEN QUOTIDIEN DE LA PRISE DE RDV D'INSTALLATION
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Trois choses, dans cet ordre :
 *  1. purger les abonnements « prévenez-moi » expirés (90 j — décision client du 2026-08-16) ;
 *  2. purger les visites anciennes de la page publique (VISIT_RETENTION_DAYS) ;
 *  3. PRÉVENIR les abonnés dont le lien propose de nouveau des créneaux.
 *
 * ⚠️ AVANT CE SERVICE, RIEN NE TOURNAIT. `purgerAbonnementsExpires()` existait depuis le
 * 2026-08-16 avec le commentaire « appelée par le cron d'entretien » — et n'avait AUCUN
 * appelant. La promesse « prévenez-moi » collectait des adresses que personne ne prévenait
 * jamais, et que personne ne purgeait. Ce fichier est la partie manquante ; le garde
 * `catalogue-exhaustif.spec.ts` exige qu'il figure au catalogue des traitements.
 *
 * Le matin (07:40) plutôt que la nuit : le courriel « des créneaux sont disponibles » arrive
 * à une heure où on le lit et où on peut réserver dans la foulée — envoyé à 04:00, il serait
 * enterré sous le courrier de la nuit.
 */
@Injectable()
export class InstallationBookingEntretienService {
  private readonly logger = new Logger(InstallationBookingEntretienService.name);
  /** Verrou anti-chevauchement : un passage lent ne doit pas en croiser un autre. */
  private enCours = false;

  constructor(private readonly booking: InstallationBookingService) {}

  @Cron('40 7 * * *', { name: 'installation-booking-entretien' })
  async tick(): Promise<void> {
    if (this.enCours) return;
    this.enCours = true;
    try {
      const res = await this.executer();
      if (res.abonnesPurges + res.visitesPurgees + res.abonnesPrevenus > 0) {
        this.logger.log(
          `Entretien RDV : ${res.abonnesPurges} abonnement(s) purgé(s), ${res.visitesPurgees} visite(s) purgée(s), ${res.abonnesPrevenus} abonné(s) prévenu(s)`,
        );
      }
    } catch (err) {
      // Une tâche de fond qui lève tue l'ordonnanceur pour toutes les suivantes.
      this.logger.error(`Entretien RDV en échec : ${err instanceof Error ? err.message : err}`);
    } finally {
      this.enCours = false;
    }
  }

  /** Public : appelable pour un déclenchement manuel ou depuis un test. Chaque étape est isolée. */
  async executer(maintenant: Date = new Date()): Promise<{ abonnesPurges: number; visitesPurgees: number; abonnesPrevenus: number }> {
    const abonnesPurges = await this.booking.purgerAbonnementsExpires().catch((e) => {
      this.logger.warn(`purge des abonnements : ${e instanceof Error ? e.message : e}`);
      return 0;
    });
    const visitesPurgees = await this.booking.purgerVisitesAnciennes(maintenant).catch((e) => {
      this.logger.warn(`purge des visites : ${e instanceof Error ? e.message : e}`);
      return 0;
    });
    const abonnesPrevenus = await this.booking.notifierAbonnesCreneauxLibres(maintenant).catch((e) => {
      this.logger.warn(`notification des abonnés : ${e instanceof Error ? e.message : e}`);
      return 0;
    });
    return { abonnesPurges, visitesPurgees, abonnesPrevenus };
  }
}
