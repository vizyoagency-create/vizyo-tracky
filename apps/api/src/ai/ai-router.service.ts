import { AiUsageService } from '../ai-usage/ai-usage.service';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ErrorLogger } from '../observability/error-logger.service';
import { CLES_REFROIDISSEMENT, RefroidissementAlerteService } from '../observability/refroidissement-alerte.service';
import { AnthropicClient } from './anthropic.client';
import { OpenAiClient } from './openai.client';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import type {
  AiClient,
  AiJsonRequest,
  AiJsonResult,
  AiProvider,
  AiProviderMode,
  KindRepli,
  NiveauEchecIa,
} from './ai-client.types';
import { AiServiceError, estRepliable } from './ai-client.types';

/**
 * Ce que l'appelant sait de son appel — repris au centre d'alerte quand le routeur bascule, et
 * sur CHAQUE ligne d'échec écrite dans `ai_usage_logs` (C3 point 5). `action` est obligatoire :
 * c'est le vocabulaire de la page « Coûts IA », et un échec sans action ne se range nulle part.
 */
export interface AiRunTrace {
  /** Action métier (`agenda_agent`, `trip_analysis`, `placement`…) : le vocabulaire d'`ai_usage_logs`. */
  action: string;
  userId?: string | null;
  fleetId?: string | null;
}

/** Options d'un appel routé. */
export interface AiRunOptions {
  /**
   * Moteur IMPOSÉ — pas une préférence, malgré le nom (conservé : les appelants ne changent pas).
   *
   * Posé par « Comparer » (le même trajet par Claude ET GPT, côte à côte) et par l'ensemble du
   * mode mixte, qui ÉTIQUETTENT chaque résultat du nom du moteur demandé. Un résultat GPT ne doit
   * jamais s'afficher sous l'étiquette Claude : quand ce champ est fourni, AUCUN repli n'a lieu,
   * et si le moteur imposé n'a pas de clé, c'est SON client qui lève un `no_key` clair — jamais
   * un autre moteur à sa place (c'est pourtant ce que faisait `pick()` avant C3 : « Comparer »
   * sans clé OpenAI affichait un récit Claude dans la colonne GPT).
   */
  preferProvider?: AiProvider;
  /**
   * Autorise la bascule vers un autre moteur configuré quand le premier REFUSE (`REPLI_KINDS`).
   * Défaut `true`. Forcé à `false` dès que `preferProvider` est fourni — voir ci-dessus.
   */
  fallback?: boolean;
  /**
   * Contexte porté au centre d'alerte et sur les lignes d'échec. Rempli par les appelants
   * (C3 point 5) ; un appelant qui l'oublie voit ses échecs rangés sous l'action `inconnu`, avec
   * un avertissement dans le journal — jamais perdus.
   */
  trace?: AiRunTrace;
}

/** État d'un moteur vu du routeur — pour la carte « Moteur IA » de la page « Coûts IA ». */
export interface EtatFournisseur {
  /** Une clé est présente côté serveur. */
  configure: boolean;
  /** Présent si le moteur est mis à l'écart après un refus ; absent sinon. */
  quarantaine?: { kind: KindRepli; jusqua: string };
}

/**
 * ══ QUARANTAINE — ne pas refrapper à une porte qu'on sait fermée ═══════════════════════════
 *
 * Après un refus, le moteur est mis à l'écart EN MÉMOIRE : tant qu'un autre candidat existe, on
 * ne lui envoie plus rien — aucun appel réseau, aucune latence ajoutée. Un compte à sec répond en
 * quelques centaines de millisecondes, mais le cron horaire de récits enchaîne des dizaines
 * d'appels : sans quarantaine, chacun paierait ce refus avant de basculer.
 *
 * Deux durées, selon que la cause GUÉRIT SEULE ou non :
 *  - `provider_unfunded`, `invalid_key`, `no_key` : 15 min. Recharger un compte ou poser une clé
 *    est un geste humain — l'incident du 03/09 a duré plus de deux jours. Quinze minutes bornent
 *    le délai de reprise APRÈS le geste, sans marteler un refus certain entre-temps.
 *  - `quota`, `overloaded` : 60 s. Un 429 ou un 529 se résorbe en secondes ; au-delà d'une minute
 *    on préfère revenir au moteur réglé, qui a le tarif, le modèle et le cache voulus.
 *
 * À l'expiration, UNE tentative : si elle échoue, la quarantaine repart. Si TOUS les candidats
 * sont à l'écart, on tente quand même le premier — une quarantaine est un raccourci, jamais un
 * interblocage. Volatile par construction : un redémarrage remet à zéro, et c'est voulu (le seul
 * coût est un appel refusé de plus, non facturé).
 */
