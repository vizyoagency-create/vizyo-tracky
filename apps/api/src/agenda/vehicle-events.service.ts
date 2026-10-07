import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  AgendaSummaryDto,
  CreateVehicleEventDto,
  OdometerEstimateDto,
  ReportIncidentDto,
  UpdateVehicleEventDto,
  VehicleEventDto,
} from '@vizyo/tracky-shared';
import { IMMOBILIZING_STATUSES } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { formatFleetDate, formatFleetDateTime, formatFleetTime } from '../common/utils/datetime';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService, type SystemActivityInput } from '../system-activity/system-activity.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { DISPONIBILITE_MODIFIEE_EVENT, type DisponibiliteModifieeEvent } from '../vehicles/immobilisation-agenda';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Un créneau lisible, en HEURE DE PARIS, pour le texte d'une ligne du journal métier (29/09).
 *
 * Le serveur tourne en UTC : `toISOString()` dans un `detail` affiche 07:00 pour un départ à 09:00
 * l'été — et c'est ce texte que le fil « Agenda » d'un client relit. `journeeEntiere` : un évènement
 * « toute la journée » (maintenance, incident) se dit par ses dates seules, sans une heure qui ne
 * veut rien dire. Partagé par l'agent de l'agenda et les plans d'entretien.
 *
 *   05/10/2026 09:00 → 12:00            (même jour)
 *   05/10/2026 09:00 → 06/10/2026 12:00 (à cheval)
 *   05/10/2026 → 12/10/2026             (journées entières)
 */
export function creneauParis(debut: Date, fin?: Date | null, journeeEntiere = false): string {
  if (journeeEntiere) {
    const j1 = formatFleetDate(debut);
    const j2 = fin ? formatFleetDate(fin) : j1;
    return j1 === j2 ? j1 : `${j1} → ${j2}`;
  }
  const d = formatFleetDateTime(debut);
  if (!fin) return d;
  return formatFleetDate(debut) === formatFleetDate(fin) ? `${d} → ${formatFleetTime(fin)}` : `${d} → ${formatFleetDateTime(fin)}`;
}

/** Libellés du journal : ce que lit un exploitant, pas un code d'énumération. */
const TYPE_LIBELLE: Record<string, string> = {
  MAINTENANCE: 'Maintenance',
  INCIDENT: 'Incident',
  RESERVATION: 'Réservation',
  MISSION: 'Mission',
};
const STATUT_LIBELLE: Record<string, string> = {
  PLANNED: 'planifié',
  OPEN: 'ouvert',
  IN_PROGRESS: 'en cours',
  DONE: 'terminé',
  CANCELLED: 'annulé',
  REQUESTED: 'demandé',
  CONFIRMED: 'confirmé',
};
const GRAVITE_LIBELLE: Record<string, string> = { LOW: 'faible', MEDIUM: 'moyenne', HIGH: 'haute', CRITICAL: 'critique' };
const typeLibelle = (t: string | null | undefined): string => (t ? (TYPE_LIBELLE[t] ?? t) : 'Évènement');
const statutLibelle = (s: string | null | undefined): string => (s ? (STATUT_LIBELLE[s] ?? s) : '—');
const graviteLibelle = (g: string | null | undefined): string => (g ? (GRAVITE_LIBELLE[g] ?? g) : 'non renseignée');
/** Un texte comparé tel que l'écran le montre : rogné, et `null` = vide (la feuille renvoie '' là où la base a null). */
const texteCompare = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
/** « « Carrosserie » », ou « — » pour un champ vide ; borné, c'est une saisie libre. */
const cite = (v: unknown): string => {
  const t = texteCompare(v);
  if (!t) return '—';
  return `« ${t.length > 60 ? `${t.slice(0, 59)}…` : t} »`;
};
/** 12450 → « 12 450 km » (espace ordinaire : pas de dépendance à l'ICU du serveur). */
const km = (n: number | null | undefined): string =>
  n == null ? 'non relevé' : `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} km`;

/** Ce que `loadScoped` rend : de quoi garder, journaliser et comparer avant/après. */
type EvenementCharge = {
  vehicleId: string;
  type: VehicleEventType;
  startAt: Date;
  endAt: Date | null;
  fleetId?: string;
  status?: VehicleEventStatus;
  title?: string;
  allDay?: boolean;
  blocksVehicle?: boolean;
  // Revue du 29/09 (C2) — lus pour ne nommer au journal que ce qui change VRAIMENT.
  description?: string | null;
  category?: string | null;
  severity?: string | null;
  odometerKm?: number | null;
  linkedEventId?: string | null;
  metadata?: Prisma.JsonValue | null;
  vehicle?: { plate: string | null } | null;
};

/**
 * P2-3 (audit du 22/09) — plafond de la liste d'évènements d'une fenêtre.
 *
 * L'ancien `take: 1000` était MUET : trié par date croissante, au-delà de mille lignes **la fin
 * du mois disparaissait** sans qu'aucune trace ne le dise — ni au client, ni au journal. cdef31
 * est à ~300 évènements sur une grille de six semaines ; un parc de trente véhicules à deux
 * réservations par jour en produirait 2 500 sur la même fenêtre, et l'écran aurait tronqué en
 * silence. Le plafond est relevé à une marge confortable pour tout parc connu, et **quand il
 * mord, il le dit** dans le journal avec la société et la fenêtre — le contrat de réponse (un
 * tableau) n'est pas changé, mais l'oubli cesse d'être invisible.
 */
