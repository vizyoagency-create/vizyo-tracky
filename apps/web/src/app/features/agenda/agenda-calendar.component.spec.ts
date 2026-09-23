import { annulationSansObjet } from './agenda-calendar.component';

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
