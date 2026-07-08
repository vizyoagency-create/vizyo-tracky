import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CommandStatus, EngineAction, UserRole } from '@prisma/client';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { EngineControlService } from './engine-control.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const VEHICLE_ID = '00000000-0000-0000-0000-000000000020';
const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET_ID = '00000000-0000-0000-0000-000000000099';
const USER_ID = '00000000-0000-0000-0000-000000000030';

const trackerWithVehicle = {
  id: TRACKER_ID,
  imei: '123456789012345',
  model: 'COBAN_GPS403D',
  status: 'OFFLINE',
  vehicleId: VEHICLE_ID,
  vehicle: {
    id: VEHICLE_ID,
    fleetId: FLEET_ID,
    plate: 'AB-123-CD',
    fleet: { id: FLEET_ID, name: 'Test Fleet' },
  },
};

const trackerWithoutVehicle = {
  ...trackerWithVehicle,
  vehicleId: null,
  vehicle: null,
};

function recentPosition(speedKmh: number, ageMs = 0, valid = true) {
  return {
    id: '00000000-0000-0000-0000-000000000040',
    trackerId: TRACKER_ID,
    lat: 33.5,
    lng: -7.6,
    speedKmh,
    heading: 0,
    altitude: null,
    satellites: null,
    valid,
    timestamp: new Date(Date.now() - ageMs),
    createdAt: new Date(),
  };
}

const createdCommand = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-0000-0000-000000000050',
  trackerId: TRACKER_ID,
  action: EngineAction.CUT,
  status: CommandStatus.PENDING,
  reason: null,
  requestedBy: USER_ID,
  lastError: null,
  scheduledAt: null,
  sentAt: null,
  ackedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const fleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };
const otherFleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: OTHER_FLEET_ID };
const nightWatchman = { userId: USER_ID, role: UserRole.NIGHT_WATCHMAN, fleetId: FLEET_ID };

