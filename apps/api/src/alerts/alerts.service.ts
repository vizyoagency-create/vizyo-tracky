import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import type { Alert, Fleet, SurveillanceProfile, Tracker, Vehicle } from '@prisma/client';
import {
  AlertSeverity,
  AlertType,
  Prisma,
  SurveillanceEventTrigger,
  UserRole,
} from '@prisma/client';
import type { CobanAlarmType, CobanPositionFrame } from '@vizyo/tracky-shared';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
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
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async createFromCobanFrame(
    frame: CobanPositionFrame,
    tracker: Tracker & { vehicle: (Vehicle & { fleet: Fleet }) | null },
  ): Promise<Alert | null> {
    if (!tracker.vehicle) {
      this.logger.warn(`Alert ignored — tracker ${tracker.imei} not assigned`);
      return null;
    }

    // V1.6 — Surveillance Max : si le véhicule a un profile armé et que l'alarme
    // matche un trigger actif, on remplace le mapping standard par un mapping
    // CRITICAL `SURVEILLANCE_TRIGGERED`. Sinon, mapping classique inchangé.
    const profile = await this.prisma.surveillanceProfile.findUnique({
      where: { vehicleId: tracker.vehicle.id },
    });
    const surveillanceTrigger = matchSurveillanceTrigger(frame.alarm, profile);

    let mapping: { type: AlertType; severity: AlertSeverity; title: string } | null;
    if (surveillanceTrigger) {
      mapping = {
        type: AlertType.SURVEILLANCE_TRIGGERED,
        severity: AlertSeverity.CRITICAL,
        title: `🚨 Surveillance déclenchée — ${tracker.vehicle.plate}`,
      };
    } else {
      mapping = mapCobanAlarm(frame.alarm);
      if (!mapping) return null;
    }

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

    // V1.6 — création de l'événement de surveillance lié à l'alerte. Insert
    // direct via Prisma pour éviter la dépendance circulaire AlertsModule ⇄
    // SurveillanceModule (SurveillanceService.recordTrigger fait exactement ça).
    if (surveillanceTrigger && profile) {
      await this.prisma.surveillanceEvent.create({
        data: {
          profileId: profile.id,
          vehicleId: profile.vehicleId,
          fleetId: profile.fleetId,
          alertId: alert.id,
          trigger: surveillanceTrigger,
          latitude: frame.latitude ?? null,
          longitude: frame.longitude ?? null,
          speedKmh: frame.speedKph ?? null,
        },
      });
    }

    this.gateway.broadcastAlert(alert);
    this.logger.warn(`[ALERT] ${mapping.severity} ${mapping.type} for ${tracker.vehicle.plate}`);

    // V1.5 (Sprint M) — dispatch externe (push / email / WhatsApp) selon les
    // AlertRule configurees pour la fleet. Fire-and-forget — l'echec d'un
    // canal ne casse pas l'ingestion.
    this.dispatch.dispatchAlert(alert).catch((err) => {
      this.logger.warn(`Notification dispatch failed for alert ${alert.id}: ${err instanceof Error ? err.message : err}`);
    });

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
    // Filtre tenant dans le where pour eviter l'enumeration cross-fleet.
    // On renvoie 404 (pas 403) pour ne pas leak l'existence d'une alerte
    // appartenant a une autre flotte.
    const where: Prisma.AlertWhereInput = { id };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Alerte introuvable');
      where.fleetId = requestedBy.fleetId;
    }

    const alert = await this.prisma.alert.findFirst({ where });
    if (!alert) throw new NotFoundException('Alerte introuvable');

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

/**
 * V1.6 — Match d'une trame Coban contre un profil de surveillance armé.
 * Retourne le type de trigger correspondant (VIBRATION/MOVEMENT/DOOR) si on
 * doit élever l'alerte à CRITICAL, sinon null.
 */
function matchSurveillanceTrigger(
  alarm: CobanAlarmType,
  profile: SurveillanceProfile | null,
): SurveillanceEventTrigger | null {
  if (!profile || !profile.currentlyArmed) return null;
  if (alarm === 'vibration' && profile.triggerVibration) {
    return SurveillanceEventTrigger.VIBRATION;
  }
  if (alarm === 'movement' && profile.triggerMovement) {
    return SurveillanceEventTrigger.MOVEMENT;
  }
  if (alarm === 'door' && profile.triggerDoor) {
    return SurveillanceEventTrigger.DOOR;
  }
  return null;
}
