import { ServiceUnavailableException } from '@nestjs/common';
import { OpenAiClient } from './openai.client';

/**
 * C3 point 1 (2026-09-05) — la couche WIRE du client GPT, jumelle de `anthropic.client.spec.ts`.
 * `fetch` global est simulé : aucun appel réseau, aucun jeton.
 *
 * Ce client n'avait AUCUN jeu d'essai alors qu'il devient le moteur de repli de toute la
 * plateforme le jour où Anthropic refuse — c'est-à-dire précisément le jour où l'on ne peut plus
 * se permettre qu'il classe mal un refus. Le test qui compte le plus est celui du 429
 * `insufficient_quota` : un compte OpenAI à sec doit être une panne de COMPTE (archivée), pas
 * une limite de débit passagère (invisible).
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

/** Réponse nominale de la Responses API (forme brute : la sortie vit dans `output[].content[]`). */
const REPONSE_NOMINALE = {
  model: 'gpt-4.1-2025-04-14',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"x":42}' }] }],
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20 },
};

/** Corps documenté d'OpenAI pour un compte sans crédit : HTTP 429, comme la limite de débit. */
const CORPS_COMPTE_A_SEC = JSON.stringify({
  error: {
    message:
      'You exceeded your current quota, please check your plan and billing details. ' +
      'For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.',
    type: 'insufficient_quota',
    param: null,
    code: 'insufficient_quota',
  },
});

/** Corps documenté d'une limite de débit : MÊME code HTTP, aucun motif de compte. */
const CORPS_LIMITE_DEBIT = JSON.stringify({
  error: {
    message: 'Rate limit reached for gpt-4.1 on tokens per min (TPM): Limit 30000, Used 29500, Requested 1200. Please try again in 1.4s.',
    type: 'tokens',
    param: null,
    code: 'rate_limit_exceeded',
  },
});

