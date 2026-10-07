import { HttpErrorResponse } from '@angular/common/http';

/**
 * Les libellés que le filtre de l'API pose sur une panne NON maîtrisée (exception non gérée :
 * « Internal server error », « Unknown error » — `all-exceptions.filter.ts`), et celui de Nest
 * pour une `InternalServerErrorException` sans texte. Ce ne sont pas des motifs : l'écran garde
 * alors son propre texte, en français et dans son contexte.
 */
const LIBELLES_SANS_MOTIF = new Set(['internal server error', 'unknown error']);

/**
 * Le motif qu'une réponse d'erreur de l'API porte, lu au BON niveau — ou `undefined`.
 *
 * HttpClient range le corps de la réponse dans `err.error`, et l'API l'enveloppe TOUJOURS, depuis
 * la première version de son filtre (13/04/2026) : `{ error: { code, message, requestId } }`. Le
 * motif est donc `err.error.error.message`. Lire `err.error.message` — la forme plate — rend
 * `undefined` sur TOUTE erreur de l'API : 53 lectures dans 32 écrans disaient « Échec » sans
 * jamais dire pourquoi (recensées le 07/10/2026). La forme plate reste lue en repli.
 *
 * Accepte toute erreur qui porte un corps dans `error` (pas seulement une `HttpErrorResponse`) :
 * c'est le remplaçant exact des lectures à plat. Une liste (messages de validation) est jointe, ce
 * qui n'est pas du texte est ignoré, un texte vide n'est pas un motif.
 */
export function motifErreurApi(err: unknown): string | undefined {
  const corps = (err as { error?: unknown } | null | undefined)?.error;
  if (!corps || typeof corps !== 'object') return undefined;
  const { error: enveloppe, message: aPlat } = corps as { error?: unknown; message?: unknown };
  const brut =
    (enveloppe && typeof enveloppe === 'object' ? (enveloppe as { message?: unknown }).message : undefined) ?? aPlat;
  const texte = (
    Array.isArray(brut) ? brut.filter((m) => typeof m === 'string').join(' · ') : typeof brut === 'string' ? brut : ''
  ).trim();
  return texte && !LIBELLES_SANS_MOTIF.has(texte.toLowerCase()) ? texte : undefined;
}

/**
 * Message d'erreur API lisible pour l'utilisateur : le motif du serveur (`motifErreurApi`), sinon
 * « serveur injoignable » quand la requête n'a pas abouti, sinon le repli de l'écran.
 */
export function apiErrorMessage(err: unknown, fallback = 'Une erreur est survenue.'): string {
  if (err instanceof HttpErrorResponse) {
    const motif = motifErreurApi(err);
    if (motif) return motif;
    if (err.status === 0) return 'Serveur injoignable. Vérifiez votre connexion.';
    return fallback;
  }
  return fallback;
}
