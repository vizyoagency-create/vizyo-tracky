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
import { Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import { randomUUID } from 'crypto';
import type {
  AgendaAgentProposalDto,
  AgendaAgentProposalStatus,
  AgendaAgentRunDto,
  AgendaAgentRunResultDto,
  EcarterPropositionsDto,
  EcartPropositionsResultDto,
  FleetMetier,
  NettoyageChevauchementsResultDto,
  NettoyerChevauchementsDto,
} from '@vizyo/tracky-shared';
import { effectiveBlockingEndMs, IMMOBILIZING_STATUSES } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { AutomationDisabledException } from '../common/automation-disabled.exception';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService, type SystemActivityInput } from '../system-activity/system-activity.service';
import { lireResultatLocal, TravauxIaService } from '../travaux-ia/travaux-ia.service';
import { AGENDA_AGENT_SCHEMA, renderAgendaAgentSystem } from './agenda-agent.prompt';
import { fleetTzFormatter, localParts, localWallToUtc } from './fleet-tz.util';
import { RecurrenceDetectorService, type RecurringPattern } from './recurrence-detector.service';
import { ReservationsService } from './reservations.service';
import { creneauParis, VehicleEventsService } from './vehicle-events.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Horizon de projection des occurrences récurrentes (jours à venir). */
const HORIZON_DAYS = 14;
/** On ne réserve/propose jamais dans l'heure qui vient (créneau trop proche = inutile). */
const LEAD_MS = 60 * 60 * 1000;
const MAX_DAY_STEPS = 60;
/** Historique conservé par société (l'agent tourne chaque nuit → ~3 mois de recul). */
const KEEP_RUNS_PER_FLEET = 100;
/** P2-5 — une proposition `expired` / `dismissed` dont le créneau a plus d'un trimestre s'efface. */
const RETENTION_PROPOSITIONS_CLOSES_MS = 90 * DAY_MS;
/** P2-5 — par passage horaire : le reliquat s'écoule en plusieurs passages, jamais en un verrou. */
const PURGE_LOT_MAX = 5_000;
/**
 * D0 (4e revue du 29/09) — âge minimal d'une proposition « prise sans réservation » avant rattrapage.
 * `apply()` prend la proposition puis réserve : quelques centaines de millisecondes d'ordinaire. Dix
 * minutes laissent passer toute application encore en cours (VPS lent, verrou) sans la disputer.
 */
const RATTRAPAGE_DELAI_MS = 10 * 60 * 1000;
/** D0 — par passage horaire, comme la purge : un reliquat anormal s'écoule sans verrouiller. */
const RATTRAPAGE_LOT_MAX = 200;
/**
 * Plafond de la liste des propositions rendue à l'écran (grille en pointillé, onglet
 * « Propositions IA », panneau du jour).
 *
 * Recette du 28/09 sur la démo : `take: 200` sur 453 propositions triées par départ — la grille
 * s'arrêtait au 6ᵉ jour et le badge disait « 200 », **sans un mot**. Même famille que P2-3
 * (`MAX_EVENEMENTS_PAR_FENETRE`). À ~35 propositions par jour sur une flotte de 37 véhicules, 1 000
 * couvre un horizon d'un mois ; quand le plafond mord, le journal le dit avec la société.
 */
export const PROPOSITIONS_LISTE_MAX = 1_000;
/**
 * Plafond d'un lot de propositions écartées depuis Réorganiser (piste 3 du 29/09) : celui des
 * réservations (`MAX_REORGANISATION`). Au-delà, le lot est tronqué et la réponse le dit (`plafonne`).
 */
export const MAX_LOT_PROPOSITIONS = 500;
/** Un identifiant (véhicule, société, proposition) tel que les colonnes UUID l'attendent. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Plafond d'un nettoyage des chevauchements (30/09) : au-delà, tronqué et dit (`plafonne`). */
export const MAX_NETTOYAGE_CHEVAUCHEMENTS = 2_000;

/** Une proposition telle que le nettoyage des chevauchements la lit. */
export interface PropositionAClasser {
  id: string;
  vehicleId: string;
  startAt: Date;
  endAt: Date;
  confidence: number;
  createdAt: Date;
  aiKeep: boolean | null;
}

/**
 * Un créneau déjà PRIS sur un véhicule : réservation ferme ou immobilisation, fin EFFECTIVE en ms
 * (un incident sans fin bloque jusqu'à sa résolution). Relecture du 30/09 : le nettoyage ne voyait que
 * les propositions en attente — il pouvait garder une proposition sous une réservation (« Réserver »
 * → 409 « Le créneau est déjà occupé ») et écarter sa jumelle, la seule réservable.
 */
export interface CreneauPris {
  vehicleId: string;
  debutMs: number;
  finMs: number;
}

/**
 * 30/09 — les propositions à ÉCARTER pour qu'aucune ne chevauche une autre du même véhicule, ni un
 * créneau déjà PRIS (`pris` : réservation ferme, immobilisation), en gardant la plus sûre de chaque
 * groupe : validée par l'IA d'abord (`aiKeep`), puis la plus confiante, puis la plus ANCIENNE (vue le
 * plus longtemps), puis la plus tôt. Les créneaux pris sont gardés d'office : une proposition qui en
 * chevauche un ne se réserve pas (`isVehicleFree`), elle ne l'emporte jamais sur une jumelle libre.
 * L'agent, lui, garde la proposition déjà CONNUE (premier arrivé, relecture du 29/09) ; le nettoyage,
 * qui voit tout le groupe d'un coup, garde la plus sûre.
 * Une chaîne A–B–C (A chevauche B, B chevauche C, pas A et C) garde A et C si A est la plus sûre.
 */
