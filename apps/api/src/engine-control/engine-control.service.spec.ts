import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { CommandStatus, EngineAction, UserRole } from '@prisma/client';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';
import { GpsDeadZonesService } from '../gps-dead-zones/gps-dead-zones.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { EngineControlService, PresumedParkedException } from './engine-control.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { computeNextTransition } from '../vehicle-schedules/schedule-evaluator';

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

// Fixtures planning pour la refonte « action manuelle × mode horaire » (feat/comptes-conducteurs).
const scheduleBase = {
  id: '00000000-0000-0000-0000-000000000060',
  vehicleId: VEHICLE_ID,
  enabled: true,
  timezone: 'Europe/Paris',
  mondayEnabled: true, mondayStart: null as string | null, mondayEnd: null as string | null,
  tuesdayEnabled: true, tuesdayStart: null as string | null, tuesdayEnd: null as string | null,
  wednesdayEnabled: true, wednesdayStart: null as string | null, wednesdayEnd: null as string | null,
  thursdayEnabled: true, thursdayStart: null as string | null, thursdayEnd: null as string | null,
  fridayEnabled: true, fridayStart: null as string | null, fridayEnd: null as string | null,
  saturdayEnabled: true, saturdayStart: null as string | null, saturdayEnd: null as string | null,
  sundayEnabled: true, sundayStart: null as string | null, sundayEnd: null as string | null,
  mondaySlots: null, tuesdaySlots: null, wednesdaySlots: null, thursdaySlots: null,
  fridaySlots: null, saturdaySlots: null, sundaySlots: null,
  countryCode: '', // vide → pas de jours fériés → test déterministe
  customDates: null,
  lastEvaluatedAt: null,
  lastEvaluatedState: null,
  overrideUntil: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
// Toujours ouvert (aucune plage) → computeNextTransition = null → fallback override 1h.
const enabledScheduleAlwaysOpen = { ...scheduleBase };
// Fenêtré 08:00–22:00 tous les jours → il existe toujours une prochaine bascule (8h/22h).
const enabledScheduleWindowed = {
  ...scheduleBase,
  mondayStart: '08:00', mondayEnd: '22:00',
  tuesdayStart: '08:00', tuesdayEnd: '22:00',
  wednesdayStart: '08:00', wednesdayEnd: '22:00',
  thursdayStart: '08:00', thursdayEnd: '22:00',
  fridayStart: '08:00', fridayEnd: '22:00',
  saturdayStart: '08:00', saturdayEnd: '22:00',
  sundayStart: '08:00', sundayEnd: '22:00',
};

describe('EngineControlService', () => {
  let service: EngineControlService;
  /** Conservé pour être FERMÉ après chaque test (cf. afterEach : annulation des timers). */
  let testModule: TestingModule;
  // V1.10 (Sprint 6) — findFirst ajoute au mock car requestCommand/getCommand
  // appliquent maintenant le filtre tenant via la relation tracker.vehicle.fleetId
  // au lieu d'un check after-find.
  let prisma: {
    tracker: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
    position: { findFirst: jest.Mock; count: jest.Mock };
    engineControlCommand: { create: jest.Mock; update: jest.Mock; updateMany: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock };
    vehicleSchedule: { updateMany: jest.Mock; findFirst: jest.Mock };
  };
  let registry: { get: jest.Mock; send: jest.Mock };
  let ackWaiter: { waitForAck: jest.Mock; cancelAll: jest.Mock };
  let gateway: { emitEngineCommandUpdate: jest.Mock };
  let errorLogger: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      tracker: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      position: { findFirst: jest.fn(), count: jest.fn().mockResolvedValue(1) },
      engineControlCommand: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(createdCommand(data))),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(createdCommand(data))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      vehicleSchedule: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
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

    testModule = await Test.createTestingModule({
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
        // Zones mortes GPS : par defaut AUCUNE zone -> la sentinelle « coupure
        // inverifiable » remonte normalement. Les tests qui veulent l'inverse
        // surchargent matchZoneForPoint.
        { provide: GpsDeadZonesService, useValue: { matchZoneForPoint: jest.fn().mockResolvedValue(null) } },
        { provide: SystemActivityService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = testModule.get(EngineControlService);
  });

  /**
   * Ferme le module après CHAQUE test → `onModuleDestroy` des providers est appelé, donc les
   * timers d'arrière-plan sont annulés. Sans ça, chaque coupe testée laissait une sentinelle
   * armée à 90 s qui se réveillait plus tard, pendant une AUTRE suite (cf. l'instabilité
   * diagnostiquée le 2026-07-20). Bonus : tout futur timer non nettoyé sera détecté ici.
   */
  afterEach(async () => {
    await testModule?.close();
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

  /** Récupère la mise à jour qui passe la commande en FAILED (celle qui porte le motif). */
  function failedUpdate(p: { engineControlCommand: { update: jest.Mock } }): { lastError: string } {
    const data = p.engineControlCommand.update.mock.calls
      .map((c) => (c[0] as { data: { status?: string; lastError?: string } }).data)
      .find((d) => d.status === CommandStatus.FAILED);
    if (!data) throw new Error('aucune mise à jour FAILED trouvée');
    return { lastError: data.lastError ?? '' };
  }

  /**
   * Le motif d'échec du repli SMS doit être EXACT.
   *
   * Constat prod 2026-07-25 : le repli échouait sur un 403 « hors allowlist » de vizyo-texto — le
   * numéro SIM était bien renseigné — mais la commande enregistrait invariablement
   * « pas de simPhoneNumber ». Trois causes très différentes (passerelle éteinte / numéro absent /
   * numéro refusé) se confondaient en un `false`, et l'opérateur lisait un diagnostic FAUX sur un
   * chemin de sécurité : il cherchait un numéro manquant qui ne manquait pas.
   */
  it('rapporte le VRAI motif quand la passerelle REFUSE le numéro (et non « pas de simPhoneNumber »)', async () => {
    // Le boîtier A un numéro SIM : c'est bien la PASSERELLE qui refuse, pas le numéro qui manque.
    prisma.tracker.findFirst.mockResolvedValue({ ...trackerWithVehicle, simPhoneNumber: '+345901030605198' });
    prisma.position.findFirst.mockResolvedValue(recentPosition(0));
    registry.send.mockReturnValue(false); // TCP indisponible → on bascule sur le repli SMS

    const sms = testModule.get(SmsGatewayService) as unknown as {
      isEnabled: jest.Mock; send: jest.Mock;
    };
    sms.isEnabled.mockReturnValue(true);
    sms.send.mockResolvedValue({ ok: false, error: 'Destinataire +345901030605198 hors allowlist du tenant "tracky"' });

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);

    const failing = failedUpdate(prisma);
    expect(failing.lastError).toContain('hors allowlist');
    expect(failing.lastError).not.toContain('pas de simPhoneNumber');
    // Le centre d'alerte reçoit aussi le motif exploitable.
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.stringContaining('hors allowlist'),
      'engine-control',
      expect.objectContaining({ smsFallbackReason: expect.stringContaining('hors allowlist') }),
    );
  });

  it('distingue le cas « aucun numéro SIM » du refus passerelle', async () => {
    prisma.tracker.findFirst.mockResolvedValue({ ...trackerWithVehicle, simPhoneNumber: null });
    prisma.position.findFirst.mockResolvedValue(recentPosition(0));
    registry.send.mockReturnValue(false);
    const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
    sms.isEnabled.mockReturnValue(true);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);

    const failing = failedUpdate(prisma);
    expect(failing.lastError).toContain('aucun numéro SIM enregistré');
    expect(sms.send).not.toHaveBeenCalled();
  });

  /* ═══════════════════════════════════════════════════════════════════════ *
   * DORMANCE — boîtier muet depuis des jours.
   *
   * Le périmètre est VOLONTAIREMENT minimal : `CUT` + `SCHEDULER` seulement.
   * DORM-2 et DORM-3 sont les tests qui comptent le plus — ils verrouillent
   * l'asymétrie : rater une coupe est un désagrément, rater une RESTAURATION
   * immobilise un véhicule. Si un jour quelqu'un « harmonise » la garde, ils
   * doivent tomber.
   * ═══════════════════════════════════════════════════════════════════════ */

  const dormant = { ...trackerWithVehicle, lastSeenAt: new Date(Date.now() - 89 * 24 * 60 * 60 * 1000) };

  // DORM-1. Coupe AUTO sur boîtier dormant → report sec, rien de persisté, rien d'émis.
  it('DORM-1: suspend une coupe AUTO sur boîtier dormant, sans persister ni émettre', async () => {
    prisma.tracker.findFirst.mockResolvedValue(dormant);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
    expect(gateway.emitEngineCommandUpdate).not.toHaveBeenCalled();
    expect(registry.send).not.toHaveBeenCalled();
    // La porte agit AVANT toute lecture de position : aucun travail inutile.
    expect(prisma.position.findFirst).not.toHaveBeenCalled();
  });

  // DORM-2. ⚠️ Une RESTAURATION n'est JAMAIS suspendue — sinon un véhicule réellement
  // coupé puis devenu muet resterait immobilisé pour toujours.
  it('DORM-2: ne suspend JAMAIS une RESTAURATION, même sur boîtier dormant', async () => {
    prisma.tracker.findFirst.mockResolvedValue(dormant);
    registry.send.mockReturnValue(true);

    await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, superAdmin, 'SCHEDULER');

    expect(registry.send).toHaveBeenCalled(); // dispatch bien tenté
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: EngineAction.RESTORE }),
    });
  });

  // DORM-3. ⚠️ Une action MANUELLE n'est jamais suspendue : immobiliser un véhicule volé
  // sur un boîtier silencieux est exactement le cas où l'on veut tenter sa chance (TCP + SMS).
  it('DORM-3: ne suspend JAMAIS une coupe MANUELLE, et tente le repli SMS', async () => {
    prisma.tracker.findFirst.mockResolvedValue({ ...dormant, simPhoneNumber: '+33600000000' });
    prisma.position.findFirst.mockResolvedValue(recentPosition(0));
    registry.send.mockReturnValue(false); // TCP KO → le repli SMS doit être tenté
    const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
    sms.isEnabled.mockReturnValue(true);
    sms.send.mockResolvedValue({ ok: true });

    await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin);

    expect(sms.send).toHaveBeenCalled();
  });

  // DORM-4. Réintégration automatique : une seule trame fraîche suffit, rien à réactiver.
  it('DORM-4: le boîtier qui réémet redevient immédiatement pilotable par le planning', async () => {
    prisma.tracker.findFirst.mockResolvedValue({ ...trackerWithVehicle, lastSeenAt: new Date() });
    prisma.position.findFirst
      .mockResolvedValueOnce(recentPosition(0))
      .mockResolvedValueOnce(null); // aucun mouvement récent → la coupe passe les gardes
    registry.send.mockReturnValue(true);

    await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER');

    expect(registry.send).toHaveBeenCalled();
  });

  // DORM-5. Frontière : sous le seuil d'action (72 h), on agit normalement.
  it('DORM-5: un silence de 71 h ne suspend pas encore la coupe auto', async () => {
    prisma.tracker.findFirst.mockResolvedValue({
      ...trackerWithVehicle,
      lastSeenAt: new Date(Date.now() - 71 * 60 * 60 * 1000),
    });
    prisma.position.findFirst
      .mockResolvedValueOnce(recentPosition(0))
      .mockResolvedValueOnce(null);
    registry.send.mockReturnValue(true);

    await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER');

    expect(registry.send).toHaveBeenCalled();
  });


  /**
   * ZONE SANS GPS CONFIRMEE — un vehicule gare dans un parking souterrain n'a pas de fix,
   * c'est NORMAL et ca dure tant qu'il est gare. Repeter chaque soir « coupure inverifiable »
   * pour un fait connu et sans action possible, c'est le meme travers que l'alerte de dormance
   * retiree la veille : un etat stable ne se notifie pas en boucle.
   *
   * Cas reel (2026-07-28, FS-253-HR) : boitier vivant en TCP, sans fix GPS depuis le 22/07,
   * gare dans un parking couvert. L'application savait deja reconnaitre ces endroits
   * (GpsDeadZone CONFIRMED_BENIGN, qui fait taire le detecteur « GPS perdu ») mais cette
   * sentinelle l'ignorait : confirmer une zone silenciait UN canal sur DEUX.
   */
  describe('sentinelle de coupure — zone sans GPS confirmee', () => {
    function armeSentinelle(zone: unknown) {
      const deadZones = testModule.get(GpsDeadZonesService) as unknown as { matchZoneForPoint: jest.Mock };
      deadZones.matchZoneForPoint.mockResolvedValue(zone);
      prisma.engineControlCommand.findUnique.mockResolvedValue({
        status: CommandStatus.SENT, ackedAt: null, trackerId: TRACKER_ID,
        sentAt: new Date(Date.now() - 90_000),
      });
      prisma.position.count.mockResolvedValue(0); // boitier muet depuis l'envoi
      prisma.tracker.findUnique.mockResolvedValue({
        vehicleId: VEHICLE_ID, lastLat: 43.6127, lastLng: 1.4507,
      });
      return (service as unknown as { reportIfUnconfirmed: (id: string, imei: string) => Promise<void> });
    }

    it('NE remonte PAS quand la derniere position est dans une zone confirmee benigne', async () => {
      const svc = armeSentinelle({ status: 'CONFIRMED_BENIGN' });
      await svc.reportIfUnconfirmed('cmd-1', '123456789012345');
      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    it('REMONTE quand la zone est seulement SUSPECTE (brouilleur possible)', async () => {
      const svc = armeSentinelle({ status: 'SUSPECT' });
      await svc.reportIfUnconfirmed('cmd-2', '123456789012345');
      expect(errorLogger.record).toHaveBeenCalled();
    });

    it('REMONTE quand aucune zone ne correspond', async () => {
      const svc = armeSentinelle(null);
      await svc.reportIfUnconfirmed('cmd-3', '123456789012345');
      expect(errorLogger.record).toHaveBeenCalled();
    });

    it('⚠️ REMONTE si le boitier PARLE : la zone n explique alors rien', async () => {
      const svc = armeSentinelle({ status: 'CONFIRMED_BENIGN' });
      prisma.position.count.mockResolvedValue(3); // des trames sont arrivees
      await svc.reportIfUnconfirmed('cmd-4', '123456789012345');
      expect(errorLogger.record).toHaveBeenCalled();
    });

    it('FAIL-OPEN : une panne de lookup ne doit pas avaler l alerte', async () => {
      const svc = armeSentinelle({ status: 'CONFIRMED_BENIGN' });
      const deadZones = testModule.get(GpsDeadZonesService) as unknown as { matchZoneForPoint: jest.Mock };
      deadZones.matchZoneForPoint.mockRejectedValue(new Error('service indisponible'));
      await svc.reportIfUnconfirmed('cmd-5', '123456789012345');
      expect(errorLogger.record).toHaveBeenCalled();
    });
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
    prisma.vehicleSchedule.findFirst.mockResolvedValue(enabledScheduleAlwaysOpen);
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
    prisma.vehicleSchedule.findFirst.mockResolvedValue(enabledScheduleAlwaysOpen);
    prisma.position.findFirst.mockResolvedValue(recentPosition(0));
    registry.send.mockReturnValue(true);
    await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'MANUAL', true);
    expect(prisma.vehicleSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }),
    );
  });

  // Un RESTORE (réactivation manuelle) lève le hold indéfini et suspend jusqu'à la prochaine
  // bascule. Ici planning « toujours ouvert » (pas de bascule) → fallback override 1h.
  it('NIGHT_WATCHMAN RESTORE sur planning toujours ouvert → fallback ~1h (surtout pas indéfini)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.vehicleSchedule.findFirst.mockResolvedValue(enabledScheduleAlwaysOpen);
    registry.send.mockReturnValue(true);
    await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, nightWatchman, 'MANUAL', false);
    const call = prisma.vehicleSchedule.updateMany.mock.calls.find((c) => c[0]?.data?.overrideUntil);
    expect(call).toBeDefined();
    const deltaMs = (call![0].data.overrideUntil as Date).getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(50 * 60 * 1000); // ~1h, surtout PAS indéfini
    expect(deltaMs).toBeLessThan(70 * 60 * 1000);
  });

  // Refonte « action manuelle × mode horaire » (feat/comptes-conducteurs) : une action manuelle
  // standard NE désactive PLUS le planning — elle le suspend jusqu'à la PROCHAINE bascule (8h/22h),
  // puis il reprend seul. On vérifie que `overrideUntil` = computeNextTransition, PAS un 1h fixe,
  // et que `enabled:false` n'est jamais posé.
  it('action manuelle standard sur planning fenêtré → override jusqu\'à la prochaine bascule (pas 1h fixe), sans désactiver', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.vehicleSchedule.findFirst.mockResolvedValue(enabledScheduleWindowed);
    registry.send.mockReturnValue(true);
    const before = computeNextTransition(enabledScheduleWindowed as never)!.at.getTime();
    await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin, 'MANUAL', false);
    const after = computeNextTransition(enabledScheduleWindowed as never)!.at.getTime();
    const call = prisma.vehicleSchedule.updateMany.mock.calls.find((c) => c[0]?.data?.overrideUntil);
    expect(call).toBeDefined();
    const actual = (call![0].data.overrideUntil as Date).getTime();
    // Encadré par deux calculs de la prochaine bascule (dérive < quelques ms entre les appels).
    expect(actual).toBeGreaterThanOrEqual(before - 1000);
    expect(actual).toBeLessThanOrEqual(after + 1000);
    // Le mode reste actif : jamais enabled:false sur une action manuelle standard.
    expect(prisma.vehicleSchedule.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }),
    );
  });

  /**
   * Sentinelle « coupure non confirmée » — instabilité des tests diagnostiquée le 2026-07-20.
   *
   * Une coupe confirmable arme un timer à 90 s. Il survivait à son contexte : il se réveillait
   * pendant une AUTRE suite, appelait un Prisma qui n'existait plus (`findUnique()` → `undefined`),
   * et le `.catch` sur `undefined` levait un TypeError DANS un callback fire-and-forget → rejet non
   * rattrapé → **crash du worker Node** → des tests sans aucun rapport échouaient au hasard.
   * Symptôme trompeur : la suite ne cassait que lorsqu'elle durait plus de 90 s.
   */
  describe('sentinelle « coupure non confirmée » — ne doit jamais survivre ni crasher', () => {
    /** Arme une vraie sentinelle : coupe confirmable (contact mis) livrée en TCP. */
    async function armSentinel() {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.position.findFirst.mockResolvedValue({ ...recentPosition(0), ignition: true });
      prisma.engineControlCommand.findFirst.mockResolvedValue(null);
      registry.send.mockReturnValue(true);
      await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin);
    }

    it('annule ses timers à l\'arrêt du module (ils ne réveillent plus un monde disparu)', async () => {
      jest.useFakeTimers();
      try {
        await armSentinel();
        expect(jest.getTimerCount()).toBeGreaterThan(0); // sentinelle bien armée

        service.onModuleDestroy();

        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('⚠️ ne produit AUCUN rejet non rattrapé, même si Prisma répond n\'importe quoi', async () => {
      const rejections: unknown[] = [];
      const capture = (e: unknown) => rejections.push(e);
      process.on('unhandledRejection', capture);
      jest.useFakeTimers();
      try {
        await armSentinel();
        // Le cas EXACT du crash : le mock ne renvoie pas de promesse (contexte détruit).
        prisma.engineControlCommand.findUnique.mockReturnValue(undefined as never);

        jest.advanceTimersByTime(95_000); // la sentinelle se réveille
        jest.useRealTimers();
        // Laisse les microtâches (et donc un éventuel rejet) remonter.
        await new Promise((r) => setTimeout(r, 10));

        expect(rejections).toEqual([]);
      } finally {
        jest.useRealTimers();
        process.off('unhandledRejection', capture);
      }
    });
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

  // SCH-5. Incident FS-253 : dernière position VIEILLE (28h) avec vitesse FIGÉE > 5 km/h (boîtier
  // GPS muet mais garé) → la vitesse périmée ne bloque PLUS la coupe auto ; sans mouvement récent
  // dans la fenêtre → la coupe est autorisée (avant : REJECTED_SPEED « position trop ancienne » en boucle).
  it('should ALLOW a SCHEDULER CUT when last position is STALE with speed>5 but no recent movement', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst
      .mockResolvedValueOnce(recentPosition(12.8, 28 * 3600 * 1000)) // lastPosition : 12.8 km/h figé, VIEUX de 28h
      .mockResolvedValueOnce(null); // aucune trame en mouvement dans la fenêtre 10 min
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(ServiceUnavailableException); // passe les gardes → échoue au dispatch offline
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING, source: 'SCHEDULER' }),
    });
  });

  // SCH-6. Non-régression : une coupe MANUELLE (admin) garde le garde « stale » — une position
  // périmée en mouvement est refusée (le garde n'est levé QUE pour le SCHEDULER).
  it('should STILL reject a MANUAL cut on a stale moving position (guard only lifted for SCHEDULER)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(12.8, 28 * 3600 * 1000));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'MANUAL'),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.REJECTED_SPEED, lastError: expect.stringContaining('Position trop ancienne') }),
    });
  });

  /**
   * ── TRK-046 : LA VITESSE FIGÉE D'UN VÉHICULE HORS CHAMP NE DÉCIDE PLUS ──────────────────
   *
   * Mesuré en production le 25/08 (FZ-862-VY) : entré dans un souterrain à 27,15 km/h, plus
   * un fix pendant 7,7 h, et 13 refus « Vitesse trop élevée : 27.15 km/h » d'affilée sur une
   * vitesse datée de la veille. Le lieu de la perte décide désormais :
   *   parking VALIDÉ → considéré stationné (exception typée, rien de persisté) ;
   *   lieu inconnu   → report honnête (jamais de coupe à l'aveugle : un tunnel ne produit
   *                    AUCUNE position, le scan d'immobilité y est aveugle par construction).
   *
   * ⚠️ Les fixtures portent les champs TRACKER réels du hors-champ (lastNoFixAt frais +
   * lastPositionAt périmé) : SCH-5 ci-dessus reste sur l'ancien chemin précisément parce que
   * sa fixture n'a PAS ces champs — un harnais qui les omettrait rendrait cette logique
   * invisible (le piège « mock manquant » payé trois fois le 24/08).
   */
  const horsChampTracker = (overrides: Record<string, unknown> = {}) => ({
    ...trackerWithVehicle,
    status: 'ONLINE',
    lastSeenAt: new Date(),                                     // le boîtier parle (trames L)
    lastNoFixAt: new Date(),                                    // ...sans lock satellite
    lastPositionAt: new Date(Date.now() - 7.7 * 3600 * 1000),   // dernière position : 7,7 h
    lastKnownIgnition: true,
    lastLat: 33.5,
    lastLng: -7.6,
    powerLossSuspectAt: null,
    ...overrides,
  });
  const zoneParkingValidee = {
    id: '00000000-0000-0000-0000-000000000070',
    vehicleId: VEHICLE_ID,
    fleetId: FLEET_ID,
    status: 'CONFIRMED_BENIGN',
    label: 'UNDERGROUND_PARKING',
    placeLabel: 'Centre commercial',
    centroidLat: 33.5,
    centroidLng: -7.6,
    radiusM: 40,
  };

  // SCH-7 (le bug TRK-046, test écrit AVANT le correctif et vérifié EN ÉCHEC sur l'ancien
  // code : il persistait une REJECTED_SPEED « Vitesse trop élevée : 27.15 km/h »).
  it('TRK-046: defers (no REJECTED_SPEED) a SCHEDULER CUT on a GPS-dark vehicle with stale speed > 20', async () => {
    prisma.tracker.findFirst.mockResolvedValue(horsChampTracker());
    prisma.position.findFirst.mockResolvedValue(recentPosition(27.15, 7.7 * 3600 * 1000));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(/hors champ GPS/);
    // La cause honnête nomme la durée et disqualifie la vitesse — plus jamais « Vitesse trop élevée ».
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
  });

  // SCH-8. Lieu VALIDÉ parking → considéré stationné : exception TYPÉE (le cron la traite
  // comme un état calme), aucune commande, aucun refus persisté.
  it('TRK-046: presumes PARKED (typed exception, nothing persisted) when the loss anchor is a validated parking', async () => {
    const deadZones = testModule.get(GpsDeadZonesService) as { matchZoneForPoint: jest.Mock };
    deadZones.matchZoneForPoint.mockResolvedValue(zoneParkingValidee);
    prisma.tracker.findFirst.mockResolvedValue(horsChampTracker());
    prisma.position.findFirst.mockResolvedValue(recentPosition(27.15, 7.7 * 3600 * 1000));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(PresumedParkedException);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(/considéré stationné/);
    expect(deadZones.matchZoneForPoint).toHaveBeenCalledWith(VEHICLE_ID, 33.5, -7.6);
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
  });

  // SCH-9. Soupçon de coupure d'alimentation (TRK-040) → JAMAIS de présomption, même en zone
  // validée : un boîtier peut-être en train de mourir débranché n'est pas « stationné ».
  it('TRK-046: never presumes parked while a power-loss suspicion is open (falls back to honest deferral)', async () => {
    const deadZones = testModule.get(GpsDeadZonesService) as { matchZoneForPoint: jest.Mock };
    deadZones.matchZoneForPoint.mockResolvedValue(zoneParkingValidee);
    prisma.tracker.findFirst.mockResolvedValue(horsChampTracker({ powerLossSuspectAt: new Date() }));
    prisma.position.findFirst.mockResolvedValue(recentPosition(27.15, 7.7 * 3600 * 1000));
    const err: unknown = await service
      .requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(PresumedParkedException); // report honnête, pas une présomption
    expect((err as Error).message).toMatch(/hors champ GPS/);
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
  });

  // SCH-10. Zone bénigne mais PAS parking (tunnel) → pas de présomption : seul un parking
  // rend la perte attendue sans limite (même sémantique que gps-integrity / le front).
  it('TRK-046: a benign non-parking zone (TUNNEL) does not presume parked', async () => {
    const deadZones = testModule.get(GpsDeadZonesService) as { matchZoneForPoint: jest.Mock };
    deadZones.matchZoneForPoint.mockResolvedValue({ ...zoneParkingValidee, label: 'TUNNEL' });
    prisma.tracker.findFirst.mockResolvedValue(horsChampTracker());
    prisma.position.findFirst.mockResolvedValue(recentPosition(27.15, 7.7 * 3600 * 1000));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(/hors champ GPS/);
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
  });

  // SCH-11. Hors champ mais perdu À L'ARRÊT (vitesse figée ≤ 5), lieu inconnu → chemin de
  // juillet (FS-253) CONSERVÉ : le scan d'immobilité ne trouve rien, la coupe part.
  it('TRK-046: still ALLOWS the cut when the vehicle went dark at rest (July behaviour preserved)', async () => {
    prisma.tracker.findFirst.mockResolvedValue(horsChampTracker());
    prisma.position.findFirst
      .mockResolvedValueOnce(recentPosition(0, 7.7 * 3600 * 1000)) // perdu à l'arrêt
      .mockResolvedValueOnce(null); // aucun mouvement dans la fenêtre 10 min
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(ServiceUnavailableException); // passe les gardes → échoue au dispatch offline
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING, source: 'SCHEDULER' }),
    });
  });

  // SCH-12. ASYMÉTRIE SACRÉE : un RESTORE n'est JAMAIS retenu par la présomption — rater une
  // coupe est un désagrément, rater une restauration immobilise un véhicule.
  it('TRK-046: RESTORE is never held back by the parked presumption', async () => {
    const deadZones = testModule.get(GpsDeadZonesService) as { matchZoneForPoint: jest.Mock };
    deadZones.matchZoneForPoint.mockResolvedValue(zoneParkingValidee);
    prisma.tracker.findFirst.mockResolvedValue(horsChampTracker());
    registry.send.mockReturnValue(false);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, superAdmin, 'SCHEDULER'),
    ).rejects.toThrow(ServiceUnavailableException); // la commande PART (échec dispatch offline)
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING, action: EngineAction.RESTORE }),
    });
  });

  /**
   * ── TRK-036 : L'ACCUSE DU BOITIER ARRIVE PAR SMS, ET IL FAUT LE RAMASSER ────────────
   *
   * Le 2026-08-19 a 04:39:13, un RESTORE part vers GS-014-NY par le repli SMS. A 08:28:58 le
   * boitier repond « Resume engine Succeed » depuis sa carte SIM. Le message est recu, ecrit
   * dans `sms_logs`... et la commande reste au statut « envoye » 21 heures plus tard.
   *
   * Ces tests verrouillent le rapprochement ET ses abstentions — qui comptent autant : un
   * accuse colle au mauvais vehicule ferait croire a une coupure moteur confirmee.
   */
  describe('TRK-036 — accuse SMS du boitier', () => {
    const SIM = '+345901030609501';
    const evt = (body: string, fromNumber = SIM) =>
      ({ smsLogId: 'log-1', fromNumber, toNumber: '+33656691615', body, receivedAt: new Date().toISOString() }) as never;

    const armerBoitier = () => {
      prisma.tracker.findMany.mockResolvedValue([
        { id: 'trk-1', imei: '864035054756169', vehicle: { fleetId: 'fleet-1' } },
      ] as never);
    };
    const armerCommande = () => {
      prisma.engineControlCommand.findFirst.mockResolvedValue({
        id: 'cmd-1',
        createdAt: new Date(Date.now() - 3 * 3600_000),
      } as never);
      prisma.engineControlCommand.findUnique.mockResolvedValue({ id: 'cmd-1', fleetId: 'fleet-1' } as never);
    };

    it('🔴 « Resume engine Succeed » acquitte le RESTORE resté en attente', async () => {
      // LE test du correctif : il échoue sur le code d'avant, où ce chemin n'existait pas.
      armerBoitier();
      armerCommande();

      await service.onAccuseSmsMoteur(evt('Resume engine Succeed'));

      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACKNOWLEDGED' }),
        }),
      );
    });

    it('cherche la commande sur le COUPLE (boitier, action) — jamais sur le temps seul', async () => {
      // ⚠️ 3 h 50 séparaient la commande de sa réponse. Une fenêtre temporelle assez large
      // pour couvrir ce cas rattacherait n'importe quel accusé à n'importe quelle commande.
      armerBoitier();
      armerCommande();

      await service.onAccuseSmsMoteur(evt('Stop engine Succeed'));

      const where = prisma.engineControlCommand.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ trackerId: 'trk-1', action: 'CUT', status: 'SENT' });
    });

    it('un SMS ordinaire ne touche à rien', async () => {
      armerBoitier();
      await service.onAccuseSmsMoteur(evt('Bonjour, je vois avec eux demain'));
      expect(prisma.engineControlCommand.findFirst).not.toHaveBeenCalled();
      expect(prisma.engineControlCommand.updateMany).not.toHaveBeenCalled();
    });

    it('🔴 DEUX boitiers pour ce numero : on n acquitte RIEN', async () => {
      // Confirmer une coupure moteur sur le mauvais véhicule est plus grave que ne rien
      // confirmer : l'exploitant croirait le vehicule immobilise alors qu'il roule.
      prisma.tracker.findMany.mockResolvedValue([
        { id: 'trk-1', imei: '1', vehicle: { fleetId: 'f' } },
        { id: 'trk-2', imei: '2', vehicle: { fleetId: 'f' } },
      ] as never);
      await service.onAccuseSmsMoteur(evt('Resume engine Succeed'));
      expect(prisma.engineControlCommand.updateMany).not.toHaveBeenCalled();
    });

    it('numero inconnu : aucune ecriture', async () => {
      prisma.tracker.findMany.mockResolvedValue([] as never);
      await service.onAccuseSmsMoteur(evt('Resume engine Succeed'));
      expect(prisma.engineControlCommand.updateMany).not.toHaveBeenCalled();
    });

    it('accuse sans commande en attente : aucune ecriture', async () => {
      armerBoitier();
      prisma.engineControlCommand.findFirst.mockResolvedValue(null as never);
      await service.onAccuseSmsMoteur(evt('Resume engine Succeed'));
      expect(prisma.engineControlCommand.updateMany).not.toHaveBeenCalled();
    });

    it('IDEMPOTENT : un second SMS identique ne reecrit pas un acquittement pose', async () => {
      armerBoitier();
      armerCommande();
      prisma.engineControlCommand.updateMany.mockResolvedValue({ count: 0 } as never);

      await service.onAccuseSmsMoteur(evt('Resume engine Succeed'));

      // `count: 0` = le statut n'etait plus SENT. On ne diffuse pas une mise a jour fantome.
      expect(gateway.emitEngineCommandUpdate).not.toHaveBeenCalled();
    });

    it('🔴 une panne de ce chemin NE CASSE PAS le flux SMS entrant', async () => {
      // ⚠️ Un ecouteur qui leve casse l'evenement pour TOUS les abonnes — dont la machine a
      // etats de provisionnement, qui attend ses ACK sur le meme canal.
      armerBoitier();
      prisma.engineControlCommand.findFirst.mockRejectedValue(new Error('DB down') as never);

      await expect(service.onAccuseSmsMoteur(evt('Resume engine Succeed'))).resolves.toBeUndefined();
    });

    it('le rapprochement tolere les variations d ecriture du numero', async () => {
      // Le meme numero circule en `+33…`, `0033…` ou `0…` selon l'operateur qui le relaie.
      armerBoitier();
      armerCommande();

      await service.onAccuseSmsMoteur(evt('Resume engine Succeed', '00345901030609501'));

      const where = prisma.tracker.findMany.mock.calls[0][0].where;
      expect(where.simPhoneNumber.endsWith).toBe('030609501');
    });
  });

  /**
   * ── TRK-018 : UNE COMMANDE MOTEUR N'AVAIT PAS DE FIN DE VIE ────────────────────────
   *
   * Mesure du 2026-08-24 : 313 commandes `SENT`, dont 307 de plus de 24 h, 0 acquittee
   * depuis l'origine. Rien ne soldait jamais ces lignes — la file n'etait plus une file.
   *
   * 🔑 `SENT_UNCONFIRMED` est VOLONTAIREMENT distinct de `FAILED` : « a echoue » et « nul
   * ne sait » ne sont pas la meme information. Le coupe-circuit est une garde de securite,
   * et une garde qu'on croit armee sans preuve est plus dangereuse qu'une garde qu'on sait
   * muette.
   */
  describe('cloture par echeance des commandes moteur (TRK-018)', () => {
    it('🔴 ferme en SENT_UNCONFIRMED, jamais en FAILED', async () => {
      await service.cloturerCommandesPerimees();

      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledTimes(1);
      const arg = prisma.engineControlCommand.updateMany.mock.calls[0][0];
      expect(arg.data.status).toBe('SENT_UNCONFIRMED');
      expect(arg.data.expiredAt).toBeInstanceOf(Date);
    });

    it('🔴 l echeance est PUREMENT TEMPORELLE — lecon de TRK-007', async () => {
      // La conditionner a un etat du boitier la ferait retomber dans le piege qu'elle
      // pretend fermer : on attendrait une confirmation qui n'arrive jamais pour fermer
      // une ligne ouverte faute de confirmation.
      await service.cloturerCommandesPerimees();

      const where = prisma.engineControlCommand.updateMany.mock.calls[0][0].where;
      expect(Object.keys(where).sort()).toEqual(['ackedAt', 'sentAt', 'status']);
      expect(where.status).toBe('SENT');
      expect(where.ackedAt).toBeNull();
      expect(where.sentAt.lt).toBeInstanceOf(Date);
    });

    it('🔴 n ecrit JAMAIS ackedAt — le temoin n est pas le defaut', async () => {
      // Marquer ces commandes acquittees d office ferait disparaitre les 313 lignes et
      // supprimerait la seule trace de la question.
      await service.cloturerCommandesPerimees();

      const data = prisma.engineControlCommand.updateMany.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('ackedAt');
      expect(data).not.toHaveProperty('lastError');
    });

    it('l echeance est tres au-dela de la fenetre de confirmation', async () => {
      // 30 min par defaut, contre 15 s d'ACK et 90 s de confirmation par ignition : passe
      // ce delai, aucun mecanisme existant ne peut plus confirmer la commande.
      const avant = Date.now();
      await service.cloturerCommandesPerimees();

      const seuil = prisma.engineControlCommand.updateMany.mock.calls[0][0].where.sentAt.lt as Date;
      const ecartMin = (avant - seuil.getTime()) / 60000;
      expect(ecartMin).toBeGreaterThanOrEqual(29);
      expect(ecartMin).toBeLessThanOrEqual(31);
    });

    it('un echec de balayage ne remonte pas', async () => {
      prisma.engineControlCommand.updateMany.mockRejectedValue(new Error('DB down'));
      await expect(service.cloturerCommandesPerimees()).resolves.toBeUndefined();
    });
  });
});