const QUARANTAINE_LONGUE_MS = 15 * 60_000;
const QUARANTAINE_COURTE_MS = 60_000;
const QUARANTAINE_PAR_KIND: Readonly<Record<KindRepli, number>> = {
  provider_unfunded: QUARANTAINE_LONGUE_MS,
  invalid_key: QUARANTAINE_LONGUE_MS,
  no_key: QUARANTAINE_LONGUE_MS,
  quota: QUARANTAINE_COURTE_MS,
  overloaded: QUARANTAINE_COURTE_MS,
};

/**
 * Un repli réussi écrit UNE ligne au centre d'alerte par (moteur, sorte) et par 6 h — la cadence
 * déjà retenue pour Overpass (`speed-limit`) : l'épisode est visible, et le cron de récits qui
 * bascule quarante fois dans l'heure ne l'écrit pas quarante fois.
 */
const REFROIDISSEMENT_REPLI_MS = 6 * 3_600_000;

/**
 * ══ C3 point 5 — UN ÉCHEC PASSAGER TOTAL SE VOIT, SANS BRUIT ═══════════════════════════════
 *
 * `ErrorLogger` n'archive JAMAIS une erreur `transient` (429, 529, délai, réseau, plafond
 * mensuel) : c'est voulu depuis le 2026-07-20, ces échecs ne sont ni un bug ni une action à
 * mener. Mais « jamais archivé » était devenu « jamais vu » : un fournisseur saturé toute une
 * nuit ne laissait aucune trace au centre d'alerte. Quand TOUTES les tentatives échouent sur une
 * erreur passagère, le routeur écrit donc lui-même UNE ligne DEGRADATION — écrite, datée,
 * consultable, pas comptée comme un défaut (TRK-037) — par (moteur, sorte) et par heure.
 * Les erreurs NON passagères restent archivées par les appelants (marqueur RECORDED : pas de
 * doublon), avec leur niveau.
 */
const REFROIDISSEMENT_ECHEC_PASSAGER_MS = 3_600_000;
/**
 * Clé de refroidissement des échecs passagers, suffixée `:<moteur>:<sorte>`. Identifiant
 * PERSISTANT (la renommer remettrait le garde à zéro) : a vocation à rejoindre
 * `CLES_REFROIDISSEMENT` sous ce nom exact.
 */
const CLE_ECHEC_PASSAGER: string = CLES_REFROIDISSEMENT.AI_ECHEC_PASSAGER;
/** Nom du « moteur » sur une ligne d'échec levée par le plafond mensuel, avant tout fournisseur. */
const MOTEUR_PLAFOND = 'plafond';

/** Source des lignes du routeur au centre d'alerte. */
const SOURCE_ALERTE = 'AI_ROUTER';

/** Action rangée sur les échecs d'un appelant qui n'a pas transmis de `trace`. */
const ACTION_INCONNUE = 'inconnu';

/** Trace complétée : toujours une action, même quand l'appelant a oublié la sienne. */
type TraceResolue = { action: string; userId: string | null; fleetId: string | null };

/**
 * Jetons d'entrée ESTIMÉS d'une requête qui n'a reçu aucune réponse : longueur du prompt
 * système et des données, à 4 caractères par jeton (l'ordre de grandeur usuel pour du texte et
 * du JSON). Le schéma de sortie n'est pas compté — l'estimation est SIMPLE, et assumée telle.
 */
export function estimerJetonsEntree(req: AiJsonRequest): number {
  let caracteres = (req.system ?? '').length;
  try {
    caracteres += JSON.stringify(req.userPayload ?? null)?.length ?? 0;
  } catch {
    /* charge utile non sérialisable (cycle) : on ne compte que le prompt système */
  }
  return Math.ceil(caracteres / 4);
}

