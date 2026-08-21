import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, UserRole, type TripAutomationRun, type TripAutomationSettings } from '@prisma/client';
import type {
  SetTripAutomationSettingsDto,
  TripAutomationRunDto,
  TripAutomationRunItemDto,
  TripAutomationRunStats,
  TripAutomationSettingsDto,
} from '@vizyo/tracky-shared';
import { DORMANT_STOP_ACTING_MS, isVehicleDormant } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { TripsService } from '../trips/trips.service';
import { TripAnalysisLlmService } from './trip-analysis-llm.service';
import { TripAnalysisService } from './trip-analysis.service';

/** Source des erreurs de l'automatisation dans le centre d'alerte (filtre dédié). */
const SOURCE = 'TRIP_AUTOMATION';
/** recompute() clampe déjà `to` à now-10min ; on aligne la fenêtre dessus. */
const RECOMPUTE_TAIL_MS = 10 * 60 * 1000;
/** Marge amont quand on recompute le « tail sale » (rattrape un trajet frontière). */
const RECOMPUTE_BACKOFF_MS = 30 * 60 * 1000;
/**
 * Amplitude MAXIMALE d'un seul recalcul.
 *
 * Sans ce plafond, un véhicule portant un vieux trajet non recalculé déclenchait un recompute sur
 * TOUTE la fenêtre (`lookbackHours`, 50 jours en prod) : suppression puis re-segmentation de sept
 * semaines de positions, plusieurs heures de travail — pendant lesquelles le verrou `running`
 * faisait sauter chaque passage horaire suivant. Le passage finissait tué par un redémarrage AVANT
 * d'avoir rien persisté, et le suivant repartait du même point : le retard ne se résorbait JAMAIS.
 * Constat prod du 19/08 : 2 158 trajets encore bruts, dont 1 207 vieux de 30 à 50 jours, alors que
 * la tranche 1-7 jours était propre — la signature d'un traitement qui n'atteint jamais le fond.
 *
 * Avec une tranche bornée, chaque passage avance le front d'un cran par véhicule. La reprise est
 * GRATUITE et SANS ÉTAT : le passage suivant relit le plus vieux trajet encore brut, qui a avancé.
 * Rien à mémoriser, rien à perdre si le processus redémarre au milieu.
 */
const RECOMPUTE_SLICE_MS = 48 * 60 * 60 * 1000;
/**
 * Budget de travail d'un passage. Au-delà, on arrête de prendre du travail neuf et le passage se
 * clôture normalement : il persiste son bilan, met à jour `lastRunAt`, et le suivant reprend où
 * celui-ci s'est arrêté.
 *
 * ⚠️ MESURÉ LE 19/08, APRÈS UNE PREMIÈRE VERSION INSUFFISANTE. Le budget n'était vérifié qu'à
 * l'entrée de chaque VÉHICULE. Or le temps ne part pas dans le nombre de véhicules : il part dans
 * la boucle interne sur leurs TRAJETS, où chaque analyse interroge OpenStreetMap pour les limites
 * de vitesse (lent, parfois en échec) et chaque trajet recalculé est recalé sur le réseau routier.
 * Un seul véhicule portant 150 trajets à analyser tenait donc le passage bien au-delà du budget :
 * observé à 31 minutes pour un plafond annoncé à 20. La borne doit être là où le temps se dépense,
 * pas là où il est commode de la lire.
 *
 * ── PORTE A 50 MIN LE 2026-08-19 ─────────────────────────────────────────────────────
 *
 * Le cron passe TOUTES LES HEURES, et un garde interdit deja le chevauchement : brider a
 * 20 minutes laissait donc les deux tiers du temps disponible inutilises. Mesure du jour :
 * un passage de 22,8 minutes traitait UN SEUL vehicule et reportait les 39 autres, alors que
 * 11 300 analyses attendaient le rattrapage de l'historique. A ce rythme il aurait fallu
 * soixante-six heures.
 *
 * 50 minutes laissent dix minutes de marge avant le tick suivant. Si un passage deborde
 * malgre tout, le garde anti-chevauchement saute simplement le tick d'apres — le systeme se
 * regule seul, il ne s'empile pas.
 */
