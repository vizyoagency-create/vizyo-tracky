/**
 * 06/10/2026 — L'ÉTAT DES VÉHICULES DANS LES RAPPORTS.
 *
 * Demande du propriétaire : « ajoute aux autres pages, tableau de bord et rapport aussi ». Un
 * rapport nommait « n'a fait aucun trajet » un véhicule au garage depuis trois semaines : la phrase
 * qui décide d'une mutualisation ou d'une restitution se lisait comme un véhicule sous-utilisé.
 *
 * Ce que ces tests verrouillent :
 *   1. le motif déclaré est LU (sélection), et l'agenda aussi — en lot, best-effort ;
 *   2. `vehicles.indisponibles` liste le parc VISIBLE indisponible à la date de génération ;
 *   3. l'état n'est posé sur la ligne d'un véhicule immobile que s'il a commencé AVANT la fin de
 *      la période (une immobilisation d'hier n'explique pas un mois sans trajet) ;
 *   4. rien ne bouge dans les totaux, et un véhicule en mode vie privée n'est jamais nommé ;
 *   5. la mention (PDF, courrier) est muette sur un parc disponible, et défensive.
 */
import PDFDocument from 'pdfkit';
import { UserRole } from '@prisma/client';
import { ReportPdfService } from './report-pdf.service';
import {
  buildUnavailableNotice,
  FleetStatsReport,
  ReportsStatsService,
  type VehiculeIndisponibleDuRapport,
} from './reports-stats.service';

const FLEET_ID = 'fleet-1';
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const NOW = Date.now();
/** Période : il y a 30 jours → il y a 10 jours. */
const FROM = new Date(NOW - 30 * DAY);
const TO = new Date(NOW - 10 * DAY);

interface Fixture {
  id: string;
  plate: string;
  km: number;
  outOfServiceReason?: 'ACCIDENT' | 'TRACKER_UNPLUGGED' | 'IMMOBILIZED' | null;
  outOfServiceSince?: Date | null;
  privacyModeEnabled?: boolean;
}

function makePrisma(fixtures: Fixture[], evenements: unknown[] | 'absent' = []) {
  const vehicleRows = fixtures.map((f) => ({
    id: f.id,
    plate: f.plate,
    type: 'CAR',
    energy: 'DIESEL',
    fuelConsumptionL100km: 7,
    calibratedConsumptionL100km: null,
    calibratedTanks: 0,
    privacyModeEnabled: !!f.privacyModeEnabled,
    groups: [],
    tracker: { id: `t-${f.id}`, lastSeenAt: new Date(NOW - 5 * 60 * 1000) },
    outOfServiceReason: f.outOfServiceReason ?? null,
    outOfServiceSince: f.outOfServiceSince ?? null,
  }));
  const tripGroups = fixtures
    .filter((f) => f.km > 0 && !f.privacyModeEnabled)
    .map((f) => ({ vehicleId: f.id, driverId: null, _sum: { distanceKm: f.km, durationSeconds: 3600 }, _count: { _all: 1 } }));
  const totalKm = tripGroups.reduce((s, g) => s + g._sum.distanceKm, 0);
  const prisma: Record<string, unknown> = {
    fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Flotte test', fuelPriceEurL: 1.85 }) },
    vehicle: { findMany: jest.fn().mockResolvedValue(vehicleRows) },
    trip: {
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: tripGroups.length },
        _sum: { distanceKm: totalKm, durationSeconds: 3600 * tripGroups.length, movingSeconds: 3000 * tripGroups.length },
        _avg: { avgSpeed: 42 },
        _max: { maxSpeed: 110 },
      }),
      groupBy: jest.fn().mockResolvedValue(tripGroups),
      findMany: jest.fn().mockResolvedValue([]),
    },
    alert: { groupBy: jest.fn().mockResolvedValue([]) },
    tripFuelStop: { groupBy: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  if (evenements !== 'absent') prisma.vehicleEvent = { findMany: jest.fn().mockResolvedValue(evenements) };
  return prisma as any;
}

const compute = (prisma: unknown): Promise<FleetStatsReport> =>
  new ReportsStatsService(prisma as never).compute(FLEET_ID, FROM, TO, {
    role: UserRole.FLEET_ADMIN,
    fleetId: FLEET_ID,
    accessibleVehicleIds: 'ALL',
  } as never);

