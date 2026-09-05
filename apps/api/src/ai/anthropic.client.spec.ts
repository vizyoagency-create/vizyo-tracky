import { ServiceUnavailableException } from '@nestjs/common';
import { AnthropicClient, resolveModel } from './anthropic.client';

/**
 * Sprint 9 — Couvre la couche WIRE (la plus à risque car non testée live) :
 * forme du body envoyé + chaque branche d'erreur. `fetch` global est mocké :
 * aucun appel réseau, aucun token.
 */

function res(over: Partial<{ ok: boolean; status: number; json: unknown; text: string }>) {
  return {
    ok: over.ok ?? true,
    status: over.status ?? 200,
    json: async () => over.json ?? {},
    text: async () => over.text ?? '',
  } as never;
}

const REQ = { system: 'SYS', userPayload: { a: 1 }, schema: { type: 'object' } };

describe('AnthropicClient — couche wire (Sprint 9)', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    fetchMock = jest.fn();
    (global as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    (global as { fetch: unknown }).fetch = realFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('sans clé -> 503, aucun appel réseau', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const client = new AnthropicClient();
    await expect(client.completeJson(REQ)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('happy path : renvoie le JSON parsé + usage + body bien formé (model, output_config.format, adaptive, caching, headers)', async () => {
    fetchMock.mockResolvedValue(res({ json: {
      stop_reason: 'end_turn',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: '{"x":42}' }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
    } }));
    const client = new AnthropicClient();

    const out = await client.completeJson<{ x: number }>(REQ);
    expect(out.result).toEqual({ x: 42 });
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 80 });
    expect(out.model).toBe('claude-opus-4-8');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['x-api-key']).toBe('test-key');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('claude-sonnet-5'); // defaut = le moins cher, cf. resolveModel
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config.effort).toBe('high');
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: REQ.schema });
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toBe('SYS');
    expect(JSON.parse(body.messages[0].content)).toEqual({ a: 1 }); // user payload sérialisé
  });

  it('stop_reason=refusal -> 503', async () => {
    fetchMock.mockResolvedValue(res({ json: { stop_reason: 'refusal', content: [] } }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('stop_reason=max_tokens -> 503 « tronqué » (détecté AVANT le parse, pas le JSON opaque)', async () => {
    fetchMock.mockResolvedValue(res({ json: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"x":4' }] } }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toThrow(/tronqu/i);
  });

  it('HTTP 401 -> 503 (clé invalide), corps tronqué non fatal', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 401, text: 'unauthorized' }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toThrow(/invalide|autoris/i);
  });

  it('HTTP 429 -> 503 (quota)', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 429, text: 'rate limited' }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toThrow(/Quota/i);
  });

  // Chantier C3 — symétrie avec le client GPT : un compte à sec servi en 429 doit rester un refus
  // contractuel (provider_unfunded, archivé), jamais un « quota » passager mis 60 s à l'écart.
  it('HTTP 429 portant « credit balance is too low » -> provider_unfunded, pas quota', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 429, text: 'Your credit balance is too low to access the Anthropic API.' }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'provider_unfunded' });
  });

  // Incident 2026-07-27 — un récit de trajet perdu sur un 400 « Grammar compilation timed out »,
  // remonté en ERREUR au centre d'alerte. C'est un aléa du fournisseur (il n'a pas compilé NOTRE
  // schéma à temps), pas un appel fautif : il doit être marqué passager, donc non archivé.
  it('HTTP 400 « Grammar compilation timed out » -> passager (non archivé au centre d\'alerte)', async () => {
    fetchMock.mockResolvedValue(res({
      ok: false, status: 400,
      text: '{"type":"error","error":{"type":"invalid_request_error","message":"Grammar compilation timed out."}}',
    }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toMatchObject({
      kind: 'overloaded',
      transient: true,
    });
  });

  // Un VRAI 400 (appel malformé) reste une erreur dure — mais doit PORTER le motif du fournisseur.
  // Avant, le centre d'alerte n'affichait que « Erreur du service IA (400) » : diagnostiquer
  // imposait d'aller lire les logs du conteneur en SSH.
  it('HTTP 400 réel -> erreur dure PORTANT le motif du fournisseur', async () => {
    fetchMock.mockResolvedValue(res({
      ok: false, status: 400,
      text: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be >= 1"}}',
    }));
    const err = await new AnthropicClient().completeJson(REQ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'http', transient: false });
    expect((err as Error).message).toContain('max_tokens: must be >= 1');
  });

  // ── TRK-061 — le compte à sec, mesuré en production le 03/09 puis le 04/09 ─────────────
  //
  // Le corps est celui qu'Anthropic a réellement renvoyé. Les trois tests forment un couple
  // avec celui ci-dessus : MÊME code HTTP, MÊME forme de corps, un seul mot change — et tout
  // le classement bascule. C'est exactement ce qui rendait le défaut invisible.
  const CORPS_COMPTE_A_SEC = JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        'Your credit balance is too low to access the Anthropic API. ' +
        'Please go to Plans & Billing to upgrade or purchase credits.',
    },
  });

  it('TRK-061 — HTTP 400 « credit balance too low » -> refus CONTRACTUEL, pas une faute d’appel', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 400, text: CORPS_COMPTE_A_SEC }));
    const err = await new AnthropicClient().completeJson(REQ).catch((e: unknown) => e);

    // Non transitoire : une panne de compte ne guérit pas seule, elle DOIT alerter…
    expect(err).toMatchObject({ kind: 'provider_unfunded', transient: false });
    // …mais en DEGRADATION : rien n'est cassé dans l'app, une dépendance assumée refuse de servir.
    expect((err as { niveau: string }).niveau).toBe('DEGRADATION');
  });

  it('TRK-061 — le message rendu à l’UTILISATEUR ne nomme aucun sous-traitant et donne l’action', async () => {
    // Le 03/09, ce texte anglais de facturation a été servi tel quel sur un iPhone, page /agenda.
    fetchMock.mockResolvedValue(res({ ok: false, status: 400, text: CORPS_COMPTE_A_SEC }));
    const err = await new AnthropicClient().completeJson(REQ).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).not.toMatch(/anthropic/i);
    expect(message).not.toMatch(/credit balance/i);
    expect(message).not.toMatch(/Plans & Billing/i);
    expect(message).toContain('recharger le compte');
    // Ce qui SURVIT est dit, sinon l'utilisateur croit toute la plateforme en panne.
    expect(message).toContain('analyses de flotte');
  });

  it('TRK-061 — le motif du fournisseur part dans `detail`, pour le centre d’alerte seul', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 400, text: CORPS_COMPTE_A_SEC }));
    const err = await new AnthropicClient().completeJson(REQ).catch((e: unknown) => e);
    expect((err as { detail?: string }).detail).toContain('credit balance is too low');
  });

  it('contenu vide -> 503', async () => {
    fetchMock.mockResolvedValue(res({ json: { stop_reason: 'end_turn', content: [] } }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('JSON de réponse invalide -> 503', async () => {
    fetchMock.mockResolvedValue(res({ json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'pas du json' }] } }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toThrow(/JSON/i);
  });

  it('rejet réseau -> 503 (injoignable)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('boom'), { name: 'TypeError' }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toThrow(/injoignable/i);
  });
});