const RUN_BUDGET_MS = 50 * 60 * 1000;
/** Plafond dur de trajets listés par véhicule et par run (défense mémoire). */
const MAX_TRIPS_PER_VEHICLE = 500;
/** Détail borné stocké par run (les trajets traités, cliquables). */
const MAX_ITEMS_PER_RUN = 300;
/** Historique conservé (runs récents) — le reste est élagué à chaque insertion. */
const KEEP_RUNS = 100;

type MutableStats = {
  fleets: number;
  vehicles: number;
  recomputed: number;
  analyzed: number;
  narrated: number;
  failed: number;
  /** Véhicules écartés d'entrée parce que leur boîtier s'est tu (cf. {@link DORMANT_STOP_ACTING_MS}). */
  skippedDormant: number;
  /** Tranches non recalculées faute de position : recompute SUPPRIME avant de re-segmenter. */
  skippedNoPositions: number;
  /** Véhicules non abordés parce que le budget de temps du passage était épuisé. */
  skippedBudget: number;
  /** Le passage s'est-il arrêté sur son budget plutôt qu'au bout de son travail ? */
  budgetAtteint: boolean;
};

/**
 * Bilan de run + le compteur d'exclusions pour dormance.
 *
 * Le champ vit UNIQUEMENT dans le JSON (`TripAutomationSettings.lastRunStats` et le `meta` de
 * l'activité système) : la dormance est dérivée au read-time, elle ne justifie NI colonne NI
 * migration. La table d'historique `TripAutomationRun` garde donc ses colonnes telles quelles —
 * le nombre d'ignorés est en revanche écrit en toutes lettres dans le libellé d'activité, pour
 * qu'un chiffre qui baisse (moins de véhicules traités) soit toujours expliqué.
 */
type TripAutomationRunStatsWithDormancy = TripAutomationRunStats & {
  skippedDormant: number;
  skippedNoPositions: number;
  skippedBudget: number;
  budgetAtteint: boolean;
};

type RunItem = TripAutomationRunItemDto;

/**
 * Automatisation des trajets (2026-07) — un cron HORAIRE qui, pour TOUTES les flottes, exécute le
 * pipeline « recalcul → analyse déterministe → récit IA », de façon bornée et paramétrable
 * (singleton `TripAutomationSettings`, piloté par le super-admin).
 *
 * Ordre IMPOSÉ (le recompute re-crée les trajets avec de NOUVEAUX ids et orpheline les analyses) :
 *   1. RECALCUL (optionnel) — on ne recompute QUE le « tail sale » (trajets non issus d'un précédent
 *      recompute) pour éviter de re-miner (donc ré-analyser + ré-narrer) les trajets déjà propres.
 *      C'est le « if avant pour clear les trajets » : on analyse 3 vrais trajets, pas 10 fragments.
 *   2. ANALYSE déterministe (jamais bloquée par l'IA — c'est la couche non-IA).
 *   3. RÉCIT IA, seulement si l'IA est active pour la flotte, borné par un cap de coût.
 *
 * CONTRÔLE : chaque passage est PERSISTÉ (TripAutomationRun) avec quand / pour qui / quoi + la liste
 * cliquable des trajets traités. Robustesse : verrou anti-chevauchement, tout est séquentiel
 * (throttle OSM/Overpass partagé + VPS 2 vCPU), chaque échec → centre d'alerte (jamais de throw).
 *
 * PÉRIMÈTRE : seuls les véhicules dont le boîtier a parlé dans les 72 h entrent dans le pipeline.
 * Un boîtier muet ne produit plus de trajet : le balayer coûtait des requêtes (et, si un recompute
 * recréait ses vieux trajets, des appels IA facturés) pour un résultat toujours vide. Les exclus
 * sont COMPTÉS (`skippedDormant`) et annoncés dans le journal d'activité.
 */
@Injectable()
export class TripAutomationService {
  private readonly logger = new Logger(TripAutomationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly analysis: TripAnalysisService,
    private readonly llm: TripAnalysisLlmService,
    private readonly aiAvail: AiAvailabilityService,
    private readonly errorLogger: ErrorLogger,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /** Toutes les heures à HH:45 (décalé des crons agenda :00 / rapports :20 pour lisser le VPS). */
  @Cron('0 45 * * * *')
  async runScheduled(): Promise<void> {
    let settings: TripAutomationSettings;
    try {
      settings = await this.loadRow();
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'settings' }, 'CRITICAL');
      return;
    }
    if (!settings.enabled) return;

