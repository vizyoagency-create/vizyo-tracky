/**
 * ══ TRK-037 — LE NIVEAU « DÉGRADATION » ═══════════════════════════════════════════════
 *
 * Le centre d'alerte a longtemps mélangé deux choses que rien ne distinguait :
 *
 *   1. **un défaut** — quelque chose ne marche pas, quelqu'un doit agir ;
 *   2. **une dégradation ASSUMÉE** — une dépendance tierce gratuite est momentanément
 *      injoignable, la fonctionnalité se replie proprement, et le propriétaire a
 *      explicitement accepté la contrepartie. *Personne n'a rien à faire.*
 *
 * Mesuré le 2026-08-26 : **14 des 18 lignes actives** étaient de la seconde espèce
 * (Overpass/OpenStreetMap injoignable, cf. [TRK-037]). Un exploitant qui ouvre le centre
 * d'alerte y lit « 18 erreurs » et ne peut pas savoir que 14 ne demandent rien.
 *
 * 🔑 **Ce n'est PAS un correctif qui vide l'écran.** La ligne est toujours écrite, toujours
 * consultable, toujours horodatée, et son refroidissement reste en place. Ce qui change est sa
 * CLASSE : elle ne compte plus comme une erreur à traiter. *Un correctif qui ne fait que vider
 * l'écran n'est pas un correctif — celui-ci ne cache rien, il nomme.*
 *
 * ⚠️ **Ce niveau est réservé à une dégradation dont le repli est PROPRE et la perte BORNÉE**,
 * et dont le propriétaire a accepté la contrepartie par écrit. Dans le doute : `ERROR`. Une
 * dégradation qu'on n'a pas su borner est un défaut, et elle doit crier.
 */

/** Une dépendance tierce s'est dégradée, le repli a fonctionné, aucune action n'est attendue. */
export const NIVEAU_DEGRADATION = 'DEGRADATION' as const;

/** Les niveaux qui décrivent un DÉFAUT — ceux que le centre d'alerte compte. */
export type NiveauErreur = 'ERROR' | 'CRITICAL' | typeof NIVEAU_DEGRADATION;

/**
 * Clause Prisma « tout sauf les dégradations assumées ».
 *
 * ⚠️ Utilise `not`, PAS une liste blanche `in: ['ERROR','CRITICAL']` : la colonne `level` est
 * une chaîne libre en base, et une liste blanche ferait disparaître en silence tout niveau
 * futur que personne n'aurait pensé à y ajouter. Exclure ce qu'on connaît est sûr ; n'inclure
 * que ce qu'on connaît ne l'est pas.
 */
export const HORS_DEGRADATION = { level: { not: NIVEAU_DEGRADATION } } as const;

/** Vrai si cette ligne décrit une dégradation assumée plutôt qu'un défaut. */
export function estDegradation(ligne: { level: string }): boolean {
  return ligne.level === NIVEAU_DEGRADATION;
}
