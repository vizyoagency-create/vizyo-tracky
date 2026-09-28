import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ChildSeatsService } from './child-seats.service';

/**
 * Sièges auto (2026-09-28) — un STOCK par société, deux types JAMAIS interchangeables.
 * Ces tests verrouillent ce qui a une conséquence réelle : un siège promis deux fois, un type
 * substitué à l'autre, une demande groupée comptée deux fois, un réglage hors périmètre.
 */
function makeUser(over: Record<string, unknown> = {}) {
  return { id: 'u1', role: UserRole.FLEET_ADMIN, fleetId: 'f1', ...over } as never;
}

function makePrisma(over: { stock?: { baby: number; child: number }; events?: unknown[] } = {}) {
  const stock = over.stock ?? { baby: 3, child: 4 };
  return {
    fleet: {
      findUnique: jest.fn().mockResolvedValue({ id: 'f1', childSeatsBaby: stock.baby, childSeatsChild: stock.child }),
      update: jest.fn().mockImplementation(({ data }: { data: { childSeatsBaby: number; childSeatsChild: number } }) =>
        Promise.resolve({ id: 'f1', childSeatsBaby: data.childSeatsBaby, childSeatsChild: data.childSeatsChild }),
      ),
    },
    vehicleEvent: {
      findMany: jest.fn().mockResolvedValue(over.events ?? []),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  } as never;
}

const START = new Date('2026-10-05T07:00:00Z');
const END = new Date('2026-10-05T10:00:00Z');

describe('ChildSeatsService — stock de sièges auto par société', () => {
  it('availability : stock − engagés, type par type, jamais négatif', async () => {
    const prisma = makePrisma({
      stock: { baby: 2, child: 3 },
      events: [
        { id: 'r1', metadata: { criteria: { childSeatsBaby: 1, childSeatsChild: 1 } } },
        { id: 'r2', metadata: { criteria: { childSeatsChild: 5 } } }, // plus que le stock : on ne descend pas sous zéro
      ],
    });
    const svc = new ChildSeatsService(prisma);
    const a = await svc.availability('f1', START, END);
    expect(a.stock).toEqual({ baby: 2, child: 3 });
    expect(a.engaged).toEqual({ baby: 1, child: 6 });
    expect(a.available).toEqual({ baby: 1, child: 0 });
  });

  it('engaged : une demande groupée (même bookingRef sur deux véhicules) porte son besoin UNE fois', async () => {
    const prisma = makePrisma({
      events: [
        { id: 'a', metadata: { bookingRef: 'g1', criteria: { childSeatsBaby: 2 } } },
        { id: 'b', metadata: { bookingRef: 'g1', criteria: { childSeatsBaby: 2 } } },
        { id: 'c', metadata: { criteria: { childSeatsBaby: 1 } } },
      ],
    });
    const svc = new ChildSeatsService(prisma);
    expect(await svc.engaged('f1', START, END)).toEqual({ baby: 3, child: 0 });
  });

  it('engaged : excludeBookingRef écarte les sœurs déjà validées (la 2ᵉ validation du groupe n’est pas refusée)', async () => {
    const prisma = makePrisma({
      stock: { baby: 2, child: 0 },
      events: [{ id: 'a', metadata: { bookingRef: 'g1', criteria: { childSeatsBaby: 2 } } }],
    });
    const svc = new ChildSeatsService(prisma);
    // Sans l'exclusion, le stock (2) serait entièrement engagé par la sœur déjà validée.
    await expect(svc.assertAvailable('f1', START, END, { baby: 2, child: 0 })).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.assertAvailable('f1', START, END, { baby: 2, child: 0 }, { excludeId: 'b', excludeBookingRef: 'g1' }),
    ).resolves.toBeUndefined();
  });

  it('engaged : les statuts occupants sont CONFIRMED/IN_PROGRESS, plus REQUESTED sur demande (flux public)', async () => {
    const prisma = makePrisma();
    const svc = new ChildSeatsService(prisma);
    await svc.engaged('f1', START, END);
    await svc.engaged('f1', START, END, { includeRequested: true });
    const calls = (prisma as unknown as { vehicleEvent: { findMany: jest.Mock } }).vehicleEvent.findMany.mock.calls;
    expect(calls[0][0].where.status.in).toEqual(['CONFIRMED', 'IN_PROGRESS']);
    expect(calls[1][0].where.status.in).toEqual(['CONFIRMED', 'IN_PROGRESS', 'REQUESTED']);
    // Chevauchement strict du créneau, et jamais une autre société.
    expect(calls[0][0].where).toMatchObject({ fleetId: 'f1', type: 'RESERVATION', startAt: { lt: END }, endAt: { gt: START } });
  });

  it('assertAvailable : aucun type ne remplace l’autre — 2 bébé demandés, 1 dispo → 409 même avec 4 enfant libres', async () => {
    const prisma = makePrisma({
      stock: { baby: 1, child: 4 },
    });
    const svc = new ChildSeatsService(prisma);
    await expect(svc.assertAvailable('f1', START, END, { baby: 2, child: 0 })).rejects.toThrow(/il manque 1 siège\(s\) « Bébé »/);
    // Le message nomme le type ET le compte : c'est ce que l'exploitant lit pour décider.
    await expect(svc.assertAvailable('f1', START, END, { baby: 2, child: 0 })).rejects.toThrow(/1 disponible\(s\) sur 1/);
  });

  it('assertAvailable : un besoin nul ne coûte aucune requête', async () => {
    const prisma = makePrisma();
    const svc = new ChildSeatsService(prisma);
    await svc.assertAvailable('f1', START, END, { baby: 0, child: 0 });
    expect((prisma as unknown as { fleet: { findUnique: jest.Mock } }).fleet.findUnique).not.toHaveBeenCalled();
    expect((prisma as unknown as { vehicleEvent: { findMany: jest.Mock } }).vehicleEvent.findMany).not.toHaveBeenCalled();
  });

  it('assertAvailable : stock jamais renseigné (0/0) → le message envoie vers Paramètres de l’agenda', async () => {
    const svc = new ChildSeatsService(makePrisma({ stock: { baby: 0, child: 0 } }));
    await expect(svc.assertAvailable('f1', START, END, { baby: 0, child: 1 })).rejects.toThrow(/Paramètres de l'agenda/);
  });

  it('setStock : entiers ≥ 0, plafonnés ; un non-super-admin ne règle que sa société', async () => {
    const prisma = makePrisma();
    const svc = new ChildSeatsService(prisma);
    const r = await svc.setStock(makeUser(), { baby: 2.9, child: 9999 });
    expect(r.stock).toEqual({ baby: 2, child: 500 });
    await expect(svc.setStock(makeUser(), { baby: -1, child: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setStock(makeUser(), { fleetId: 'fAUTRE', baby: 1, child: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getStock(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('needOf / criteresPropres : entiers sûrs, sans clé vide — c’est ce qui est écrit en base', () => {
    expect(ChildSeatsService.needOf({ childSeatsBaby: '2' as unknown as number, childSeatsChild: -3 })).toEqual({ baby: 2, child: 0 });
    expect(ChildSeatsService.needOf(undefined)).toEqual({ baby: 0, child: 0 });
    expect(ChildSeatsService.criteresPropres({ minSeats: 8, childSeatsBaby: 1, childSeatsChild: 0, requiredFeatures: ['clim', ''] })).toEqual({
      minSeats: 8,
      childSeatsBaby: 1,
      requiredFeatures: ['clim'],
    });
    expect(ChildSeatsService.criteresPropres({ minSeats: undefined })).toBeNull();
  });
});
