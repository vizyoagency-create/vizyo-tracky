import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Prisma, InstallationBookingStatus, InstallationPlanStatus } from '@prisma/client';
import type {
  CreatePublicBookingDto,
  InstallationBookingDto,
  InstallationBookingLinkDto,
  PublicBookingLinkDto,
  PublicBookingResultDto,
} from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import {
  type SlotConfig,
  generateAvailability,
  parisParts,
  slotLabel,
} from './installation-booking.slots';
import type {
  CreateBookingLinkDto,
  UpdateBookingLinkDto,
  ConfirmBookingDto,
  RejectBookingDto,
} from './dto/installation-booking.dto';

/** Statuts qui OCCUPENT un créneau (source de la disponibilité + contrainte EXCLUDE). */
const ACTIVE: InstallationBookingStatus[] = ['PENDING', 'CONFIRMED'];
/** Notification opérateur — le client l'a demandé sur cette boîte. */
const CONTACT_EMAIL = 'contact@vizyoagency.com';

type LinkRow = Prisma.InstallationBookingLinkGetPayload<{ include: { fleet: { select: { name: true } } } }>;
type BookingRow = Prisma.InstallationBookingGetPayload<{ include: { link: { select: { label: true; planId: true } } } }>;

@Injectable()
export class InstallationBookingService {
  private readonly logger = new Logger(InstallationBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
    private readonly systemActivity: SystemActivityService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private publicUrl(token: string): string {
    return `${this.appBase()}/book/${token}`;
  }

  private configOf(link: {
    slotMinutes: number; dayStartMinutes: number; dayEndMinutes: number;
    workingDays: number[]; horizonDays: number; leadHours: number;
  }): SlotConfig {
    return {
      slotMinutes: link.slotMinutes,
      dayStartMinutes: link.dayStartMinutes,
      dayEndMinutes: link.dayEndMinutes,
      workingDays: link.workingDays,
      horizonDays: link.horizonDays,
      leadHours: link.leadHours,
    };
  }

  /** Intervalles occupés GLOBALEMENT (capacité 1 équipe) sur le futur proche. */
  private async busyIntervals(now: Date): Promise<{ startMs: number; endMs: number }[]> {
    const rows = await this.prisma.installationBooking.findMany({
      where: { status: { in: ACTIVE }, endAt: { gt: now } },
      select: { startAt: true, endAt: true },
    });
    return rows.map((r) => ({ startMs: r.startAt.getTime(), endMs: r.endAt.getTime() }));
  }

  private isExclusionConflict(err: unknown): boolean {
    const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
    if (e?.code === '23P01' || e?.meta?.code === '23P01') return true;
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('no_overlap_installation_booking') || msg.toLowerCase().includes('exclusion');
  }

  private appBase(): string {
    return this.config.get('APP_BASE_URL', { infer: true });
  }

  // ─── Liens (SUPER_ADMIN) ─────────────────────────────────────────────────────

  async createLink(userId: string | null, dto: CreateBookingLinkDto): Promise<InstallationBookingLinkDto> {
    const fleet = await this.prisma.fleet.findUnique({ where: { id: dto.fleetId }, select: { id: true, name: true } });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    if (dto.planId) {
      const plan = await this.prisma.installationPlan.findUnique({ where: { id: dto.planId }, select: { fleetId: true } });
      if (!plan || plan.fleetId !== dto.fleetId) {
        throw new BadRequestException('Le planning choisi n\'appartient pas à cette flotte.');
      }
    }

    const token = randomBytes(32).toString('base64url');
    const row = await this.prisma.installationBookingLink.create({
      data: {
        fleetId: dto.fleetId,
        planId: dto.planId ?? null,
        label: dto.label.trim(),
        token,
        clientName: dto.clientName?.trim() || null,
        clientEmail: dto.clientEmail?.trim() || null,
        clientPhone: dto.clientPhone?.trim() || null,
        clientAddress: dto.clientAddress?.trim() || null,
        slotMinutes: dto.slotMinutes ?? undefined,
        dayStartMinutes: dto.dayStartMinutes ?? undefined,
        dayEndMinutes: dto.dayEndMinutes ?? undefined,
        workingDays: dto.workingDays ?? undefined,
        horizonDays: dto.horizonDays ?? undefined,
        leadHours: dto.leadHours ?? undefined,
        singleUse: dto.singleUse ?? undefined,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdBy: userId,
      },
      include: { fleet: { select: { name: true } } },
    });
    return this.toLinkDto(row, 0, 0);
  }

  async listLinks(): Promise<InstallationBookingLinkDto[]> {
    const rows = await this.prisma.installationBookingLink.findMany({
      include: { fleet: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return [];
    const counts = await this.prisma.installationBooking.groupBy({
      by: ['linkId', 'status'],
      _count: { _all: true },
      where: { linkId: { in: rows.map((r) => r.id) } },
    });
    const pending = new Map<string, number>();
    const confirmed = new Map<string, number>();
    for (const c of counts) {
      if (c.status === 'PENDING') pending.set(c.linkId, c._count._all);
      if (c.status === 'CONFIRMED') confirmed.set(c.linkId, c._count._all);
    }
    return rows.map((r) => this.toLinkDto(r, pending.get(r.id) ?? 0, confirmed.get(r.id) ?? 0));
  }

  async updateLink(id: string, dto: UpdateBookingLinkDto): Promise<InstallationBookingLinkDto> {
    await this.getLinkOr404(id);
    const row = await this.prisma.installationBookingLink.update({
      where: { id },
      data: {
        label: dto.label?.trim(),
        active: dto.active,
        slotMinutes: dto.slotMinutes,
        dayStartMinutes: dto.dayStartMinutes,
        dayEndMinutes: dto.dayEndMinutes,
        workingDays: dto.workingDays,
        horizonDays: dto.horizonDays,
        leadHours: dto.leadHours,
        singleUse: dto.singleUse,
        expiresAt: dto.expiresAt === undefined ? undefined : dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
      include: { fleet: { select: { name: true } } },
    });
    return this.toLinkDto(row, 0, 0);
  }

  async deleteLink(id: string): Promise<void> {
    await this.getLinkOr404(id);
    await this.prisma.installationBookingLink.delete({ where: { id } });
  }

  private async getLinkOr404(id: string): Promise<LinkRow> {
    const row = await this.prisma.installationBookingLink.findUnique({
      where: { id },
      include: { fleet: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Lien introuvable.');
    return row;
  }

  // ─── Public (page /book/:token, hors auth) ───────────────────────────────────

  /** Motif de fermeture d'un lien, ou null s'il est réservable. */
  private closedReason(link: LinkRow): string | null {
    if (!link.active) return 'Ce lien de réservation a été désactivé.';
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return 'Ce lien de réservation a expiré.';
    return null;
  }

  /** Trace une ouverture de la page publique (fire-and-forget, ne jette jamais). */
  private trackOpen(linkId: string, isFirst: boolean, fleetId: string, label: string): void {
    const now = new Date();
    this.prisma.installationBookingLink
      .update({
        where: { id: linkId },
        data: {
          openCount: { increment: 1 },
          lastOpenedAt: now,
          ...(isFirst ? { firstOpenedAt: now } : {}),
        },
      })
      .catch((e) => this.logger.warn(`trackOpen échoué: ${e instanceof Error ? e.message : e}`));
    // Seule la 1re ouverture alimente le feed « Système » (anti-flood ; les suivantes = compteur).
    if (isFirst) {
      this.systemActivity.record({
        category: 'INSTALLATION',
        action: 'booking_link_opened',
        status: 'SUCCESS',
        actor: 'client',
        target: label,
        detail: `Lien de prise de RDV ouvert pour la 1re fois`,
        fleetId,
        meta: { linkId },
      });
    }
  }

  async getPublicLink(rawToken: string): Promise<PublicBookingLinkDto> {
    const link = await this.prisma.installationBookingLink.findUnique({
      where: { token: rawToken },
      include: { fleet: { select: { name: true } } },
    });
    if (!link) throw new NotFoundException('Lien de réservation introuvable.');

    // Observabilité : on trace l'OUVERTURE du lien (compteur + 1re/dernière). Best-effort,
    // ne bloque jamais la réponse. La 1re ouverture est journalisée dans le feed « Système ».
    this.trackOpen(link.id, link.firstOpenedAt === null, link.fleetId, link.label);

    const closedReason = this.closedReason(link);
    const base: PublicBookingLinkDto = {
      companyName: link.fleet.name,
      closed: closedReason !== null,
      closedReason,
      needsClientInfo: !link.clientEmail,
      prefill: link.clientEmail
        ? { name: link.clientName, email: link.clientEmail, phone: link.clientPhone, address: link.clientAddress }
        : null,
      slotMinutes: link.slotMinutes,
      days: [],
    };
    if (closedReason) return base;

    const now = new Date();
    const busy = await this.busyIntervals(now);
    const days = generateAvailability(this.configOf(link), now, busy);
    base.days = days.map((d) => ({
      date: d.date,
      label: d.label,
      slots: d.slots.map((s) => ({ startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), label: s.label })),
    }));
    return base;
  }

  async createPublicBooking(rawToken: string, dto: CreatePublicBookingDto): Promise<PublicBookingResultDto> {
    const link = await this.prisma.installationBookingLink.findUnique({
      where: { token: rawToken },
      include: { fleet: { select: { name: true } } },
    });
    if (!link) throw new NotFoundException('Lien de réservation introuvable.');
    const closed = this.closedReason(link);
    if (closed) throw new BadRequestException(closed);

    const start = new Date(dto.startAt);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Créneau invalide.');
    const end = new Date(start.getTime() + link.slotMinutes * 60_000);

    // Le créneau doit correspondre EXACTEMENT à une disponibilité offerte à cet instant
    // (grille horaire + jour ouvré + horizon + délai mini + non déjà pris). La contrainte
    // EXCLUDE tranche ensuite la course concurrente.
    const now = new Date();
    const busy = await this.busyIntervals(now);
    const days = generateAvailability(this.configOf(link), now, busy);
    const offered = days.some((d) => d.slots.some((s) => s.startAt.getTime() === start.getTime()));
    if (!offered) throw new ConflictException('Ce créneau n\'est plus disponible. Choisissez-en un autre.');

    // Infos client : mode « lien direct » (clientEmail sur le lien) => on prend celles du lien.
    let clientName: string;
    let clientEmail: string;
    let clientPhone: string | null;
    let clientAddress: string | null;
    if (link.clientEmail) {
      clientName = link.clientName ?? link.fleet.name;
      clientEmail = link.clientEmail;
      clientPhone = link.clientPhone;
      clientAddress = link.clientAddress;
    } else {
      const name = dto.clientName?.trim();
      const email = dto.clientEmail?.trim();
      if (!name || !email) throw new BadRequestException('Nom et e-mail requis.');
      clientName = name;
      clientEmail = email;
      clientPhone = dto.clientPhone?.trim() || null;
      clientAddress = dto.clientAddress?.trim() || null;
    }

    let booking;
    try {
      booking = await this.prisma.installationBooking.create({
        data: {
          linkId: link.id,
          fleetId: link.fleetId,
          startAt: start,
          endAt: end,
          status: 'PENDING',
          clientName,
          clientEmail,
          clientPhone,
          clientAddress,
          vehiclePlate: dto.vehiclePlate?.trim() || null,
          vehicleBrand: dto.vehicleBrand?.trim() || null,
          vehicleModel: dto.vehicleModel?.trim() || null,
          vehicleEnergy: dto.vehicleEnergy ?? null,
          notes: dto.notes?.trim() || null,
        },
      });
    } catch (err) {
      if (this.isExclusionConflict(err)) {
        throw new ConflictException('Ce créneau vient d\'être réservé. Choisissez-en un autre.');
      }
      throw err;
    }

    const label = slotLabel(start, end);
    // Notification opérateur (best-effort : ne bloque pas la réservation).
    const vehicle = [dto.vehiclePlate, dto.vehicleBrand, dto.vehicleModel].filter(Boolean).join(' · ') || null;
    void this.email
      .send({
        to: CONTACT_EMAIL,
        ...this.email.buildInstallationSlotRequestedEmail({
          companyName: link.fleet.name,
          slotLabel: label,
          clientName,
          clientEmail,
          clientPhone,
          clientAddress,
          vehicle,
          notes: dto.notes?.trim() || null,
          manageUrl: `${this.appBase()}/admin/installation-bookings`,
        }),
        template: 'installation_slot_requested',
        fleetId: link.fleetId,
        context: { bookingId: booking.id, linkId: link.id },
      })
      .catch((e) => this.logger.warn(`Notif demande créneau échouée: ${e instanceof Error ? e.message : e}`));

    this.systemActivity.record({
      category: 'INSTALLATION',
      action: 'booking_requested',
      status: 'SUCCESS',
      actor: 'client',
      target: `${clientName} — ${label}`,
      detail: 'Demande de créneau déposée via le lien public',
      fleetId: link.fleetId,
      meta: { bookingId: booking.id, linkId: link.id },
    });

    return { ok: true, startAt: start.toISOString(), endAt: end.toISOString(), slotLabel: label };
  }

  // ─── Demandes (SUPER_ADMIN) ──────────────────────────────────────────────────

  async listBookings(filters: { status?: InstallationBookingStatus; from?: Date; to?: Date }): Promise<InstallationBookingDto[]> {
    const where: Prisma.InstallationBookingWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (filters.from || filters.to) {
      where.startAt = { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lt: filters.to } : {}) };
    }
    const rows = await this.prisma.installationBooking.findMany({
      where,
      include: { link: { select: { label: true, planId: true } } },
      orderBy: { startAt: 'asc' },
      take: 1000,
    });
    return rows.map((r) => this.toBookingDto(r));
  }

  async confirmBooking(userId: string | null, id: string, dto: ConfirmBookingDto): Promise<InstallationBookingDto> {
    const booking = await this.prisma.installationBooking.findUnique({
      where: { id },
      include: { link: { select: { label: true, planId: true, id: true, clientName: true, clientAddress: true } } },
    });
    if (!booking) throw new NotFoundException('Demande introuvable.');
    if (booking.status !== 'PENDING') {
      throw new BadRequestException('Seule une demande en attente peut être validée.');
    }

    const plate = (dto.vehiclePlate?.trim() || booking.vehiclePlate || '').trim();
    if (!plate) throw new BadRequestException('Renseignez la plaque du véhicule pour créer la pose.');
    const brand = dto.vehicleBrand?.trim() ?? booking.vehicleBrand;
    const model = dto.vehicleModel?.trim() ?? booking.vehicleModel;
    const energy = dto.vehicleEnergy ?? booking.vehicleEnergy;
    // Date de pose = jour du créneau (Europe/Paris), sauf override.
    const p = parisParts(booking.startAt);
    const scheduledDate = dto.scheduledDate
      ? new Date(`${dto.scheduledDate}T00:00:00.000Z`)
      : new Date(`${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T00:00:00.000Z`);

    const updated = await this.prisma.$transaction(async (tx) => {
      // 1) Planning cible : celui du lien, sinon on en crée un (même lien = même planning).
      let planId = booking.link.planId;
      if (!planId) {
        const plan = await tx.installationPlan.create({
          data: {
            fleetId: booking.fleetId,
            clientName: booking.clientName || booking.link.clientName || 'Client',
            clientAddress: booking.clientAddress ?? booking.link.clientAddress ?? null,
            description: 'Prises de RDV en ligne',
            status: InstallationPlanStatus.PUBLISHED,
          },
        });
        planId = plan.id;
        await tx.installationBookingLink.update({ where: { id: booking.link.id }, data: { planId } });
      }

      // 2) Pose dans ce planning (orderIndex = à la suite).
      const agg = await tx.installationTask.aggregate({ where: { planId }, _max: { orderIndex: true } });
      const task = await tx.installationTask.create({
        data: {
          planId,
          orderIndex: (agg._max.orderIndex ?? -1) + 1,
          scheduledDate,
          plate,
          brand: brand ?? null,
          model: model ?? null,
          energy: energy ?? null,
          status: 'PENDING',
        },
      });

      // 3) Marque la demande validée + garde la trace de la pose.
      const b = await tx.installationBooking.update({
        where: { id },
        data: {
          status: 'CONFIRMED',
          taskId: task.id,
          vehiclePlate: plate,
          vehicleBrand: brand ?? null,
          vehicleModel: model ?? null,
          vehicleEnergy: energy ?? null,
          confirmedAt: new Date(),
          confirmedBy: userId,
        },
        include: { link: { select: { label: true, planId: true } } },
      });

      // 4) Lien à usage unique : on le referme.
      if (booking.link) {
        const full = await tx.installationBookingLink.findUnique({ where: { id: booking.link.id }, select: { singleUse: true } });
        if (full?.singleUse) await tx.installationBookingLink.update({ where: { id: booking.link.id }, data: { active: false } });
      }
      return b;
    });

    // Confirmation client (best-effort).
    const fleet = await this.prisma.fleet.findUnique({ where: { id: booking.fleetId }, select: { name: true } });
    void this.email
      .send({
        to: booking.clientEmail,
        ...this.email.buildInstallationSlotConfirmedEmail({
          companyName: fleet?.name ?? 'Vizyo Tracky',
          slotLabel: slotLabel(booking.startAt, booking.endAt),
          clientName: booking.clientName,
          address: booking.clientAddress ?? booking.link.clientAddress ?? null,
        }),
        template: 'installation_slot_confirmed',
        fleetId: booking.fleetId,
        context: { bookingId: booking.id },
      })
      .catch((e) => this.logger.warn(`Confirmation client échouée: ${e instanceof Error ? e.message : e}`));

    this.systemActivity.record({
      category: 'INSTALLATION',
      action: 'booking_confirmed',
      status: 'SUCCESS',
      actor: 'opérateur',
      target: `${booking.clientName} — ${slotLabel(booking.startAt, booking.endAt)}`,
      detail: 'Créneau validé → pose créée dans le planning',
      fleetId: booking.fleetId,
      triggeredByUserId: userId,
      meta: { bookingId: booking.id },
    });

    return this.toBookingDto(updated);
  }

  async rejectBooking(id: string, dto: RejectBookingDto): Promise<InstallationBookingDto> {
    const booking = await this.prisma.installationBooking.findUnique({
      where: { id },
      include: { link: { select: { label: true, planId: true } } },
    });
    if (!booking) throw new NotFoundException('Demande introuvable.');
    if (booking.status === 'CONFIRMED') {
      throw new BadRequestException('Une demande déjà validée ne peut pas être refusée (annulez la pose).');
    }
    if (booking.status === 'REJECTED') return this.toBookingDto(booking);

    const updated = await this.prisma.installationBooking.update({
      where: { id },
      data: { status: 'REJECTED', rejectionReason: dto.reason?.trim() || null },
      include: { link: { select: { label: true, planId: true } } },
    });

    this.systemActivity.record({
      category: 'INSTALLATION',
      action: 'booking_rejected',
      status: 'SUCCESS',
      actor: 'opérateur',
      target: `${booking.clientName} — ${slotLabel(booking.startAt, booking.endAt)}`,
      detail: dto.reason?.trim() || 'Demande de créneau refusée',
      fleetId: booking.fleetId,
      meta: { bookingId: booking.id, notifiedClient: !!dto.notifyClient },
    });

    if (dto.notifyClient) {
      const fleet = await this.prisma.fleet.findUnique({ where: { id: booking.fleetId }, select: { name: true } });
      void this.email
        .send({
          to: booking.clientEmail,
          subject: 'Votre demande de créneau d\'installation',
          html: this.email.shell({
            eyebrow: 'Installation · Créneau',
            footer: 'VIZYO TRACKY · GPS FLOTTE · OCCITANIE',
            body: `<tr><td style="padding:28px 36px 0;"><h1 style="margin:0 0 12px;font-family:'Manrope',sans-serif;font-size:23px;font-weight:800;color:#EAEFED;">Créneau à reprogrammer</h1><p style="margin:0;font-family:'Manrope',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">Bonjour, le créneau demandé (${slotLabel(booking.startAt, booking.endAt)}) n'a pas pu être retenu${dto.reason ? ` : ${dto.reason}` : ''}. Répondez à cet e-mail pour convenir d'un autre créneau.</p></td></tr>`,
          }),
          template: 'installation_slot_confirmed',
          fleetId: booking.fleetId,
          context: { bookingId: booking.id, rejected: true, fleetName: fleet?.name },
        })
        .catch((e) => this.logger.warn(`Refus client échoué: ${e instanceof Error ? e.message : e}`));
    }
    return this.toBookingDto(updated);
  }

  // ─── Mapping ─────────────────────────────────────────────────────────────────

  private toLinkDto(row: LinkRow, pendingCount: number, confirmedCount: number): InstallationBookingLinkDto {
    return {
      id: row.id,
      fleetId: row.fleetId,
      fleetName: row.fleet.name,
      planId: row.planId,
      label: row.label,
      publicUrl: this.publicUrl(row.token),
      clientName: row.clientName,
      clientEmail: row.clientEmail,
      clientPhone: row.clientPhone,
      clientAddress: row.clientAddress,
      slotMinutes: row.slotMinutes,
      dayStartMinutes: row.dayStartMinutes,
      dayEndMinutes: row.dayEndMinutes,
      workingDays: row.workingDays,
      horizonDays: row.horizonDays,
      leadHours: row.leadHours,
      active: row.active,
      singleUse: row.singleUse,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      pendingCount,
      confirmedCount,
      openCount: row.openCount,
      firstOpenedAt: row.firstOpenedAt ? row.firstOpenedAt.toISOString() : null,
      lastOpenedAt: row.lastOpenedAt ? row.lastOpenedAt.toISOString() : null,
    };
  }

  private toBookingDto(row: BookingRow): InstallationBookingDto {
    return {
      id: row.id,
      linkId: row.linkId,
      linkLabel: row.link?.label ?? '',
      fleetId: row.fleetId,
      planId: row.link?.planId ?? null,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      status: row.status as InstallationBookingDto['status'],
      clientName: row.clientName,
      clientEmail: row.clientEmail,
      clientPhone: row.clientPhone,
      clientAddress: row.clientAddress,
      vehiclePlate: row.vehiclePlate,
      vehicleBrand: row.vehicleBrand,
      vehicleModel: row.vehicleModel,
      vehicleEnergy: row.vehicleEnergy as InstallationBookingDto['vehicleEnergy'],
      notes: row.notes,
      taskId: row.taskId,
      rejectionReason: row.rejectionReason,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
