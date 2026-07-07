import { HttpErrorResponse } from '@angular/common/http';

/**
 * Message d'erreur API lisible pour l'utilisateur.
 *
 * Le backend enveloppe TOUJOURS ses erreurs : `{ error: { code, message, requestId } }`
 * (voir `all-exceptions.filter.ts`). Lire `err.error.message` (à plat) renvoie donc `undefined`
 * et masque le vrai motif — d'où ce helper unique : message IMBRIQUÉ d'abord, message à plat
 * ensuite (compat.), puis un repli explicite selon le statut.
 */
export function apiErrorMessage(err: unknown, fallback = 'Une erreur est survenue.'): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { message?: string; error?: { message?: string } } | null;
    const m = body?.error?.message ?? body?.message;
    if (typeof m === 'string' && m.trim()) return m;
    if (err.status === 0) return 'Serveur injoignable. Vérifiez votre connexion.';
    return fallback;
  }
  return fallback;
}
