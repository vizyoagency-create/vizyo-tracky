import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Couche IA multi-provider (2026-07) — contrat COMMUN à tous les moteurs (Claude, GPT…).
 *
 * Historiquement il n'y avait qu'`AnthropicClient`. On abstrait ici l'interface (`AiClient`) pour
 * pouvoir router entre plusieurs providers (switch/mixte piloté depuis la page « Coûts IA ») SANS
 * toucher aux appelants : agenda, optimiseur, booking vocal, rapports d'activité, analyse de trajets.
 * L'app PROPOSE via l'IA (JSON garanti par le schéma) ; l'app VALIDE. Le coût est tracé par modèle.
 */

/** Providers IA supportés. `claude` = Anthropic Messages API ; `gpt` = OpenAI Responses API. */
export type AiProvider = 'claude' | 'gpt';

/** MODE réglé globalement : un seul moteur, ou `both` = MIXTE (les 2 + synthèse). */
export type AiProviderMode = AiProvider | 'both';

/** Nature d'un échec IA — pour classer le niveau d'alerte + l'anti-spam (pas de match texte fragile). */
export type AiErrorKind =
  | 'no_key'
  | 'invalid_key'
  | 'quota'
  /** Fournisseur saturé (HTTP 529 Anthropic / 503) — passager, réessayable. */
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'refusal'
  | 'empty'
  | 'parse'
  | 'truncated'
  /**
   * TRK-061 — le fournisseur REFUSE de servir pour une raison contractuelle, pas technique :
   * compte sans crédit, offre expirée. Voir `UNFUNDED_400_PATTERNS`.
   */
  | 'provider_unfunded'
  | 'http';

/**
 * Échecs PASSAGERS côté fournisseur : ni un bug de l'app, ni une action à mener. Ils ne doivent
 * donc pas remplir le centre d'alerte ni déclencher la vigie de saturation — au même titre que les
 * 429 de Vizyo Auth, déjà filtrés dans `all-exceptions.filter`.
 * (2026-07-20 : des 529 « Overloaded » d'Anthropic remontaient en ERROR pendant les récits de trajet.)
 */
const TRANSIENT_KINDS: ReadonlySet<AiErrorKind> = new Set<AiErrorKind>(['quota', 'overloaded', 'timeout', 'network']);

/**
 * ══ C3 point 1 (2026-09-05) — LES SORTES SUR LESQUELLES LE ROUTEUR PEUT BASCULER ═════════
 *
 * Le fournisseur a REFUSÉ de servir, et rien n'a été facturé : pas de clé, clé refusée, quota,
 * saturation, compte à sec. Un autre moteur peut légitimement prendre l'appel à sa place.
 *
 * Relevé de production du 2026-09-05 qui a décidé ce point : `ANTHROPIC_API_KEY` refusée
 * (400 « credit balance is too low ») depuis le 03/09, pendant qu'une `OPENAI_API_KEY` VALIDE
 * (GET /v1/models = 200) dormait à côté — l'agent d'agenda tournait en mode dégradé depuis
 * le 04/09 avec un second moteur payé et inutilisé.
 *
 * ⚠️ Volontairement ABSENTS :
 *  - `refusal`, `truncated`, `parse`, `empty`, `http` : des défauts de la REQUÊTE (schéma trop
 *    gros, sortie coupée, appel malformé). Un second moteur les repaierait pour le même résultat.
 *  - `timeout`, `network` : une INCERTITUDE, pas un refus. L'appel a peut-être été servi et
 *    facturé de l'autre côté ; le rejouer ailleurs doublerait la dépense.
 */
export const REPLI_KINDS = ['no_key', 'invalid_key', 'quota', 'overloaded', 'provider_unfunded'] as const satisfies readonly AiErrorKind[];

/** Sorte d'échec qui autorise le repli — et qui met le moteur fautif en quarantaine (cf. `AiRouter`). */
export type KindRepli = (typeof REPLI_KINDS)[number];

/** Vrai si un autre moteur peut légitimement reprendre l'appel après cet échec. */
export function estRepliable(kind: AiErrorKind): kind is KindRepli {
  return (REPLI_KINDS as readonly AiErrorKind[]).includes(kind);
}

