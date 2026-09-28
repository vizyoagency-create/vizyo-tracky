import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  ChildSeatAvailabilityDto,
  ChildSeatCounts,
  ChildSeatStockDto,
  ReservationCriteria,
  SetChildSeatStockDto,
} from '@vizyo/tracky-shared';
import { CHILD_SEAT_LABELS } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';

/** Statuts qui ENGAGENT le stock : une réservation ferme, ou en cours. */
const ENGAGING: VehicleEventStatus[] = [VehicleEventStatus.CONFIRMED, VehicleEventStatus.IN_PROGRESS];
/** Un stock au-delà de ça n'est plus un stock de sièges, c'est une faute de frappe. */
const STOCK_MAX = 500;

/**
 * ── SIÈGES AUTO : UN STOCK PAR SOCIÉTÉ, DEUX TYPES (2026-09-28) ──────────────────────────────
 *
 * ┌─ CE QUI EXISTAIT ─────────────────────────────────────────────────────────┐
 * │ `Vehicle.childSeats` : un nombre PAR VÉHICULE, à renseigner voiture par   │
 * │ voiture, et que l'IA de capacité devinait d'après le modèle. Mesuré le    │
 * │ 28/09 chez le client concerné : 2 sièges déclarés sur 30 véhicules, et    │
 * │ jamais un critère de réservation posé dessus.                             │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Ce n'est pas ainsi qu'une société qui transporte des enfants travaille. Elle possède un STOCK
 * de sièges — du matériel MOBILE, qu'elle installe dans le véhicule retenu. Et il y a DEUX sortes
 * de sièges, JAMAIS interchangeables : un enfant « bébé » ne peut pas aller dans un siège
 * « enfant », ni l'inverse. Aucune substitution, dans aucun sens : c'est la règle du propriétaire,
 * et c'est une règle de sécurité.
 *
 * Le stock se règle dans « Paramètres de l'agenda ». Ce qui reste disponible sur un créneau =
 * stock − sièges engagés par les réservations fermes qui chevauchent ce créneau (leurs critères
 * `childSeatsBaby` / `childSeatsChild`). Une demande publique groupée (plusieurs véhicules pour
 * un même `bookingRef`) porte SON besoin une seule fois : on dédoublonne par référence.
 *
 * Trois surfaces s'en servent : la réservation interne (demande, validation, édition), le lien
 * public (à la soumission, en comptant aussi les demandes en attente — un demandeur public ne
 * doit pas se voir promettre un siège déjà demandé par un autre), et l'IA de placement (le
 * payload porte la disponibilité ; le service court-circuite quand le stock ne suffit pas —
 * inutile de payer des jetons pour une réponse certaine).
 */
