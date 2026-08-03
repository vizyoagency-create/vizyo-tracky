import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  // Typé `NestExpressApplication` pour accéder à `app.set(...)` — nécessaire au réglage
  // « trust proxy » ci-dessous. Aucun changement de comportement : c'est du typage.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const pinoLogger = app.get(Logger);
  app.useLogger(pinoLogger);

  // Filet process AVANT tout le reste : capte les rejets/exceptions d'arrière-plan qui
  // n'atteignent pas AllExceptionsFilter, et les rend visibles au centre d'alerte.
  installProcessSafetyNet(app.get(ErrorLogger), pinoLogger);

  // ══ IP RÉELLE DU CLIENT DERRIÈRE TRAEFIK ═════════════════════════════════════════
  //
  // ⚠️ CONSTAT DU 2026-08-03. Sans ce réglage, `req.ip` valait l'adresse du conteneur
  // Traefik. Vérifié dans le journal d'erreurs de production : `::ffff:172.18.0.4` —
  // une adresse Docker interne, identique pour tous les clients.
  //
  // Les journaux applicatifs, eux, montraient les vraies adresses : cinq endroits du
  // code extraient `x-forwarded-for` à la main. Le défaut était donc invisible là où on
  // regardait, et bien réel là où personne ne regardait :
  //
  //   `ThrottlerGuard` compte par `req.ip`. Toutes les requêtes partageaient donc UN
  //   SEUL compteur. Les limites anti-force-brute (login, envoi de code…) n'étaient pas
  //   par client : un attaquant consommait le quota de tout le monde, et un utilisateur
  //   légitime pouvait se retrouver bloqué par le trafic d'un autre.
  //
  // ⚠️⚠️ POURQUOI `1` ET SURTOUT PAS `true`.
  //
  // `true` fait confiance à l'en-tête `X-Forwarded-For` ENTIER, y compris à la partie
  // écrite par le client. Il suffirait alors d'envoyer `X-Forwarded-For: 1.2.3.4`, en
  // changeant de valeur à chaque requête, pour obtenir un compteur neuf à chaque fois —
  // c'est-à-dire pour contourner TOUTES les limites de débit. On aurait remplacé un
  // compteur trop large par une protection nulle, en croyant l'améliorer.
  //
  // `1` = un seul intermédiaire de confiance. Express ne remonte alors que d'un cran et
  // retient l'adresse ajoutée par Traefik, la seule que le client ne peut pas écrire.
  //
  // ⚠️ Ce nombre doit rester égal au nombre de proxys RÉELLEMENT devant l'API. Vérifié
  // ce jour : Traefik seul, pas de Cloudflare (aucun en-tête `CF-Ray` sur les réponses).
  // Ajouter un CDN devant sans passer ce `1` à `2` ferait compter l'adresse du CDN.
  app.set('trust proxy', 1);

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
