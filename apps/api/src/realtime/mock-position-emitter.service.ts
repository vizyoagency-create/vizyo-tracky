import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CobanPositionFrame } from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { PositionsService } from '../positions/positions.service';
import { PrismaService } from '../prisma/prisma.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { FakeTcpSocket } from './fake-tcp-socket';

interface TrackerState {
  imei: string;
  lat: number;
  lng: number;
  heading: number;
  speedKmh: number;
  ignition: boolean;
}

@Injectable()
export class MockPositionEmitterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MockPositionEmitterService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private trackers = new Map<string, TrackerState>();
  private fakeSockets = new Map<string, FakeTcpSocket>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly positions: PositionsService,
    private readonly registry: SocketRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const mockEnabled = this.config.get('MOCK_POSITIONS', { infer: true }) === 'true';
    const nodeEnv = this.config.get('NODE_ENV', { infer: true });

    if (!mockEnabled || nodeEnv === 'production') return;

    const assignedTrackers = await this.prisma.tracker.findMany({
      where: { vehicleId: { not: null } },
      include: { vehicle: true },
      take: 10,
    });

    if (assignedTrackers.length === 0) {
      this.logger.warn('No assigned trackers found for mock emitter');
      return;
    }

    for (const t of assignedTrackers) {
      const state: TrackerState = {
        imei: t.imei,
        lat: 33.5731 + (Math.random() - 0.5) * 0.01,
        lng: -7.5898 + (Math.random() - 0.5) * 0.01,
        heading: Math.random() * 360,
        speedKmh: Math.random() * 40,
        ignition: true,
      };
      this.trackers.set(t.id, state);

      const fakeSocket = new FakeTcpSocket(
        t.imei,
        (imei, action) => this.handleMockCommand(imei, action),
      );
      this.fakeSockets.set(t.imei, fakeSocket);
      this.registry.register(t.imei, fakeSocket);
      this.logger.log(`[MOCK] Registered fake socket for ${t.imei}`);
    }

    this.logger.warn(
      `Mock position emitter RUNNING (${this.trackers.size} trackers with fake sockets) — do not enable in production`,
    );

    this.interval = setInterval(() => this.tick(), 2000);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const [imei, socket] of this.fakeSockets) {
      this.registry.unregister(imei);
      socket.destroy();
    }
    this.fakeSockets.clear();
    this.trackers.clear();
  }

  private handleMockCommand(imei: string, action: 'CUT' | 'RESTORE'): void {
    for (const state of this.trackers.values()) {
      if (state.imei === imei) {
        state.ignition = action === 'RESTORE';
        if (action === 'CUT') {
          state.speedKmh = 0;
        }
        this.logger.log(`[MOCK] State updated for ${imei}: ignition=${state.ignition}`);
        return;
      }
    }
  }

  private async tick(): Promise<void> {
    for (const state of this.trackers.values()) {
      if (state.ignition) {
        state.lat += (Math.random() - 0.5) * 0.001;
        state.lng += (Math.random() - 0.5) * 0.001;
        state.heading = (state.heading + (Math.random() - 0.5) * 30 + 360) % 360;
        state.speedKmh = Math.max(0, Math.min(80, state.speedKmh + (Math.random() - 0.5) * 20));
      } else {
        state.speedKmh = 0;
      }

      const fakeFrame: CobanPositionFrame = {
        type: 'position',
        imei: state.imei,
        alarm: 'none',
        deviceTime: new Date(),
        valid: true,
        latitude: state.lat,
        longitude: state.lng,
        speedKph: Math.round(state.speedKmh * 100) / 100,
        course: Math.round(state.heading * 100) / 100,
        altitude: 0,
        ignition: state.ignition,
        raw: '[mock]',
      };

      try {
        await this.positions.ingest(fakeFrame);
      } catch (err) {
        this.logger.error(`Mock ingest failed for ${state.imei}`, err);
      }
    }
  }
}
