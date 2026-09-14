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
import { AutomaticCutWithheldException, EngineControlService, PresumedParkedException } from './engine-control.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { computeNextTransition } from '../vehicle-schedules/schedule-evaluator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ══ T53 (contre-expertise du 13/09, P2-10) — LE JOURNAL DES TENTATIVES EST EXERCÉ ═══════════
 *
 * Le service lit le délégué `engineDeliveryAttempt` en duck-typing : absent du harnais, il
 * rendait `beginAttempt`/`finishAttempt` INERTES — la suite était verte sans jamais écrire une
 * tentative, et ni le CHECK des statuts ni l'unicité (commandId, attemptNumber) posés par la
 * migration n'avaient tourné une seule fois. Le faux délégué ci-dessous rejoue les DEUX
 * contraintes, lues dans le SQL de la migration lui-même : un statut inventé dans le code
 * fait échouer un test ici avant d'échouer en production.
 */
const MIGRATION_TENTATIVES = readFileSync(
  join(__dirname, '../../prisma/migrations/20260912110000_engine_delivery_reliability/migration.sql'),
  'utf8',
);
function valeursDuCheck(contrainte: string): string[] {
  const m = new RegExp(`CONSTRAINT "${contrainte}" CHECK \\(\\s*"\\w+" IN \\(([^)]*)\\)`).exec(MIGRATION_TENTATIVES);
  if (!m) throw new Error(`contrainte ${contrainte} introuvable dans la migration`);
  return [...m[1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]!);
}
const ATTEMPT_CHANNELS = valeursDuCheck('engine_delivery_attempts_channel_check');
const ATTEMPT_STATUSES = valeursDuCheck('engine_delivery_attempts_status_check');

type LigneTentative = { id: string; commandId: string; attemptNumber: number; channel: string; status: string; finishedAt: Date | null } & Record<string, unknown>;

