import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ChildSeatsService } from './child-seats.service';

/**
 * Sièges auto (2026-09-28) — possédés par la société, INSTALLÉS dans un véhicule ou en STOCK, deux
 * types JAMAIS interchangeables, et une politique : le stock complète-t-il un véhicule non équipé ?
 * Ces tests verrouillent ce qui a une conséquence réelle : un siège promis deux fois, un type
 * substitué à l'autre, une demande groupée comptée deux fois, un total réduit sous ce qui est à
 * bord, un réglage hors périmètre.
 */
function makeUser(over: Record<string, unknown> = {}) {
  return { id: 'u1', role: UserRole.FLEET_ADMIN, fleetId: 'f1', ...over } as never;
}

type Veh = { id: string; plate?: string; fleetId?: string; childSeatsBaby: number; childSeatsChild: number; outOfServiceReason?: string | null };

function makePrisma(over: {
  total?: { baby: number; child: number };
  policy?: 'STOCK_OR_INSTALLED' | 'INSTALLED_ONLY';
  vehicles?: Veh[];
  events?: unknown[];
} = {}) {
  const total = over.total ?? { baby: 3, child: 4 };
  const vehicles: Veh[] = over.vehicles ?? [];
  const fleet = { id: 'f1', childSeatsBaby: total.baby, childSeatsChild: total.child, childSeatPolicy: over.policy ?? 'STOCK_OR_INSTALLED' };
  const sum = () => ({
    _sum: {
      childSeatsBaby: vehicles.reduce((s, v) => s + v.childSeatsBaby, 0),
      childSeatsChild: vehicles.reduce((s, v) => s + v.childSeatsChild, 0),
    },
  });
  return {
    fleet: {
      findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...fleet })),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(fleet, data);
        return Promise.resolve({ ...fleet });
      }),
    },
    vehicle: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(vehicles.map((v) => ({ plate: v.id.toUpperCase(), outOfServiceReason: null, fleetId: 'f1', ...v })))),
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const v = vehicles.find((x) => x.id === where.id);
        return Promise.resolve(v ? { plate: v.id.toUpperCase(), fleetId: 'f1', ...v } : null);
      }),
      aggregate: jest.fn().mockImplementation(() => Promise.resolve(sum())),
      update: jest.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, number> }) => {
        const v = vehicles.find((x) => x.id === where.id);
        if (v) Object.assign(v, data);
        return Promise.resolve(v);
      }),
    },
    vehicleEvent: {
      findMany: jest.fn().mockResolvedValue(over.events ?? []),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  } as never;
}

const START = new Date('2026-10-05T07:00:00Z');
const END = new Date('2026-10-05T10:00:00Z');
const aBord = (baby: number, child: number) => ({ vehicle: { childSeatsBaby: baby, childSeatsChild: child } });

