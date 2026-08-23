/**
 * Qualité GPS — la logique PURE de diagnostic, partagée par l'application et par l'agent.
 *
 * ── Le manque auquel ce module répond ────────────────────────────────────────────────
 * Les zones de perte GPS sont apprises PAR VÉHICULE : chaque véhicule accumule ses propres
 * centroïdes. C'est correct pour afficher « ici, ce camion perd le signal », mais ça ne répond
 * jamais à la seule question qui décide d'une action :
 *
 *   « Est-ce le LIEU qui est mauvais, ou le BOÎTIER ? »
 *
 * Un parking souterrain fait perdre le signal à tous ceux qui y entrent : rien à réparer, c'est
 * la physique. Un boîtier mourant perd le signal PARTOUT : il faut le remplacer. Les deux
 * produisent exactement les mêmes lignes en base, et personne ne peut les distinguer en regardant
 * un véhicule à la fois. Il faut croiser les véhicules entre eux — c'est ce que fait ce module.
 *
 * ── Ce qu'il ne fait pas ─────────────────────────────────────────────────────────────
 * Aucun accès base, aucun réseau, aucune dépendance Nest ou Prisma : il prend des zones et rend
 * des diagnostics. C'est ce qui le rend consommable à la fois par l'API et par un script Node.
 *
 * ── Et surtout : il sait NE PAS conclure ─────────────────────────────────────────────
 * Un véhicule qui perd le signal à un seul endroit ne prouve rien — c'est probablement son
 * parking. Conclure « boîtier défaillant » sur cette base enverrait un technicien pour rien.
 * « Indéterminé » est une réponse à part entière, et c'est la plus fréquente.
 */

export interface ZoneBrute {
  id: string;
  vehicleId: string;
  /** Plaque, pour que le diagnostic soit lisible sans requête supplémentaire. */
  plaque?: string | null;
  fleetId: string;
  centroidLat: number;
  centroidLng: number;
  radiusM: number;
  /** Épisodes de perte distincts rattachés à cette zone. */
  occurrences: number;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  placeLabel?: string | null;
  /**
   * TRK-039 — combien d'AUTRES véhicules de la flotte ont circulé sur le secteur de cette zone
   * pendant la fenêtre d'observation. C'est ce qui rend la phrase « sans qu'aucun autre véhicule
   * n'ait le même problème à ces endroits » TESTABLE : personne d'autre sur le secteur = la
   * contre-preuve n'existe pas, et la zone ne peut porter aucun verdict « boîtier ».
   * `undefined` vaut 0 — une corroboration qu'on n'a pas mesurée n'est pas une preuve.
   */
  vehiculesTiersSurSecteur?: number;
}

export type NatureDiagnostic = 'lieu' | 'boitier' | 'indetermine';

export interface Diagnostic {
  nature: NatureDiagnostic;
  fleetId: string;
  /** Zones agrégées par ce diagnostic. */
  zoneIds: string[];
  /** Véhicules concernés (plaques quand elles sont connues). */
  vehicules: string[];
  /** Nombre d'épisodes de perte cumulés. */
  episodes: number;
  /** Centre du groupe — renseigné pour un diagnostic de LIEU. */
  lat: number | null;
  lng: number | null;
  placeLabel: string | null;
  /** Étalement géographique en mètres — ce qui sépare « un endroit » de « partout ». */
  etalementM: number;
  /** Ce qu'on affirme, en une phrase, sans jargon. */
  constat: string;
  /** Ce qu'il faut faire. Vide quand il n'y a rien à faire. */
  recommandation: string;
  gravite: 'basse' | 'moyenne' | 'haute';
}

/**
 * Deux zones de véhicules DIFFÉRENTS à moins de cette distance désignent le même endroit.
 *
 * 300 m et non 50 : le centroïde est une moyenne mobile de points de perte, et deux véhicules
 * n'entrent jamais dans un parking par la même rampe. Trop serré, on rate la corrélation et on
 * accuse les boîtiers ; trop large, on fusionne un quartier entier en une seule « zone morte ».
 */
export const RAYON_CORRELATION_M = 300;
/**
 * Au-delà, les pertes d'UN véhicule ne désignent plus un endroit mais un comportement.
 *
 * ⚠️ TRK-039 — ne pas « corriger » en montant ce seuil : mesuré sur toutes les zones, l'étalement
 * mesure d'abord la distance parcourue (KSR370 : 580 km = 193× le seuil, un simple aller-retour
 * en Espagne). C'est le critère qui était faux, pas son réglage : depuis, il ne se mesure que sur
 * les zones CORROBORÉES — celles où d'autres véhicules de la flotte circulent réellement.
 */
