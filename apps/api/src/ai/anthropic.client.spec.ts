import { ServiceUnavailableException } from '@nestjs/common';
import { AnthropicClient } from './anthropic.client';

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

  it('happy path : renvoie le JSON parsé + body bien formé (model, output_config.format, adaptive, caching, headers)', async () => {
    fetchMock.mockResolvedValue(res({ json: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"x":42}' }] } }));
    const client = new AnthropicClient();

    const out = await client.completeJson<{ x: number }>(REQ);
    expect(out).toEqual({ x: 42 });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['x-api-key']).toBe('test-key');
    expect(opts.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('claude-opus-4-8');
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

  it('HTTP 401 -> 503 (clé invalide), corps tronqué non fatal', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 401, text: 'unauthorized' }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toThrow(/invalide|autoris/i);
  });

  it('HTTP 429 -> 503 (quota)', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 429, text: 'rate limited' }));
    await expect(new AnthropicClient().completeJson(REQ)).rejects.toThrow(/Quota/i);
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
