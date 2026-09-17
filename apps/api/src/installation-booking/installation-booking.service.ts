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
  BookingVisitEventDto,
  BookingVisitEventType,
  CreatePublicBookingDto,
  DecouverteDto,
  DeleteLinkConsequencesDto,
  DeleteLinkMode,
  InstallationBookingDto,
  InstallationBookingLinkDto,
  InstallationBookingLinkVisitDto,
  InstallationBookingLinkVisitsDto,
  PublicBookingLinkDto,
  PublicBookingResultDto,
} from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { tronquerAdresse } from '../depot/share-token';
import { emailClientPropre, telephoneClientE164, telephoneLisible } from './contact';
import {
  type SlotConfig,
  WEEKEND_DAYS,
  generateAvailability,
  parisParts,
  slotLabel,
  windowFor,
} from './installation-booking.slots';
import { ManagerClientService } from './manager-client.service';
import { decrireAgent, hoteDuReferrer, provenanceLisible } from './visiteur';
import type {
  BookingVehicleInputDto,
  CancelBookingDto,
  CreateBookingLinkDto,
  UpdateBookingLinkDto,
  ConfirmBookingDto,
  RejectBookingDto,
} from './dto/installation-booking.dto';

/** Statuts qui OCCUPENT un créneau (source de la disponibilité + contrainte EXCLUDE). */
const ACTIVE: InstallationBookingStatus[] = ['PENDING', 'CONFIRMED'];

/**
 * Combien de temps on garde l'adresse d'un client qui demande à être prévenu.
 *
 * ⚠️ CE NOMBRE EST UNE DÉCISION, PAS UN RÉGLAGE TECHNIQUE — **arbitrée par le
 * client le 2026-08-16**. Passé ce délai, la ligne est supprimée qu'elle ait servi
 * ou non : une adresse collectée pour une finalité qui s'est épuisée n'a plus de
 * raison d'être conservée.
 *
 * 90 jours = l'horizon de réservation par défaut (42 j) avec de la marge : au-delà,
 * la personne a trouvé une solution ailleurs, et la prévenir n'aurait plus de sens.
 *
 * Ne pas l'allonger « pour être tranquille » : c'est la durée qui rend la collecte
 * proportionnée, et la rallonger sans nouvelle décision la rendrait excessive.
 */
const SLOT_WATCH_RETENTION_DAYS = 90;

/**
 * Combien de temps on garde une VISITE de la page publique (IP tronquée, famille
 * d'appareil, hôte du referrer, chronologie des gestes).
 *
 * Elle répond à « le client a-t-il ouvert le lien, et qu'a-t-il fait ? » — une question
 * qui se pose pendant que l'installation se prépare, pas six mois après. 180 jours =
 * l'horizon maximal d'un lien (180 j) : au-delà, plus aucun créneau du lien n'est encore
 * réservable, et la trace ne raconte plus rien d'utile. Proposé au client avec ce chantier ;
 * à graver comme décision, pas à allonger en passant.
 */
export const VISIT_RETENTION_DAYS = 180;

/**
 * Plafond de gestes par visite. Une page qui en enverrait davantage n'est pas un client
 * qui hésite, c'est un script — et la colonne n'a pas à grossir pour lui.
 */
const VISIT_MAX_EVENTS = 80;

/** Le marqueur `?from=` que la vitrine lit (vt.js) pour attribuer la visite au lien de RDV. */
const VITRINE_FROM = 'rdv-installation';

/** Plaque écrite sur une pose dont le client n'a pas donné la plaque ; `completeTask` exige la vraie. */
export const PLAQUE_A_CONFIRMER = 'À confirmer';

/** Plafond absolu du multi-véhicules (6 × 2 h = une journée). Le lien porte son propre plafond. */
const MAX_VEHICULES_ABSOLU = 6;

const LINK_INCLUDE = {
  fleet: { select: { name: true } },
  creator: { select: { firstName: true, lastName: true, email: true } },
} satisfies Prisma.InstallationBookingLinkInclude;
type LinkRow = Prisma.InstallationBookingLinkGetPayload<{ include: typeof LINK_INCLUDE }>;

const BOOKING_INCLUDE = {
  link: { select: { label: true, planId: true } },
  fleet: { select: { name: true } },
  vehicles: { orderBy: { position: 'asc' } },
  tasks: { select: { id: true, planId: true, plate: true, status: true } },
  confirmer: { select: { firstName: true, lastName: true, email: true } },
} satisfies Prisma.InstallationBookingInclude;
type BookingRow = Prisma.InstallationBookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;
type VisitRow = Prisma.InstallationBookingLinkVisitGetPayload<Record<string, never>>;

/** Ce que l'HTTP sait du visiteur au moment où la page s'ouvre. */
export interface ContexteVisite {
  ip?: string;
  userAgent?: string;
  referrer?: string;
  /**
   * Visite déjà ouverte par la page (rechargement après un créneau perdu) : on la
   * RÉUTILISE. Sans ça, chaque « ce créneau vient d'être pris » créerait une visite de
   * plus, et l'écran admin lirait trois clients là où il n'y en a qu'un.
   */
  visiteId?: string | null;
}

/** Un nom lisible pour un compte, ou null s'il n'existe plus. */
function nomDe(u: { firstName: string | null; lastName: string | null; email: string } | null | undefined): string | null {
  if (!u) return null;
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
}