/**
 * Routeur IA (2026-07) — point d'entrée UNIQUE de tous les appels IA de l'app. DROP-IN de
 * `AnthropicClient` (même `isConfigured()` + `completeJson()`), pour que les appelants existants
 * (agenda, optimiseur, booking vocal, rapports, analyse de trajets) basculent sans changer de code.
 *
 * Choix du moteur, dans l'ordre : (1) `preferProvider` de l'appel (imposé, sans repli), (2) le
 * mode GLOBAL réglé dans « Coûts IA », (3) `claude`, (4) `gpt` — restreint aux moteurs CONFIGURÉS.
 * Si aucun n'a de clé, on délègue au moteur réglé qui lèvera un 503 `no_key` clair. Le `provider`
 * réellement utilisé est renvoyé dans le résultat (attribution de coût + UI « qui a répondu »).
 *
 * ══ C3 point 1 (2026-09-05) — LE ROUTEUR BASCULE QUAND UN MOTEUR REFUSE ═══════════════════
 *
 * Avant, `pick()` élisait UN moteur (le premier configuré) et l'appel mourait avec lui. Relevé
 * du 05/09 : la clé Anthropic refusée depuis le 03/09 (compte à sec), une clé OpenAI VALIDE à
 * côté, et l'agent d'agenda en mode dégradé depuis le 04/09. On essaie désormais les candidats
 * dans l'ordre ; un REFUS (`REPLI_KINDS` : rien n'a été facturé) passe au suivant, tout autre
 * échec remonte tel quel. Voir `AiRunOptions.preferProvider` pour l'exception, et la quarantaine
 * ci-dessus pour ne pas repayer un refus certain à chaque appel.
 *
 * ══ C3 point 5 (2026-09-05) — CHAQUE ÉCHEC EST UNE LIGNE ═════════════════════════════════
 *
 * Seul point de passage, donc seul endroit où AUCUN échec ne peut être oublié : chaque tentative
 * de fournisseur qui échoue — y compris celles suivies d'un repli réussi, et le plafond mensuel
 * levé avant tout appel — écrit une ligne `ok = false` dans `ai_usage_logs` (sorte, motif,
 * fournisseur, coût réel si le fournisseur a facturé, estimation sinon). Jusqu'au 05/09, la table
 * n'avait jamais porté un échec : trois jours de compte à sec sans une ligne sur la page.
 */
@Injectable()
export class AiRouter {
  private readonly logger = new Logger(AiRouter.name);

  /** Moteurs mis à l'écart : jusqu'à quand (epoch ms) et pourquoi. Cf. QUARANTAINE ci-dessus. */
  private readonly quarantaines = new Map<AiProvider, { jusqua: number; kind: KindRepli }>();

  constructor(
    private readonly anthropic: AnthropicClient,
    private readonly openai: OpenAiClient,
    private readonly settings: AiProviderSettingsService,
    private readonly usage: AiUsageService,
    // Fournis par l'ObservabilityModule (@Global). Optionnels : les jeux d'essai construisent le
    // routeur à la main avec quatre dépendances, et un repli sans centre d'alerte reste un repli.
    @Optional() private readonly errorLogger?: ErrorLogger,
    @Optional() private readonly refroidissement?: RefroidissementAlerteService,
  ) {}

  /** L'IA est disponible dès qu'AU MOINS un provider a une clé (l'app active alors sa couche IA). */
  isConfigured(): boolean {
    return this.anthropic.isConfigured() || this.openai.isConfigured();
  }

  /** Disponibilité par provider (clé présente côté serveur) — pour l'UI du switch « Coûts IA ». */
  availability(): Record<AiProvider, boolean> {
    return { claude: this.anthropic.isConfigured(), gpt: this.openai.isConfigured() };
  }

