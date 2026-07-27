import { FuelReportService } from './fuel-report.service';

/**
 * DORMANCE & FRAÎCHEUR DES PRIX dans le suivi carburant.
 *
 * Le cas réel : sur FV-941-LZ (boîtier muet depuis 89 jours), la fiche carburant affichait un
 * « dernier prix relevé » de 1,88 €/L exactement comme s'il datait de la veille, et rien ne disait
 * que le suivi s'était arrêté trois mois plus tôt.
 *
 * Deux règles distinctes, volontairement testées séparément :
 *  - le VÉHICULE est dormant (son boîtier s'est tu) → le rapport est un arrêt sur image ;
 *  - le PRIX est périmé (le relevé lui-même est vieux) → il ne peut pas être présenté comme courant.
 * Un véhicule bien vivant peut afficher un prix périmé (il n'a pas fait le plein depuis un mois), et
 * un véhicule fraîchement réveillé garde des prix vieux : les deux drapeaux ne se déduisent pas l'un
 * de l'autre.
 *
 * Dans tous les cas RIEN n'est retiré du rapport : passages, prix et coûts restent affichés.
 */

const H = 3600 * 1000;
const DAY = 24 * H;
const NOW = new Date('2026-07-27T12:00:00.000Z').getTime();
const FROM = new Date(NOW - 90 * DAY).toISOString();
const TO = new Date(NOW).toISOString();

const STATION_A = { id: 'st-a', brand: 'Total', name: 'Total Rangueil', city: 'Toulouse', address: '10 av. de la Station', lat: 43.61, lng: 1.44 };
const STATION_B = { id: 'st-b', brand: 'Esso', name: 'Esso Purpan', city: 'Toulouse', address: '2 rue Purpan', lat: 43.6, lng: 1.39 };

type Stop = { vehicleId?: string; arrivedAt: Date; durationSec: number; unitPriceEur: number | null; fuelType: string | null; station: typeof STATION_A };

function makeSvc(opts: { stops: Stop[]; tracker: { id: string; lastSeenAt: Date | null } | null }) {
  const prisma = {
    tripFuelStop: { findMany: jest.fn().mockResolvedValue(opts.stops) },
    trip: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { distanceKm: 420 } }),
      findMany: jest.fn().mockResolvedValue([{ id: 'tr1' }]),
    },
    tripAnalysis: { findMany: jest.fn().mockResolvedValue([{ tripId: 'tr1', fuelLiters: 45, distanceKm: 600 }]) },
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({ fleet: { fuelPriceEurL: 1.8 }, tracker: opts.tracker }),
      findMany: jest.fn().mockResolvedValue([{ id: 'v-dorm', plate: 'FV-941-LZ' }, { id: 'v-live', plate: 'AA-111-AA' }]),
    },
  };
  const access = {
    hasAccessToVehicle: jest.fn().mockResolvedValue(true),
    getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL'),
  };
  return { svc: new FuelReportService(prisma as never, access as never), prisma };
}

const USER = { id: 'u1', role: 'ADMIN' } as never;

/** Deux passages anciens : le véhicule a cessé de rouler il y a ~3 mois. */
const OLD_STOPS: Stop[] = [
  { vehicleId: 'v-dorm', arrivedAt: new Date(NOW - 89 * DAY), durationSec: 300, unitPriceEur: 1.75, fuelType: 'gazole', station: STATION_A },
  { vehicleId: 'v-dorm', arrivedAt: new Date(NOW - 80 * DAY), durationSec: 360, unitPriceEur: 1.88, fuelType: 'gazole', station: STATION_A },
];

/** Véhicule actif : un plein il y a 9 j (station B) puis un autre il y a 2 j (station A). */
const RECENT_STOPS: Stop[] = [
  { vehicleId: 'v-live', arrivedAt: new Date(NOW - 9 * DAY), durationSec: 300, unitPriceEur: 1.75, fuelType: 'gazole', station: STATION_B },
  { vehicleId: 'v-live', arrivedAt: new Date(NOW - 2 * DAY), durationSec: 360, unitPriceEur: 1.9, fuelType: 'gazole', station: STATION_A },
];

