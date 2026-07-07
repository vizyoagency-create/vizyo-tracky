import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { UserRole } from '@prisma/client';
import type {
  CreateReservationBookingLinkDto,
  PublicReservationLinkDto,
  PublicReservationSuggestRequestDto,
  PublicReservationSuggestionDto,
  PublicSuggestedVehicleDto,
  ReservationBookingLinkDto,
  SubmitPublicReservationDto,
  SubmitPublicReservationResultDto,
  SuggestedVehicleDto,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { ReservationsService } from '../agenda/reservations.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { ReservationBookingNotifier } from './reservation-booking-notifier.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Extrait un nombre de places d'un texte libre (« 11 places », « 9 personnes »…). */
const SEATS_RE = /(\d{1,3})\s*(?:places?|pax|personnes?|passagers?|si[èe]ges?)/i;
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

  async suggestPublic(token: string, need: PublicReservationSuggestRequestDto): Promise<PublicReservationSuggestionDto> {
    const link = await this.loadActiveLink(token);
    const slot = this.validateSlot(need?.startAt, need?.endAt, link);
    const seatsNeeded = this.resolveSeats(need);
    const destination = (need?.destination?.trim() || this.extractDestination(need?.freeText)) ?? null;

    // excludeRequested : un demandeur public ne voit NI les véhicules réservés NI ceux en ATTENTE
    // (déjà demandés par un autre). On écarte AUSSI ceux déjà suggérés par l'agent (proposition en
    // attente qui chevauche) — anti-double-suggestion.
    const avail = await this.reservations.availableForFleet(link.fleetId, slot.startAt, slot.endAt, undefined, { excludeRequested: true });
    const freeVehicles = await this.withoutAgentHeld(link.fleetId, slot.startAt, slot.endAt, avail.vehicles);
    // Combinaison : véhicules libres à places CONNUES, plus grande capacité d'abord.
    const withSeats = freeVehicles.filter((v) => v.seats != null).sort((a, b) => (b.seats ?? 0) - (a.seats ?? 0));
    const combination = this.greedy(withSeats, seatsNeeded);
    const totalSeats = combination.reduce((s, v) => s + (v.seats ?? 0), 0);
    const covered = totalSeats >= seatsNeeded;
    const chosen = new Set(combination.map((v) => v.vehicleId));
    const alternatives = freeVehicles.filter((v) => !chosen.has(v.vehicleId)).map((v) => this.pubVeh(v));

    return {
      startAt: slot.startAt,
      endAt: slot.endAt,
      seatsNeeded,
      destination,
      combination: combination.map((v) => this.pubVeh(v)),
      totalSeats,
      covered,
      alternatives,
      message: covered
        ? `${combination.length} véhicule(s) proposé(s) pour ${seatsNeeded} place(s).`
        : `Places insuffisantes sur ce créneau (${totalSeats}/${seatsNeeded}). Choisissez un autre créneau ou ajoutez des véhicules.`,
    };
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
    const vehicleIds = [...new Set((dto?.vehicleIds ?? []).filter((x): x is string => typeof x === 'string' && !!x))].slice(0, 10);
    if (vehicleIds.length === 0) throw new BadRequestException('Choisissez au moins un véhicule.');

    // Anti-tamper : les véhicules DOIVENT appartenir à la société du lien.
    const vehicles = await this.prisma.vehicle.findMany({
      where: { id: { in: vehicleIds }, fleetId: link.fleetId },
      select: { id: true },
    });
    if (vehicles.length !== vehicleIds.length) throw new BadRequestException('Véhicule hors périmètre du lien.');

    const start = new Date(slot.startAt);
    const end = new Date(slot.endAt);
    const destination = (dto?.destination?.trim() || this.extractDestination(dto?.freeText)) ?? null;
    const requester = (dto?.requesterName || '').trim().slice(0, 120) || 'Demande publique';
    const bookingRef = randomBytes(8).toString('hex');
    const title = `Demande publique${destination ? ' → ' + destination : ''}`;

    let created = 0;
    for (const vehicleId of vehicleIds) {
      // REQUESTED = non bloquant : la validation humaine tranche (on ne rejette pas ici).
      await this.reservations.systemRequest({
        fleetId: link.fleetId,
        vehicleId,
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
          destination,
          freeText: (dto?.freeText || '').slice(0, 500),
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
      count: created,
    });

    this.systemActivity.record({
      category: 'RESERVATION',
      action: 'public_booking_submitted',
      status: 'SUCCESS',
      actor: 'client',
      detail: `Demande publique : ${created} véhicule(s), ${seatsNeeded} place(s)${destination ? ' → ' + destination : ''}`,
      fleetId: link.fleetId,
      meta: { created, seatsNeeded, linkId: link.id },
    });
    return { created, message: `Demande envoyée : ${created} véhicule(s), en attente de validation.` };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Écarte les véhicules déjà retenus par une PROPOSITION EN ATTENTE de l'agent (chevauchant le créneau). */
  private async withoutAgentHeld(
    fleetId: string,
    startAt: string,
    endAt: string,
    vehicles: SuggestedVehicleDto[],
  ): Promise<SuggestedVehicleDto[]> {
    if (vehicles.length === 0) return vehicles;
    const start = new Date(startAt);
    const end = new Date(endAt);
    const held = await this.prisma.agendaAgentProposal.findMany({
      where: {
        fleetId,
        status: 'pending',
        startAt: { lt: end },
        endAt: { gt: start },
        vehicleId: { in: vehicles.map((v) => v.vehicleId) },
      },
      select: { vehicleId: true },
    });
    const heldSet = new Set(held.map((h) => h.vehicleId));
    return vehicles.filter((v) => !heldSet.has(v.vehicleId));
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
    return m ? m[1].trim() : null;
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

  private pubVeh(v: SuggestedVehicleDto): PublicSuggestedVehicleDto {
    return { vehicleId: v.vehicleId, plate: v.vehiclePlate, seats: v.seats };
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
