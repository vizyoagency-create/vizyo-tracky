import {
  coupesAutoSuspendues,
  etatIndisponibilite,
  immobilisationAgendaEnCours,
  LIBELLES_ETAT,
  type EvenementAgendaImmobilisant,
  type ImmobilisationAgendaDto,
} from './etat-vehicule';

const H = 60 * 60 * 1000;
/** Mardi 6 octobre 2026, 10:00 UTC. */
const MAINTENANT = Date.parse('2026-10-06T10:00:00.000Z');

function ev(partiel: Partial<EvenementAgendaImmobilisant>): EvenementAgendaImmobilisant {
  return {
    id: 'ev-1',
    type: 'MAINTENANCE',
    status: 'PLANNED',
    blocksVehicle: true,
    title: 'Vidange',
    startAt: new Date(MAINTENANT - 2 * H).toISOString(),
    endAt: new Date(MAINTENANT + 6 * H).toISOString(),
    ...partiel,
  };
}

describe('immobilisationAgendaEnCours — la même règle que la réservation', () => {
  it('une maintenance « Immobilise le véhicule » en cours immobilise, avec sa fin saisie', () => {
    const im = immobilisationAgendaEnCours([ev({})], MAINTENANT);
    expect(im).toEqual({
      eventId: 'ev-1',
      type: 'MAINTENANCE',
      title: 'Vidange',
      startAt: new Date(MAINTENANT - 2 * H).toISOString(),
      endAt: new Date(MAINTENANT + 6 * H).toISOString(),
    });
  });

  it('accepte les dates de la ligne Prisma (Date) comme celles du DTO (ISO)', () => {
    const im = immobilisationAgendaEnCours(
      [ev({ startAt: new Date(MAINTENANT - H), endAt: new Date(MAINTENANT + H) })],
      MAINTENANT,
    );
    expect(im?.endAt).toBe(new Date(MAINTENANT + H).toISOString());
  });

  it('⚠️ une maintenance NON bloquante n’immobilise pas (rappel d’un plan d’entretien)', () => {
    // Les plans matérialisent une « Vidange » PLANIFIÉE à chaque échéance, sans fin et sans
    // blocage : la compter suspendrait 24 h les coupes du véhicule à chaque échéance.
    expect(immobilisationAgendaEnCours([ev({ blocksVehicle: false, endAt: null })], MAINTENANT)).toBeNull();
  });

  it('⚠️ une mission bloquante n’immobilise pas : le véhicule ROULE', () => {
    expect(immobilisationAgendaEnCours([ev({ type: 'MISSION' })], MAINTENANT)).toBeNull();
    expect(immobilisationAgendaEnCours([ev({ type: 'RESERVATION', status: 'CONFIRMED' })], MAINTENANT)).toBeNull();
  });

  it('pas avant son début, plus après sa fin', () => {
    expect(immobilisationAgendaEnCours([ev({ startAt: new Date(MAINTENANT + H).toISOString() })], MAINTENANT)).toBeNull();
    expect(immobilisationAgendaEnCours([ev({ endAt: new Date(MAINTENANT - 1).toISOString() })], MAINTENANT)).toBeNull();
    // La fin est EXCLUE : à l'heure dite, le véhicule est rendu.
    expect(immobilisationAgendaEnCours([ev({ endAt: new Date(MAINTENANT).toISOString() })], MAINTENANT)).toBeNull();
  });

  it('clôturée ou annulée, elle n’immobilise plus', () => {
    expect(immobilisationAgendaEnCours([ev({ status: 'DONE' })], MAINTENANT)).toBeNull();
    expect(immobilisationAgendaEnCours([ev({ status: 'CANCELLED' })], MAINTENANT)).toBeNull();
    expect(immobilisationAgendaEnCours([ev({ status: 'IN_PROGRESS' })], MAINTENANT)).not.toBeNull();
    expect(immobilisationAgendaEnCours([ev({ status: 'OPEN' })], MAINTENANT)).not.toBeNull();
  });

  it('sans date de fin : une maintenance couvre sa journée (24 h), un incident court jusqu’à sa clôture', () => {
    const debut = MAINTENANT - 23 * H;
    const maintenance = immobilisationAgendaEnCours([ev({ startAt: new Date(debut).toISOString(), endAt: null })], MAINTENANT);
    expect(maintenance?.endAt).toBe(new Date(debut + 24 * H).toISOString());
    // DZ-034-CA (prod, 06/10) : maintenance « en cours » depuis le 21/08 sans fin → expirée depuis.
    expect(
      immobilisationAgendaEnCours([ev({ startAt: new Date(MAINTENANT - 40 * 24 * H).toISOString(), endAt: null, status: 'IN_PROGRESS' })], MAINTENANT),
    ).toBeNull();
    const incident = immobilisationAgendaEnCours(
      [ev({ type: 'INCIDENT', status: 'OPEN', startAt: new Date(MAINTENANT - 40 * 24 * H).toISOString(), endAt: null })],
      MAINTENANT,
    );
    expect(incident).toMatchObject({ type: 'INCIDENT', endAt: null });
  });

  it('plusieurs à la fois : l’incident d’abord, puis la maintenance la plus récente', () => {
    const vieille = ev({ id: 'm-vieille', startAt: new Date(MAINTENANT - 5 * H).toISOString() });
    const recente = ev({ id: 'm-recente', startAt: new Date(MAINTENANT - H).toISOString() });
    expect(immobilisationAgendaEnCours([vieille, recente], MAINTENANT)?.eventId).toBe('m-recente');
    const incident = ev({ id: 'i-1', type: 'INCIDENT', status: 'OPEN', startAt: new Date(MAINTENANT - 9 * H).toISOString() });
    expect(immobilisationAgendaEnCours([recente, incident, vieille], MAINTENANT)?.eventId).toBe('i-1');
  });

  it('ignore une date illisible au lieu d’immobiliser à tort', () => {
    expect(immobilisationAgendaEnCours([ev({ startAt: 'pas une date' })], MAINTENANT)).toBeNull();
  });
});

