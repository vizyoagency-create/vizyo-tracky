'use strict';
/**
 * Jeux d'essai du module partage `cli-claude.cjs` — SANS lancer la CLI.
 *
 *   node --test outils/cli-claude.test.cjs
 *
 * Chaque cas protege une decision du chantier C3 (point 3) : les jetons et le modele REELS lus
 * dans l'enveloppe, un environnement nettoye des cles qui feraient facturer l'API, un refus
 * quand la CLI n'est pas sur l'abonnement, et un texte d'erreur qui vient de la CLI — jamais de
 * la ligne de commande (qui porte le prompt entier).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const cli = require('./cli-claude.cjs');

/** Enveloppe REELLE relevee sur la CLI 2.1.168 le 2026-09-05 (appel haiku, un tour, sans outil). */
const ENVELOPPE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  total_cost_usd: 0.03529375,
  usage: { input_tokens: 10, cache_creation_input_tokens: 28031, cache_read_input_tokens: 0, output_tokens: 49 },
  modelUsage: {
    'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 49, cacheReadInputTokens: 0, cacheCreationInputTokens: 28031, costUSD: 0.03529375 },
  },
  duration_ms: 2198,
  session_id: 'x',
};

// ── parserEnveloppe ─────────────────────────────────────────────────────────────────

test('parserEnveloppe : jetons reels, identifiant reel du modele, cout equivalent et duree', () => {
  const r = cli.parserEnveloppe(JSON.stringify(ENVELOPPE), 'haiku');
  assert.equal(r.texte, 'ok');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 49, cacheWriteTokens: 28031, cacheReadTokens: 0 });
  // La CLE de modelUsage, pas l'alias demande : c'est elle que la grille tarifaire sait chiffrer.
  assert.equal(r.modele, 'claude-haiku-4-5-20251001');
  assert.equal(r.coutEquivalentUsd, 0.03529375);
  assert.equal(r.dureeMs, 2198);
  assert.equal(r.sessionId, 'x');
});

test('parserEnveloppe : sans modelUsage, le modele demande est conserve et les jetons viennent de usage', () => {
  const sans = { ...ENVELOPPE, modelUsage: undefined };
  const r = cli.parserEnveloppe(JSON.stringify(sans), 'sonnet');
  assert.equal(r.modele, 'sonnet');
  assert.equal(r.usage.cacheWriteTokens, 28031);
});

test('parserEnveloppe : sans usage, les totaux de modelUsage font foi', () => {
  const sans = { ...ENVELOPPE, usage: undefined };
  const r = cli.parserEnveloppe(JSON.stringify(sans), 'haiku');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 49, cacheWriteTokens: 28031, cacheReadTokens: 0 });
});

test('parserEnveloppe : plusieurs modeles → le plus charge en jetons donne son nom', () => {
  const deux = {
    ...ENVELOPPE,
    modelUsage: {
      'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 },
      'claude-sonnet-4-5-20250929': { inputTokens: 10, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 28031, costUSD: 0.1 },
    },
  };
  assert.equal(cli.parserEnveloppe(JSON.stringify(deux), 'sonnet').modele, 'claude-sonnet-4-5-20250929');
});

test('parserEnveloppe : un resultat non textuel est serialise, jamais perdu', () => {
  const r = cli.parserEnveloppe(JSON.stringify({ ...ENVELOPPE, result: { a: 1 } }), 'haiku');
  assert.equal(r.texte, '{"a":1}');
});

test('parserEnveloppe : is_error → leve avec le result de la CLI', () => {
  const err = { ...ENVELOPPE, is_error: true, result: 'Prompt is too long' };
  assert.throws(() => cli.parserEnveloppe(JSON.stringify(err), 'haiku'), /Prompt is too long/);
});

test('parserEnveloppe : is_error qui parle de session → code AUTH', () => {
  const err = { ...ENVELOPPE, is_error: true, result: 'OAuth token revoked, please authenticate' };
  try {
    cli.parserEnveloppe(JSON.stringify(err), 'haiku');
    assert.fail('aurait du lever');
  } catch (e) {
    assert.equal(e.code, 'AUTH');
  }
});

test('parserEnveloppe : une sortie qui n est pas du JSON leve — le travail sera repose, pas invente', () => {
  assert.throws(() => cli.parserEnveloppe('Segmentation fault', 'haiku'), /pas du JSON/);
  assert.throws(() => cli.parserEnveloppe('', 'haiku'), /pas du JSON/);
});