describe('EngineControlService', () => {
  let service: EngineControlService;
  // V1.10 (Sprint 6) — findFirst ajoute au mock car requestCommand/getCommand
  // appliquent maintenant le filtre tenant via la relation tracker.vehicle.fleetId
  // au lieu d'un check after-find.
  let prisma: {
    tracker: { findUnique: jest.Mock; findFirst: jest.Mock };
    position: { findFirst: jest.Mock };
    engineControlCommand: { create: jest.Mock; update: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock };
    vehicleSchedule: { updateMany: jest.Mock };
  };
  let registry: { get: jest.Mock; send: jest.Mock };
  let ackWaiter: { waitForAck: jest.Mock; cancelAll: jest.Mock };
  let gateway: { emitEngineCommandUpdate: jest.Mock };
  let errorLogger: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      tracker: { findUnique: jest.fn(), findFirst: jest.fn() },
      position: { findFirst: jest.fn() },
      engineControlCommand: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(createdCommand(data))),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(createdCommand(data))),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      vehicleSchedule: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    registry = {
      get: jest.fn().mockReturnValue(undefined),
      send: jest.fn().mockReturnValue(false),
    };

    ackWaiter = {
      waitForAck: jest.fn().mockResolvedValue('ack-frame'),
      cancelAll: jest.fn(),
    };

    gateway = {
      emitEngineCommandUpdate: jest.fn(),
    };

    errorLogger = { record: jest.fn().mockResolvedValue('error-id') };

    const module = await Test.createTestingModule({
      providers: [
        EngineControlService,
        { provide: PrismaService, useValue: prisma },
        { provide: SocketRegistryService, useValue: registry },
        { provide: CobanWireLogger, useValue: { out: jest.fn(), in: jest.fn(), ackMatch: jest.fn(), ackTimeout: jest.fn() } },
        { provide: AckWaiterService, useValue: ackWaiter },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: ErrorLogger, useValue: errorLogger },
        // Pré-existant : EngineControlService injecte SmsGatewayService (fallback SMS
        // V1.5 sprint-i) mais le provider manquait → toute la suite ne compilait pas.
        // isEnabled=false : trySmsFallback reste un no-op, on garde le chemin offline→FAILED.
        { provide: SmsGatewayService, useValue: { isEnabled: jest.fn().mockReturnValue(false), send: jest.fn() } },
        { provide: SystemActivityService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get(EngineControlService);
  });

  // 1. CUT refusé si tracker introuvable
  it('should throw NotFoundException when tracker does not exist', async () => {
    prisma.tracker.findFirst.mockResolvedValue(null);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(NotFoundException);
  });

  // 2. CUT refusé si tracker sans vehicle (cas SUPER_ADMIN — pour un fleetAdmin,
  // le filtre tenant integre au where rejette deja avec un 404).
  it('should throw BadRequestException when tracker has no vehicle', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithoutVehicle);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  // 3. CUT refusé si fleetId différent et pas SUPER_ADMIN → maintenant NotFoundException
  // V1.10 (Sprint 6) — le filtre tenant integre au where via findFirst renvoie null
  // pour les non-SUPER d'une autre flotte. Changement volontaire de 403 vers 404.
  it('should throw NotFoundException when fleet mismatch for non-SUPER_ADMIN', async () => {
    // findFirst renvoie null car le where exige vehicle.fleetId = otherFleetAdmin.fleetId
    // alors que le tracker est dans FLEET_ID.
    prisma.tracker.findFirst.mockResolvedValue(null);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, otherFleetAdmin),
    ).rejects.toThrow(NotFoundException);
  });

  // 4. CUT refusé si aucune position → REJECTED_SPEED persistée
  it('should reject CUT and persist REJECTED_SPEED when no position exists', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(null);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: 'Aucune position connue pour ce tracker',
      }),
    });
    expect(gateway.emitEngineCommandUpdate).toHaveBeenCalled();
  });

  // 5a. CUT refusé si position stale en mouvement (>60s, speed > 5)
  it('should reject CUT when position is stale while moving (>60s)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(10, 90 * 1000));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: expect.stringContaining('Position trop ancienne'),
      }),
    });
  });

  // 5b. CUT accepté si position 90s à l'arrêt (seuil adaptatif 10 min)
  it('should allow CUT when position is 90s old but vehicle is at rest', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(0, 90 * 1000));
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException); // passe le guard, échoue au dispatch
  });

  // 5c. CUT accepté même si position très ancienne quand véhicule à l'arrêt
  it('should allow CUT when position is very old but vehicle is at rest', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(0, 30 * 60 * 1000)); // 30 min
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException); // passe le guard, échoue au dispatch
  });

  // 6. CUT refusé si fix GPS invalide
  it('should reject CUT when GPS fix is invalid', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(5, 0, false));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: 'Fix GPS invalide',
      }),
    });
  });

  // 7. CUT refusé si speedKmh === 21
  it('should reject CUT when speed is 21 km/h', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(21));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: 'Vitesse trop élevée : 21 km/h',
      }),
    });
  });

  // 8. CUT refusé si speedKmh === 20.01
  it('should reject CUT when speed is 20.01 km/h', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(20.01));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
  });

  // 9. CUT ACCEPTÉ si speedKmh === 20.0 → PENDING puis FAILED (tracker offline)
  it('should accept CUT at 20.0 km/h then fail dispatch (offline)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(20.0));
    registry.send.mockReturnValue(false);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING }),
    });
    expect(prisma.engineControlCommand.update).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      data: expect.objectContaining({ status: CommandStatus.FAILED }),
    });
    expect(gateway.emitEngineCommandUpdate).toHaveBeenCalled();
  });

  // 10. CUT ACCEPTÉ + dispatch réussi si tracker connecté
  it('should dispatch CUT to connected tracker and start ACK wait', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(0));
    registry.send.mockReturnValue(true);

    const result = await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin);

    expect(result.status).toBe(CommandStatus.PENDING);
    expect(registry.send).toHaveBeenCalledWith(
      '123456789012345',
      expect.stringContaining('**,imei:123456789012345,J;'),
    );
    expect(prisma.engineControlCommand.update).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      data: expect.objectContaining({ status: CommandStatus.SENT }),
    });
    expect(ackWaiter.waitForAck).toHaveBeenCalledWith(
      '123456789012345',
      expect.any(RegExp),
      15000,
      expect.any(String),
      10, // ENGINE_ACK_PRIORITY (#7) — priorite haute pour l'echo moteur J/K
    );
    expect(gateway.emitEngineCommandUpdate).toHaveBeenCalled();
  });

  // 11. SUPER_ADMIN peut CUT sur une autre flotte
  it('should allow SUPER_ADMIN to CUT on any fleet', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(5));
    registry.send.mockReturnValue(false);

    const crossFleetSuperAdmin = { ...superAdmin, fleetId: OTHER_FLEET_ID };
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, crossFleetSuperAdmin),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // 12. RESTORE accepté même avec speed = 100
  it('should allow RESTORE even when speed is 100 km/h', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(false);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING, action: EngineAction.RESTORE }),
    });
  });

  // 13. RESTORE accepté même sans aucune position
  it('should allow RESTORE even when no position exists', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(null);
    registry.send.mockReturnValue(false);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.position.findFirst).not.toHaveBeenCalled();
  });

  // 14. Pas d'écho ACK sur le fil → la commande RESTE SENT (le Coban exécute les
  // commandes moteur silencieusement, cf docs/03 §3.7.2). Un timeout d'attente
  // d'écho ne doit ni passer la commande FAILED ni générer une fausse erreur dans
  // le centre d'alertes (cause des Erreurs #2/#3 du rapport).
  it('should keep command SENT (not FAILED) and log no error when no wire ACK arrives', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(0));
    registry.send.mockReturnValue(true);
    ackWaiter.waitForAck.mockRejectedValue(new Error('ACK timeout after 15000ms'));

    await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin);

    // Laisser le .catch background (fire-and-forget) se résoudre.
    await new Promise((r) => setTimeout(r, 10));

    // La commande ne doit jamais passer FAILED sur un simple timeout d'écho.
    expect(prisma.engineControlCommand.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: CommandStatus.FAILED }),
      }),
    );
    // Aucune fausse erreur ne doit alimenter le centre d'alertes.
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  // 15. WS event emitted on REJECTED_SPEED
  it('should emit WS event when CUT is rejected for speed', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(25));

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);

    expect(gateway.emitEngineCommandUpdate).toHaveBeenCalledWith(
      FLEET_ID,
      expect.objectContaining({
        trackerId: TRACKER_ID,
        action: EngineAction.CUT,
        status: CommandStatus.REJECTED_SPEED,
      }),
    );
  });

  // --- Sprint 2 (Fiabilisation) ---

  // 16. Obj1 — verrou : une 2e coupure est rejetee (409) tant qu'une coupure
  // confirmable est en vol (SENT, confirmationExpected, dans la fenetre).
  it('should reject a new CUT (409) while a confirmable CUT is in flight', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.engineControlCommand.findFirst.mockResolvedValue(
      createdCommand({ status: CommandStatus.SENT, confirmationExpected: true }),
    );

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ConflictException);
    // aucune nouvelle commande ne doit etre creee
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
  });

  // 17. Obj1 (ajustement) — le verrou NE bloque PAS un RESTORE, meme avec une
  // coupure en vol (le rallumage est l'echappatoire sur, toujours autorise).
  it('should NOT block RESTORE even when a CUT is in flight', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.engineControlCommand.findFirst.mockResolvedValue(
      createdCommand({ status: CommandStatus.SENT, confirmationExpected: true }),
    );
    registry.send.mockReturnValue(false);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException); // passe le lock, echoue au dispatch offline
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: EngineAction.RESTORE }),
    });
  });

  // 18. Obj2 — CUT d'un vehicule en marche (ignition ON) => confirmationExpected=true.
  it('should set confirmationExpected=true for a CUT of a running vehicle', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue({ ...recentPosition(3), ignition: true });
    registry.send.mockReturnValue(true);

    await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ confirmationExpected: true }),
    });
  });

  // 19. Obj2 — CUT d'un vehicule a l'arret (ignition OFF) => confirmationExpected=false
  // (etat "non verifiable" : pas de chute d'ignition observable).
  it('should set confirmationExpected=false for a CUT at rest (ignition OFF)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue({ ...recentPosition(0), ignition: false });
    registry.send.mockReturnValue(true);

    await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ confirmationExpected: false }),
    });
  });

  // 20. Obj2 — RESTORE => confirmationExpected=false (jamais confirmable par ignition).
  it('should set confirmationExpected=false for RESTORE', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(true);

    await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: EngineAction.RESTORE, confirmationExpected: false }),
    });
  });

  // 21. Obj1 (revue #3) — le verrou ne s'applique qu'aux commandes MANUELLES : une
  // coupure SCHEDULER n'est JAMAIS 409 (le scheduler re-evalue a chaque tick et ne
  // doit pas etre bloque par une coupure manuelle en attente de confirmation).
  it('should NOT block a SCHEDULER CUT even when a confirmable CUT is in flight', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    // 1er findFirst = lastPosition (à l'arrêt) ; 2e = scan « mouvement récent » de la règle
    // 10 min (source SCHEDULER) → null = aucun mouvement récent → la coupe passe le garde-fou.
    prisma.position.findFirst
      .mockResolvedValueOnce({ ...recentPosition(0), ignition: true })
      .mockResolvedValueOnce(null);
    prisma.engineControlCommand.findFirst.mockResolvedValue(
      createdCommand({ status: CommandStatus.SENT, confirmationExpected: true }),
    );
    registry.send.mockReturnValue(false);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'SCHEDULER'),
    ).rejects.toThrow(ServiceUnavailableException); // passe le verrou, echoue au dispatch offline
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: EngineAction.CUT, source: 'SCHEDULER' }),
    });
  });

  // 22. Obj1 (revue #6) — la requete du verrou borne les commandes par la fenetre de
  // confirmation (createdAt >= now - window) : un PENDING orphelin plus ancien que la
  // fenetre (dispatch crashe) ne bloque plus indefiniment les coupures suivantes.
  it('should bound the in-flight lock query by the confirmation window', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue({ ...recentPosition(0), ignition: true });
    prisma.engineControlCommand.findFirst.mockResolvedValue(null); // rien en vol DANS la fenetre
    registry.send.mockReturnValue(false);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.engineControlCommand.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
  });

  // --- Sprint 3 (Veilleur de nuit) — règle « immobile depuis X min », RÔLE VEILLEUR UNIQUEMENT ---

  // 23. Veilleur — refus si véhicule EN MOUVEMENT (>5 km/h), même ≤ 20 (qui passerait pour un admin).
  it('should reject a NIGHT_WATCHMAN CUT when the vehicle is moving (>5 km/h)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(10));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, nightWatchman),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: expect.stringContaining('en mouvement'),
      }),
    });
  });

  // 24. Veilleur — refus si à l'arrêt mais immobile depuis trop peu (mouvement récent dans la fenêtre).
  it('should reject a NIGHT_WATCHMAN CUT when stopped for less than the minimum', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst
      .mockResolvedValueOnce(recentPosition(0)) // lastPosition : à l'arrêt
      .mockResolvedValueOnce({ timestamp: new Date(Date.now() - 30 * 1000) }); // a bougé il y a 30s
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, nightWatchman),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: expect.stringContaining('arrêté depuis seulement'),
      }),
    });
  });

  // 25. Veilleur — ACCEPTÉ si à l'arrêt ET aucun mouvement dans la fenêtre (immobile ≥ X min).
  it('should allow a NIGHT_WATCHMAN CUT when stopped long enough (no recent movement)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst
      .mockResolvedValueOnce(recentPosition(0)) // lastPosition : à l'arrêt
      .mockResolvedValueOnce(null); // aucune trame en mouvement dans la fenêtre
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, nightWatchman),
    ).rejects.toThrow(ServiceUnavailableException); // passe le garde-fou veilleur, échoue au dispatch offline
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING }),
    });
  });

  // 26. Non-régression admin — la règle veilleur NE s'applique PAS : un FLEET_ADMIN peut couper
  // un véhicule en mouvement lent (≤ 20 km/h) → antivol préservé, et aucune 2e requête position.
  it('should NOT apply the watchman rule to a FLEET_ADMIN (antivol ≤ 20 km/h preserved)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(10)); // en mouvement lent
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException); // passe S2 (≤20), échoue au dispatch
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING }),
    });
    expect(prisma.position.findFirst).toHaveBeenCalledTimes(1); // pas de 2e requête (règle veilleur non déclenchée)
  });

  // 27. Veilleur — un RESTORE n'est jamais soumis à la règle d'immobilité (débloquer doit toujours marcher).
  it('should NOT apply the watchman stop-rule to a RESTORE (unblock always allowed)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, nightWatchman),
    ).rejects.toThrow(ServiceUnavailableException); // RESTORE saute tout le bloc CUT, échoue au dispatch
    expect(prisma.position.findFirst).not.toHaveBeenCalled();
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: EngineAction.RESTORE }),
    });
  });

  // Sprint 3 (revue A1 + Option A) — la coupe veilleur (a) ne contourne PAS le gate
  // `schedules_manage` (jamais `enabled:false`) ET (b) tient jusqu'à réactivation manuelle
  // (override « indéfini », pas 1h) — même si `disableSchedule:true` est forcé dans le body.
  it('NIGHT_WATCHMAN CUT → suspend le planning jusqu\'à réactivation manuelle (override indéfini), sans le désactiver', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst
      .mockResolvedValueOnce(recentPosition(0)) // lastPosition : à l'arrêt
      .mockResolvedValueOnce(null); // immobile depuis > 2 min (aucune trame en mouvement)
    registry.send.mockReturnValue(true);
    await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, nightWatchman, 'MANUAL', true);
    const call = prisma.vehicleSchedule.updateMany.mock.calls.find((c) => c[0]?.data?.overrideUntil);
    expect(call).toBeDefined();
    // Override « indéfini » (sentinelle lointaine) → le scheduler ne rallumera pas au bout d'1h.
    expect((call![0].data.overrideUntil as Date).getFullYear()).toBeGreaterThan(2900);
    // Et le planning n'est PAS désactivé (gate schedules_manage préservé).
    expect(prisma.vehicleSchedule.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }),
    );
  });

  it('FLEET_ADMIN avec disableSchedule:true → désactive bien le planning (a schedules_manage)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(0));
    registry.send.mockReturnValue(true);
    await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'MANUAL', true);
    expect(prisma.vehicleSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }),
    );
  });

  // Sprint 3 (Option A) — un RESTORE (réactivation manuelle) lève le hold indéfini et repose
  // une grâce 1h : le scheduler reprend la main au bout d'1h, pas avant.
  it('NIGHT_WATCHMAN RESTORE → repose une grâce 1h (le planning reprend ensuite)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(true);
    await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, nightWatchman, 'MANUAL', false);
    const call = prisma.vehicleSchedule.updateMany.mock.calls.find((c) => c[0]?.data?.overrideUntil);
    expect(call).toBeDefined();
    const deltaMs = (call![0].data.overrideUntil as Date).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(50 * 60 * 1000); // ~1h, surtout PAS indéfini
    expect(deltaMs).toBeLessThan(70 * 60 * 1000);
  });

  // --- Demande CDEF (2026-07) — COUPE AUTOMATIQUE (source SCHEDULER) : jamais couper en
  // mouvement + attendre 10 min d'arrêt réel. Gating par SOURCE (pas par rôle), TOUTES flottes. ---

  // SCH-1. Report SEC (throw sans commande) si le véhicule roule (>5 km/h) — même ≤ 20 (qu'un
  // admin couperait). Anti-bloat : aucune REJECTED_SPEED empilée à chaque tick minute.
  it('should DEFER a SCHEDULER CUT (throw, no command created) when the vehicle is moving (>5 km/h)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(15)); // roule à 15 km/h
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
    expect(prisma.position.findFirst).toHaveBeenCalledTimes(1); // pas de scan dwell si déjà en mouvement
  });

  // SCH-2. Report si à l'arrêt mais immobile depuis trop peu (trame en mouvement dans la fenêtre 10 min).
  it('should DEFER a SCHEDULER CUT when stopped for less than the required window (recent movement)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst
      .mockResolvedValueOnce(recentPosition(0)) // lastPosition : à l'arrêt
      .mockResolvedValueOnce({ timestamp: new Date(Date.now() - 2 * 60 * 1000) }); // a bougé il y a 2 min
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(/arrêté depuis seulement/);
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
  });

  // SCH-3. ACCEPTÉ si à l'arrêt ET aucun mouvement dans la fenêtre (immobile ≥ 10 min) → PENDING
  // puis échec dispatch (offline). La coupe auto est bien émise, source SCHEDULER.
  it('should ALLOW a SCHEDULER CUT when stopped long enough (no movement in the window)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst
      .mockResolvedValueOnce(recentPosition(0)) // à l'arrêt
      .mockResolvedValueOnce(null); // aucune trame en mouvement dans la fenêtre
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(ServiceUnavailableException); // passe le garde-fou, échoue au dispatch offline
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING, source: 'SCHEDULER' }),
    });
  });

  // SCH-4. Non-régression — la règle 10 min est branchée sur la SOURCE, pas le rôle : une coupe
  // MANUELLE (même SUPER_ADMIN) garde la coupe antivol S2 (≤ 20 km/h) et n'est PAS différée.
  it('should NOT apply the schedule 10-min rule to a MANUAL cut (source-gated): cuts at 15 km/h', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(15));
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'MANUAL'),
    ).rejects.toThrow(ServiceUnavailableException); // passe S2 (≤20), échoue au dispatch
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING }),
    });
    expect(prisma.position.findFirst).toHaveBeenCalledTimes(1); // pas de scan dwell sur une coupe manuelle
  });
});
