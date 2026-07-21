import { PrismaClient } from '@prisma/client';
import type { CobanPositionFrame } from '@vizyo/tracky-shared';
import { PositionBatchBufferService } from '../../src/positions/position-batch-buffer.service';
import { PositionsService } from '../../src/positions/positions.service';

/**
 * LOT 2 / incrément 3 — PREUVE RÉELLE que le calendrier de temps de travail pilote l'INGESTION.
 *
 * Chaîne testée de bout en bout, contre une VRAIE base Postgres : trame Coban → `PositionsService.
 * ingest()` → `PositionBatchBufferService` (le VRAI, pas un mock) → `flush()` → table `positions`.
 * On compte les lignes AVANT et APRÈS. « Absente », pas « masquée ».
 *
 *   TEST_DATABASE_URL="postgresql://…/xxx_test" pnpm --filter @vizyo/tracky-api test:integration
 *
 * Ne tourne QUE si `TEST_DATABASE_URL` est défini, et REFUSE toute base dont le nom ne finit pas
 * par `_test` (protection anti-production, identique au lot 1).
 *
 * Horloge : seul `Date` est simulé (`doNotFake` laisse les timers réels) — sinon les E/S Prisma
 * se bloqueraient. On peut ainsi se placer un vrai samedi et un vrai lundi 10h.
 */
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const RUN = !!TEST_DB_URL;

/** 25/07/2026 = SAMEDI, 14:00 Paris (UTC+2 en été) — hors plage de travail. */
const SAMEDI_14H = new Date('2026-07-25T12:00:00Z');
/** 27/07/2026 = LUNDI, 10:00 Paris — en plein temps de travail. */
const LUNDI_10H = new Date('2026-07-27T08:00:00Z');
/**
 * 01/08/2026 = SAMEDI SUIVANT. Les scénarios qui suivent le lundi doivent être POSTÉRIEURS à lui :
 * le service écarte les trames dont le `deviceTime` est antérieur au dernier fix connu
 * (garde-fou anti-rejeu / anti-téléportation, positions.service.ts). Rejouer le samedi précédent
 * ferait passer le test pour la mauvaise raison.
 */
const SAMEDI_SUIVANT_14H = new Date('2026-08-01T12:00:00Z');
const SAMEDI_SUIVANT_18H = new Date('2026-08-01T16:00:00Z');

/**
 * Fige l'horloge à `d` en ne simulant QUE `Date` : les timers restent réels, sinon les E/S
 * Prisma (qui s'appuient dessus) se bloqueraient et le test tournerait dans le vide.
 */
function freezeAt(d: Date): void {
  jest.useFakeTimers({
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
      'nextTick', 'queueMicrotask', 'performance', 'hrtime',
    ],
  });
  jest.setSystemTime(d.getTime()); // ms : `d` date d'avant le gel, sinon ne le reconnaitrait pas
}