  /**
   * État de chaque moteur : configuré, et mis à l'écart ou non. Exposé à la page « Coûts IA »
   * (carte Moteur) pour qu'une bascule silencieuse ne le reste pas : sans ça, l'écran dirait
   * « Claude » pendant que GPT facture, et rien n'expliquerait pourquoi.
   */
  etatFournisseurs(): Record<AiProvider, EtatFournisseur> {
    const maintenant = Date.now();
    const etat = (p: AiProvider): EtatFournisseur => {
      const q = this.enQuarantaine(p, maintenant) ? this.quarantaines.get(p) : undefined;
      return {
        configure: this.byName(p).isConfigured(),
        ...(q ? { quarantaine: { kind: q.kind, jusqua: new Date(q.jusqua).toISOString() } } : {}),
      };
    };
    return { claude: etat('claude'), gpt: etat('gpt') };
  }

  /**
   * Le modèle qu'un moteur emploie par défaut (sans choix de l'appelant) — pour que la carte
   * « Moteur IA » nomme le modèle RÉEL au lieu d'un libellé écrit en dur (C3 point 4).
   */
  modeleParDefaut(p: AiProvider): string {
    return this.byName(p).modelFor();
  }

  private byName(p: AiProvider): AiClient {
    return p === 'gpt' ? this.openai : this.anthropic;
  }

  /** MODE global réglé (`claude` | `gpt` | `both`). Pour les décisions d'ensemble (analyse de trajets). */
  async mode(): Promise<AiProviderMode> {
    return this.settings.current();
  }

  /** true si le MIXTE est possible (les 2 moteurs ont une clé côté serveur). */
  mixteAvailable(): boolean {
    return this.anthropic.isConfigured() && this.openai.isConfigured();
  }

  /**
   * Un appel = une réponse JSON structurée, routée vers le bon provider. Lève `AiServiceError` (503).
   * Le mode `both` (mixte) n'a de sens que pour les usages qui savent lancer 2 moteurs + synthèse
   * (analyse de trajets) ; pour un appel SIMPLE, il retombe sur le moteur primaire (Claude).
   */
  async completeJson<T>(req: AiJsonRequest, opts?: AiRunOptions): Promise<AiJsonResult<T>> {
    const trace = this.traceDe(opts);

    // ══ PLAFOND MENSUEL — applique ICI, pour TOUS les appelants ═══════════════════
    //
    // Il ne gardait qu'UN des huit points d'appel (`place-analysis`). L'administrateur
    // fixait un plafond, le voyait « depasse » a l'ecran, et le cron de recits, l'agent
    // d'agenda, l'optimiseur, le rapport d'activite et la saisie vocale continuaient de
    // depenser. Un plafond qui ne plafonne pas est pire qu'aucun plafond : il donne une
    // fausse assurance.
    //
    // Ce service se declare « point d'entree UNIQUE de tous les appels IA ». C'est donc
    // le seul endroit ou la regle ne peut pas etre oubliee par un futur appelant.
    if (await this.usage.monthBudgetExhausted()) {
      const refus = new AiServiceError('quota', 'Plafond mensuel de depense IA atteint — appel refuse.');
      // Refusé AVANT tout moteur : la ligne d'échec n'a pas de fournisseur, et son estimation
      // chiffre le modèle qui AURAIT été employé — sans lire le réglage (le plafond passe avant
      // le choix du fournisseur, et une lecture en base pour un appel refusé serait payée pour rien).
      await this.journaliserEchec(null, this.modeleProbable(req), refus, req, trace, 0);
      await this.signalerEchecPassager(null, refus, trace);
      throw refus;
    }

    const mode = await this.settings.current();
    const selected: AiProvider = mode === 'both' ? 'claude' : mode;
    return this.essayer<T>(req, this.candidats(selected, opts), opts, trace);
  }

  /**
   * La trace, complétée. Un appelant qui n'en fournit pas voit ses échecs rangés sous `inconnu`
   * — et le journal le dit, pour qu'on aille lui ajouter la sienne.
   */
  private traceDe(opts?: AiRunOptions): TraceResolue {
    const t = opts?.trace;
    if (!t?.action) {
      this.logger.warn('Appel IA sans `trace` : ses échecs seront rangés sous l\'action « inconnu ». Ajouter `trace: { action, userId, fleetId }` à l\'appelant.');
    }
    return { action: t?.action || ACTION_INCONNUE, userId: t?.userId ?? null, fleetId: t?.fleetId ?? null };
  }

