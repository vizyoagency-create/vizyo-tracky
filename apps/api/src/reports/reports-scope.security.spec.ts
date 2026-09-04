/**
 * Sprint 5 — Tests de sécurité du PÉRIMÈTRE véhicule des rapports / trips.
 *
 * Objectif (anti-IDOR intra-flotte, cf. docs/sprint-5/ANALYSE.md §4) : un user
 * scopé à un groupe ou à des véhicules (VIEWER/FLEET_MANAGER avec règles
 * `UserVehicleAccess`) ne doit voir/exporter QUE ses véhicules accessibles, et
 * toute demande explicite d'un véhicule hors périmètre doit être REJETÉE (403),
 * pas réduite silencieusement à un sous-ensemble.
 *
 * On vérifie :
 *   1. le helper partagé `resolveReportVehicleScope` (cœur de la règle) ;
 *   2. `ReportsStatsService.compute` borne les requêtes trips/alerts au périmètre
 *      + rejette un vehicleId hors périmètre ;
 *   3. `ReportCsvService.trips` borne le `where` au périmètre ;
 *   4. `TripsService.list` borne + rejette hors périmètre, et 'ALL' = inchangé.
 */
import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { ReportsStatsService } from './reports-stats.service';
import { ReportCsvService } from './report-csv.service';
import { TripsService } from '../trips/trips.service';

const FLEET_ID = 'fleet-1';
// Périmètre du user scopé groupe G1 : véhicules A et B.
const VEH_A = 'veh-a';
const VEH_B = 'veh-b';
// Véhicule HORS périmètre (appartient à la flotte mais pas au groupe du user).
const VEH_X = 'veh-x';

const FROM = new Date('2026-06-01T00:00:00.000Z');
const TO = new Date('2026-06-30T23:59:59.000Z');

// ---------------------------------------------------------------------------
// 1) Helper partagé
// ---------------------------------------------------------------------------
describe('resolveReportVehicleScope (helper partagé)', () => {
  it("'ALL' sans demande explicite → 'ALL' (pas de borne)", () => {
    expect(resolveReportVehicleScope('ALL')).toBe('ALL');
  });

  it("'ALL' avec demande explicite → la demande (la flotte borne ailleurs)", () => {
    expect(resolveReportVehicleScope('ALL', [VEH_A])).toEqual([VEH_A]);
  });

  it('périmètre restreint sans demande → borne = périmètre complet', () => {
    expect(resolveReportVehicleScope([VEH_A, VEH_B])).toEqual(
      expect.arrayContaining([VEH_A, VEH_B]),
    );
  });

  it('périmètre restreint + demande DANS le périmètre → la demande', () => {
    expect(resolveReportVehicleScope([VEH_A, VEH_B], [VEH_A])).toEqual([VEH_A]);
  });

  it('périmètre restreint + demande HORS périmètre → ForbiddenException', () => {
    expect(() => resolveReportVehicleScope([VEH_A, VEH_B], [VEH_X])).toThrow(
      ForbiddenException,
    );
  });

  it('périmètre restreint + demande mixte (1 dedans, 1 dehors) → Forbidden', () => {
    expect(() => resolveReportVehicleScope([VEH_A, VEH_B], [VEH_A, VEH_X])).toThrow(
      ForbiddenException,
    );
  });
});

