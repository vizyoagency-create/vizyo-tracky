import { annulationSansObjet, joursCouverts, peutEtreDeplace } from './agenda-calendar.component';

/**
 * LOT MULTI-JOURS (28/09) — « un véhicule en garage, ça peut prendre une semaine ».
 *
 * La grille ne portait une pilule que sur le jour de DÉBUT : une maintenance du 5 au 12
 * disparaissait dès le 6, alors que le panneau du jour la disait immobilisante. Ce prédicat rend
 * les jours qu'un évènement occupe ; la grille pose une « suite » sur chacun après le premier.
 */
describe('joursCouverts', () => {
  it('sans fin : le seul jour de début', () => {
    expect(joursCouverts({ startAt: '2026-10-05T08:00:00', endAt: null })).toEqual(['2026-10-05']);
  });

  it('une fin le même jour : toujours un seul jour', () => {
    expect(joursCouverts({ startAt: '2026-10-05T08:00:00', endAt: '2026-10-05T18:00:00' })).toEqual(['2026-10-05']);
  });

  it('du 5 au 12 : huit jours, le premier compris, le dernier aussi', () => {
    const jours = joursCouverts({ startAt: '2026-10-05T08:00:00', endAt: '2026-10-12T18:00:00' });
    expect(jours.length).toBe(8);
    expect(jours[0]).toBe('2026-10-05');
    expect(jours[7]).toBe('2026-10-12');
  });

  it('une fin à minuit pile le lendemain occupe le lendemain (le véhicule y est encore immobilisé)', () => {
    expect(joursCouverts({ startAt: '2026-10-05T08:00:00', endAt: '2026-10-06T00:00:00' })).toEqual(['2026-10-05', '2026-10-06']);
  });

  it('une fin AVANT le début, ou illisible : on ne raconte rien de plus que le début', () => {
    expect(joursCouverts({ startAt: '2026-10-05T08:00:00', endAt: '2026-10-04T18:00:00' })).toEqual(['2026-10-05']);
    expect(joursCouverts({ startAt: '2026-10-05T08:00:00', endAt: 'pas une date' })).toEqual(['2026-10-05']);
  });

  it('un début illisible ne produit aucun jour', () => {
    expect(joursCouverts({ startAt: 'pas une date', endAt: '2026-10-12T18:00:00' })).toEqual([]);
  });

  it('⚠️ borné : un incident « jusqu’à nouvel ordre » daté d’un an ne fabrique pas 365 pilules', () => {
    expect(joursCouverts({ startAt: '2026-10-05T08:00:00', endAt: '2027-10-05T08:00:00' }).length).toBe(62);
    expect(joursCouverts({ startAt: '2026-10-05T08:00:00', endAt: '2027-10-05T08:00:00' }, 10).length).toBe(10);
  });
});

/**
 * LA REPRISE EN MASSE LAISSAIT AUTANT DE LIGNES BARRÉES QU'ELLE ANNULAIT DE RÉSERVATIONS.
 *
 * Relevé le 2026-09-23, en production, juste après avoir repris les 116 réservations automatiques
 * à venir du cdef31 depuis la feuille « Réorganiser ». Les 116 annulations se sont affichées
 * barrées sur les deux semaines suivantes : l'outil censé désencombrer l'agenda venait de le
 * rendre moins lisible qu'avant qu'on s'en serve.
 *
 * La règle retenue tient en une phrase : un créneau annulé qui n'a pas encore commencé n'aura pas
 * lieu, donc on ne le montre pas ; un créneau annulé qui a déjà commencé a occupé son véhicule un
 * moment, et ce trou mérite d'être visible.
 */
describe('annulationSansObjet', () => {
  const MAINTENANT = Date.parse('2026-09-23T10:00:00.000Z');
  const dans = (ms: number) => new Date(MAINTENANT + ms).toISOString();

  it('masque une annulation dont le créneau est encore à venir', () => {
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: dans(3600_000) }, MAINTENANT)).toBe(true);
  });

  it('GARDE une annulation déjà commencée — le trou dans l’activité s’explique', () => {
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: dans(-3600_000) }, MAINTENANT)).toBe(false);
  });

  it('ne masque RIEN qui ne soit pas annulé, même loin dans le futur', () => {
    for (const status of ['CONFIRMED', 'REQUESTED', 'IN_PROGRESS', 'DONE', 'PLANNED']) {
      expect(annulationSansObjet({ status, startAt: dans(7 * 24 * 3600_000) }, MAINTENANT)).toBe(false);
    }
  });

  it('traite un statut absent comme « pas annulé » plutôt que de le faire disparaître', () => {
    expect(annulationSansObjet({ startAt: dans(3600_000) }, MAINTENANT)).toBe(false);
    expect(annulationSansObjet({ status: null, startAt: dans(3600_000) }, MAINTENANT)).toBe(false);
  });

  /**
   * ⚠️ Une date illisible ne doit pas faire disparaître la ligne : on ne sait pas si elle est
   * passée, et un événement qu'on n'affiche pas est un événement qu'on ne peut pas corriger.
   */
  it('garde une ligne dont la date est illisible', () => {
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: 'pas une date' }, MAINTENANT)).toBe(false);
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: '' }, MAINTENANT)).toBe(false);
  });

  /** La borne est le DÉBUT, et elle est stricte : commencer à la seconde présente, c'est commencé. */
  it('ne masque pas une annulation qui commence à l’instant même', () => {
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: dans(0) }, MAINTENANT)).toBe(false);
  });
});

/**
 * LE GLISSER-DÉPOSER DÉPLACE UN ENGAGEMENT EN UN DEMI-SECONDE.
 *
 * Ajouté le 2026-09-23 avec le geste lui-même. Ce prédicat est le seul garde-fou entre un
 * mouvement de pouce et le déplacement d'une réservation : il mérite d'être éprouvé ligne à
 * ligne, y compris sur les cas qu'on n'a pas envie d'écrire.
 */
describe('peutEtreDeplace', () => {
  const TOUT = { agenda: true, reservations: true };
  const RIEN = { agenda: false, reservations: false };

  it('laisse déplacer une maintenance planifiée à qui gère l’agenda', () => {
    expect(peutEtreDeplace({ type: 'MAINTENANCE', status: 'PLANNED' }, TOUT)).toBe(true);
    expect(peutEtreDeplace({ type: 'MAINTENANCE', status: 'PLANNED' }, RIEN)).toBe(false);
  });

  /** Déplacer une réservation, c'est la même autorité que la valider — pas celle de l'agenda. */
  it('exige `reservations_manage` pour une réservation, pas `agenda_manage`', () => {
    const agendaSeul = { agenda: true, reservations: false };
    expect(peutEtreDeplace({ type: 'RESERVATION', status: 'CONFIRMED' }, agendaSeul)).toBe(false);
    expect(peutEtreDeplace({ type: 'RESERVATION', status: 'CONFIRMED' }, TOUT)).toBe(true);
  });

  /** Le cas qui compte le plus : une mission engage un TIERS. */
  it('ne laisse JAMAIS déplacer une mission, même avec tous les droits', () => {
    for (const status of ['PLANNED', 'OPEN', 'IN_PROGRESS'] as const) {
      expect(peutEtreDeplace({ type: 'MISSION', status }, TOUT)).toBe(false);
    }
  });

  it('refuse ce qui est clôturé ou annulé', () => {
    expect(peutEtreDeplace({ type: 'MAINTENANCE', status: 'DONE' }, TOUT)).toBe(false);
    expect(peutEtreDeplace({ type: 'RESERVATION', status: 'CANCELLED' }, TOUT)).toBe(false);
  });
});