  /** Le modèle du premier moteur configuré (ordre par défaut Claude puis GPT), sans lecture du réglage. */
  private modeleProbable(req: AiJsonRequest): string {
    const p: AiProvider = this.anthropic.isConfigured() || !this.openai.isConfigured() ? 'claude' : 'gpt';
    return this.byName(p).modelFor(req);
  }

  /**
   * Les moteurs à essayer, DANS L'ORDRE : [imposé] seul, ou [réglé, claude, gpt] restreint aux
   * moteurs CONFIGURÉS. Un seul élément quand le repli est interdit (moteur imposé, `fallback:
   * false`) ou qu'aucun moteur n'a de clé (on délègue alors au moteur réglé : son client lève un
   * 503 `no_key` clair, comme avant).
   */
  private candidats(selected: AiProvider, opts?: AiRunOptions): AiProvider[] {
    // Imposé : lui, configuré ou non. Un autre moteur à sa place serait un résultat mal étiqueté.
    if (opts?.preferProvider) return [opts.preferProvider];
    const ordre: AiProvider[] = [];
    for (const p of [selected, 'claude', 'gpt'] as const) if (!ordre.includes(p)) ordre.push(p);
    const configures = ordre.filter((p) => this.byName(p).isConfigured());
    if (configures.length === 0) return [selected];
    return opts?.fallback === false ? [configures[0]] : configures;
  }

  /**
   * Essaie les candidats dans l'ordre. Sur un REFUS (`REPLI_KINDS`) et s'il reste un candidat :
   * quarantaine du fautif, puis le suivant. Quand le repli réussit, il est archivé (une fois).
   * Quand tout échoue, c'est l'erreur du PRIMAIRE — le premier tenté — qui est relancée, telle
   * quelle : c'est elle que les appelants et le filtre HTTP savent classer et archiver, et son
   * message est celui écrit pour l'utilisateur (TRK-061).
   *
   * Chaque tentative qui échoue écrit sa ligne d'échec AVANT toute décision de repli : la ligne
   * dit ce qui s'est passé à ce moteur, quoi qu'il advienne ensuite (C3 point 5).
   */
  private async essayer<T>(req: AiJsonRequest, liste: AiProvider[], opts: AiRunOptions | undefined, trace: TraceResolue): Promise<AiJsonResult<T>> {
    const maintenant = Date.now();
    const horsQuarantaine = liste.filter((p) => !this.enQuarantaine(p, maintenant));
    // Tous à l'écart (ou le seul candidat l'est) : on tente quand même le premier.
    const aEssayer = horsQuarantaine.length > 0 ? horsQuarantaine : [liste[0]];
    for (const p of liste) {
      if (!aEssayer.includes(p)) {
        this.logger.debug(`Moteur ${p} en quarantaine (${this.quarantaines.get(p)?.kind}) : sauté sans appel.`);
      }
    }

    let primaire: AiServiceError | undefined;
    const replis: { de: AiProvider; err: AiServiceError }[] = [];
    for (let i = 0; i < aEssayer.length; i++) {
      const p = aEssayer[i];
      const client = this.byName(p);
      const depart = Date.now();
      try {
        const res = await client.completeJson<T>(req);
        for (const r of replis) await this.archiverRepli(r.de, p, r.err, opts);
        return res;
      } catch (e) {
        // Une erreur qui n'est pas un échec typé du fournisseur est un DÉFAUT du code : elle
        // remonte telle quelle, jamais cachée derrière le 503 d'un autre moteur.
        if (!(e instanceof AiServiceError)) throw e;
        // La ligne d'échec : le modèle qui a répondu (échec après réponse), sinon celui qui
        // aurait servi. La latence est celle de CETTE tentative.
        await this.journaliserEchec(p, e.model ?? client.modelFor(req), e, req, trace, Date.now() - depart);
        primaire ??= e;
        const suivant = aEssayer[i + 1];
        if (!suivant || !estRepliable(e.kind)) {
          // ⚠️ L'échec d'un moteur de REPLI ne doit pas disparaître derrière l'erreur du primaire
          // relancée : un `invalid_key` CRITICAL de GPT caché par un `overloaded` passager de
          // Claude serait invisible au centre d'alerte (revue C3 du 2026-09-05). Il est archivé
          // sous sa propre clé, avec SON niveau, avant que l'erreur du primaire ne reparte.
          if (replis.length > 0) await this.archiverEchecRepli(replis[replis.length - 1].de, p, e, opts);
          // Tout a échoué. Si l'erreur relancée est PASSAGÈRE, personne d'autre ne l'archivera
          // (`ErrorLogger` l'ignore) : une ligne DEGRADATION, derrière refroidissement.
          await this.signalerEchecPassager(aEssayer[0], primaire, trace);
          throw primaire;
        }
        this.mettreEnQuarantaine(p, e.kind, Date.now());
        replis.push({ de: p, err: e });
        this.logger.warn(`Moteur ${p} refuse (${e.kind}) : bascule sur ${suivant}. ${e.detail ?? e.message}`);
      }
    }
    // Inatteignable : la boucle rend un résultat ou lève. Gardé pour le typage.
    throw primaire ?? new AiServiceError('http', 'Aucun moteur IA candidat.');
  }