// ---------------------------------------------------------------------------
// 2) ReportsStatsService.compute
// ---------------------------------------------------------------------------
describe('ReportsStatsService.compute — borne périmètre', () => {
  /** Capture les `where` passés à trip.aggregate / groupBy / findMany. */
  function makePrisma(vehiclesInFleet: string[]) {
    const captured: { tripWhere?: any; alertWhere?: any; fuelStopWhere?: any; excesParams?: unknown[]; nbRequetesBrutes?: number } = {};
    const vehicleRows = vehiclesInFleet.map((id) => ({
      id, plate: id.toUpperCase(), type: 'CAR', fuelConsumptionL100km: null, groups: [],
    }));
    return {
      captured,
      prisma: {
        fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'F1', fuelPriceEurL: 1.85 }) },
        vehicle: {
          findMany: jest.fn().mockImplementation(({ where }: any) => {
            // Respecte le filtre id IN si présent (simulate DB).
            const ids: string[] | undefined = where?.id?.in;
            return Promise.resolve(ids ? vehicleRows.filter((v) => ids.includes(v.id)) : vehicleRows);
          }),
        },
        trip: {
          aggregate: jest.fn().mockImplementation(({ where }: any) => {
            captured.tripWhere = where;
            return Promise.resolve({
              _count: { _all: 0 }, _sum: { distanceKm: 0, durationSeconds: 0 },
              _avg: { avgSpeed: 0 }, _max: { maxSpeed: 0 },
            });
          }),
          groupBy: jest.fn().mockResolvedValue([]),
          findMany: jest.fn().mockResolvedValue([]),
        },
        alert: {
          groupBy: jest.fn().mockImplementation(({ where }: any) => {
            captured.alertWhere = where;
            return Promise.resolve([]);
          }),
        },
        tripFuelStop: {
          aggregate: jest.fn().mockImplementation(({ where }: any) => {
            captured.fuelStopWhere = where;
            return Promise.resolve({ _avg: { unitPriceEur: null }, _count: { _all: 0 } });
          }),
        },
        /**
         * Excès par véhicule (F06) — SQL brut, donc HORS du `where` Prisma que le reste de
         * ce fichier inspecte. C'est exactement pour cela qu'on capture ses paramètres : une
         * requête écrite à la main est le seul endroit du service où le périmètre peut être
         * oublié sans qu'aucun type ne s'en aperçoive.
         */
        $queryRaw: jest.fn().mockImplementation((_strings: unknown, ...valeurs: unknown[]) => {
          // ⚠️ On ACCUMULE : le service en lance plusieurs (excès, ralenti). Ne garder que
          // la dernière ferait passer le test au vert alors qu'une seule des requêtes porte
          // le périmètre — et ce serait la garde de périmètre qui aurait l'air tenue.
          captured.excesParams = [...(captured.excesParams ?? []), ...valeurs];
          captured.nbRequetesBrutes = (captured.nbRequetesBrutes ?? 0) + 1;
          return Promise.resolve([]);
        }),
      } as any,
    };
  }

  it('user scopé groupe (A,B) → trips/alerts bornés à [A,B]', async () => {
    const { prisma, captured } = makePrisma([VEH_A, VEH_B, VEH_X]);
    const svc = new ReportsStatsService(prisma);

    await svc.compute(FLEET_ID, FROM, TO, {
      role: UserRole.VIEWER,
      fleetId: FLEET_ID,
      accessibleVehicleIds: [VEH_A, VEH_B],
    });

    expect(captured.tripWhere.vehicleId).toEqual({ in: expect.arrayContaining([VEH_A, VEH_B]) });
    expect(captured.tripWhere.vehicleId.in).toHaveLength(2);
    expect(captured.tripWhere.vehicleId.in).not.toContain(VEH_X);
    expect(captured.alertWhere.vehicleId).toEqual({ in: expect.arrayContaining([VEH_A, VEH_B]) });
    // Borne flotte conservée (défense en profondeur).
    expect(captured.tripWhere.fleetId).toBe(FLEET_ID);
  });

  it('user scopé groupe demande un vehicleId HORS périmètre → Forbidden', async () => {
    const { prisma } = makePrisma([VEH_A, VEH_B, VEH_X]);
    const svc = new ReportsStatsService(prisma);

    await expect(
      svc.compute(
        FLEET_ID, FROM, TO,
        { role: UserRole.VIEWER, fleetId: FLEET_ID, accessibleVehicleIds: [VEH_A, VEH_B] },
        { vehicleIds: [VEH_X] },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("user 'ALL' (FLEET_ADMIN) → pas de borne véhicule (inchangé)", async () => {
    const { prisma, captured } = makePrisma([VEH_A, VEH_B, VEH_X]);
    const svc = new ReportsStatsService(prisma);

    await svc.compute(FLEET_ID, FROM, TO, {
      role: UserRole.FLEET_ADMIN,
      fleetId: FLEET_ID,
      accessibleVehicleIds: 'ALL',
    });

    // Aucun filtre vehicleId injecté → tripWhere n'a pas la clé vehicleId.
    expect(captured.tripWhere.vehicleId).toBeUndefined();
    expect(captured.tripWhere.fleetId).toBe(FLEET_ID);
  });

  /**
   * Les paramètres LIÉS de la requête, fragments imbriqués compris.
   *
   * ⚠️ La clause de périmètre est un `Prisma.sql` niché dans le gabarit principal. Prisma
   * l'aplatit à l'exécution ; un double `jest.fn()`, lui, reçoit le fragment tel quel. Ne
   * regarder que le premier niveau ferait passer ce test au vert le jour où la clause
   * disparaîtrait — le pire des verts, sur une garde de périmètre.
   */
  function valeursLiees(params: unknown[] | undefined): unknown[] {
    const sortie: unknown[] = [];
    for (const v of params ?? []) {
      const imbrique = (v as { values?: unknown[] } | null)?.values;
      if (Array.isArray(imbrique) && v instanceof Object && 'strings' in (v as object)) {
        sortie.push(...valeursLiees(imbrique));
      } else {
        sortie.push(v);
      }
    }
    return sortie;
  }

  /**
   * ── LA COLONNE « EXCÈS » PASSE PAR DU SQL ÉCRIT À LA MAIN (F06) ────────────────────
   *
   * Les autres agrégats sont bornés par un objet `where` que Prisma type ; celui-ci est une
   * chaîne. Aucun compilateur ne verra jamais qu'on a oublié d'y remettre le périmètre le
   * jour où la requête bougera — et c'est le seul endroit du service où un VIEWER pourrait
   * apprendre combien d'excès a commis un véhicule qu'il n'a pas le droit de voir.
   */
  it('la requête SQL des excès porte le périmètre véhicule, pas seulement la flotte', async () => {
    const { prisma, captured } = makePrisma([VEH_A, VEH_B, VEH_X]);
    const svc = new ReportsStatsService(prisma);

    await svc.compute(FLEET_ID, FROM, TO, {
      role: UserRole.VIEWER,
      fleetId: FLEET_ID,
      accessibleVehicleIds: [VEH_A, VEH_B],
    });

    const params = valeursLiees(captured.excesParams);
    // ⚠️ CHAQUE requête brute porte son périmètre : autant de tableaux liés que de requêtes.
    // Une seule suffirait à faire passer une assertion naïve, en laissant l'autre ouverte.
    const perimetres = params.filter((v): v is string[] => Array.isArray(v));
    expect(perimetres.length).toBe(captured.nbRequetesBrutes);
    for (const perimetre of perimetres) {
      expect(perimetre).toEqual(expect.arrayContaining([VEH_A, VEH_B]));
      expect(perimetre).toHaveLength(2);
      expect(perimetre).not.toContain(VEH_X);
    }
    // Et la flotte reste passée, en défense en profondeur comme partout ailleurs.
    expect(params).toContain(FLEET_ID);
  });

  it("un utilisateur 'ALL' n'envoie AUCUN tableau de véhicules à la requête des excès", async () => {
    const { prisma, captured } = makePrisma([VEH_A, VEH_B, VEH_X]);
    const svc = new ReportsStatsService(prisma);

    await svc.compute(FLEET_ID, FROM, TO, {
      role: UserRole.FLEET_ADMIN,
      fleetId: FLEET_ID,
      accessibleVehicleIds: 'ALL',
    });

    // Aucun paramètre tableau : la clause de périmètre n'est pas ajoutée du tout.
    expect(valeursLiees(captured.excesParams).some((v) => Array.isArray(v))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3) ReportCsvService.trips
// ---------------------------------------------------------------------------
describe('ReportCsvService.trips — borne périmètre', () => {
  function makeCsvPrisma() {
    const captured: { where?: any } = {};
    return {
      captured,
      prisma: {
        trip: {
          findMany: jest.fn().mockImplementation(({ where }: any) => {
            captured.where = where;
            return Promise.resolve([]);
          }),
        },
      } as any,
    };
  }

  it('user scopé (A,B) → where.vehicleId IN [A,B] + fleetId conservé', async () => {
    const { prisma, captured } = makeCsvPrisma();
    const svc = new ReportCsvService(prisma);

    await svc.trips(FLEET_ID, FROM, TO, [VEH_A, VEH_B]);

    expect(captured.where.vehicleId).toEqual({ in: expect.arrayContaining([VEH_A, VEH_B]) });
    expect(captured.where.fleetId).toBe(FLEET_ID);
  });

  it("user 'ALL' → pas de borne vehicleId (seulement fleetId)", async () => {
    const { prisma, captured } = makeCsvPrisma();
    const svc = new ReportCsvService(prisma);

    await svc.trips(FLEET_ID, FROM, TO, 'ALL');

    expect(captured.where.vehicleId).toBeUndefined();
    expect(captured.where.fleetId).toBe(FLEET_ID);
  });
});

// ---------------------------------------------------------------------------
// 4) TripsService.list / dailySummary
// ---------------------------------------------------------------------------
describe('TripsService.list / dailySummary — borne périmètre', () => {
  function makeTripsService() {
    const captured: { where?: any } = {};
    const prisma = {
      trip: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          captured.where = where;
          return Promise.resolve([]);
        }),
      },
    } as any;
    // gateway/segmenter/mapMatching non sollicités par list/dailySummary.
    const svc = new TripsService(prisma, {} as any, {} as any, {} as any);
    (svc as any).ready = true;
    return { svc, captured };
  }

  it('VIEWER scopé (A,B) sans filtre → where.vehicleId IN [A,B]', async () => {
    const { svc, captured } = makeTripsService();
    await svc.list(
      { userId: 'u', role: UserRole.VIEWER, fleetId: FLEET_ID, accessibleVehicleIds: [VEH_A, VEH_B] },
      {},
    );
    expect(captured.where.vehicleId).toEqual({ in: expect.arrayContaining([VEH_A, VEH_B]) });
    expect(captured.where.fleetId).toBe(FLEET_ID);
  });

  it('VIEWER scopé (A,B) demande VEH_X hors périmètre → Forbidden', async () => {
    const { svc } = makeTripsService();
    await expect(
      svc.list(
        { userId: 'u', role: UserRole.VIEWER, fleetId: FLEET_ID, accessibleVehicleIds: [VEH_A, VEH_B] },
        { vehicleId: VEH_X },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('VIEWER scopé (A,B) demande VEH_A (dans périmètre) → vehicleId = A', async () => {
    const { svc, captured } = makeTripsService();
    await svc.list(
      { userId: 'u', role: UserRole.VIEWER, fleetId: FLEET_ID, accessibleVehicleIds: [VEH_A, VEH_B] },
      { vehicleId: VEH_A },
    );
    expect(captured.where.vehicleId).toBe(VEH_A);
  });

  it("FLEET_ADMIN 'ALL' sans filtre → aucune borne vehicleId (inchangé)", async () => {
    const { svc, captured } = makeTripsService();
    await svc.list(
      { userId: 'u', role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID, accessibleVehicleIds: 'ALL' },
      {},
    );
    expect(captured.where.vehicleId).toBeUndefined();
    expect(captured.where.fleetId).toBe(FLEET_ID);
  });

  it('dailySummary VIEWER scopé (A,B) demande VEH_X → Forbidden', async () => {
    const { svc } = makeTripsService();
    await expect(
      svc.dailySummary(
        { userId: 'u', role: UserRole.VIEWER, fleetId: FLEET_ID, accessibleVehicleIds: [VEH_A, VEH_B] },
        { vehicleIds: VEH_X },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
