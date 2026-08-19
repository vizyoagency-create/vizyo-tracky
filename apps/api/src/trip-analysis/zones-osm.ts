/**
 * Quels extraits OpenStreetMap faut-il, pour les routes que la flotte parcourt réellement ?
 *
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────
 *
 * Interroger un service Overpass public pour 220 000 portions de route ne marche pas : deux de
 * nos IP se sont fait bannir en une seule journée, et les instances survivantes répondent en
 * 150 à 450 s par lot de cinquante. Le calcul est sans appel — des semaines, en dérangeant des
 * serveurs bénévoles.
 *
 * La sortie est de télécharger une fois l'extrait OSM des régions concernées et de faire le
 * rattachement EN LOCAL : plus de réseau, plus de quota, plus de bannissement possible, et un
 * temps de résolution qui se compte en minutes.
 *
 * Encore faut-il savoir QUELLES régions. Ce module répond à ça, et il le fait à partir des
 * positions réelles — pas d'une liste écrite à la main qui deviendrait fausse le jour où la
 * flotte prend une nouvelle destination.
 *
 * ── POURQUOI UN POLYGONE ET PAS UN RECTANGLE ─────────────────────────────────────────
 *
 * ⚠️ Le rectangle englobant a été essayé, et il se trompait sur le cas le plus important :
 *    Toulouse (longitude 1,4442) tombe dans l'emprise rectangulaire d'AQUITAINE, dont la borne
 *    est à 1,451 — alors que l'extrait réel ne la contient pas. Le choix glouton partait donc
 *    télécharger 281 Mo d'Aquitaine, et Toulouse — 61,5 % des portions à résoudre — serait
 *    restée sans limites, sans que rien n'explique pourquoi.
 *
 *    Le découpage réel est un polygone, et c'est lui qui décide ici. Vérifié : Toulouse
 *    n'appartient qu'à Midi-Pyrénées.
 *
 * L'emprise rectangulaire est conservée, mais seulement pour ce à quoi elle est bonne : écarter
 * d'un test trivial les points manifestement lointains avant de dérouler le polygone.
 *
 * Les données viennent de `https://download.geofabrik.de/index-v1.json`, relevées le 2026-08-19.
 */

import { POLYGONES_REGIONS } from './zones-osm.polygones';

