import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  ChildSeatAvailabilityDto,
  ChildSeatCounts,
  ChildSeatPolicy,
  ChildSeatStockDto,
  ReservationCriteria,
  SetChildSeatStockDto,
  SetVehicleChildSeatsDto,
} from '@vizyo/tracky-shared';
import { CHILD_SEAT_LABELS, CHILD_SEAT_POLICY_LABELS } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/** Statuts qui ENGAGENT le stock : une réservation ferme, ou en cours. */
const ENGAGING: VehicleEventStatus[] = [VehicleEventStatus.CONFIRMED, VehicleEventStatus.IN_PROGRESS];
/** Un total au-delà de ça n'est plus un stock de sièges, c'est une faute de frappe. */
const STOCK_MAX = 500;
/** Un véhicule n'a pas vingt places arrière. */
const VEHICLE_MAX = 20;
const POLICIES: ChildSeatPolicy[] = ['STOCK_OR_INSTALLED', 'INSTALLED_ONLY'];

const zero = (): ChildSeatCounts => ({ baby: 0, child: 0 });
const add = (a: ChildSeatCounts, b: ChildSeatCounts): ChildSeatCounts => ({ baby: a.baby + b.baby, child: a.child + b.child });
/** a − b, jamais négatif. */
const moins = (a: ChildSeatCounts, b: ChildSeatCounts): ChildSeatCounts => ({
  baby: Math.max(0, a.baby - b.baby),
  child: Math.max(0, a.child - b.child),
});
const aucun = (c: ChildSeatCounts): boolean => c.baby <= 0 && c.child <= 0;

/**
 * ── SIÈGES AUTO : POSSÉDÉS, INSTALLÉS OU EN STOCK, DEUX TYPES (2026-09-28) ─────────────────────
 *
 * ┌─ LE MODÈLE ────────────────────────────────────────────────────────────────┐
 * │ La société POSSÈDE des sièges (`Fleet.childSeatsBaby/Child`). Chacun est   │
 * │ soit INSTALLÉ dans un véhicule (`Vehicle.childSeatsBaby/Child` : à bord,   │
 * │ prêt), soit dans le STOCK = possédés − installés (dérivé, jamais stocké).   │
 * │ Deux types, JAMAIS interchangeables : un enfant « bébé » ne va pas dans un │
 * │ siège « enfant », ni l'inverse. Règle du propriétaire, et règle de sécurité.│
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Une réservation avec un besoin (n bébé, m enfant) sur un véhicule V :
 *  - les sièges À BORD de V couvrent d'abord (rien à installer) ;
 *  - le RESTE (besoin − à bord) vient du STOCK — si la politique l'autorise
 *    (`STOCK_OR_INSTALLED`, défaut) et s'il en reste sur le créneau : stock − ce que les
 *    réservations fermes chevauchantes prennent déjà dessus (leur besoin − les sièges à bord de
 *    LEUR véhicule ; une demande groupée = un seul besoin, contre la somme de ses véhicules) ;
 *  - sous `INSTALLED_ONLY`, le stock n'est jamais promis : V doit avoir tout à bord.
 *
 * Les sièges à bord ne se disputent jamais entre réservations : deux réservations du même
 * véhicule se heurtent déjà sur le véhicule. Seul le stock est partagé, donc seul le stock se
 * compte sur le créneau.
 *
 * Trois surfaces s'en servent : la réservation interne (demande, validation, édition), le lien
 * public (à la soumission, demandes en attente comprises) et le vivier de suggestion — donc l'IA
 * de placement, dont le payload porte la politique, le stock du créneau, et pour chaque candidat
 * ce qu'il a à bord et ce que le stock devrait lui fournir.
 */
@Injectable()
export class ChildSeatsService {
  private readonly logger = new Logger(ChildSeatsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Journal métier (29/09, @Global) — en dernier et @Optional : les specs montées à la main
    // (`new ChildSeatsService(prisma)`) restent valides, et sans journal rien ne casse.
    @Optional() private readonly systemActivity?: SystemActivityService,
  ) {}

