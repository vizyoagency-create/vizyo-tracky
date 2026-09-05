'use strict';
/**
 * cli-claude — l'UNIQUE porte des agents du poste vers la CLI Claude Code.
 *
 * ── POURQUOI CE MODULE EXISTE (design/C3-CHANTIER-IA-2026-09-05.md, point 3) ──────────
 *
 * Trois agents appelaient la CLI chacun a leur maniere, avec le chemin du binaire recopie et une
 * detection d'authentification par expression reguliere posee deux fois (AM-034). Surtout, rien ne
 * garantissait que l'appel passait bien par l'ABONNEMENT du poste : une variable `ANTHROPIC_API_KEY`
 * dans l'environnement suffit a faire basculer la CLI sur l'API facturee, sans aucun signal — et le
 * `.env` racine du depot, repertoire de travail des agents, portait justement les vraies cles
 * (releve du 2026-09-05). Le cout « 0 » etait donc une hypothese, pas une garantie.
 *
 * Ce module rend la garantie STRUCTURELLE :
 *   — `verifierAbonnement()` refuse de tourner si une variable interdite est presente, puis exige
 *     `claude auth status` → `authMethod = claude.ai` (releve le 2026-09-05 sur la 2.1.168 :
 *     `{ loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType }`) ;
 *   — `appeler()` lance la CLI avec un environnement NETTOYE des memes variables et rend les
 *     JETONS REELS, l'identifiant REEL du modele, le cout equivalent API et la duree — ce que les
 *     agents ecrivaient jusqu'ici en dur (0 jeton, modele « sonnet » ou « claude-code-poste ») ;
 *   — une erreur de la CLI est rapportee a partir de sa SORTIE (stderr/stdout), jamais de la ligne
 *     de commande : `execFileSync` range le prompt entier dans `e.message`, et c'est ce texte que
 *     le courrier stockait dans la colonne `erreur` (AM-005).
 *
 * Aucune dependance : `node:child_process` seulement. Le parsing est expose separement
 * (`parserEnveloppe`, `extraireErreurCli`, `analyserStatutAuth`) pour etre teste sans lancer la CLI
 * (`node --test outils/cli-claude.test.cjs`).
 */

const { execFileSync } = require('node:child_process');

/**
 * Le BINAIRE de la CLI.
 *
 * ⚠️ Sous Windows, `claude` est un script (`.cmd`, `.ps1`) : `execFileSync('claude')` echoue en
 *    ENOENT / EINVAL selon la variante. Node refuse de lancer un `.cmd` sans shell depuis 20.x, et
 *    passer par un shell obligerait a echapper un prompt multiligne — la porte ouverte aux
 *    injections. On vise donc le binaire reel.
 */
const CLI = process.platform === 'win32'
  ? 'C:/Program Files/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
  : 'claude';

/**
 * Les variables qui feraient quitter l'abonnement. `ANTHROPIC_API_KEY` et `ANTHROPIC_AUTH_TOKEN`
 * font facturer l'API ; `ANTHROPIC_BASE_URL` detourne les appels vers un autre serveur ; les deux
 * `CLAUDE_CODE_USE_*` routent vers Bedrock / Vertex, factures ailleurs. Aucune n'a sa place sur le
 * poste : leur presence est un REFUS, pas un avertissement.
 */
const CLES_INTERDITES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]);

/** Ce que la CLI ecrit quand la session n'est plus valable — messages non contractuels, d'ou la largeur du filet. */
const MOTIF_AUTH = /OAuth|authenticate|401|revoked|not logged in/i;

