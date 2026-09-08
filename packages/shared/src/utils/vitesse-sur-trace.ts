import { haversineMeters } from './gps-sanity';

/** Un relevé GPS : une position et la vitesse annoncée à cet instant. */
export interface ReleveVitesse {
  readonly lat: number;
  readonly lng: number;
  readonly speedKmh: number | null | undefined;
}

/**
 * La vitesse de CHAQUE SOMMET d'un tracé, lue sur les relevés GPS.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI DEUX SUITES ET PAS UNE                                            │
 * │                                                                            │
 * │ La géométrie d'un trajet et ses vitesses ne vivent pas au même endroit :   │
 * │ le tracé qui suit la route est la polyligne recalée (OSRM), dense, sans    │
 * │ vitesse ; les vitesses sont dans les positions brutes, creuses — le        │
 * │ boîtier émet toutes les 20 à 100 s à 100 km/h, soit jusqu'à 2,5 km sans    │
 * │ rien. Colorer les positions brutes coupe les virages (constaté en          │
 * │ production le 2026-09-08). On colore donc le tracé, et on lui prête la     │
 * │ vitesse du relevé le plus proche.                                          │
 * │                                                                            │
 * │ « Le plus proche » se cherche EN AVANÇANT : les deux suites parcourent le  │
 * │ même chemin dans le même ordre. Chercher le plus proche à vol d'oiseau     │
 * │ sur tout le trajet donnerait, à un aller-retour, la vitesse de l'aller     │
 * │ au retour. Ici le curseur ne recule jamais.                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * @param trace   sommets en [lng, lat], dans l'ordre du parcours
 * @param releves relevés dans l'ordre du temps
 * @returns une vitesse par sommet ; `NaN` quand aucun relevé ne la donne
 */
export function vitessesSurTrace(
  trace: ReadonlyArray<readonly [number, number]>,
  releves: ReadonlyArray<ReleveVitesse>,
): number[] {
  if (releves.length === 0) return trace.map(() => Number.NaN);
  const out: number[] = new Array(trace.length);
  let j = 0;
  for (let i = 0; i < trace.length; i++) {
    const [lng, lat] = trace[i]!;
    let d = haversineMeters(lat, lng, releves[j]!.lat, releves[j]!.lng);
    // Tant que le relevé suivant est aussi proche ou plus, c'est lui qui décrit ce sommet :
    // un relevé porte la vitesse mesurée en y ARRIVANT.
    while (j + 1 < releves.length) {
      const suivant = releves[j + 1]!;
      const dn = haversineMeters(lat, lng, suivant.lat, suivant.lng);
      if (dn > d) break;
      d = dn;
      j++;
    }
    const v = releves[j]!.speedKmh;
    out[i] = typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
  }
  return out;
}