  /**
   * Une ligne `sieges_modifies` (catégorie AGENDA) : « avant → après », type par type. La société
   * est celle de la RESSOURCE (la société réglée, ou celle du véhicule) — jamais celle de
   * l'utilisateur, qu'un super-admin n'a d'ailleurs pas. Rien n'est écrit si rien n'a changé.
   */
  private journaliser(
    user: AuthUser,
    fleetId: string,
    target: string | null,
    changements: string[],
    meta: Record<string, unknown>,
    sujet: string,
  ): void {
    if (!this.systemActivity || changements.length === 0) return;
    try {
      this.systemActivity.record({
        category: 'AGENDA',
        action: 'sieges_modifies',
        actor: 'utilisateur',
        target,
        detail: `${sujet} : ${changements.join(' ; ')}`,
        fleetId,
        triggeredByUserId: user.id,
        meta,
      });
    } catch (e) {
      this.logger.warn(`journal sièges auto non écrit : ${(e as Error)?.message ?? e}`);
    }
  }

  /** « Bébé 3 → 2 » pour chaque type qui a bougé. */
  private static ecarts(prefixe: string, avant: ChildSeatCounts, apres: ChildSeatCounts): string[] {
    return (['baby', 'child'] as const)
      .filter((t) => avant[t] !== apres[t])
      .map((t) => `${prefixe}« ${t === 'baby' ? CHILD_SEAT_LABELS.BABY : CHILD_SEAT_LABELS.CHILD} » ${avant[t]} → ${apres[t]}`);
  }

  // ─── Lecture / réglage ──────────────────────────────────────────────────────

  async getStock(user: AuthUser, fleetId?: string): Promise<ChildSeatStockDto> {
    return this.summary(this.resolveFleetId(user, fleetId));
  }

  /** L'état complet d'une société : politique, possédés, installés (véhicule par véhicule), stock. */
  async summary(fleetId: string): Promise<ChildSeatStockDto> {
    const [fleet, vehicles] = await Promise.all([
      this.prisma.fleet.findUnique({
        where: { id: fleetId },
        select: { childSeatsBaby: true, childSeatsChild: true, childSeatPolicy: true },
      }),
      this.prisma.vehicle.findMany({
        where: { fleetId },
        select: { id: true, plate: true, childSeatsBaby: true, childSeatsChild: true, outOfServiceReason: true },
        orderBy: { plate: 'asc' },
        take: 500,
      }),
    ]);
    if (!fleet) throw new NotFoundException('Société introuvable.');
    const total = { baby: fleet.childSeatsBaby, child: fleet.childSeatsChild };
    const rows = vehicles.map((v) => ({
      vehicleId: v.id,
      plate: v.plate,
      installed: { baby: v.childSeatsBaby ?? 0, child: v.childSeatsChild ?? 0 },
      outOfService: v.outOfServiceReason != null,
    }));
    const installed = rows.reduce((acc, r) => add(acc, r.installed), zero());
    // Équipés en premier : c'est ce qu'on vient régler ; le reste de la liste sert à en ajouter un.
    rows.sort((a, b) => Number(aucun(a.installed)) - Number(aucun(b.installed)) || (a.plate ?? '').localeCompare(b.plate ?? ''));
    return {
      fleetId,
      policy: fleet.childSeatPolicy as ChildSeatPolicy,
      total,
      installed,
      stock: moins(total, installed),
      vehicles: rows,
    };
  }

