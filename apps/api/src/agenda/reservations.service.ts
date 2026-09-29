import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  ConfirmReservationDto,
  ReorganisationRefusDto,
  ReorganisationResultDto,
  ReorganiserReservationsDto,
  ReaffecterReservationDto,
  RequestReservationDto,
  ReservationGroupDto,
  SuggestReservationResultDto,
  SuggestedVehicleDto,
  UpdateReservationDto,
  VehicleEventDto,
  VehicleEventStatus as VehicleEventStatusDto,
} from '@vizyo/tracky-shared';
import { DORMANT_STOP_COUNTING_MS, effectiveBlockingEndMs, IMMOBILIZING_STATUSES, isVehicleDormant } from '@vizyo/tracky-shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import {
  fourchettePlaces,
  messageAucunVehicule,
  motifPlacesInsuffisantes,
  type AucunVehiculeContexte,
} from './aucun-vehicule.message';
import { ChildSeatsService } from './child-seats.service';
import { VehicleEventsService } from './vehicle-events.service';

type EventRow = Prisma.VehicleEventGetPayload<{ include: { vehicle: { select: { plate: true } } } }>;
const INCLUDE_PLATE = { vehicle: { select: { plate: true } } } as const;

/** Statuts « bloquants » : occupent le véhicule (conflits + disponibilité). */
const BLOCKING: VehicleEventStatus[] = [VehicleEventStatus.CONFIRMED, VehicleEventStatus.IN_PROGRESS];
/** Acteur « système » des réservations créées par l'agent (createdBy = colonne UUID sans FK User). */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
/**
 * Durée d'occupation MAXIMALE supposée d'un trajet encore ouvert (endedAt NULL). Un tel trajet
 * n'a pas de fin connue : on suppose qu'il dure au plus « une journée d'activité ». Il bloque donc
 * les créneaux PROCHES (véhicule qui roule) mais ni les créneaux LOINTAINS (sinon un véhicule qui
 * roule serait injustement injoignable pour la semaine prochaine), ni un trajet fantôme jamais
 * clôturé (au-delà de cette durée = anomalie tracker, ne bloque plus rien).
 */
const MAX_OPEN_TRIP_MS = 8 * 60 * 60 * 1000;
/** Fenêtre récente pour le tri par sous-utilisation (auto-complétion). */
const RECENT_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
const UNDERUTILIZED_RATIO = 0.12;
/**
 * Plafond d'un geste de masse. 500 couvre très largement le cas réel (108 réservations chez
 * cdef31) tout en bornant ce qu'une requête peut écrire d'un coup. Au-delà, le lot est tronqué
 * ET l'écran le dit : un lot silencieusement incomplet serait pire qu'un refus franc.
 */
const MAX_REORGANISATION = 500;
/**
 * Revue du 29/09 (C4/C43) — une réservation NE CHANGE PAS de société. Un super-admin en « Toutes
 * les sociétés » se voyait proposer les plaques de tous les clients : réaffecter une réservation de
 * cdef31 sur un véhicule de Client test la faisait passer dans l'agenda de Client test, avec son
 * groupe et le contact du demandeur public. Refusé partout où le véhicule peut changer.
 */
const AUTRE_SOCIETE = 'Ce véhicule appartient à une autre société : une réservation ne change pas de société.';
/** D1 / R1 — le véhicule visé est dans un groupe où l'appelant ne peut que DEMANDER. */
const MESSAGE_CIBLE_NON_GEREE = 'Vous ne gérez pas les réservations du véhicule visé : vous ne pouvez rien y poser.';

/**
 * Options INTERNES d'une écriture — jamais exposées par un contrôleur (qui n'en passe aucune).
 * `silencieux` (contre-revue du 29/09, R3) : ne pas prévenir le demandeur public ligne par ligne ;
 * l'appelant (la réorganisation) écrit UNE fois par demande groupée, après la boucle.
 */
interface OptionsInternes {
  silencieux?: boolean;
  /**
   * Journal (29/09) — POURQUOI `update()` est appelé, quand ce n'est pas la feuille d'édition : il
   * choisit la ligne écrite (« réaffectée » pour `reaffecter`, « décalée » pour Réorganiser → Décaler)
   * au lieu d'un « modifiée » générique qui ne dirait pas le geste.
   */
  motif?: 'reaffectation' | 'decalage';
  /**
   * Journal — identifiant d'un geste de MASSE (`reorganiser`) : porté par chaque ligne unitaire ET par
   * les résumés, pour relire « ce lot-là » d'un seul filtre.
   */
  lot?: string;
}

/** Les codes d'action que ce service écrit (sous-ensemble de AGENDA_ACTIVITY_ACTION_LABELS). */
type ActionJournal =
  | 'reservation_demandee'
  | 'reservation_creee'
  | 'reservation_consignee'
  | 'reservation_validee'
  | 'reservation_refusee'
  | 'reservation_retiree'
  | 'reservation_annulee'
  | 'reservation_modifiee'
  | 'reservation_reaffectee'
  | 'reservation_decalee'
  | 'reservation_scindee'
  | 'reservations_reorganisees';

/** Une ligne du journal métier, telle que la construit l'appelant (cf. `journaliser`). */
interface EntreeJournal {
  /** Société de la RESSOURCE (réservation, véhicule) — jamais celle de l'utilisateur. */
  fleetId: string | null;
  /** La plaque concernée (`target`). */
  plaque?: string | null;
  /** Lisible, dates en heure de Paris (jamais un ISO en UTC). */
  detail: string;
  meta?: Record<string, unknown>;
  status?: 'SUCCESS' | 'SKIPPED';
}

/**
 * ── LES DATES DU JOURNAL SONT EN HEURE DE PARIS ──────────────────────────────────────────────
 * Le détail est lu par un gestionnaire, pas par une machine : « 2026-10-01T08:00:00.000Z » pour une
 * sortie à 10:00 le faisait chercher deux heures trop tôt. `meta` garde les ISO pour les outils.
 */
const FMT_JOUR = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' });
const FMT_HEURE = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function enDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** « 01/10/2026 10:00 » (Europe/Paris). */
function heureParis(d: Date | string | null | undefined): string {
  const date = enDate(d);
  return date ? `${FMT_JOUR.format(date)} ${FMT_HEURE.format(date)}` : '—';
}

/** « 01/10/2026 10:00 → 12:00 », ou « 01/10/2026 10:00 → 02/10/2026 18:00 » sur deux jours. */
function creneauParis(debut: Date | string | null | undefined, fin: Date | string | null | undefined): string {
  const a = enDate(debut);
  const b = enDate(fin);
  if (!a) return '—';
  if (!b) return `à partir du ${heureParis(a)}`;
  return FMT_JOUR.format(a) === FMT_JOUR.format(b)
    ? `${heureParis(a)} → ${FMT_HEURE.format(b)}`
    : `${heureParis(a)} → ${heureParis(b)}`;
}

/** Ce qu'une écriture de `update()` a changé, champ par champ (cf. `changementsDe`). */
interface Changements {
  vehicule?: { avant: string; apres: string };
  creneau?: { avant: { debut: Date; fin: Date | null }; apres: { debut: Date; fin: Date | null } };
  titre?: { avant: string; apres: string };
  motif?: { avant: string | null; apres: string | null };
  groupe?: { avant: ReservationGroupDto | null; apres: ReservationGroupDto | null };
  criteres?: { avant: RequestReservationDto['criteria'] | null; apres: RequestReservationDto['criteria'] | null };
}

/**
 * « 12 places » — les véhicules libres sur le créneau quelle que soit leur taille, tels que la demande
 * les relit : ce que lit le constructeur partagé (nombre, fourchette), plus la SOMME des places connues
 * et le nombre de libres sans places renseignées (relecture du 29/09 : « répartissez » seulement si
 * c'est possible).
 */
type LibresToutesTailles = NonNullable<AucunVehiculeContexte['libresToutesTailles']> & {
  places: number;
  inconnues: number;
  /**
   * Revue du 29/09 (C6) — les SIÈGES AUTO demandés, jugés sur ces mêmes libres (relus SANS eux). Null =
   * aucun siège demandé, ou disponibilité inconnue (société non résolue) : rien à en dire.
   *  - `porteurs` : les plaques des libres qui peuvent recevoir, À EUX SEULS, tous les sièges demandés
   *    (à bord + stock, selon la politique) — la feuille les met sur UNE réservation de la répartition ;
   *  - `combinables` : les libres, ensemble, peuvent-ils les recevoir (sièges répartis entre plusieurs
   *    réservations) ? Faux = aucun partage ne les assoit, même en répartissant le groupe.
   */
  sieges: { porteurs: string[]; combinables: boolean } | null;
};

/** « 12 places min., 1 siège(s) bébé » — les critères, lisibles. */
function decrireCriteres(c: RequestReservationDto['criteria'] | null | undefined): string {
  if (!c) return 'aucun';
  const p: string[] = [];
  if (c.minSeats) p.push(`${c.minSeats} places min.`);
  if (c.childSeatsBaby) p.push(`${c.childSeatsBaby} siège(s) bébé`);
  if (c.childSeatsChild) p.push(`${c.childSeatsChild} siège(s) enfant`);
  if (c.requiredFeatures?.length) p.push(c.requiredFeatures.join(', '));
  return p.length > 0 ? p.join(', ') : 'aucun';
}

/** Un texte libre cité dans le détail : court, entre guillemets, « — » s'il est vide. */
function cite(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? `« ${s.length > 60 ? `${s.slice(0, 59)}…` : s} »` : '—';
}

/** Début de la minute en cours : le point de coupe d'une réservation scindée (l'écran raisonne à la minute). */
function debutDeMinute(ms: number): Date {
  return new Date(Math.floor(ms / 60_000) * 60_000);
}

/**
 * Une demande jamais validée n'a pas de « suite » ferme à reprendre : elle se valide ou se refuse.
 * UNE règle, lue par `reaffecter()` (qui refuse) et par `reorganiser()` (qui l'annonce dès la
 * simulation — troisième relecture du 29/09, T4 : l'écran annonçait « scindée » une demande que
 * l'application refusait à coup sûr). Renvoie le motif du refus, ou null si la demande se réaffecte.
 */
function motifDemandeNonReaffectable(status: string, debutMs: number, maintenant: number, coupeMs: number): string | null {
  if (status !== VehicleEventStatus.REQUESTED) return null;
  if (debutMs < maintenant) {
    return 'Cette demande a déjà commencé sans avoir été validée : validez-la ou refusez-la, elle ne se réaffecte pas.';
  }
  if (debutMs < coupeMs) {
    return 'Cette demande n’a pas été validée et déborde sur l’indisponibilité du véhicule : validez-la ou refusez-la, elle ne se réaffecte pas.';
  }
  return null;
}

/**
 * L'AUTEUR d'une demande encore en attente la retire lui-même (revue du 29/09, C4). Une seule règle,
 * lue par `cancel()` (droit : on reprend ce qu'on a déposé, sans gérer le véhicule ; journal :
 * `reservation_retiree`, jamais « Demande refusée ») et par `reorganiser()` (aucune annonce de refus).
 * `requesterId` n'est posé que par `request()` (demande interne) : une demande publique n'est jamais
 * un retrait — son demandeur n'a pas de compte.
 */
function estRetraitDeSaDemande(status: string, metadata: unknown, userId: string): boolean {
  const auteur = (metadata as { requesterId?: unknown } | null | undefined)?.requesterId;
  return status === VehicleEventStatus.REQUESTED && typeof auteur === 'string' && auteur === userId;
}

/**
 * Même minute ? L'écran tronque les heures à la minute : une réservation posée par le lien public ou
 * par l'agent porte des secondes, et la renvoyer telle qu'affichée ne doit pas passer pour un
 * déplacement (revue du 29/09, C44).
 */
function memeMinute(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
}

/**
 * D'où vient une réservation — ce que « Réorganiser » entend par « posée par l'agent ».
 *
 * ⚠️ `source === 'SYSTEM'` ne suffisait pas : le flux PUBLIC (`systemRequest`) écrit lui aussi
 * SYSTEM, si bien qu'une demande déposée par un conducteur via le lien public, puis validée par le
 * standard, passait pour une réservation de l'agent — et « Posées par l'agent → Tout annuler »
 * l'aurait annulée avec les autres. Mesuré le 28/09 sur la démo : « GD-057-AG · agent » sur une
 * demande publique. Chez un client où l'agent ne réserve rien (autonomie « suggestions »), les
 * SYSTEM sont même EXCLUSIVEMENT des demandes publiques et des propositions appliquées à la main.
 *
 * La demande publique se reconnaît à `metadata.public` (posé par `reservation-booking.service`).
 */
function origineReservation(e: { source: string; metadata?: unknown }): 'agent' | 'public' | 'manuelle' {
  if (e.source !== 'SYSTEM') return 'manuelle';
  const meta = e.metadata as { public?: unknown } | null | undefined;
  return meta?.public === true ? 'public' : 'agent';
}