@Injectable()
export class InstallationBookingService {
  private readonly logger = new Logger(InstallationBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
    private readonly systemActivity: SystemActivityService,
    private readonly manager: ManagerClientService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private publicUrl(token: string): string {
    return `${this.appBase()}/book/${token}`;
  }

  private configOf(link: {
    slotMinutes: number; dayStartMinutes: number; dayEndMinutes: number;
    workingDays: number[]; horizonDays: number; leadDays: number;
    weekendStartMinutes: number | null; weekendEndMinutes: number | null;
  }): SlotConfig {
    return {
      slotMinutes: link.slotMinutes,
      dayStartMinutes: link.dayStartMinutes,
      dayEndMinutes: link.dayEndMinutes,
      workingDays: link.workingDays,
      horizonDays: link.horizonDays,
      leadDays: link.leadDays,
      weekendStartMinutes: link.weekendStartMinutes,
      weekendEndMinutes: link.weekendEndMinutes,
    };
  }

  /** La société telle que le client la connaît : celle du lien prospect, sinon la flotte. */
  private societeDe(link: { companyName: string | null; fleet: { name: string } | null }): string {
    return link.companyName?.trim() || link.fleet?.name || 'Vizyo Tracky';
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

  private vitrineBase(): string {
    return String(this.config.get('VITRINE_BASE_URL', { infer: true }) ?? 'https://tracky.vizyoagency.com').replace(/\/+$/, '');
  }

  /** Adresse qui reçoit les notifications opérateur — configurable, plus codée en dur. */
  private adresseOperateur(): string {
    const brut = this.config.get('INSTALLATION_NOTIFY_EMAIL', { infer: true }) as string | undefined;
    return (brut ?? '').trim() || 'contact@vizyoagency.com';
  }

  /**
   * Les fenêtres horaires doivent contenir AU MOINS un créneau, sinon le lien est créé et
   * la page affiche « aucun créneau » sans que personne ne comprenne pourquoi. Refuser ici,
   * c'est le dire à l'opérateur au moment où il peut corriger.
   */
  private validerFenetres(cfg: {
    slotMinutes: number; dayStartMinutes: number; dayEndMinutes: number; workingDays: number[];
    weekendStartMinutes: number | null; weekendEndMinutes: number | null;
  }): void {
    const weekendOuvert = cfg.workingDays.some((d) => WEEKEND_DAYS.has(d));
    const semaineOuverte = cfg.workingDays.some((d) => !WEEKEND_DAYS.has(d));
    if (cfg.workingDays.length === 0) throw new BadRequestException('Cochez au moins un jour.');
    if ((cfg.weekendStartMinutes == null) !== (cfg.weekendEndMinutes == null)) {
      throw new BadRequestException('Les horaires du week-end vont par deux : un début ET une fin.');
    }
    if (semaineOuverte && cfg.dayEndMinutes - cfg.dayStartMinutes < cfg.slotMinutes) {
      throw new BadRequestException('La plage horaire de la semaine est plus courte qu\'un créneau.');
    }
    if (weekendOuvert) {
      const w = windowFor(cfg, 6);
      if (w.end - w.start < cfg.slotMinutes) {
        throw new BadRequestException('La plage horaire du week-end est plus courte qu\'un créneau.');
      }
    }
  }

  /**
   * Un lien a une flotte OU un nom de société — jamais ni l'un ni l'autre (la page publique
   * n'aurait rien à afficher, et une demande ne saurait pas à qui elle appartient).
   */
  private async validerSociete(fleetId: string | null | undefined, companyName: string | null | undefined, planId?: string | null): Promise<void> {
    if (fleetId) {
      const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true } });
      if (!fleet) throw new NotFoundException('Flotte introuvable.');
      if (planId) {
        const plan = await this.prisma.installationPlan.findUnique({ where: { id: planId }, select: { fleetId: true } });
        if (!plan || plan.fleetId !== fleetId) {
          throw new BadRequestException('Le planning choisi n\'appartient pas à cette flotte.');
        }
      }
      return;
    }
    if (!companyName?.trim()) {
      throw new BadRequestException('Sans flotte, indiquez le nom de la société du prospect.');
    }
    if (planId) throw new BadRequestException('Un planning ne peut être rattaché qu\'avec une flotte.');
  }

  // ─── Liens (SUPER_ADMIN) ─────────────────────────────────────────────────────

  async createLink(userId: string | null, dto: CreateBookingLinkDto): Promise<InstallationBookingLinkDto> {
    await this.validerSociete(dto.fleetId, dto.companyName, dto.planId);
    this.validerFenetres({
      slotMinutes: dto.slotMinutes ?? 120,
      dayStartMinutes: dto.dayStartMinutes ?? 480,
      dayEndMinutes: dto.dayEndMinutes ?? 1260,
      workingDays: dto.workingDays ?? [1, 2, 3, 4, 5],
      weekendStartMinutes: dto.weekendStartMinutes ?? null,
      weekendEndMinutes: dto.weekendEndMinutes ?? null,
    });

    const token = randomBytes(32).toString('base64url');
    const row = await this.prisma.installationBookingLink.create({
      data: {
        fleetId: dto.fleetId ?? null,
        companyName: dto.fleetId ? (dto.companyName?.trim() || null) : dto.companyName!.trim(),
        maxVehicles: dto.maxVehicles ?? undefined,
        planId: dto.planId ?? null,
        label: dto.label.trim(),
        token,
        clientName: dto.clientName?.trim() || null,
        clientEmail: dto.clientEmail?.trim().toLowerCase() || null,
        clientPhone: dto.clientPhone?.trim() || null,
        clientAddress: dto.clientAddress?.trim() || null,
        slotMinutes: dto.slotMinutes ?? undefined,
        dayStartMinutes: dto.dayStartMinutes ?? undefined,
        dayEndMinutes: dto.dayEndMinutes ?? undefined,
        workingDays: dto.workingDays ?? undefined,
        weekendStartMinutes: dto.weekendStartMinutes ?? null,
        weekendEndMinutes: dto.weekendEndMinutes ?? null,
        horizonDays: dto.horizonDays ?? undefined,
        leadDays: dto.leadDays ?? undefined,
        singleUse: dto.singleUse ?? undefined,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdBy: userId,
      },
      include: LINK_INCLUDE,
    });
    return this.toLinkDto(row, { pending: 0, confirmed: 0, visits: 0, robots: 0 });
  }

  async listLinks(): Promise<InstallationBookingLinkDto[]> {
    const rows = await this.prisma.installationBookingLink.findMany({
      include: LINK_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [counts, visites] = await Promise.all([
      this.prisma.installationBooking.groupBy({
        by: ['linkId', 'status'],
        _count: { _all: true },
        where: { linkId: { in: ids } },
      }),
      this.prisma.installationBookingLinkVisit.groupBy({
        by: ['linkId', 'robot'],
        _count: { _all: true },
        where: { linkId: { in: ids } },
      }),
    ]);
    const pending = new Map<string, number>();
    const confirmed = new Map<string, number>();
    for (const c of counts) {
      if (!c.linkId) continue;
      if (c.status === 'PENDING') pending.set(c.linkId, c._count._all);
      if (c.status === 'CONFIRMED') confirmed.set(c.linkId, c._count._all);
    }
    const humains = new Map<string, number>();
    const robots = new Map<string, number>();
    for (const v of visites) (v.robot ? robots : humains).set(v.linkId, v._count._all);
    return rows.map((r) => this.toLinkDto(r, {
      pending: pending.get(r.id) ?? 0,
      confirmed: confirmed.get(r.id) ?? 0,
      visits: humains.get(r.id) ?? 0,
      robots: robots.get(r.id) ?? 0,
    }));
  }

  async updateLink(id: string, dto: UpdateBookingLinkDto): Promise<InstallationBookingLinkDto> {
    const actuel = await this.getLinkOr404(id);
    // La société résultante : on peut rattacher une flotte à un lien prospect, jamais retirer la
    // flotte d'un lien qui en a une (ses demandes la portent déjà).
    const fleetId = dto.fleetId === undefined ? actuel.fleetId : dto.fleetId;
    if (actuel.fleetId && fleetId !== actuel.fleetId) {
      throw new BadRequestException('La flotte d\'un lien ne se change pas : créez un autre lien.');
    }
    const companyName = dto.companyName === undefined ? actuel.companyName : dto.companyName;
    await this.validerSociete(fleetId, companyName, null);
    // On valide la configuration RÉSULTANTE (l'existant fusionné avec ce qui change), pas
    // seulement les champs envoyés : un week-end coché seul, sans ses horaires, se lit ici.
    this.validerFenetres({
      slotMinutes: dto.slotMinutes ?? actuel.slotMinutes,
      dayStartMinutes: dto.dayStartMinutes ?? actuel.dayStartMinutes,
      dayEndMinutes: dto.dayEndMinutes ?? actuel.dayEndMinutes,
      workingDays: dto.workingDays ?? actuel.workingDays,
      weekendStartMinutes: dto.weekendStartMinutes === undefined ? actuel.weekendStartMinutes : dto.weekendStartMinutes,
      weekendEndMinutes: dto.weekendEndMinutes === undefined ? actuel.weekendEndMinutes : dto.weekendEndMinutes,
    });
    const row = await this.prisma.installationBookingLink.update({
      where: { id },
      data: {
        label: dto.label?.trim(),
        active: dto.active,
        fleetId: dto.fleetId === undefined ? undefined : dto.fleetId,
        companyName: dto.companyName === undefined ? undefined : (dto.companyName?.trim() || null),
        maxVehicles: dto.maxVehicles,
        slotMinutes: dto.slotMinutes,
        dayStartMinutes: dto.dayStartMinutes,
        dayEndMinutes: dto.dayEndMinutes,
        workingDays: dto.workingDays,
        weekendStartMinutes: dto.weekendStartMinutes,
        weekendEndMinutes: dto.weekendEndMinutes,
        horizonDays: dto.horizonDays,
        leadDays: dto.leadDays,
        singleUse: dto.singleUse,
        expiresAt: dto.expiresAt === undefined ? undefined : dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
      include: LINK_INCLUDE,
    });
    // Rattacher la flotte à un lien prospect rattache aussi ses demandes encore sans flotte.
    if (!actuel.fleetId && row.fleetId) {
      await this.prisma.installationBooking.updateMany({
        where: { linkId: id, fleetId: null },
        data: { fleetId: row.fleetId },
      });
    }
    return this.toLinkDto(row, { pending: 0, confirmed: 0, visits: 0, robots: 0 });
  }

  /** Ce qu'une suppression emporterait — pour le dialogue de l'écran, et le 409 de l'API. */
  async consequencesSuppression(id: string): Promise<DeleteLinkConsequencesDto> {
    await this.getLinkOr404(id);
    const [parStatut, visites, abonnes] = await Promise.all([
      this.prisma.installationBooking.groupBy({ by: ['status'], _count: { _all: true }, where: { linkId: id } }),
      this.prisma.installationBookingLinkVisit.count({ where: { linkId: id } }),
      this.prisma.installationSlotWatcher.count({ where: { linkId: id } }),
    ]);
    const compte = (s: InstallationBookingStatus) => parStatut.find((p) => p.status === s)?._count._all ?? 0;
    const total = parStatut.reduce((n, p) => n + p._count._all, 0);
    return {
      demandes: { total, enAttente: compte('PENDING'), confirmees: compte('CONFIRMED') },
      visites,
      abonnes,
    };
  }

  /**
   * Supprimer un lien (Q8, décision du 16/09). S'il porte des demandes, l'appelant DOIT dire quoi
   * en faire : `conserver` (elles survivent, `linkLabel` les garde lisibles — SetNull en base) ou
   * `effacer` (demandes et véhicules partent avec le lien ; les poses déjà créées survivent). Sans
   * réponse : 409 avec le décompte — c'est ce que le dialogue affiche.
   */
  async deleteLink(id: string, mode?: DeleteLinkMode, userId?: string | null): Promise<void> {
    const link = await this.getLinkOr404(id);
    const consequences = await this.consequencesSuppression(id);
    if (consequences.demandes.total > 0 && !mode) {
      // `code` explicite : le filtre global ne transmet les champs métier (`consequences`) qu'avec lui.
      throw new ConflictException({
        code: 'DEMANDES_A_TRANCHER',
        message: `Ce lien porte ${consequences.demandes.total} demande(s). Indiquez quoi en faire : conserver ou effacer.`,
        consequences,
      });
    }
    if (mode === 'effacer' && consequences.demandes.total > 0) {
      await this.prisma.installationBooking.deleteMany({ where: { linkId: id } });
    } else if (consequences.demandes.total > 0) {
      await this.prisma.installationBooking.updateMany({
        where: { linkId: id, linkLabel: null },
        data: { linkLabel: link.label },
      });
    }
    await this.prisma.installationBookingLink.delete({ where: { id } });
    this.systemActivity.record({
      category: 'INSTALLATION',
      action: 'booking_link_deleted',
      status: 'SUCCESS',
      actor: 'opérateur',
      target: link.label,
      detail: consequences.demandes.total === 0
        ? 'Lien supprimé (aucune demande)'
        : mode === 'effacer'
          ? `Lien supprimé avec ses ${consequences.demandes.total} demande(s)`
          : `Lien supprimé, ${consequences.demandes.total} demande(s) conservée(s)`,
      fleetId: link.fleetId,
      triggeredByUserId: userId ?? null,
      meta: { linkId: id, mode: mode ?? null, ...consequences },
    });
  }

  private async getLinkOr404(id: string): Promise<LinkRow> {
    const row = await this.prisma.installationBookingLink.findUnique({
      where: { id },
      include: LINK_INCLUDE,
    });
    if (!row) throw new NotFoundException('Lien introuvable.');
    return row;
  }

  // ─── Visites (qui a ouvert le lien, quand, et qu'a-t-il fait) ───────────────

  /**
   * Ouvre (ou réutilise) la visite d'une page publique. BEST-EFFORT : `null` si le suivi
   * échoue — le client venu réserver n'y peut rien, et la page fonctionne sans.
   */
  private async ouvrirVisite(link: LinkRow, ctx: ContexteVisite): Promise<{ id: string } | null> {
    try {
      const now = new Date();
      if (ctx.visiteId) {
        const n = await this.ajouterEvenement(ctx.visiteId, link.id, { type: 'ouverture', target: 'rechargement' }, now);
        if (n > 0) return { id: ctx.visiteId };
        // Visite inconnue (purgée, ou d'un autre lien) : on en ouvre une neuve, sans bruit.
      }
      const agent = decrireAgent(ctx.userAgent);
      const nominatif = !!link.clientEmail;
      const premier: BookingVisitEventDto = { t: now.toISOString(), type: 'ouverture', target: 'nouvelle' };
      const row = await this.prisma.installationBookingLinkVisit.create({
        data: {
          linkId: link.id,
          fleetId: link.fleetId,
          openedAt: now,
          lastSeenAt: now,
          ipTruncated: tronquerAdresse(ctx.ip),
          device: agent.device,
          os: agent.os,
          browser: agent.browser,
          referrerHost: hoteDuReferrer(ctx.referrer),
          robot: agent.robot,
          // Un lien nominatif dit QUI on a invité — pas qui a cliqué. D'où « présumé ».
          contactName: nominatif ? link.clientName : null,
          contactEmail: nominatif ? link.clientEmail : null,
          identitySource: nominatif ? 'LIEN_DIRECT' : null,
          events: [premier] as unknown as Prisma.InputJsonValue,
          eventCount: 1,
        },
        select: { id: true },
      });
      // Les compteurs du lien ne comptent que les HUMAINS : un aperçu WhatsApp qui ouvre le
      // lien avant le client n'est pas « le client a ouvert le lien ».
      if (!agent.robot) this.trackOpen(link.id, link.firstOpenedAt === null, link.fleetId, link.label);
      return { id: row.id };
    } catch (e) {
      this.logger.warn(`ouverture de visite échouée: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * Ajoute un geste à la chronologie d'une visite — par CONCATÉNATION JSONB côté base
   * (`events || …`), sans relecture : deux clics rapides ne s'écrasent pas. Le `linkId`
   * dans le WHERE fait qu'une visite ne peut recevoir que les gestes de SON lien, et le
   * plafond arrête un script. Rend le nombre de lignes touchées (0 = inconnue / pleine).
   */
  private async ajouterEvenement(
    visiteId: string,
    linkId: string,
    ev: { type: BookingVisitEventType; target?: string | null },
    now: Date = new Date(),
  ): Promise<number> {
    const entree: BookingVisitEventDto = {
      t: now.toISOString(),
      type: ev.type,
      target: ev.target ? String(ev.target).slice(0, 120) : null,
    };
    const json = JSON.stringify([entree]);
    return this.prisma.$executeRaw`
      UPDATE "installation_booking_link_visits"
      SET "events" = "events" || ${json}::jsonb,
          "eventCount" = "eventCount" + 1,
          "lastSeenAt" = ${now}
      WHERE "id" = ${visiteId}::uuid AND "linkId" = ${linkId}::uuid AND "eventCount" < ${VISIT_MAX_EVENTS}`;
  }

  /** Un geste envoyé par la page (jour regardé, vidéo ouverte…). Ne jette que sur un token inconnu. */
  async enregistrerEvenement(
    rawToken: string,
    visiteId: string,
    ev: { type: BookingVisitEventType; target?: string },
  ): Promise<{ ok: true }> {
    const link = await this.prisma.installationBookingLink.findUnique({ where: { token: rawToken }, select: { id: true } });
    if (!link) throw new NotFoundException('Lien de réservation introuvable.');
    try {
      await this.ajouterEvenement(visiteId, link.id, ev);
    } catch (e) {
      this.logger.warn(`événement de visite non enregistré: ${e instanceof Error ? e.message : e}`);
    }
    return { ok: true };
  }

  /**
   * Pose l'identité CERTAINE d'une visite (réservation ou abonnement), sans jamais rétrograder
   * une réservation en abonnement : « a réservé » dit plus que « a laissé un e-mail ».
   */
  private async identifierVisite(
    visiteId: string,
    linkId: string,
    identite: { name: string | null; email: string; source: 'RESERVATION' | 'ABONNEMENT'; bookingId?: string },
  ): Promise<void> {
    try {
      await this.prisma.installationBookingLinkVisit.updateMany({
        where: {
          id: visiteId,
          linkId,
          // `not: 'RESERVATION'` en SQL exclurait aussi les NULL (NULL <> x n'est pas vrai) :
          // on énumère ce qu'un abonnement a le droit d'écraser.
          ...(identite.source === 'ABONNEMENT'
            ? { OR: [{ identitySource: null }, { identitySource: { in: ['LIEN_DIRECT', 'ABONNEMENT'] } }] }
            : {}),
          ...(identite.bookingId ? { bookingId: null } : {}),
        },
        data: {
          contactName: identite.name,
          contactEmail: identite.email,
          identitySource: identite.source,
          ...(identite.bookingId ? { bookingId: identite.bookingId } : {}),
        },
      });
    } catch (e) {
      this.logger.warn(`identification de visite échouée: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Les visites d'un lien, pour l'admin : les plus récentes d'abord. */
  async listerVisites(linkId: string): Promise<InstallationBookingLinkVisitsDto> {
    await this.getLinkOr404(linkId);
    const [visites, humaines, robots, avecReservation] = await Promise.all([
      this.prisma.installationBookingLinkVisit.findMany({
        where: { linkId },
        orderBy: { openedAt: 'desc' },
        take: 300,
      }),
      this.prisma.installationBookingLinkVisit.count({ where: { linkId, robot: false } }),
      this.prisma.installationBookingLinkVisit.count({ where: { linkId, robot: true } }),
      this.prisma.installationBookingLinkVisit.count({ where: { linkId, robot: false, bookingId: { not: null } } }),
    ]);
    let hoteApp: string | null = null;
    try { hoteApp = new URL(this.appBase()).hostname; } catch { hoteApp = null; }
    return {
      linkId,
      humaines,
      robots,
      avecReservation,
      visites: visites.map((v) => this.toVisitDto(v, hoteApp)),
    };
  }

  /**
   * Purge des visites anciennes. Appelée par le service d'entretien quotidien — c'est la
   * LIMITE que la collecte s'est donnée, pas de l'hygiène.
   */
  async purgerVisitesAnciennes(maintenant: Date = new Date()): Promise<number> {
    const plancher = new Date(maintenant.getTime() - VISIT_RETENTION_DAYS * 86_400_000);
    const { count } = await this.prisma.installationBookingLinkVisit.deleteMany({
      where: { openedAt: { lt: plancher } },
    });
    if (count > 0) this.logger.log(`Visites de pages de RDV purgées : ${count}`);
    return count;
  }

  // ─── Public (page /book/:token, hors auth) ───────────────────────────────────

  /** Motif de fermeture d'un lien, ou null s'il est réservable. */
  private closedReason(link: Pick<LinkRow, 'active' | 'expiresAt'>): string | null {
    if (!link.active) return 'Ce lien de réservation a été désactivé.';
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return 'Ce lien de réservation a expiré.';
    return null;
  }

  /** Trace une ouverture HUMAINE de la page publique (fire-and-forget, ne jette jamais). */
  private trackOpen(linkId: string, isFirst: boolean, fleetId: string | null, label: string): void {
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

  /**
   * Les liens « découvrir Tracky » de la page publique. Le client qui attend sa pose peut
   * voir à quoi ressemble ce qu'on va lui installer : les trois scènes de `decouvrir.html`
   * (supervision, analyse, administration) et l'espace dépôt. Chaque URL porte `?from=`
   * pour que la vitrine (vt.js) attribue la visite au lien de RDV.
   */
  private decouverte(): DecouverteDto {
    const base = this.vitrineBase();
    const presentation = `${base}/decouvrir.html?from=${VITRINE_FROM}`;
    const depot = `${base}/decouvrir-depot.html?from=${VITRINE_FROM}`;
    return {
      presentationUrl: presentation,
      depotUrl: depot,
      videos: [
        {
          id: 'supervision', titre: 'Supervision', url: `${presentation}#supervision`,
          description: 'Toute votre flotte en temps réel : carte live, alertes, coupe-circuit antivol, géofences.',
        },
        {
          id: 'analyse', titre: 'Analyse', url: `${presentation}#analyse`,
          description: 'Rapports automatisés, récit IA des trajets, tournées optimisées et carburant mesuré.',
        },
        {
          id: 'administration', titre: 'Administration', url: `${presentation}#administration`,
          description: 'Utilisateurs, rôles, permissions au véhicule près, identification conducteur, cartes SIM.',
        },
        {
          id: 'depot', titre: 'Espace dépôt', url: `${depot}#suivre`,
          description: 'Ce que voient vos propres clients : le camion qui arrive, pendant la mission, sans compte à créer.',
        },
      ],
    };
  }

  /** Le nombre de véhicules demandé, borné par le lien — jamais moins d'un, jamais plus que permis. */
  private borneVehicules(link: { maxVehicles: number }, demande: number | undefined): number {
    const max = Math.min(Math.max(1, link.maxVehicles), MAX_VEHICULES_ABSOLU);
    const n = Math.floor(demande ?? 1);
    return Math.min(Math.max(1, Number.isFinite(n) ? n : 1), max);
  }

  async getPublicLink(rawToken: string, ctx: ContexteVisite = {}, vehicleCount?: number): Promise<PublicBookingLinkDto> {
    const link = await this.prisma.installationBookingLink.findUnique({
      where: { token: rawToken },
      include: LINK_INCLUDE,
    });
    if (!link) throw new NotFoundException('Lien de réservation introuvable.');

    // Observabilité : une VISITE par ouverture réelle (appareil, provenance, chronologie),
    // et les compteurs du lien pour les humains. Best-effort, ne bloque jamais la réponse.
    const visite = await this.ouvrirVisite(link, ctx);

    const closedReason = this.closedReason(link);
    const nombre = this.borneVehicules(link, vehicleCount);
    const base: PublicBookingLinkDto = {
      companyName: this.societeDe(link),
      closed: closedReason !== null,
      closedReason,
      // Depuis le lot A, le contact est TOUJOURS demandé (le lien nominatif pré-remplit).
      needsClientInfo: true,
      prefill: link.clientEmail
        ? { name: link.clientName, email: link.clientEmail, phone: telephoneLisible(link.clientPhone) ?? link.clientPhone, address: link.clientAddress }
        : null,
      slotMinutes: link.slotMinutes,
      days: [],
      telephonePublic: this.telephoneAtelier(),
      // On n'ouvre cette sortie que si le lien est encore vivant : proposer d'être
      // prévenu sur un lien expiré promettrait un e-mail qui ne partira jamais.
      abonnementCreneauDisponible: closedReason === null,
      weekendOuvert: link.workingDays.some((d) => WEEKEND_DAYS.has(d)),
      vehicleCount: nombre,
      maxVehicles: Math.min(Math.max(1, link.maxVehicles), MAX_VEHICULES_ABSOLU),
      contactRequis: { email: true, telephone: true },
      visite,
      decouverte: this.decouverte(),
    };
    if (closedReason) return base;

    const now = new Date();
    const busy = await this.busyIntervals(now);
    const days = generateAvailability(this.configOf(link), now, busy, nombre);
    base.days = days.map((d) => ({
      date: d.date,
      label: d.label,
      weekend: d.weekend,
      slots: d.slots.map((s) => ({ startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), label: s.label })),
    }));
    return base;
  }

  /**
   * Le téléphone de l'ATELIER, jamais celui d'une personne.
   *
   * Il vient de la configuration serveur et pas d'une fiche utilisateur : cette
   * page est publique, son URL circule par e-mail et par SMS, et un numéro
   * personnel exposé là ne se reprend plus. Non configuré → `null`, et le bouton
   * « Appeler » ne s'affiche pas du tout : mieux vaut deux sorties que trois dont
   * une qui ne sonne nulle part.
   */
  private telephoneAtelier(): string | null {
    const brut = this.config.get('INSTALLATION_PUBLIC_PHONE', { infer: true }) as string | undefined;
    const valeur = (brut ?? '').trim();
    return valeur.length > 0 ? valeur : null;
  }

  /**
   * « Prévenez-moi si un créneau se libère » — la sortie n° 3.
   *
   * Idempotent par (lien, e-mail) : dix clics impatients n'inscrivent qu'une fois,
   * et n'enverront donc qu'un seul e-mail. Chaque inscription REPOUSSE la date de
   * purge — quelqu'un qui redemande manifeste que sa demande tient toujours.
   */
  async watchSlots(rawToken: string, email: string, visiteId?: string | null): Promise<{ ok: true }> {
    const link = await this.prisma.installationBookingLink.findUnique({
      where: { token: rawToken },
      select: { id: true, fleetId: true, label: true, active: true, expiresAt: true, singleUse: true },
    });
    if (!link) throw new NotFoundException('Lien de réservation introuvable.');

    const closed = this.closedReason(link);
    if (closed) {
      throw new BadRequestException(
        "Ce lien n'est plus actif : personne ne pourra vous prévenir. Contactez l'atelier.",
      );
    }

    const propre = email.trim().toLowerCase();
    const expiresAt = new Date(Date.now() + SLOT_WATCH_RETENTION_DAYS * 24 * 3600 * 1000);
    await this.prisma.installationSlotWatcher.upsert({
      where: { linkId_email: { linkId: link.id, email: propre } },
      update: { expiresAt, notifiedAt: null },
      create: { linkId: link.id, email: propre, expiresAt },
    });

    if (visiteId) {
      await this.identifierVisite(visiteId, link.id, { name: null, email: propre, source: 'ABONNEMENT' });
      await this.ajouterEvenement(visiteId, link.id, { type: 'abonnement' }).catch(() => 0);
    }

    this.systemActivity.record({
      category: 'INSTALLATION',
      action: 'slot_watch_requested',
      status: 'SUCCESS',
      actor: 'client',
      target: link.label,
      detail: "Demande d'être prévenu qu'un créneau se libère",
      fleetId: link.fleetId,
      meta: { linkId: link.id },
    });

    return { ok: true };
  }

  /**
   * Purge des abonnements expirés. Appelée par le service d'entretien quotidien.
   *
   * Ce n'est pas de l'hygiène de base : c'est la LIMITE que la collecte s'est
   * donnée. Sans cette purge, la table deviendrait une réserve d'adresses gardées
   * sans finalité — exactement ce que la conception voulait éviter.
   */
  async purgerAbonnementsExpires(): Promise<number> {
    const { count } = await this.prisma.installationSlotWatcher.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    if (count > 0) this.logger.log(`Abonnements « prévenez-moi » purgés : ${count}`);
    return count;
  }

  /**
   * Tient la promesse de « Prévenez-moi » : pour chaque lien encore ouvert qui a des
   * abonnés non prévenus, si des créneaux sont proposables MAINTENANT, on envoie l'e-mail
   * et on marque `notifiedAt`. Une fois par inscription — se réinscrire remet à zéro.
   *
   * Un passage QUOTIDIEN suffit : un créneau « se libère » par un refus, une annulation, un
   * changement d'horaires, ou simplement un jour de plus qui entre dans l'horizon — autant
   * d'événements qu'il serait fragile d'intercepter un par un.
   */
  async notifierAbonnesCreneauxLibres(maintenant: Date = new Date()): Promise<number> {
    const abonnes = await this.prisma.installationSlotWatcher.findMany({
      where: { notifiedAt: null, expiresAt: { gt: maintenant } },
      include: { link: { include: LINK_INCLUDE } },
    });
    if (abonnes.length === 0) return 0;

    const busy = await this.busyIntervals(maintenant);
    const parLien = new Map<string, typeof abonnes>();
    for (const a of abonnes) {
      const liste = parLien.get(a.linkId) ?? [];
      liste.push(a);
      parLien.set(a.linkId, liste);
    }

    let envoyes = 0;
    for (const [, liste] of parLien) {
      const link = liste[0].link;
      if (this.closedReason(link)) continue;
      const days = generateAvailability(this.configOf(link), maintenant, busy);
      if (days.length === 0) continue;
      const premier = days[0].slots[0];
      const courriel = this.email.buildInstallationSlotAvailableEmail({
        companyName: this.societeDe(link),
        nextSlotLabel: slotLabel(premier.startAt, premier.endAt),
        dayCount: days.length,
        bookingUrl: this.publicUrl(link.token),
      });
      for (const a of liste) {
        const res = await this.email
          .send({
            to: a.email,
            ...courriel,
            template: 'installation_slot_available',
            fleetId: link.fleetId ?? undefined,
            context: { linkId: link.id, watcherId: a.id },
          })
          .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        if (!res.ok) {
          this.logger.warn(`« Prévenez-moi » non envoyé à ${a.email}: ${res.error ?? 'échec'}`);
          continue;
        }
        await this.prisma.installationSlotWatcher.update({ where: { id: a.id }, data: { notifiedAt: maintenant } });
        envoyes += 1;
      }
      this.systemActivity.record({
        category: 'INSTALLATION',
        action: 'slot_watch_notified',
        status: 'SUCCESS',
        actor: 'système',
        target: link.label,
        detail: `${liste.length} abonné(s) prévenu(s) : des créneaux sont de nouveau proposables`,
        fleetId: link.fleetId,
        meta: { linkId: link.id, jours: days.length },
      });
    }
    return envoyes;
  }

  /**
   * Le contact d'une demande — OBLIGATOIRE (décision du 16/09). Chaque refus dit quoi corriger :
   * ce formulaire s'ouvre au téléphone, une main prise, et un message vague coûte une demande.
   */
  private validerContact(dto: CreatePublicBookingDto): { name: string; email: string; phone: string } {
    const name = (dto.clientName ?? '').trim();
    if (name.length < 2) throw new BadRequestException('Indiquez votre nom.');
    if (name.includes('@')) throw new BadRequestException('Le nom ne peut pas être une adresse e-mail.');
    const email = emailClientPropre(dto.clientEmail);
    if (!email) throw new BadRequestException('Renseignez un e-mail valide : c\'est là que la confirmation arrive.');
    const phone = telephoneClientE164(dto.clientPhone);
    if (!phone) {
      throw new BadRequestException('Renseignez un numéro de téléphone valide (ex. 06 12 34 56 78) : nous vous appelons la veille si besoin.');
    }
    return { name, email, phone };
  }

  /** Les véhicules déclarés, nettoyés : autant que `vehicleCount`, dans l'ordre. */
  private validerVehicules(link: { maxVehicles: number }, dto: CreatePublicBookingDto): {
    count: number; vehicles: { plate: string | null; brand: string | null; model: string | null; energy: BookingVehicleInputDto['energy'] | null }[];
  } {
    const max = Math.min(Math.max(1, link.maxVehicles), MAX_VEHICULES_ABSOLU);
    const count = Math.floor(dto.vehicleCount);
    if (!Number.isFinite(count) || count < 1) throw new BadRequestException('Indiquez le nombre de véhicules à équiper.');
    if (count > max) throw new BadRequestException(`Au plus ${max} véhicule(s) par demande sur ce lien.`);
    const lignes = Array.isArray(dto.vehicles) ? dto.vehicles : [];
    if (lignes.length !== count) throw new BadRequestException(`${count} véhicule(s) annoncé(s), ${lignes.length} décrit(s).`);
    return {
      count,
      vehicles: lignes.map((v) => ({
        plate: v.plate?.trim().toUpperCase() || null,
        brand: v.brand?.trim() || null,
        model: v.model?.trim() || null,
        energy: v.energy ?? null,
      })),
    };
  }

  async createPublicBooking(rawToken: string, dto: CreatePublicBookingDto): Promise<PublicBookingResultDto> {
    const link = await this.prisma.installationBookingLink.findUnique({
      where: { token: rawToken },
      include: LINK_INCLUDE,
    });
    if (!link) throw new NotFoundException('Lien de réservation introuvable.');
    const closed = this.closedReason(link);
    if (closed) throw new BadRequestException(closed);

    const start = new Date(dto.startAt);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Créneau invalide.');
    const contact = this.validerContact(dto);
    const { count, vehicles } = this.validerVehicules(link, dto);
    const end = new Date(start.getTime() + link.slotMinutes * count * 60_000);

    // Le créneau doit correspondre EXACTEMENT à une disponibilité offerte à cet instant POUR CE
    // NOMBRE DE VÉHICULES (grille horaire + jour ouvré + horizon + J+N + non déjà pris). La
    // contrainte EXCLUDE tranche ensuite la course concurrente.
    const now = new Date();
    const busy = await this.busyIntervals(now);
    const days = generateAvailability(this.configOf(link), now, busy, count);
    const offered = days.some((d) => d.slots.some((s) => s.startAt.getTime() === start.getTime()));
    if (!offered) {
      await this.tracerEchec(dto.visiteId, link.id, 'créneau plus disponible');
      throw new ConflictException('Ce créneau n\'est plus disponible. Choisissez-en un autre.');
    }

    const clientAddress = dto.clientAddress?.trim() || link.clientAddress || null;
    const companyName = this.societeDe(link);
    let booking: { id: string };
    try {
      booking = await this.prisma.installationBooking.create({
        data: {
          linkId: link.id,
          linkLabel: link.label,
          fleetId: link.fleetId,
          companyName,
          startAt: start,
          endAt: end,
          status: 'PENDING',
          clientName: contact.name,
          clientEmail: contact.email,
          clientPhone: contact.phone,
          clientAddress,
          vehicleCount: count,
          notes: dto.notes?.trim() || null,
          vehicles: {
            create: vehicles.map((v, i) => ({ position: i, plate: v.plate, brand: v.brand, model: v.model, energy: v.energy })),
          },
        },
        select: { id: true },
      });
    } catch (err) {
      if (this.isExclusionConflict(err)) {
        await this.tracerEchec(dto.visiteId, link.id, 'créneau pris entre-temps');
        throw new ConflictException('Ce créneau vient d\'être réservé. Choisissez-en un autre.');
      }
      throw err;
    }

    const label = slotLabel(start, end);

    // La visite raconte maintenant QUI a réservé — une identité certaine, celle-là.
    if (dto.visiteId) {
      await this.identifierVisite(dto.visiteId, link.id, {
        name: contact.name, email: contact.email, source: 'RESERVATION', bookingId: booking.id,
      });
      await this.ajouterEvenement(dto.visiteId, link.id, { type: 'reservation', target: label }).catch(() => 0);
    }

    // Notification opérateur (best-effort : ne bloque pas la réservation).
    const vehiculesLisibles = vehicles
      .map((v, i) => [v.plate ?? `véhicule ${i + 1}`, [v.brand, v.model].filter(Boolean).join(' ') || null].filter(Boolean).join(' · '))
      .join(' ; ');
    void this.email
      .send({
        to: this.adresseOperateur(),
        ...this.email.buildInstallationSlotRequestedEmail({
          companyName: link.fleetId ? companyName : `${companyName} (prospect, sans flotte)`,
          slotLabel: `${label} · ${count} véhicule${count > 1 ? 's' : ''}`,
          clientName: contact.name,
          clientEmail: contact.email,
          clientPhone: telephoneLisible(contact.phone),
          clientAddress,
          vehicle: vehiculesLisibles || null,
          notes: dto.notes?.trim() || null,
          manageUrl: `${this.appBase()}/admin/installation-bookings`,
        }),
        template: 'installation_slot_requested',
        // ⚠️ RÉPONDRE ÉCRIT AU CLIENT, pas à notre propre boîte. Le pied de page le dit ;
        // sans cet en-tête il faudrait recopier l'adresse à la main depuis le corps.
        replyTo: contact.email,
        fleetId: link.fleetId ?? undefined,
        context: { bookingId: booking.id, linkId: link.id },
      })
      .catch((e) => this.logger.warn(`Notif demande créneau échouée: ${e instanceof Error ? e.message : e}`));

    this.systemActivity.record({
      category: 'INSTALLATION',
      action: 'booking_requested',
      status: 'SUCCESS',
      actor: 'client',
      target: `${contact.name} — ${label}`,
      detail: `Demande de créneau déposée via le lien public (${count} véhicule${count > 1 ? 's' : ''}, ${companyName})`,
      fleetId: link.fleetId,
      meta: { bookingId: booking.id, linkId: link.id, vehicleCount: count, prospect: !link.fleetId },
    });

    return { ok: true, startAt: start.toISOString(), endAt: end.toISOString(), slotLabel: label };
  }

  /** Un échec de réservation, dans la chronologie de la visite — best-effort. */
  private async tracerEchec(visiteId: string | undefined, linkId: string, motif: string): Promise<void> {
    if (!visiteId) return;
    await this.ajouterEvenement(visiteId, linkId, { type: 'reservation_echec', target: motif }).catch(() => 0);
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
      include: BOOKING_INCLUDE,
      orderBy: { startAt: 'asc' },
      take: 1000,
    });
    return rows.map((r) => this.toBookingDto(r));
  }

  private async getBookingOr404(id: string): Promise<BookingRow> {
    const row = await this.prisma.installationBooking.findUnique({ where: { id }, include: BOOKING_INCLUDE });
    if (!row) throw new NotFoundException('Demande introuvable.');
    return row;
  }

  /**
   * La flotte d'une demande à valider : celle qu'elle porte, celle qu'on rattache, ou celle que
   * Vizyo Manager vient de créer. JAMAIS créée par Tracky lui-même (conception v2, § 2.3).
   */
  private async resoudreFlotte(booking: BookingRow, dto: ConfirmBookingDto): Promise<{ id: string; name: string }> {
    let fleetId = booking.fleetId ?? dto.fleetId ?? null;
    if (!fleetId && dto.creerClient) {
      const cree = await this.manager.creerClient({
        companyName: booking.companyName ?? booking.clientName,
        email: booking.clientEmail,
        contactFirstName: booking.clientName.split(/\s+/)[0] ?? null,
        contactLastName: booking.clientName.split(/\s+/).slice(1).join(' ') || null,
        phone: booking.clientPhone,
        externalRef: booking.id,
      });
      fleetId = cree.trackyFleetId;
      this.systemActivity.record({
        category: 'INSTALLATION',
        action: 'client_created_via_manager',
        status: 'SUCCESS',
        actor: 'opérateur',
        target: booking.companyName ?? booking.clientName,
        detail: `Client créé dans Vizyo Manager (${cree.clientId}) et flotte provisionnée`,
        fleetId,
        meta: { bookingId: booking.id, clientId: cree.clientId },
      });
    }
    if (!fleetId) {
      // `code` explicite : sans lui, le filtre global (`AllExceptionsFilter`) ne rend que le message.
      throw new ConflictException({
        code: 'SANS_FLOTTE',
        message: 'Cette demande n\'a pas encore de société : rattachez une flotte existante, ou créez le client dans Vizyo Manager.',
        sansFlotte: true,
        creationManagerConfiguree: this.manager.estConfigure(),
        urlManager: this.manager.urlNouveauClient({
          companyName: booking.companyName ?? booking.clientName, email: booking.clientEmail, phone: booking.clientPhone,
        }),
      });
    }
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true, name: true } });
    if (!fleet) throw new NotFoundException('Flotte introuvable — si elle vient d\'être créée dans Manager, vérifiez que la provision Tracky a réussi.');
    return fleet;
  }

  async confirmBooking(userId: string | null, id: string, dto: ConfirmBookingDto): Promise<InstallationBookingDto> {
    const booking = await this.getBookingOr404(id);
    if (booking.status !== 'PENDING') {
      throw new BadRequestException('Seule une demande en attente peut être validée.');
    }
    const fleet = await this.resoudreFlotte(booking, dto);

    // Les véhicules, avec les corrections de l'opérateur (par position).
    const corrections = new Map((dto.vehicles ?? []).map((v) => [v.position, v]));
    const vehicules = booking.vehicles.map((v) => {
      const fix = corrections.get(v.position);
      return {
        id: v.id,
        plate: (fix?.plate ?? v.plate)?.trim().toUpperCase() || null,
        brand: (fix?.brand ?? v.brand)?.trim() || null,
        model: (fix?.model ?? v.model)?.trim() || null,
        energy: fix?.energy === undefined ? v.energy : fix.energy,
      };
    });
    if (vehicules.length === 0) throw new BadRequestException('Cette demande ne décrit aucun véhicule.');

    // Date de pose = jour du créneau (Europe/Paris), sauf override.
    const p = parisParts(booking.startAt);
    const scheduledDate = dto.scheduledDate
      ? new Date(`${dto.scheduledDate}T00:00:00.000Z`)
      : new Date(`${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T00:00:00.000Z`);
    const societe = booking.companyName ?? fleet.name;

    const updated = await this.prisma.$transaction(async (tx) => {
      // 1) Planning cible : celui du lien, sinon on en crée un au nom de la SOCIÉTÉ (même lien = même planning).
      let planId = booking.link?.planId ?? null;
      if (!planId) {
        const plan = await tx.installationPlan.create({
          data: {
            fleetId: fleet.id,
            clientName: societe,
            clientAddress: booking.clientAddress ?? null,
            description: 'Prises de RDV en ligne — créé automatiquement à la validation',
            status: InstallationPlanStatus.PUBLISHED,
          },
        });
        planId = plan.id;
        if (booking.linkId) {
          await tx.installationBookingLink.update({ where: { id: booking.linkId }, data: { planId } });
        }
      }

      // 2) Une pose par véhicule, à la suite du planning, rattachée à la demande.
      const agg = await tx.installationTask.aggregate({ where: { planId }, _max: { orderIndex: true } });
      let orderIndex = (agg._max.orderIndex ?? -1) + 1;
      for (const v of vehicules) {
        const task = await tx.installationTask.create({
          data: {
            planId,
            orderIndex: orderIndex++,
            scheduledDate,
            plate: v.plate ?? PLAQUE_A_CONFIRMER,
            brand: v.brand,
            model: v.model,
            energy: v.energy,
            status: 'PENDING',
            bookingId: booking.id,
            fieldNotes: booking.notes ? `Note du client : ${booking.notes}` : null,
          },
        });
        await tx.installationBookingVehicle.update({
          where: { id: v.id },
          data: { plate: v.plate, brand: v.brand, model: v.model, energy: v.energy, taskId: task.id },
        });
      }

      // 3) La demande est validée ; elle porte désormais sa flotte, et le lien prospect aussi.
      const b = await tx.installationBooking.update({
        where: { id },
        data: { status: 'CONFIRMED', fleetId: fleet.id, confirmedAt: new Date(), confirmedBy: userId },
        include: BOOKING_INCLUDE,
      });
      if (booking.linkId) {
        const lien = await tx.installationBookingLink.findUnique({ where: { id: booking.linkId }, select: { fleetId: true, singleUse: true } });
        if (lien && !lien.fleetId) {
          await tx.installationBookingLink.update({ where: { id: booking.linkId }, data: { fleetId: fleet.id } });
          await tx.installationBooking.updateMany({ where: { linkId: booking.linkId, fleetId: null }, data: { fleetId: fleet.id } });
        }
        // 4) Lien à usage unique : on le referme.
        if (lien?.singleUse) await tx.installationBookingLink.update({ where: { id: booking.linkId }, data: { active: false } });
      }
      return b;
    });

    // Confirmation client (best-effort).
    void this.email
      .send({
        to: booking.clientEmail,
        ...this.email.buildInstallationSlotConfirmedEmail({
          companyName: societe,
          slotLabel: slotLabel(booking.startAt, booking.endAt),
          clientName: booking.clientName,
          address: booking.clientAddress ?? null,
        }),
        template: 'installation_slot_confirmed',
        fleetId: fleet.id,
        context: { bookingId: booking.id },
      })
      .catch((e) => this.logger.warn(`Confirmation client échouée: ${e instanceof Error ? e.message : e}`));

    this.systemActivity.record({
      category: 'INSTALLATION',
      action: 'booking_confirmed',
      status: 'SUCCESS',
      actor: 'opérateur',
      target: `${booking.clientName} — ${slotLabel(booking.startAt, booking.endAt)}`,
      detail: `Créneau validé → ${vehicules.length} pose(s) créée(s) dans le planning de ${societe}`,
      fleetId: fleet.id,
      triggeredByUserId: userId,
      meta: { bookingId: booking.id, vehicleCount: vehicules.length },
    });

    return this.toBookingDto(updated);
  }

  async rejectBooking(id: string, dto: RejectBookingDto): Promise<InstallationBookingDto> {
    const booking = await this.getBookingOr404(id);
    if (booking.status === 'CONFIRMED') {
      throw new BadRequestException('Une demande déjà validée ne se refuse pas : annulez-la.');
    }
    if (booking.status === 'REJECTED' || booking.status === 'CANCELLED') return this.toBookingDto(booking);

    const updated = await this.prisma.installationBooking.update({
      where: { id },
      data: { status: 'REJECTED', rejectionReason: dto.reason?.trim() || null },
      include: BOOKING_INCLUDE,
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
      const lienOuvert = booking.linkId
        ? await this.prisma.installationBookingLink.findUnique({ where: { id: booking.linkId }, select: { token: true, active: true, expiresAt: true } })
        : null;
      const bookingUrl = lienOuvert && !this.closedReason(lienOuvert) ? this.publicUrl(lienOuvert.token) : null;
      void this.email
        .send({
          to: booking.clientEmail,
          ...this.email.buildInstallationSlotRejectedEmail({
            companyName: booking.companyName ?? booking.fleet?.name ?? 'Vizyo Tracky',
            slotLabel: slotLabel(booking.startAt, booking.endAt),
            clientName: booking.clientName,
            reason: dto.reason?.trim() || null,
            bookingUrl,
            telephoneAtelier: this.telephoneAtelier(),
          }),
          template: 'installation_slot_rejected',
          fleetId: booking.fleetId ?? undefined,
          context: { bookingId: booking.id },
        })
        .catch((e) => this.logger.warn(`Refus client échoué: ${e instanceof Error ? e.message : e}`));
    }
    return this.toBookingDto(updated);
  }

  /**
   * Annuler une demande — en attente OU confirmée (R2 : jusqu'ici une demande confirmée bloquait
   * son créneau pour toujours). Les poses non faites sont retirées ; une pose déjà faite interdit
   * l'annulation (le boîtier est posé, ce n'est plus une demande).
   */
  async cancelBooking(userId: string | null, id: string, dto: CancelBookingDto): Promise<InstallationBookingDto> {
    const booking = await this.getBookingOr404(id);
    if (booking.status === 'CANCELLED') return this.toBookingDto(booking);
    if (booking.status === 'REJECTED') throw new BadRequestException('Une demande refusée n\'a rien à annuler.');
    if (booking.tasks.some((t) => t.status === 'DONE')) {
      throw new BadRequestException('Une pose de cette demande a déjà été faite : elle ne s\'annule plus.');
    }

    // `cancelledBy` est un LIBELLÉ (« Youness H. » ou « client »), pas un identifiant : c'est ce
    // que l'écran affiche, et il doit rester lisible quand le compte n'existe plus.
    const operateur = userId
      ? nomDe(await this.prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } }))
      : null;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (booking.tasks.length > 0) {
        await tx.installationTask.deleteMany({ where: { id: { in: booking.tasks.map((t) => t.id) } } });
      }
      return tx.installationBooking.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: operateur ?? 'opérateur',
          cancelReason: dto.reason?.trim() || null,
        },
        include: BOOKING_INCLUDE,
      });
    });

    this.systemActivity.record({
      category: 'INSTALLATION',
      action: 'booking_cancelled',
      status: 'SUCCESS',
      actor: 'opérateur',
      target: `${booking.clientName} — ${slotLabel(booking.startAt, booking.endAt)}`,
      detail: dto.reason?.trim() || `Demande annulée (${booking.tasks.length} pose(s) retirée(s))`,
      fleetId: booking.fleetId,
      triggeredByUserId: userId,
      meta: { bookingId: booking.id, posesRetirees: booking.tasks.length, notifiedClient: !!dto.notifyClient },
    });

    if (dto.notifyClient) {
      const lienOuvert = booking.linkId
        ? await this.prisma.installationBookingLink.findUnique({ where: { id: booking.linkId }, select: { token: true, active: true, expiresAt: true } })
        : null;
      const bookingUrl = lienOuvert && !this.closedReason(lienOuvert) ? this.publicUrl(lienOuvert.token) : null;
      void this.email
        .send({
          to: booking.clientEmail,
          ...this.email.buildInstallationSlotCancelledEmail({
            companyName: booking.companyName ?? booking.fleet?.name ?? 'Vizyo Tracky',
            slotLabel: slotLabel(booking.startAt, booking.endAt),
            clientName: booking.clientName,
            reason: dto.reason?.trim() || null,
            bookingUrl,
            telephoneAtelier: this.telephoneAtelier(),
          }),
          template: 'installation_slot_cancelled',
          fleetId: booking.fleetId ?? undefined,
          context: { bookingId: booking.id },
        })
        .catch((e) => this.logger.warn(`Annulation client échouée: ${e instanceof Error ? e.message : e}`));
    }
    return this.toBookingDto(updated);
  }

  // ─── Mapping ─────────────────────────────────────────────────────────────────

  private toLinkDto(
    row: LinkRow,
    counts: { pending: number; confirmed: number; visits: number; robots: number },
  ): InstallationBookingLinkDto {
    return {
      id: row.id,
      fleetId: row.fleetId,
      fleetName: row.fleet?.name ?? null,
      companyName: row.companyName,
      maxVehicles: row.maxVehicles,
      createdByName: nomDe(row.creator),
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
      weekendStartMinutes: row.weekendStartMinutes,
      weekendEndMinutes: row.weekendEndMinutes,
      horizonDays: row.horizonDays,
      leadDays: row.leadDays,
      active: row.active,
      singleUse: row.singleUse,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      pendingCount: counts.pending,
      confirmedCount: counts.confirmed,
      openCount: row.openCount,
      firstOpenedAt: row.firstOpenedAt ? row.firstOpenedAt.toISOString() : null,
      lastOpenedAt: row.lastOpenedAt ? row.lastOpenedAt.toISOString() : null,
      visitCount: counts.visits,
      robotVisitCount: counts.robots,
    };
  }

  private toVisitDto(v: VisitRow, hoteApp: string | null): InstallationBookingLinkVisitDto {
    const events = Array.isArray(v.events) ? (v.events as unknown as BookingVisitEventDto[]) : [];
    return {
      id: v.id,
      openedAt: v.openedAt.toISOString(),
      lastSeenAt: v.lastSeenAt.toISOString(),
      ipTruncated: v.ipTruncated,
      device: v.device as InstallationBookingLinkVisitDto['device'],
      os: v.os,
      browser: v.browser,
      referrerHost: v.referrerHost,
      provenance: provenanceLisible(v.referrerHost, hoteApp),
      robot: v.robot,
      contactName: v.contactName,
      contactEmail: v.contactEmail,
      identitySource: v.identitySource as InstallationBookingLinkVisitDto['identitySource'],
      events,
      bookingId: v.bookingId,
    };
  }

  private toBookingDto(row: BookingRow): InstallationBookingDto {
    return {
      id: row.id,
      linkId: row.linkId,
      linkLabel: row.link?.label ?? row.linkLabel ?? '',
      fleetId: row.fleetId,
      fleetName: row.fleet?.name ?? null,
      companyName: row.companyName,
      planId: row.link?.planId ?? row.tasks[0]?.planId ?? null,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      status: row.status as InstallationBookingDto['status'],
      clientName: row.clientName,
      clientEmail: row.clientEmail,
      clientPhone: telephoneLisible(row.clientPhone) ?? row.clientPhone,
      clientAddress: row.clientAddress,
      vehicleCount: row.vehicleCount,
      vehicles: row.vehicles.map((v) => ({
        id: v.id, position: v.position, plate: v.plate, brand: v.brand, model: v.model,
        energy: v.energy as InstallationBookingDto['vehicles'][number]['energy'], taskId: v.taskId,
      })),
      notes: row.notes,
      poses: row.tasks.map((t) => ({ taskId: t.id, planId: t.planId, plate: t.plate, status: t.status as 'PENDING' | 'DONE' | 'SKIPPED' })),
      rejectionReason: row.rejectionReason,
      cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
      cancelledByName: row.cancelledBy,
      cancelReason: row.cancelReason,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      confirmedByName: nomDe(row.confirmer),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
