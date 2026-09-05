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
import { AutomationDisabledException } from '../common/automation-disabled.exception';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { lireResultatLocal, TravauxIaService } from '../travaux-ia/travaux-ia.service';
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
/** Type du travail de la file du poste qui porte le jugement de l'IA (design/C3 point 7). */
const TYPE_JUGEMENT = 'jugement-agenda' as const;
/** Motifs soumis au jugement, au plus — borne la taille du prompt sur les grosses flottes. */
const MAX_MOTIFS_JUGEMENT = 30;
/**
 * Longueur retenue d'une justification de l'IA. Le prompt demande une phrase COURTE ; 400 est la
 * borne que l'ancien appel synchrone appliquait déjà, et que le plafond de 16 000 jetons a été
 * dimensionné pour tenir (30 motifs × 400 caractères, relevé du 2026-08-21).
 */
const MAX_RAISON_IA = 400;

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
  aiVerdictAt: Date | null;
  aiKeep: boolean | null;
};

/** Un motif tel qu'il est rangé dans le contexte du travail : son rang dans le prompt et ses propositions. */
interface MotifJugement {
  index: number;
  proposalIds: string[];
}

/** Un verdict de l'IA, validé : rang du motif, garder ou non, justification bornée. */
interface VerdictIa {
  index: number;
  keep: boolean;
  reasoning: string;
}

