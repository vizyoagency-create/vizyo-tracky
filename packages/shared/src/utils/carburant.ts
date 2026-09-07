/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * DE L'ÉNERGIE D'UN VÉHICULE AU CARBURANT D'UNE POMPE
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * `Vehicle.energy` dit DIESEL, ESSENCE, ÉLECTRIQUE… ; le flux officiel des prix
 * (`data.economie.gouv.fr`) parle gazole, e10, sp95, sp98, e85, gplc. Cette table fait le
 * pont, et il n'y en a qu'une.
 *
 * ── POURQUOI ELLE DÉMÉNAGE ICI (2026-09-07) ─────────────────────────────────────────────
 *
 * Elle vivait dans le service qui interroge les stations, donc au seul moment où l'on CAPTE
 * un prix. Les rapports, eux, doivent faire le chemin inverse — « pour ce véhicule, quel
 * prix constaté appliquer ? » — parce que le coût carburant ne peut pas se calculer avec un
 * prix unique sur un parc qui mêle essence, diesel et électrique. Sans elle ici, cette
 * question se serait répondue par une seconde table recopiée : deux tables divergent, et
 * l'écart se lit en euros sur la facture d'un client.
 *
 * ⚠️ Ce fichier ne connaît ni Prisma ni Angular : c'est la condition pour qu'il n'y en ait
 * qu'un.
 */

/**
 * Le carburant de pompe correspondant à une énergie de véhicule, ou `null` quand la question
 * n'a pas de sens (électrique) ou n'a pas de réponse (énergie absente, hybride rechargeable
 * dont on ne sait pas ce qu'il met dans le réservoir).
 *
 * ⚠️ `ESSENCE` → `e10`, et pas `sp95`. C'est le carburant essence le plus distribué en France
 * et le moins cher des trois : à défaut de savoir ce que le conducteur met réellement, on
 * choisit l'hypothèse qui ne GONFLE pas la facture qu'on présente au client.
 */
export function carburantDePompe(energie: string | null | undefined): string | null {
  if (!energie) return null;
  const e = energie.toUpperCase();
  if (e.includes('DIESEL') || e.includes('GAZOLE') || e.includes('GASOIL') || e.includes('GAZOIL')) return 'gazole';
  if (e.includes('GPL') || e.includes('LPG')) return 'gplc';
  if (e.includes('E85') || e.includes('ETHANOL') || e.includes('SUPERETHANOL')) return 'e85';
  if (e.includes('ELEC') || e.includes('HYBRID')) return null; // électrique/hybride : pas de prix carburant liquide
  if (e.includes('SP98')) return 'sp98';
  if (e.includes('SP95') || e.includes('E10')) return 'e10';
  if (e.includes('ESSENCE') || e.includes('GASOLINE') || e.includes('PETROL') || e.includes('BENZIN')) return 'e10';
  return null;
}

/** Le libellé lisible d'un carburant de pompe, pour les documents. */
export function libelleCarburant(carburant: string): string {
  const t: Record<string, string> = {
    gazole: 'gazole', e10: 'essence E10', sp95: 'essence SP95',
    sp98: 'essence SP98', e85: 'superéthanol E85', gplc: 'GPL',
  };
  return t[carburant] ?? carburant;
}