describe('etatIndisponibilite — la fiche d’abord, puis l’agenda', () => {
  const maintenance: ImmobilisationAgendaDto = {
    eventId: 'm', type: 'MAINTENANCE', title: 'Vidange', startAt: '2026-10-06T08:00:00.000Z', endAt: '2026-10-06T16:00:00.000Z',
  };
  const incident: ImmobilisationAgendaDto = { ...maintenance, eventId: 'i', type: 'INCIDENT', endAt: null };

  it('disponible quand rien n’est déclaré ni posé', () => {
    expect(etatIndisponibilite({})).toBeNull();
    expect(etatIndisponibilite({ outOfServiceReason: null, immobilisationAgenda: null })).toBeNull();
    expect(etatIndisponibilite(undefined)).toBeNull();
  });

  it('chaque motif de la fiche a son état', () => {
    expect(etatIndisponibilite({ outOfServiceReason: 'TRACKER_UNPLUGGED' })).toBe('DEBRANCHE');
    expect(etatIndisponibilite({ outOfServiceReason: 'ACCIDENT' })).toBe('ACCIDENTE');
    expect(etatIndisponibilite({ outOfServiceReason: 'IMMOBILIZED' })).toBe('IMMOBILISE');
  });

  it('l’agenda : maintenance ou incident', () => {
    expect(etatIndisponibilite({ immobilisationAgenda: maintenance })).toBe('MAINTENANCE');
    expect(etatIndisponibilite({ immobilisationAgenda: incident })).toBe('INCIDENT');
  });

  it('⚠️ une déclaration de la fiche l’emporte sur l’agenda', () => {
    expect(etatIndisponibilite({ outOfServiceReason: 'ACCIDENT', immobilisationAgenda: maintenance })).toBe('ACCIDENTE');
    expect(etatIndisponibilite({ outOfServiceReason: 'TRACKER_UNPLUGGED', immobilisationAgenda: incident })).toBe('DEBRANCHE');
  });

  it('un motif inconnu (enum élargi plus tard) ne bloque pas la lecture de l’agenda', () => {
    expect(etatIndisponibilite({ outOfServiceReason: 'AUTRE_CHOSE', immobilisationAgenda: maintenance })).toBe('MAINTENANCE');
  });
});

describe('coupesAutoSuspendues et libellés', () => {
  it('tout état d’indisponibilité suspend les coupes automatiques ; un véhicule disponible non', () => {
    for (const etat of ['DEBRANCHE', 'ACCIDENTE', 'IMMOBILISE', 'MAINTENANCE', 'INCIDENT'] as const) {
      expect(coupesAutoSuspendues(etat)).toBe(true);
    }
    expect(coupesAutoSuspendues(null)).toBe(false);
  });

  it('chaque état a ses deux libellés, en minuscule après une plaque, avec majuscule en titre', () => {
    for (const { court, long } of Object.values(LIBELLES_ETAT)) {
      expect(court).toBe(court.toLowerCase());
      expect(long.charAt(0)).toBe(long.charAt(0).toUpperCase());
    }
    expect(LIBELLES_ETAT.MAINTENANCE.court).toBe('en maintenance');
  });
});
