import { EmailService } from '../email/email.service';
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
const makePrisma = (freres: { status: string; vehicle?: { plate: string } }[] = []) => ({
  fleet: { findUnique: jest.fn().mockResolvedValue({ name: 'CDEF' }) },
  vehicleEvent: { findMany: jest.fn().mockResolvedValue(freres) },
} as never);
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

  /**
   * F13 (recette prod du 28/09) : une demande de 11 places tient sur deux véhicules (même
   * bookingRef) — le demandeur recevait DEUX refus. Un seul courriel, à la dernière décision.
   */
  it('groupe : tant qu\'un frère est encore EN ATTENTE, ni refus ni confirmation ne partent', async () => {
    const email = makeEmail(); const sms = makeSms();
    const prisma = makePrisma([{ status: 'CANCELLED' }, { status: 'REQUESTED' }]);
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), prisma, makeDestinataires());
    await n.onRefused(payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }));
    await n.onConfirmed(payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }));
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('groupe : à la DERNIÈRE décision, un seul courriel — la confirmation nomme tous les véhicules retenus', async () => {
    const email = makeEmail(); const sms = makeSms();
    const prisma = makePrisma([{ status: 'CONFIRMED', vehicle: { plate: 'AA-1' } }, { status: 'CONFIRMED', vehicle: { plate: 'BB-2' } }]);
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), prisma, makeDestinataires());
    await n.onConfirmed(payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }));
    expect((email as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1);
    expect((email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail)
      .toHaveBeenCalledWith(expect.objectContaining({ vehicle: 'AA-1, BB-2' }));
  });

  it('groupe : tous refusés → un seul refus part', async () => {
    const email = makeEmail(); const sms = makeSms();
    const prisma = makePrisma([{ status: 'CANCELLED' }, { status: 'CANCELLED' }]);
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), prisma, makeDestinataires());
    await n.onRefused(payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }));
    expect((email as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1);
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

/**
 * C5 (revue du 29/09) — une réservation publique DÉJÀ CONFIRMÉE change de véhicule (garage →
 * « Réaffecter ») ou de créneau : le demandeur, dont la confirmation nommait l'ancienne plaque,
 * reçoit SA confirmation mise à jour, dite « modifiée ». Un seul courriel.
 */
describe('ReservationBookingNotifier — réservation modifiée après confirmation (revue du 29/09)', () => {
  const H = 3_600_000;

  it('prévient le demandeur par la confirmation, marquée « modifiée », sous le modèle reservation_confirmed', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires());
    await n.onModified(payload({ public: true, requesterContact: 'ecole@test.fr', destination: 'Albi' }));
    const e = email as unknown as { send: jest.Mock; buildReservationConfirmedEmail: jest.Mock };
    expect(e.buildReservationConfirmedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ modifiee: true, vehicle: 'AA-1', destination: 'Albi' }),
    );
    expect(e.send).toHaveBeenCalledTimes(1);
    expect(e.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ecole@test.fr', template: 'reservation_confirmed' }));
  });

  it('réservation interne (non publique) ou sans contact : personne à prévenir', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires());
    await n.onModified(payload({ public: false, requesterContact: 'ecole@test.fr' }));
    await n.onModified(payload({ public: true, requesterContact: '  ' }));
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
    expect((sms as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('une ligne sœur encore EN ATTENTE : on se tait (la confirmation finale portera les bonnes plaques)', async () => {
    const email = makeEmail();
    const prisma = makePrisma([{ status: 'CONFIRMED', vehicle: { plate: 'AA-1' } }, { status: 'REQUESTED', vehicle: { plate: 'BB-2' } }]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), prisma, makeDestinataires());
    await n.onModified(payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }));
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('réservation scindée : la partie écoulée (ancienne plaque) n’est plus annoncée ; un groupe nomme ses véhicules à venir', async () => {
    const email = makeEmail();
    const passe = new Date(Date.now() - H);
    const avenir = new Date(Date.now() + 4 * H);
    const scindee = makePrisma([
      { status: 'CONFIRMED', endAt: passe, vehicle: { plate: 'OLD-1' } } as never,
      { status: 'CONFIRMED', endAt: avenir, vehicle: { plate: 'NEW-2' } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), scindee, makeDestinataires());
    await n.onModified({ ...payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }), vehiclePlate: 'NEW-2' });
    const build = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail;
    expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ vehicle: 'NEW-2' }));

    const groupe = makePrisma([
      { status: 'CONFIRMED', endAt: avenir, vehicle: { plate: 'AA-1' } } as never,
      { status: 'CONFIRMED', endAt: avenir, vehicle: { plate: 'BB-2' } } as never,
    ]);
    const n2 = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n2.onModified(payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }));
    expect(build).toHaveBeenLastCalledWith(expect.objectContaining({ vehicle: 'AA-1, BB-2' }));
  });

  /**
   * Contre-revue du 29/09 (R4) — corriger après coup le véhicule d'une sortie d'hier écrivait au
   * demandeur « votre réservation a été modifiée ». Le service ne l'émet plus ; le notifier se tait
   * aussi, quel que soit l'émetteur.
   */
  it('R4 — réservation terminée (fin passée), close ou annulée : personne à prévenir', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires());
    const meta = { public: true, requesterContact: 'ecole@test.fr' };
    await n.onModified({ ...payload(meta), startAt: new Date(Date.now() - 26 * H).toISOString(), endAt: new Date(Date.now() - 23 * H).toISOString() });
    await n.onModified({ ...payload(meta), status: 'CANCELLED' });
    await n.onModified({ ...payload(meta), status: 'DONE' });
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
    expect((sms as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();

    await n.onModified({ ...payload(meta), status: 'CONFIRMED' });
    expect((email as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1);
  });

  /**
   * Contre-revue du 29/09 (R3) — une demande groupée dont une seule ligne a bougé (filtre véhicule,
   * refus sur l'autre, édition d'une ligne) : le courriel annonçait « AA-1, BB-2 » au NOUVEL horaire
   * alors que BB-2 était resté à l'ancien. Créneaux différents → une ligne par véhicule.
   */
  it('R3 — lignes à venir sur des créneaux DIFFÉRENTS : une ligne « véhicule — créneau » par véhicule', async () => {
    const email = makeEmail();
    const a = new Date('2027-01-05T08:00:00Z'); // mardi 5 janvier, 09:00 à Paris
    const b = new Date('2027-01-05T08:30:00Z');
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: b, endAt: new Date(b.getTime() + 2 * H), vehicle: { plate: 'AA-1' } } as never,
      { status: 'CONFIRMED', startAt: a, endAt: new Date(a.getTime() + 2 * H), vehicle: { plate: 'BB-2' } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onModified({
      ...payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }),
      startAt: b.toISOString(), endAt: new Date(b.getTime() + 2 * H).toISOString(),
    });
    const build = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail;
    const opts = build.mock.calls[0][0];
    // Triées par début : BB-2 (09:00) puis AA-1 (09:30), chacune avec SON créneau.
    expect(opts.lignes).toEqual([
      { vehicle: 'BB-2', slotLabel: expect.stringContaining('09:00') },
      { vehicle: 'AA-1', slotLabel: expect.stringContaining('09:30') },
    ]);
    expect((email as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1);
  });

  it('R3 — même créneau pour toutes les lignes : pas de détail, les plaques sur un seul créneau', async () => {
    const email = makeEmail();
    const debut = new Date(Date.now() + 24 * H);
    const fin = new Date(debut.getTime() + 2 * H);
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: debut, endAt: fin, vehicle: { plate: 'AA-1' } } as never,
      { status: 'CONFIRMED', startAt: debut, endAt: fin, vehicle: { plate: 'BB-2' } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onModified(payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }));
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.lignes).toBeUndefined();
    expect(opts.vehicle).toBe('AA-1, BB-2');
  });

  it('un créneau sur plusieurs jours porte la date de sa fin (« lundi → jeudi », pas « lundi 09:00 → 00:00 »)', async () => {
    const email = makeEmail();
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), makePrisma(), makeDestinataires());
    await n.onModified({
      ...payload({ public: true, requesterContact: 'ecole@test.fr' }),
      startAt: '2027-01-04T08:00:00Z', // lundi 4 janvier, 09:00 à Paris
      endAt: '2027-01-06T23:00:00Z', // jeudi 7 janvier, 00:00 à Paris
    });
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.slotLabel).toContain('lundi 4 janvier');
    expect(opts.slotLabel).toContain('jeudi 7 janvier');
  });

  it('le gabarit réel, détaillé par véhicule : une ligne par véhicule avec son créneau, plus de « Créneau » unique', () => {
    const config = { get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.test' : '') } as never;
    const service = new EmailService(config, {} as never, {} as never, {} as never);
    const built2 = service.buildReservationConfirmedEmail({
      fleetName: 'CDEF', slotLabel: 'ignoré', destination: 'Albi', vehicle: 'AA-1, BB-2', modifiee: true,
      lignes: [
        { vehicle: 'AA-1', slotLabel: 'lundi 29 septembre 09:00 → jeudi 2 octobre 00:00' },
        { vehicle: 'CC-3', slotLabel: 'jeudi 2 octobre 00:00 → vendredi 3 octobre 17:00' },
      ],
    });
    expect(built2.html).toContain('Véhicule AA-1');
    expect(built2.html).toContain('Véhicule CC-3');
    expect(built2.html).toContain('jeudi 2 octobre 00:00 → vendredi 3 octobre 17:00');
    expect(built2.html).not.toContain('ignoré');
    expect(built2.text).toContain('Véhicule AA-1 : lundi 29 septembre 09:00 → jeudi 2 octobre 00:00');
    expect(built2.text).toContain('Véhicule CC-3 : jeudi 2 octobre 00:00 → vendredi 3 octobre 17:00');
    expect(built2.text).toContain('Destination : Albi');
    expect(built2.text).not.toContain('Créneau :');
  });

  /**
   * Troisième relecture du 29/09 (T5) — la CONFIRMATION finale d'une demande groupée combinait le
   * créneau de la ligne validée avec toutes les plaques confirmées : une ligne scindée pendant que
   * l'autre attendait devenait « lundi → vendredi, Véhicule : A, C, B ». Même récapitulatif que la
   * modification : les lignes fermes À VENIR, chacune avec SON créneau.
   */
  it('T5 — confirmation finale après une scission : une ligne par véhicule, chacune avec son créneau', async () => {
    const email = makeEmail();
    const lundi = new Date('2027-01-04T08:00:00Z'); // lundi 4 janvier, 09:00 à Paris
    const jeudi = new Date('2027-01-06T23:00:00Z'); // jeudi 7 janvier, 00:00 à Paris
    const vendredi = new Date('2027-01-08T16:00:00Z'); // vendredi 8 janvier, 17:00 à Paris
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: lundi, endAt: jeudi, vehicle: { plate: 'AA-1' } } as never,
      { status: 'CONFIRMED', startAt: jeudi, endAt: vendredi, vehicle: { plate: 'CC-3' } } as never,
      { status: 'CONFIRMED', startAt: lundi, endAt: vendredi, vehicle: { plate: 'BB-2' } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onConfirmed({
      ...payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }),
      vehiclePlate: 'BB-2', startAt: lundi.toISOString(), endAt: vendredi.toISOString(),
    });
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.modifiee).toBeUndefined(); // c'est la confirmation, pas une modification
    expect(opts.lignes).toEqual([
      { vehicle: 'AA-1', slotLabel: expect.stringMatching(/lundi 4 janvier.*jeudi 7 janvier/) },
      { vehicle: 'BB-2', slotLabel: expect.stringMatching(/lundi 4 janvier.*vendredi 8 janvier/) },
      { vehicle: 'CC-3', slotLabel: expect.stringMatching(/jeudi 7 janvier.*vendredi 8 janvier/) },
    ]);
    expect((email as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1);
  });

  it('T5 — la partie DÉJÀ ÉCOULÉE d’une scission n’est plus annoncée à la confirmation', async () => {
    const email = makeEmail();
    const passe = new Date(Date.now() - H);
    const avenir = new Date(Date.now() + 30 * H);
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: new Date(Date.now() - 5 * H), endAt: passe, vehicle: { plate: 'OLD-1' } } as never,
      { status: 'CONFIRMED', startAt: passe, endAt: avenir, vehicle: { plate: 'NEW-2' } } as never,
      { status: 'CONFIRMED', startAt: passe, endAt: avenir, vehicle: { plate: 'BB-2' } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onConfirmed({ ...payload({ public: true, requesterContact: 'ecole@test.fr', bookingRef: 'abc' }), vehiclePlate: 'BB-2' });
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.lignes).toBeUndefined(); // les lignes à venir partagent un créneau
    expect(opts.vehicle).toBe('NEW-2, BB-2');
    expect(opts.vehicle).not.toContain('OLD-1');
  });

  it('le gabarit réel : sujet, titre et première phrase disent « modifiée » ; sans l’option, la confirmation est inchangée', () => {
    const config = { get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.test' : '') } as never;
    const service = new EmailService(config, {} as never, {} as never, {} as never);
    const opts = { fleetName: 'CDEF', slotLabel: 'mar. 30 sept., 09:00 → 17:00', destination: 'Albi', vehicle: 'NEW-2' };

    const modifie = service.buildReservationConfirmedEmail({ ...opts, modifiee: true });
    expect(modifie.subject).toBe('Votre réservation a été modifiée');
    expect(modifie.html).toContain('Votre réservation a été modifiée');
    expect(modifie.html).toContain('le véhicule ou le créneau a changé');
    expect(modifie.html).toContain('NEW-2');
    expect(modifie.text).toContain('a été modifiée');
    expect(modifie.text).toContain('Véhicule : NEW-2');

    const confirme = service.buildReservationConfirmedEmail(opts);
    expect(confirme.subject).toBe('Votre réservation est confirmée');
    expect(confirme.html).toContain('a été <span class="m-title" style="color:#0A1311;font-weight:600;">validée</span>');
    expect(confirme.text).toContain('est confirmée');
    expect(confirme.html).not.toContain('modifiée');
  });
});

