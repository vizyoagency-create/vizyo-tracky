import { ForbiddenException, Injectable } from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import { maskPhone, type DepotMissionDto, type MissionStatusDto } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { resolveEffectivePrivacy } from '../privacy-mode/effective-privacy';
import { SystemActivityService } from '../system-activity/system-activity.service';
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
    private readonly activite: SystemActivityService,
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
    if (!mission) throw new ForbiddenException('Ressource hors de votre périmètre');
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
    if (!mission) throw new ForbiddenException('Ressource hors de votre périmètre');

    const autorise = await this.scope.canSeeLivePosition(userId, mission.vehicleId);
    if (!autorise) throw new ForbiddenException('Ressource hors de votre périmètre');

    const vehicule = await this.prisma.vehicle.findUnique({
      where: { id: mission.vehicleId },
      select: {
        mixedUseEnabled: true,
        privacyModeEnabled: true,
        workOverrideUntil: true,
        workSchedule: true,
        tracker: {
          select: { lastLat: true, lastLng: true, lastSpeedKmh: true, lastPositionAt: true },
        },
      },
    });

    // ══ MODE VIE PRIVEE — PRIME SUR LA FENETRE DE MISSION (lot A3) ═══════════
    //
    // Cette route lit `Tracker.lastLat/lastLng`, denormalisee sur le boitier : elle
    // court-circuite le masquage applique par `positions.service` a la lecture. Sans
    // ce test, un vehicule en vie privee serait servi au depot alors qu'il est masque
    // a son propre gestionnaire.
    //
    // La fenetre de mission dit ce qu'un depot a le droit de voir QUAND le suivi est
    // actif ; elle ne decide pas si le suivi doit l'etre. On rend la meme forme qu'un
    // boitier muet — le depot lit « suivi suspendu », sans en connaitre la raison.
    if (vehicule && resolveEffectivePrivacy(vehicule, vehicule.workSchedule).isPrivate) {
      return { unavailableSince: 0 };
    }

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
   * Le numero COMPLET du conducteur, pour declencher un appel (lot A3).
   *
   * ┌─ TROIS VERROUS, ET LE TROISIEME N'EST PAS UN REFUS ───────────────────────┐
   * │ 1. la mission appartient-elle a ce depot ?      (garde + `where` ici)       │
   * │ 2. son suivi est-il actif MAINTENANT ?          (meme fenetre qu'A1 § 3)    │
   * │ 3. l'acces est JOURNALISE, toujours.                                       │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * Le verrou 2 est ce qui distingue « appeler le conducteur de ma livraison en
   * cours » de « disposer du carnet d'adresses des chauffeurs du transporteur ».
   * Hors fenetre, le bloc conducteur n'est de toute facon pas affiche — mais un
   * endpoint qui se fie a ce que l'interface affiche n'est pas un endpoint garde.
   */
  async revelerNumeroConducteur(userId: string, missionId: string): Promise<{ phone: string }> {
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, depotUserId: userId },
      select: {
        ref: true,
        fleetId: true,
        status: true,
        startAt: true,
        endAt: true,
        driver: { select: { firstName: true, lastName: true, phone: true } },
      },
    });
    if (!mission) throw new ForbiddenException('Ressource hors de votre périmètre');

    const maintenant = new Date();
    const suiviActif =
      mission.startAt <= maintenant &&
      (mission.status === MissionStatus.LATE ||
        (mission.status === MissionStatus.IN_PROGRESS && mission.endAt >= maintenant));
    // Hors fenetre : meme refus que hors perimetre. Un message different apprendrait
    // qu'il y a bien un conducteur, et qu'il suffit d'attendre le bon creneau.
    if (!suiviActif || !mission.driver?.phone) {
      throw new ForbiddenException('Ressource hors de votre périmètre');
    }

    // ⚠️ JOURNALISE AVANT de servir. Ecrire apres laisserait une lecture non tracee
    // si la reponse echouait entre les deux — et c'est justement le cas qu'on veut voir.
    this.activite.record({
      category: 'DEPOT',
      action: 'driver_contact_revealed',
      status: 'SUCCESS',
      actor: userId,
      target: `mission ${mission.ref}`,
      detail: `Numéro du conducteur ${this.nomAffiche(mission.driver.firstName, mission.driver.lastName)} révélé au dépôt`,
      fleetId: mission.fleetId,
      triggeredByUserId: userId,
    });

    return { phone: mission.driver.phone };
  }

  /**
   * Le SEUL point d'entree public vers le DTO restreint (lot A3).
   *
   * `DepotLiveService` et `DepotHistoryService` chargent leurs missions eux-memes —
   * ils ont besoin de `vehicleId` pour joindre une position ou un trajet, ce que la
   * selection d'A1 ne porte pas. Ils passent malgre tout par CETTE methode pour la
   * mise en forme : sans elle, chacun recopierait le masquage du telephone, la
   * troncature du nom et le calcul du retard — et l'un des trois finirait par diverger.
   *
   * ⚠️ Le parametre est type par la selection d'A1 : un appelant qui aurait charge
   * `depotUserId` ou `notes` ne peut pas les faire ressortir par ici.
   */
  versDtoPublic(m: MissionSelectionnee, peutVoirConducteur: boolean): DepotMissionDto {
    return this.versDto(m, peutVoirConducteur);
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
      // A6 / T8 — les arrets de la tournee. LE LIBELLE SEUL : ni `placeId`, ni
      // `lat`/`lng`, ni `note`. Un depot doit savoir ou passe son camion, pas obtenir
      // les coordonnees des lieux cles de son transporteur ni les consignes internes
      // laissees sur un arret qui ne le concerne pas.
      stops: { select: { label: true }, orderBy: { position: 'asc' } },
      // A6 — l'historique des tournees. On charge le NOM de l'auteur, jamais son
      // identifiant : le depot doit savoir QUI a modifie, pas pouvoir remonter a un
      // compte de la societe de son transporteur.
      stopRevisions: {
        select: {
          position: true, authorName: true, reason: true, stops: true,
          distanceM: true, amountCents: true, previousAmountCents: true, createdAt: true,
        },
        orderBy: { position: 'asc' },
      },
      // Volontairement ABSENTS : vehicleId, driverId, depotUserId, notes,
      // originPlaceId, destPlaceId, createdByUserId, fleetId, authorUserId.
    } as const;
  }

  private versDto(m: MissionSelectionnee, peutVoirConducteur: boolean): DepotMissionDto {
    return {
      id: m.id,
      ref: m.ref,
      origin: m.originLabel,
      destination: m.destLabel,
      // Vide sur une mission point a point : l'ecran retombe sur `origin -> destination`.
      stops: m.stops.map((s) => s.label),
      // Vide tant que la tournee n'a jamais bouge : l'ecran n'affiche alors rien.
      stopHistory: m.stopRevisions.map((r) => ({
        position: r.position,
        authorName: r.authorName,
        reason: r.reason,
        stops: Array.isArray(r.stops)
          ? (r.stops as Array<{ label: string }>).map((s) => s.label)
          : [],
        distanceKm: r.distanceM === null ? null : r.distanceM / 1000,
        amountCents: r.amountCents,
        previousAmountCents: r.previousAmountCents,
        createdAt: r.createdAt.toISOString(),
      })),
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
  /** A6 / T8 — les arrets de la tournee. Le LIBELLE seul, cf. `selectionMission`. */
  stops: Array<{ label: string }>;
  /** A6 — l'historique des tournees. Sans identifiant d'auteur. */
  stopRevisions: Array<{
    position: number;
    authorName: string;
    reason: string | null;
    stops: unknown;
    distanceM: number | null;
    amountCents: number | null;
    previousAmountCents: number | null;
    createdAt: Date;
  }>;
};
