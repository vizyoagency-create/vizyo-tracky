import { UserRole } from '@prisma/client';
import { ForecastService } from './forecast.service';

function makeUser(over: Record<string, unknown> = {}) {
  return { id: 'u1', role: UserRole.FLEET_ADMIN, fleetId: 'f1', ...over } as never;
}
function access(ids: string[] | 'ALL') {
  return { getAccessibleVehicleIds: jest.fn().mockResolvedValue(ids) } as never;
}
function makePrisma(trips: unknown[]) {
  return { trip: { findMany: jest.fn().mockResolvedValue(trips) } } as never;
}
function trip(vehicleId: string, isoStartUtc: string, hoursDur = 2) {
  const s = new Date(isoStartUtc);
  return { vehicleId, startedAt: s, endedAt: new Date(s.getTime() + hoursDur * 3_600_000), vehicle: { plate: 'AA-1' } };
}

// 4 mêmes jours-de-semaine, à 7 jours d'intervalle = 4 semaines distinctes.
const FOUR_WEEKS = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25'];
const WIN_FROM = new Date('2026-07-01T00:00:00Z');
const WIN_TO = new Date('2026-07-29T00:00:00Z'); // 4 semaines -> chaque dow apparaît

describe('ForecastService — Sprint 8 Palier C (prévision dérivée, non bloquante)', () => {
  it('détecte un usage récurrent (>= 4 semaines) et le projette sur la fenêtre', async () => {
    const trips = FOUR_WEEKS.map((d) => trip('v1', `${d}T10:00:00Z`));
    const svc = new ForecastService(makePrisma(trips), access('ALL'));
    const res = await svc.getForecast(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), WIN_FROM, WIN_TO);

    expect(res.slots.length).toBeGreaterThan(0);
    expect(res.slots[0].vehicleId).toBe('v1');
    expect(res.slots[0].basis).toContain('4/10');
    expect(res.slots[0].confidence).toBeCloseTo(0.4, 1);
  });

  it('ignore le bruit : motif observé sur trop peu de semaines -> aucune prévision', async () => {
    const trips = ['2026-05-04', '2026-05-11'].map((d) => trip('v1', `${d}T10:00:00Z`)); // 2 semaines
    const svc = new ForecastService(makePrisma(trips), access('ALL'));
    const res = await svc.getForecast(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), WIN_FROM, WIN_TO);
    expect(res.slots).toEqual([]);
  });

  it('scoping : borne par fleetId + périmètre véhicules (anti-IDOR)', async () => {
    const prisma = makePrisma([]);
    const svc = new ForecastService(prisma, access(['v1']));
    await svc.getForecast(makeUser(), WIN_FROM, WIN_TO);
    const where = (prisma as { trip: { findMany: jest.Mock } }).trip.findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBe('f1');
    expect(where.vehicleId).toEqual({ in: ['v1'] });
  });

  it('une prévision n\'est PAS un événement (pas de statut) -> jamais bloquante', async () => {
    const trips = [...FOUR_WEEKS, '2026-06-01'].map((d) => trip('v1', `${d}T10:00:00Z`));
    const svc = new ForecastService(makePrisma(trips), access('ALL'));
    const res = await svc.getForecast(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), WIN_FROM, WIN_TO);

    expect(res.slots.length).toBeGreaterThan(0);
    const s = res.slots[0];
    expect(s).toHaveProperty('basis');
    expect(s).toHaveProperty('confidence');
    expect(s).not.toHaveProperty('status'); // structurellement distinct d'une réservation
    expect(s.confidence).toBeGreaterThan(0);
    expect(s.confidence).toBeLessThanOrEqual(1);
  });
});