function faussesTentatives() {
  const rows: LigneTentative[] = [];
  const violation = (code: string, message: string) => Object.assign(new Error(message), { code });
  const verifier = (data: Record<string, unknown>) => {
    if ('channel' in data && !ATTEMPT_CHANNELS.includes(String(data['channel']))) {
      throw violation('23514', `engine_delivery_attempts_channel_check violée : ${String(data['channel'])}`);
    }
    if ('status' in data && !ATTEMPT_STATUSES.includes(String(data['status']))) {
      throw violation('23514', `engine_delivery_attempts_status_check violée : ${String(data['status'])}`);
    }
  };
  return {
    rows,
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      verifier(data);
      if (rows.some((r) => r.commandId === data['commandId'] && r.attemptNumber === data['attemptNumber'])) {
        throw violation('P2002', `engine_delivery_attempts_commandId_attemptNumber_key violée : ${String(data['commandId'])}#${String(data['attemptNumber'])}`);
      }
      const row = { id: `attempt-${rows.length + 1}`, startedAt: new Date(), finishedAt: null, ...data } as unknown as LigneTentative;
      rows.push(row);
      return { id: row.id };
    }),
    updateMany: jest.fn(async ({ where, data }: { where: { id?: string; commandId?: string; smsLogId?: string }; data: Record<string, unknown> }) => {
      verifier(data);
      // Les deux formes que le service emploie : par id (finishAttempt) et par (commandId, smsLogId)
      // (réconciliation du worker : DELIVERED / FAILED posés sur la tentative SMS corrélée).
      const hits = rows.filter((r) =>
        where.id !== undefined ? r.id === where.id : r.commandId === where.commandId && r['smsLogId'] === where.smsLogId,
      );
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    }),
  };
}

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
    engineDeliveryAttempt: ReturnType<typeof faussesTentatives>;
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
      // T53 — présent dans TOUS les tests : chaque dispatch écrit ses tentatives et se heurte
      // aux contraintes de la migration.
      engineDeliveryAttempt: faussesTentatives(),
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
        {
          provide: SmsGatewayService,
          useValue: {
            isEnabled: jest.fn().mockReturnValue(false),
            send: jest.fn(),
            reconcileOutboundStatus: jest.fn(),
            cancelOutbound: jest.fn().mockResolvedValue({ ok: true, status: 'cancelling' }),
            healthCheck: jest.fn(),
            currentProvider: jest.fn().mockReturnValue('noop'),
            dispatchQueueState: jest.fn().mockReturnValue({ depth: 0, minIntervalMs: 15000, nextDispatchAt: null }),
          },
        },
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

    // La réponse HTTP reflète maintenant l'état réellement persisté après dispatch.
    expect(result.status).toBe(CommandStatus.SENT);
    expect(registry.send).toHaveBeenCalledWith(
      '123456789012345',
      expect.stringContaining('**,imei:123456789012345,J;'),
    );
    // T48 — l'écriture « envoyée » est CONDITIONNELLE : jamais par-dessus une preuve.
    expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith({
      where: { id: expect.any(String), ackedAt: null, status: { in: [CommandStatus.PENDING, CommandStatus.SENT] } },
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

    const result = await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin);
    expect(result.status).toBe(CommandStatus.PENDING);
    expect(result.lastError).toContain('reconnexion prioritaire');

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
    ).resolves.toEqual(expect.objectContaining({ status: CommandStatus.PENDING }));

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
    ).resolves.toEqual(expect.objectContaining({ status: CommandStatus.PENDING }));
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
    ).resolves.toEqual(expect.objectContaining({ status: CommandStatus.PENDING }));
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

  it('défense interne : RESTORE avec disableSchedule=true ne désactive jamais le planning', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
    prisma.vehicleSchedule.findFirst.mockResolvedValue(enabledScheduleAlwaysOpen);
    registry.send.mockReturnValue(true);
    await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin, 'MANUAL', true);
    expect(prisma.vehicleSchedule.updateMany).not.toHaveBeenCalledWith(
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
    ).resolves.toEqual(expect.objectContaining({ status: CommandStatus.PENDING }));
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

      // Deux balayages : les CUT (30 min) puis, depuis la contre-expertise du 13/09, les
      // RESTORE sans preuve (4 h) — jamais FAILED, ni l'un ni l'autre.
      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledTimes(2);
      for (const [arg] of prisma.engineControlCommand.updateMany.mock.calls) {
        expect(arg.data.status).toBe('SENT_UNCONFIRMED');
        expect(arg.data.expiredAt).toBeInstanceOf(Date);
      }
    });

    it('P0-1 : ferme aussi les RESTORE « envoyées » sans preuve après ENGINE_RESTORE_EXPIRY (4 h) en libérant leur clé — jamais sous lease', async () => {
      const avant = Date.now();
      await service.cloturerCommandesPerimees();

      const { where, data } = prisma.engineControlCommand.updateMany.mock.calls[1][0];
      expect(where.action).toBe('RESTORE');
      expect(where.status).toBe('SENT');
      expect(where.ackedAt).toBeNull();
      // T42 — l'horloge part de la première transmission, ou de la création si rien n'est
      // jamais parti (socket absente, SMS refusés) : sinon la ligne ne se fermerait jamais.
      const [horloge, lease] = where.AND as [{ OR: unknown[] }, { OR: unknown[] }];
      expect(horloge.OR).toEqual([
        { sentAt: { lt: expect.any(Date) } },
        { sentAt: null, createdAt: { lt: expect.any(Date) } },
      ]);
      const seuil = (horloge.OR[0] as { sentAt: { lt: Date } }).sentAt.lt;
      const ecartMin = (avant - seuil.getTime()) / 60000;
      expect(ecartMin).toBeGreaterThanOrEqual(239);
      expect(ecartMin).toBeLessThanOrEqual(241);
      expect((horloge.OR[1] as { createdAt: { lt: Date } }).createdAt.lt).toEqual(seuil);
      // Une ligne que le worker est en train de traiter (lease posé) n'est pas réécrite.
      expect(lease.OR).toEqual([
        { dispatchLeaseUntil: null },
        { dispatchLeaseUntil: { lt: expect.any(Date) } },
      ]);
      expect(data).toMatchObject({
        status: 'SENT_UNCONFIRMED',
        activeKey: null,
        nextAttemptAt: null,
        dispatchLeaseUntil: null,
      });
      expect(data).not.toHaveProperty('ackedAt');
    });

    it('🔴 l echeance est PUREMENT TEMPORELLE — lecon de TRK-007', async () => {
      // La conditionner a un etat du boitier la ferait retomber dans le piege qu'elle
      // pretend fermer : on attendrait une confirmation qui n'arrive jamais pour fermer
      // une ligne ouverte faute de confirmation.
      await service.cloturerCommandesPerimees();

      const where = prisma.engineControlCommand.updateMany.mock.calls[0][0].where;
      expect(Object.keys(where).sort()).toEqual(['ackedAt', 'action', 'sentAt', 'status']);
      expect(where.status).toBe('SENT');
      expect(where.action).toBe('CUT');
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

  /**
   * ══ TRK-018 nº 4 — l'écran « immobilisations non confirmées » ═══════════════════════════
   *
   * Ce que ces tests verrouillent avant tout : le CLOISONNEMENT (une flotte ne voit jamais les
   * immobilisations d'une autre) et le VOCABULAIRE (`FAILED` n'est PAS une cécité).
   */
  describe('TRK-018 nº 4 — immobilisations non confirmées', () => {
    const ligne = (o: Partial<{ id: string; status: CommandStatus; action: EngineAction; channel: string | null; ageH: number; plate: string | null; source: string }> = {}) => ({
      id: o.id ?? 'c1',
      status: o.status ?? CommandStatus.SENT_UNCONFIRMED,
      action: o.action ?? EngineAction.CUT,
      channel: o.channel === undefined ? 'TCP' : o.channel,
      source: o.source ?? 'SCHEDULER',
      ackedAt: null,
      trackerId: TRACKER_ID,
      createdAt: new Date(Date.now() - (o.ageH ?? 1) * 3600_000),
      tracker: {
        imei: '123456789012345',
        // ⚠️ L'id doit SUIVRE la plaque : le regroupement se fait par identifiant de véhicule
        // (plus juste qu'une plaque, qui peut changer). Un fixture qui donne le même id à deux
        // plaques différentes les ferait fusionner — et ferait passer le test pour une raison
        // fausse. Constaté à l'écriture de ce test.
        vehicle:
          o.plate === null
            ? null
            : { id: `veh-${o.plate ?? 'AB-123-CD'}`, plate: o.plate ?? 'AB-123-CD' },
      },
    });

    it('ne demande QUE des commandes sans accusé, jamais les FAILED', async () => {
      prisma.engineControlCommand.findMany.mockResolvedValue([]);

      await service.listUnconfirmedImmobilisations({ userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null });

      const where = prisma.engineControlCommand.findMany.mock.calls[0][0].where;
      expect(where.ackedAt).toBeNull();
      expect(where.status.in).toEqual(
        expect.arrayContaining([CommandStatus.SENT_UNCONFIRMED, CommandStatus.SENT]),
      );
      // « A échoué » et « nul ne sait » ne sont pas la même information.
      expect(where.status.in).not.toContain(CommandStatus.FAILED);
    });

    /** 🔴 Le test qui compte : une flotte ne doit jamais voir les immobilisations d'une autre. */
    it('cloisonne un FLEET_ADMIN sur SA flotte', async () => {
      prisma.engineControlCommand.findMany.mockResolvedValue([]);

      await service.listUnconfirmedImmobilisations({ userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID });

      const where = prisma.engineControlCommand.findMany.mock.calls[0][0].where;
      expect(where.tracker).toEqual({ vehicle: { fleetId: FLEET_ID } });
      expect(where.tracker.vehicle.fleetId).not.toBe(OTHER_FLEET_ID);
    });

    it('ne pose AUCUN filtre de flotte pour un SUPER_ADMIN', async () => {
      prisma.engineControlCommand.findMany.mockResolvedValue([]);

      await service.listUnconfirmedImmobilisations({ userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null });

      expect(prisma.engineControlCommand.findMany.mock.calls[0][0].where.tracker).toBeUndefined();
    });

    /** Fail-closed : un non-super sans flotte ne voit RIEN, et la base n'est même pas interrogée. */
    it('rend un résultat vide SANS requêter pour un non-super sans flotte', async () => {
      const r = await service.listUnconfirmedImmobilisations({ userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: null });

      expect(prisma.engineControlCommand.findMany).not.toHaveBeenCalled();
      expect(r.resume.total).toBe(0);
      expect(r.parVehicule).toEqual([]);
      expect(r.recentes).toEqual([]);
    });

    it('ventile par canal et compte INCONNU quand le canal n a jamais été observé', async () => {
      prisma.engineControlCommand.findMany.mockResolvedValue([
        ligne({ id: 'a', channel: 'TCP' }),
        ligne({ id: 'b', channel: 'SMS' }),
        ligne({ id: 'c', channel: null }),
        ligne({ id: 'd', channel: null }),
      ]);

      const r = await service.listUnconfirmedImmobilisations({ userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null });

      expect(r.resume.parCanal).toEqual({ TCP: 1, SMS: 1, INCONNU: 2 });
      expect(r.resume.total).toBe(4);
    });

    it('regroupe par véhicule, trie par volume et compte les envois SMS', async () => {
      prisma.engineControlCommand.findMany.mockResolvedValue([
        ligne({ id: 'a', plate: 'EY-613-MF', channel: 'SMS', ageH: 1 }),
        ligne({ id: 'b', plate: 'EY-613-MF', channel: 'SMS', ageH: 5 }),
        ligne({ id: 'c', plate: 'EY-613-MF', channel: null, ageH: 9 }),
        ligne({ id: 'd', plate: 'FS-253-HR', channel: 'TCP', ageH: 2 }),
      ]);

      const r = await service.listUnconfirmedImmobilisations({ userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null });

      expect(r.parVehicule[0]).toMatchObject({ plaque: 'EY-613-MF', total: 3, viaSms: 2, canalInconnu: 1 });
      expect(r.parVehicule[1]).toMatchObject({ plaque: 'FS-253-HR', total: 1, viaSms: 0 });
      expect(r.resume.vehiculesConcernes).toBe(2);
    });

    it('compte les fenêtres 24 h et 7 j sur les horodatages réels', async () => {
      prisma.engineControlCommand.findMany.mockResolvedValue([
        ligne({ id: 'a', ageH: 2 }),
        ligne({ id: 'b', ageH: 20 }),
        ligne({ id: 'c', ageH: 50 }),
        ligne({ id: 'd', ageH: 400 }),
      ]);

      const r = await service.listUnconfirmedImmobilisations({ userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null });

      expect(r.resume.dernieres24h).toBe(2);
      expect(r.resume.derniers7j).toBe(3);
      expect(r.resume.total).toBe(4);
    });

    it('supporte un boîtier sans véhicule sans planter', async () => {
      prisma.engineControlCommand.findMany.mockResolvedValue([ligne({ id: 'a', plate: null })]);

      const r = await service.listUnconfirmedImmobilisations({ userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null });

      expect(r.parVehicule[0].plaque).toBe('(sans véhicule)');
      expect(r.parVehicule[0].vehicleId).toBeNull();
    });

    it('borne la fenêtre demandée entre 1 et 365 jours', async () => {
      prisma.engineControlCommand.findMany.mockResolvedValue([]);

      const trop = await service.listUnconfirmedImmobilisations(
        { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null }, { days: 9999 });
      expect(trop.fenetreJours).toBe(365);

      const peu = await service.listUnconfirmedImmobilisations(
        { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null }, { days: 0 });
      expect(peu.fenetreJours).toBe(1);
    });

    /** ⚠️ Cet écran informe. Il ne doit jamais écrire — surtout pas `ackedAt` (cf. TRK-014). */
    it('est en LECTURE SEULE — aucune écriture, aucun acquittement', async () => {
      prisma.engineControlCommand.findMany.mockResolvedValue([ligne({ id: 'a' })]);

      await service.listUnconfirmedImmobilisations({ userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null });

      expect(prisma.engineControlCommand.update).not.toHaveBeenCalled();
      expect(prisma.engineControlCommand.updateMany).not.toHaveBeenCalled();
      expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
    });
  });

  describe('fiabilité coupe-circuit — incident septembre 2026', () => {
    it('bloque par défaut une CUT automatique en production', async () => {
      const previousNodeEnv = process.env['NODE_ENV'];
      const previousFlag = process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
      process.env['NODE_ENV'] = 'production';
      delete process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);

      try {
        await expect(
          service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
        ).rejects.toThrow('Coupures automatiques désactivées');
        expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
        // T49 — un état voulu, pas une panne : DÉGRADATION (non compté, pas de vigie), et typé.
        expect(errorLogger.record).toHaveBeenCalledWith(
          expect.stringContaining('kill-switch'),
          'engine-control-interlock',
          expect.objectContaining({ cause: 'kill-switch', trackerId: TRACKER_ID, plate: 'AB-123-CD', refusalsSinceLastLine: 1 }),
          'DEGRADATION',
        );
        await expect(
          service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
        ).rejects.toBeInstanceOf(AutomaticCutWithheldException);
      } finally {
        if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = previousNodeEnv;
        if (previousFlag === undefined) delete process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
        else process.env['ENGINE_AUTOMATIC_CUT_ENABLED'] = previousFlag;
      }
    });

    it('bloque une CUT automatique si le téléphone Android ne ping plus', async () => {
      const previousNodeEnv = process.env['NODE_ENV'];
      const previousFlag = process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
      process.env['NODE_ENV'] = 'production';
      process.env['ENGINE_AUTOMATIC_CUT_ENABLED'] = 'true';
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      const sms = testModule.get(SmsGatewayService) as unknown as {
        currentProvider: jest.Mock;
        healthCheck: jest.Mock;
      };
      sms.currentProvider.mockReturnValue('vizyo-texto');
      sms.healthCheck.mockResolvedValue({
        enabled: true,
        reachable: true,
        deliveryProofAvailable: true,
        pendingWithoutReceipt: 0,
        oldestPendingAt: null,
        lastTerminalSuccessAt: new Date().toISOString(),
        gateway: {
          operational: false,
          device: { fresh: false, freshestLastSeenAt: null, ageSeconds: null },
        },
      });

      try {
        await expect(
          service.requestCommand(
            TRACKER_ID,
            EngineAction.CUT,
            null,
            superAdmin,
            'SCHEDULER',
          ),
        ).rejects.toThrow('téléphone Android/SIM indisponible');
        expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
        expect(errorLogger.record).toHaveBeenCalledWith(
          expect.stringContaining('téléphone Android/SIM indisponible'),
          'engine-control-interlock',
          expect.objectContaining({ cause: 'interlock', trackerId: TRACKER_ID, plate: 'AB-123-CD' }),
          'CRITICAL',
        );
      } finally {
        if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = previousNodeEnv;
        if (previousFlag === undefined)
          delete process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
        else process.env['ENGINE_AUTOMATIC_CUT_ENABLED'] = previousFlag;
      }
    });

    /**
     * ── T49 (contre-expertise du 13/09, P2-2) — une ligne par cause, espacée ────────────────────
     * Avant : un CRITICAL par appel refusé ; 30 véhicules × palier 2/5/15/30 min = des dizaines de
     * lignes par nuit et un courriel par heure, pour un état que le propriétaire a choisi.
     */
    describe('T49 — kill-switch et interlock sans rafale', () => {
      let previousNodeEnv: string | undefined;
      let previousFlag: string | undefined;
      beforeEach(() => {
        previousNodeEnv = process.env['NODE_ENV'];
        previousFlag = process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
        process.env['NODE_ENV'] = 'production';
        prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      });
      afterEach(() => {
        jest.restoreAllMocks();
        if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = previousNodeEnv;
        if (previousFlag === undefined) delete process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
        else process.env['ENGINE_AUTOMATIC_CUT_ENABLED'] = previousFlag;
      });
      const refus = () =>
        service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER').catch((e) => e);

      it('🔴 kill-switch : trente refus en une heure = UNE ligne, puis une ligne qui les compte et nomme les véhicules', async () => {
        delete process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
        const t0 = 1_800_000_000_000;
        const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
        for (let i = 0; i < 30; i++) {
          prisma.tracker.findFirst.mockResolvedValueOnce({ ...trackerWithVehicle, vehicle: { ...trackerWithVehicle.vehicle, plate: `VH-${String(i).padStart(3, '0')}` } });
          now.mockReturnValue(t0 + i * 2 * 60_000); // un refus toutes les 2 min pendant une heure
          await refus();
        }
        expect(errorLogger.record).toHaveBeenCalledTimes(1);
        // L'heure passée : une seconde ligne, qui porte les 29 refus muets et leurs plaques.
        now.mockReturnValue(t0 + 61 * 60_000);
        prisma.tracker.findFirst.mockResolvedValueOnce({ ...trackerWithVehicle, vehicle: { ...trackerWithVehicle.vehicle, plate: 'VH-030' } });
        await refus();
        expect(errorLogger.record).toHaveBeenCalledTimes(2);
        const [message, source, context, level] = errorLogger.record.mock.calls[1];
        expect(source).toBe('engine-control-interlock');
        expect(level).toBe('DEGRADATION');
        expect(context).toMatchObject({ cause: 'kill-switch', refusalsSinceLastLine: 30, spacingMin: 60 });
        expect(context.vehicles).toEqual(expect.arrayContaining(['VH-001', 'VH-029', 'VH-030']));
        expect(context.vehicles).not.toContain('VH-000'); // la première ligne l'avait déjà nommé
        expect(String(message)).toContain('30 refus');
        expect(String(message)).toContain('VH-030');
      });

      it('interlock : CRITICAL une fois par raison et par quart d heure — une raison nouvelle a sa propre ligne', async () => {
        process.env['ENGINE_AUTOMATIC_CUT_ENABLED'] = 'true';
        const sms = testModule.get(SmsGatewayService) as unknown as { currentProvider: jest.Mock; healthCheck: jest.Mock };
        sms.currentProvider.mockReturnValue('vizyo-texto');
        const sante = (operational: boolean, error?: string) => ({
          enabled: true, reachable: true, deliveryProofAvailable: true, pendingWithoutReceipt: 0, oldestPendingAt: null,
          lastTerminalSuccessAt: new Date().toISOString(), error,
          gateway: { operational, device: { fresh: operational } },
        });
        sms.healthCheck.mockResolvedValue(sante(false, 'téléphone périmé'));
        const t0 = 1_800_000_000_000;
        const now = jest.spyOn(Date, 'now').mockReturnValue(t0);

        await refus();
        now.mockReturnValue(t0 + 5 * 60_000);
        await refus(); // même raison, 5 min plus tard : muet
        now.mockReturnValue(t0 + 14 * 60_000);
        await refus(); // 14 min : encore muet
        expect(errorLogger.record).toHaveBeenCalledTimes(1);
        expect(errorLogger.record.mock.calls[0][3]).toBe('CRITICAL');

        now.mockReturnValue(t0 + 16 * 60_000);
        await refus(); // le quart d'heure est passé : une ligne, avec le compte
        expect(errorLogger.record).toHaveBeenCalledTimes(2);
        expect(errorLogger.record.mock.calls[1][2]).toMatchObject({ cause: 'interlock', refusalsSinceLastLine: 3, spacingMin: 15 });

        // Une raison DIFFÉRENTE (le cache de santé expire à 30 s : on le pousse au-delà) a sa propre ligne, tout de suite.
        sms.healthCheck.mockResolvedValue({ ...sante(true), deliveryProofAvailable: false });
        now.mockReturnValue(t0 + 17 * 60_000);
        const err = await refus();
        expect(err).toBeInstanceOf(AutomaticCutWithheldException);
        expect((err as AutomaticCutWithheldException).reason).toContain('aucune preuve de remise');
        expect(errorLogger.record).toHaveBeenCalledTimes(3);
        expect(errorLogger.record.mock.calls[2][2]).toMatchObject({ cause: 'interlock', refusalsSinceLastLine: 1 });
      });

      it('le refus est typé, avec sa cause et sa raison — le cron discrimine par TYPE, jamais par texte', async () => {
        delete process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
        const err = await refus();
        expect(err).toBeInstanceOf(AutomaticCutWithheldException);
        expect(err).toBeInstanceOf(ServiceUnavailableException); // le traitement « report » du cron reste vrai
        expect((err as AutomaticCutWithheldException).cause).toBe('kill-switch');
        expect((err as AutomaticCutWithheldException).reason).toContain('ENGINE_AUTOMATIC_CUT_ENABLED');
      });

      it('un centre d alerte en panne ne bloque ni ne casse le refus', async () => {
        delete process.env['ENGINE_AUTOMATIC_CUT_ENABLED'];
        errorLogger.record.mockRejectedValueOnce(new Error('centre indisponible'));
        await expect(
          service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER'),
        ).rejects.toBeInstanceOf(AutomaticCutWithheldException);
      });
    });

    it('renvoie la même intention après collision idempotente', async () => {
      const replay = createdCommand({
        action: EngineAction.RESTORE,
        status: CommandStatus.SENT,
        idempotencyKey: 'same-click',
      });
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.engineControlCommand.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(replay);
      prisma.engineControlCommand.create.mockRejectedValueOnce({ code: 'P2002' });

      const result = await service.requestCommand(
        TRACKER_ID,
        EngineAction.RESTORE,
        null,
        fleetAdmin,
        'MANUAL',
        false,
        false,
        'same-click',
      );

      expect(result.id).toBe(replay.id);
      expect(prisma.engineControlCommand.findFirst).toHaveBeenLastCalledWith({
        where: { idempotencyKey: 'same-click', trackerId: TRACKER_ID },
      });
      expect(registry.send).not.toHaveBeenCalled();
    });

    it("refuse de rejouer une même clé pour l'action opposée", async () => {
      const previousCut = createdCommand({ idempotencyKey: 'reused-click' });
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(previousCut);

      await expect(service.requestCommand(
        TRACKER_ID,
        EngineAction.RESTORE,
        null,
        fleetAdmin,
        'MANUAL',
        false,
        false,
        'reused-click',
      )).rejects.toThrow('autre action');

      expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
      expect(registry.send).not.toHaveBeenCalled();
    });

    it("refuse une collision idempotente appartenant à un autre boîtier", async () => {
      const foreign = createdCommand({
        trackerId: '00000000-0000-0000-0000-000000000099',
        action: EngineAction.RESTORE,
        idempotencyKey: 'foreign-click',
      });
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.engineControlCommand.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(foreign)
        .mockResolvedValueOnce(null);
      prisma.engineControlCommand.create.mockRejectedValueOnce({ code: 'P2002' });

      await expect(service.requestCommand(
        TRACKER_ID,
        EngineAction.RESTORE,
        null,
        fleetAdmin,
        'MANUAL',
        false,
        false,
        'foreign-click',
      )).rejects.toThrow(ConflictException);

      expect(prisma.engineControlCommand.findFirst).toHaveBeenNthCalledWith(2, {
        where: { idempotencyKey: 'foreign-click', trackerId: TRACKER_ID },
      });
      expect(prisma.engineControlCommand.findFirst).toHaveBeenNthCalledWith(3, {
        where: { activeKey: `${TRACKER_ID}:${EngineAction.RESTORE}`, trackerId: TRACKER_ID },
        orderBy: { createdAt: 'desc' },
      });
      expect(registry.send).not.toHaveBeenCalled();
    });

    /**
     * ══ P0-1 (contre-expertise du 13/09) — LA RESTORE DU LENDEMAIN NE DOIT JAMAIS ÊTRE AVALÉE ══
     *
     * Avant : une RESTORE partie par SMS, « remise » et jamais acquittée gardait `activeKey` pour
     * toujours ; la RESTORE suivante du boîtier (planning, clic) retombait sur elle et repartait
     * sans qu'un octet ne soit envoyé. Ces tests verrouillent le réarmement, et ses limites.
     */
    const restoreDHier = (overrides: Record<string, unknown> = {}) =>
      createdCommand({
        action: EngineAction.RESTORE,
        status: CommandStatus.SENT,
        channel: 'SMS',
        smsLogId: '00000000-0000-0000-0000-000000000077',
        attemptCount: 2,
        smsAttemptCount: 1,
        sentAt: new Date(Date.now() - 24 * 3600_000),
        lastAttemptAt: new Date(Date.now() - 24 * 3600_000),
        createdAt: new Date(Date.now() - 24 * 3600_000),
        nextAttemptAt: null, // parquée : le worker a lu « SMS remis » et s'est arrêté là
        dispatchLeaseUntil: null,
        activeKey: `${TRACKER_ID}:${EngineAction.RESTORE}`,
        alertedAt: new Date(Date.now() - 23 * 3600_000),
        ...overrides,
      });

    it('P0-1 : la RESTORE du lendemain RÉARME une RESTORE d hier parquée et repart TCP d abord', async () => {
      const stale = restoreDHier();
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.engineControlCommand.create.mockRejectedValueOnce({ code: 'P2002' });
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(stale); // relecture activeKey
      prisma.engineControlCommand.findUnique.mockResolvedValueOnce({
        ...stale,
        status: CommandStatus.PENDING,
        channel: null,
        smsLogId: null,
        smsAttemptCount: 0,
        sentAt: null,
      });
      registry.send.mockReturnValue(true); // la socket est revenue depuis hier

      const result = await service.requestCommand(
        TRACKER_ID,
        EngineAction.RESTORE,
        'Automatisation horaire : entrée dans la plage autorisée',
        superAdmin,
        'SCHEDULER',
      );

      // Réarmement conditionnel : jamais sous un ACK arrivé entre-temps.
      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith({
        where: { id: stale.id, status: CommandStatus.SENT, ackedAt: null },
        data: expect.objectContaining({
          status: CommandStatus.PENDING,
          channel: null,
          smsLogId: null,
          smsAttemptCount: 0,
          sentAt: null,
          nextAttemptAt: expect.any(Date),
          dispatchLeaseUntil: expect.any(Date),
        }),
      });
      // Et la commande repart dans la foulée : TCP en premier, aucun SMS payé d'office.
      expect(registry.send).toHaveBeenCalledTimes(1);
      const sms = testModule.get(SmsGatewayService) as unknown as { send: jest.Mock };
      expect(sms.send).not.toHaveBeenCalled();
      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: stale.id, ackedAt: null }),
          data: expect.objectContaining({ status: CommandStatus.SENT, channel: 'TCP' }),
        }),
      );
      expect(result.id).toBe(stale.id);
    });

    it('P0-1 : un clic manuel réarme aussi une RESTORE dont le prochain essai est lointain (backoff)', async () => {
      const enBackoff = restoreDHier({
        createdAt: new Date(Date.now() - 90_000),
        sentAt: new Date(Date.now() - 90_000),
        lastAttemptAt: new Date(Date.now() - 30_000),
        nextAttemptAt: new Date(Date.now() + 4 * 60_000),
      });
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.engineControlCommand.create.mockRejectedValueOnce({ code: 'P2002' });
      prisma.engineControlCommand.findFirst
        .mockResolvedValueOnce(null) // clé d'idempotence inconnue
        .mockResolvedValueOnce(null) // (collision) relecture par clé d'idempotence
        .mockResolvedValueOnce(enBackoff); // relecture activeKey
      prisma.engineControlCommand.findUnique.mockResolvedValueOnce({
        ...enBackoff,
        status: CommandStatus.PENDING,
        channel: null,
      });
      registry.send.mockReturnValue(false);

      await service.requestCommand(
        TRACKER_ID,
        EngineAction.RESTORE,
        null,
        fleetAdmin,
        'MANUAL',
        false,
        false,
        'clic-operateur',
      );

      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: enBackoff.id, status: CommandStatus.SENT, ackedAt: null },
        }),
      );
      // Socket absente : l'intention attend la reconnexion (PENDING, canal TCP), le worker
      // paiera le SMS ensuite — même politique que pour une intention neuve.
      expect(prisma.engineControlCommand.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: CommandStatus.PENDING,
            channel: 'TCP',
          }),
        }),
      );
    });

    it('P0-1 : un double clic ne réarme RIEN — une RESTORE en cours de traitement est rendue telle quelle', async () => {
      const enCours = restoreDHier({
        status: CommandStatus.SENT,
        channel: 'TCP',
        createdAt: new Date(Date.now() - 5_000),
        sentAt: new Date(Date.now() - 5_000),
        lastAttemptAt: new Date(Date.now() - 5_000),
        nextAttemptAt: new Date(Date.now() + 10_000), // attente d'ACK, dans la fenêtre du worker
      });
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.engineControlCommand.create.mockRejectedValueOnce({ code: 'P2002' });
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(enCours);

      const result = await service.requestCommand(
        TRACKER_ID,
        EngineAction.RESTORE,
        null,
        fleetAdmin,
        'MANUAL',
      );

      expect(result).toBe(enCours);
      // Le seul updateMany attendu est la supplantation des CUT en vol (chemin RESTORE nominal) :
      // aucun réarmement (retour en PENDING), aucun dispatch.
      const rearms = prisma.engineControlCommand.updateMany.mock.calls.filter(
        ([arg]) => arg?.data?.status === CommandStatus.PENDING,
      );
      expect(rearms).toHaveLength(0);
      expect(prisma.engineControlCommand.update).not.toHaveBeenCalled();
      expect(registry.send).not.toHaveBeenCalled();
    });

    it('P0-1 : si l ACK arrive entre la relecture et le réarmement, rien n est réécrit (updateMany conditionnel)', async () => {
      const stale = restoreDHier();
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.engineControlCommand.create.mockRejectedValueOnce({ code: 'P2002' });
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(stale);
      // La supplantation des CUT (premier updateMany) passe ; le réarmement, lui, ne trouve
      // plus la ligne en SENT/non acquittée : un ACK vient de la clore.
      prisma.engineControlCommand.updateMany.mockImplementation(({ data }) =>
        Promise.resolve({ count: data?.status === CommandStatus.PENDING ? 0 : 1 }),
      );

      const result = await service.requestCommand(
        TRACKER_ID,
        EngineAction.RESTORE,
        null,
        superAdmin,
        'SCHEDULER',
      );

      expect(result).toBe(stale);
      expect(registry.send).not.toHaveBeenCalled();
      expect(prisma.engineControlCommand.update).not.toHaveBeenCalled();
    });

    it('P0-1 : une CUT active n est jamais réarmée par ce chemin (périmètre RESTORE seulement)', async () => {
      const cutActive = createdCommand({
        action: EngineAction.CUT,
        status: CommandStatus.SENT,
        nextAttemptAt: null,
        activeKey: `${TRACKER_ID}:${EngineAction.CUT}`,
        createdAt: new Date(Date.now() - 24 * 3600_000),
      });
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.position.findFirst.mockResolvedValue(recentPosition(0));
      prisma.engineControlCommand.create.mockRejectedValueOnce({ code: 'P2002' });
      // 1) verrou « coupure en vol » (MANUAL) : rien ; 2) relecture activeKey
      prisma.engineControlCommand.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(cutActive);

      const result = await service.requestCommand(
        TRACKER_ID,
        EngineAction.CUT,
        null,
        fleetAdmin,
        'MANUAL',
      );

      expect(result).toBe(cutActive);
      expect(prisma.engineControlCommand.updateMany).not.toHaveBeenCalled();
    });

    /**
     * ══ T41 (contre-expertise du 13/09, P0-2) — validité des SMS CUT, priorité des RESTORE,
     * annulation du SMS d'une CUT supplantée ═══════════════════════════════════════════════
     */
    it('T41 : une CUT partie par SMS porte une validité (ttlSeconds), jamais de priorité', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      sms.send.mockResolvedValue({ ok: true, outcome: 'accepted', submittedStatus: 'queued', smsLogId: 'sms-cut' });
      prisma.tracker.findFirst.mockResolvedValue({ ...trackerWithVehicle, simPhoneNumber: '+33600000000' });
      prisma.position.findFirst.mockResolvedValue(recentPosition(0));
      registry.send.mockReturnValue(false);

      await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin);

      expect(sms.send).toHaveBeenCalledWith(
        '+33600000000',
        'stop123456',
        expect.objectContaining({ ttlSeconds: 900, priority: 'engine_cut' }),
      );
      expect(sms.send.mock.calls[0][2]).not.toHaveProperty('smsPriority');
    });

    it('T41 : une RESTORE partie par SMS porte la priorité maximale (100), jamais de validité', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      sms.send.mockResolvedValue({ ok: true, outcome: 'accepted', submittedStatus: 'queued', smsLogId: 'sms-restore' });
      prisma.tracker.findFirst.mockResolvedValue({ simPhoneNumber: '+33600000000' });
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([
          {
            ...createdCommand({
              action: EngineAction.RESTORE,
              status: CommandStatus.SENT,
              channel: 'TCP',
              attemptCount: 1,
              sentAt: new Date(Date.now() - 20_000),
              nextAttemptAt: new Date(Date.now() - 1_000),
              dispatchLeaseUntil: null,
            }),
            tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
          },
        ])
        .mockResolvedValueOnce([]);

      await service.processPendingRestores();

      expect(sms.send).toHaveBeenCalledWith(
        '+33600000000',
        'resume123456',
        expect.objectContaining({ smsPriority: 100, priority: 'critical_restore' }),
      );
      expect(sms.send.mock.calls[0][2]).not.toHaveProperty('ttlSeconds');
    });

    it('T41 : une RESTORE qui supplante une CUT partie par SMS demande l annulation de son SMS au relais', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { cancelOutbound: jest.Mock };
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      // Relecture des CUT visées avant leur clôture : une par SMS, une par TCP (rien à annuler).
      prisma.engineControlCommand.findMany.mockResolvedValueOnce([
        { id: 'cut-sms', smsLogId: 'sms-cut', channel: 'SMS' },
        { id: 'cut-tcp', smsLogId: null, channel: 'TCP' },
      ]);

      await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin, 'MANUAL');
      await new Promise((r) => setTimeout(r, 10)); // l'annulation est asynchrone et jamais bloquante

      expect(prisma.engineControlCommand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ action: EngineAction.CUT, activeKey: { not: null } }),
          select: { id: true, smsLogId: true, channel: true },
        }),
      );
      expect(sms.cancelOutbound).toHaveBeenCalledTimes(1);
      expect(sms.cancelOutbound).toHaveBeenCalledWith('sms-cut');
      // La commande supplantée dit que son SMS a été retiré avant émission.
      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith({
        where: { id: 'cut-sms', status: CommandStatus.SENT_UNCONFIRMED },
        data: { lastError: expect.stringContaining('SMS annulé au relais') },
      });
    });

    it('T41 : un refus d annulation (message déjà pris par le téléphone) ne bloque ni ne casse la RESTORE', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { cancelOutbound: jest.Mock };
      sms.cancelOutbound.mockResolvedValue({ ok: false, reason: 'statut sent : plus annulable' });
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.engineControlCommand.findMany.mockResolvedValueOnce([{ id: 'cut-sms', smsLogId: 'sms-cut', channel: 'SMS' }]);

      await expect(
        service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin, 'MANUAL'),
      ).resolves.toBeDefined();
      await new Promise((r) => setTimeout(r, 10));

      // L'intention RESTORE a bien été créée malgré le refus d'annulation.
      expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: EngineAction.RESTORE, status: CommandStatus.PENDING }),
      });
      expect(sms.cancelOutbound).toHaveBeenCalledWith('sms-cut');
      const relabel = prisma.engineControlCommand.updateMany.mock.calls.find(
        ([arg]) => arg?.where?.id === 'cut-sms' && arg?.where?.status === CommandStatus.SENT_UNCONFIRMED,
      );
      expect(relabel).toBeUndefined();
    });

    it('reprend un RESTORE TCP sans ACK par le fallback SMS', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as {
        isEnabled: jest.Mock;
        send: jest.Mock;
      };
      sms.isEnabled.mockReturnValue(true);
      sms.send.mockResolvedValue({
        ok: true,
        outcome: 'accepted',
        submittedStatus: 'queued',
        smsLogId: '00000000-0000-0000-0000-000000000099',
        twilioSid: 'cap-99',
      });
      prisma.tracker.findFirst.mockResolvedValue({ simPhoneNumber: '+33600000000' });
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([{
          ...createdCommand({
            action: EngineAction.RESTORE,
            status: CommandStatus.SENT,
            channel: 'TCP',
            attemptCount: 1,
            sentAt: new Date(Date.now() - 20_000),
            nextAttemptAt: new Date(Date.now() - 1_000),
            dispatchLeaseUntil: null,
          }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }])
        .mockResolvedValueOnce([]);

      await service.processPendingRestores();

      expect(sms.send).toHaveBeenCalledWith(
        '+33600000000',
        'resume123456',
        expect.objectContaining({ commandId: expect.any(String) }),
      );
      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ channel: 'SMS' }) }),
      );
    });

    /**
     * ── T48 (contre-expertise du 13/09, P2-1 · P2-4) — une preuve ne se rétrograde pas ─────────
     */
    it('🔴 T48 : un ACK TCP arrivé pendant l envoi du SMS n est PAS écrasé — la ligne reste acquittée et le SMS inutile est annulé', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock; cancelOutbound: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      prisma.tracker.findFirst.mockResolvedValue({ simPhoneNumber: '+33600000000' });
      prisma.engineControlCommand.findFirst.mockResolvedValue(null);
      // Pendant `send`, l'écho K arrive et un autre chemin acquitte la commande.
      const acquittee = createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.ACKNOWLEDGED, ackedAt: new Date(), activeKey: null });
      sms.send.mockImplementation(async () => {
        prisma.engineControlCommand.updateMany.mockResolvedValueOnce({ count: 0 }); // la garde `ackedAt IS NULL` ne tient plus
        prisma.engineControlCommand.findUnique.mockResolvedValue(acquittee);
        return { ok: true, outcome: 'accepted', submittedStatus: 'queued', smsLogId: 'sms-tardif' };
      });
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([{
          ...createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.SENT, channel: 'TCP', attemptCount: 1, sentAt: new Date(Date.now() - 20_000), nextAttemptAt: new Date(Date.now() - 1_000), dispatchLeaseUntil: null }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }])
        .mockResolvedValue([]);

      await service.processPendingRestores();
      await new Promise((r) => setTimeout(r, 10));

      // Aucune écriture aveugle : `update({ where: { id } })` n'est plus le chemin de « envoyée ».
      const aveugle = prisma.engineControlCommand.update.mock.calls.find(([arg]) => arg?.data?.status === CommandStatus.SENT);
      expect(aveugle).toBeUndefined();
      // Le SMS accepté pour rien est annulé au relais.
      expect(sms.cancelOutbound).toHaveBeenCalledWith('sms-tardif');
      // Et l'état émis au frontal est celui de la base : acquittée.
      expect(gateway.emitEngineCommandUpdate).toHaveBeenLastCalledWith(FLEET_ID, expect.objectContaining({ status: CommandStatus.ACKNOWLEDGED }));
    });

    it('T48 : une CUT PENDING orpheline (créée puis jamais transmise) est DISPATCHÉE à la collision, au lieu d être rendue telle quelle', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.position.findFirst.mockResolvedValue(recentPosition(0));
      registry.send.mockReturnValue(true);
      prisma.engineControlCommand.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
      const orpheline = createdCommand({
        action: EngineAction.CUT, status: CommandStatus.PENDING, activeKey: `${TRACKER_ID}:CUT`,
        createdAt: new Date(Date.now() - 5 * 60_000), dispatchLeaseUntil: null, ackedAt: null,
      });
      // Le verrou « coupure en vol » est borné à 90 s : un orphelin de 5 min lui est invisible
      // (1er findFirst), c'est la contrainte d'unicité qui le révèle (2e findFirst).
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(null).mockResolvedValue(orpheline);

      const result = await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'MANUAL');

      expect(registry.send).toHaveBeenCalledWith(trackerWithVehicle.imei, expect.stringContaining(',J;'));
      expect(result.id).toBe(orpheline.id);
      expect(result.status).toBe(CommandStatus.SENT);
    });

    it('T48 : une CUT PENDING d il y a une seconde n est PAS un orphelin — c est un clic concurrent, rendu tel quel', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.position.findFirst.mockResolvedValue(recentPosition(0));
      registry.send.mockReturnValue(true);
      prisma.engineControlCommand.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
      const concurrente = createdCommand({ action: EngineAction.CUT, status: CommandStatus.PENDING, activeKey: `${TRACKER_ID}:CUT`, createdAt: new Date(Date.now() - 1_000) });
      prisma.engineControlCommand.findFirst.mockResolvedValue(concurrente);
      prisma.position.findFirst.mockReset().mockResolvedValueOnce({ ...recentPosition(0), ignition: true }).mockResolvedValueOnce(null);

      // Source SCHEDULER : pas de verrou « coupure en vol » (il réévalue à chaque tick) → la collision d'unicité décide.
      const result = await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, superAdmin, 'SCHEDULER');

      expect(registry.send).not.toHaveBeenCalled();
      expect(result).toBe(concurrente);
    });

    it('T48 : une intention sous bail (le worker la traite) n est jamais prise pour un orphelin', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.position.findFirst.mockResolvedValue(recentPosition(0));
      registry.send.mockReturnValue(true);
      prisma.engineControlCommand.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
      const enCours = createdCommand({ action: EngineAction.CUT, status: CommandStatus.PENDING, activeKey: `${TRACKER_ID}:CUT`, createdAt: new Date(Date.now() - 5 * 60_000), dispatchLeaseUntil: new Date(Date.now() + 30_000) });
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(null).mockResolvedValue(enCours);

      const result = await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'MANUAL');

      expect(registry.send).not.toHaveBeenCalled();
      expect(result).toBe(enCours);
    });

    it('T48 : un second écho K ne réécrit pas ackedAt — l acquittement est conditionnel', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      registry.send.mockReturnValue(true);
      prisma.engineControlCommand.findUnique.mockResolvedValue(createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.SENT, activeKey: `${TRACKER_ID}:RESTORE` }));
      await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin, 'MANUAL');
      await new Promise((r) => setTimeout(r, 10));

      const ack = prisma.engineControlCommand.updateMany.mock.calls.find(([arg]) => arg?.data?.status === CommandStatus.ACKNOWLEDGED);
      expect(ack).toBeDefined();
      expect(ack![0].where).toEqual({ id: expect.any(String), ackedAt: null });
      const aveugle = prisma.engineControlCommand.update.mock.calls.find(([arg]) => arg?.data?.status === CommandStatus.ACKNOWLEDGED);
      expect(aveugle).toBeUndefined();
    });

    it('attend une reconnexion TCP avant de payer le secours SMS si la socket était absente', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as {
        isEnabled: jest.Mock;
        send: jest.Mock;
      };
      sms.isEnabled.mockReturnValue(true);
      sms.send.mockResolvedValue({
        ok: true,
        outcome: 'accepted',
        submittedStatus: 'queued',
        smsLogId: '00000000-0000-0000-0000-000000000098',
      });
      prisma.tracker.findFirst.mockResolvedValue({ simPhoneNumber: '+33600000000' });
      registry.send.mockReturnValue(false);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([{
          ...createdCommand({
            action: EngineAction.RESTORE,
            status: CommandStatus.PENDING,
            channel: 'TCP',
            attemptCount: 1,
            nextAttemptAt: new Date(Date.now() - 1_000),
            dispatchLeaseUntil: null,
          }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }])
        .mockResolvedValueOnce([]);

      await service.processPendingRestores();

      expect(registry.send).toHaveBeenCalled();
      expect(sms.send).toHaveBeenCalledWith(
        '+33600000000',
        'resume123456',
        expect.objectContaining({ priority: 'critical_restore' }),
      );
    });

    it('T42 : le 3e SMS en échec terminal rend visible l épuisement — sans jamais fermer l intention (relance TCP, clé conservée)', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { reconcileOutboundStatus: jest.Mock };
      sms.reconcileOutboundStatus.mockResolvedValue({ outcome: 'failed', status: 'failed' });
      prisma.engineControlCommand.findFirst.mockResolvedValue(null); // aucune CUT plus récente
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([{
          ...createdCommand({
            action: EngineAction.RESTORE,
            status: CommandStatus.SENT,
            channel: 'SMS',
            smsLogId: '00000000-0000-0000-0000-000000000099',
            attemptCount: 3,
            smsAttemptCount: 3,
            nextAttemptAt: new Date(Date.now() - 1_000),
            dispatchLeaseUntil: null,
          }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }])
        .mockResolvedValueOnce([]);

      const avant = Date.now();
      await service.processPendingRestores();

      const terminal = prisma.engineControlCommand.update.mock.calls.find(([arg]) => arg?.data?.status === CommandStatus.FAILED);
      expect(terminal).toBeUndefined();
      const kept = prisma.engineControlCommand.update.mock.calls.find(([arg]) => arg?.data?.smsLogId === null);
      expect(kept).toBeDefined();
      expect(kept![0].data).toMatchObject({ status: CommandStatus.SENT, dispatchLeaseUntil: null });
      expect(kept![0].data).not.toHaveProperty('activeKey'); // la clé reste posée : l'intention vit
      const relanceMin = ((kept![0].data.nextAttemptAt as Date).getTime() - avant) / 60000;
      expect(relanceMin).toBeGreaterThanOrEqual(29);
      expect(relanceMin).toBeLessThanOrEqual(31);
      expect(kept![0].data.lastError).toContain('secours SMS épuisé');
      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.stringContaining('secours SMS épuisé'),
        'engine-control-restore',
        expect.objectContaining({ commandId: expect.any(String), smsAttemptCount: 3 }),
        'CRITICAL',
      );
    });

    it('émet une sentinelle CRITICAL unique pour un RESTORE en retard', async () => {
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          ...createdCommand({
            action: EngineAction.RESTORE,
            status: CommandStatus.SENT,
            channel: 'SMS',
            attemptCount: 2,
            alertedAt: null,
            createdAt: new Date(Date.now() - 120_000),
          }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }]);

      await service.processPendingRestores();

      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.stringContaining('RESTORE non confirmé'),
        'engine-control-restore',
        expect.objectContaining({ plate: 'AB-123-CD', attemptCount: 2 }),
        'CRITICAL',
      );
      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { alertedAt: expect.any(Date) } }),
      );
    });

    it('réarme la sentinelle si le centre d alertes ne persiste pas le signal', async () => {
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          ...createdCommand({
            action: EngineAction.RESTORE,
            status: CommandStatus.SENT,
            alertedAt: null,
            createdAt: new Date(Date.now() - 120_000),
          }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }]);
      errorLogger.record.mockRejectedValueOnce(new Error('centre indisponible'));

      await expect(service.processPendingRestores()).resolves.toBeUndefined();

      expect(prisma.engineControlCommand.updateMany).toHaveBeenLastCalledWith({
        where: { id: expect.any(String), alertedAt: expect.any(Date) },
        data: { alertedAt: null },
      });
    });

    it('remonte aussi un RESTORE terminal FAILED resté sans alerte persistée', async () => {
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          ...createdCommand({
            action: EngineAction.RESTORE,
            status: CommandStatus.FAILED,
            alertedAt: null,
            createdAt: new Date(Date.now() - 120_000),
            lastError: '3 SMS refusés',
          }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }]);

      await service.processPendingRestores();

      expect(errorLogger.record).toHaveBeenCalledWith(
        'RESTORE en échec terminal — intervention humaine obligatoire',
        'engine-control-restore',
        expect.objectContaining({ lastError: '3 SMS refusés', actionRequired: expect.any(String) }),
        'CRITICAL',
      );
      const sentinelQuery = prisma.engineControlCommand.findMany.mock.calls[1][0].where;
      expect(sentinelQuery.status.in).toContain(CommandStatus.FAILED);
    });

    // ── T42 (contre-expertise du 13/09, P1-1) — relance à la reconnexion, jamais terminale ──
    const dueRestore = (overrides: Record<string, unknown>) => ({
      ...createdCommand({
        action: EngineAction.RESTORE,
        status: CommandStatus.SENT,
        nextAttemptAt: new Date(Date.now() - 1_000),
        dispatchLeaseUntil: null,
        ...overrides,
      }),
      tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
    });
    const connected = { imei: trackerWithVehicle.imei, remoteAddress: '10.0.0.7:4242', replaced: true, at: new Date().toISOString() };
    const flush = () => new Promise((r) => setTimeout(r, 15));

    it('T42 : à la reconnexion, la dernière RESTORE parquée après SMS repart PENDING, TCP d abord, sans budget SMS neuf', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      const parquee = createdCommand({
        action: EngineAction.RESTORE,
        status: CommandStatus.SENT,
        channel: 'SMS',
        smsLogId: 'sms-1',
        smsAttemptCount: 1,
        attemptCount: 2,
        sentAt: new Date(Date.now() - 3 * 3600_000),
        createdAt: new Date(Date.now() - 3 * 3600_000),
        nextAttemptAt: null,
        dispatchLeaseUntil: null,
        activeKey: `${TRACKER_ID}:RESTORE`,
      });
      prisma.engineControlCommand.findFirst
        .mockResolvedValueOnce(parquee) // la dernière RESTORE du boîtier
        .mockResolvedValue(null); // aucune CUT demandée depuis (ici et dans le worker)
      // Le worker relit l'intention réarmée et la dispatche sur la socket toute neuve.
      registry.send.mockReturnValue(true);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([dueRestore({ status: CommandStatus.PENDING, channel: null, smsLogId: null, smsAttemptCount: 1, attemptCount: 2 })])
        .mockResolvedValue([]);

      await service.onTrackerConnected(connected);
      await flush();

      // Périmètre : RESTORE, jamais une observation boîtier, créée depuis moins de 24 h.
      const candidate = prisma.engineControlCommand.findFirst.mock.calls[0][0];
      expect(candidate.where).toMatchObject({
        tracker: { imei: trackerWithVehicle.imei },
        action: EngineAction.RESTORE,
        source: { not: 'DEVICE_OBSERVED' },
      });
      expect(Date.now() - (candidate.where.createdAt.gte as Date).getTime()).toBeGreaterThanOrEqual(24 * 3600_000 - 5_000);
      expect(candidate.orderBy).toEqual({ createdAt: 'desc' });
      // La garde « aucune CUT depuis » porte la date de la RESTORE.
      expect(prisma.engineControlCommand.findFirst.mock.calls[1][0].where).toMatchObject({
        action: EngineAction.CUT,
        status: { not: CommandStatus.REJECTED_SPEED },
        createdAt: { gt: parquee.createdAt },
      });
      // Réarmement conditionnel : PENDING, canal et SMS effacés, clé reposée, budget SMS INTACT.
      const rearm = prisma.engineControlCommand.updateMany.mock.calls.find(([arg]) => arg?.data?.status === CommandStatus.PENDING);
      expect(rearm).toBeDefined();
      expect(rearm![0].where).toEqual({
        id: parquee.id,
        ackedAt: null,
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT, CommandStatus.FAILED, CommandStatus.SENT_UNCONFIRMED] },
      });
      expect(rearm![0].data).toMatchObject({
        channel: null,
        smsLogId: null,
        expiredAt: null,
        activeKey: `${TRACKER_ID}:RESTORE`,
        dispatchLeaseUntil: null,
        nextAttemptAt: expect.any(Date),
      });
      expect(rearm![0].data).not.toHaveProperty('smsAttemptCount');
      expect(rearm![0].data).not.toHaveProperty('sentAt');
      // Et K est partie en TCP tout de suite — pas un SMS.
      expect(registry.send).toHaveBeenCalledWith(trackerWithVehicle.imei, expect.stringContaining('**,imei:123456789012345,K;'));
      expect(sms.send).not.toHaveBeenCalled();
    });

    it('T42 : une RESTORE FAILED d hier matin (3 SMS refusés) est RAVIVÉE à la reconnexion — K en TCP, et plus jamais un SMS', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      const failed = createdCommand({
        action: EngineAction.RESTORE,
        status: CommandStatus.FAILED,
        channel: 'SMS',
        smsLogId: null,
        smsAttemptCount: 3,
        attemptCount: 4,
        sentAt: null,
        createdAt: new Date(Date.now() - 40 * 60_000),
        nextAttemptAt: null,
        activeKey: null,
      });
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(failed).mockResolvedValue(null);
      registry.send.mockReturnValue(true);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([dueRestore({ status: CommandStatus.PENDING, channel: null, smsLogId: null, smsAttemptCount: 3, attemptCount: 4, sentAt: null })])
        .mockResolvedValue([]);

      await service.onTrackerConnected(connected);
      await flush();

      const rearm = prisma.engineControlCommand.updateMany.mock.calls.find(([arg]) => arg?.data?.status === CommandStatus.PENDING);
      expect(rearm![0].data.activeKey).toBe(`${TRACKER_ID}:RESTORE`);
      expect(registry.send).toHaveBeenCalledWith(trackerWithVehicle.imei, expect.stringContaining(',K;'));
      expect(sms.send).not.toHaveBeenCalled();
      // La relance TCP seule pose sentAt à la PREMIÈRE transmission et programme le créneau suivant.
      const tcp = prisma.engineControlCommand.update.mock.calls.find(([arg]) => arg?.data?.channel === 'TCP');
      expect(tcp![0].data).toMatchObject({ status: CommandStatus.SENT, sentAt: expect.any(Date) });
      // L'ACK (mock immédiat) acquitte par updateMany CONDITIONNEL, jamais par update aveugle.
      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith({
        where: { id: expect.any(String), status: CommandStatus.SENT, ackedAt: null },
        data: expect.objectContaining({ status: CommandStatus.ACKNOWLEDGED, activeKey: null, ackedAt: expect.any(Date) }),
      });
    });

    it('T42 : une COUPURE demandée après la RESTORE — la reconnexion ne rallume rien', async () => {
      prisma.engineControlCommand.findFirst
        .mockResolvedValueOnce(createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.SENT, createdAt: new Date(Date.now() - 3600_000) }))
        .mockResolvedValueOnce({ id: 'cut-du-soir' });

      await service.onTrackerConnected(connected);
      await flush();

      expect(prisma.engineControlCommand.updateMany).not.toHaveBeenCalled();
      expect(registry.send).not.toHaveBeenCalled();
    });

    it('T42 : rien à relancer — acquittée, sous lease, ou aucune RESTORE de moins de 24 h', async () => {
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(
        createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.ACKNOWLEDGED, ackedAt: new Date() }),
      );
      await service.onTrackerConnected(connected);
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(
        createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.PENDING, dispatchLeaseUntil: new Date(Date.now() + 30_000) }),
      );
      await service.onTrackerConnected(connected);
      prisma.engineControlCommand.findFirst.mockResolvedValueOnce(null);
      await service.onTrackerConnected(connected);
      await flush();

      expect(prisma.engineControlCommand.findFirst).toHaveBeenCalledTimes(3);
      expect(prisma.engineControlCommand.updateMany).not.toHaveBeenCalled();
    });

    it('T42 : une autre RESTORE porte déjà la clé (course avec une demande neuve) → la vieille n est pas ravivée, sans lever', async () => {
      prisma.engineControlCommand.findFirst
        .mockResolvedValueOnce(createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.SENT_UNCONFIRMED, activeKey: null, createdAt: new Date(Date.now() - 3600_000) }))
        .mockResolvedValueOnce(null);
      prisma.engineControlCommand.updateMany.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));

      await expect(service.onTrackerConnected(connected)).resolves.toBeUndefined();
      await flush();

      expect(prisma.engineControlCommand.findMany).not.toHaveBeenCalled(); // pas de relance du worker
    });

    it('🔴 T42 : l abonné à la reconnexion ne lève JAMAIS — une panne ici casserait le login de tous les boîtiers', async () => {
      prisma.engineControlCommand.findFirst.mockRejectedValueOnce(new Error('base indisponible'));
      await expect(service.onTrackerConnected(connected)).resolves.toBeUndefined();
      await expect(service.onTrackerConnected({ imei: '' } as never)).resolves.toBeUndefined();
    });

    it('T42 : budget SMS épuisé + boîtier en ligne → K renvoyée en TCP seule, jamais un 4e SMS, créneau à +30 min', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      prisma.engineControlCommand.findFirst.mockResolvedValue(null);
      registry.send.mockReturnValue(true);
      const premiereTransmission = new Date(Date.now() - 50 * 60_000);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([dueRestore({ channel: 'SMS', smsLogId: null, smsAttemptCount: 3, attemptCount: 3, sentAt: premiereTransmission })])
        .mockResolvedValue([]);

      const avant = Date.now();
      await service.processPendingRestores();
      await flush();

      expect(sms.send).not.toHaveBeenCalled();
      expect(registry.send).toHaveBeenCalledWith(trackerWithVehicle.imei, expect.stringContaining(',K;'));
      const tcp = prisma.engineControlCommand.update.mock.calls.find(([arg]) => arg?.data?.channel === 'TCP');
      expect(tcp).toBeDefined();
      expect(tcp![0].data).toMatchObject({ status: CommandStatus.SENT, sentAt: premiereTransmission, dispatchLeaseUntil: null });
      const relanceMin = ((tcp![0].data.nextAttemptAt as Date).getTime() - avant) / 60000;
      expect(relanceMin).toBeGreaterThanOrEqual(29);
      expect(relanceMin).toBeLessThanOrEqual(31);
      expect(tcp![0].data).not.toHaveProperty('activeKey');
    });

    it('T42 : budget SMS épuisé + boîtier hors ligne → juste un prochain créneau, aucun SMS, aucune tentative inscrite', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      prisma.engineControlCommand.findFirst.mockResolvedValue(null);
      registry.send.mockReturnValue(false);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([dueRestore({ channel: 'SMS', smsLogId: null, smsAttemptCount: 3, attemptCount: 3 })])
        .mockResolvedValue([]);

      await service.processPendingRestores();

      expect(sms.send).not.toHaveBeenCalled();
      expect(prisma.engineControlCommand.update).toHaveBeenCalledTimes(1);
      expect(prisma.engineControlCommand.update.mock.calls[0][0].data).toMatchObject({
        status: CommandStatus.SENT,
        nextAttemptAt: expect.any(Date),
        dispatchLeaseUntil: null,
        lastError: expect.stringContaining('hors ligne'),
      });
      expect(prisma.engineControlCommand.update.mock.calls[0][0].data).not.toHaveProperty('channel');
    });

    it('T42 : un 3e SMS en file (smsLogId présent) n est PAS « épuisé » : on réconcilie, on ne renvoie pas K', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { reconcileOutboundStatus: jest.Mock };
      sms.reconcileOutboundStatus.mockResolvedValue({ outcome: 'accepted', status: 'queued' });
      prisma.engineControlCommand.findFirst.mockResolvedValue(null);
      registry.send.mockReturnValue(true);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([dueRestore({ channel: 'SMS', smsLogId: 'sms-3', smsAttemptCount: 3, attemptCount: 3 })])
        .mockResolvedValue([]);

      await service.processPendingRestores();

      expect(sms.reconcileOutboundStatus).toHaveBeenCalledWith('sms-3');
      expect(registry.send).not.toHaveBeenCalled();
    });

    it('🔴 T42 : une RESTORE ne transmet JAMAIS après une COUPURE plus récente — le worker la clôt sans envoi', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      prisma.engineControlCommand.findFirst.mockResolvedValue({ id: 'cut-du-soir' });
      registry.send.mockReturnValue(true);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([dueRestore({ status: CommandStatus.PENDING, channel: null, smsAttemptCount: 0 })])
        .mockResolvedValue([]);

      await service.processPendingRestores();

      expect(registry.send).not.toHaveBeenCalled();
      expect(sms.send).not.toHaveBeenCalled();
      expect(prisma.engineControlCommand.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: expect.objectContaining({
          status: CommandStatus.SENT_UNCONFIRMED,
          activeKey: null,
          nextAttemptAt: null,
          lastError: expect.stringContaining('supplantée par une intention CUT'),
        }),
      });
    });

    it('T42 : une COUPURE créée supplante les RESTORE encore ouvertes du boîtier (symétrique de RESTORE → CUT)', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.position.findFirst.mockResolvedValue(recentPosition(0));
      prisma.engineControlCommand.findFirst.mockResolvedValue(null);
      registry.send.mockReturnValue(true);

      await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'MANUAL');

      const supplante = prisma.engineControlCommand.updateMany.mock.calls.find(
        ([arg]) => arg?.where?.action === EngineAction.RESTORE && arg?.data?.status === CommandStatus.SENT_UNCONFIRMED,
      );
      expect(supplante).toBeDefined();
      expect(supplante![0].where).toMatchObject({
        trackerId: TRACKER_ID,
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
        ackedAt: null,
        activeKey: { not: null },
        id: { not: expect.any(String) },
      });
      expect(supplante![0].data).toMatchObject({ activeKey: null, nextAttemptAt: null, lastError: expect.stringContaining('CUT plus récente') });
    });

    it('T42 : une COUPURE refusée (vitesse) ne supplante rien — le véhicule n est pas coupé', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.position.findFirst.mockResolvedValue(recentPosition(60));

      await expect(service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'MANUAL')).rejects.toBeInstanceOf(ForbiddenException);

      const supplante = prisma.engineControlCommand.updateMany.mock.calls.find(([arg]) => arg?.where?.action === EngineAction.RESTORE);
      expect(supplante).toBeUndefined();
    });

    it('T42 : le 3e refus de soumission SMS laisse l intention SENT avec sa clé, créneau TCP à +30 min, CRITICAL « épuisé »', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      sms.send.mockResolvedValue({ ok: false, error: 'passerelle injoignable' });
      prisma.tracker.findFirst.mockResolvedValue({ simPhoneNumber: '+33600000000' });
      prisma.engineControlCommand.findFirst.mockResolvedValue(null);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([dueRestore({ channel: 'SMS', smsLogId: null, smsAttemptCount: 2, attemptCount: 3 })])
        .mockResolvedValue([]);

      const avant = Date.now();
      await service.processPendingRestores();

      expect(sms.send).toHaveBeenCalledTimes(1); // le 3e et dernier essai
      const echec = prisma.engineControlCommand.update.mock.calls.find(([arg]) => arg?.data?.smsAttemptCount === 3);
      expect(echec).toBeDefined();
      expect(echec![0].data).toMatchObject({ status: CommandStatus.SENT, channel: 'SMS', smsLogId: null, alertedAt: null });
      expect(echec![0].data).not.toHaveProperty('activeKey');
      const relanceMin = ((echec![0].data.nextAttemptAt as Date).getTime() - avant) / 60000;
      expect(relanceMin).toBeGreaterThanOrEqual(29);
      expect(relanceMin).toBeLessThanOrEqual(31);
      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.stringContaining('secours SMS épuisé'),
        'engine-control-restore',
        expect.objectContaining({ reason: 'passerelle injoignable' }),
        'CRITICAL',
      );
      const terminal = prisma.engineControlCommand.update.mock.calls.find(([arg]) => arg?.data?.status === CommandStatus.FAILED);
      expect(terminal).toBeUndefined();
    });

    // ── T51 (contre-expertise du 13/09, P2-5 · P2-6) — une RESTORE qui traîne se rappelle ─────
    it('T51 : la sentinelle RAPPELLE une RESTORE non prouvée toutes les 15 min — plus une ligne puis le silence', async () => {
      const dejaAlertee = new Date(Date.now() - 16 * 60_000);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          ...createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.SENT, channel: 'SMS', attemptCount: 2, alertedAt: dejaAlertee, createdAt: new Date(Date.now() - 2 * 3600_000) }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }]);

      await service.processPendingRestores();

      const sentinelWhere = prisma.engineControlCommand.findMany.mock.calls[1][0].where;
      expect(sentinelWhere.OR).toEqual([{ alertedAt: null }, { alertedAt: { lt: expect.any(Date) } }]);
      expect(Date.now() - (sentinelWhere.OR[1].alertedAt.lt as Date).getTime()).toBeGreaterThanOrEqual(15 * 60_000 - 1_000);
      // Comparaison-et-échange sur la valeur lue : deux instances ne rappellent pas deux fois.
      expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith({
        where: { id: expect.any(String), alertedAt: dejaAlertee, ackedAt: null },
        data: { alertedAt: expect.any(Date) },
      });
      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.stringContaining('toujours non confirmée depuis 120 min'),
        'engine-control-restore',
        expect.objectContaining({ reminder: true, plate: 'AB-123-CD' }),
        'CRITICAL',
      );
    });

    it('T51 : un SMS en file depuis plus d une heure est annulé au relais et retenté', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { reconcileOutboundStatus: jest.Mock; cancelOutbound: jest.Mock };
      sms.reconcileOutboundStatus.mockResolvedValue({ outcome: 'accepted', status: 'queued' });
      prisma.engineControlCommand.findFirst.mockResolvedValue(null);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([{
          ...createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.SENT, channel: 'SMS', smsLogId: 'sms-bloque', smsAttemptCount: 1, lastAttemptAt: new Date(Date.now() - 61 * 60_000), nextAttemptAt: new Date(Date.now() - 1_000), dispatchLeaseUntil: null }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }])
        .mockResolvedValue([]);

      await service.processPendingRestores();

      expect(sms.cancelOutbound).toHaveBeenCalledWith('sms-bloque');
      expect(prisma.engineControlCommand.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: expect.objectContaining({ smsLogId: null, nextAttemptAt: expect.any(Date), lastError: expect.stringContaining('annulé au relais') }),
      });
    });

    it('T51 : un SMS en file depuis 30 min est simplement repollé — pas encore bloqué', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { reconcileOutboundStatus: jest.Mock; cancelOutbound: jest.Mock };
      sms.reconcileOutboundStatus.mockResolvedValue({ outcome: 'accepted', status: 'queued' });
      prisma.engineControlCommand.findFirst.mockResolvedValue(null);
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([{
          ...createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.SENT, channel: 'SMS', smsLogId: 'sms-recent', smsAttemptCount: 1, lastAttemptAt: new Date(Date.now() - 30 * 60_000), nextAttemptAt: new Date(Date.now() - 1_000), dispatchLeaseUntil: null }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }])
        .mockResolvedValue([]);

      await service.processPendingRestores();

      expect(sms.cancelOutbound).not.toHaveBeenCalled();
      expect(prisma.engineControlCommand.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: { nextAttemptAt: expect.any(Date), dispatchLeaseUntil: null },
      });
    });

    it('🔴 T51 : un clic MANUEL n attend plus la file SMS — réponse dans le budget avec l intention persistée, l envoi finit derrière', async () => {
      const previous = process.env['ENGINE_MANUAL_RESPONSE_BUDGET_MS'];
      process.env['ENGINE_MANUAL_RESPONSE_BUDGET_MS'] = '1000';
      try {
        const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
        sms.isEnabled.mockReturnValue(true);
        // La file SMS est longue : l'envoi ne rend la main qu'après 2 s.
        sms.send.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, outcome: 'accepted', submittedStatus: 'queued', smsLogId: 'sms-lent' }), 2_000)));
        prisma.tracker.findFirst.mockResolvedValueOnce(trackerWithVehicle).mockResolvedValue({ simPhoneNumber: '+33600000000' });
        prisma.position.findFirst.mockResolvedValue(recentPosition(0));
        registry.send.mockReturnValue(false);

        const t0 = Date.now();
        const result = await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'MANUAL');
        expect(Date.now() - t0).toBeLessThan(1_800);
        expect(result.status).toBe(CommandStatus.PENDING); // l'intention, persistée, rendue avant la fin de l'envoi

        // … et l'envoi se termine en arrière-plan.
        await new Promise((r) => setTimeout(r, 1_500));
        expect(sms.send).toHaveBeenCalledTimes(1);
        expect(prisma.engineControlCommand.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: CommandStatus.SENT, channel: 'SMS', smsLogId: 'sms-lent' }) }),
        );
      } finally {
        if (previous === undefined) delete process.env['ENGINE_MANUAL_RESPONSE_BUDGET_MS'];
        else process.env['ENGINE_MANUAL_RESPONSE_BUDGET_MS'] = previous;
      }
    });

    it('ignore un tick concurrent pendant qu un worker RESTORE est encore actif', async () => {
      let release!: (rows: unknown[]) => void;
      const blocked = new Promise<unknown[]>((resolve) => { release = resolve; });
      prisma.engineControlCommand.findMany
        .mockReturnValueOnce(blocked)
        .mockResolvedValueOnce([]);

      const first = service.processPendingRestores();
      await Promise.resolve();
      await expect(service.processPendingRestores()).resolves.toBeUndefined();
      expect(prisma.engineControlCommand.findMany).toHaveBeenCalledTimes(1);

      release([]);
      await first;
      expect(prisma.engineControlCommand.findMany).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * ── T53 (contre-expertise du 13/09, P2-10) — le journal des tentatives, enfin exercé ────────
   * Voir `faussesTentatives` en tête de fichier : le CHECK et l'unicité de la migration sont
   * rejoués à chaque écriture, dans TOUTE la suite. Ces tests fixent en plus ce que le service
   * écrit réellement sur ses trois chemins (TCP acquitté, TCP absent, secours SMS).
   */
  describe('T53 — journal des tentatives exercé, contraintes de la migration rejouées', () => {
    it('la migration porte bien un CHECK sur channel et sur status (les listes sont lues dans le SQL, pas recopiées)', () => {
      expect(ATTEMPT_CHANNELS).toEqual(['TCP', 'SMS']);
      expect(ATTEMPT_STATUSES).toEqual(expect.arrayContaining(['QUEUED', 'UNAVAILABLE', 'WRITTEN', 'ACCEPTED', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED', 'TIMED_OUT']));
      expect(ATTEMPT_STATUSES).toHaveLength(8);
    });

    it('le faux délégué REFUSE un statut hors CHECK et un doublon (commandId, attemptNumber) — la suite peut donc échouer sur une dérive', async () => {
      const journal = prisma.engineDeliveryAttempt;
      await expect(journal.create({ data: { commandId: 'c1', attemptNumber: 1, channel: 'TCP', status: 'INVENTE' } }))
        .rejects.toThrow('engine_delivery_attempts_status_check');
      await expect(journal.create({ data: { commandId: 'c1', attemptNumber: 1, channel: 'FAX', status: 'QUEUED' } }))
        .rejects.toThrow('engine_delivery_attempts_channel_check');
      const { id } = await journal.create({ data: { commandId: 'c1', attemptNumber: 1, channel: 'SMS', status: 'QUEUED' } });
      await expect(journal.create({ data: { commandId: 'c1', attemptNumber: 1, channel: 'TCP', status: 'WRITTEN' } }))
        .rejects.toMatchObject({ code: 'P2002' });
      await expect(journal.updateMany({ where: { id }, data: { status: 'BIDON', finishedAt: new Date() } }))
        .rejects.toThrow('engine_delivery_attempts_status_check');
      await expect(journal.updateMany({ where: { id }, data: { status: 'ACCEPTED', finishedAt: new Date() } })).resolves.toEqual({ count: 1 });
    });

    it('garde anti-dérive : chaque statut littéral que le service passe à beginAttempt/finishAttempt figure dans le CHECK de la migration', () => {
      const source = readFileSync(join(__dirname, 'engine-control.service.ts'), 'utf8');
      const appels = [...source.matchAll(/(?:beginAttempt|finishAttempt)\(([^)]*)\)/g)].map((m) => m[1]!);
      expect(appels.length).toBeGreaterThanOrEqual(10);
      const statuts = new Set<string>();
      for (const args of appels) {
        for (const lit of args.matchAll(/'([A-Z][A-Z_]{3,})'/g)) {
          if (!ATTEMPT_CHANNELS.includes(lit[1]!)) statuts.add(lit[1]!);
        }
      }
      expect([...statuts].sort()).toEqual(['ACCEPTED', 'ACKNOWLEDGED', 'DELIVERED', 'FAILED', 'QUEUED', 'TIMED_OUT', 'UNAVAILABLE', 'WRITTEN']);
      for (const s of statuts) expect(ATTEMPT_STATUSES).toContain(s);
    });

    it('une CUT transmise en TCP et acquittée laisse UNE tentative n°1 TCP : WRITTEN puis ACKNOWLEDGED, avec l écho brut', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.position.findFirst.mockResolvedValue(recentPosition(0));
      registry.send.mockReturnValue(true);

      await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'MANUAL');
      await new Promise((r) => setTimeout(r, 10));

      const rows = prisma.engineDeliveryAttempt.rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ commandId: expect.any(String), attemptNumber: 1, channel: 'TCP', status: 'ACKNOWLEDGED', rawCode: 'ack-frame' });
      expect(rows[0]!.finishedAt).toBeInstanceOf(Date);
      // La création portait bien WRITTEN (l'écriture socket a réussi) avant l'acquittement.
      expect(prisma.engineDeliveryAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ channel: 'TCP', status: 'WRITTEN' }) }));
    });

    it('une RESTORE sans socket au premier dispatch journalise une tentative TCP UNAVAILABLE — un statut que la migration accepte', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      registry.send.mockReturnValue(false);

      const result = await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin, 'MANUAL');

      expect(result.status).toBe(CommandStatus.PENDING);
      expect(prisma.engineDeliveryAttempt.rows).toEqual([
        expect.objectContaining({ attemptNumber: 1, channel: 'TCP', status: 'UNAVAILABLE', errorMessage: 'Socket TCP absente au premier dispatch' }),
      ]);
      expect(prisma.engineDeliveryAttempt.rows[0]!.finishedAt).toBeInstanceOf(Date);
    });

    it('une CUT sans socket part en SMS : tentative n°1 SMS, QUEUED puis ACCEPTED, corrélée au smsLogId et au providerId', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      sms.send.mockResolvedValue({ ok: true, outcome: 'accepted', submittedStatus: 'queued', smsLogId: 'sms-42', twilioSid: 'prov-1' });
      prisma.tracker.findFirst.mockResolvedValue({ ...trackerWithVehicle, simPhoneNumber: '+33600000000' });
      prisma.position.findFirst.mockResolvedValue(recentPosition(0));
      registry.send.mockReturnValue(false);

      const result = await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin, 'MANUAL');

      expect(result.status).toBe(CommandStatus.SENT);
      expect(prisma.engineDeliveryAttempt.rows).toEqual([
        expect.objectContaining({ attemptNumber: 1, channel: 'SMS', status: 'ACCEPTED', smsLogId: 'sms-42', providerId: 'prov-1', rawCode: 'queued' }),
      ]);
    });

    it('la seconde tentative d une même intention porte le n°2 : la tentative TCP absente (n°1) et le secours SMS du worker ne collisionnent pas', async () => {
      const sms = testModule.get(SmsGatewayService) as unknown as { isEnabled: jest.Mock; send: jest.Mock };
      sms.isEnabled.mockReturnValue(true);
      sms.send.mockResolvedValue({ ok: true, outcome: 'accepted', submittedStatus: 'queued', smsLogId: 'sms-43' });
      prisma.tracker.findFirst.mockResolvedValue({ ...trackerWithVehicle, simPhoneNumber: '+33600000000' });
      registry.send.mockReturnValue(false);
      // Tentative n°1 : le clic manuel, socket absente.
      const attente = await service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin, 'MANUAL');
      expect(attente.attemptCount).toBe(1);
      // Tentative n°2 : le worker relit l'intention (attemptCount = 1) et passe au secours SMS.
      prisma.engineControlCommand.findMany
        .mockResolvedValueOnce([{
          ...createdCommand({ action: EngineAction.RESTORE, status: CommandStatus.PENDING, channel: 'TCP', attemptCount: 1, smsAttemptCount: 0, smsLogId: null, sentAt: null, lastAttemptAt: new Date(Date.now() - 20_000), nextAttemptAt: new Date(Date.now() - 1_000), dispatchLeaseUntil: null, createdAt: new Date(Date.now() - 20_000) }),
          tracker: { imei: trackerWithVehicle.imei, vehicle: trackerWithVehicle.vehicle },
        }])
        .mockResolvedValue([]);

      await service.processPendingRestores();

      const numeros = prisma.engineDeliveryAttempt.rows.map((r) => `${r.attemptNumber}:${r.channel}:${r.status}`);
      expect(numeros[0]).toBe('1:TCP:UNAVAILABLE');
      expect(numeros.length).toBeGreaterThanOrEqual(2);
      expect(new Set(prisma.engineDeliveryAttempt.rows.map((r) => r.attemptNumber)).size).toBe(prisma.engineDeliveryAttempt.rows.length);
    });
  });
});