/**
 * Motifs d'erreur PASSAGERS que les fournisseurs renvoient en **400**.
 *
 * Un 400 signale normalement un appel malformé — donc un vrai bug, qui DOIT alerter. Mais
 * certains sont des aléas d'infrastructure déguisés : « Grammar compilation timed out » = le
 * fournisseur n'a pas réussi à compiler NOTRE schéma de sortie structurée dans son délai. Le
 * même appel repasse à l'essai suivant, sans rien changer côté app.
 * (2026-07-27 : un récit de trajet perdu ainsi, remonté en ERREUR au centre d'alerte alors que
 * le schéma en cause — `TRIP_NARRATIVE_SCHEMA` — ne compte que 3 champs et passe le reste du temps.)
 */
const TRANSIENT_400_PATTERNS: readonly RegExp[] = [
  /grammar compilation timed out/i,
  /overloaded/i,
];

/** Vrai si le corps d'un 400 décrit un aléa fournisseur (réessayable) et non un appel fautif. */
export function isTransientBadRequest(body: string): boolean {
  return TRANSIENT_400_PATTERNS.some((re) => re.test(body));
}

/**
 * ══ TRK-061 — LE REFUS CONTRACTUEL, HABILLÉ EN APPEL MALFORMÉ ════════════════════════════
 *
 * Mesuré en production le 2026-09-03 à 00:13:23, **première occurrence en 90 jours de
 * rétention**, puis récidive le 04/09 sur un second chemin : Anthropic facture l'épuisement
 * d'un compte comme un **HTTP 400 `invalid_request_error`** — le code d'une requête malformée.
 *
 * Aucun motif de `TRANSIENT_400_PATTERNS` ne correspondait, la ligne tombait donc dans le cas
 * par défaut commenté « Vraie faute d'appel » et sortait en `kind: 'http'`. **Ce n'est ni une
 * faute d'appel, ni un aléa passager** : c'est une panne de COMPTE. Elle ne guérit pas seule,
 * elle se reproduira à l'identique à chaque appel facturé, et l'action qui la résout — recharger
 * le compte — **n'est pas dans le code**.
 *
 * La taxonomie de ce fichier était excellente par ailleurs ; il lui manquait exactement une
 * case : *« le fournisseur refuse de servir pour une raison contractuelle, pas technique ».*
 *
 * ⚠️ **Motifs volontairement ÉTROITS.** Le premier est celui qu'on a mesuré, mot pour mot. Les
 * deux suivants sont les formes équivalentes documentées d'OpenAI, ajoutées parce que le client
 * GPT est le jumeau exact de celui-ci et qu'un défaut corrigé d'un seul côté revient par
 * l'autre. On n'y met PAS `/billing/i` : le mot apparaît dans des messages qui n'ont rien à voir,
 * et un motif trop large classerait en « compte à sec » de vraies fautes d'appel — exactement
 * l'erreur inverse de celle qu'on corrige.
 */
const UNFUNDED_400_PATTERNS: readonly RegExp[] = [
  /credit balance is too low/i,
  /insufficient_quota/i,
  /exceeded your current quota/i,
];

/** Vrai si le corps d'un refus décrit un compte sans crédit plutôt qu'un appel fautif. */
export function isUnfundedRequest(body: string): boolean {
  return UNFUNDED_400_PATTERNS.some((re) => re.test(body));
}

/**
 * Message rendu à l'UTILISATEUR quand le compte du fournisseur est à sec.
 *
 * 🔑 **Il ne nomme aucun sous-traitant, et c'est le cœur du correctif.** Le 03/09, le message de
 * facturation d'Anthropic — en anglais, avec l'ordre d'aller créditer un compte auquel
 * l'utilisateur n'a pas accès — a été servi tel quel sur un iPhone, `page: /agenda`, parce que
 * `AiServiceError` hérite de `ServiceUnavailableException` et que son message EST le corps de la
 * réponse HTTP. `describeProviderError` avait pourtant été écrit — son commentaire le dit — « pour
 * que le CENTRE D'ALERTE porte la cause ». *Une seule chaîne servait deux publics, et rien ne les
 * séparait.* Le motif du fournisseur part désormais dans `detail`, lu par le centre d'alerte seul.
 *
 * Il suit le patron que `trip-analysis` applique déjà bien dans ce dépôt : la dépendance, la
 * conséquence, **ce qui survit**, puis l'action.
 */
export const MESSAGE_COMPTE_SANS_CREDIT =
  "Assistance IA indisponible : le compte du fournisseur n'a plus de crédit. " +
  'Les analyses de flotte, exécutées localement, ne sont pas affectées. ' +
  'Action : recharger le compte.';

