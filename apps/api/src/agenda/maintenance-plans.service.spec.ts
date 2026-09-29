import { UserRole } from '@prisma/client';
import { MaintenancePlansService } from './maintenance-plans.service';

/**
 * ── PLANS D'ENTRETIEN : LE JOURNAL MÉTIER (29/09) ─────────────────────────────────────────────
 *
 * Créer, modifier, supprimer un plan, ou déclarer un entretien fait, laisse une ligne
 * `plan_entretien_modifie` (catégorie AGENDA) au journal lu par le fil de la société. Verrouillé :
 * la société est celle du PLAN (un super-admin agit chez un client), l'auteur est l'utilisateur
 * réel, les dates du texte sont celles de PARIS, un enregistrement sans changement n'écrit rien, et
 * un journal absent ou en panne ne fait jamais échouer le geste.
 */
const superAdmin = () => ({ id: 'u-sa', role: UserRole.SUPER_ADMIN, fleetId: null }) as never;

function planRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pl1',
    fleetId: 'fCLIENT',
    vehicleId: 'v1',
    category: 'VIDANGE',
    label: 'Vidange',
    intervalMonths: 12,
    intervalKm: null,
    lastDoneAt: new Date('2026-01-10T10:00:00Z'),
    lastDoneKm: null,
    reminderDaysBefore: 30,
    reminderKmBefore: null,
    enabled: true,
    createdAt: new Date('2026-01-10T10:00:00Z'),
    updatedAt: new Date('2026-01-10T10:00:00Z'),
    ...over,
  };
}

function monter(opts: { plan?: ReturnType<typeof planRow>; journal?: { record: jest.Mock } | null; plaque?: jest.Mock } = {}) {
  const plan = opts.plan ?? planRow();
  const prisma = {
    maintenancePlan: {
      findUnique: jest.fn().mockResolvedValue(plan),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...planRow(), id: 'pl-neuf', ...data })),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...plan, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) })),
      delete: jest.fn().mockResolvedValue(plan),
    },
    vehicleEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    vehicle: { findUnique: opts.plaque ?? jest.fn().mockResolvedValue({ plate: 'AA-1' }) },
  };
  const events = {
    // La société est DÉRIVÉE du véhicule (celle du client), jamais de l'utilisateur.
    assertVehicleAccess: jest.fn().mockResolvedValue('fCLIENT'),
    maybeUpdateOdometer: jest.fn().mockResolvedValue(undefined),
  };
  const journal = opts.journal === null ? undefined : (opts.journal ?? { record: jest.fn() });
  const svc = new MaintenancePlansService(prisma as never, events as never, journal as never);
  return { svc, prisma, events, journal: journal as { record: jest.Mock } };
}

const base = { vehicleId: 'v1', category: 'VIDANGE', label: 'Vidange', intervalMonths: 12, lastDoneAt: '2026-01-10T10:00:00Z' } as never;

describe('MaintenancePlansService — journal métier (29/09)', () => {
  it('créer → plan_entretien_modifie (opération « cree »), société du VÉHICULE, auteur réel, plaque, échéance en date de Paris', async () => {
    const { svc, journal } = monter();

    await svc.upsert(superAdmin(), null, base);

    expect(journal.record).toHaveBeenCalledTimes(1);
    const l = journal.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({
      category: 'AGENDA', action: 'plan_entretien_modifie', actor: 'utilisateur', target: 'AA-1', fleetId: 'fCLIENT', triggeredByUserId: 'u-sa',
    }));
    expect(l.meta).toEqual(expect.objectContaining({ planId: 'pl-neuf', vehicleId: 'v1', operation: 'cree' }));
    expect(l.detail).toContain('Plan d\'entretien « Vidange » créé — tous les 12 mois');
    expect(l.detail).toContain('prochaine échéance le 10/01/2027');
  });

  it('modifier → seuls les champs changés, « avant → après » ; un enregistrement sans changement n’écrit rien', async () => {
    const { svc, journal } = monter();

    await svc.upsert(superAdmin(), 'pl1', { ...(base as object), intervalMonths: 6 } as never);
    const l = journal.record.mock.calls[0][0];
    expect(l.meta.operation).toBe('modifie');
    expect(l.fleetId).toBe('fCLIENT');
    expect(l.detail).toContain('rythme tous les 12 mois → tous les 6 mois');
    expect(l.detail).not.toContain('nom');
    expect(l.meta.avant).toEqual(expect.objectContaining({ intervalMonths: 12 }));
    expect(l.meta.apres).toEqual(expect.objectContaining({ intervalMonths: 6 }));

    journal.record.mockClear();
    await svc.upsert(superAdmin(), 'pl1', base);
    expect(journal.record).not.toHaveBeenCalled();
  });

  it('supprimer → opération « supprime », société du plan', async () => {
    const { svc, journal, prisma } = monter();

    await svc.remove(superAdmin(), 'pl1');

    expect(prisma.maintenancePlan.delete).toHaveBeenCalled();
    const l = journal.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({ action: 'plan_entretien_modifie', fleetId: 'fCLIENT', triggeredByUserId: 'u-sa' }));
    expect(l.meta.operation).toBe('supprime');
    expect(l.detail).toContain('« Vidange » supprimé');
  });

  it('« fait » → opération « fait », la date du JOUR DE PARIS (30/09 22:30Z = 01/10 à Paris), le kilométrage', async () => {
    const { svc, journal } = monter();

    await svc.recordDone(superAdmin(), 'pl1', { doneAt: '2026-09-30T22:30:00Z', doneKm: 45200 } as never);

    const l = journal.record.mock.calls[0][0];
    expect(l.meta.operation).toBe('fait');
    expect(l.fleetId).toBe('fCLIENT');
    expect(l.detail).toContain('Entretien « Vidange » fait le 01/10/2026');
    expect(l.detail).not.toContain('30/09/2026');
    expect(l.detail).toMatch(/45\s?200 km/);
  });

  it('plaque illisible : la ligne part sans plaque, le geste passe', async () => {
    const { svc, journal } = monter({ plaque: jest.fn().mockRejectedValue(new Error('base indisponible')) });

    await expect(svc.remove(superAdmin(), 'pl1')).resolves.toEqual({ ok: true });
    expect(journal.record.mock.calls[0][0].target).toBeNull();
  });

  it('journal EN PANNE (record lève) ou ABSENT : créer, modifier, supprimer et « fait » passent', async () => {
    for (const journal of [{ record: jest.fn(() => { throw new Error('journal HS'); }) }, null]) {
      const { svc } = monter({ journal });
      await expect(svc.upsert(superAdmin(), null, base)).resolves.toMatchObject({ label: 'Vidange' });
      await expect(svc.upsert(superAdmin(), 'pl1', { ...(base as object), intervalMonths: 6 } as never)).resolves.toMatchObject({ intervalMonths: 6 });
      await expect(svc.recordDone(superAdmin(), 'pl1', {} as never)).resolves.toMatchObject({ id: 'pl1' });
      await expect(svc.remove(superAdmin(), 'pl1')).resolves.toEqual({ ok: true });
    }
  });
});