describe('FuelReportService.vehicleReport — dormance & péremption des prix', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  it('(a) véhicule dormant : rapport marqué « arrêt sur image », prix daté et marqué périmé — mais RIEN n\'est retiré', async () => {
    const { svc } = makeSvc({ stops: OLD_STOPS, tracker: { id: 'tk', lastSeenAt: new Date(NOW - 89 * DAY) } });
    const res = await svc.vehicleReport(USER, 'v-dorm', FROM, TO);

    expect(res.dormant).toBe(true);
    expect(res.silenceLabel).toBe('89 j');
    expect(res.trackerLastSeenAt).toBe(new Date(NOW - 89 * DAY).toISOString());

    // Le « dernier prix » n'est plus présenté comme courant…
    expect(res.priceLatestStale).toBe(true);
    expect(res.priceLatestAt).toBe(new Date(NOW - 80 * DAY).toISOString());
    expect(res.stations[0].lastPriceStale).toBe(true);
    expect(res.stations[0].lastPriceAt).toBe(new Date(NOW - 80 * DAY).toISOString());

    // …mais il reste LISIBLE, comme tout le reste de l'historique : on ne masque jamais un fait constaté.
    expect(res.priceLatest).toBe(1.88);
    expect(res.stations[0].lastPriceEur).toBe(1.88);
    expect(res.visits).toBe(2);
    expect(res.stations).toHaveLength(1);
    expect(res.priceTrend).toHaveLength(2);
    expect(res.estimatedLiters).toBe(45);
  });

  it('(b) véhicule silencieux 2 h avec un plein il y a 2 j : ni dormant, ni prix périmé', async () => {
    const { svc } = makeSvc({ stops: RECENT_STOPS, tracker: { id: 'tk', lastSeenAt: new Date(NOW - 2 * H) } });
    const res = await svc.vehicleReport(USER, 'v-live', FROM, TO);

    expect(res.dormant).toBe(false);
    expect(res.silenceLabel).toBeNull();
    expect(res.priceLatest).toBe(1.9);
    expect(res.priceLatestStale).toBe(false);

    // La station B n'a plus été ravitaillée depuis 9 j : SON prix, lui, est périmé.
    const stB = res.stations.find((s) => s.stationId === 'st-b');
    expect(stB?.lastPriceStale).toBe(true);
    const stA = res.stations.find((s) => s.stationId === 'st-a');
    expect(stA?.lastPriceStale).toBe(false);
  });

  it('(c) véhicule SANS boîtier, et boîtier n\'ayant jamais émis : jamais dormant', async () => {
    const sans = await makeSvc({ stops: RECENT_STOPS, tracker: null }).svc.vehicleReport(USER, 'v-test', FROM, TO);
    expect(sans.dormant).toBe(false);
    expect(sans.trackerLastSeenAt).toBeNull();
    expect(sans.silenceLabel).toBeNull();

    const jamais = await makeSvc({ stops: RECENT_STOPS, tracker: { id: 'tk', lastSeenAt: null } }).svc.vehicleReport(USER, 'v-new', FROM, TO);
    expect(jamais.dormant).toBe(false);
    expect(jamais.silenceLabel).toBeNull();
  });

  it('(d) réintégration : le boîtier ré-émet → plus dormant, sans que ses vieux prix redeviennent courants', async () => {
    const { svc } = makeSvc({ stops: OLD_STOPS, tracker: { id: 'tk', lastSeenAt: new Date(NOW - 5 * 60 * 1000) } });
    const res = await svc.vehicleReport(USER, 'v-dorm', FROM, TO);
    expect(res.dormant).toBe(false);
    expect(res.silenceLabel).toBeNull();
    // Les deux notions restent indépendantes : le relevé de 80 j n'est pas devenu le prix du jour.
    expect(res.priceLatestStale).toBe(true);
  });

  it('la dormance ne coûte AUCUNE requête : `tracker` est joint au findUnique véhicule existant', async () => {
    const { svc, prisma } = makeSvc({ stops: OLD_STOPS, tracker: { id: 'tk', lastSeenAt: new Date(NOW - 89 * DAY) } });
    await svc.vehicleReport(USER, 'v-dorm', FROM, TO);
    expect(prisma.vehicle.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.vehicle.findUnique.mock.calls[0][0].select.tracker).toEqual({ select: { id: true, lastSeenAt: true } });
  });

  it('aucun prix jamais capté → « inconnu », surtout pas « périmé »', async () => {
    const stops: Stop[] = [{ vehicleId: 'v-live', arrivedAt: new Date(NOW - 3 * DAY), durationSec: 300, unitPriceEur: null, fuelType: null, station: STATION_A }];
    const { svc } = makeSvc({ stops, tracker: { id: 'tk', lastSeenAt: new Date(NOW - H) } });
    const res = await svc.vehicleReport(USER, 'v-live', FROM, TO);
    expect(res.priceLatest).toBeNull();
    expect(res.priceLatestAt).toBeNull();
    expect(res.priceLatestStale).toBe(false);
    expect(res.stations[0].lastPriceStale).toBe(false);
  });

  it('période PASSÉE : un véhicule vivant à l\'époque n\'est pas marqué dormant a posteriori', async () => {
    const { svc } = makeSvc({ stops: OLD_STOPS, tracker: { id: 'tk', lastSeenAt: new Date(NOW - 20 * DAY) } });
    const res = await svc.vehicleReport(USER, 'v-dorm', new Date(NOW - 70 * DAY).toISOString(), new Date(NOW - 40 * DAY).toISOString());
    expect(res.dormant).toBe(false);
  });
});