(RUN ? describe : describe.skip)('Mode vie privée — le calendrier pilote l’ingestion (base réelle)', () => {
  let prisma: PrismaClient;
  let service: PositionsService;
  let buffer: PositionBatchBufferService;
  const ids = { fleetId: '', vehicleId: '', trackerId: '', imei: '' };

  /** Trame Coban valide (le boîtier émet : personne n'est connecté, personne ne scanne). */
  const frame = (n: number): CobanPositionFrame => ({
    type: 'position',
    imei: ids.imei,
    alarm: 'none',
    deviceTime: new Date(Date.now() + n * 30_000),
    valid: true,
    latitude: 43.6047 + n * 0.0001,
    longitude: 1.4442 + n * 0.0001,
    speedKph: 42,
    course: 90,
    ignition: true,
    raw: `*HQ,${ids.imei},V1,test,${n}#`, // trame brute telle que recue du boitier
  });

  /** Nombre de lignes RÉELLEMENT présentes dans `positions` pour ce boîtier. */
  const countPositions = (): Promise<number> => prisma.position.count({ where: { trackerId: ids.trackerId } });

  /** Émet `n` trames puis vide le buffer (le vrai chemin d'écriture). */
  async function emit(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await service.ingest(frame(i));
    await buffer.flush();
  }

  beforeAll(async () => {
    const dbName = new URL(TEST_DB_URL as string).pathname.replace('/', '');
    if (!dbName.endsWith('_test')) {
      throw new Error(`REFUS : la base « ${dbName} » ne finit pas par _test (protection anti-production).`);
    }
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();

    const fleet = await prisma.fleet.create({ data: { name: 'Flotte test vie privée' } });
    // Véhicule EN USAGE MIXTE + cadre lun–ven 08:00–18:00, week-end fermé.
    const vehicle = await prisma.vehicle.create({
      data: {
        fleetId: fleet.id,
        plate: 'TEST-PRIV-01',
        mixedUseEnabled: true,
        workSchedule: {
          create: {
            enabled: true,
            timezone: 'Europe/Paris',
            mondayEnabled: true, mondayStart: '08:00', mondayEnd: '18:00',
            tuesdayEnabled: true, tuesdayStart: '08:00', tuesdayEnd: '18:00',
            wednesdayEnabled: true, wednesdayStart: '08:00', wednesdayEnd: '18:00',
            thursdayEnabled: true, thursdayStart: '08:00', thursdayEnd: '18:00',
            fridayEnabled: true, fridayStart: '08:00', fridayEnd: '18:00',
            saturdayEnabled: false,
            sundayEnabled: false,
          },
        },
      },
    });
    ids.imei = `TESTPRIV${Date.now()}`;
    const tracker = await prisma.tracker.create({ data: { imei: ids.imei, vehicleId: vehicle.id } });
    ids.fleetId = fleet.id;
    ids.vehicleId = vehicle.id;
    ids.trackerId = tracker.id;

    buffer = new PositionBatchBufferService(prisma as never);
    service = new PositionsService(
      prisma as never,
      { broadcastPosition: jest.fn(), emitTrackerStatus: jest.fn(), emitVehicleMovement: jest.fn(), emitEngineCommandUpdate: jest.fn() } as never,
      { checkViolations: jest.fn().mockResolvedValue(undefined) } as never,
      { processPosition: jest.fn().mockResolvedValue(undefined) } as never,
      { record: jest.fn().mockResolvedValue('id') } as never,
      {
        classify: jest.fn().mockReturnValue({ state: 'MOVING', distanceM: null }),
        decide: jest.fn().mockReturnValue({ shouldInsert: true, decision: 'INSERTED', state: 'MOVING', reason: 'test', distanceM: null }),
        recordDecision: jest.fn().mockResolvedValue(undefined),
      } as never,
      { enqueue: jest.fn().mockReturnValue(true) } as never, // broadcastBuffer (temps reel)
      {
        desiredIntervalFor: jest.fn().mockReturnValue(30),
        reconcile: jest.fn().mockReturnValue({ nextCurrentFixIntervalS: 30, nextFailureCount: 0, nextFailing: false }),
        requestChange: jest.fn().mockResolvedValue(undefined), // pilotage de la cadence du boitier
      } as never, // fixMode
      buffer, // batchBuffer : le VRAI service, ecrit dans la vraie base
    );
  });

  afterAll(async () => {
    if (!prisma) return;
    jest.useRealTimers();
    await prisma.fleet.deleteMany({ where: { id: ids.fleetId } }); // cascade : véhicule, boîtier, positions
    await prisma.$disconnect();
  });

  afterEach(() => jest.useRealTimers());

  it('SAMEDI (hors temps de travail) : le boîtier émet, AUCUNE position n’est écrite en base', async () => {
    freezeAt(SAMEDI_14H);

    const avant = await countPositions();
    await emit(5); // 5 trames émises un samedi après-midi, personne connecté, personne ne scanne
    const apres = await countPositions();

    // eslint-disable-next-line no-console
    console.log(`[SAMEDI] positions en base — avant: ${avant} · après 5 trames émises: ${apres}`);
    expect(apres).toBe(avant);
    expect(apres).toBe(0); // rien n'a jamais été écrit : absente, pas masquée

    // Le boîtier reste VIVANT (liveness) : on sait qu'il communique, sans savoir où il est.
    const tracker = await prisma.tracker.findUnique({ where: { id: ids.trackerId }, select: { status: true, lastSeenAt: true } });
    expect(tracker?.status).toBe('ONLINE');
    expect(tracker?.lastSeenAt).not.toBeNull();
  });

  it('LUNDI 10h (temps de travail) : le MÊME véhicule voit ses positions ÉCRITES en base', async () => {
    freezeAt(LUNDI_10H);

    const avant = await countPositions();
    await emit(5);
    const apres = await countPositions();

    // eslint-disable-next-line no-console
    console.log(`[LUNDI 10h] positions en base — avant: ${avant} · après 5 trames émises: ${apres}`);
    expect(apres).toBe(avant + 5);
  });

  it('SAMEDI suivant : le compteur ne bouge plus (le calendrier pilote dans les deux sens)', async () => {
    freezeAt(SAMEDI_SUIVANT_14H);

    const avant = await countPositions();
    await emit(5);
    const apres = await countPositions();

    // eslint-disable-next-line no-console
    console.log(`[SAMEDI bis] positions en base — avant: ${avant} · après 5 trames émises: ${apres}`);
    expect(apres).toBe(avant); // les 5 positions du lundi restent, aucune du samedi ne s'ajoute
  });

  it('véhicule NON mixte : le samedi, les positions SONT écrites (l’antivol reste actif)', async () => {
    // Même véhicule, usage mixte retiré → le cadre ne s'applique plus (proportionnalité).
    await prisma.vehicle.update({ where: { id: ids.vehicleId }, data: { mixedUseEnabled: false } });
    freezeAt(SAMEDI_SUIVANT_18H);

    const avant = await countPositions();
    await emit(3);
    const apres = await countPositions();

    // eslint-disable-next-line no-console
    console.log(`[SAMEDI · véhicule PRO] positions en base — avant: ${avant} · après 3 trames: ${apres}`);
    expect(apres).toBe(avant + 3);

    await prisma.vehicle.update({ where: { id: ids.vehicleId }, data: { mixedUseEnabled: true } });
  });
});
