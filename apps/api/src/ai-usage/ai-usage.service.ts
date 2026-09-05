import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type {
  AiBudgetStatus,
  AiExecutor,
  AiUsageAbsorbedDto,
  AiUsageBreakdownRowDto,
  AiUsageBudgetDto,
  AiUsageLogsPageDto,
  AiUsageSummaryDto,
} from '@vizyo/tracky-shared';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { CLES_REFROIDISSEMENT, RefroidissementAlerteService } from '../observability/refroidissement-alerte.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/** Tarifs en USD / 1M jetons (figés côté serveur ; source de vérité du coût). */
interface Pricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * ══ GRILLE TARIFAIRE — relevée le 2026-09-05 sur les pages officielles ═══════════════════
 *
 *   - Anthropic : https://www.anthropic.com/pricing — cache : écriture (5 min) = 1,25× l'entrée,
 *     lecture = 0,1× l'entrée. Fable 5.1 fait exception : lecture de cache à 0,25 $.
 *   - OpenAI : https://openai.com/api/pricing — pas d'écriture de cache facturée (`cacheWrite` 0),
 *     `cacheRead` = tarif « cached input ».
 *
 * ── POURQUOI CETTE GRILLE A ÉTÉ REFAITE (C3 point 4) ──────────────────────────────────────
 * Sonnet 5 était compté 3 / 15 $ alors que la page officielle dit 2 / 10 $ (cache 2,50 / 0,20) :
 * 26 lignes API Sonnet 5 = 0,891 $ stockés contre 0,594 $ recalculés. Et les agents du poste
 * écrivaient des noms (`sonnet`, `claude-code-poste`) inconnus de la grille — donc comptés au
 * repli, silencieusement. Une grille fausse ne fait pas planter : elle fait prendre des
 * décisions sur des chiffres faux.
 *
 * ⚠️ Une grille MANQUANTE ne fait pas planter non plus : elle retombe sur le repli LE PLUS CHER
 *    (Fable 5.1, cf. `FALLBACK_MODEL`) et le DIT — journal + une ligne DEGRADATION au centre
 *    d'alerte. On ne sous-estime jamais un coût inconnu, et on ne le tait pas.
 *
 * Les clés sont des PRÉFIXES : les fournisseurs renvoient des identifiants datés
 * (`claude-haiku-4-5-20251001`, `gpt-4.1-2025-04-14`), résolus par le plus long préfixe connu
 * (cf. `resolvePricing` : `gpt-4o-mini` doit gagner sur `gpt-4o`).
 */
const PRICING: Record<string, Pricing> = {
  // ── Anthropic ──────────────────────────────────────────────────────────────────────────
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // ── OpenAI ─────────────────────────────────────────────────────────────────────────────
  'gpt-5.2': { input: 1.75, output: 14, cacheWrite: 0, cacheRead: 0.175 },
  'gpt-5.1': { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheWrite: 0, cacheRead: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheWrite: 0, cacheRead: 0.005 },
  'gpt-4.1': { input: 2, output: 8, cacheWrite: 0, cacheRead: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheWrite: 0, cacheRead: 0.1 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheWrite: 0, cacheRead: 0.025 },
  'gpt-4o': { input: 2.5, output: 10, cacheWrite: 0, cacheRead: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheWrite: 0, cacheRead: 0.075 },
};

/**
 * ALIAS — les noms que le poste et les consommateurs écrivent à la place d'un identifiant.
 *
 * ⚠️ Mesuré sur le poste le 2026-09-05 : l'alias CLI `sonnet` résout en `claude-sonnet-4-6`,
 *    PAS en Sonnet 5. Les lignes locales antérieures portant `sonnet` ou `claude-code-poste`
 *    (l'agent de récits écrivait ce nom en dur, à 0 jeton, depuis le 20/08) sont donc du
 *    Sonnet 4.6, et se comptent à son tarif. `local` est le nom que les consommateurs posent
 *    quand le résultat ne dit pas son modèle (`lireResultatLocal`) : même moteur, même tarif.
 *    Depuis le 05/09 les nouvelles lignes locales portent l'identifiant réel rendu par la CLI
 *    (`claude-sonnet-4-6`, `claude-haiku-4-5-20251001`…), résolu par préfixe.
 */
const ALIAS: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  'claude-code-poste': 'claude-sonnet-4-6',
  local: 'claude-sonnet-4-6',
  opus: 'claude-opus-5',
  haiku: 'claude-haiku-4-5',
};

/** Le repli d'un modèle inconnu : le tarif LE PLUS CHER de la grille, pour ne jamais sous-estimer. */
const FALLBACK_MODEL = 'claude-fable-5-1';
const FALLBACK_PRICING: Pricing = PRICING[FALLBACK_MODEL];

/**
 * Résout la grille d'un modèle : exact, puis alias, puis le plus long PRÉFIXE connu (les
 * fournisseurs renvoient des versions datées). `connu: false` = repli au tarif le plus cher.
 * Fonction PURE : le signalement du repli est fait par le service (il a le centre d'alerte).
 */
export function resolvePricing(model: string): { pricing: Pricing; cle: string; connu: boolean } {
  const nom = (model ?? '').trim();
  if (PRICING[nom]) return { pricing: PRICING[nom], cle: nom, connu: true };
  const alias = ALIAS[nom];
  if (alias && PRICING[alias]) return { pricing: PRICING[alias], cle: alias, connu: true };
  let best: { key: string; p: Pricing } | null = null;
  for (const [key, p] of Object.entries(PRICING)) {
    if (nom.startsWith(key) && (!best || key.length > best.key.length)) best = { key, p };
  }
  if (best) return { pricing: best.p, cle: best.key, connu: true };
  return { pricing: FALLBACK_PRICING, cle: FALLBACK_MODEL, connu: false };
}

/**
 * Le fournisseur qu'un identifiant de modèle désigne, pour les lignes écrites AVANT que la
 * colonne `provider` n'existe (05/09) : `claude` pour les alias du poste et la famille Claude,
 * `gpt` pour la famille OpenAI, sinon inconnu.
 */
function fournisseurDuModele(model: string): 'claude' | 'gpt' | null {
  const nom = (model ?? '').trim();
  if (ALIAS[nom] || nom.startsWith('claude')) return 'claude';
  if (nom.startsWith('gpt') || /^o[1-9]/.test(nom)) return 'gpt';
  return null;
}