/**
 * Niveau que le centre d'alerte doit donner à un échec IA, **décidé ici et une seule fois**.
 *
 * Avant TRK-061, la règle « clé invalide = CRITICAL » vivait dans `ai-optimization.service`, et
 * les autres appelants l'ignoraient : le même incident changeait de gravité selon la porte par
 * laquelle il entrait. Les valeurs sont des littéraux et non le type de l'observabilité — ce
 * module ne doit rien importer de là-bas (canard-typage, comme `transient`).
 */
export type NiveauEchecIa = 'ERROR' | 'CRITICAL' | 'DEGRADATION';

const NIVEAU_PAR_KIND: Partial<Record<AiErrorKind, NiveauEchecIa>> = {
  /** Une clé configurée mais refusée est un vrai incident : personne ne le verra autrement. */
  invalid_key: 'CRITICAL',
  /**
   * ⚠️ DEGRADATION, pas ERROR — même raisonnement que pour Overpass (TRK-037) : le service est
   * indisponible pour une raison **assumée et externe**, le repli local fonctionne, et rien n'est
   * cassé dans l'application. La ligne est écrite, horodatée, consultable ; elle ne compte
   * simplement pas comme un défaut à corriger. *Elle ne cache rien : elle nomme.*
   */
  provider_unfunded: 'DEGRADATION',
};

/**
 * Motif LISIBLE extrait du corps d'erreur d'un fournisseur, pour que le centre d'alerte porte la
 * cause au lieu d'un « Erreur du service IA (400) » opaque qui obligeait à aller lire les logs du
 * conteneur en SSH pour diagnostiquer. Les corps Claude et OpenAI ont la même forme
 * `{ error: { message } }`. Borné : un corps d'erreur peut être volumineux.
 */
export function describeProviderError(body: string): string {
  const raw = (body ?? '').trim();
  if (!raw) return 'aucun détail renvoyé';
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown; type?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200);
  } catch {
    /* corps non-JSON (page d'erreur d'un proxy, etc.) → on retombe sur le brut tronqué */
  }
  return raw.slice(0, 200);
}

/** Échec IA typé (toujours un 503 pour l'appelant) portant son `kind` pour la journalisation. */
export class AiServiceError extends ServiceUnavailableException {
  /**
   * Marqueur lu par `ErrorLogger` **en canard-typage** (aucun import du module IA côté
   * observabilité, donc aucun cycle) : tout échec qui se déclare transitoire est journalisé
   * localement mais PAS persisté au centre d'alerte.
   */
  public readonly transient: boolean;

  /**
   * Niveau attendu au centre d'alerte. Lu en canard-typage par les appelants qui journalisent,
   * pour que la gravité d'un incident ne dépende plus de la porte par laquelle il est entré.
   */
  public readonly niveau: NiveauEchecIa;

  /**
   * ══ C3 point 5 (2026-09-05) — CE QUE L'ÉCHEC A COÛTÉ ═══════════════════════════════════
   *
   * Un échec APRÈS réponse du fournisseur (refus du modèle, sortie tronquée, réponse vide ou
   * JSON invalide) a été FACTURÉ : le fournisseur a lu le prompt et produit des jetons avant que
   * le client ne rejette la réponse. Sans ces deux champs, le routeur ne pouvait qu'estimer ce
   * coût — et l'estimation ne compte jamais dans le plafond mensuel, donc l'argent réellement
   * dépensé par une réponse tronquée disparaissait. Absents sur un échec AVANT réponse (clé,
   * quota, réseau, délai) : rien n'a été facturé, le routeur estime.
   */
  public readonly usage?: AiUsage;
  /** Identifiant du modèle qui a produit la réponse rejetée (tel que renvoyé par le fournisseur). */
  public readonly model?: string;

  constructor(
    public readonly kind: AiErrorKind,
    message: string,
    /**
     * Motif BRUT du fournisseur — **pour le centre d'alerte seulement, jamais pour le corps
     * HTTP** (TRK-061). Ce qui est mis ici n'est pas lu par l'utilisateur ; ce qui est mis dans
     * `message`, si.
     */
    public readonly detail?: string,
    /** Jetons facturés et modèle, quand le fournisseur a répondu avant l'échec (voir `usage`). */
    facture?: { usage: AiUsage; model?: string },
  ) {
    super(message);
    this.transient = TRANSIENT_KINDS.has(kind);
    this.niveau = NIVEAU_PAR_KIND[kind] ?? 'ERROR';
    if (facture) {
      this.usage = facture.usage;
      this.model = facture.model;
    }
  }
}

