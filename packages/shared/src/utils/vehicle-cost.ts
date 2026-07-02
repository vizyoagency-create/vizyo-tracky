/**
 * Coût/km INDICATIF (€) d'un véhicule selon son énergie. Prix carburant TTC moyens France
 * (approximatifs, 2026) ; l'électrique est un forfait recharge dépôt. Volontairement grossier :
 * sert au CLASSEMENT relatif (mutualiser vers le moins cher à mission égale), PAS à une facturation.
 * SOURCE UNIQUE partagée : optimiseur IA de placement + dashboard d'optimisation d'agenda.
 */
export const FUEL_PRICE_EUR_PER_L: Record<string, number> = { DIESEL: 1.75, ESSENCE: 1.9, HYBRIDE: 1.9 };
export const DEFAULT_CONSO_L100: Record<string, number> = { DIESEL: 6.5, ESSENCE: 7.5, HYBRIDE: 5 };
export const ELECTRIC_COST_PER_KM = 0.03;

/** Estime un coût/km (€) depuis l'énergie + la conso (L/100km si connue, sinon défaut par énergie). */
export function estimateCostPerKm(
  energy: string | null | undefined,
  consoL100: number | null | undefined,
): number | null {
  if (!energy) return null;
  if (energy === 'ELECTRIQUE') return ELECTRIC_COST_PER_KM;
  const price = FUEL_PRICE_EUR_PER_L[energy];
  if (!price) return null;
  const conso = consoL100 && consoL100 > 0 ? consoL100 : DEFAULT_CONSO_L100[energy];
  if (!conso) return null;
  return Math.round((conso / 100) * price * 1000) / 1000; // €/km, 3 décimales
}
