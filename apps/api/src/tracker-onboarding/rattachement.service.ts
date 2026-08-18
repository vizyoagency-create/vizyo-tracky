import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { UnknownTrackerRegistry } from '../unknown-trackers/unknown-trackers.registry';

export interface EtatAttenteDto {
  /** Le boîtier a-t-il ouvert une session acceptée depuis le rattachement ? */
  connecte: boolean;
  /** Il frappe encore en tant qu'inconnu — signe que l'IMEI déclaré ne colle pas. */
  encoreInconnu: boolean;
  derniereVueIso: string | null;
  positions: number;
  statut: string;
}

export interface RattachementDto {
  trackerId: string;
  imei: string;
  /** Sans accent : une clé JSON accentuée se fait mal citer par les clients. */
  cree: boolean;
  vehiculePlaque: string;
  connecteDejaVu: boolean;
}

@Injectable()
export class RattachementService {
  private readonly logger = new Logger(RattachementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inconnus: UnknownTrackerRegistry,
    private readonly systemActivity: SystemActivityService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Rattache un boîtier à un véhicule — en le créant s'il n'existe pas encore.
   *
   * ── POURQUOI DÉCLARER LE BOÎTIER AVANT QU'IL AIT PARLÉ ───────────────────────────
   *
   * Le serveur TCP interroge la base à CHAQUE ouverture de session, sans cache. Déclarer
   * l'IMEI maintenant suffit donc à ce que la toute prochaine trame soit acceptée, même
   * si le boîtier est silencieux à l'instant. C'est exactement ce qui s'est produit sur
   * FL-787-KV le 18 août : déclaré à 05:03 alors qu'il se taisait, accepté sans rien
   * toucher dès qu'il a repris la parole.
   *
   * L'alternative — attendre une trame pour créer la fiche — obligerait l'installateur à
   * rester devant son écran, et n'apporterait aucune garantie de plus.
   */
  async rattacher(input: {
    vehicleId: string;
    imei: string;
    msisdn: string | null;
    demandeur: { userId: string; email: string; role: string; fleetId: string | null };
  }): Promise<RattachementDto> {
    const { vehicleId, imei, msisdn, demandeur } = input;
    if (!/^\d{15}$/.test(imei)) {
      throw new BadRequestException("L'IMEI doit comporter exactement 15 chiffres.");
    }

    const vehicule = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, plate: true, fleetId: true, tracker: { select: { id: true, imei: true } } },
    });
    if (!vehicule) throw new NotFoundException('Véhicule introuvable.');

    // Cloisonnement : on ne rattache pas un boîtier au véhicule d'une autre société.
    if (demandeur.role !== 'SUPER_ADMIN' && vehicule.fleetId !== demandeur.fleetId) {
      throw new NotFoundException('Véhicule introuvable.');
    }

    if (vehicule.tracker && vehicule.tracker.imei !== imei) {
      throw new ConflictException(
        `${vehicule.plate} porte déjà le boîtier ${vehicule.tracker.imei}. Détachez-le d'abord.`,
      );
    }

    const existant = await this.prisma.tracker.findUnique({
      where: { imei },
      select: { id: true, vehicleId: true },
    });
    if (existant?.vehicleId && existant.vehicleId !== vehicleId) {
      throw new ConflictException('Ce boîtier équipe déjà un autre véhicule.');
    }

    const tracker = existant
      ? await this.prisma.tracker.update({
          where: { id: existant.id },
          data: { vehicleId, ...(msisdn ? { simPhoneNumber: msisdn } : {}) },
          select: { id: true, imei: true },
        })
      : await this.prisma.tracker.create({
          data: { imei, model: '403C', vehicleId, ...(msisdn ? { simPhoneNumber: msisdn } : {}) },
          select: { id: true, imei: true },
        });

    /**
     * Le numéro vient d'entrer sur une fiche boîtier : l'allowlist doit suivre, sinon le
     * premier SMS de configuration part en 403 — le mécanisme exact des 1476 rejets de
     * juillet. L'événement déclenche la synchronisation.
     */
    if (msisdn) this.events.emit('tracker.sim-changed', { imei });

    this.systemActivity.record({
      category: 'SMS',
      action: 'boitier_rattache',
      status: 'SUCCESS',
      actor: demandeur.email,
      detail: `Boîtier ${imei} rattaché à ${vehicule.plate}${msisdn ? ` (SIM ${msisdn})` : ''}.`,
      meta: { imei, vehicleId, plate: vehicule.plate, msisdn, cree: !existant },
    });
    this.logger.log(`Boitier ${imei} rattache a ${vehicule.plate} par ${demandeur.email}`);

    return {
      trackerId: tracker.id,
      imei: tracker.imei,
      cree: !existant,
      vehiculePlaque: vehicule.plate,
      connecteDejaVu: this.inconnus.list().some((e) => e.imei === imei),
    };
  }

  /**
   * Où en est l'attente d'une première connexion ?
   *
   * ⚠️ `encoreInconnu` EST LE SIGNAL QUI COMPTE. Un boîtier qui continue de frapper en
   * tant qu'inconnu APRÈS le rattachement dit que l'IMEI déclaré n'est pas le sien —
   * typiquement un chiffre de travers, comme les quatre fiches fautives trouvées dans ce
   * parc. Sans ce drapeau, l'écran afficherait « en attente » indéfiniment et personne ne
   * saurait que l'attente est vaine.
   */
  async attente(trackerId: string): Promise<EtatAttenteDto> {
    const t = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      select: { imei: true, status: true, lastSeenAt: true },
    });
    if (!t) throw new NotFoundException('Boîtier introuvable.');

    const positions = await this.prisma.position.count({ where: { trackerId } });
    const autresInconnus = this.inconnus.list();

    return {
      connecte: t.lastSeenAt !== null,
      encoreInconnu: autresInconnus.some((e) => e.imei === t.imei),
      derniereVueIso: t.lastSeenAt?.toISOString() ?? null,
      positions,
      statut: t.status,
    };
  }
}