/**
 * Clé de refroidissement du signalement « tarif inconnu », suffixée par le modèle. La valeur est
 * un identifiant PERSISTANT (la renommer remettrait le garde à zéro) : elle a vocation à
 * rejoindre `CLES_REFROIDISSEMENT` sous ce nom exact.
 */
const CLE_TARIF_INCONNU: string = CLES_REFROIDISSEMENT.AI_TARIF_INCONNU;
/** Un modèle inconnu se signale une fois par semaine : ajouter une ligne à la grille est un geste humain. */
const REFROIDISSEMENT_TARIF_MS = 7 * 24 * 3_600_000;
/** Source des lignes de la grille tarifaire au centre d'alerte. */
const SOURCE_ALERTE_TARIF = 'AI_TARIF';

const ACTION_LABELS: Record<string, string> = {
  capacity: 'Capacité',
  placement: 'Placement',
  agenda_optimization: 'Agenda (agent)',
  agenda_agent: 'Agent agenda',
  activity_report: "Rapport d'activité",
  trip_analysis: 'Analyse de trajet',
  booking_parse: 'Réservation (vocal)',
  place_analysis: 'Analyse de lieu',
  support_chat: 'Assistance (chat)',
};

/**
 * Ce que chaque fonction PRODUIT, au pluriel — « 418 trajets analysés ce mois ».
 *
 * Le libellé vit ici, à côté de `ACTION_LABELS`, parce que c'est le serveur qui
 * connaît la liste des actions. Laisser le client deviner l'unité d'un compteur,
 * c'est lui demander d'inventer un fait métier ; une action ajoutée sans entrée
 * ici n'affiche simplement pas son unité, au lieu d'en afficher une fausse.
 */
const ACTION_RESULTATS: Record<string, string> = {
  capacity: 'capacités estimées',
  placement: 'placements proposés',
  agenda_optimization: 'créneaux optimisés',
  agenda_agent: 'demandes traitées',
  activity_report: "rapports d'activité rédigés",
  trip_analysis: 'trajets analysés',
  booking_parse: 'réservations comprises',
  place_analysis: 'lieux qualifiés',
  support_chat: 'réponses rédigées',
};

/** Les quatre compteurs d'un appel, tels que les fournisseurs les renvoient. */
export interface AiUsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface AiUsageEntry extends AiUsageTokens {
  userId?: string | null;
  fleetId?: string | null;
  model: string;
  action: string;
  latencyMs?: number | null;
  ok?: boolean;
  /**
   * Combien d'objets cet appel a produits (trajets analysés, lieux qualifiés…).
   * Laisser vide quand le point d'appel ne sait pas compter : `null` dit « non
   * mesuré », là où `0` affirmerait « rien produit ». La page préfère se taire.
   */
  resultCount?: number | null;
  /**
   * QUI a exécuté l'appel. Défaut `api` — c'est le cas de tous les points d'appel existants,
   * et un oubli doit compter comme une dépense, jamais comme un travail gratuit : se tromper
   * dans ce sens fait surestimer la facture, l'inverse la ferait disparaître.
   */
  executor?: AiExecutor;
  /** Fournisseur qui a répondu (`claude` | `gpt`). Absent : déduit du modèle à la lecture. */
  provider?: string | null;
}

/**
 * Un appel IA en ÉCHEC, tel que le routeur le décrit (C3 point 5). Une ligne par TENTATIVE de
 * fournisseur : un refus Anthropic suivi d'un repli GPT réussi produit une ligne d'échec ET une
 * ligne de succès — c'est bien ce qui s'est passé.
 */
export interface AiUsageFailure {
  action: string;
  userId?: string | null;
  fleetId?: string | null;
  /** `api` (défaut) ou `local` : un travail de la file du poste acté en échec n'a rien facturé. */
  executor?: 'api' | 'local';
  /** Fournisseur tenté (`claude` | `gpt`), ou `null` quand l'appel a été refusé AVANT tout moteur (plafond mensuel). */
  provider: string | null;
  /** Modèle tenté — celui qui a répondu, sinon celui qui AURAIT été employé (`AiClient.modelFor`). */
  model: string;
  errorKind: string;
  /** Motif du fournisseur ou message d'erreur ; borné à 400 caractères à l'écriture. */
  errorDetail?: string | null;
  latencyMs?: number | null;
  /**
   * Usage RÉEL renvoyé par le fournisseur avant l'échec (réponse tronquée, refus après lecture,
   * JSON invalide) : ces jetons ont été FACTURÉS, `costUsd` les compte. Absent = rien facturé.
   */
  usage?: AiUsageTokens | null;
  /**
   * Jetons d'entrée ESTIMÉS quand rien n'a été facturé : longueur(system + données) / 4, sortie 0.
   * Simple et assumé — un ordre de grandeur marqué ≈ à l'écran, jamais de l'argent.
   */
  estimatedInputTokens?: number;
}

/** Borne du motif conservé sur une ligne d'échec (la colonne est du texte libre, le corps d'un fournisseur peut être long). */
const ERROR_DETAIL_MAX = 400;

/**
 * Palier « Coûts IA » — enregistre chaque appel IA (réussi : jetons + coût ; échoué : sorte,
 * motif, coût réel ou estimé) et fournit les agrégats du tableau de bord super-admin + le budget
 * mensuel. Le calcul de coût vit ici (source unique). L'enregistrement est NON BLOQUANT : jamais
 * d'exception propagée.
 */
@Injectable()
export class AiUsageService implements OnModuleInit {
  private readonly logger = new Logger(AiUsageService.name);

  /**
   * Préchauffe le taux au démarrage : les appelants SYNCHRONES (`eurRate()`) liraient sinon le
   * repli pendant la première minute de chaque redémarrage, et un coût converti à 0,86 au lieu du
   * taux réglé serait écrit dans `place_analyses.costEur` sans que rien ne le dise.
   */
  async onModuleInit(): Promise<void> {
    await this.usdToEur().catch(() => undefined);
  }

