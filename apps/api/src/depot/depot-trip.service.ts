import { ForbiddenException, Injectable } from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import type { DepotTripDto, DepotTripStepDto } from '@vizyo/tracky-shared';
import { TripStopDetectorService, type TripStop } from '../agenda/trip-stop-detector.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espace depot (2026-08) — le trajet detaille (A3 § 5, modale « Detail d'un trajet »).
 *
 * ┌─ CE QUE CETTE MODALE APPORTE VRAIMENT ────────────────────────────────────┐
 * │ Le TEMPS PASSE SUR PLACE. C'est lui qui distingue « le camion est parti a   │
 * │ 8h15 » de « le camion a attendu 14 minutes au premier point » — et c'est    │
 * │ cette information qui permet au depot de comprendre un retard SANS APPELER. │
 * │ Un deroule sans les durees d'arret n'est qu'une liste d'heures.             │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Le trace servi est celui du trajet de LA MISSION. Il ne revele donc pas les points
 * de livraison precedents du camion — donc pas les autres clients du transporteur,
 * ce que le DTO de mission s'interdit explicitement (A4 § 2).
 */
@Injectable()
export class DepotTripService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stops: TripStopDetectorService,
  ) {}

  /**
   * Le trajet d'une mission du depot.
   *
   * ⚠️ Le `where` porte `mission: { depotUserId: userId }` — le garde a deja verifie
   * le rattachement, on le REVERIFIE ici. Un garde et un service qui se font
   * confiance mutuellement laissent un trou le jour ou l'un des deux change.
   */
  async trip(userId: string, tripId: string): Promise<DepotTripDto> {
    return this.construire(tripId, userId);
  }

  /**
   * Le trajet de la mission en cours — le chemin qu'emprunte « Voir le trajet » depuis
   * la carte live.
   *
   * ┌─ POURQUOI DEUX ENTREES POUR UNE MEME MODALE ──────────────────────────────┐
   * │ `Trip.missionId` est rattache A LA CLOTURE : pendant la mission, le trajet  │
   * │ existe peut-etre deja mais n'est pas encore lie. Exiger un `tripId` aurait   │
   * │ donc rendu la modale inaccessible AU MOMENT OU elle sert le plus — quand le  │
   * │ depot cherche a comprendre un retard en cours.                              │
   * │                                                                            │
   * │ Depuis l'historique on connait le `tripId` : on l'emploie. Depuis la carte   │
   * │ on connait la mission : on passe par ici, et le deroule se construit a       │
   * │ partir de la mission meme lorsque aucun trajet n'est encore rattache.        │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  async tripDeMission(userId: string, missionId: string): Promise<DepotTripDto> {
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, depotUserId: userId },
      select: {
        id: true,
        ref: true,
        originLabel: true,
        destLabel: true,
        startAt: true,
        endAt: true,
        status: true,
        actualStartAt: true,
        actualEndAt: true,
        vehicle: {
          select: {
            plate: true,
            tracker: {
              select: { id: true, lastLat: true, lastLng: true, lastPositionAt: true },
            },
          },
        },
        trips: { select: { id: true }, orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });
    if (!mission) throw new ForbiddenException('Ressource hors de votre perimetre');

    const trajet = mission.trips[0];
    if (trajet) return this.trip(userId, trajet.id);

    // Aucun trajet rattache : le deroule se construit depuis la mission seule. Les
    // quatre tuiles affichent des zeros ASSUMES — la mission a commence, le trajet
    // n'est pas encore clos, et c'est exactement ce que l'ecran doit dire.
    const suiviActif =
      mission.status === MissionStatus.IN_PROGRESS || mission.status === MissionStatus.LATE;
    const debut = mission.actualStartAt ?? mission.startAt;
    const arrets = mission.vehicle.tracker?.id
      ? await this.stops.deriveStops(mission.vehicle.tracker.id, debut, new Date())
      : [];

    return {
      missionRef: mission.ref,
      missionId: mission.id,
      origin: mission.originLabel,
      destination: mission.destLabel,
      plate: mission.vehicle.plate,
      // Aucun trajet rattache : la distance n'est PAS mesurable. `null`, pas zero —
      // un « 0 km » se lirait comme « le camion n'a pas bouge ».
      distanceKm: null,
      durationMinutes: Math.max(
        0,
        Math.round(((mission.actualEndAt ?? new Date()).getTime() - debut.getTime()) / 60_000),
      ),
      stops: arrets.length > 0 ? Math.max(0, arrets.length - (mission.actualEndAt ? 1 : 0)) : null,
      etaAt: (mission.actualEndAt ?? mission.endAt).toISOString(),
      polyline: null,
      currentPosition: this.positionActuelle(suiviActif, mission.vehicle.tracker),
      steps: this.deroule(mission, arrets, !mission.actualEndAt),
    };
  }

  private async construire(tripId: string, userId: string): Promise<DepotTripDto> {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, mission: { depotUserId: userId } },
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
        distanceKm: true,
        polyline: true,
        polylineMatched: true,
        vehicle: {
          select: {
            plate: true,
            tracker: {
              select: { id: true, lastLat: true, lastLng: true, lastPositionAt: true },
            },
          },
        },
        mission: {
          select: {
            id: true,
            ref: true,
            originLabel: true,
            destLabel: true,
            startAt: true,
            endAt: true,
            status: true,
            actualStartAt: true,
            actualEndAt: true,
          },
        },
        // Volontairement ABSENTS : notes (internes au transporteur), driverId,
        // maxSpeed / avgSpeed (donnees d'exploitation, A3 § 7 regle 2), fleetId.
      },
    });
    // Inconnu et hors perimetre donnent le MEME refus (A1 § 3).
    if (!trip?.mission) throw new ForbiddenException('Ressource hors de votre perimetre');

    const m = trip.mission;
    const debut = trip.startedAt;
    const fin = trip.endedAt ?? new Date();
    const trackerId = trip.vehicle.tracker?.id ?? null;
    const arrets = trackerId ? await this.stops.deriveStops(trackerId, debut, fin) : [];

    const suiviActif = m.status === MissionStatus.IN_PROGRESS || m.status === MissionStatus.LATE;

    return {
      missionRef: m.ref,
      missionId: m.id,
      origin: m.originLabel,
      destination: m.destLabel,
      plate: trip.vehicle.plate,
      distanceKm: Math.round(trip.distanceKm * 10) / 10,
      durationMinutes: Math.round(trip.durationSeconds / 60),
      // Les arrets INTERMEDIAIRES : le stationnement au point d'arrivee n'est pas un
      // arret « pendant » la livraison (cf. `DepotHistoryService.compterArrets`).
      stops: Math.max(0, arrets.length - 1),
      etaAt: (m.actualEndAt ?? (suiviActif ? null : m.endAt))?.toISOString() ?? null,
      // La polyligne snappee aux routes quand elle existe : le trace brut du GPS
      // donne un camion qui roule dans les champs, ce qui fait douter du reste.
      polyline: trip.polylineMatched ?? trip.polyline,
      currentPosition: this.positionActuelle(suiviActif, trip.vehicle.tracker),
      steps: this.deroule(m, arrets),
    };
  }

  /**
   * La position actuelle — servie UNIQUEMENT pendant le suivi actif.
   *
   * Hors fenetre, on ne sert rien : la mini-carte affiche le trace seul. Servir la
   * derniere position connue apres la mission reviendrait a suivre le camion apres
   * la livraison, ce que toute l'isolation d'A1 s'emploie a interdire.
   */
  private positionActuelle(
    suiviActif: boolean,
    tracker: { lastLat: number | null; lastLng: number | null; lastPositionAt: Date | null } | null,
  ): { lat: number; lng: number; at: string } | null {
    if (!suiviActif || !tracker?.lastLat || !tracker?.lastLng || !tracker?.lastPositionAt) {
      return null;
    }
    return {
      lat: tracker.lastLat,
      lng: tracker.lastLng,
      at: tracker.lastPositionAt.toISOString(),
    };
  }

  /**
   * Le deroule horodate : depart, arrets intermediaires avec leur duree, arrivee.
   *
   * L'etape a venir porte `done: false` et son heure PREVUE : l'interface la rend en
   * tirete. Une arrivee estimee affichee comme une arrivee constatee est un mensonge
   * qui ne se voit pas — c'est la meme regle que pour les positions perimees.
   */
  private deroule(
    m: {
      originLabel: string;
      destLabel: string;
      startAt: Date;
      endAt: Date;
      actualStartAt: Date | null;
      actualEndAt: Date | null;
    },
    arrets: TripStop[],
    /** Vrai pendant la mission : le dernier arret est alors en COURS, pas celui de
     *  l'arrivee — on ne le retire donc pas de la liste. */
    enCours = false,
  ): DepotTripStepDto[] {
    const etapes: DepotTripStepDto[] = [
      {
        label: `Départ · ${m.originLabel}`,
        plannedAt: m.startAt.toISOString(),
        actualAt: m.actualStartAt?.toISOString() ?? null,
        dwellMinutes: null,
        done: m.actualStartAt !== null,
      },
    ];

    // Le dernier arret est le stationnement d'arrivee : il est deja porte par l'etape
    // « Arrivee ». L'inclure afficherait deux fois le meme evenement. Pendant la
    // mission en revanche, ce dernier arret est un VRAI arret en cours : on le garde.
    const intermediaires = enCours ? arrets : arrets.slice(0, -1);
    for (const [i, arret] of intermediaires.entries()) {
      etapes.push({
        label: `Arrêt ${i + 1}`,
        plannedAt: null,
        actualAt: arret.arrivedAt.toISOString(),
        dwellMinutes: Math.round(arret.durationMin),
        done: true,
      });
    }

    etapes.push({
      label: `Arrivée · ${m.destLabel}`,
      plannedAt: m.endAt.toISOString(),
      actualAt: m.actualEndAt?.toISOString() ?? null,
      dwellMinutes: null,
      done: m.actualEndAt !== null,
    });

    return etapes;
  }
}