// ── repartirUsage ───────────────────────────────────────────────────────────────────

test('repartirUsage : parts egales, reste sur la premiere, somme exacte', () => {
  const parts = cli.repartirUsage({ inputTokens: 10, outputTokens: 49, cacheWriteTokens: 28031, cacheReadTokens: 0 }, 3);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[1], { inputTokens: 3, outputTokens: 16, cacheWriteTokens: 9343, cacheReadTokens: 0 });
  assert.deepEqual(parts[0], { inputTokens: 4, outputTokens: 17, cacheWriteTokens: 9345, cacheReadTokens: 0 });
  const somme = parts.reduce((a, p) => a + p.inputTokens + p.outputTokens + p.cacheWriteTokens + p.cacheReadTokens, 0);
  assert.equal(somme, 10 + 49 + 28031);
});

test('repartirUsage : 0 ou 1 part → une seule ligne portant tout', () => {
  assert.deepEqual(cli.repartirUsage({ inputTokens: 5, outputTokens: 7, cacheWriteTokens: 0, cacheReadTokens: 2 }, 0), [
    { inputTokens: 5, outputTokens: 7, cacheWriteTokens: 0, cacheReadTokens: 2 },
  ]);
});

// ── envPourCli ──────────────────────────────────────────────────────────────────────

test('envPourCli : retire les cinq cles interdites, pose le plafond, ne touche pas la base', () => {
  const base = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-factice',
    ANTHROPIC_AUTH_TOKEN: 't',
    ANTHROPIC_BASE_URL: 'https://ailleurs.example',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    OPENAI_API_KEY: 'sk-factice',
  };
  const env = cli.envPourCli({ maxTokens: 16000 }, base);
  for (const k of cli.CLES_INTERDITES) assert.equal(k in env, false, `${k} devrait etre retiree`);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OPENAI_API_KEY, 'sk-factice'); // hors liste : la CLI ne la lit pas, on ne la juge pas
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '16000');
  assert.equal(base.ANTHROPIC_API_KEY, 'sk-ant-factice'); // la base n'est jamais modifiee
});

