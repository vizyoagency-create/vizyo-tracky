import { ServiceUnavailableException } from '@nestjs/common';

/**
 * REFUS DÉLIBÉRÉ — une décision de la plateforme, pas une panne.
 *
 * ══ Le défaut que ça corrige (TRK-004) ════════════════════════════════════════════════
 *
 * Certaines portes refusent volontairement un service : plafond de dépense IA atteint,
 * assistance IA coupée pour une société. Elles répondaient en `ServiceUnavailableException`
 * (503), et `AllExceptionsFilter` archive tout ce qui est ≥ 500. Résultat : **la gouvernance
 * qui fonctionne parfaitement produisait une erreur au centre d'alerte.** Un plafond atteint
 * n'est pas une faute — c'est le plafond qui fait son travail.
 *
 * ══ Pourquoi une classe et pas une reconnaissance de message ══════════════════════════
 *
 * Le contrat est **structurel**, jamais textuel. Reconnaître « budget » ou « désactivé »
 * dans un message serait fragile et finirait par attraper de vraies pannes au passage —
 * c'est le raisonnement déjà écrit pour `isTransient` dans `error-logger.service.ts`.
 *
 * ══ Ce qui NE change PAS ══════════════════════════════════════════════════════════════
 *
 * La réponse HTTP est **strictement identique** : on hérite de `ServiceUnavailableException`
 * précisément pour que le corps (`statusCode`, `message`, `error: 'Service Unavailable'`) ne
 * bouge pas d'un octet. Le front continue de distinguer « refusé » de « en panne » comme
 * avant. Seule la journalisation disparaît.
 *
 * ⚠️ À n'utiliser que pour un refus DÉCIDÉ par nous. Une dépendance qui tombe reste une
 * panne : elle doit continuer de remonter.
 */
export class ExpectedRefusalException extends ServiceUnavailableException {
  /** Marqueur lu en canard-typage par `AllExceptionsFilter` (aucun import croisé). */
  public readonly expectedRefusal = true;
}

/** Vrai si l'exception se déclare comme un refus délibéré. */
export function isExpectedRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { expectedRefusal?: unknown }).expectedRefusal === true
  );
}
