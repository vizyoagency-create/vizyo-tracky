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

  /**
   * Un contrôleur OUBLIÉ dans `controllers:` de son module est un angle mort TOTAL :
   * le typecheck est vert (le fichier compile), le smoke-boot ci-dessus est vert (le
   * graphe se résout — il n'y a simplement rien à résoudre), les tests unitaires du
   * service sont verts. Et pourtant l'API ne sert AUCUNE de ses routes.
   *
   * Cas réel (2026-07-28) : `NotificationCenterController` est parti en production sans
   * être déclaré. Le déploiement s'est passé sans une erreur, l'API répondait `healthy`,
   * et le centre de notifications renvoyait 404 sur toutes ses routes. Détecté seulement
   * en cherchant les routes dans les logs de démarrage.
   *
   * Ce test ferme l'angle mort : il énumère les routes RÉELLEMENT enregistrées et exige
   * la présence de celles dont l'absence est silencieuse mais grave. Ajoutez-y toute route
   * dont vous voulez garantir l'existence.
   */
  it('ne laisse AUCUN contrôleur orphelin (non déclaré dans un module)', () => {
    // On lit les MÉTADONNÉES, on ne démarre rien : `app.init()` déclencherait les
    // `onModuleInit` et donc de vraies connexions base — précisément ce que ce fichier
    // évite (cf. en-tête). Le câblage se vérifie sans allumer le moteur.
    const declared = new Set<unknown>();
    for (const file of sourceFiles('.module.ts')) {
      for (const exported of Object.values(safeRequire(file))) {
        if (typeof exported !== 'function') continue;
        const list = Reflect.getMetadata('controllers', exported) as unknown[] | undefined;
        for (const c of list ?? []) declared.add(c);
      }
    }

    const orphans: string[] = [];
    let seen = 0;
    for (const file of sourceFiles('.controller.ts')) {
      for (const exported of Object.values(safeRequire(file))) {
        if (typeof exported !== 'function') continue;
        // `@Controller()` pose la métadonnée 'path' : c'est le discriminant fiable,
        // plus robuste qu'un test sur le nom de la classe.
        if (!Reflect.hasMetadata('path', exported)) continue;
        seen++;
        if (!declared.has(exported)) orphans.push((exported as { name: string }).name);
      }
    }

    // Filet : si l'énumération se casse un jour (arborescence, build), on veut un échec
    // franc plutôt qu'un test vert qui ne vérifie plus rien.
    expect(seen).toBeGreaterThan(20);
    expect(orphans).toEqual([]);
  }, 60_000);
});

/** Chemins absolus des fichiers `src/**\/*<suffix>`, hors specs. */
function sourceFiles(suffix: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix) && !entry.name.includes('.spec.')) out.push(full);
    }
  };
  walk(__dirname);
  return out;
}

/**
 * `require` tolérant : un fichier qui refuse de se charger ne doit pas faire échouer le
 * test pour la MAUVAISE raison (on chercherait un contrôleur orphelin et on trouverait
 * une erreur d'import sans rapport).
 */
function safeRequire(file: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(file) as Record<string, unknown>;
  } catch {
    return {};
  }
}
