/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * CO₂ ÉMIS PAR LITRE DE CARBURANT — une seule table, pour tout le produit.
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── POURQUOI ELLE DÉMÉNAGE ICI (2026-09-04) ─────────────────────────────────────────────
 *
 * Elle vivait dans le préprocesseur d'analyse de trajet, et nulle part ailleurs. Le CO₂
 * n'existait donc qu'au TRAJET : la page Rapports, qui affiche pourtant le carburant de la
 * période, n'avait aucun moyen d'en dire le CO₂ sans recopier ces quatre nombres. Une table
 * recopiée est une table qui divergera — et deux écrans qui annoncent deux empreintes pour
 * la même flotte ne sont pas un détail cosmétique : c'est un chiffre qu'un client peut mettre
 * dans son bilan.
 *
 * ⚠️ Facteurs de combustion « du réservoir à la roue » (tank-to-wheel), en kg de CO₂ par
 * litre brûlé. Ils ne comptent PAS la production ni le transport du carburant : ce n'est pas
 * une analyse de cycle de vie, et rien de ce que le produit affiche ne doit le laisser croire.
 *
 * ⚠️ Ce fichier ne connaît ni Prisma ni Angular : c'est la condition pour qu'il n'y en ait
 * qu'un.
 */

/** kg de CO₂ par litre brûlé, par énergie. */
export const CO2_KG_PAR_LITRE: Record<string, number> = {
  DIESEL: 2.68,
  ESSENCE: 2.31,
  HYBRIDE: 2.0,
  AUTRE: 2.4,
};

/**
 * Facteur retenu quand l'énergie est inconnue ou absente de la table.
 *
 * ⚠️ C'est une valeur intermédiaire assumée, pas un zéro. Rendre zéro pour une énergie
 * inconnue ferait disparaître l'empreinte d'un véhicule mal renseigné — la fiche incomplète
 * deviendrait alors le moyen le plus simple d'afficher un bon bilan.
 */
export const CO2_KG_PAR_LITRE_DEFAUT = 2.4;

/** Le facteur d'une énergie, quelle que soit sa casse. `null`/absent → le défaut. */
export function facteurCo2(energie: string | null | undefined): number {
  if (!energie) return CO2_KG_PAR_LITRE_DEFAUT;
  return CO2_KG_PAR_LITRE[energie.toUpperCase()] ?? CO2_KG_PAR_LITRE_DEFAUT;
}

/**
 * CO₂ émis par une quantité de carburant, en kg — arrondi au centième.
 *
 * ⚠️ Un véhicule ÉLECTRIQUE ne brûle rien : il n'appelle pas cette fonction, il ne consomme
 * aucun litre. Lui attribuer un facteur, fût-il nul, reviendrait à prétendre qu'on a mesuré
 * son empreinte alors qu'on ne sait rien de l'électricité qu'il a chargée.
 */
export function co2DuCarburant(litres: number, energie: string | null | undefined): number {
  return Math.round(litres * facteurCo2(energie) * 100) / 100;
}