describe('FuelReportService.fleetStationsMap — prix daté, historique intact', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  it('un prix vieux de 60 j est marqué périmé même si la station a été REVISITÉE hier sans relevé', async () => {
    const stops: Stop[] = [
      // Station A : prix relevé il y a 60 j, puis un passage récent SANS prix capté.
      { vehicleId: 'v-dorm', arrivedAt: new Date(NOW - 60 * DAY), durationSec: 300, unitPriceEur: 1.7, fuelType: 'gazole', station: STATION_A },
      { vehicleId: 'v-live', arrivedAt: new Date(NOW - 1 * DAY), durationSec: 300, unitPriceEur: null, fuelType: null, station: STATION_A },
      // Station B : prix relevé hier.
      { vehicleId: 'v-live', arrivedAt: new Date(NOW - 1 * DAY), durationSec: 300, unitPriceEur: 1.92, fuelType: 'gazole', station: STATION_B },
    ];
    const { svc } = makeSvc({ stops, tracker: null });
    const points = await svc.fleetStationsMap(USER, FROM, TO);

    const a = points.find((p) => p.stationId === 'st-a')!;
    expect(a.lastPriceEur).toBe(1.7);
    expect(a.lastPriceAt).toBe(new Date(NOW - 60 * DAY).toISOString());
    expect(a.lastPriceStale).toBe(true); // la récence de la VISITE ne rajeunit pas le PRIX
    expect(a.lastVisitAt).toBe(new Date(NOW - 1 * DAY).toISOString());

    const b = points.find((p) => p.stationId === 'st-b')!;
    expect(b.lastPriceStale).toBe(false);
  });

  it('les passages d\'un véhicule devenu dormant restent comptés : la carte raconte l\'usage réel des stations', async () => {
    const stops: Stop[] = [
      { vehicleId: 'v-dorm', arrivedAt: new Date(NOW - 80 * DAY), durationSec: 300, unitPriceEur: 1.75, fuelType: 'gazole', station: STATION_A },
      { vehicleId: 'v-live', arrivedAt: new Date(NOW - 2 * DAY), durationSec: 300, unitPriceEur: 1.9, fuelType: 'gazole', station: STATION_A },
    ];
    const { svc } = makeSvc({ stops, tracker: null });
    const points = await svc.fleetStationsMap(USER, FROM, TO);

    const a = points.find((p) => p.stationId === 'st-a')!;
    expect(a.visits).toBe(2);
    expect(a.distinctVehicles).toBe(2);
    expect(a.vehicles.map((v) => v.vehicleId).sort()).toEqual(['v-dorm', 'v-live']);
  });
});