/** Un travail (rapport 8-12k jetons d'entree) peut etre long : marge large. */
const TIMEOUT_APPEL_MS = 8 * 60 * 1000;
/** `claude auth status` repond en moins d'une seconde ; au-dela de 30 s, quelque chose est casse. */
const TIMEOUT_STATUT_MS = 30 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;
/**
 * Longueur conservee d'une sortie d'erreur (la FIN, qui porte la cause) : assez pour comprendre,
 * trop peu pour un prompt. ⚠️ 360 et non 600 : le courrier stocke `erreur` sur 400 caracteres
 * apres un prefixe de 18 — garder 600 ici faisait perdre la cause, tronquee ensuite par le DEBUT.
 */
const EXTRAIT_ERREUR = 360;
/**
 * Plancher du plafond de sortie transmis a la CLI (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`).
 *
 * ⚠️ MESURE LE 2026-09-05 (CLI 2.1.168, haiku) : la CLI derive son budget de reflexion du
 * plafond de sortie, et l'API exige `thinking.enabled.budget_tokens >= 1024`. Plafond 64 ou
 * 900 → « API Error: 400 thinking.enabled.budget_tokens: Input should be greater than or equal
 * to 1024 » ; 1100 passe. Or l'analyse de lieu transmet `maxTokens: 900` : transmis tel quel,
 * CHAQUE travail `analyse-lieu` echouerait. Le `maxTokens` du travail decrit la place voulue pour
 * la REPONSE ; la reflexion se sert avant elle. 4096 laisse la reflexion et une fiche de 900
 * jetons ; un plafond superieur (16 000 pour un rapport) est transmis tel quel.
 */
const PLANCHER_SORTIE_CLI = 4096;

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const texteDe = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'string' ? v : '');
const apercu = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 200) || '(vide)';

// ── Environnement ────────────────────────────────────────────────────────────────────

/** L'adresse officielle de l'API : la seule valeur d'`ANTHROPIC_BASE_URL` qui ne detourne rien. */
const BASE_URL_OFFICIELLE = 'https://api.anthropic.com';

/**
 * Les variables interdites PRESENTES (non vides) dans l'environnement donne.
 *
 * `ANTHROPIC_BASE_URL` fait exception quand elle vaut l'adresse OFFICIELLE : une session Claude Code
 * interactive la pose telle quelle dans ses processus enfants (mesure le 2026-09-05), et refuser
 * la-dessus interdisait tout lancement manuel d'un agent — sans aucun risque de facturation.
 * Toute AUTRE valeur est un detournement : refus. Dans les deux cas `envPourCli` la retire.
 */
function clesInterditesPresentes(env = process.env) {
  return CLES_INTERDITES.filter((k) => {
    const v = env[k];
    if (typeof v !== 'string' || v.trim() === '') return false;
    if (k === 'ANTHROPIC_BASE_URL' && v.trim().replace(/\/+$/, '') === BASE_URL_OFFICIELLE) return false;
    return true;
  });
}

/**
 * Copie de l'environnement SANS les variables interdites, avec le plafond de sortie demande
 * (jamais sous `PLANCHER_SORTIE_CLI`, cf. la mesure ci-dessus).
 * Ne modifie jamais `process.env` : le nettoyage vaut pour la CLI, pas pour l'agent.
 */
function envPourCli({ maxTokens } = {}, base = process.env) {
  const env = { ...base };
  for (const k of CLES_INTERDITES) delete env[k];
  const plafond = Number(maxTokens);
  if (Number.isFinite(plafond) && plafond > 0) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.max(PLANCHER_SORTIE_CLI, Math.floor(plafond)));
  }
  return env;
}

// ── Abonnement ───────────────────────────────────────────────────────────────────────

/**
 * Lit la reponse de `claude auth status` (JSON) et dit si l'agent a le droit de tourner.
 * Pur : aucune CLI lancee, aucune variable lue — testable a sec.
 *
 * Tout ce qui n'est pas explicitement « connecte sur claude.ai » est un refus : une sortie qui
 * n'est pas du JSON est un etat INCONNU, et devant l'inconnu on ne depense pas.
 */
