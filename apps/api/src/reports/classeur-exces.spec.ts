import { UserRole } from '@prisma/client';
import ExcelJS from 'exceljs';
import { ReportExcelService } from './report-excel.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LES EXCÈS, DANS LE CLASSEUR AUSSI — ET PARTOUT OÙ ILS ONT UN SENS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Contrôle du 2026-09-06 : le PDF imprimait une colonne EXCÈS dans son récapitulatif, l'écran
 * les affichait sur les deux vues, et le classeur n'en parlait NULLE PART. Un gestionnaire qui
 * ouvre le tableur pour trier ses conducteurs — le geste même pour lequel un tableur existe —
 * n'y trouvait pas la colonne sur laquelle il voulait trier.
 *
 * Ce fichier vérifie les quatre endroits où ils apparaissent désormais :
 *
 *   1. « Trajets »                  — ligne à ligne, c'est la feuille qu'on filtre ;
 *   2. « Par conducteur ou groupe » — le récapitulatif que le PDF imprime déjà ;
 *   3. « Synthèse par véhicule »    — le tableau de bord d'un parc ;
 *   4. « Synthèse » (un véhicule)   — le bloc d'indicateurs.
 *
 * ⚠️ ET LA DÉGRADATION, qui compte autant : la lecture des excès est best-effort. Un classeur
 * amputé d'une colonne reste utile — c'est le document de secours quand l'écran ne répond
 * pas — alors qu'un classeur en erreur ne l'est pas.
 */
const FLEET_ID = 'fleet-1';
const VEH_A = 'veh-a';
const FROM = new Date('2026-06-01T00:00:00.000Z');
const TO = new Date('2026-06-30T23:59:59.000Z');

const makeUser = (role: UserRole) => ({ id: 'u1', role, fleetId: FLEET_ID }) as never;

/** Trois trajets, dont deux portent des excès. */
const TRIPS = [
  {
    id: 't1',
    startedAt: new Date('2026-06-02T08:00:00.000Z'), endedAt: new Date('2026-06-02T08:30:00.000Z'),
    durationSeconds: 1800, movingSeconds: 1500, distanceKm: 12.4, maxSpeed: 92, avgSpeed: 41,
    notes: null, driverId: 'drv-alice', driver: { firstName: 'Alice', lastName: 'Martin' },
  },
  {
    id: 't2',
    startedAt: new Date('2026-06-03T08:00:00.000Z'), endedAt: new Date('2026-06-03T08:20:00.000Z'),
    durationSeconds: 1200, movingSeconds: 1200, distanceKm: 7.5, maxSpeed: 118, avgSpeed: 38,
    notes: null, driverId: 'drv-alice', driver: { firstName: 'Alice', lastName: 'Martin' },
  },
  {
    id: 't3',
    startedAt: new Date('2026-06-04T08:00:00.000Z'), endedAt: new Date('2026-06-04T08:15:00.000Z'),
    durationSeconds: 900, movingSeconds: 900, distanceKm: 4.2, maxSpeed: 70, avgSpeed: 30,
    notes: null, driverId: 'drv-bob', driver: { firstName: 'Bob', lastName: 'Durand' },
  },
];

/** Ce que rend `excesParTrajet` : deux trajets d'Alice, aucun de Bob. */
const EXCES = [
  { tripId: 't1', vehicleId: VEH_A, driverId: 'drv-alice', exces: 3, pire: 12.5 },
  { tripId: 't2', vehicleId: VEH_A, driverId: 'drv-alice', exces: 1, pire: 26.4 },
];

function banc(opts: { queryRaw?: unknown } = {}) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({
        id: VEH_A, plate: 'AB-123-CD', brand: 'Renault', model: 'Master', type: 'VAN',
        fuelConsumptionL100km: null, calibratedConsumptionL100km: null, calibratedTanks: 0,
        fleetId: FLEET_ID, groups: [{ group: { id: 'g1', name: 'Livraisons' } }],
        fleet: { id: FLEET_ID, name: 'Flotte Test', fuelPriceEurL: 1.9 },
      }),
    },
    trip: { findMany: jest.fn().mockResolvedValue(TRIPS) },
    tripFuelStop: { findMany: jest.fn().mockResolvedValue([]) },
  };
  if ('queryRaw' in opts) prisma.$queryRaw = opts.queryRaw;
  const vehicleAccess: any = { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return new ReportExcelService(prisma, vehicleAccess);
}

