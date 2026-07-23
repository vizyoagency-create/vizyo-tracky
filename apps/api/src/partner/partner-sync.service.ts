import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PartnerLinkStatus } from '@prisma/client';
import { parsePartnerScopes } from '@vizyo/tracky-shared';

import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { PartnerClientService } from './partner-client.service';
import { PartnerConfigService } from './partner.config';
import { PartnerInvitationService } from './partner-invitation.service';

const PARTNER = 'MAESTROO';

/**
 * SYNCHRONISATION AUTOMATIQUE de l'identité des véhicules Tracky → partenaire.
 *
 * ⚠️ POURQUOI CE SERVICE EXISTE — le pré-remplissage à l'appairage est un
 * INSTANTANÉ. Sans réconciliation, un véhicule ajouté ou corrigé dans Tracky
 * APRÈS l'appairage ne parvenait jamais au partenaire : le client voyait sa
 * flotte figée au jour de la connexion, et finissait par ressaisir à la main ce
 * qu'il avait déjà chez nous. Ce cron rattrape ces écarts.
 *
 * ⚠️ C'est un FILET, pas le seul chemin : le pré-remplissage immédiat reste la
 * voie normale. Le cron existe pour ce qui change ENTRE deux appairages.
 *
 * ⚠️ IL RESPECTE LES SCOPES VIVANTS. `seedVehicles` renvoie une liste vide si le
 * client a coupé `VEHICLE_IDENTITY` : la synchro ne réenrichit jamais ce qui a
 * été révoqué. Elle ne SUPPRIME rien non plus côté partenaire — un véhicule
 * retiré de Tracky ne fait pas disparaître la ligne métier adoptée (classe C) ;
 * la suppression relève de la révocation, décision explicite, pas d'un cron.
 */
@Injectable()
export class PartnerSyncService {
  private readonly logger = new Logger(PartnerSyncService.name);
  /** Anti-recouvrement : `@Cron` ne l'empêche PAS tout seul (piège connu). */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: PartnerClientService,
    private readonly config: PartnerConfigService,
    private readonly invitations: PartnerInvitationService,
    private readonly activity: SystemActivityService,
  ) {}

  /**
   * Toutes les 30 min : re-pousse l'identité des véhicules de chaque lien ACTIF.
   *
   * Une panne du partenaire n'est pas grave ici : on retentera au tour suivant,
   * et le pré-remplissage initial reste en place. On ne journalise donc pas ça
   * comme une erreur — c'est le fonctionnement nominal d'un filet.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async reconcile(): Promise<void> {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    try {
      const links = await this.prisma.partnerLink.findMany({
        where: { partner: PARTNER, status: PartnerLinkStatus.ACTIVE, liveKey: { not: null } },
        select: { id: true, fleetId: true, scopes: true },
      });
      for (const link of links) {
        await this.reconcileOne(link.id, link.fleetId, parsePartnerScopes(link.scopes));
      }
    } catch (err) {
      // Le cron entier ne doit jamais mourir sur un lien : une exception non
      // rattrapée dans un @Cron peut faire tomber le worker (piège vécu). On
      // borne ici, chaque lien est déjà protégé individuellement.
      this.logger.error(`Réconciliation partenaire interrompue : ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Synchronise UN lien. Isolé et protégé : un lien en échec (partenaire
   * injoignable, secret périmé) ne doit pas empêcher les suivants.
   */
  private async reconcileOne(linkId: string, fleetId: string, scopes: string[]): Promise<void> {
    try {
      const vehicles = await this.invitations.seedVehicles(fleetId, scopes);
      // Rien à partager (scope coupé) : inutile d'appeler le partenaire pour
      // envoyer une liste vide, ça ne ferait que du bruit réseau.
      if (vehicles.length === 0) return;

      const res = await this.client.reseedVehicles(linkId, vehicles);
      if (res.skipped) {
        // Le partenaire a répondu « lien non actif » alors que le nôtre l'est :
        // désalignement à surveiller, sans être une panne.
        this.logger.warn(`Reseed refusé par le partenaire (lien ${linkId}) — lien non actif de son côté`);
        return;
      }
      const divergences = res.divergences ?? 0;
      if (res.created > 0 || res.updated > 0 || divergences > 0) {
        this.logger.log(
          `Sync lien ${linkId} : +${res.created} / maj ${res.updated} / ` +
            `ff ${res.fastForwards ?? 0} / ecarts ${divergences}`,
        );
        this.activity.record({
          category: 'PARTNER',
          action: 'partner_vehicles_synced',
          status: 'SUCCESS',
          target: linkId,
          // Les écarts remontent dans l'activité : « le mode observation a vu
          // quelque chose » doit se lire depuis l'admin Tracky, pas seulement
          // dans les logs du partenaire.
          detail: `${res.created} cree(s), ${res.updated} mis a jour, ${divergences} ecart(s) observe(s)`,
          fleetId,
        });
      }
    } catch (err) {
      // Panne d'un lien : on la note en WARN (pas ERROR) et on continue. Le
      // prochain tour retentera ; rien n'est perdu, la donnée reste chez nous.
      this.logger.warn(`Sync du lien ${linkId} en échec : ${(err as Error).message}`);
    }
  }
}