  /** Règle le total possédé et la politique. Refuse un total sous ce qui est installé. */
  async setStock(user: AuthUser, dto: SetChildSeatStockDto): Promise<ChildSeatStockDto> {
    const id = this.resolveFleetId(user, dto?.fleetId);
    const baby = this.cleanStock(dto?.baby, CHILD_SEAT_LABELS.BABY);
    const child = this.cleanStock(dto?.child, CHILD_SEAT_LABELS.CHILD);
    const policy = dto?.policy === undefined ? undefined : this.cleanPolicy(dto.policy);
    // Les valeurs AVANT sont lues ici (même requête qu'avant, trois colonnes de plus) : le journal
    // dit « Bébé 3 → 2 », pas seulement « 2 ».
    const existing = await this.prisma.fleet.findUnique({
      where: { id },
      select: { id: true, childSeatsBaby: true, childSeatsChild: true, childSeatPolicy: true },
    });
    if (!existing) throw new NotFoundException('Société introuvable.');
    const installed = await this.installedOf(id);
    if (baby < installed.baby || child < installed.child) {
      throw new BadRequestException(
        `Impossible : ${installed.baby} siège(s) « ${CHILD_SEAT_LABELS.BABY} » et ${installed.child} « ${CHILD_SEAT_LABELS.CHILD} » sont installés dans des véhicules. ` +
          'Retirez-les des véhicules avant de réduire le total possédé.',
      );
    }
    await this.prisma.fleet.update({
      where: { id },
      data: { childSeatsBaby: baby, childSeatsChild: child, ...(policy ? { childSeatPolicy: policy } : {}) },
    });
    const totalAvant = { baby: existing.childSeatsBaby ?? 0, child: existing.childSeatsChild ?? 0 };
    const totalApres = { baby, child };
    const policyAvant = (existing.childSeatPolicy as ChildSeatPolicy | undefined) ?? 'STOCK_OR_INSTALLED';
    const changements = ChildSeatsService.ecarts('possédés ', totalAvant, totalApres);
    if (policy && policy !== policyAvant) {
      changements.push(`réglage « ${CHILD_SEAT_POLICY_LABELS[policyAvant] ?? policyAvant} » → « ${CHILD_SEAT_POLICY_LABELS[policy]} »`);
    }
    this.journaliser(user, id, null, changements, {
      scope: 'societe',
      avant: { total: totalAvant, policy: policyAvant },
      apres: { total: totalApres, policy: policy ?? policyAvant },
    }, 'Sièges auto de la société');
    return this.summary(id);
  }

