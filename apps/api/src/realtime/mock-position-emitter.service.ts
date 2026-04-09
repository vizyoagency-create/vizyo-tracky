import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PositionUpdateEvent } from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from './realtime.gateway';

interface TrackerState {
  trackerId: string;
  vehicleId: string;
  fleetId: string;
  lat: number;
  lng: number;
  heading: number;
  speedKmh: number;
}

@Injectable()
export class MockPositionEmitterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MockPositionEmitterService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private trackers = new Map<string, TrackerState>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
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
      this.trackers.set(t.id, {
        trackerId: t.id,
        vehicleId: t.vehicleId!,
        fleetId: t.vehicle!.fleetId,
        lat: 33.5731 + (Math.random() - 0.5) * 0.01,
        lng: -7.5898 + (Math.random() - 0.5) * 0.01,
        heading: Math.random() * 360,
        speedKmh: Math.random() * 40,
      });
    }

    this.logger.warn(
      `Mock position emitter RUNNING (${this.trackers.size} trackers) — do not enable in production`,
    );

    this.interval = setInterval(() => this.tick(), 2000);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick(): Promise<void> {
    for (const state of this.trackers.values()) {
      state.lat += (Math.random() - 0.5) * 0.001;
      state.lng += (Math.random() - 0.5) * 0.001;
      state.heading = (state.heading + (Math.random() - 0.5) * 30 + 360) % 360;
      state.speedKmh = Math.max(0, Math.min(80, state.speedKmh + (Math.random() - 0.5) * 20));

      const timestamp = new Date();

      try {
        await this.prisma.position.create({
          data: {
            trackerId: state.trackerId,
            lat: state.lat,
            lng: state.lng,
            speedKmh: Math.round(state.speedKmh * 100) / 100,
            heading: Math.round(state.heading * 100) / 100,
            timestamp,
          },
        });
      } catch (err) {
        this.logger.error(`Failed to persist mock position for ${state.trackerId}`, err);
      }

      const event: PositionUpdateEvent = {
        trackerId: state.trackerId,
        vehicleId: state.vehicleId,
        fleetId: state.fleetId,
        lat: state.lat,
        lng: state.lng,
        speedKmh: Math.round(state.speedKmh * 100) / 100,
        heading: Math.round(state.heading * 100) / 100,
        timestamp: timestamp.toISOString(),
      };

      this.gateway.broadcastPosition(state.fleetId, event);
    }
  }
}
