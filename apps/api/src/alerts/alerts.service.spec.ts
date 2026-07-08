import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import type { CobanPositionFrame } from '@vizyo/tracky-shared';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AlertsService } from './alerts.service';

const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET = '00000000-0000-0000-0000-000000000099';
const VEHICLE_ID = '00000000-0000-0000-0000-000000000020';
const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const ALERT_ID = '00000000-0000-0000-0000-000000000060';
const USER_ID = '00000000-0000-0000-0000-000000000030';

const tracker = {
  id: TRACKER_ID,
  imei: '111111111111111',
  vehicle: { id: VEHICLE_ID, plate: 'AB-123', fleetId: FLEET_ID, fleet: { id: FLEET_ID } },
};

const trackerNoVehicle = { ...tracker, vehicle: null };

function makeFrame(alarm: string): CobanPositionFrame {
  return {
    type: 'position',
    imei: '111111111111111',
    alarm: alarm as any,
    deviceTime: new Date(),
    valid: true,
    latitude: 33.5,
    longitude: -7.5,
    speedKph: 10,
    raw: '[test]',
  };
}

const alertRecord = (overrides: Record<string, unknown> = {}) => ({
  id: ALERT_ID,
  fleetId: FLEET_ID,
  vehicleId: VEHICLE_ID,
  trackerId: TRACKER_ID,
  type: 'SOS',
  severity: 'CRITICAL',
  title: 'Appel SOS conducteur',
  message: 'Vehicule AB-123',
  acknowledgedAt: null,
  acknowledgedBy: null,
  createdAt: new Date(),
  ...overrides,
});

const admin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };
const otherAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: OTHER_FLEET };

