import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { UserRole } from '@prisma/client';
import type {
  CreateReservationBookingLinkDto,
  ParsedNeedDto,
  PublicReservationLinkDto,
  ReservationBookingLinkDto,
  SubmitPublicReservationDto,
  SubmitPublicReservationResultDto,
  SuggestedVehicleDto,
} from '@vizyo/tracky-shared';
import { Optional } from '@nestjs/common';
import type { ChildSeatCounts } from '@vizyo/tracky-shared';
import { CHILD_SEAT_LABELS } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { ChildSeatsService } from '../agenda/child-seats.service';
import { fleetTzFormatter, localParts, localWallToUtc } from '../agenda/fleet-tz.util';
import { ReservationsService } from '../agenda/reservations.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { classerEchecIa } from '../ai/ai-client.types';
import { AiRouter } from '../ai/ai-router.service';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { ReservationBookingNotifier } from './reservation-booking-notifier.service';
import { BOOKING_PARSE_SCHEMA, renderBookingParseSystem } from './reservation-parse.prompt';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Extrait un nombre de places d'un texte libre (« 11 places », « 9 personnes »…).
 * « 2 sièges bébé » ou « 1 siège auto » ne sont PAS des places : ce sont des sièges auto (regex
 * dédiées ci-dessous) — d'où l'exclusion sur ce qui suit « siège ».
 */
const SEATS_RE = /(\d{1,3})\s*(?:places?|pax|personnes?|passagers?|si[èe]ges?(?!\s*(?:auto|b[ée]b[ée]|enfant|r[ée]hausseur|coque|cosy|nacelle)))/i;
/**
 * Sièges auto dictés, par type — deux types jamais interchangeables (2026-09-28).
 * « 2 sièges bébé », « un cosy », « une coque », « 1 nacelle » → bébé ;
 * « 3 sièges enfant », « deux rehausseurs », « 1 siège auto enfant » → enfant.
 * Le nombre peut être en chiffres ou en lettres (un/une/deux/trois/quatre).
 */
const NOMBRE = '(\\d{1,2}|un|une|deux|trois|quatre|cinq|six)';
const BABY_SEATS_RE = new RegExp(`${NOMBRE}\\s*(?:si[èe]ges?\\s*)?(?:auto\\s*)?(?:(?:pour\\s+)?b[ée]b[ée]s?|cosys?|coques?|nacelles?)`, 'i');
const CHILD_SEATS_RE = new RegExp(`${NOMBRE}\\s*(?:si[èe]ges?\\s*)?(?:auto\\s*)?(?:(?:pour\\s+)?enfants?|r[ée]hausseurs?)`, 'i');
const NOMBRES_EN_LETTRES: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6 };
/** Extrait une destination (« pour Carcassonne », « vers Toulouse »…). */
const DEST_RE = /(?:pour|vers|à|a|direction|jusqu'?[àa])\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' \-]{1,39})/i;

type LinkRow = {
  id: string;
  fleetId: string;
  token: string;
  label: string | null;
  active: boolean;
  expiresAt: Date | null;
  horizonDays: number;
  leadHours: number;
  openCount: number;
  firstOpenedAt: Date | null;
  lastOpenedAt: Date | null;
  createdAt: Date;
  fleet?: { name: string | null } | null;
};

/**
 * Refonte agenda/IA (2026-07, P4) — Lien PUBLIC de demande de réservation.
 * Admin : génère un lien à SOCIÉTÉ FIXE. Public (hors auth) : un tiers décrit un besoin, l'app
 * propose des véhicules/combinaisons DISPONIBLES de cette société (déterministe), et la soumission
 * crée des demandes REQUESTED (file de validation). Anti-tamper : les véhicules soumis doivent
 * appartenir à la société du lien. Le lien = une société → aucun mélange inter-flottes.
 */
@Injectable()
export class ReservationBookingService {
  private readonly logger = new Logger(ReservationBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationsService,
    private readonly systemActivity: SystemActivityService,
    private readonly notifier: ReservationBookingNotifier,
    // IA d'analyse OPTIONNELLE (voix → champs). Injectée en prod (AiRouter @Global) ; omise en spec → repli déterministe.
    private readonly ai?: AiRouter,
    private readonly aiUsage?: AiUsageService,
    // Centre d'alerte (@Global) : remonte l'échec de l'analyse IA du besoin dicté (best-effort mais visible).
    private readonly errorLogger?: ErrorLogger,
    // Interrupteur maître IA par flotte (@Global) : si la flotte a désactivé l'IA, on n'affine pas au LLM.
    // Placé EN FIN pour ne pas décaler les constructions positionnelles des specs (DI = par type).
    private readonly aiAvail?: AiAvailabilityService,
    /**
     * Sièges auto (2026-09-28) : le stock de la société borne aussi les demandes publiques — en
     * comptant les demandes en attente, comme pour les véhicules. Exporté par AgendaModule.
     * `@Optional()` : les specs construisent ce service à la main ; sans lui, pas de contrôle.
     */
    @Optional() private readonly childSeats?: ChildSeatsService,
  ) {}

