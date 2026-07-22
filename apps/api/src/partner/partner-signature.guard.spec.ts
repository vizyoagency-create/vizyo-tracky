import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { PartnerConfigService } from './partner.config';
import { PARTNER_OP_KEY, PartnerSignatureGuard } from './partner-signature.guard';
import { signPartnerRequest } from './partner-signature';

const SECRET = 'secret-de-plateforme-pour-les-tests';

function makeConfig(overrides: Record<string, unknown> = {}): PartnerConfigService {
  const values: Record<string, unknown> = {
    PARTNER_MAESTROO_ENABLED: 'true',
    PARTNER_PLATFORM_SECRET: SECRET,
    PARTNER_MAESTROO_API_URL: 'https://api.maestroo.app',
    PARTNER_TOKEN_TTL_SECONDS: 600,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService<never, true>;
  return new PartnerConfigService(config);
}

function makeContext(req: Record<string, unknown>, op: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function makeGuard(config: PartnerConfigService, op: string | undefined): PartnerSignatureGuard {
  const reflector = {
    getAllAndOverride: (key: string) => (key === PARTNER_OP_KEY ? op : undefined),
  } as unknown as Reflector;
  return new PartnerSignatureGuard(reflector, config);
}

function signedRequest(op: string, body = '', method = 'POST') {
  const headers = signPartnerRequest(SECRET, { method, op, rawBody: body });
  return {
    method,
    rawBody: body ? Buffer.from(body, 'utf8') : undefined,
    headers: {
      'x-partner-timestamp': headers['X-Partner-Timestamp'],
      'x-partner-signature': headers['X-Partner-Signature'],
    },
  };
}

describe('PartnerSignatureGuard — kill-switch', () => {
  // Choix délibéré : 404, pas 403. Un 403 CONFIRMERAIT que la route existe.
  // Tant que l'intégration n'est pas ouverte, elle doit être indiscernable d'une
  // route absente — y compris pour quelqu'un qui sonde l'API.
  it('module éteint ⇒ 404 (et surtout PAS 403)', () => {
    const guard = makeGuard(makeConfig({ PARTNER_MAESTROO_ENABLED: 'false' }), 'partner.ping');
    expect(() => guard.canActivate(makeContext(signedRequest('partner.ping'), 'partner.ping'))).toThrow(
      NotFoundException,
    );
  });

  it.each([
    ['secret manquant', { PARTNER_PLATFORM_SECRET: '' }],
    ['URL du pair manquante', { PARTNER_MAESTROO_API_URL: '' }],
  ])('kill-switch à true mais %s ⇒ 404 aussi', (_label, overrides) => {
    // Un module « à moitié configuré » rejetterait toutes les signatures : mieux
    // vaut le déclarer franchement éteint que le laisser mentir.
    const guard = makeGuard(makeConfig(overrides), 'partner.ping');
    expect(() => guard.canActivate(makeContext(signedRequest('partner.ping'), 'partner.ping'))).toThrow(
      NotFoundException,
    );
  });
});

describe('PartnerSignatureGuard — vérification', () => {
  it('signature valide ⇒ passe', () => {
    const req = signedRequest('partner.webhook', JSON.stringify({ a: 1 }));
    const guard = makeGuard(makeConfig(), 'partner.webhook');
    expect(guard.canActivate(makeContext(req, 'partner.webhook'))).toBe(true);
  });

  it('GET sans corps ⇒ rawBody traité comme chaîne vide', () => {
    const req = signedRequest('partner.ping', '', 'GET');
    const guard = makeGuard(makeConfig(), 'partner.ping');
    expect(guard.canActivate(makeContext(req, 'partner.ping'))).toBe(true);
  });

  it('signature valide pour une AUTRE opération ⇒ rejetée', () => {
    // Le rejeu inter-endpoints, refusé au niveau de la garde.
    const req = signedRequest('partner.ping', '', 'GET');
    const guard = makeGuard(makeConfig(), 'partner.vehicles.count');
    expect(() => guard.canActivate(makeContext(req, 'partner.vehicles.count'))).toThrow(
      UnauthorizedException,
    );
  });

  it('corps altéré après signature ⇒ rejeté', () => {
    const req = signedRequest('partner.webhook', JSON.stringify({ a: 1 }));
    req.rawBody = Buffer.from(JSON.stringify({ a: 2 }), 'utf8');
    const guard = makeGuard(makeConfig(), 'partner.webhook');
    expect(() => guard.canActivate(makeContext(req, 'partner.webhook'))).toThrow(UnauthorizedException);
  });

  it('en-têtes absents ⇒ rejeté', () => {
    const guard = makeGuard(makeConfig(), 'partner.ping');
    const req = { method: 'GET', headers: {}, rawBody: undefined };
    expect(() => guard.canActivate(makeContext(req, 'partner.ping'))).toThrow(UnauthorizedException);
  });

  it("la raison du rejet n'est JAMAIS renvoyée au client", () => {
    // Elle dirait à un attaquant quel critère il vient de franchir.
    const req = signedRequest('partner.ping', '', 'GET');
    req.headers['x-partner-signature'] = 'f'.repeat(64);
    const guard = makeGuard(makeConfig(), 'partner.ping');
    try {
      guard.canActivate(makeContext(req, 'partner.ping'));
      fail('aurait dû lever');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toBe('Invalid partner signature');
      expect(message).not.toMatch(/mismatch|timestamp|malformed|drift/i);
    }
  });
});

describe('PartnerSignatureGuard — garde-fou de programmation', () => {
  it('route SANS @PartnerOp ⇒ refus de servir', () => {
    // Sans `op`, la route accepterait une signature émise pour une autre route.
    // On préfère une panne franche à une garantie silencieusement dégradée.
    const req = signedRequest('partner.ping', '', 'GET');
    const guard = makeGuard(makeConfig(), undefined);
    expect(() => guard.canActivate(makeContext(req, undefined))).toThrow(UnauthorizedException);
  });
});

describe('PartnerConfigService', () => {
  it('actif seulement si kill-switch ET secret ET URL', () => {
    expect(makeConfig().enabled).toBe(true);
    expect(makeConfig({ PARTNER_MAESTROO_ENABLED: 'false' }).enabled).toBe(false);
    expect(makeConfig({ PARTNER_PLATFORM_SECRET: '' }).enabled).toBe(false);
    expect(makeConfig({ PARTNER_MAESTROO_API_URL: '' }).enabled).toBe(false);
  });

  it('la raison de l\'extinction est explicite (diagnostic en prod)', () => {
    expect(makeConfig().disabledReason).toBeNull();
    expect(makeConfig({ PARTNER_MAESTROO_ENABLED: 'false' }).disabledReason).toBe(
      'PARTNER_MAESTROO_ENABLED=false',
    );
    expect(makeConfig({ PARTNER_PLATFORM_SECRET: '' }).disabledReason).toBe(
      'PARTNER_PLATFORM_SECRET manquant',
    );
    expect(makeConfig({ PARTNER_MAESTROO_API_URL: '' }).disabledReason).toBe(
      'PARTNER_MAESTROO_API_URL manquant',
    );
  });

  it('l\'URL du pair est normalisée (pas de slash final)', () => {
    // Sinon on construirait `https://api.maestroo.app//partner/v1/...`.
    expect(makeConfig({ PARTNER_MAESTROO_API_URL: 'https://api.maestroo.app/' }).maestrooApiUrl).toBe(
      'https://api.maestroo.app',
    );
  });
});