describe('OpenAiClient — couche wire', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.OPENAI_MODEL;
    fetchMock = jest.fn();
    (global as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    (global as { fetch: unknown }).fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('sans clé → 503 `no_key`, aucun appel réseau', async () => {
    delete process.env.OPENAI_API_KEY;
    const client = new OpenAiClient();
    expect(client.isConfigured()).toBe(false);
    const err = await client.completeJson(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err).toMatchObject({ kind: 'no_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nominal 200 : JSON parsé, usage avec la part cachée ISOLÉE, modèle du fournisseur, provider gpt', async () => {
    fetchMock.mockResolvedValue(res({ json: REPONSE_NOMINALE }));
    const out = await new OpenAiClient().completeJson<{ x: number }>(REQ);

    expect(out.result).toEqual({ x: 42 });
    // OpenAI compte le cache DANS input_tokens : 100 dont 80 cachés → 20 au plein tarif.
    expect(out.usage).toEqual({ inputTokens: 20, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 80 });
    expect(out.model).toBe('gpt-4.1-2025-04-14');
    expect(out.provider).toBe('gpt');
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('le corps suit la Responses API : instructions, input sérialisé, json_schema NON strict, max_output_tokens, Bearer', async () => {
    fetchMock.mockResolvedValue(res({ json: REPONSE_NOMINALE }));
    await new OpenAiClient().completeJson({ ...REQ, maxTokens: 1200 });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(opts.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-4.1'); // défaut, sans OPENAI_MODEL
    expect(body.instructions).toBe('SYS');
    expect(JSON.parse(body.input)).toEqual({ a: 1 });
    expect(body.text.format).toEqual({ type: 'json_schema', name: 'tracky_result', strict: false, schema: REQ.schema });
    expect(body.max_output_tokens).toBe(1200);
  });

  it('OPENAI_MODEL surcharge le modèle par défaut', async () => {
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    fetchMock.mockResolvedValue(res({ json: { ...REPONSE_NOMINALE, model: undefined } }));
    const out = await new OpenAiClient().completeJson(REQ);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('gpt-4o-mini');
    expect(out.model).toBe('gpt-4o-mini'); // le modèle demandé, faute de réponse du fournisseur
  });

  it('`output_text` (forme SDK) est lu en priorité quand il est présent', async () => {
    fetchMock.mockResolvedValue(res({ json: { status: 'completed', output_text: '{"y":1}', usage: {} } }));
    const out = await new OpenAiClient().completeJson<{ y: number }>(REQ);
    expect(out.result).toEqual({ y: 1 });
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
  });

  // ── C3 point 1 — le compte à sec, habillé en limite de débit ─────────────────────────
  //
  // Anthropic l'envoie en 400 (TRK-061) ; OpenAI l'envoie en 429 `insufficient_quota`, le
  // code de la limite de débit. Les deux tests suivants forment un couple : MÊME code HTTP,
  // MÊME forme de corps, seul le motif change — et tout le classement bascule.
  it('C3 — HTTP 429 `insufficient_quota` → refus CONTRACTUEL (provider_unfunded), DEGRADATION, non passager', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 429, text: CORPS_COMPTE_A_SEC }));
    const err = await new OpenAiClient().completeJson(REQ).catch((e: unknown) => e);

    expect(err).toMatchObject({ kind: 'provider_unfunded', transient: false });
    expect((err as { niveau: string }).niveau).toBe('DEGRADATION');
  });

  it('C3 — le message rendu ne nomme aucun sous-traitant et donne l’action ; le motif part dans `detail`', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 429, text: CORPS_COMPTE_A_SEC }));
    const err = await new OpenAiClient().completeJson(REQ).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).not.toMatch(/openai/i);
    expect(message).not.toMatch(/quota/i);
    expect(message).toContain('recharger le compte');
    expect((err as { detail?: string }).detail).toContain('exceeded your current quota');
  });

  it('HTTP 429 sans motif de compte (limite de débit) → quota, passager', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 429, text: CORPS_LIMITE_DEBIT }));
    const err = await new OpenAiClient().completeJson(REQ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'quota', transient: true });
    expect((err as Error).message).toMatch(/Quota/i);
  });

  it('le motif seul décide, pas le code HTTP : un 400 « credit balance » est aussi un compte à sec', async () => {
    fetchMock.mockResolvedValue(res({
      ok: false, status: 400,
      text: '{"error":{"message":"Your credit balance is too low.","type":"invalid_request_error"}}',
    }));
    await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'provider_unfunded' });
  });

  it('HTTP 401 / 403 → invalid_key (non passager : quelqu’un doit agir)', async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValue(res({ ok: false, status, text: '{"error":{"message":"Incorrect API key provided"}}' }));
      await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'invalid_key', transient: false });
    }
  });

  it('HTTP 529 / 503 → overloaded, passager', async () => {
    for (const status of [529, 503]) {
      fetchMock.mockResolvedValue(res({ ok: false, status, text: 'overloaded' }));
      await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'overloaded', transient: true });
    }
  });

  it('HTTP 400 « Grammar compilation timed out » → overloaded, passager (aléa fournisseur, pas un appel fautif)', async () => {
    fetchMock.mockResolvedValue(res({
      ok: false, status: 400,
      text: '{"error":{"message":"Grammar compilation timed out.","type":"invalid_request_error"}}',
    }));
    await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'overloaded', transient: true });
  });

  it('HTTP 400 réel → erreur dure PORTANT le motif du fournisseur', async () => {
    fetchMock.mockResolvedValue(res({
      ok: false, status: 400,
      text: '{"error":{"message":"Invalid schema for response_format: additionalProperties is required","type":"invalid_request_error"}}',
    }));
    const err = await new OpenAiClient().completeJson(REQ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'http', transient: false });
    expect((err as Error).message).toContain('additionalProperties is required');
  });

  it('status incomplete / max_output_tokens → truncated, détecté AVANT le parse', async () => {
    fetchMock.mockResolvedValue(res({ json: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"x":4' }] }],
    } }));
    await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'truncated' });
  });

  it('item `refusal` → refusal', async () => {
    fetchMock.mockResolvedValue(res({ json: {
      status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'non' }] }],
    } }));
    await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'refusal' });
  });

  it('sortie vide → empty', async () => {
    fetchMock.mockResolvedValue(res({ json: { status: 'completed', output: [] } }));
    await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'empty' });
  });

  it('JSON de sortie invalide → parse', async () => {
    fetchMock.mockResolvedValue(res({ json: { status: 'completed', output_text: 'pas du json' } }));
    await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'parse' });
  });

  it('rejet réseau → network ; délai dépassé → timeout (tous deux passagers, jamais repliables)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('fetch failed'), { name: 'TypeError' }));
    await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'network', transient: true });

    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(new OpenAiClient().completeJson(REQ)).rejects.toMatchObject({ kind: 'timeout', transient: true });
  });
});
