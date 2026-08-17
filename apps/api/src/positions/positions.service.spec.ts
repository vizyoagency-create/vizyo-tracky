import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import type { CobanPositionFrame } from '@vizyo/tracky-shared';
import { GeofencesService } from '../geofences/geofences.service';
import { GpsDeadZonesService } from '../gps-dead-zones/gps-dead-zones.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { PositionBroadcastBuffer } from '../realtime/position-broadcast-buffer.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TrackerFixModeService } from '../tracker-fix-mode/tracker-fix-mode.service';
import { TripsService } from '../trips/trips.service';
import { PositionSamplingService } from './position-sampling.service';
import { PositionsService } from './positions.service';

const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET = '00000000-0000-0000-0000-000000000099';
const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const VEHICLE_ID = '00000000-0000-0000-0000-000000000020';

const admin = { role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };
const otherAdmin = { role: UserRole.FLEET_ADMIN, fleetId: OTHER_FLEET };

const posRecord = (i: number) => ({
  id: `pos-${i}`,
  trackerId: TRACKER_ID,
  lat: 33.5,
  lng: -7.5,
  speedKmh: 10 * i,
  heading: 0,
  altitude: null,
  satellites: null,
  valid: true,
  timestamp: new Date(Date.now() - i * 1000),
  createdAt: new Date(),
});

describe('PositionsService.list', () => {
  let service: PositionsService;
  // V1.10 (Sprint 6) — vehicle.findFirst ajoute au mock car le service applique
  // le filtre tenant via where au lieu d'un check after-find. Le tracker continue
  // d'utiliser findUnique car la securite passe par la verification de
  // tracker.vehicle.fleetId apres lookup.
  let prisma: {
    vehicle: { findUnique: jest.Mock; findFirst: jest.Mock };
    tracker: { findUnique: jest.Mock; update: jest.Mock };
    position: { findMany: jest.Mock; create: jest.Mock; createMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      vehicle: { findUnique: jest.fn(), findFirst: jest.fn() },
      tracker: {
        findUnique: jest.fn().mockResolvedValue({
          id: TRACKER_ID,
          vehicle: { id: VEHICLE_ID, fleetId: FLEET_ID },
        }),
        update: jest.fn(),
      },
      position: {
        findMany: jest.fn().mockResolvedValue([posRecord(1), posRecord(2), posRecord(3)]),
        create: jest.fn(),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        PositionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeGateway, useValue: { broadcastPosition: jest.fn(), emitTrackerStatus: jest.fn(), emitVehicleMovement: jest.fn() } },
        { provide: GeofencesService, useValue: { checkViolations: jest.fn() } },
        { provide: TripsService, useValue: { processPosition: jest.fn() } },
        { provide: ErrorLogger, useValue: { record: jest.fn().mockResolvedValue('id'), recordBackground: jest.fn() } },
        { provide: PositionSamplingService, useValue: {
          classify: jest.fn().mockReturnValue({ state: 'MOVING', distanceM: null }),
          decide: jest.fn().mockReturnValue({ shouldInsert: true, decision: 'INSERTED', state: 'MOVING', reason: 'test', distanceM: null }),
          recordDecision: jest.fn().mockResolvedValue(undefined),
        } },
        { provide: PositionBroadcastBuffer, useValue: { enqueue: jest.fn().mockReturnValue(true) } },
        // V1.10 (Sprint 6) — PositionBatchBufferService injecte par PositionsService
        // pour batcher les INSERT. Mock minimal qui no-op enqueue.
        {
          provide: (await import('./position-batch-buffer.service')).PositionBatchBufferService,
          useValue: { enqueue: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: TrackerFixModeService, useValue: {
          desiredIntervalFor: jest.fn().mockReturnValue(30),
          reconcile: jest.fn().mockReturnValue({ nextCurrentFixIntervalS: 30, nextFailureCount: 0, nextFailing: false }),
          requestChange: jest.fn().mockResolvedValue(null),
        } },
        { provide: GpsDeadZonesService, useValue: { recordRecovery: jest.fn().mockResolvedValue(0) } },
      ],
    }).compile();

    service = module.get(PositionsService);
  });

  it('should list positions by trackerId', async () => {
    const result = await service.list(admin, { trackerId: TRACKER_ID });
    expect(result.items).toHaveLength(3);
    expect(prisma.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { trackerId: TRACKER_ID } }),
    );
  });

  it('should resolve trackerId from vehicleId', async () => {
    // V1.10 (Sprint 6) — vehicle.findFirst (filtre tenant integre au where).
    prisma.vehicle.findFirst.mockResolvedValue({
      id: VEHICLE_ID,
      fleetId: FLEET_ID,
      tracker: { id: TRACKER_ID },
    });
    const result = await service.list(admin, { vehicleId: VEHICLE_ID });
    expect(result.items).toHaveLength(3);
  });

  it('should reject cross-fleet access', async () => {
    // V1.10 (Sprint 6) — le service rejette le tracker d'une autre flotte
    // avec NotFoundException (cf. tracker.vehicle.fleetId check apres findUnique).
    await expect(service.list(otherAdmin, { trackerId: TRACKER_ID }))
      .rejects.toThrow(NotFoundException);
  });

  it('should throw BadRequest when no trackerId or vehicleId', async () => {
    await expect(service.list(admin, {}))
      .rejects.toThrow(BadRequestException);
  });

  it('should apply time filters', async () => {
    const from = '2026-01-01T00:00:00Z';
    const to = '2026-12-31T23:59:59Z';
    await service.list(admin, { trackerId: TRACKER_ID, from, to });
    expect(prisma.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          timestamp: { gte: new Date(from), lte: new Date(to) },
        }),
      }),
    );
  });
});