  /** Vrai si le moteur est à l'écart ; une quarantaine expirée est oubliée au passage. */
  private enQuarantaine(p: AiProvider, maintenant: number): boolean {
    const q = this.quarantaines.get(p);
    if (!q) return false;
    if (q.jusqua <= maintenant) {
      this.quarantaines.delete(p);
      return false;
    }
    return true;
  }

  private mettreEnQuarantaine(p: AiProvider, kind: KindRepli, maintenant: number): void {
    this.quarantaines.set(p, { jusqua: maintenant + QUARANTAINE_PAR_KIND[kind], kind });
  }

  /**
   * UNE ligne d'échec par tentative (C3 point 5). Le coût RÉEL vient des jetons que l'erreur
   * transporte quand le fournisseur a répondu avant l'échec (réponse tronquée, refus après
   * lecture, JSON invalide) ; sinon `costUsd` vaut 0 et l'estimation chiffre le prompt préparé
   * pour rien. Ne fait jamais échouer l'appel : `recordFailure` ne lève pas, et on se protège
   * quand même — journaliser un échec ne doit pas en fabriquer un second.
   */
  private async journaliserEchec(
    provider: AiProvider | null,
    model: string,
    err: AiServiceError,
    req: AiJsonRequest,
    trace: TraceResolue,
    latencyMs: number,
  ): Promise<void> {
    try {
      await this.usage.recordFailure({
        action: trace.action,
        userId: trace.userId,
        fleetId: trace.fleetId,
        provider,
        model,
        errorKind: err.kind,
        errorDetail: err.detail ?? err.message,
        latencyMs,
        usage: err.usage ?? null,
        estimatedInputTokens: err.usage ? undefined : estimerJetonsEntree(req),
      });
    } catch (e) {
      this.logger.warn(`Ligne d'échec IA non écrite (${provider ?? MOTEUR_PLAFOND}/${err.kind}) : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Tout a échoué sur une erreur PASSAGÈRE : une ligne DEGRADATION par (moteur, sorte) et par
   * heure — cf. `REFROIDISSEMENT_ECHEC_PASSAGER_MS`. L'erreur écrite est une `Error` ordinaire,
   * pas l'`AiServiceError` transitoire : c'est précisément ce que `ErrorLogger` refuserait
   * d'archiver. Rien pour une erreur non passagère (l'appelant l'archive avec son niveau).
   */
  private async signalerEchecPassager(provider: AiProvider | null, err: AiServiceError, trace: TraceResolue): Promise<void> {
    if (!err.transient || !this.errorLogger) return;
    const moteur = provider ?? MOTEUR_PLAFOND;
    const motif = err.detail ?? err.message;
    try {
      const cle = `${CLE_ECHEC_PASSAGER}:${moteur}:${err.kind}`;
      if (this.refroidissement && !(await this.refroidissement.tenterEmission(cle, REFROIDISSEMENT_ECHEC_PASSAGER_MS))) return;
      await this.errorLogger.record(
        new Error(`Appel IA en échec passager : ${moteur} ${err.kind} — ${motif}`),
        SOURCE_ALERTE,
        { action: trace.action, provider: moteur, kind: err.kind, motif, userId: trace.userId ?? undefined, fleetId: trace.fleetId ?? undefined },
        'DEGRADATION',
      );
    } catch (e) {
      this.logger.error(`Échec passager ${moteur}/${err.kind} non signalé : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Le repli a RÉUSSI : on le dit, une fois par (moteur, sorte) et par 6 h. Le silence serait un
   * mensonge tranquille — l'écran « Coûts IA » verrait GPT facturer pendant que le réglage dit
   * « Claude », sans qu'aucune ligne n'explique pourquoi.
   *
   * Quand tout échoue, ce n'est PAS ici qu'on écrit : les appelants et le filtre HTTP archivent
   * déjà l'erreur qu'on leur relance. Une ligne de plus serait le doublon du 03/09 (TRK-061).
   */
  /**
   * Le moteur de repli a échoué à son tour : sa faute est archivée sous sa propre clé, avec le
   * niveau de SON erreur (clé refusée → CRITICAL ; saturation passagère → DEGRADATION). L'erreur
   * relancée à l'appelant reste celle du primaire — c'est elle qu'il sait classer.
   */
  private async archiverEchecRepli(de: AiProvider, vers: AiProvider, err: AiServiceError, opts?: AiRunOptions): Promise<void> {
    this.logger.warn(`Repli ${de} → ${vers} en échec (${err.kind}) : ${err.detail ?? err.message}`);
    if (!this.errorLogger) return;
    try {
      const cle = `${CLES_REFROIDISSEMENT.AI_REPLI_ECHEC}:${vers}:${err.kind}`;
      if (this.refroidissement && !(await this.refroidissement.tenterEmission(cle, REFROIDISSEMENT_REPLI_MS))) return;
      const niveau: NiveauEchecIa = err.transient ? 'DEGRADATION' : err.niveau;
      await this.errorLogger.record(
        new Error(`Repli IA en échec : ${de} → ${vers} (${err.kind}) — ${err.detail ?? err.message}`),
        SOURCE_ALERTE,
        { de, vers, kind: err.kind, motifFournisseur: err.detail, action: opts?.trace?.action, userId: opts?.trace?.userId ?? undefined, fleetId: opts?.trace?.fleetId ?? undefined },
        niveau,
      );
    } catch (e) {
      this.logger.error(`Échec du repli ${de} → ${vers} non archivé : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async archiverRepli(de: AiProvider, vers: AiProvider, err: AiServiceError, opts?: AiRunOptions): Promise<void> {
    if (!this.errorLogger) return;
    try {
      const cle = `${CLES_REFROIDISSEMENT.AI_REPLI}:${de}:${err.kind}`;
      if (this.refroidissement && !(await this.refroidissement.tenterEmission(cle, REFROIDISSEMENT_REPLI_MS))) return;
      // Niveau : celui de l'erreur (`invalid_key` → CRITICAL, `provider_unfunded` → DEGRADATION)…
      // sauf pour une sorte PASSAGÈRE (`quota`, `overloaded`), que `ErrorLogger` n'archive jamais
      // quand elle échoue. Un repli qui a marché ne peut pas crier plus fort que l'échec qu'il a
      // évité : DEGRADATION — écrit, daté, consultable, pas compté comme un défaut (TRK-037).
      const niveau: NiveauEchecIa = err.transient ? 'DEGRADATION' : err.niveau;
      await this.errorLogger.record(
        new Error(`Repli IA : ${de} → ${vers} (${err.kind}) — ${err.detail ?? err.message}`),
        SOURCE_ALERTE,
        {
          de,
          vers,
          kind: err.kind,
          motifFournisseur: err.detail,
          action: opts?.trace?.action,
          userId: opts?.trace?.userId ?? undefined,
          fleetId: opts?.trace?.fleetId ?? undefined,
        },
        niveau,
      );
    } catch (e) {
      // Journaliser le repli ne doit jamais faire échouer un appel qui, lui, a réussi.
      this.logger.error(`Repli ${de} → ${vers} non archivé : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
