import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  MissionStatus,
  MissionStopKind,
  Prisma,
  UserRole,
  VehicleEventStatus,
  VehicleEventType,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '../auth/types/auth-user';
import { NO_FLEET, requiredFleetScope } from '../common/tenant-scope';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { MissionShareService } from '../depot/mission-share.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

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
  /**
   * La societe dans laquelle creer la mission. N'a de sens que pour un SUPER_ADMIN,
   * qui n'appartient a aucune flotte et choisit la sienne dans le selecteur global.
   * Ignore pour tout autre role : le serveur impose alors la flotte du compte.
   */
  fleetId?: string | null;
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
  /**
   * A6 / T8 — les arrêts, quand la mission en compte plus de deux (arbitrage A :
   * « c'est rare, les missions avec une seule adresse »).
   *
   * ┌─ OPTIONNEL, ET IL DOIT LE RESTER ─────────────────────────────────────────┐
   * │ `originLabel` et `destLabel` restent OBLIGATOIRES et restent la source     │
   * │ affichée par tout l'existant : liste des missions, espace dépôt, liens     │
   * │ publics, agenda, e-mails. Les arrêts s'ajoutent À CÔTÉ, ils ne remplacent  │
   * │ rien.                                                                      │
   * │                                                                            │
   * │ Concrètement : un appelant qui ne les envoie pas — l'API publique, un      │
   * │ script, l'agenda avant cette version — crée exactement la mission qu'il    │
   * │ créait hier. C'est ce qui rend T8 déployable sans reprendre les cinq       │
   * │ chemins de lecture qui existent déjà.                                      │
   * │                                                                            │
   * │ Quand ils SONT envoyés, les deux libellés sont RECALCULÉS depuis le        │
   * │ premier et le dernier arrêt : deux vérités sur le même trajet finiraient   │
   * │ par diverger, et c'est le résumé qui doit suivre la source, jamais         │
   * │ l'inverse (§ 4.1).                                                          │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  stops?: ArretMissionEntree[];
}

/** Un arrêt saisi. Le premier est le chargement, les suivants des livraisons. */
export interface ArretMissionEntree {
  label: string;
  placeId?: string | null;
  /** Créneau souhaité SUR CET ARRÊT — distinct de la fenêtre de la mission. */
  wantedAt?: string | null;
  note?: string | null;
}

/** Une ligne du tableau des missions, cote transporteur (A2 § 6). */
export interface MissionListeDto {
  id: string;
  ref: string;
  origin: string;
  destination: string;
  startAt: string;
  endAt: string;
  status: MissionStatus;
  plate: string;
  driverName: string | null;
  depotId: string | null;
  depotName: string | null;
  /**
   * A6 / T8 — les arrêts, dans l'ordre de passage. Libellés seuls.
   *
   * VIDE pour une mission point à point, et pour toutes celles créées avant T8 :
   * l'écran retombe alors sur `origin → destination`. C'est ce qui permet d'ajouter
   * ce champ sans reprendre aucun des affichages existants.
   */
  stops: string[];
}

/** Un vehicule et sa disponibilite sur le creneau demande (A2 § 4, niveau 1). */
export interface VehiculeDisponibiliteDto {
  id: string;
  plate: string;
  label: string | null;
  available: boolean;
  /** « Déjà en mission M-2482 · 09:00 → 12:20 ». Null si libre. */
  reason: string | null;
  /**
   * Le prochain instant où ce véhicule est libre pendant la durée demandée (ISO 8601).
   * Renseigné UNIQUEMENT quand aucun véhicule n'est disponible — c'est le niveau 2
   * d'A2 § 4 : proposer une sortie plutôt qu'annoncer un échec. `null` si le véhicule
   * est libre, ou si rien ne se dégage sous 14 jours.
   */
  nextFreeAt: string | null;
}