export const MAX_EVENEMENTS_PAR_FENETRE = 3000;

type EventRow = Prisma.VehicleEventGetPayload<{ include: { vehicle: { select: { plate: true } } } }>;

/**
 * Sprint 7 — CRUD des événements d'agenda (générique : maintenance + incidents). Scoping
 * tenant STRICT (anti-IDOR) réutilisant la chaîne S5 : `getAccessibleVehicleIds` +
 * `resolveReportVehicleScope`. Aucune donnée hors périmètre véhicule de l'utilisateur.
 */
@Injectable()
export class VehicleEventsService {
  private readonly logger = new Logger(VehicleEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    // EventEmitter2 est global (EventEmitterModule.forRoot) : injecté en prod, omis dans les specs.
    private readonly emitter?: EventEmitter2,
    // Journal métier (29/09, @Global) — EN DERNIER et @Optional : les specs montées à la main
    // (`new VehicleEventsService(prisma, access)`) restent valides, et sans journal rien ne casse.
    @Optional() private readonly systemActivity?: SystemActivityService,
  ) {}

  /**
   * 06/10/2026 — une maintenance ou un incident a changé : l'état de disponibilité du véhicule aussi
   * (carte, page Horaires, coupes automatiques). Le cache de l'instantané est vidé à réception.
   */
  private signalerDisponibilite(row: { type: VehicleEventType; fleetId?: string | null; vehicleId: string }): void {
    if (row.type !== VehicleEventType.MAINTENANCE && row.type !== VehicleEventType.INCIDENT) return;
    if (!row.fleetId) return;
    const evt: DisponibiliteModifieeEvent = { fleetId: row.fleetId, vehicleId: row.vehicleId };
    this.emitter?.emit(DISPONIBILITE_MODIFIEE_EVENT, evt);
  }

  /** Notifie l'agent d'agenda qu'un incident/maintenance vient d'être créé (déclencheur P3). */
  private emitAgentTrigger(fleetId: string, kind: 'incident' | 'maintenance'): void {
    this.emitter?.emit('agenda-agent.trigger', { fleetId, kind });
  }

  /**
   * Une ligne du fil « Agenda » (catégorie AGENDA). Le texte est construit DANS le `try` : une
   * donnée inattendue (mock partiel, ligne sans véhicule) ne fait jamais échouer le geste qu'on
   * trace — même contrat que `SystemActivityService.record`, qui ne lève jamais.
   *
   * `fleetId` = la société de L'ÉVÈNEMENT (donc du véhicule), jamais celle de l'utilisateur : un
   * super-admin qui clôt une maintenance chez un client laisse la trace chez ce client.
   *
   * `construire` peut rendre `null` : « rien à dire » (un Enregistrer qui n'a rien changé), décidé
   * lui aussi DANS le `try`.
   */
  private journaliser(construire: () => Omit<SystemActivityInput, 'category' | 'actor'> | null): void {
    if (!this.systemActivity) return;
    try {
      const ligne = construire();
      if (!ligne) return;
      this.systemActivity.record({ category: 'AGENDA', actor: 'utilisateur', ...ligne });
    } catch (e) {
      this.logger.warn(`journal agenda non écrit : ${(e as Error)?.message ?? e}`);
    }
  }

