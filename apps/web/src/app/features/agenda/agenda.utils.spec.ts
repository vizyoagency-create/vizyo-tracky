import type { VehicleEventType } from '@vizyo/tracky-shared';
import { estUneEcheance, eventTypeLabel } from './agenda.utils';

/**
 * L'AGENDA AFFICHAIT « MISSION » EN CAPITALES, AU MILIEU DE « MAINTENANCE » ET « RÉSERVATION ».
 *
 * Relevé le 2026-09-23. `eventTypeLabel` ne connaissait pas `MISSION` : son `default` renvoyait
 * l'énumération telle quelle. Les missions vivent pourtant dans la MÊME grille que le reste depuis
 * 2026-08 (A2 § 3.1, « un gestionnaire qui ne voit pas les missions double-réserve ») — elles
 * doivent donc se nommer comme le reste.
 *
 * Ce test vaut surtout pour LE PROCHAIN TYPE : il échouera le jour où l'on en ajoutera un sans lui
 * donner de libellé, au lieu de le découvrir sur l'écran d'un client.
 */
describe('eventTypeLabel', () => {
  const TOUS: VehicleEventType[] = ['MAINTENANCE', 'INCIDENT', 'RESERVATION', 'MISSION'];

  it('nomme chaque type en français', () => {
    expect(eventTypeLabel('MAINTENANCE')).toBe('Maintenance');
    expect(eventTypeLabel('INCIDENT')).toBe('Incident');
    expect(eventTypeLabel('RESERVATION')).toBe('Réservation');
    expect(eventTypeLabel('MISSION')).toBe('Mission');
  });

  it('ne laisse AUCUN type retomber sur son énumération brute', () => {
    for (const t of TOUS) {
      const libelle = eventTypeLabel(t);
      expect(libelle).not.toBe(t);
      // Un libellé destiné à l'écran n'est jamais tout en capitales.
      expect(libelle).not.toBe(libelle.toUpperCase());
    }
  });
});

/**
 * « COMPTEUR ≠ LISTE » (audit du 24/09). Le compteur « En retard » ne comptait que les PLANNED,
 * la liste dessous affichait aussi OPEN et IN_PROGRESS : « 1 en retard » au-dessus de trois lignes
 * rouges. `estUneEcheance` est désormais LA règle des deux côtés — ces tests la fixent, et le
 * serveur (`summary`) compte exactement la même chose.
 */
describe('estUneEcheance — la règle unique de la liste « À venir & en retard »', () => {
  const NOW = Date.parse('2026-09-28T08:00:00Z');
  const HIER = '2026-09-27T08:00:00Z';
  const DEMAIN = '2026-09-29T08:00:00Z';

  it('un PLANNED est une échéance, passée (en retard) comme future (à venir)', () => {
    expect(estUneEcheance({ status: 'PLANNED', startAt: HIER }, NOW)).toBe(true);
    expect(estUneEcheance({ status: 'PLANNED', startAt: DEMAIN }, NOW)).toBe(true);
  });

  it('un OPEN dont l’échéance est passée est en retard — c’est le contrat du compteur', () => {
    expect(estUneEcheance({ status: 'OPEN', startAt: HIER }, NOW)).toBe(true);
  });

  it('un OPEN à échéance future ne compte nulle part, donc ne s’affiche pas', () => {
    expect(estUneEcheance({ status: 'OPEN', startAt: DEMAIN }, NOW)).toBe(false);
  });

  it('⚠️ un IN_PROGRESS n’est ni à venir ni en retard : il est EN COURS, ailleurs', () => {
    expect(estUneEcheance({ status: 'IN_PROGRESS', startAt: HIER }, NOW)).toBe(false);
    expect(estUneEcheance({ status: 'IN_PROGRESS', startAt: DEMAIN }, NOW)).toBe(false);
  });

  it('les états clos et les réservations ne sont pas des échéances', () => {
    for (const status of ['DONE', 'CANCELLED', 'REQUESTED', 'CONFIRMED'] as const) {
      expect(estUneEcheance({ status, startAt: HIER }, NOW)).toBe(false);
      expect(estUneEcheance({ status, startAt: DEMAIN }, NOW)).toBe(false);
    }
  });

  it('une date illisible sur un OPEN ne le fait pas passer pour en retard', () => {
    expect(estUneEcheance({ status: 'OPEN', startAt: 'pas-une-date' }, NOW)).toBe(false);
  });
});
