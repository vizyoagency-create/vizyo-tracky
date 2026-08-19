/**
 * Résolution d'une limite de vitesse à partir d'une réponse Overpass — LOGIQUE PURE.
 *
 * ── POURQUOI CE FICHIER EST SÉPARÉ ───────────────────────────────────────────────────
 *
 * Deux programmes doivent résoudre les limites EXACTEMENT de la même façon :
 *   — l'API, quand elle analyse un trajet à la volée ;
 *   — l'agent de rattrapage qui tourne sur le poste du propriétaire, parce que l'IP du VPS
 *     s'est fait bannir de l'instance publique et que celle du poste répond trois fois plus vite.
 *
 * Dupliquer ce code serait la porte ouverte aux DONNÉES FAUSSES : deux copies divergent, et
 * l'agent finirait par écrire en base des limites que l'app n'aurait jamais déduites — sans
 * que rien ne le signale. Une seule implémentation, un seul jeu de tests, aucune divergence
 * possible. C'est aussi pour ça que tout ici est PUR : aucun réseau, aucune base, testable
 * intégralement.
 */

/** Voies NON routables (à ignorer : elles ne portent pas la limite d'un véhicule). */
export const NON_DRIVABLE = new Set([
  'footway', 'path', 'cycleway', 'pedestrian', 'steps', 'bridleway',
  'corridor', 'platform', 'construction', 'proposed',
]);

/**
 * Limite INFÉRÉE (km/h) par type de voie OSM `highway`, défauts FRANCE (fallback quand aucun tag
 * `maxspeed` explicite). Approximatif (l'urbain/rural sur primary/secondary reste ambigu) : à
 * considérer comme « probable ». motorway=130, trunk=110, voies structurantes=90/80, urbain=50/30/20.
 */
const INFER: Record<string, number> = {
  motorway: 130, motorway_link: 90, trunk: 110, trunk_link: 70,
  primary: 90, primary_link: 50, secondary: 80, secondary_link: 50,
  tertiary: 80, tertiary_link: 50, unclassified: 80,
  residential: 50, living_street: 20, service: 30, road: 50,
};

export function inferFromHighway(highway: string | undefined): number | null {
  return highway ? (INFER[highway] ?? null) : null;
}

/** Convertit une valeur OSM `maxspeed` en km/h. Gère les mph, les catégories FR, `none`, `walk`. */
export function parseMaxspeed(v: string | undefined | null): number | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === 'none' || s === 'signals' || s === 'variable') return null;
  if (s === 'walk') return 6;
  // Catégories implicites françaises (zones/urban/rural/motorway).
  const cat: Record<string, number> = {
    'fr:urban': 50, 'fr:rural': 80, 'fr:trunk': 110, 'fr:motorway': 130,
    'fr:living_street': 20, 'fr:zone30': 30, 'fr:walk': 6,
  };
  if (cat[s] != null) return cat[s];
  const mph = /mph/.test(s);
  const num = parseFloat(s);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(mph ? num * 1.60934 : num);
}

/**
 * Distance (m) d'un point à un segment, en projection équirectangulaire locale. À l'échelle de
 * quelques dizaines de mètres l'approximation est négligeable devant la précision GPS.
 */
export function distancePointSegment(
  plat: number, plng: number,
  alat: number, alng: number,
  blat: number, blng: number,
): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const cosLat = Math.cos(plat * rad);
  const px = plng * rad * cosLat * R, py = plat * rad * R;
  const ax = alng * rad * cosLat * R, ay = alat * rad * R;
  const bx = blng * rad * cosLat * R, by = blat * rad * R;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface OverpassWay {
  type?: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

export interface OverpassReponse {
  elements?: OverpassWay[];
  /** Présent quand Overpass signale une erreur SOUS un HTTP 200 (timeout, surcharge). */
  remark?: string;
}

export interface LimitePoint {
  /** Limite retenue, ou null si indéterminable. */
  limite: number | null;
  /**
   * Une voie routable a-t-elle réellement été rattachée ?
   *
   * ⚠️ C'EST CE DRAPEAU QUI AUTORISE LA MISE EN CACHE. `false` veut dire « aucune voie à
   * portée » — ce qui, pour un point GPS de véhicule en mouvement, est le symptôme d'une
   * réponse dégradée et non un fait de terrain. Le mémoriser est exactement le bug qui avait
   * stérilisé 59 347 points en production.
   */
  trouvee: boolean;
}

/** Marge de rattachement (m). Overpass a filtré à 20 m ; on tolère l'arrondi de projection. */
export const MATCH_M = 25;

/** Ne garde que les voies exploitables : un `way` routable avec une géométrie utilisable. */
export function voiesRoutables(json: OverpassReponse): OverpassWay[] {
  return (json.elements ?? [])
    .filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1)
    .filter((e) => e.tags?.['highway'] && !NON_DRIVABLE.has(e.tags['highway']));
}