/**
 * Troisième relecture du 29/09 (T2) — une réservation publique DÉJÀ CONFIRMÉE qu'on annule : le
 * demandeur avait reçu « confirmée — AA-111-BB » et ne recevait plus rien. L'état du groupe tranche :
 * une sœur en attente → silence ; des lignes fermes restantes → « modifiée » qui les nomme ; plus rien
 * → « annulée » (jamais le texte du refus).
 */
describe('ReservationBookingNotifier — réservation confirmée puis ANNULÉE (troisième relecture du 29/09)', () => {
  const H = 3_600_000;
  const meta = (over: Record<string, unknown> = {}) => ({ public: true, requesterContact: 'ecole@test.fr', destination: 'Albi', ...over });
  const annulee = (over: Record<string, unknown> = {}) => ({ ...payload(meta(over)), vehiclePlate: 'AA-111-BB', status: 'CANCELLED' });

  it('ligne unique : « Votre réservation a été annulée », sous le modèle reservation_refused, variante annulée', async () => {
    const email = makeEmail();
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), makePrisma(), makeDestinataires());
    await n.onCancelled(annulee());
    const e = email as unknown as { send: jest.Mock; buildReservationRefusedEmail: jest.Mock; buildReservationConfirmedEmail: jest.Mock };
    expect(e.buildReservationRefusedEmail).toHaveBeenCalledWith(expect.objectContaining({ annulee: true, destination: 'Albi' }));
    expect(e.buildReservationConfirmedEmail).not.toHaveBeenCalled();
    expect(e.send).toHaveBeenCalledTimes(1);
    expect(e.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ecole@test.fr', template: 'reservation_refused' }));
  });

  it('une ligne annulée, une ligne ferme RESTANTE : « modifiée », qui nomme la restante — jamais la plaque ni le créneau annulés', async () => {
    const email = makeEmail();
    const reste = { debut: new Date('2027-01-05T13:00:00Z'), fin: new Date('2027-01-05T16:00:00Z') }; // 14:00 → 17:00 à Paris
    const groupe = makePrisma([
      { status: 'CANCELLED', startAt: new Date('2027-01-05T08:00:00Z'), endAt: new Date('2027-01-05T10:00:00Z'), vehicle: { plate: 'AA-111-BB' } } as never,
      { status: 'CONFIRMED', startAt: reste.debut, endAt: reste.fin, vehicle: { plate: 'CC-222-DD' } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onCancelled({
      ...annulee({ bookingRef: 'g1' }), startAt: '2027-01-05T08:00:00Z', endAt: '2027-01-05T10:00:00Z',
    });
    const e = email as unknown as { send: jest.Mock; buildReservationRefusedEmail: jest.Mock; buildReservationConfirmedEmail: jest.Mock };
    const opts = e.buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts).toEqual(expect.objectContaining({ modifiee: true, vehicle: 'CC-222-DD', destination: 'Albi' }));
    expect(opts.slotLabel).toContain('14:00');
    expect(opts.slotLabel).not.toContain('09:00');
    expect(e.buildReservationRefusedEmail).not.toHaveBeenCalled();
    expect(e.send).toHaveBeenCalledTimes(1);
    expect(e.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'reservation_confirmed' }));
  });

  it('une ligne sœur encore EN ATTENTE : on se tait (la dernière décision écrira)', async () => {
    const email = makeEmail();
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), makePrisma([{ status: 'REQUESTED' }]), makeDestinataires());
    await n.onCancelled(annulee({ bookingRef: 'g1' }));
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  it('non publique, sans contact, rétroactive ou déjà finie : personne à prévenir', async () => {
    const email = makeEmail(); const sms = makeSms();
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires());
    await n.onCancelled(annulee({ public: false }));
    await n.onCancelled(annulee({ requesterContact: ' ' }));
    await n.onCancelled(annulee({ retroactive: true }));
    await n.onCancelled({ ...annulee(), startAt: new Date(Date.now() - 5 * H).toISOString(), endAt: new Date(Date.now() - 2 * H).toISOString() });
    expect((email as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
    expect((sms as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
  });

  /**
   * Même famille, chemin du REFUS : une ligne validée (la validation s'était tue, sa sœur attendait),
   * l'autre refusée — le refus final écrivait « non retenue » et la confirmation n'arrivait jamais.
   */
  it('refus de la dernière ligne en attente alors qu’une autre a été VALIDÉE : la confirmation part, pas « non retenue »', async () => {
    const email = makeEmail();
    const avenir = new Date(Date.now() + 30 * H);
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: new Date(Date.now() + 26 * H), endAt: avenir, vehicle: { plate: 'AA-1' } } as never,
      { status: 'CANCELLED', startAt: new Date(Date.now() + 26 * H), endAt: avenir, vehicle: { plate: 'BB-2' } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onRefused({ ...payload(meta({ bookingRef: 'g1' })), vehiclePlate: 'BB-2' });
    const e = email as unknown as { send: jest.Mock; buildReservationRefusedEmail: jest.Mock; buildReservationConfirmedEmail: jest.Mock };
    expect(e.buildReservationRefusedEmail).not.toHaveBeenCalled();
    const opts = e.buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.vehicle).toBe('AA-1');
    expect(opts.modifiee).toBeUndefined(); // sa PREMIÈRE confirmation : la validation s'était tue
    expect(e.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'reservation_confirmed' }));
  });

  it('le gabarit réel : « annulée » le dit (sujet, titre, texte) ; sans l’option, le refus est inchangé', () => {
    const config = { get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.test' : '') } as never;
    const service = new EmailService(config, {} as never, {} as never, {} as never);
    const opts = { fleetName: 'CDEF', slotLabel: 'mar. 30 sept., 09:00 → 17:00', destination: 'Albi' };

    const a = service.buildReservationRefusedEmail({ ...opts, annulee: true });
    expect(a.subject).toBe('Votre réservation a été annulée');
    expect(a.html).toContain('Votre réservation a été annulée');
    expect(a.html).toContain('qui avait été confirmée');
    expect(a.html).not.toContain('pas pu être retenue');
    expect(a.text).toContain('a annulé votre réservation');
    expect(a.text).toContain('Créneau : mar. 30 sept., 09:00 → 17:00');
    expect(a.text).toContain('Destination : Albi');

    const r = service.buildReservationRefusedEmail(opts);
    expect(r.subject).toBe('Votre demande de réservation n\'a pas pu être retenue');
    expect(r.html).toContain('Votre demande n\'a pas pu être retenue');
    expect(r.text).toContain('Créneau demandé : mar. 30 sept., 09:00 → 17:00');
    expect(r.html).not.toContain('annulée');
  });
});
