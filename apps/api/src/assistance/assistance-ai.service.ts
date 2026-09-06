import { Injectable, Logger } from '@nestjs/common';
import { AiTraceService } from '../ai-traces/ai-trace.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { classerEchecIa, type AiErrorKind, type NiveauEchecIa } from '../ai/ai-client.types';
import { AiRouter } from '../ai/ai-router.service';
import type { AuthUser } from '../auth/types/auth-user';
import { ErrorLogger } from '../observability/error-logger.service';
import { AssistanceContextService, type ContextBundle } from './assistance-context.service';
import { contenuSujets } from './knowledge/tracky-knowledge';
import {
  CLASSEMENT_SCHEMA,
  REPONSE_INDISPONIBLE,
  REPONSE_SCHEMA,
  REPONSE_URGENCE,
  renderClassementSystem,
  renderReponseSystem,
} from './prompts/assistance.prompt';

/** Source dédiée dans le centre d'alerte (filtrable). */
const SOURCE = 'ASSISTANCE';
/** Action journalisée dans les coûts IA — l'assistance est le seul poste qui dépense en direct. */
const ACTION = 'support_chat';
/** Messages d'historique repassés au modèle. Au-delà, on paie du contexte que personne ne relit. */
const HISTORIQUE_MAX = 6;
/** Longueur maximale d'une réponse conservée. Le prompt demande 2-4 phrases ; ceci est le filet. */
const REPONSE_MAX = 1200;
/** Longueur maximale d'une question transmise au modèle (anti-bourrage de contexte). */
const QUESTION_MAX = 2000;

export type Gravite = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AssistanceMessageEntree {
  role: 'user' | 'assistant' | 'admin';
  content: string;
}

/**
 * TRK-070 — POURQUOI l'assistant a rendu la main, quand ce n'est PAS une décision de contenu.
 *
 * Une escalade a deux natures que rien ne distinguait : l'assistant juge sur le CONTENU qu'un
 * humain doit reprendre (vrai signal produit), ou bien un appel IA vient d'échouer et l'escalade
 * n'est qu'un REPLI sur un incident **déjà consigné**. Le second cas produisait une seconde ligne
 * `ERROR` quatorze millisecondes après la ligne `DEGRADATION` de l'incident — et la recomptait
 * comme un défaut, annulant le bénéfice du correctif de TRK-061.
 *
 * Renseigné → l'escalade est un repli technique, et le centre d'alerte doit la classer au niveau
 * DÉJÀ décidé pour l'incident d'origine. Absent → escalade de contenu, qui garde `ERROR`.
 */
export interface CauseTechniqueEscalade {
  /** Niveau déjà retenu pour l'incident d'origine (`classerEchecIa`). */
  niveau: NiveauEchecIa;
  /** Sorte d'échec, conservée pour que la ligne d'escalade reste diagnosticable. */
  kind?: AiErrorKind;
}

export interface AssistanceReponse {
  reponse: string;
  escalade: boolean;
  motifEscalade: string | null;
  /**
   * TRK-070 — présent uniquement quand l'escalade est un REPLI sur un échec technique déjà
   * journalisé. Le service d'assistance s'en sert pour ne pas re-hausser l'incident en `ERROR`.
   */
  causeTechnique?: CauseTechniqueEscalade | null;
  gravite: Gravite;
  /** Titre court déduit de la demande — sert la liste de suivi en espace admin. */
  titre: string;
  /** Sujets de connaissance réellement employés. */
  sujets: string[];
  /** Audit : ce qui a été lu, et ce qui a été refusé. Jamais les données elles-mêmes. */
  contextUsed: Array<{ key: string; volume: number; refuse: boolean }>;
  model: string | null;
  costUsd: number;
  latencyMs: number;
  /** true quand aucune IA n'a été appelée (urgence, ou assistance indisponible). */
  sansIa: boolean;
}

type Classement = {
  sujets: string[];
  contexte: string[];
  horsSujet: boolean;
  urgence: boolean;
  titre: string;
};

type Redaction = {
  reponse: string;
  escalade: boolean;
  motifEscalade?: string;
  gravite: Gravite;
};

