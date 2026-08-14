import { Injectable } from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import type {
  DepotLiveDto,
  DepotPositionDto,
  DepotPositionUnavailableDto,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { resolveEffectivePrivacy } from '../privacy-mode/effective-privacy';
import { DepotService } from './depot.service';

/**
 * Espace depot (2026-08) — la lecture unique de l'ecran carte (A3 § 1).
 *
 * ┌─ POURQUOI UN SEUL APPEL ──────────────────────────────────────────────────┐
 * │ L'alternative etait `GET /depot/missions` suivi d'un appel                  │
 * │ `/depot/missions/:id/position` par mission. Ces appels repondent `403` pour │
 * │ toute mission dont le suivi n'est pas actif — soit, sur le jeu de reference,│
 * │ deux 403 toutes les vingt secondes, pour un ecran qui fonctionne.           │
 * │                                                                            │
 * │ Or c'est par les journaux qu'on verifie l'isolation. Un ecran qui produit   │
 * │ des refus LEGITIMES en continu rend les refus REELS illisibles. On ne noie  │
 * │ pas le signal qui sert a prouver la propriete qu'on tient a prouver.        │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Les trois routes d'A1 restent intactes : elles sont le contrat verifie par les
 * 31 controles HTTP, et `/depot/missions/:id/position` demeure le seul chemin qui
 * prouve, ressource par ressource, que la fenetre est fermee des deux cotes.
 */

/** Au-dela, la position n'est plus « actuelle » : on la declare indisponible. */
const FRAICHEUR_MAX_MINUTES = 10;

@Injectable()
export class DepotLiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly depot: DepotService,
  ) {}

  async live(userId: string, peutVoirConducteur: boolean): Promise<DepotLiveDto> {
    const maintenant = new Date();
    const { debut, fin } = this.journee(maintenant);

    const compte = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        firstName: true,
        lastName: true,
        fleetId: true,
        fleet: { select: { name: true } },
      },
    });

    // Les missions DU JOUR — plus toute mission encore ouverte, meme commencee hier :
    // une mission en retard depuis 22 h est precisement celle que le depot cherche.
    const missions = await this.prisma.mission.findMany({
      where: {
        depotUserId: userId,
        OR: [
          { startAt: { lte: fin }, endAt: { gte: debut } },
          { status: MissionStatus.LATE },
          { status: MissionStatus.IN_PROGRESS },
        ],
      },
      select: this.selection(),
      orderBy: { startAt: 'asc' },
    });

    const dto = missions.map((m) => this.depot.versDtoPublic(m, peutVoirConducteur));

    // Les positions : uniquement les missions dont le suivi est actif MAINTENANT.
    // La regle est celle d'A1 — statut IN_PROGRESS|LATE ET fenetre couverte — et elle
    // est appliquee ici sur les memes bornes, pas sur une variante approchante.
    const actives = missions.filter((m) => this.suiviActif(m, maintenant));
    const { positions, unavailable } = await this.positions(actives, maintenant);

    return {
      carrierName: compte?.fleet?.name ?? 'Votre transporteur',
      depotName: this.nomDepot(compte),
      missions: dto,
      positions,
      unavailable,
      otherVehiclesCount: await this.autresCamions(compte?.fleetId ?? null, missions),
      serverTime: maintenant.toISOString(),
    };
  }

  /**
   * Les camions du transporteur qui ne sont sur AUCUNE mission de ce depot.
   *
   * ⚠️ SEUL chiffre de tout l'espace depot calcule sur la flotte — l'unique exception
   * a la regle 1 d'A3 § 7, et elle est deliberee (cf. `DepotLiveDto.otherVehiclesCount`).
   *
   * Le decompte se fait sur les PLAQUES des missions du jour, pas sur toutes les
   * missions jamais recues : un depot qui a vu passer les sept camions en un an
   * verrait sinon l'encart disparaitre, alors que la garantie qu'il enonce, elle,
   * n'a pas change.
   */
  private async autresCamions(
    fleetId: string | null,
    missions: Array<{ vehicle: { plate: string } }>,
  ): Promise<number> {
    if (!fleetId) return 0;
    const totalFlotte = await this.prisma.vehicle.count({ where: { fleetId } });
    const surMesMissions = new Set(missions.map((m) => m.vehicle.plate)).size;
    return Math.max(0, totalFlotte - surMesMissions);
  }

  /**
   * Les positions des missions au suivi actif, en UNE requete.
   *
   * Un boitier muet ou en retard de plus de dix minutes ne produit pas une position :
   * il produit une INDISPONIBILITE datee. Jamais un point perime presente comme
   * actuel — « c'est le pire des deux mondes : faux ET credible » (A1 § 6).
   */
  private async positions(
    missions: Array<{ id: string; vehicleId: string; destPlaceId: string | null }>,
    maintenant: Date,
  ): Promise<{ positions: DepotPositionDto[]; unavailable: DepotPositionUnavailableDto[] }> {
    if (missions.length === 0) return { positions: [], unavailable: [] };

    const vehicules = await this.prisma.vehicle.findMany({
      where: { id: { in: missions.map((m) => m.vehicleId) } },
      select: {
        id: true,
        // Les trois champs dont depend le mode vie privee, et le cadre horaire.
        mixedUseEnabled: true,
        privacyModeEnabled: true,
        workOverrideUntil: true,
        workSchedule: true,
        tracker: {
          select: { lastLat: true, lastLng: true, lastSpeedKmh: true, lastPositionAt: true },
        },
      },
    });
    const parVehicule = new Map(vehicules.map((v) => [v.id, v]));
    const destinations = await this.destinations(missions);

    const positions: DepotPositionDto[] = [];
    const unavailable: DepotPositionUnavailableDto[] = [];

    for (const m of missions) {
      const vehicule = parVehicule.get(m.vehicleId);

      // ══ MODE VIE PRIVEE — LE VERROU QUI PRIME SUR LA MISSION ═══════════════
      //
      // Le depot lit la position depuis `Tracker.lastLat/lastLng`, denormalisee sur
      // le boitier. Ce chemin COURT-CIRCUITE le masquage que `positions.service`
      // applique a la lecture : sans ce test, un vehicule en vie privee serait servi
      // au depot alors qu'il est masque a son propre gestionnaire.
      //
      // La fenetre de mission ne l'emporte pas sur la vie privee. Elle dit ce qu'un
      // depot a le droit de voir QUAND le suivi est actif ; elle ne decide pas si le
      // suivi doit l'etre. C'est la meme regle que pour la flotte, appliquee ici.
      if (
        vehicule &&
        resolveEffectivePrivacy(vehicule, vehicule.workSchedule, maintenant).isPrivate
      ) {
        // « Suivi suspendu », sans dire pourquoi (A3 § 8) : la raison appartient au
        // conducteur. `unavailableSince: 0` — une duree ferait deviner le debut.
        unavailable.push({ missionId: m.id, unavailableSince: 0, reason: 'SUSPENDED' });
        continue;
      }

      const t = vehicule?.tracker;
      if (!t?.lastLat || !t?.lastLng || !t?.lastPositionAt) {
        unavailable.push({ missionId: m.id, unavailableSince: 0, reason: 'UNAVAILABLE' });
        continue;
      }
      const age = Math.floor((maintenant.getTime() - t.lastPositionAt.getTime()) / 60_000);
      if (age > FRAICHEUR_MAX_MINUTES) {
        unavailable.push({ missionId: m.id, unavailableSince: age, reason: 'UNAVAILABLE' });
        continue;
      }
      const dest = m.destPlaceId ? destinations.get(m.destPlaceId) : undefined;
      positions.push({
        missionId: m.id,
        lat: t.lastLat,
        lng: t.lastLng,
        speedKmh: t.lastSpeedKmh ?? null,
        at: t.lastPositionAt.toISOString(),
        remainingKm: dest ? this.distanceKm(t.lastLat, t.lastLng, dest.lat, dest.lng) : null,
      });
    }
    return { positions, unavailable };
  }

  /**
   * Les coordonnees des destinations, LUES ICI ET SERVIES NULLE PART.
   *
   * Elles ne sortent pas de ce service : seule la distance qu'on en derive est servie.
   * Livrer la latitude d'un lieu cle de la flotte reviendrait a exposer par le canal
   * de la carte ce que le DTO de mission refuse par principe (A1 § 4).
   */
  private async destinations(
    missions: Array<{ destPlaceId: string | null }>,
  ): Promise<Map<string, { lat: number; lng: number }>> {
    const ids = [...new Set(missions.map((m) => m.destPlaceId).filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const lieux = await this.prisma.fleetPlace.findMany({
      where: { id: { in: ids } },
      select: { id: true, lat: true, lng: true },
    });
    return new Map(lieux.map((l) => [l.id, { lat: l.lat, lng: l.lng }]));
  }

  /**
   * Distance a vol d'oiseau, arrondie au kilometre.
   *
   * A vol d'oiseau et pas par la route : un itineraire routier demanderait un appel a
   * un service externe a chaque rafraichissement, pour une precision dont personne
   * n'a besoin ici. L'arrondi au kilometre DIT que c'est un ordre de grandeur —
   * « 12 km » se lit comme une approximation, « 12,4 km » comme une mesure.
   */
  private distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const rad = (d: number): number => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }

  /** La regle d'A1 § 3, appliquee en memoire sur des missions DEJA bornees par le
   *  `where` sur depotUserId — jamais pour decider d'un acces, seulement d'un affichage. */
  private suiviActif(m: { status: MissionStatus; startAt: Date; endAt: Date }, at: Date): boolean {
    if (m.startAt > at) return false;
    if (m.status === MissionStatus.LATE) return true;
    return m.status === MissionStatus.IN_PROGRESS && m.endAt >= at;
  }

  /** Bornes du jour, a l'heure SERVEUR. Jamais une date envoyee par le client. */
  private journee(at: Date): { debut: Date; fin: Date } {
    const debut = new Date(at);
    debut.setHours(0, 0, 0, 0);
    const fin = new Date(at);
    fin.setHours(23, 59, 59, 999);
    return { debut, fin };
  }

  /** « Dépôt Fenouillet ». Repli neutre plutot qu'un e-mail affiche en en-tete. */
  private nomDepot(compte: { firstName: string | null; lastName: string | null } | null): string {
    const nom = [compte?.firstName, compte?.lastName].filter(Boolean).join(' ').trim();
    return nom || 'Votre dépôt';
  }

  /** La meme selection qu'A1, plus `vehicleId` — necessaire pour joindre la position,
   *  et qui ne sort JAMAIS du service : `versDtoPublic` ne le recopie pas. */
  private selection() {
    return {
      id: true,
      ref: true,
      originLabel: true,
      destLabel: true,
      startAt: true,
      endAt: true,
      status: true,
      actualEndAt: true,
      vehicleId: true,
      // `destPlaceId` sert la distance restante et NE SORT PAS : `versDtoPublic` ne le
      // recopie pas, et seule la distance derivee est servie (cf. `destinations`).
      destPlaceId: true,
      vehicle: { select: { plate: true, brand: true, model: true } },
      driver: { select: { firstName: true, lastName: true, phone: true } },
      fleet: { select: { name: true } },
      // A6 / T8 — la tournee, LIBELLES SEULS. Cette selection nourrit `versDtoPublic`,
      // qui est le contrat du depot : y omettre les arrets aurait fait de la carte
      // live le seul ecran du depot ou une tournee a quatre points se lit encore
      // « Fenouillet -> Muret ». Le typage l'a d'ailleurs refuse, et c'est exactement
      // ce que la selection partagee est censee provoquer.
      stops: { select: { label: true }, orderBy: { position: 'asc' } },
    } as const;
  }
}