test('envPourCli : un plafond sous le plancher est releve — mesure du 2026-09-05 : 900 → 400 de l API, 1100 passe', () => {
  // L'analyse de lieu demande 900 jetons de reponse ; transmis tels quels, la CLI reserve un
  // budget de reflexion < 1024 et l'API refuse (400). Le plancher protege CHAQUE travail `analyse-lieu`.
  assert.equal(cli.PLANCHER_SORTIE_CLI, 4096);
  assert.equal(cli.envPourCli({ maxTokens: 900 }, { PATH: 'x' }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096');
  assert.equal(cli.envPourCli({ maxTokens: 64 }, { PATH: 'x' }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096');
  assert.equal(cli.envPourCli({ maxTokens: 4096 }, { PATH: 'x' }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096');
  assert.equal(cli.envPourCli({ maxTokens: 4097 }, { PATH: 'x' }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4097');
});

test('envPourCli : sans maxTokens, aucun plafond n est pose', () => {
  const env = cli.envPourCli({}, { PATH: 'x' });
  assert.equal('CLAUDE_CODE_MAX_OUTPUT_TOKENS' in env, false);
  assert.equal('CLAUDE_CODE_MAX_OUTPUT_TOKENS' in cli.envPourCli({ maxTokens: 'abc' }, { PATH: 'x' }), false);
});

test('clesInterditesPresentes : une variable vide ne compte pas, une variable remplie oui', () => {
  assert.deepEqual(cli.clesInterditesPresentes({ ANTHROPIC_API_KEY: '' }), []);
  assert.deepEqual(cli.clesInterditesPresentes({ ANTHROPIC_API_KEY: '  ' }), []);
  assert.deepEqual(cli.clesInterditesPresentes({ ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_USE_VERTEX: '1' }), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_VERTEX']);
});

// ── analyserStatutAuth / verifierAbonnement ─────────────────────────────────────────

/** Forme REELLE de `claude auth status` (2.1.168, 2026-09-05), valeurs personnelles factices. */
const STATUT_OK = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'x@example.com', orgId: 'o', orgName: 'n', subscriptionType: 'max' };

test('analyserStatutAuth : claude.ai → ok, avec le type d abonnement', () => {
  const v = cli.analyserStatutAuth(JSON.stringify(STATUT_OK));
  assert.equal(v.ok, true);
  assert.equal(v.authMethod, 'claude.ai');
  assert.equal(v.subscriptionType, 'max');
});

test('analyserStatutAuth : cle API, deconnecte ou JSON absent → refus motive', () => {
  assert.equal(cli.analyserStatutAuth(JSON.stringify({ ...STATUT_OK, authMethod: 'apiKey' })).ok, false);
  assert.match(cli.analyserStatutAuth(JSON.stringify({ ...STATUT_OK, authMethod: 'apiKey' })).motif, /apiKey/);
  assert.equal(cli.analyserStatutAuth(JSON.stringify({ ...STATUT_OK, loggedIn: false })).ok, false);
  assert.match(cli.analyserStatutAuth('Not logged in').motif, /pas du JSON/);
  assert.equal(cli.analyserStatutAuth('42').ok, false);
});

test('verifierAbonnement : une cle interdite dans l environnement refuse SANS lancer la CLI', () => {
  let lance = 0;
  const muet = { log() {}, error() {} };
  const v = cli.verifierAbonnement({
    env: { PATH: 'x', ANTHROPIC_API_KEY: 'sk-ant-factice' },
    lancer: () => { lance++; return JSON.stringify(STATUT_OK); },
    journal: muet,
  });
  assert.equal(v.ok, false);
  assert.match(v.motif, /ANTHROPIC_API_KEY/);
  assert.equal(lance, 0);
});

test('verifierAbonnement : la CLI est lancee avec un environnement nettoye, et son JSON est lu', () => {
  let envRecu = null;
  const muet = { log() {}, error() {} };
  const v = cli.verifierAbonnement({
    env: { PATH: 'x', ANTHROPIC_API_KEY: '' }, // vide = absente : on ne refuse pas, mais on nettoie quand meme
    lancer: (env) => { envRecu = env; return JSON.stringify(STATUT_OK); },
    journal: muet,
  });
  assert.equal(v.ok, true);
  assert.equal('ANTHROPIC_API_KEY' in envRecu, false);
  assert.equal(envRecu.PATH, 'x');
});

test('verifierAbonnement : une CLI qui plante ou ne rend pas du JSON → refus, jamais d exception', () => {
  const muet = { log() {}, error() {} };
  const plante = cli.verifierAbonnement({ env: { PATH: 'x' }, lancer: () => { throw Object.assign(new Error('Command failed: claude auth status'), { stderr: 'boom', status: 1 }); }, journal: muet });
  assert.equal(plante.ok, false);
  assert.match(plante.motif, /boom/);
  const inconnu = cli.verifierAbonnement({ env: { PATH: 'x' }, lancer: () => 'Logged in as someone', journal: muet });
  assert.equal(inconnu.ok, false);
  assert.match(inconnu.motif, /refus prudent/);
});

// ── extraireErreurCli / erreurDepuisEchecCli ────────────────────────────────────────

const PROMPT = 'Tu es un assistant d exploitation de flotte. SECRET-DU-PROMPT.';
/** Ce que `execFileSync` leve reellement : `message` porte la ligne de commande ENTIERE. */
const echecCli = (extra) => Object.assign(
  new Error(`Command failed: claude -p --output-format json --append-system-prompt ${PROMPT}`),
  { status: 1, signal: null, stdout: '', stderr: '', ...extra },
);

test('extraireErreurCli : le texte vient de stderr, jamais de la ligne de commande ni du prompt', () => {
  const t = cli.extraireErreurCli(echecCli({ stderr: 'Error: API rate limit reached\n' }));
  assert.equal(t, 'Error: API rate limit reached');
  assert.equal(t.includes('SECRET-DU-PROMPT'), false);
  assert.equal(t.includes('Command failed'), false);
});

test('extraireErreurCli : garde les DERNIERS caracteres — 360, la cause est a la fin et le courrier stocke 400', () => {
  const longue = 'x'.repeat(1000) + 'CAUSE-FINALE';
  const t = cli.extraireErreurCli(echecCli({ stderr: longue }));
  assert.equal(t.length, 360);
  assert.ok(t.endsWith('CAUSE-FINALE'));
});

test('extraireErreurCli : stderr vide → stdout, et une enveloppe is_error livre son result', () => {
  assert.equal(cli.extraireErreurCli(echecCli({ stdout: 'sortie brute' })), 'sortie brute');
  const env = JSON.stringify({ type: 'result', is_error: true, result: 'Invalid model name' });
  assert.equal(cli.extraireErreurCli(echecCli({ stdout: env })), 'Invalid model name');
});

test('extraireErreurCli : aucune sortie → la cause connue de Node (code, delai, binaire absent)', () => {
  assert.match(cli.extraireErreurCli(echecCli({ status: 137 })), /code 137/);
  assert.match(cli.extraireErreurCli(echecCli({ status: null, code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' })), /delai depasse/);
  assert.match(cli.extraireErreurCli(echecCli({ status: null, code: 'ENOENT' })), /introuvable/);
  assert.match(cli.extraireErreurCli(echecCli({ status: null, code: 'ETIMEDOUT', stderr: 'partiel' })), /delai depasse — partiel/);
});

test('erreurDepuisEchecCli : un motif de session pose code AUTH, sinon pas de code', () => {
  const auth = cli.erreurDepuisEchecCli(echecCli({ stderr: 'Not logged in · Please run /login' }));
  assert.equal(auth.code, 'AUTH');
  assert.match(auth.message, /non authentifiee/);
  const autre = cli.erreurDepuisEchecCli(echecCli({ stderr: 'Error: overloaded' }));
  assert.equal(autre.code, undefined);
  assert.match(autre.message, /echec de la CLI : Error: overloaded/);
  assert.equal(autre.message.includes('SECRET-DU-PROMPT'), false);
});

// ── appeler (executeur injecte) ─────────────────────────────────────────────────────

test('appeler : arguments de la CLI, consigne sur stdin, environnement nettoye, enveloppe lue', () => {
  let recu = null;
  const r = cli.appeler({
    system: 'SYS', consigne: 'donnees', modele: 'sonnet', maxTokens: 900, timeoutMs: 1234,
    env: { PATH: 'x', ANTHROPIC_API_KEY: 'sk-ant-factice' },
    executer: (bin, args, opts) => { recu = { bin, args, opts }; return JSON.stringify(ENVELOPPE); },
  });
  assert.equal(recu.bin, cli.CLI);
  assert.deepEqual(recu.args, ['-p', '--output-format', 'json', '--max-turns', '1', '--allowed-tools', '', '--model', 'sonnet', '--append-system-prompt', 'SYS']);
  assert.equal(recu.opts.input, 'donnees');
  assert.equal(recu.opts.timeout, 1234);
  assert.equal('ANTHROPIC_API_KEY' in recu.opts.env, false);
  assert.equal(recu.opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(cli.PLANCHER_SORTIE_CLI)); // 900 releve au plancher
  assert.equal(r.modele, 'claude-haiku-4-5-20251001');
  assert.equal(r.usage.cacheWriteTokens, 28031);
});

test('appeler : un echec de la CLI remonte SANS la ligne de commande, avec code AUTH si la session est en cause', () => {
  const executer = () => { throw echecCli({ stderr: 'OAuth token expired' }); };
  try {
    cli.appeler({ system: PROMPT, consigne: 'x', modele: 'sonnet', executer });
    assert.fail('aurait du lever');
  } catch (e) {
    assert.equal(e.code, 'AUTH');
    assert.equal(e.message.includes('SECRET-DU-PROMPT'), false);
  }
});

test('appeler : consigne vide ou modele absent → refus immediat, sans appel', () => {
  let lance = 0;
  const executer = () => { lance++; return '{}'; };
  assert.throws(() => cli.appeler({ consigne: '', modele: 'sonnet', executer }), /consigne vide/);
  assert.throws(() => cli.appeler({ consigne: 'x', executer }), /modele/);
  assert.equal(lance, 0);
});

// ── Revue C3 du 2026-09-05 : ANTHROPIC_BASE_URL officielle ─────────────────────────────────

test('clesInterditesPresentes : ANTHROPIC_BASE_URL officielle toleree (session Claude Code), toute autre valeur refusee', () => {
  assert.deepEqual(cli.clesInterditesPresentes({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), []);
  assert.deepEqual(cli.clesInterditesPresentes({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }), []);
  assert.deepEqual(cli.clesInterditesPresentes({ ANTHROPIC_BASE_URL: 'https://ailleurs.example' }), ['ANTHROPIC_BASE_URL']);
  assert.deepEqual(cli.clesInterditesPresentes({ ANTHROPIC_API_KEY: 'sk-factice' }), ['ANTHROPIC_API_KEY']);
});

test('envPourCli : ANTHROPIC_BASE_URL est retiree meme officielle — la CLI n a pas a la recevoir', () => {
  const env = cli.envPourCli({}, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', PATH: 'p' });
  assert.equal('ANTHROPIC_BASE_URL' in env, false);
  assert.equal(env.PATH, 'p');
});
