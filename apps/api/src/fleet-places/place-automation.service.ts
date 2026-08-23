import { Injectable, Logger } from '@nestjs/common';
import { heureParis } from '../common/utils/datetime';
import { Cron } from '@nestjs/schedule';
import type { PlaceAutomationSettings } from '@prisma/client';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlaceAnalysisService, type PaidCallError, type PlaceForAnalysis } from './place-analysis.service';

/** Source dédiée dans le centre d'alerte (filtrable). */
const SOURCE = 'PLACE_AUTOMATION';
/** Détail borné conservé par run (défense mémoire + lisibilité de l'historique). */
const MAX_ITEMS_PER_RUN = 200;
/** Historique conservé — les plus anciens sont élagués à chaque insertion. */
const KEEP_RUNS = 100;
/** Coût unitaire supposé quand aucune analyse passée n'existe encore (simulation seulement). */
const FALLBACK_COST_EUR = 0.02;
/** Coupe-circuit : au-delà de N échecs D'AFFILÉE, on arrête (provider HS, base indisponible…). */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Bornes de saisie des réglages — empêchent de configurer une dépense absurde depuis l'UI. */
const LIMITS = {
  hour: { min: 0, max: 23 },
  minIntervalDays: { min: 1, max: 365 },
  maxAnalysesPerRun: { min: 1, max: 200 },
  // Plafond haut DÉLIBÉRÉMENT bas : ce réglage s'applique à chaque passage QUOTIDIEN, donc il
  // détermine le pire cas mensuel (5 € × 30 j = 150 €/mois). Un « max 50 » autoriserait 1500 €/mois
  // sans que personne ne l'ait voulu.
  maxCostEurPerRun: { min: 0.01, max: 5 },
};

type StopReason =
  | 'completed'
  | 'max_analyses'
  | 'max_cost'
  | 'month_budget'
  | 'too_many_failures'
  | 'already_running'
  | 'error';

interface RunItem {
  fleetName: string;
  placeId: string;
  placeName: string;
  action: 'analyzed' | 'would_analyze' | 'failed';
  costEur: number;
}

export interface PlaceAutomationRunStats {
  fleets: number;
  candidates: number;
  analyzed: number;
  skippedUnchanged: number;
  skippedCooldown: number;
  skippedAiOff: number;
  failed: number;
  costEur: number;
  durationMs: number;
  stopReason: StopReason;
  dryRun: boolean;
}

/**
 * Automatisation des analyses de lieux (2026-07).
 *
 * ⚠️ Ce service DÉPENSE DE L'ARGENT. Il est donc écrit autour d'une seule question : « est-ce que
 * cet appel apporte quelque chose que je n'ai pas déjà payé ? ». Cinq garde-fous CUMULATIFS, du
 * moins cher au plus cher — chacun élimine des candidats AVANT d'atteindre le suivant :
 *
 *   1. **OPT-IN** — `enabled` false par défaut : tant que personne n'active, zéro dépense.
 *   2. **Porte IA par société** — `isEnabledForFleet` : une société sans option IA est écartée en
 *      bloc, sans même lire ses lieux.
 *   3. **Budget mensuel global** — si `AiBudget` est défini et déjà consommé, le run s'arrête AVANT
 *      le premier appel (`stopReason: 'month_budget'`).
 *   4. **Délai minimum par lieu** (`minIntervalDays`, 30 j par défaut) — borne PRINCIPALE : un lieu
 *      coûte au plus une analyse par période, quoi qu'il arrive. Vérifié avant toute collecte.
 *   5. **Empreinte des faits** (`skipUnchanged`) — si les faits n'ont pas bougé, le modèle
 *      réécrirait le même texte : on saute. La collecte des faits (OSM + base) est GRATUITE, donc
 *      ce contrôle ne coûte rien.
 *
 * Puis deux plafonds DURS par run : nombre d'analyses et euros dépensés.
 *
 * Robustesse : verrou anti-chevauchement, exécution séquentielle (throttle Overpass + VPS 2 vCPU),
 * échec d'un lieu = ce lieu seul est perdu (compté `failed`, remonté au centre d'alerte), et le
 * service ne lève JAMAIS — un cron qui explose casserait le scheduler.
 *
 * Chaque run est PERSISTÉ avec le détail des sauts par motif : on peut répondre précisément à
 * « pourquoi ça a coûté ça » et à « pourquoi ce lieu n'a pas été analysé ».
 */