export const ETALEMENT_BOITIER_M = 3000;
/** En dessous, un véhicule seul ne prouve rien : c'est probablement son parking habituel. */
export const ZONES_MIN_BOITIER = 4;

/** Distance en mètres entre deux points (haversine). */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Plus grande distance entre deux zones d'un groupe — l'étalement. */
function etalement(zones: ZoneBrute[]): number {
  let max = 0;
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const d = distanceM(zones[i].centroidLat, zones[i].centroidLng, zones[j].centroidLat, zones[j].centroidLng);
      if (d > max) max = d;
    }
  }
  return Math.round(max);
}

/**
 * Regroupe les zones qui désignent le même endroit, tous véhicules confondus.
 *
 * Agrégation par proximité au groupe déjà formé (et non au premier point) : sans ça, une file de
 * zones espacées de 250 m formerait une chaîne de plusieurs kilomètres — un « lieu » qui n'en est
 * pas un.
 */
function grouperParLieu(zones: ZoneBrute[]): ZoneBrute[][] {
  const restantes = [...zones].sort((a, b) => b.occurrences - a.occurrences);
  const groupes: ZoneBrute[][] = [];
  while (restantes.length > 0) {
    const graine = restantes.shift()!;
    const groupe = [graine];
    for (let i = restantes.length - 1; i >= 0; i--) {
      const z = restantes[i];
      const proche = groupe.every(
        (g) => distanceM(g.centroidLat, g.centroidLng, z.centroidLat, z.centroidLng) <= RAYON_CORRELATION_M,
      );
      if (proche) {
        groupe.push(z);
        restantes.splice(i, 1);
      }
    }
    groupes.push(groupe);
  }
  return groupes;
}

const plaqueDe = (z: ZoneBrute) => z.plaque ?? z.vehicleId;
const uniques = (v: string[]) => [...new Set(v)].sort();

/**
 * Produit les diagnostics d'une société.
 *
 * L'ordre compte : on identifie d'abord les LIEUX (plusieurs véhicules au même endroit), puis on
 * juge les boîtiers sur ce qui RESTE. Sans cela, un véhicule qui fréquente trois parkings connus
 * serait accusé d'être défaillant alors qu'il ne fait que rouler là où le signal ne passe pas.
 */