describe('AlertsService', () => {
  let service: AlertsService;
  let prisma: {
    // V1.10 (Sprint 6) — findFirst pour le filtre tenant integre au where.
    alert: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock; count: jest.Mock };
    surveillanceProfile: { findUnique: jest.Mock };
    surveillanceEvent: { create: jest.Mock };
  };
  let gateway: { broadcastAlert: jest.Mock; broadcastAlertAcknowledged: jest.Mock };

  beforeEach(async () => {
    prisma = {
      alert: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(alertRecord(data))),
        findMany: jest.fn().mockResolvedValue([alertRecord()]),
        findUnique: jest.fn().mockResolvedValue(alertRecord()),
        findFirst: jest.fn().mockResolvedValue(alertRecord()),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(alertRecord(data))),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
        count: jest.fn().mockResolvedValue(5),
      },
      // V1.6 — Surveillance Max : AlertsService consulte le profile pour
      // éventuellement élever la severity. Par défaut, pas de profil = pas
      // d'élévation (comportement legacy).
      surveillanceProfile: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      surveillanceEvent: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'evt-1', ...data })),
      },
    };
    gateway = { broadcastAlert: jest.fn(), broadcastAlertAcknowledged: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        AlertsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: NotificationDispatchService, useValue: { dispatchAlert: jest.fn().mockResolvedValue({ channels: [] }) } },
      ],
    }).compile();

    service = module.get(AlertsService);
  });

  // 1. alarm 'none' → null
  it('should return null for alarm none', async () => {
    const result = await service.createFromCobanFrame(makeFrame('none'), tracker as any);
    expect(result).toBeNull();
    expect(prisma.alert.create).not.toHaveBeenCalled();
  });

  // 2. tracker sans vehicle → null
  it('should return null when tracker has no vehicle', async () => {
    const result = await service.createFromCobanFrame(makeFrame('sos'), trackerNoVehicle as any);
    expect(result).toBeNull();
  });

  // 3. sos → CRITICAL SOS + broadcast
  it('should create CRITICAL SOS alert and broadcast', async () => {
    const result = await service.createFromCobanFrame(makeFrame('sos'), tracker as any);
    expect(result).not.toBeNull();
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'SOS', severity: 'CRITICAL' }),
      }),
    );
    expect(gateway.broadcastAlert).toHaveBeenCalled();
  });

  // 4. low_battery → WARNING LOW_BATTERY
  it('should create WARNING LOW_BATTERY alert', async () => {
    await service.createFromCobanFrame(makeFrame('low_battery'), tracker as any);
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'LOW_BATTERY', severity: 'WARNING' }),
      }),
    );
  });

  // 5. list: multi-tenant
  it('should filter by fleetId for non-SUPER_ADMIN', async () => {
    await service.list(admin, {});
    expect(prisma.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fleetId: FLEET_ID }) }),
    );
  });

  // 6. list: SUPER_ADMIN sees all
  it('should not filter by fleetId for SUPER_ADMIN', async () => {
    await service.list(superAdmin, {});
    const call = prisma.alert.findMany.mock.calls[0][0];
    expect(call.where.fleetId).toBeUndefined();
  });

  // 7. acknowledge: marks + broadcast
  it('should acknowledge and broadcast', async () => {
    prisma.alert.findFirst.mockResolvedValue(alertRecord());
    const result = await service.acknowledge(ALERT_ID, admin);
    expect(prisma.alert.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ acknowledgedBy: USER_ID }) }),
    );
    expect(gateway.broadcastAlertAcknowledged).toHaveBeenCalled();
  });

  // 8. acknowledge: idempotent
  it('should be idempotent on already acknowledged alert', async () => {
    prisma.alert.findFirst.mockResolvedValue(alertRecord({ acknowledgedAt: new Date() }));
    const result = await service.acknowledge(ALERT_ID, admin);
    expect(prisma.alert.update).not.toHaveBeenCalled();
  });

  // 9. acknowledge: cross-fleet refused → NotFoundException
  // V1.10 (Sprint 6) — le filtre fleetId integre au where via findFirst renvoie
  // null pour les non-SUPER d'une autre flotte. Changement volontaire de 403
  // vers 404 pour ne pas leak l'existence des ressources cross-fleet.
  it('should refuse cross-fleet acknowledge', async () => {
    prisma.alert.findFirst.mockResolvedValue(null);
    await expect(service.acknowledge(ALERT_ID, otherAdmin)).rejects.toThrow(NotFoundException);
  });

  // 10. countUnacknowledged
  it('should count total and critical', async () => {
    prisma.alert.count.mockResolvedValueOnce(10).mockResolvedValueOnce(2);
    const result = await service.countUnacknowledged(admin);
    expect(result).toEqual({ total: 10, critical: 2 });
  });

  // 11. #6 — surveillanceEvent.create échoue → l'alerte CRITICAL est quand même diffusée
  it('should still broadcast a CRITICAL surveillance alert when the audit event write fails', async () => {
    prisma.surveillanceProfile.findUnique.mockResolvedValue({
      id: 'profile-1',
      vehicleId: VEHICLE_ID,
      fleetId: FLEET_ID,
      currentlyArmed: true,
      triggerVibration: true,
      triggerMovement: false,
      triggerDoor: false,
    });
    // L'event d'audit échoue (timeout DB, FK...) : ne doit PAS bloquer le broadcast.
    prisma.surveillanceEvent.create.mockRejectedValue(new Error('DB timeout'));

    const result = await service.createFromCobanFrame(makeFrame('vibration'), tracker as any);

    expect(result).not.toBeNull();
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ severity: 'CRITICAL', type: 'SURVEILLANCE_TRIGGERED' }),
      }),
    );
    // Point clé : malgré l'échec de l'audit, l'alerte de vol a bien été diffusée.
    expect(gateway.broadcastAlert).toHaveBeenCalled();
  });

  // 12. GPS_LOST (incident FS-253) — aucune alerte récente → crée WARNING GPS_LOST + broadcast
  it('createGpsLostAlert creates a WARNING GPS_LOST alert when none is recent', async () => {
    prisma.alert.findFirst.mockResolvedValue(null);
    const result = await service.createGpsLostAlert(
      { id: TRACKER_ID, imei: '111111111111111', lastLat: 43.6, lastLng: 1.45, lastPositionAt: new Date() },
      { id: VEHICLE_ID, plate: 'FS-253-HR', fleetId: FLEET_ID },
      '29 h',
    );
    expect(result).not.toBeNull();
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'GPS_LOST', severity: 'WARNING', vehicleId: VEHICLE_ID }),
      }),
    );
    expect(gateway.broadcastAlert).toHaveBeenCalled();
  });

  // 13. GPS_LOST — dédup : une alerte GPS_LOST récente OUVERTE → null, aucun doublon
  it('createGpsLostAlert dedups against a recent OPEN alert', async () => {
    prisma.alert.findFirst.mockResolvedValue(alertRecord({ type: 'GPS_LOST' }));
    const result = await service.createGpsLostAlert(
      { id: TRACKER_ID, imei: '111111111111111', lastLat: null, lastLng: null, lastPositionAt: null },
      { id: VEHICLE_ID, plate: 'FS-253-HR', fleetId: FLEET_ID },
      '29 h',
    );
    expect(result).toBeNull();
    expect(prisma.alert.create).not.toHaveBeenCalled();
  });

  // 14. GPS_LOST — anti-régression (revue 2026-07-09) : une alerte ACQUITTÉE récente
  // dédup AUSSI. Sinon acquitter recréerait une alerte au tick suivant (re-spam).
  it('createGpsLostAlert dedups even against an ACKNOWLEDGED recent alert (no re-spawn on ack)', async () => {
    prisma.alert.findFirst.mockResolvedValue(alertRecord({ type: 'GPS_LOST', acknowledgedAt: new Date() }));
    const result = await service.createGpsLostAlert(
      { id: TRACKER_ID, imei: '111111111111111', lastLat: null, lastLng: null, lastPositionAt: null },
      { id: VEHICLE_ID, plate: 'FS-253-HR', fleetId: FLEET_ID },
      '30 h',
    );
    expect(result).toBeNull();
    expect(prisma.alert.create).not.toHaveBeenCalled();
    // Le filtre de dédup NE DOIT PAS restreindre à acknowledgedAt: null (sinon ré-spawn).
    const where = prisma.alert.findFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('acknowledgedAt');
    expect(where).toMatchObject({ vehicleId: VEHICLE_ID, type: 'GPS_LOST' });
  });
});
