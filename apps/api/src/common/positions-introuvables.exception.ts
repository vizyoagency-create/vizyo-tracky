import { UnprocessableEntityException } from '@nestjs/common';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * « LES POSITIONS DE CE TRAJET N'EXISTENT PLUS » — UN REFUS, PAS UN INCIDENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'analyse refuse d'écrire un zéro inventé sur un trajet qui a roulé mais dont les positions
 * ont disparu (purge de rétention, le plus souvent). Ce refus est la BONNE décision, et il est
 * couvert par `analyse-vide.spec.ts` depuis le 2026-08-21.
 *
 * ── POURQUOI UNE CLASSE, ET PAS UN `UnprocessableEntityException` NU ────────────────────
 *
 * Parce que trois appelants doivent le reconnaître SANS lire son message :
 *   1. `TripAnalysisService.analyze()` ne l'archive pas au centre d'alerte. Un refus délibéré
 *      n'est pas une panne, et l'archiver annulait le silence que ses appelants voulaient.
 *   2. `TripAutomationService` fige le trajet — sous l'horizon de rétention comme au-dessus,
 *      avec un marqueur distinct — pour qu'aucun passage ne le resélectionne à vie.
 *   3. Le filtre d'exceptions HTTP laisse passer les 4xx : le client reçoit son message.
 *
 * Mesuré en production le 2026-09-08, faute de cette distinction : le trajet du 08/07 de
 * HD-597-XY, 3,2 km, zéro position conservée, a écrit **20 lignes d'erreur en 27 heures**, une
 * par passage horaire, sans que rien ne puisse jamais y remédier. Le message était juste ; sa
 * répétition ne servait personne.
 *
 * ⚠️ Reste un `UnprocessableEntityException` : le code HTTP (422) et le corps ne changent pas.
 * Ce qui change est la capacité du code appelant à dire « je sais ce que c'est ».
 */
export class PositionsIntrouvablesException extends UnprocessableEntityException {
  constructor(message: string) {
    super(message);
  }
}