/**
 * Refonte agenda/IA (2026-07, P3) — Agent nocturne d'optimisation d'agenda.
 * Chaque nuit (à l'heure réglée par flotte) — ou à la demande — il détecte les trajets récurrents
 * (RecurrenceDetectorService, DÉTERMINISTE), projette les prochaines occurrences, et selon
 * l'autonomie réglée (P2) : ajoute des SUGGESTIONS (`pending`) OU crée des réservations FERMES
 * au-dessus du seuil de confiance (`auto_applied`). Anti-double-réservation entre les nuits via
 * l'unicité (flotte, véhicule, créneau) + les pré-checks/EXCLUDE des réservations. Scoping tenant
 * strict. Aucun appel LLM depuis ce service : fiable et gratuit.
 *
 * VIVACITÉ : l'agent n'a pas de garde propre — il ne connaît que les motifs qu'on lui donne. Les
 * véhicules au boîtier muet et les habitudes éteintes sont écartés en AMONT (RecurrenceDetector) ;
 * l'agent se contente de reverser ces exclusions dans son bilan pour qu'elles soient visibles.
 *
 * ── LE JUGEMENT DE L'IA PASSE PAR LA FILE DU POSTE (design/C3 point 7, 2026-09-05) ─────────
 *
 * Jusqu'au 05/09, chaque passage appelait l'API (`AiRouter.completeJson`) AVANT de créer les
 * propositions : 12 appels en 30 jours pour la seule société cdef31, et le passage nocturne du
 * 04/09 tombé à 00:01 sur un compte fournisseur à sec (TRK-061). Décision du propriétaire : le
 * coût API automatique de l'agenda doit être 0 ; seuls l'assistance et l'optimiseur — des
 * gestes instantanés — restent sur l'API.
 *
 *   1. PRODUCTEUR (`runForFleet`, planifié, manuel ou événementiel) : la détection ne change pas,
 *      les propositions sont créées AUSSITÔT avec la phrase mécanique — c'est le mode dégradé
 *      qui tournait déjà depuis le 04/09, réservations fermes de l'autonomie haute comprises.
 *      Puis, si l'IA est ouverte pour la société et qu'au moins un motif a produit une
 *      proposition, UN travail `jugement-agenda` est enfilé pour le courrier du poste, avec la
 *      liste des propositions créées par motif. Plus aucun appel modèle ici, ni la nuit ni au clic.
 *   2. CONSOMMATEUR (`consommerJugements`, en tête du cron horaire) : range les verdicts rendus
 *      par le courrier (06:30 / 14:30 Paris) — `keep=false` écarte les propositions encore en
 *      attente avec la raison de l'IA, `keep=true` remplace la phrase mécanique ; chaque
 *      proposition porte `aiVerdictAt` / `aiKeep`, le passage devient `aiUsed`, et l'usage est
 *      écrit avec les jetons RÉELS mesurés par la CLI (executor `local`, 0 $ facturé).
 *   3. EXPIRATION (`expirerPropositions`, même cron) : une suggestion dont le créneau est passé
 *      devient `expired` — 1 615 propositions périmées sur 1 954 `pending` relevées le 05/09.
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
    // File des travaux IA du poste (design/C1, C3 point 7) : remplace le routeur IA à cette
    // position depuis le 2026-09-05. OBLIGATOIRE — sans file, pas de jugement possible ; les
    // specs passent un double (`enfiler`, `reprendrePerimes`, `faits`, `consommer`, `rejeter`).
    private readonly travauxIa: TravauxIaService,
    // Usage IA (@Global) : ligne d'usage du verdict consommé (jetons réels du poste, 0 $).
    private readonly aiUsage?: AiUsageService,
    // Centre d'alerte (@Global) : remonte les échecs des runs de FOND (planifié / événementiel /
    // enfilage / consommation) qui, sinon, ne journalisent qu'en console. Omis dans les specs.
    private readonly errorLogger?: ErrorLogger,
    // Interrupteur maître IA par flotte (@Global) : si la flotte a désactivé l'IA, aucun travail de
    // jugement n'est enfilé (l'agent reste 100% déterministe). PLACÉ EN FIN pour ne pas décaler
    // les constructions positionnelles des specs (injection NestJS = par type, l'ordre n'impacte
    // pas la prod). Absent (specs) = IA fermée : on n'enfile jamais par défaut.
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
      // Planifié : rien si l'agent est désactivé (no-op silencieux, un cron ne lève pas).
      if (origin === 'scheduled' && !enabled) return { created: 0, proposed: 0, skipped: 0 };
      /**
       * Manuel + agent désactivé : REFUS, avant toute détection (design/C3 point 2, 2026-09-05).
       *
       * Jusqu'ici « Lancer l'analyse » tournait quand même — détection, propositions, et
       * jusqu'à l'appel IA synchrone de l'époque (`reviewPatterns`, remplacé le 05/09 par le
       * travail de jugement confié au poste, point 7) — alors que l'exploitant avait coupé l'agent
       * (12 appels API sur 30 j relevés le 05/09 pour la seule société cdef31). Un interrupteur
       * qu'un bouton contourne n'est pas un interrupteur. Le 409 remonte tel quel au front
       * (le message dit quoi faire) ; il ne laisse ni ligne d'historique ni alerte : ce n'est
       * pas un passage qui a échoué, c'est un passage qui n'a pas eu lieu.
       *
       * Une société SANS ligne de réglage n'a jamais activé l'agent : même refus. Les
       * déclencheurs événementiels ne passent pas ici (`onTrigger` teste déjà `enabled`).
       */
      if (origin === 'manual' && !enabled) {
        throw new AutomationDisabledException(
          "L'agent d'agenda est désactivé pour cette société. Activez-le et enregistrez avant de lancer une analyse.",
        );
      }
      // On ne réserve AUTO que si l'agent est en autonomie « auto si confiance haute ».
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
      const now = Date.now();
      const horizonEnd = now + HORIZON_DAYS * DAY_MS;
      const fmt = fleetTzFormatter();

      let created = 0;
      let proposed = 0;
      // Les exclusions du détecteur entrent dans « ignoré(s) » — le seul compteur qui existe déjà
      // pour « vu, pas traité ». Le détail (dormants / éteints) est écrit en clair par `track()` :
      // aucune migration, et aucun chiffre qui baisse sans explication.
      let skipped = detection.skippedDormantVehicles + detection.skippedStalePatterns;
      // Propositions créées CE passage, par rang de motif : c'est ce que le jugement de l'IA
      // pourra écarter ou commenter après coup. Une occurrence déjà proposée une nuit précédente
      // n'y entre pas — elle a eu (ou aura eu) son verdict la nuit où elle est née.
      const idsParMotif = new Map<number, string[]>();

      for (let pi = 0; pi < patterns.length; pi++) {
        const p = patterns[pi];
        // Phrase MÉCANIQUE, toujours : le « pourquoi » vulgarisé de l'IA la remplacera quand le
        // verdict sera consommé (design/C3 point 7) — la proposition est visible et réservable
        // dès maintenant, comme en mode dégradé.
        const reasoning = this.reasoning(p);
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

          const row = await this.prisma.agendaAgentProposal
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
              select: { id: true },
            })
            .catch(() => null as { id: string } | null);
          /* `null` = course sur la clé unique (fleet,véhicule,créneau) : sans gravité, et rien à juger */
          if (row?.id) idsParMotif.set(pi, [...(idsParMotif.get(pi) ?? []), row.id]);
        }
      }

      if (settings) {
        await this.prisma.agendaAgentSettings.update({ where: { fleetId }, data: { lastRunAt: new Date() } });
      }
      /**
       * L'historique est écrit AVANT l'enfilage, pour que le travail porte `runId` : c'est par lui
       * que le consommateur marquera le passage `aiUsed` quand le verdict arrivera. `aiUsed` est
       * donc toujours false à la création — l'IA n'a encore rien jugé. Choix documenté (design/C3
       * point 7) : créer la ligne à la fin, comme avant, garde intacts les compteurs et la durée
       * d'un passage RÉEL ; une ligne « en cours » ouverte au début aurait exigé un troisième statut.
       * `recordRun` ne lève jamais : sans identifiant (historique en panne), le travail part quand
       * même — les propositions seront jugées, seul le badge « IA » du passage manquera.
       */
      const runId = await this.recordRun({
        fleetId, origin, startedAt, status: 'completed',
        patterns: patterns.length, created, proposed, skipped,
        aiUsed: false,
      });
      const aiVerdictQueued = await this.enfilerJugement(fleetId, origin, runId, patterns, idsParMotif);
      this.track(fleetId, origin, { created, proposed, skipped }, detection, aiVerdictQueued);
      return { created, proposed, skipped, aiVerdictQueued };
    } catch (e) {
      // Un refus (agent désactivé, lancement manuel) n'est pas un passage en échec : il n'a rien
      // détecté, rien écrit, rien à archiver. Une ligne « error » ici ferait passer un réglage
      // respecté pour un agent cassé — l'inverse exact de ce que l'historique doit montrer.
      if (e instanceof AutomationDisabledException) throw e;
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

  /**
   * Cron horaire : chaque flotte activée se déclenche à SON heure nocturne réglée.
   *
   * En tête, AVANT la boucle des flottes (design/C3 point 7) : l'expiration des suggestions dont
   * le créneau est passé, puis la consommation des verdicts rendus par le courrier du poste. Les
   * deux sont isolés : une panne de l'un n'empêche ni l'autre ni les passages nocturnes, et
   * chacune laisse une ligne au centre d'alerte — un verdict jamais rangé ne doit pas se deviner
   * à des propositions qui gardent leur phrase mécanique.
   */
  @Cron('0 0 * * * *')
  async runScheduled(): Promise<void> {
    try {
      const n = await this.expirerPropositions();
      if (n > 0) this.logger.log(`${n} proposition(s) d'agenda périmée(s) passée(s) en expired`);
    } catch (e) {
      this.logger.error(`expirerPropositions : ${(e as Error)?.message ?? e}`);
      void this.errorLogger
        ?.record(e as Error, 'AGENDA_AGENT', { phase: 'expirerPropositions' })
        .catch(() => {});
    }
    try {
      await this.consommerJugements();
    } catch (e) {
      this.logger.error(`consommerJugements : ${(e as Error)?.message ?? e}`);
      void this.errorLogger
        ?.record(e as Error, 'AGENDA_AGENT', { phase: 'consommerJugements' })
        .catch(() => {});
    }
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
      where: {
        fleetId: id,
        ...(status ? { status } : {}),
        // Une suggestion dont le départ est passé n'est plus réservable : elle sort de la liste
        // sans attendre que le cron horaire l'acte `expired` (design/C3 point 7 — le 05/09, les
        // 200 lignes affichées étaient toutes périmées). Les autres statuts restent historiques.
        ...(status === 'pending' ? { startAt: { gte: new Date() } } : {}),
      },
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

  // ─── Jugement de l'IA par la file du poste (design/C3 point 7) ─────────────

  /**
   * PRODUCTEUR : confie au courrier du poste le jugement des motifs qui ont produit au moins une
   * proposition ce passage. Rend true si un travail a bien été enfilé.
   *
   * Ne quittent jamais ce service : la porte IA de la société (`aiAvail`, interrupteur maître +
   * drapeau `agendaAgent`), le prompt système, le schéma STRICT et les données — le courrier ne
   * connaît aucun métier. Un motif sans proposition nouvelle n'est pas soumis : il n'y a rien à
   * écarter ni à commenter, et avec un horizon de 14 jours la plupart des habitudes hebdomadaires
   * ne produisent une occurrence neuve qu'une nuit sur sept — soumettre les 30 chaque nuit aurait
   * payé (en temps de poste) des verdicts sans objet.
   *
   * Clé d'idempotence : la nuit, `jugement-agenda:<société>:<jour Paris>` — un seul travail par
   * société et par nuit même si le cron horaire repassait ; un clic « Lancer l'analyse » (ou un
   * déclencheur événementiel) porte en plus son origine et l'horodatage, parce que SES propositions
   * sont neuves et méritent leur propre verdict.
   *
   * BEST-EFFORT : une file injoignable ne fait pas échouer un passage qui a déjà créé ses
   * propositions — elles gardent leur phrase mécanique, et l'échec est remonté au centre
   * d'alerte (source AGENDA_AGENT) pour qu'un « l'IA ne dit jamais rien » ait une cause lisible.
   */
  private async enfilerJugement(
    fleetId: string,
    origin: string,
    runId: string | null,
    patterns: RecurringPattern[],
    idsParMotif: Map<number, string[]>,
  ): Promise<boolean> {
    const motifs = patterns
      .map((p, pi) => ({ p, proposalIds: idsParMotif.get(pi) ?? [] }))
      .filter((m) => m.proposalIds.length > 0)
      .slice(0, MAX_MOTIFS_JUGEMENT);
    if (motifs.length === 0) return false;
    // Porte SANS clé API serveur : le jugement part vers la file du poste, pas vers un fournisseur.
    if (!this.aiAvail || !(await this.aiAvail.isFeatureOnForFleet(fleetId, 'agendaAgent'))) return false;
    try {
      const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { metier: true, name: true } });
      const metier = (fleet?.metier as FleetMetier) ?? 'GENERIC';
      const userPayload = {
        fleetName: fleet?.name ?? null,
        metier,
        patterns: motifs.map(({ p }, i) => ({
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
      const dateKey = localParts(fleetTzFormatter(), Date.now()).dateKey;
      const cleIdempotence =
        origin === 'scheduled'
          ? `${TYPE_JUGEMENT}:${fleetId}:${dateKey}`
          : `${TYPE_JUGEMENT}:${fleetId}:${dateKey}:${origin === 'manual' ? 'manuel' : origin}:${Date.now()}`;
      const { enfile } = await this.travauxIa.enfiler(
        TYPE_JUGEMENT,
        {
          system: renderAgendaAgentSystem(metier),
          schema: AGENDA_AGENT_SCHEMA,
          userPayload,
          /**
           * 16 000 et non 4 096 — relevé le 2026-08-21 après un refus en production
           * (« Réponse IA tronquée : limite de jetons atteinte »). Jusqu'à 30 motifs, chacun avec
           * un verdict et une justification de 400 caractères : plus de 12 000 caractères de
           * sortie utile hors structure JSON, 4 096 jetons ne pouvaient pas tenir et le JSON
           * tronqué perdait TOUT le passage. C'est un PLAFOND, pas une réservation — et sur le
           * poste il ne coûte rien de plus.
           */
          maxTokens: 16000,
        },
        {
          cleIdempotence,
          fleetId,
          runId,
          dateKey,
          motifs: motifs.map((m, i): MotifJugement => ({ index: i, proposalIds: m.proposalIds })),
        },
      );
      if (!enfile) this.logger.warn(`jugement-agenda ${fleetId} : déjà en file pour ${dateKey}, pas de doublon`);
      return enfile;
    } catch (e) {
      this.logger.warn(`enfilerJugement ${fleetId} : ${(e as Error)?.message ?? e}`);
      void this.errorLogger
        ?.record(e as Error, 'AGENDA_AGENT', { fleetId, runId, phase: 'enfilerJugement' })
        .catch(() => {});
      return false;
    }
  }

  /**
   * CONSOMMATEUR : range les verdicts que le courrier du poste a rendus (appelé en tête du cron
   * horaire). Pour chaque travail `jugement-agenda` en `fait` :
   *
   *   — le résultat est VALIDÉ strictement (`lireVerdicts`) : un tableau `reviews` d'objets
   *     `{ index entier dans les bornes, keep booléen, reasoning chaîne }`, sinon le travail est
   *     rejeté (`rejeter` : rejoué, puis acté en échec à la 3ᵉ tentative — visible) ;
   *   — `keep=false` : les propositions du motif ENCORE `pending` passent en `dismissed`, avec la
   *     raison de l'IA ; `keep=true` : leur phrase mécanique est remplacée par le « pourquoi »
   *     vulgarisé ;
   *   — toutes les propositions du motif encore vivantes (`pending` ou `auto_applied`) portent
   *     `aiVerdictAt` / `aiKeep`. ⚠️ Une réservation FERME (`auto_applied`) n'est JAMAIS annulée
   *     par ce verdict : elle est déjà dans l'agenda, peut-être déjà vue par l'exploitant — la
   *     retirer après coup est un geste humain (design/C3 point 7). Une proposition déjà tranchée
   *     par un humain (`applied`, `dismissed`) ou périmée (`expired`) n'est pas touchée ;
   *   — le passage d'origine devient `aiUsed` (via `runId`, s'il existe encore) dès qu'au moins
   *     un verdict a été rendu ;
   *   — UNE ligne `ai_usage_logs` (C3, point 3) : executor `local`, identifiant réel du modèle et
   *     jetons mesurés par la CLI (`lireResultatLocal`, 0 pour un ancien format), `costUsd`
   *     forcé à 0 par `AiUsageService.record` — rien n'est facturé, le coût équivalent se
   *     recalcule à la lecture. Écrite ICI et seulement ici : le courrier n'écrit plus d'usage.
   */
  async consommerJugements(): Promise<{ ranges: number; rejetes: number }> {
    await this.travauxIa.reprendrePerimes();
    const faits = await this.travauxIa.faits(TYPE_JUGEMENT);
    let ranges = 0;
    let rejetes = 0;
    for (const t of faits) {
      const lu = lireResultatLocal(t.resultat);
      try {
        const motifs = lireMotifs(t.contexte);
        const verdicts = lireVerdicts(lu.contenu, motifs.length);
        const fleetId = typeof t.contexte['fleetId'] === 'string' ? t.contexte['fleetId'] : null;
        const runId = typeof t.contexte['runId'] === 'string' ? t.contexte['runId'] : null;
        const now = new Date();
        for (const v of verdicts) {
          const ids = motifs[v.index].proposalIds;
          if (ids.length === 0) continue;
          if (v.keep) {
            await this.prisma.agendaAgentProposal.updateMany({
              where: { id: { in: ids }, status: 'pending' },
              // Une justification vide ne remplace pas la phrase mécanique : mieux vaut « projetée
              // par l'agent » qu'une proposition muette.
              data: { ...(v.reasoning ? { reasoning: v.reasoning } : {}), aiVerdictAt: now, aiKeep: true },
            });
          } else {
            await this.prisma.agendaAgentProposal.updateMany({
              where: { id: { in: ids }, status: 'pending' },
              data: {
                status: 'dismissed',
                reasoning: v.reasoning ? `Écartée par l'IA : ${v.reasoning}` : "Écartée par l'IA.",
                aiVerdictAt: now,
                aiKeep: false,
              },
            });
          }
          // Réservation ferme : le verdict est POSÉ (visible), la réservation est CONSERVÉE.
          await this.prisma.agendaAgentProposal.updateMany({
            where: { id: { in: ids }, status: 'auto_applied' },
            data: { aiVerdictAt: now, aiKeep: v.keep },
          });
        }
        // `updateMany` et non `update` : un passage élagué entre-temps (plafond d'historique par
        // société) ne doit pas faire rejeter un verdict qui, lui, a bien été appliqué.
        if (runId && verdicts.length > 0) {
          await this.prisma.agendaAgentRun.updateMany({ where: { id: runId }, data: { aiUsed: true } });
        }
        await this.aiUsage?.record({
          userId: null,
          fleetId,
          action: 'agenda_agent',
          model: lu.modele,
          executor: 'local',
          inputTokens: lu.usage.inputTokens,
          outputTokens: lu.usage.outputTokens,
          cacheWriteTokens: lu.usage.cacheWriteTokens,
          cacheReadTokens: lu.usage.cacheReadTokens,
          latencyMs: lu.latencyMs || null,
          ok: true,
          resultCount: verdicts.length,
        });
        await this.travauxIa.consommer(t.id);
        ranges++;
        this.logger.log(`jugement-agenda ${fleetId ?? '?'} : ${verdicts.length} verdict(s) rangé(s) (${lu.modele})`);
      } catch (e) {
        rejetes++;
        await this.travauxIa.rejeter(t.id, e instanceof Error ? e.message : String(e));
      }
    }
    return { ranges, rejetes };
  }

  /**
   * EXPIRATION : une suggestion `pending` dont le créneau est entièrement passé (`endAt < now`)
   * devient `expired`. Seules les suggestions sont concernées — une réservation ferme vit dans
   * l'agenda, une proposition tranchée reste ce qu'elle est. Paramétrable en date pour la spec ;
   * le cron horaire l'appelle avec l'heure courante. Rend le nombre de lignes basculées.
   */
  async expirerPropositions(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.agendaAgentProposal.updateMany({
      where: { status: 'pending', endAt: { lt: now } },
      data: { status: 'expired' },
    });
    return count;
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
      aiVerdictAt: r.aiVerdictAt ? r.aiVerdictAt.toISOString() : null,
      aiKeep: r.aiKeep ?? null,
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
   * Écrit une ligne d'historique et rend son identifiant (`null` si l'écriture a échoué).
   * **Ne lève JAMAIS** : la traçabilité ne doit pas faire échouer un passage qui, lui, a bien
   * travaillé. Élague au passage pour ne pas laisser la table croître indéfiniment (l'agent
   * tourne toutes les nuits, par société). L'identifiant sert au travail de jugement enfilé
   * juste après : c'est par lui que le verdict marquera le passage `aiUsed`.
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
  }): Promise<string | null> {
    try {
      const ligne = await this.prisma.agendaAgentRun.create({
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
      return typeof ligne?.id === 'string' ? ligne.id : null;
    } catch (e) {
      this.logger.warn(`Historique agent agenda non écrit : ${(e as Error)?.message ?? e}`);
      return null;
    }
  }

  private track(
    fleetId: string,
    origin: string,
    counts: { created: number; proposed: number; skipped: number },
    excluded?: { skippedDormantVehicles: number; skippedStalePatterns: number },
    aiVerdictQueued = false,
  ): void {
    // Le détail des exclusions n'apparaît que s'il y en a : un libellé propre les jours normaux,
    // et une explication le jour où l'exploitant se demande où sont passées ses propositions.
    const dormant = excluded?.skippedDormantVehicles ?? 0;
    const stale = excluded?.skippedStalePatterns ?? 0;
    const why =
      dormant > 0 || stale > 0
        ? ` (dont ${dormant} véhicule(s) au boîtier muet, ${stale} habitude(s) éteinte(s))`
        : '';
    // Dire si un verdict est attendu : sans ça, « l'IA ne dit jamais rien » se lirait comme une
    // panne alors que l'IA est simplement coupée pour la société, ou qu'il n'y avait rien à juger.
    const ia = aiVerdictQueued ? ' · avis de l\'IA confié au poste' : '';
    this.systemActivity.record({
      category: 'AI',
      action: 'agenda_agent_run',
      status: 'SUCCESS',
      actor: origin === 'manual' ? 'utilisateur' : 'system',
      detail: `Agent agenda (${origin}) : ${counts.created} réservé(s), ${counts.proposed} proposé(s), ${counts.skipped} ignoré(s)${why}${ia}`,
      fleetId,
      meta: { ...counts, skippedDormantVehicles: dormant, skippedStalePatterns: stale, aiVerdictQueued },
    });
  }
}

// ─── Lecture stricte d'un travail de jugement ──────────────────────────────────

/**
 * Les motifs rangés dans le contexte du travail par `enfilerJugement`. Le contexte est écrit par
 * ce service, mais il transite par une colonne JSON et une ligne modifiée à la main est toujours
 * possible : une forme inattendue fait rejeter le travail, jamais appliquer un verdict de travers.
 */
function lireMotifs(contexte: Record<string, unknown>): MotifJugement[] {
  const brut = contexte['motifs'];
  if (!Array.isArray(brut)) throw new Error('contexte sans tableau motifs');
  return brut.map((m, i) => {
    const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    if (o['index'] !== i) throw new Error(`motif ${i} : index incohérent`);
    const ids = Array.isArray(o['proposalIds']) ? o['proposalIds'].filter((x): x is string => typeof x === 'string') : [];
    return { index: i, proposalIds: ids };
  });
}

/**
 * Le `reviews` rendu par le modèle, validé STRICTEMENT contre le schéma promis au prompt :
 * un tableau d'objets `{ index, keep, reasoning }` — `index` entier dans [0, nbMotifs[ (le
 * prompt interdit d'inventer un index), `keep` booléen, `reasoning` chaîne. Tout écart fait
 * rejeter le travail entier : un verdict à moitié lisible n'est pas un verdict. La longueur, elle,
 * est bornée et non refusée (`MAX_RAISON_IA`) : c'est de l'affichage. Un index en double garde
 * le premier verdict.
 */
function lireVerdicts(contenu: unknown, nbMotifs: number): VerdictIa[] {
  const reviews = (contenu && typeof contenu === 'object' ? (contenu as Record<string, unknown>)['reviews'] : undefined);
  if (!Array.isArray(reviews)) throw new Error('résultat sans tableau reviews');
  const vus = new Set<number>();
  const out: VerdictIa[] = [];
  reviews.forEach((r, i) => {
    const o = (r && typeof r === 'object' ? r : null) as Record<string, unknown> | null;
    if (!o) throw new Error(`review ${i} : pas un objet`);
    const index = o['index'];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= nbMotifs) {
      throw new Error(`review ${i} : index hors bornes (${String(index)})`);
    }
    if (typeof o['keep'] !== 'boolean') throw new Error(`review ${i} : keep non booléen`);
    if (typeof o['reasoning'] !== 'string') throw new Error(`review ${i} : reasoning non textuel`);
    if (vus.has(index)) return;
    vus.add(index);
    out.push({ index, keep: o['keep'], reasoning: o['reasoning'].trim().slice(0, MAX_RAISON_IA) });
  });
  return out;
}
