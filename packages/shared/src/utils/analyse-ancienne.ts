/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * « CETTE ANALYSE A-T-ELLE ÉTÉ ÉCRITE AVANT LA RÈGLE ACTUELLE ? » — et peut-elle être reprise ?
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Les analyses écrites avant le 4 septembre 2026 n'ont ni le taux de couverture des limites,
 * ni la réserve sur la vitesse annoncée, ni le détail de la note. Leur détail stocké peut
 * contenir de FAUX excès — des dépassements bâtis sur un seul point, dont un « limite 30,
 * relevé à 154 km/h » qui est en réalité un point rattaché au pont qui franchit la rocade.
 *
 * Les écrans ne les COMPTENT plus : ils relisent le détail avec la règle actuelle, qui écarte
 * les segments de durée nulle. Mais la donnée, elle, reste fausse — et le rattrapage horaire
 * ne peut rejouer que les trajets dont les positions GPS existent encore.
 *
 * ⚠️ Une seule définition, partagée par le rattrapage (SQL), l'écran d'automatisation et la
 * modale d'analyse : trois endroits, un seul critère. Le produit a déjà payé le prix de deux
 * définitions de « reste à faire » — deux écrans, deux totaux, aucun moyen de dire lequel
 * mentait.
 */

/** L'analyse a-t-elle été écrite AVANT le lot V1 ? Sa marque est l'absence de `detail.vitesse`. */
export function analyseAvantRegleActuelle(
  analyse: { detail?: { vitesse?: unknown } | null } | null | undefined,
): boolean {
  return !!analyse && !analyse.detail?.vitesse;
}

/**
 * Les positions de ce trajet sont-elles encore là pour permettre une reprise ?
 *
 * ⚠️ Comparé à l'HORIZON DE RÉTENTION, pas à une date figée : le jour où la rétention change,
 * la réponse suit. Marquer les lignes en base aurait figé un jugement qui dépend d'un horizon
 * mobile — une analyse « hors de portée » aujourd'hui redeviendrait reprenable demain sans que
 * la marque bouge.
 */
export function analyseHorsDePortee(
  departTrajet: Date | string | number,
  horizonRetention: Date | string | number,
): boolean {
  const t = new Date(departTrajet).getTime();
  const h = new Date(horizonRetention).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(h)) return false;
  return t <= h;
}