@Injectable()
export class ChildSeatsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Lecture / réglage du stock ─────────────────────────────────────────────

  async getStock(user: AuthUser, fleetId?: string): Promise<ChildSeatStockDto> {
    const id = this.resolveFleetId(user, fleetId);
    return { fleetId: id, stock: await this.stockOf(id) };
  }

  async setStock(user: AuthUser, dto: SetChildSeatStockDto): Promise<ChildSeatStockDto> {
    const id = this.resolveFleetId(user, dto?.fleetId);
    const baby = this.cleanStock(dto?.baby, 'bébé');
    const child = this.cleanStock(dto?.child, 'enfant');
    const existing = await this.prisma.fleet.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('Société introuvable.');
    const updated = await this.prisma.fleet.update({
      where: { id },
      data: { childSeatsBaby: baby, childSeatsChild: child },
      select: { id: true, childSeatsBaby: true, childSeatsChild: true },
    });
    return { fleetId: updated.id, stock: { baby: updated.childSeatsBaby, child: updated.childSeatsChild } };
  }

  /** Le stock d'une société, sans garde de périmètre (appelants internes déjà scopés). */
  async stockOf(fleetId: string): Promise<ChildSeatCounts> {
    const f = await this.prisma.fleet.findUnique({
      where: { id: fleetId },
      select: { childSeatsBaby: true, childSeatsChild: true },
    });
    return { baby: f?.childSeatsBaby ?? 0, child: f?.childSeatsChild ?? 0 };
  }

  // ─── Disponibilité sur un créneau ───────────────────────────────────────────

  /**
   * Sièges ENGAGÉS sur [start,end) : somme des besoins des réservations qui chevauchent le créneau.
   *
   * - `includeRequested` : compte aussi les demandes EN ATTENTE (flux public, symétrique de
   *   `excludeRequested` pour les véhicules) ;
   * - `excludeId` / `excludeBookingRef` : la réservation qu'on est en train de valider ou d'éditer
   *   ne s'engage pas elle-même — et pour une demande groupée, ses sœurs déjà validées portent le
   *   MÊME besoin, qu'il ne faut pas recompter (sinon la seconde validation d'un groupe de deux
   *   véhicules serait refusée alors que le stock suffit).
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
      select: { id: true, metadata: true },
      take: 5000,
    });
    const out: ChildSeatCounts = { baby: 0, child: 0 };
    const refsVues = new Set<string>();
    for (const r of rows) {
      const meta = (r.metadata ?? {}) as { bookingRef?: unknown; criteria?: unknown };
      const ref = typeof meta.bookingRef === 'string' && meta.bookingRef ? meta.bookingRef : null;
      if (ref) {
        if (opts?.excludeBookingRef && ref === opts.excludeBookingRef) continue;
        if (refsVues.has(ref)) continue; // une demande groupée = un seul besoin
        refsVues.add(ref);
      }
      const need = ChildSeatsService.needOf(meta.criteria as ReservationCriteria | undefined);
      out.baby += need.baby;
      out.child += need.child;
    }
    return out;
  }

  async availability(
    fleetId: string,
    start: Date,
    end: Date,
    opts?: { includeRequested?: boolean; excludeId?: string; excludeBookingRef?: string | null },
  ): Promise<ChildSeatAvailabilityDto> {
    const [stock, engaged] = await Promise.all([this.stockOf(fleetId), this.engaged(fleetId, start, end, opts)]);
    return {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      stock,
      engaged,
      available: { baby: Math.max(0, stock.baby - engaged.baby), child: Math.max(0, stock.child - engaged.child) },
    };
  }

  /** Disponibilité pour un utilisateur (garde de périmètre) — la feuille de réservation s'en sert. */
  async availabilityFor(
    user: AuthUser,
    query: { fleetId?: string; startAt: string; endAt: string; excludeId?: string },
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
    return this.availability(id, start, end, { excludeId: query.excludeId, excludeBookingRef });
  }

  /**
   * Refuse (409) si le besoin dépasse ce qui reste. Un besoin nul ne coûte AUCUNE requête : la
   * plupart des réservations n'ont pas d'enfant à bord, et le VPS n'a que 2 vCPU.
   */
  async assertAvailable(
    fleetId: string,
    start: Date,
    end: Date,
    need: ChildSeatCounts,
    opts?: { includeRequested?: boolean; excludeId?: string; excludeBookingRef?: string | null },
  ): Promise<void> {
    if (need.baby <= 0 && need.child <= 0) return;
    const avail = await this.availability(fleetId, start, end, opts);
    const manque = ChildSeatsService.manque(avail, need);
    if (manque) throw new ConflictException(manque);
  }

  // ─── Helpers purs (réutilisés par le lien public et l'IA) ───────────────────

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

  /**
   * La phrase du refus, ou null si tout tient. Elle nomme le TYPE qui manque et de combien : c'est
   * ce que l'exploitant lit pour décider (déplacer le créneau, ou racheter un siège) — jamais un
   * « sièges insuffisants » qu'il faudrait aller vérifier ailleurs.
   */
  static manque(avail: ChildSeatAvailabilityDto, need: ChildSeatCounts): string | null {
    const parts: string[] = [];
    if (need.baby > avail.available.baby) {
      parts.push(`${need.baby - avail.available.baby} siège(s) « ${CHILD_SEAT_LABELS.BABY} » (${avail.available.baby} disponible(s) sur ${avail.stock.baby})`);
    }
    if (need.child > avail.available.child) {
      parts.push(`${need.child - avail.available.child} siège(s) « ${CHILD_SEAT_LABELS.CHILD} » (${avail.available.child} disponible(s) sur ${avail.stock.child})`);
    }
    if (parts.length === 0) return null;
    const stockVide = avail.stock.baby === 0 && avail.stock.child === 0;
    return stockVide
      ? `Sièges auto insuffisants : aucun stock de sièges n'est renseigné pour cette société (Paramètres de l'agenda → Sièges auto). Il manque ${parts.join(' et ')}.`
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
    if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`Stock de sièges « ${type} » invalide (entier ≥ 0 attendu).`);
    return Math.min(STOCK_MAX, n);
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
