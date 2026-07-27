import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { Prisma, UserRole } from '@prisma/client';
import type {
  AgendaAgentProposalDto,
  AgendaAgentProposalStatus,
  AgendaAgentRunDto,
  AgendaAgentRunResultDto,
  FleetMetier,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { AiRouter } from '../ai/ai-router.service';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { AGENDA_AGENT_SCHEMA, renderAgendaAgentSystem } from './agenda-agent.prompt';
import { fleetTzFormatter, localParts, localWallToUtc } from './fleet-tz.util';
import { RecurrenceDetectorService, type RecurringPattern } from './recurrence-detector.service';
import { ReservationsService } from './reservations.service';
import { VehicleEventsService } from './vehicle-events.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Horizon de projection des occurrences récurrentes (jours à venir). */
const HORIZON_DAYS = 14;
/** On ne réserve/propose jamais dans l'heure qui vient (créneau trop proche = inutile). */
const LEAD_MS = 60 * 60 * 1000;
const MAX_DAY_STEPS = 60;
/** Historique conservé par société (l'agent tourne chaque nuit → ~3 mois de recul). */
const KEEP_RUNS_PER_FLEET = 100;
/** Anti-storm : au plus une (re)analyse ÉVÉNEMENTIELLE par flotte toutes les 5 min. */
const EVENT_THROTTLE_MS = 5 * 60 * 1000;

type ProposalRow = {
  id: string;
  fleetId: string;
  vehicleId: string;
  startAt: Date;
  endAt: Date;
  dayOfWeek: number;
  destinationLabel: string | null;
  confidence: number;
  basis: string;
  reasoning: string;
  status: string;
  origin: string;
  createdEventId: string | null;
  createdAt: Date;
};

/**
 * Refonte agenda/IA (2026-07, P3) — Agent nocturne d'optimisation d'agenda.
 * Chaque nuit (à l'heure réglée par flotte) — ou à la demande — il détecte les trajets récurrents
 * (RecurrenceDetectorService, DÉTERMINISTE), projette les prochaines occurrences, et selon
 * l'autonomie réglée (P2) : ajoute des SUGGESTIONS (`pending`) OU crée des réservations FERMES
 * au-dessus du seuil de confiance (`auto_applied`). Anti-double-réservation entre les nuits via
 * l'unicité (flotte, véhicule, créneau) + les pré-checks/EXCLUDE des réservations. Scoping tenant
 * strict. Aucun appel LLM : fiable et gratuit.
 *
 * VIVACITÉ : l'agent n'a pas de garde propre — il ne connaît que les motifs qu'on lui donne. Les
 * véhicules au boîtier muet et les habitudes éteintes sont écartés en AMONT (RecurrenceDetector) ;
 * l'agent se contente de reverser ces exclusions dans son bilan pour qu'elles soient visibles.
 */
@Injectable()
export class AgendaAgentRunnerService {
  private readonly logger = new Logger(AgendaAgentRunnerService.name);
  /** Flottes en cours d'analyse (anti-chevauchement in-process). */
  private readonly running = new Set<string>();
  /** Dernière (re)analyse événementielle par flotte (throttle anti-storm). */
  private readonly lastEventRun = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly detector: RecurrenceDetectorService,
    private readonly reservations: ReservationsService,
    private readonly events: VehicleEventsService,
    private readonly systemActivity: SystemActivityService,
    // Couche IA OPTIONNELLE (jugement/explication). Injectée en prod (AiRouter @Global : Claude ou GPT
    // selon le switch « Coûts IA ») ; omise dans les specs → 100% déterministe.
    private readonly ai?: AiRouter,
    private readonly aiUsage?: AiUsageService,
    // Centre d'alerte (@Global) : remonte les échecs des runs de FOND (planifié / événementiel / IA)
    // qui, sinon, ne journalisent qu'en console. Omis dans les specs (construction manuelle).
    private readonly errorLogger?: ErrorLogger,
    // Interrupteur maître IA par flotte (@Global) : si la flotte a désactivé l'IA, l'agent tourne en
    // 100% déterministe (pas d'appel LLM). Optionnel comme `ai` ; PLACÉ EN FIN pour ne pas décaler les
    // constructions positionnelles des specs (injection NestJS = par type, l'ordre n'impacte pas la prod).
    private readonly aiAvail?: AiAvailabilityService,
  ) {}

  private resolveFleetId(user: AuthUser, fleetId?: string): string {
    const id = fleetId ?? user.fleetId ?? undefined;
    if (!id) throw new BadRequestException('Préciser la flotte (fleetId).');
    if (user.role !== UserRole.SUPER_ADMIN && id !== user.fleetId) {
      throw new ForbiddenException('Flotte hors périmètre.');
    }
    return id;
  }

  private assertScope(user: AuthUser, fleetId: string): void {
    // 404 (pas 403) pour ne pas révéler l'existence d'une proposition hors périmètre.
    if (user.role !== UserRole.SUPER_ADMIN && fleetId !== user.fleetId) {
      throw new NotFoundException('Proposition introuvable');
    }
  }

  // ─── Exécution ─────────────────────────────────────────────────────────────

  /** Lancement À LA DEMANDE (super/fleet admin). */
  async runOnDemand(user: AuthUser, fleetId?: string): Promise<AgendaAgentRunResultDto> {
    return this.runForFleet(this.resolveFleetId(user, fleetId), 'manual');
  }

  /** Analyse une flotte : détecte, projette, dédup, propose ou réserve (auto). */
  async runForFleet(fleetId: string, origin: string): Promise<AgendaAgentRunResultDto> {
    if (this.running.has(fleetId)) return { created: 0, proposed: 0, skipped: 0, alreadyRunning: true };
    this.running.add(fleetId);
    const startedAt = new Date();
    try {
      const settings = await this.prisma.agendaAgentSettings.findUnique({ where: { fleetId } });
      const enabled = settings?.enabled ?? false;
      // Planifié : rien si l'agent est désactivé. Manuel : on tourne quand même, mais on ne réserve
      // AUTO que si l'agent est activé ET en autonomie « auto si confiance haute ».
      if (origin === 'scheduled' && !enabled) return { created: 0, proposed: 0, skipped: 0 };
      const autoOn = enabled && (settings?.autonomy ?? 'suggest') === 'auto_high_confidence';
      const threshold = (settings?.confidenceThreshold ?? 80) / 100;

      // AUDIT DORMANCE : l'agent ne choisit pas ses véhicules, il applique les motifs du détecteur —
      // c'est donc LÀ que se jouait le fait de réserver un véhicule mort depuis 89 jours, et c'est
      // là que la garde a été posée. On récupère ici ce qu'il a écarté pour l'annoncer dans le bilan
      // du passage : sinon « 0 proposition » ressemblerait à un agent en panne.
      // (Les propositions DÉJÀ créées ne sont pas touchées : leur validation reste une décision
      //  humaine, et un véhicule dormant qui réémet redevient éligible au passage suivant.)
      const detection = await this.detector.detectWithStats(fleetId);
      const patterns = detection.patterns;
      // Couche IA (best-effort) : jugement « garder/écarter » + « pourquoi » vulgarisé par récurrence.
      const reviews = await this.reviewPatterns(fleetId, patterns);
      const now = Date.now();
      const horizonEnd = now + HORIZON_DAYS * DAY_MS;
      const fmt = fleetTzFormatter();

      let created = 0;
      let proposed = 0;
      // Les exclusions du détecteur entrent dans « ignoré(s) » — le seul compteur qui existe déjà
      // pour « vu, pas traité ». Le détail (dormants / éteints) est écrit en clair par `track()` :
      // aucune migration, et aucun chiffre qui baisse sans explication.
      let skipped = detection.skippedDormantVehicles + detection.skippedStalePatterns;

      for (let pi = 0; pi < patterns.length; pi++) {
        const p = patterns[pi];
        const review = reviews.get(pi);
        if (review && !review.keep) continue; // l'IA juge cette récurrence non pertinente
        const reasoning = review?.reasoning || this.reasoning(p);
        for (const dateKey of this.occurrences(p.dayOfWeek, now, horizonEnd, fmt)) {
          const start = localWallToUtc(dateKey, p.startMinutes);
          const end = localWallToUtc(dateKey, p.endMinutes);
          if (start.getTime() <= now + LEAD_MS || end.getTime() <= start.getTime()) continue;

          // Dédup entre les nuits : une occurrence déjà traitée n'est jamais re-proposée.
          const existing = await this.prisma.agendaAgentProposal.findUnique({
            where: { fleetId_vehicleId_startAt: { fleetId, vehicleId: p.vehicleId, startAt: start } },
          });
          if (existing) {
            skipped++;
            continue;
          }

          let status: AgendaAgentProposalStatus = 'pending';
          let createdEventId: string | null = null;

          if (autoOn && p.confidence >= threshold) {
            const resa = await this.reservations.systemConfirm({
              fleetId,
              vehicleId: p.vehicleId,
              start,
              end,
              title: this.title(p),
              metadata: this.meta(p, origin),
            });
            if (resa) {
              status = 'auto_applied';
              createdEventId = resa.id;
              created++;
            } else {
              skipped++; // créneau occupé → pas de proposition inutile
              continue;
            }
          } else {
            // Suggestion : n'a de sens que si le créneau est encore LIBRE.
            if (!(await this.reservations.isVehicleFree(p.vehicleId, start, end))) {
              skipped++;
              continue;
            }
            proposed++;
          }

          await this.prisma.agendaAgentProposal
            .create({
              data: {
                fleetId,
                vehicleId: p.vehicleId,
                startAt: start,
                endAt: end,
                dayOfWeek: p.dayOfWeek,
                destinationLabel: p.destinationLabel,
                destLat: p.destLat,
                destLng: p.destLng,
                confidence: p.confidence,
                basis: p.basis,
                reasoning,
                status,
                createdEventId,
                origin,
              },
            })
            .catch(() => {
              /* course sur la clé unique (fleet,véhicule,créneau) : sans gravité */
            });
        }
      }

      if (settings) {
        await this.prisma.agendaAgentSettings.update({ where: { fleetId }, data: { lastRunAt: new Date() } });
      }
      this.track(fleetId, origin, { created, proposed, skipped }, detection);
      await this.recordRun({
        fleetId, origin, startedAt, status: 'completed',
        patterns: patterns.length, created, proposed, skipped,
        // `reviews` non vide = la couche IA a réellement jugé. Distingue « agent déterministe
        // seul » (IA coupée pour la société) de « IA active mais sans effet ».
        aiUsed: reviews.size > 0,
      });
      return { created, proposed, skipped };
    } catch (e) {
      // Un passage qui échoue doit LAISSER UNE TRACE : sans ça, l'historique ne montrerait que les
      // succès et un agent cassé passerait pour un agent qui n'a rien à faire.
      await this.recordRun({
        fleetId, origin, startedAt, status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      this.running.delete(fleetId);
    }
  }

  /** Cron horaire : chaque flotte activée se déclenche à SON heure nocturne réglée. */
  @Cron('0 0 * * * *')
  async runScheduled(): Promise<void> {
    let rows: { fleetId: string; nightlyHour: number; frequency: string; triggerNightly: boolean; lastRunAt: Date | null }[];
    try {
      rows = await this.prisma.agendaAgentSettings.findMany({ where: { enabled: true } });
    } catch (e) {
      this.logger.error(`runScheduled (lecture réglages) : ${(e as Error)?.message ?? e}`);
      void this.errorLogger
        ?.record(e as Error, 'AGENDA_AGENT', { phase: 'runScheduled:settings' }, 'CRITICAL')
        .catch(() => {});
      return;
    }
    const fmt = fleetTzFormatter();
    const parisHour = Math.floor(localParts(fmt, Date.now()).minutes / 60);
    for (const s of rows) {
      if (!s.triggerNightly || (s.nightlyHour ?? 2) !== parisHour) continue;
      const periodMs = (s.frequency === 'weekly' ? 7 : 1) * DAY_MS - 2 * 60 * 60 * 1000; // marge anti-jitter
      if (s.lastRunAt && Date.now() - s.lastRunAt.getTime() < periodMs) continue;
      try {
        await this.runForFleet(s.fleetId, 'scheduled');
      } catch (e) {
        this.logger.error(`runScheduled ${s.fleetId} : ${(e as Error)?.message ?? e}`);
        void this.errorLogger
          ?.record(e as Error, 'AGENDA_AGENT', { fleetId: s.fleetId, phase: 'runScheduled' })
          .catch(() => {});
      }
    }
  }

  /**
   * Déclencheur ÉVÉNEMENTIEL (incident / maintenance / réservation). Ne (re)analyse que si l'agent
   * est activé ET la case correspondante est cochée, avec throttle anti-storm par flotte. Les
   * réservations créées PAR l'agent (source SYSTEM) n'émettent jamais cet évènement → pas de boucle.
   */
  @OnEvent('agenda-agent.trigger', { async: true })
  async onTrigger(payload: { fleetId?: string; kind?: 'incident' | 'maintenance' | 'reservation' }): Promise<void> {
    const fleetId = payload?.fleetId;
    const kind = payload?.kind;
    if (!fleetId || !kind) return;
    try {
      const s = await this.prisma.agendaAgentSettings.findUnique({ where: { fleetId } });
      if (!s?.enabled) return;
      const on = kind === 'incident' ? s.triggerIncident : kind === 'maintenance' ? s.triggerMaintenance : s.triggerReservation;
      if (!on) return;
      const now = Date.now();
      if (now - (this.lastEventRun.get(fleetId) ?? 0) < EVENT_THROTTLE_MS) return;
      this.lastEventRun.set(fleetId, now);
      await this.runForFleet(fleetId, kind);
    } catch (e) {
      this.logger.error(`onTrigger ${fleetId}/${kind} : ${(e as Error)?.message ?? e}`);
      void this.errorLogger
        ?.record(e as Error, 'AGENDA_AGENT', { fleetId, phase: `onTrigger:${kind}` })
        .catch(() => {});
    }
  }

  // ─── Propositions (revue humaine) ──────────────────────────────────────────

  async list(user: AuthUser, fleetId?: string, status: string = 'pending'): Promise<AgendaAgentProposalDto[]> {
    // Super-admin sans société ciblée (« toutes les sociétés ») : rien à lister (pas de 400 sur le
    // simple compteur de propositions ; il faut choisir une société pour voir/agir).
    if (user.role === UserRole.SUPER_ADMIN && !fleetId && !user.fleetId) return [];
    const id = this.resolveFleetId(user, fleetId);
    const rows = (await this.prisma.agendaAgentProposal.findMany({
      where: { fleetId: id, ...(status ? { status } : {}) },
      orderBy: { startAt: 'asc' },
      take: 200,
    })) as ProposalRow[];
    const vids = [...new Set(rows.map((r) => r.vehicleId))];
    const vehicles = vids.length
      ? await this.prisma.vehicle.findMany({ where: { id: { in: vids } }, select: { id: true, plate: true } })
      : [];
    const plate = new Map(vehicles.map((v) => [v.id, v.plate]));
    return rows.map((r) => this.toDto(r, plate.get(r.vehicleId) ?? null));
  }

  /** Valide une SUGGESTION -> crée la réservation ferme. Perm reservations_manage (controller). */
  async apply(user: AuthUser, id: string): Promise<AgendaAgentProposalDto> {
    const p = (await this.prisma.agendaAgentProposal.findUnique({ where: { id } })) as ProposalRow | null;
    if (!p) throw new NotFoundException('Proposition introuvable');
    this.assertScope(user, p.fleetId);
    await this.events.assertVehicleAccess(user, p.vehicleId); // 403/404 périmètre véhicule
    if (p.status !== 'pending') throw new BadRequestException('Proposition déjà traitée.');

    const resa = await this.reservations.systemConfirm({
      fleetId: p.fleetId,
      vehicleId: p.vehicleId,
      start: p.startAt,
      end: p.endAt,
      title: this.title(p),
      createdBy: user.id,
      metadata: { agent: true, appliedBy: user.id, destinationLabel: p.destinationLabel, confidence: p.confidence, basis: p.basis },
    });
    if (!resa) throw new ConflictException('Le créneau est déjà occupé.');
    const updated = (await this.prisma.agendaAgentProposal.update({
      where: { id },
      data: { status: 'applied', createdEventId: resa.id },
    })) as ProposalRow;
    return this.toDto(updated, resa.vehiclePlate ?? null);
  }

  /** Rejette une SUGGESTION. Perm reservations_manage (controller). */
  async dismiss(user: AuthUser, id: string): Promise<AgendaAgentProposalDto> {
    const p = (await this.prisma.agendaAgentProposal.findUnique({ where: { id } })) as ProposalRow | null;
    if (!p) throw new NotFoundException('Proposition introuvable');
    this.assertScope(user, p.fleetId);
    if (p.status === 'auto_applied' || p.status === 'applied') {
      throw new BadRequestException('Une réservation déjà créée s\'annule depuis l\'agenda.');
    }
    const updated = (await this.prisma.agendaAgentProposal.update({
      where: { id },
      data: { status: 'dismissed' },
    })) as ProposalRow;
    return this.toDto(updated, null);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Dates locales (YYYY-MM-DD) de la fenêtre qui tombent sur le jour-de-semaine du motif. */
  private occurrences(dow: number, fromMs: number, toMs: number, fmt: Intl.DateTimeFormat): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let cursor = fromMs;
    let steps = 0;
    while (cursor < toMs && steps < MAX_DAY_STEPS) {
      const p = localParts(fmt, cursor);
      if (!seen.has(p.dateKey)) {
        seen.add(p.dateKey);
        if (p.dow === dow) out.push(p.dateKey);
      }
      cursor += 12 * 60 * 60 * 1000; // pas de 12 h (robuste DST), dédup par dateKey
      steps++;
    }
    return out;
  }

  private hhmm(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}`;
  }

  private title(p: RecurringPattern | ProposalRow): string {
    return `Trajet récurrent${p.destinationLabel ? ' → ' + p.destinationLabel : ''}`;
  }

  private reasoning(p: RecurringPattern): string {
    const dest = p.destinationLabel ? ` vers ${p.destinationLabel}` : '';
    return `${p.basis}. Départ habituel ~${this.hhmm(p.startMinutes)}${dest} — occurrence récurrente projetée par l'agent.`;
  }

  /**
   * Couche IA BEST-EFFORT : Claude juge, pour chaque récurrence, s'il faut la pré-réserver (`keep`)
   * et rédige un « pourquoi » vulgarisé. Map vide si l'IA n'est pas configurée / échoue → l'agent
   * retombe sur son raisonnement déterministe (il ne casse JAMAIS). Coût tracé (action agenda_agent).
   */
  private async reviewPatterns(
    fleetId: string,
    patterns: RecurringPattern[],
  ): Promise<Map<number, { keep: boolean; reasoning: string }>> {
    const out = new Map<number, { keep: boolean; reasoning: string }>();
    if (!this.ai || !this.aiUsage || !this.ai.isConfigured() || patterns.length === 0) return out;
    // Interrupteur maître : IA désactivée pour la flotte → pas de couche IA (l'agent reste déterministe).
    if (this.aiAvail && !(await this.aiAvail.isEnabledForFleet(fleetId, 'agendaAgent'))) return out;
    const capped = patterns.slice(0, 30); // borne le coût sur les grosses flottes
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { metier: true, name: true } });
    const metier = (fleet?.metier as FleetMetier) ?? 'GENERIC';
    const payload = {
      fleetName: fleet?.name ?? null,
      metier,
      patterns: capped.map((p, i) => ({
        index: i,
        plate: p.vehiclePlate,
        dayOfWeek: p.dayOfWeek,
        start: this.hhmm(p.startMinutes),
        end: this.hhmm(p.endMinutes),
        destination: p.destinationLabel,
        // #3 — Vrai ITINÉRAIRE (lieux réellement visités, hors dépôt) : donne à l'IA le contexte du
        // déplacement, pas juste le dépôt de retour. Ex. ["Borderouge","Ramonville"].
        itinerary: p.itinerary,
        roundTripFromDepot: p.roundTripFromDepot,
        // #5 — ZONES (géofences) traversées : contexte métier admin-défini (ex. « Sortie Toulouse »).
        zones: p.zones,
        weeksObserved: p.activeWeeks,
        confidence: p.confidence,
      })),
    };
    try {
      const call = await this.ai.completeJson<{ reviews: { index: number; keep: boolean; reasoning: string }[] }>({
        system: renderAgendaAgentSystem(metier),
        userPayload: payload,
        schema: AGENDA_AGENT_SCHEMA,
        maxTokens: 4096,
      });
      for (const r of call.result?.reviews ?? []) {
        if (typeof r?.index === 'number' && r.index >= 0 && r.index < capped.length) {
          out.set(r.index, {
            keep: r.keep !== false,
            reasoning: typeof r.reasoning === 'string' ? r.reasoning.slice(0, 400) : '',
          });
        }
      }
      void this.aiUsage.record({
        userId: null, fleetId, action: 'agenda_agent', model: call.model,
        inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
        cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
        latencyMs: call.latencyMs, ok: true,
      });
    } catch (e) {
      // Best-effort : l'échec IA ne casse pas l'agent (raisonnement déterministe conservé), MAIS on le
      // remonte au centre d'alerte — c'est exactement le « aucun retour » que l'admin doit pouvoir
      // diagnostiquer (clé API absente, quota, timeout Claude…).
      this.logger.warn(`reviewPatterns ${fleetId} : ${(e as Error)?.message ?? e}`);
      void this.errorLogger
        ?.record(e as Error, 'AGENDA_AGENT_AI', { fleetId, phase: 'reviewPatterns' })
        .catch(() => {});
    }
    return out;
  }

  private meta(p: RecurringPattern, origin: string): Prisma.InputJsonValue {
    return { agent: true, origin, destinationLabel: p.destinationLabel, confidence: p.confidence, basis: p.basis } as Prisma.InputJsonValue;
  }

  private toDto(r: ProposalRow, vehiclePlate: string | null): AgendaAgentProposalDto {
    return {
      id: r.id,
      fleetId: r.fleetId,
      vehicleId: r.vehicleId,
      vehiclePlate,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
      dayOfWeek: r.dayOfWeek,
      destinationLabel: r.destinationLabel,
      confidence: r.confidence,
      basis: r.basis,
      reasoning: r.reasoning,
      status: r.status as AgendaAgentProposalStatus,
      origin: r.origin,
      createdEventId: r.createdEventId,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /**
   * Historique des passages (lecture). Même périmètre société que les propositions : un
   * super-admin sans société ciblée ne voit rien (il doit choisir), un non-super est borné à
   * la sienne par `resolveFleetId`.
   */
  async listRuns(user: AuthUser, fleetId?: string, limit = 30): Promise<AgendaAgentRunDto[]> {
    if (user.role === UserRole.SUPER_ADMIN && !fleetId && !user.fleetId) return [];
    const id = this.resolveFleetId(user, fleetId);
    const rows = await this.prisma.agendaAgentRun.findMany({
      where: { fleetId: id },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      origin: r.origin,
      status: r.status,
      patterns: r.patterns,
      created: r.created,
      proposed: r.proposed,
      skipped: r.skipped,
      aiUsed: r.aiUsed,
      durationMs: r.durationMs,
      error: r.error,
    }));
  }

  /**
   * Écrit une ligne d'historique. **Ne lève JAMAIS** : la traçabilité ne doit pas faire échouer
   * un passage qui, lui, a bien travaillé. Élague au passage pour ne pas laisser la table croître
   * indéfiniment (l'agent tourne toutes les nuits, par société).
   */
  private async recordRun(run: {
    fleetId: string;
    origin: string;
    startedAt: Date;
    status: string;
    patterns?: number;
    created?: number;
    proposed?: number;
    skipped?: number;
    aiUsed?: boolean;
    error?: string;
  }): Promise<void> {
    try {
      await this.prisma.agendaAgentRun.create({
        data: {
          fleetId: run.fleetId,
          startedAt: run.startedAt,
          finishedAt: new Date(),
          origin: run.origin,
          status: run.status,
          patterns: run.patterns ?? 0,
          created: run.created ?? 0,
          proposed: run.proposed ?? 0,
          skipped: run.skipped ?? 0,
          aiUsed: run.aiUsed ?? false,
          durationMs: Math.max(0, Date.now() - run.startedAt.getTime()),
          error: run.error ? run.error.slice(0, 500) : null,
        },
      });
      const old = await this.prisma.agendaAgentRun.findMany({
        where: { fleetId: run.fleetId },
        orderBy: { startedAt: 'desc' },
        skip: KEEP_RUNS_PER_FLEET,
        select: { id: true },
      });
      if (old.length > 0) {
        await this.prisma.agendaAgentRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
      }
    } catch (e) {
      this.logger.warn(`Historique agent agenda non écrit : ${(e as Error)?.message ?? e}`);
    }
  }

  private track(
    fleetId: string,
    origin: string,
    counts: { created: number; proposed: number; skipped: number },
    excluded?: { skippedDormantVehicles: number; skippedStalePatterns: number },
  ): void {
    // Le détail des exclusions n'apparaît que s'il y en a : un libellé propre les jours normaux,
    // et une explication le jour où l'exploitant se demande où sont passées ses propositions.
    const dormant = excluded?.skippedDormantVehicles ?? 0;
    const stale = excluded?.skippedStalePatterns ?? 0;
    const why =
      dormant > 0 || stale > 0
        ? ` (dont ${dormant} véhicule(s) au boîtier muet, ${stale} habitude(s) éteinte(s))`
        : '';
    this.systemActivity.record({
      category: 'AI',
      action: 'agenda_agent_run',
      status: 'SUCCESS',
      actor: origin === 'manual' ? 'utilisateur' : 'system',
      detail: `Agent agenda (${origin}) : ${counts.created} réservé(s), ${counts.proposed} proposé(s), ${counts.skipped} ignoré(s)${why}`,
      fleetId,
      meta: { ...counts, skippedDormantVehicles: dormant, skippedStalePatterns: stale },
    });
  }
}
