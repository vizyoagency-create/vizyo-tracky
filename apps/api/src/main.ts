import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ErrorLogger } from './observability/error-logger.service';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

/**
 * Filet de sécurité PROCESS — « zéro erreur fantôme ». Une Promise rejetée sans `.catch`
 * ou un `throw` synchrone dans un timer/callback échappe à AllExceptionsFilter (qui ne voit
 * que le pipeline HTTP) : sans handler, Node les avale silencieusement OU crashe le process.
 * On les remonte au centre d'alerte (error_logs) et on CONTINUE de servir : pour un ingesteur
 * GPS live, une erreur visible-mais-survivante vaut mieux qu'un crash-loop invisible.
 */
function installProcessSafetyNet(errorLogger: ErrorLogger, log: Logger): void {
  process.on('unhandledRejection', (reason: unknown) => {
    log.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
    errorLogger.recordBackground(
      reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`),
      'process:unhandledRejection',
      {},
      'CRITICAL',
    );
  });
  process.on('uncaughtException', (err: Error) => {
    log.error(`Uncaught exception: ${err?.stack ?? String(err)}`);
    errorLogger.recordBackground(err, 'process:uncaughtException', {}, 'CRITICAL');
    // Volontairement, on NE quitte PAS : cf. commentaire ci-dessus (survie > crash-loop).
  });
}

async function bootstrap() {
  // rawBody: true => req.rawBody dispo pour verifier la signature HMAC du webhook
  // entrant vizyo-texto (X-Vizyo-Signature) sans dependre du re-serialize du JSON.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  const pinoLogger = app.get(Logger);
  app.useLogger(pinoLogger);

  // Filet process AVANT tout le reste : capte les rejets/exceptions d'arrière-plan qui
  // n'atteignent pas AllExceptionsFilter, et les rend visibles au centre d'alerte.
  installProcessSafetyNet(app.get(ErrorLogger), pinoLogger);

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

  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:4200')
    .split(',')
    .map((o) => o.trim());
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
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
