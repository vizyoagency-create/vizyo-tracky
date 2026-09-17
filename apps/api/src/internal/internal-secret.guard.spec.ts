import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { InternalSecretGuard } from './internal-secret.guard';

/**
 * ══ LOT D (C7) — LA GARDE DES ROUTES MACHINE ACCEPTE LE HMAC, ET ENCORE LE SECRET STATIQUE ═══
 *
 * Même schéma que la garde de Vizyo Manager : `X-App-Id: manager`, `X-App-Timestamp` (± 5 min),
 * `X-App-Signature` = HMAC-SHA256(secret, `${ts}.${JSON.stringify(corps)}`). Pendant la transition,
 * `X-Internal-Secret` reste accepté (avec un avertissement). Un appel qui SE PRÉSENTE en HMAC est
 * jugé en HMAC : jamais de repli silencieux sur le secret statique quand la signature est fausse.
 */
const STATIQUE = 'secret-statique-de-test-32-caracteres';
const HMAC = 'secret-manager-de-test-32-caracteres!';

function garde(hmac: string | null = HMAC) {
  const config = { get: (k: string) => ({ INTERNAL_API_SECRET: STATIQUE, VIZYO_MANAGER_APP_SECRET: hmac ?? undefined })[k] } as never;
  return new InternalSecretGuard(config);
}
function contexte(headers: Record<string, string>, body?: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ headers, body, method: 'POST', url: '/api/internal/fleet/x' }) }) } as unknown as ExecutionContext;
}
function signer(ts: number, corps: string, secret = HMAC): string {
  return createHmac('sha256', secret).update(`${ts}.${corps}`).digest('hex');
}
const maintenant = () => Math.floor(Date.now() / 1000);

describe('InternalSecretGuard — HMAC', () => {
  it('signature valide sur le corps tel que reçu (mêmes clés, même ordre) → passe', () => {
    const body = { name: 'Legrand', contact: { firstName: 'Marc' } };
    const ts = maintenant();
    const ctx = contexte({ 'x-app-id': 'manager', 'x-app-timestamp': String(ts), 'x-app-signature': signer(ts, JSON.stringify(body)) }, body);
    expect(garde().canActivate(ctx)).toBe(true);
  });

  it('sans corps, les deux formes signées sont acceptées : `${ts}.` et `${ts}.{}`', () => {
    const ts = maintenant();
    expect(garde().canActivate(contexte({ 'x-app-id': 'manager', 'x-app-timestamp': String(ts), 'x-app-signature': signer(ts, '') }, {}))).toBe(true);
    expect(garde().canActivate(contexte({ 'x-app-id': 'manager', 'x-app-timestamp': String(ts), 'x-app-signature': signer(ts, '{}') }, undefined))).toBe(true);
  });

  it('signature fausse → 401, SANS repli sur le secret statique même s’il est aussi fourni', () => {
    const ts = maintenant();
    const ctx = contexte({ 'x-app-id': 'manager', 'x-app-timestamp': String(ts), 'x-app-signature': signer(ts, '{"name":"autre"}'), 'x-internal-secret': STATIQUE }, { name: 'Legrand' });
    expect(() => garde().canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('horodatage hors tolérance (± 300 s) → 401 ; appli inconnue → 401 ; secret HMAC non configuré → 401', () => {
    const vieux = maintenant() - 301;
    expect(() => garde().canActivate(contexte({ 'x-app-id': 'manager', 'x-app-timestamp': String(vieux), 'x-app-signature': signer(vieux, '{}') }, {}))).toThrow(/tolerance/);
    const ts = maintenant();
    expect(() => garde().canActivate(contexte({ 'x-app-id': 'leads', 'x-app-timestamp': String(ts), 'x-app-signature': signer(ts, '{}') }, {}))).toThrow(/not allowed/);
    expect(() => garde(null).canActivate(contexte({ 'x-app-id': 'manager', 'x-app-timestamp': String(ts), 'x-app-signature': signer(ts, '{}') }, {}))).toThrow(/not configured/);
  });

  it('en-têtes HMAC incomplets → 401 (« Missing HMAC headers »)', () => {
    expect(() => garde().canActivate(contexte({ 'x-app-id': 'manager' }, {}))).toThrow(/Missing/);
  });
});

describe('InternalSecretGuard — secret statique (transition)', () => {
  it('le bon secret passe encore (avec avertissement) ; un mauvais ou aucun → 401', () => {
    expect(garde().canActivate(contexte({ 'x-internal-secret': STATIQUE }, {}))).toBe(true);
    expect(() => garde().canActivate(contexte({ 'x-internal-secret': 'faux' }, {}))).toThrow(UnauthorizedException);
    expect(() => garde().canActivate(contexte({}, {}))).toThrow(UnauthorizedException);
  });

  it('le secret statique fonctionne même sans VIZYO_MANAGER_APP_SECRET (prod avant le lot D côté Manager)', () => {
    expect(garde(null).canActivate(contexte({ 'x-internal-secret': STATIQUE }, {}))).toBe(true);
  });
});
