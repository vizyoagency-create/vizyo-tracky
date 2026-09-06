/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * UNE PART EN POURCENTAGE QUI NE CONTREDIT JAMAIS LES NOMBRES QU'ELLE ACCOMPAGNE
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le produit écrit partout la même forme : « 1 866 trajets sur 1 886 (99 %, 11 460 km) ». Les
 * deux nombres sont exacts ; c'est l'arrondi du pourcentage qui peut mentir, et il ment aux
 * deux bouts :
 *
 *   - « 1 sur 1 000 » arrondi à 0 % dirait « aucun », alors qu'il y en a un ;
 *   - « 999 sur 1 000 » arrondi à 100 % dirait « tous », alors qu'il en manque un.
 *
 * D'où la règle : un extrême ne s'affirme que si les nombres l'atteignent VRAIMENT. Sinon on
 * écrit « < 1 % » ou « > 99 % », qui restent vrais.
 *
 * ── POURQUOI CETTE RÈGLE VIT DANS LE CONTRAT PARTAGÉ ────────────────────────────────────
 *
 * Elle a été recopiée TROIS fois — la page Rapports, l'écran des scores et le PDF —, sur les
 * MÊMES trajets et sous les MÊMES yeux : le gestionnaire ouvre son PDF à côté de son écran.
 * « 99 % » ici et « 100 % » là-bas se lit comme une erreur de calcul, pas comme une nuance
 * d'arrondi, et fait douter des deux nombres qui, eux, étaient justes. Trois copies auraient
 * fini par diverger ; c'est la faute que ce dépôt a déjà payée sur « reste à faire », sur
 * « avec excès » et sur la clé d'imputation.
 *
 * @param n numérateur (par exemple les trajets non attribués)
 * @param d dénominateur (le total RÉEL de la période, jamais la somme des lignes classées)
 */
export function partLibelle(n: number, d: number): string {
  if (d <= 0 || n <= 0) return '0 %';
  if (n >= d) return '100 %';
  const p = Math.round((n / d) * 100);
  return p === 0 ? '< 1 %' : p === 100 ? '> 99 %' : `${p} %`;
}
