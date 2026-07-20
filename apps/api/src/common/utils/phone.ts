/**
 * Normalisation E.164 d'un numéro (incident 2026-07-19).
 *
 * Le catalogue WhereverSIM renvoie les MSISDN **sans le `+`** (ex. `345901030605196`). Recopiés
 * tels quels sur un boîtier, ils rendaient tout SMS impossible — donc le repli SMS du coupe-circuit
 * inopérant sur 17 véhicules, sans que ça se voie autrement que par une avalanche d'erreurs.
 *
 * Règle VOLONTAIREMENT prudente : on n'ajoute le `+` que si la chaîne est **uniquement** des
 * chiffres, de longueur plausible (8–15, borne E.164) et **ne commence pas par 0**. Un numéro
 * national (`0612345678`) doit être REJETÉ, pas transformé en `+0612345678` : mieux vaut un envoi
 * refusé qu'un SMS parti au mauvais numéro. Tout le reste est renvoyé tel quel — la validation
 * finale reste à l'appelant.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Espaces, points, tirets et parenthèses de mise en forme : sans signification.
  const cleaned = raw.trim().replace(/[\s.\-()]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+')) return cleaned;
  if (/^[1-9]\d{7,14}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}

/** Le numéro est-il exploitable pour un envoi SMS (E.164 complet) ? */
export function isE164(value: string | null | undefined): boolean {
  return !!value && /^\+[1-9]\d{7,14}$/.test(value.trim());
}