  /** Vérifie l'accès à un véhicule (cross-flotte + IDOR intra-flotte) → renvoie son fleetId. */
  async assertVehicleAccess(user: AuthUser, vehicleId: string): Promise<string> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, fleetId: true },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');
    if (user.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== user.fleetId) {
      throw new ForbiddenException('Véhicule hors de votre flotte');
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    resolveReportVehicleScope(accessible, [vehicleId]); // 403 si hors perimetre per-vehicule
    return vehicle.fleetId;
  }

  /**
   * Les véhicules que l'utilisateur voit (`'ALL'` = tout le parc de sa société, liste vide = aucun) —
   * le périmètre de `scopedWhere`, exposé pour les listes qui ne passent pas par ce service (30/09 :
   * les propositions de l'agent, que tout gestionnaire voyait sur tout le parc).
   */
  async vehiculesAccessibles(user: AuthUser): Promise<string[] | 'ALL'> {
    return resolveReportVehicleScope(await this.vehicleAccess.getAccessibleVehicleIds(user), undefined);
  }

  /** WHERE scopé (flotte + périmètre véhicules) pour les listes/compteurs. */
  private async scopedWhere(
    user: AuthUser,
    requestedVehicleIds?: string[],
    fleetId?: string,
  ): Promise<Prisma.VehicleEventWhereInput> {
    const where: Prisma.VehicleEventWhereInput = {};
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée');
      where.fleetId = user.fleetId;
    } else if (fleetId) {
      // Filtre société global (SUPER_ADMIN) : restreint à la société choisie dans le top-bar.
      where.fleetId = fleetId;
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const scope = resolveReportVehicleScope(accessible, requestedVehicleIds);
    if (scope !== 'ALL') where.vehicleId = { in: scope };
    return where;
  }

  /** vehicleIds d'un groupe (le groupe doit appartenir à la flotte de l'user, sauf super-admin). */
  private async groupVehicleIds(user: AuthUser, groupId: string): Promise<string[]> {
    const assignments = await this.prisma.vehicleGroupAssignment.findMany({
      where: {
        groupId,
        ...(user.role !== UserRole.SUPER_ADMIN
          ? { group: { fleetId: user.fleetId ?? '__none__' } }
          : {}),
      },
      select: { vehicleId: true },
    });
    return assignments.map((a) => a.vehicleId);
  }

  async list(
    user: AuthUser,
    q: {
      from: Date;
      to: Date;
      vehicleId?: string;
      groupId?: string;
      type?: VehicleEventType;
      status?: VehicleEventStatus;
      fleetId?: string;
    },
  ): Promise<VehicleEventDto[]> {
    let requested: string[] | undefined;
    if (q.vehicleId) requested = [q.vehicleId];
    else if (q.groupId) {
      requested = await this.groupVehicleIds(user, q.groupId);
      if (requested.length === 0) return []; // groupe vide -> ne rien exposer d'autre
    }

    const where = await this.scopedWhere(user, requested, q.fleetId);
    /**
     * Fenêtre temporelle : événements qui chevauchent [from, to].
     *
     * Troisième relecture du 29/09 (T16) — une IMMOBILISATION SANS FIN commencée AVANT la fenêtre, et
     * toujours active, la chevauche aussi. Un incident OPEN bloquant signalé le 20/08, jamais résolu,
     * n'était rendu à aucune grille de septembre : le panneau du jour annonçait le véhicule disponible
     * (« Tous les véhicules du périmètre sont disponibles ») pendant que la réservation répondait 409.
     * Même prédicat que `ReservationsService.findImmobilized` (bloquant, hors réservation, statut
     * immobilisant) et même fin effective que `effectiveBlockingEndMs` : un INCIDENT sans fin bloque
     * jusqu'à résolution, les autres (maintenance…) leur journée — 24 h après leur début.
     * La grille n'en dessine rien (un évènement d'un jour commencé avant la fenêtre n'a aucun jour
     * dedans) ; la disponibilité et le panneau du jour le voient chaque jour, comme prévu.
     */
    const immobilisantSansFin: Prisma.VehicleEventWhereInput = {
      endAt: null,
      blocksVehicle: true,
      status: { in: IMMOBILIZING_STATUSES },
    };
    where.AND = [
      {
        OR: [
          { endAt: null, startAt: { gte: q.from, lte: q.to } },
          { startAt: { lte: q.to }, endAt: { gte: q.from } },
          { ...immobilisantSansFin, type: VehicleEventType.INCIDENT, startAt: { lt: q.from } },
          {
            ...immobilisantSansFin,
            type: { notIn: [VehicleEventType.INCIDENT, VehicleEventType.RESERVATION] },
            startAt: { gt: new Date(q.from.getTime() - DAY_MS), lt: q.from },
          },
        ],
      },
    ];
    if (q.type) where.type = q.type;
    if (q.status) where.status = q.status;

    const rows = await this.prisma.vehicleEvent.findMany({
      where,
      include: { vehicle: { select: { plate: true } } },
      orderBy: { startAt: 'asc' },
      take: MAX_EVENEMENTS_PAR_FENETRE,
    });
    if (rows.length === MAX_EVENEMENTS_PAR_FENETRE) {
      // Tronqué : la fin de la fenêtre n'est pas rendue. Dit, pas avalé (P2-3).
      this.logger.warn(
        `Liste d'évènements tronquée à ${MAX_EVENEMENTS_PAR_FENETRE} lignes — société ${String(where.fleetId ?? 'toutes')}, ` +
          `fenêtre ${q.from.toISOString()} → ${q.to.toISOString()} : les évènements les plus tardifs manquent.`,
      );
    }
    return rows.map((r) => this.toDto(r));
  }

  /**
   * TOUS les évènements d'UN véhicule, sans fenêtre — l'onglet « Maintenance » de la fiche (07/10/2026).
   *
   * L'onglet lisait `GET /agenda/events?vehicleId=…&type=MAINTENANCE`, sans `from` ni `to`, que cette
   * route exige depuis sa création (Sprint 7) : 400 « from (ISO) requis », avalé par un `.catch` — la
   * fiche annonçait « Aucun entretien » sur tous les véhicules depuis le 28/06.
   *
   * Pas de fenêtre, parce que la fiche montre l'historique ET les échéances : un entretien fait il y
   * a trois ans, une échéance PLANNED oubliée depuis un an (la plus importante à voir), un contrôle
   * technique matérialisé à `lastDoneAt + intervalMonths`, des années devant. Toute fenêtre en ferait
   * disparaître une partie, en silence — le défaut même qu'on corrige.
   *
   * La borne est le VÉHICULE du chemin (UUID validé par la route), contrôlé par `assertVehicleAccess`
   * (404 inconnu, 403 autre société ou hors périmètre) : aucun paramètre ne l'élargit à une flotte.
   * `list()` garde sa fenêtre obligatoire — la rendre facultative « quand vehicleId est là » aurait
   * rouvert la lecture de toute la flotte pour `vehicleId=%20` : `resolveReportVehicleScope` écarte un
   * identifiant vide, et un périmètre `'ALL'` (FLEET_ADMIN, SUPER_ADMIN) n'aurait plus eu de borne véhicule.
   *
   * Du plus tardif au plus ancien : si le plafond mordait, c'est le plus ancien qui manquerait — et le
   * journal le dirait (P2-3).
   */
  async listForVehicle(
    user: AuthUser,
    vehicleId: string,
    q: { type?: VehicleEventType } = {},
  ): Promise<VehicleEventDto[]> {
    const fleetId = await this.assertVehicleAccess(user, vehicleId);
    const rows = await this.prisma.vehicleEvent.findMany({
      where: { fleetId, vehicleId, ...(q.type ? { type: q.type } : {}) },
      include: { vehicle: { select: { plate: true } } },
      orderBy: { startAt: 'desc' },
      take: MAX_EVENEMENTS_PAR_FENETRE,
    });
    if (rows.length === MAX_EVENEMENTS_PAR_FENETRE) {
      this.logger.warn(
        `Évènements du véhicule ${vehicleId} tronqués à ${MAX_EVENEMENTS_PAR_FENETRE} lignes : les plus anciens manquent.`,
      );
    }
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Les trois compteurs de l'en-tête.
   *
   * ── Périmètre (P2-4, audit du 22/09) ────────────────────────────────────────────────────
   * Filtrer par groupe ou véhicule ne changeait pas « En retard / À venir / Incidents
   * ouverts » : l'écran suggérait un périmètre qu'il n'appliquait pas. Les compteurs prennent
   * désormais le MÊME périmètre que la liste (`vehicleId` / `groupId`, résolus comme dans
   * `list()`). Le filtre de TYPE, lui, reste volontairement hors des compteurs : chacun est
   * typé par nature (« Incidents ouverts » sous un filtre « Maintenance » afficherait 0 — et ce
   * zéro serait faux).
   *
   * ── Statuts (audit du 24/09, « compteur ≠ liste ») ───────────────────────────────────────
   * `overdue` comptait les seuls `PLANNED` alors que le contrat du DTO dit « PLANNED/OPEN dont
   * l'échéance est passée » et que la liste « À venir & en retard » affichait aussi les OPEN.
   * La liste, côté web, applique la MÊME règle (`estUneEcheance`, `agenda.utils.ts`) — un
   * compteur et la liste sous lui doivent parler du même ensemble, sinon le lecteur ne sait plus
   * lequel croire.
   *
   * Recette du 28/09 (démo) : compter les OPEN faisait passer un incident déclaré à l'instant
   * (`reportIncident` : OPEN, `startAt` = maintenant) pour « en retard » dans la seconde. Un OPEN
   * est OUVERT — il vit dans `openIncidents`, comme un IN_PROGRESS. Seul un PLANNED a une échéance
   * qu'on peut dépasser : c'est le contrat du DTO, corrigé le même jour.
   */
  async summary(
    user: AuthUser,
    q: { fleetId?: string; vehicleId?: string; groupId?: string } = {},
  ): Promise<AgendaSummaryDto> {
    let requested: string[] | undefined;
    if (q.vehicleId) requested = [q.vehicleId];
    else if (q.groupId) {
      requested = await this.groupVehicleIds(user, q.groupId);
      if (requested.length === 0) return { overdue: 0, upcoming: 0, openIncidents: 0 }; // groupe vide
    }
    const where = await this.scopedWhere(user, requested, q.fleetId);
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * DAY_MS);
    const [overdue, upcoming, openIncidents] = await Promise.all([
      this.prisma.vehicleEvent.count({
        where: {
          ...where,
          status: VehicleEventStatus.PLANNED,
          startAt: { lt: now },
        },
      }),
      this.prisma.vehicleEvent.count({
        where: { ...where, status: VehicleEventStatus.PLANNED, startAt: { gte: now, lte: in30 } },
      }),
      this.prisma.vehicleEvent.count({
        where: {
          ...where,
          type: VehicleEventType.INCIDENT,
          status: { in: [VehicleEventStatus.OPEN, VehicleEventStatus.IN_PROGRESS] },
        },
      }),
    ]);
    return { overdue, upcoming, openIncidents };
  }

  async create(user: AuthUser, dto: CreateVehicleEventDto): Promise<VehicleEventDto> {
    if (dto.type === VehicleEventType.RESERVATION) {
      throw new BadRequestException('Les réservations seront gérées au Sprint 8');
    }
    const fleetId = await this.assertVehicleAccess(user, dto.vehicleId);
    const startAt = this.parseDate(dto.startAt, 'startAt');
    const endAt = dto.endAt ? this.parseDate(dto.endAt, 'endAt') : null;
    // Lot multi-jours (28/09) : une maintenance « du 5 au 12 » se saisit avec sa fin. Elle doit
    // rester après le début — sinon l'immobilisation calculée depuis `effectiveBlockingEndMs`
    // serait vide, et le véhicule « libre » pendant son passage au garage.
    if (endAt && endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('La fin doit être après le début.');
    }
    const row = await this.prisma.vehicleEvent.create({
      data: {
        fleetId,
        vehicleId: dto.vehicleId,
        type: dto.type,
        category: dto.category ?? null,
        status: dto.status ?? VehicleEventStatus.PLANNED,
        severity: dto.severity ?? null,
        title: dto.title.trim(),
        description: dto.description ?? null,
        startAt,
        endAt,
        allDay: dto.allDay ?? true,
        // Un incident immobilise par défaut (roue crevée = indisponible) ; une maintenance AUSSI depuis
        // le 06/10/2026 (« si on ajoute une maintenance à une voiture, elle doit passer avec la clé »).
        // Les rappels des plans d'entretien ne passent pas par ici : ils restent non bloquants.
        blocksVehicle:
          dto.blocksVehicle ?? (dto.type === VehicleEventType.INCIDENT || dto.type === VehicleEventType.MAINTENANCE),
        odometerKm: dto.odometerKm ?? null,
        metadata: dto.metadata ? (dto.metadata as Prisma.InputJsonValue) : undefined,
        createdBy: user.id,
        source: 'MANUAL',
      },
      include: { vehicle: { select: { plate: true } } },
    });
    await this.maybeUpdateOdometer(dto.vehicleId, dto.odometerKm, startAt);
    if (row.type === VehicleEventType.INCIDENT || row.type === VehicleEventType.MAINTENANCE) {
      this.emitAgentTrigger(row.fleetId, row.type === VehicleEventType.INCIDENT ? 'incident' : 'maintenance');
    }
    this.signalerDisponibilite(row);
    // Un INCIDENT saisi par la feuille « Nouvel évènement » est un incident signalé, comme par le
    // bouton dédié : même libellé au fil, sinon le client lit « Événement créé » pour une panne.
    this.journaliser(() => ({
      action: row.type === VehicleEventType.INCIDENT ? 'incident_signale' : 'evenement_cree',
      target: row.vehicle?.plate ?? null,
      detail:
        `${typeLibelle(row.type)} « ${row.title} » — ${creneauParis(row.startAt, row.endAt, row.allDay)}` +
        (row.blocksVehicle ? ' · véhicule indisponible' : ''),
      fleetId: row.fleetId,
      triggeredByUserId: user.id,
      meta: {
        eventId: row.id,
        vehicleId: row.vehicleId,
        type: row.type,
        status: row.status,
        blocksVehicle: row.blocksVehicle,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt ? row.endAt.toISOString() : null,
      },
    }));
    return this.toDto(row);
  }

  async reportIncident(user: AuthUser, dto: ReportIncidentDto): Promise<VehicleEventDto> {
    const fleetId = await this.assertVehicleAccess(user, dto.vehicleId);
    const row = await this.prisma.vehicleEvent.create({
      data: {
        fleetId,
        vehicleId: dto.vehicleId,
        type: VehicleEventType.INCIDENT,
        status: VehicleEventStatus.OPEN,
        severity: dto.severity ?? 'MEDIUM',
        title: dto.title.trim(),
        description: dto.description ?? null,
        startAt: new Date(),
        allDay: true,
        blocksVehicle: dto.blocksVehicle ?? true,
        createdBy: user.id,
        source: 'MANUAL',
      },
      include: { vehicle: { select: { plate: true } } },
    });
    this.emitAgentTrigger(row.fleetId, 'incident');
    this.signalerDisponibilite(row);
    this.journaliser(() => ({
      action: 'incident_signale',
      target: row.vehicle?.plate ?? null,
      detail:
        `Incident « ${row.title} » signalé le ${formatFleetDateTime(row.startAt)}` +
        (row.severity ? ` · gravité ${GRAVITE_LIBELLE[row.severity] ?? row.severity}` : '') +
        (row.blocksVehicle ? ' · véhicule immobilisé' : ''),
      fleetId: row.fleetId,
      triggeredByUserId: user.id,
      meta: { eventId: row.id, vehicleId: row.vehicleId, severity: row.severity ?? null, blocksVehicle: row.blocksVehicle },
    }));
    return this.toDto(row);
  }

  async update(user: AuthUser, id: string, dto: UpdateVehicleEventDto): Promise<VehicleEventDto> {
    const existing = await this.loadScoped(user, id);
    // Sprint 8 — une réservation ne se gère QUE via ReservationsService (perms reservations_*),
    // jamais via l'endpoint agenda générique : sinon agenda_manage contournerait reservations_manage
    // et court-circuiterait les pré-checks de conflit. Symétrique du refus dans create().
    if (existing.type === VehicleEventType.RESERVATION) {
      throw new BadRequestException('Les réservations se gèrent depuis l\'espace Réservations.');
    }
    this.refuserSiMission(existing.type);
    const data: Prisma.VehicleEventUpdateInput = {};
    if (dto.status !== undefined) {
      data.status = dto.status;
      if (dto.status === VehicleEventStatus.DONE) data.resolvedAt = new Date();
    }
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.severity !== undefined) data.severity = dto.severity;
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.startAt !== undefined) data.startAt = this.parseDate(dto.startAt, 'startAt');
    if (dto.endAt !== undefined) data.endAt = dto.endAt ? this.parseDate(dto.endAt, 'endAt') : null;
    // Lot multi-jours (28/09) : que le début, la fin ou les deux changent, la fin reste après
    // le début — c'est ce que l'écran « cette maintenance est-elle terminée ? » réécrit.
    const debut = data.startAt instanceof Date ? data.startAt : existing.startAt;
    const fin = dto.endAt !== undefined ? (data.endAt instanceof Date ? data.endAt : null) : existing.endAt;
    if (fin && fin.getTime() <= debut.getTime()) {
      throw new BadRequestException('La fin doit être après le début.');
    }
    if (dto.allDay !== undefined) data.allDay = dto.allDay;
    if (dto.blocksVehicle !== undefined) data.blocksVehicle = dto.blocksVehicle;
    if (dto.odometerKm !== undefined) data.odometerKm = dto.odometerKm;
    if (dto.linkedEventId !== undefined) {
      // Anti-IDOR : un lien ne peut pointer que vers un evenement DANS le perimetre (S8-ready).
      if (dto.linkedEventId) await this.loadScoped(user, dto.linkedEventId);
      data.linkedEventId = dto.linkedEventId;
    }
    if (dto.metadata !== undefined) data.metadata = dto.metadata as Prisma.InputJsonValue;

    const row = await this.prisma.vehicleEvent.update({
      where: { id },
      data,
      include: { vehicle: { select: { plate: true } } },
    });
    if (dto.odometerKm !== undefined) {
      await this.maybeUpdateOdometer(existing.vehicleId, dto.odometerKm, row.startAt);
    }
    this.signalerDisponibilite(row);
    // « Clos » = le statut PASSE à DONE (réponse « Oui, terminée » de l'écran « À clore », bouton
    // « Terminé ») ; un DONE réécrit sur un évènement déjà clos n'est qu'une modification.
    const clos = dto.status === VehicleEventStatus.DONE && existing.status !== VehicleEventStatus.DONE;
    this.journaliser(() => {
      const quoi = `${typeLibelle(row.type)} « ${row.title} »`;
      const { lignes: changements, champs } = this.changements(existing, row, dto);
      // Revue du 29/09 (C2) — la feuille d'édition renvoie TOUS ses champs : « Enregistrer » sans
      // rien toucher n'est pas une modification. Aucune ligne — même règle que `tracerModification`
      // côté réservations. Une clôture, elle, est toujours un geste.
      if (!clos && changements.length === 0) return null;
      return {
        action: clos ? 'evenement_clos' : 'evenement_modifie',
        target: row.vehicle?.plate ?? existing.vehicle?.plate ?? null,
        detail: clos
          ? `Clôture : ${quoi} — ${creneauParis(row.startAt, row.endAt, row.allDay)}`
          : `Modification : ${quoi} — ${changements.join(' ; ')}`,
        fleetId: row.fleetId ?? existing.fleetId ?? null,
        triggeredByUserId: user.id,
        meta: {
          eventId: id,
          vehicleId: existing.vehicleId,
          type: row.type,
          // Les clés qui ont VRAIMENT changé — pas toutes celles que la feuille a renvoyées.
          champs,
          avant: {
            status: existing.status ?? null,
            title: existing.title ?? null,
            startAt: existing.startAt?.toISOString() ?? null,
            endAt: existing.endAt?.toISOString() ?? null,
            blocksVehicle: existing.blocksVehicle ?? null,
          },
          apres: {
            status: row.status,
            title: row.title,
            startAt: row.startAt.toISOString(),
            endAt: row.endAt?.toISOString() ?? null,
            blocksVehicle: row.blocksVehicle,
          },
        },
      };
    });
    return this.toDto(row);
  }

  /**
   * Ce qui a changé, en clair — seulement ce que le correctif a VRAIMENT modifié, et les clés
   * correspondantes (`meta.champs`).
   *
   * Revue du 29/09 (C2) — la feuille d'édition renvoie à chaque « Enregistrer » le titre, la
   * catégorie, la description, les dates, l'immobilisation, la gravité d'un incident et le
   * kilométrage s'il est connu. Nommer un champ parce qu'il était DANS le correctif faisait lire
   * « description, catégorie mis à jour » à chaque report de date — et même sans rien toucher. Un
   * champ n'est donc nommé que si sa valeur en base diffère avant/après (`avant` = `loadScoped`,
   * `apres` = la ligne réécrite) : textes rognés, `null` et '' confondus, `metadata` comparé en
   * JSON (les deux côtés sortent de la base, même ordre de clés). Un champ que `avant` ne porte pas
   * n'est jamais nommé : on n'affirme pas un changement qu'on ne peut pas prouver.
   */
  private changements(
    avant: EvenementCharge,
    apres: EventRow,
    dto: UpdateVehicleEventDto,
  ): { lignes: string[]; champs: string[] } {
    const lignes: string[] = [];
    const champs: string[] = [];
    const envoye = (k: keyof UpdateVehicleEventDto): boolean => dto[k] !== undefined;
    if (envoye('status') && avant.status !== apres.status) {
      lignes.push(`statut ${statutLibelle(avant.status)} → ${statutLibelle(apres.status)}`);
      champs.push('status');
    }
    if (envoye('title') && avant.title !== undefined && avant.title !== apres.title) {
      lignes.push(`titre « ${avant.title} » → « ${apres.title} »`);
      champs.push('title');
    }
    const datesAvant = creneauParis(avant.startAt, avant.endAt, avant.allDay ?? apres.allDay);
    const datesApres = creneauParis(apres.startAt, apres.endAt, apres.allDay);
    const clesDates = (['startAt', 'endAt', 'allDay'] as const).filter(envoye);
    if (clesDates.length > 0 && datesAvant !== datesApres) {
      // « désormais » plutôt qu'une flèche : un créneau en porte déjà une (09:00 → 12:00).
      lignes.push(`dates ${datesAvant}, désormais ${datesApres}`);
      // Chaque borne comparée TELLE QU'AFFICHÉE (dans le mode du créneau réécrit) : une journée
      // entière renvoyée à 00:00 au lieu de 08:00 n'a pas « changé de début ».
      const affiche = (d: Date | null | undefined): string => (d ? creneauParis(d, null, apres.allDay) : '—');
      const bougees = clesDates.filter((k) =>
        k === 'allDay'
          ? avant.allDay !== undefined && avant.allDay !== apres.allDay
          : affiche(avant[k]) !== affiche(apres[k]),
      );
      champs.push(...(bougees.length > 0 ? bougees : clesDates));
    }
    if (envoye('blocksVehicle') && avant.blocksVehicle !== undefined && avant.blocksVehicle !== apres.blocksVehicle) {
      lignes.push(apres.blocksVehicle ? 'véhicule désormais indisponible' : 'véhicule de nouveau disponible');
      champs.push('blocksVehicle');
    }
    if (envoye('category') && avant.category !== undefined && texteCompare(avant.category) !== texteCompare(apres.category)) {
      lignes.push(`catégorie ${cite(avant.category)} → ${cite(apres.category)}`);
      champs.push('category');
    }
    if (envoye('severity') && avant.severity !== undefined && (avant.severity ?? null) !== (apres.severity ?? null)) {
      lignes.push(`gravité ${graviteLibelle(avant.severity)} → ${graviteLibelle(apres.severity)}`);
      champs.push('severity');
    }
    if (envoye('odometerKm') && avant.odometerKm !== undefined && (avant.odometerKm ?? null) !== (apres.odometerKm ?? null)) {
      lignes.push(`kilométrage ${km(avant.odometerKm)} → ${km(apres.odometerKm)}`);
      champs.push('odometerKm');
    }
    // Contenus longs ou techniques : nommés, pas recopiés.
    const nommes: string[] = [];
    if (envoye('description') && avant.description !== undefined && texteCompare(avant.description) !== texteCompare(apres.description)) {
      nommes.push('description');
      champs.push('description');
    }
    if (envoye('linkedEventId') && avant.linkedEventId !== undefined && (avant.linkedEventId ?? null) !== (apres.linkedEventId ?? null)) {
      nommes.push('évènement lié');
      champs.push('linkedEventId');
    }
    if (envoye('metadata') && avant.metadata !== undefined && JSON.stringify(avant.metadata ?? null) !== JSON.stringify(apres.metadata ?? null)) {
      nommes.push('détails');
      champs.push('metadata');
    }
    if (nommes.length > 0) {
      lignes.push(nommes.length === 1 && nommes[0] === 'description' ? 'description mise à jour' : `${nommes.join(', ')} mis à jour`);
    }
    return { lignes, champs };
  }

  async remove(user: AuthUser, id: string): Promise<{ ok: true }> {
    const existing = await this.loadScoped(user, id);
    if (existing.type === VehicleEventType.RESERVATION) {
      throw new BadRequestException('Les réservations se gèrent depuis l\'espace Réservations.');
    }
    this.refuserSiMission(existing.type);
    // Écrit AVANT la suppression : après, il ne reste rien en base pour dire ce qui a disparu (titre,
    // type, plaque, dates). Si la suppression échoue, une seconde ligne en ÉCHEC le dit — le fil ne
    // doit pas affirmer une suppression qui n'a pas eu lieu sans que la suite le corrige.
    const quoi = () => `${typeLibelle(existing.type)} « ${existing.title ?? 'sans titre'} »`;
    const meta = () => ({
      eventId: id,
      vehicleId: existing.vehicleId,
      type: existing.type,
      status: existing.status ?? null,
      title: existing.title ?? null,
      startAt: existing.startAt?.toISOString() ?? null,
      endAt: existing.endAt?.toISOString() ?? null,
    });
    this.journaliser(() => ({
      action: 'evenement_supprime',
      target: existing.vehicle?.plate ?? null,
      detail: `Suppression : ${quoi()} — ${creneauParis(existing.startAt, existing.endAt, existing.allDay ?? true)}`,
      fleetId: existing.fleetId ?? null,
      triggeredByUserId: user.id,
      meta: meta(),
    }));
    try {
      await this.prisma.vehicleEvent.delete({ where: { id } });
    } catch (e) {
      this.journaliser(() => ({
        action: 'evenement_supprime',
        status: 'FAILURE',
        target: existing.vehicle?.plate ?? null,
        detail: `Suppression ÉCHOUÉE : ${quoi()} — l'évènement est toujours dans l'agenda.`,
        fleetId: existing.fleetId ?? null,
        triggeredByUserId: user.id,
        meta: { ...meta(), error: e instanceof Error ? e.message.slice(0, 300) : String(e) },
      }));
      throw e;
    }
    this.signalerDisponibilite(existing);
    return { ok: true };
  }

  /**
   * P2-1 (audit du 22/09) — un évènement `MISSION` n'est pas un évènement comme les autres :
   * c'est L'OMBRE d'une mission, créée avec elle dans la même transaction (`missions.service.ts`)
   * et retrouvée par `metadata.missionId` à chaque changement d'état. Le serveur refusait déjà
   * l'édition d'une RÉSERVATION par cette voie, mais laissait passer la mission : « Terminé » ou
   * « Supprimer » depuis le panneau du jour **libérait le véhicule pendant une mission qui
   * existait toujours** — exactement la désynchronisation que la transaction de création empêche.
   *
   * Même famille de garde que la réservation, même symétrie : la mission se pilote depuis l'onglet
   * Missions (démarrer, terminer, annuler), et c'est ELLE qui met son ombre à jour. Le message
   * dit où aller, parce qu'un refus qui ne dit pas le bon geste en provoque un autre.
   */
  private refuserSiMission(type: VehicleEventType): void {
    if (type === VehicleEventType.MISSION) {
      throw new BadRequestException(
        "Une mission se pilote depuis l'onglet Missions de l'agenda : c'est elle qui met à jour cet évènement.",
      );
    }
  }

  async estimateOdometer(user: AuthUser, vehicleId: string): Promise<OdometerEstimateDto> {
    await this.assertVehicleAccess(user, vehicleId);
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { lastOdometerKm: true, lastOdometerAt: true },
    });
    const since = vehicle?.lastOdometerAt ?? undefined;
    const agg = await this.prisma.trip.aggregate({
      where: { vehicleId, ...(since ? { startedAt: { gte: since } } : {}) },
      _sum: { distanceKm: true },
    });
    const gpsSince = Math.round(agg._sum.distanceKm ?? 0);
    const base = vehicle?.lastOdometerKm ?? null;
    const estimated = base !== null ? base + gpsSince : gpsSince > 0 ? gpsSince : null;
    return {
      vehicleId,
      lastOdometerKm: base,
      lastOdometerAt: vehicle?.lastOdometerAt?.toISOString() ?? null,
      gpsDistanceSinceKm: gpsSince,
      estimatedKm: estimated,
    };
  }

  /** Charge un événement en garantissant qu'il est dans le périmètre de l'user. */
  private async loadScoped(user: AuthUser, id: string): Promise<EvenementCharge> {
    const where = await this.scopedWhere(user);
    const ev = await this.prisma.vehicleEvent.findFirst({
      where: { ...where, id },
      // `startAt` / `endAt` : la garde « fin après début » de update() (lot multi-jours) doit
      // raisonner sur les valeurs en base quand le patch n'en change qu'une.
      // `fleetId`, `status`, `title`, `allDay`, `blocksVehicle`, plaque : le journal métier (29/09)
      // dit « avant → après » et, pour une suppression, ce qui a disparu — lus dans la MÊME requête.
      // `description` … `metadata` (revue du 29/09, C2) : sans eux, `changements()` ne pouvait que
      // nommer ce que la feuille RENVOIE, pas ce qui CHANGE.
      select: {
        id: true,
        vehicleId: true,
        type: true,
        startAt: true,
        endAt: true,
        fleetId: true,
        status: true,
        title: true,
        allDay: true,
        blocksVehicle: true,
        description: true,
        category: true,
        severity: true,
        odometerKm: true,
        linkedEventId: true,
        metadata: true,
        vehicle: { select: { plate: true } },
      },
    });
    if (!ev) throw new NotFoundException('Événement introuvable');
    return ev;
  }

  /** Met à jour le baseline km du véhicule (jamais en arrière : on n'écrase qu'avec une saisie plus récente). */
  async maybeUpdateOdometer(
    vehicleId: string,
    odometerKm: number | null | undefined,
    at: Date,
  ): Promise<void> {
    if (odometerKm == null) return;
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { lastOdometerAt: true },
    });
    if (v?.lastOdometerAt && v.lastOdometerAt.getTime() > at.getTime()) return;
    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { lastOdometerKm: odometerKm, lastOdometerAt: at },
    });
  }

  private parseDate(raw: string, field: string): Date {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`${field} doit être une date ISO valide`);
    }
    return d;
  }

  toDto(r: EventRow): VehicleEventDto {
    return {
      id: r.id,
      fleetId: r.fleetId,
      vehicleId: r.vehicleId,
      vehiclePlate: r.vehicle?.plate ?? null,
      type: r.type,
      category: r.category,
      status: r.status,
      severity: (r.severity as VehicleEventDto['severity']) ?? null,
      title: r.title,
      description: r.description,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt?.toISOString() ?? null,
      allDay: r.allDay,
      blocksVehicle: r.blocksVehicle,
      odometerKm: r.odometerKm,
      planId: r.planId,
      linkedEventId: r.linkedEventId,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
