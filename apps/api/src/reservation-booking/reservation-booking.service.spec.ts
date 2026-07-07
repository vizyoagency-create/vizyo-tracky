import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ReservationBookingService } from './reservation-booking.service';

const DAY = 86_400_000;
const futureSlot = () => ({
  startAt: new Date(Date.now() + 2 * DAY).toISOString(),
  endAt: new Date(Date.now() + 2 * DAY + 2 * 3600_000).toISOString(),
});

function link(over: Record<string, unknown> = {}) {
  return {
    id: 'l1', fleetId: 'f1', token: 't', label: null, active: true, expiresAt: null,
    horizonDays: 30, leadHours: 2, openCount: 0, firstOpenedAt: null, lastOpenedAt: null,
    createdAt: new Date(), fleet: { name: 'CDEF' }, ...over,
  };
}
function makePrisma(over: Record<string, unknown> = {}) {
  return {
    reservationBookingLink: {
      findUnique: jest.fn().mockResolvedValue(link()),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
    },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
    fleet: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', name: 'CDEF' }) },
    agendaAgentProposal: { findMany: jest.fn().mockResolvedValue([]) },
    ...over,
  } as never;
}
function makeReservations(vehicles: unknown[]) {
  return {
    availableForFleet: jest.fn().mockResolvedValue({ startAt: '', endAt: '', vehicles, excludedUnknownCapacity: 0, excludedImmobilized: 0 }),
    systemRequest: jest.fn().mockResolvedValue({ id: 'ev' }),
  } as never;
}
const makeActivity = () => ({ record: jest.fn() } as never);
const makeNotifier = () => ({ sendAcknowledgment: jest.fn().mockResolvedValue(undefined) } as never);
const CONTACT = { requesterContact: 'ecole@test.fr' };
const veh = (id: string, seats: number | null) => ({ vehicleId: id, vehiclePlate: id.toUpperCase(), seats, childSeats: 0, features: [], utilizationRatio: 0, underutilized: true });

describe('ReservationBookingService (P4 — lien public)', () => {
  it('suggestPublic : combine des véhicules pour couvrir 11 places (9 + 5)', async () => {
    const reservations = makeReservations([veh('v1', 9), veh('v2', 5), veh('v3', 4)]);
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier());
    const res = await svc.suggestPublic('t', { ...futureSlot(), seatsNeeded: 11 });
    expect(res.covered).toBe(true);
    expect(res.totalSeats).toBeGreaterThanOrEqual(11);
    expect(res.combination.length).toBe(2); // 9 + 5
  });

  it('suggestPublic : un seul véhicule suffit s\'il est assez grand', async () => {
    const reservations = makeReservations([veh('v1', 15), veh('v2', 5)]);
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier());
    const res = await svc.suggestPublic('t', { ...futureSlot(), seatsNeeded: 11 });
    expect(res.combination.map((v) => v.vehicleId)).toEqual(['v1']);
    expect(res.covered).toBe(true);
  });

  it('suggestPublic : extrait places + destination du texte libre', async () => {
    const reservations = makeReservations([veh('v1', 15)]);
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier());
    const res = await svc.suggestPublic('t', { ...futureSlot(), freeText: "j'ai besoin de 11 places pour Carcassonne" });
    expect(res.seatsNeeded).toBe(11);
    expect(res.destination).toBe('Carcassonne');
  });

  it('submitPublic : sans contact (e-mail/téléphone) -> 400', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([]), makeActivity(), makeNotifier());
    await expect(
      svc.submitPublic('t', { ...futureSlot(), vehicleIds: ['v1'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('submitPublic : véhicule hors société du lien -> 400 (anti-tamper)', async () => {
    const prisma = makePrisma({ vehicle: { findMany: jest.fn().mockResolvedValue([]) } });
    const svc = new ReservationBookingService(prisma, makeReservations([]), makeActivity(), makeNotifier());
    await expect(
      svc.submitPublic('t', { ...futureSlot(), ...CONTACT, vehicleIds: ['vX'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('submitPublic : crée une demande REQUESTED par véhicule valide + accuse réception', async () => {
    const prisma = makePrisma({ vehicle: { findMany: jest.fn().mockResolvedValue([{ id: 'v1' }, { id: 'v2' }]) } });
    const reservations = makeReservations([]);
    const notifier = makeNotifier();
    const svc = new ReservationBookingService(prisma, reservations, makeActivity(), notifier);
    const res = await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, vehicleIds: ['v1', 'v2'], requesterName: 'Jean' });
    expect(res.created).toBe(2);
    expect((reservations as unknown as { systemRequest: jest.Mock }).systemRequest).toHaveBeenCalledTimes(2);
    expect((notifier as unknown as { sendAcknowledgment: jest.Mock }).sendAcknowledgment).toHaveBeenCalled();
  });

  it('suggestPublic : exclut les véhicules retenus par une proposition IA en attente', async () => {
    const prisma = makePrisma({ agendaAgentProposal: { findMany: jest.fn().mockResolvedValue([{ vehicleId: 'v1' }]) } });
    const reservations = makeReservations([veh('v1', 9), veh('v2', 5)]);
    const svc = new ReservationBookingService(prisma, reservations, makeActivity(), makeNotifier());
    const res = await svc.suggestPublic('t', { ...futureSlot(), seatsNeeded: 5 });
    // v1 est écarté (proposé par l'agent) → seul v2 reste proposable/alternatif.
    const all = [...res.combination, ...res.alternatives].map((v) => v.vehicleId);
    expect(all).not.toContain('v1');
    expect(all).toContain('v2');
    // excludeRequested propagé à availableForFleet.
    expect((reservations as unknown as { availableForFleet: jest.Mock }).availableForFleet)
      .toHaveBeenCalledWith('f1', expect.any(String), expect.any(String), undefined, { excludeRequested: true });
  });

  it('createLink : super-admin sans fleetId -> 400', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([]), makeActivity(), makeNotifier());
    await expect(
      svc.createLink({ id: 'u1', role: UserRole.SUPER_ADMIN, fleetId: null } as never, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
