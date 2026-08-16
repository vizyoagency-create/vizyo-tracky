import { Injectable } from '@nestjs/common';
import { MissionStatus, UserRole, type Mission } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espace depot (2026-08) — resolution du perimetre d'un compte DEPOT.
 *
 * ┌─ LA REGLE ────────────────────────────────────────────────────────────────┐
 * │ Le perimetre d'un DEPOT se calcule A CHAQUE REQUETE, depuis `Mission`,     │
 * │ jamais depuis `UserVehicleAccess` ni `Fleet`.                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `PermissionsResolverService` resout par vehicule via `UserVehicleAccess`
 * (VEHICLE > GROUP > ALL). **Ce chemin ne s'applique pas au role DEPOT** : un depot
 * n'a aucune ligne `UserVehicleAccess`, et ne doit jamais en avoir (A1 § 7).
 * D'ou ce resolveur distinct.
 *
 * Trois invariants tenus par ce service, chacun teste :
 *
 *  1. **Filtre en requete, pas en memoire.** Le `where` Prisma porte TOUJOURS
 *     `depotUserId`. On ne charge jamais pour filtrer ensuite : une erreur de
 *     filtrage en memoire est une fuite, une erreur de `where` est une requete vide.
 *
 *  2. **L'heure est celle du SERVEUR.** Jamais une date envoyee par le client.
 *     Un depot qui poste `?at=2030-01-01` ne doit rien obtenir de plus.
 *
 *  3. **La fenetre est fermee des deux cotes.** Avant `startAt`, rien — meme si le
 *     camion roule deja. Apres `endAt`, rien — sauf si la mission est encore en
 *     cours (LATE), auquel cas la fenetre s'etend jusqu'a la cloture : c'est
 *     precisement le moment ou le depot a le plus besoin de voir le camion.
 *
 * Cf. design/A1-ROLE-DEPOT.md § 3.
 */

/** Statuts pour lesquels la position LIVE est servie a un depot. */
const STATUTS_SUIVI_ACTIF: MissionStatus[] = [MissionStatus.IN_PROGRESS, MissionStatus.LATE];

/** Duree de vie de l'index d'aiguillage des salons socket (lot A3). */
const INDEX_TTL_MS = 15_000;

@Injectable()
export class DepotScopeService {
  /** Index d'AIGUILLAGE (`vehicleId` → missions actives), jamais d'autorisation. */
  private indexCache: Map<string, string[]> | null = null;
  private indexCacheAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Les missions du depot, eventuellement bornees a un instant.
   *
   * `at` sert les vues « missions du jour » cote serveur. Il n'est JAMAIS alimente
   * par le client pour un controle d'acces — seulement pour un filtre d'affichage.
   * Le controle d'acces passe par `canSeeLivePosition` / `canSeeTrip`, qui prennent
   * l'heure serveur eux-memes.
   */
  async missionsFor(userId: string, at?: Date): Promise<Mission[]> {
    return this.prisma.mission.findMany({
      where: {
        depotUserId: userId,
        ...(at ? { startAt: { lte: at }, endAt: { gte: at } } : {}),
      },
      orderBy: { startAt: 'desc' },
    });
  }

  /**
   * Le depot peut-il voir la POSITION de ce vehicule MAINTENANT ?
   *
   * Vrai seulement s'il existe une mission ou :
   *   depotUserId = userId ET vehicleId = vehicleId
   *   ET startAt <= now ET endAt >= now
   *   ET status IN (IN_PROGRESS, LATE)
   *
   * Le statut est determinant AUTANT que la fenetre : une mission `PLANNED` ne donne
   * rien, meme si `startAt` est passe de deux minutes. C'est la premiere position
   * detectee qui fait basculer le statut — pas l'horloge (A1 § 7, regle 3).
   *
   * `LATE` etend la fenetre : `endAt` est depasse, mais le camion roule encore. La
   * borne `endAt: { gte: now }` ne s'applique donc PAS a ce statut.
   */
  async canSeeLivePosition(userId: string, vehicleId: string): Promise<boolean> {
    const now = new Date();
    const mission = await this.prisma.mission.findFirst({
      where: {
        depotUserId: userId,
        vehicleId,
        startAt: { lte: now },
        OR: [
          // En cours, dans la fenetre annoncee.
          { status: MissionStatus.IN_PROGRESS, endAt: { gte: now } },
          // En retard : la fenetre s'etend jusqu'a DONE ou cloture manuelle.
          { status: MissionStatus.LATE },
        ],
      },
      select: { id: true },
    });
    return mission !== null;
  }

