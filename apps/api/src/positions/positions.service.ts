import { Injectable, Logger } from '@nestjs/common';
import type { CobanPositionFrame, PositionUpdateEvent } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
  ) {}

  async ingest(frame: CobanPositionFrame): Promise<void> {
    const tracker = await this.prisma.tracker.findUnique({
      where: { imei: frame.imei },
      include: { vehicle: true },
    });

    if (!tracker) {
      this.logger.warn(`Position for unknown IMEI ${frame.imei}, skipping`);
      return;
    }

    if (!frame.valid) {
      this.logger.debug(`Invalid GPS fix for ${frame.imei}, skipping persistence`);
      return;
    }

    await this.prisma.position.create({
      data: {
        trackerId: tracker.id,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        heading: frame.course ?? 0,
        altitude: frame.altitude,
        valid: frame.valid,
        timestamp: frame.deviceTime,
      },
    });

    await this.prisma.tracker.update({
      where: { id: tracker.id },
      data: { lastSeenAt: new Date(), status: 'ONLINE' },
    });

    if (tracker.vehicle) {
      const event: PositionUpdateEvent = {
        trackerId: tracker.id,
        vehicleId: tracker.vehicle.id,
        fleetId: tracker.vehicle.fleetId,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        heading: frame.course ?? 0,
        timestamp: frame.deviceTime.toISOString(),
        ignition: frame.ignition ?? true,
        valid: frame.valid,
      };
      this.gateway.broadcastPosition(tracker.vehicle.fleetId, event);
    }
  }
}