/** Le parc : un immobilisé de longue date, un accidenté d'avant-hier, une maintenance en cours, un libre qui roule, un privé. */
const PARC: Fixture[] = [
  { id: 'v-imm', plate: 'HD-998-XY', km: 0, outOfServiceReason: 'IMMOBILIZED', outOfServiceSince: new Date(NOW - 20 * DAY) },
  { id: 'v-acc', plate: 'KS-370-AA', km: 0, outOfServiceReason: 'ACCIDENT', outOfServiceSince: new Date(NOW - 2 * DAY) },
  { id: 'v-mtn', plate: 'BB-222-CC', km: 120 },
  { id: 'v-libre', plate: 'AA-111-BB', km: 340 },
  { id: 'v-prive', plate: 'PR-000-VE', km: 0, outOfServiceReason: 'IMMOBILIZED', outOfServiceSince: new Date(NOW - 40 * DAY), privacyModeEnabled: true },
];
const MAINTENANCE_EN_COURS = {
  id: 'ev-1', vehicleId: 'v-mtn', type: 'MAINTENANCE', status: 'PLANNED', blocksVehicle: true,
  title: 'Pneus', startAt: new Date(NOW - HOUR), endAt: new Date(NOW + 5 * HOUR),
};

describe('Rapport — l’état des véhicules (06/10/2026)', () => {
  it('lit le motif déclaré (jamais la note libre) et l’agenda, en lot sur le parc visible', async () => {
    const prisma = makePrisma(PARC, [MAINTENANCE_EN_COURS]);
    await compute(prisma);
    const select = prisma.vehicle.findMany.mock.calls[0][0].select;
    expect(select.outOfServiceReason).toBe(true);
    expect(select.outOfServiceSince).toBe(true);
    expect(select.outOfServiceNote).toBeUndefined();
    expect(prisma.vehicleEvent.findMany).toHaveBeenCalledTimes(1);
    const ids = prisma.vehicleEvent.findMany.mock.calls[0][0].where.vehicleId.in;
    expect(ids).not.toContain('v-prive');
  });

  it('liste les indisponibles du parc VISIBLE, du plus fort au plus faible, avec leur période', async () => {
    const r = await compute(makePrisma(PARC, [MAINTENANCE_EN_COURS]));
    const liste = r.vehicles.indisponibles ?? [];
    expect(liste.map((v) => [v.plate, v.etat, v.sansTrajet])).toEqual([
      ['KS-370-AA', 'ACCIDENTE', true],
      ['HD-998-XY', 'IMMOBILISE', true],
      ['BB-222-CC', 'MAINTENANCE', false],
    ]);
    const mtn = liste.find((v) => v.etat === 'MAINTENANCE')!;
    expect(mtn.titre).toBe('Pneus');
    expect(mtn.jusqua).toBe(new Date(NOW + 5 * HOUR).toISOString());
    const imm = liste.find((v) => v.etat === 'IMMOBILISE')!;
    expect(imm.depuis).toBe(new Date(NOW - 20 * DAY).toISOString());
    expect(imm.titre).toBeNull();
    // 🔴 Le véhicule en mode vie privée n'est JAMAIS nommé, même immobilisé.
    expect(liste.some((v) => v.plate === 'PR-000-VE')).toBe(false);
  });

  it('🔴 l’état n’explique « n’a pas roulé » que s’il a commencé AVANT la fin de la période', async () => {
    const r = await compute(makePrisma(PARC, [MAINTENANCE_EN_COURS]));
    const parPlaque = new Map(r.vehicles.idleVehicles.map((v) => [v.plate, v]));
    // Immobilisé depuis 20 jours : la période (−30 → −10 j) le trouvait déjà au garage.
    expect(parPlaque.get('HD-998-XY')?.etat).toBe('IMMOBILISE');
    // Accidenté avant-hier : il était libre pendant la période — l'état ne l'excuse pas.
    expect(parPlaque.get('KS-370-AA')?.etat).toBeNull();
  });

  it('ne touche à AUCUN total : parc, véhicules actifs, immobiles', async () => {
    const avec = await compute(makePrisma(PARC, [MAINTENANCE_EN_COURS]));
    const sans = await compute(makePrisma(PARC.map((f) => ({ ...f, outOfServiceReason: null })), []));
    expect(avec.vehicles.total).toBe(sans.vehicles.total);
    expect(avec.vehicles.activeDuringPeriod).toBe(sans.vehicles.activeDuringPeriod);
    expect(avec.vehicles.idleTotal).toBe(sans.vehicles.idleTotal);
    expect(avec.trips.totalKm).toBe(sans.trips.totalKm);
    expect(sans.vehicles.indisponibles).toEqual([]);
  });

  it('agenda illisible : le rapport sort quand même, avec les seuls états de la fiche', async () => {
    const r = await compute(makePrisma(PARC, 'absent'));
    expect((r.vehicles.indisponibles ?? []).map((v) => v.etat)).toEqual(['ACCIDENTE', 'IMMOBILISE']);
  });
});

