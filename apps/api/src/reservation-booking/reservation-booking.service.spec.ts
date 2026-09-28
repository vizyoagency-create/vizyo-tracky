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
    // Lot 3b : le classement lit les réservations fermes pour repérer « engagé ailleurs ».
    vehicleEvent: { findMany: jest.fn().mockResolvedValue([]) },
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
/**
 * Notifieur mocké — DEUX méthodes, et c'est le sujet du correctif P0-1 : `sendAcknowledgment`
 * parle au DEMANDEUR, `notifyFleetOfPendingRequest` parle à ceux qui VALIDENT. La seconde
 * manquait, et avec elle tout avis côté société.
 */
const makeNotifier = () =>
  ({
    sendAcknowledgment: jest.fn().mockResolvedValue(undefined),
    notifyFleetOfPendingRequest: jest.fn().mockResolvedValue(1),
  }) as never;
const CONTACT = { requesterContact: 'ecole@test.fr' };
const veh = (id: string, seats: number | null) => ({ vehicleId: id, vehiclePlate: id.toUpperCase(), seats, childSeats: 0, features: [], utilizationRatio: 0, underutilized: true });

describe('ReservationBookingService (P4 — lien public)', () => {
  it('submitPublic : un seul véhicule assez grand suffit (sélection serveur greedy, created=1)', async () => {
    const reservations = makeReservations([veh('v1', 15), veh('v2', 5)]);
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier());
    const res = await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 11 });
    expect(res.created).toBe(1); // v1 (15) couvre 11 à lui seul
  });

  /**
   * P0-1 — LA SOCIÉTÉ EST PRÉVENUE. Le défaut mesuré le 22/09 : une demande publique partait en
   * base, le demandeur recevait « vous recevrez la confirmation dès sa validation », et AUCUN
   * canal ne prévenait qui que ce soit qu'il y avait quelque chose à valider.
   */
  it('submitPublic : prévient ceux qui valident, avec le demandeur et le nombre de véhicules', async () => {
    const notifier = makeNotifier() as unknown as { notifyFleetOfPendingRequest: jest.Mock };
    const svc = new ReservationBookingService(
      makePrisma(), makeReservations([veh('v1', 15)]), makeActivity(), notifier as never,
    );
    await svc.submitPublic('t', {
      ...futureSlot(), ...CONTACT, seatsNeeded: 11, requesterName: 'École Jean Jaurès',
    });
    expect(notifier.notifyFleetOfPendingRequest).toHaveBeenCalledTimes(1);
    expect(notifier.notifyFleetOfPendingRequest.mock.calls[0][0]).toMatchObject({
      requester: 'École Jean Jaurès',
      contact: 'ecole@test.fr',
      seats: 11,
      vehicleCount: 1,
    });
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

  /**
   * ── LOT 3B — ON CLASSE, ON N'EXCLUT PLUS (2026-09-23) ────────────────────────────────────────
   *
   * Ce test verrouillait l'EXCLUSION : un véhicule retenu par une proposition disparaissait du
   * vivier. Conséquence mesurée chez cdef31, où l'agent pré-remplissait 21 véhicules sur 30 :
   * une demande de conducteur était REFUSÉE alors que des voitures étaient libres. Une
   * suggestion de machine l'emportait sur une demande humaine.
   *
   * Le classement garde le bon réflexe — on préfère un véhicule que rien ne retient — mais
   * n'interdit plus le dernier recours.
   */
  it('submitPublic : PRÉFÈRE un véhicule libre de tout engagement à un véhicule pré-retenu', async () => {
    const prisma = makePrisma({
      agendaAgentProposal: { findMany: jest.fn().mockResolvedValue([{ id: 'p1', vehicleId: 'v1' }]) },
    });
    const reservations = makeReservations([veh('v1', 9), veh('v2', 5)]);
    const svc = new ReservationBookingService(prisma, reservations, makeActivity(), makeNotifier());
    // besoin 5 places : v1 (9 places) est plus gros, mais une proposition le retient → v2 d'abord.
    const res = await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 5 });
    expect(res.created).toBe(1);
    const requested = (reservations as unknown as { systemRequest: jest.Mock }).systemRequest.mock.calls.map((c) => c[0].vehicleId);
    expect(requested).toEqual(['v2']);
    // excludeRequested propagé à availableForFleet.
    expect((reservations as unknown as { availableForFleet: jest.Mock }).availableForFleet)
      .toHaveBeenCalledWith('f1', expect.any(String), expect.any(String), undefined, { excludeRequested: true });
  });

  /**
   * LE CAS QUI ÉTAIT REFUSÉ : tout le parc est pré-rempli par l'agent. La demande passe quand
   * même — et le déplacement est NOTÉ pour que le valideur le voie avant de cliquer.
   */
  it('submitPublic : parc entièrement pré-rempli → la demande PASSE, et le déplacement est noté', async () => {
    const prisma = makePrisma({
      agendaAgentProposal: { findMany: jest.fn().mockResolvedValue([{ id: 'p1', vehicleId: 'v1' }]) },
    });
    const reservations = makeReservations([veh('v1', 9)]); // le SEUL véhicule libre, et il est retenu
    const svc = new ReservationBookingService(prisma, reservations, makeActivity(), makeNotifier());
    const res = await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 5 });

    expect(res.created).toBe(1); // avant le lot 3b : BadRequestException « aucun véhicule »
    const appel = (reservations as unknown as { systemRequest: jest.Mock }).systemRequest.mock.calls[0][0];
    expect(appel.vehicleId).toBe('v1');
    expect(appel.metadata.deplaceePropositions).toEqual([{ proposalId: 'p1', plate: 'V1' }]);
  });

  /** Cas normal : rien n'est déplacé, donc la métadonnée n'existe même pas. */
  it('submitPublic : aucun déplacement → pas de métadonnée parasite', async () => {
    const reservations = makeReservations([veh('v1', 9)]);
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier());
    await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 5 });
    const appel = (reservations as unknown as { systemRequest: jest.Mock }).systemRequest.mock.calls[0][0];
    expect(appel.metadata).not.toHaveProperty('deplaceePropositions');
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
    expect(r.childSeatsBaby).toBeNull(); // la phrase n'en parle pas : null, pas 0
    expect(r.childSeatsChild).toBeNull();
  });

  // ─── Sièges auto (2026-09-28) : deux types, jamais confondus, jamais comptés comme des places ──

  it('parsePublic : « 6 places avec 2 sièges bébé et un rehausseur » → 6 places, 2 bébé, 1 enfant', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([]), makeActivity(), makeNotifier());
    const r = await svc.parsePublic('t', '6 places avec 2 sièges bébé et un rehausseur pour Albi lundi matin');
    expect(r.seatsNeeded).toBe(6); // « 2 sièges bébé » n'est PAS « 2 places »
    expect(r.childSeatsBaby).toBe(2);
    expect(r.childSeatsChild).toBe(1);
    expect(r.destination).toBe('Albi');
  });

  it('parsePublic : « 1 siège auto enfant » et « une coque » se rangent chacun dans leur type', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([]), makeActivity(), makeNotifier());
    const r = await svc.parsePublic('t', 'Il me faut une coque et 1 siège auto enfant, 4 personnes');
    expect(r.childSeatsBaby).toBe(1);
    expect(r.childSeatsChild).toBe(1);
    expect(r.seatsNeeded).toBe(4);
  });

  /** Stock mocké : ce qu'il reste sur le créneau, tel que le rend `ChildSeatsService.availability`. */
  const makeChildSeats = (available: { baby: number; child: number }, policy = 'STOCK_OR_INSTALLED') =>
    ({
      availability: jest.fn().mockResolvedValue({
        startAt: '', endAt: '', policy, total: { baby: 2, child: 4 }, installed: { baby: 0, child: 0 },
        stock: { baby: 2, child: 4 }, engaged: { baby: 0, child: 0 }, available,
      }),
    }) as never;

  it('submitPublic : le besoin de sièges entre dans les CRITÈRES du vivier (sièges à bord, puis stock)', async () => {
    const reservations = makeReservations([veh('v1', 9)]);
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier(), undefined, undefined, undefined, undefined, makeChildSeats({ baby: 2, child: 4 }));
    await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 3, childSeatsBaby: 1, childSeatsChild: 2 });
    const criteria = (reservations as unknown as { availableForFleet: jest.Mock }).availableForFleet.mock.calls[0][3];
    expect(criteria).toEqual({ childSeatsBaby: 1, childSeatsChild: 2 });
  });

  it('submitPublic : sièges demandés au-delà du stock → 400 qui nomme le TYPE, sans chiffre, et rien n\'est créé', async () => {
    const reservations = makeReservations([veh('v1', 9)]);
    const childSeats = makeChildSeats({ baby: 0, child: 4 });
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier(), undefined, undefined, undefined, undefined, childSeats);
    await expect(
      svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 3, childSeatsBaby: 1, childSeatsChild: 2 }),
    ).rejects.toThrow(/« Bébé »/);
    await expect(
      svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 3, childSeatsBaby: 1, childSeatsChild: 2 }),
    ).rejects.not.toThrow(/\d+ disponible/); // anti-sondage : pas de compte du stock via le lien public
    expect((reservations as unknown as { systemRequest: jest.Mock }).systemRequest).not.toHaveBeenCalled();
    // Les demandes en attente comptent aussi, et la combinaison est jugée avec ce que ses véhicules ont à bord.
    expect((childSeats as unknown as { availability: jest.Mock }).availability.mock.calls[0][3]).toEqual(
      expect.objectContaining({ includeRequested: true, installed: { baby: 0, child: 0 } }),
    );
  });

  it('submitPublic : une combinaison de deux véhicules additionne leurs sièges à bord avant de prendre au stock', async () => {
    // 11 places → v1 (9) + v2 (5). Besoin 2 bébé : 1 à bord de chacun → rien au stock (qui est vide).
    const equipe = (id: string, seats: number, baby: number) => ({ ...veh(id, seats), childSeatsInstalled: { baby, child: 0 }, childSeatsFromStock: { baby: Math.max(0, 2 - baby), child: 0 } });
    const reservations = makeReservations([equipe('v1', 9, 1), equipe('v2', 5, 1)]);
    const childSeats = makeChildSeats({ baby: 0, child: 0 });
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier(), undefined, undefined, undefined, undefined, childSeats);
    const res = await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 11, childSeatsBaby: 2 });
    expect(res.created).toBe(2);
    expect((childSeats as unknown as { availability: jest.Mock }).availability.mock.calls[0][3]).toEqual(
      expect.objectContaining({ installed: { baby: 2, child: 0 } }),
    );
  });

  it('submitPublic : sièges couverts → le besoin part dans `criteria` (metadata), dans l\'avis aux valideurs et dans l\'accusé', async () => {
    const reservations = makeReservations([veh('v1', 9)]);
    const notifier = makeNotifier();
    const svc = new ReservationBookingService(
      makePrisma(), reservations, makeActivity(), notifier, undefined, undefined, undefined, undefined, makeChildSeats({ baby: 2, child: 4 }),
    );
    const res = await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 3, childSeatsBaby: 1, childSeatsChild: 0 });
    expect(res.created).toBe(1);
    const meta = (reservations as unknown as { systemRequest: jest.Mock }).systemRequest.mock.calls[0][0].metadata;
    expect(meta.criteria).toEqual({ childSeatsBaby: 1 }); // pas de clé à zéro
    expect((notifier as unknown as { notifyFleetOfPendingRequest: jest.Mock }).notifyFleetOfPendingRequest.mock.calls[0][0].childSeats).toEqual({ baby: 1, child: 0 });
    expect((notifier as unknown as { sendAcknowledgment: jest.Mock }).sendAcknowledgment.mock.calls[0][0].childSeats).toEqual({ baby: 1, child: 0 });
  });

  it('submitPublic : sans champ de sièges, la phrase dictée fait foi ; un 0 explicite prime sur la phrase', async () => {
    const reservations = makeReservations([veh('v1', 9)]);
    const childSeats = makeChildSeats({ baby: 2, child: 4 });
    const svc = new ReservationBookingService(makePrisma(), reservations, makeActivity(), makeNotifier(), undefined, undefined, undefined, undefined, childSeats);
    await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 3, freeText: '3 places et deux sièges bébé' });
    const m1 = (reservations as unknown as { systemRequest: jest.Mock }).systemRequest.mock.calls[0][0].metadata;
    expect(m1.criteria).toEqual({ childSeatsBaby: 2 });
    await svc.submitPublic('t', { ...futureSlot(), ...CONTACT, seatsNeeded: 3, freeText: '3 places et deux sièges bébé', childSeatsBaby: 0, childSeatsChild: 0 });
    const m2 = (reservations as unknown as { systemRequest: jest.Mock }).systemRequest.mock.calls[1][0].metadata;
    expect(m2).not.toHaveProperty('criteria');
    // Sans besoin, le stock n'est même pas lu.
    expect((childSeats as unknown as { availability: jest.Mock }).availability).toHaveBeenCalledTimes(1);
  });

  it('createLink : super-admin sans fleetId -> 400', async () => {
    const svc = new ReservationBookingService(makePrisma(), makeReservations([]), makeActivity(), makeNotifier());
    await expect(
      svc.createLink({ id: 'u1', role: UserRole.SUPER_ADMIN, fleetId: null } as never, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