/** Les 5 compteurs en tete de l'onglet Missions. */
export interface CompteursMissions {
  enCours: number;
  planifiees: number;
  enRetard: number;
  /** Vehicules DISTINCTS immobilises — le lien visible avec l'effet 2. */
  vehiculesIndisponibles: number;
  depotsDestinataires: number;
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

/** Champs qu'une modification peut porter. */
export interface ModifierMissionEntree {
  originLabel?: string;
  destLabel?: string;
  startAt?: string;
  endAt?: string;
  vehicleId?: string;
  driverId?: string | null;
  depotUserId?: string | null;
  notes?: string | null;
}

type ChampModifiable = keyof ModifierMissionEntree;

/**
 * Ce qui est modifiable selon le statut (A2 § 6).
 *
 * `LATE` suit `IN_PROGRESS` : la mission court encore, le camion roule, et le
 * gestionnaire doit pouvoir repousser l'heure de fin — c'est meme le cas le plus
 * frequent quand une livraison prend du retard.
 */
const CHAMPS_MODIFIABLES: Record<MissionStatus, ChampModifiable[]> = {
  [MissionStatus.PLANNED]: [
    'originLabel', 'destLabel', 'startAt', 'endAt', 'vehicleId', 'driverId', 'depotUserId', 'notes',
  ],
  [MissionStatus.IN_PROGRESS]: ['endAt', 'driverId', 'notes'],
  [MissionStatus.LATE]: ['endAt', 'driverId', 'notes'],
  [MissionStatus.DONE]: ['notes'],
  [MissionStatus.CANCELLED]: [],
};

const LIBELLE_STATUT: Record<MissionStatus, string> = {
  [MissionStatus.PLANNED]: 'planifiée',
  [MissionStatus.IN_PROGRESS]: 'en cours',
  [MissionStatus.LATE]: 'en retard',
  [MissionStatus.DONE]: 'terminée',
  [MissionStatus.CANCELLED]: 'annulée',
};

/** La mission en cours d'un véhicule — bandeau de la fiche véhicule (A2 § 9). */
export interface MissionEnCoursDto {
  id: string;
  ref: string;
  origin: string;
  destination: string;
  startAt: string;
  endAt: string;
  status: MissionStatus;
  depotName: string | null;
  /** Un tiers suit-il la position en ce moment ? Le bandeau doit le dire. */
  depotWatching: boolean;
}

/** L'effet d'un changement d'heure de fin sur l'accès du dépôt destinataire. */
export interface ImpactFenetre {
  sens: 'ETENDUE' | 'REDUITE';
  minutes: number;
  nouvelleFin: string;
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
    private readonly gateway: RealtimeGateway,
    private readonly partage: MissionShareService,
  ) {}