  /**
   * Règle les sièges À BORD d'un véhicule. Si la société en possède moins que la somme installée,
   * le total est RELEVÉ plutôt que refusé : « 2 sièges à bord » dit que la société en possède au
   * moins 2 — refuser ici obligerait à aller compter ailleurs d'abord.
   */
  async setVehicleSeats(user: AuthUser, vehicleId: string, dto: SetVehicleChildSeatsDto): Promise<ChildSeatStockDto> {
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      // Plaque et sièges à bord AVANT : lus dans la même requête, pour le journal (« avant → après »).
      select: { id: true, fleetId: true, plate: true, childSeatsBaby: true, childSeatsChild: true },
    });
    if (!v) throw new NotFoundException('Véhicule introuvable.');
    const fleetId = this.resolveFleetId(user, v.fleetId);
    const baby = this.cleanVehicle(dto?.baby, CHILD_SEAT_LABELS.BABY);
    const child = this.cleanVehicle(dto?.child, CHILD_SEAT_LABELS.CHILD);
    await this.prisma.vehicle.update({ where: { id: vehicleId }, data: { childSeatsBaby: baby, childSeatsChild: child } });
    const releve = await this.releverTotal(fleetId);
    const aBordAvant = { baby: v.childSeatsBaby ?? 0, child: v.childSeatsChild ?? 0 };
    const aBordApres = { baby, child };
    const changements = ChildSeatsService.ecarts('à bord ', aBordAvant, aBordApres);
    // Le total relevé est un effet du geste : le taire ferait croire à un stock qui bouge seul.
    if (releve) changements.push(...ChildSeatsService.ecarts('possédés (relevé) ', releve.avant, releve.apres));
    this.journaliser(user, fleetId, v.plate ?? null, changements, {
      scope: 'vehicule',
      vehicleId,
      avant: { aBord: aBordAvant, ...(releve ? { total: releve.avant } : {}) },
      apres: { aBord: aBordApres, ...(releve ? { total: releve.apres } : {}) },
    }, `Sièges auto à bord de ${v.plate ?? 'ce véhicule'}`);
    return this.summary(fleetId);
  }

  /**
   * Invariant possédés ≥ installés, par type : on relève le total si la somme à bord le dépasse.
   * Rend le total avant/après quand il a été relevé (le journal le dit), sinon null.
   */
  private async releverTotal(fleetId: string): Promise<{ avant: ChildSeatCounts; apres: ChildSeatCounts } | null> {
    const [installed, fleet] = await Promise.all([
      this.installedOf(fleetId),
      this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { childSeatsBaby: true, childSeatsChild: true } }),
    ]);
    if (!fleet) return null;
    const data: { childSeatsBaby?: number; childSeatsChild?: number } = {};
    if (fleet.childSeatsBaby < installed.baby) data.childSeatsBaby = installed.baby;
    if (fleet.childSeatsChild < installed.child) data.childSeatsChild = installed.child;
    if (Object.keys(data).length === 0) return null;
    await this.prisma.fleet.update({ where: { id: fleetId }, data });
    const avant = { baby: fleet.childSeatsBaby, child: fleet.childSeatsChild };
    return { avant, apres: { baby: data.childSeatsBaby ?? avant.baby, child: data.childSeatsChild ?? avant.child } };
  }

  /** Somme des sièges installés dans les véhicules de la société. */
  private async installedOf(fleetId: string): Promise<ChildSeatCounts> {
    const agg = await this.prisma.vehicle.aggregate({
      where: { fleetId },
      _sum: { childSeatsBaby: true, childSeatsChild: true },
    });
    return { baby: agg._sum.childSeatsBaby ?? 0, child: agg._sum.childSeatsChild ?? 0 };
  }

  /** Possédés, installés, stock et politique — sans la liste des véhicules. */
  private async etatOf(fleetId: string): Promise<{ policy: ChildSeatPolicy; total: ChildSeatCounts; installed: ChildSeatCounts; stock: ChildSeatCounts }> {
    const [fleet, installed] = await Promise.all([
      this.prisma.fleet.findUnique({
        where: { id: fleetId },
        select: { childSeatsBaby: true, childSeatsChild: true, childSeatPolicy: true },
      }),
      this.installedOf(fleetId),
    ]);
    const total = { baby: fleet?.childSeatsBaby ?? 0, child: fleet?.childSeatsChild ?? 0 };
    return {
      policy: ((fleet?.childSeatPolicy as ChildSeatPolicy | undefined) ?? 'STOCK_OR_INSTALLED'),
      total,
      installed,
      stock: moins(total, installed),
    };
  }

  // ─── Disponibilité sur un créneau ───────────────────────────────────────────

  /**
   * Sièges du STOCK engagés sur [start,end) : pour chaque réservation ferme chevauchante, son
   * besoin moins les sièges à bord de son véhicule — par demande GROUPÉE (même `bookingRef`), un
   * seul besoin contre la somme des sièges à bord de ses véhicules.
   *
   * - `includeRequested` : compte aussi les demandes EN ATTENTE (flux public, symétrique de
   *   `excludeRequested` pour les véhicules) ;
   * - `excludeId` / `excludeBookingRef` : la réservation qu'on valide ou qu'on édite ne s'engage pas
   *   elle-même, ni ses sœurs déjà validées (sinon la seconde validation d'un groupe serait refusée).
   */
  async engaged(
    fleetId: string,
    start: Date,
    end: Date,
    opts?: { includeRequested?: boolean; excludeId?: string; excludeBookingRef?: string | null },
  ): Promise<ChildSeatCounts> {
    const statuses = opts?.includeRequested ? [...ENGAGING, VehicleEventStatus.REQUESTED] : ENGAGING;
    const rows = await this.prisma.vehicleEvent.findMany({
      where: {
        fleetId,
        type: VehicleEventType.RESERVATION,
        status: { in: statuses },
        startAt: { lt: end },
        endAt: { gt: start },
        ...(opts?.excludeId ? { id: { not: opts.excludeId } } : {}),
      },
      select: { id: true, metadata: true, vehicle: { select: { childSeatsBaby: true, childSeatsChild: true } } },
      take: 5000,
    });
    const groupes = new Map<string, { need: ChildSeatCounts; aBord: ChildSeatCounts }>();
    for (const r of rows) {
      const meta = (r.metadata ?? {}) as { bookingRef?: unknown; criteria?: unknown };
      const ref = typeof meta.bookingRef === 'string' && meta.bookingRef ? meta.bookingRef : `id:${r.id}`;
      if (opts?.excludeBookingRef && ref === opts.excludeBookingRef) continue;
      const aBord = { baby: r.vehicle?.childSeatsBaby ?? 0, child: r.vehicle?.childSeatsChild ?? 0 };
      const g = groupes.get(ref);
      if (g) g.aBord = add(g.aBord, aBord);
      else groupes.set(ref, { need: ChildSeatsService.needOf(meta.criteria as ReservationCriteria | undefined), aBord });
    }
    let out = zero();
    for (const g of groupes.values()) out = add(out, moins(g.need, g.aBord));
    return out;
  }

  async availability(
    fleetId: string,
    start: Date,
    end: Date,
    opts?: {
      includeRequested?: boolean;
      excludeId?: string;
      excludeBookingRef?: string | null;
      /** Véhicule visé : ses sièges à bord entrent dans le compte. */
      vehicleId?: string;
      /** Sièges à bord DÉJÀ connus (ex. somme d'une combinaison de véhicules) — prime sur `vehicleId`. */
      installed?: ChildSeatCounts;
    },
  ): Promise<ChildSeatAvailabilityDto> {
    const [etat, engaged, vehicle] = await Promise.all([
      this.etatOf(fleetId),
      this.engaged(fleetId, start, end, opts),
      opts?.installed || !opts?.vehicleId
        ? Promise.resolve(null)
        : this.prisma.vehicle.findUnique({
            where: { id: opts.vehicleId },
            select: { plate: true, childSeatsBaby: true, childSeatsChild: true },
          }),
    ]);
    const vehicleInstalled = opts?.installed
      ? opts.installed
      : vehicle
        ? { baby: vehicle.childSeatsBaby ?? 0, child: vehicle.childSeatsChild ?? 0 }
        : null;
    return {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      policy: etat.policy,
      total: etat.total,
      installed: etat.installed,
      stock: etat.stock,
      engaged,
      available: moins(etat.stock, engaged),
      vehicleInstalled,
      vehiclePlate: vehicle?.plate ?? null,
    };
  }

  /** Disponibilité pour un utilisateur (garde de périmètre) — la feuille de réservation s'en sert. */
  async availabilityFor(
    user: AuthUser,
    query: { fleetId?: string; startAt: string; endAt: string; excludeId?: string; vehicleId?: string },
  ): Promise<ChildSeatAvailabilityDto> {
    const id = this.resolveFleetId(user, query.fleetId);
    const start = new Date(query.startAt);
    const end = new Date(query.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
      throw new BadRequestException('Créneau invalide (dates ISO requises).');
    }
    let excludeBookingRef: string | null = null;
    if (query.excludeId) {
      const row = await this.prisma.vehicleEvent.findUnique({ where: { id: query.excludeId }, select: { fleetId: true, metadata: true } });
      if (row && row.fleetId === id) {
        const ref = (row.metadata as { bookingRef?: unknown } | null)?.bookingRef;
        excludeBookingRef = typeof ref === 'string' && ref ? ref : null;
      }
    }
    // Un véhicule d'une autre société ne dit rien de celle-ci : ignoré plutôt que refusé (la
    // feuille passe ce qu'elle a sous la main, et le serveur revalide à l'envoi de toute façon).
    let vehicleId = query.vehicleId || undefined;
    if (vehicleId) {
      const v = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { fleetId: true } });
      if (!v || v.fleetId !== id) vehicleId = undefined;
    }
    return this.availability(id, start, end, { excludeId: query.excludeId, excludeBookingRef, vehicleId });
  }

  /**
   * Refuse (409) si le besoin ne peut pas être couvert avec ce véhicule (sièges à bord + stock
   * selon la politique). Un besoin nul ne coûte AUCUNE requête : la plupart des réservations
   * n'ont pas d'enfant à bord, et le VPS n'a que 2 vCPU.
   */
  async assertAvailable(
    fleetId: string,
    start: Date,
    end: Date,
    need: ChildSeatCounts,
    opts?: {
      vehicleId?: string;
      installed?: ChildSeatCounts;
      includeRequested?: boolean;
      excludeId?: string;
      excludeBookingRef?: string | null;
    },
  ): Promise<void> {
    if (aucun(need)) return;
    const avail = await this.availability(fleetId, start, end, opts);
    const manque = ChildSeatsService.manque(avail, need);
    if (manque) throw new ConflictException(manque);
  }

  // ─── Helpers purs (réutilisés par le vivier, le lien public et l'IA) ────────

  /** Le besoin porté par des critères (corps non typé à l'exécution → entiers sûrs). */
  static needOf(criteria: ReservationCriteria | null | undefined): ChildSeatCounts {
    const c = (criteria ?? {}) as { childSeatsBaby?: unknown; childSeatsChild?: unknown };
    return { baby: ChildSeatsService.cleanNeed(c.childSeatsBaby), child: ChildSeatsService.cleanNeed(c.childSeatsChild) };
  }

  /** Entier dans [0, 50] ; tout le reste vaut 0 (un besoin ne se devine pas). */
  static cleanNeed(v: unknown): number {
    if (v === null || v === undefined || v === '') return 0;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(50, n) : 0;
  }

  /** Ce que le STOCK devrait fournir pour couvrir `need` avec `installed` à bord (jamais négatif). */
  static fromStock(need: ChildSeatCounts, installed: ChildSeatCounts | null | undefined): ChildSeatCounts {
    return moins(need, installed ?? zero());
  }

  /**
   * Le besoin est-il couvert avec un véhicule ayant `installed` à bord, dans l'état `avail` ?
   * `INSTALLED_ONLY` : tout doit être à bord. Sinon : le reste doit tenir dans le stock disponible.
   */
  static couvre(avail: Pick<ChildSeatAvailabilityDto, 'policy' | 'available'>, need: ChildSeatCounts, installed: ChildSeatCounts | null | undefined): boolean {
    const reste = ChildSeatsService.fromStock(need, installed);
    if (avail.policy === 'INSTALLED_ONLY') return aucun(reste);
    return reste.baby <= avail.available.baby && reste.child <= avail.available.child;
  }

  /**
   * La phrase du refus, ou null si tout tient. Elle nomme le TYPE qui manque, ce qui est à bord et
   * ce que le stock peut encore donner : c'est ce que l'exploitant lit pour décider — changer de
   * véhicule, installer un siège, déplacer le créneau, ou changer le réglage.
   */
  static manque(avail: ChildSeatAvailabilityDto, need: ChildSeatCounts): string | null {
    const aBord = avail.vehicleInstalled ?? zero();
    const reste = moins(need, aBord);
    const vehicule = avail.vehiclePlate ? `${avail.vehiclePlate}` : 'le véhicule';
    const type = (t: 'baby' | 'child') => `« ${t === 'baby' ? CHILD_SEAT_LABELS.BABY : CHILD_SEAT_LABELS.CHILD} »`;
    if (avail.policy === 'INSTALLED_ONLY') {
      const parts = (['baby', 'child'] as const)
        .filter((t) => reste[t] > 0)
        .map((t) => `${reste[t]} siège(s) ${type(t)} (${aBord[t]} à bord)`);
      if (parts.length === 0) return null;
      return (
        `Sièges auto insuffisants : il manque ${parts.join(' et ')} à bord de ${vehicule}, et la société ne prend pas ` +
        'les sièges sur le stock (réglage « Sièges installés seulement »). Choisissez un véhicule équipé, ' +
        "ou changez le réglage dans Paramètres de l'agenda."
      );
    }
    const parts = (['baby', 'child'] as const)
      .filter((t) => reste[t] > avail.available[t])
      .map((t) => `${reste[t] - avail.available[t]} siège(s) ${type(t)} (${aBord[t]} à bord, ${avail.available[t]} disponible(s) en stock sur ${avail.stock[t]})`);
    if (parts.length === 0) return null;
    const rienPossede = avail.total.baby === 0 && avail.total.child === 0;
    return rienPossede
      ? `Sièges auto insuffisants : aucun siège n'est renseigné pour cette société (Paramètres de l'agenda → Sièges auto). Il manque ${parts.join(' et ')}.`
      : `Sièges auto insuffisants sur ce créneau : il manque ${parts.join(' et ')}. Les deux types ne se remplacent pas.`;
  }

  /** Les critères tels qu'on les ÉCRIT en base : entiers sûrs, sans clé vide. */
  static criteresPropres(criteria: ReservationCriteria | null | undefined): ReservationCriteria | null {
    if (!criteria || typeof criteria !== 'object') return null;
    const c = criteria as { minSeats?: unknown; requiredFeatures?: unknown };
    const out: ReservationCriteria = {};
    const minSeats = Math.floor(Number(c.minSeats));
    if (Number.isFinite(minSeats) && minSeats > 0) out.minSeats = minSeats;
    const need = ChildSeatsService.needOf(criteria);
    if (need.baby > 0) out.childSeatsBaby = need.baby;
    if (need.child > 0) out.childSeatsChild = need.child;
    if (Array.isArray(c.requiredFeatures)) {
      const rf = c.requiredFeatures.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (rf.length > 0) out.requiredFeatures = rf;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  private cleanStock(v: unknown, type: string): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`Nombre de sièges « ${type} » invalide (entier ≥ 0 attendu).`);
    return Math.min(STOCK_MAX, n);
  }

  private cleanVehicle(v: unknown, type: string): number {
    const n = v === undefined || v === null || v === '' ? 0 : Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`Sièges « ${type} » à bord invalides (entier ≥ 0 attendu).`);
    return Math.min(VEHICLE_MAX, n);
  }

  private cleanPolicy(v: unknown): ChildSeatPolicy {
    if (typeof v === 'string' && (POLICIES as string[]).includes(v)) return v as ChildSeatPolicy;
    throw new BadRequestException('Réglage des sièges auto inconnu (« Sièges installés + stock » ou « Sièges installés seulement »).');
  }

  /** Résout la société cible (la sienne, ou celle passée pour un super-admin) + garde de périmètre. */
  private resolveFleetId(user: AuthUser, fleetId?: string): string {
    const id = fleetId ?? user.fleetId ?? undefined;
    if (!id) throw new BadRequestException('Préciser la société (fleetId).');
    if (user.role !== UserRole.SUPER_ADMIN && id !== user.fleetId) {
      throw new ForbiddenException('Société hors périmètre.');
    }
    return id;
  }
}