@Injectable()
export class PlaceAutomationService {
  private readonly logger = new Logger(PlaceAutomationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analysis: PlaceAnalysisService,
    private readonly aiAvail: AiAvailabilityService,
    private readonly aiUsage: AiUsageService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * Sonde HORAIRE à HH:10 qui ne fait quelque chose qu'à l'heure configurée (créneau libre : agenda
   * :00, rapports :20, trajets :45). Un run par jour maximum — les lieux ne changent pas d'heure
   * en heure, et une cadence plus fine ne ferait que dépenser.
   */
  @Cron('0 10 * * * *')
  async runScheduled(): Promise<void> {
    // D'abord RANGER ce que le poste a produit — meme automatisation coupee : un travail
    // deja redige doit etre persiste, pas abandonne dans la file (design/C1).
    try {
      await this.analysis.consommerTravauxLocaux();
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'consommer-travaux-locaux' });
    }

    let settings: PlaceAutomationSettings;
    try {
      settings = await this.loadRow();
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'settings' }, 'CRITICAL');
      return;
    }
    if (!settings.enabled) return;
    if (this.parisHour() !== settings.hour) return;
    // Anti double-run quotidien (marge 22 h) : protège d'un redémarrage ou d'un changement d'heure.
    if (settings.lastRunAt && Date.now() - settings.lastRunAt.getTime() < 22 * 3600 * 1000) return;

    await this.run(settings, 'scheduled');
  }

  /**
   * Lancement MANUEL (super-admin). `dryRun` = SIMULATION : tout est évalué (candidats, sauts,
   * estimation) mais **aucun appel IA n'est émis** — permet de voir ce que coûterait un run avant
   * de l'activer.
   */
  async runNow(dryRun = false): Promise<PlaceAutomationRunStats> {
    const settings = await this.loadRow();
    return this.run(settings, dryRun ? 'dry-run' : 'manual');
  }

  // ─── Réglages ──────────────────────────────────────────────────────────────

  /**
   * Réglages + budget IA mensuel global. Le budget est joint ici parce que c'est le plafond qui
   * PRIME sur tous les autres : l'afficher à côté des plafonds par passage évite de raisonner sur
   * un seul chiffre et de se croire protégé alors qu'on ne l'est pas.
   */
  async getSettings(): Promise<PlaceAutomationSettings & { monthlyBudgetEur: number }> {
    const [row, budget] = await Promise.all([
      this.loadRow(),
      this.aiUsage.getBudget({ isOwner: true }).catch(() => ({ monthlyBudgetEur: 0 })),
    ]);
    return { ...row, monthlyBudgetEur: budget.monthlyBudgetEur ?? 0 };
  }

  /** Écrit les réglages en CLAMPANT chaque valeur : l'UI ne doit pas pouvoir armer une dépense folle. */
  async setSettings(dto: Partial<PlaceAutomationSettings>, userId?: string): Promise<PlaceAutomationSettings> {
    const row = await this.loadRow();
    const data: Record<string, unknown> = { updatedByUserId: userId ?? null };
    if (typeof dto.enabled === 'boolean') data['enabled'] = dto.enabled;
    if (typeof dto.skipUnchanged === 'boolean') data['skipUnchanged'] = dto.skipUnchanged;
    if (dto.hour != null) data['hour'] = clampInt(dto.hour, LIMITS.hour);
    if (dto.minIntervalDays != null) data['minIntervalDays'] = clampInt(dto.minIntervalDays, LIMITS.minIntervalDays);
    if (dto.maxAnalysesPerRun != null) data['maxAnalysesPerRun'] = clampInt(dto.maxAnalysesPerRun, LIMITS.maxAnalysesPerRun);
    if (dto.maxCostEurPerRun != null) {
      const v = Math.min(LIMITS.maxCostEurPerRun.max, Math.max(LIMITS.maxCostEurPerRun.min, Number(dto.maxCostEurPerRun)));
      // (le plafond haut est volontairement bas : × 30 jours, c'est lui qui fixe le pire cas mensuel)
      data['maxCostEurPerRun'] = Number.isFinite(v) ? Math.round(v * 100) / 100 : 1;
    }
    return this.prisma.placeAutomationSettings.update({ where: { id: row.id }, data });
  }

  /** Historique des runs (le plus récent d'abord). */
  async listRuns(limit = 30) {
    return this.prisma.placeAutomationRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });
  }

  // ─── Exécution ─────────────────────────────────────────────────────────────

  private async run(
    settings: PlaceAutomationSettings,
    origin: 'scheduled' | 'manual' | 'dry-run',
  ): Promise<PlaceAutomationRunStats> {
    const dryRun = origin === 'dry-run';
    if (this.running) {
      // Motif DISTINCT de « terminé » : l'UI ne doit pas annoncer un passage réussi alors qu'un
      // autre est en cours (et dépense) en arrière-plan.
      this.logger.warn('Run déjà en cours — skip.');
      return { ...emptyStats(), stopReason: 'already_running', dryRun };
    }
    this.running = true;

    const startedAt = new Date();
    const t0 = Date.now();
    const stats = emptyStats();
    const items: RunItem[] = [];
    let stopReason: StopReason = 'completed';

    try {
      // ── Garde-fou 3 : budget mensuel global. Vérifié AVANT tout appel. Délégué au service
      // d'analyse : MÊME contrôle que le déclenchement manuel, pas une seconde implémentation.
      if (!dryRun && (await this.analysis.monthBudgetExhausted())) {
        stopReason = 'month_budget';
        this.logger.warn('Budget IA mensuel atteint — run annulé avant toute dépense.');
      } else {
        stopReason = await this.processFleets(settings, stats, items, dryRun);
      }
    } catch (e) {
      // Filet ultime : une erreur inattendue ne doit ni casser le cron, ni passer inaperçue.
      stopReason = 'error';
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'run', origin }, 'CRITICAL');
    } finally {
      this.running = false;
    }

    const durationMs = Date.now() - t0;
    const final: PlaceAutomationRunStats = { ...stats, durationMs, stopReason, dryRun };
    // (un run refusé par le verrou est sorti plus haut : il n'atteint jamais l'historique)
    await this.persistRun(startedAt, origin, final, items);
    // Une SIMULATION ne doit pas décaler la cadence réelle : elle ne touche pas `lastRunAt`.
    if (!dryRun) await this.markRun(settings.id, final);
    return final;
  }

  /** Parcourt les sociétés puis leurs lieux, en appliquant les garde-fous dans l'ordre du moins cher. */
  private async processFleets(
    settings: PlaceAutomationSettings,
    stats: PlaceAutomationRunStats,
    items: RunItem[],
    dryRun: boolean,
  ): Promise<StopReason> {
    const fleets = await this.prisma.fleet.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const estimate = dryRun ? await this.averageCostEur() : 0;
    const cooldownMs = settings.minIntervalDays * 24 * 3600 * 1000;
    let consecutiveFailures = 0;

    for (const fleet of fleets) {
      // ── Garde-fou 2 : société sans IA → on compte ses lieux (pour l'historique) puis on passe,
      // sans jamais rien collecter ni analyser. Le `count` évite de charger les lignes entières.
      const aiOn = await this.aiAvail.isEnabledForFleet(fleet.id, 'placeAnalysis');
      if (!aiOn) {
        const n = await this.prisma.fleetPlace.count({ where: { fleetId: fleet.id } });
        if (n > 0) {
          stats.fleets++;
          stats.skippedAiOff += n;
        }
        continue;
      }

      const places = await this.prisma.fleetPlace.findMany({
        where: { fleetId: fleet.id },
        select: { id: true, fleetId: true, name: true, kind: true, lat: true, lng: true, radiusM: true, note: true, stationId: true },
        orderBy: { createdAt: 'asc' },
      });
      if (places.length === 0) continue;
      stats.fleets++;

      for (const place of places) {
        stats.candidates++;

        // ── Garde-fou 4 : délai minimum. Vérifié en PREMIER (une lecture en base, aucun réseau).
        const existing = await this.prisma.placeAnalysis.findUnique({
          where: { placeId: place.id },
          select: { computedAt: true, factsHash: true },
        });
        if (existing && Date.now() - existing.computedAt.getTime() < cooldownMs) {
          stats.skippedCooldown++;
          continue;
        }

        // ── Plafonds DURS. Testés avant l'appel : le dépassement possible est d'AU PLUS une
        // analyse (on ne connaît le coût exact qu'après coup) — assumé et documenté.
        if (stats.analyzed >= settings.maxAnalysesPerRun) return 'max_analyses';
        if (!dryRun && stats.costEur >= settings.maxCostEurPerRun) return 'max_cost';

        try {
          // Collecte GRATUITE (OSM + base) — c'est elle qui permet le garde-fou 5.
          const { facts, hash } = await this.analysis.gatherFacts(place as PlaceForAnalysis);

          // ── Garde-fou 5 : faits inchangés → le modèle réécrirait le même texte.
          if (settings.skipUnchanged && existing?.factsHash && existing.factsHash === hash) {
            stats.skippedUnchanged++;
            continue;
          }

          if (dryRun) {
            stats.analyzed++;
            stats.costEur = round4(stats.costEur + estimate);
            pushItem(items, { fleetName: fleet.name, placeId: place.id, placeName: place.name, action: 'would_analyze', costEur: estimate });
            continue;
          }

          /**
           * ⚠️ PLUS AUCUN APPEL MODELE ICI — bascule locale du 2026-08-21 (design/C1).
           * Le travail complet part vers le poste ; la redaction est absorbee par
           * l'abonnement, d'ou un cout de 0. Le plafond de depense par passage reste en
           * place mais ne mord plus — conserve pour le jour ou la voie API reviendrait.
           * L'action reste 'analyzed' dans les items (DTO partage inchange, regle du
           * chantier) : lire « analyse CONFIEE au poste », le resultat arrive au passage
           * suivant du cron, une fois le courrier passe.
           */
          const enfile = await this.analysis.enfilerAnalyseLocale(place as PlaceForAnalysis, facts, hash);
          if (enfile) {
            stats.analyzed++;
            consecutiveFailures = 0;
            pushItem(items, { fleetName: fleet.name, placeId: place.id, placeName: place.name, action: 'analyzed', costEur: 0 });
          } else {
            stats.skippedUnchanged++; // deja en file pour ces memes faits : rien a refaire
          }
        } catch (e) {
          // Un lieu qui échoue ne fait pas tomber le run : on le compte, on le remonte, on continue.
          stats.failed++;
          consecutiveFailures++;
          // ⚠️ L'échec a pu survenir APRÈS un appel déjà facturé (panne de base, etc.). On récupère
          // le coût réellement engagé, sinon les plafonds seraient aveugles à une panne en série.
          const paid = (e as PaidCallError)?.paidCostEur ?? 0;
          if (paid > 0) stats.costEur = round4(stats.costEur + paid);
          pushItem(items, { fleetName: fleet.name, placeId: place.id, placeName: place.name, action: 'failed', costEur: paid });
          await this.errorLogger.record(
            e as Error, SOURCE,
            { phase: 'analyze', fleetId: fleet.id, placeId: place.id, placeName: place.name, paidCostEur: paid },
            'ERROR',
          );
          // COUPE-CIRCUIT : au-delà de N échecs d'affilée, quelque chose est cassé (provider HS,
          // base indisponible). Continuer reviendrait à payer en boucle pour rien.
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.logger.error(`${consecutiveFailures} échecs consécutifs — run interrompu.`);
            return 'too_many_failures';
          }
        }
      }
    }
    return 'completed';
  }

  // ─── Garde-fous & utilitaires ──────────────────────────────────────────────

  /** Coût moyen d'une analyse déjà réalisée — sert UNIQUEMENT à chiffrer une simulation. */
  private async averageCostEur(): Promise<number> {
    try {
      const agg = await this.prisma.placeAnalysis.aggregate({ _avg: { costEur: true } });
      const avg = agg._avg.costEur;
      return avg && avg > 0 ? round4(avg) : FALLBACK_COST_EUR;
    } catch {
      return FALLBACK_COST_EUR;
    }
  }

  private async persistRun(
    startedAt: Date,
    origin: string,
    stats: PlaceAutomationRunStats,
    items: RunItem[],
  ): Promise<void> {
    try {
      await this.prisma.placeAutomationRun.create({
        data: {
          startedAt,
          finishedAt: new Date(),
          origin,
          fleets: stats.fleets,
          candidates: stats.candidates,
          analyzed: stats.analyzed,
          skippedUnchanged: stats.skippedUnchanged,
          skippedCooldown: stats.skippedCooldown,
          skippedAiOff: stats.skippedAiOff,
          failed: stats.failed,
          costEur: stats.costEur,
          durationMs: stats.durationMs,
          stopReason: stats.stopReason,
          items: items as unknown as object,
        },
      });
      // Élagage : on garde les N derniers runs.
      const old = await this.prisma.placeAutomationRun.findMany({
        orderBy: { startedAt: 'desc' }, skip: KEEP_RUNS, select: { id: true },
      });
      if (old.length > 0) {
        await this.prisma.placeAutomationRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
      }
    } catch (e) {
      // L'historique est de la traçabilité : son échec ne doit pas invalider un run déjà exécuté.
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'persist-run' }, 'ERROR');
    }
  }

  private async markRun(settingsId: string, stats: PlaceAutomationRunStats): Promise<void> {
    try {
      await this.prisma.placeAutomationSettings.update({
        where: { id: settingsId },
        data: { lastRunAt: new Date(), lastRunStats: { ...stats, at: new Date().toISOString() } },
      });
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'mark-run' }, 'ERROR');
    }
  }

  /** Ligne unique de réglages (créée à la volée au premier accès). */
  private async loadRow(): Promise<PlaceAutomationSettings> {
    const existing = await this.prisma.placeAutomationSettings.findFirst({ orderBy: { createdAt: 'asc' } });
    if (existing) return existing;
    return this.prisma.placeAutomationSettings.create({ data: {} });
  }

  /**
   * Heure courante à Paris (le VPS est en UTC — sans ça le run tomberait à côté en été).
   *
   * 🔴 TRK-044 — l'ancienne version faisait `Number(format(...))` sur un format à heure
   * seule : en `fr-FR` il rend « 04 h », donc `NaN`, donc une porte fermée À TOUTE HEURE.
   * Cette tâche ne s'est JAMAIS déclenchée sur son planning entre son activation et le
   * 23/08 — et aucun des trois filets (erreurs, journal, sonde) ne pouvait le voir, le
   * `return` étant muet. Délégué à l'util COMMUN et testé : deux copies privées de ce
   * calcul avaient déjà divergé (celle des trajets était saine, celle-ci non).
   */
  private parisHour(): number {
    return heureParis();
  }
}

function emptyStats(): PlaceAutomationRunStats {
  return {
    fleets: 0, candidates: 0, analyzed: 0, skippedUnchanged: 0, skippedCooldown: 0,
    skippedAiOff: 0, failed: 0, costEur: 0, durationMs: 0, stopReason: 'completed', dryRun: false,
  };
}

function pushItem(items: RunItem[], item: RunItem): void {
  if (items.length < MAX_ITEMS_PER_RUN) items.push(item);
}

function clampInt(v: number, { min, max }: { min: number; max: number }): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
