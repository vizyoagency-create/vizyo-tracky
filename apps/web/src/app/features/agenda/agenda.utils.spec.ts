import type { VehicleEventType } from '@vizyo/tracky-shared';
import { eventTypeLabel } from './agenda.utils';

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