export interface Emprise {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface RegionOsm {
  id: string;
  nom: string;
  /** URL de l'extrait `.osm.pbf` chez Geofabrik. */
  pbf: string;
  emprise: Emprise;
  /** Taille approximative en Mo, relevée le 2026-08-19 — pour annoncer le coût du téléchargement. */
  tailleMo: number;
}

/**
 * Régions couvrant la zone d'exploitation constatée (relevé du 2026-08-19) :
 * 61,5 % des portions à résoudre sont autour de Toulouse, 97 % dans le Sud-Ouest français,
 * moins de 1 % en Catalogne.
 */
export const REGIONS_OSM: RegionOsm[] = [
  {
    id: 'midi-pyrenees',
    nom: 'Midi-Pyrénées',
    pbf: 'https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf',
    emprise: { minLat: 42.568, maxLat: 45.048, minLng: -0.328, maxLng: 3.453 },
    tailleMo: 343,
  },
  {
    id: 'languedoc-roussillon',
    nom: 'Languedoc-Roussillon',
    pbf: 'https://download.geofabrik.de/europe/france/languedoc-roussillon-latest.osm.pbf',
    emprise: { minLat: 42.328, maxLat: 44.978, minLng: 1.686, maxLng: 4.848 },
    tailleMo: 256,
  },
  {
    id: 'aquitaine',
    nom: 'Aquitaine',
    pbf: 'https://download.geofabrik.de/europe/france/aquitaine-latest.osm.pbf',
    emprise: { minLat: 42.773, maxLat: 45.717, minLng: -1.843, maxLng: 1.451 },
    tailleMo: 281,
  },
  {
    id: 'cataluna',
    nom: 'Catalogne',
    pbf: 'https://download.geofabrik.de/europe/spain/cataluna-latest.osm.pbf',
    emprise: { minLat: 40.212, maxLat: 42.863, minLng: 0.156, maxLng: 4.175 },
    tailleMo: 256,
  },
];

export interface Cellule {
  lat: number;
  lng: number;
}

/**
 * Le point est-il dans l'anneau ? Lancer de rayon horizontal, comptage des traversées.
 * Un point exactement sur la frontière peut tomber d'un côté ou de l'autre — sans importance
 * ici : on choisit un fichier à télécharger, pas une limite de vitesse.
 */
function dansAnneau(lng: number, lat: number, anneau: [number, number][]): boolean {
  let dedans = false;
  for (let i = 0, k = anneau.length - 1; i < anneau.length; k = i++) {
    const [xi, yi] = anneau[i]!;
    const [xk, yk] = anneau[k]!;
    if (yi > lat !== yk > lat && lng < ((xk - xi) * (lat - yi)) / (yk - yi) + xi) dedans = !dedans;
  }
  return dedans;
}

/**
 * Le point tombe-t-il dans le découpage RÉEL de l'extrait ?
 *
 * Le rectangle sert de filtre rapide — il écarte l'immense majorité des points sans dérouler
 * les 1 543 sommets de Midi-Pyrénées — mais il ne décide jamais seul (cf. le cas de Toulouse
 * dans l'en-tête de ce fichier).
 */
export function couvre(r: RegionOsm, lat: number, lng: number): boolean {
  const e = r.emprise;
  if (lat < e.minLat || lat > e.maxLat || lng < e.minLng || lng > e.maxLng) return false;
  const polys = POLYGONES_REGIONS[r.id];
  if (!polys) return false;
  return polys.some((anneau) => dansAnneau(lng, lat, anneau));
}

/** Combien de cellules chaque région couvrirait-elle ? Décroissant, régions à zéro exclues. */
export function couvertureParRegion(
  cellules: Cellule[],
  regions: RegionOsm[] = REGIONS_OSM,
): { region: RegionOsm; cellules: number }[] {
  return regions
    .map((region) => ({ region, cellules: cellules.filter((c) => couvre(region, c.lat, c.lng)).length }))
    .filter((x) => x.cellules > 0)
    .sort((a, b) => b.cellules - a.cellules);
}

/**
 * Cellules qu'AUCUNE région connue ne couvre.
 *
 * ⚠️ C'est le signal « la flotte roule ailleurs ». Il ne doit pas rester muet : sans lui, un
 * nouveau pays d'exploitation se traduirait par des trajets éternellement sans limites, sans que
 * rien n'explique pourquoi. L'agent le remonte, et on ajoute la région au catalogue.
 */
export function cellulesOrphelines(cellules: Cellule[], regions: RegionOsm[] = REGIONS_OSM): Cellule[] {
  return cellules.filter((c) => !regions.some((r) => couvre(r, c.lat, c.lng)));
}

/**
 * Quelles régions télécharger, et dans quel ordre ?
 *
 * Choix GLOUTON : on prend d'abord la région qui couvre le plus de cellules encore orphelines,
 * puis on recommence sur le reste. Une région qui n'apporterait presque rien de neuf n'est pas
 * téléchargée — inutile de tirer 281 Mo pour trente portions de route, qu'Overpass traitera en
 * une requête.
 *
 * `minGain` est le nombre de cellules NOUVELLES qu'une région doit apporter pour valoir son
 * téléchargement.
 */
export function planTelechargement(
  cellules: Cellule[],
  minGain = 500,
  regions: RegionOsm[] = REGIONS_OSM,
): { region: RegionOsm; gain: number }[] {
  const restantes = new Set(cellules.map((_, i) => i));
  const plan: { region: RegionOsm; gain: number }[] = [];
  const candidates = [...regions];

  for (;;) {
    let meilleure: { region: RegionOsm; gain: number; indices: number[] } | null = null;
    for (const region of candidates) {
      const indices: number[] = [];
      for (const i of restantes) {
        const c = cellules[i]!;
        if (couvre(region, c.lat, c.lng)) indices.push(i);
      }
      if (!meilleure || indices.length > meilleure.gain) meilleure = { region, gain: indices.length, indices };
    }
    if (!meilleure || meilleure.gain < minGain) break;
    plan.push({ region: meilleure.region, gain: meilleure.gain });
    for (const i of meilleure.indices) restantes.delete(i);
    candidates.splice(candidates.indexOf(meilleure.region), 1);
  }
  return plan;
}