  private resolveFleetId(user: AuthUser, fleetId?: string): string {
    const id = fleetId ?? user.fleetId ?? undefined;
    if (!id) throw new BadRequestException('Préciser la flotte (fleetId).');
    if (user.role !== UserRole.SUPER_ADMIN && id !== user.fleetId) {
      throw new ForbiddenException('Flotte hors périmètre.');
    }
    return id;
  }

  private publicUrl(token: string): string {
    const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    return `${base}/reserve/${token}`;
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  async createLink(user: AuthUser, dto: CreateReservationBookingLinkDto): Promise<ReservationBookingLinkDto> {
    const fleetId = this.resolveFleetId(user, dto?.fleetId);
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true, name: true } });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    const token = randomBytes(32).toString('base64url');
    const row = (await this.prisma.reservationBookingLink.create({
      data: {
        fleetId,
        token,
        label: dto?.label?.trim() || null,
        horizonDays: this.clampInt(dto?.horizonDays, 30, 1, 365),
        leadHours: this.clampInt(dto?.leadHours, 2, 0, 168),
        createdByUserId: user.id,
      },
    })) as LinkRow;
    return this.toLinkDto(row, fleet.name);
  }

  async listLinks(user: AuthUser, fleetId?: string): Promise<ReservationBookingLinkDto[]> {
    let where: { fleetId?: string };
    if (user.role === UserRole.SUPER_ADMIN) {
      where = fleetId ? { fleetId } : {};
    } else {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée.');
      where = { fleetId: user.fleetId };
    }
    const rows = (await this.prisma.reservationBookingLink.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { fleet: { select: { name: true } } },
    })) as LinkRow[];
    return rows.map((r) => this.toLinkDto(r, r.fleet?.name ?? null));
  }

  async setActive(user: AuthUser, id: string, active: boolean): Promise<ReservationBookingLinkDto> {
    const row = (await this.prisma.reservationBookingLink.findUnique({ where: { id } })) as LinkRow | null;
    if (!row) throw new NotFoundException('Lien introuvable.');
    if (user.role !== UserRole.SUPER_ADMIN && row.fleetId !== user.fleetId) throw new NotFoundException('Lien introuvable.');
    const updated = (await this.prisma.reservationBookingLink.update({
      where: { id },
      data: { active: !!active },
      include: { fleet: { select: { name: true } } },
    })) as LinkRow;
    return this.toLinkDto(updated, updated.fleet?.name ?? null);
  }

  // ─── Public (hors auth) ────────────────────────────────────────────────────

  private async loadActiveLink(token: string): Promise<LinkRow> {
    const link = (await this.prisma.reservationBookingLink.findUnique({
      where: { token },
      include: { fleet: { select: { name: true } } },
    })) as LinkRow | null;
    if (!link || !link.active) throw new NotFoundException('Lien introuvable ou désactivé.');
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) throw new NotFoundException('Lien expiré.');
    return link;
  }

  async getPublic(token: string): Promise<PublicReservationLinkDto> {
    const link = await this.loadActiveLink(token);
    // Suivi d'ouverture (fire-and-forget, ne bloque jamais la page publique).
    this.prisma.reservationBookingLink
      .update({
        where: { id: link.id },
        data: {
          openCount: { increment: 1 },
          lastOpenedAt: new Date(),
          ...(link.firstOpenedAt ? {} : { firstOpenedAt: new Date() }),
        },
      })
      .catch(() => undefined);
    return { fleetName: link.fleet?.name ?? null, label: link.label, horizonDays: link.horizonDays, leadHours: link.leadHours };
  }

  /**
   * Analyse IA RAPIDE d'un besoin dicté (voix → texte) : renvoie places / destination / créneau.
   * Repli DÉTERMINISTE toujours calculé (regex places + destination + dates courantes FR) ; Claude
   * (si configuré) affine la compréhension du langage naturel. Best-effort : jamais d'échec public.
   */
  async parsePublic(token: string, text: string): Promise<ParsedNeedDto> {
    const link = await this.loadActiveLink(token);
    const clean = (text || '').trim().slice(0, 500);
    if (!clean) return { seatsNeeded: null, childSeatsBaby: null, childSeatsChild: null, destination: null, startAt: null, endAt: null };

    const when = this.parseWhen(clean);
    const sieges = this.parseChildSeats(clean);
    const deterministic: ParsedNeedDto = {
      seatsNeeded: this.parseSeatsOrNull(clean),
      childSeatsBaby: sieges.baby,
      childSeatsChild: sieges.child,
      destination: this.extractDestination(clean),
      startAt: when.startAt,
      endAt: when.endAt,
    };

    // Interrupteur maître : si la flotte a désactivé l'IA, on garde le repli déterministe (pas de LLM).
    const aiEnabled = this.aiAvail ? await this.aiAvail.isEnabledForFleet(link.fleetId, 'bookingParse') : true;
    if (this.ai?.isConfigured() && this.aiUsage && aiEnabled) {
      try {
        const nowIso = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
        const call = await this.ai.completeJson<{
          seatsNeeded: number | null; childSeatsBaby: number | null; childSeatsChild: number | null;
          destination: string | null; startAt: string | null; endAt: string | null;
        }>({
          system: renderBookingParseSystem(nowIso),
          userPayload: { text: clean },
          schema: BOOKING_PARSE_SCHEMA,
          maxTokens: 400,
        }, { trace: { action: 'booking_parse', userId: null, fleetId: link.fleetId } });
        const r = call.result ?? ({} as {
          seatsNeeded?: unknown; childSeatsBaby?: unknown; childSeatsChild?: unknown;
          destination?: unknown; startAt?: unknown; endAt?: unknown;
        });
        void this.aiUsage.record({
          userId: null, fleetId: link.fleetId, action: 'booking_parse', model: call.model, provider: call.provider,
          inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
          cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
          latencyMs: call.latencyMs, ok: true,
        });
        return {
          seatsNeeded: this.cleanSeats(r.seatsNeeded) ?? deterministic.seatsNeeded,
          // L'IA prime quand elle a compris (un chiffre) ; sinon la lecture déterministe.
          childSeatsBaby: this.cleanChildSeats(r.childSeatsBaby) ?? deterministic.childSeatsBaby,
          childSeatsChild: this.cleanChildSeats(r.childSeatsChild) ?? deterministic.childSeatsChild,
          destination: typeof r.destination === 'string' && r.destination.trim() ? r.destination.trim().slice(0, 60) : deterministic.destination,
          startAt: this.validIso(r.startAt, link) ?? deterministic.startAt,
          endAt: this.validIso(r.endAt, link) ?? deterministic.endAt,
        };
      } catch (e) {
        // best-effort : on garde l'analyse déterministe (aucun échec propagé au demandeur public), MAIS
        // on remonte au centre d'alerte (l'admin voit les pannes IA du parsing vocal : clé, quota, timeout)
        // — avec le NIVEAU décidé par la couche IA et le motif du fournisseur en contexte (C3 point 5).
        this.logger.warn(`parsePublic (IA) ${link.fleetId} : ${(e as Error)?.message ?? e}`);
        const { niveau, kind, motifFournisseur } = classerEchecIa(e);
        void this.errorLogger
          ?.record(e as Error, 'BOOKING_PARSE_AI', { fleetId: link.fleetId, phase: 'parsePublic', kind, motifFournisseur }, niveau)
          .catch(() => {});
      }
    }
    return deterministic;
  }

  async submitPublic(token: string, dto: SubmitPublicReservationDto): Promise<SubmitPublicReservationResultDto> {
    const link = await this.loadActiveLink(token);
    const slot = this.validateSlot(dto?.startAt, dto?.endAt, link);
    const seatsNeeded = this.resolveSeats(dto);
    // Contact OBLIGATOIRE (e-mail ou téléphone) : sans lui, impossible de renvoyer la validation.
    const contact = (dto?.requesterContact || '').trim();
    if (!contact) {
      throw new BadRequestException('Un e-mail ou un numéro de téléphone est obligatoire pour recevoir la validation de la réservation.');
    }
    // #4 — Lien PUBLIC : le demandeur NE VOIT NI NE CHOISIT de véhicule (données sensibles). C'est
    // le SERVEUR qui trouve le(s) véhicule(s) libre(s) couvrant le besoin (même logique que la
    // suggestion), invisibles au demandeur. `vehicleIds` du client est IGNORÉ (anti-fuite/anti-tamper).
    const start = new Date(slot.startAt);
    const end = new Date(slot.endAt);
    // #5 — Entrée publique non authentifiée : borne la destination comme requester(120)/contact(160)/freeText(500).
    const destination = ((dto?.destination?.trim() || this.extractDestination(dto?.freeText)) ?? null)?.slice(0, 120) ?? null;

    // Sièges auto (2026-09-28) : le besoin vient des champs du formulaire, sinon de la phrase
    // dictée. Il entre dans les CRITÈRES du vivier : un véhicule sans les sièges à bord n'y reste
    // que si le stock du créneau (demandes en attente comprises) peut compléter — selon la
    // politique de la société. Le message de refus reste SANS chiffre (anti-sondage via le lien
    // public) mais nomme le TYPE qui manque : c'est ce que le demandeur peut corriger.
    const sieges = this.resolveChildSeats(dto);
    const aBesoinSieges = sieges.baby > 0 || sieges.child > 0;
    const { combination, freeCount, withSeatsCount, deplacements, excludedChildSeats } = await this.pickCombination(link.fleetId, slot, seatsNeeded, sieges);
    const totalSeats = combination.reduce((s, v) => s + (v.seats ?? 0), 0);
    if (combination.length === 0 || totalSeats < seatsNeeded) {
      // Des véhicules étaient libres mais aucun ne peut recevoir les sièges demandés : dire les
      // sièges, pas le créneau — sinon le demandeur change d'horaire pour rien.
      if (aBesoinSieges && excludedChildSeats > 0 && this.childSeats) {
        const avail = await this.childSeats.availability(link.fleetId, start, end, { includeRequested: true });
        throw new BadRequestException(this.refusSieges(this.siegesIndisponibles(avail, sieges, { baby: 0, child: 0 })));
      }
      // Messages SANS chiffre (anti-sondage capacité) + cause juste : si des véhicules sont libres mais
      // qu'aucun n'a de nombre de places renseigné, ce n'est pas le créneau qui est en cause.
      if (withSeatsCount === 0 && freeCount > 0) {
        throw new BadRequestException(
          "La capacité des véhicules n'est pas encore renseignée par l'organisation : votre demande ne peut pas être traitée automatiquement. Contactez directement l'organisation.",
        );
      }
      throw new BadRequestException(
        "Aucun véhicule n'est disponible pour ce besoin sur ce créneau. Essayez un autre horaire.",
      );
    }

    // Une demande GROUPÉE (plusieurs véhicules) porte UN besoin de sièges : ce que ses véhicules ont
    // à bord s'additionne, le stock fournit le reste. Le vivier a jugé chaque véhicule seul ; ici
    // on juge la combinaison — c'est elle qui sera validée d'un seul geste.
    if (aBesoinSieges && this.childSeats) {
      const aBord = combination.reduce(
        (acc, v) => ({ baby: acc.baby + (v.childSeatsInstalled?.baby ?? 0), child: acc.child + (v.childSeatsInstalled?.child ?? 0) }),
        { baby: 0, child: 0 },
      );
      const avail = await this.childSeats.availability(link.fleetId, start, end, { includeRequested: true, installed: aBord });
      const indisponibles = this.siegesIndisponibles(avail, sieges, aBord);
      if (indisponibles.length > 0) throw new BadRequestException(this.refusSieges(indisponibles));
    }

    const requester = (dto?.requesterName || '').trim().slice(0, 120) || 'Demande publique';
    const bookingRef = randomBytes(8).toString('hex');
    const title = `Demande publique${destination ? ' → ' + destination : ''}`;

    let created = 0;
    for (const v of combination) {
      // REQUESTED = non bloquant : la validation humaine tranche (elle peut réaffecter le véhicule).
      await this.reservations.systemRequest({
        fleetId: link.fleetId,
        vehicleId: v.vehicleId,
        start,
        end,
        title,
        metadata: {
          public: true,
          bookingRef,
          linkId: link.id,
          requester,
          requesterContact: contact.slice(0, 160),
          seatsNeeded,
          // Le besoin de sièges vit dans `criteria`, comme pour une réservation interne : c'est là
          // que le stock se recompte à chaque validation (une demande groupée = un seul besoin,
          // dédoublonné par `bookingRef`). Absent quand il n'y a pas d'enfant à bord.
          ...(sieges.baby > 0 || sieges.child > 0
            ? { criteria: { ...(sieges.baby > 0 ? { childSeatsBaby: sieges.baby } : {}), ...(sieges.child > 0 ? { childSeatsChild: sieges.child } : {}) } }
            : {}),
          destination,
          freeText: (dto?.freeText || '').slice(0, 500),
          /**
           * Lot 3b — LE DÉPLACEMENT SE DIT AU VALIDEUR.
           *
           * Quand plus aucun véhicule n'est libre de tout engagement, on pioche dans ceux qu'une
           * proposition de l'agent retenait sur ce créneau. C'est le bon arbitrage — une demande
           * humaine passe avant une suggestion de machine — mais il ne doit pas être SILENCIEUX :
           * valider cette demande écartera la proposition, et celui qui valide doit le savoir.
           * Vide dans le cas normal, donc invisible tant que ça n'arrive pas.
           */
          ...(deplacements.length > 0 ? { deplaceePropositions: deplacements } : {}),
        },
      });
      created++;
    }

    // Accusé de réception au demandeur (best-effort ; tout échec d'envoi → centre d'alerte admin).
    void this.notifier.sendAcknowledgment({
      fleetId: link.fleetId,
      contact,
      destination,
      startAt: slot.startAt,
      endAt: slot.endAt,
      seats: seatsNeeded,
      childSeats: sieges,
    });

    /**
     * P0-1 — ET ON PRÉVIENT LA SOCIÉTÉ (2026-09-23).
     *
     * La ligne du dessus existait depuis l'origine ; celle-ci manquait. Promettre au demandeur
     * « vous recevrez la confirmation dès sa validation » sans prévenir personne qu'il y a
     * quelque chose à valider, c'est une promesse que l'application ne pouvait pas tenir.
     *
     * `void` comme l'accusé de réception : l'envoi ne doit ni retarder ni faire échouer la
     * réponse au demandeur. La demande est déjà en base quand on arrive ici.
     */
    void this.notifier.notifyFleetOfPendingRequest({
      fleetId: link.fleetId,
      requester,
      contact,
      destination,
      startAt: slot.startAt,
      endAt: slot.endAt,
      seats: seatsNeeded,
      childSeats: sieges,
      vehicleCount: created,
    });

    const siegesTxt = [
      sieges.baby > 0 ? `${sieges.baby} siège(s) bébé` : '',
      sieges.child > 0 ? `${sieges.child} siège(s) enfant` : '',
    ].filter(Boolean).join(', ');
    this.systemActivity.record({
      category: 'RESERVATION',
      action: 'public_booking_submitted',
      status: 'SUCCESS',
      actor: 'client',
      detail: `Demande publique : ${created} véhicule(s), ${seatsNeeded} place(s)${siegesTxt ? ', ' + siegesTxt : ''}${destination ? ' → ' + destination : ''}`,
      fleetId: link.fleetId,
      meta: { created, seatsNeeded, childSeatsBaby: sieges.baby, childSeatsChild: sieges.child, linkId: link.id },
    });
    // Message générique (pas de nombre de véhicules : anti-sondage capacité via le lien public).
    return { created, message: 'Demande envoyée. Vous recevrez la confirmation dès sa validation par l\'organisation.' };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Écarte les véhicules déjà retenus par une PROPOSITION EN ATTENTE de l'agent (chevauchant le créneau). */
  /**
   * ── LOT 3B — LE CLASSEMENT EN TROIS RANGS (2026-09-23) ──────────────────────────────────────
   *
   * ┌─ CE QUE FAISAIT LA VERSION PRÉCÉDENTE ────────────────────────────────────┐
   * │ Elle RETIRAIT purement et simplement les véhicules retenus par une        │
   * │ proposition de l'agent. Conséquence : quand l'agent avait pré-rempli le   │
   * │ créneau — ce qui, chez cdef31, concernait 21 véhicules sur 30 — la        │
   * │ demande d'un conducteur était REFUSÉE (« aucun véhicule disponible »)     │
   * │ alors que des voitures étaient bel et bien libres. Une suggestion faite   │
   * │ par la machine l'emportait sur une demande faite par un humain.           │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * On CLASSE au lieu d'exclure, dans l'ordre demandé par le propriétaire :
   *
   *   RANG 1 — aucun engagement du tout sur l'horizon : ni réservation, ni proposition.
   *            C'est le véhicule qu'on veut donner : le prendre ne déplace rien.
   *   RANG 2 — libre sur CE créneau, mais engagé D'AUTRES JOURS (proposition ou réservation
   *            automatique ailleurs). Le prendre ne casse rien non plus, c'est juste moins net.
   *   RANG 3 — une proposition de l'agent couvre CE créneau précis. Le prendre la DÉPLACE :
   *            c'est un dernier recours, et le valideur doit le savoir avant de dire oui.
   *
   * À rang égal, le plus grand nombre de places d'abord (inchangé) : c'est ce qui permet de
   * couvrir le besoin avec le moins de véhicules.
   */
  private async classerParEngagement(
    fleetId: string,
    startAt: string,
    endAt: string,
    vehicles: SuggestedVehicleDto[],
  ): Promise<{ vehicule: SuggestedVehicleDto; rang: 1 | 2 | 3; propositionDeplacee: string | null }[]> {
    if (vehicles.length === 0) return [];
    const start = new Date(startAt);
    const end = new Date(endAt);
    const ids = vehicles.map((v) => v.vehicleId);

    // Horizon d'« engagé ailleurs » : la fenêtre de projection de l'agent (14 j). Au-delà, un
    // engagement lointain ne dit plus rien de la disponibilité réelle de ce véhicule.
    const horizon = new Date(start.getTime() + 14 * 24 * 3600 * 1000);

    const [surLeCreneau, ailleurs] = await Promise.all([
      // Propositions qui couvrent CE créneau : les prendre déplace quelque chose.
      this.prisma.agendaAgentProposal.findMany({
        where: { fleetId, status: 'pending', startAt: { lt: end }, endAt: { gt: start }, vehicleId: { in: ids } },
        select: { id: true, vehicleId: true },
      }),
      // Engagements AILLEURS sur l'horizon : propositions en attente…
      this.prisma.agendaAgentProposal.findMany({
        where: { fleetId, status: 'pending', startAt: { gte: start, lt: horizon }, vehicleId: { in: ids } },
        select: { vehicleId: true },
      }),
    ]);

    // …et réservations fermes déjà posées (dont les réservations SYSTÈME héritées de l'agent).
    const resaAilleurs = await this.prisma.vehicleEvent.findMany({
      where: {
        fleetId,
        type: 'RESERVATION',
        status: { in: ['CONFIRMED', 'IN_PROGRESS', 'REQUESTED'] },
        startAt: { gte: start, lt: horizon },
        vehicleId: { in: ids },
      },
      select: { vehicleId: true },
    });

    const deplaceePar = new Map(surLeCreneau.map((p) => [p.vehicleId, p.id]));
    const engageAilleurs = new Set<string>([
      ...ailleurs.map((p) => p.vehicleId),
      ...resaAilleurs.map((e) => e.vehicleId),
    ]);

    // À rang égal (2026-09-28) : d'abord le véhicule qui a déjà les sièges auto À BORD (rien à
    // installer, stock préservé), puis le plus grand nombre de places.
    const duStock = (v: SuggestedVehicleDto) => (v.childSeatsFromStock?.baby ?? 0) + (v.childSeatsFromStock?.child ?? 0);
    return vehicles
      .map((v) => {
        const propositionDeplacee = deplaceePar.get(v.vehicleId) ?? null;
        const rang: 1 | 2 | 3 = propositionDeplacee ? 3 : engageAilleurs.has(v.vehicleId) ? 2 : 1;
        return { vehicule: v, rang, propositionDeplacee };
      })
      .sort(
        (a, b) =>
          a.rang - b.rang ||
          duStock(a.vehicule) - duStock(b.vehicule) ||
          (b.vehicule.seats ?? 0) - (a.vehicule.seats ?? 0),
      );
  }

  /**
   * #4 — Sélection SERVEUR de la combinaison de véhicules libres couvrant le besoin (lien public :
   * le demandeur ne voit rien). Réutilise la logique de disponibilité (exclut réservés / en attente /
   * tenus par l'agent) + la combinaison greedy.
   */
  private async pickCombination(
    fleetId: string,
    slot: { startAt: string; endAt: string },
    seatsNeeded: number,
    sieges: ChildSeatCounts,
  ): Promise<{
    combination: SuggestedVehicleDto[];
    freeCount: number;
    withSeatsCount: number;
    /** Propositions de l'agent que cette attribution déplace (rang 3). Vide dans le cas normal. */
    deplacements: { proposalId: string; plate: string | null }[];
    /** Véhicules libres écartés parce que les sièges auto demandés ne peuvent pas être couverts avec eux. */
    excludedChildSeats: number;
  }> {
    // Le besoin de sièges entre dans les critères : le vivier écarte (et compte) les véhicules qui
    // ne peuvent pas le couvrir — sièges à bord, puis stock selon la politique de la société.
    const criteria =
      sieges.baby > 0 || sieges.child > 0
        ? { ...(sieges.baby > 0 ? { childSeatsBaby: sieges.baby } : {}), ...(sieges.child > 0 ? { childSeatsChild: sieges.child } : {}) }
        : undefined;
    const avail = await this.reservations.availableForFleet(fleetId, slot.startAt, slot.endAt, criteria, { excludeRequested: true });
    // Lot 3b : on CLASSE (rang 1 → 3) au lieu d'exclure. `classerParEngagement` rend déjà la liste
    // triée par rang puis par places — `greedy` n'a plus qu'à cumuler dans cet ordre.
    const classes = await this.classerParEngagement(fleetId, slot.startAt, slot.endAt, avail.vehicles);
    const avecPlaces = classes.filter((c) => c.vehicule.seats != null);
    const retenus = this.greedy(avecPlaces.map((c) => c.vehicule), seatsNeeded);
    const rangDe = new Map(classes.map((c) => [c.vehicule.vehicleId, c]));
    // freeCount/withSeatsCount : distinguent « créneau complet » de « places non renseignées » dans le
    // message d'erreur, SANS révéler de chiffres exacts (anti-sondage de la capacité via le lien public).
    return {
      combination: retenus,
      freeCount: classes.length,
      withSeatsCount: avecPlaces.length,
      // Les propositions que cette attribution DÉPLACE : le valideur doit les voir avant de dire oui.
      deplacements: retenus
        .map((v) => rangDe.get(v.vehicleId))
        .filter((c): c is NonNullable<typeof c> => !!c && c.rang === 3)
        .map((c) => ({ proposalId: c.propositionDeplacee as string, plate: c.vehicule.vehiclePlate ?? null })),
      excludedChildSeats: avail.excludedChildSeats ?? 0,
    };
  }

  /**
   * Les TYPES de sièges que le créneau ne peut pas fournir, pour un besoin `sieges` avec `aBord`
   * déjà installés (somme des véhicules retenus). Sous « installés seulement », tout ce qui n'est
   * pas à bord manque ; sinon, ce qui dépasse le stock disponible.
   */
  private siegesIndisponibles(
    avail: { policy: string; available: ChildSeatCounts },
    sieges: ChildSeatCounts,
    aBord: ChildSeatCounts,
  ): string[] {
    const reste = ChildSeatsService.fromStock(sieges, aBord);
    const out: string[] = [];
    const manque = (t: 'baby' | 'child') => (avail.policy === 'INSTALLED_ONLY' ? reste[t] > 0 : reste[t] > avail.available[t]);
    if (manque('baby')) out.push(`« ${CHILD_SEAT_LABELS.BABY} »`);
    if (manque('child')) out.push(`« ${CHILD_SEAT_LABELS.CHILD} »`);
    return out;
  }

  /** Message public de refus pour des sièges : sans chiffre, mais avec le type. */
  private refusSieges(types: string[]): string {
    const quoi = types.length > 0 ? `Les sièges auto ${types.join(' et ')} demandés` : 'Les sièges auto demandés';
    return `${quoi} ne sont pas tous disponibles sur ce créneau. Essayez un autre horaire, ou contactez directement l'organisation.`;
  }

  /** Couvre le besoin avec le MOINS de véhicules : d'abord un seul qui suffit, sinon cumul décroissant. */
  private greedy(free: SuggestedVehicleDto[], seatsNeeded: number): SuggestedVehicleDto[] {
    const single = free.find((v) => (v.seats ?? 0) >= seatsNeeded);
    if (single) return [single];
    const out: SuggestedVehicleDto[] = [];
    let sum = 0;
    for (const v of free) {
      out.push(v);
      sum += v.seats ?? 0;
      if (sum >= seatsNeeded) break;
    }
    return out;
  }

  private resolveSeats(need: { seatsNeeded?: number; freeText?: string }): number {
    const explicit = Number(need?.seatsNeeded);
    if (Number.isFinite(explicit) && explicit > 0) return Math.min(200, Math.floor(explicit));
    const m = (need?.freeText || '').match(SEATS_RE);
    const parsed = m ? parseInt(m[1], 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(200, parsed) : 1;
  }

  private extractDestination(text?: string): string | null {
    if (!text) return null;
    const m = text.match(DEST_RE);
    if (!m) return null;
    // La capture peut déborder (« Carcassonne demain de ») : garde les mots jusqu'au 1er terme
    // temporel / numérique, et au plus 3 mots (destinations composées type « Saint-Gaudens »).
    const STOP = new Set([
      'demain', 'aujourd', "aujourd'hui", 'après', 'apres', 'matin', 'midi', 'soir', 'de', 'à', 'a',
      'le', 'la', 'pour', 'vers', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche',
    ]);
    const words: string[] = [];
    for (const w of m[1].trim().split(/\s+/)) {
      const lw = w.toLowerCase().replace(/[.,;:].*$/, '');
      if (!lw || STOP.has(lw) || /\d/.test(w)) break;
      words.push(w);
      if (words.length >= 3) break;
    }
    const dest = words.join(' ').trim();
    return dest || null;
  }

  /** Places explicitement dictées (« 11 places »), sinon null (pas de défaut à 1 pour l'analyse). */
  private parseSeatsOrNull(text: string): number | null {
    const m = text.match(SEATS_RE);
    const n = m ? parseInt(m[1], 10) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(200, n) : null;
  }

  private cleanSeats(v: unknown): number | null {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(200, n) : null;
  }

  /**
   * Sièges auto dictés, par type (null = la phrase n'en parle pas). « 2 sièges bébé et 1
   * rehausseur » → { baby: 2, child: 1 }. Déterministe ; l'IA affine par-dessus quand elle tourne.
   */
  private parseChildSeats(text: string): { baby: number | null; child: number | null } {
    const lire = (re: RegExp): number | null => {
      const m = text.match(re);
      if (!m) return null;
      const brut = m[1].toLowerCase();
      const n = NOMBRES_EN_LETTRES[brut] ?? parseInt(brut, 10);
      return Number.isFinite(n) && n > 0 ? Math.min(50, n) : null;
    };
    return { baby: lire(BABY_SEATS_RE), child: lire(CHILD_SEATS_RE) };
  }

  /** Entier dans [1, 50] renvoyé par l'IA, sinon null (jamais 0 : « aucun » = null, on garde le repli). */
  private cleanChildSeats(v: unknown): number | null {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(50, n) : null;
  }

  /**
   * Le besoin de sièges d'une soumission : les champs du formulaire s'ils sont renseignés (0
   * compris — « aucun siège » est une réponse), sinon la phrase dictée. Un besoin absent vaut 0.
   */
  private resolveChildSeats(need: { childSeatsBaby?: unknown; childSeatsChild?: unknown; freeText?: string }): ChildSeatCounts {
    const explicite = need?.childSeatsBaby !== undefined || need?.childSeatsChild !== undefined;
    if (explicite) {
      return { baby: ChildSeatsService.cleanNeed(need.childSeatsBaby), child: ChildSeatsService.cleanNeed(need.childSeatsChild) };
    }
    const dicte = this.parseChildSeats(need?.freeText || '');
    return { baby: dicte.baby ?? 0, child: dicte.child ?? 0 };
  }

  /** Valide un ISO renvoyé par l'IA (date réelle, fenêtre plausible), sinon null. */
  private validIso(s: unknown, link: LinkRow): string | null {
    if (typeof s !== 'string' || !s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    const now = Date.now();
    if (d.getTime() < now - DAY_MS || d.getTime() > now + (link.horizonDays + 1) * DAY_MS) return null;
    return d.toISOString();
  }

  private addDays(dateKey: string, n: number): string {
    const d = new Date(`${dateKey}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** Extraction DÉTERMINISTE d'un créneau depuis le langage naturel FR (jour + heures), heure Paris. */
  private parseWhen(text: string): { startAt: string | null; endAt: string | null } {
    const t = text.toLowerCase();
    const fmt = fleetTzFormatter();
    const today = localParts(fmt, Date.now()); // { dateKey, dow (1-7), minutes }

    let dayOffset = 0;
    let dayFound = false;
    if (/aujourd'?hui|ce jour|ce soir|cet? apr[eè]s-?midi|ce matin/.test(t)) {
      dayFound = true;
    } else if (/apr[eè]s[ -]?demain/.test(t)) {
      dayOffset = 2; dayFound = true;
    } else if (/demain/.test(t)) {
      dayOffset = 1; dayFound = true;
    } else {
      const DAYS = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
      for (let d = 1; d <= 7; d++) {
        if (t.includes(DAYS[d])) {
          let add = (d - today.dow + 7) % 7;
          if (add === 0) add = 7; // « lundi » un lundi = lundi PROCHAIN
          dayOffset = add; dayFound = true;
          break;
        }
      }
    }

    let startMin: number | null = null;
    let endMin: number | null = null;
    const range = t.match(/(\d{1,2})\s*h\s*(\d{2})?\s*(?:[-–]|[àa]|jusqu'?[àa])\s*(\d{1,2})\s*h\s*(\d{2})?/);
    if (range) {
      startMin = parseInt(range[1], 10) * 60 + (range[2] ? parseInt(range[2], 10) : 0);
      endMin = parseInt(range[3], 10) * 60 + (range[4] ? parseInt(range[4], 10) : 0);
    } else {
      const single = t.match(/(?:[àa]\s*)?(\d{1,2})\s*h\s*(\d{2})?/);
      if (single) startMin = parseInt(single[1], 10) * 60 + (single[2] ? parseInt(single[2], 10) : 0);
    }
    if (/\bmatin\b/.test(t)) { startMin = startMin ?? 9 * 60; endMin = endMin ?? 12 * 60; }
    else if (/apr[eè]s-?midi/.test(t)) { startMin = startMin ?? 14 * 60; endMin = endMin ?? 18 * 60; }
    else if (/\bsoir\b/.test(t)) { startMin = startMin ?? 18 * 60; endMin = endMin ?? 21 * 60; }
    else if (/\bmidi\b/.test(t) && startMin === null) { startMin = 12 * 60; }

    if (!dayFound && startMin === null) return { startAt: null, endAt: null };
    const dateKey = this.addDays(today.dateKey, dayOffset);
    const sMin = startMin ?? 9 * 60;
    const eMin = endMin ?? Math.min(23 * 60 + 59, sMin + 8 * 60);
    return {
      startAt: localWallToUtc(dateKey, sMin).toISOString(),
      endAt: localWallToUtc(dateKey, eMin).toISOString(),
    };
  }

  private validateSlot(startAt: string | undefined, endAt: string | undefined, link: LinkRow): { startAt: string; endAt: string } {
    if (!startAt || !endAt) throw new BadRequestException('Créneau requis.');
    const s = new Date(startAt);
    const e = new Date(endAt);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e.getTime() <= s.getTime()) {
      throw new BadRequestException('Créneau invalide.');
    }
    const now = Date.now();
    if (s.getTime() < now + link.leadHours * 60 * 60 * 1000) {
      throw new BadRequestException(`Créneau trop proche (délai minimum ${link.leadHours} h).`);
    }
    if (s.getTime() > now + link.horizonDays * DAY_MS) {
      throw new BadRequestException(`Créneau au-delà de l'horizon (${link.horizonDays} j).`);
    }
    return { startAt: s.toISOString(), endAt: e.toISOString() };
  }

  private clampInt(v: unknown, def: number, min: number, max: number): number {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  }

  private toLinkDto(r: LinkRow, fleetName: string | null): ReservationBookingLinkDto {
    return {
      id: r.id,
      fleetId: r.fleetId,
      fleetName,
      token: r.token,
      publicUrl: this.publicUrl(r.token),
      label: r.label,
      active: r.active,
      openCount: r.openCount,
      lastOpenedAt: r.lastOpenedAt ? r.lastOpenedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
