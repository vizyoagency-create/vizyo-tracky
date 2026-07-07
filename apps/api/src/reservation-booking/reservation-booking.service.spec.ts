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
  it('submitPublic : un seul véhicule assez grand suffit (sélection serveur greedy, created=1)', async () => {
    const reservations = makeReservations([veh('v1', 15), veh('v2', 5)]);
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier());
    const res = await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 11 });
    expect(res.created).toBe(1); // v1 (15) couvre 11 à lui seul
  });

  it('submitPublic : sans contact (e-mail/téléphone) -> 400', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([veh('v1', 9)]), makeActivity(), makeNotifier());
    await expect(
      svc.submitPublic('t', { ...futureSlot(), seatsNeeded: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('submitPublic : #4 aucun véhicule dispo pour le besoin -> 400 (le demandeur ne voit rien)', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([]), makeActivity(), makeNotifier());
    await expect(
      svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('submitPublic : #4 sélectionne le(s) véhicule(s) CÔTÉ SERVEUR (sans vehicleIds client) + crée REQUESTED + accuse réception', async () => {
    // 11 places → combinaison serveur 9+5 = 2 véhicules ; le demandeur n'a envoyé AUCUN véhicule.
    const reservations = makeReservations([veh('v1', 9), veh('v2', 5)]);
    const notifier = makeNotifier();
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), notifier);
    const res = await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 11, requesterName: 'Jean' });
    expect(res.created).toBe(2);
    expect((reservations as unknown as { systemRequest: jest.Mock }).systemRequest).toHaveBeenCalledTimes(2);
    expect((notifier as unknown as { sendAcknowledgment: jest.Mock }).sendAcknowledgment).toHaveBeenCalled();
  });

  it('submitPublic : exclut les véhicules retenus par une proposition IA en attente (sélection serveur)', async () => {
    const prisma = makePrisma({ agendaAgentProposal: { findMany: jest.fn().mockResolvedValue([{ vehicleId: 'v1' }]) } });
    const reservations = makeReservations([veh('v1', 9), veh('v2', 5)]);
    const svc = new ReservationBookingService(prisma, reservations, makeActivity(), makeNotifier());
    // besoin 5 places : v1 (9) est tenu par l'agent → le serveur retient v2 (5), jamais v1.
    const res = await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 5 });
    expect(res.created).toBe(1);
    const requested = (reservations as unknown as { systemRequest: jest.Mock }).systemRequest.mock.calls.map((c) => c[0].vehicleId);
    expect(requested).toEqual(['v2']); // v1 exclu
    // excludeRequested propagé à availableForFleet.
    expect((reservations as unknown as { availableForFleet: jest.Mock }).availableForFleet)
      .toHaveBeenCalledWith('f1', expect.any(String), expect.any(String), undefined, { excludeRequested: true });
  });

  it('submitPublic : #4 véhicules libres SANS places renseignées -> message « capacité non renseignée » (pas « créneau »)', async () => {
    const reservations = makeReservations([veh('v1', null), veh('v2', null)]); // libres mais capacité inconnue
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier());
    await expect(svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 5 }))
      .rejects.toThrow(/capacité/i);
  });

  it('parsePublic : extrait places + destination + créneau (déterministe) du texte dicté', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([]), makeActivity(), makeNotifier());
    const r = await svc.parsePublic('t', '11 places pour Carcassonne demain de 9h à 17h');
    expect(r.seatsNeeded).toBe(11);
    expect(r.destination).toBe('Carcassonne');
    expect(r.startAt).not.toBeNull();
    expect(r.endAt).not.toBeNull();
    expect(new Date(r.startAt as string).getTime()).toBeLessThan(new Date(r.endAt as string).getTime());
  });

  it('parsePublic : sans créneau explicite -> startAt/endAt null', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([]), makeActivity(), makeNotifier());
    const r = await svc.parsePublic('t', '5 places pour Toulouse');
    expect(r.seatsNeeded).toBe(5);
    expect(r.destination).toBe('Toulouse');
    expect(r.startAt).toBeNull();
    expect(r.endAt).toBeNull();
  });

  it('createLink : super-admin sans fleetId -> 400', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([]), makeActivity(), makeNotifier());
    await expect(
      svc.createLink({ id: 'u1', role: UserRole.SUPER_ADMIN, fleetId: null } as never, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
