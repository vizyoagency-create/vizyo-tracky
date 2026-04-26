import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request = require('supertest');
import { HealthController } from '../../src/health/health.controller';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * V1.6 (P5) — Test d'integration HealthController.
 *
 * Pattern : on bootstrap le HealthController avec ThrottlerModule + un
 * PrismaService mocke pour valider qu'un endpoint critique repond
 * correctement avec tout le pipeline NestJS (controller resolution,
 * validation, throttling, error handling).
 *
 * Etendre ce pattern pour couvrir d'autres endpoints en ajoutant les mocks
 * adequats (services + JwtAuthGuard / RolesGuard pour les routes protegees).
 */
describe('HealthController (e2e-soft)', () => {
  async function buildApp(prismaMock: { $queryRawUnsafe: jest.Mock }): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }])],
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaMock },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  it('GET /health → 200 + status ok quand DB up', async () => {
    const app = await buildApp({
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ ok: 1 }]),
    });
    try {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(res.body.services?.database).toBe('connected');
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
    }
  });

  it('GET /health → 503 + degraded quand DB down', async () => {
    const app = await buildApp({
      $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('DB down')),
    });
    try {
      const res = await request(app.getHttpServer()).get('/health').expect(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.services.database).toBe('disconnected');
    } finally {
      await app.close();
    }
  });
});
