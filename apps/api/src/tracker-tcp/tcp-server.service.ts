import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackerStatus } from '@prisma/client';
import { decodeFrame } from '@vizyo/tracky-shared';
import type { CobanFrame } from '@vizyo/tracky-shared';
import { createServer, type Server, type Socket } from 'node:net';
import type { Env } from '../config/env.validation';
import { PositionsService } from '../positions/positions.service';
import { PrismaService } from '../prisma/prisma.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';

@Injectable()
export class TcpServerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TcpServerService.name);
  private server: Server | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly registry: SocketRegistryService,
    private readonly prisma: PrismaService,
    private readonly positions: PositionsService,
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
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(300_000);

    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.debug(`Incoming TCP connection from ${remote}`);

    let boundImei: string | null = null;
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('ascii');

      let idx: number;
      while ((idx = buffer.search(/[;\r\n]/)) !== -1) {
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!raw) continue;

        this.logger.debug(`← [${remote}] ${raw}`);

        try {
          const frame = decodeFrame(raw);
          this.dispatchFrame(frame, socket, boundImei, (newImei) => {
            boundImei = newImei;
          }).catch((err) => {
            this.logger.error(`Frame dispatch failed: ${raw}`, err);
          });
        } catch (err) {
          this.logger.error(`Unexpected decode error: ${raw}`, err);
        }
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
      if (boundImei) {
        this.registry.unregister(boundImei);
        this.prisma.tracker.updateMany({
          where: { imei: boundImei },
          data: { status: TrackerStatus.OFFLINE },
        }).catch((e) => this.logger.error(`Failed to set offline: ${boundImei}`, e));
      }
    });
  }

  private async dispatchFrame(
    frame: CobanFrame,
    socket: Socket,
    currentImei: string | null,
    setImei: (imei: string) => void,
  ): Promise<void> {
    switch (frame.type) {
      case 'login': {
        const tracker = await this.prisma.tracker.findUnique({
          where: { imei: frame.imei },
        });
        if (!tracker) {
          this.logger.warn(`Unknown IMEI attempting login: ${frame.imei}`);
          socket.end();
          return;
        }
        setImei(frame.imei);
        this.registry.register(frame.imei, socket);
        socket.write('LOAD');
        await this.prisma.tracker.update({
          where: { id: tracker.id },
          data: { status: TrackerStatus.ONLINE, lastSeenAt: new Date() },
        });
        this.logger.log(`Tracker connected: ${frame.imei}`);
        break;
      }

      case 'heartbeat': {
        if (frame.imei !== currentImei) {
          this.logger.warn(`Heartbeat IMEI mismatch: got ${frame.imei}, expected ${currentImei}`);
          break;
        }
        this.registry.touch(frame.imei);
        socket.write('ON');
        break;
      }

      case 'position': {
        if (!currentImei) {
          this.logger.warn(`Position received before login: ${frame.raw}`);
          break;
        }
        if (frame.imei !== currentImei) {
          this.logger.warn(`Position IMEI mismatch: got ${frame.imei}, expected ${currentImei}`);
          break;
        }
        await this.positions.ingest(frame);

        if (frame.alarm === 'sos') {
          socket.write(`**,imei:${currentImei},E;`);
          this.logger.warn(`SOS alarm from ${currentImei}, ACK sent`);
        }
        if (['power_cut', 'accident', 'collision'].includes(frame.alarm)) {
          this.logger.warn(`Critical alarm "${frame.alarm}" from ${currentImei}: ${frame.raw}`);
        }
        break;
      }

      case 'unknown': {
        this.logger.warn(`Unknown frame (${frame.reason}): ${frame.raw}`);
        break;
      }
    }
  }
}