    const parisHour = this.parisHour();
    if (settings.frequency === 'daily') {
      if (parisHour !== settings.hour) return;
      // Anti double-run quotidien (marge 22h).
      if (settings.lastRunAt && Date.now() - settings.lastRunAt.getTime() < 22 * 3600 * 1000) return;
    } else {
      // Horaire : garde anti double-run rapproché (< 50 min).
      if (settings.lastRunAt && Date.now() - settings.lastRunAt.getTime() < 50 * 60 * 1000) return;
    }

    await this.run(settings, 'scheduled');
  }

  /** Lancement MANUEL (bouton « Lancer maintenant » super-admin) — ignore cadence/heure. */
  async runNow(): Promise<TripAutomationRunStatsWithDormancy> {
    const settings = await this.loadRow();
    return this.run(settings, 'manual');
  }

  private async run(
    settings: TripAutomationSettings,
    origin: 'scheduled' | 'manual',
  ): Promise<TripAutomationRunStatsWithDormancy> {
    if (this.running) {
      this.logger.warn('Run déjà en cours — skip.');
      return this.finalStats(this.emptyStats(), 0);
    }
    this.running = true;
    const startedAt = new Date();
    const startMs = Date.now();
    // Échéance ABSOLUE du passage, calculée une seule fois et descendue jusqu'à la boucle des
    // trajets — c'est là que le temps se dépense, donc c'est là qu'il faut la lire.
    const echeance = startMs + RUN_BUDGET_MS;
    const stats = this.emptyStats();
    const items: RunItem[] = [];
    try {
      const user = this.systemUser();
      const now = Date.now();
      const windowFrom = new Date(now - settings.lookbackHours * 3600 * 1000);

      const windowTo = new Date(now - RECOMPUTE_TAIL_MS);

      const fleets = await this.prisma.fleet.findMany({ select: { id: true, name: true } });
      for (const fleet of fleets) {
        stats.fleets++;
        const aiOn = settings.narrateEnabled && (await this.aiAvail.isEnabledForFleet(fleet.id, 'tripAnalysis'));

        let vehicles: { id: string; plate: string; tracker: { id: string; lastSeenAt: Date | null } | null }[];
        try {
          vehicles = await this.prisma.vehicle.findMany({
            where: { fleetId: fleet.id, tracker: { isNot: null } },
            // `lastSeenAt` est JOINT à la requête qui existait déjà (rien de nouveau à exécuter) :
            // il sert à ne pas relancer tout le pipeline sur un boîtier muet depuis des semaines.
            select: { id: true, plate: true, tracker: { select: { id: true, lastSeenAt: true } } },
          });
        } catch (e) {
          stats.failed++;
          await this.errorLogger.record(e as Error, SOURCE, { fleetId: fleet.id, phase: 'vehicles' });
          continue;
        }

        for (const v of vehicles) {
          // Arrêt anticipé si les deux caps sont atteints (rien de plus à faire ce run).
          const analysisCapReached = stats.analyzed >= settings.maxAnalysesPerRun;
          const narrationCapReached = !aiOn || stats.narrated >= settings.maxNarrationsPerRun;
          if (analysisCapReached && narrationCapReached) break;
          // BUDGET DE PASSAGE (cf. RUN_BUDGET_MS) — on ne démarre plus de véhicule au-delà. On
          // COMPTE les véhicules laissés de côté au lieu de sortir en silence : un passage qui
          // traite 12 véhicules sur 39 doit le dire, sinon il ressemble à un passage complet.
          if (Date.now() > echeance) {
            stats.skippedBudget++;
            stats.budgetAtteint = true;
            continue;
          }
          // DORMANCE (seuil « arrêter d'agir », 72 h) — un boîtier muet depuis 3 jours n'a produit
          // AUCUN trajet neuf : le recompute, le listing des trajets et la lecture des analyses
          // tournaient à vide, une fois par heure, pour chaque véhicule mort (en prod : FV-941-LZ,
          // 89 jours). Pire, le récit IA se déclenchait sur des trajets qu'on avait déjà narrés si
          // un recompute les avait recréés. On borne donc l'ENTRÉE du pipeline, jamais ses refus.
          //
          // Le véhicule n'est ni masqué ni archivé : ses trajets, analyses et récits restent
          // intégralement consultables. Dès la première trame reçue, `lastSeenAt` redevient frais
          // et il repasse dans le pipeline au tick suivant — aucun bouton à cliquer.
          //
          // Un boîtier affecté qui n'a JAMAIS émis n'est PAS dormant (il ne s'est pas « tu ») :
          // il traverse la boucle, ne trouve aucun trajet et sort immédiatement.
          if (
            isVehicleDormant(
              { trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null },
              now,
              DORMANT_STOP_ACTING_MS,
            )
          ) {
            stats.skippedDormant++;
            continue;
          }
          stats.vehicles++;
          await this.processVehicle(
            user,
            { id: v.id, plate: v.plate, fleetId: fleet.id, fleetName: fleet.name, trackerId: v.tracker?.id ?? null },
            aiOn, windowFrom, windowTo, settings, stats, items, echeance,
          );
        }
      }

      const runStats = this.finalStats(stats, Date.now() - startMs);
      await this.persistRun(settings.id, runStats);
      await this.recordRun(origin, startedAt, runStats, items);
      this.systemActivity.record({
        category: 'AI',
        action: 'trip_automation_run',
        status: stats.failed > 0 ? 'FAILURE' : 'SUCCESS',
        actor: origin === 'manual' ? 'super-admin' : 'planning',
        // Un chiffre client ne doit jamais baisser en silence : si des véhicules ont été écartés,
        // le libellé le DIT (sinon « 12 analysés » au lieu de 30 passerait pour une panne). Les
        // trois motifs d'exclusion sont distincts et se cumulent — les fondre en un seul total
        // rendrait impossible de savoir s'il faut rallumer un boîtier ou élargir le budget.
        detail:
          `Automatisation trajets (${origin}) : ${stats.recomputed} recalculé(s) · ${stats.analyzed} analysé(s) · ` +
          `${stats.narrated} récit(s) IA · ${stats.failed} échec(s) sur ${stats.fleets} flotte(s)` +
          (stats.skippedDormant > 0 ? ` · ${stats.skippedDormant} véhicule(s) au boîtier muet ignoré(s)` : '') +
          (stats.skippedBudget > 0 ? ` · ${stats.skippedBudget} véhicule(s) reportés au passage suivant (budget de temps atteint)` : '') +
          (stats.skippedNoPositions > 0 ? ` · ${stats.skippedNoPositions} recalcul(s) impossibles faute de position` : '') +
          // Un passage écourté n'est pas un passage terminé : le dire évite de lire « 12 analysés »
          // comme « il n'y avait que 12 choses à faire ».
          (stats.budgetAtteint ? ' · passage ÉCOURTÉ sur son budget de temps, la suite au prochain' : '') +
          '.',
        meta: runStats as unknown as Record<string, unknown>,
      });
      return runStats;
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'run' }, 'CRITICAL');
      return this.finalStats(stats, Date.now() - startMs);
    } finally {
      this.running = false;
    }
  }

  /**
   * Horizon au-dela duquel les positions ONT ETE PURGEES et ne reviendront pas.
   *
   * ⚠️ Lu depuis LA MEME variable d'environnement que la purge (`POSITIONS_RETENTION_DAYS`),
   *    jamais d'une constante recopiee : deux valeurs qui divergent, et on se remettrait a
   *    alerter sur une absence parfaitement normale — ou pire, a se taire sur une vraie
   *    anomalie. Un jour de marge absorbe l'ecart entre l'heure de la purge et celle du passage.
   */
  private horizonRetention(now = Date.now()): number {
    const jours = Number(process.env.POSITIONS_RETENTION_DAYS ?? 60);
    // Retention desactivee (0 ou absurde) : rien n'est purge, donc toute absence est une anomalie.
    if (!Number.isFinite(jours) || jours <= 0) return 0;
    return now - (jours - 1) * 86_400_000;
  }

  private async processVehicle(
    user: AuthUser,
    veh: { id: string; plate: string; fleetId: string; fleetName: string | null; trackerId: string | null },
    aiOn: boolean,
    windowFrom: Date,
    windowTo: Date,
    settings: TripAutomationSettings,
    stats: MutableStats,
    items: RunItem[],
    echeance: number,
  ): Promise<void> {
    const { id: vehicleId, fleetId } = veh;

    // 1) RECALCUL « if avant pour clear les trajets » — uniquement le tail sale.
    if (settings.recomputeTrips) {
      try {
        const dirty = await this.prisma.trip.findFirst({
          where: {
            vehicleId,
            endedAt: { not: null },
            startedAt: { gte: windowFrom },
            // segmentationSource est non-nullable (défaut 'live') : « sale » = pas encore recomputé.
            // 'fige-retention' est EXCLU : ses positions sont purgées, le re-segmenter est
            // impossible pour toujours — le laisser ici recréerait la famine qu'il résout.
            segmentationSource: { notIn: ['recompute', 'fige-retention'] },
          },
          select: { startedAt: true },
          orderBy: { startedAt: 'asc' },
        });
        if (dirty) {
          const fromMs = Math.max(windowFrom.getTime(), dirty.startedAt.getTime() - RECOMPUTE_BACKOFF_MS);
          // TRANCHE BORNÉE : `fromMs -> fromMs + 48 h`, JAMAIS « jusqu'à maintenant ». Le front
          // avance d'une tranche par passage et par véhicule ; sur la queue fraîche (le cas
          // courant, un trajet clôturé il y a quelques minutes) la borne haute retombe sur
          // `windowTo` et le comportement est identique à avant.
          const toMs = Math.min(fromMs + RECOMPUTE_SLICE_MS, windowTo.getTime());
          // recompute() SUPPRIME la tranche avant de la re-segmenter. Sans position pour la
          // reconstruire, il effacerait des trajets qu'il ne pourrait pas recréer : une tranche
          // vide est un fait DOUTEUX, pas un fait. On ne touche à rien, on le compte, et on le
          // remonte au centre d'alerte — le véhicule cale, mais il cale BRUYAMMENT. Un blocage
          // visible vaut mieux qu'un historique détruit en silence.
          const positions = veh.trackerId
            ? await this.prisma.position.count({
                where: { trackerId: veh.trackerId, timestamp: { gte: new Date(fromMs), lte: new Date(toMs) } },
              })
            : 0;
          if (positions === 0 && fromMs < this.horizonRetention()) {
            /**
             * ⚠️ SOUS L'HORIZON DE RETENTION, UNE TRANCHE VIDE EST UN FAIT DEFINITIF — et le
             * front doit AVANCER, pas attendre.
             *
             * L'ancien comportement se contentait de sauter la tranche. Or « dirty » retombe
             * sur le MEME trajet a chaque passage : le vehicule etait en famine perpetuelle,
             * silencieuse depuis que l'alerte est tue sous l'horizon. Mesure du 2026-08-21 :
             * la convergence figee 24 h durant (906 -> 907 trajets a re-segmenter), pendant
             * que la purge quotidienne creait de nouveaux affames a la frontiere.
             *
             * On FIGE donc les trajets de la tranche : leur version live devient la version
             * definitive, puisque les positions qui permettraient de les re-segmenter
             * n'existent plus. `fige-retention` les sort du front (le filtre dirty exclut
             * deja tout ce qui n'est pas 'live'... non : il exclut 'recompute' — d'ou un
             * marqueur DISTINCT, teste, pour ne pas les confondre avec un vrai recalcul).
             */
            const figes = await this.prisma.trip.updateMany({
              where: {
                vehicleId,
                startedAt: { gte: new Date(fromMs), lte: new Date(toMs) },
                endedAt: { not: null },
                segmentationSource: { notIn: ['recompute', 'fige-retention'] },
              },
              data: { segmentationSource: 'fige-retention' },
            });
            stats.skippedNoPositions++;
            this.logger.log(
              `${veh.plate} : tranche ${new Date(fromMs).toISOString().slice(0, 10)} sans position (retention) — ` +
              `${figes.count} trajet(s) fige(s), le front avance`,
            );
          } else if (positions === 0) {
            stats.skippedNoPositions++;
            // ⚠️ DEUX CAUSES TRES DIFFERENTES POUR UNE MEME TRANCHE VIDE.
            //
            //   — au-dela de l'horizon de retention, l'absence de positions est ATTENDUE : la
            //     purge les a supprimees, c est la politique qui s applique. Alerter revient a
            //     signaler chaque jour que le passe est passe ;
            //   — en deca, c est une vraie anomalie : les positions devraient etre la.
            //
            // Releve du 2026-08-20 : en portant la fenetre a 1 500 h pour le rattrapage de
            // l'historique, elle s'est mise a chevaucher la limite de retention. Resultat, trois
            // alertes en quatre heures sur FZ-862-VY pour une tranche du 19 au 21 juin — vouee a
            // se repeter a CHAQUE passage, indefiniment, pour un fait sans remede.
            await this.errorLogger.record(
                new Error(
                  `Recalcul impossible sur ${veh.plate} : aucune position entre ${new Date(fromMs).toISOString()} et ` +
                    `${new Date(toMs).toISOString()}, alors que des trajets bruts y subsistent. Rien n'a été supprimé.`,
                ),
                SOURCE,
                { fleetId, vehicleId, phase: 'recompute:no-positions', from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
              );
          } else if (toMs > fromMs) {
            const r = await this.trips.recompute(
              { userId: user.id, role: user.role, fleetId: user.fleetId },
              { vehicleId, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
            );
            stats.recomputed += r.created;
          }
        }
      } catch (e) {
        stats.failed++;
        await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, phase: 'recompute' });
      }
    }

    // 2) Trajets clôturés de la fenêtre + état analyse/récit.
    let trips: { id: string; startedAt: Date }[];
    try {
      trips = await this.prisma.trip.findMany({
        where: { vehicleId, endedAt: { not: null }, startedAt: { gte: windowFrom } },
        select: { id: true, startedAt: true },
        orderBy: { startedAt: 'desc' },
        take: MAX_TRIPS_PER_VEHICLE,
      });
    } catch (e) {
      stats.failed++;
      await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, phase: 'listTrips' });
      return;
    }
    /**
     * ⚠️ LA BORNE DES 500 AFFAMAIT LE RATTRAPAGE.
     *
     * Le listing prend les 500 trajets les plus RECENTS — la bonne priorite au quotidien : le
     * client regarde d'abord la journee en cours. Mais en rattrapage, les trajets encore sans
     * analyse sont les plus ANCIENS : des que le front a recule au-dela de la borne, le cron
     * terminait en quelques secondes en jurant qu'il n'y avait rien a faire. Mesure du
     * 2026-08-21 : 2 235 trajets en attente, passages a 0-5 analyses.
     *
     * On complete donc par les plus anciens SANS analyse, en petit nombre : le courant garde
     * la priorite, l'arriere s'ecoule. Les trajets figes par la retention sont exclus — les
     * analyser produirait des analyses VIDES (60 retrouvees en base sur des trajets reels,
     * toutes a la frontiere de purge du 18-19/06).
     */
    try {
      const anciens = await this.prisma.trip.findMany({
        where: {
          vehicleId,
          endedAt: { not: null },
          startedAt: { gte: windowFrom },
          segmentationSource: { not: 'fige-retention' },
          id: { notIn: trips.map((t) => t.id) },
        },
        select: { id: true, startedAt: true },
        orderBy: { startedAt: 'asc' },
        take: 300,
      });
      if (anciens.length > 0) {
        const dejaAnalyses = new Set(
          (
            await this.prisma.tripAnalysis.findMany({
              where: { tripId: { in: anciens.map((t) => t.id) } },
              select: { tripId: true },
            })
          ).map((a) => a.tripId),
        );
        // Les plus anciens D'ABORD en fin de liste : la boucle traite les recents en tete.
        // ⚠️ DEDUPLIQUE PAR IDENTIFIANT, meme si le `notIn` de la requete rend le doublon
        //    improbable : un trajet present deux fois serait ANALYSE DEUX FOIS dans la meme
        //    boucle — et surtout NARRE deux fois, soit un appel modele paye pour rien. La
        //    defense cote code ne depend pas de la bonne volonte de la requete.
        const vus = new Set(trips.map((t) => t.id));
        trips = trips.concat(anciens.filter((t) => !dejaAnalyses.has(t.id) && !vus.has(t.id)));
      }
    } catch (e) {
      // Best-effort : sans le complement, on retombe sur l'ancien comportement (borne).
      this.logger.warn(`complement anciens sans analyse : ${(e as Error)?.message ?? e}`);
    }

    if (trips.length === 0) return;

    let existing: { tripId: string; narrative: string | null }[];
    try {
      existing = await this.prisma.tripAnalysis.findMany({
        where: { tripId: { in: trips.map((t) => t.id) } },
        select: { tripId: true, narrative: true },
      });
    } catch (e) {
      stats.failed++;
      await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, phase: 'existing' });
      return;
    }
    // tripId -> a une analyse ? (valeur = a un récit ?)
    const narrativeByTrip = new Map(existing.map((e) => [e.tripId, !!e.narrative]));

    for (const t of trips) {
      // LA garde qui manquait. Une analyse interroge OpenStreetMap et un recalcul recale le
      // tracé sur le réseau routier : quelques secondes chacun, parfois davantage quand le
      // service public répond mal. Sans ce contrôle ICI, un seul véhicule chargé tenait le
      // passage une demi-heure et faisait sauter le suivant. Les trajets non traités n'ont pas
      // d'analyse : le passage suivant les reprendra tels quels, sans rien mémoriser.
      if (Date.now() > echeance) {
        stats.budgetAtteint = true;
        break;
      }
      const hasAnalysis = narrativeByTrip.has(t.id);
      let hasNarrative = narrativeByTrip.get(t.id) ?? false;
      let didAnalyze = false;
      let didNarrate = false;

      // 2a) ANALYSE déterministe si absente (couche non-IA, jamais coupée).
      if (!hasAnalysis) {
        if (stats.analyzed >= settings.maxAnalysesPerRun) continue; // cap → ni analyse ni récit
        try {
          await this.analysis.analyze(user, t.id);
          stats.analyzed++;
          didAnalyze = true;
          hasNarrative = false; // désormais analysé, sans récit
        } catch (e) {
          stats.failed++;
          await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, tripId: t.id, phase: 'analyze' });
          continue; // pas d'analyse → pas de récit possible
        }
      }

      // 2b) RÉCIT IA si active + pas déjà de récit + budget restant.
      if (aiOn && !hasNarrative && stats.narrated < settings.maxNarrationsPerRun) {
        try {
          await this.llm.narrate(user, t.id);
          stats.narrated++;
          didNarrate = true;
        } catch (e) {
          stats.failed++;
          await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, tripId: t.id, phase: 'narrate' });
        }
      }

      // Trace cliquable : un trajet réellement touché ce run (analyse et/ou récit).
      if ((didAnalyze || didNarrate) && items.length < MAX_ITEMS_PER_RUN) {
        items.push({
          fleetId, fleetName: veh.fleetName,
          vehicleId, plate: veh.plate,
          tripId: t.id, tripStartedAt: t.startedAt.toISOString(),
          action: didNarrate ? 'narrated' : 'analyzed',
        });
      }
    }
  }

  // ── Réglages (singleton) ────────────────────────────────────────────────

  async getSettings(): Promise<TripAutomationSettingsDto> {
    return this.toDto(await this.loadRow());
  }

  async setSettings(dto: SetTripAutomationSettingsDto, userId: string | null): Promise<TripAutomationSettingsDto> {
    const row = await this.loadRow();
    const data: Prisma.TripAutomationSettingsUpdateInput = { updatedByUserId: userId };
    if (dto.enabled !== undefined) data.enabled = !!dto.enabled;
    if (dto.frequency !== undefined) data.frequency = dto.frequency === 'daily' ? 'daily' : 'hourly';
    if (dto.hour !== undefined) data.hour = this.clampInt(dto.hour, 0, 23);
    if (dto.lookbackHours !== undefined) data.lookbackHours = this.clampInt(dto.lookbackHours, 1, 720);
    if (dto.recomputeTrips !== undefined) data.recomputeTrips = !!dto.recomputeTrips;
    if (dto.narrateEnabled !== undefined) data.narrateEnabled = !!dto.narrateEnabled;
    if (dto.maxAnalysesPerRun !== undefined) data.maxAnalysesPerRun = this.clampInt(dto.maxAnalysesPerRun, 0, 5000);
    if (dto.maxNarrationsPerRun !== undefined) data.maxNarrationsPerRun = this.clampInt(dto.maxNarrationsPerRun, 0, 2000);
    const updated = await this.prisma.tripAutomationSettings.update({ where: { id: row.id }, data });
    return this.toDto(updated);
  }

  /** Historique des passages (le plus récent d'abord) — audit « quand / pour qui / quoi ». */
  async listRuns(limit = 30): Promise<TripAutomationRunDto[]> {
    const take = this.clampInt(limit, 1, 100);
    const rows = await this.prisma.tripAutomationRun.findMany({ orderBy: { startedAt: 'desc' }, take });
    return rows.map((r) => this.runToDto(r));
  }

  private async loadRow(): Promise<TripAutomationSettings> {
    const existing = await this.prisma.tripAutomationSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (existing) return existing;
    return this.prisma.tripAutomationSettings.create({ data: {} });
  }

  private async persistRun(id: string, runStats: TripAutomationRunStatsWithDormancy): Promise<void> {
    try {
      await this.prisma.tripAutomationSettings.update({
        where: { id },
        data: { lastRunAt: new Date(), lastRunStats: runStats as unknown as Prisma.InputJsonValue },
      });
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'persistRun' });
    }
  }

  /** Enregistre le run dans l'historique (audit + récits cliquables) puis élague les vieux. */
  private async recordRun(
    origin: 'scheduled' | 'manual',
    startedAt: Date,
    runStats: TripAutomationRunStatsWithDormancy,
    items: RunItem[],
  ): Promise<void> {
    try {
      await this.prisma.tripAutomationRun.create({
        data: {
          startedAt,
          finishedAt: new Date(),
          origin,
          fleets: runStats.fleets,
          vehicles: runStats.vehicles,
          recomputed: runStats.recomputed,
          analyzed: runStats.analyzed,
          narrated: runStats.narrated,
          failed: runStats.failed,
          durationMs: runStats.durationMs,
          items: items.slice(0, MAX_ITEMS_PER_RUN) as unknown as Prisma.InputJsonValue,
        },
      });
      // Élagage best-effort : ne garder que les KEEP_RUNS plus récents.
      const stale = await this.prisma.tripAutomationRun.findMany({
        orderBy: { startedAt: 'desc' },
        skip: KEEP_RUNS,
        select: { id: true },
      });
      if (stale.length > 0) {
        await this.prisma.tripAutomationRun.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      }
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'recordRun' });
    }
  }

  private toDto(r: TripAutomationSettings): TripAutomationSettingsDto {
    return {
      enabled: r.enabled,
      frequency: r.frequency === 'daily' ? 'daily' : 'hourly',
      hour: r.hour,
      lookbackHours: r.lookbackHours,
      recomputeTrips: r.recomputeTrips,
      narrateEnabled: r.narrateEnabled,
      maxAnalysesPerRun: r.maxAnalysesPerRun,
      maxNarrationsPerRun: r.maxNarrationsPerRun,
      lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
      lastRunStats: (r.lastRunStats as unknown as TripAutomationRunStats | null) ?? null,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    };
  }

  private runToDto(r: TripAutomationRun): TripAutomationRunDto {
    const items = Array.isArray(r.items) ? (r.items as unknown as TripAutomationRunItemDto[]) : [];
    return {
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      origin: r.origin === 'manual' ? 'manual' : 'scheduled',
      fleets: r.fleets,
      vehicles: r.vehicles,
      recomputed: r.recomputed,
      analyzed: r.analyzed,
      narrated: r.narrated,
      failed: r.failed,
      durationMs: r.durationMs,
      items,
    };
  }

  // ── Utilitaires ─────────────────────────────────────────────────────────

  /** Super-admin SYNTHÉTIQUE : court-circuite les checks d'accès (aucune requête sur l'id). */
  private systemUser(): AuthUser {
    return {
      id: 'system-trip-automation',
      authUserId: 'system-trip-automation',
      email: 'system@tracky',
      firstName: null,
      lastName: null,
      role: UserRole.SUPER_ADMIN,
      isOwner: false,
      fleetId: null,
      isActive: true,
      permissions: null,
    };
  }

  /** Heure courante à Paris (0-23), robuste au DST via Intl. */
  private parisHour(): number {
    try {
      const s = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        hour12: false,
      }).format(new Date());
      const h = parseInt(s, 10);
      return Number.isFinite(h) ? h % 24 : new Date().getHours();
    } catch {
      return new Date().getHours();
    }
  }

  private clampInt(n: number, min: number, max: number): number {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  private emptyStats(): MutableStats {
    return {
      fleets: 0, vehicles: 0, recomputed: 0, analyzed: 0, narrated: 0, failed: 0,
      skippedDormant: 0, skippedNoPositions: 0, skippedBudget: 0, budgetAtteint: false,
    };
  }

  private finalStats(s: MutableStats, durationMs: number): TripAutomationRunStatsWithDormancy {
    return { ...s, durationMs, at: new Date().toISOString() };
  }
}