function analyserStatutAuth(sortie) {
  let statut;
  try {
    statut = JSON.parse(String(sortie ?? ''));
  } catch {
    return { ok: false, motif: `« claude auth status » ne rend pas du JSON (${apercu(sortie)}) — etat inconnu, refus prudent` };
  }
  if (!statut || typeof statut !== 'object') {
    return { ok: false, motif: `« claude auth status » rend une valeur inattendue (${apercu(sortie)}) — refus prudent` };
  }
  const authMethod = typeof statut.authMethod === 'string' ? statut.authMethod : null;
  const subscriptionType = typeof statut.subscriptionType === 'string' ? statut.subscriptionType : null;
  if (statut.loggedIn === false) {
    return { ok: false, motif: 'CLI non connectee (loggedIn = false) — ouvrir un terminal, lancer « claude » puis /login', authMethod, subscriptionType };
  }
  if (authMethod !== 'claude.ai') {
    return { ok: false, motif: `authMethod = ${authMethod ?? 'inconnu'} (attendu : claude.ai) — la CLI ne tourne pas sur l'abonnement`, authMethod, subscriptionType };
  }
  return { ok: true, authMethod, subscriptionType, apiProvider: typeof statut.apiProvider === 'string' ? statut.apiProvider : null };
}

function lancerStatutAuth(env) {
  return execFileSync(CLI, ['auth', 'status'], {
    encoding: 'utf8',
    env,
    timeout: TIMEOUT_STATUT_MS,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * L'agent a-t-il le droit de tourner ? Rend `{ ok, motif?, authMethod?, subscriptionType? }` —
 * ne leve jamais : un refus est une reponse, pas une panne.
 *
 * Ordre volontaire : l'environnement d'abord (sans lancer quoi que ce soit — une cle presente
 * suffit a refuser), la CLI ensuite. `lancer` et `env` sont injectables pour les tests.
 */
function verifierAbonnement({ env = process.env, lancer = lancerStatutAuth, journal = console } = {}) {
  const interdites = clesInterditesPresentes(env);
  if (interdites.length > 0) {
    const motif = `variable(s) d'environnement interdite(s) : ${interdites.join(', ')} — la CLI basculerait sur l'API facturee`;
    journal.error(`[cli-claude] REFUS — ${motif}`);
    return { ok: false, motif };
  }
  let sortie;
  try {
    sortie = lancer(envPourCli({}, env));
  } catch (e) {
    const motif = `« claude auth status » en echec : ${extraireErreurCli(e)}`;
    journal.error(`[cli-claude] REFUS — ${motif}`);
    return { ok: false, motif };
  }
  const verdict = analyserStatutAuth(sortie);
  if (verdict.ok) {
    journal.log(`[cli-claude] abonnement ${verdict.subscriptionType ?? '?'} (${verdict.authMethod}) — les appels passent par l'abonnement du poste, pas par l'API.`);
  } else {
    journal.error(`[cli-claude] REFUS — ${verdict.motif}`);
  }
  return verdict;
}

// ── Enveloppe de reponse ─────────────────────────────────────────────────────────────

/**
 * Lit l'enveloppe `--output-format json` de la CLI. Champs REELS, mesures sur la 2.1.168 :
 *   type 'result', subtype, is_error, result, total_cost_usd, duration_ms, session_id,
 *   usage.{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens },
 *   modelUsage.{ <id modele>: { inputTokens, outputTokens, cacheReadInputTokens,
 *                                cacheCreationInputTokens, costUSD } }.
 *
 * Rend { texte, usage, modele, coutEquivalentUsd, dureeMs, sessionId }. Le modele est la CLE de
 * `modelUsage` (l'identifiant date, ex. `claude-haiku-4-5-20251001`), jamais l'alias demande
 * (« sonnet ») : c'est ce qui permet a la grille tarifaire de la page « Couts IA » de chiffrer
 * ce que l'abonnement absorbe. S'il y a plusieurs cles, la plus chargee en jetons l'emporte ;
 * sans `modelUsage`, on garde le modele demande.
 *
 * `is_error` vrai → leve avec le `result` de la CLI (code 'AUTH' si le texte parle de session).
 * Une sortie qui n'est pas du JSON → leve : avec `--output-format json`, ce n'est pas une
 * reponse, et le travail sera repose plutot qu'invente.
 */
function parserEnveloppe(sortie, modeleDemande) {
  let env;
  try {
    env = JSON.parse(String(sortie ?? ''));
  } catch {
    throw new Error(`sortie de la CLI illisible (pas du JSON) : ${apercu(sortie)}`);
  }
  if (!env || typeof env !== 'object') throw new Error(`enveloppe CLI inattendue : ${apercu(sortie)}`);
  if (env.is_error) {
    const detail = typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? null);
    const err = new Error(`la CLI signale une erreur : ${String(detail).slice(0, EXTRAIT_ERREUR)}`);
    if (MOTIF_AUTH.test(String(detail))) err.code = 'AUTH';
    throw err;
  }

  const texte = typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? '');
  const u = env.usage && typeof env.usage === 'object' ? env.usage : null;
  const mu = env.modelUsage && typeof env.modelUsage === 'object' ? env.modelUsage : {};

  let modele = modeleDemande ? String(modeleDemande) : null;
  let poids = -1;
  const somme = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  for (const [cle, m] of Object.entries(mu)) {
    const x = m && typeof m === 'object' ? m : {};
    const p = n(x.inputTokens) + n(x.outputTokens) + n(x.cacheReadInputTokens) + n(x.cacheCreationInputTokens);
    somme.inputTokens += n(x.inputTokens);
    somme.outputTokens += n(x.outputTokens);
    somme.cacheWriteTokens += n(x.cacheCreationInputTokens);
    somme.cacheReadTokens += n(x.cacheReadInputTokens);
    if (p > poids) { poids = p; modele = cle; }
  }

  const usage = u
    ? {
        inputTokens: n(u.input_tokens),
        outputTokens: n(u.output_tokens),
        cacheWriteTokens: n(u.cache_creation_input_tokens),
        cacheReadTokens: n(u.cache_read_input_tokens),
      }
    : somme; // enveloppe sans `usage` : les totaux par modele disent la meme chose

  return {
    texte,
    usage,
    modele,
    coutEquivalentUsd: typeof env.total_cost_usd === 'number' && Number.isFinite(env.total_cost_usd) ? env.total_cost_usd : 0,
    dureeMs: n(env.duration_ms),
    sessionId: typeof env.session_id === 'string' ? env.session_id : null,
  };
}

/**
 * Repartit l'usage d'UN appel entre `parts` lignes, a parts egales, le reste sur la premiere.
 * Sert a l'agent de recits : un lot de cinq trajets est un seul appel, mais chaque recit garde sa
 * propre ligne d'usage (sa societe, sa trace). La somme des parts est exactement l'usage.
 */
function repartirUsage(usage, parts) {
  const k = Math.max(1, Math.floor(Number(parts) || 1));
  const out = [];
  for (let i = 0; i < k; i++) out.push({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
  for (const champ of ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']) {
    const total = n(usage && usage[champ]);
    const base = Math.floor(total / k);
    for (let i = 0; i < k; i++) out[i][champ] = base;
    out[0][champ] += total - base * k;
  }
  return out;
}

// ── Erreurs de la CLI ────────────────────────────────────────────────────────────────

/**
 * Le texte d'erreur d'un appel rate, tire de la SORTIE de la CLI (stderr, sinon stdout, sinon la
 * cause connue de Node), et jamais de `e.message` : `execFileSync` y range « Command failed: »
 * suivi de la ligne de commande COMPLETE — donc du prompt systeme — et c'est ce que le courrier
 * conservait dans la colonne `erreur` des travaux (constat C3 du 2026-09-05).
 * Les 600 derniers caracteres : la fin d'une sortie porte la cause, le debut porte le decor.
 */
function extraireErreurCli(e) {
  const stderr = texteDe(e && e.stderr).trim();
  const stdout = texteDe(e && e.stdout).trim();
  let brut = stderr || stdout;
  if (!stderr && stdout) {
    // La CLI peut sortir en erreur AVEC une enveloppe JSON sur stdout : son `result` est la cause.
    try {
      const env = JSON.parse(stdout);
      if (env && env.is_error && env.result) brut = String(env.result);
    } catch {
      /* stdout n'est pas une enveloppe : on le garde tel quel */
    }
  }
  const delai = !!(e && (e.code === 'ETIMEDOUT' || (e.killed && e.signal === 'SIGTERM')));
  if (!brut) {
    if (delai) brut = 'delai depasse — la CLI a ete interrompue sans avoir repondu';
    else if (e && e.code === 'ENOENT') brut = `binaire de la CLI introuvable (${CLI})`;
    else {
      const code = e && e.status != null ? e.status : e && e.code ? e.code : '?';
      brut = `la CLI s'est terminee sans message (code ${code}${e && e.signal ? `, signal ${e.signal}` : ''})`;
    }
  } else if (delai) {
    brut = `delai depasse — ${brut}`;
  }
  return brut.trim().slice(-EXTRAIT_ERREUR);
}

/** Construit l'erreur a lever apres un echec de la CLI : `.code = 'AUTH'` si la session est en cause. */
function erreurDepuisEchecCli(e) {
  const detail = extraireErreurCli(e);
  const auth = MOTIF_AUTH.test(detail);
  const err = new Error(auth ? `session Claude Code non authentifiee : ${detail}` : `echec de la CLI : ${detail}`);
  if (auth) err.code = 'AUTH';
  err.detail = detail;
  err.status = e && typeof e.status === 'number' ? e.status : null;
  return err;
}

// ── L'appel ──────────────────────────────────────────────────────────────────────────

/**
 * UN appel a la CLI, une reponse.
 *
 * `--max-turns 1` et aucun outil autorise : on veut une reponse a partir des donnees fournies,
 * pas un agent qui part explorer le disque. C'est aussi ce qui rend la duree previsible.
 * `--append-system-prompt` porte le prompt systeme, la consigne passe par stdin (aucun shell,
 * aucun echappement). L'environnement est celui de `envPourCli` : nettoye, plafonne.
 *
 * Rend le resultat de `parserEnveloppe`. Leve `Error` (code 'AUTH' si la session est en cause)
 * avec un message tire de la sortie de la CLI — jamais de la ligne de commande.
 */
function appeler({ system = '', consigne, modele, maxTokens, timeoutMs = TIMEOUT_APPEL_MS, env = process.env, executer = execFileSync } = {}) {
  if (typeof consigne !== 'string' || consigne.trim() === '') throw new Error('appeler() : consigne vide');
  if (!modele) throw new Error('appeler() : modele non precise');
  const args = [
    '-p', '--output-format', 'json', '--max-turns', '1', '--allowed-tools', '',
    '--model', String(modele), '--append-system-prompt', String(system ?? ''),
  ];
  let sortie;
  try {
    sortie = executer(CLI, args, {
      input: consigne,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      env: envPourCli({ maxTokens }, env),
    });
  } catch (e) {
    throw erreurDepuisEchecCli(e);
  }
  return parserEnveloppe(sortie, String(modele));
}

module.exports = {
  CLI,
  CLES_INTERDITES,
  MOTIF_AUTH,
  TIMEOUT_APPEL_MS,
  PLANCHER_SORTIE_CLI,
  clesInterditesPresentes,
  envPourCli,
  analyserStatutAuth,
  verifierAbonnement,
  parserEnveloppe,
  repartirUsage,
  extraireErreurCli,
  erreurDepuisEchecCli,
  appeler,
};