/** Voie routable la plus proche du point, dans la limite de `MATCH_M`. */
export function voieLaPlusProche(
  p: { lat: number; lng: number },
  voies: OverpassWay[],
  matchM: number = MATCH_M,
): OverpassWay | null {
  let meilleure: OverpassWay | null = null;
  let min = matchM;
  for (const v of voies) {
    const g = v.geometry!;
    for (let i = 1; i < g.length; i++) {
      const d = distancePointSegment(p.lat, p.lng, g[i - 1]!.lat, g[i - 1]!.lon, g[i]!.lat, g[i]!.lon);
      if (d < min) { min = d; meilleure = v; }
    }
  }
  return meilleure;
}

/**
 * Résout la limite de CHAQUE point à partir des voies renvoyées par une requête groupée.
 *
 * L'ordre de sortie suit exactement l'ordre d'entrée. Deux règles, dans cet ordre :
 *   1. un `maxspeed` EXPLICITE sur la voie la plus proche prime — c'est une donnée, pas une
 *      hypothèse ;
 *   2. à défaut, on infère par le TYPE de voie (défauts FR). Beaucoup de routes françaises
 *      n'ont pas de tag `maxspeed` : la limite y est implicite, et c'est cette inférence qui
 *      rattrape les 130 / 110 / 90.
 *
 * Une inférence qui échoue (type inconnu) renvoie `limite: null` MAIS `trouvee: true` : la route
 * existe, elle n'est simplement pas interprétable. C'est un vrai négatif, légitime à mémoriser.
 */
export function resoudrePoints(
  points: { lat: number; lng: number }[],
  json: OverpassReponse,
  matchM: number = MATCH_M,
): LimitePoint[] {
  const voies = voiesRoutables(json);
  return points.map((p) => {
    const proche = voieLaPlusProche(p, voies, matchM);
    if (!proche) return { limite: null, trouvee: false };
    const explicite = parseMaxspeed(proche.tags?.['maxspeed']);
    if (explicite != null) return { limite: explicite, trouvee: true };
    return { limite: inferFromHighway(proche.tags?.['highway']), trouvee: true };
  });
}

/**
 * Construit la requête Overpass groupée pour un lot de points.
 *
 * Taille de lot calibrée par la mesure sur l'instance publique :
 *   40 points → 87 Ko en ~5 s ·  100 → 156 Ko en 9 s ·  200 → 198 Ko en 13 s ·  400 → HTTP 429.
 * `out tags geom` : la géométrie est indispensable pour savoir QUELLE route va avec QUEL point.
 */
export function requeteLot(points: { lat: number; lng: number }[], rayonM = 20, timeoutS = 180): string {
  const clauses = points.map((p) => `way(around:${rayonM},${p.lat},${p.lng})[highway];`).join('');
  return `[out:json][timeout:${timeoutS}];(${clauses});out tags geom;`;
}

/**
 * La réponse est-elle une PANNE déguisée ?
 *
 * ⚠️ Overpass sert ses erreurs de surcharge SOUS UN HTTP 200 — tantôt une page HTML, tantôt un
 * JSON parfaitement valide portant un champ `remark`. Les lire comme « aucune route ici » et les
 * mémoriser est ce qui avait marqué 98,8 % du cache « inconnu », définitivement.
 *
 * Renvoie le motif de la panne, ou null si la réponse est exploitable.
 */
export function panneDeguisee(texte: string): { motif: string; json?: never } | null {
  let json: OverpassReponse;
  try {
    json = JSON.parse(texte) as OverpassReponse;
  } catch {
    return { motif: `corps non-JSON (${texte.slice(0, 80).replace(/\s+/g, ' ')})` };
  }
  if (typeof json.remark === 'string' && json.remark.length > 0) {
    return { motif: `erreur applicative Overpass : ${json.remark.slice(0, 120)}` };
  }
  return null;
}

/** Clé de cache : coords arrondies à 4 décimales (~11 m) → mutualise un segment de route. */
export function cleCellule(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}