  /**
   * Le depot peut-il voir l'HISTORIQUE de ce trajet ?
   *
   * Pas de borne horaire ici : une mission terminee reste consultable jusqu'a la fin
   * de la periode de conservation (12 mois, A3 § 3). Ce qui compte est le
   * rattachement : le trajet porte `missionId`, et cette mission designe ce depot.
   */
  async canSeeTrip(userId: string, tripId: string): Promise<boolean> {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, mission: { depotUserId: userId } },
      select: { id: true },
    });
    return trip !== null;
  }

  /**
   * Le depot peut-il voir CETTE mission ? Sans borne horaire : une mission planifiee
   * est visible dans sa liste (avec « le suivi demarrera a 08:15 »), et une mission
   * terminee reste dans son historique. C'est la POSITION qui est bornee, pas la
   * mission elle-meme.
   */
  async canSeeMission(userId: string, missionId: string): Promise<boolean> {
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, depotUserId: userId },
      select: { id: true },
    });
    return mission !== null;
  }

  /**
   * Les identifiants des missions dont le suivi live est actif MAINTENANT.
   * Sert a decider quelles rooms socket `depot:mission:<id>` ce compte peut rejoindre.
   */
  async activeMissionIds(userId: string): Promise<string[]> {
    const now = new Date();
    const missions = await this.prisma.mission.findMany({
      where: {
        depotUserId: userId,
        startAt: { lte: now },
        OR: [
          { status: MissionStatus.IN_PROGRESS, endAt: { gte: now } },
          { status: MissionStatus.LATE },
        ],
      },
      select: { id: true },
    });
    return missions.map((m) => m.id);
  }

  /**
   * Lot A3 — l'index qui permet A LA PASSERELLE de router une position vers les
   * salons `depot:mission:<id>` concernes : `vehicleId` → missions au suivi actif.
   *
   * ┌─ POURQUOI UN INDEX, ET POURQUOI UN CACHE ─────────────────────────────────┐
   * │ Les positions arrivent par lots, une fois par seconde. Interroger la base a │
   * │ chaque lot pour savoir si un vehicule est sur une mission ferait une        │
   * │ requete par seconde et par flotte, pour un resultat qui ne change qu'aux    │
   * │ bascules de statut — quelques fois par jour.                               │
   * │                                                                            │
   * │ Le cache est volontairement COURT (15 s) : au pire, un depot voit un        │
   * │ marqueur bouger quinze secondes de trop apres la cloture de sa mission.     │
   * │ ⚠️ Ce n'est PAS le mecanisme d'isolation — c'est un cache d'aiguillage. Le   │
   * │ verrou reste la revalidation de socket (A1) qui coupe le raccordement des   │
   * │ qu'une mission entre ou sort de la fenetre, et le refus HTTP qui, lui, relit │
   * │ toujours la base. Un cache d'aiguillage ne doit jamais devenir un cache      │
   * │ d'autorisation : c'est pourquoi il ne sert QU'A choisir un salon.           │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  async missionsActivesParVehicule(): Promise<Map<string, string[]>> {
    const maintenant = Date.now();
    if (this.indexCache && maintenant - this.indexCacheAt < INDEX_TTL_MS) {
      return this.indexCache;
    }

    const now = new Date();
    const missions = await this.prisma.mission.findMany({
      where: {
        // Une mission sans depot destinataire n'a aucun salon : l'exclure ici evite
        // de construire un index qui contiendrait les missions internes du transporteur.
        depotUserId: { not: null },
        startAt: { lte: now },
        OR: [
          { status: MissionStatus.IN_PROGRESS, endAt: { gte: now } },
          { status: MissionStatus.LATE },
        ],
      },
      select: { id: true, vehicleId: true },
    });

    const index = new Map<string, string[]>();
    for (const m of missions) {
      const deja = index.get(m.vehicleId);
      // Un vehicule peut porter deux missions actives (deux depots sur la meme
      // tournee) : chacune a son salon, chacune recoit la position.
      if (deja) deja.push(m.id);
      else index.set(m.vehicleId, [m.id]);
    }

    this.indexCache = index;
    this.indexCacheAt = maintenant;
    return index;
  }

  /** Invalide l'index d'aiguillage. Appele aux bascules de statut de mission, pour
   *  que la fin d'une mission coupe le direct sans attendre l'expiration du cache. */
  invaliderIndex(): void {
    this.indexCache = null;
  }

  /**
   * Invariant A1 § 7 : un DEPOT n'a JAMAIS de ligne `UserVehicleAccess`.
   *
   * Contrainte applicative, pas seulement documentaire — une ligne creee par erreur
   * (import, script, route mal gardee) donnerait a un depot un perimetre de flotte
   * via `PermissionsResolverService`, en contournant entierement ce service.
   * Appele a la creation et a la modification d'un compte.
   */
  async assertNoVehicleAccess(userId: string, role: UserRole): Promise<void> {
    if (role !== UserRole.DEPOT) return;
    const count = await this.prisma.userVehicleAccess.count({ where: { userId } });
    if (count > 0) {
      throw new Error(
        `Invariant viole : le compte Dépôt ${userId} porte ${count} ligne(s) UserVehicleAccess. ` +
          'Le perimetre d\'un depot se calcule depuis ses missions, jamais depuis un scope vehicule.',
      );
    }
  }
}

export { STATUTS_SUIVI_ACTIF };