async function classeur(svc: ReportExcelService): Promise<ExcelJS.Workbook> {
  const { buffer } = await svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

/** Les valeurs d'une ligne, sans la case 0 qu'exceljs laisse vide. */
const valeurs = (ws: ExcelJS.Worksheet, n: number): unknown[] =>
  (ws.getRow(n).values as unknown[]).slice(1);

describe('Classeur — les excès figurent partout où ils ont un sens', () => {
  let wb: ExcelJS.Workbook;

  beforeAll(async () => {
    wb = await classeur(banc({ queryRaw: jest.fn().mockResolvedValue(EXCES) }));
  });

  it('feuille « Trajets » : chaque ligne porte ses excès et son pire dépassement', async () => {
    const ws = wb.getWorksheet('Trajets')!;
    const entete = valeurs(ws, 1) as string[];
    const iExces = entete.indexOf('Excès');
    const iPire = entete.indexOf('Pire dépassement (km/h)');

    expect(iExces).toBeGreaterThan(-1);
    expect(valeurs(ws, 2)[iExces]).toBe(3);
    expect(valeurs(ws, 2)[iPire]).toBe(12.5);
    expect(valeurs(ws, 3)[iExces]).toBe(1);
    // ⚠️ Un trajet SANS excès porte un zéro… mais PAS de « pire ». Un 0 dans cette colonne
    // se trierait comme une mesure, au milieu de trajets qui en ont vraiment un.
    expect(valeurs(ws, 4)[iExces]).toBe(0);
    expect(valeurs(ws, 4)[iPire] ?? '').toBe('');
  });

  it('feuille « Trajets » : la ligne TOTAL somme les excès et garde le PIRE', async () => {
    const ws = wb.getWorksheet('Trajets')!;
    const entete = valeurs(ws, 1) as string[];
    const total = valeurs(ws, ws.rowCount);

    expect(total[0]).toBe('TOTAL');
    expect(total[entete.indexOf('Excès')]).toBe(4); // 3 + 1
    // ⚠️ 26,4 et non 38,9 : additionner deux dépassements donnerait un nombre qui ne
    // correspond à aucun instant de conduite.
    expect(total[entete.indexOf('Pire dépassement (km/h)')]).toBe(26.4);
  });

  it('feuille « Par conducteur ou groupe » : les excès suivent l’imputation', async () => {
    const ws = wb.getWorksheet('Par conducteur ou groupe')!;
    const entete = valeurs(ws, 4) as string[];
    const iExces = entete.indexOf('Excès');
    const iPire = entete.indexOf('Pire dépassement (km/h)');

    expect(iExces).toBeGreaterThan(-1);
    // Alice roule le plus : sa ligne ouvre le tableau, avec ses quatre excès.
    const alice = valeurs(ws, 5);
    expect(alice[0]).toBe('Alice Martin');
    expect(alice[iExces]).toBe(4);
    expect(alice[iPire]).toBe(26.4);
    // Bob n'en a aucun : zéro, et pas de pire.
    const bob = valeurs(ws, 6);
    expect(bob[0]).toBe('Bob Durand');
    expect(bob[iExces]).toBe(0);
    expect(bob[iPire] ?? '').toBe('');
  });

  it('feuille « Synthèse » : deux lignes, parce que « 4 excès » et « sur 2 trajets » diffèrent', async () => {
    // Quatre dépassements répartis sur deux sorties se lisent autrement que quatre sur une
    // seule : c'est la seconde ligne qui distingue une habitude d'un mauvais jour.
    const texte = valeurs(wb.getWorksheet('Synthèse')!, 0).join(' ');
    const ws = wb.getWorksheet('Synthèse')!;
    const lignes: Array<[unknown, unknown]> = [];
    ws.eachRow((row) => lignes.push([row.getCell(1).value, row.getCell(2).value]));
    const valeurDe = (libelle: string) => lignes.find(([l]) => l === libelle)?.[1];

    expect(texte).toBeDefined();
    expect(valeurDe('Excès de vitesse établis')).toBe(4);
    expect(valeurDe('— sur combien de trajets')).toBe(2);
    expect(valeurDe('Pire dépassement (km/h au-dessus)')).toBe(26.4);
  });

  it('sans le moindre excès, la ligne « pire dépassement » n’apparaît pas', async () => {
    // Un « 0 km/h au-dessus de la limite » se lit comme une mesure. Il n'y a rien à mesurer.
    const vierge = await classeur(banc({ queryRaw: jest.fn().mockResolvedValue([]) }));
    const ws = vierge.getWorksheet('Synthèse')!;
    const libelles: unknown[] = [];
    ws.eachRow((row) => libelles.push(row.getCell(1).value));

    expect(libelles).toContain('Excès de vitesse établis');
    expect(libelles).not.toContain('Pire dépassement (km/h au-dessus)');
  });

  /**
   * ⚠️ LA DÉGRADATION EST UNE FONCTIONNALITÉ, PAS UN ACCIDENT.
   *
   * La lecture des excès passe par une requête SQL brute. Si elle échoue — base sous tension,
   * client Prisma remplacé, méthode absente d'un double — le classeur doit SORTIR QUAND MÊME.
   * C'est le document de secours quand l'écran ne répond plus : le faire tomber pour une
   * colonne accessoire serait une régression bien plus grave que son absence.
   */
  it('la requête échoue : le classeur sort quand même, colonnes à zéro', async () => {
    const enPanne = banc({ queryRaw: jest.fn().mockRejectedValue(new Error('base indisponible')) });
    const wbPanne = await classeur(enPanne);
    const ws = wbPanne.getWorksheet('Trajets')!;
    const iExces = (valeurs(ws, 1) as string[]).indexOf('Excès');

    expect(ws.rowCount).toBeGreaterThan(1);
    expect(valeurs(ws, 2)[iExces]).toBe(0);
  });

  it('la méthode n’existe même pas : même issue, pas une exception', async () => {
    // Un `.catch()` seul ne rattraperait pas cette erreur-là : elle est SYNCHRONE.
    const wbSansMethode = await classeur(banc());
    expect(wbSansMethode.getWorksheet('Trajets')!.rowCount).toBeGreaterThan(1);
  });
});
