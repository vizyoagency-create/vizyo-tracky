import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import type { Alert, Fleet, Tracker, Vehicle } from '@prisma/client';
import { AlertSeverity, AlertType, Prisma, UserRole } from '@prisma/client';
import type { CobanPositionFrame } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { mapCobanAlarm } from './alert-mapping';

interface RequestedBy {
  userId: string;
  role: UserRole | string;
  fleetId: string | null;
  accessibleVehicleIds?: string[] | 'ALL';
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => RealtimeGateway))
    private readonly gateway: RealtimeGateway,
  ) {}

  async createFromCobanFrame(
    frame: CobanPositionFrame,
    tracker: Tracker & { vehicle: (Vehicle & { fleet: Fleet }) | null },
  ): Promise<Alert | null> {
    if (!tracker.vehicle) {
      this.logger.warn(`Alert ignored — tracker ${tracker.imei} not assigned`);
      return null;
    }

    const mapping = mapCobanAlarm(frame.alarm);
    if (!mapping) return null;

    const alert = await this.prisma.alert.create({
      data: {
        fleetId: tracker.vehicle.fleetId,
        vehicleId: tracker.vehicle.id,
        trackerId: tracker.id,
        type: mapping.type,
        severity: mapping.severity,
        title: mapping.title,
        // The vehicle plate is already shown by the UI alongside this alert,
        // so the message stays null unless we ever attach extra context.
        message: null,
        payload: { raw: frame.raw, alarm: frame.alarm } as any,
        latitude: frame.latitude,
        longitude: frame.longitude,
      },
      include: { vehicle: true, tracker: true },
    });

    this.gateway.broadcastAlert(alert);
    this.logger.warn(`[ALERT] ${mapping.severity} ${mapping.type} for ${tracker.vehicle.plate}`);
    return alert;
  }

  async list(
    requestedBy: RequestedBy,
    filters: {
      type?: AlertType;
      severity?: AlertSeverity;
      acknowledged?: boolean | string;
      vehicleId?: string;
      limit?: string;
      cursor?: string;
    },
  ): Promise<{ items: Alert[]; nextCursor: string | null }> {
    const where: Prisma.AlertWhereInput = {};

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) return { items: [], nextCursor: null };
      where.fleetId = requestedBy.fleetId;
    }

    // Filtrage par accès véhicules
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.vehicleId = { in: requestedBy.accessibleVehicleIds };
    }

    if (filters.type) where.type = filters.type;
    if (filters.severity) where.severity = filters.severity;
    if (filters.vehicleId) where.vehicleId = filters.vehicleId;

    const ack = filters.acknowledged;
    if (ack === true || ack === 'true') where.acknowledgedAt = { not: null };
    if (ack === false || ack === 'false') where.acknowledgedAt = null;

    const limit = Math.min(filters.limit ? parseInt(filters.limit, 10) : 20, 100);
    const items = await this.prisma.alert.findMany({
      where,
      include: { vehicle: true, tracker: true },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async countUnacknowledged(
    requestedBy: RequestedBy,
  ): Promise<{ total: number; critical: number }> {
    const where: Prisma.AlertWhereInput = { acknowledgedAt: null };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) return { total: 0, critical: 0 };
      where.fleetId = requestedBy.fleetId;
    }
    const [total, critical] = await Promise.all([
      this.prisma.alert.count({ where }),
      this.prisma.alert.count({ where: { ...where, severity: 'CRITICAL' } }),
    ]);
    return { total, critical };
  }

  async acknowledge(
    id: string,
    requestedBy: RequestedBy,
  ): Promise<Alert> {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException('Alerte introuvable');

    if (requestedBy.role !== UserRole.SUPER_ADMIN && alert.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse a cette alerte');
    }

    if (alert.acknowledgedAt) return alert;

    const updated = await this.prisma.alert.update({
      where: { id },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedBy: requestedBy.userId,
      },
      include: { vehicle: true, tracker: true },
    });

    this.gateway.broadcastAlertAcknowledged(updated);
    return updated;
  }

  async acknowledgeAll(
    requestedBy: RequestedBy,
  ): Promise<{ count: number }> {
    const where: Prisma.AlertWhereInput = { acknowledgedAt: null };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) return { count: 0 };
      where.fleetId = requestedBy.fleetId;
    }
    const result = await this.prisma.alert.updateMany({
      where,
      data: {
        acknowledgedAt: new Date(),
        acknowledgedBy: requestedBy.userId,
      },
    });
    return { count: result.count };
  }
}
