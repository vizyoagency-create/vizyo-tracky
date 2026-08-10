import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type { DepotIncidentDto, DepotIncidentInputDto, DepotIncidentReason } from '@vizyo/tracky-shared';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espace depot (2026-08) — le signalement d'incident (A3 § 5).
 *
 * ┌─ L'UNE DES DEUX SEULES ECRITURES D'UN DEPOT ──────────────────────────────┐
 * │ L'autre est le lien de partage (A4). Tout le reste de l'espace est en       │
 * │ LECTURE SEULE — aucun bouton qui ecrit sur un vehicule (A3 § 7, regle 6).   │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ `blocksVehicle: false`, et c'est le point le plus important de ce fichier.
 * L'evenement d'agenda porte l'incident LA OU LE GESTIONNAIRE REGARDE, mais il ne
 * rend pas le camion indisponible : un depot qui pourrait immobiliser un vehicule de
 * son transporteur — fut-ce par un signalement de bonne foi — ecrirait sur sa flotte.
 * `blocksVehicle: true` ferait entrer l'incident dans `findImmobilized`, donc dans les
 * creneaux reservables et les suggestions de l'agent : un tiers deciderait de la
 * disponibilite du parc. C'est exactement ce que le role interdit.
 *
 * Le statut est `OPEN` et non `PLANNED` : rien n'est planifie, quelque chose est
 * signale et attend une reponse.
 */

/** Bornage du texte libre : un depot signale, il ne remplit pas la base du transporteur. */
const MESSAGE_MAX = 1000;

const LIBELLE_MOTIF: Record<DepotIncidentReason, string> = {
  DELAY: 'Retard',
  GOODS: 'Marchandise',
  DEPOT_ACCESS: 'Accès dépôt',
  OTHER: 'Autre',
};

@Injectable()
export class DepotIncidentService {
  private readonly logger = new Logger(DepotIncidentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async signaler(userId: string, entree: DepotIncidentInputDto): Promise<DepotIncidentDto> {
    // Le `where` porte `depotUserId` : le garde a deja verifie le rattachement, on le
    // REVERIFIE. Un garde et un service qui se font confiance mutuellement laissent un
    // trou le jour ou l'un des deux change.
    const mission = await this.prisma.mission.findFirst({
      where: { id: entree.missionId, depotUserId: userId },
      select: {
        id: true,
        ref: true,
        fleetId: true,
        vehicleId: true,
        originLabel: true,
        destLabel: true,
        startAt: true,
        vehicle: { select: { plate: true } },
      },
    });
    if (!mission) throw new ForbiddenException('Ressource hors de votre perimetre');

    const depot = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });
    const nomDepot = [depot?.firstName, depot?.lastName].filter(Boolean).join(' ').trim() || 'Un dépôt';
    const motif = LIBELLE_MOTIF[entree.reason] ?? LIBELLE_MOTIF.OTHER;
    const message = (entree.message ?? '').trim().slice(0, MESSAGE_MAX);

    const evenement = await this.prisma.vehicleEvent.create({
      data: {
        fleetId: mission.fleetId,
        vehicleId: mission.vehicleId,
        type: VehicleEventType.INCIDENT,
        status: VehicleEventStatus.OPEN,
        // Le titre porte le motif ET la mission : dans l'agenda, le gestionnaire lit
        // une ligne, pas une fiche. « Incident » seul l'obligerait a ouvrir.
        title: `Signalement dépôt · ${motif} · mission ${mission.ref}`,
        description: message || null,
        startAt: new Date(),
        allDay: false,
        // ⚠️ Cf. l'en-tete : un depot n'immobilise jamais un camion.
        blocksVehicle: false,
        createdBy: userId,
        source: 'MANUAL',
        metadata: {
          missionId: mission.id,
          missionRef: mission.ref,
          reason: entree.reason,
          reportedByDepot: nomDepot,
        },
      },
      select: { id: true, createdAt: true },
    });

    // HORS transaction, et volontairement : un e-mail qui echoue ne doit pas annuler
    // un signalement deja ecrit dans l'agenda. Meme regle qu'a la creation de mission.
    void this.notifierTransporteur({
      fleetId: mission.fleetId,
      missionRef: mission.ref,
      trajet: `${mission.originLabel} → ${mission.destLabel}`,
      plate: mission.vehicle.plate,
      motif,
      message,
      nomDepot,
    });

    this.logger.log(
      `Incident depot signale · mission ${mission.ref} · motif ${entree.reason} · par ${depot?.email ?? userId}`,
    );

    return {
      id: evenement.id,
      missionRef: mission.ref,
      reason: entree.reason,
      createdAt: evenement.createdAt.toISOString(),
    };
  }

  /**
   * L'e-mail aux gestionnaires de la flotte.
   *
   * Aux gestionnaires, pas a une adresse de contact : c'est eux qui agissent. Un
   * signalement envoye a `contact@` attend qu'on le transfere, et un signalement
   * qu'on transfere arrive trop tard.
   */
  private async notifierTransporteur(opts: {
    fleetId: string;
    missionRef: string;
    trajet: string;
    plate: string;
    motif: string;
    message: string;
    nomDepot: string;
  }): Promise<void> {
    try {
      const destinataires = await this.prisma.user.findMany({
        where: {
          fleetId: opts.fleetId,
          isActive: true,
          role: { in: [UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER] },
        },
        select: { email: true },
        take: 20,
      });
      if (destinataires.length === 0) return;

      const tpl = this.email.buildDepotIncidentEmail(opts);
      for (const d of destinataires) {
        if (!d.email) continue;
        await this.email.send({
          to: d.email,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          template: 'depot_incident',
          fleetId: opts.fleetId,
          context: { missionRef: opts.missionRef },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Notification d'incident echouee pour ${opts.missionRef} : ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
