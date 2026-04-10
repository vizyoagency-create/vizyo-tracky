import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { CobanAlarmType, CobanPositionFrame } from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { AlertsService } from '../alerts/alerts.service';
import { PositionsService } from '../positions/positions.service';
import { PrismaService } from '../prisma/prisma.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { FakeTcpSocket } from './fake-tcp-socket';
import { RealtimeGateway } from './realtime.gateway';

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
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private trackers = new Map<string, TrackerState>();
  private fakeSockets = new Map<string, FakeTcpSocket>();
  private enabled = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly positions: PositionsService,
    private readonly alertsService: AlertsService,
    private readonly registry: SocketRegistryService,
    private readonly gateway: RealtimeGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    const mockEnabled = this.config.get('MOCK_POSITIONS', { infer: true }) === 'true';
    const nodeEnv = this.config.get('NODE_ENV', { infer: true });

    if (!mockEnabled || nodeEnv === 'production') {
      this.logger.warn('Mock position emitter DISABLED');
      return;
    }

    this.enabled = true;
    this.logger.warn('Mock position emitter ENABLED');

    await this.syncTrackers();

    this.tickInterval = setInterval(() => this.tick(), 2000);
    this.refreshInterval = setInterval(() => this.syncTrackers(), 30_000);
  }

  onModuleDestroy(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    for (const [imei, socket] of this.fakeSockets) {
      this.registry.unregister(imei);
      socket.destroy();
    }
    this.fakeSockets.clear();
    this.trackers.clear();
  }

  @OnEvent('tracker.assigned')
  async onTrackerAssigned(payload: { trackerId: string; imei: string }): Promise<void> {
    if (!this.enabled) return;

    const tracker = await this.prisma.tracker.findUnique({
      where: { id: payload.trackerId },
      include: { vehicle: true },
    });
    if (!tracker || !tracker.vehicle) return;

    if (this.fakeSockets.has(tracker.imei)) return;

    this.registerFakeTracker(tracker.id, tracker.imei, tracker.vehicle.fleetId);
    this.logger.warn(`[MOCK] Tracker ${tracker.imei} assigned — fake socket registered instantly`);
  }

  @OnEvent('tracker.unassigned')
  onTrackerUnassigned(payload: { trackerId: string; imei: string }): void {
    if (!this.enabled) return;

    const imei = payload.imei;
    const socket = this.fakeSockets.get(imei);
    if (socket) {
      this.registry.unregister(imei);
      socket.destroy();
      this.fakeSockets.delete(imei);
    }

    for (const [id, state] of this.trackers) {
      if (state.imei === imei) {
        this.trackers.delete(id);
        break;
      }
    }

    this.logger.warn(`[MOCK] Tracker ${imei} unassigned — fake socket removed`);
  }

  private async syncTrackers(): Promise<void> {
    const assigned = await this.prisma.tracker.findMany({
      where: { vehicleId: { not: null } },
      include: { vehicle: true },
      take: 50,
    });

    const assignedImeis = new Set(assigned.map((t) => t.imei));

    for (const t of assigned) {
      if (!this.fakeSockets.has(t.imei)) {
        this.registerFakeTracker(t.id, t.imei, t.vehicle?.fleetId);
        this.logger.warn(`[MOCK] Sync: registered fake socket for ${t.imei}`);
      }
    }

    for (const [imei, socket] of this.fakeSockets) {
      if (!assignedImeis.has(imei)) {
        this.registry.unregister(imei);
        socket.destroy();
        this.fakeSockets.delete(imei);
        for (const [id, state] of this.trackers) {
          if (state.imei === imei) { this.trackers.delete(id); break; }
        }
        this.logger.warn(`[MOCK] Sync: removed fake socket for ${imei}`);
      }
    }
  }

  private registerFakeTracker(trackerId: string, imei: string, fleetId?: string): void {
    const state: TrackerState = {
      imei,
      lat: 33.5731 + (Math.random() - 0.5) * 0.01,
      lng: -7.5898 + (Math.random() - 0.5) * 0.01,
      heading: Math.random() * 360,
      speedKmh: Math.random() * 40,
      ignition: true,
    };
    this.trackers.set(trackerId, state);

    const fakeSocket = new FakeTcpSocket(
      imei,
      (i, action) => this.handleMockCommand(i, action),
    );
    this.fakeSockets.set(imei, fakeSocket);
    this.registry.register(imei, fakeSocket);

    if (fleetId) {
      this.gateway.emitTrackerStatus(fleetId, {
        trackerId, imei, status: 'online', at: new Date().toISOString(),
      });
    }
  }

  private handleMockCommand(imei: string, action: 'CUT' | 'RESTORE'): void {
    for (const state of this.trackers.values()) {
      if (state.imei === imei) {
        state.ignition = action === 'RESTORE';
        if (action === 'CUT') state.speedKmh = 0;
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

      const alarm = this.maybeInjectAlarm();

      const fakeFrame: CobanPositionFrame = {
        type: 'position',
        imei: state.imei,
        alarm,
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

        if (alarm !== 'none') {
          const tracker = await this.prisma.tracker.findUnique({
            where: { imei: state.imei },
            include: { vehicle: { include: { fleet: true } } },
          });
          if (tracker) {
            await this.alertsService.createFromCobanFrame(fakeFrame, tracker as any);
          }
        }
      } catch (err) {
        this.logger.error(`Mock ingest failed for ${state.imei}`, err);
      }
    }
  }

  private readonly WARNING_ALARMS: CobanAlarmType[] = [
    'harsh_braking', 'harsh_acceleration', 'overspeed', 'movement', 'low_battery',
  ];
  private readonly CRITICAL_ALARMS: CobanAlarmType[] = ['sos', 'accident', 'power_cut'];

  private maybeInjectAlarm(): CobanAlarmType {
    const r = Math.random();
    if (r < 0.003) return this.CRITICAL_ALARMS[Math.floor(Math.random() * this.CRITICAL_ALARMS.length)]!;
    if (r < 0.023) return this.WARNING_ALARMS[Math.floor(Math.random() * this.WARNING_ALARMS.length)]!;
    return 'none';
  }
}