/**
 * Ce qu'un appelant transmet au centre d'alerte à propos d'un échec IA : le NIVEAU décidé par la
 * couche IA (`NIVEAU_PAR_KIND`), la sorte, et le motif du fournisseur pour le contexte — jamais
 * pour le message (TRK-061). Une erreur qui n'est pas un échec typé (défaut du code) garde
 * `ERROR`, sans motif.
 *
 * ── Pourquoi une fonction ──────────────────────────────────────────────────────────────
 * Le 05/09, cinq appelants archivaient sans niveau : le même compte à sec sortait en ERROR par
 * l'assistance et en DEGRADATION par l'optimiseur. La règle est écrite ici une fois, et chaque
 * appelant la transmet telle quelle (C3 point 5).
 */
export function classerEchecIa(e: unknown): { niveau: NiveauEchecIa; kind?: AiErrorKind; motifFournisseur?: string } {
  if (e instanceof AiServiceError) return { niveau: e.niveau, kind: e.kind, motifFournisseur: e.detail };
  return { niveau: 'ERROR' };
}

/** Une requête IA → une réponse JSON structurée. Identique quel que soit le provider. */
export interface AiJsonRequest {
  /** System prompt (préfixe stable → mis en cache quand le provider le supporte). */
  system: string;
  /** Données de la requête, sérialisées en JSON comme message user. */
  userPayload: unknown;
  /** JSON Schema de la sortie attendue (Structured Outputs). */
  schema: unknown;
  maxTokens?: number;
  /**
   * Modèle à employer, quand l'appelant sait que sa tâche ne mérite pas le plus cher.
   *
   * Relevé du 2026-08-19 : 4 410 récits de trajet à 0,0104 $ pièce, soit 45,89 $ — 89 % de la
   * facture IA — tous passés par le modèle le plus coûteux parce qu'il était CODÉ EN DUR. Raconter
   * un trajet en trois phrases et arbitrer un plan de tournée ne demandent pas la même puissance.
   * Absent → défaut du client (surchargeable par `ANTHROPIC_MODEL`).
   */
  model?: string;
  /**
   * Effort de raisonnement. `high` fait réfléchir le modèle avant de répondre, et cette réflexion
   * est facturée en SORTIE — le poste le plus cher (75 % du coût des récits de trajet). Un résumé
   * factuel n'en a pas besoin. Absent → `high`, pour ne rien changer aux appelants existants.
   */
  effort?: 'low' | 'medium' | 'high';
}

/** Consommation de tokens renvoyée par le provider — base du calcul de coût (palier « Coûts IA »). */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/** Résultat d'un appel : sortie JSON + consommation + modèle + provider + latence. */
export interface AiJsonResult<T> {
  result: T;
  usage: AiUsage;
  /** Nom exact du modèle renvoyé par le provider (ex. `claude-opus-4-8`, `gpt-4.1`). */
  model: string;
  /** Provider ayant réellement traité l'appel (pour l'attribution de coût + l'UI « qui a répondu »). */
  provider: AiProvider;
  latencyMs: number;
}

/** Contrat commun d'un moteur IA. Implémenté par AnthropicClient (claude) et OpenAiClient (gpt). */
export interface AiClient {
  /** Identité du provider (constante). */
  readonly provider: AiProvider;
  /** Vrai si une clé API est présente côté serveur pour CE provider. */
  isConfigured(): boolean;
  /** Un appel = une réponse JSON structurée (validée par `schema`). Lève `AiServiceError` (503) sinon. */
  completeJson<T>(req: AiJsonRequest): Promise<AiJsonResult<T>>;
  /**
   * Le modèle que `completeJson` EMPLOIERAIT pour cette requête (choix de l'appelant, sinon
   * variable d'environnement, sinon défaut du client) — sans rien appeler. Sert à ESTIMER le
   * coût d'un échec survenu AVANT toute réponse (C3 point 5) : un refus de clé ou un quota ne
   * renvoie aucun identifiant de modèle, et la grille tarifaire a besoin d'un nom pour chiffrer
   * le prompt qui a été préparé pour rien. Sans argument : le modèle par défaut du moteur (carte
   * « Moteur IA » de la page « Coûts IA »).
   */
  modelFor(req?: Pick<AiJsonRequest, 'model'>): string;
}
