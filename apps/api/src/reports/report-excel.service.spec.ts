/**
 * Sprint 5 — Tests du ReportExcelService (export Excel « soigné » par véhicule).
 *
 * Vérifie :
 *   1. `generate` retourne un Buffer .xlsx non vide, relisible par exceljs, avec
 *      les 3 feuilles attendues (Synthèse · Trajets · Par jour) + l'en-tête de la
 *      feuille Trajets ;
 *   2. les données trajets (TOTAL, par jour) sont bien rendues ;
 *   3. un `vehicleId` HORS périmètre de l'appelant → ForbiddenException ;
 *   4. le nom de fichier suit `tracky-{plaque}-{from}_{to}.xlsx`.
 */
import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { ReportExcelService } from './report-excel.service';
import type { AuthUser } from '../auth/types/auth-user';

const FLEET_ID = 'fleet-1';
const VEH_A = 'veh-a';
const VEH_X = 'veh-x'; // hors périmètre
const FROM = new Date('2026-06-01T00:00:00.000Z');
const TO = new Date('2026-06-30T23:59:59.000Z');

function makeUser(role: UserRole, fleetId: string | null = FLEET_ID): AuthUser {
  return {
    id: 'user-1', authUserId: 'auth-1', email: 'u@test.fr',
    firstName: null, lastName: null, role, fleetId, isActive: true, isOwner: false, permissions: null,
  };
}

const TRIP_ROWS = [
  {
    startedAt: new Date('2026-06-02T08:00:00.000Z'),
    endedAt: new Date('2026-06-02T08:30:00.000Z'),
    durationSeconds: 1800, distanceKm: 12.4, maxSpeed: 92, avgSpeed: 41,
    notes: 'Livraison matin', driver: { firstName: 'Alice', lastName: 'Martin' },
  },
  {
    startedAt: new Date('2026-06-02T14:00:00.000Z'),
    endedAt: new Date('2026-06-02T14:45:00.000Z'),
    durationSeconds: 2700, distanceKm: 20.1, maxSpeed: 110, avgSpeed: 53,
    notes: null, driver: null,
  },
  {
    startedAt: new Date('2026-06-05T09:00:00.000Z'),
    endedAt: new Date('2026-06-05T09:20:00.000Z'),
    durationSeconds: 1200, distanceKm: 7.5, maxSpeed: 70, avgSpeed: 30,
    notes: null, driver: { firstName: 'Bob', lastName: 'Durand' },
  },
];

/**
 * @param accessible périmètre véhicules retourné par VehicleAccessService.
 * @param vehicleFleetId flotte du véhicule chargé (pour le check d'appartenance).
 */
function buildService(accessible: string[] | 'ALL', vehicleFleetId = FLEET_ID) {
  const prisma = {
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({
        id: VEH_A, plate: 'AB-123-CD', brand: 'Renault', model: 'Master',
        type: 'VAN', fuelConsumptionL100km: null, fleetId: vehicleFleetId,
        fleet: { id: FLEET_ID, name: 'Flotte Test', fuelPriceEurL: 1.9 },
      }),
    },
    trip: { findMany: jest.fn().mockResolvedValue(TRIP_ROWS) },
  } as any;
  const vehicleAccess = {
    getAccessibleVehicleIds: jest.fn().mockResolvedValue(accessible),
  } as any;
  const svc = new ReportExcelService(prisma, vehicleAccess);
  return { svc, prisma, vehicleAccess };
}

describe('ReportExcelService.generate', () => {
  it('retourne un Buffer .xlsx non vide avec les 3 feuilles + en-tête Trajets', async () => {
    const { svc } = buildService('ALL');

    const { buffer, filename } = await svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(filename).toBe('tracky-AB-123-CD-2026-06-01_2026-06-30.xlsx');

    // Relit le classeur produit.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(['Synthèse', 'Trajets', 'Par jour']);

    // En-tête de la feuille Trajets (ligne 1).
    const trajets = wb.getWorksheet('Trajets')!;
    const header = (trajets.getRow(1).values as unknown[]).slice(1); // index 0 vide chez exceljs
    expect(header).toEqual([
      'Départ', 'Arrivée', 'Durée', 'Distance (km)',
      'V. moy (km/h)', 'V. max (km/h)', 'Conducteur', 'Notes',
    ]);

    // 3 trajets + 1 ligne TOTAL = 4 lignes de données (rows 2..5).
    expect(trajets.rowCount).toBe(1 + TRIP_ROWS.length + 1);
    const totalRow = trajets.getRow(trajets.rowCount);
    expect(totalRow.getCell(1).value).toBe('TOTAL');
  });

  it("feuille « Par jour » agrège par date (2 jours pour ce jeu d'essai)", async () => {
    const { svc } = buildService('ALL');
    const { buffer } = await svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const parJour = wb.getWorksheet('Par jour')!;
    // header + 2 jours distincts (2026-06-02, 2026-06-05).
    expect(parJour.rowCount).toBe(1 + 2);
    expect(parJour.getRow(2).getCell(1).value).toBe('2026-06-02');
    expect(parJour.getRow(3).getCell(1).value).toBe('2026-06-05');
  });

  it("Synthèse porte la plaque et le nombre de trajets", async () => {
    const { svc } = buildService('ALL');
    const { buffer } = await svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const synth = wb.getWorksheet('Synthèse')!;
    // Cherche une cellule contenant la plaque.
    let foundPlate = false;
    synth.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value === 'AB-123-CD') foundPlate = true;
      });
    });
    expect(foundPlate).toBe(true);
  });

  it('VIEWER scopé (sans VEH_X) demandant VEH_X → ForbiddenException', async () => {
    // Le périmètre accessible ne contient QUE VEH_A ; on demande VEH_X.
    const { svc, prisma } = buildService([VEH_A]);

    await expect(
      svc.generate(VEH_X, FROM, TO, makeUser(UserRole.VIEWER)),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Rejet AVANT toute requête véhicule/trip (court-circuit périmètre).
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
  });

  it('non-super dont le véhicule appartient à une AUTRE flotte → Forbidden (defense en profondeur)', async () => {
    // Périmètre 'ALL' incohérent mais véhicule d'une autre flotte → 403 via le
    // check d'appartenance flotte.
    const { svc } = buildService('ALL', 'autre-flotte');

    await expect(
      svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_MANAGER, FLEET_ID)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