  /**
   * Taux USD→€ : défaut 0,86 (marché relevé le 2026-09-05). Jusqu'à cette date, 0,92 en dur —
   * variable `AI_USD_TO_EUR` jamais déclarée ni posée — soit 7 % au-dessus du marché, et le
   * plafond mensuel se comparait à cette dépense en euros. Le taux vit désormais dans
   * `ai_budget.usdToEurRate`, modifiable depuis la page et affiché à côté des montants.
   */
  private static readonly TAUX_DEFAUT = 0.86;
  /** Le taux change rarement : une lecture par minute suffit, y compris pour les chemins synchrones. */
  private static readonly TAUX_CACHE_MS = 60_000;
  private tauxCache: { valeur: number; a: number } | null = null;
  private tauxEnCours: Promise<number> | null = null;

  /** Modèles inconnus déjà signalés par CE processus : le refroidissement en base tient sur la durée. */
  private readonly tarifsInconnusSignales = new Set<string>();

  /**
   * Le plafond mensuel est-il atteint ?
   *
   * ── Pourquoi ici ────────────────────────────────────────────────────────────────
   * Cette regle vivait dans `PlaceAnalysisService`, un seul des HUIT points d'appel IA.
   * L'administrateur fixait 10 EUR, voyait la barre rouge et le badge « Depasse » — et
   * seules les analyses de lieux s'arretaient. Le cron horaire de recits de trajets,
   * l'agent d'agenda, le rapport d'activite, l'optimiseur et la saisie vocale
   * continuaient d'appeler le modele.
   *
   * Le plafond appartient au budget, donc il vit avec lui. `AiRouterService` — qui se
   * declare « point d'entree UNIQUE de tous les appels IA » — l'applique desormais pour
   * tout le monde, et personne n'a plus a y penser.
   *
   * ⚠️ FAIL-CLOSED : une lecture en echec repond `true`. Devant un doute sur l'argent,
   * on ne depense pas. C'est l'inverse de l'anti-spam, dont le pire cas est une
   * notification de trop.
   *
   * ⚠️ Le plafond ne somme que `costUsd` — l'argent RÉEL. L'estimation d'un échec
   * (`estimatedCostUsd`) n'y entre jamais : un compte à sec qui refuse cent appels ne doit pas
   * « dépenser » cent estimations et couper l'autre moteur (C3 point 5).
   */
  async monthBudgetExhausted(): Promise<boolean> {
    try {
      const budget = await this.getBudget({ isOwner: true });
      // Budget non defini (0 ou absent) = pas de plafond, pas de blocage.
      if (!budget.monthlyBudgetEur || budget.monthlyBudgetEur <= 0) return false;
      return budget.spentThisMonthEur >= budget.monthlyBudgetEur;
    } catch (err) {
      this.logger.warn(
        `[ai] budget illisible — appel IA refuse par prudence: ${err instanceof Error ? err.message : err}`,
      );
      return true;
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
    private readonly ownerVis: OwnerVisibilityService,
    // Fournis par l'ObservabilityModule (@Global). Optionnels : les jeux d'essai construisent le
    // service à trois dépendances, et un coût se calcule sans centre d'alerte.
    @Optional() private readonly errorLogger?: ErrorLogger,
    @Optional() private readonly refroidissement?: RefroidissementAlerteService,
  ) {}

  // ─── Taux USD→€ ────────────────────────────────────────────────────────────

  /** Repli hors base : `AI_USD_TO_EUR` (déclarée au schéma d'environnement), sinon 0,86. */
  private tauxRepli(): number {
    const r = Number(process.env.AI_USD_TO_EUR);
    return Number.isFinite(r) && r > 0 ? r : AiUsageService.TAUX_DEFAUT;
  }

  /** Taux USD→€ courant : `ai_budget.usdToEurRate` (ligne singleton), cache 60 s, repli env puis 0,86. */
  private async usdToEur(): Promise<number> {
    if (this.tauxCache && Date.now() - this.tauxCache.a < AiUsageService.TAUX_CACHE_MS) return this.tauxCache.valeur;
    // Une seule lecture en vol : la page appelle summary + logs + budget en rafale.
    if (!this.tauxEnCours) {
      this.tauxEnCours = this.lireTaux().finally(() => {
        this.tauxEnCours = null;
      });
    }
    return this.tauxEnCours;
  }

  private async lireTaux(): Promise<number> {
    try {
      const row = await this.prisma.aiBudget.findFirst({ orderBy: { updatedAt: 'desc' }, select: { usdToEurRate: true } });
      const v = row?.usdToEurRate;
      const valeur = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : this.tauxRepli();
      this.tauxCache = { valeur, a: Date.now() };
      return valeur;
    } catch (e) {
      this.logger.warn(`Taux USD→€ illisible en base, repli ${this.tauxCache?.valeur ?? this.tauxRepli()} : ${(e as Error)?.message ?? e}`);
      return this.tauxCache?.valeur ?? this.tauxRepli();
    }
  }

  /**
   * Taux USD→€ appliqué (exposé pour convertir des coûts stockés ailleurs : rapport d'activité,
   * analyse de lieu, assistance). SYNCHRONE pour ne pas changer la signature de ses appelants :
   * rend le dernier taux lu (≤ 60 s) et, s'il est périmé, relance une lecture en arrière-plan.
   * Avant la première lecture, c'est le repli (env, puis 0,86) — un montant converti au repli
   * plutôt qu'une requête qui bloque.
   */
  eurRate(): number {
    if (!this.tauxCache || Date.now() - this.tauxCache.a >= AiUsageService.TAUX_CACHE_MS) {
      void this.usdToEur().catch(() => undefined);
    }
    return this.tauxCache?.valeur ?? this.tauxRepli();
  }

  // ─── Grille ────────────────────────────────────────────────────────────────

  /** La grille d'un modèle ; un modèle inconnu est compté au tarif le plus cher ET signalé. */
  private tarif(model: string): Pricing {
    const r = resolvePricing(model);
    if (!r.connu) this.signalerTarifInconnu(model);
    return r.pricing;
  }

  /**
   * Un modèle absent de la grille est compté au tarif le plus cher (jamais sous-estimer), et on
   * le DIT : journal + UNE ligne DEGRADATION au centre d'alerte par modèle et par 7 jours. Sans
   * signalement, l'agent de récits a tourné du 20/08 au 05/09 sous un nom inconnu, compté au
   * repli, sans que personne ne le voie. Fire-and-forget : le calcul d'un coût ne bloque pas.
   */
  private signalerTarifInconnu(model: string): void {
    if (this.tarifsInconnusSignales.has(model)) return;
    this.tarifsInconnusSignales.add(model);
    this.logger.warn(`Modèle « ${model} » absent de la grille tarifaire : compté au tarif le plus cher (${FALLBACK_MODEL}).`);
    if (!this.errorLogger) return;
    const errorLogger = this.errorLogger;
    void (async () => {
      try {
        const cle = `${CLE_TARIF_INCONNU}:${model}`;
        if (this.refroidissement && !(await this.refroidissement.tenterEmission(cle, REFROIDISSEMENT_TARIF_MS))) return;
        await errorLogger.record(
          new Error(
            `Tarif IA inconnu pour le modèle « ${model} » : compté au tarif le plus cher (${FALLBACK_MODEL}) — ajouter sa ligne à la grille.`,
          ),
          SOURCE_ALERTE_TARIF,
          { model, repli: FALLBACK_MODEL },
          'DEGRADATION',
        );
      } catch (e) {
        this.logger.warn(`Tarif inconnu « ${model} » non signalé : ${(e as Error)?.message ?? e}`);
      }
    })();
  }

  private computeCostUsd(model: string, input: number, output: number, cacheWrite: number, cacheRead: number): number {
    const p = this.tarif(model);
    return (input * p.input + output * p.output + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) / 1_000_000;
  }

  /** Coût USD d'un usage donné (réutilisé pour stocker le coût ailleurs, ex. rapport d'activité). */
  costOf(model: string, usage: AiUsageTokens): number {
    return this.computeCostUsd(model, usage.inputTokens, usage.outputTokens, usage.cacheWriteTokens, usage.cacheReadTokens);
  }

  /**
   * Estimation SIMPLE du coût d'un appel qui n'a jamais reçu de réponse : des jetons d'entrée
   * au prix d'entrée du modèle, sortie 0. Assumée grossière (C3 point 5 : « l'estimation du coût
   * IA (simple) ») — elle sert à voir qu'un échec a un prix, pas à le facturer.
   */
  estimateInputCostUsd(model: string, estimatedInputTokens: number): number {
    const jetons = Math.max(0, Math.ceil(Number(estimatedInputTokens) || 0));
    return (jetons * this.tarif(model).input) / 1_000_000;
  }

  // ─── Enregistrement ────────────────────────────────────────────────────────

  /** Journalise un appel IA. Ne lève jamais (le coût ne doit pas casser la requête métier). */
  async record(entry: AiUsageEntry): Promise<void> {
    try {
      const i = Math.max(0, entry.inputTokens | 0);
      const o = Math.max(0, entry.outputTokens | 0);
      const cw = Math.max(0, entry.cacheWriteTokens | 0);
      const cr = Math.max(0, entry.cacheReadTokens | 0);
      // Défaut `api` : un point d'appel qui oublie de se déclarer compte comme une DÉPENSE. Se
      // tromper dans ce sens surestime la facture ; l'inverse la ferait disparaître en silence.
      const executor: AiExecutor = entry.executor === 'local' ? 'local' : 'api';
      const tarifUsd = this.computeCostUsd(entry.model, i, o, cw, cr);
      // ⚠️ Un appel LOCAL n'est pas facturé : `costUsd` doit rester ce qui a réellement été
      // dépensé. Y inscrire le tarif théorique remplirait le budget mensuel avec de l'argent que
      // personne n'a payé — et `monthBudgetExhausted()` finirait par couper l'IA payante à cause
      // du travail gratuit. Ce que l'abonnement a absorbé se recalcule à la lecture, à partir des
      // tokens conservés ci-dessous.
      const costUsd = executor === 'local' ? 0 : tarifUsd;
      await this.prisma.aiUsageLog.create({
        data: {
          executor,
          userId: entry.userId ?? null,
          fleetId: entry.fleetId ?? null,
          model: entry.model,
          action: entry.action,
          inputTokens: i,
          outputTokens: o,
          cacheWriteTokens: cw,
          cacheReadTokens: cr,
          costUsd,
          latencyMs: entry.latencyMs ?? null,
          ok: entry.ok ?? true,
          resultCount: entry.resultCount ?? null,
          provider: entry.provider ?? null,
        },
      });
      // Funnel unique des appels IA → visible aussi dans l'onglet Système. On skippe
      // 'activity_report' (le planifié est déjà journalisé en AI_REPORT ; le manuel
      // est un acte utilisateur couvert par l'audit MUTATION).
      if (entry.action !== 'activity_report') {
        this.systemActivity.record({
          category: 'AI',
          action: `ai_${entry.action}`,
          status: entry.ok === false ? 'FAILURE' : 'SUCCESS',
          actor: entry.userId ? 'utilisateur' : 'system',
          detail:
            `${ACTION_LABELS[entry.action] ?? entry.action} · ${entry.model}` +
            // Le journal Système doit dire POURQUOI une ligne affiche 0 $ : sans ça, un appel
            // gratuit est indiscernable d'un appel raté.
            (executor === 'local' ? ' · poste local (absorbé par l\'abonnement)' : ''),
          fleetId: entry.fleetId ?? null,
          triggeredByUserId: entry.userId ?? null,
          durationMs: entry.latencyMs ?? null,
          meta: { costUsd, model: entry.model, executor, tarifUsd },
        });
      }
    } catch (e) {
      this.logger.warn(`AiUsageLog non journalisé : ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * ══ UN ÉCHEC EST UNE LIGNE (C3 point 5, 2026-09-05) ═════════════════════════════════════
   *
   * Jusqu'au 05/09, `ai_usage_logs` n'avait JAMAIS porté une ligne `ok = false` : trois jours de
   * compte Anthropic à sec (03-04/09) sont restés invisibles sur la page « Coûts IA ». Le routeur
   * appelle ceci pour CHAQUE tentative de fournisseur qui échoue — y compris celles suivies d'un
   * repli réussi, et le plafond mensuel levé avant tout appel.
   *
   *  - `costUsd` = l'argent RÉEL : le coût des jetons renvoyés par le fournisseur avant l'échec
   *    (réponse tronquée, refus après lecture), sinon 0. C'est lui, et lui seul, que le plafond
   *    mensuel additionne.
   *  - `estimatedCostUsd` = ce coût réel quand il existe, sinon l'estimation simple depuis les
   *    jetons d'entrée estimés. Affiché ≈ ; jamais compté dans le plafond.
   *
   * Ne lève jamais : journaliser un échec ne doit pas en fabriquer un second.
   */
  async recordFailure(f: AiUsageFailure): Promise<void> {
    try {
      const u = f.usage ?? null;
      const i = Math.max(0, (u?.inputTokens ?? 0) | 0);
      const o = Math.max(0, (u?.outputTokens ?? 0) | 0);
      const cw = Math.max(0, (u?.cacheWriteTokens ?? 0) | 0);
      const cr = Math.max(0, (u?.cacheReadTokens ?? 0) | 0);
      const facture = i + o + cw + cr > 0;
      const costUsd = facture ? this.computeCostUsd(f.model, i, o, cw, cr) : 0;
      const estimatedCostUsd = facture ? costUsd : this.estimateInputCostUsd(f.model, f.estimatedInputTokens ?? 0);
      const errorDetail = (f.errorDetail ?? '').trim().slice(0, ERROR_DETAIL_MAX) || null;
      await this.prisma.aiUsageLog.create({
        data: {
          executor: f.executor ?? 'api',
          userId: f.userId ?? null,
          fleetId: f.fleetId ?? null,
          model: f.model,
          action: f.action,
          inputTokens: i,
          outputTokens: o,
          cacheWriteTokens: cw,
          cacheReadTokens: cr,
          costUsd,
          latencyMs: f.latencyMs ?? null,
          ok: false,
          // 0 et non null : cet appel n'a RIEN produit, et c'est un fait, pas une absence de mesure.
          resultCount: 0,
          provider: f.provider ?? null,
          errorKind: f.errorKind,
          errorDetail,
          estimatedCostUsd,
        },
      });
      // Même entonnoir que les succès (onglet Système), même exception pour le rapport
      // d'activité : son échec manuel est archivé par l'appelant au centre d'alerte.
      if (f.action !== 'activity_report') {
        this.systemActivity.record({
          category: 'AI',
          action: `ai_${f.action}`,
          status: 'FAILURE',
          actor: f.userId ? 'utilisateur' : 'system',
          detail:
            `${ACTION_LABELS[f.action] ?? f.action} · ${f.model} · échec ${f.errorKind}` +
            (f.provider ? ` (${f.provider})` : '') +
            (errorDetail ? ` — ${errorDetail.slice(0, 120)}` : ''),
          fleetId: f.fleetId ?? null,
          triggeredByUserId: f.userId ?? null,
          durationMs: f.latencyMs ?? null,
          meta: { costUsd, estimatedCostUsd, estime: !facture, model: f.model, provider: f.provider, errorKind: f.errorKind },
        });
      }
    } catch (e) {
      this.logger.warn(`Échec IA non journalisé (${f.action}/${f.errorKind}) : ${(e as Error)?.message ?? e}`);
    }
  }

  // ─── Tableau de bord ───────────────────────────────────────────────────────

  async summary(
    fromIso?: string,
    toIso?: string,
    scopeFleetId?: string,
    viewer: { isOwner?: boolean | null } = {},
  ): Promise<AiUsageSummaryDto> {
    const rate = await this.usdToEur();
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    // scopeFleetId : un FLEET_ADMIN ne voit QUE sa société (forcé par le controller) ; un
    // SUPER_ADMIN filtre librement (undefined = toutes). ET owner plateforme : exclu de TOUS les
    // agrégats pour un viewer non-owner (total inclus, sinon le delta total − Σ(par user) trahirait
    // une dépense masquée). userId NULLABLE (appels système) → on conserve les null, on exclut les owners.
    const ownerIds = this.ownerVis.isMasked(viewer) ? await this.ownerVis.getOwnerIds() : [];
    const where: Prisma.AiUsageLogWhereInput = {
      createdAt: { gte: from, lte: to },
      ...(scopeFleetId ? { fleetId: scopeFleetId } : {}),
    };
    if (ownerIds.length) where.OR = [{ userId: null }, { userId: { notIn: ownerIds } }];
    const fleetCond = scopeFleetId ? Prisma.sql`AND "fleetId" = ${scopeFleetId}::uuid` : Prisma.empty;
    const notOwnerAi = ownerIds.length
      ? Prisma.sql`AND ("userId" IS NULL OR "userId" <> ALL(${ownerIds}::uuid[]))`
      : Prisma.empty;

    const [agg, billed, failedAgg, byActionRaw, failedByActionRaw, byFleetRaw, byUserRaw, dayRows] = await Promise.all([
      this.prisma.aiUsageLog.aggregate({
        where,
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, costUsd: true },
      }),
      // Appels FACTURÉS : le seul dénominateur honnête d'un « coût par appel » (cf. le DTO). Le
      // NUMÉRATEUR doit porter sur le même ensemble — `totalCostUsd` inclut aussi le coût réel des
      // échecs facturés (réponse tronquée), et diviser l'un par l'autre gonflait le chiffre.
      this.prisma.aiUsageLog.aggregate({ where: { ...where, executor: 'api', ok: true }, _count: { _all: true }, _sum: { costUsd: true } }),
      // Les échecs, comptés à part, avec leur coût estimé (≈) — jamais de l'argent.
      this.prisma.aiUsageLog.aggregate({ where: { ...where, ok: false }, _count: { _all: true }, _sum: { estimatedCostUsd: true } }),
      this.prisma.aiUsageLog.groupBy({ by: ['action'], where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true, resultCount: true } }),
      this.prisma.aiUsageLog.groupBy({ by: ['action'], where: { ...where, ok: false }, _count: { _all: true } }),
      this.prisma.aiUsageLog.groupBy({ by: ['fleetId'], where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true, resultCount: true } }),
      this.prisma.aiUsageLog.groupBy({ by: ['userId'], where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true, resultCount: true } }),
      // ⚠️ Jour tronqué en heure de PARIS, pour coller au filtre « jour » de la page (bornes
      // locales de l'opérateur). `createdAt` est un timestamp SANS fuseau qui contient de l'UTC :
      // on le déclare UTC (`AT TIME ZONE 'UTC'` → timestamptz) AVANT de le lire en heure de
      // Paris — un seul `AT TIME ZONE 'Europe/Paris'` sur la colonne nue l'aurait pris pour de
      // l'heure locale et décalé chaque jour d'une ou deux heures dans le mauvais sens.
      this.prisma.$queryRaw<Array<{ day: Date; calls: bigint; cost: number }>>`
        SELECT date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris') AS day,
               COUNT(*)::bigint AS calls, COALESCE(SUM("costUsd"), 0) AS cost
        FROM ai_usage_logs
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to} ${fleetCond} ${notOwnerAi}
        GROUP BY 1 ORDER BY 1 ASC`,
    ]);

    const fleetIds = byFleetRaw.map((r) => r.fleetId).filter((x): x is string => !!x);
    const userIds = byUserRaw.map((r) => r.userId).filter((x): x is string => !!x);
    const [fleets, users] = await Promise.all([
      fleetIds.length ? this.prisma.fleet.findMany({ where: { id: { in: fleetIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
    ]);
    const fleetName = new Map(fleets.map((f) => [f.id, f.name]));
    const userEmail = new Map(users.map((u) => [u.id, u.email]));
    const failedByAction = new Map(failedByActionRaw.map((r) => [r.action, r._count._all]));

    const row = (
      key: string | null, label: string, calls: number, i: number, o: number, cost: number,
      resultats: number | null = null, resultatsLibelle: string | null = null,
    ): AiUsageBreakdownRowDto => ({
      key: key ?? '∅',
      label,
      calls,
      inputTokens: i,
      outputTokens: o,
      costUsd: cost,
      costEur: cost * rate,
      resultats,
      resultatsLibelle,
    });

    const byAction = byActionRaw
      .map((r) => ({
        ...row(
          r.action, ACTION_LABELS[r.action] ?? r.action, r._count._all,
          r._sum.inputTokens ?? 0, r._sum.outputTokens ?? 0, r._sum.costUsd ?? 0,
          r._sum.resultCount, ACTION_RESULTATS[r.action] ?? null,
        ),
        failed: failedByAction.get(r.action) ?? 0,
      }))
      .sort((a, b) => b.costUsd - a.costUsd);
    const byFleet = byFleetRaw
      .map((r) => row(
        r.fleetId, r.fleetId ? (fleetName.get(r.fleetId) ?? 'Flotte inconnue') : '— (hors flotte)', r._count._all,
        r._sum.inputTokens ?? 0, r._sum.outputTokens ?? 0, r._sum.costUsd ?? 0,
        // Une flotte cumule PLUSIEURS actions : le total a un sens, pas l'unité.
        // Nommer « trajets analysés » ici mélangerait des trajets et des lieux.
        r._sum.resultCount, null,
      ))
      .sort((a, b) => b.costUsd - a.costUsd);
    const byUser = byUserRaw
      .map((r) => row(
        r.userId, r.userId ? (userEmail.get(r.userId) ?? 'Utilisateur inconnu') : '— (système)', r._count._all,
        r._sum.inputTokens ?? 0, r._sum.outputTokens ?? 0, r._sum.costUsd ?? 0,
        r._sum.resultCount, null,
      ))
      .sort((a, b) => b.costUsd - a.costUsd);
    const byDay = dayRows.map((d) => {
      const iso = d.day.toISOString().slice(0, 10);
      return row(iso, iso, Number(d.calls), 0, 0, Number(d.cost));
    });

    const totalCostUsd = agg._sum.costUsd ?? 0;
    const failedEstimatedCostUsd = failedAgg._sum.estimatedCostUsd ?? 0;
    // Budget : global (super-admin) OU vue scopée flotte (visibilité seule, pas de plafond par flotte).
    const budget = scopeFleetId ? await this.fleetBudgetView(scopeFleetId, rate, viewer) : await this.getBudget(viewer);
    // Flotte scopée : identité + interrupteur maître IA → pilotage de l'IA PAR SOCIÉTÉ depuis la page.
    const scopedFleet = scopeFleetId
      ? await this.prisma.fleet.findUnique({ where: { id: scopeFleetId }, select: { id: true, name: true, aiEnabled: true } })
      : null;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalCalls: agg._count._all,
      billedCalls: billed._count._all,
      billedCostUsd: billed._sum.costUsd ?? 0,
      billedCostEur: (billed._sum.costUsd ?? 0) * rate,
      totalInputTokens: agg._sum.inputTokens ?? 0,
      totalOutputTokens: agg._sum.outputTokens ?? 0,
      totalCacheReadTokens: agg._sum.cacheReadTokens ?? 0,
      totalCacheWriteTokens: agg._sum.cacheWriteTokens ?? 0,
      totalCostUsd,
      totalCostEur: totalCostUsd * rate,
      usdToEurRate: rate,
      failedCalls: failedAgg._count._all,
      failedEstimatedCostUsd,
      failedEstimatedCostEur: failedEstimatedCostUsd * rate,
      byAction,
      byFleet,
      byUser,
      byDay,
      budget,
      scopedFleet: scopedFleet ?? null,
      absorbed: await this.absorbedOnWindow(where, rate),
    };
  }

  /**
   * Ce que l'abonnement local a ABSORBÉ sur la fenêtre — le pendant du coût facturé.
   *
   * Sans ce bloc, basculer un traitement vers un agent local ferait simplement TOMBER la dépense,
   * et la page ne saurait pas distinguer « c'est devenu gratuit » de « c'est en panne ». Les deux
   * produisent la même courbe.
   *
   * ── Ce qui est mesuré, ce qui est estimé ────────────────────────────────────────
   * `localCalls` et `localResults` sont MESURÉS : ce sont des lignes en base (réussies : un
   * travail de la file mort en `echec` n'a rien absorbé, il est compté dans les échecs).
   * `estimatedCostUsd` est une ESTIMATION, et elle le reste. Deux sources, dans cet ordre :
   *   1. les tokens réellement enregistrés sur la ligne → tarif EXACT de la grille. C'est le cas
   *      de toutes les lignes du poste depuis le 05/09 (C3 point 3 : la CLI rend ses jetons réels).
   *      ⚠️ Ces jetons incluent le contexte propre de Claude Code — ≈ 28 000 jetons de cache par
   *      appel — que la page annonce : le montant dit ce que le poste a consommé, pas ce qu'un
   *      appel API nu aurait coûté ;
   *   2. à défaut, le coût moyen RÉELLEMENT constaté pour la même action via l'API sur les
   *      90 DERNIERS JOURS — pas toute l'histoire : la référence d'avril (Opus 4.8 à 0,0104 $ le
   *      récit) ne décrit plus le travail d'aujourd'hui (Sonnet 5 à 2/10 $). Se limiter à la
   *      fenêtre affichée priverait en revanche de référence toute fenêtre où l'API n'a rien
   *      tourné — c'est-à-dire exactement le cas qu'on cherche à décrire une fois la bascule finie.
   * Une action sans aucune référence n'est PAS estimée : elle est nommée dans
   * `actionsSansReference` et n'entre pas dans le total. Un total incomplet et annoncé vaut mieux
   * qu'un chiffre rond inventé.
   */
  private async absorbedOnWindow(where: Prisma.AiUsageLogWhereInput, rate: number): Promise<AiUsageAbsorbedDto> {
    const vide: AiUsageAbsorbedDto = {
      localCalls: 0, localResults: null, estimatedCostUsd: null, estimatedCostEur: null, actionsSansReference: [],
      callsWithTokens: 0, callsEstimated: 0,
    };
    try {
      const local = await this.prisma.aiUsageLog.groupBy({
        by: ['action', 'model'],
        where: { ...where, executor: 'local', ok: true },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, resultCount: true },
      });
      if (local.length === 0) return vide;

      const refRows = await this.prisma.aiUsageLog.groupBy({
        by: ['action'],
        where: { executor: 'api', ok: true, createdAt: { gte: new Date(Date.now() - 90 * 24 * 3_600_000) } },
        _avg: { costUsd: true },
      });
      const refByAction = new Map(refRows.map((r) => [r.action, r._avg.costUsd ?? 0]));

      let calls = 0;
      let results = 0;
      let resultsMesures = false;
      let estimation = 0;
      let avecJetons = 0;
      let estimes = 0;
      const sansReference = new Set<string>();

      for (const r of local) {
        calls += r._count._all;
        if (r._sum.resultCount != null) {
          results += r._sum.resultCount;
          resultsMesures = true;
        }
        const i = r._sum.inputTokens ?? 0;
        const o = r._sum.outputTokens ?? 0;
        const cw = r._sum.cacheWriteTokens ?? 0;
        const cr = r._sum.cacheReadTokens ?? 0;
        if (i + o + cw + cr > 0) {
          estimation += this.computeCostUsd(r.model, i, o, cw, cr);
          avecJetons += r._count._all;
          continue;
        }
        const moyenne = refByAction.get(r.action);
        // `0` est une moyenne légitime (appels gratuits) : seul `undefined` signifie « aucune
        // référence ». Confondre les deux ferait disparaître des actions du signalement.
        if (moyenne === undefined) sansReference.add(ACTION_LABELS[r.action] ?? r.action);
        else {
          estimation += moyenne * r._count._all;
          estimes += r._count._all;
        }
      }

      return {
        localCalls: calls,
        localResults: resultsMesures ? results : null,
        estimatedCostUsd: estimation > 0 ? estimation : null,
        estimatedCostEur: estimation > 0 ? estimation * rate : null,
        actionsSansReference: [...sansReference].sort(),
        callsWithTokens: avecJetons,
        callsEstimated: estimes,
      };
    } catch (e) {
      // La page de coûts ne doit jamais tomber à cause de son propre encart d'information.
      this.logger.warn(`Absorbé local non calculé : ${(e as Error)?.message ?? e}`);
      return vide;
    }
  }

  async logs(
    opts: { limit?: number; before?: string; after?: string; userId?: string; fleetId?: string; action?: string; onlyFailed?: boolean },
    /**
     * ⚠️ `role` sert au MOTIF de l'échec, pas au périmètre. `errorDetail` porte le texte BRUT du
     * fournisseur (« Your credit balance is too low… ») ; TRK-061 l'a précisément retiré de ce que
     * lit un client, pour le réserver au centre d'alerte — un écran de super-admin. Cette page,
     * elle, est ouverte aux administrateurs de société : ils voient la SORTE de l'échec, jamais la
     * phrase du sous-traitant.
     */
    viewer: { isOwner?: boolean | null; role?: string | null } = {},
  ): Promise<AiUsageLogsPageDto> {
    const rate = await this.usdToEur();
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: Prisma.AiUsageLogWhereInput = {};
    if (opts.userId) where.userId = opts.userId;
    if (opts.fleetId) where.fleetId = opts.fleetId;
    if (opts.action) where.action = opts.action;
    // « Échecs seulement » : le filtre qui manquait pendant les trois jours de compte à sec.
    if (opts.onlyFailed) where.ok = false;
    // Fenêtre temporelle : `before` = curseur de pagination (borne haute exclusive) ; `after` = borne
    // basse (filtre JOUR précis). Les deux peuvent coexister (journal borné à un jour + pagination).
    const createdAt: Prisma.DateTimeFilter = {};
    if (opts.before) { const d = new Date(opts.before); if (!Number.isNaN(d.getTime())) createdAt.lt = d; }
    if (opts.after) { const d = new Date(opts.after); if (!Number.isNaN(d.getTime())) createdAt.gte = d; }
    if (createdAt.lt || createdAt.gte) where.createdAt = createdAt;
    // Owner plateforme — appels IA de l'owner exclus pour un viewer non-owner
    // (userId nullable → on conserve les null système).
    if (this.ownerVis.isMasked(viewer)) {
      const ownerIds = await this.ownerVis.getOwnerIds();
      if (ownerIds.length) where.OR = [{ userId: null }, { userId: { notIn: ownerIds } }];
    }
    const rows = await this.prisma.aiUsageLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: take + 1 });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    const fleetIds = [...new Set(page.map((r) => r.fleetId).filter((x): x is string => !!x))];
    const userIds = [...new Set(page.map((r) => r.userId).filter((x): x is string => !!x))];
    const [fleets, users] = await Promise.all([
      fleetIds.length ? this.prisma.fleet.findMany({ where: { id: { in: fleetIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
    ]);
    const fleetName = new Map(fleets.map((f) => [f.id, f.name]));
    const userEmail = new Map(users.map((u) => [u.id, u.email]));

    return {
      rows: page.map((r) => {
        const jetons = r.inputTokens + r.outputTokens + r.cacheWriteTokens + r.cacheReadTokens;
        const estimatedCostUsd = r.ok ? null : r.estimatedCostUsd;
        const motifVisible = viewer.role === UserRole.SUPER_ADMIN;
        return {
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          userId: r.userId,
          userEmail: r.userId ? (userEmail.get(r.userId) ?? null) : null,
          fleetId: r.fleetId,
          fleetName: r.fleetId ? (fleetName.get(r.fleetId) ?? null) : null,
          model: r.model,
          action: r.action,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          costUsd: r.costUsd,
          costEur: r.costUsd * rate,
          latencyMs: r.latencyMs,
          ok: r.ok,
          executor: (r.executor === 'local' ? 'local' : 'api') as AiExecutor,
          // Les lignes d'avant le 05/09 n'ont pas de fournisseur : on le déduit du modèle.
          provider: r.provider ?? fournisseurDuModele(r.model),
          errorKind: r.errorKind ?? null,
          errorDetail: motifVisible ? (r.errorDetail ?? null) : null,
          estimatedCostUsd,
          estimatedCostEur: estimatedCostUsd == null ? null : estimatedCostUsd * rate,
          // Estimé (≈) quand l'échec n'a laissé aucun jeton facturé ; le coût d'une réponse
          // tronquée, lui, vient des jetons réels et s'affiche sans ≈.
          estime: !r.ok && estimatedCostUsd != null && jetons === 0,
        };
      }),
      nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
    };
  }

  // ─── Coût par flotte (visibilité) ──────────────────────────────────────────

  private monthStart(): Date {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Fragment WHERE excluant les appels IA de l'owner plateforme pour un viewer non-owner. IDENTIQUE
   * à la logique de `summary`/`logs` : sans lui, la DÉPENSE DU MOIS (budget) trahirait un coût masqué
   * (delta entre « dépensé » et Σ des lignes par utilisateur). `userId` NULLABLE (appels système) → on
   * conserve les null. Masque par DÉFAUT (viewer omis = non-owner) : sûr.
   */
  private async ownerAiExclusion(viewer: { isOwner?: boolean | null }): Promise<Prisma.AiUsageLogWhereInput> {
    if (!this.ownerVis.isMasked(viewer)) return {};
    const ownerIds = await this.ownerVis.getOwnerIds();
    return ownerIds.length ? { OR: [{ userId: null }, { userId: { notIn: ownerIds } }] } : {};
  }

  /**
   * Dépense IA (USD) d'une flotte depuis le 1er du mois courant (owner exclu pour un viewer non-owner).
   * Somme `costUsd` seulement — l'argent réel ; les estimations d'échec restent hors de tout budget.
   */
  private async fleetMonthSpendUsd(fleetId: string, viewer: { isOwner?: boolean | null } = {}): Promise<number> {
    const agg = await this.prisma.aiUsageLog.aggregate({
      where: { fleetId, createdAt: { gte: this.monthStart() }, ...(await this.ownerAiExclusion(viewer)) },
      _sum: { costUsd: true },
    });
    return agg._sum.costUsd ?? 0;
  }

  /** Coût IA (€) d'une flotte depuis le 1er du mois — pour la ⚙️ agenda + les vues scopées. */
  async monthCostEur(fleetId: string, viewer: { isOwner?: boolean | null } = {}): Promise<number> {
    return (await this.fleetMonthSpendUsd(fleetId, viewer)) * (await this.usdToEur());
  }

  /** Vue budget SCOPÉE flotte : pas de plafond par flotte (visibilité seule), juste la dépense du mois. */
  private async fleetBudgetView(fleetId: string, rate: number, viewer: { isOwner?: boolean | null } = {}): Promise<AiUsageBudgetDto> {
    const usd = await this.fleetMonthSpendUsd(fleetId, viewer);
    return {
      monthlyBudgetEur: 0,
      spentThisMonthEur: usd * rate,
      spentThisMonthUsd: usd,
      status: 'none',
      usdToEurRate: rate,
      updatedAt: null,
    };
  }

  // ─── Budget mensuel (singleton) ────────────────────────────────────────────

  async getBudget(viewer: { isOwner?: boolean | null } = {}): Promise<AiUsageBudgetDto> {
    const rate = await this.usdToEur();
    const row = await this.prisma.aiBudget.findFirst({ orderBy: { updatedAt: 'desc' } });
    const monthlyBudgetEur = row?.monthlyBudgetEur ?? 0;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    // Owner plateforme exclu de la dépense du mois pour un viewer non-owner (cohérent avec summary/logs).
    // ⚠️ `costUsd` seulement : l'argent réel. `estimatedCostUsd` (échecs) n'entre jamais ici.
    const agg = await this.prisma.aiUsageLog.aggregate({ where: { createdAt: { gte: monthStart }, ...(await this.ownerAiExclusion(viewer)) }, _sum: { costUsd: true } });
    const spentThisMonthUsd = agg._sum.costUsd ?? 0;
    const spentThisMonthEur = spentThisMonthUsd * rate;
    let status: AiBudgetStatus = 'none';
    if (monthlyBudgetEur > 0) {
      const ratio = spentThisMonthEur / monthlyBudgetEur;
      status = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok';
    }
    return {
      monthlyBudgetEur,
      spentThisMonthEur,
      spentThisMonthUsd,
      status,
      usdToEurRate: rate,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Règle le plafond mensuel (€) et, s'il est fourni, le taux USD→€ (0,5 à 1,5 — au-delà c'est
   * une faute de frappe, pas un taux de change ; on ne touche alors pas au taux enregistré).
   */
  async setBudget(
    reglage: { monthlyBudgetEur: number; usdToEurRate?: number },
    userId?: string,
    viewer: { isOwner?: boolean | null } = {},
  ): Promise<AiUsageBudgetDto> {
    const value = Number.isFinite(reglage.monthlyBudgetEur) && reglage.monthlyBudgetEur >= 0 ? reglage.monthlyBudgetEur : 0;
    const taux = reglage.usdToEurRate;
    const tauxValide = typeof taux === 'number' && Number.isFinite(taux) && taux >= 0.5 && taux <= 1.5 ? taux : undefined;
    const data = { monthlyBudgetEur: value, updatedByUserId: userId ?? null, ...(tauxValide !== undefined ? { usdToEurRate: tauxValide } : {}) };
    const existing = await this.prisma.aiBudget.findFirst();
    if (existing) {
      await this.prisma.aiBudget.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.aiBudget.create({ data });
    }
    // Le taux vient peut-être de changer : la prochaine lecture doit le voir, pas le cache.
    if (tauxValide !== undefined) this.tauxCache = null;
    return this.getBudget(viewer);
  }
}