const GRAVITES: readonly Gravite[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * Assistance IA — le moteur de réponse, en DEUX temps.
 *
 * ── Pourquoi deux appels plutôt qu'une boucle d'outils ───────────────────────────────
 *   1. CLASSEMENT — le modèle lit la question et dit ce qu'il faut consulter : des sujets de
 *      connaissance, et des lots de données sur le demandeur. Il ne voit encore AUCUNE donnée.
 *   2. RÉDACTION — le serveur a chargé les lots (scopés sur le demandeur), le modèle rédige.
 *
 * Le modèle ne fournit jamais d'identifiant : il choisit des clés dans deux listes fermées. Une
 * question habilement tournée n'a donc aucun paramètre à détourner pour atteindre les données
 * d'une autre société. C'est structurel, pas déclaratif — un prompt n'est pas un contrôle d'accès.
 *
 * Corollaire agréable : le coût d'une question est BORNÉ à deux appels, là où une boucle d'outils
 * a une longueur qu'on ne connaît qu'après coup.
 *
 * ── Ce service ne lève jamais ────────────────────────────────────────────────────────
 * Une conversation d'assistance qui renvoie une erreur 500 est pire que pas d'assistance : la
 * personne a déjà un problème, elle vient d'en trouver un second. Tout échec se traduit par un
 * message honnête et une trace au centre d'alerte.
 */
@Injectable()
export class AssistanceAiService {
  private readonly logger = new Logger(AssistanceAiService.name);

  constructor(
    private readonly ai: AiRouter,
    private readonly aiUsage: AiUsageService,
    private readonly contexte: AssistanceContextService,
    private readonly errorLogger: ErrorLogger,
    private readonly traces: AiTraceService,
  ) {}

  /** Vrai si un moteur est configuré côté serveur. L'écran s'en sert pour ne pas proposer un chat mort. */
  disponible(): boolean {
    return this.ai.isConfigured();
  }

  async repondre(
    user: AuthUser,
    question: string,
    historique: readonly AssistanceMessageEntree[] = [],
  ): Promise<AssistanceReponse> {
    const demande = (question ?? '').trim().slice(0, QUESTION_MAX);
    if (!demande) return this.sansIaReponse(REPONSE_INDISPONIBLE, 'LOW', false, 'Message vide');
    if (!this.ai.isConfigured()) {
      // Une IA non configurée est un ÉTAT VOULU, pas une panne : personne n'a de bug à corriger.
      // Même raisonnement que `no_key` côté routeur — la ligne est écrite, elle ne compte pas
      // comme un défaut.
      return this.sansIaReponse(REPONSE_INDISPONIBLE, 'LOW', true, 'Assistance IA non configurée', {
        niveau: 'DEGRADATION',
        kind: 'no_key',
      });
    }

    const recents = historique.slice(-HISTORIQUE_MAX).map((m) => ({ role: m.role, contenu: m.content.slice(0, 1500) }));
    let coutTotal = 0;
    let latenceTotale = 0;
    let modele: string | null = null;
    // Ce que le routeur écrit sur chaque ligne d'échec (C3 point 5) : la même identité que la
    // ligne de succès, pour que refus et réponses se rangent au même endroit de la page.
    const trace = { action: ACTION, userId: user.id, fleetId: user.fleetId };

    // ── 1. Classement ──────────────────────────────────────────────────────────
    let plan: Classement;
    try {
      const appel = await this.ai.completeJson<Classement>({
        system: renderClassementSystem(),
        // Le message est encadré et ANNONCÉ comme donnée : c'est la première ligne de défense
        // contre une consigne glissée dans la question.
        userPayload: { messageUtilisateur: demande, historique: recents },
        schema: CLASSEMENT_SCHEMA,
        maxTokens: 400,
        // Trier une question ne demande pas de réflexion longue, et cette réflexion se facture
        // en SORTIE. On laisse le modèle par défaut (le fournisseur peut changer), on baisse
        // l'effort : c'est le levier qui ne dépend d'aucun nom de modèle codé en dur.
        effort: 'low',
      }, { trace });
      plan = this.normaliserClassement(appel.result);
      coutTotal += this.aiUsage.costOf(appel.model, appel.usage);
      latenceTotale += appel.latencyMs;
      modele = appel.model;
      void this.aiUsage.record({
        userId: user.id, fleetId: user.fleetId, action: ACTION, model: appel.model, executor: 'api', provider: appel.provider,
        inputTokens: appel.usage.inputTokens, outputTokens: appel.usage.outputTokens,
        cacheWriteTokens: appel.usage.cacheWriteTokens, cacheReadTokens: appel.usage.cacheReadTokens,
        latencyMs: appel.latencyMs, ok: true,
      });
    } catch (e) {
      const cause = await this.tracerErreur(e, user, 'classement');
      return this.sansIaReponse(REPONSE_INDISPONIBLE, 'LOW', true, 'Classement indisponible', cause);
    }

    // ── Urgence : on ne fait PAS rédiger ───────────────────────────────────────
    // Une urgence ne se rédige pas à la volée. Générer trois phrases empathiques prend quelques
    // secondes pendant lesquelles personne n'a été prévenu — et le texte pourrait laisser croire
    // que quelque chose a été déclenché. On renvoie un message fixe qui pousse vers l'humain.
    if (plan.urgence) {
      return {
        reponse: REPONSE_URGENCE,
        escalade: true,
        motifEscalade: 'Situation critique décrite par l\'utilisateur — reprise humaine immédiate.',
        gravite: 'CRITICAL',
        titre: plan.titre || 'Demande urgente',
        sujets: [],
        contextUsed: [],
        model: modele,
        costUsd: coutTotal,
        latencyMs: latenceTotale,
        sansIa: false,
      };
    }

    // ── 2. Lecture du contexte, côté SERVEUR ───────────────────────────────────
    // Une question hors sujet ne justifie aucune lecture de données : on recadre, on ne fouille pas.
    const lots: ContextBundle[] = plan.horsSujet ? [] : await this.contexte.build(user, plan.contexte);
    const sujets = contenuSujets(plan.sujets);

    // ── 3. Rédaction ───────────────────────────────────────────────────────────
    try {
      const appel = await this.ai.completeJson<Redaction>({
        system: renderReponseSystem(sujets.map((s) => ({ titre: s.titre, contenu: s.contenu }))),
        userPayload: {
          messageUtilisateur: demande,
          historique: recents,
          // Les lots partent avec leur libellé ET leur éventuel refus : le modèle doit pouvoir
          // dire « je n'ai pas pu vérifier » au lieu de conclure « il n'y a rien ».
          donneesDuDemandeur: lots.map((l) => ({
            lot: l.key,
            contenu: l.libelle,
            refuse: l.refus ?? null,
            donnees: l.data,
          })),
        },
        schema: REPONSE_SCHEMA,
        maxTokens: 900,
        effort: 'low',
      }, { trace });
      const r = this.normaliserRedaction(appel.result);
      coutTotal += this.aiUsage.costOf(appel.model, appel.usage);
      latenceTotale += appel.latencyMs;
      modele = appel.model;
      void this.aiUsage.record({
        userId: user.id, fleetId: user.fleetId, action: ACTION, model: appel.model, executor: 'api', provider: appel.provider,
        inputTokens: appel.usage.inputTokens, outputTokens: appel.usage.outputTokens,
        cacheWriteTokens: appel.usage.cacheWriteTokens, cacheReadTokens: appel.usage.cacheReadTokens,
        latencyMs: appel.latencyMs, ok: true, resultCount: 1,
      });
      void this.conserverTrace(user, demande, recents, plan, lots, appel.model, appel.latencyMs, r);
      return {
        ...r,
        titre: plan.titre || 'Demande d\'assistance',
        sujets: sujets.map((s) => s.key),
        contextUsed: lots.map((l) => ({ key: l.key, volume: l.volume, refuse: !!l.refus })),
        model: appel.model,
        costUsd: coutTotal,
        latencyMs: latenceTotale,
        sansIa: false,
      };
    } catch (e) {
      const cause = await this.tracerErreur(e, user, 'redaction');
      void this.traces.record({
        action: ACTION, executor: 'api', model: modele, fleetId: user.fleetId,
        input: this.entreeTracable(demande, recents, plan, lots),
        error: e instanceof Error ? e.message : String(e),
        verdict: 'rejete', verdictNote: 'Appel de rédaction en échec',
      });
      return {
        ...this.sansIaReponse(REPONSE_INDISPONIBLE, 'LOW', true, 'Rédaction indisponible', cause),
        titre: plan.titre || 'Demande d\'assistance',
        // Le classement a bien eu lieu et a été facturé : on le remonte, sinon le coût
        // apparaîtrait nulle part et la facture ne serait plus explicable.
        costUsd: coutTotal,
        latencyMs: latenceTotale,
        model: modele,
      };
    }
  }

  // ─── Normalisation ─────────────────────────────────────────────────────────

  /**
   * Le schéma garantit la FORME, pas le sens : rien n'empêche le modèle de renvoyer 40 clés
   * inventées. On borne ici, et les clés inconnues sont éliminées plus loin par les listes fermées.
   */
  private normaliserClassement(r: Partial<Classement> | null | undefined): Classement {
    const liste = (v: unknown, cap: number): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, cap) : [];
    return {
      sujets: liste(r?.sujets, 3),
      contexte: liste(r?.contexte, 5),
      horsSujet: r?.horsSujet === true,
      urgence: r?.urgence === true,
      titre: typeof r?.titre === 'string' ? r.titre.trim().slice(0, 120) : '',
    };
  }

  private normaliserRedaction(r: Partial<Redaction> | null | undefined): Omit<AssistanceReponse, 'titre' | 'sujets' | 'contextUsed' | 'model' | 'costUsd' | 'latencyMs' | 'sansIa'> {
    const texte = typeof r?.reponse === 'string' ? r.reponse.trim().slice(0, REPONSE_MAX) : '';
    const escalade = r?.escalade === true;
    const motif = typeof r?.motifEscalade === 'string' ? r.motifEscalade.trim().slice(0, 400) : '';
    // Gravité inconnue → MEDIUM, jamais LOW. Un défaut « anodin » sur une valeur qu'on n'a pas
    // comprise ferait passer sous le radar exactement ce qu'on cherche à voir remonter.
    const gravite: Gravite = GRAVITES.includes(r?.gravite as Gravite) ? (r!.gravite as Gravite) : 'MEDIUM';
    return {
      // Une réponse vide n'est pas une réponse : on bascule sur l'escalade plutôt que d'afficher
      // un blanc que l'utilisateur interpréterait comme une panne.
      reponse: texte || 'Je n\'ai pas de réponse fiable à vous donner sur ce point. Un conseiller va reprendre votre demande.',
      escalade: texte ? escalade : true,
      motifEscalade: escalade || !texte ? motif || 'Réponse non concluante.' : null,
      gravite,
    };
  }

  private sansIaReponse(
    texte: string,
    gravite: Gravite,
    escalade: boolean,
    motif: string,
    // TRK-070 — renseigné quand l'escalade n'est qu'un repli sur un incident DÉJÀ consigné.
    causeTechnique: CauseTechniqueEscalade | null = null,
  ): AssistanceReponse {
    return {
      reponse: texte,
      escalade,
      motifEscalade: escalade ? motif : null,
      causeTechnique: escalade ? causeTechnique : null,
      gravite,
      titre: 'Demande d\'assistance',
      sujets: [],
      contextUsed: [],
      model: null,
      costUsd: 0,
      latencyMs: 0,
      sansIa: true,
    };
  }

  /**
   * Ce qui part dans la trace.
   *
   * ⚠️ Les LOTS DE DONNÉES sont réduits à leur résumé d'audit — clé, volume, refus — et jamais
   * recopiés. Ils contiennent l'activité réelle, les erreurs et les trajets d'une personne :
   * les archiver ici en créerait une SECONDE COPIE, hors de sa table d'origine, hors des règles
   * de rétention qui la gouvernent, et hors du mode vie privée.
   *
   * Ce qu'on perd : le rejeu à l'identique. Ce qu'on garde : la question, les sujets retenus et
   * les lots consultés — c'est-à-dire ce qui permet de comprendre POURQUOI une réponse est
   * mauvaise. Une réponse hors sujet vient presque toujours d'un mauvais classement ou d'une
   * connaissance manquante, pas d'une valeur particulière dans les données du demandeur.
   */
  private entreeTracable(
    question: string,
    historique: Array<{ role: string; contenu: string }>,
    plan: Classement,
    lots: ContextBundle[],
  ): unknown {
    return {
      question,
      historique,
      sujetsRetenus: plan.sujets,
      horsSujet: plan.horsSujet,
      lotsConsultes: lots.map((l) => ({ lot: l.key, volume: l.volume, refuse: l.refus ?? null })),
    };
  }

  private async conserverTrace(
    user: AuthUser,
    question: string,
    historique: Array<{ role: string; contenu: string }>,
    plan: Classement,
    lots: ContextBundle[],
    model: string,
    latencyMs: number,
    reponse: { reponse: string; escalade: boolean; gravite: Gravite },
  ): Promise<void> {
    await this.traces.record({
      action: ACTION,
      executor: 'api',
      model,
      fleetId: user.fleetId,
      input: this.entreeTracable(question, historique, plan, lots),
      output: reponse,
      latencyMs,
      // Une escalade n'est pas un échec technique, mais c'est un cas à RELIRE : l'agent a rendu
      // la main. C'est exactement le lot qu'on veut retrouver pour l'améliorer.
      verdict: reponse.escalade ? 'rejete' : 'concluant',
      verdictNote: reponse.escalade ? 'Reprise humaine demandée par l\'assistant' : null,
    });
  }

  /**
   * Journalise l'échec au centre d'alerte ET **rend sa classification**, pour que l'escalade qui
   * suit soit cotée sur la CAUSE et non sur la gravité de la conversation (TRK-070).
   */
  private async tracerErreur(e: unknown, user: AuthUser, phase: string): Promise<CauseTechniqueEscalade> {
    const err = e instanceof Error ? e : new Error(String(e));
    this.logger.warn(`Assistance (${phase}) : ${err.message}`);
    // Le NIVEAU est celui décidé par la couche IA, et le motif du fournisseur part dans le
    // contexte (C3 point 5) : jusqu'au 05/09 l'assistance archivait tout en ERROR, un compte à
    // sec compris — le même incident sortait en DEGRADATION par l'optimiseur.
    const { niveau, kind, motifFournisseur } = classerEchecIa(err);
    await this.errorLogger
      .record(err, SOURCE, { phase, userId: user.id, fleetId: user.fleetId ?? undefined, kind, motifFournisseur }, niveau)
      .catch(() => {
        /* la supervision ne doit jamais faire tomber ce qu'elle supervise */
      });
    return { niveau, kind };
  }
}
