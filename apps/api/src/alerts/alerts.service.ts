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
import { VEHICLE_GROUP_INCLUDE, flattenVehicleGroup } from '../common/vehicle-group';
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

    // Build contextual message based on alert type + frame data.
    const contextMessage = buildAlertMessage(mapping.type, frame);

    const alert = await this.prisma.alert.create({
      data: {
        fleetId: tracker.vehicle.fleetId,
        vehicleId: tracker.vehicle.id,
        trackerId: tracker.id,
        type: mapping.type,
        severity: mapping.severity,
        title: mapping.title,
        message: contextMessage,
        payload: {
          raw: frame.raw,
          alarm: frame.alarm,
          speedKmh: frame.speedKph ?? null,
          course: frame.course ?? null,
          ignition: frame.ignition ?? null,
        } as any,
        latitude: frame.latitude,
        longitude: frame.longitude,
      },
      include: { vehicle: true, tracker: true },
    });

    // V1.6 — création de l'événement de surveillance lié à l'alerte. Insert
    // direct via Prisma pour éviter la dépendance circulaire AlertsModule ⇄
    // SurveillanceModule (SurveillanceService.recordTrigger fait exactement ça).
    if (surveillanceTrigger && profile) {
      // Best-effort (audit #6) : l'event de surveillance est un AUDIT. Son echec
      // (timeout DB, FK, contrainte...) ne doit JAMAIS empecher le broadcast WS +
      // le dispatch externe d'une alerte CRITICAL (vol). On loggue et on continue.
      await this.prisma.surveillanceEvent
        .create({
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
        })
        .catch((err) => {
          this.logger.error(
            `surveillanceEvent.create a echoue pour l'alerte ${alert.id} (broadcast/dispatch maintenus): ${err instanceof Error ? err.message : err}`,
          );
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

  /**
   * Incident FS-253 — alerte « GPS perdu » : le boîtier communique (réseau OK) mais
   * n'envoie plus de position GPS depuis longtemps (antenne débranchée / masquée / ciel
   * bouché). Créée par le détecteur `gps-integrity`. Un GPS perdu ne déclenche NI un état
   * OFFLINE (le boîtier est vivant) NI `fixCommandFailing` → sans cette alerte il restait
   * totalement invisible (le trou de « catching » signalé sur FS-253).
   *
   * DÉDUPLIQUÉE : au plus UNE alerte GPS_LOST par véhicule sur `dedupWindowMs`, QUEL QUE
   * SOIT son acquittement. On NE filtre PAS sur `acknowledgedAt: null` volontairement :
   * un boîtier GPS-perdu rafraîchit lastSeenAt/lastNoFixAt toutes les ~20 s pendant des
   * heures, donc le détecteur le re-sélectionne à chaque tick (5 min). Si on ne dédupait
   * que les alertes OUVERTES, acquitter l'alerte (le geste normal pour vider le centre)
   * en ferait recréer une neuve au tick suivant → re-notification + re-ErrorLog en boucle.
   * Ici, acquitter la fait taire pour toute la fenêtre ; une re-alerte ne repart qu'après
   * `dedupWindowMs` (rappel « toujours perdu »). Retourne l'alerte créée, ou `null` si une
   * alerte GPS_LOST récente existe déjà (aucun doublon, aucune re-notification).
   */
  async createGpsLostAlert(
    tracker: { id: string; imei: string; lastLat: number | null; lastLng: number | null; lastPositionAt: Date | null },
    vehicle: { id: string; plate: string; fleetId: string },
    agoLabel: string,
    dedupWindowMs = 24 * 60 * 60 * 1000,
    // Zones mortes GPS : contexte de récurrence si la perte tombe dans une zone déjà connue.
    // `recognized` = zone reconnue (perte récurrente au même endroit) ; `suspect` = zone marquée
    // suspecte (brouilleur ?). Absent = 1re perte / pas de zone → message « panne d'antenne » standard.
    recurrence?: { count: number; recognized: boolean; suspect: boolean },
  ): Promise<Alert | null> {
    const since = new Date(Date.now() - dedupWindowMs);
    const existing = await this.prisma.alert.findFirst({
      where: { vehicleId: vehicle.id, type: AlertType.GPS_LOST, createdAt: { gte: since } },
      select: { id: true },
    });
    if (existing) return null;

    const baseMsg = `Le boîtier communique toujours (réseau OK) mais n'envoie plus de position GPS depuis ${agoLabel}. Antenne probablement débranchée/masquée ou véhicule sans vue ciel : à vérifier physiquement.`;
    let title = `📡 GPS perdu — ${vehicle.plate}`;
    let message = baseMsg;
    if (recurrence?.suspect) {
      title = `📡 GPS perdu (zone suspecte) — ${vehicle.plate}`;
      message = `Perte de position GPS depuis ${agoLabel} à un endroit SIGNALÉ SUSPECT (brouilleur ?). ${recurrence.count}e perte au même endroit — à surveiller de près.`;
    } else if (recurrence?.recognized) {
      title = `📡 GPS perdu (zone récurrente) — ${vehicle.plate}`;
      message = `Perte GPS récurrente au même endroit (${recurrence.count}e épisode) — parking souterrain/couvert ou tunnel probable, pas nécessairement une panne. Sans position GPS depuis ${agoLabel}. Si ce lieu est normal, confirmez la zone sur la fiche véhicule pour ne plus être alerté.`;
    } else if (recurrence && recurrence.count >= 2) {
      message = `${baseMsg} Déjà ${recurrence.count} pertes GPS constatées à cet endroit — surveiller une éventuelle récurrence (parking couvert / zone masquée).`;
    }

    const alert = await this.prisma.alert.create({
      data: {
        fleetId: vehicle.fleetId,
        vehicleId: vehicle.id,
        trackerId: tracker.id,
        type: AlertType.GPS_LOST,
        severity: AlertSeverity.WARNING,
        title,
        message,
        payload: {
          imei: tracker.imei,
          lastPositionAt: tracker.lastPositionAt?.toISOString() ?? null,
          agoLabel,
          deadZone: recurrence
            ? { count: recurrence.count, recognized: recurrence.recognized, suspect: recurrence.suspect }
            : null,
        } as any,
        latitude: tracker.lastLat,
        longitude: tracker.lastLng,
      },
      include: { vehicle: true, tracker: true },
    });

    this.gateway.broadcastAlert(alert);
    this.logger.warn(`[ALERT] WARNING GPS_LOST for ${vehicle.plate} (${agoLabel})`);
    // Dispatch externe best-effort (comme createFromCobanFrame) : l'échec d'un canal ne
    // doit pas casser le détecteur.
    this.dispatch.dispatchAlert(alert).catch((err) => {
      this.logger.warn(`Notification dispatch failed for GPS_LOST alert ${alert.id}: ${err instanceof Error ? err.message : err}`);
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
      include: { vehicle: { include: { ...VEHICLE_GROUP_INCLUDE } }, tracker: true },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    // Aplatit le groupe du véhicule (vehicle.group) pour la liste d'alertes.
    // Mode vie privée (RGPD) : on CAVIARDE la localisation (lat/lng) des alertes d'un
    // véhicule en mode privé — l'alerte reste visible (sécurité : SOS, coupure…) mais
    // sans révéler OÙ. Réapparaît si le mode privé est désactivé.
    const page = (hasMore ? items.slice(0, limit) : items).map((a) => {
      const priv = (a.vehicle as { privacyModeEnabled?: boolean } | null)?.privacyModeEnabled === true;
      const redacted = priv ? { ...a, latitude: null, longitude: null } : a;
      return redacted.vehicle ? { ...redacted, vehicle: flattenVehicleGroup(redacted.vehicle) } : redacted;
    });
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
 * Build a contextual message for an alert based on its type and frame data.
 * Returns null if no meaningful context is available.
 */
function buildAlertMessage(type: AlertType, frame: CobanPositionFrame): string | null {
  const speed = frame.speedKph;
  switch (type) {
    case 'OVERSPEED':
      return speed != null ? `Vitesse détectée : ${Math.round(speed)} km/h` : null;
    case 'HARSH_BRAKING':
    case 'HARSH_ACCELERATION':
    case 'HARSH_TURN':
      return speed != null ? `Vitesse au moment de l'événement : ${Math.round(speed)} km/h` : null;
    case 'LOW_BATTERY':
      return 'Niveau de batterie faible détecté par le tracker';
    case 'GPS_LOST':
      return speed != null ? `Dernière vitesse connue : ${Math.round(speed)} km/h` : null;
    case 'MOVEMENT_IDLE':
      return speed != null && speed > 0 ? `Mouvement détecté à ${Math.round(speed)} km/h` : null;
    default:
      return null;
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
