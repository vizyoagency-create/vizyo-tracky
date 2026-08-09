import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  MissionStatus,
  Prisma,
  UserRole,
  VehicleEventStatus,
  VehicleEventType,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '../auth/types/auth-user';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espace depot (2026-08) — les missions. Cf. design/A2-MISSIONS.md.
 *
 * La mission est le PIVOT du bloc A : c'est elle qui ouvre l'acces au depot, et sa
 * fenetre horaire qui le referme. La creer n'ecrit donc pas seulement une ligne — elle
 * declenche quatre effets, dont deux sont invisibles si on ne les nomme pas.
 */

/** Bornes de validation, A2 § 4. */
const DUREE_MIN_MS = 15 * 60_000;
const DUREE_MAX_MS = 24 * 60 * 60_000;
const HORIZON_MAX_MS = 90 * 24 * 60 * 60_000;

/** Statuts d'une mission qui occupe encore le vehicule. */
const STATUTS_OCCUPANTS: MissionStatus[] = [
  MissionStatus.PLANNED,
  MissionStatus.IN_PROGRESS,
  MissionStatus.LATE,
];

export interface CreerMissionEntree {
  originLabel: string;
  destLabel: string;
  originPlaceId?: string | null;
  destPlaceId?: string | null;
  startAt: string;
  endAt: string;
  vehicleId: string;
  driverId?: string | null;
  depotUserId?: string | null;
  notes?: string | null;
}

/** Ce qu'un CONDUCTEUR voit de sa propre mission. Aucune donnee du depot. */
export interface MissionConducteurDto {
  id: string;
  ref: string;
  origin: string;
  destination: string;
  startAt: string;
  endAt: string;
  status: MissionStatus;
  plate: string;
  /**
   * Un tiers (le depot destinataire) suit-il la position du vehicule pendant cette
   * mission ? Calcule cote serveur : c'est une obligation d'information, pas un
   * choix d'affichage.
   */
  depotWatching: boolean;
}

export interface ResultatCreation {
  mission: { id: string; ref: string };
  /** Avertissements NON bloquants — ex. vehicule sans boitier. */
  avertissements: string[];
}

