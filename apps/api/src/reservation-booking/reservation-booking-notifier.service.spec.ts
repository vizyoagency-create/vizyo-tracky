import { ReservationBookingNotifier } from './reservation-booking-notifier.service';

const makeEmail = (ok = true) => ({ send: jest.fn().mockResolvedValue({ ok }) } as never);
const makeSms = (ok = true) => ({ send: jest.fn().mockResolvedValue({ ok }) } as never);
const makeErrors = () => ({ record: jest.fn().mockResolvedValue('log-1') } as never);

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
    const n = new ReservationBookingNotifier(email, sms, makeErrors());
    await n.onConfirmed(payload({ public: true, requesterContact: 'ecole@test.fr', destination: 'Carcassonne' }));
    expect((email as unknown as { send: jest.Mock }).send).toHaveBeenCalled();
    expect((sms as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('confirmation par SMS si le contact est un numéro', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors());
    await n.onConfirmed(payload({ public: true, requesterContact: '+33612345678' }));
    expect((sms as unknown as { send: jest.Mock }).send).toHaveBeenCalled();
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('réservation NON publique : aucune notification', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors());
    await n.onConfirmed(payload({ public: false, requesterContact: 'ecole@test.fr' }));
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
    expect((sms as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('échec d\'envoi -> journalisé dans le centre d\'alerte (source RESERVATION_BOOKING)', async () => {
    const errors = makeErrors();
    const n = new ReservationBookingNotifier(makeEmail(false), makeSms(), errors);
    await n.onConfirmed(payload({ public: true, requesterContact: 'ecole@test.fr' }));
    expect((errors as unknown as { record: jest.Mock }).record).toHaveBeenCalledWith(
      expect.stringContaining('Notification'),
      'RESERVATION_BOOKING',
      expect.any(Object),
    );
  });
});