/**
 * Sprint 8 (Palier B) — Réservations de véhicules sur le modèle d'événement S7
 * (type=RESERVATION). Flux Demande → validation, scoping tenant STRICT (anti-IDOR,
 * chaîne S5), conflits gérés (pré-check 409 + contrainte EXCLUDE race-proof). La
 * prévision (S8 Palier C) reste dérivée et ne compte JAMAIS comme bloquante ici.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly events: VehicleEventsService,
    private readonly permissions: PermissionsResolverService,
    // EventEmitter2 global : injecté en prod, omis dans les specs. Déclenche l'agent sur une
    // réservation HUMAINE uniquement (jamais depuis systemConfirm/systemRequest → anti-boucle).
    private readonly emitter?: EventEmitter2,
    /**
     * Journal d'activité (@Global) : chaque geste sur une réservation (demande, création, validation,
     * refus, annulation, modification, réaffectation, scission, réorganisation) — cf. `journaliser`.
     * `@Optional()` : les specs montent ce service à la main, et un journal absent ne doit jamais
     * empêcher un geste d'aboutir.
     */
    @Optional() private readonly systemActivity?: SystemActivityService,
    /**
     * Sièges auto (2026-09-28) : le STOCK de la société borne les réservations qui en demandent.
     * `@Optional()` pour les specs montées à la main ; en production il est toujours là (même
     * module). Sans lui, aucun contrôle de sièges — ce que les specs historiques attendent.
     */
    @Optional() private readonly childSeats?: ChildSeatsService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private parseSlot(startAt: string, endAt: string): { start: Date; end: Date } {
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Créneau invalide (dates ISO requises).');
    }
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException('La fin du créneau doit être après le début.');
    }
    return { start, end };
  }

  /**
   * Coerce des critères (corps non typé à l'exécution) en valeurs sûres pour les requêtes.
   * Les sièges auto n'y sont plus : ce n'est pas un filtre de VÉHICULE mais un besoin pris sur le
   * stock de la société (`ChildSeatsService.needOf`), vérifié à part.
   */
  private sanitizeCriteria(
    c: RequestReservationDto['criteria'] | undefined,
  ): { minSeats?: number; requiredFeatures?: string[] } {
    if (!c || typeof c !== 'object') return {};
    const minSeats = Number((c as { minSeats?: unknown }).minSeats);
    const rf = Array.isArray(c.requiredFeatures)
      ? c.requiredFeatures.filter((x): x is string => typeof x === 'string')
      : undefined;
    return {
      minSeats: Number.isFinite(minSeats) && minSeats > 0 ? Math.floor(minSeats) : undefined,
      requiredFeatures: rf && rf.length > 0 ? rf : undefined,
    };
  }

  /** Le `bookingRef` d'une demande groupée (lien public), sinon null. */
  private bookingRefOf(metadata: unknown): string | null {
    const ref = (metadata as { bookingRef?: unknown } | null | undefined)?.bookingRef;
    return typeof ref === 'string' && ref ? ref : null;
  }

  // ─── Groupe de réservation (refonte UX du 28/09, point 9) ─────────────────────────────────
  //
  // « Groupe du véhicule ≠ groupe de la réservation. » Le véhicule garde le sien ; la réservation
  // porte celui qui s'en SERT (`metadata.group`). Par défaut, c'est le groupe du véhicule au moment
  // où le véhicule est fixé — et ce défaut ne se recalcule pas quand on change de véhicule à
  // l'édition : c'est l'utilisateur, pas le propriétaire, qu'on a écrit.

  /**
   * Nettoie un groupe reçu du client. Un `id` doit être un groupe de LA société (sinon 400 : on ne
   * range pas une réservation sous le groupe d'un autre client) ; son nom est relu en base, jamais
   * pris tel quel. Sans `id`, un nom libre (≤ 60 caractères). Vide = aucun groupe.
   */
  private async groupePropre(fleetId: string, input: unknown): Promise<ReservationGroupDto | null> {
    if (!input || typeof input !== 'object') return null;
    const brut = input as { id?: unknown; name?: unknown };
    const id = typeof brut.id === 'string' && brut.id.trim() ? brut.id.trim() : null;
    const name = typeof brut.name === 'string' ? brut.name.trim().slice(0, 60) : '';
    if (id) {
      const groupe = await this.prisma.vehicleGroup.findFirst({ where: { id, fleetId }, select: { id: true, name: true } });
      if (!groupe) throw new BadRequestException('Groupe inconnu dans cette société.');
      return { id: groupe.id, name: groupe.name };
    }
    return name ? { id: null, name } : null;
  }

  /** Le groupe (unique, cf. VehiclesService.withGroup) d'un véhicule, ou null. */
  private async groupeDuVehicule(vehicleId: string): Promise<ReservationGroupDto | null> {
    const lien = await this.prisma.vehicleGroupAssignment.findFirst({
      where: { vehicleId },
      select: { group: { select: { id: true, name: true } } },
      orderBy: { group: { name: 'asc' } },
    });
    return lien?.group ? { id: lien.group.id, name: lien.group.name } : null;
  }

  /** Le groupe déjà posé sur une réservation (`metadata.group`), s'il est lisible. */
  static groupeDe(metadata: unknown): ReservationGroupDto | null {
    const g = (metadata as { group?: unknown } | null | undefined)?.group;
    if (!g || typeof g !== 'object') return null;
    const { id, name } = g as { id?: unknown; name?: unknown };
    if (typeof name !== 'string' || !name.trim()) return null;
    return { id: typeof id === 'string' && id ? id : null, name: name.trim() };
  }

  /**
   * HORS SERVICE — le garde qui manquait sur le chemin EXPLICITE (2026-09-28, « check de tout »).
   *
   * `computeSuggestions` écarte les hors-service du vivier et `isVehicleFree` les refuse à l'agent ;
   * mais un humain qui CHOISIT le véhicule (feuille de réservation, validation avec réaffectation,
   * édition) passait à côté des deux : une voiture déclarée accidentée par un super-admin pouvait
   * être réservée fermement, et le conducteur découvrait l'accident à la remise des clés.
   * Le motif est DÉCLARÉ (pas déduit) : aucun délai, aucun doute — on refuse, en le nommant.
   * Jamais en rétroactif : consigner une sortie passée ne promet rien.
   */
  private async assertEnService(vehicleId: string): Promise<void> {
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { outOfServiceReason: true, plate: true },
    });
    if (!v?.outOfServiceReason) return;
    const motif =
      v.outOfServiceReason === 'ACCIDENT' ? 'accidenté'
        : v.outOfServiceReason === 'TRACKER_UNPLUGGED' ? 'boîtier débranché'
          : 'immobilisé durablement';
    throw new ConflictException(
      `${v.plate ?? 'Ce véhicule'} est déclaré hors service (${motif}) : il ne peut pas être réservé tant qu'il n'est pas remis en service.`,
    );
  }

  /**
   * « 12 places » (29/09) — un véhicule choisi À LA MAIN dont le nombre de places est CONNU et
   * inférieur au plancher saisi (conducteur compris) : 400 qui dit quoi faire. Places inconnues : on ne
   * refuse pas sur une donnée absente (le vivier, lui, les compte à part).
   */
  private async assertAssezDePlaces(vehicleId: string, minSeats: number | undefined): Promise<void> {
    if (!minSeats) return;
    const v = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { seats: true, plate: true } });
    // La phrase est partagée avec l'annonce de `reorganiser()` en simulation (C8) : un seul texte.
    const motif = motifPlacesInsuffisantes(v?.plate, v?.seats, minSeats);
    if (motif) throw new BadRequestException(motif);
  }

  /**
   * Relecture du 29/09 (C8 × T4) — les places d'une cible CHOISIE pour « Réorganiser → Réaffecter »,
   * lues UNE fois pour tout le lot : de quoi annoncer dès la simulation le refus « trop petit » que
   * `reaffecter()` lèvera à coup sûr. Null — donc rien d'annoncé, `reaffecter()` garde le dernier mot —
   * dès que ce refus ne serait PAS le premier que `reaffecter()` rendrait : cible hors périmètre ou
   * introuvable, non gérée, places inconnues. On ne nomme jamais (plaque, places) un véhicule que
   * `reaffecter()` aurait refusé avant d'en parler. La société est rendue : une ligne d'une autre
   * société est refusée par `reaffecter()` (« autre société ») avant les places.
   */
  private async placesDeLaCibleChoisie(
    user: AuthUser,
    vehicleId: string,
  ): Promise<{ fleetId: string; plate: string | null; seats: number } | null> {
    try {
      const fleetId = await this.events.assertVehicleAccess(user, vehicleId);
      if (!(await this.permissions.canOnVehicle(user, vehicleId, 'reservations_manage'))) return null;
      const v = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { seats: true, plate: true } });
      if (typeof v?.seats !== 'number' || v.seats <= 0) return null;
      return { fleetId, plate: v.plate ?? null, seats: v.seats };
    } catch {
      return null; // l'annonce n'est qu'une avance : en cas de doute, l'application tranche ligne par ligne
    }
  }

  /**
   * Ce que `messageAucunVehicule` lit d'un vivier vide (chemins AUTHENTIFIÉS seulement).
   *
   * Relecture du 29/09 — les SIÈGES AUTO passent avant la taille. Le vivier juge les sièges APRÈS le
   * plancher de places et l'occupation : un véhicule écarté pour ses sièges était donc libre ET assez
   * grand. Compter alors les petits véhicules du parc (le 4 places de Client test, ou tout le parc
   * mixte d'une réaffectation, dont le plancher vaut les places du véhicule d'origine) faisait dire au
   * constructeur « aucun véhicule d'au moins 5 places n'est libre sur ce créneau. Aucun véhicule n'est
   * libre, quelle que soit sa taille. » — deux phrases fausses pour 7 véhicules libres à qui il
   * manquait un siège bébé. La taille ne l'emporte que si le parc n'a VRAIMENT aucun véhicule assez
   * grand (`largestSeats < minSeats`, impossible quand des sièges ont écarté quelqu'un — gardé pour un
   * vivier qui ne suivrait pas cet ordre).
   */
  private contexteAucunVehicule(sug: SuggestReservationResultDto, minSeats: number | null): AucunVehiculeContexte {
    const sieges = sug.excludedChildSeats ?? 0;
    const largestSeats = sug.largestSeats ?? null;
    const parcTropPetit = !!minSeats && largestSeats != null && largestSeats < minSeats;
    return {
      minSeats,
      excludedTooSmall: sieges > 0 && !parcTropPetit ? 0 : (sug.excludedTooSmall ?? 0),
      largestSeats,
      excludedUnknownCapacity: sug.excludedUnknownCapacity ?? 0,
      excludedChildSeats: sieges,
      excludedDormant: sug.excludedDormant ?? 0,
    };
  }

  /**
   * « 12 places » — les véhicules libres sur le créneau QUELLE QUE SOIT leur taille : le même vivier
   * (même créneau, même société, mêmes équipements), relu sans `minSeats`. Rend leur nombre, leur
   * fourchette de places et — relecture du 29/09 — la SOMME des places connues et le nombre de libres
   * sans places renseignées : de quoi ne conseiller « répartissez le groupe » que quand c'est possible
   * (cf. `messageDemandeSansVehicule`).
   *
   * Revue du 29/09 (C6) — relu aussi SANS les sièges auto. Dans une répartition, les sièges vont sur
   * UNE réservation (comme dans la feuille) : les garder dans la relecture écartait chaque véhicule qui
   * ne pouvait pas les porter tous, et « 12 places + 1 siège bébé » chez Client test (7 libres, stock
   * vide) répondait « Aucun véhicule n'est libre sur ce créneau, quelle que soit sa taille » — ou, un
   * seul 9 places équipé, « pas assez… même en répartissant » alors que 9 (avec le siège) + 4 = 13.
   * L'information n'est pas perdue : elle est jugée À PART sur ces mêmes libres (`sieges`), sans
   * requête de plus — la disponibilité du créneau (`sug.childSeats`) et les sièges à bord de chaque
   * véhicule (`childSeatsInstalled`) sont rendus même sans besoin.
   * Un échec de relecture n'empêche pas le message : il perd seulement cette phrase.
   */
  private async libresToutesTailles(user: AuthUser, dto: RequestReservationDto): Promise<LibresToutesTailles | null> {
    try {
      const {
        minSeats: _plancher,
        childSeatsBaby: _bebe,
        childSeatsChild: _enfant,
        ...autres
      } = (dto.criteria ?? {}) as NonNullable<RequestReservationDto['criteria']>;
      const sug = await this.suggest(user, { startAt: dto.startAt, endAt: dto.endAt, criteria: autres, fleetId: dto.fleetId });
      const places = sug.vehicles.map((v) => v.seats).filter((s): s is number => typeof s === 'number' && s > 0);
      return {
        n: sug.vehicles.length,
        min: places.length > 0 ? Math.min(...places) : null,
        max: places.length > 0 ? Math.max(...places) : null,
        places: places.reduce((a, b) => a + b, 0),
        inconnues: sug.vehicles.length - places.length,
        sieges: this.siegesDesLibres(sug, ChildSeatsService.needOf(dto.criteria)),
      };
    } catch {
      return null;
    }
  }

  /** C6 — les sièges auto demandés, jugés sur des libres relus sans eux (cf. `LibresToutesTailles.sieges`). */
  private siegesDesLibres(
    sug: SuggestReservationResultDto,
    need: { baby: number; child: number },
  ): LibresToutesTailles['sieges'] {
    const avail = sug.childSeats;
    if ((need.baby <= 0 && need.child <= 0) || !avail) return null;
    const aBord = (v: SuggestedVehicleDto) => v.childSeatsInstalled ?? { baby: 0, child: 0 };
    const porteurs = sug.vehicles
      .filter((v) => ChildSeatsService.couvre(avail, need, aBord(v)))
      .map((v) => v.vehiclePlate ?? 'un véhicule sans plaque');
    // Ensemble : les sièges à bord de TOUS les libres, plus le stock — chaque réservation de la
    // répartition prend d'abord ceux de son véhicule, le stock ne fournit que le reste.
    const sommeABord = sug.vehicles.reduce(
      (s, v) => ({ baby: s.baby + aBord(v).baby, child: s.child + aBord(v).child }),
      { baby: 0, child: 0 },
    );
    return { porteurs, combinables: porteurs.length > 0 || ChildSeatsService.couvre(avail, need, sommeABord) };
  }

  /**
   * Le 400 d'une demande « ouverte » dont le vivier est vide.
   *
   * Relecture du 29/09 — « répartissez le groupe » seulement quand c'est POSSIBLE : au moins deux
   * véhicules libres, dont les places connues couvrent, à elles toutes, le plancher saisi (ou dont une
   * partie n'a pas de places renseignées : on ne conclut pas « pas assez » sur une donnée absente).
   * Demande de 12 places, un seul 9 places libre : le constructeur disait « 1 véhicule est libre
   * (9 places) : répartissez le groupe » — l'exploitant essayait, et échouait. La somme est une
   * condition NÉCESSAIRE (chaque véhicule de plus emporte aussi un conducteur) : « pas assez » est
   * donc toujours vrai, « répartissez » reste une piste.
   *
   * Revue du 29/09 (C6) — les libres sont relus SANS les sièges auto, jugés à part (`libres.sieges`) :
   *  - aucun partage ne les assoit (`combinables` faux) → jamais « répartissez » : la phrase dit les
   *    libres ET que les sièges manquent (installer un siège, changer le réglage) ;
   *  - un seul (ou quelques-uns) des libres peut les recevoir → « répartissez », et la phrase NOMME
   *    celui qui doit porter les sièges ;
   *  - aucun seul, mais ensemble oui → « répartissez » les sièges aussi.
   * « Aucun véhicule n'est libre, quelle que soit sa taille » ne sort donc plus que si RIEN n'est libre.
   *
   * ⚠️ Le constructeur partagé (`messageAucunVehicule`) ne juge pas la faisabilité et ne reçoit pas la
   * somme : le cas « pas assez » est écrit ICI, après sa phrase. Seule la demande relit les libres
   * (ni la réaffectation ni l'IA de placement) : aucune autre surface n'est concernée.
   */
  private messageDemandeSansVehicule(contexte: AucunVehiculeContexte, libres: LibresToutesTailles | null): string {
    const min = contexte.minSeats ?? 0;
    const sieges = libres?.sieges ?? null;
    const siegesImpossibles = !!sieges && !sieges.combinables;
    // Chaque véhicule emporte SON conducteur (revue du 29/09, aligné sur la répartition de la
    // feuille) : N places demandées conducteur compris = N − 1 passagers, et un véhicule de S places
    // en offre S − 1. « 9 + 4 = 13 » ne couvre donc pas 13 places : il y faut 12 passagers, il n'y en a que 11.
    const connus = libres ? libres.n - libres.inconnues : 0;
    const passagersLibres = libres ? libres.places - connus : 0;
    const placesSuffisent = !!libres && libres.n >= 2 && (libres.inconnues > 0 || passagersLibres >= min - 1);
    const repartissable = placesSuffisent && !siegesImpossibles;
    if (!libres || libres.n === 0 || repartissable) {
      const message = messageAucunVehicule({
        ...contexte,
        libresToutesTailles: libres ? { n: libres.n, min: libres.min, max: libres.max } : null,
      });
      return repartissable ? message + this.noteSiegesRepartition(libres!) : message;
    }
    const base = messageAucunVehicule({ ...contexte, libresToutesTailles: null });
    const pourquoiSieges = 'pas assez de sièges à bord, et le stock ne complète pas ou ne suffit plus';
    // Assez de places à eux tous, mais aucun partage n'assoit les enfants : c'est le SIÈGE qui manque.
    if (placesSuffisent) {
      return (
        `${base} Sur ce créneau, ${libres.n} véhicules sont libres${fourchettePlaces(libres.min, libres.max)}, ` +
        `mais aucun ne peut recevoir les sièges auto demandés, même en répartissant le groupe (${pourquoiSieges}). ` +
        'Installez un siège, ou changez le réglage dans la vue Parc.'
      );
    }
    const siegesNonPlus = siegesImpossibles ? ` Les sièges auto demandés n'y tiennent pas non plus (${pourquoiSieges}).` : '';
    // Un seul véhicule libre, sans places renseignées : on ne chiffre rien, mais répartir est impossible.
    if (libres.inconnues > 0) {
      return `${base} Sur ce créneau, un seul véhicule est libre (nombre de places non renseigné) : impossible de répartir le groupe.${siegesNonPlus}`;
    }
    const qui =
      libres.n === 1
        ? `un seul véhicule est libre (${libres.places} ${libres.places > 1 ? 'places' : 'place'})`
        : `${libres.n} véhicules sont libres, ${libres.places} places à eux tous (${passagersLibres} passagers, un conducteur par véhicule)`;
    return `${base} Sur ce créneau, ${qui} : pas assez pour les ${min} places demandées, même en répartissant le groupe.${siegesNonPlus}`;
  }

  /**
   * C6 — la répartition tient : où vont les sièges auto demandés ? Rien à dire quand tous les libres
   * peuvent les recevoir (ou qu'aucun siège n'est demandé) ; sinon, le véhicule qui doit les porter
   * est NOMMÉ (jusqu'à trois plaques), ou l'on dit de les répartir aussi quand aucun ne les prend seul.
   */
  private noteSiegesRepartition(libres: LibresToutesTailles): string {
    const s = libres.sieges;
    if (!s || s.porteurs.length >= libres.n) return '';
    if (s.porteurs.length === 0) {
      return ' Aucun de ces véhicules ne peut recevoir à lui seul tous les sièges auto demandés : répartissez-les aussi entre les réservations.';
    }
    const k = s.porteurs.length;
    const qui =
      k === 1 ? s.porteurs[0]
        : k <= 3 ? `${s.porteurs.slice(0, -1).join(', ')} ou ${s.porteurs[k - 1]}`
          : `${k} de ces véhicules`;
    return ` Les sièges auto demandés ne peuvent aller que sur ${qui} : mettez-les sur la réservation de ${k === 1 ? 'ce véhicule' : 'l’un d’eux'}.`;
  }

  private async resolveScope(
    user: AuthUser,
    requestedFleetId?: string,
  ): Promise<{ fleetId?: string; ids: string[] | 'ALL' }> {
    let fleetId: string | undefined;
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée');
      fleetId = user.fleetId;
      // Un non-super-admin ne peut jamais viser une autre société que la sienne.
      if (requestedFleetId && requestedFleetId !== user.fleetId) {
        throw new ForbiddenException('Flotte hors périmètre.');
      }
    } else if (requestedFleetId) {
      // SUPER_ADMIN : scoper sur la société demandée (filtre société global) au lieu de
      // balayer tout le parc de toutes les sociétés.
      fleetId = requestedFleetId;
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const ids = resolveReportVehicleScope(accessible, undefined);
    return { fleetId, ids };
  }

  /** Réservations FERMES (bloquantes) chevauchant [start,end) sur un véhicule. */
  async findOverlaps(vehicleId: string, start: Date, end: Date, excludeId?: string): Promise<EventRow[]> {
    return this.prisma.vehicleEvent.findMany({
      where: {
        vehicleId,
        type: VehicleEventType.RESERVATION,
        status: { in: BLOCKING },
        startAt: { lt: end },
        endAt: { gt: start },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      include: INCLUDE_PLATE,
    });
  }

  /**
   * Clause « trajet en cours » (endedAt NULL), bornée par une durée d'occupation max : un trajet
   * ouvert bloque un créneau qui commence dans (start − MAX_OPEN_TRIP_MS, end). Conséquences : un
   * véhicule qui roule MAINTENANT bloque bien les créneaux proches (même journée), mais pas ceux de
   * la semaine prochaine (sa fin n'est pas « infinie »), et un trajet jamais clôturé (démarré il y a
   * plus que cette durée = anomalie tracker) ne bloque plus rien.
   */
  private openTripOr(start: Date): Prisma.TripWhereInput[] {
    return [{ endedAt: null, startedAt: { gt: new Date(start.getTime() - MAX_OPEN_TRIP_MS) } }];
  }

  /**
   * Un trajet RÉEL chevauche-t-il le créneau (véhicule effectivement pris) ?
   *
   * `ignorerDepuis` (contre-revue du 29/09, R0) : les trajets démarrés À PARTIR de cet instant ne
   * comptent pas. Sert à prolonger une réservation déjà commencée, sur le même véhicule : le trajet
   * que le conducteur est en train de faire — ouvert, donc sans fin — est l'usage de CETTE
   * réservation, pas un conflit. Sans ça, « il rentre à 19:00 au lieu de 17:00 » répondait 409
   * « Ce véhicule roule déjà » dès que la voiture roulait. Un trajet ouvert AVANT le début de la
   * réservation (quelqu'un d'autre au volant, trajet jamais clos) continue de bloquer.
   */
  private async hasTripOverlap(vehicleId: string, start: Date, end: Date, opts?: { ignorerDepuis?: Date }): Promise<boolean> {
    const t = await this.prisma.trip.findFirst({
      where: {
        vehicleId,
        startedAt: { lt: end },
        OR: [{ endedAt: { gt: start } }, ...this.openTripOr(start)],
        ...(opts?.ignorerDepuis ? { NOT: { startedAt: { gte: opts.ignorerDepuis } } } : {}),
      },
      select: { id: true },
    });
    return !!t;
  }

  /**
   * Véhicules immobilisés par un événement bloquant actif (incident/maintenance avec
   * `blocksVehicle`) chevauchant [start,end). Fin effective si endAt absent : un incident
   * bloque jusqu'à résolution, une maintenance all-day bloque sa journée.
   */
  private async findImmobilized(vehicleIds: string[], start: Date, end: Date): Promise<Set<string>> {
    const out = new Set<string>();
    if (vehicleIds.length === 0) return out;
    const rows = await this.prisma.vehicleEvent.findMany({
      where: {
        vehicleId: { in: vehicleIds },
        blocksVehicle: true,
        type: { not: VehicleEventType.RESERVATION },
        status: { in: IMMOBILIZING_STATUSES },
        startAt: { lt: end },
      },
      select: { vehicleId: true, type: true, startAt: true, endAt: true },
    });
    for (const r of rows) {
      // Source UNIQUE partagée avec le front (disponibilité affichée = ce que la résa accepte).
      const effectiveEnd = effectiveBlockingEndMs(r.type, r.startAt.getTime(), r.endAt ? r.endAt.getTime() : null);
      if (effectiveEnd > start.getTime()) out.add(r.vehicleId);
    }
    return out;
  }

  /** Charge une réservation en vérifiant le scope (flotte + périmètre véhicule). */
  private async loadScoped(user: AuthUser, id: string): Promise<EventRow> {
    const row = await this.prisma.vehicleEvent.findUnique({ where: { id }, include: INCLUDE_PLATE });
    if (!row) throw new NotFoundException('Réservation introuvable');
    if (user.role !== UserRole.SUPER_ADMIN && row.fleetId !== user.fleetId) {
      throw new NotFoundException('Réservation introuvable');
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    resolveReportVehicleScope(accessible, [row.vehicleId]); // 403 si hors périmètre
    if (row.type !== VehicleEventType.RESERVATION) {
      throw new BadRequestException("Cet événement n'est pas une réservation.");
    }
    return row;
  }

  private isExclusionConflict(err: unknown): boolean {
    // Code SQLSTATE fiable s'il est exposé (23P01 = exclusion_violation) ; sinon repli sur le
    // texte (nom de la contrainte / « exclusion constraint » dans le message Postgres).
    const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
    if (e?.code === '23P01' || e?.meta?.code === '23P01') return true;
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('no_overlap_reservation') ||
      msg.includes('23P01') ||
      msg.toLowerCase().includes('exclusion')
    );
  }

  private toDto(r: EventRow): VehicleEventDto {
    return {
      id: r.id,
      fleetId: r.fleetId,
      vehicleId: r.vehicleId,
      vehiclePlate: r.vehicle?.plate ?? null,
      type: r.type as VehicleEventDto['type'],
      category: r.category,
      status: r.status as VehicleEventStatusDto,
      severity: (r.severity as VehicleEventDto['severity']) ?? null,
      title: r.title,
      description: r.description,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt ? r.endAt.toISOString() : null,
      allDay: r.allDay,
      blocksVehicle: r.blocksVehicle,
      odometerKm: r.odometerKm,
      planId: r.planId,
      linkedEventId: r.linkedEventId,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  // ─── Auto-complétion ──────────────────────────────────────────────────────

  /**
   * `interne` (revue du 29/09, C2) — jamais exposé par un contrôleur : quand on cherche où DÉPLACER
   * une réservation, son propre besoin de sièges auto (et celui de ses sœurs, même `bookingRef`) ne
   * doit pas se compter contre elle dans le stock. Sans ça, « auto » répondait « aucun autre véhicule
   * libre et conforme » là où la cible choisie à la main passait (update() exclut déjà la réservation).
   */
  async suggest(
    user: AuthUser,
    query: { startAt: string; endAt: string; criteria?: RequestReservationDto['criteria']; fleetId?: string },
    interne?: { excludeId?: string; excludeBookingRef?: string | null },
  ): Promise<SuggestReservationResultDto> {
    const { start, end } = this.parseSlot(query.startAt, query.endAt);
    const scope = await this.resolveScope(user, query.fleetId);
    const where: Prisma.VehicleWhereInput = {};
    if (scope.fleetId) where.fleetId = scope.fleetId;
    if (scope.ids !== 'ALL') where.id = { in: scope.ids };
    return this.computeSuggestions(where, start, end, query.criteria, interne ? { siegesHors: interne } : undefined);
  }

  /**
   * Disponibilité pour une flotte PRÉCISE (flux public P4, sans utilisateur authentifié).
   * `excludeRequested` : traite AUSSI les demandes en attente (REQUESTED) comme occupantes — un
   * demandeur public ne doit pas voir un véhicule déjà réservé NI déjà suggéré/demandé pour un autre.
   *
   * ⚠️ Le résultat porte les compteurs d'exclusion (dont `excludedDormant`, et depuis le 29/09
   * `excludedTooSmall` et `largestSeats`) : ce sont des informations INTERNES (état du parc).
   * L'appelant public ne consomme que `vehicles` — ne jamais remonter ces chiffres dans une réponse
   * du lien public (anti-sondage de l'état de la flotte). Ce chemin ne construit AUCUN message
   * `messageAucunVehicule` : il rend le DTO, il ne lève pas.
   */
  async availableForFleet(
    fleetId: string,
    startAt: string,
    endAt: string,
    criteria?: RequestReservationDto['criteria'],
    opts?: { excludeRequested?: boolean },
  ): Promise<SuggestReservationResultDto> {
    const { start, end } = this.parseSlot(startAt, endAt);
    return this.computeSuggestions({ fleetId }, start, end, criteria, opts);
  }

  /** Cœur d'auto-complétion : véhicules du `where` LIBRES sur [start,end) conformes aux critères. */
  private async computeSuggestions(
    where: Prisma.VehicleWhereInput,
    start: Date,
    end: Date,
    criteria?: RequestReservationDto['criteria'],
    opts?: {
      excludeRequested?: boolean;
      /** Réservation (et sœurs) qu'on déplace : son besoin de sièges ne se compte pas contre elle. */
      siegesHors?: { excludeId?: string; excludeBookingRef?: string | null };
    },
  ): Promise<SuggestReservationResultDto> {
    const c = this.sanitizeCriteria(criteria);
    // Statuts occupants : fermes (défaut) ou fermes + en attente (flux public, anti-double-suggestion).
    const busyStatuses = opts?.excludeRequested ? [...BLOCKING, VehicleEventStatus.REQUESTED] : BLOCKING;

    const candidates = await this.prisma.vehicle.findMany({
      /**
       * ⚠️ HORS SERVICE — ecarte EN AMONT, donc pour les quatre surfaces d'un coup
       *    (disponibilite flotte, suggestion, lien public, attribution automatique).
       *
       * Proposer un vehicule accidente ou dont le boitier est debranche au garage, c'est
       * promettre une voiture qui n'existe pas pour le client. Le motif est DECLARE par un
       * super-admin, contrairement a la dormance qui est deduite : il n'y a donc aucun delai
       * ni aucun doute a lever — l'exclusion est immediate et le vehicule revient au vivier
       * a la seconde ou il est remis en service.
       */
      where: { ...where, outOfServiceReason: null },
      select: {
        id: true,
        plate: true,
        seats: true,
        // Sièges auto À BORD (2026-09-28) : ils couvrent le besoin avant le stock.
        childSeatsBaby: true,
        childSeatsChild: true,
        features: true,
        // Dormance : lue par JOINTURE sur la relation 1-1 déjà là (aucune requête de plus — le VPS
        // 2 vCPU ne pardonne pas un N+1 sur un parc de 2000). `lastSeenAt` est l'UNIQUE source :
        // ni Trip ni Position (vidés en mode vie privée alors que le boîtier parle), ni
        // `Tracker.status` (colonne collante, jamais remise à OFFLINE).
        tracker: { select: { id: true, lastSeenAt: true } },
      },
      take: 2000,
    });

    // Capacité filtrée EN JS (pas via `gte` Prisma, qui écarterait silencieusement les
    // NULL) : les véhicules à capacité inconnue sont COMPTÉS et rendus visibles à l'UI.
    // Les sièges auto, eux, se jugent APRÈS l'occupation (plus bas) : sièges à bord + stock du
    // créneau, selon la politique de la société.
    let excludedUnknownCapacity = 0;
    // « 12 places » (29/09) : les véhicules trop PETITS sont comptés aussi. Sans ce compte, un vivier
    // vidé par la taille se lisait « aucun véhicule libre sur ce créneau » — on cherchait un conflit
    // d'horaire qui n'existait pas, pendant que le panneau du jour affichait 7 véhicules sur 8 libres.
    let excludedTooSmall = 0;
    const capacityOk = candidates.filter((v) => {
      if (c.minSeats && v.seats == null) {
        excludedUnknownCapacity++;
        return false;
      }
      if (c.minSeats && (v.seats ?? 0) < c.minSeats) {
        excludedTooSmall++;
        return false;
      }
      return true;
    });
    // Le plus grand véhicule EN SERVICE du périmètre (les hors-service sont déjà hors de `candidates`),
    // occupé ou non : c'est lui qui dit « aucun véhicule de 12 places, le plus grand en a 9 ».
    const placesConnues = candidates
      .map((v) => v.seats)
      .filter((s): s is number => typeof s === 'number' && s > 0);
    const largestSeats = placesConnues.length > 0 ? Math.max(...placesConnues) : null;

    // Disponibilité des sièges auto sur le créneau — quand la société est connue. Lue en parallèle
    // du reste : c'est une requête de plus, mais une seule, et seulement si un stock peut exister.
    const fleetId = typeof where.fleetId === 'string' ? where.fleetId : null;
    const childSeatsAvail = fleetId && this.childSeats
      ? await this.childSeats.availability(fleetId, start, end, {
          includeRequested: opts?.excludeRequested,
          ...(opts?.siegesHors?.excludeId ? { excludeId: opts.siegesHors.excludeId } : {}),
          ...(opts?.siegesHors?.excludeBookingRef ? { excludeBookingRef: opts.siegesHors.excludeBookingRef } : {}),
        })
      : null;

    // Équipements : superset insensible à la casse (non exprimable en `hasEvery` Prisma).
    const required = (c.requiredFeatures ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean);
    const matching =
      required.length === 0
        ? capacityOk
        : capacityOk.filter((v) => {
            const have = new Set(v.features.map((f) => f.toLowerCase()));
            return required.every((r) => have.has(r));
          });
    const empty = (excludedImmobilized: number, excludedDormant = 0, excludedChildSeats = 0): SuggestReservationResultDto => ({
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      vehicles: [],
      childSeats: childSeatsAvail,
      excludedChildSeats,
      excludedUnknownCapacity,
      excludedImmobilized,
      excludedDormant,
      excludedTooSmall,
      largestSeats,
    });
    if (matching.length === 0) return empty(0);

    // DORMANCE (seuil « arrêter de COMPTER » = 7 j) — proposer un véhicule dont le boîtier s'est tu
    // depuis plus d'une semaine, c'est promettre une voiture qu'on ne sait plus ni localiser ni
    // garantir présente : en prod FV-941-LZ (89 j de silence) et FL-787-KV (52 j) ressortaient
    // encore dans le vivier, y compris via l'attribution automatique d'une demande « ouverte » et
    // via le lien public de réservation. On les écarte ici, en AMONT — donc pour les 4 surfaces
    // d'un coup (disponibilité flotte, suggestion, lien public, attribution automatique).
    //
    // Écarté du PRÉSENT seulement : la fiche, l'historique et les réservations déjà posées ne
    // bougent pas, et le véhicule réintègre le vivier tout seul à la première trame reçue (dérivé
    // au read-time, aucun champ en base, aucun bouton « réactiver »).
    //
    // ⚠️ Un véhicule SANS boîtier (TEST-001-XX) n'est PAS dormant et reste réservable :
    // beaucoup de flottes exploitent parfaitement des véhicules non équipés. `isVehicleDormant`
    // renvoie déjà false sans trackerId ET quand le boîtier n'a JAMAIS émis — on ne contourne pas.
    //
    // Compté sur les véhicules CONFORMES aux critères (comme `excludedImmobilized`) : le chiffre
    // affiché répond à « combien j'aurais pu vous proposer si les boîtiers parlaient », pas
    // « combien de muets dans le parc ». Le filtre est appliqué AVANT les requêtes d'occupation :
    // inutile d'aller chercher les conflits d'un véhicule déjà hors vivier.
    const nowMs = Date.now();
    const awake = matching.filter(
      (v) =>
        !isVehicleDormant(
          { trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null },
          nowMs,
          // 7 j, explicitement. Le seuil « AGIR » (72 h) ne s'applique PAS ici : proposer un
          // véhicule n'est pas lui envoyer une commande, et retirer à tort un vrai véhicule du
          // parc proposé au client coûte bien plus cher qu'une tentative de commande perdue.
          DORMANT_STOP_COUNTING_MS,
        ),
    );
    const excludedDormant = matching.length - awake.length;
    if (awake.length === 0) return empty(0, excludedDormant);

    const ids = awake.map((v) => v.id);
    const [busyResas, busyTrips, immobilized] = await Promise.all([
      this.prisma.vehicleEvent.findMany({
        where: {
          vehicleId: { in: ids },
          type: VehicleEventType.RESERVATION,
          status: { in: busyStatuses },
          startAt: { lt: end },
          endAt: { gt: start },
        },
        select: { vehicleId: true },
      }),
      this.prisma.trip.findMany({
        where: {
          vehicleId: { in: ids },
          startedAt: { lt: end },
          OR: [{ endedAt: { gt: start } }, ...this.openTripOr(start)],
        },
        select: { vehicleId: true },
      }),
      this.findImmobilized(ids, start, end),
    ]);
    const busy = new Set<string>([...busyResas.map((b) => b.vehicleId), ...busyTrips.map((b) => b.vehicleId)]);
    const excludedImmobilized = awake.filter((v) => immobilized.has(v.id)).length;
    const free = awake.filter((v) => !busy.has(v.id) && !immobilized.has(v.id));
    if (free.length === 0) return empty(excludedImmobilized, excludedDormant);

    // SIÈGES AUTO (2026-09-28) — un véhicule libre ne suffit pas quand la demande a des enfants à
    // bord : il faut ses sièges À BORD, et pour le reste le STOCK du créneau — si la politique de
    // la société l'autorise. Un véhicule que le besoin ne peut pas couvrir est ÉCARTÉ et COMPTÉ
    // (jamais un chiffre qui baisse en silence). Jugé ici, après l'occupation : inutile de juger
    // les sièges d'un véhicule déjà pris.
    const need = ChildSeatsService.needOf(criteria);
    const aBesoin = need.baby > 0 || need.child > 0;
    const aBordDe = (v: { childSeatsBaby?: number | null; childSeatsChild?: number | null }) => ({
      baby: v.childSeatsBaby ?? 0,
      child: v.childSeatsChild ?? 0,
    });
    let excludedChildSeats = 0;
    const couverts =
      aBesoin && childSeatsAvail
        ? free.filter((v) => {
            const ok = ChildSeatsService.couvre(childSeatsAvail, need, aBordDe(v));
            if (!ok) excludedChildSeats++;
            return ok;
          })
        : free;
    if (couverts.length === 0) return empty(excludedImmobilized, excludedDormant, excludedChildSeats);

    const util = await this.recentUtilization(couverts.map((v) => v.id));
    const duStock = (c: { baby: number; child: number }) => c.baby + c.child;
    const vehicles: SuggestedVehicleDto[] = couverts
      .map((v) => {
        const ratio = util.get(v.id) ?? 0;
        const aBord = aBordDe(v);
        return {
          vehicleId: v.id,
          vehiclePlate: v.plate,
          seats: v.seats,
          features: v.features,
          utilizationRatio: Math.round(ratio * 100) / 100,
          underutilized: ratio < UNDERUTILIZED_RATIO,
          childSeatsInstalled: aBord,
          childSeatsFromStock: ChildSeatsService.fromStock(need, aBord),
        };
      })
      // Avec des enfants à bord : d'abord le véhicule qui a DÉJÀ ses sièges (rien à installer, stock
      // préservé pour une autre course), puis les sous-utilisés. Sans besoin : sous-utilisés d'abord.
      .sort((a, b) =>
        (aBesoin ? duStock(a.childSeatsFromStock!) - duStock(b.childSeatsFromStock!) : 0) ||
        a.utilizationRatio - b.utilizationRatio,
      );

    return {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      vehicles,
      childSeats: childSeatsAvail,
      excludedChildSeats,
      excludedUnknownCapacity,
      excludedImmobilized,
      excludedDormant,
      excludedTooSmall,
      largestSeats,
    };
  }

  private async recentUtilization(vehicleIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (vehicleIds.length === 0) return out;
    const from = new Date(Date.now() - RECENT_WINDOW_MS);
    const trips = await this.prisma.trip.findMany({
      where: { vehicleId: { in: vehicleIds }, startedAt: { gte: from } },
      select: { vehicleId: true, durationSeconds: true },
    });
    const sum = new Map<string, number>();
    for (const t of trips) {
      sum.set(t.vehicleId, (sum.get(t.vehicleId) ?? 0) + (t.durationSeconds ?? 0) * 1000);
    }
    for (const id of vehicleIds) out.set(id, Math.min(1, (sum.get(id) ?? 0) / RECENT_WINDOW_MS));
    return out;
  }

  // ─── Demande → validation ──────────────────────────────────────────────────

  /** Demande de réservation (status REQUESTED, NON bloquant). Perm reservations_request. */
  async request(user: AuthUser, dto: RequestReservationDto): Promise<VehicleEventDto> {
    const { start, end } = this.parseSlot(dto.startAt, dto.endAt);

    // On ne réserve pas dans le passé. Seule EXCEPTION : consigner une réservation DÉJÀ EFFECTUÉE
    // mais non enregistrée (option « déjà effectuée ») — elle est alors placée à sa date réelle.
    const isPast = start.getTime() < Date.now();
    if (isPast && !dto.retroactive) {
      throw new BadRequestException(
        'Impossible de réserver une date passée. Pour consigner une réservation déjà effectuée mais non enregistrée, activez l’option « réservation déjà effectuée ».',
      );
    }
    if (dto.retroactive && !dto.vehicleId) {
      throw new BadRequestException('Précisez le véhicule concerné pour consigner une réservation déjà effectuée.');
    }
    // Rétroactif EFFECTIF = flag + créneau réellement passé (sur un créneau futur, le flag est ignoré
    // → réservation normale, tous les contrôles s'appliquent).
    const retro = !!dto.retroactive && isPast;

    let vehicleId = dto.vehicleId;
    let fleetId: string;
    if (vehicleId) {
      fleetId = await this.events.assertVehicleAccess(user, vehicleId); // 403/404
    } else {
      // Demande « ouverte » sur critères : on attache le meilleur véhicule libre (sous-utilisé d'abord).
      const sug = await this.suggest(user, {
        startAt: dto.startAt,
        endAt: dto.endAt,
        criteria: dto.criteria,
        fleetId: dto.fleetId,
      });
      if (sug.vehicles.length === 0) {
        // Seule surface HUMAINE où le compteur d'exclusion disparaîtrait : ici on ne renvoie pas le
        // DTO, on lève. Sans la mention, l'exploitant lit « aucun véhicule » comme « agenda plein »
        // et part chercher un conflit de créneau qui n'existe pas, alors que le vrai sujet est un
        // boîtier muet (batterie débranchée, SIM coupée) à faire réparer, un siège auto qui manque —
        // ou, le 29/09 à 05:10 sur Client test, un groupe de 12 pour un parc dont le plus grand
        // véhicule a 9 places. Une exclusion ne fait jamais baisser un chiffre client en silence —
        // y compris dans un message d'erreur. Un seul constructeur pour tous ces cas
        // (`messageAucunVehicule`), partagé avec la réaffectation.
        // Chemin AUTHENTIFIÉ (le lien public passe par availableForFleet + systemRequest, qui ne
        // construisent aucun de ces messages) : aucune fuite d'état de parc.
        const minSeats = this.sanitizeCriteria(dto.criteria).minSeats ?? null;
        const contexte = this.contexteAucunVehicule(sug, minSeats);
        // « 12 places » : ce sont les places qui ont vidé le vivier. Relire le créneau SANS le plancher
        // dit combien de véhicules sont libres et de quelle taille — de quoi répartir le groupe, ou dire
        // que même répartis ils ne suffisent pas. Seulement ici : c'est une requête de plus, sur le seul
        // chemin qui en a besoin — et jamais quand ce sont les sièges auto qui ont vidé le vivier
        // (`contexte.excludedTooSmall` vaut alors 0 : les petits véhicules n'y sont pour rien).
        const libres =
          minSeats && (contexte.excludedTooSmall ?? 0) > 0 ? await this.libresToutesTailles(user, dto) : null;
        throw new BadRequestException(this.messageDemandeSansVehicule(contexte, libres));
      }
      vehicleId = sug.vehicles[0].vehicleId;
      fleetId = await this.events.assertVehicleAccess(user, vehicleId);
    }

    // « 12 places » (29/09) — le choix EXPLICITE d'un véhicule trop petit pour le plancher saisi : 400
    // avant tout contrôle de créneau (c'est le choix qui est faux, pas l'agenda). Le vivier écarte déjà
    // ces véhicules pour une demande ouverte ; le choix à la main passait, et la réservation annonçait
    // 12 places dans une voiture de 9. Aucun flux légitime n'envoie un tel couple : l'IA de placement
    // (« Suggérer avec l'IA », seule source de pré-sélection de la feuille Réserver) propose depuis ce
    // même vivier, donc jamais sous `minSeats` ; une demande publique répartie ne porte pas `minSeats`
    // (seulement `seatsNeeded`) et passe par systemRequest. Jamais en rétroactif : on consigne ce qui a
    // roulé, pas une promesse. La même règle tient à l'édition (`update()`, dès que le véhicule ou le
    // plancher change), à la validation qui déplace (`confirm()`) et à la réaffectation vers un véhicule
    // choisi (`reaffecter()`) — revue du 29/09, C8.
    if (dto.vehicleId && !retro) {
      await this.assertAssezDePlaces(vehicleId, this.sanitizeCriteria(dto.criteria).minSeats);
    }

    // Une réservation FERME existante (une autre réservation) sur le créneau rend la demande caduque —
    // y compris en rétroactif (on ne consigne pas deux fois le même créneau).
    const conflicts = await this.findOverlaps(vehicleId, start, end);
    if (conflicts.length > 0) {
      throw new ConflictException('Ce véhicule est déjà réservé sur ce créneau.');
    }
    // Rétroactif : le trajet réel (et une immobilisation passée) sont ATTENDUS — ils prouvent que la
    // réservation a eu lieu ; on ne bloque donc pas dessus. Pour une réservation à venir, on refuse.
    if (!retro) {
      // Déclaré hors service par un super-admin : on ne promet pas une voiture qui n'existe plus.
      // (La demande OUVERTE passe par le vivier, qui les écarte déjà ; ici c'est le choix explicite.)
      if (dto.vehicleId) await this.assertEnService(vehicleId);
      if (await this.hasTripOverlap(vehicleId, start, end)) {
        throw new ConflictException('Ce véhicule roule déjà sur ce créneau.');
      }
      if ((await this.findImmobilized([vehicleId], start, end)).has(vehicleId)) {
        throw new ConflictException('Ce véhicule est immobilisé (incident ou maintenance) sur ce créneau.');
      }
      // Sièges auto : un véhicule libre ne suffit pas, il faut aussi de quoi asseoir les enfants —
      // ses sièges à bord, puis le stock selon la politique. Vérifié pour une DEMANDE aussi (pas
      // seulement une réservation ferme) : celui qui dépose l'apprend tout de suite, pas le
      // valideur trois jours plus tard.
      await this.childSeats?.assertAvailable(fleetId, start, end, ChildSeatsService.needOf(dto.criteria), { vehicleId });
    }

    // #5 — Placement DIRECT si l'appelant peut GÉRER les réservations de CE véhicule
    // (droit reservations_manage résolu par véhicule) : sa réservation entre CONFIRMÉE
    // dans l'agenda, sans passer par la file de demandes. Sinon (droit reservations_request
    // seul) → REQUESTED (une demande qu'un gestionnaire validera).
    const canManage = await this.permissions.canOnVehicle(user, vehicleId, 'reservations_manage');
    // Consigner une réservation passée est un acte de GESTION (jamais une demande à valider).
    if (retro && !canManage) {
      throw new ForbiddenException('Seul un gestionnaire peut consigner une réservation déjà effectuée.');
    }
    const status = canManage ? VehicleEventStatus.CONFIRMED : VehicleEventStatus.REQUESTED;

    try {
      const row = await this.prisma.vehicleEvent.create({
        data: {
          fleetId,
          vehicleId,
          type: VehicleEventType.RESERVATION,
          status,
          /**
           * ⚠️ LE MOTIF SAISI DEVIENT LE TITRE. Il était rangé dans `metadata.reason` et plus
           * jamais montré : le calendrier affiche `title`, qui valait toujours « Réservation ».
           * Relevé en recette le 2026-09-24 — le champ propose pourtant « Ex. Ramassage scolaire
           * secteur nord », et le gestionnaire qui le remplit voit son texte disparaître.
           *
           * L'ordre dit la priorité : un titre explicite (API, import) prime ; sinon le motif
           * saisi par la personne ; « Réservation » n'est plus qu'un dernier recours. Le motif
           * reste AUSSI dans la metadata — il y est lu par le flux public et les exports.
           */
          title: dto.title?.trim() || dto.reason?.trim() || 'Réservation',
          startAt: start,
          endAt: end,
          allDay: false,
          metadata: {
            requesterId: user.id,
            reason: dto.reason ?? null,
            // Écrits PROPRES (entiers sûrs, sans clé vide) : c'est sur ces critères que le stock de
            // sièges se recompte à chaque validation — une chaîne « 2 » ou un -1 y fausserait tout.
            criteria: ChildSeatsService.criteresPropres(dto.criteria),
            ...(retro ? { retroactive: true } : {}),
            // Groupe qui utilise le véhicule : ABSENT = celui du véhicule retenu ; `null` = aucun groupe,
            // choisi explicitement (revue du 29/09, C3/C41 : un `?? groupeDuVehicule` remettait en
            // silence le groupe du véhicule que le gestionnaire venait de retirer).
            group:
              dto.group === undefined
                ? await this.groupeDuVehicule(vehicleId)
                : await this.groupePropre(fleetId, dto.group),
          } as Prisma.InputJsonValue,
          createdBy: user.id,
          source: 'MANUAL',
        },
        include: INCLUDE_PLATE,
      });
      // Déclencheur agent : une réservation HUMAINE À VENIR vient d'être créée (l'agent décide selon
      // son toggle). Une consignation rétroactive (créneau passé) n'a rien à optimiser → pas de trigger.
      if (!retro) this.emitter?.emit('agenda-agent.trigger', { fleetId, kind: 'reservation' });
      // Journal (29/09) : la demande, la création ferme ou la consignation — jamais un événement de
      // plus (les courriels ne changent pas), seulement une ligne dans le journal métier.
      this.tracerCreation(user, row, { retro, auto: !dto.vehicleId });
      return this.toDto(row);
    } catch (err) {
      // Une réservation FERME (CONFIRMED) est soumise à la contrainte EXCLUDE : traduire
      // la course concurrente en 409 lisible (le pré-check plus haut a déjà écarté le reste).
      if (status === VehicleEventStatus.CONFIRMED && this.isExclusionConflict(err)) {
        throw new ConflictException("Ce créneau vient d'être réservé (course concurrente).");
      }
      throw err;
    }
  }

  /** Validation d'une demande -> CONFIRMED (bloquant). Perm reservations_manage. */
  async confirm(user: AuthUser, id: string, dto: ConfirmReservationDto): Promise<VehicleEventDto> {
    const resa = await this.loadScoped(user, id);
    // Seule une demande EN ATTENTE peut être validée : pas de re-confirm d'un CONFIRMED/IN_PROGRESS
    // (qui régresserait le cycle de vie), ni d'un DONE/CANCELLED clôturé.
    if (resa.status !== VehicleEventStatus.REQUESTED) {
      throw new BadRequestException('Seule une demande en attente peut être validée.');
    }
    /**
     * Troisième relecture du 29/09 (T1) — VALIDER, c'est gérer les réservations de CE véhicule, qu'on
     * le déplace ou non. Le contrôle n'avait lieu qu'en cas de réaffectation : un gestionnaire du
     * groupe Nord, simple demandeur sur Sud, déposait une demande sur Sud (`request()` la mettait en
     * REQUESTED, justement parce qu'il ne gère pas Sud)… puis la validait lui-même en un second appel.
     */
    await this.exigerGestion(user, resa.vehicleId, this.messageNonGeree(resa, 'valider'));

    let vehicleId = resa.vehicleId;
    // La société ne change jamais à la validation (revue du 29/09, C4) : le véhicule de réaffectation
    // doit être de la même société que la demande.
    const fleetId = resa.fleetId;
    if (dto.vehicleId && dto.vehicleId !== vehicleId) {
      // Valider EN DÉPLAÇANT, c'est déplacer (contre-revue du 29/09, R1) : mêmes droits que `update()`
      // et `reaffecter()` — l'origine est contrôlée juste au-dessus, la cible ici.
      await this.cibleDeLaMemeSociete(user, resa, dto.vehicleId); // réaffectation
      await this.exigerGestion(user, dto.vehicleId, MESSAGE_CIBLE_NON_GEREE);
      // C8 (revue du 29/09) — valider EN DÉPLAÇANT vers un véhicule plus petit que le plancher saisi
      // à la demande : même 400 que `request()` et `update()`. Sans déplacement, rien de neuf n'est
      // choisi : une demande ancienne déjà incohérente se valide telle quelle.
      const criteresDemande = (resa.metadata as { criteria?: RequestReservationDto['criteria'] } | null)?.criteria;
      await this.assertAssezDePlaces(dto.vehicleId, this.sanitizeCriteria(criteresDemande).minSeats);
      vehicleId = dto.vehicleId;
    }

    if (!resa.endAt) throw new BadRequestException('Réservation sans créneau de fin.');
    // Hors service : déclaré depuis le dépôt de la demande, ou véhicule de réaffectation choisi à la
    // main — dans les deux cas, valider engagerait une voiture qui ne roule pas.
    await this.assertEnService(vehicleId);
    // Pré-check (409 lisible) ; la contrainte EXCLUDE tranche la course concurrente.
    const conflicts = await this.findOverlaps(vehicleId, resa.startAt, resa.endAt, id);
    if (conflicts.length > 0) {
      throw new ConflictException('Conflit : une réservation ferme existe déjà sur ce créneau.');
    }
    // Cohérence avec la réalité : refuser si le véhicule roule déjà sur le créneau (symétrique
    // de request() ; surtout pertinent quand confirm réaffecte un autre véhicule).
    if (await this.hasTripOverlap(vehicleId, resa.startAt, resa.endAt)) {
      throw new ConflictException('Ce véhicule roule déjà sur ce créneau.');
    }
    if ((await this.findImmobilized([vehicleId], resa.startAt, resa.endAt)).has(vehicleId)) {
      throw new ConflictException('Ce véhicule est immobilisé (incident ou maintenance) sur ce créneau.');
    }
    // Sièges auto : le stock a pu être pris par d'autres réservations validées depuis le dépôt.
    // La demande elle-même et ses sœurs (même `bookingRef`, même besoin) ne se comptent pas.
    {
      const meta = (resa.metadata as { criteria?: unknown } | null) ?? null;
      await this.childSeats?.assertAvailable(
        fleetId,
        resa.startAt,
        resa.endAt,
        ChildSeatsService.needOf(meta?.criteria as RequestReservationDto['criteria']),
        { vehicleId, excludeId: id, excludeBookingRef: this.bookingRefOf(resa.metadata) },
      );
    }

    // Groupe qui utilise le véhicule (revue du 29/09, C3/C41) :
    //  - choisi à la validation : un objet le pose, `null` = AUCUN groupe (choix explicite du valideur,
    //    que l'ancien `?? groupeDe(meta) ?? groupeDuVehicule` remplaçait en silence) ;
    //  - absent : celui déjà posé sur la demande dès qu'elle porte une clé `group` — y compris `null`,
    //    un « aucun groupe » choisi au dépôt — sinon (demande publique, ancienne demande) celui du véhicule.
    const metaConfirm = (resa.metadata as Record<string, unknown> | null) ?? {};
    const groupe =
      dto.group !== undefined
        ? await this.groupePropre(fleetId, dto.group)
        : Object.hasOwn(metaConfirm, 'group')
          ? ReservationsService.groupeDe(metaConfirm)
          : await this.groupeDuVehicule(vehicleId);

    try {
      const row = await this.prisma.vehicleEvent.update({
        where: { id },
        data: {
          status: VehicleEventStatus.CONFIRMED,
          vehicleId,
          fleetId,
          metadata: { ...metaConfirm, group: groupe } as Prisma.InputJsonValue,
        },
        include: INCLUDE_PLATE,
      });
      // Réservation validée : notifier le demandeur (flux public P4). Le notifier ne réagit qu'aux
      // réservations `metadata.public` avec un contact ; sans effet pour les réservations internes.
      this.emitter?.emit('reservation.confirmed', {
        fleetId: row.fleetId,
        vehiclePlate: row.vehicle?.plate ?? null,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt ? row.endAt.toISOString() : null,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      });
      this.tracerDecision('validee', user, row, {
        vehiculeAvant: vehicleId !== resa.vehicleId ? { id: resa.vehicleId, plate: resa.vehicle?.plate ?? null } : null,
      });
      return this.toDto(row);
    } catch (err) {
      if (this.isExclusionConflict(err)) {
        throw new ConflictException('Conflit : ce créneau vient d\'être réservé (course concurrente).');
      }
      throw err;
    }
  }

  /**
   * Refus / annulation -> CANCELLED. Perm reservations_manage.
   *
   * `interne` (troisième relecture du 29/09, T2) : `silencieux` — la réorganisation prévient elle-même,
   * UNE fois par demande groupée, après sa boucle. Le contrôleur n'en passe aucune.
   */
  async cancel(user: AuthUser, id: string, interne?: OptionsInternes): Promise<VehicleEventDto> {
    const resa = await this.loadScoped(user, id);
    // Un DONE est terminal (immuable) ; un CANCELLED est idempotent.
    if (resa.status === VehicleEventStatus.DONE) {
      throw new BadRequestException('Une réservation terminée ne peut pas être annulée.');
    }
    if (resa.status === VehicleEventStatus.CANCELLED) return this.toDto(resa);
    /**
     * T1 — annuler ou refuser, c'est GÉRER les réservations de CE véhicule (droit résolu par
     * véhicule). Le garde du contrôleur lit l'UNION des droits : un gestionnaire de Nord, simple
     * demandeur sur Sud, annulait n'importe quelle réservation de Sud — une à une, ou en masse par
     * « Réorganiser → Annuler », pendant que « Réaffecter » refusait ces mêmes lignes.
     * Seule exception : retirer SA PROPRE demande encore en attente — ce n'est pas gérer Sud, c'est
     * reprendre ce qu'on a soi-même déposé.
     */
    const retraitDeSaDemande = estRetraitDeSaDemande(resa.status, resa.metadata, user.id);
    if (!retraitDeSaDemande) await this.exigerGestion(user, resa.vehicleId, this.messageNonGeree(resa, 'annuler'));
    const etait = resa.status;
    const row = await this.prisma.vehicleEvent.update({
      where: { id },
      data: { status: VehicleEventStatus.CANCELLED, resolvedAt: new Date() },
      include: INCLUDE_PLATE,
    });
    // « Refusée », « retirée » et « annulée » sont trois gestes différents pour un même appel :
    // refuser la demande de quelqu'un, retirer SA propre demande, annuler une réservation déjà ferme.
    // Le journal doit les distinguer, sinon il raconte une histoire fausse — revue du 29/09 (C4) : un
    // gestionnaire de Nord qui retirait sa demande sur Sud était écrit « Demande refusée » sur Sud, en
    // rouge, comme s'il avait tranché chez des véhicules qu'il ne gère pas.
    const quoi = etait !== VehicleEventStatus.REQUESTED ? 'annulee' : retraitDeSaDemande ? 'retiree' : 'refusee';
    this.tracerDecision(quoi, user, row, { lot: interne?.lot });
    const ecrite = this.toDto(row);
    if (!interne?.silencieux) {
      // F16 (recette du 28/09) : le demandeur d'une demande PUBLIQUE apprenait la validation, jamais
      // le refus — il attendait un véhicule qui ne viendrait pas. Même événement que la confirmation,
      // l'autre verbe ; le notifier ne réagit qu'aux demandes publiques avec un contact.
      // Un RETRAIT n'est pas un refus (C4) : rien à annoncer. Sans effet sur les courriels — un retrait
      // ne vise qu'une demande interne (`requesterId`), que le notifier ignorait déjà.
      if (etait === VehicleEventStatus.REQUESTED) {
        if (quoi === 'refusee') this.annoncerRefus(ecrite);
      }
      // T2 — et une réservation publique DÉJÀ CONFIRMÉE qu'on annule : le demandeur avait reçu
      // « confirmée — AA-111-BB » et se présentait pour une réservation annulée.
      else if (this.annulationAAnnoncer(etait, ecrite)) this.annoncerAnnulation(ecrite);
    }
    return ecrite;
  }

  /** `reservation.refused` : une demande en attente n'a pas été retenue (F16). */
  private annoncerRefus(ligne: VehicleEventDto): void {
    this.emitter?.emit('reservation.refused', {
      fleetId: ligne.fleetId,
      vehiclePlate: ligne.vehiclePlate ?? null,
      startAt: ligne.startAt,
      endAt: ligne.endAt,
      metadata: ligne.metadata ?? null,
    });
  }

  /**
   * T2 (troisième relecture du 29/09) — faut-il prévenir le demandeur de l'ANNULATION de cette ligne ?
   * Mêmes bornes que {@link annoncerModification} : seulement une réservation publique qui était
   * CONFIRMÉE (une demande en attente reçoit un refus ; une réservation en cours, le demandeur a déjà
   * la voiture), jamais une consignation rétroactive, jamais une réservation déjà finie.
   * `statutAvant` : le statut AVANT l'annulation — c'est lui qui dit « déjà confirmée ».
   */
  private annulationAAnnoncer(
    statutAvant: VehicleEventStatus | string,
    ligne: Pick<VehicleEventDto, 'endAt' | 'metadata'>,
  ): boolean {
    if (statutAvant !== VehicleEventStatus.CONFIRMED) return false;
    const meta = ligne.metadata ?? null;
    if (meta?.['public'] !== true || meta['retroactive'] === true) return false;
    return !ligne.endAt || new Date(ligne.endAt).getTime() > Date.now();
  }

  /**
   * `reservation.cancelled` — un événement DÉDIÉ, pas `reservation.refused` : « votre demande n'a pas
   * pu être retenue » est faux pour une réservation que le demandeur tenait pour ferme. Le notifier
   * tranche sur l'état du groupe : s'il reste des lignes fermes à venir, la demande est MODIFIÉE (et
   * le courriel les nomme) ; sinon, elle est annulée.
   */
  private annoncerAnnulation(ligne: VehicleEventDto): void {
    this.emitter?.emit('reservation.cancelled', {
      fleetId: ligne.fleetId,
      vehiclePlate: ligne.vehiclePlate ?? null,
      startAt: ligne.startAt,
      endAt: ligne.endAt,
      status: ligne.status,
      metadata: ligne.metadata ?? null,
    });
  }

  /**
   * ── LA DÉCISION LAISSE UNE TRACE ───────────────────────────────────────────────────────
   *
   * ⚠️ ELLE N'EN LAISSAIT AUCUNE. Le DÉPÔT d'une demande publique était journalisé
   * (`public_booking_submitted`), mais valider ou refuser ne l'était pas — exactement l'inverse
   * de ce qu'il faut. Relevé le 2026-09-24 en recette : deux demandes de « Client test » étaient
   * passées à CONFIRMED et RIEN ne permettait de dire qui les avait validées, ni quand.
   *
   * Chez un client dont le standard valide les demandes des conducteurs, c'est la décision qui
   * engage — pas la demande. Elle doit être attribuable.
   *
   * Best-effort (`?.`) comme partout ailleurs : un journal indisponible ne doit jamais empêcher
   * une validation d'aboutir.
   */
  private tracerDecision(
    quoi: 'validee' | 'refusee' | 'retiree' | 'annulee',
    user: AuthUser,
    row: {
      id: string;
      fleetId: string;
      vehicleId?: string;
      startAt: Date;
      endAt?: Date | null;
      metadata?: unknown;
      vehicle?: { plate: string | null } | null;
    },
    extra?: { lot?: string; vehiculeAvant?: { id: string; plate: string | null } | null },
  ): void {
    this.journaliser(`reservation_${quoi}`, user, () => {
      const plaque = row.vehicle?.plate ?? null;
      const quoiLisible =
        quoi === 'validee' ? 'Réservation validée'
          : quoi === 'refusee' ? 'Demande refusée'
            : quoi === 'retiree' ? 'Demande retirée par son auteur'
              : 'Réservation annulée';
      const deplacee = extra?.vehiculeAvant ? ` (véhicule ${extra.vehiculeAvant.plate ?? '?'} → ${plaque ?? '?'})` : '';
      return {
        fleetId: row.fleetId,
        plaque,
        detail: `${quoiLisible} — ${plaque ?? 'véhicule inconnu'}, ${creneauParis(row.startAt, row.endAt)}${deplacee}`,
        meta: {
          reservationId: row.id,
          vehicleId: row.vehicleId ?? null,
          bookingRef: this.bookingRefOf(row.metadata),
          parUtilisateur: user.id,
          plaque,
          ...(extra?.vehiculeAvant ? { vehiculeAvant: extra.vehiculeAvant.id, plaqueAvant: extra.vehiculeAvant.plate } : {}),
          ...(extra?.lot ? { lot: extra.lot } : {}),
        },
      };
    });
  }

  /**
   * ── LE JOURNALISEUR UNIQUE (29/09) ──────────────────────────────────────────────────────────
   *
   * Toutes les lignes que ce service écrit dans `system_activity_logs` passent ICI : demande,
   * création, consignation, validation, refus, annulation, modification, réaffectation, décalage,
   * scission, réorganisation. Les règles, dites une fois :
   *  - `category` RESERVATION, `actor` 'utilisateur' (jamais un nom en texte libre : le fil client
   *    affiche « Équipe Tracky » pour un super-admin, il ne doit pas le trouver écrit ailleurs) ;
   *  - `fleetId` = la société de la RESSOURCE — un super-admin agit sur la société d'un client, et
   *    c'est dans l'activité de CE client que son geste doit apparaître ;
   *  - `triggeredByUserId` = la personne réelle ;
   *  - le détail est en heure de Paris ; `meta` garde les identifiants.
   *
   * La ligne est CONSTRUITE dans le `try` (`construire` est paresseux) : ni un journal absent
   * (service optionnel, specs), ni une donnée inattendue au moment de rédiger le détail ne peuvent
   * faire échouer le geste — il a déjà été écrit quand on le raconte.
   */
  private journaliser(action: ActionJournal, user: AuthUser | null | undefined, construire: () => EntreeJournal): void {
    const journal = this.systemActivity;
    if (!journal?.record) return;
    try {
      const e = construire();
      journal.record({
        category: 'RESERVATION',
        action,
        status: e.status ?? 'SUCCESS',
        actor: 'utilisateur',
        target: e.plaque ?? null,
        detail: e.detail,
        fleetId: e.fleetId,
        triggeredByUserId: user?.id ?? null,
        meta: e.meta ?? null,
      });
    } catch {
      // Le journal observe le geste ; il ne l'empêche jamais (SystemActivityService.record ne jette
      // déjà pas — ce filet couvre la rédaction de la ligne elle-même).
    }
  }

  /** `request()` — la réservation qui vient d'être posée : demande, création ferme ou consignation. */
  private tracerCreation(user: AuthUser, row: EventRow, opts: { retro: boolean; auto: boolean }): void {
    const action: ActionJournal = opts.retro
      ? 'reservation_consignee'
      : row.status === VehicleEventStatus.CONFIRMED
        ? 'reservation_creee'
        : 'reservation_demandee';
    this.journaliser(action, user, () => {
      const plaque = row.vehicle?.plate ?? null;
      const quoi =
        action === 'reservation_consignee' ? 'Réservation consignée (déjà effectuée)'
          : action === 'reservation_creee' ? 'Réservation créée'
            : 'Demande de réservation';
      const titre = row.title && row.title !== 'Réservation' ? ` · ${cite(row.title)}` : '';
      return {
        fleetId: row.fleetId,
        plaque,
        detail:
          `${quoi} — ${plaque ?? 'véhicule inconnu'}, ${creneauParis(row.startAt, row.endAt)}${titre}` +
          (opts.auto ? ' (véhicule attribué automatiquement)' : ''),
        meta: {
          reservationId: row.id,
          vehicleId: row.vehicleId,
          statut: row.status,
          attribueAuto: opts.auto,
          bookingRef: this.bookingRefOf(row.metadata),
          startAt: row.startAt.toISOString(),
          endAt: row.endAt ? row.endAt.toISOString() : null,
        },
      };
    });
  }

  /**
   * Édition d'une réservation (créneau / critères / libellé / VÉHICULE). Perm reservations_manage.
   * Une réservation VALIDÉE (CONFIRMED) reste éditable : le créneau, le motif, les critères ET le
   * véhicule affecté peuvent changer, avec re-vérification des conflits sur la cible (véhicule +
   * créneau) et la contrainte EXCLUDE en dernier rempart.
   *
   * `interne` : options de l'appelant INTERNE (réorganisation) — le contrôleur n'en passe aucune.
   */
  async update(user: AuthUser, id: string, dto: UpdateReservationDto, interne?: OptionsInternes): Promise<VehicleEventDto> {
    const resa = await this.loadScoped(user, id);
    const maintenant = Date.now();

    let start = resa.startAt;
    let end = resa.endAt;
    const data: Prisma.VehicleEventUncheckedUpdateInput = {};
    /**
     * CE QUI CHANGE VRAIMENT (revue du 29/09, C44). Une réservation multi-jours déjà commencée ne
     * pouvait plus être prolongée ni regroupée : le client renvoyait toujours `startAt`, donc le
     * créneau passait pour « déplacé », et un début passé tombait sous la garde « dans le passé ».
     * On compare désormais à ce qui est en base (à la minute : l'écran tronque les secondes) — un
     * début renvoyé à l'identique n'est pas un déplacement, et on ne le réécrit pas.
     */
    let debutChange = false;
    let finChange = false;
    if (dto.startAt !== undefined || dto.endAt !== undefined) {
      const slot = this.parseSlot(dto.startAt ?? resa.startAt.toISOString(), dto.endAt ?? resa.endAt?.toISOString() ?? '');
      debutChange = !memeMinute(slot.start, resa.startAt);
      finChange = !resa.endAt || !memeMinute(slot.end, resa.endAt);
      if (debutChange) start = slot.start;
      if (finChange) end = slot.end;
      if (end && end.getTime() <= start.getTime()) {
        throw new BadRequestException('La fin du créneau doit être après le début.');
      }
      if (debutChange) data.startAt = start;
      if (finChange) data.endAt = end;
    }
    const slotChanged = debutChange || finChange;
    // Une réservation « déjà effectuée » (metadata.retroactive, ou marquée telle par le client) reste
    // éditable même sur un créneau passé. Sinon, on interdit de DÉPLACER le début dans le passé — mais
    // un début déjà écoulé qu'on ne touche pas (réservation en cours qu'on prolonge) n'est pas un
    // déplacement ; et une fin qu'on change doit rester à venir.
    const isRetro =
      (resa.metadata as { retroactive?: unknown } | null)?.retroactive === true || dto.retroactive === true;
    if (debutChange && start.getTime() < maintenant && !isRetro) {
      throw new BadRequestException(
        'Impossible de déplacer une réservation dans le passé. Pour une réservation déjà effectuée, activez l’option « réservation déjà effectuée ».',
      );
    }
    if (finChange && end && end.getTime() <= maintenant && !isRetro) {
      throw new BadRequestException(
        'La nouvelle fin est déjà passée. Pour une réservation déjà effectuée, activez l’option « réservation déjà effectuée ».',
      );
    }

    // Réaffectation de véhicule (ex. changer le véhicule d'une réservation validée). Vérifiée AVANT
    // le groupe : la société est celle de la réservation, et elle ne change pas (revue du 29/09, C4 —
    // le groupe était validé contre l'ancienne société pendant que la réservation passait chez une autre).
    let targetVehicleId = resa.vehicleId;
    const vehicleChanged = !!dto.vehicleId && dto.vehicleId !== resa.vehicleId;
    /**
     * Contre-revue du 29/09 (R1), puis troisième relecture (T1) — GÉRER le véhicule d'origine, contrôlé
     * AVANT toute écriture, scission comprise, DÈS QU'UN CHAMP CHANGE. R1 ne le demandait qu'au
     * changement de véhicule : un gestionnaire de Nord, simple demandeur sur Sud, décalait, renommait ou
     * changeait les critères de n'importe quelle réservation de Sud — une à une, ou toutes d'un coup par
     * « Réorganiser → Décaler ». Un appel qui ne change rien n'écrit rien : il n'a rien à prouver.
     */
    const champChange =
      slotChanged || vehicleChanged ||
      dto.title !== undefined || dto.reason !== undefined || dto.criteria !== undefined || dto.group !== undefined;
    if (champChange) {
      await this.exigerGestion(
        user,
        resa.vehicleId,
        vehicleChanged ? this.messageOrigineNonGeree(resa) : this.messageNonGeree(resa, 'modifier'),
      );
    }
    if (vehicleChanged) {
      /**
       * Contre-revue du 29/09 (R1) — D1 n'était fermé que dans `reaffecter` : la feuille d'édition
       * (PATCH) changeait toujours la plaque avec le seul garde du contrôleur, qui lit l'UNION des
       * droits. Un gestionnaire du groupe Nord, simple demandeur sur Sud, posait ainsi une
       * réservation FERME sur un véhicule de Sud sans que Sud la valide — et, depuis la scission, une
       * réservation commencée créait sa suite ferme sur Sud par le même chemin. Déplacer exige de
       * GÉRER l'origine (contrôlée juste au-dessus) ET la cible.
       */
      await this.cibleDeLaMemeSociete(user, resa, dto.vehicleId!); // 403/404, puis 400 si autre société
      await this.exigerGestion(user, dto.vehicleId!, MESSAGE_CIBLE_NON_GEREE);
      targetVehicleId = dto.vehicleId!;
      data.vehicleId = targetVehicleId;
      // Réaffecter vers un véhicule hors service serait le même défaut que le réserver.
      if (!isRetro) await this.assertEnService(targetVehicleId);
    }

    if (dto.title !== undefined) data.title = dto.title.trim() || 'Réservation';
    const metaActuelle = (resa.metadata as Record<string, unknown> | null) ?? {};
    /**
     * Troisième relecture du 29/09 (T13) — LE TITRE SUIT LE MOTIF QU'IL REPRENAIT. À la création, le
     * motif saisi devient le titre (cf. `request()`), et c'est le titre que le calendrier affiche. À
     * l'édition, seul `metadata.reason` changeait : « Ramassage nord » devenu « Sortie piscine »
     * restait « Ramassage nord » sur la grille, et la carte du jour montrait les deux.
     * Le titre ne suit que s'il ÉTAIT dérivé du motif (égal à l'ancien motif, ou « Réservation » par
     * défaut) : un titre explicite (API, import, « Demande publique → … ») est gardé. Motif vidé →
     * « Réservation ». Posé avant la scission : les deux parties le portent.
     */
    if (dto.title === undefined && dto.reason !== undefined) {
      const ancienMotif = typeof metaActuelle['reason'] === 'string' ? (metaActuelle['reason'] as string).trim() : '';
      const nouveauMotif = typeof dto.reason === 'string' ? dto.reason.trim() : '';
      const titreActuel = (resa.title ?? '').trim();
      if (nouveauMotif !== ancienMotif && (titreActuel === ancienMotif || titreActuel === 'Réservation')) {
        data.title = nouveauMotif || 'Réservation';
      }
    }
    const criteresApres = dto.criteria !== undefined
      ? ChildSeatsService.criteresPropres(dto.criteria)
      : ((metaActuelle['criteria'] as RequestReservationDto['criteria'] | null | undefined) ?? null);
    const vivante = resa.status !== VehicleEventStatus.DONE && resa.status !== VehicleEventStatus.CANCELLED;
    /**
     * Revue du 29/09 (C8) — « véhicule trop petit » : la règle de `request()` tient aussi à l'édition.
     * « 8 places min. » déplacée sur un 4 places, ou « Places min. » montée à 12 sur un 9 places,
     * répondait 200 : la réservation annonçait 8 places dans une voiture de 4 (la feuille l'affichait,
     * sans que rien ne le refuse). Contrôlé AVANT la scission (retour anticipé, plus bas) : un seul
     * appel couvre l'édition, la scission lancée depuis l'édition et `reaffecter()` non scindé.
     * On compare les VALEURS, pas la présence des champs : la feuille renvoie toujours `criteria`, et
     * une réservation ancienne déjà incohérente doit rester modifiable (motif, titre, créneau) tant
     * qu'on ne touche ni au véhicule ni au plancher. Jamais en rétroactif (on consigne ce qui a roulé),
     * jamais une réservation close ; places inconnues : pas de refus (cf. `assertAssezDePlaces`).
     */
    if (vivante && !isRetro) {
      const minAvant = this.sanitizeCriteria(metaActuelle['criteria'] as RequestReservationDto['criteria']).minSeats;
      const minApres = this.sanitizeCriteria(criteresApres ?? undefined).minSeats;
      if (vehicleChanged || minApres !== minAvant) await this.assertAssezDePlaces(targetVehicleId, minApres);
    }
    let metaApres: Record<string, unknown> | null = null;
    if (dto.reason !== undefined || dto.criteria !== undefined || dto.group !== undefined) {
      metaApres = {
        ...metaActuelle,
        ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
        ...(dto.criteria !== undefined ? { criteria: criteresApres } : {}),
        // Un objet remplace, `null` retire ; absent, on ne touche à rien (même si le véhicule change).
        ...(dto.group !== undefined ? { group: await this.groupePropre(resa.fleetId, dto.group) } : {}),
      };
      data.metadata = metaApres as Prisma.InputJsonValue;
    }

    const blocking = resa.status === VehicleEventStatus.CONFIRMED || resa.status === VehicleEventStatus.IN_PROGRESS;
    /**
     * Changer le véhicule d'une réservation ferme DÉJÀ COMMENCÉE (revue du 29/09, C6) : la matinée
     * qu'elle a roulée sur l'ancien véhicule reste à lui, seule la suite passe sur le nouveau — la
     * même scission que « Réaffecter ». Sans ça, la ligne entière changeait de plaque et l'historique
     * disait que le nouveau véhicule était réservé pendant que l'ancien roulait.
     */
    const coupe = debutDeMinute(maintenant);
    if (
      vehicleChanged && blocking && !isRetro && !debutChange && end &&
      coupe.getTime() > resa.startAt.getTime() && end.getTime() > coupe.getTime()
    ) {
      return this.scinder(user, resa, targetVehicleId, coupe, {
        fin: end,
        title: data.title as string | undefined,
        metadata: metaApres,
        criteres: criteresApres,
        silencieux: interne?.silencieux,
        lot: interne?.lot,
      });
    }

    // Réservation bloquante + (créneau OU véhicule change) → re-vérifier les conflits sur la CIBLE.
    if (blocking && (slotChanged || vehicleChanged) && end) {
      const conflicts = await this.findOverlaps(targetVehicleId, start, end, id);
      if (conflicts.length > 0) throw new ConflictException('Conflit sur le nouveau créneau.');
      // Rétroactif : le trajet réel / l'immobilisation passée sont attendus → on ne bloque pas dessus.
      // Sinon, seulement ce qui est À VENIR et NOUVEAU pour ce véhicule (C44) : les trajets qu'il a
      // faits depuis le début de CETTE réservation sont son usage, pas un conflit — y compris celui
      // qu'il est EN TRAIN de faire (contre-revue, R0 : la fenêtre contrôlée est toujours à venir, donc
      // seul un trajet ouvert pouvait y tomber, et c'était celui de la réservation qu'on prolonge).
      // Même véhicule et réservation commencée seulement : sur un autre véhicule, tout trajet compte.
      if (!isRetro) {
        const usagePropre = !vehicleChanged && resa.startAt.getTime() <= maintenant ? resa.startAt : undefined;
        for (const [a, b] of this.fenetresAControler(resa, start, end, vehicleChanged, maintenant)) {
          if (await this.hasTripOverlap(targetVehicleId, a, b, { ignorerDepuis: usagePropre })) {
            throw new ConflictException('Ce véhicule roule déjà sur le nouveau créneau.');
          }
          if ((await this.findImmobilized([targetVehicleId], a, b)).has(targetVehicleId)) {
            throw new ConflictException('Ce véhicule est immobilisé (incident ou maintenance) sur le nouveau créneau.');
          }
        }
      }
    }
    // Sièges auto : un créneau déplacé ou un besoin revu se re-vérifie contre le stock — pour une
    // réservation ferme comme pour une demande encore en attente (le valideur ne doit pas hériter
    // d'un refus). Une réservation close ne bouge plus ; une rétroactive n'engage plus rien. Jugé sur
    // la partie À VENIR (C44) : les heures écoulées n'engagent plus aucun siège du stock.
    if (vivante && !isRetro && end && (slotChanged || dto.criteria !== undefined || vehicleChanged)) {
      const debutUtile = start.getTime() >= maintenant ? start : new Date(maintenant);
      if (debutUtile.getTime() < end.getTime()) {
        await this.childSeats?.assertAvailable(
          resa.fleetId,
          debutUtile,
          end,
          ChildSeatsService.needOf(criteresApres),
          { vehicleId: targetVehicleId, excludeId: id, excludeBookingRef: this.bookingRefOf(resa.metadata) },
        );
      }
    }

    // Journal (29/09) : ce qui change VRAIMENT, comparé à la base — pas ce que le client a renvoyé.
    // La feuille d'édition renvoie critères et groupe à chaque enregistrement : sans cette comparaison,
    // un « Enregistrer » sans rien toucher écrirait « Réservation modifiée ».
    const changements = this.changementsDe(resa, {
      vehicleChanged,
      targetVehicleId,
      slotChanged,
      start,
      end,
      title: data.title as string | undefined,
      reason: dto.reason,
      groupe: dto.group !== undefined ? { apres: (metaApres?.['group'] as ReservationGroupDto | null | undefined) ?? null } : undefined,
      criteres: dto.criteria !== undefined ? { apres: criteresApres } : undefined,
    });

    try {
      const row = await this.prisma.vehicleEvent.update({ where: { id }, data, include: INCLUDE_PLATE });
      const ecrite = this.toDto(row);
      // Silencieux : la réorganisation prévient une fois par demande groupée, après sa boucle (R3).
      if (!interne?.silencieux && !isRetro && (vehicleChanged || slotChanged)) this.annoncerModification(resa.status, ecrite);
      this.tracerModification(user, resa, row, changements, interne);
      return ecrite;
    } catch (err) {
      if (this.isExclusionConflict(err)) {
        throw new ConflictException('Conflit : créneau déjà réservé.');
      }
      throw err;
    }
  }

  /**
   * Journal (29/09) — ce qu'une écriture de `update()` change VRAIMENT par rapport à la base. Vide =
   * rien à journaliser (un « Enregistrer » qui renvoie les mêmes valeurs n'est pas une modification).
   */
  private changementsDe(
    resa: EventRow,
    x: {
      vehicleChanged: boolean;
      targetVehicleId: string;
      slotChanged: boolean;
      start: Date;
      end: Date | null;
      title: string | undefined;
      reason: unknown;
      groupe?: { apres: ReservationGroupDto | null };
      criteres?: { apres: RequestReservationDto['criteria'] | null };
    },
  ): Changements {
    const meta = (resa.metadata as Record<string, unknown> | null) ?? {};
    const out: Changements = {};
    if (x.vehicleChanged) out.vehicule = { avant: resa.vehicleId, apres: x.targetVehicleId };
    if (x.slotChanged) {
      out.creneau = { avant: { debut: resa.startAt, fin: resa.endAt }, apres: { debut: x.start, fin: x.end } };
    }
    if (x.title !== undefined && x.title !== resa.title) out.titre = { avant: resa.title, apres: x.title };
    if (x.reason !== undefined) {
      const avant = typeof meta['reason'] === 'string' ? (meta['reason'] as string).trim() : '';
      const apres = typeof x.reason === 'string' ? x.reason.trim() : '';
      if (avant !== apres) out.motif = { avant: avant || null, apres: apres || null };
    }
    if (x.groupe) {
      const avant = ReservationsService.groupeDe(meta);
      const apres = x.groupe.apres;
      if ((avant?.id ?? null) !== (apres?.id ?? null) || (avant?.name ?? '') !== (apres?.name ?? '')) {
        out.groupe = { avant, apres };
      }
    }
    if (x.criteres) {
      // Les deux côtés passent par la même mise au propre : l'ordre des clés est le même, un `{}` vaut null.
      const avant = ChildSeatsService.criteresPropres(meta['criteria'] as RequestReservationDto['criteria']);
      const apres = ChildSeatsService.criteresPropres(x.criteres.apres ?? null);
      if (JSON.stringify(avant) !== JSON.stringify(apres)) out.criteres = { avant, apres };
    }
    return out;
  }

  /**
   * Journal (29/09) — UNE ligne par écriture de `update()`, et seulement si quelque chose a changé :
   *  - appelée par `reaffecter()` (motif `reaffectation`) : « Réservation réaffectée », véhicule A → B ;
   *  - appelée par Réorganiser → Décaler (motif `decalage`) : « Réservation décalée » ;
   *  - sinon (feuille d'édition) : « Réservation modifiée », avec avant → après champ par champ.
   * Une scission n'arrive pas ici : `scinder()` écrit sa propre ligne.
   */
  private tracerModification(
    user: AuthUser,
    resa: EventRow,
    row: EventRow,
    ch: Changements,
    interne?: OptionsInternes,
  ): void {
    const champs = Object.keys(ch) as (keyof Changements)[];
    if (champs.length === 0) return;
    const action: ActionJournal =
      interne?.motif === 'reaffectation' && ch.vehicule
        ? 'reservation_reaffectee'
        : interne?.motif === 'decalage' && ch.creneau
          ? 'reservation_decalee'
          : 'reservation_modifiee';
    this.journaliser(action, user, () => {
      const plaqueAvant = resa.vehicle?.plate ?? null;
      const plaque = row.vehicle?.plate ?? plaqueAvant;
      const morceaux: string[] = [];
      if (ch.vehicule) morceaux.push(`véhicule ${plaqueAvant ?? '?'} → ${plaque ?? '?'}`);
      if (ch.creneau) {
        morceaux.push(
          `créneau ${creneauParis(ch.creneau.avant.debut, ch.creneau.avant.fin)} devient ${creneauParis(ch.creneau.apres.debut, ch.creneau.apres.fin)}`,
        );
      }
      // Un titre qui ne fait que suivre le motif (T13) ne se dit pas deux fois.
      const titreSuitMotif = !!ch.motif && !!ch.titre && ch.titre.apres === (ch.motif.apres ?? 'Réservation');
      if (ch.titre && !titreSuitMotif) morceaux.push(`titre ${cite(ch.titre.avant)} → ${cite(ch.titre.apres)}`);
      if (ch.motif) morceaux.push(`motif ${cite(ch.motif.avant)} → ${cite(ch.motif.apres)}`);
      if (ch.groupe) morceaux.push(`groupe ${ch.groupe.avant?.name ?? 'aucun'} → ${ch.groupe.apres?.name ?? 'aucun'}`);
      if (ch.criteres) morceaux.push(`critères ${decrireCriteres(ch.criteres.avant)} → ${decrireCriteres(ch.criteres.apres)}`);
      const quoi =
        action === 'reservation_reaffectee' ? 'Réservation réaffectée'
          : action === 'reservation_decalee' ? 'Réservation décalée'
            : 'Réservation modifiée';
      // Le créneau est toujours situé : dans le morceau « créneau » s'il a bougé, sinon en tête.
      const situe = ch.creneau ? '' : `, ${creneauParis(row.startAt, row.endAt)}`;
      const iso = (d: Date | null) => (d ? d.toISOString() : null);
      return {
        fleetId: resa.fleetId,
        plaque,
        detail: `${quoi} — ${plaque ?? 'véhicule inconnu'}${situe} : ${morceaux.join(' ; ')}`,
        meta: {
          reservationId: resa.id,
          vehicleId: row.vehicleId ?? resa.vehicleId,
          bookingRef: this.bookingRefOf(resa.metadata),
          parUtilisateur: user.id,
          champs,
          avant: {
            ...(ch.vehicule ? { vehicleId: ch.vehicule.avant, plaque: plaqueAvant } : {}),
            ...(ch.creneau ? { startAt: iso(ch.creneau.avant.debut), endAt: iso(ch.creneau.avant.fin) } : {}),
            ...(ch.titre ? { title: ch.titre.avant } : {}),
            ...(ch.motif ? { reason: ch.motif.avant } : {}),
            ...(ch.groupe ? { group: ch.groupe.avant } : {}),
            ...(ch.criteres ? { criteria: ch.criteres.avant } : {}),
          },
          apres: {
            ...(ch.vehicule ? { vehicleId: ch.vehicule.apres, plaque } : {}),
            ...(ch.creneau ? { startAt: iso(ch.creneau.apres.debut), endAt: iso(ch.creneau.apres.fin) } : {}),
            ...(ch.titre ? { title: ch.titre.apres } : {}),
            ...(ch.motif ? { reason: ch.motif.apres } : {}),
            ...(ch.groupe ? { group: ch.groupe.apres } : {}),
            ...(ch.criteres ? { criteria: ch.criteres.apres } : {}),
          },
          ...(interne?.lot ? { lot: interne.lot } : {}),
        },
      };
    });
  }

  /**
   * Les fenêtres où re-vérifier trajets et immobilisations sur la cible, bornées au FUTUR (C44) :
   *  - véhicule changé : toute la partie à venir du créneau ;
   *  - même véhicule : seulement ce que le nouveau créneau AJOUTE à l'ancien (avancée du début,
   *    prolongation de la fin). Raccourcir ne crée aucun conflit ; et ce que le véhicule a fait
   *    pendant cette réservation est l'usage de la réservation elle-même.
   */
  private fenetresAControler(
    resa: { startAt: Date; endAt: Date | null },
    start: Date,
    end: Date,
    vehicleChanged: boolean,
    maintenant: number,
  ): [Date, Date][] {
    const borne = (a: number, b: number): [Date, Date][] => {
      const debut = Math.max(a, maintenant);
      return debut < b ? [[new Date(debut), new Date(b)]] : [];
    };
    if (vehicleChanged || !resa.endAt) return borne(start.getTime(), end.getTime());
    return [
      ...(start.getTime() < resa.startAt.getTime()
        ? borne(start.getTime(), Math.min(end.getTime(), resa.startAt.getTime()))
        : []),
      ...(end.getTime() > resa.endAt.getTime()
        ? borne(Math.max(start.getTime(), resa.endAt.getTime()), end.getTime())
        : []),
    ];
  }

  /**
   * C5 (revue du 29/09) — LE DEMANDEUR PUBLIC APPREND QUE SA RÉSERVATION A CHANGÉ.
   *
   * Sa confirmation nommait « AA-111-BB » ; le véhicule part au garage, la réservation passe sur un
   * autre, et personne ne lui écrivait : il se présentait pour une voiture au garage. Émis d'UN seul
   * endroit par écriture (update, ou la scission), jamais par `reaffecter` en plus — un seul courriel ;
   * et une seule fois par DEMANDE pour un geste de masse (`reorganiser`, contre-revue R3).
   *
   * Seulement une réservation CONFIRMÉE issue du lien public : une demande encore en attente recevra
   * la confirmation avec les bonnes données ; une réservation en cours, le demandeur a déjà la voiture.
   * Un événement DÉDIÉ, pas `reservation.confirmed` : l'agent d'agenda écoute celui-là pour son ménage.
   *
   * Contre-revue du 29/09 (R4) : rien non plus pour une réservation TERMINÉE — close, annulée, ou
   * simplement finie (une réservation n'est jamais passée à DONE : celle d'hier reste CONFIRMED et
   * éditable). Corriger après coup le véhicule réellement utilisé écrivait au demandeur « votre
   * réservation a été modifiée » pour une sortie finie depuis la veille. La suite d'une scission finit
   * toujours dans le futur : elle n'est pas touchée.
   *
   * `statutAvant` : le statut AVANT l'écriture (c'est lui qui dit « déjà confirmée ») ; `apres` : la
   * ligne écrite, celle que le demandeur doit connaître.
   */
  private annoncerModification(statutAvant: VehicleEventStatus | string, apres: VehicleEventDto): void {
    if (statutAvant !== VehicleEventStatus.CONFIRMED) return;
    if (apres.status === VehicleEventStatus.DONE || apres.status === VehicleEventStatus.CANCELLED) return;
    if (apres.endAt && new Date(apres.endAt).getTime() <= Date.now()) return;
    const meta = apres.metadata ?? null;
    if (meta?.['public'] !== true) return;
    this.emitter?.emit('reservation.modified', {
      fleetId: apres.fleetId,
      vehiclePlate: apres.vehiclePlate ?? null,
      startAt: apres.startAt,
      endAt: apres.endAt,
      status: apres.status,
      metadata: meta,
    });
  }

  /** Liste des réservations (scopée). Délègue au scoping/mapping S7. Perm reservations_view. */
  async list(
    user: AuthUser,
    filters: {
      from: Date;
      to: Date;
      status?: VehicleEventStatus;
      vehicleId?: string;
      groupId?: string;
      /** Filtre société du bandeau (SUPER_ADMIN) ; ignoré pour les autres rôles, bornés par leur flotte. */
      fleetId?: string;
    },
  ): Promise<VehicleEventDto[]> {
    return this.events.list(user, {
      from: filters.from,
      to: filters.to,
      type: VehicleEventType.RESERVATION,
      status: filters.status,
      vehicleId: filters.vehicleId,
      groupId: filters.groupId,
      fleetId: filters.fleetId,
    });
  }

  /**
   * ── LOT 3C (2026-09-23) — REPRENDRE UN LOT DE RÉSERVATIONS ──────────────────────────────────
   *
   * ┌─ POURQUOI CE GESTE EXISTE ────────────────────────────────────────────────┐
   * │ L'agent avait posé 108 réservations à venir sur 21 véhicules de cdef31.   │
   * │ Les reprendre une par une, par la feuille d'édition, n'est pas tenable —   │
   * │ et sur un téléphone, encore moins. La réorganisation demandait donc un    │
   * │ geste de masse ; elle n'en avait aucun.                                    │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * QUATRE GARDE-FOUS, parce qu'un geste de masse se trompe en masse :
   *
   *  1. **SIMULATION par défaut.** `simulation !== false` ne touche rien et rend le même
   *     compte-rendu. C'est la discipline du DRY-RUN de la rétention (Sprint 6) : on montre ce
   *     qui va se passer avant de le faire, et l'écran ouvre là-dessus.
   *  2. **À VENIR seulement.** Annuler ou décaler une réservation passée ne libère rien et
   *     réécrit de l'historique. La borne basse est `max(from, maintenant)`. Seule exception
   *     (revue du 29/09) : « réaffecter » reprend toute réservation qui CHEVAUCHE la fenêtre,
   *     parce qu'il la scinde à cette borne (contre-revue, R2) — la partie d'avant reste sur son
   *     véhicule, l'historique n'est pas réécrit.
   *  2 bis. **Le lot appliqué est celui qu'on a vu** (`attendu`, contre-revue du 29/09) : si le lot
   *     recalculé n'a plus le nombre annoncé par la simulation, 409 et rien n'est écrit.
   *  2 ter. **Liste blanche** (`ids`, troisième relecture du 29/09, T3) : présente, le lot ne garde
   *     QUE ces réservations — filtré avant le plafond, l'aperçu et `attendu`. C'est le renvoi depuis
   *     le formulaire d'immobilisation : seules les réservations refusées y sont reprises, jamais
   *     celles que le gestionnaire a choisi de « Laisser », ni celles arrivées depuis.
   *  3. **Plafond de {@link MAX_REORGANISATION}.** Au-delà, on tronque et on le DIT (`plafonne`) :
   *     un lot silencieusement incomplet serait pire qu'un refus.
   *  4. **Chaque refus est nommé.** Un décalage qui tomberait sur un créneau occupé est rendu
   *     avec sa plaque et son motif — jamais un total qui ne correspond pas au constat. Un refus
   *     CERTAIN (une demande en attente qui déborde sur la coupe de « réaffecter », T4) est rendu dès
   *     la simulation, avec le même motif qu'à l'application ; `concernees` reste le lot entier (c'est
   *     le contrat d'`attendu`), l'écran annonce `concernees − refusees`.
   *
   * Le périmètre passe par `events.list`, donc par la chaîne de scoping anti-IDOR habituelle :
   * aucune réservation hors du périmètre de l'appelant ne peut entrer dans le lot.
   */
  /**
   * ── RÉAFFECTER UNE RÉSERVATION (refonte UX du 28/09, point 4) ──────────────────────────────
   *
   * Le geste qui manquait à la réorganisation : un véhicule part au garage, ses réservations
   * passent sur un autre. Cible explicite (`versVehicleId`), ou `auto` : le premier véhicule libre
   * et conforme aux critères de LA réservation (places, sièges auto, équipements), jamais le véhicule
   * d'origine. Pour une réservation à venir, conflits, hors service, sièges et groupe sont ce que
   * `update()` vérifie déjà : une seule règle, un seul endroit.
   *
   * Revue du 29/09 — ce que « déjà vérifié par update() » laissait passer :
   *  - D1 : il faut GÉRER les réservations du véhicule d'origine ET de la cible (droit par véhicule,
   *    comme `request()` qui en fait dépendre CONFIRMED ou REQUESTED) ; en `auto`, le premier
   *    candidat que l'appelant gère — pas une voiture d'un groupe où il ne peut que demander ;
   *  - C0 : une demande publique ne porte pas `minSeats`, seulement `seatsNeeded` → plancher de places ;
   *  - C1 : `update()` ne contrôle les conflits que d'une réservation FERME → une demande en attente
   *    est contrôlée ici, et jamais posée sur le véhicule d'une autre ligne de la même demande ;
   *  - C2 : en `auto`, le stock de sièges se lit sans le besoin de la réservation elle-même ;
   *  - C6 : une réservation DÉJÀ COMMENCÉE est scindée — le passé reste sur son véhicule.
   *
   * Contre-revue du 29/09 (R2) — la coupe n'est plus toujours « maintenant ». Une maintenance déclarée
   * lundi pour jeudi scindait lundi 14:00 la réservation lundi → vendredi : A paraissait libre (et
   * réservable) trois jours pendant que le conducteur en gardait les clés, B réservé sans rouler.
   * `aPartirDe` dit quand le véhicule d'origine cesse d'être disponible ; la coupe est
   * max(maintenant, aPartirDe), à la minute :
   *  - la réservation CHEVAUCHE la coupe (début < coupe < fin) → SCINDÉE là : la partie d'avant reste
   *    sur son véhicule, la suite part sur la cible, contrôlée sur [coupe, fin) seulement ;
   *  - elle commence à la coupe ou après → elle part EN ENTIER ;
   *  - elle finit avant la coupe → elle n'est pas concernée (400) ;
   *  - une demande jamais validée qui chevauche la coupe se refuse : elle n'a pas de « suite » ferme.
   *
   * `interne` : options de la réorganisation (courriel groupé) — le contrôleur n'en passe aucune.
   */
  async reaffecter(
    user: AuthUser,
    id: string,
    dto: ReaffecterReservationDto = {},
    interne?: OptionsInternes,
  ): Promise<VehicleEventDto> {
    const resa = await this.loadScoped(user, id);
    if (resa.status === VehicleEventStatus.DONE || resa.status === VehicleEventStatus.CANCELLED) {
      throw new BadRequestException('Une réservation terminée ou annulée ne se réaffecte pas.');
    }
    if (!resa.endAt) throw new BadRequestException('Réservation sans créneau de fin.');
    const fin = resa.endAt;
    const maintenant = Date.now();
    if (fin.getTime() < maintenant) throw new BadRequestException('Une réservation passée ne se réaffecte pas.');

    // R2 — à partir de quand le véhicule d'origine n'est plus disponible. Absent = maintenant.
    let indisponibleDes = maintenant;
    if (dto?.aPartirDe !== undefined && dto?.aPartirDe !== null && dto?.aPartirDe !== '') {
      const t = typeof dto.aPartirDe === 'string' ? Date.parse(dto.aPartirDe) : Number.NaN;
      if (Number.isNaN(t)) throw new BadRequestException('« aPartirDe » invalide : une date ISO est attendue.');
      indisponibleDes = Math.max(maintenant, t);
    }
    // Coupe à la minute (l'écran raisonne à la minute).
    const coupe = debutDeMinute(indisponibleDes);
    if (fin.getTime() <= coupe.getTime()) {
      throw new BadRequestException(
        'Cette réservation se termine avant que le véhicule ne devienne indisponible : rien à reprendre.',
      );
    }

    // D1 — déplacer la réservation de quelqu'un, c'est GÉRER les réservations de CE véhicule.
    await this.exigerGestion(user, resa.vehicleId, this.messageOrigineNonGeree(resa));

    // C6 / R2 — la réservation déborde-t-elle sur la coupe ? Une demande jamais validée n'a pas de
    // « suite » ferme à reprendre : elle se valide ou se refuse (la suite d'une scission est CONFIRMÉE).
    // Même règle que l'annonce de `reorganiser()` en simulation (T4).
    const chevauche = resa.startAt.getTime() < coupe.getTime(); // fin > coupe, acquis plus haut
    const refusDemande = motifDemandeNonReaffectable(resa.status, resa.startAt.getTime(), maintenant, coupe.getTime());
    if (refusDemande) throw new BadRequestException(refusDemande);
    // Une réservation commencée dans la minute en cours (début ≥ coupe) se déplace en entier.
    const aScinder = chevauche;
    const debut = aScinder ? coupe : resa.startAt;

    // C1 — les véhicules qui portent déjà une ligne vivante de la MÊME demande sur le créneau.
    const soeurs = await this.vehiculesDeSoeurs(resa, debut, fin);

    const voulu = typeof dto?.versVehicleId === 'string' ? dto.versVehicleId.trim() : '';
    let cible = voulu && voulu !== 'auto' ? voulu : null;
    if (cible) {
      if (cible === resa.vehicleId) {
        throw new BadRequestException('La réservation est déjà sur ce véhicule.');
      }
      await this.cibleDeLaMemeSociete(user, resa, cible); // accès d'abord : rien à dire d'un véhicule hors périmètre
      await this.exigerGestion(user, cible, MESSAGE_CIBLE_NON_GEREE);
      if (soeurs.has(cible)) {
        throw new ConflictException('Ce véhicule porte déjà une autre ligne de la même demande sur ce créneau.');
      }
      /**
       * C8 (revue du 29/09) — une cible CHOISIE plus petite que le plancher SAISI : 400, comme
       * `request()` et `update()`. Ici et pas seulement dans `update()` : la scission appelle `scinder()`
       * sans passer par lui. Le plancher DÉRIVÉ de `criteresDeReaffectation` (places du véhicule
       * d'origine, `seatsNeeded`) n'est PAS utilisé : il borne la recherche automatique, il n'interdit
       * pas un choix humain — trois personnes réservées sur un 9 places, sans « Places min. », passent
       * à la main sur un 5 places. Jamais en rétroactif (même règle qu'`update()`).
       */
      const metaResa = (resa.metadata as { criteria?: RequestReservationDto['criteria']; retroactive?: unknown } | null) ?? null;
      if (metaResa?.retroactive !== true) {
        await this.assertAssezDePlaces(cible, this.sanitizeCriteria(metaResa?.criteria).minSeats);
      }
    } else {
      const { criteres, minSeats } = await this.criteresDeReaffectation(resa);
      const sug = await this.suggest(
        user,
        { startAt: debut.toISOString(), endAt: fin.toISOString(), criteria: criteres, fleetId: resa.fleetId },
        { excludeId: resa.id, excludeBookingRef: this.bookingRefOf(resa.metadata) },
      );
      const libres = sug.vehicles.filter((v) => v.vehicleId !== resa.vehicleId && !soeurs.has(v.vehicleId));
      for (const v of libres) {
        if (await this.permissions.canOnVehicle(user, v.vehicleId, 'reservations_manage')) {
          cible = v.vehicleId;
          break;
        }
      }
      if (!cible) throw new ConflictException(this.motifAucunCandidat(sug, libres.length, minSeats));
    }

    if (aScinder) return this.scinder(user, resa, cible, coupe, { fin, silencieux: interne?.silencieux, lot: interne?.lot });
    // C1 — une demande EN ATTENTE : `update()` ne contrôle que les réservations fermes. Mêmes
    // contrôles que `request()` et `confirm()`, sinon la demande atterrit sur un véhicule pris et le
    // valideur hérite d'un refus (« Validé 1 sur 2 »).
    if (resa.status === VehicleEventStatus.REQUESTED) await this.controlerCible(cible, resa.startAt, fin, resa.id);
    // Journal : `update()` écrit UNE ligne « réaffectée » (véhicule A → B), pas un « modifiée » générique.
    return this.update(user, id, { vehicleId: cible }, { ...interne, motif: 'reaffectation' });
  }

  /**
   * D1 / R1 — le droit de GÉRER se lit PAR véhicule (`reservations_manage` résolu sur son groupe).
   * Une seule règle pour tous les chemins qui ÉCRIVENT une réservation existante : `update()` (feuille
   * d'édition, scission comprise, dès qu'un champ change), `reaffecter()`, `confirm()` et `cancel()`
   * (troisième relecture du 29/09, T1 : valider, annuler et modifier sur place ne lisaient que
   * l'union des droits).
   */
  private async exigerGestion(user: AuthUser, vehicleId: string, message: string): Promise<void> {
    if (!(await this.permissions.canOnVehicle(user, vehicleId, 'reservations_manage'))) {
      throw new ForbiddenException(message);
    }
  }

  /** « Vous ne gérez pas les réservations de AA-111-BB : vous ne pouvez pas les <verbe>. » */
  private messageNonGeree(
    resa: { vehicle?: { plate: string | null } | null },
    verbe: 'déplacer' | 'valider' | 'annuler' | 'modifier',
  ): string {
    return `Vous ne gérez pas les réservations de ${resa.vehicle?.plate ?? 'ce véhicule'} : vous ne pouvez pas les ${verbe}.`;
  }

  /** « Vous ne gérez pas les réservations de AA-111-BB… » — le véhicule d'ORIGINE nommé. */
  private messageOrigineNonGeree(resa: { vehicle?: { plate: string | null } | null }): string {
    return this.messageNonGeree(resa, 'déplacer');
  }

  /** Refuse (400) un véhicule d'une autre société que la réservation ; 403/404 hors périmètre. */
  private async cibleDeLaMemeSociete(user: AuthUser, resa: { fleetId: string }, vehicleId: string): Promise<void> {
    const fleetId = await this.events.assertVehicleAccess(user, vehicleId);
    if (fleetId !== resa.fleetId) throw new BadRequestException(AUTRE_SOCIETE);
  }

  /** Conflit ferme, trajet réel, immobilisation : ce qui rend une cible inutilisable sur [start,end). */
  private async controlerCible(vehicleId: string, start: Date, end: Date, excludeId: string): Promise<void> {
    if ((await this.findOverlaps(vehicleId, start, end, excludeId)).length > 0) {
      throw new ConflictException('Ce véhicule est déjà réservé sur ce créneau.');
    }
    if (await this.hasTripOverlap(vehicleId, start, end)) {
      throw new ConflictException('Ce véhicule roule déjà sur ce créneau.');
    }
    if ((await this.findImmobilized([vehicleId], start, end)).has(vehicleId)) {
      throw new ConflictException('Ce véhicule est immobilisé (incident ou maintenance) sur ce créneau.');
    }
  }

  /**
   * C1 — véhicules portant une AUTRE ligne vivante (en attente ou ferme) de la même demande groupée
   * (`bookingRef`) sur le créneau. Deux lignes d'une demande de 11 places sur le même véhicule, et la
   * validation groupée finissait en « Validé 1 sur 2 ».
   */
  private async vehiculesDeSoeurs(resa: EventRow, start: Date, end: Date): Promise<Set<string>> {
    const ref = this.bookingRefOf(resa.metadata);
    if (!ref) return new Set();
    const rows = await this.prisma.vehicleEvent.findMany({
      where: {
        fleetId: resa.fleetId,
        type: VehicleEventType.RESERVATION,
        id: { not: resa.id },
        status: { in: [...BLOCKING, VehicleEventStatus.REQUESTED] },
        startAt: { lt: end },
        endAt: { gt: start },
        metadata: { path: ['bookingRef'], equals: ref },
      },
      select: { vehicleId: true },
    });
    return new Set(rows.map((r) => r.vehicleId));
  }

  /**
   * C0 — les critères avec lesquels chercher un remplaçant. Le plancher de places, jamais écrit dans la
   * metadata (la réservation ne change pas, seule la recherche est bornée) :
   *  1. `criteria.minSeats` s'il a été saisi ;
   *  2. sinon, pour une demande PUBLIQUE, `min(seatsNeeded, places du véhicule d'origine)` : une
   *     demande sur un seul véhicule vaut `seatsNeeded` (le vivier du lien public a pris un véhicule
   *     assez grand) ; une demande répartie sur plusieurs vaut la part de CE véhicule ;
   *  3. sinon, les places du véhicule d'origine — le groupe ne tient pas dans moins.
   */
  private async criteresDeReaffectation(
    resa: EventRow,
  ): Promise<{ criteres: RequestReservationDto['criteria'] | undefined; minSeats: number | null }> {
    const meta = (resa.metadata as { criteria?: unknown; public?: unknown; seatsNeeded?: unknown } | null) ?? null;
    const criteres = {
      ...(meta?.criteria && typeof meta.criteria === 'object' ? (meta.criteria as Record<string, unknown>) : {}),
    } as NonNullable<RequestReservationDto['criteria']> & { minSeats?: unknown };
    const saisi = Math.floor(Number(criteres.minSeats));
    if (Number.isFinite(saisi) && saisi > 0) return { criteres, minSeats: saisi };

    const origine = await this.prisma.vehicle.findUnique({ where: { id: resa.vehicleId }, select: { seats: true } });
    const places = typeof origine?.seats === 'number' && origine.seats > 0 ? origine.seats : null;
    let plancher = places;
    if (meta?.public === true) {
      const besoin = Math.floor(Number(meta.seatsNeeded));
      if (Number.isFinite(besoin) && besoin > 0) plancher = places ? Math.min(besoin, places) : besoin;
    }
    if (plancher) criteres.minSeats = plancher;
    else delete criteres.minSeats;
    return { criteres: Object.keys(criteres).length > 0 ? criteres : undefined, minSeats: plancher };
  }

  /**
   * « Aucun remplaçant » qui dit POURQUOI : un plancher de places écarte les véhicules trop petits ou
   * dont le nombre de places n'est pas renseigné, et une exclusion ne doit jamais se lire comme un
   * agenda plein. Même constructeur que `request()` (29/09, « 12 places »), au « autre » près — plus
   * les véhicules libres que l'appelant ne gère pas (D1), qui n'existent que sur ce chemin.
   */
  private motifAucunCandidat(sug: SuggestReservationResultDto, sansDroit: number, minSeats: number | null): string {
    const contexte = this.contexteAucunVehicule(sug, minSeats);
    if (sansDroit === 0) return messageAucunVehicule({ ...contexte, autre: true });
    // Des véhicules libres ET conformes existent (ceux que l'appelant ne gère pas) : ils ont passé le
    // plancher de places ET les sièges auto. Ni la taille ni les sièges n'expliquent le refus —
    // « aucun véhicule d'au moins N places n'est libre » ou « aucun véhicule libre ne peut recevoir les
    // sièges auto » seraient faux (relecture du 29/09). Les écartés pour leurs sièges restent NOMMÉS, en
    // complément, comme le faisait le motif d'avant le constructeur.
    const sieges = contexte.excludedChildSeats ?? 0;
    const base = messageAucunVehicule({ ...contexte, excludedTooSmall: 0, excludedChildSeats: 0, autre: true });
    return (
      `${base} Hors de vos droits : ${sansDroit} véhicule(s) libre(s) dont vous ne gérez pas les réservations.` +
      (sieges > 0 ? ` (${sieges} autre(s) écarté(s) : sièges auto insuffisants.)` : '')
    );
  }

  /**
   * C6 (revue du 29/09) — SCINDER une réservation ferme déjà commencée.
   *
   * R va de 08:00 à 18:00 sur A ; à 12:00, A tombe en panne. Réaffecter R en entier réécrivait
   * l'histoire (B « réservé » le matin pendant que A roulait) et exigeait que B ait été libre aussi
   * les heures écoulées. Désormais : R reste sur A jusqu'à la coupe, et la SUITE — même titre, même
   * metadata (critères, groupe, `bookingRef`), `suiteDe` = R — part sur la cible, de la coupe à la
   * fin. Les deux écritures dans une transaction ; la contrainte EXCLUDE reste le dernier rempart.
   *
   * Les contrôles de la cible portent sur [coupe, fin) seulement. L'accès, la société et le droit de
   * gérer (origine ET cible) sont vérifiés par l'appelant, avant l'appel.
   *
   * Contre-revue du 29/09 (R2) : la coupe peut être FUTURE — le début d'une indisponibilité déclarée
   * pour jeudi. La réservation garde alors son véhicule jusqu'à jeudi, pas jusqu'à « maintenant ».
   */
  private async scinder(
    user: AuthUser,
    resa: EventRow,
    cible: string,
    coupe: Date,
    opts: {
      fin: Date;
      /** Nouveau titre (édition), appliqué aux deux parties. */
      title?: string;
      /** Nouvelle metadata (édition : motif, critères, groupe), appliquée aux deux parties. */
      metadata?: Record<string, unknown> | null;
      /** Critères de la suite, si l'édition les change. */
      criteres?: RequestReservationDto['criteria'] | null;
      /** R3 — la réorganisation prévient elle-même, une fois par demande groupée. */
      silencieux?: boolean;
      /** Journal — le geste de masse dont cette scission fait partie. */
      lot?: string;
    },
  ): Promise<VehicleEventDto> {
    const { fin } = opts;
    await this.assertEnService(cible);
    await this.controlerCible(cible, coupe, fin, resa.id);
    const metaOrigine = opts.metadata ?? (resa.metadata as Record<string, unknown> | null) ?? {};
    const criteres =
      opts.criteres !== undefined ? opts.criteres : ((metaOrigine['criteria'] as RequestReservationDto['criteria'] | null | undefined) ?? null);
    await this.childSeats?.assertAvailable(resa.fleetId, coupe, fin, ChildSeatsService.needOf(criteres), {
      vehicleId: cible,
      excludeId: resa.id,
      excludeBookingRef: this.bookingRefOf(resa.metadata),
    });

    let suite: EventRow;
    try {
      suite = await this.prisma.$transaction(async (tx) => {
        await tx.vehicleEvent.update({
          where: { id: resa.id },
          data: {
            endAt: coupe,
            ...(opts.title !== undefined ? { title: opts.title } : {}),
            ...(opts.metadata ? { metadata: opts.metadata as Prisma.InputJsonValue } : {}),
          },
        });
        return tx.vehicleEvent.create({
          data: {
            fleetId: resa.fleetId,
            vehicleId: cible,
            type: VehicleEventType.RESERVATION,
            // La suite n'a pas encore été prise en main : ferme, pas « en cours ».
            status: VehicleEventStatus.CONFIRMED,
            title: opts.title ?? resa.title,
            description: resa.description,
            startAt: coupe,
            endAt: fin,
            allDay: false,
            metadata: { ...metaOrigine, suiteDe: resa.id } as Prisma.InputJsonValue,
            // Même auteur, même source : l'origine (agent / public / manuelle) ne change pas en route.
            createdBy: resa.createdBy,
            source: resa.source,
          },
          include: INCLUDE_PLATE,
        });
      });
    } catch (err) {
      if (this.isExclusionConflict(err)) {
        throw new ConflictException('Conflit : ce créneau vient d’être réservé sur le véhicule visé (course concurrente).');
      }
      throw err;
    }
    this.journaliser('reservation_scindee', user, () => {
      const plaque = resa.vehicle?.plate ?? null;
      const plaqueSuite = suite.vehicle?.plate ?? null;
      return {
        fleetId: resa.fleetId,
        plaque,
        detail:
          `Réservation scindée — ${plaque ?? 'véhicule inconnu'} garde ${creneauParis(resa.startAt, coupe)}, ` +
          `la suite part sur ${plaqueSuite ?? 'véhicule inconnu'} (${creneauParis(coupe, fin)})`,
        meta: {
          reservationId: resa.id,
          suiteId: suite.id,
          vehicleId: resa.vehicleId,
          versVehicleId: cible,
          plaqueSuite,
          coupe: coupe.toISOString(),
          bookingRef: this.bookingRefOf(resa.metadata),
          parUtilisateur: user.id,
          ...(opts.lot ? { lot: opts.lot } : {}),
        },
      };
    });
    const ecrite = this.toDto(suite);
    if (!opts.silencieux) this.annoncerModification(resa.status, ecrite);
    return ecrite;
  }

  async reorganiser(user: AuthUser, dto: ReorganiserReservationsDto): Promise<ReorganisationResultDto> {
    const simulation = dto?.simulation !== false;
    const action = dto?.action;
    if (action !== 'annuler' && action !== 'decaler' && action !== 'reaffecter') {
      throw new BadRequestException('Action inconnue : « annuler », « decaler » ou « reaffecter ».');
    }
    const versVehicleId = typeof dto?.versVehicleId === 'string' && dto.versVehicleId.trim() ? dto.versVehicleId.trim() : 'auto';
    // Revue du 29/09 (D0) : « réaffecter » sans véhicule source passait TOUTES les réservations à
    // venir de la société (jusqu'à 500) sur « le premier véhicule libre » — un brassage du parc que
    // rien ne demandait, et des plaques fausses chez les conducteurs et les demandeurs publics. Le
    // geste, c'est « un véhicule part au garage » : il faut dire lequel.
    if (action === 'reaffecter' && !dto?.vehicleId) {
      throw new BadRequestException('Choisissez le véhicule à libérer.');
    }
    if (action === 'reaffecter' && versVehicleId !== 'auto' && dto?.vehicleId && versVehicleId === dto.vehicleId) {
      throw new BadRequestException('Le véhicule de destination est celui qu’on libère.');
    }
    const decalage = Math.trunc(Number(dto?.decalageMinutes ?? 0));
    if (action === 'decaler' && (!Number.isFinite(decalage) || decalage === 0)) {
      throw new BadRequestException('Préciser de combien de minutes décaler (positif ou négatif).');
    }
    // T3 — liste blanche. Absente (ou null) : aucun filtre. Présente : un tableau d'identifiants, borné
    // par le plafond ; VIDE, elle ne garde rien — jamais « vide = tout », qui rendrait le lot entier.
    let listeBlanche: Set<string> | null = null;
    if (dto?.ids !== undefined && dto?.ids !== null) {
      const ids: unknown = dto.ids;
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_REORGANISATION ||
        ids.some((x) => typeof x !== 'string' || !x.trim())
      ) {
        throw new BadRequestException('« ids » invalide : une liste d’identifiants de réservations est attendue.');
      }
      listeBlanche = new Set((ids as string[]).map((x) => x.trim()));
    }

    const from = new Date(dto?.from ?? '');
    const to = new Date(dto?.to ?? '');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to.getTime() <= from.getTime()) {
      throw new BadRequestException('Fenêtre invalide.');
    }
    // Garde 2 : jamais le passé. Un lot qui réécrit hier ne libère aucun véhicule.
    const debut = new Date(Math.max(from.getTime(), Date.now()));
    if (debut.getTime() >= to.getTime()) {
      throw new BadRequestException('La fenêtre est entièrement passée : rien à réorganiser.');
    }

    const origine = dto?.origine ?? 'auto';
    // Toute la fenêtre, TOUS les véhicules : les comptes par origine et par véhicule (pour l'écran)
    // se calculent avant les filtres ; le lot lui-même est filtré en mémoire juste après.
    const toutes = await this.events.list(user, {
      from: debut,
      to,
      type: VehicleEventType.RESERVATION,
      fleetId: dto?.fleetId,
    });

    const vivante = (e: VehicleEventDto) =>
      e.status !== VehicleEventStatus.DONE && e.status !== VehicleEventStatus.CANCELLED;
    /**
     * Contre-revue du 29/09 (R2) — DEUX périmètres, dits une fois pour toutes :
     *  - `chevauchantes` : toute réservation vivante qui CHEVAUCHE [debut, to), commencée avant `from`
     *    ou non. C'est le lot de « réaffecter » : chacune est reprise À PARTIR DE `debut` — scindée si
     *    elle déborde dessus (la partie d'avant reste sur son véhicule, l'historique n'est pas réécrit),
     *    en entier si elle commence après. C'est le cas du véhicule qui tombe en panne en pleine
     *    réservation, ou d'une maintenance jeudi sous une location lundi → vendredi. Une demande jamais
     *    validée qui déborde y figure aussi : elle revient en REFUS nommé (« validez-la ou refusez-la »)
     *    au lieu de disparaître de l'écran.
     *    C'est aussi ce que compte `parVehicule`, quelle que soit l'action : la liste où l'on choisit
     *    le véhicule à libérer doit montrer celui dont la seule réservation est en cours.
     *  - « annuler » et « décaler » : seulement ce qui COMMENCE dans la fenêtre — annuler ou décaler une
     *    réservation en cours réécrirait sa partie écoulée.
     */
    const chevauchantes = toutes.filter(
      (e) =>
        vivante(e) &&
        !!e.endAt &&
        new Date(e.endAt).getTime() > debut.getTime() &&
        new Date(e.startAt).getTime() < to.getTime(),
    );
    const vivantes =
      action === 'reaffecter'
        ? chevauchantes
        : toutes.filter((e) => vivante(e) && new Date(e.startAt).getTime() >= debut.getTime());
    const compter = (liste: VehicleEventDto[]) => {
      const t = { agent: 0, public: 0, manuelle: 0 };
      for (const e of liste) t[origineReservation(e)]++;
      return t;
    };
    const totaux = compter(vivantes);
    // C9 (revue du 29/09) : un véhicule choisi, l'écran doit pouvoir dire « rien de l'agent sur X ;
    // 3 saisies à la main » au lieu de « rien à venir sur X » — `totaux` couvre toute la société.
    const totauxVehicule = dto?.vehicleId ? compter(vivantes.filter((e) => e.vehicleId === dto.vehicleId)) : undefined;
    const retenueParOrigine = (e: VehicleEventDto): boolean => {
      // « auto » = l'agent seul ; une demande publique (SYSTEM elle aussi) n'en est pas.
      if (origine === 'auto') return origineReservation(e) === 'agent';
      if (origine === 'manuelle') return origineReservation(e) !== 'agent';
      return true;
    };
    // Par véhicule : les réservations qui CHEVAUCHENT la fenêtre, quelle que soit l'action (cf. plus haut).
    const parVehiculeMap = new Map<string, { vehicleId: string; plate: string | null; n: number }>();
    for (const e of chevauchantes.filter(retenueParOrigine)) {
      const v = parVehiculeMap.get(e.vehicleId);
      if (v) v.n++;
      else parVehiculeMap.set(e.vehicleId, { vehicleId: e.vehicleId, plate: e.vehiclePlate, n: 1 });
    }
    const parVehicule = [...parVehiculeMap.values()].sort((a, b) => (a.plate ?? '').localeCompare(b.plate ?? ''));

    // T3 : la liste blanche filtre ICI, avant le plafond, l'aperçu et `attendu` — la simulation et
    // l'application recalculent le même lot. Elle restreint, elle n'élargit jamais (origine, véhicule).
    const candidates = vivantes.filter(
      (e) =>
        retenueParOrigine(e) &&
        (!dto?.vehicleId || e.vehicleId === dto.vehicleId) &&
        (!listeBlanche || listeBlanche.has(e.id)),
    );

    const plafonne = candidates.length > MAX_REORGANISATION;
    const lot = candidates.slice(0, MAX_REORGANISATION);
    /**
     * Quatrième revue du 29/09 (C0) — les identifiants EXACTS du lot, rendus en simulation comme à
     * l'application. L'écran les renvoie en `ids` : la liste blanche ci-dessus fait alors le reste —
     * une réservation arrivée entre la simulation et le clic n'est pas dans `ids`, elle n'entre pas
     * dans le lot et n'est jamais écrite ; une réservation sortie du lot en fait baisser le nombre, et
     * `attendu` refuse (409) sans rien écrire.
     */
    const lotIds = lot.map((e) => e.id);
    const apercu = lot.slice(0, 8).map((e) => ({
      plate: e.vehiclePlate,
      startAt: e.startAt,
      endAt: e.endAt,
      source: e.source,
      origine: origineReservation(e),
      // T4 : l'écran n'annonce « scindée » qu'une réservation FERME — une demande se valide ou se refuse.
      status: e.status,
    }));
    const refusees: ReorganisationRefusDto[] = [];

    /**
     * T4 (troisième relecture du 29/09) — un refus CERTAIN s'annonce dès la simulation. Une demande
     * jamais validée qui déborde sur la coupe de « réaffecter » (ou déjà commencée) sera refusée par
     * `reaffecter()` : la simulation la comptait « réaffectée » et l'écran la disait « scindée ». La
     * MÊME règle (`motifDemandeNonReaffectable`, même coupe, même motif) sert aux deux temps : en
     * simulation elle remplit `refusees`, à l'application elle refuse la ligne sans l'écrire. Le lot
     * n'est pas réduit : `concernees` reste `lot.length`, sinon `attendu` ne correspondrait plus.
     */
    const coupeReaffectation = debutDeMinute(Math.max(Date.now(), debut.getTime())).getTime();
    /**
     * Relecture du 29/09 (C8 × T4) — vers un véhicule CHOISI, le refus « trop petit » de `reaffecter()`
     * est lui aussi certain dès la simulation : ni les places de la cible ni le plancher SAISI de la
     * ligne (`metadata.criteria.minSeats`) ne dépendent de l'occupation. Sans cette annonce, l'écran
     * comptait « 3 seront reprises » et l'application en refusait 2 : le lot partait à moitié, deux
     * lignes restant sur le véhicule qui part au garage. Même phrase (`motifPlacesInsuffisantes`), même
     * exception qu'à l'écriture : jamais en rétroactif, rien si les places sont inconnues, rien pour une
     * ligne d'une autre société (cf. `placesDeLaCibleChoisie`). Le plancher DÉRIVÉ n'entre pas en compte,
     * comme dans `reaffecter()`.
     */
    const placesCible =
      action === 'reaffecter' && versVehicleId !== 'auto' && lot.length > 0
        ? await this.placesDeLaCibleChoisie(user, versVehicleId)
        : null;
    const refusCertain = (e: VehicleEventDto): string | null => {
      if (action !== 'reaffecter') return null;
      const demande = motifDemandeNonReaffectable(e.status, Date.parse(e.startAt), Date.now(), coupeReaffectation);
      if (demande) return demande; // `reaffecter()` le lève avant de regarder la cible
      if (!placesCible || e.fleetId !== placesCible.fleetId) return null;
      const meta = (e.metadata as { criteria?: RequestReservationDto['criteria']; retroactive?: unknown } | null | undefined) ?? null;
      if (meta?.retroactive === true) return null;
      return motifPlacesInsuffisantes(placesCible.plate, placesCible.seats, this.sanitizeCriteria(meta?.criteria).minSeats);
    };

    if (simulation) {
      for (const e of lot) {
        const motif = refusCertain(e);
        if (motif) refusees.push({ plate: e.vehiclePlate, startAt: e.startAt, motif });
      }
      return {
        simulation: true, concernees: lot.length, appliquees: 0, refusees, apercu, plafonne, totaux,
        ...(totauxVehicule ? { totauxVehicule } : {}),
        parVehicule,
        lotIds,
      };
    }

    /**
     * Contre-revue du 29/09 — on n'applique QUE le lot que la simulation a montré. Le lot est recalculé
     * au moment d'écrire : si des demandes sont arrivées par le lien public (ou des réservations ont
     * commencé) entre la simulation et le clic, « Annuler ces 3 réservations » en aurait annulé 5, dont
     * deux que personne n'a vues — et envoyé leurs courriels de refus. Rien n'est écrit : on relance.
     */
    if (dto?.attendu !== undefined && dto?.attendu !== null && Number(dto.attendu) !== lot.length) {
      throw new ConflictException('La liste a changé depuis la simulation : relancez-la.');
    }

    /**
     * Contre-revue du 29/09 (R3) — UN courriel « modifiée » par demande, pas un par ligne. Une demande
     * publique de 11 personnes tient sur deux lignes (même `bookingRef`) : décaler le lot envoyait deux
     * courriels identiques — le F13 revenu par l'événement de modification. Chaque écriture se fait en
     * silence ; on retient une ligne écrite de chaque demande (sinon de chaque réservation) — la
     * dernière écrite, qui en décalage vers l'avant est la plus tôt (T0) : le notifier relit l'état du
     * groupe en base, la ligne ne sert qu'à le désigner —, et l'on prévient après la boucle, quand
     * toutes les lignes sont à leur place : le courriel décrit l'état final du groupe. Seule une
     * réservation publique DÉJÀ CONFIRMÉE avant le geste compte (statut lu dans le lot, AVANT
     * l'écriture), comme pour une écriture unitaire.
     */
    const aPrevenir = new Map<string, VehicleEventDto>();
    /**
     * T2 (troisième relecture du 29/09) — même règle pour « annuler » : UN événement par demande. Une
     * ligne publique CONFIRMÉE annoncée « annulée » l'emporte sur une ligne en attente « refusée » de la
     * même demande — sinon le demandeur recevait « non retenue » puis « annulée » pour une seule demande.
     */
    const aPrevenirAnnulation = new Map<string, { verbe: 'annulation' | 'refus'; ligne: VehicleEventDto }>();
    const aPartirDe = debut.toISOString();
    /**
     * T0 (troisième relecture du 29/09) — l'ORDRE D'ÉCRITURE d'un décalage. Le lot sort trié par début
     * croissant ; décalées dans cet ordre de +90 min, deux réservations fermes collées du même véhicule
     * se bloquaient : la première visait le créneau de la seconde, pas encore déplacée → 409 « Conflit
     * sur le nouveau créneau », lot à moitié appliqué, et un motif faux. Vers l'avant, on écrit donc la
     * plus TARDIVE d'abord ; vers l'arrière, la plus tôt d'abord : chaque ligne ne rencontre que des
     * voisines déjà parties. Un refus qui reste est un vrai conflit. L'aperçu, `attendu` et les comptes
     * gardent l'ordre du lot : seule l'écriture change d'ordre.
     */
    const ordreEcriture =
      action === 'decaler'
        ? [...lot].sort((a, b) => Math.sign(decalage) * (Date.parse(b.startAt) - Date.parse(a.startAt)))
        : lot;
    /**
     * Journal (29/09) — un identifiant de LOT, porté par chaque ligne unitaire (annulée, refusée,
     * réaffectée, scindée, décalée) et par les résumés : « ce que ce clic a fait » se relit d'un filtre.
     * Et UN résumé PAR SOCIÉTÉ présente dans le lot, compté ici : un super-admin en « Toutes les
     * sociétés » qui réorganise deux clients doit laisser une trace dans l'activité de CHACUN, sur
     * SES chiffres — pas une ligne orpheline (`fleetId` absent) ni les chiffres de l'autre.
     */
    const lotId = randomUUID();
    const parSociete = new Map<string | null, { concernees: number; appliquees: number; refusees: number; plaques: Set<string> }>();
    const compteSociete = (e: VehicleEventDto) => {
      const cle = e.fleetId ?? null;
      let s = parSociete.get(cle);
      if (!s) {
        s = { concernees: 0, appliquees: 0, refusees: 0, plaques: new Set() };
        parSociete.set(cle, s);
      }
      return s;
    };
    for (const e of lot) {
      const s = compteSociete(e);
      s.concernees++;
      if (e.vehiclePlate) s.plaques.add(e.vehiclePlate);
    }
    const refuser = (e: VehicleEventDto, motif: string) => {
      refusees.push({ plate: e.vehiclePlate, startAt: e.startAt, motif });
      compteSociete(e).refusees++;
    };
    let appliquees = 0;
    for (const e of ordreEcriture) {
      try {
        let ecrite: VehicleEventDto | null = null;
        if (action === 'annuler') {
          const annulee = await this.cancel(user, e.id, { silencieux: true, lot: lotId });
          // Statut lu dans le lot, AVANT l'écriture : c'est lui qui dit « refusée » ou « annulée ».
          // Sa propre demande retirée (C4) : ni refus ni annulation à annoncer — même règle que `cancel()`.
          const verbe =
            e.status === VehicleEventStatus.REQUESTED
              ? estRetraitDeSaDemande(e.status, e.metadata, user.id) ? null : 'refus'
              : this.annulationAAnnoncer(e.status, e) ? 'annulation' : null;
          if (verbe) {
            const cle = this.bookingRefOf(e.metadata) ?? e.id;
            const deja = aPrevenirAnnulation.get(cle);
            if (!deja || verbe === 'annulation' || deja.verbe === 'refus') aPrevenirAnnulation.set(cle, { verbe, ligne: annulee });
          }
        } else if (action === 'reaffecter') {
          // T4 / C8 — la même règle qu'en simulation : un refus certain n'est pas tenté.
          const motif = refusCertain(e);
          if (motif) {
            refuser(e, motif);
            continue;
          }
          // R2 — la coupe est le début de la fenêtre, pas « maintenant » : une maintenance jeudi ne
          // retire pas lundi la voiture d'une location lundi → vendredi.
          ecrite = await this.reaffecter(user, e.id, { versVehicleId, aPartirDe }, { silencieux: true, lot: lotId });
        } else {
          const debutNouveau = new Date(new Date(e.startAt).getTime() + decalage * 60_000);
          const finNouvelle = e.endAt ? new Date(new Date(e.endAt).getTime() + decalage * 60_000) : null;
          if (!finNouvelle) {
            refuser(e, 'Réservation sans heure de fin.');
            continue;
          }
          if (debutNouveau.getTime() < Date.now()) {
            refuser(e, 'Le décalage la ferait passer dans le passé.');
            continue;
          }
          ecrite = await this.update(
            user,
            e.id,
            { startAt: debutNouveau.toISOString(), endAt: finNouvelle.toISOString() },
            { silencieux: true, motif: 'decalage', lot: lotId },
          );
        }
        appliquees++;
        compteSociete(e).appliquees++;
        const meta = (e.metadata as { public?: unknown; retroactive?: unknown } | null | undefined) ?? null;
        if (ecrite && e.status === VehicleEventStatus.CONFIRMED && meta?.public === true && meta.retroactive !== true) {
          aPrevenir.set(this.bookingRefOf(e.metadata) ?? e.id, ecrite);
        }
      } catch (err) {
        // Garde 4 : le motif REMONTE. Un conflit de créneau (EXCLUDE) ou un refus métier doit se
        // lire ligne par ligne — « 12 sur 108 » sans dire lesquelles ne s'explique pas.
        refuser(e, err instanceof Error ? err.message : 'Refus inattendu.');
      }
    }
    // Après la boucle : chaque demande prévenue une seule fois, sur son état final (R3, T2).
    for (const ecrite of aPrevenir.values()) this.annoncerModification(VehicleEventStatus.CONFIRMED, ecrite);
    for (const { verbe, ligne } of aPrevenirAnnulation.values()) {
      if (verbe === 'annulation') this.annoncerAnnulation(ligne);
      else this.annoncerRefus(ligne);
    }

    // UN résumé par société du lot (un lot vide n'a rien écrit : aucun résumé). Chacun porte les
    // chiffres de SA société ; `meta.lot` le relie à ses lignes unitaires.
    const geste =
      action === 'annuler' ? 'annulation'
        : action === 'decaler' ? `décalage de ${decalage > 0 ? '+' : ''}${decalage} min`
          : `réaffectation vers ${versVehicleId === 'auto' ? 'le premier véhicule libre' : 'un véhicule choisi'}`;
    for (const [fleetId, s] of parSociete) {
      this.journaliser('reservations_reorganisees', user, () => ({
        fleetId,
        // Un seul véhicule dans le lot de cette société (le cas « un véhicule part au garage ») : sa plaque.
        plaque: s.plaques.size === 1 ? [...s.plaques][0] : null,
        // `SKIPPED` quand au moins une ligne a été refusée : le journal ne connaît pas de « partiel »,
        // et dire `SUCCESS` sur un lot incomplet ferait passer un refus pour un succès.
        status: s.refusees > 0 ? 'SKIPPED' : 'SUCCESS',
        detail:
          `Réorganisation appliquée (${geste}, origine ${origine}, fenêtre ${creneauParis(debut, to)}) : ` +
          `${s.appliquees} reprise(s) sur ${s.concernees}, ${s.refusees} refus.`,
        meta: {
          lot: lotId,
          action,
          decalage,
          origine,
          vehicleId: dto?.vehicleId ?? null,
          versVehicleId: action === 'reaffecter' ? versVehicleId : null,
          from: debut.toISOString(),
          to: to.toISOString(),
          concernees: s.concernees,
          appliquees: s.appliquees,
          refusees: s.refusees,
          parUtilisateur: user.id,
        },
      }));
    }

    return {
      simulation: false, concernees: lot.length, appliquees, refusees, apercu, plafonne, totaux,
      ...(totauxVehicule ? { totauxVehicule } : {}),
      parVehicule,
      lotIds,
    };
  }

  // ─── Agent d'agenda (P3) : disponibilité + création système ────────────────

  /**
   * Le véhicule est-il ENGAGEABLE sur [start,end) ? (résa ferme + trajet réel + immobilisation
   * + boîtier qui parle encore).
   *
   * ⚠️ Ce prédicat n'a que des appelants d'ENGAGEMENT — `systemConfirm` juste en dessous et
   * l'agent d'agenda nocturne. Il ne sert nulle part à afficher une disponibilité. C'est pourquoi
   * la dormance a sa place ICI et pas seulement dans le vivier de suggestion : l'agent nocturne
   * NE PASSE PAS par le vivier (il applique un motif récurrent puis appelle directement ce
   * prédicat), donc sans cette 4ᵉ condition il pouvait poser une réservation FERME sur un véhicule
   * muet depuis 89 jours — la seule voie par laquelle un dormant continuait d'être engagé.
   *
   * Placé en DERNIER à dessein : les trois conflits ci-dessus disqualifient la plupart des
   * candidats sans requête supplémentaire ; on ne paie la lecture du boîtier que lorsqu'on est
   * réellement sur le point d'engager le véhicule (VPS à 2 vCPU).
   */
  async isVehicleFree(vehicleId: string, start: Date, end: Date): Promise<boolean> {
    if ((await this.findOverlaps(vehicleId, start, end)).length > 0) return false;
    if (await this.hasTripOverlap(vehicleId, start, end)) return false;
    if ((await this.findImmobilized([vehicleId], start, end)).has(vehicleId)) return false;
    // Seuil « arrêter de COMPTER » (7 j) : engager un véhicule n'est pas lui envoyer une commande.
    // Un véhicule SANS boîtier reste engageable — `isVehicleDormant` renvoie déjà false sans
    // trackerId, et beaucoup de flottes exploitent des véhicules non équipés.
    const veh = await this.prisma.vehicle
      .findUnique({
        where: { id: vehicleId },
        select: {
          outOfServiceReason: true,
          tracker: { select: { id: true, lastSeenAt: true } },
        },
      })
      .catch(() => null);
    /**
     * HORS SERVICE — le garde qui MANQUAIT sur ce chemin.
     *
     * `computeSuggestions` écarte les hors-service depuis toujours, et son commentaire affirmait
     * couvrir « l'attribution automatique ». C'était faux : l'agent d'agenda NE PASSE PAS par ce
     * vivier (il applique un motif récurrent puis appelle directement ce prédicat, cf. l'en-tête
     * ci-dessus). Un véhicule déclaré hors service dont le boîtier parle encore — accident
     * déclaré le matin, hivernage alimenté, véhicule rebranché pour être déplacé — franchissait
     * donc les quatre conditions et se retrouvait RÉSERVÉ FERMEMENT.
     *
     * Testé AVANT la dormance : c'est un fait déclaré, pas déduit, et il n'a aucun délai de
     * levée. Chez cdef31 les quatre véhicules hors service se taisaient aussi, donc la dormance
     * les retenait — par accident. On ne laisse pas un garde reposer sur une coïncidence.
     */
    if (veh?.outOfServiceReason != null) return false;
    if (
      isVehicleDormant(
        { trackerId: veh?.tracker?.id ?? null, lastSeenAt: veh?.tracker?.lastSeenAt ?? null },
        Date.now(),
        DORMANT_STOP_COUNTING_MS,
      )
    ) {
      return false;
    }
    return true;
  }

  /**
   * Création SYSTÈME d'une réservation FERME (agent nocturne / application d'une proposition).
   * Rejoue les pré-checks + s'appuie sur la contrainte EXCLUDE ; renvoie null si le créneau est
   * occupé (course incluse), ne lève que sur erreur inattendue. La permission est vérifiée EN AMONT
   * (agent scopé flotte, ou application humaine déjà gardée par reservations_manage).
   */
  async systemConfirm(input: {
    fleetId: string;
    vehicleId: string;
    start: Date;
    end: Date;
    title: string;
    createdBy?: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<VehicleEventDto | null> {
    const { fleetId, vehicleId, start, end } = input;
    if (!(await this.isVehicleFree(vehicleId, start, end))) return null;
    // Groupe qui utilise le véhicule : une réservation posée par le système hérite du groupe du véhicule.
    const metaSys = (input.metadata as Record<string, unknown> | null | undefined) ?? {};
    const groupeSys = ReservationsService.groupeDe(metaSys) ?? (await this.groupeDuVehicule(vehicleId));
    try {
      const row = await this.prisma.vehicleEvent.create({
        data: {
          fleetId,
          vehicleId,
          type: VehicleEventType.RESERVATION,
          status: VehicleEventStatus.CONFIRMED,
          title: input.title,
          startAt: start,
          endAt: end,
          allDay: false,
          metadata: { ...metaSys, group: groupeSys } as Prisma.InputJsonValue,
          createdBy: input.createdBy ?? SYSTEM_ACTOR_ID,
          source: 'SYSTEM',
        },
        include: INCLUDE_PLATE,
      });
      return this.toDto(row);
    } catch (err) {
      if (this.isExclusionConflict(err)) return null; // course : créneau pris entre-temps
      throw err;
    }
  }

  /**
   * Création SYSTÈME d'une DEMANDE (REQUESTED, non bloquante) — flux public P4. La demande atterrit
   * dans la file de validation ; un gestionnaire la confirme (aucune permission publique). Le véhicule
   * a déjà été vérifié appartenir à la flotte du lien EN AMONT (booking service).
   */
  async systemRequest(input: {
    fleetId: string;
    vehicleId: string;
    start: Date;
    end: Date;
    title: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<VehicleEventDto> {
    const row = await this.prisma.vehicleEvent.create({
      data: {
        fleetId: input.fleetId,
        vehicleId: input.vehicleId,
        type: VehicleEventType.RESERVATION,
        status: VehicleEventStatus.REQUESTED,
        title: input.title,
        startAt: input.start,
        endAt: input.end,
        allDay: false,
        metadata: input.metadata ?? Prisma.JsonNull,
        createdBy: SYSTEM_ACTOR_ID,
        source: 'SYSTEM',
      },
      include: INCLUDE_PLATE,
    });
    return this.toDto(row);
  }
}
