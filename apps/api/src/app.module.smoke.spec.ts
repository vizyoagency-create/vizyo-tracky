/**
 * SMOKE-BOOT — vérifie que le graphe d'injection de dépendances de l'API se résout.
 *
 * Pourquoi ce test existe (2026-07-22) : le module `api-traffic` est parti en production
 * sans importer `AuthModule`, alors que son contrôleur utilise `JwtAuthGuard`. L'API a
 * démarré en boucle de plantage et l'ingestion GPS est tombée. Le typecheck était vert,
 * les 1000+ tests unitaires étaient verts — parce qu'AUCUN n'instancie l'application
 * entière. Les tests unitaires fournissent leurs dépendances à la main : par construction,
 * ils ne peuvent pas voir un `imports:` manquant.
 *
 * Ce que ce test attrape : `UnknownDependenciesException`, dépendances circulaires,
 * providers non déclarés, tokens d'injection absents — c'est-à-dire tout ce qui fait
 * qu'un conteneur redémarre en boucle au lieu de servir.
 *
 * `.compile()` construit le graphe et instancie les providers, mais n'appelle PAS
 * `onModuleInit` : aucune connexion base/réseau n'est ouverte. C'est précisément la
 * frontière voulue — on valide le CÂBLAGE, pas le comportement.
 *
 * ⚠️ Si ce test échoue après l'ajout d'un module : ne le neutralisez pas. Il décrit une
 * panne de démarrage bien réelle. Le correctif est presque toujours un `imports:` manquant
 * dans le module fautif (nommé dans le message d'erreur Nest).
 */
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

/**
 * Env factice, suffisant pour `validateEnv`. Volontairement inerte : URL non résolvables
 * et secrets bidon — rien ici ne doit permettre d'atteindre un vrai service.
 */
const FAKE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://smoke:smoke@127.0.0.1:1/smoke?schema=public',
  REDIS_URL: 'redis://127.0.0.1:1',
  VIZYO_AUTH_API_URL: 'http://127.0.0.1:1',
  VIZYO_AUTH_APP_ID: 'app_smoke_boot',
  VIZYO_AUTH_APP_SECRET: 'smoke_secret_at_least_16_chars',
  VIZYO_AUTH_JWT_ACCESS_SECRET: 'smoke_jwt_secret',
  VIZYO_AUTH_JWT_ISSUER: 'http://127.0.0.1:1',
  VIZYO_AUTH_APP_INTERNAL_ID: 'smoke_internal_id',
  INTERNAL_API_SECRET: 'smoke_internal_at_least_16_chars',
};

describe("SMOKE-BOOT — graphe d'injection de l'API", () => {
  const saved = new Map<string, string | undefined>();
  let moduleRef: TestingModule | undefined;

  beforeAll(() => {
    for (const [key, value] of Object.entries(FAKE_ENV)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  afterAll(async () => {
    // `close()` déclenche onModuleDestroy : c'est lui qui arrête les setInterval
    // démarrés par certains constructeurs. Sans ça, le worker Jest reste vivant et
    // les timers se réveillent pendant une AUTRE suite.
    await moduleRef?.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("résout toutes les dépendances de l'application complète", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { AppModule } = require('./app.module') as { AppModule: unknown };

    moduleRef = await Test.createTestingModule({
      imports: [AppModule as never],
    }).compile();

    expect(moduleRef).toBeDefined();
  }, 120_000); // le graphe complet est gros ; le défaut de 5 s ne suffit pas
});