@Injectable()
export class MissionsService {
  private readonly logger = new Logger(MissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async creer(user: AuthUser, entree: CreerMissionEntree): Promise<ResultatCreation> {
    const fleetId = this.fleetDe(user);
    const { start, end } = this.validerCreneau(entree.startAt, entree.endAt);

    const vehicule = await this.prisma.vehicle.findFirst({
      where: { id: entree.vehicleId, fleetId },
      select: { id: true, plate: true, tracker: { select: { id: true } } },
    });
    // Hors flotte → 403, et le meme message qu'un vehicule inexistant : sinon on
    // permet de tester l'appartenance d'un identifiant a une flotte.
    if (!vehicule) throw new ForbiddenException('Vehicule hors de votre flotte');

    await this.validerDepot(entree.depotUserId, fleetId);
    await this.validerConducteur(entree.driverId, fleetId);
    await this.refuserSiCreneauOccupe(entree.vehicleId, vehicule.plate, start, end);

    const avertissements: string[] = [];
    if (!vehicule.tracker) {
      // Avertissement plutot que refus : on peut planifier une mission avant
      // l'installation du boitier (A2 § 4).
      avertissements.push(
        'Ce vehicule n\'a pas encore de boitier : le depot ne verra pas sa position.',
      );
    }

    const mission = await this.prisma.$transaction(async (tx) => {
      const ref = await this.genererReference(tx, fleetId);
      const creee = await tx.mission.create({
        data: {
          ref,
          fleetId,
          originLabel: entree.originLabel,
          destLabel: entree.destLabel,
          originPlaceId: entree.originPlaceId ?? null,
          destPlaceId: entree.destPlaceId ?? null,
          startAt: start,
          endAt: end,
          vehicleId: entree.vehicleId,
          driverId: entree.driverId ?? null,
          depotUserId: entree.depotUserId ?? null,
          notes: entree.notes ?? null,
          createdByUserId: user.id,
          status: MissionStatus.PLANNED,
        },
        select: { id: true, ref: true },
      });

      // EFFET 1 — l'evenement d'agenda. Dans la MEME transaction : une mission sans
      // son evenement laisserait le vehicule reservable pendant son creneau.
      await tx.vehicleEvent.create({
        data: {
          fleetId,
          vehicleId: entree.vehicleId,
          type: VehicleEventType.MISSION,
          status: VehicleEventStatus.PLANNED,
          title: `Mission ${ref} · ${entree.originLabel} → ${entree.destLabel}`,
          startAt: start,
          endAt: end,
          allDay: false,
          // EFFET 2 — l'indisponibilite. `blocksVehicle` fait entrer cet evenement dans
          // `findImmobilized`, donc dans le chemin de lecture EXISTANT : le vehicule
          // sort des creneaux reservables de /agenda, de /reserve/:token et des
          // suggestions de l'agent IA, sans qu'aucun second mecanisme soit ecrit.
          blocksVehicle: true,
          createdBy: user.id,
          source: 'SYSTEM',
          metadata: { missionId: creee.id, missionRef: ref },
        },
      });

      return creee;
    });

    this.logger.log(
      `Mission ${mission.ref} creee (vehicule ${vehicule.plate}, depot ${entree.depotUserId ?? 'aucun'})`,
    );

    // EFFET 3 — le depot est notifie. HORS transaction, et volontairement : un e-mail
    // qui echoue ne doit pas annuler une mission deja ecrite. Le gestionnaire a valide,
    // le vehicule est bloque, le depot verra la mission en se connectant de toute facon.
    if (entree.depotUserId) {
      void this.notifierDepot(entree.depotUserId, {
        ref: mission.ref,
        origin: entree.originLabel,
        destination: entree.destLabel,
        startAt: start,
        endAt: end,
        plate: vehicule.plate,
      });
    }

    return { mission, avertissements };
  }

  /**
   * EFFET 4 — les missions du jour d'un CONDUCTEUR, avec la mention d'information.
   *
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ OBLIGATION D'INFORMATION — pas une politesse.                              │
   * │ Le conducteur doit savoir qu'un tiers voit sa position pendant la mission. │
   * │ C'est la condition de conformite du dispositif (A2 § 3.4).                 │
   * └───────────────────────────────────────────────────────────────────────────┘
   *
   * `depotWatching` n'est donc PAS un detail d'affichage que le client pourrait
   * oublier de rendre : il est calcule ici, a cote de la donnee qu'il qualifie, et
   * vaut `true` des qu'un depot est destinataire. Le laisser au front reviendrait a
   * faire dependre une obligation legale d'un `@if` qu'on peut supprimer par megarde.
   */
  async missionsDuConducteur(user: AuthUser): Promise<MissionConducteurDto[]> {
    const driver = await this.prisma.driver.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!driver) return [];

    const debutDuJour = new Date();
    debutDuJour.setHours(0, 0, 0, 0);
    const finDuJour = new Date(debutDuJour.getTime() + 48 * 3600_000);

    const missions = await this.prisma.mission.findMany({
      where: {
        driverId: driver.id,
        status: { in: STATUTS_OCCUPANTS },
        startAt: { lt: finDuJour },
        endAt: { gte: debutDuJour },
      },
      select: {
        id: true,
        ref: true,
        originLabel: true,
        destLabel: true,
        startAt: true,
        endAt: true,
        status: true,
        depotUserId: true,
        vehicle: { select: { plate: true } },
      },
      orderBy: { startAt: 'asc' },
    });

    return missions.map((m) => ({
      id: m.id,
      ref: m.ref,
      origin: m.originLabel,
      destination: m.destLabel,
      startAt: m.startAt.toISOString(),
      endAt: m.endAt.toISOString(),
      status: m.status,
      plate: m.vehicle.plate,
      /** Un tiers suit-il la position pendant cette mission ? */
      depotWatching: m.depotUserId !== null,
    }));
  }