describe('ChildSeatsService — possédés, installés, stock, politique', () => {
  it('summary : stock = possédés − installés, équipés en premier', async () => {
    const svc = new ChildSeatsService(makePrisma({
      total: { baby: 3, child: 4 },
      vehicles: [
        { id: 'a', childSeatsBaby: 0, childSeatsChild: 0 },
        { id: 'b', childSeatsBaby: 1, childSeatsChild: 2 },
      ],
    }));
    const s = await svc.summary('f1');
    expect(s.total).toEqual({ baby: 3, child: 4 });
    expect(s.installed).toEqual({ baby: 1, child: 2 });
    expect(s.stock).toEqual({ baby: 2, child: 2 });
    expect(s.vehicles.map((v) => v.vehicleId)).toEqual(['b', 'a']);
    expect(s.policy).toBe('STOCK_OR_INSTALLED');
  });

  it('availability : engagés = besoin − sièges à bord de LEUR véhicule ; disponible = stock − engagés, jamais négatif', async () => {
    const prisma = makePrisma({
      total: { baby: 2, child: 3 },
      vehicles: [{ id: 'x', childSeatsBaby: 1, childSeatsChild: 0 }],
      events: [
        // Besoin 1/1 sur un véhicule qui a 1 bébé à bord : ne prend que 1 enfant au stock.
        { id: 'r1', metadata: { criteria: { childSeatsBaby: 1, childSeatsChild: 1 } }, ...aBord(1, 0) },
        // Besoin 0/5 sans rien à bord : plus que le stock — on ne descend pas sous zéro.
        { id: 'r2', metadata: { criteria: { childSeatsChild: 5 } }, ...aBord(0, 0) },
      ],
    });
    const svc = new ChildSeatsService(prisma);
    const a = await svc.availability('f1', START, END);
    expect(a.installed).toEqual({ baby: 1, child: 0 });
    expect(a.stock).toEqual({ baby: 1, child: 3 });
    expect(a.engaged).toEqual({ baby: 0, child: 6 });
    expect(a.available).toEqual({ baby: 1, child: 0 });
  });

  it('engaged : une demande groupée (même bookingRef) porte UN besoin contre la SOMME des sièges à bord de ses véhicules', async () => {
    const svc = new ChildSeatsService(makePrisma({
      events: [
        { id: 'a', metadata: { bookingRef: 'g1', criteria: { childSeatsBaby: 2 } }, ...aBord(1, 0) },
        { id: 'b', metadata: { bookingRef: 'g1', criteria: { childSeatsBaby: 2 } }, ...aBord(1, 0) },
        { id: 'c', metadata: { criteria: { childSeatsBaby: 1 } }, ...aBord(0, 0) },
      ],
    }));
    // g1 : besoin 2, à bord 1 + 1 = 2 → rien au stock ; c : 1 au stock.
    expect(await svc.engaged('f1', START, END)).toEqual({ baby: 1, child: 0 });
  });

  it('engaged : excludeBookingRef écarte les sœurs déjà validées (la 2ᵉ validation du groupe n’est pas refusée)', async () => {
    const svc = new ChildSeatsService(makePrisma({
      total: { baby: 2, child: 0 },
      events: [{ id: 'a', metadata: { bookingRef: 'g1', criteria: { childSeatsBaby: 2 } }, ...aBord(0, 0) }],
    }));
    await expect(svc.assertAvailable('f1', START, END, { baby: 2, child: 0 })).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.assertAvailable('f1', START, END, { baby: 2, child: 0 }, { excludeId: 'b', excludeBookingRef: 'g1' }),
    ).resolves.toBeUndefined();
  });

  it('engaged : statuts occupants CONFIRMED/IN_PROGRESS, plus REQUESTED sur demande (flux public)', async () => {
    const prisma = makePrisma();
    const svc = new ChildSeatsService(prisma);
    await svc.engaged('f1', START, END);
    await svc.engaged('f1', START, END, { includeRequested: true });
    const calls = (prisma as unknown as { vehicleEvent: { findMany: jest.Mock } }).vehicleEvent.findMany.mock.calls;
    expect(calls[0][0].where.status.in).toEqual(['CONFIRMED', 'IN_PROGRESS']);
    expect(calls[1][0].where.status.in).toEqual(['CONFIRMED', 'IN_PROGRESS', 'REQUESTED']);
    expect(calls[0][0].where).toMatchObject({ fleetId: 'f1', type: 'RESERVATION', startAt: { lt: END }, endAt: { gt: START } });
  });

  it('assertAvailable : les sièges À BORD du véhicule visé couvrent d’abord, le stock fournit le reste', async () => {
    const svc = new ChildSeatsService(makePrisma({
      total: { baby: 2, child: 2 },
      vehicles: [{ id: 'v1', childSeatsBaby: 1, childSeatsChild: 2 }], // stock : 1 bébé, 0 enfant
    }));
    // Besoin 2 bébé / 2 enfant sur v1 : 1 bébé + 2 enfant à bord, 1 bébé au stock (il en reste 1) → passe.
    await expect(svc.assertAvailable('f1', START, END, { baby: 2, child: 2 }, { vehicleId: 'v1' })).resolves.toBeUndefined();
    // Même besoin sur un véhicule vide : 2 bébé au stock (1 dispo) et 2 enfant (0 dispo) → refusé, les deux nommés.
    await expect(svc.assertAvailable('f1', START, END, { baby: 2, child: 2 }, { installed: { baby: 0, child: 0 } }))
      .rejects.toThrow(/1 siège\(s\) « Bébé » \(0 à bord, 1 disponible\(s\) en stock sur 1\) et 2 siège\(s\) « Enfant »/);
  });

  it('assertAvailable : aucun type ne remplace l’autre — 1 bébé manquant reste manquant avec 4 enfant libres', async () => {
    const svc = new ChildSeatsService(makePrisma({ total: { baby: 1, child: 4 } }));
    await expect(svc.assertAvailable('f1', START, END, { baby: 2, child: 0 }, { installed: { baby: 0, child: 0 } }))
      .rejects.toThrow(/il manque 1 siège\(s\) « Bébé »/);
  });

  it('assertAvailable : sous INSTALLED_ONLY, le stock n’est jamais promis — tout doit être à bord', async () => {
    const svc = new ChildSeatsService(makePrisma({
      total: { baby: 5, child: 5 },
      policy: 'INSTALLED_ONLY',
      vehicles: [{ id: 'v1', childSeatsBaby: 1, childSeatsChild: 0 }],
    }));
    await expect(svc.assertAvailable('f1', START, END, { baby: 1, child: 0 }, { vehicleId: 'v1' })).resolves.toBeUndefined();
    await expect(svc.assertAvailable('f1', START, END, { baby: 1, child: 1 }, { vehicleId: 'v1' }))
      .rejects.toThrow(/1 siège\(s\) « Enfant » \(0 à bord\).*Sièges installés seulement/);
  });

  it('assertAvailable : un besoin nul ne coûte aucune requête', async () => {
    const prisma = makePrisma();
    const svc = new ChildSeatsService(prisma);
    await svc.assertAvailable('f1', START, END, { baby: 0, child: 0 });
    expect((prisma as unknown as { fleet: { findUnique: jest.Mock } }).fleet.findUnique).not.toHaveBeenCalled();
    expect((prisma as unknown as { vehicleEvent: { findMany: jest.Mock } }).vehicleEvent.findMany).not.toHaveBeenCalled();
  });

  it('assertAvailable : rien de possédé (0/0) → le message envoie vers Paramètres de l’agenda', async () => {
    const svc = new ChildSeatsService(makePrisma({ total: { baby: 0, child: 0 } }));
    await expect(svc.assertAvailable('f1', START, END, { baby: 0, child: 1 })).rejects.toThrow(/Paramètres de l'agenda/);
  });

  it('setStock : entiers ≥ 0 plafonnés, politique validée, refus sous ce qui est installé, périmètre', async () => {
    const prisma = makePrisma({ total: { baby: 3, child: 4 }, vehicles: [{ id: 'v1', childSeatsBaby: 2, childSeatsChild: 0 }] });
    const svc = new ChildSeatsService(prisma);
    const r = await svc.setStock(makeUser(), { baby: 2.9, child: 9999, policy: 'INSTALLED_ONLY' });
    expect(r.total).toEqual({ baby: 2, child: 500 });
    expect(r.policy).toBe('INSTALLED_ONLY');
    await expect(svc.setStock(makeUser(), { baby: 1, child: 0 })).rejects.toThrow(/2 siège\(s\) « Bébé ».*installés dans des véhicules/);
    await expect(svc.setStock(makeUser(), { baby: -1, child: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setStock(makeUser(), { baby: 2, child: 0, policy: 'N_IMPORTE_QUOI' as never })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setStock(makeUser(), { fleetId: 'fAUTRE', baby: 1, child: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getStock(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setVehicleSeats : écrit à bord, et RELÈVE le total possédé s’il est dépassé (jamais un refus ici)', async () => {
    const prisma = makePrisma({ total: { baby: 0, child: 1 }, vehicles: [{ id: 'v1', childSeatsBaby: 0, childSeatsChild: 0 }] });
    const svc = new ChildSeatsService(prisma);
    const r = await svc.setVehicleSeats(makeUser(), 'v1', { baby: 2, child: 1 });
    expect(r.installed).toEqual({ baby: 2, child: 1 });
    expect(r.total).toEqual({ baby: 2, child: 1 }); // bébé relevé de 0 à 2 ; enfant déjà suffisant
    expect(r.stock).toEqual({ baby: 0, child: 0 });
    // Un véhicule d'une autre société : hors périmètre pour un non-super-admin.
    await expect(svc.setVehicleSeats(makeUser({ fleetId: 'fAUTRE' }), 'v1', { baby: 1, child: 0 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('helpers : needOf / fromStock / couvre / criteresPropres', () => {
    expect(ChildSeatsService.needOf({ childSeatsBaby: '2' as unknown as number, childSeatsChild: -3 })).toEqual({ baby: 2, child: 0 });
    expect(ChildSeatsService.fromStock({ baby: 2, child: 1 }, { baby: 1, child: 3 })).toEqual({ baby: 1, child: 0 });
    const avail = { policy: 'STOCK_OR_INSTALLED' as const, available: { baby: 1, child: 0 } };
    expect(ChildSeatsService.couvre(avail, { baby: 2, child: 1 }, { baby: 1, child: 1 })).toBe(true);
    expect(ChildSeatsService.couvre(avail, { baby: 2, child: 1 }, { baby: 0, child: 1 })).toBe(false);
    expect(ChildSeatsService.couvre({ ...avail, policy: 'INSTALLED_ONLY' }, { baby: 1, child: 0 }, { baby: 0, child: 0 })).toBe(false);
    expect(ChildSeatsService.couvre({ ...avail, policy: 'INSTALLED_ONLY' }, { baby: 1, child: 0 }, { baby: 1, child: 0 })).toBe(true);
    expect(ChildSeatsService.criteresPropres({ minSeats: 8, childSeatsBaby: 1, childSeatsChild: 0, requiredFeatures: ['clim', ''] })).toEqual({
      minSeats: 8,
      childSeatsBaby: 1,
      requiredFeatures: ['clim'],
    });
    expect(ChildSeatsService.criteresPropres({ minSeats: undefined })).toBeNull();
  });
});

/**
 * ── JOURNAL MÉTIER (29/09) ───────────────────────────────────────────────────────────────────
 *
 * Régler le stock, la politique ou les sièges à bord d'un véhicule laisse une ligne
 * `sieges_modifies` (catégorie AGENDA), « avant → après » type par type. La société est celle
 * RÉGLÉE (ou celle du véhicule) — jamais celle de l'utilisateur ; rien n'est écrit si rien ne
 * change ; un journal absent ou en panne ne fait jamais échouer le réglage.
 */
describe('ChildSeatsService — journal métier (29/09)', () => {
  const superAdmin = () => makeUser({ id: 'u-sa', role: UserRole.SUPER_ADMIN, fleetId: null });

  it('setStock : « possédés « Bébé » 3 → 2 », réglage avant → après, société RÉGLÉE, auteur réel', async () => {
    const journal = { record: jest.fn() };
    const svc = new ChildSeatsService(makePrisma({ total: { baby: 3, child: 4 } }), journal as never);

    await svc.setStock(superAdmin(), { fleetId: 'f1', baby: 2, child: 4, policy: 'INSTALLED_ONLY' });

    expect(journal.record).toHaveBeenCalledTimes(1);
    const l = journal.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({
      category: 'AGENDA', action: 'sieges_modifies', actor: 'utilisateur', fleetId: 'f1', triggeredByUserId: 'u-sa', target: null,
    }));
    expect(l.detail).toContain('possédés « Bébé » 3 → 2');
    expect(l.detail).not.toContain('« Enfant »'); // inchangé : pas dit
    expect(l.detail).toContain('« Sièges installés + stock » → « Sièges installés seulement »');
    expect(l.meta).toEqual(expect.objectContaining({
      avant: { total: { baby: 3, child: 4 }, policy: 'STOCK_OR_INSTALLED' },
      apres: { total: { baby: 2, child: 4 }, policy: 'INSTALLED_ONLY' },
    }));
  });

  it('setStock sans changement : aucune ligne', async () => {
    const journal = { record: jest.fn() };
    const svc = new ChildSeatsService(makePrisma({ total: { baby: 3, child: 4 } }), journal as never);

    await svc.setStock(makeUser(), { baby: 3, child: 4, policy: 'STOCK_OR_INSTALLED' });
    expect(journal.record).not.toHaveBeenCalled();
  });

  it('setVehicleSeats : plaque, « à bord » avant → après, le total RELEVÉ dit aussi ; société du VÉHICULE', async () => {
    const journal = { record: jest.fn() };
    const prisma = makePrisma({ total: { baby: 0, child: 1 }, vehicles: [{ id: 'v1', childSeatsBaby: 0, childSeatsChild: 0 }] });
    const svc = new ChildSeatsService(prisma, journal as never);

    await svc.setVehicleSeats(superAdmin(), 'v1', { baby: 2, child: 1 });

    const l = journal.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({ action: 'sieges_modifies', fleetId: 'f1', triggeredByUserId: 'u-sa', target: 'V1' }));
    expect(l.detail).toContain('Sièges auto à bord de V1');
    expect(l.detail).toContain('à bord « Bébé » 0 → 2');
    expect(l.detail).toContain('à bord « Enfant » 0 → 1');
    expect(l.detail).toContain('possédés (relevé) « Bébé » 0 → 2');
    expect(l.meta).toEqual(expect.objectContaining({ scope: 'vehicule', vehicleId: 'v1' }));
  });

  it('journal EN PANNE (record lève) ou ABSENT : les réglages passent', async () => {
    const enPanne = { record: jest.fn(() => { throw new Error('journal HS'); }) };
    for (const journal of [enPanne, undefined]) {
      const svc = new ChildSeatsService(
        makePrisma({ total: { baby: 3, child: 4 }, vehicles: [{ id: 'v1', childSeatsBaby: 0, childSeatsChild: 0 }] }),
        journal as never,
      );
      await expect(svc.setStock(makeUser(), { baby: 5, child: 5 })).resolves.toMatchObject({ total: { baby: 5, child: 5 } });
      await expect(svc.setVehicleSeats(makeUser(), 'v1', { baby: 1, child: 0 })).resolves.toMatchObject({ installed: { baby: 1, child: 0 } });
    }
    expect(enPanne.record).toHaveBeenCalledTimes(2);
  });
});
