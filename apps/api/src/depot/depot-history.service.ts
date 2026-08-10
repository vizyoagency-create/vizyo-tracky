import { Injectable } from '@nestjs/common';
import { MissionStatus, type Prisma } from '@prisma/client';
import {
  DEPOT_KPI_MIN_SAMPLE,
  DEPOT_RETENTION_MONTHS,
  type DepotHistoryDto,
  type DepotHistoryKpisDto,
  type DepotHistoryRowDto,
} from '@vizyo/tracky-shared';
import { TripStopDetectorService } from '../agenda/trip-stop-detector.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espace depot (2026-08) — l'onglet Historique et ses KPI (A3 § 3).
 *
 * ┌─ LES KPI SE CALCULENT ICI, PAS DANS LE NAVIGATEUR ────────────────────────┐
 * │ Un calcul cote client obligerait a servir toutes les missions de la periode │
 * │ pour en deriver quatre nombres. C'est exactement le contraire du principe   │
 * │ du DTO restreint : on servirait plus pour afficher moins (A3 § 8).          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Le « % a l'heure » est l'indicateur que le depot regarde vraiment : c'est la note
 * de son transporteur. Il se calcule sur les missions `DONE` de la periode, par
 * `actualEndAt <= endAt` — l'heure REELLE contre l'heure ANNONCEE, jamais contre une
 * heure recalculee apres coup.
 */

/**
 * Borne dure du nombre de lignes servies.
 *
 * Ce n'est pas de la pagination : c'est ce qui borne le travail de derivation des
 * arrets (une lecture de positions par trajet). Le pied de tableau annonce le total
 * conserve, donc une periode plus large ne se solde jamais par un chiffre silencieux.
 */
const MAX_LIGNES = 100;

/** Conservation : au-dela, les trajets sortent de l'espace depot (A3 § 3). */
function debutConservation(at: Date): Date {
  const d = new Date(at);
  d.setMonth(d.getMonth() - DEPOT_RETENTION_MONTHS);
  return d;
}

