import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { TrackerProvisioningService } from '../sms/tracker-provisioning.service';

export interface LancementProvisioningDto {
  provisioningId: string;
  imei: string;
  msisdn: string;
  apn: string;
  nbEtapes: number;
}

/**
 * Configuration SMS d'un boîtier, déclenchée depuis la fiche véhicule.
 *
 * ── POURQUOI CETTE COUCHE PLUTÔT QUE L'ÉCRAN ADMIN ───────────────────────────────────
 *
 * L'écran `/admin/sms` demandait SIX champs à la main — IMEI, numéro, APN, numéro admin,
 * IP et port serveur — et n'était ouvert qu'au SUPER_ADMIN. Un installateur devait donc
 * déranger un administrateur, qui retapait des valeurs qu'il ne connaissait pas mieux
 * que lui. Chacun de ces six champs est une occasion de se tromper, et une IP serveur
 * fausse envoie le boîtier parler dans le vide sans que rien ne le signale.
 *
 * Ici, TOUT EST DÉDUIT :
 *   — l'IMEI et le numéro viennent de l'identification déjà faite ;
 *   — l'APN vient de la fiche SIM, que l'opérateur synchronise ;
 *   — l'IP et le port viennent de la configuration du serveur.
 *
 * ⚠️ ET L'INSTALLATEUR NE PEUT PAS LES CHOISIR. Laisser un administrateur de flotte
 * saisir l'IP reviendrait à lui permettre de rediriger un boîtier vers son propre
 * serveur. Ces valeurs ne transitent pas par la requête.
 */
@Injectable()
export class ProvisioningVehiculeService {
  private readonly logger = new Logger(ProvisioningVehiculeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly provisioning: TrackerProvisioningService,
  ) {}

  async lancer(input: {
    imei: string;
    demandeur: { userId: string; email: string; role: string; fleetId: string | null };
  }): Promise<LancementProvisioningDto> {
    const { imei, demandeur } = input;

    const serverIp = this.config.get('PROVISIONING_SERVER_IP', { infer: true });
    if (!serverIp) {
      // On NOMME ce qui manque et où le poser : « configuration incomplète » enverrait
      // l'installateur appeler l'assistance sans rien pour la renseigner.
      throw new BadRequestException(
        "La configuration par SMS n'est pas paramétrée : PROVISIONING_SERVER_IP est absent des variables du serveur.",
      );
    }
    const serverPort = this.config.get('TRACKER_TCP_PORT', { infer: true });

    const tracker = await this.prisma.tracker.findUnique({
      where: { imei },
      select: {
        id: true,
        simPhoneNumber: true,
        vehicle: { select: { plate: true, fleetId: true } },
      },
    });
    if (!tracker) throw new NotFoundException('Boîtier introuvable. Rattachez-le au véhicule avant de le configurer.');

    // Cloisonnement : on ne configure pas le boîtier d'une autre société.
    if (demandeur.role !== 'SUPER_ADMIN' && tracker.vehicle?.fleetId !== demandeur.fleetId) {
      throw new NotFoundException('Boîtier introuvable.');
    }

    const puce = await this.prisma.sim.findFirst({
      where: { imei },
      select: { msisdn: true, apn: true },
    });

    const msisdn = tracker.simPhoneNumber ?? (puce?.msisdn ? `+${puce.msisdn}` : null);
    if (!msisdn) {
      throw new BadRequestException(
        "Aucun numéro SIM connu pour ce boîtier : la configuration par SMS n'a pas de destinataire.",
      );
    }

    /**
     * L'APN vient de l'opérateur. Sans lui, le boîtier n'ouvrira aucune session data et
     * la configuration produirait un boîtier joignable par SMS mais muet en TCP — le pire
     * des états, puisqu'il a l'air configuré.
     */
    const apn = puce?.apn;
    if (!apn) {
      throw new BadRequestException(
        "L'APN de cette carte SIM est inconnu. Synchronisez le parc SIM, puis relancez.",
      );
    }

    const lance = await this.provisioning.start(
      { imei, phoneNumber: msisdn, apn, serverIp, serverPort },
      demandeur.userId,
    );

    const nbEtapes = this.provisioning.buildSteps({
      imei,
      phoneNumber: msisdn,
      apn,
      serverIp,
      serverPort,
    }).length;

    this.logger.log(
      `Provisioning SMS lance pour ${imei} (${msisdn}, apn=${apn}) par ${demandeur.email} — ${nbEtapes} etapes`,
    );
    return { provisioningId: lance.id, imei, msisdn, apn, nbEtapes };
  }

  /** Avancement, pour l'écran qui suit la configuration étape par étape. */
  async etat(id: string, demandeur: { role: string; fleetId: string | null; userId: string }) {
    return this.provisioning.findOne(id, { role: demandeur.role, fleetId: demandeur.fleetId });
  }
}