// V1.17 (gps-sanity ingestion) — garde-fou anti-replay / anti-teleportation.
// Reproduit le flux fantome observe en prod (HD-779-MA) : une trame rejouee
// depuis le buffer du boitier (deviceTime anterieur + grand saut) ne doit JAMAIS
// etre persistee ni alimenter les trips, et ne doit pas empoisonner la baseline
// ni l'ignition du tracker.
describe('PositionsService.ingest — garde-fou replay/teleportation', () => {
  let service: PositionsService;
  let prisma: any;
  let batchBuffer: { enqueue: jest.Mock };
  let broadcastBuffer: { enqueue: jest.Mock };
  let trips: { processPosition: jest.Mock };
  let sampling: { classify: jest.Mock; decide: jest.Mock; recordDecision: jest.Mock };
  let gateway: {
    broadcastPosition: jest.Mock;
    emitTrackerStatus: jest.Mock;
    emitEngineCommandUpdate: jest.Mock;
    emitVehicleMovement: jest.Mock;
  };
  let deadZones: { recordRecovery: jest.Mock };
  let trackerRow: Record<string, unknown>;

  const IMEI = '359339074500001';
  // Derniere verite connue du tracker : 01:00:00 a (33.5, -7.5), moteur ON.
  const LAST_SEEN = new Date('2026-06-11T01:00:00Z');

  const makeTracker = (overrides: Record<string, unknown> = {}) => ({
    id: TRACKER_ID,
    imei: IMEI,
    accConnected: true,
    status: 'ONLINE',
    lastKnownIgnition: true,
    lastIgnition: true,
    lastIgnitionChangeAt: LAST_SEEN,
    lastLat: 33.5,
    lastLng: -7.5,
    lastSpeedKmh: 40,
    lastHeading: 90,
    lastValid: true,
    lastSeenAt: LAST_SEEN,
    lastPositionAt: LAST_SEEN,
    lastValidFrameAt: LAST_SEEN,
    lastWriteAt: LAST_SEEN,
    lastSampledState: 'MOVING',
    // FK portee par la ligne tracker elle-meme — c'est celle que lit le raccroc
    // « retour du signal » (TRK-028), pas `vehicle.id` de la relation incluse.
    vehicleId: VEHICLE_ID,
    verboseUntil: null,
    desiredFixIntervalS: 30,
    currentFixIntervalS: 30,
    fixCommandFailing: false,
    fixCommandFailureCount: 0,
    vehicle: {
      id: VEHICLE_ID,
      fleetId: FLEET_ID,
      plate: 'HD-779-MA',
      fleet: { adaptiveSamplingEnabled: true },
    },
    ...overrides,
  });

  const makeFrame = (overrides: Partial<CobanPositionFrame> = {}): CobanPositionFrame => ({
    type: 'position',
    imei: IMEI,
    alarm: 'none',
    // Par defaut : trame REELLE, 30s apres la derniere verite, ~555m plus loin.
    deviceTime: new Date('2026-06-11T01:00:30Z'),
    valid: true,
    latitude: 33.505,
    longitude: -7.5,
    speedKph: 50,
    course: 90,
    altitude: 100,
    ignition: true,
    raw: 'imei:359339074500001,...',
    ...overrides,
  });

  beforeEach(async () => {
    trackerRow = makeTracker();
    prisma = {
      tracker: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(trackerRow)),
        update: jest.fn().mockResolvedValue({}),
      },
      trackerCommand: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      engineControlCommand: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'cmd', action: 'CUT', status: 'ACKNOWLEDGED' }),
        update: jest.fn().mockResolvedValue({
          id: 'cut-1', action: 'CUT', status: 'ACKNOWLEDGED',
          confirmationExpected: true, sentAt: new Date(), ackedAt: new Date(), source: 'MANUAL',
        }),
      },
      positionSamplingDecision: { create: jest.fn().mockResolvedValue({}) },
    };
    batchBuffer = { enqueue: jest.fn() };
    broadcastBuffer = { enqueue: jest.fn().mockReturnValue(true) };
    trips = { processPosition: jest.fn().mockResolvedValue(undefined) };
    sampling = {
      classify: jest.fn().mockReturnValue({ state: 'MOVING', distanceM: 555 }),
      decide: jest.fn().mockReturnValue({
        shouldInsert: true,
        decision: 'INSERTED',
        state: 'MOVING',
        reason: 'mouvement actif',
        distanceM: 555,
      }),
      recordDecision: jest.fn().mockResolvedValue(undefined),
    };
    gateway = {
      broadcastPosition: jest.fn(),
      emitTrackerStatus: jest.fn(),
      emitEngineCommandUpdate: jest.fn(),
      emitVehicleMovement: jest.fn(),
    };
    deadZones = { recordRecovery: jest.fn().mockResolvedValue(0) };

    const module = await Test.createTestingModule({
      providers: [
        PositionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeGateway, useValue: gateway },
        { provide: GeofencesService, useValue: { checkViolations: jest.fn().mockResolvedValue(undefined) } },
        { provide: TripsService, useValue: trips },
        { provide: ErrorLogger, useValue: { record: jest.fn().mockResolvedValue('id'), recordBackground: jest.fn() } },
        { provide: PositionSamplingService, useValue: sampling },
        { provide: PositionBroadcastBuffer, useValue: broadcastBuffer },
        {
          provide: (await import('./position-batch-buffer.service')).PositionBatchBufferService,
          useValue: batchBuffer,
        },
        {
          provide: TrackerFixModeService,
          useValue: {
            desiredIntervalFor: jest.fn().mockReturnValue(30),
            reconcile: jest.fn().mockReturnValue({
              nextCurrentFixIntervalS: 30,
              nextFailureCount: 0,
              nextFailing: false,
              autoAlignDesiredS: null,
            }),
            requestChange: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: GpsDeadZonesService, useValue: deadZones },
      ],
    }).compile();

    service = module.get(PositionsService);
  });

  it('persists an authoritative forward frame (enqueue + trip)', async () => {
    await service.ingest(makeFrame());
    expect(sampling.decide).toHaveBeenCalledTimes(1);
    expect(batchBuffer.enqueue).toHaveBeenCalledTimes(1);
    expect(trips.processPosition).toHaveBeenCalledTimes(1);
  });

  it('mode vie privée (manuel) : JETTE la trame à l\'ingestion — AUCUNE écriture en base (pas un simple masquage)', async () => {
    // RGPD : véhicule en mode privé manuel → la position ne doit JAMAIS être persistée.
    trackerRow = makeTracker({
      status: 'ONLINE',
      vehicle: {
        id: VEHICLE_ID, fleetId: FLEET_ID, plate: 'HD-779-MA',
        fleet: { adaptiveSamplingEnabled: true },
        mixedUseEnabled: true, privacyModeEnabled: true,
      },
    });

    await service.ingest(makeFrame());

    // Non collectée : ni buffer d'écriture, ni trajet, ni sampler, ni broadcast.
    expect(batchBuffer.enqueue).not.toHaveBeenCalled();
    expect(trips.processPosition).not.toHaveBeenCalled();
    expect(sampling.decide).not.toHaveBeenCalled();
    expect(gateway.broadcastPosition).not.toHaveBeenCalled();
    // Liveness UNIQUEMENT (le boîtier communique) — pas de dénorm position.
    expect(prisma.tracker.update).toHaveBeenCalledTimes(1);
    expect(prisma.tracker.update).toHaveBeenCalledWith({
      where: { id: TRACKER_ID },
      data: { lastSeenAt: expect.any(Date), status: 'ONLINE' },
    });
  });

  it('cadre temps de travail : HORS plage (tous les jours fermés) → trame JETÉE (non collectée)', async () => {
    // Cadre actif dont AUCUN jour n'est ouvert → toujours hors-travail → privé automatique,
    // quelle que soit l'heure du test (déterministe). RGPD : le hors-travail n'est jamais écrit.
    trackerRow = makeTracker({
      status: 'ONLINE',
      vehicle: {
        id: VEHICLE_ID, fleetId: FLEET_ID, plate: 'HD-779-MA',
        fleet: { adaptiveSamplingEnabled: true },
        mixedUseEnabled: true, privacyModeEnabled: false,
        workOverrideUntil: null,
        workSchedule: {
          enabled: true, timezone: 'Europe/Paris', countryCode: 'FR', customDates: null,
          mondayEnabled: false, tuesdayEnabled: false, wednesdayEnabled: false, thursdayEnabled: false,
          fridayEnabled: false, saturdayEnabled: false, sundayEnabled: false,
        },
      },
    });

    await service.ingest(makeFrame());

    expect(batchBuffer.enqueue).not.toHaveBeenCalled();
    expect(trips.processPosition).not.toHaveBeenCalled();
    expect(sampling.decide).not.toHaveBeenCalled();
  });

  it('cadre temps de travail : DANS la plage (tous les jours ouverts, sans restriction) → trame collectée', async () => {
    // Cadre actif, tous jours ouverts sans plage → IN_WINDOW en permanence → tracé normalement.
    trackerRow = makeTracker({
      vehicle: {
        id: VEHICLE_ID, fleetId: FLEET_ID, plate: 'HD-779-MA',
        fleet: { adaptiveSamplingEnabled: true },
        mixedUseEnabled: true, privacyModeEnabled: false,
        workOverrideUntil: null,
        workSchedule: {
          enabled: true, timezone: 'Europe/Paris', countryCode: '', customDates: null,
          mondayEnabled: true, tuesdayEnabled: true, wednesdayEnabled: true, thursdayEnabled: true,
          fridayEnabled: true, saturdayEnabled: true, sundayEnabled: true,
          mondaySlots: null, tuesdaySlots: null, wednesdaySlots: null, thursdaySlots: null,
          fridaySlots: null, saturdaySlots: null, sundaySlots: null,
          mondayStart: null, mondayEnd: null,
        },
      },
    });

    await service.ingest(makeFrame());

    expect(batchBuffer.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does NOT persist a replayed frame (deviceTime anterieur + grand saut)', async () => {
    const replay = makeFrame({
      deviceTime: new Date('2026-06-11T00:59:30Z'), // 30s AVANT la derniere verite
      latitude: 33.45,
      longitude: -7.4, // ~10 km
      speedKph: 0,
      ignition: false,
    });

    await service.ingest(replay);

    // Rien n'est persiste, et le sampler n'est meme pas consulte (rejet en amont).
    expect(batchBuffer.enqueue).not.toHaveBeenCalled();
    expect(trips.processPosition).not.toHaveBeenCalled();
    expect(sampling.decide).not.toHaveBeenCalled();
    // Pas de broadcast de la position fantome.
    expect(gateway.broadcastPosition).not.toHaveBeenCalled();
    // Liveness UNIQUEMENT : pas de denorm position (lastLat/lastLng/lastPositionAt...).
    expect(prisma.tracker.update).toHaveBeenCalledTimes(1);
    expect(prisma.tracker.update).toHaveBeenCalledWith({
      where: { id: TRACKER_ID },
      data: { lastSeenAt: expect.any(Date), status: 'ONLINE' },
    });
    // Audit visible dans position_sampling_decisions.
    expect(sampling.recordDecision).toHaveBeenCalledWith(
      TRACKER_ID,
      expect.objectContaining({ decision: 'SKIPPED_REPLAY', shouldInsert: false }),
      0,
      false,
    );
  });

  it('does NOT persist a forward-time teleport (saut infaisable au dt reel)', async () => {
    const teleport = makeFrame({
      deviceTime: new Date('2026-06-11T01:00:30Z'), // 30s APRES (deviceTime en avant)
      latitude: 33.59,
      longitude: -7.5, // ~10 km en 30s = ~1200 km/h
      speedKph: 0,
    });

    await service.ingest(teleport);

    expect(batchBuffer.enqueue).not.toHaveBeenCalled();
    expect(sampling.decide).not.toHaveBeenCalled();
    expect(sampling.recordDecision).toHaveBeenCalledWith(
      TRACKER_ID,
      expect.objectContaining({ decision: 'SKIPPED_REPLAY' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does NOT touch ignition from a replayed frame (no false external CUT)', async () => {
    // Moteur reellement ON ; le fantome annonce ignition=false. Sans le garde-fou
    // ca declencherait handleIgnitionTransition -> faux CUT DEVICE_OBSERVED.
    const replay = makeFrame({
      deviceTime: new Date('2026-06-11T00:59:30Z'),
      latitude: 33.45,
      longitude: -7.4,
      speedKph: 0,
      ignition: false,
    });

    await service.ingest(replay);

    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
    const updateArg = prisma.tracker.update.mock.calls[0][0];
    expect(updateArg.data).not.toHaveProperty('lastKnownIgnition');
    expect(updateArg.data).not.toHaveProperty('lastLat');
  });

  // Sprint 2 (Obj 2) — CONFIRMATION PAR IGNITION : une coupure app SENT passe
  // ACKNOWLEDGED quand l'ignition tombe apres elle (preuve physique reelle).
  it('confirms an app CUT (SENT -> ACKNOWLEDGED) when ignition drops after it', async () => {
    prisma.engineControlCommand.findFirst.mockResolvedValue({
      id: 'cut-1',
      action: 'CUT',
      status: 'SENT',
      confirmationExpected: true,
      sentAt: new Date(),
      ackedAt: null,
      source: 'MANUAL',
    });

    // Trame REELLE (forward) avec ignition OFF => transition ON->OFF.
    await service.ingest(makeFrame({ ignition: false }));
    // handleIgnitionTransition est fire-and-forget : on laisse la chaine se resoudre.
    await new Promise((r) => setTimeout(r, 20));

    expect(prisma.engineControlCommand.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cut-1' },
        data: expect.objectContaining({ status: 'ACKNOWLEDGED' }),
      }),
    );
    // Pas de DEVICE_OBSERVED cree (la coupure app explique deja la chute d'ignition).
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
    expect(gateway.emitEngineCommandUpdate).toHaveBeenCalled();
  });

  // « super carré » — un simple stationnement (contact ON->OFF) SANS coupure app
  // ne doit RIEN créer ni modifier : on a supprimé la fausse commande « coupure
  // externe » DEVICE_OBSERVED qui faisait apparaître tout véhicule garé « coupé »
  // (bouton « Rallumer » à tort, veilleurs comme tous les autres roles).
  it('does NOT synthesize a CUT when ignition drops without an app cut (normal park)', async () => {
    prisma.engineControlCommand.findFirst.mockResolvedValue(null); // aucune coupure app recente
    await service.ingest(makeFrame({ ignition: false }));           // transition ON -> OFF
    await new Promise((r) => setTimeout(r, 20));
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
    expect(prisma.engineControlCommand.update).not.toHaveBeenCalled();
  });

  // Redémarrage (contact OFF->ON) : aucune commande synthétique « rallumage / reset
  // relais ». L'état coupé est piloté UNIQUEMENT par les commandes app.
  it('does NOT synthesize a RESTORE when ignition comes back on (restart)', async () => {
    trackerRow = makeTracker({ lastKnownIgnition: false, lastIgnition: false });
    await service.ingest(makeFrame({ ignition: true }));            // transition OFF -> ON
    await new Promise((r) => setTimeout(r, 20));
    expect(prisma.engineControlCommand.create).not.toHaveBeenCalled();
    expect(prisma.engineControlCommand.update).not.toHaveBeenCalled();
  });

  // Fix veilleur — transition « en mouvement » émise au veilleur (booléen, aucune position).
  it('émet VEHICLE_MOVEMENT moving=true quand un véhicule à l\'arrêt se met à rouler', async () => {
    trackerRow = makeTracker({ lastKnownIgnition: true, lastIgnition: true, lastSpeedKmh: 0 });
    await service.ingest(makeFrame({ ignition: true, speedKph: 50 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(gateway.emitVehicleMovement).toHaveBeenCalledWith(
      FLEET_ID,
      expect.objectContaining({ trackerId: TRACKER_ID, moving: true }),
    );
  });

  it('émet VEHICLE_MOVEMENT moving=false quand un véhicule qui roulait s\'arrête (contact coupé)', async () => {
    trackerRow = makeTracker({ lastKnownIgnition: true, lastIgnition: true, lastSpeedKmh: 40 });
    await service.ingest(makeFrame({ ignition: false, alarm: 'acc_off' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(gateway.emitVehicleMovement).toHaveBeenCalledWith(
      FLEET_ID,
      expect.objectContaining({ trackerId: TRACKER_ID, moving: false }),
    );
  });

  it('n\'émet PAS VEHICLE_MOVEMENT quand l\'état de mouvement ne change pas (roule → roule)', async () => {
    trackerRow = makeTracker({ lastKnownIgnition: true, lastIgnition: true, lastSpeedKmh: 40 });
    await service.ingest(makeFrame({ ignition: true, speedKph: 50 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(gateway.emitVehicleMovement).not.toHaveBeenCalled();
  });

  it('accepts the first ever valid frame when the tracker has no baseline', async () => {
    trackerRow = makeTracker({
      lastLat: null,
      lastLng: null,
      lastValidFrameAt: null,
      lastPositionAt: null,
      lastWriteAt: null,
      lastSampledState: null,
    });

    await service.ingest(makeFrame());

    expect(batchBuffer.enqueue).toHaveBeenCalledTimes(1);
  });

  it('accepts a large-gap catch-up frame (post-GPRS, plausible average speed)', async () => {
    // Derniere verite il y a 1h, ~60 km plus loin = 60 km/h moyen : LEGITIME.
    // Le dt PLEIN tolere la distance — aucune position reelle perdue.
    const catchUp = makeFrame({
      deviceTime: new Date('2026-06-11T02:00:00Z'),
      latitude: 34.04,
      longitude: -7.5,
      speedKph: 60,
    });

    await service.ingest(catchUp);

    expect(batchBuffer.enqueue).toHaveBeenCalledTimes(1);
  });

  it('updates liveness on an out-of-bounds / Null Island fix without persisting it', async () => {
    // Sprint 0.1 — boitier qui COMMUNIQUE mais sans fix valide (Null Island 0,0,
    // demarrage a froid). Avant : aucune liveness -> tracker "jamais vu" a tort
    // et compte OFFLINE. Desormais lastSeenAt + ONLINE, sans denorm ni broadcast.
    trackerRow = makeTracker({ status: 'OFFLINE' });
    const invalid = makeFrame({ latitude: 0, longitude: 0, valid: true });

    await service.ingest(invalid);

    expect(prisma.tracker.update).toHaveBeenCalledTimes(1);
    expect(prisma.tracker.update).toHaveBeenCalledWith({
      where: { id: TRACKER_ID },
      data: { lastSeenAt: expect.any(Date), status: 'ONLINE' },
    });
    // Aucune persistance ni broadcast d'une position invalide.
    expect(batchBuffer.enqueue).not.toHaveBeenCalled();
    expect(trips.processPosition).not.toHaveBeenCalled();
    expect(sampling.decide).not.toHaveBeenCalled();
    expect(gateway.broadcastPosition).not.toHaveBeenCalled();
    // Le tracker etait OFFLINE -> on annonce le passage online.
    expect(gateway.emitTrackerStatus).toHaveBeenCalledWith(
      FLEET_ID,
      expect.objectContaining({ trackerId: TRACKER_ID, status: 'online' }),
    );
  });

  /**
   * ── TRK-028 : LE RETOUR DU SIGNAL SE NOTE A L'INGESTION ────────────────────────────
   *
   * Le cron d'integrite ouvre l'episode mais ne peut pas le refermer : il tourne toutes
   * les 5 minutes SUR LES BOITIERS SANS FIX, donc un vehicule ressorti du parking a deja
   * quitte sa liste. L'instant du retour n'existe qu'ici, dans la premiere trame valide.
   *
   * Les deux tests ci-dessous verrouillent la condition de declenchement, parce qu'elle
   * porte tout le cout : sans le filtre de silence, c'est un updateMany par trame et par
   * vehicule sur la route la plus chaude du systeme.
   */
  it('une trame ordinaire ne coute AUCUNE requete de fermeture', async () => {
    // 30 s de silence : aucun episode n'a pu etre ouvert (seuil = 2 h).
    await service.ingest(makeFrame());
    expect(deadZones.recordRecovery).not.toHaveBeenCalled();
  });

  it('apres un long silence, la premiere trame valide referme l\'episode a son instant reel', async () => {
    // Le vehicule ressort du parking a 04:00 apres 3 h sans fix : au-dela du seuil,
    // un episode a pu etre ouvert, on tente donc la fermeture.
    const sortie = makeFrame({ deviceTime: new Date('2026-06-11T04:00:00Z') });

    await service.ingest(sortie);

    expect(deadZones.recordRecovery).toHaveBeenCalledTimes(1);
    // ⚠️ `frame.deviceTime`, PAS `new Date()` : l'heure du boitier est l'instant du
    // retour ; l'heure serveur y ajouterait la latence de la file d'ingestion.
    expect(deadZones.recordRecovery).toHaveBeenCalledWith({
      vehicleId: VEHICLE_ID,
      at: sortie.deviceTime,
    });
  });

  it('un echec de fermeture ne casse pas l\'ingestion — la position est persistee quand meme', async () => {
    // La fermeture est un enrichissement. Si elle echoue, la trame doit vivre :
    // perdre une position pour une statistique serait un mauvais echange.
    deadZones.recordRecovery.mockRejectedValue(new Error('base injoignable'));

    await service.ingest(makeFrame({ deviceTime: new Date('2026-06-11T04:00:00Z') }));

    expect(batchBuffer.enqueue).toHaveBeenCalledTimes(1);
  });
});