  async creer(
    user: AuthUser,
    entree: CreerMissionEntree,
    /**
     * Reglages d'appel, HORS du DTO d'entree — et c'est important : `CreerMissionEntree`
     * est le corps de `POST /missions`. Y glisser un interrupteur de notification
     * laisserait un client couper l'e-mail du depot depuis l'exterieur.
     *
     * Seul l'appelant INTERNE s'en sert : `MissionRequestsService.affecter` envoie son
     * propre avis, qui nomme la demande negociee (« D-0142 est devenue M-2481 »). Sans
     * ce reglage, le depot recevrait deux e-mails dans la meme seconde pour un seul
     * evenement — celui-ci et l'avis generique, qui ignore tout de la negociation.
     */
    reglages: { notifierDepot?: boolean } = {},
  ): Promise<ResultatCreation> {
    const fleetId = this.porteeEcriture(user, entree.fleetId);
    const { start, end } = this.validerCreneau(entree.startAt, entree.endAt);

    const vehicule = await this.prisma.vehicle.findFirst({
      where: { id: entree.vehicleId, fleetId },
      select: { id: true, plate: true, tracker: { select: { id: true } } },
    });
    // Hors flotte → 403, et le meme message qu'un vehicule inexistant : sinon on
    // permet de tester l'appartenance d'un identifiant a une flotte.
    if (!vehicule) throw new ForbiddenException('Véhicule hors de votre flotte');

    await this.validerDepot(entree.depotUserId, fleetId);
    await this.validerConducteur(entree.driverId, fleetId);
    await this.refuserSiCreneauOccupe(entree.vehicleId, vehicule.plate, start, end);

    // Les arrêts, VALIDÉS AVANT toute écriture — et les deux libellés recalculés
    // depuis eux quand ils sont là (§ 4.1 : les arrêts sont la source de vérité, les
    // libellés en sont le résumé).
    const arrets = this.validerArretsMission(entree.stops);
    const originLabel = arrets ? arrets[0].label : entree.originLabel;
    const destLabel = arrets ? arrets[arrets.length - 1].label : entree.destLabel;

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
          originLabel,
          destLabel,
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

      // A6 / T8 — les arrêts, DANS LA MÊME TRANSACTION que la mission. Une mission
      // écrite sans ses arrêts serait un trajet amputé que rien ne rattraperait : le
      // dépôt lirait « Fenouillet → Muret » sur une tournée à quatre points.
      if (arrets) {
        await tx.missionStop.createMany({
          data: arrets.map((a, i) => ({
            missionId: creee.id,
            position: i,
            // Exactement UN chargement, en position 0 (arbitrage B). Le reste est
            // livraison, y compris un retour au dépôt — jamais ajouté d'office.
            kind: i === 0 ? MissionStopKind.PICKUP : MissionStopKind.DROPOFF,
            label: a.label,
            placeId: a.placeId ?? null,
            wantedAt: a.wantedAt ? new Date(a.wantedAt) : null,
            note: a.note ?? null,
          })),
        });
      }

      // EFFET 1 — l'evenement d'agenda. Dans la MEME transaction : une mission sans
      // son evenement laisserait le vehicule reservable pendant son creneau.
      await tx.vehicleEvent.create({
        data: {
          fleetId,
          vehicleId: entree.vehicleId,
          type: VehicleEventType.MISSION,
          status: VehicleEventStatus.PLANNED,
          title: `Mission ${ref} · ${originLabel} → ${destLabel}`,
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
    if (entree.depotUserId && reglages.notifierDepot !== false) {
      void this.notifierDepot(entree.depotUserId, {
        ref: mission.ref,
        origin: originLabel,
        destination: destLabel,
        startAt: start,
        endAt: end,
        plate: vehicule.plate,
      });
    }

    return { mission, avertissements };
  }

  /**
   * La liste des missions de la flotte, avec ses 5 compteurs (A2 § 6).
   *
   * Les compteurs sont calcules COTE SERVEUR, en une passe sur le meme jeu de lignes :
   * les recalculer cote client obligerait a servir toutes les missions de la flotte
   * pour afficher cinq nombres.
   */
  async lister(
    user: AuthUser,
    filtres: {
      status?: MissionStatus;
      depotUserId?: string;
      from?: Date;
      to?: Date;
      fleetId?: string;
    },
  ): Promise<{ missions: MissionListeDto[]; compteurs: CompteursMissions }> {
    // `undefined` = SUPER_ADMIN sur « Toutes les sociétés » : aucune borne de flotte.
    const fleetId = this.porteeLecture(user, filtres.fleetId);

    const lignes = await this.prisma.mission.findMany({
      where: {
        ...(fleetId ? { fleetId } : {}),
        ...(filtres.status ? { status: filtres.status } : {}),
        ...(filtres.depotUserId ? { depotUserId: filtres.depotUserId } : {}),
        ...(filtres.from ? { startAt: { gte: filtres.from } } : {}),
        ...(filtres.to ? { endAt: { lte: filtres.to } } : {}),
      },
      select: {
        id: true,
        ref: true,
        originLabel: true,
        destLabel: true,
        startAt: true,
        endAt: true,
        status: true,
        vehicleId: true,
        vehicle: { select: { plate: true } },
        driver: { select: { firstName: true, lastName: true } },
        depotUser: { select: { id: true, firstName: true, lastName: true, email: true } },
        // A6 / T8 — LES LIBELLÉS SEULS, jamais les coordonnées. Cette liste alimente un
        // tableau, pas une carte : servir des lat/lng ici les exposerait sur un chemin
        // qui n'en a aucun usage.
        stops: { select: { label: true }, orderBy: { position: 'asc' } },
      },
      orderBy: [{ startAt: 'desc' }],
      take: 500,
    });

    const missions = lignes.map((m) => ({
      id: m.id,
      ref: m.ref,
      origin: m.originLabel,
      destination: m.destLabel,
      // Vide pour toute mission créée avant T8, et pour toute mission point à point :
      // l'écran retombe alors sur `origin → destination`, exactement comme avant.
      stops: m.stops.map((s) => s.label),
      startAt: m.startAt.toISOString(),
      endAt: m.endAt.toISOString(),
      status: m.status,
      plate: m.vehicle.plate,
      driverName: m.driver ? `${m.driver.firstName} ${m.driver.lastName}`.trim() : null,
      depotId: m.depotUser?.id ?? null,
      depotName: m.depotUser
        ? `${m.depotUser.firstName ?? ''} ${m.depotUser.lastName ?? ''}`.trim() || m.depotUser.email
        : null,
    }));

    return { missions, compteurs: this.compter(lignes) };
  }

  /**
   * La mission EN COURS de ce vehicule, s'il y en a une. Alimente le bandeau
   * « en mission » de la fiche vehicule (A2 § 9).
   *
   * Pourquoi un bandeau : un gestionnaire qui ouvre une fiche pour couper le moteur
   * ou changer un horaire doit savoir qu'un tiers regarde ce camion en ce moment.
   * Sans cette mention, il agit a l'aveugle sur un vehicule sous observation.
   */
  async missionEnCours(
    user: AuthUser,
    vehicleId: string,
    fleetIdDemande?: string,
  ): Promise<MissionEnCoursDto | null> {
    const fleetId = this.porteeLecture(user, fleetIdDemande);
    const maintenant = new Date();
    const m = await this.prisma.mission.findFirst({
      where: {
        ...(fleetId ? { fleetId } : {}),
        vehicleId,
        status: { in: [MissionStatus.IN_PROGRESS, MissionStatus.LATE] },
        startAt: { lte: maintenant },
      },
      select: {
        id: true, ref: true, originLabel: true, destLabel: true,
        startAt: true, endAt: true, status: true,
        depotUser: { select: { firstName: true, lastName: true, email: true } },
      },
      orderBy: { startAt: 'desc' },
    });
    if (!m) return null;

    return {
      id: m.id,
      ref: m.ref,
      origin: m.originLabel,
      destination: m.destLabel,
      startAt: m.startAt.toISOString(),
      endAt: m.endAt.toISOString(),
      status: m.status,
      depotName: m.depotUser
        ? `${m.depotUser.firstName ?? ''} ${m.depotUser.lastName ?? ''}`.trim() || m.depotUser.email
        : null,
      /** Un tiers suit-il la position en ce moment ? Le bandeau doit le dire. */
      depotWatching: m.depotUser !== null,
    };
  }

  /**
   * Le nombre de missions EN COURS par compte depot, pour la colonne « Perimetre »
   * de la liste des utilisateurs (A5 § 3).
   *
   * Un `groupBy` plutot qu'une requete par depot : la liste peut porter dix comptes,
   * et dix requetes pour dix nombres est exactement le N+1 que ce VPS ne pardonne pas.
   */
  async activiteDesDepots(
    user: AuthUser,
    fleetIdDemande?: string,
  ): Promise<Record<string, number>> {
    const fleetId = this.porteeLecture(user, fleetIdDemande);
    const maintenant = new Date();
    const lignes = await this.prisma.mission.groupBy({
      by: ['depotUserId'],
      where: {
        ...(fleetId ? { fleetId } : {}),
        depotUserId: { not: null },
        status: { in: [MissionStatus.IN_PROGRESS, MissionStatus.LATE] },
        startAt: { lte: maintenant },
      },
      _count: { _all: true },
    });

    const out: Record<string, number> = {};
    for (const l of lignes) {
      if (l.depotUserId) out[l.depotUserId] = l._count._all;
    }
    return out;
  }

  /**
   * Les comptes DEPOT de la flotte, pour le selecteur de destinataire.
   *
   * Portee d'ECRITURE, bien que ce soit une lecture : ce selecteur alimente un
   * formulaire de creation. Servir les depots de toutes les societes a un
   * SUPER_ADMIN sans selection lui ferait choisir un destinataire que
   * `validerDepot` refusera ensuite — « le destinataire doit etre un compte depot
   * de votre flotte ». Autant le dire tout de suite, et au bon endroit.
   */
  async listerDepots(
    user: AuthUser,
    fleetIdDemande?: string,
  ): Promise<Array<{ id: string; nom: string }>> {
    const fleetId = this.porteeEcriture(user, fleetIdDemande);
    const depots = await this.prisma.user.findMany({
      where: { fleetId, role: UserRole.DEPOT, isActive: true },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: { firstName: 'asc' },
    });
    return depots.map((d) => ({
      id: d.id,
      nom: `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim() || d.email,
    }));
  }

  /**
   * Les vehicules de la flotte sur un creneau, AVEC leur motif d'occupation.
   *
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ On renvoie TOUS les vehicules, occupes compris — pas seulement les libres. │
   * └───────────────────────────────────────────────────────────────────────────┘
   *
   * A2 § 4, niveau 1 : « le vehicule apparait GRISE avec son motif : Deja en mission
   * M-2482 · 09:00 → 12:20 ». Masquer les occupes ferait disparaitre le camion que le
   * gestionnaire cherchait, sans lui dire pourquoi — et il rouvrirait le formulaire
   * cinq fois. Le motif transforme une absence inexplicable en information.
   */
  async disponibiliteVehicules(
    user: AuthUser,
    startAt: Date,
    endAt: Date,
    fleetIdDemande?: string,
  ): Promise<VehiculeDisponibiliteDto[]> {
    // Portee d'ECRITURE : ce sont les vehicules PROPOSES a la creation. Melanger
    // ceux de plusieurs societes produirait un choix que `creer` refuserait.
    const fleetId = this.porteeEcriture(user, fleetIdDemande);

    const [vehicules, missionsOccupantes] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { fleetId },
        select: { id: true, plate: true, brand: true, model: true },
        orderBy: { plate: 'asc' },
        take: 2000,
      }),
      this.prisma.mission.findMany({
        where: {
          fleetId,
          status: { in: STATUTS_OCCUPANTS },
          startAt: { lt: endAt },
          endAt: { gt: startAt },
        },
        select: { vehicleId: true, ref: true, startAt: true, endAt: true },
      }),
    ]);

    const parVehicule = new Map(missionsOccupantes.map((m) => [m.vehicleId, m]));
    const h = (d: Date) =>
      d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

    const base = vehicules.map((v) => {
      const occupe = parVehicule.get(v.id);
      return {
        id: v.id,
        plate: v.plate,
        label: [v.brand, v.model].filter(Boolean).join(' ') || null,
        available: !occupe,
        // Le motif est REDIGE cote serveur : il doit etre identique partout, et le
        // client n'a pas a savoir formater une reference de mission.
        reason: occupe
          ? `Déjà en mission ${occupe.ref} · ${h(occupe.startAt)} → ${h(occupe.endAt)}`
          : null,
        nextFreeAt: null as string | null,
      };
    });

    // ── NIVEAU 2 (A2 § 4) — aucun vehicule libre ────────────────────────────
    //
    // On ne calcule le prochain creneau QUE dans ce cas. Tant qu'il reste un camion
    // disponible, le gestionnaire en choisit un autre et la question ne se pose pas :
    // calculer pour rien couterait une requete par vehicule a chaque frappe.
    //
    // « Un gestionnaire qui recoit "aucun vehicule disponible" sans alternative
    //   rouvre le formulaire cinq fois. » On propose une sortie.
    const aucunLibre = base.length > 0 && base.every((v) => !v.available);
    if (aucunLibre) {
      const duree = endAt.getTime() - startAt.getTime();
      for (const v of base) {
        const libre = await this.prochainCreneauLibre(v.id, startAt, duree);
        v.nextFreeAt = libre ? libre.toISOString() : null;
      }
    }

    return base;
  }

  /**
   * Le prochain instant ou CE vehicule est libre pendant `dureeMs`, à partir de `depuis`.
   *
   * On avance de mission en mission : chaque fois que le creneau candidat chevauche une
   * mission, on le repousse a la fin de celle-ci. La premiere position qui tient est la
   * bonne — les missions etant triees, on ne revient jamais en arriere.
   *
   * Renvoie `null` au-dela de l'horizon : proposer « libre dans 4 mois » n'aide personne,
   * et laisse croire a un calcul utile.
   */
  private async prochainCreneauLibre(
    vehicleId: string,
    depuis: Date,
    dureeMs: number,
  ): Promise<Date | null> {
    const HORIZON_MS = 14 * 24 * 3600_000;
    const limite = depuis.getTime() + HORIZON_MS;

    const missions = await this.prisma.mission.findMany({
      where: {
        vehicleId,
        status: { in: STATUTS_OCCUPANTS },
        endAt: { gt: depuis },
        startAt: { lt: new Date(limite) },
      },
      select: { startAt: true, endAt: true },
      orderBy: { startAt: 'asc' },
    });

    let candidat = depuis.getTime();
    for (const m of missions) {
      // Le creneau candidat tient-il AVANT cette mission ?
      if (candidat + dureeMs <= m.startAt.getTime()) return new Date(candidat);
      // Sinon il chevauche : on le repousse a la fin de la mission.
      candidat = Math.max(candidat, m.endAt.getTime());
      if (candidat > limite) return null;
    }
    return candidat <= limite ? new Date(candidat) : null;
  }

  /**
   * Les 5 compteurs d'A2 § 6.
   *
   * « Vehicules indisponibles » est le lien avec l'effet 2 : il rend VISIBLE le cout
   * des missions sur la disponibilite de la flotte. Un gestionnaire qui ne voit pas ce
   * chiffre ne comprend pas pourquoi il ne lui reste plus rien a reserver.
   *
   * Il compte les vehicules DISTINCTS, pas les missions : trois missions sur le meme
   * camion n'immobilisent qu'un camion.
   */
  private compter(
    lignes: Array<{ status: MissionStatus; vehicleId: string; depotUser: { id: string } | null }>,
  ): CompteursMissions {
    const vehiculesOccupes = new Set<string>();
    const depots = new Set<string>();
    let enCours = 0;
    let planifiees = 0;
    let enRetard = 0;

    for (const l of lignes) {
      if (l.status === MissionStatus.IN_PROGRESS) enCours++;
      if (l.status === MissionStatus.PLANNED) planifiees++;
      if (l.status === MissionStatus.LATE) enRetard++;
      if (STATUTS_OCCUPANTS.includes(l.status)) vehiculesOccupes.add(l.vehicleId);
      if (l.depotUser) depots.add(l.depotUser.id);
    }

    return {
      enCours,
      planifiees,
      enRetard,
      vehiculesIndisponibles: vehiculesOccupes.size,
      depotsDestinataires: depots.size,
    };
  }

  /**
   * Modifier une mission. Trois regimes selon le statut (A2 § 6).
   *
   *   PLANNED      entierement modifiable
   *   IN_PROGRESS  seuls endAt, le conducteur et les notes
   *   LATE         idem IN_PROGRESS — la mission court encore
   *   DONE         les notes seulement
   *   CANCELLED    rien
   *
   * ⚠️ Un champ interdit est REFUSE, jamais ignore en silence. Ignorer laisserait
   * l'interface afficher une valeur que le serveur n'a pas ecrite : le gestionnaire
   * croirait avoir change le vehicule d'une mission en cours, et decouvrirait le
   * contraire en rouvrant la fiche.
   */
  async modifier(
    user: AuthUser,
    missionId: string,
    modifs: ModifierMissionEntree,
    // ⚠️ PARAMETRE, et non un champ de `ModifierMissionEntree` : `ChampModifiable`
    // derive de cette interface, et le controle des champs autorises par statut
    // rejetterait `fleetId` comme une modification interdite. Ce n'est pas une
    // valeur qu'on modifie, c'est la societe dans laquelle on cherche la mission.
    fleetIdDemande?: string,
  ): Promise<{ impactFenetre: ImpactFenetre | null }> {
    const portee = this.porteeLecture(user, fleetIdDemande);
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, ...(portee ? { fleetId: portee } : {}) },
      select: {
        id: true, ref: true, status: true, startAt: true, endAt: true, fleetId: true,
        vehicleId: true, depotUserId: true, vehicle: { select: { plate: true } },
      },
    });
    if (!mission) throw new ForbiddenException('Mission hors de votre flotte');
    // ⚠️ A partir d'ici, la flotte de reference est CELLE DE LA MISSION — jamais la
    // portee, qui peut valoir `undefined` pour un super-admin sans societe choisie.
    // Un `fleetId: undefined` dans un `where` Prisma SUPPRIME le filtre : les trois
    // validations qui suivent (vehicule, depot, conducteur) accepteraient alors des
    // ressources d'une AUTRE societe. C'est le fail-open que tenant-scope.ts decrit.
    const fleetId = mission.fleetId;

    const autorises = CHAMPS_MODIFIABLES[mission.status];
    const demandes = Object.keys(modifs).filter(
      (k) => modifs[k as keyof ModifierMissionEntree] !== undefined,
    );
    const refuses = demandes.filter((c) => !autorises.includes(c as ChampModifiable));
    if (refuses.length > 0) {
      throw new BadRequestException(
        `Sur une mission ${LIBELLE_STATUT[mission.status]}, ces champs ne sont pas modifiables : ${refuses.join(', ')}`,
      );
    }
    if (demandes.length === 0) return { impactFenetre: null };

    // Le creneau bouge : il faut re-verifier le conflit ET synchroniser l'agenda.
    const nouveauDebut = modifs.startAt ? new Date(modifs.startAt) : mission.startAt;
    const nouvelleFin = modifs.endAt ? new Date(modifs.endAt) : mission.endAt;
    const creneauBouge =
      nouveauDebut.getTime() !== mission.startAt.getTime() ||
      nouvelleFin.getTime() !== mission.endAt.getTime();

    if (creneauBouge) {
      this.validerCreneau(nouveauDebut.toISOString(), nouvelleFin.toISOString());
      await this.refuserSiCreneauOccupe(
        mission.vehicleId,
        mission.vehicle.plate,
        nouveauDebut,
        nouvelleFin,
        mission.id, // s'exclure soi-meme, sinon toute mission serait en conflit avec elle-meme
      );
    }

    if (modifs.vehicleId && modifs.vehicleId !== mission.vehicleId) {
      const v = await this.prisma.vehicle.findFirst({
        where: { id: modifs.vehicleId, fleetId },
        select: { id: true, plate: true },
      });
      if (!v) throw new ForbiddenException('Véhicule hors de votre flotte');
      await this.refuserSiCreneauOccupe(v.id, v.plate, nouveauDebut, nouvelleFin, mission.id);
    }
    if (modifs.depotUserId !== undefined) await this.validerDepot(modifs.depotUserId, fleetId);
    if (modifs.driverId !== undefined) await this.validerConducteur(modifs.driverId, fleetId);

    await this.prisma.$transaction(async (tx) => {
      await tx.mission.update({
        where: { id: mission.id },
        data: {
          ...(modifs.originLabel !== undefined ? { originLabel: modifs.originLabel } : {}),
          ...(modifs.destLabel !== undefined ? { destLabel: modifs.destLabel } : {}),
          ...(modifs.startAt !== undefined ? { startAt: nouveauDebut } : {}),
          ...(modifs.endAt !== undefined ? { endAt: nouvelleFin } : {}),
          ...(modifs.vehicleId !== undefined ? { vehicleId: modifs.vehicleId } : {}),
          ...(modifs.driverId !== undefined ? { driverId: modifs.driverId } : {}),
          ...(modifs.depotUserId !== undefined ? { depotUserId: modifs.depotUserId } : {}),
          ...(modifs.notes !== undefined ? { notes: modifs.notes } : {}),
        },
      });

      // L'evenement d'agenda suit le creneau ET le vehicule. Sans cette mise à jour,
      // le camion resterait immobilise sur l'ANCIEN creneau — et libre sur le nouveau.
      if (creneauBouge || modifs.vehicleId) {
        await tx.vehicleEvent.updateMany({
          where: {
            type: VehicleEventType.MISSION,
            metadata: { path: ['missionId'], equals: mission.id },
          },
          data: {
            ...(creneauBouge ? { startAt: nouveauDebut, endAt: nouvelleFin } : {}),
            ...(modifs.vehicleId ? { vehicleId: modifs.vehicleId } : {}),
          },
        });
      }
    });

    this.logger.log(`Mission ${mission.ref} modifiee par ${user.id} : ${demandes.join(', ')}`);
    return { impactFenetre: this.decrireImpact(mission, nouvelleFin) };
  }

  /**
   * Ce que le changement d'heure de fin fait a l'acces du depot.
   *
   * A2 § 6 : « Changer endAt d'une mission en cours ETEND OU REDUIT la fenetre d'acces
   * du depot — le dire dans la confirmation. » Le serveur decrit donc l'impact, plutot
   * que de laisser chaque ecran le recalculer et le formuler a sa facon.
   */
  private decrireImpact(
    mission: { depotUserId: string | null; endAt: Date; status: MissionStatus },
    nouvelleFin: Date,
  ): ImpactFenetre | null {
    if (!mission.depotUserId) return null; // mission interne : aucun tiers concerne
    const ecartMinutes = Math.round((nouvelleFin.getTime() - mission.endAt.getTime()) / 60_000);
    if (ecartMinutes === 0) return null;
    return {
      sens: ecartMinutes > 0 ? 'ETENDUE' : 'REDUITE',
      minutes: Math.abs(ecartMinutes),
      nouvelleFin: nouvelleFin.toISOString(),
    };
  }

  /**
   * Annuler une mission. Le motif est OBLIGATOIRE (A2 § 6).
   *
   * Trois effets : le vehicule est libere, le depot conserve la mission dans son
   * historique avec la mention « Annulee par le transporteur », et l'evenement
   * d'agenda passe en CANCELLED — sans quoi le vehicule resterait bloque.
   */
  async annuler(
    user: AuthUser,
    missionId: string,
    motif: string,
    fleetIdDemande?: string,
  ): Promise<void> {
    const portee = this.porteeLecture(user, fleetIdDemande);
    const propre = (motif ?? '').trim();
    if (propre.length < 3) {
      // Un motif vide rendrait la mention « Annulee par le transporteur » muette pour
      // le depot, qui rappellerait pour demander pourquoi.
      throw new BadRequestException("Un motif d'annulation est obligatoire");
    }

    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, ...(portee ? { fleetId: portee } : {}) },
      select: { id: true, ref: true, status: true },
    });
    if (!mission) throw new ForbiddenException('Mission hors de votre flotte');
    if (mission.status === MissionStatus.DONE || mission.status === MissionStatus.CANCELLED) {
      throw new BadRequestException('Cette mission est déjà terminée ou annulée');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.mission.update({
        where: { id: missionId },
        data: {
          status: MissionStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: propre,
        },
      });
      // Libere le vehicule : sans cette mise à jour, l'evenement resterait immobilisant
      // et le camion demeurerait inreservable jusqu'a la fin du creneau annule.
      await tx.vehicleEvent.updateMany({
        where: {
          type: VehicleEventType.MISSION,
          metadata: { path: ['missionId'], equals: missionId },
        },
        data: { status: VehicleEventStatus.CANCELLED },
      });
    });

    // Lot A3 — le depot regarde peut-etre sa carte a cet instant. Le marqueur va
    // disparaitre : on le lui DIT, plutot que de le laisser conclure a une panne.
    this.gateway.emitDepotMissionEnded(mission.id, mission.ref);
    // Lot A4 — l'annulation ferme les liens publics de cette mission. Le destinataire
    // lit « cette livraison a ete annulee » pendant quelques minutes, puis le lien
    // meurt : il ne doit pas continuer a attendre un camion qui ne viendra pas.
    await this.partage.fermerLiensDeMission(mission.id, 'CANCELLED');

    this.logger.log(`Mission ${mission.ref} annulee par ${user.id} — motif : ${propre}`);
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
        `Notification dépôt échouée pour la mission ${mission.ref} : ${err instanceof Error ? err.message : err}`,
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
  /**
   * A6 / T8 — les arrêts d'une mission, vérifiés.
   *
   * `undefined` en entrée → `null` en sortie : la mission reste point à point, et
   * absolument rien ne change. C'est le cas de TOUS les appelants qui existaient avant
   * cette version, et il doit rester le chemin le plus court.
   *
   * ⚠️ DEUX ARRÊTS AU MINIMUM, MÊME RÈGLE QUE LA DEMANDE. Un tableau à un seul élément
   * n'est pas un trajet : le laisser passer produirait une mission dont le départ et
   * l'arrivée sont la même adresse, sans que personne l'ait voulu. Un tableau VIDE est
   * refusé pour la même raison — il signale une saisie perdue, pas une intention.
   *
   * Le retour au dépôt est une livraison COMME UNE AUTRE, jamais ajoutée d'office
   * (arbitrage H) : ce service ne complète rien, il vérifie.
   */
  private validerArretsMission(
    stops: ArretMissionEntree[] | undefined,
  ): ArretMissionEntree[] | null {
    if (stops === undefined) return null;
    if (!Array.isArray(stops) || stops.length < 2) {
      throw new BadRequestException(
        'Une mission à arrêts multiples comporte au moins une adresse de chargement et une adresse de livraison.',
      );
    }
    return stops.map((a, i) => {
      const label = (a?.label ?? '').trim();
      if (!label) {
        throw new BadRequestException(`Arrêt ${i + 1} : le libellé est obligatoire.`);
      }
      if (a.wantedAt && Number.isNaN(new Date(a.wantedAt).getTime())) {
        throw new BadRequestException(`Arrêt ${i + 1} : l'horaire souhaité est invalide.`);
      }
      return { ...a, label };
    });
  }

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
      throw new BadRequestException('Le destinataire doit être un compte dépôt de votre flotte');
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

  /**
   * La flotte a laquelle BORNER une lecture. `undefined` = aucune borne.
   *
   * ── Pourquoi ceci a remplace `fleetDe` (2026-08-12) ─────────────────────────────
   * `fleetDe` levait « Aucune flotte associee » des que `user.fleetId` etait nul. Or
   * un SUPER_ADMIN a `fleetId = null` PAR CONSTRUCTION : il n'appartient a aucune
   * societe et choisit la sienne dans le selecteur global (FleetFilterService). Les
   * quatre comptes super-admin de production recevaient donc un 403 sur HUIT des
   * neuf methodes de ce service : l'onglet Missions, le selecteur de depot, le choix
   * du vehicule, la creation, la modification, l'annulation, le bandeau de la fiche
   * vehicule et la colonne « Perimetre » de /users. Toute la fonctionnalite depot
   * leur etait fermee.
   *
   * `requiredFleetScope` est la regle deja appliquee par TOUS les autres endpoints
   * de /agenda ; missions en etait le seul absent. Elle est fail-closed : un
   * non-super-admin sans flotte recoit `NO_FLEET`, une flotte impossible qui ne
   * matche aucune ligne — jamais l'absence de filtre, qui ouvrirait tout.
   */
  private porteeLecture(user: AuthUser, fleetIdDemande?: string): string | undefined {
    return requiredFleetScope(user, fleetIdDemande);
  }

  /**
   * La flotte dans laquelle ECRIRE — ou dont on liste les ressources d'un formulaire
   * de creation (vehicules disponibles, comptes depot).
   *
   * Une ecriture ne peut jamais porter sur « toutes les societes » : il faut une
   * flotte, et une seule. Un SUPER_ADMIN qui n'en a choisi aucune est donc arrete
   * ici, avec le message a suivre — et non par un echec obscur plus loin.
   */
  private porteeEcriture(user: AuthUser, fleetIdDemande?: string | null): string {
    const id = requiredFleetScope(user, fleetIdDemande ?? undefined);
    if (!id) {
      throw new BadRequestException(
        'Sélectionnez une société avant de créer ou modifier une mission.',
      );
    }
    // Non-super-admin sans flotte : le compte est mal provisionné. Le dire tel quel
    // plutôt que de laisser NO_FLEET produire un « véhicule hors de votre flotte ».
    if (id === NO_FLEET) throw new ForbiddenException('Aucune flotte associée à votre compte.');
    return id;
  }
}