@Injectable()
export class DepotHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stops: TripStopDetectorService,
  ) {}

  async history(
    userId: string,
    filtres: { from?: Date; to?: Date; plate?: string; destination?: string },
    peutVoirConducteur: boolean,
  ): Promise<DepotHistoryDto> {
    const maintenant = new Date();
    const plancher = debutConservation(maintenant);

    // ⚠️ `depotUserId` d'abord, TOUJOURS. Les filtres de l'utilisateur s'ajoutent a ce
    // bornage, ils ne le remplacent jamais : une plaque inconnue restreint, elle
    // n'ouvre rien. Le plancher de conservation est applique en `where`, pas apres
    // lecture — un trajet de 13 mois ne doit pas quitter la base.
    const where: Prisma.MissionWhereInput = {
      depotUserId: userId,
      status: MissionStatus.DONE,
      startAt: {
        gte: filtres.from && filtres.from > plancher ? filtres.from : plancher,
        ...(filtres.to ? { lte: filtres.to } : {}),
      },
      ...(filtres.plate ? { vehicle: { plate: filtres.plate } } : {}),
      ...(filtres.destination ? { destLabel: filtres.destination } : {}),
    };

    const missions = await this.prisma.mission.findMany({
      where,
      select: {
        id: true,
        ref: true,
        originLabel: true,
        destLabel: true,
        startAt: true,
        endAt: true,
        actualStartAt: true,
        actualEndAt: true,
        vehicle: { select: { plate: true, tracker: { select: { id: true } } } },
        driver: { select: { firstName: true, lastName: true } },
        trips: {
          select: { id: true, distanceKm: true, startedAt: true, endedAt: true },
          orderBy: { startedAt: 'asc' },
        },
      },
      orderBy: { startAt: 'desc' },
      take: MAX_LIGNES,
    });

    const rows = await Promise.all(
      missions.map((m) => this.versLigne(m, peutVoirConducteur)),
    );

    // Le total CONSERVE, sans les filtres d'affichage : c'est le « sur 23 » du pied de
    // tableau. Compte des missions DU DEPOT — jamais des trajets de la flotte.
    const totalRetained = await this.prisma.mission.count({
      where: {
        depotUserId: userId,
        status: MissionStatus.DONE,
        startAt: { gte: plancher },
      },
    });

    const { plates, destinations } = await this.valeursDeFiltre(userId, plancher);

    return {
      rows,
      kpis: this.kpis(missions),
      totalRetained,
      plates,
      destinations,
      retentionMonths: DEPOT_RETENTION_MONTHS,
    };
  }

  /**
   * Les 4 KPI d'A3 § 3.
   *
   * `onTimePercent` est NULL sous le seuil d'echantillon plutot que « 0 % » ou
   * « 100 % » : un taux sur deux missions n'est pas une note, et le depot le lirait
   * pourtant comme un jugement sur son transporteur. L'interface affiche alors un
   * tiret EXPLIQUE, avec la taille d'echantillon qu'on lui donne ici.
   */
  private kpis(missions: MissionHistorique[]): DepotHistoryKpisDto {
    const cloturees = missions.filter((m) => m.actualEndAt !== null);
    const aLHeure = cloturees.filter((m) => m.actualEndAt! <= m.endAt).length;

    const durees = missions
      .filter((m) => m.actualStartAt && m.actualEndAt)
      .map((m) => (m.actualEndAt!.getTime() - m.actualStartAt!.getTime()) / 60_000);

    const retards = cloturees
      .map((m) => Math.floor((m.actualEndAt!.getTime() - m.endAt.getTime()) / 60_000))
      .filter((minutes) => minutes > 0);

    return {
      delivered: missions.length,
      onTimePercent:
        cloturees.length >= DEPOT_KPI_MIN_SAMPLE
          ? Math.round((aLHeure / cloturees.length) * 100)
          : null,
      onTimeSampleSize: cloturees.length,
      avgDurationMinutes: durees.length > 0 ? Math.round(this.moyenne(durees)) : null,
      // La moyenne porte sur les missions EN RETARD, pas sur toutes : diluee par les
      // missions a l'heure, elle afficherait « 3 min » pour un retard reel de 40.
      avgDelayMinutes: retards.length > 0 ? Math.round(this.moyenne(retards)) : null,
      delayedCount: retards.length,
    };
  }

  private moyenne(valeurs: number[]): number {
    return valeurs.reduce((somme, v) => somme + v, 0) / valeurs.length;
  }

  private async versLigne(
    m: MissionHistorique,
    peutVoirConducteur: boolean,
  ): Promise<DepotHistoryRowDto> {
    const trajet = m.trips[0] ?? null;
    const distanceKm = m.trips.reduce((somme, t) => somme + (t.distanceKm ?? 0), 0);
    const retard = m.actualEndAt
      ? Math.floor((m.actualEndAt.getTime() - m.endAt.getTime()) / 60_000)
      : null;

    return {
      missionId: m.id,
      ref: m.ref,
      origin: m.originLabel,
      destination: m.destLabel,
      date: m.startAt.toISOString(),
      actualStartAt: m.actualStartAt?.toISOString() ?? null,
      actualEndAt: m.actualEndAt?.toISOString() ?? null,
      plate: m.vehicle.plate,
      driverName:
        peutVoirConducteur && m.driver
          ? this.nomAffiche(m.driver.firstName, m.driver.lastName)
          : null,
      distanceKm: m.trips.length > 0 ? Math.round(distanceKm * 10) / 10 : null,
      stops: await this.compterArrets(m),
      onTime: m.actualEndAt ? m.actualEndAt <= m.endAt : null,
      // Une avance n'est pas un retard negatif : on la ramene a zero. « -12 min » se
      // lirait comme une anomalie de calcul, pas comme une livraison en avance.
      delayMinutes: retard === null ? null : Math.max(0, retard),
      tripId: trajet?.id ?? null,
    };
  }

  /**
   * Les arrets INTERMEDIAIRES : le detecteur compte aussi le stationnement au point
   * d'arrivee, qui n'est pas un arret « pendant » la livraison. On retire donc le
   * dernier — sinon toute mission afficherait au moins un arret, ce qui rend la
   * colonne inutile puisqu'elle ne distingue plus rien.
   *
   * Null quand aucun trajet n'est rattache : la colonne affiche un tiret plutot
   * qu'un « 0 » qu'on lirait comme « le camion n'a pas marque d'arret ».
   */
  private async compterArrets(m: MissionHistorique): Promise<number | null> {
    const trackerId = m.vehicle.tracker?.id;
    const debut = m.actualStartAt ?? m.trips[0]?.startedAt ?? null;
    const fin = m.actualEndAt ?? m.trips[m.trips.length - 1]?.endedAt ?? null;
    if (!trackerId || !debut || !fin) return null;

    const arrets = await this.stops.deriveStops(trackerId, debut, fin);
    return Math.max(0, arrets.length - 1);
  }

  /** Les valeurs presentes dans l'historique, pour peupler les deux filtres. On ne
   *  sert PAS le catalogue des vehicules de la flotte : seulement ce que le depot a
   *  deja vu passer sur ses propres missions. */
  private async valeursDeFiltre(
    userId: string,
    plancher: Date,
  ): Promise<{ plates: string[]; destinations: string[] }> {
    const missions = await this.prisma.mission.findMany({
      where: { depotUserId: userId, status: MissionStatus.DONE, startAt: { gte: plancher } },
      select: { destLabel: true, vehicle: { select: { plate: true } } },
      take: 500,
    });
    const plates = [...new Set(missions.map((m) => m.vehicle.plate))].sort();
    const destinations = [...new Set(missions.map((m) => m.destLabel))].sort();
    return { plates, destinations };
  }

  /** « Karim B. » — meme regle qu'A1 : jamais le nom complet. */
  private nomAffiche(prenom: string | null, nom: string | null): string {
    const p = (prenom ?? '').trim();
    const initiale = (nom ?? '').trim().charAt(0);
    if (!p && !initiale) return 'Conducteur';
    return initiale ? `${p} ${initiale.toUpperCase()}.`.trim() : p;
  }
}

type MissionHistorique = {
  id: string;
  ref: string;
  originLabel: string;
  destLabel: string;
  startAt: Date;
  endAt: Date;
  actualStartAt: Date | null;
  actualEndAt: Date | null;
  vehicle: { plate: string; tracker: { id: string } | null };
  driver: { firstName: string; lastName: string } | null;
  trips: Array<{ id: string; distanceKm: number; startedAt: Date; endedAt: Date | null }>;
};
