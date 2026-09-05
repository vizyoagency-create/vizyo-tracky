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

/** Ce que l'appelant sait de son appel — repris au centre d'alerte quand le routeur bascule. */
export interface AiRunTrace {
  /** Action métier (`agenda_agent`, `trip_analysis`, `placement`…) : le vocabulaire d'`ai_usage_logs`. */
  action?: string;
  userId?: string;
  fleetId?: string;
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
  /** Contexte porté au centre d'alerte si le routeur bascule. Rempli par les appelants (C3 point 5). */
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

/** Source des lignes du routeur au centre d'alerte. */
const SOURCE_ALERTE = 'AI_ROUTER';

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
      throw new AiServiceError('quota', 'Plafond mensuel de depense IA atteint — appel refuse.');
    }

    const mode = await this.settings.current();
    const selected: AiProvider = mode === 'both' ? 'claude' : mode;
    return this.essayer<T>(req, this.candidats(selected, opts), opts);
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
   */
  private async essayer<T>(req: AiJsonRequest, liste: AiProvider[], opts?: AiRunOptions): Promise<AiJsonResult<T>> {
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
      try {
        const res = await this.byName(p).completeJson<T>(req);
        for (const r of replis) await this.archiverRepli(r.de, p, r.err, opts);
        return res;
      } catch (e) {
        // Une erreur qui n'est pas un échec typé du fournisseur est un DÉFAUT du code : elle
        // remonte telle quelle, jamais cachée derrière le 503 d'un autre moteur.
        if (!(e instanceof AiServiceError)) throw e;
        primaire ??= e;
        const suivant = aEssayer[i + 1];
        if (!suivant || !estRepliable(e.kind)) {
          // ⚠️ L'échec d'un moteur de REPLI ne doit pas disparaître derrière l'erreur du primaire
          // relancée : un `invalid_key` CRITICAL de GPT caché par un `overloaded` passager de
          // Claude serait invisible au centre d'alerte (revue C3 du 2026-09-05). Il est archivé
          // sous sa propre clé, avec SON niveau, avant que l'erreur du primaire ne reparte.
          if (replis.length > 0) await this.archiverEchecRepli(replis[replis.length - 1].de, p, e, opts);
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
        { de, vers, kind: err.kind, motifFournisseur: err.detail, action: opts?.trace?.action, userId: opts?.trace?.userId, fleetId: opts?.trace?.fleetId },
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
          userId: opts?.trace?.userId,
          fleetId: opts?.trace?.fleetId,
        },
        niveau,
      );
    } catch (e) {
      // Journaliser le repli ne doit jamais faire échouer un appel qui, lui, a réussi.
      this.logger.error(`Repli ${de} → ${vers} non archivé : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
