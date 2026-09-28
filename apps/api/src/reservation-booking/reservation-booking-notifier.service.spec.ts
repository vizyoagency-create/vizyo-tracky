import { ReservationBookingNotifier } from './reservation-booking-notifier.service';

const built = { subject: 's', html: 'h', text: 't' };
const makeEmail = (ok = true) => ({
  send: jest.fn().mockResolvedValue({ ok }),
  buildReservationRequestedEmail: jest.fn().mockReturnValue(built),
  buildReservationConfirmedEmail: jest.fn().mockReturnValue(built),
  buildReservationRefusedEmail: jest.fn().mockReturnValue(built),
} as never);
const makeSms = (ok = true) => ({ send: jest.fn().mockResolvedValue({ ok }) } as never);
const makeErrors = () => ({ record: jest.fn().mockResolvedValue('log-1') } as never);
const makePrisma = () => ({ fleet: { findUnique: jest.fn().mockResolvedValue({ name: 'CDEF' }) } } as never);
/**
 * Qui peut valider / qui est prevenu. INERTE ici : ces tests portent sur la notification AU
 * DEMANDEUR (accuse de reception, confirmation), pas sur l'avis aux valideurs. Une liste vide
 * est donc l'etat juste — et si un jour un test de cette suite touchait `notifyFleetOf…`, il
 * faudrait la remplir, ce que le vide rendra evident.
 */
const makeDestinataires = () => ({ possibles: jest.fn().mockResolvedValue([]), notifies: jest.fn().mockResolvedValue([]) } as never);

const payload = (metadata: Record<string, unknown>) => ({
  fleetId: 'f1',
  vehiclePlate: 'AA-1',
  startAt: new Date(Date.now() + 86_400_000).toISOString(),
  endAt: new Date(Date.now() + 86_400_000 + 3600_000).toISOString(),
  metadata,
});

describe('ReservationBookingNotifier (P4 — notifications demandeur)', () => {
  it('confirmation par E-MAIL si le contact contient « @ »', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires());
    await n.onConfirmed(payload({ public: true, requesterContact: 'ecole@test.fr', destination: 'Carcassonne' }));
    expect((email as unknown as { send: jest.Mock }).send).toHaveBeenCalled();
    expect((sms as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('confirmation par SMS si le contact est un numéro', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires());
    await n.onConfirmed(payload({ public: true, requesterContact: '+33612345678' }));
    expect((sms as unknown as { send: jest.Mock }).send).toHaveBeenCalled();
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('réservation NON publique : aucune notification', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires());
    await n.onConfirmed(payload({ public: false, requesterContact: 'ecole@test.fr' }));
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
    expect((sms as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  /**
   * F16 (recette du 28/09) : le demandeur apprenait la validation, jamais le refus — il attendait
   * un véhicule qui ne viendrait pas. Le refus prévient, sous son propre modèle.
   */
  it('REFUS d\'une demande publique : le demandeur est prévenu sous le modèle reservation_refused', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires());
    await n.onRefused(payload({ public: true, requesterContact: 'ecole@test.fr', destination: 'Albi' }));
    const send = (email as unknown as { send: jest.Mock }).send;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ecole@test.fr', template: 'reservation_refused' }));
    expect((email as unknown as { buildReservationRefusedEmail: jest.Mock }).buildReservationRefusedEmail)
      .toHaveBeenCalledWith(expect.objectContaining({ destination: 'Albi' }));
  });

  it('REFUS d\'une réservation NON publique (saisie interne) : personne à prévenir', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires());
    await n.onRefused(payload({ public: false, requesterContact: 'ecole@test.fr' }));
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
    expect((sms as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('échec d\'envoi -> journalisé dans le centre d\'alerte (source RESERVATION_BOOKING)', async () => {
    const errors = makeErrors();
    const n = new ReservationBookingNotifier(makeEmail(false), makeSms(), errors, makePrisma(), makeDestinataires());
    await n.onConfirmed(payload({ public: true, requesterContact: 'ecole@test.fr' }));
    expect((errors as unknown as { record: jest.Mock }).record).toHaveBeenCalledWith(
      expect.stringContaining('Notification'),
      'RESERVATION_BOOKING',
      expect.any(Object),
    );
  });
});
