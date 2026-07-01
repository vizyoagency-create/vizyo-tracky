import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import type { ServerOptions, Server } from 'socket.io';

/**
 * V1.10 (Sprint 6) — Custom IoAdapter qui branche le Redis adapter sur le
 * Socket.io Server au moment de sa creation. Permet le scale horizontal :
 * plusieurs instances API partagent leurs broadcasts WS via pub/sub Redis.
 *
 * Pattern Nest officiel : on extend IoAdapter (de @nestjs/platform-socket.io)
 * et on override createIOServer pour intercepter le Server avant qu'il ne
 * commence a accepter des connexions, et lui assigner l'adapter Redis.
 *
 * Sans REDIS_URL ou si l'init Redis echoue, on retombe sur le memory adapter
 * (single-instance fallback). Pas de crash boot.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ((nsp: unknown) => unknown) | null = null;
  private redisPub: { quit: () => Promise<unknown> } | null = null;
  private redisSub: { quit: () => Promise<unknown> } | null = null;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /**
   * A appeler avant `app.useWebSocketAdapter(adapter)` dans main.ts. Tente la
   * connexion Redis et prepare le constructor. Si echec, on log et on laisse
   * adapterConstructor a null -> createIOServer utilisera le memory adapter.
   */
  async connectToRedis(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.log('[ws-adapter] REDIS_URL absent — memory adapter (single instance)');
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { createAdapter } = require('@socket.io/redis-adapter') as typeof import('@socket.io/redis-adapter');
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const Redis = require('ioredis').default ?? require('ioredis');

      this.redisPub = new Redis(redisUrl);
      this.redisSub = ((this.redisPub as unknown) as { duplicate: () => unknown }).duplicate() as {
        quit: () => Promise<unknown>;
      };
      this.adapterConstructor = createAdapter(this.redisPub as any, this.redisSub as any) as (
        nsp: unknown,
      ) => unknown;
      this.logger.log('[ws-adapter] Redis adapter prepared (multi-instance ready)');
    } catch (err) {
      this.logger.warn(
        `[ws-adapter] Redis adapter init failed, falling back to memory: ${err instanceof Error ? err.message : err}`,
      );
      this.redisPub = null;
      this.redisSub = null;
      this.adapterConstructor = null;
    }
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    // Tolérance ping ÉLARGIE (cause racine des faux « live interrompu 45s »). Défauts socket.io :
    // pingInterval 25s / pingTimeout 20s → fenêtre de coupure ~45s (= signature EXACTE observée en
    // prod : tous les incidents pile à 45s). Sous charge VPS (2 vCPU), l'API rate un pong bref → le
    // socket est coupé → 45s de gap live. On porte pingTimeout à 60s (tolérance ~85s avant coupure) :
    // un pic de charge court ne tue plus le live. Un client réellement mort est détecté un peu plus
    // tard, mais il a sa propre reconnexion → sans impact utilisateur.
    const tuned = {
      ...(options ?? {}),
      pingInterval: 25_000,
      pingTimeout: 60_000,
    } as ServerOptions;
    const server = super.createIOServer(port, tuned) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor as Parameters<Server['adapter']>[0]);
    }
    return server;
  }

  async disconnectFromRedis(): Promise<void> {
    await Promise.all([
      this.redisPub?.quit().catch(() => undefined),
      this.redisSub?.quit().catch(() => undefined),
    ]);
  }
}
