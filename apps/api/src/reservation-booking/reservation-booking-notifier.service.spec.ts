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
    // C1 (quatrième revue) : aucune sœur perdue → confirmation pleine, pas « en partie ».
    expect((email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0].partielle)
      .toBeUndefined();
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
      expect.objectContaining({ modifiee: true, motif: 'changement', vehicle: 'AA-1', destination: 'Albi' }),
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
      fleetName: 'CDEF', slotLabel: 'ignoré', destination: 'Albi', vehicle: 'AA-1, BB-2', modifiee: true, motif: 'changement',
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

    const modifie = service.buildReservationConfirmedEmail({ ...opts, modifiee: true, motif: 'changement' });
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
    expect(opts).toEqual(expect.objectContaining({ modifiee: true, motif: 'retrait', vehicle: 'CC-222-DD', destination: 'Albi' }));
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
  /**
   * Quatrième revue du 29/09 (C1) — ce courriel disait « Votre réservation est confirmée — votre
   * demande a été validée — Véhicule : AA-1 » : le groupe de 11 se présentait pour 9 places. Il est
   * désormais marqué « retenue qu'en partie », avec le rappel des places demandées.
   */
  it('refus de la dernière ligne en attente alors qu’une autre a été VALIDÉE : la confirmation part, marquée « en partie »', async () => {
    const email = makeEmail();
    const avenir = new Date(Date.now() + 30 * H);
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: new Date(Date.now() + 26 * H), endAt: avenir, vehicle: { plate: 'AA-1', seats: 9 } } as never,
      { status: 'CANCELLED', startAt: new Date(Date.now() + 26 * H), endAt: avenir, vehicle: { plate: 'BB-2', seats: 9 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onRefused({ ...payload(meta({ bookingRef: 'g1', seatsNeeded: 11 })), vehiclePlate: 'BB-2' });
    const e = email as unknown as { send: jest.Mock; buildReservationRefusedEmail: jest.Mock; buildReservationConfirmedEmail: jest.Mock };
    expect(e.buildReservationRefusedEmail).not.toHaveBeenCalled();
    const opts = e.buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.vehicle).toBe('AA-1');
    expect(opts.modifiee).toBeUndefined(); // sa PREMIÈRE confirmation : la validation s'était tue
    expect(opts.partielle).toBe(true);
    expect(opts.placesDemandees).toBe(11);
    // Conditions d'envoi inchangées : un seul courriel, au demandeur, sous le même modèle.
    expect(e.send).toHaveBeenCalledTimes(1);
    expect(e.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ecole@test.fr', template: 'reservation_confirmed' }));
  });

  it('C1 — ordre inverse (la ligne en attente ANNULÉE d’abord, l’autre VALIDÉE ensuite) : la confirmation est aussi « en partie »', async () => {
    const email = makeEmail();
    const avenir = new Date(Date.now() + 30 * H);
    const groupe = makePrisma([
      { status: 'CANCELLED', startAt: new Date(Date.now() + 26 * H), endAt: avenir, vehicle: { plate: 'BB-2', seats: 9 } } as never,
      { status: 'CONFIRMED', startAt: new Date(Date.now() + 26 * H), endAt: avenir, vehicle: { plate: 'AA-1', seats: 9 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onConfirmed({ ...payload(meta({ bookingRef: 'g1', seatsNeeded: 11 })), vehiclePlate: 'AA-1' });
    const e = email as unknown as { send: jest.Mock; buildReservationConfirmedEmail: jest.Mock };
    expect(e.buildReservationConfirmedEmail.mock.calls[0][0]).toEqual(
      expect.objectContaining({ vehicle: 'AA-1', partielle: true, placesDemandees: 11 }),
    );
    expect(e.send).toHaveBeenCalledTimes(1);
  });

  it('C1 — la ligne restante a été RÉAFFECTÉE sur un véhicule assez grand (12 pour 11) : pas de « en partie »', async () => {
    const email = makeEmail();
    const debut = new Date(Date.now() + 26 * H);
    const fin = new Date(Date.now() + 30 * H);
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: debut, endAt: fin, vehicle: { plate: 'MINI-12', seats: 12 } } as never,
      { status: 'CANCELLED', startAt: debut, endAt: fin, vehicle: { plate: 'BB-2', seats: 9 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onRefused({ ...payload(meta({ bookingRef: 'g1', seatsNeeded: 11 })), vehiclePlate: 'BB-2' });
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.vehicle).toBe('MINI-12');
    expect(opts.partielle).toBeUndefined();
    expect(opts.placesDemandees).toBeUndefined();
  });

  it('C1 — deux créneaux différents ne s’additionnent pas (9 puis 9 ≠ 18 places) : la sœur perdue suffit à dire « en partie »', async () => {
    const email = makeEmail();
    const lundi = new Date('2027-01-04T08:00:00Z');
    const jeudi = new Date('2027-01-06T23:00:00Z');
    const vendredi = new Date('2027-01-08T16:00:00Z');
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: lundi, endAt: jeudi, vehicle: { plate: 'AA-1', seats: 9 } } as never,
      { status: 'CONFIRMED', startAt: jeudi, endAt: vendredi, vehicle: { plate: 'CC-3', seats: 9 } } as never,
      { status: 'CANCELLED', startAt: lundi, endAt: vendredi, vehicle: { plate: 'BB-2', seats: 9 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onRefused({ ...payload(meta({ bookingRef: 'g1', seatsNeeded: 11 })), vehiclePlate: 'BB-2' });
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.partielle).toBe(true);
  });

  /**
   * Revue du 29/09 — la couverture se juge INSTANT PAR INSTANT. La ligne de 12 places (réaffectée pour
   * une demande de 11, la sœur de 9 refusée) est scindée par « Réaffecter » après une maintenance
   * posée à partir de jeudi : lundi→jeudi sur MINI-12, jeudi→vendredi sur MAXI-12. Des créneaux
   * différents, mais 12 places à chaque instant : l'ancienne règle (« créneaux différents = non
   * prouvé ») écrivait « retenue qu'en partie » — faux et alarmant.
   */
  it('C1 — un 12 places RELAYÉ par un autre 12 places (scission) pour 11 places, une sœur refusée : pas de « en partie »', async () => {
    const email = makeEmail();
    const lundi = new Date(Date.now() + 26 * H);
    const jeudi = new Date(Date.now() + 98 * H);
    const vendredi = new Date(Date.now() + 122 * H);
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: lundi, endAt: jeudi, vehicle: { plate: 'MINI-12', seats: 12 } } as never,
      { status: 'CONFIRMED', startAt: jeudi, endAt: vendredi, vehicle: { plate: 'MAXI-12', seats: 12 } } as never,
      { status: 'CANCELLED', startAt: lundi, endAt: vendredi, vehicle: { plate: 'BB-2', seats: 9 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onModified({
      ...payload(meta({ bookingRef: 'g1', seatsNeeded: 11 })),
      vehiclePlate: 'MAXI-12', startAt: jeudi.toISOString(), endAt: vendredi.toISOString(),
    });
    const e = email as unknown as { send: jest.Mock; buildReservationConfirmedEmail: jest.Mock };
    const opts = e.buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.modifiee).toBe(true);
    expect(opts.partielle).toBeUndefined();
    expect(opts.placesDemandees).toBeUndefined();
    // Les deux lignes sont nommées, chacune sur son créneau (R3) ; conditions d'envoi inchangées.
    expect(opts.lignes).toEqual([
      { vehicle: 'MINI-12', slotLabel: expect.any(String) },
      { vehicle: 'MAXI-12', slotLabel: expect.any(String) },
    ]);
    expect(e.send).toHaveBeenCalledTimes(1);
    expect(e.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ecole@test.fr', template: 'reservation_confirmed' }));
  });

  it('C1 — un TROU entre deux lignes de 12 (mercredi → jeudi sans véhicule) : non couvert, « en partie »', async () => {
    const email = makeEmail();
    const lundi = new Date(Date.now() + 26 * H);
    const mercredi = new Date(Date.now() + 74 * H);
    const jeudi = new Date(Date.now() + 98 * H);
    const vendredi = new Date(Date.now() + 122 * H);
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: lundi, endAt: mercredi, vehicle: { plate: 'MINI-12', seats: 12 } } as never,
      { status: 'CONFIRMED', startAt: jeudi, endAt: vendredi, vehicle: { plate: 'MAXI-12', seats: 12 } } as never,
      { status: 'CANCELLED', startAt: lundi, endAt: vendredi, vehicle: { plate: 'BB-2', seats: 9 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onRefused({ ...payload(meta({ bookingRef: 'g1', seatsNeeded: 11 })), vehiclePlate: 'BB-2' });
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts).toEqual(expect.objectContaining({ partielle: true, placesDemandees: 11 }));
  });

  it('C1 — seul ce qui reste À VENIR est jugé : 9 + 9 présents dès maintenant couvrent 11, même si l’une a commencé seule', async () => {
    const email = makeEmail();
    const fin = new Date(Date.now() + 4 * H);
    const groupe = makePrisma([
      // en cours depuis 3 h, seule pendant les deux premières heures (sa sœur scindée a relayé l'autre partie)
      { status: 'IN_PROGRESS', startAt: new Date(Date.now() - 3 * H), endAt: fin, vehicle: { plate: 'AA-1', seats: 9 } } as never,
      { status: 'CONFIRMED', startAt: new Date(Date.now() - H), endAt: fin, vehicle: { plate: 'CC-3', seats: 9 } } as never,
      { status: 'CANCELLED', startAt: new Date(Date.now() - 3 * H), endAt: fin, vehicle: { plate: 'BB-2', seats: 5 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onRefused({ ...payload(meta({ bookingRef: 'g1', seatsNeeded: 11 })), vehiclePlate: 'BB-2' });
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.partielle).toBeUndefined();
  });

  it('C1 — une ligne relais à la capacité INCONNUE : non prouvé, la sœur perdue suffit à dire « en partie »', async () => {
    const email = makeEmail();
    const lundi = new Date(Date.now() + 26 * H);
    const jeudi = new Date(Date.now() + 98 * H);
    const vendredi = new Date(Date.now() + 122 * H);
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: lundi, endAt: jeudi, vehicle: { plate: 'MINI-12', seats: 12 } } as never,
      { status: 'CONFIRMED', startAt: jeudi, endAt: vendredi, vehicle: { plate: 'XX-0', seats: null } } as never,
      { status: 'CANCELLED', startAt: lundi, endAt: vendredi, vehicle: { plate: 'BB-2', seats: 9 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onRefused({ ...payload(meta({ bookingRef: 'g1', seatsNeeded: 11 })), vehiclePlate: 'BB-2' });
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts.partielle).toBe(true);
  });

  it('C1 — une ligne ferme ANNULÉE, une autre reste : « modifiée » ET « en partie »', async () => {
    const email = makeEmail();
    const debut = new Date(Date.now() + 26 * H);
    const fin = new Date(Date.now() + 30 * H);
    const groupe = makePrisma([
      { status: 'CANCELLED', startAt: debut, endAt: fin, vehicle: { plate: 'AA-111-BB', seats: 9 } } as never,
      { status: 'CONFIRMED', startAt: debut, endAt: fin, vehicle: { plate: 'CC-222-DD', seats: 5 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onCancelled({ ...annulee({ bookingRef: 'g1', seatsNeeded: 12 }), startAt: debut.toISOString(), endAt: fin.toISOString() });
    const opts = (email as unknown as { buildReservationConfirmedEmail: jest.Mock }).buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts).toEqual(expect.objectContaining({ modifiee: true, motif: 'retrait', partielle: true, placesDemandees: 12, vehicle: 'CC-222-DD' }));
  });

  it('C1 — le gabarit réel : « retenue qu’en partie » dans le sujet, le titre, le texte, avec les places demandées ; sans l’option, rien ne change', () => {
    const config = { get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.test' : '') } as never;
    const service = new EmailService(config, {} as never, {} as never, {} as never);
    const opts = { fleetName: 'CDEF', slotLabel: 'mar. 30 sept., 09:00 → 17:00', destination: 'Albi', vehicle: 'AA-1' };

    const p = service.buildReservationConfirmedEmail({ ...opts, partielle: true, placesDemandees: 11 });
    expect(p.subject).toBe('Votre demande n\'a été retenue qu\'en partie');
    expect(p.html).toContain('Votre demande n\'a été retenue qu\'en partie');
    expect(p.html).toContain('Voici ce qui reste confirmé');
    expect(p.html).toContain('Places demandées');
    expect(p.html).not.toContain('>validée<');
    expect(p.text).toContain('n\'a été retenue qu\'en partie : voici ce qui reste confirmé.');
    expect(p.text).toContain('Places demandées : 11');
    expect(p.text).toContain('Véhicule : AA-1');
    expect(p.text).not.toContain('est confirmée.');

    const pm = service.buildReservationConfirmedEmail({ ...opts, partielle: true, modifiee: true, motif: 'retrait', placesDemandees: null });
    expect(pm.subject).toBe('Votre réservation a été modifiée : elle n\'est retenue qu\'en partie');
    expect(pm.text).toContain('a été modifiée et n\'est retenue qu\'en partie');
    expect(pm.text).not.toContain('Places demandées');

    const c = service.buildReservationConfirmedEmail({ ...opts, placesDemandees: 11 });
    expect(c.subject).toBe('Votre réservation est confirmée');
    expect(c.text).toContain('est confirmée.');
    expect(c.text).not.toContain('Places demandées'); // le rappel n'accompagne que la variante partielle
    expect(c.html).not.toContain('en partie');
  });

  /**
   * Cinquième revue du 29/09 (C1) — demande de 11 places : A (9 places) validée, B refusée (« retenue
   * qu'en partie » déjà envoyé). Le gestionnaire DÉCALE ensuite A. Le courriel disait « modifiée et
   * n'est retenue qu'en partie : une partie des véhicules prévus n'est plus maintenue » — une perte
   * qui n'avait pas eu lieu — et plus un mot du créneau changé. Le notifier dit désormais le MOTIF.
   */
  it('C1 (5e revue) — décalage d’une demande DÉJÀ retenue en partie : motif « changement », partielle en rappel, un seul courriel', async () => {
    const email = makeEmail();
    const debut = new Date(Date.now() + 27 * H); // A décalée de +60 min
    const fin = new Date(Date.now() + 31 * H);
    const groupe = makePrisma([
      { status: 'CONFIRMED', startAt: debut, endAt: fin, vehicle: { plate: 'AA-1', seats: 9 } } as never,
      { status: 'CANCELLED', startAt: new Date(Date.now() + 26 * H), endAt: new Date(Date.now() + 30 * H), vehicle: { plate: 'BB-2', seats: 4 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onModified({
      ...payload(meta({ bookingRef: 'g1', seatsNeeded: 11 })),
      vehiclePlate: 'AA-1', status: 'CONFIRMED', startAt: debut.toISOString(), endAt: fin.toISOString(),
    });
    const e = email as unknown as { send: jest.Mock; buildReservationConfirmedEmail: jest.Mock };
    const opts = e.buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts).toEqual(
      expect.objectContaining({ modifiee: true, motif: 'changement', partielle: true, placesDemandees: 11, vehicle: 'AA-1' }),
    );
    // Conditions d'envoi inchangées : un seul courriel, au demandeur, sous le même modèle.
    expect(e.send).toHaveBeenCalledTimes(1);
    expect(e.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ecole@test.fr', template: 'reservation_confirmed' }));
  });

  it('C1 (5e revue) — annulation d’une ligne dont la restante COUVRE le besoin (12 pour 11) : motif « retrait », pas de « en partie »', async () => {
    const email = makeEmail();
    const debut = new Date(Date.now() + 26 * H);
    const fin = new Date(Date.now() + 30 * H);
    const groupe = makePrisma([
      { status: 'CANCELLED', startAt: debut, endAt: fin, vehicle: { plate: 'AA-111-BB', seats: 9 } } as never,
      { status: 'CONFIRMED', startAt: debut, endAt: fin, vehicle: { plate: 'MINI-12', seats: 12 } } as never,
    ]);
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), groupe, makeDestinataires());
    await n.onCancelled({ ...annulee({ bookingRef: 'g1', seatsNeeded: 11 }), startAt: debut.toISOString(), endAt: fin.toISOString() });
    const e = email as unknown as { send: jest.Mock; buildReservationConfirmedEmail: jest.Mock };
    const opts = e.buildReservationConfirmedEmail.mock.calls[0][0];
    expect(opts).toEqual(expect.objectContaining({ modifiee: true, motif: 'retrait', vehicle: 'MINI-12' }));
    expect(opts.partielle).toBeUndefined();
    expect(e.send).toHaveBeenCalledTimes(1);
  });

  it('C1 (5e revue) — le gabarit réel : « changement » + « en partie » dit le créneau changé partout et n’annonce aucune perte', () => {
    const config = { get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.test' : '') } as never;
    const service = new EmailService(config, {} as never, {} as never, {} as never);
    const opts = { fleetName: 'CDEF', slotLabel: 'mar. 30 sept., 10:00 → 18:00', destination: 'Albi', vehicle: 'AA-1' };

    const ch = service.buildReservationConfirmedEmail({ ...opts, modifiee: true, motif: 'changement', partielle: true, placesDemandees: 11 });
    expect(ch.subject).toBe('Votre réservation a été modifiée');
    // Phrase, aperçu (preheader) et texte (qui sert aussi au SMS) disent ce qui vient de se passer.
    expect(ch.html).toContain('le véhicule ou le créneau a changé. Pour rappel, elle n\'est retenue');
    expect(ch.html).toContain('Le véhicule ou le créneau de votre réservation a changé. Pour rappel, elle n\'est retenue qu\'en partie.');
    expect(ch.html).toContain('Réservation · Modifiée');
    expect(ch.text).toContain('a été modifiée : le véhicule ou le créneau a changé. Pour rappel, elle n\'est retenue qu\'en partie.');
    // Le rappel « en partie » garde les places demandées et le conseil de la variante partielle.
    expect(ch.html).toContain('Places demandées');
    expect(ch.text).toContain('Places demandées : 11');
    expect(ch.text).toContain('Ce qui reste ne suffit pas ?');
    expect(ch.text).toContain('Créneau : mar. 30 sept., 10:00 → 18:00');
    // Aucune perte annoncée, aucune « confirmée » pleine.
    for (const out of [ch.html, ch.text]) {
      expect(out).not.toContain('n\'est plus maintenue');
      expect(out).not.toContain('n\'a pas pu être retenue');
      expect(out).not.toContain('Retenue en partie');
      expect(out).not.toContain('Elle reste confirmée');
    }
  });

  it('C1 (5e revue) — le gabarit réel : « retrait » est la SEULE variante qui annonce une perte (avec ou sans « en partie »)', () => {
    const config = { get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.test' : '') } as never;
    const service = new EmailService(config, {} as never, {} as never, {} as never);
    const opts = { fleetName: 'CDEF', slotLabel: 'mar. 30 sept., 09:00 → 17:00', destination: 'Albi', vehicle: 'CC-222-DD' };

    const rp = service.buildReservationConfirmedEmail({ ...opts, modifiee: true, motif: 'retrait', partielle: true, placesDemandees: 12 });
    expect(rp.subject).toBe('Votre réservation a été modifiée : elle n\'est retenue qu\'en partie');
    expect(rp.html).toContain('une partie des véhicules prévus n\'est plus maintenue');
    expect(rp.html).toContain('Réservation · Retenue en partie');
    expect(rp.html).toContain('Places demandées');
    expect(rp.text).toContain('a été modifiée et n\'est retenue qu\'en partie');
    expect(rp.html).not.toContain('le véhicule ou le créneau a changé');
    expect(rp.text).not.toContain('le véhicule ou le créneau a changé');

    // Retrait couvert (le reste suffit) : l'ancien texte disait « le véhicule ou le créneau a changé ».
    const r = service.buildReservationConfirmedEmail({ ...opts, modifiee: true, motif: 'retrait' });
    expect(r.subject).toBe('Votre réservation a été modifiée');
    expect(r.html).toContain('une partie des véhicules prévus n\'est plus maintenue. Elle reste confirmée');
    expect(r.html).toContain('Réservation · Modifiée');
    expect(r.text).toContain('a été modifiée : une partie des véhicules prévus n\'est plus maintenue. Elle reste confirmée.');
    expect(r.text).not.toContain('Places demandées');
    for (const out of [r.html, r.text]) {
      expect(out).not.toContain('le véhicule ou le créneau a changé');
      expect(out).not.toContain('en partie');
    }

    // Le changement sans « en partie » est inchangé (C5).
    const c = service.buildReservationConfirmedEmail({ ...opts, modifiee: true, motif: 'changement' });
    expect(c.text).toContain('a été modifiée : le véhicule ou le créneau a changé. Elle reste confirmée.');
    expect(c.html).not.toContain('n\'est plus maintenue');
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

/**
 * 30/09 — LE GARDE-FOU D'ENVOI côté notifier. Le courriel est jugé par `EmailService.send` ; le
 * notifier, lui, juge ce qui ne passe PAS par là : le SMS au demandeur (facturé) et le push
 * « demande à valider » aux téléphones de l'équipe.
 */
describe('ReservationBookingNotifier — mode recette d’une société', () => {
  const garde = (motif: string | null) =>
    ({
      motifDeRetenue: jest.fn().mockResolvedValue(motif),
      noterSmsRetenu: jest.fn(),
      noterPushRetenu: jest.fn(),
    }) as unknown as { motifDeRetenue: jest.Mock; noterSmsRetenu: jest.Mock; noterPushRetenu: jest.Mock };

  it('SMS au demandeur RETENU : rien ne part, une ligne au journal', async () => {
    const email = makeEmail(); const sms = makeSms(); const g = garde("société en mode recette jusqu'au 30/09 12:40");
    const n = new ReservationBookingNotifier(email, sms, makeErrors(), makePrisma(), makeDestinataires(), undefined, g as never);
    await n.onConfirmed(payload({ public: true, requesterContact: '+33612345678' }));
    expect((sms as unknown as { send: jest.Mock }).send).not.toHaveBeenCalled();
    expect(g.motifDeRetenue).toHaveBeenCalledWith({ canal: 'sms', destinataire: '+33612345678', fleetId: 'f1', modele: 'reservation_confirmed' });
    expect(g.noterSmsRetenu).toHaveBeenCalledWith(expect.objectContaining({ numero: '+33612345678', fleetId: 'f1', modele: 'reservation_confirmed' }));
  });

  it('SMS non retenu : il part, comme avant', async () => {
    const sms = makeSms(); const g = garde(null);
    const n = new ReservationBookingNotifier(makeEmail(), sms, makeErrors(), makePrisma(), makeDestinataires(), undefined, g as never);
    await n.onConfirmed(payload({ public: true, requesterContact: '+33612345678' }));
    expect((sms as unknown as { send: jest.Mock }).send).toHaveBeenCalledTimes(1);
    expect(g.noterSmsRetenu).not.toHaveBeenCalled();
  });

  it('contact e-mail : le notifier ne juge pas lui-même (EmailService.send le fait, avec la société)', async () => {
    const email = makeEmail(); const g = garde('peu importe');
    const n = new ReservationBookingNotifier(email, makeSms(), makeErrors(), makePrisma(), makeDestinataires(), undefined, g as never);
    await n.onConfirmed(payload({ public: true, requesterContact: 'ecole@test.fr' }));
    expect(g.motifDeRetenue).not.toHaveBeenCalled();
    expect((email as unknown as { send: jest.Mock }).send).toHaveBeenCalledWith(expect.objectContaining({ fleetId: 'f1', template: 'reservation_confirmed' }));
  });

  function avisEquipe(motifPush: string | null) {
    const email = {
      send: jest.fn().mockResolvedValue({ ok: true }),
      buildReservationRequestPendingEmail: jest.fn().mockReturnValue(built),
    };
    const destinataires = {
      possibles: jest.fn().mockResolvedValue([{ id: 'v1', email: 'v1@cdef31.fr', notifie: true }, { id: 'v2', email: 'v2@cdef31.fr', notifie: true }]),
      notifies: jest.fn(),
    };
    const dispatch = { notifyUsers: jest.fn().mockResolvedValue(2) };
    const g = garde(motifPush);
    const n = new ReservationBookingNotifier(email as never, makeSms(), makeErrors(), makePrisma(), destinataires as never, dispatch as never, g as never);
    const demande = {
      fleetId: 'f1', requester: 'École', contact: 'ecole@test.fr', destination: null,
      startAt: new Date(Date.now() + 86_400_000).toISOString(), endAt: new Date(Date.now() + 90_000_000).toISOString(),
      seats: null, vehicleCount: 1,
    };
    return { n, email, dispatch, g, demande };
  }

  it('push « demande à valider » RETENU en mode recette : les téléphones de l’équipe ne sonnent pas', async () => {
    const { n, email, dispatch, g, demande } = avisEquipe("société en mode recette jusqu'au 30/09 12:40");
    await n.notifyFleetOfPendingRequest(demande);
    expect(dispatch.notifyUsers).not.toHaveBeenCalled();
    expect(g.motifDeRetenue).toHaveBeenCalledWith(expect.objectContaining({ canal: 'push', fleetId: 'f1', modele: 'reservation_request_pending' }));
    expect(g.noterPushRetenu).toHaveBeenCalledWith(expect.objectContaining({ destinataires: 2, fleetId: 'f1' }));
    // Les courriels passent quand même par EmailService.send — c'est LUI qui les retient.
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it('push non retenu : il part, comme avant', async () => {
    const { n, dispatch, g, demande } = avisEquipe(null);
    await n.notifyFleetOfPendingRequest(demande);
    expect(dispatch.notifyUsers).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['v1', 'v2'], kind: 'reservation-request' }));
    expect(g.noterPushRetenu).not.toHaveBeenCalled();
  });
});