/**
 * ── CE QUE CES TESTS EMPECHENT DE REVENIR ────────────────────────────────────────────
 *
 * Releve du 2026-08-19 : 51,65 $ de facture IA, dont 45,89 $ (89 %) pour 4 410 recits de
 * trajet. Chacun passait par le modele le plus cher non par choix, mais parce qu'il etait
 * ECRIT EN DUR dans ce fichier. Raconter un trajet ne demande pas la meme puissance
 * qu'arbitrer un plan de tournee ; encore fallait-il pouvoir le dire.
 */
describe('AnthropicClient — choix du modele et de l’effort', () => {
  const OLD_ENV = process.env.ANTHROPIC_MODEL;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = OLD_ENV;
  });

  it('par defaut : Sonnet 5, plus recent ET moins cher qu’Opus 4.8', () => {
    delete process.env.ANTHROPIC_MODEL;
    expect(resolveModel()).toBe('claude-sonnet-5');
  });

  it('l’appelant prime : une tache lourde peut demander un modele plus fort', () => {
    delete process.env.ANTHROPIC_MODEL;
    expect(resolveModel('claude-opus-5')).toBe('claude-opus-5');
  });

  it('ANTHROPIC_MODEL surcharge le defaut sans redeployer', () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
    expect(resolveModel()).toBe('claude-haiku-4-5-20251001');
  });

  it('le choix de l’appelant passe AVANT la variable d’env', () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
    expect(resolveModel('claude-opus-5')).toBe('claude-opus-5');
  });
});

describe('AnthropicClient — l’effort part dans le body', () => {
  const OLD_FETCH = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    fetchMock = jest.fn().mockResolvedValue(res({ json: {
      stop_reason: 'end_turn', model: 'claude-sonnet-5',
      content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 },
    } }));
    global.fetch = fetchMock as never;
  });
  afterEach(() => { global.fetch = OLD_FETCH; });

  it('⚠️ `effort: low` est bien transmis — la reflexion est facturee en SORTIE, 75 % du cout', async () => {
    await new AnthropicClient().completeJson({ ...REQ, effort: 'low' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).output_config.effort).toBe('low');
  });

  it('sans precision, l’effort reste `high` : les appelants existants ne changent pas', async () => {
    await new AnthropicClient().completeJson(REQ);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).output_config.effort).toBe('high');
  });

  it('le modele demande par l’appelant part dans le body', async () => {
    await new AnthropicClient().completeJson({ ...REQ, model: 'claude-opus-5' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('claude-opus-5');
  });
});