  /**
   * EFFET 3 — l'e-mail au depot destinataire.
   *
   * Ne leve jamais : l'appel est en `void` et toute erreur est journalisee. Une panne
   * du fournisseur d'e-mail ne doit pas faire echouer une creation de mission, ni
   * laisser croire au gestionnaire que sa saisie a ete perdue.
   */
  private async notifierDepot(
    depotUserId: string,
    mission: {
      ref: string;
      origin: string;
      destination: string;
      startAt: Date;
      endAt: Date;
      plate: string;
    },
  ): Promise<void> {
    try {
      const depot = await this.prisma.user.findUnique({
        where: { id: depotUserId },
        select: { email: true, fleetId: true, fleet: { select: { name: true } } },
      });
      if (!depot?.email) return;

      const base = this.config.get('APP_BASE_URL', { infer: true }) ?? '';
      const tpl = this.email.buildMissionAssignedEmail({
        ...mission,
        // Le nom du TRANSPORTEUR, pas Tracky : c'est de lui que le depot attend un
        // e-mail (A0 § Marque). Repli neutre plutot qu'une marque qu'il ne connait pas.
        carrierName: depot.fleet?.name ?? 'Votre transporteur',
        depotUrl: `${base}/depot`,
      });

      await this.email.send({
        to: depot.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        template: 'mission_assigned',
        fleetId: depot.fleetId,
        context: { missionRef: mission.ref },
      });
    } catch (err) {
      this.logger.warn(
        `Notification depot echouee pour la mission ${mission.ref} : ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Reference lisible, sequence PAR FLOTTE : « M-2481 ».
   *
   * Generee DANS la transaction, avec un verrou de ligne (`FOR UPDATE`) sur les
   * missions de la flotte. Sans lui, deux creations simultanees lisent le meme maximum
   * et produisent la meme reference — la contrainte `@@unique([fleetId, ref])` en
   * rattraperait une, mais en faisant echouer une creation legitime.
   *
   * La contrainte est le FILET, pas le mecanisme.
   */
  private async genererReference(tx: Prisma.TransactionClient, fleetId: string): Promise<string> {
    const lignes = await tx.$queryRaw<Array<{ ref: string }>>`
      SELECT "ref" FROM "missions"
      WHERE "fleetId" = ${fleetId}::uuid
      ORDER BY "createdAt" DESC
      LIMIT 1
      FOR UPDATE
    `;
    const derniere = lignes[0]?.ref;
    const numero = derniere ? Number.parseInt(derniere.replace(/^M-/, ''), 10) : 0;
    const suivant = Number.isFinite(numero) ? numero + 1 : 1;
    return `M-${String(suivant).padStart(4, '0')}`;
  }

  /**
   * Un vehicule ne peut porter deux missions qui se chevauchent (A2 § 4).
   * Refus cote API avec le DETAIL du conflit — un « creneau indisponible » sans dire
   * lequel oblige le gestionnaire a rouvrir le formulaire cinq fois.
   */
  private async refuserSiCreneauOccupe(
    vehicleId: string,
    plate: string,
    start: Date,
    end: Date,
    exclureId?: string,
  ): Promise<void> {
    const conflit = await this.prisma.mission.findFirst({
      where: {
        vehicleId,
        status: { in: STATUTS_OCCUPANTS },
        startAt: { lt: end },
        endAt: { gt: start },
        ...(exclureId ? { id: { not: exclureId } } : {}),
      },
      select: { ref: true, startAt: true, endAt: true },
    });
    if (!conflit) return;

    throw new ConflictException({
      code: 'MISSION_SLOT_CONFLICT',
      vehiclePlate: plate,
      conflictingMission: {
        ref: conflit.ref,
        startAt: conflit.startAt.toISOString(),
        endAt: conflit.endAt.toISOString(),
      },
    });
  }

  /** Les cinq validations de creneau d'A2 § 4, dans l'ordre ou elles se lisent. */
  private validerCreneau(startAt: string, endAt: string): { start: Date; end: Date } {
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Dates invalides');
    }
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException("L'heure de fin doit suivre l'heure de depart");
    }
    const duree = end.getTime() - start.getTime();
    if (duree < DUREE_MIN_MS) {
      throw new BadRequestException('Une mission dure au moins 15 minutes');
    }
    if (duree > DUREE_MAX_MS) {
      throw new BadRequestException('Au-dela de 24 h, creez plusieurs missions');
    }
    if (start.getTime() - Date.now() > HORIZON_MAX_MS) {
      throw new BadRequestException('Trop loin dans le temps');
    }
    return { start, end };
  }

  /** Le destinataire doit etre un compte DEPOT de la MEME flotte (A2 § 4). */
  private async validerDepot(depotUserId: string | null | undefined, fleetId: string): Promise<void> {
    if (!depotUserId) return; // Sans depot : mission interne, parfaitement valide.
    const depot = await this.prisma.user.findFirst({
      where: { id: depotUserId, fleetId, role: UserRole.DEPOT },
      select: { id: true },
    });
    if (!depot) {
      throw new BadRequestException('Le destinataire doit etre un compte depot de votre flotte');
    }
  }

  private async validerConducteur(driverId: string | null | undefined, fleetId: string): Promise<void> {
    if (!driverId) return;
    const conducteur = await this.prisma.driver.findFirst({
      where: { id: driverId, fleetId },
      select: { id: true },
    });
    if (!conducteur) throw new BadRequestException('Conducteur hors de votre flotte');
  }

  private fleetDe(user: AuthUser): string {
    if (!user.fleetId) throw new ForbiddenException('Aucune flotte associee');
    return user.fleetId;
  }
}
