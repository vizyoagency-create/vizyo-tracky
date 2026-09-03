import { parisDayKey, parisDayStart } from './datetime';

/**
 * Jours civils Europe/Paris — la règle que les rapports doivent partager avec l'écran.
 *
 * L'écran raisonne en jours LOCAUX (« Aujourd'hui », « 7 jours », graphique par jour) ;
 * l'API lisait « 2026-08-03 » comme minuit UTC et groupait par jour UTC. Décalage d'une à
 * deux heures selon la saison : 21 trajets sur 391 changeaient de jour entre le tableau et
 * le graphique d'activité, et « Aujourd'hui » excluait les départs entre minuit et 2 h.
 */
describe('jours civils Europe/Paris', () => {
  it('parisDayKey : 22:40Z un soir d\'été est DÉJÀ le lendemain à Paris', () => {
    expect(parisDayKey(new Date('2026-08-10T22:40:00Z'))).toBe('2026-08-11');
    expect(parisDayKey(new Date('2026-08-10T21:59:59Z'))).toBe('2026-08-10');
  });

  it('parisDayKey : l\'hiver, la bascule est à 23:00Z', () => {
    expect(parisDayKey(new Date('2026-01-10T23:10:00Z'))).toBe('2026-01-11');
    expect(parisDayKey(new Date('2026-01-10T22:50:00Z'))).toBe('2026-01-10');
  });

  it('parisDayStart : minuit à Paris = 22:00Z l\'été, 23:00Z l\'hiver', () => {
    expect(parisDayStart('2026-08-03').toISOString()).toBe('2026-08-02T22:00:00.000Z');
    expect(parisDayStart('2026-01-15').toISOString()).toBe('2026-01-14T23:00:00.000Z');
  });

  it('parisDayStart : les jours de changement d\'heure tombent juste', () => {
    // Passage à l'heure d'été (dernier dimanche de mars 2026 = 29) : minuit est encore en hiver.
    expect(parisDayStart('2026-03-29').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    // Lendemain : l'été est là.
    expect(parisDayStart('2026-03-30').toISOString()).toBe('2026-03-29T22:00:00.000Z');
    // Retour à l'heure d'hiver (25 octobre 2026) : minuit est encore en été.
    expect(parisDayStart('2026-10-25').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(parisDayStart('2026-10-26').toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('parisDayStart : un ISO complet (avec heure) est lu tel quel', () => {
    expect(parisDayStart('2026-08-03T10:30:00Z').toISOString()).toBe('2026-08-03T10:30:00.000Z');
  });

  it('aller-retour : la clé du minuit d\'un jour est ce jour', () => {
    for (const d of ['2026-01-01', '2026-03-29', '2026-06-30', '2026-10-25', '2026-12-31']) {
      expect(parisDayKey(parisDayStart(d))).toBe(d);
    }
  });
});
