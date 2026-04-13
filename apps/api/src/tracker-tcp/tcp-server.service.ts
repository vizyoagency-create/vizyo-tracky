import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackerStatus } from '@prisma/client';
import { decodeFrame } from '@vizyo/tracky-shared';
import type { CobanFrame } from '@vizyo/tracky-shared';
import { createServer, type Server, type Socket } from 'node:net';
import type { Env } from '../config/env.validation';
import { AlertsService } from '../alerts/alerts.service';
import { PositionsService } from '../positions/positions.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';
import { ErrorLogger } from '../observability/error-logger.service';
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
    private readonly alertsService: AlertsService,
    private readonly gateway: RealtimeGateway,
    private readonly wireLogger: CobanWireLogger,
    private readonly errorLogger: ErrorLogger,
    private readonly ackWaiter: AckWaiterService,
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
          if (boundImei || frame.type === 'login') {
            this.wireLogger.in(
              frame.type === 'login' ? (frame as any).imei : (boundImei ?? 'unknown'),
              raw,
              frame.type,
            );
          }
          this.dispatchFrame(frame, socket, boundImei, (newImei) => {
            boundImei = newImei;
          }).catch((err) => {
            this.errorLogger.record(
              err instanceof Error ? err : new Error(String(err)),
              'tcp-server',
              { imei: boundImei ?? undefined, frameRaw: raw },
            ).catch(() => {});
          });
        } catch (err) {
          this.errorLogger.record(
            err instanceof Error ? err : new Error(String(err)),
            'tcp-server',
            { imei: boundImei ?? undefined, frameRaw: raw },
          ).catch(() => {});
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
      this.logger.warn({ imei: boundImei, remoteAddr: remote }, `Socket closed (imei=${boundImei ?? 'unbound'})`);
      if (boundImei) {
        this.registry.unregister(boundImei);
        this.prisma.tracker.findUnique({
          where: { imei: boundImei },
          include: { vehicle: true },
        }).then((tracker) => {
          if (!tracker) return;
          return this.prisma.tracker.update({
            where: { id: tracker.id },
            data: { status: TrackerStatus.OFFLINE },
          }).then(() => {
            if (tracker.vehicle) {
              this.gateway.emitTrackerStatus(tracker.vehicle.fleetId, {
                trackerId: tracker.id,
                imei: tracker.imei,
                status: 'offline',
                at: new Date().toISOString(),
              });
            }
          });
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
        this.logger.log({ imei: frame.imei, remoteAddr: socket.remoteAddress, frameRaw: frame.raw }, `Tracker connected: ${frame.imei}`);
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
        this.logger.debug(
          { imei: frame.imei, lat: frame.latitude, lng: frame.longitude, speed: frame.speedKph, valid: frame.valid },
          `Position from ${frame.imei}`,
        );
        await this.positions.ingest(frame);

        if (frame.alarm && frame.alarm !== 'none') {
          const tracker = await this.prisma.tracker.findUnique({
            where: { imei: frame.imei },
            include: { vehicle: { include: { fleet: true } } },
          });
          if (tracker) {
            await this.alertsService.createFromCobanFrame(frame, tracker as any).catch((err) =>
              this.logger.error('Failed to create alert', err),
            );
          }
        }

        if (frame.alarm === 'sos') {
          socket.write(`**,imei:${currentImei},E;`);
          this.logger.warn(`SOS alarm from ${currentImei}, ACK sent`);
        }
        break;
      }

      case 'unknown': {
        if (currentImei && this.ackWaiter.tryMatch(currentImei, frame.raw)) {
          break;
        }
        this.logger.warn({ imei: currentImei, reason: frame.reason, frameRaw: frame.raw }, `Unknown frame`);
        break;
      }
    }
  }
}
