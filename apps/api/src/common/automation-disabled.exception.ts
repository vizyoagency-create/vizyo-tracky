import { ConflictException } from '@nestjs/common';

/**
 * « LANCER MAINTENANT » NE CONTOURNE PLUS SON INTERRUPTEUR (design/C3, point 2, 2026-09-05).
 *
 * ══ Le défaut que ça corrige ═══════════════════════════════════════════════════════════
 *
 * Quatre boutons de lancement manuel — l'agent d'agenda, l'automatisation des trajets, celle
 * des lieux et l'envoi immédiat du rapport hebdomadaire — tournaient QUAND MÊME quand leur
 * interrupteur était coupé. L'interrupteur ne gouvernait que la planification : couper
 * « Automatisation des trajets » n'empêchait personne de déclencher un passage complet d'un
 * clic, et « Envoyer maintenant » partait vers de vraies boîtes aux lettres alors que la
 * société avait coupé l'envoi. Un réglage qu'un bouton contourne n'est pas un réglage.
 *
 * ══ Pourquoi 409 et pas autre chose ══════════════════════════════════════════════════════
 *
 * Le refus tient à l'ÉTAT de la ressource, pas à l'appelant ni à la requête :
 *   · pas 403 — l'appelant a le droit de lancer ; c'est le réglage qui est coupé. Un 403
 *     ferait chercher un problème de permission qui n'existe pas ;
 *   · pas 400 — la requête est bien formée ;
 *   · pas 503 — rien n'est en panne. Un 503 est ≥ 500 : `AllExceptionsFilter` l'archiverait
 *     au centre d'alerte (c'est le défaut TRK-004 qu'`ExpectedRefusalException` a dû
 *     contourner avec un marqueur). Ici, pas besoin de marqueur : le filtre n'archive que
 *     `status >= 500` ou les exceptions hors `HttpException` — un 409 n'y entre jamais.
 *
 * 409 Conflict dit exactement cela : « l'état actuel de la ressource est incompatible avec
 * l'action demandée ». Le corps HTTP reste celui de Nest (`statusCode`, `message`,
 * `error: 'Conflict'`) et le front lit `message` via `apiErrorMessage` : le texte français
 * passé par l'appelant arrive tel quel dans le toast ou la pastille.
 *
 * ══ Règle d'emploi ═══════════════════════════════════════════════════════════════════════
 *
 * Réservée au refus d'un lancement MANUEL. Les passages PLANIFIÉS gardent leur no-op
 * silencieux (un cron qui lève casserait le scheduler), et les déclencheurs événementiels
 * ne sont pas concernés. Le message est fourni par l'appelant, en français, et doit dire
 * QUOI faire (« activez-le et enregistrez ») — un 409 nu ne dit rien à personne.
 */
export class AutomationDisabledException extends ConflictException {
  constructor(message: string) {
    super(message);
  }
}
