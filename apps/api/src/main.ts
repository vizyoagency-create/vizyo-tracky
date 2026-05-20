import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // V1.10 (Sprint 6) — cookie-parser pour lire les cookies httpOnly tracky_at
  // (access JWT) et tracky_rt (refresh JWT). Migration depuis localStorage cote
  // frontend pour reduire la surface XSS (cf. docs/19-tech-debt-auth-httponly.md).
  app.use(cookieParser());

  // V1.10 (Sprint 6) — Adapter Redis pour Socket.io. Active si REDIS_URL
  // defini, sinon fallback memory (single-instance). A faire AVANT app.listen()
  // pour que createIOServer attache l'adapter avant la 1ere connexion WS.
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200',
    credentials: true, // necessaire pour que le browser envoie les cookies cross-origin
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  app.get(Logger).log(`API ready on http://localhost:${port}/api`);
}

bootstrap();
