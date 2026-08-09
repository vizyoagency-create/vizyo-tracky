import { ForbiddenException, Injectable } from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import { maskPhone, type DepotMissionDto, type MissionStatusDto } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { DepotScopeService } from './depot-scope.service';

/**
 * Espace depot (2026-08) — le service qui SERT le depot.
 *
 * Il ne reutilise AUCUN service de la flotte, et c'est deliberé : leurs DTO exposent
 * des champs qu'un depot ne doit pas voir — couts, scores, conducteur hors mission,
 * groupe (A1 § 4). Reutiliser puis retirer des champs, c'est se condamner a en oublier
 * un le jour ou quelqu'un en ajoutera un.
 *
 * Ici, on construit le DTO champ par champ, a partir d'un `select` Prisma explicite.
 * Ce qui n'est pas selectionne ne peut pas fuir.
 */
@Injectable()
export class DepotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: DepotScopeService,
  ) {}

  /** Les missions du depot. Le `where` porte depotUserId — jamais de filtrage en memoire. */
  async listMissions(
    userId: string,
    filtres: { status?: MissionStatus; from?: Date; to?: Date },
    peutVoirConducteur: boolean,
  ): Promise<DepotMissionDto[]> {
    const missions = await this.prisma.mission.findMany({
      where: {
        depotUserId: userId,
        ...(filtres.status ? { status: filtres.status } : {}),
        ...(filtres.from ? { startAt: { gte: filtres.from } } : {}),
        ...(filtres.to ? { endAt: { lte: filtres.to } } : {}),
      },
      select: this.selectionMission(),
      orderBy: { startAt: 'desc' },
    });
    return missions.map((m) => this.versDto(m, peutVoirConducteur));
  }

  /** Une mission. Le `where` porte depotUserId : hors perimetre, rien ne remonte. */
  async getMission(
    userId: string,
    missionId: string,
    peutVoirConducteur: boolean,
  ): Promise<DepotMissionDto> {
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, depotUserId: userId },
      select: this.selectionMission(),
    });
    // Inconnu et hors perimetre donnent le MEME refus — sinon on permet d'enumerer.
    if (!mission) throw new ForbiddenException('Ressource hors de votre perimetre');
    return this.versDto(mission, peutVoirConducteur);
  }

  /**
   * La position live du vehicule d'une mission.
   *
   * Deux verrous, dans cet ordre :
   *   1. la mission appartient-elle a ce depot ?
   *   2. son suivi est-il actif MAINTENANT ? (IN_PROGRESS|LATE, fenetre couverte)
   *
   * Hors fenetre : 403. **Jamais** une derniere position connue presentee comme
   * actuelle — c'est le pire des deux mondes : faux ET credible.
   */
  async getLivePosition(
    userId: string,
    missionId: string,
  ): Promise<{ lat: number; lng: number; speedKmh: number | null; at: string } | { unavailableSince: number }> {
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, depotUserId: userId },
      select: { vehicleId: true },
    });
    if (!mission) throw new ForbiddenException('Ressource hors de votre perimetre');

    const autorise = await this.scope.canSeeLivePosition(userId, mission.vehicleId);
    if (!autorise) throw new ForbiddenException('Ressource hors de votre perimetre');

    const vehicule = await this.prisma.vehicle.findUnique({
      where: { id: mission.vehicleId },
      select: {
        tracker: {
          select: { lastLat: true, lastLng: true, lastSpeedKmh: true, lastPositionAt: true },
        },
      },
    });

    const t = vehicule?.tracker;
    if (!t?.lastLat || !t?.lastLng || !t?.lastPositionAt) {
      // Boitier muet : on le DIT, on ne sert pas un point perime (A1 § 6).
      return { unavailableSince: 0 };
    }

    const ageMinutes = Math.floor((Date.now() - t.lastPositionAt.getTime()) / 60_000);
    // Au-dela de 10 minutes, la position n'est plus « actuelle » : on la declare
    // indisponible plutot que de la presenter comme fraiche.
    if (ageMinutes > 10) return { unavailableSince: ageMinutes };

    return {
      lat: t.lastLat,
      lng: t.lastLng,
      speedKmh: t.lastSpeedKmh ?? null,
      at: t.lastPositionAt.toISOString(),
    };
  }

  /**
   * LA SELECTION EST LE CONTRAT. Tout champ absent d'ici ne peut pas fuir, meme si
   * quelqu'un l'ajoute au DTO par inadvertance : Prisma ne l'aura pas charge.
   */
  private selectionMission() {
    return {
      id: true,
      ref: true,
      originLabel: true,
      destLabel: true,
      startAt: true,
      endAt: true,
      status: true,
      actualEndAt: true,
      // `label` n'existe pas sur Vehicle : le libellé « Renault D 12 t » se compose
      // de brand + model. On ne charge NI l'id, NI l'imei, NI le groupe.
      vehicle: { select: { plate: true, brand: true, model: true } },
      driver: { select: { firstName: true, lastName: true, phone: true } },
      fleet: { select: { name: true } },
      // Volontairement ABSENTS : vehicleId, driverId, depotUserId, notes,
      // originPlaceId, destPlaceId, createdByUserId, fleetId.
    } as const;
  }

  private versDto(m: MissionSelectionnee, peutVoirConducteur: boolean): DepotMissionDto {
    return {
      id: m.id,
      ref: m.ref,
      origin: m.originLabel,
      destination: m.destLabel,
      startAt: m.startAt.toISOString(),
      endAt: m.endAt.toISOString(),
      status: m.status as MissionStatusDto,
      vehicle: { plate: m.vehicle.plate, label: this.libelleVehicule(m.vehicle) },
      driver:
        peutVoirConducteur && m.driver
          ? {
              displayName: this.nomAffiche(m.driver.firstName, m.driver.lastName),
              phone: maskPhone(m.driver.phone),
            }
          : null,
      etaAt: null, // Calcule par le lot A3 (a partir du trajet en cours).
      delayMinutes: this.retardMinutes(m),
      carrierName: m.fleet.name,
    };
  }

  /** « Renault D 12 t » — marque + modele. Null si le transporteur n'a rien renseigne. */
  private libelleVehicule(v: { brand: string | null; model: string | null }): string | null {
    const libelle = [v.brand, v.model].filter(Boolean).join(' ').trim();
    return libelle || null;
  }

  /** « Karim B. » — prenom + initiale. Jamais le nom complet (A1 § 4). */
  private nomAffiche(prenom: string | null, nom: string | null): string {
    const p = (prenom ?? '').trim();
    const initiale = (nom ?? '').trim().charAt(0);
    if (!p && !initiale) return 'Conducteur';
    return initiale ? `${p} ${initiale.toUpperCase()}.`.trim() : p;
  }

  /**
   * Retard CALCULE A LA VOLEE — jamais stocke : il change a chaque minute (A2 § 2).
   * `now - endAt` si en cours, `actualEndAt - endAt` si terminee.
   */
  private retardMinutes(m: MissionSelectionnee): number | null {
    if (m.status === MissionStatus.LATE) {
      return Math.max(0, Math.floor((Date.now() - m.endAt.getTime()) / 60_000));
    }
    if (m.status === MissionStatus.DONE && m.actualEndAt) {
      const ecart = Math.floor((m.actualEndAt.getTime() - m.endAt.getTime()) / 60_000);
      return ecart > 0 ? ecart : 0;
    }
    return null;
  }
}

type MissionSelectionnee = {
  id: string;
  ref: string;
  originLabel: string;
  destLabel: string;
  startAt: Date;
  endAt: Date;
  status: MissionStatus;
  actualEndAt: Date | null;
  vehicle: { plate: string; brand: string | null; model: string | null };
  driver: { firstName: string; lastName: string; phone: string | null } | null;
  fleet: { name: string };
};