describe('buildUnavailableNotice — la même phrase pour le PDF et le courrier', () => {
  const indispo = (over: Partial<VehiculeIndisponibleDuRapport>): VehiculeIndisponibleDuRapport => ({
    vehicleId: 'v', plate: 'HD-998-XY', etat: 'IMMOBILISE', depuis: '2026-10-05T18:54:00.000Z',
    jusqua: null, titre: null, sansTrajet: true, ...over,
  });
  const rapport = (indisponibles?: VehiculeIndisponibleDuRapport[]) =>
    ({ vehicles: { indisponibles } } as unknown as FleetStatsReport);

  it('muette sur un parc disponible, et sur un rapport d’avant ce champ', () => {
    expect(buildUnavailableNotice(rapport([]))).toBeNull();
    expect(buildUnavailableNotice(rapport(undefined))).toBeNull();
    // Défensive : un rapport partiel ne fait jamais échouer un PDF ni un courrier.
    expect(buildUnavailableNotice({} as FleetStatsReport)).toBeNull();
  });

  it('nomme chaque véhicule avec son état et sa date (heure de Paris), et dit ce que ça change', () => {
    const phrase = buildUnavailableNotice(rapport([
      indispo({}),
      indispo({ plate: 'BB-222-CC', etat: 'MAINTENANCE', titre: 'Pneus', depuis: '2026-10-06T07:00:00.000Z', jusqua: '2026-10-07T16:00:00.000Z', sansTrajet: false }),
      indispo({ plate: 'FL-787-KV', etat: 'INCIDENT', titre: 'Crevaison', depuis: '2026-08-18T05:33:00.000Z' }),
    ]))!;
    expect(phrase).toContain('3 véhicules indisponibles à la date de génération');
    expect(phrase).toContain('HD-998-XY (immobilisé depuis le 05/10/2026)');
    expect(phrase).toContain('BB-222-CC (en maintenance « Pneus » jusqu\'au 07/10/2026)');
    expect(phrase).toContain('FL-787-KV (incident « Crevaison » depuis le 18/08/2026)');
    expect(phrase).toContain('n\'est pas un véhicule sous-utilisé');
    expect(phrase).toContain('Totaux et moyennes inchangés');
  });

  it('au singulier pour un seul véhicule, et tronque au-delà du plafond', () => {
    expect(buildUnavailableNotice(rapport([indispo({})]))).toContain('1 véhicule indisponible à la date');
    const huit = Array.from({ length: 8 }, (_, i) => indispo({ plate: `AA-00${i}-BB` }));
    expect(buildUnavailableNotice(rapport(huit))).toContain(', +2 autres');
  });
});

describe('PDF — l’encart des indisponibles', () => {
  async function texteDuPdf(report: FleetStatsReport): Promise<string> {
    const real = (PDFDocument.prototype as any).text;
    const ecrit: string[] = [];
    const espion = jest.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(function (this: any, ...args: any[]) {
      if (typeof args[0] === 'string') ecrit.push(args[0]);
      return real.apply(this, args);
    });
    try {
      await new ReportPdfService().generate(report);
      return ecrit.join('\n');
    } finally {
      espion.mockRestore();
    }
  }

  it('écrit l’encart quand des véhicules sont indisponibles, et rien sinon', async () => {
    const r = await compute(makePrisma(PARC, [MAINTENANCE_EN_COURS]));
    const avec = await texteDuPdf(r);
    expect(avec).toContain('véhicules indisponibles à la date de génération');
    expect(avec).toContain('HD-998-XY (immobilisé depuis le');

    const sansEtat = await compute(makePrisma(PARC.map((f) => ({ ...f, outOfServiceReason: null })), []));
    expect(await texteDuPdf(sansEtat)).not.toContain('indisponible');
  });
});
