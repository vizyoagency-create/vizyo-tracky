import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type Server, type Socket } from 'node:net';
import type { Env } from '../config/env.validation';
import { parseCobanFrame } from './coban.parser';
import { SocketRegistryService } from './socket-registry.service';

@Injectable()
export class TcpServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TcpServerService.name);
  private server: Server | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly registry: SocketRegistryService,
  ) {}

  onModuleInit(): void {
    const port = this.config.get('TRACKER_TCP_PORT', { infer: true });
    this.server = createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (err) => {
      this.logger.error('TCP server error', err);
    });

    this.server.listen(port, () => {
      this.logger.log(`Coban TCP server listening on :${port}`);
    });
  }

  onModuleDestroy(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.logger.log('TCP server closed');
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(300_000);

    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.debug(`Incoming TCP connection from ${remote}`);

    let boundImei: string | null = null;
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('ascii');

      let endIdx: number;
      while ((endIdx = buffer.indexOf('#')) !== -1) {
        const raw = buffer.slice(0, endIdx + 1);
        buffer = buffer.slice(endIdx + 1);

        const frame = parseCobanFrame(raw);
        this.logger.debug(`Frame from ${remote}: ${raw}`);

        if (frame.imei) {
          if (!boundImei) {
            boundImei = frame.imei;
            this.registry.register(boundImei, socket);
          } else {
            this.registry.touch(boundImei);
          }
        }
        // TODO: dispatch vers PositionIngestService quand le parser sera complet
      }
    });

    socket.on('timeout', () => {
      this.logger.warn(`Socket timeout ${remote} (imei=${boundImei ?? 'unbound'})`);
      socket.destroy();
    });

    socket.on('error', (err) => {
      this.logger.warn(`Socket error ${remote}: ${err.message}`);
    });

    socket.on('close', () => {
      this.logger.debug(`Socket closed ${remote} (imei=${boundImei ?? 'unbound'})`);
      if (boundImei) this.registry.unregister(boundImei);
    });
  }
}