export function diagnostiquer(zones: ZoneBrute[]): Diagnostic[] {
  if (zones.length === 0) return [];
  const fleetId = zones[0].fleetId;
  const diagnostics: Diagnostic[] = [];

  const groupes = grouperParLieu(zones);
  const expliqueesParUnLieu = new Set<string>();

  for (const groupe of groupes) {
    // Nomme vehiculesDuGroupe et non vehicules : le controle d'accentuation du depot lit les
    // identifiants nus comme du texte affiche, et reclame l'accent sur « vehicules ». Renommer
    // coute moins cher que d'ajouter une exception a un garde qui protege les ecrans.
    const vehiculesDuGroupe = uniques(groupe.map((z) => z.vehicleId));
    if (vehiculesDuGroupe.length < 2) continue; // un seul véhicule ne prouve rien sur le lieu

    groupe.forEach((z) => expliqueesParUnLieu.add(z.id));
    const episodes = groupe.reduce((s, z) => s + z.occurrences, 0);
    const lieu = groupe.find((z) => z.placeLabel)?.placeLabel ?? null;
    const plaques = uniques(groupe.map(plaqueDe));
    diagnostics.push({
      nature: 'lieu',
      fleetId,
      zoneIds: groupe.map((z) => z.id),
      vehicules: plaques,
      episodes,
      lat: groupe.reduce((s, z) => s + z.centroidLat, 0) / groupe.length,
      lng: groupe.reduce((s, z) => s + z.centroidLng, 0) / groupe.length,
      placeLabel: lieu,
      etalementM: etalement(groupe),
      // Concaténation plutôt qu'un gabarit imbriqué dans un gabarit : plus lisible, et une
      // imbrication de moins à relire pour qui reprend cette phrase.
      constat:
        String(plaques.length) + ' véhicules perdent le signal au même endroit' +
        (lieu ? ' (' + lieu + ')' : '') + ', ' + String(episodes) + ' fois au total.',
      // Rien à réparer : c'est le lieu. Le dire évite qu'un technicien parte contrôler des
      // boîtiers qui fonctionnent.
      recommandation:
        'Aucun boîtier n\'est en cause : la couverture est mauvaise à cet endroit. ' +
        'Qualifier la zone une bonne fois (parking couvert, tunnel) pour ne plus la voir remonter.',
      gravite: 'basse',
    });
  }

  // Ce qui reste : des pertes qu'aucun lieu partagé n'explique.
  const parVehicule = new Map<string, ZoneBrute[]>();
  for (const z of zones) {
    if (expliqueesParUnLieu.has(z.id)) continue;
    const l = parVehicule.get(z.vehicleId) ?? [];
    l.push(z);
    parVehicule.set(z.vehicleId, l);
  }

  for (const [, zonesVehicule] of parVehicule) {
    const episodes = zonesVehicule.reduce((s, z) => s + z.occurrences, 0);
    const etal = etalement(zonesVehicule);
    const plaque = plaqueDe(zonesVehicule[0]);
    const base = {
      fleetId,
      zoneIds: zonesVehicule.map((z) => z.id),
      vehicules: [plaque],
      episodes,
      lat: null,
      lng: null,
      placeLabel: null,
      etalementM: etal,
    };

    // Perd le signal en de nombreux endroits ÉLOIGNÉS : ce n'est plus un lieu, c'est l'appareil.
    //
    // TRK-039 — le verdict ne se construit QUE sur les zones CORROBORÉES : celles où d'autres
    // véhicules de la flotte circulent (sans y perdre le signal). Une zone où personne d'autre
    // ne va ne prouve rien — « sans qu'aucun autre véhicule n'ait le même problème » y est
    // invérifiable, et une absence de preuve n'est pas une preuve. C'est aussi ce qui borne
    // l'étalement à l'aire d'exploitation PARTAGÉE : mesuré sur toutes les zones, il mesurait
    // d'abord la distance parcourue, et plus un véhicule voyageait loin et seul, plus il était
    // certain d'être déclaré en panne.
    const zonesCorroborees = zonesVehicule.filter((z) => (z.vehiculesTiersSurSecteur ?? 0) >= 1);
    const etalCorrobore = etalement(zonesCorroborees);
    if (zonesCorroborees.length >= ZONES_MIN_BOITIER && etalCorrobore >= ETALEMENT_BOITIER_M) {
      const episodesCorrobores = zonesCorroborees.reduce((s, z) => s + z.occurrences, 0);
      diagnostics.push({
        ...base,
        nature: 'boitier',
        // Le diagnostic ne référence QUE ce qui fonde le verdict : compter les zones de Benidorm
        // dans `zones:` ou `episodes:` referait mentir le constat par la bande.
        zoneIds: zonesCorroborees.map((z) => z.id),
        episodes: episodesCorrobores,
        etalementM: etalCorrobore,
        constat:
          `${plaque} perd le signal à ${zonesCorroborees.length} endroits distincts où d'autres ` +
          `véhicules de la flotte circulent sans le perdre, répartis sur ` +
          `${(etalCorrobore / 1000).toFixed(1)} km (${episodesCorrobores} épisodes).`,
        recommandation:
          'Contrôler le boîtier : antenne, fixation, alimentation. Des pertes dispersées ne ' +
          's\'expliquent pas par la couverture réseau.',
        gravite: episodesCorrobores >= 10 ? 'haute' : 'moyenne',
      });
      continue;
    }

    // Tout le reste : on ne conclut PAS.
    diagnostics.push({
      ...base,
      nature: 'indetermine',
      constat:
        `${plaque} perd le signal à ${zonesVehicule.length} endroit(s), ${episodes} épisode(s), ` +
        `sans recoupement avec un autre véhicule.`,
      // Une hypothèse annoncée comme telle vaut mieux qu'une affirmation fausse : à un seul
      // endroit, c'est presque toujours le parking habituel du véhicule.
      recommandation: '',
      gravite: 'basse',
    });
  }

  const rang = { haute: 0, moyenne: 1, basse: 2 } as const;
  return diagnostics.sort((a, b) => rang[a.gravite] - rang[b.gravite] || b.episodes - a.episodes);
}

/** Ce qui mérite d'être remonté : on ne signale pas ce sur quoi on n'a rien conclu. */
export function diagnosticsActionnables(d: Diagnostic[]): Diagnostic[] {
  return d.filter((x) => x.nature !== 'indetermine');
}