export function propositionsEnChevauchement(
  lignes: readonly PropositionAClasser[],
  pris: readonly CreneauPris[] = [],
): string[] {
  const rang = (p: PropositionAClasser): number => (p.aiKeep === true ? 0 : p.aiKeep === null ? 1 : 2);
  const tri = [...lignes].sort(
    (a, b) =>
      rang(a) - rang(b) ||
      b.confidence - a.confidence ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.startAt.getTime() - b.startAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const gardes = new Map<string, { debutMs: number; finMs: number }[]>();
  const garder = (vehicleId: string, debutMs: number, finMs: number): void => {
    const l = gardes.get(vehicleId) ?? [];
    l.push({ debutMs, finMs });
    gardes.set(vehicleId, l);
  };
  for (const c of pris) garder(c.vehicleId, c.debutMs, c.finMs);
  const aEcarter: string[] = [];
  for (const p of tri) {
    const debut = p.startAt.getTime();
    const fin = p.endAt.getTime();
    if ((gardes.get(p.vehicleId) ?? []).some((o) => o.debutMs < fin && o.finMs > debut)) {
      aEcarter.push(p.id);
      continue;
    }
    garder(p.vehicleId, debut, fin);
  }
  return aEcarter;
}
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

  /**
   * La société visée. Un super-admin la CHOISIT (`fleetId` : la société du bandeau) et doit en préciser
   * une s'il n'en a pas. Tout autre rôle agit sur LA SIENNE : le `fleetId` qu'il envoie est IGNORÉ,
   * comme pour les réservations et les évènements (`scopedWhere`).
   *
   * Défaut latent trouvé le 29/09 (piste 3) : ce `fleetId` vient du filtre société de l'écran, relu du
   * navigateur quel que soit le rôle et jamais effacé à la déconnexion. Après une session super-admin
   * sur le même navigateur, un gestionnaire envoyait la société d'un AUTRE client → 403 « Flotte hors
   * périmètre », avalé par l'écran : plus de pointillés dans la grille, badge de l'Assistant IA et
   * onglet des propositions de Réorganiser vides, sans un mot. Le refus ne protégeait rien — le
   * serveur connaît la société d'un gestionnaire, il n'a jamais à la lui demander.
   */
  private resolveFleetId(user: AuthUser, fleetId?: string): string {
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée');
      return user.fleetId;
    }
    const id = fleetId ?? user.fleetId ?? undefined;
    if (!id) throw new BadRequestException('Préciser la flotte (fleetId).');
    return id;
  }

  private assertScope(user: AuthUser, fleetId: string): void {
    // 404 (pas 403) pour ne pas révéler l'existence d'une proposition hors périmètre.
    if (user.role !== UserRole.SUPER_ADMIN && fleetId !== user.fleetId) {
      throw new NotFoundException('Proposition introuvable');
    }
  }

  // ─── Exécution ─────────────────────────────────────────────────────────────

  /**
   * Lancement À LA DEMANDE (super/fleet admin). L'utilisateur réel suit jusqu'au journal métier
   * (29/09) : « Passage de l'agent » lancé par quelqu'un n'est pas un passage de nuit.
   */
  async runOnDemand(user: AuthUser, fleetId?: string): Promise<AgendaAgentRunResultDto> {
    return this.runForFleet(this.resolveFleetId(user, fleetId), 'manual', user.id);
  }

  /**
   * Analyse une flotte : détecte, projette, dédup, propose ou réserve (auto).
   * `triggeredByUserId` : renseigné pour un lancement manuel seulement (journal métier).
   */
  async runForFleet(fleetId: string, origin: string, triggeredByUserId: string | null = null): Promise<AgendaAgentRunResultDto> {
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
      /**
       * ── L'AGENT NE RÉSERVE PLUS RIEN (décision du propriétaire, 2026-09-23) ─────────────────
       *
       * ┌─ LA MESURE QUI A TRANCHÉ ─────────────────────────────────────────────┐
       * │ 321 réservations automatiques déjà PASSÉES de cdef31, confrontées aux  │
       * │ trajets réels du véhicule sur leur créneau :                           │
       * │                                                                         │
       * │   • 183 (57 %) le véhicule a roulé PENDANT le créneau                  │
       * │   •  63 (20 %) il a roulé ce jour-là, à une AUTRE heure                │
       * │   •  75 (23 %) il n'a PAS BOUGÉ de la journée                          │
       * │                                                                         │
       * │ Écart d'heure quand le jour est bon : médiane 47 min, p90 4 h.         │
       * │ Et toutes ces réservations étaient au-dessus du seuil de confiance de  │
       * │ 80 % : la confiance déclarée n'est pas corrélée à la réalité. Monter   │
       * │ le seuil n'aurait donc rien réglé.                                     │
       * └─────────────────────────────────────────────────────────────────────────┘
       *
       * Ce que ça dit : la détection d'HABITUDES est bonne — le jour est juste 77 fois sur 100 —
       * mais le placement HORAIRE ne l'est pas. Or une réservation ferme BLOQUE un créneau précis :
       * à ±47 minutes elle occupe le mauvais, et fait échouer la vraie demande d'un conducteur.
       * Sur cdef31, 430 réservations sur 435 venaient de l'agent, et 21 véhicules sur 30 étaient
       * pré-pris jusqu'au 05/10 — par personne.
       *
       * L'agent produit donc UNIQUEMENT des propositions (« réservations fantômes ») : visibles sur
       * le calendrier, jamais bloquantes, validées d'un clic. C'est ce que le propriétaire appelait
       * déjà du « pré-remplissage » — le mot et la chose sont enfin d'accord.
       *
       * ⚠️ Le réglage `autonomy` et sa colonne RESTENT en base : le remettre à `auto_high_confidence`
       * ne suffit plus à réserver, et c'est voulu. Rebrancher l'automatisme, si la calibration
       * s'améliore un jour, se fait en redonnant une valeur à cette constante — un seul endroit.
       */
      const AUTONOMIE_FERME_AUTORISEE = false;
      const autoOn =
        AUTONOMIE_FERME_AUTORISEE && enabled && (settings?.autonomy ?? 'suggest') === 'auto_high_confidence';
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
      let skipped =
        detection.skippedDormantVehicles +
        detection.skippedOutOfServiceVehicles +
        detection.skippedStalePatterns;
      // Propositions créées CE passage, par rang de motif : c'est ce que le jugement de l'IA
      // pourra écarter ou commenter après coup. Une occurrence déjà proposée une nuit précédente
      // n'y entre pas — elle a eu (ou aura eu) son verdict la nuit où elle est née.
      const idsParMotif = new Map<number, string[]>();

      /**
       * Relecture du 29/09 (piste 3) — PAS DE CHEVAUCHEMENT POUR UN MÊME VÉHICULE. L'unicité (société ×
       * véhicule × DÉBUT) ne suffisait pas : l'heure d'un motif est une MOYENNE sur les semaines
       * d'apprentissage, elle dérive d'une nuit à l'autre (08:12 → 08:10) — une proposition écartée
       * (« une journée tombe ») revenait le lendemain deux minutes plus tôt, et une proposition en
       * attente se doublait. Et deux motifs du même véhicule (deux destinations le même jour de la
       * semaine) se superposaient : chez cdef31 le 29/09, 181 des 307 propositions en attente en
       * chevauchaient une autre du même véhicule (19 véhicules, jusqu'à 5 le même jour) — un
       * véhicule ne fait qu'un trajet à la fois, « Tout réserver » en aurait refusé la plupart.
       * Désormais une occurrence n'est pas créée si elle chevauche une proposition CONNUE du même
       * véhicule, quel que soit son statut (en attente, écartée, réservée), ni une proposition créée
       * plus tôt dans CE passage ; les motifs arrivent triés par confiance, le plus sûr passe d'abord.
       * Les propositions déjà en base ne sont pas touchées.
       */
      const occupees = new Map<string, Array<{ debut: number; fin: number }>>();
      const occuper = (vehicleId: string, debut: number, fin: number): void => {
        const l = occupees.get(vehicleId);
        if (l) l.push({ debut, fin });
        else occupees.set(vehicleId, [{ debut, fin }]);
      };
      const connues = await this.prisma.agendaAgentProposal.findMany({
        where: { fleetId, startAt: { lt: new Date(horizonEnd) }, endAt: { gt: new Date(now) } },
        select: { vehicleId: true, startAt: true, endAt: true },
      });
      for (const c of connues ?? []) occuper(c.vehicleId, c.startAt.getTime(), c.endAt.getTime());
      const chevaucheUneConnue = (vehicleId: string, debut: number, fin: number): boolean =>
        (occupees.get(vehicleId) ?? []).some((o) => o.debut < fin && o.fin > debut);

      for (let pi = 0; pi < patterns.length; pi++) {
        const p = patterns[pi];
        // Phrase MÉCANIQUE, toujours : le « pourquoi » vulgarisé de l'IA la remplacera quand le
        // verdict sera consommé (design/C3 point 7) — la proposition est visible et réservable
        // dès maintenant, comme en mode dégradé.
        const reasoning = this.reasoning(p);
        for (const dateKey of this.occurrences(p.dayOfWeek, now, horizonEnd, fmt)) {
          const start = localWallToUtc(dateKey, p.startMinutes);
          const end = localWallToUtc(dateKey, p.endMinutes);
          if (end.getTime() <= start.getTime()) continue;
          /*
           * Imminent ou déjà passé : trop tard pour le PROPOSER — mais le créneau reste celui du motif
           * le plus sûr (relecture du 05/10). Sans `occuper` ici, un motif moins sûr du même véhicule
           * s'y glissait : un lundi à 08:30, « Carcassonne 09:00–12:00 » (90 %) n'est plus proposable,
           * et « Narbonne 10:00–11:00 » (60 %) passait à sa place — alors que le véhicule part, selon
           * toute vraisemblance, à Carcassonne. C'est la règle plus haut (« le plus sûr passe
           * d'abord ») qui se perdait dès que le plus sûr n'était plus proposable.
           */
          if (start.getTime() <= now + LEAD_MS) {
            occuper(p.vehicleId, start.getTime(), end.getTime());
            continue;
          }

          // Chevauche une proposition connue du même véhicule (voir plus haut) : déjà traitée ou déjà là.
          if (chevaucheUneConnue(p.vehicleId, start.getTime(), end.getTime())) {
            skipped++;
            continue;
          }

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
          // Créée ici (ou par la course d'à côté) : un motif moins sûr du même véhicule ne s'y superpose pas.
          occuper(p.vehicleId, start.getTime(), end.getTime());
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
      this.track(fleetId, origin, { created, proposed, skipped }, detection, aiVerdictQueued, triggeredByUserId);
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
    // D0 — AVANT l'expiration : une proposition prise sans réservation et rendue à `pending` doit
    // pouvoir expirer dans le même passage si son créneau est déjà passé.
    try {
      const { liees, rendues } = await this.rattraperPropositionsPrises();
      if (liees + rendues > 0) {
        this.logger.warn(`${liees} proposition(s) prise(s) rattachée(s) à leur réservation, ${rendues} rendue(s) à « en attente »`);
      }
    } catch (e) {
      this.logger.error(`rattraperPropositionsPrises : ${(e as Error)?.message ?? e}`);
      void this.errorLogger
        ?.record(e as Error, 'AGENDA_AGENT', { phase: 'rattraperPropositionsPrises' })
        .catch(() => {});
    }
    try {
      const n = await this.expirerPropositions();
      if (n > 0) this.logger.log(`${n} proposition(s) d'agenda périmée(s) passée(s) en expired`);
    } catch (e) {
      this.logger.error(`expirerPropositions : ${(e as Error)?.message ?? e}`);
      void this.errorLogger
        ?.record(e as Error, 'AGENDA_AGENT', { phase: 'expirerPropositions' })
        .catch(() => {});
    }
    // P2-5 — même isolement : une purge qui échoue ne retient ni la consommation ni les flottes.
    try {
      const n = await this.purgerPropositions();
      if (n > 0) this.logger.log(`${n} proposition(s) close(s) depuis plus d'un trimestre effacée(s)`);
    } catch (e) {
      this.logger.error(`purgerPropositions : ${(e as Error)?.message ?? e}`);
      void this.errorLogger
        ?.record(e as Error, 'AGENDA_AGENT', { phase: 'purgerPropositions' })
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
    // 30/09 (point 2 du propriétaire) — le périmètre VÉHICULE, comme les réservations et les évènements
    // (`scopedWhere`) : un gestionnaire limité à un groupe voyait les propositions de TOUT le parc.
    const acces = await this.events.vehiculesAccessibles(user);
    if (acces !== 'ALL' && acces.length === 0) return [];
    const rows = (await this.prisma.agendaAgentProposal.findMany({
      where: {
        fleetId: id,
        ...(acces !== 'ALL' ? { vehicleId: { in: acces } } : {}),
        ...(status ? { status } : {}),
        // Une suggestion dont le départ est passé n'est plus réservable : elle sort de la liste
        // sans attendre que le cron horaire l'acte `expired` (design/C3 point 7 — le 05/09, les
        // 200 lignes affichées étaient toutes périmées). Les autres statuts restent historiques.
        ...(status === 'pending' ? { startAt: { gte: new Date() } } : {}),
      },
      orderBy: { startAt: 'asc' },
      take: PROPOSITIONS_LISTE_MAX,
    })) as ProposalRow[];
    if (rows.length === PROPOSITIONS_LISTE_MAX) {
      this.logger.warn(
        `Propositions tronquées à ${PROPOSITIONS_LISTE_MAX} pour la société ${id} (statut ${status}) : ` +
          'la grille et le badge ne montrent pas les plus lointaines.',
      );
    }
    const vids = [...new Set(rows.map((r) => r.vehicleId))];
    const vehicles = vids.length
      ? await this.prisma.vehicle.findMany({ where: { id: { in: vids } }, select: { id: true, plate: true, fleetId: true } })
      : [];
    const vehicule = new Map(vehicles.map((v) => [v.id, v]));
    // Relecture du 30/09 — un véhicule SUPPRIMÉ (les propositions n'ont pas de clé étrangère) ou passé
    // dans une autre société : sa proposition ne se réserve plus, et ne s'écarte plus depuis que
    // `dismiss` vérifie le véhicule. Elle sort de la liste (grille, badge, Assistant IA) et expire seule.
    return rows
      .filter((r) => vehicule.get(r.vehicleId)?.fleetId === r.fleetId)
      .map((r) => this.toDto(r, vehicule.get(r.vehicleId)?.plate ?? null));
  }

  /**
   * Valide une SUGGESTION -> crée la réservation ferme. Perm reservations_manage (controller).
   *
   * Revue du 29/09 — la proposition est PRISE avant de réserver (`pending` → `applied` sous
   * condition). Avant, deux onglets passaient tous deux le contrôle « pending » : « Réserver » d'un
   * côté et « Écarter » de l'autre laissaient une réservation ferme sous une proposition marquée
   * écartée (et « Tout réserver » lancé deux fois ne devait son salut qu'à la contrainte
   * d'exclusion). Un seul gagne ; l'autre reçoit « déjà traitée ». Si la réservation échoue, la
   * proposition est RENDUE (retour à `pending`) : elle reste réservable.
   *
   * ── D0 (4e revue du 29/09) : ET SI LE PROCESSUS MEURT ENTRE LA PRISE ET LA RÉSERVATION ? ─────
   * La proposition resterait `applied` sans `createdEventId` : ni réservable (elle n'est plus
   * `pending`), ni réservée. Une transaction unique (prise + réservation + lien) serait la
   * réponse directe, mais `ReservationsService.systemConfirm` écrit par son propre client Prisma
   * et rattrape le conflit d'EXCLUDE par un `catch` — dans une transaction interactive, ce conflit
   * AVORTERAIT la transaction au lieu de rendre `null`. On ne change pas ce contrat ici : le cron
   * horaire RATTRAPE (`rattraperPropositionsPrises`) toute proposition prise depuis plus de 10 min
   * sans lien — rattachée à la réservation qu'ELLE a posée (`metadata.propositionId`, ou agent +
   * même véhicule + même créneau exact) si elle existe, rendue à `pending` sinon. L'état orphelin
   * dure donc au plus une heure et ne se fige jamais.
   */
  async apply(user: AuthUser, id: string): Promise<AgendaAgentProposalDto> {
    const p = (await this.prisma.agendaAgentProposal.findUnique({ where: { id } })) as ProposalRow | null;
    if (!p) throw new NotFoundException('Proposition introuvable');
    this.assertScope(user, p.fleetId);
    const societeDuVehicule = await this.events.assertVehicleAccess(user, p.vehicleId); // 403/404 périmètre véhicule
    // Relecture du 30/09 — un véhicule passé dans une autre société : `systemConfirm` aurait posé une
    // réservation de l'ANCIENNE société sur un véhicule de la nouvelle (un super-admin passe
    // `assertVehicleAccess` sans comparaison de société).
    if (societeDuVehicule !== p.fleetId) {
      throw new BadRequestException('Ce véhicule n’est plus dans la société de la proposition : elle ne peut plus être réservée.');
    }
    await this.exigerGestionDuVehicule(user, p.vehicleId, 'réserver');
    if (p.status !== 'pending') throw new BadRequestException('Proposition déjà traitée.');

    const prise = await this.prisma.agendaAgentProposal.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'applied' },
    });
    if (prise.count === 0) throw new BadRequestException('Proposition déjà traitée.');
    const rendre = () =>
      this.prisma.agendaAgentProposal
        .updateMany({ where: { id, status: 'applied', createdEventId: null }, data: { status: 'pending' } })
        .catch((e: unknown) => this.logger.error(`apply ${id} : proposition non rendue : ${(e as Error)?.message ?? e}`));

    let resa: Awaited<ReturnType<ReservationsService['systemConfirm']>>;
    try {
      resa = await this.reservations.systemConfirm({
        fleetId: p.fleetId,
        vehicleId: p.vehicleId,
        start: p.startAt,
        end: p.endAt,
        title: this.title(p),
        createdBy: user.id,
        // `propositionId` : l'identité de la proposition SUR la réservation — c'est par elle que le
        // rattrapage D0 retrouve « sa » réservation, même déplacée ou réaffectée entre-temps.
        metadata: {
          agent: true, propositionId: id, appliedBy: user.id,
          destinationLabel: p.destinationLabel, confidence: p.confidence, basis: p.basis,
        },
      });
    } catch (e) {
      await rendre();
      throw e;
    }
    if (!resa) {
      await rendre();
      throw new ConflictException('Le créneau est déjà occupé.');
    }
    const updated = (await this.prisma.agendaAgentProposal.update({
      where: { id },
      data: { status: 'applied', createdEventId: resa.id },
    })) as ProposalRow;
    // Écrit APRÈS le lien : une ligne « réservée » ne doit jamais précéder la réservation. Si le
    // processus meurt avant, c'est le rattrapage horaire qui l'écrit (D0).
    this.journaliser(() => ({
      category: 'RESERVATION',
      action: 'proposition_reservee',
      target: resa.vehiclePlate ?? null,
      detail: `Proposition de l'agent réservée — ${creneauParis(p.startAt, p.endAt)}${p.destinationLabel ? ` · ${p.destinationLabel}` : ''}`,
      fleetId: p.fleetId,
      triggeredByUserId: user.id,
      meta: { propositionId: id, reservationId: resa.id, vehicleId: p.vehicleId, confidence: p.confidence },
    }));
    return this.toDto(updated, resa.vehiclePlate ?? null);
  }

  /**
   * Rejette une SUGGESTION. Perm reservations_manage (controller).
   *
   * Revue du 29/09 — écrite SOUS CONDITION : jamais sur une proposition devenue réservation entre
   * la lecture et l'écriture (voir {@link apply}).
   *
   * Revue du 29/09 (C3) — IDEMPOTENTE, et seule la vraie transition `pending` → `dismissed` est
   * journalisée. L'écran ne se rafraîchit pas depuis le serveur : une proposition déjà écartée
   * (verdict de l'IA de 06:30 / 14:30, ménage après une réservation, un collègue dans un autre
   * onglet) ou expirée par le cron horaire y reste affichée. « Écarter » l'écrivait à nouveau
   * (`notIn applied/auto_applied`) : une seconde ligne « Proposition de l'agent écartée » au nom de
   * celui qui cliquait en dernier, et une `expired` repassait `dismissed`. Désormais :
   *   — déjà `dismissed` / `expired` : ce que l'utilisateur demande est acquis → réponse 200 avec
   *     le statut RÉEL, rien d'écrit, aucune ligne (un « Tout écarter » sur une liste périmée ne
   *     compte plus de faux « refusée(s) ») ;
   *   — `applied` / `auto_applied` : 400, une réservation s'annule depuis l'agenda ;
   *   — `pending` : écriture sous `status: 'pending'` ; perdue (count 0) → on relit pour dire la
   *     VRAIE raison, au lieu d'annoncer « réservation » à tort.
   */
  async dismiss(user: AuthUser, id: string): Promise<AgendaAgentProposalDto> {
    const p = (await this.prisma.agendaAgentProposal.findUnique({ where: { id } })) as ProposalRow | null;
    if (!p) throw new NotFoundException('Proposition introuvable');
    this.assertScope(user, p.fleetId);
    // 30/09 (point 2) — même périmètre et même droit que « Réserver » : avant, `dismiss` ne regardait
    // que la société, et un gestionnaire limité écartait une à une ce que Réorganiser lui refusait.
    await this.events.assertVehicleAccess(user, p.vehicleId);
    await this.exigerGestionDuVehicule(user, p.vehicleId, 'écarter');
    const dejaReservee = 'Une réservation déjà créée s\'annule depuis l\'agenda.';
    const reservee = (s: string): boolean => s === 'auto_applied' || s === 'applied';
    if (reservee(p.status)) throw new BadRequestException(dejaReservee);
    if (p.status !== 'pending') return this.toDto(p, null);
    const ecrit = await this.prisma.agendaAgentProposal.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'dismissed' },
    });
    if (ecrit.count === 0) {
      const maintenant = (await this.prisma.agendaAgentProposal.findUnique({
        where: { id },
        select: { status: true },
      })) as { status: string } | null;
      if (!maintenant) throw new NotFoundException('Proposition introuvable');
      if (reservee(maintenant.status)) throw new BadRequestException(dejaReservee);
      // Écartée ou expirée entre la lecture et l'écriture : acquis, sans ligne.
      if (maintenant.status !== 'pending') return this.toDto({ ...p, status: maintenant.status }, null);
      // Prise par « Réserver » puis RENDUE (créneau occupé) pendant notre écriture : rien n'est
      // tranché, l'utilisateur recommence.
      throw new ConflictException('La proposition vient d\'être traitée ailleurs ; réessayez.');
    }
    const plaque = await this.plaque(p.vehicleId);
    this.journaliser(() => ({
      category: 'AGENDA',
      action: 'proposition_ecartee',
      target: plaque,
      detail: `Proposition de l'agent écartée — ${creneauParis(p.startAt, p.endAt)}${p.destinationLabel ? ` · ${p.destinationLabel}` : ''}`,
      fleetId: p.fleetId,
      triggeredByUserId: user.id,
      // Plus de `statutAvant` : seule une transition depuis `pending` est journalisée.
      meta: { propositionId: id, vehicleId: p.vehicleId },
    }));
    return this.toDto({ ...p, status: 'dismissed' }, null);
  }

  /**
   * ── ÉCARTER UN LOT DE PROPOSITIONS (29/09, piste 3 du propriétaire) ─────────────────────────
   *
   * Réorganiser ne prenait que des réservations ; l'agenda de cdef31 porte des PROPOSITIONS (307 le
   * 29/09, aucune réservation à venir). Un véhicule part au garage, une journée tombe : ses
   * propositions doivent partir aussi — l'Assistant IA les écarte une à une ou par motif, jamais
   * par période ni par véhicule.
   *
   * Les garde-fous de Réorganiser, appliqués aux propositions :
   *  1. SIMULATION par défaut : on montre le lot (nombre, aperçu, véhicules) avant d'écrire.
   *  2. À VENIR seulement : une proposition dont le départ est passé ne se réserve plus (le cron
   *     horaire l'expire, la liste ne la montre plus) — le lot ne la prend pas. Une proposition est
   *     prise si elle CHEVAUCHE la fenêtre : une immobilisation qui commence jeudi 10:00 emporte le
   *     trajet de 08:00 à 12:00.
   *  3. LE LOT APPLIQUÉ EST CELUI QU'ON A VU : à l'application, `ids` est OBLIGATOIRE (les `lotIds` de
   *     la simulation) ; le lot est recalculé avec les mêmes filtres, puis restreint à `ids`. Une
   *     proposition arrivée depuis (un passage de l'agent) n'est jamais écartée sans avoir été montrée.
   *  4. ÉCRITURE SOUS CONDITION (`status: 'pending'`) : une proposition réservée ou écartée ailleurs
   *     entre-temps n'est pas touchée. Après l'écriture, le statut RÉEL de chaque proposition montrée
   *     est relu : `dejaTraitees` (réservée, écartée ailleurs, expirée) et `restees` (toujours en
   *     attente — commencée entre-temps, ou sortie du périmètre) ne se confondent plus.
   *  5. PÉRIMÈTRE : la société de l'appelant (celle du bandeau pour un super-admin), et les seuls
   *     véhicules dont il GÈRE les réservations (`vehiculesGeres`, la règle des réservations :
   *     réserver une proposition la demande aussi). Les autres sont comptées à part (`horsGestion`,
   *     borné au véhicule choisi). Un véhicule choisi qu'il ne gère pas : en simulation, un lot vide
   *     qui le DIT (`vehiculeNonGere`) — la feuille simule en arrière-plan dès qu'on choisit un
   *     véhicule, un 403 y levait un toast rouge ; à l'écriture, 403.
   *  6. PLAFOND de {@link MAX_LOT_PROPOSITIONS} : au-delà, on tronque et on le DIT (`plafonne`).
   *
   * Journal : UNE ligne par lot (`propositions_ecartees`), pas une par proposition — 307 lignes
   * « Proposition de l'agent écartée » noieraient l'activité de la société. Un lot sans effet (tout
   * était déjà traité) n'écrit rien. Aucun courriel : une proposition n'en a jamais envoyé.
   * Définitif : l'agent ne repropose pas un trajet déjà traité — ni le même créneau (unicité société
   * × véhicule × début), ni un créneau qui le CHEVAUCHE (relecture du 29/09 : l'heure d'un motif
   * est une moyenne qui dérive d'une nuit à l'autre — voir `runForFleet`).
   */
  async ecarterEnLot(user: AuthUser, dto: EcarterPropositionsDto): Promise<EcartPropositionsResultDto> {
    const simulation = dto?.simulation !== false;
    // Relecture du 29/09 : un identifiant mal formé part en 400, pas en 500 (Prisma sur une colonne UUID).
    const vehicleId = typeof dto?.vehicleId === 'string' && dto.vehicleId.trim() ? dto.vehicleId.trim() : null;
    if (vehicleId && !UUID_RE.test(vehicleId)) throw new BadRequestException('Véhicule invalide.');
    // La société du bandeau pour un super-admin ; la SIENNE pour les autres rôles, `fleetId` ignoré
    // (`resolveFleetId`) : un filtre resté d'une session super-admin ne fait pas échouer leur geste.
    // Validée (UUID) pour un super-admin seulement : celle d'un autre rôle n'est même pas lue.
    const fleetIdDemande = user.role === UserRole.SUPER_ADMIN ? dto?.fleetId : undefined;
    if (fleetIdDemande && !UUID_RE.test(fleetIdDemande)) throw new BadRequestException('Société invalide.');
    const fleetId = this.resolveFleetId(user, fleetIdDemande);
    const from = new Date(dto?.from ?? '');
    const to = new Date(dto?.to ?? '');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to.getTime() <= from.getTime()) {
      throw new BadRequestException('Fenêtre invalide.');
    }
    const maintenant = Date.now();
    // Jamais le passé : une proposition commencée ne se réserve plus, l'écarter ne change rien.
    const debut = new Date(Math.max(from.getTime(), maintenant));
    if (debut.getTime() >= to.getTime()) {
      throw new BadRequestException('La fenêtre est entièrement passée : rien à écarter.');
    }
    let listeBlanche: Set<string> | null = null;
    if (dto?.ids !== undefined && dto?.ids !== null) {
      const ids: unknown = dto.ids;
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_LOT_PROPOSITIONS ||
        ids.some((x) => typeof x !== 'string' || !UUID_RE.test(x.trim()))
      ) {
        throw new BadRequestException('« ids » invalide : une liste d’identifiants de propositions est attendue.');
      }
      listeBlanche = new Set((ids as string[]).map((x) => x.trim()));
    }
    // Garde 3 : jamais « sans liste = tout » à l'écriture — on n'écarte que ce qui a été montré.
    if (!simulation && (!listeBlanche || listeBlanche.size === 0)) {
      throw new BadRequestException('« ids » est obligatoire pour écarter : renvoyez le lot de la simulation.');
    }

    let vehiculeNonGere = false;
    if (vehicleId) {
      const societeDuVehicule = await this.events.assertVehicleAccess(user, vehicleId); // 404 / 403 hors périmètre
      if (societeDuVehicule !== fleetId) {
        throw new BadRequestException('Ce véhicule n’est pas de la société choisie.');
      }
      if (!(await this.reservations.gereLesReservationsDe(user, vehicleId))) {
        if (!simulation) {
          const plaque = await this.plaque(vehicleId);
          throw new ForbiddenException(
            `Vous ne gérez pas les réservations de ${plaque ?? 'ce véhicule'} : vous ne pouvez pas écarter ses propositions.`,
          );
        }
        // Simulation : le lot sera vide (le véhicule n'est pas géré), et la réponse dit pourquoi.
        vehiculeNonGere = true;
      }
    }

    // Garde 2 : encore à venir (réservable) ET qui chevauche la fenêtre. Dans le périmètre VÉHICULE de
    // l'appelant (30/09, point 2) : `horsGestion` ne compte plus des véhicules qu'il ne voit même pas.
    const acces = await this.events.vehiculesAccessibles(user);
    const lignes =
      acces !== 'ALL' && acces.length === 0
        ? []
        : await this.prisma.agendaAgentProposal.findMany({
            where: {
              fleetId,
              ...(acces !== 'ALL' ? { vehicleId: { in: acces } } : {}),
              status: 'pending',
              startAt: { gte: new Date(maintenant), lt: to },
              endAt: { gt: debut },
            },
            orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
            select: { id: true, vehicleId: true, startAt: true, endAt: true, destinationLabel: true },
          });

    // Garde 5 : seuls les véhicules dont l'appelant gère les réservations — la règle par véhicule, en
    // une requête pour tout le lot (relecture du 29/09 : une par véhicule, à chaque simulation).
    const vehicules = [...new Set(lignes.map((l) => l.vehicleId))];
    const geres = await this.reservations.vehiculesGeres(user, vehicules);
    const gerees = lignes.filter((l) => geres.has(l.vehicleId));
    // Hors gestion, dans le périmètre DEMANDÉ : le véhicule choisi, sinon tout le parc.
    const horsGestion = lignes.filter((l) => !geres.has(l.vehicleId) && (!vehicleId || l.vehicleId === vehicleId)).length;
    const plaques = new Map(
      vehicules.length
        ? (await this.prisma.vehicle.findMany({ where: { id: { in: vehicules } }, select: { id: true, plate: true } })).map(
            (v) => [v.id, v.plate] as const,
          )
        : [],
    );
    const plaqueDe = (id: string): string | null => plaques.get(id) ?? null;

    // Par véhicule géré, AVANT le filtre véhicule : la liste où l'on choisit celui qui part au garage.
    const compterParVehicule = (liste: typeof gerees) => {
      const m = new Map<string, number>();
      for (const l of liste) m.set(l.vehicleId, (m.get(l.vehicleId) ?? 0) + 1);
      return [...m]
        .map(([id, n]) => ({ vehicleId: id, plate: plaqueDe(id), n }))
        .sort((a, b) => (a.plate ?? '').localeCompare(b.plate ?? '', 'fr', { numeric: true }));
    };

    const candidates = gerees.filter(
      (l) => (!vehicleId || l.vehicleId === vehicleId) && (!listeBlanche || listeBlanche.has(l.id)),
    );
    const plafonne = candidates.length > MAX_LOT_PROPOSITIONS;
    const lot = candidates.slice(0, MAX_LOT_PROPOSITIONS);
    const lotIds = lot.map((l) => l.id);
    const apercu = lot.slice(0, 8).map((l) => ({
      id: l.id,
      vehicleId: l.vehicleId,
      plate: plaqueDe(l.vehicleId),
      startAt: l.startAt.toISOString(),
      endAt: l.endAt.toISOString(),
      destinationLabel: l.destinationLabel,
    }));
    const commun = { concernees: lot.length, apercu, horsGestion, plafonne, lotIds };
    if (simulation) {
      return {
        simulation: true, ecartees: 0, dejaTraitees: 0, restees: 0, parVehicule: compterParVehicule(gerees), ...commun,
        ...(vehiculeNonGere ? { vehiculeNonGere } : {}),
      };
    }

    // Garde 4 : sous condition — une proposition réservée (prise par `apply`) ou écartée ailleurs
    // entre la lecture et l'écriture n'est pas touchée.
    const ecartees =
      lot.length > 0
        ? (
            await this.prisma.agendaAgentProposal.updateMany({
              where: { id: { in: lotIds }, fleetId, status: 'pending' },
              data: { status: 'dismissed' },
            })
          ).count
        : 0;
    const { dejaTraitees, restees } = await this.bilanDesMontrees([...(listeBlanche ?? [])], fleetId, ecartees);

    if (ecartees > 0) {
      const plaquesDuLot = [...new Set(lot.map((l) => plaqueDe(l.vehicleId)).filter((p): p is string => !!p))];
      // « tous les véhicules » ne se dit que si l'auteur VOYAIT tout le parc et le gérait en entier.
      // Relecture du 30/09 : `horsGestion` ne compte plus que les véhicules visibles — pour un
      // gestionnaire limité à un groupe il valait 0, et le fil de la société annonçait « tous ».
      const toutLeParc = acces === 'ALL' && horsGestion === 0;
      const qui = vehicleId
        ? (plaqueDe(vehicleId) ?? 'un véhicule')
        : toutLeParc ? 'tous les véhicules' : "les véhicules dont l'auteur gère les réservations";
      const s = ecartees > 1 ? 's' : '';
      const d = dejaTraitees > 1 ? 's' : '';
      const r = restees > 1 ? 's' : '';
      const suites = [
        dejaTraitees > 0 ? `${dejaTraitees} déjà traitée${d} entre-temps, laissée${d} telle${d} quelle${d}` : '',
        restees > 0 ? `${restees} restée${r} en attente` : '',
      ].filter(Boolean);
      this.journaliser(() => ({
        category: 'AGENDA',
        action: 'propositions_ecartees',
        target: vehicleId ? plaqueDe(vehicleId) : plaquesDuLot.length === 1 ? plaquesDuLot[0] : null,
        detail:
          `${ecartees} proposition${s} de l'agent écartée${s} en lot — ${qui}, ${creneauParis(debut, to)}` +
          (suites.length ? ` (${suites.join(' ; ')})` : '') +
          '.',
        fleetId,
        triggeredByUserId: user.id,
        meta: {
          lot: randomUUID(),
          vehicleId,
          from: debut.toISOString(),
          to: to.toISOString(),
          concernees: lot.length,
          ecartees,
          dejaTraitees,
          restees,
          horsGestion,
          plaques: plaquesDuLot,
          ids: lotIds,
        },
      }));
    }
    // Après l'écriture, la liste « Véhicule » compte ce qui RESTE en attente : chaque proposition du
    // lot est écartée, ou n'était déjà plus en attente (réservée, écartée ailleurs, commencée). Sinon
    // « Tous les véhicules (307) » resterait affiché sous « 307 propositions écartées ».
    const dansLeLot = new Set(lotIds);
    const parVehicule = compterParVehicule(gerees.filter((l) => !dansLeLot.has(l.id)));
    return { simulation: false, ecartees, dejaTraitees, restees, parVehicule, ...commun };
  }

  /**
   * Relecture du 29/09 — ce que sont devenues les propositions MONTRÉES qui ne l'ont pas été par CE
   * geste : le compte « montrées − écartées » appelait « déjà traitée » une proposition prise par
   * « Réserver » puis RENDUE (de nouveau en attente), ou une proposition commencée entre-temps. On relit
   * leur statut réel (dans la société, jamais au-delà) :
   *  - `dejaTraitees` : écartées AILLEURS (le total écarté moins ce geste), réservées, expirées ;
   *  - `restees` : toujours en attente — commencées entre-temps, ou sorties du périmètre.
   * Un identifiant d'une autre société (appel forgé) n'est compté nulle part. Si la relecture échoue,
   * l'écriture a eu lieu : on retombe sur « montrées − écartées », comme avant.
   */
  private async bilanDesMontrees(
    montrees: string[],
    fleetId: string,
    ecartees: number,
    geste: 'ecarterEnLot' | 'nettoyerChevauchements' = 'ecarterEnLot',
  ): Promise<{ dejaTraitees: number; restees: number }> {
    if (montrees.length === 0) return { dejaTraitees: 0, restees: 0 };
    try {
      const etats = await this.prisma.agendaAgentProposal.findMany({
        where: { id: { in: montrees }, fleetId },
        select: { status: true },
      });
      let ecarteesEnTout = 0;
      let autres = 0;
      let restees = 0;
      for (const e of etats) {
        if (e.status === 'dismissed') ecarteesEnTout++;
        else if (e.status === 'pending') restees++;
        else autres++; // applied, auto_applied, expired
      }
      return { dejaTraitees: Math.max(0, ecarteesEnTout - ecartees) + autres, restees };
    } catch (e) {
      this.logger.warn(`${geste} : statuts non relus (${(e as Error)?.message ?? e}) — compte approché.`);
      return { dejaTraitees: Math.max(0, montrees.length - ecartees), restees: 0 };
    }
  }

  /**
   * ── NETTOYER LES PROPOSITIONS QUI SE CHEVAUCHENT (30/09, sur demande du propriétaire) ──────────
   *
   * Avant la relecture du 29/09, l'agent créait des propositions qui se chevauchaient pour un même
   * véhicule : l'heure d'un motif est une moyenne qui dérive d'une nuit à l'autre, et deux motifs du
   * même véhicule tombaient le même jour. Chez cdef31, 181 des 307 propositions en attente étaient
   * prises dans un chevauchement — un véhicule ne fait qu'un trajet à la fois. `runForFleet` n'en crée
   * plus ; ce geste range celles qui existent : dans chaque groupe, la plus sûre RESTE
   * (`propositionsEnChevauchement`), les autres sont ÉCARTÉES.
   *
   * Les garde-fous de Réorganiser : simulation par défaut ; à l'écriture, `ids` OBLIGATOIRE (le lot
   * montré), recalculé puis restreint à `ids`, écrit sous condition `pending` ; bilan relu
   * (`bilanDesMontrees`) ; UNE ligne de journal pour la société. Super-admin seulement : c'est un geste
   * de maintenance, pas un geste d'exploitation.
   */
  async nettoyerChevauchements(user: AuthUser, dto: NettoyerChevauchementsDto): Promise<NettoyageChevauchementsResultDto> {
    if (user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Réservé aux super-administrateurs.');
    }
    const simulation = dto?.simulation !== false;
    const fleetIdDemande = typeof dto?.fleetId === 'string' ? dto.fleetId.trim() : undefined;
    if (fleetIdDemande && !UUID_RE.test(fleetIdDemande)) throw new BadRequestException('Société invalide.');
    const fleetId = this.resolveFleetId(user, fleetIdDemande || undefined);
    let listeBlanche: Set<string> | null = null;
    if (dto?.ids !== undefined && dto?.ids !== null) {
      const ids: unknown = dto.ids;
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_NETTOYAGE_CHEVAUCHEMENTS ||
        ids.some((x) => typeof x !== 'string' || !UUID_RE.test(x.trim()))
      ) {
        throw new BadRequestException('« ids » invalide : une liste d’identifiants de propositions est attendue.');
      }
      listeBlanche = new Set((ids as string[]).map((x) => x.trim()));
    }
    if (!simulation && (!listeBlanche || listeBlanche.size === 0)) {
      throw new BadRequestException('« ids » est obligatoire pour écarter : renvoyez le lot de la simulation.');
    }

    // Toutes les propositions EN ATTENTE encore à venir : un chevauchement se juge sur tout ce qui reste.
    const maintenant = Date.now();
    const lignes = await this.prisma.agendaAgentProposal.findMany({
      where: { fleetId, status: 'pending', startAt: { gte: new Date(maintenant) } },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, vehicleId: true, startAt: true, endAt: true, confidence: true, createdAt: true, aiKeep: true,
        destinationLabel: true,
      },
    });
    // Et les créneaux déjà PRIS sur leurs véhicules (relecture du 30/09) — voir `creneauxPris`.
    const pris = await this.creneauxPris(lignes, maintenant);
    const aEcarter = new Set(propositionsEnChevauchement(lignes, pris));
    const candidates = lignes.filter((l) => aEcarter.has(l.id) && (!listeBlanche || listeBlanche.has(l.id)));
    const plafonne = candidates.length > MAX_NETTOYAGE_CHEVAUCHEMENTS;
    const lot = candidates.slice(0, MAX_NETTOYAGE_CHEVAUCHEMENTS);
    const lotIds = lot.map((l) => l.id);

    const vehicules = [...new Set(lot.map((l) => l.vehicleId))];
    const plaques = new Map(
      vehicules.length
        ? (await this.prisma.vehicle.findMany({ where: { id: { in: vehicules } }, select: { id: true, plate: true } })).map(
            (v) => [v.id, v.plate] as const,
          )
        : [],
    );
    const compte = new Map<string, number>();
    for (const l of lot) compte.set(l.vehicleId, (compte.get(l.vehicleId) ?? 0) + 1);
    const parVehicule = [...compte]
      .map(([id, n]) => ({ vehicleId: id, plate: plaques.get(id) ?? null, n }))
      .sort((a, b) => (a.plate ?? '').localeCompare(b.plate ?? '', 'fr', { numeric: true }));
    const apercu = lot.slice(0, 8).map((l) => ({
      id: l.id,
      vehicleId: l.vehicleId,
      plate: plaques.get(l.vehicleId) ?? null,
      startAt: l.startAt.toISOString(),
      endAt: l.endAt.toISOString(),
      destinationLabel: l.destinationLabel,
    }));
    // Dans le lot, celles qui chevauchent un créneau déjà pris (non réservables) ; les autres chevauchent
    // une proposition plus sûre du même véhicule.
    const sousUnBloquant = lot.filter((l) =>
      pris.some((c) => c.vehicleId === l.vehicleId && c.debutMs < l.endAt.getTime() && c.finMs > l.startAt.getTime()),
    ).length;
    const commun = { enAttente: lignes.length, concernees: lot.length, sousUnBloquant, parVehicule, apercu, plafonne, lotIds };
    if (simulation) return { simulation: true, ecartees: 0, dejaTraitees: 0, restees: 0, ...commun };

    const ecartees =
      lot.length > 0
        ? (
            await this.prisma.agendaAgentProposal.updateMany({
              where: { id: { in: lotIds }, fleetId, status: 'pending' },
              data: { status: 'dismissed' },
            })
          ).count
        : 0;
    const { dejaTraitees, restees } = await this.bilanDesMontrees(
      [...(listeBlanche ?? [])], fleetId, ecartees, 'nettoyerChevauchements',
    );
    if (ecartees > 0) {
      const s = ecartees > 1 ? 's' : '';
      const nbVehicules = new Set(lot.map((l) => l.vehicleId)).size;
      const restantes = Math.max(0, lignes.length - ecartees);
      const suite = `(${nbVehicules} véhicule${nbVehicules > 1 ? 's' : ''} ; ${restantes} ${restantes > 1 ? 'restent' : 'reste'} en attente).`;
      const chevauchai = (n: number): string => (n > 1 ? 'chevauchaient' : 'chevauchait');
      const doublons = lot.length - sousUnBloquant;
      // Le motif décrit le LOT : il n'est détaillé que si le lot est parti en entier — sinon une partie a
      // été traitée ailleurs entre-temps, et l'on ne sait pas laquelle.
      const pourquoi =
        ecartees !== lot.length
          ? `sur ${lot.length} montrée${lot.length > 1 ? 's' : ''}, les autres traitées ailleurs entre-temps `
          : sousUnBloquant === 0
            ? `elle${s} ${chevauchai(ecartees)} une proposition plus sûre du même véhicule `
            : doublons === 0
              ? `elle${s} ${chevauchai(ecartees)} une réservation ferme ou une immobilisation du véhicule `
              : `${doublons} ${chevauchai(doublons)} une proposition plus sûre du même véhicule, ` +
                `${sousUnBloquant} une réservation ferme ou une immobilisation `;
      this.journaliser(() => ({
        category: 'AGENDA',
        action: 'propositions_ecartees',
        target: nbVehicules === 1 ? (plaques.get(lot[0].vehicleId) ?? null) : null,
        detail: `${ecartees} proposition${s} de l'agent écartée${s} au nettoyage des doublons — ${pourquoi}${suite}`,
        fleetId,
        triggeredByUserId: user.id,
        meta: {
          lot: randomUUID(), nettoyage: 'chevauchements', enAttente: lignes.length, concernees: lot.length,
          sousUnBloquant, ecartees, dejaTraitees, restees, ids: lotIds,
        },
      }));
    }
    return { simulation: false, ecartees, dejaTraitees, restees, ...commun };
  }

  /**
   * D0 (4e revue du 29/09) — RATTRAPAGE des propositions prises sans réservation.
   *
   * `apply()` prend la proposition (`pending` → `applied`), réserve, puis note `createdEventId`.
   * Un processus tué entre les deux (déploiement, OOM, redémarrage du conteneur) laissait une
   * proposition `applied` sans lien : ni réservable, ni réservée, figée pour toujours. Toute ligne
   * dans cet état depuis plus de 10 minutes (`updatedAt`, posé par la prise) est :
   *
   *   — RATTACHÉE à la réservation que `apply` avait créée PAR ELLE avant de mourir ; la ligne
   *     « Proposition réservée » que `apply` n'a pas pu écrire l'est ici, au nom de la personne
   *     qui avait cliqué (`metadata.appliedBy` de la réservation) ;
   *   — RENDUE à `pending` sinon : elle redevient réservable, ou expire au passage suivant si son
   *     créneau est passé (le rattrapage tourne AVANT l'expiration).
   *
   * Relecture du 29/09 — « sa » réservation, pas « une » réservation. La première version prenait
   * n'importe quelle réservation ferme du véhicule qui COUVRAIT le créneau : une réservation posée
   * à la main par le gestionnaire (plus large) récupérait la proposition, et le fil du client
   * recevait « Proposition de l'agent réservée » sous l'auteur « Agent de l'agenda », en plus de la
   * vraie ligne. Et une réservation de l'agent ANNULÉE avant le passage rendait la proposition
   * réservable à nouveau. Désormais on ne rattache qu'une réservation de l'AGENT
   * (`metadata.agent`) : soit celle qui porte `metadata.propositionId` = cette proposition
   * (posé par `apply` depuis le 29/09, suit la réservation si elle est déplacée), soit — pour les
   * réservations d'avant ce marqueur — celle du même véhicule sur EXACTEMENT le même créneau
   * (l'unicité société × véhicule × début des propositions garantit qu'aucune autre proposition
   * n'a pu la poser). Tous statuts : annulée, elle reste le résultat de ce clic — la proposition
   * reste `applied` avec son lien, jamais re-proposée. Une réservation déjà liée à une AUTRE
   * proposition n'est jamais reprise.
   *
   * Chaque écriture est sous condition (`applied` ET `createdEventId` nul) : une application
   * tardive qui aboutit entre la lecture et l'écriture n'est jamais écrasée. Rend les compteurs.
   */
  async rattraperPropositionsPrises(now: Date = new Date()): Promise<{ liees: number; rendues: number }> {
    const orphelines = await this.prisma.agendaAgentProposal.findMany({
      where: { status: 'applied', createdEventId: null, updatedAt: { lt: new Date(now.getTime() - RATTRAPAGE_DELAI_MS) } },
      select: { id: true, fleetId: true, vehicleId: true, startAt: true, endAt: true, destinationLabel: true },
      orderBy: { updatedAt: 'asc' },
      take: RATTRAPAGE_LOT_MAX,
    });
    let liees = 0;
    let rendues = 0;
    for (const p of orphelines) {
      const resa = await this.reservationDeLaProposition(p);
      const orpheline = { id: p.id, status: 'applied', createdEventId: null };
      if (resa) {
        const { count } = await this.prisma.agendaAgentProposal.updateMany({
          where: orpheline,
          data: { createdEventId: resa.id },
        });
        if (count === 0) continue;
        liees++;
        const appliedBy = (resa.metadata as { appliedBy?: unknown } | null)?.appliedBy;
        const auteur = typeof appliedBy === 'string' && appliedBy ? appliedBy : null;
        this.journaliser(() => ({
          category: 'RESERVATION',
          action: 'proposition_reservee',
          actor: auteur ? 'utilisateur' : 'system',
          target: resa.vehicle?.plate ?? null,
          detail:
            `Proposition de l'agent réservée — ${creneauParis(p.startAt, p.endAt)}${p.destinationLabel ? ` · ${p.destinationLabel}` : ''}` +
            ` (lien rétabli après une interruption${resa.status === VehicleEventStatus.CANCELLED ? ' ; réservation annulée depuis' : ''})`,
          fleetId: p.fleetId,
          triggeredByUserId: auteur,
          meta: { propositionId: p.id, reservationId: resa.id, vehicleId: p.vehicleId, rattrapage: true, statutReservation: resa.status },
        }));
      } else {
        const { count } = await this.prisma.agendaAgentProposal.updateMany({
          where: orpheline,
          data: { status: 'pending' },
        });
        if (count > 0) rendues++;
      }
    }
    return { liees, rendues };
  }

  /**
   * La réservation posée PAR cette proposition (voir {@link rattraperPropositionsPrises}), ou `null`.
   * Jamais une réservation manuelle (`metadata.agent` exigé), jamais celle d'une autre proposition
   * (`metadata.propositionId` différent, ou déjà liée ailleurs par `createdEventId`).
   */
  private async reservationDeLaProposition(p: {
    id: string;
    fleetId: string;
    vehicleId: string;
    startAt: Date;
    endAt: Date;
  }): Promise<{ id: string; status: VehicleEventStatus; metadata: Prisma.JsonValue; vehicle: { plate: string } | null } | null> {
    const candidates = await this.prisma.vehicleEvent.findMany({
      where: {
        fleetId: p.fleetId,
        type: VehicleEventType.RESERVATION,
        // Tous statuts : une réservation annulée avant le passage reste le résultat de ce clic.
        OR: [
          { metadata: { path: ['propositionId'], equals: p.id } },
          { vehicleId: p.vehicleId, startAt: p.startAt, endAt: p.endAt, metadata: { path: ['agent'], equals: true } },
        ],
      },
      select: { id: true, status: true, metadata: true, vehicle: { select: { plate: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    for (const resa of candidates) {
      const meta = (resa.metadata ?? null) as { agent?: unknown; propositionId?: unknown } | null;
      if (meta?.agent !== true) continue;
      if (typeof meta.propositionId === 'string' && meta.propositionId !== p.id) continue;
      const dejaLiee = await this.prisma.agendaAgentProposal.findFirst({
        where: { createdEventId: resa.id, id: { not: p.id } },
        select: { id: true },
      });
      if (dejaLiee) continue;
      return resa;
    }
    return null;
  }

  /**
   * Relecture du 30/09 — les créneaux déjà PRIS des véhicules de ces propositions, sur leur horizon : la
   * règle de `isVehicleFree` / `findImmobilized` — réservation CONFIRMED / IN_PROGRESS, évènement
   * bloquant PLANNED / OPEN / IN_PROGRESS avec sa fin effective (`effectiveBlockingEndMs`). Pas le
   * statut des propositions : une réservation posée par l'agent a pu être annulée depuis. Les trajets
   * réels ne comptent pas : une proposition commence au plus tôt dans l'heure (`LEAD_MS`).
   */
  private async creneauxPris(lignes: readonly { vehicleId: string; endAt: Date }[], maintenant: number): Promise<CreneauPris[]> {
    if (lignes.length === 0) return [];
    const vehicules = [...new Set(lignes.map((l) => l.vehicleId))];
    const finMax = new Date(lignes.reduce((m, l) => Math.max(m, l.endAt.getTime()), 0));
    const evenements = await this.prisma.vehicleEvent.findMany({
      where: {
        vehicleId: { in: vehicules },
        startAt: { lt: finMax },
        OR: [
          { type: VehicleEventType.RESERVATION, status: { in: [VehicleEventStatus.CONFIRMED, VehicleEventStatus.IN_PROGRESS] } },
          { type: { not: VehicleEventType.RESERVATION }, blocksVehicle: true, status: { in: IMMOBILIZING_STATUSES } },
        ],
      },
      select: { vehicleId: true, type: true, startAt: true, endAt: true },
    });
    return evenements
      .map((e) => ({
        vehicleId: e.vehicleId,
        debutMs: e.startAt.getTime(),
        finMs: effectiveBlockingEndMs(e.type, e.startAt.getTime(), e.endAt ? e.endAt.getTime() : null),
      }))
      .filter((c) => c.finMs > maintenant);
  }

  /**
   * 30/09 (point 2 du propriétaire) — réserver ou écarter une proposition, c'est GÉRER les réservations
   * de SON véhicule : la règle des réservations (`gereLesReservationsDe`, le plus spécifique gagne).
   * Avant, `apply` ne vérifiait que l'accès au véhicule et `dismiss` que la société : un gestionnaire
   * qui ne peut que DEMANDER sur un groupe réservait (ferme) ou écartait les propositions de ce groupe.
   */
  private async exigerGestionDuVehicule(user: AuthUser, vehicleId: string, verbe: 'réserver' | 'écarter'): Promise<void> {
    if (await this.reservations.gereLesReservationsDe(user, vehicleId)) return;
    const plaque = await this.plaque(vehicleId);
    throw new ForbiddenException(
      `Vous ne gérez pas les réservations de ${plaque ?? 'ce véhicule'} : vous ne pouvez pas ${verbe} ses propositions.`,
    );
  }

  /** Plaque d'un véhicule pour le journal ; `null` si la lecture échoue (le geste passe quand même). */
  private async plaque(vehicleId: string): Promise<string | null> {
    try {
      const v = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { plate: true } });
      return v?.plate ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Une ligne du journal métier pour un geste sur une proposition. Construite DANS le `try` : une
   * donnée inattendue ne fait jamais échouer le geste tracé. `fleetId` = société de la PROPOSITION
   * (jamais celle de l'utilisateur) ; `actor` = « utilisateur » par défaut, jamais un nom.
   */
  private journaliser(construire: () => Omit<SystemActivityInput, 'actor'> & { actor?: string }): void {
    try {
      this.systemActivity?.record({ actor: 'utilisateur', ...construire() });
    } catch (e) {
      this.logger.warn(`journal des propositions non écrit : ${(e as Error)?.message ?? e}`);
    }
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

  /**
   * RÉTENTION (P2-5, audit du 22/09) : les propositions que plus personne ne lira.
   *
   * Le 22/09, cdef31 portait **2 049 `expired` et 172 `dismissed` jamais purgées** — ~30 lignes
   * par nuit et par société, sans conséquence fonctionnelle mais sans fin. Une `expired` est une
   * suggestion dont le créneau est passé sans qu'on l'ait prise : au bout d'un trimestre, elle
   * n'explique plus rien. Une `dismissed` porte la raison de l'IA ou d'un humain ; la même
   * fenêtre suffit à en tirer ce qu'on veut en tirer.
   *
   * Ne sont JAMAIS purgées : `pending` (vivante), `applied` / `auto_applied` (elles pointent une
   * réservation créée : c'est de l'historique d'exploitation, et la mesure du 23/09 — 57 % de
   * bons créneaux sur 321 — n'a été possible que parce qu'elles étaient là).
   *
   * Borné par lot, comme la rétention des notifications : un `DELETE` massif verrouillerait la
   * table sur un VPS à 2 vCPU. Le cron repasse chaque heure, le reliquat s'écoule en quelques
   * passages. Rend le nombre de lignes effacées.
   */
  async purgerPropositions(now: Date = new Date()): Promise<number> {
    const limite = new Date(now.getTime() - RETENTION_PROPOSITIONS_CLOSES_MS);
    const condamnees = await this.prisma.agendaAgentProposal.findMany({
      where: { status: { in: ['expired', 'dismissed'] }, endAt: { lt: limite } },
      select: { id: true },
      take: PURGE_LOT_MAX,
    });
    if (condamnees.length === 0) return 0;
    const { count } = await this.prisma.agendaAgentProposal.deleteMany({
      where: { id: { in: condamnees.map((c) => c.id) } },
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
   * super-admin sans société ciblée ne voit rien (il doit choisir), un non-super lit la sienne,
   * quel que soit le `fleetId` reçu (`resolveFleetId`).
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

  /**
   * ── LOT 3B — LE MÉNAGE APRÈS UNE VALIDATION QUI DÉPLACE (2026-09-23) ────────────────────────
   *
   * Quand une demande publique n'a trouvé de véhicule qu'en piochant dans ceux qu'une proposition
   * retenait sur ce créneau, la soumission l'a noté dans ses métadonnées (`deplaceePropositions`).
   * La validation tranche : la demande HUMAINE l'emporte, et la proposition n'a plus lieu d'être.
   *
   * Sans ce ménage, elle resterait affichée en pointillé sur un créneau désormais pris — et
   * reviendrait dans la file des propositions à valider, sur un véhicule qui n'est plus libre.
   *
   * Par ÉVÉNEMENT, et non par appel direct : `ReservationsService` n'a aucune raison de connaître
   * les propositions de l'agent, et l'inverse ferait un cycle (l'agent, lui, appelle déjà les
   * réservations). Best-effort intégral : un ménage raté ne doit jamais faire échouer une
   * validation déjà écrite en base.
   */
  @OnEvent('reservation.confirmed', { async: true })
  async menagerApresValidation(payload: { metadata?: Record<string, unknown> | null }): Promise<void> {
    const brut = payload?.metadata?.['deplaceePropositions'];
    if (!Array.isArray(brut) || brut.length === 0) return;
    const ids = brut
      .map((d) => (d as { proposalId?: unknown })?.proposalId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return;
    try {
      const { count } = await this.prisma.agendaAgentProposal.updateMany({
        // `status: 'pending'` dans le WHERE : si elle a déjà été validée ou écartée entre-temps,
        // on ne la retouche pas — on ne réécrit jamais une décision humaine déjà prise.
        where: { id: { in: ids }, status: 'pending' },
        data: { status: 'dismissed', reasoning: 'Écartée : une demande de réservation a pris ce créneau.' },
      });
      if (count > 0) this.logger.log(`${count} proposition(s) écartée(s) après validation d'une demande.`);
    } catch (e) {
      this.errorLogger?.recordBackground?.(
        e instanceof Error ? e : new Error(String(e)),
        'AGENDA_AGENT',
        { motif: 'menage-apres-validation', ids },
      );
    }
  }

  private track(
    fleetId: string,
    origin: string,
    counts: { created: number; proposed: number; skipped: number },
    excluded?: {
      skippedDormantVehicles: number;
      skippedOutOfServiceVehicles: number;
      skippedStalePatterns: number;
    },
    aiVerdictQueued = false,
    triggeredByUserId: string | null = null,
  ): void {
    // Le détail des exclusions n'apparaît que s'il y en a : un libellé propre les jours normaux,
    // et une explication le jour où l'exploitant se demande où sont passées ses propositions.
    const dormant = excluded?.skippedDormantVehicles ?? 0;
    const horsService = excluded?.skippedOutOfServiceVehicles ?? 0;
    const stale = excluded?.skippedStalePatterns ?? 0;
    // Trois motifs, trois phrases : « muet », « déclaré hors service » et « habitude éteinte »
    // appellent trois gestes différents. Les fondre dans un total unique ferait relire la fiche
    // d'un véhicule accidenté à qui cherchait un boîtier en panne.
    const motifs: string[] = [];
    if (dormant > 0) motifs.push(`${dormant} véhicule(s) au boîtier muet`);
    if (horsService > 0) motifs.push(`${horsService} véhicule(s) hors service`);
    if (stale > 0) motifs.push(`${stale} habitude(s) éteinte(s)`);
    const why = motifs.length > 0 ? ` (dont ${motifs.join(', ')})` : '';
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
      // Lancement manuel : la personne qui a cliqué. Nuit / déclencheur : null (système).
      triggeredByUserId: origin === 'manual' ? triggeredByUserId : null,
      meta: {
        ...counts,
        skippedDormantVehicles: dormant,
        skippedOutOfServiceVehicles: horsService,
        skippedStalePatterns: stale,
        aiVerdictQueued,
      },
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
