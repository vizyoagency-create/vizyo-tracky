# 14 — Runbook tests qualite

> **Statut :** V1 — 2026-04-26 (livre Sprint O)
> **Public :** dev / QA Tracky

Procedure pour lancer / etendre la suite de tests.

---

## 1. Tests unitaires API (Jest)

### 1.1 Lancement

```bash
cd apps/api
pnpm test                                # tout
pnpm test -- --testPathPatterns=sampling # un fichier specifique
pnpm test:watch                          # mode watch
pnpm test:coverage                       # avec rapport coverage
```

### 1.2 Coverage

Le coverage est genere dans `apps/api/coverage/` (HTML + lcov + JSON).
Ouvrir `coverage/lcov-report/index.html` dans un navigateur pour la vue detaillee.

### 1.3 Seuils anti-regression

`package.json#jest.coverageThreshold` definit des seuils par fichier critique.
**Ces seuils sont des baselines** — si tu ajoutes des tests, **bump-les**
pour eviter les regressions.

| Fichier | Statements | Branches |
| --- | --- | --- |
| position-sampling.service.ts | 49% | 57% |
| tracker-fix-mode.service.ts | 50% | 44% |
| tracker-provisioning.service.ts | 24% | 11% |
| invitations.service.ts | 52% | 32% |
| corridor-geometry.ts | 81% | 73% |
| schedule-evaluator.ts | 6% | 0% |

> **TODO V1.6 :** augmenter les seuils a 70%/60% sur les services critiques.
> schedule-evaluator est gravement non couvert — ajouter des tests
> `evaluateSchedule()` (custom dates / jours feries / multi-slots).

### 1.4 Comment ajouter un test

```typescript
// apps/api/src/<module>/<service>.spec.ts
import { Test } from '@nestjs/testing';
import { MyService } from './my.service';

describe('MyService.myMethod', () => {
  let service: MyService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MyService,
        { provide: PrismaService, useValue: { /* mocks */ } },
        // ... autres deps
      ],
    }).compile();
    service = module.get(MyService);
  });

  it('should do X when Y', () => {
    expect(service.myMethod('Y')).toBe('X');
  });
});
```

---

## 2. Tests E2E web (Playwright)

### 2.1 Pre-requis

1. **API tracky tournant** : `cd apps/api && pnpm dev` (port 3000)
2. **DB de dev populee** : avoir au moins un user actif pour le login.
3. **Variables env de test** dans `apps/web/.env.test` ou `.env` :
   ```env
   E2E_TEST_EMAIL=admin@tracky.local
   E2E_TEST_PASSWORD=changeme
   # Pour onboarding wizard (user fraichement cree):
   E2E_NEW_USER_EMAIL=newuser@tracky.local
   E2E_NEW_USER_PASSWORD=changeme
   ```
4. **Browsers Playwright** : la premiere fois, lancer
   ```bash
   cd apps/web
   pnpm exec playwright install chromium
   ```

### 2.2 Lancement

```bash
cd apps/web
pnpm test:e2e           # headless
pnpm test:e2e:ui        # mode UI (debug pas-a-pas)
```

Le webServer Playwright lance automatiquement `pnpm dev` (port 4200) si pas
deja lance. Sinon, il reuse celui en cours.

### 2.3 User-flows livres

| Spec | Cas couverts |
| --- | --- |
| `e2e/login.spec.ts` | page login accessible / connexion valide redirige / connexion invalide reste sur /login |
| `e2e/onboarding-wizard.spec.ts` | wizard apparait au 1er login + navigation 5 steps (skippe sans E2E_NEW_USER_EMAIL) |

### 2.4 User-flows TODO V1.6

| Flow | Estimation |
| --- | --- |
| Creer un vehicule + assigner tracker | 1h |
| CUT moteur avec double confirmation | 1h |
| Replay d'un trip + scrub timeline | 1h |
| Override fix mode depuis /admin/trackers/:id/fix-mode | 30min |
| Provisioning SMS d'un nouveau tracker | 30min |
| Sender + accepter une invitation utilisateur | 1h |

### 2.5 Comment ajouter un test E2E

```typescript
// apps/web/e2e/<flow>.spec.ts
import { expect, test } from '@playwright/test';

test.describe('My flow', () => {
  test.beforeEach(async ({ page }) => {
    // Login si besoin
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(process.env.E2E_TEST_EMAIL ?? '');
    // ...
  });

  test('should do X', async ({ page }) => {
    await page.goto('/my-route');
    await expect(page.getByRole('button', { name: 'Click me' })).toBeVisible();
  });
});
```

Bonnes pratiques :
- **Selecteurs accessibles** (`getByRole`, `getByLabel`) plutot que CSS — plus robuste aux refactos.
- **Timeouts explicites** sur les steps reseau (8-10s pour les login / dispatch).
- **Cleanup** : si un test cree un objet en DB, le supprimer en `afterEach`.

---

## 3. Tests d'integration backend (TODO V1.6)

Pas encore livres. Pattern recommande :

1. Utiliser **Supertest** pour appeler l'API directement.
2. **DB de test isolee** sur un Postgres Docker port 5434
   (`docker run -p 5434:5432 postgis/postgis`).
3. **Reset** entre tests : `prisma migrate reset --force` ou `TRUNCATE` ciblee.
4. **Fixtures** : seed minimal (1 fleet, 1 user, 1 vehicule) via Prisma.

```typescript
// apps/api/test/integration/auth.e2e-spec.ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  it('POST /auth/login → 200 + access token', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@tracky.local', password: 'changeme' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });
});
```

---

## 4. CI (TODO)

CI GitHub Actions explicitement reportee (decision user, cf. roadmap 13). En
attendant, lancer manuellement avant chaque deploy :

```bash
pnpm typecheck                         # tous les packages
pnpm --filter @vizyo/tracky-api test   # 175 tests doivent passer
pnpm --filter @vizyo/tracky-api build  # NestJS build
pnpm --filter @vizyo/tracky-web build  # Angular prod
pnpm --filter @vizyo/tracky-web test:e2e  # E2E (optionnel — necessite DB peuplee)
```

---

## 5. Stats actuelles (V1.5)

| Mesure | Etat |
| --- | --- |
| Tests unitaires API | **175** ✅ |
| Tests unitaires shared | **72** ✅ |
| Tests integration API | 0 (TODO V1.6) |
| Tests E2E web | 2 specs (4 cas) |
| Coverage statements global | ~25% (services critiques 50-80%) |
| Coverage statements cible V1.6 | 70% sur services critiques |

---

## 6. References

- [Jest doc](https://jestjs.io/docs/getting-started)
- [Playwright doc](https://playwright.dev/docs/intro)
- [NestJS testing](https://docs.nestjs.com/fundamentals/testing)
- [Supertest](https://github.com/ladjs/supertest)
