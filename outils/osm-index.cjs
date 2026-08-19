/**
 * Résolution des limites de vitesse depuis un extrait OpenStreetMap LOCAL.
 *
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────
 *
 * Interroger un Overpass public pour 220 000 portions de route ne marche pas : deux de nos IP
 * bannies en une journée, et les instances survivantes à 150-450 s par lot de cinquante. Des
 * semaines de travail, en dérangeant des serveurs bénévoles.
 *
 * Ici, on télécharge une fois l'extrait de la région et on fait le rattachement en local.
 * Plus de réseau, plus de quota, plus de bannissement possible.
 *
 * ── COMMENT, SANS FAIRE EXPLOSER LA MÉMOIRE ──────────────────────────────────────────
 *
 * Un extrait comme Midi-Pyrénées contient une vingtaine de millions de nœuds. Les garder dans
 * une `Map` JavaScript coûterait plusieurs gigaoctets. Deux choix évitent ça :
 *
 *   1. LES NŒUDS VONT DANS DES TABLEAUX TYPÉS, pas dans une Map. Un identifiant sur 8 octets,
 *      latitude et longitude en entiers 32 bits (multipliés par 10^7 : 180 × 10^7 tient
 *      largement dans un int32). Vingt millions de nœuds tiennent ainsi dans ~290 Mo. Le format
 *      PBF les livre par identifiants croissants, donc le tableau est trié d'office et la
 *      recherche est dichotomique.
 *
 *   2. LE RÉSEAU ROUTIER N'EST JAMAIS STOCKÉ. Chaque route est traitée au vol : on reconstruit
 *      sa géométrie, on cherche les cellules-cibles proches, on met à jour leur meilleure
 *      correspondance, puis on l'oublie. Seules les ~240 000 cellules à résoudre restent en
 *      mémoire, avec leur meilleur candidat du moment.
 *
 * ── AUCUNE RÈGLE MÉTIER RÉÉCRITE ICI ─────────────────────────────────────────────────
 *
 * `estRoutable`, `limiteDeVoie` et `distancePointSegment` viennent du module que l'application
 * utilise elle-même. Ce fichier ne décide de RIEN : il fournit des routes et des distances, les
 * règles restent uniques. Une deuxième implémentation aurait fini par diverger, et l'agent
 * écrirait des limites que l'app n'aurait jamais déduites.
 */

const fs = require('node:fs');
const path = require('node:path');
const parseOsm = require('osm-pbf-parser');

const R = path.join(__dirname, '..', 'apps', 'api', 'dist', 'trip-analysis', 'speed-limit.resolution.js');
const { estRoutable, limiteDeVoie, distancePointSegment, MATCH_M, cleCellule } = require(R);

/** Coordonnées stockées en entiers : 10^7 conserve ~1 cm, et tient dans un int32. */
const ECHELLE = 1e7;
/** Pas de la grille de recherche des cellules-cibles (degrés) — ~200 m sous nos latitudes. */
const PAS_GRILLE = 0.002;

/**
 * Réserve croissante de nœuds, en tableaux typés.
 *
 * Les tableaux typés ne se redimensionnent pas : on double la capacité quand elle est atteinte,
 * comme le ferait un vecteur. Copier 20 millions d'entrées une poignée de fois reste bien moins
 * cher que d'entretenir une Map de plusieurs gigaoctets.
 */
class Noeuds {
  constructor(capacite = 1 << 20) {
    this.n = 0;
    this.ids = new Float64Array(capacite); // les identifiants OSM depassent 2^32
    this.lat = new Int32Array(capacite);
    this.lng = new Int32Array(capacite);
  }

  ajouter(id, lat, lng) {
    if (this.n === this.ids.length) this.agrandir();
    this.ids[this.n] = id;
    this.lat[this.n] = Math.round(lat * ECHELLE);
    this.lng[this.n] = Math.round(lng * ECHELLE);
    this.n++;
  }

  agrandir() {
    const c = this.ids.length * 2;
    const ids = new Float64Array(c); ids.set(this.ids); this.ids = ids;
    const la = new Int32Array(c); la.set(this.lat); this.lat = la;
    const ln = new Int32Array(c); ln.set(this.lng); this.lng = ln;
  }

  /** Recherche dichotomique — le PBF livre les nœuds par identifiants croissants. */
  indexDe(id) {
    let bas = 0, haut = this.n - 1;
    while (bas <= haut) {
      const m = (bas + haut) >> 1;
      const v = this.ids[m];
      if (v === id) return m;
      if (v < id) bas = m + 1; else haut = m - 1;
    }
    return -1;
  }

  /** Vrai si les identifiants sont bien croissants — sinon la dichotomie mentirait. */
  estTrie() {
    for (let i = 1; i < this.n; i++) if (this.ids[i] < this.ids[i - 1]) return false;
    return true;
  }

  octets() {
    return this.ids.length * 16;
  }
}

/**
 * Grille des cellules à résoudre, pour retrouver vite celles qui bordent une route donnée.
 * Sans elle, chaque route serait comparée aux 240 000 cellules — impraticable.
 */
class GrilleCibles {
  constructor(cellules) {
    this.cases = new Map();
    this.cellules = cellules;
    cellules.forEach((c, i) => {
      const k = this.cle(c.lat, c.lng);
      const l = this.cases.get(k);
      if (l) l.push(i); else this.cases.set(k, [i]);
    });
  }

  cle(lat, lng) {
    return `${Math.floor(lat / PAS_GRILLE)},${Math.floor(lng / PAS_GRILLE)}`;
  }

  /** Indices des cellules dont la case touche le rectangle donné (déjà élargi de la marge). */
  proches(minLat, maxLat, minLng, maxLng) {
    const out = [];
    const i0 = Math.floor(minLat / PAS_GRILLE), i1 = Math.floor(maxLat / PAS_GRILLE);
    const j0 = Math.floor(minLng / PAS_GRILLE), j1 = Math.floor(maxLng / PAS_GRILLE);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const l = this.cases.get(`${i},${j}`);
        if (l) out.push(...l);
      }
    }
    return out;
  }
}

/**
 * Résout les limites d'un ensemble de cellules à partir d'un extrait `.osm.pbf`.
 *
 * Renvoie une Map `cle -> { limite, trouvee }`, exactement la forme que produit la voie
 * Overpass. `trouvee: false` signifie « aucune route routable à portée » : l'appelant ne doit
 * PAS le mémoriser — c'est le garde-fou qui avait manqué et stérilisé 98,8 % du cache.
 */
function resoudreDepuisExtrait(cheminPbf, cellules, { journal = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const noeuds = new Noeuds();
    const grille = new GrilleCibles(cellules);
    /** Meilleure correspondance par cellule : distance et limite retenue. */
    const meilleur = new Array(cellules.length).fill(null);

    // Marge de rattachement, convertie en degrés pour élargir le rectangle d'une route.
    const margeLat = MATCH_M / 111_320;
    let routes = 0, nonTriePrevenu = false;
    const t0 = Date.now();

    const flux = fs.createReadStream(cheminPbf).pipe(parseOsm());

    flux.on('data', (items) => {
      for (const it of items) {
        if (it.type === 'node') {
          noeuds.ajouter(it.id, it.lat, it.lon);
          continue;
        }
        if (it.type !== 'way' || !it.tags || !estRoutable(it.tags.highway)) continue;
        if (!Array.isArray(it.refs) || it.refs.length < 2) continue;

        // ⚠️ La dichotomie suppose des identifiants croissants. On le VÉRIFIE une fois, à la
        //    première route : un extrait desordonne donnerait des rattachements faux, donc de
        //    fausses limites — exactement ce qu'on refuse d'ecrire en base.
        if (routes === 0 && !noeuds.estTrie()) {
          if (!nonTriePrevenu) {
            nonTriePrevenu = true;
            flux.destroy();
            reject(new Error(
              "Extrait OSM inexploitable : les noeuds ne sont pas livres par identifiants croissants. " +
              "La recherche dichotomique rattacherait les routes au hasard et produirait de fausses limites.",
            ));
          }
          return;
        }
        routes++;

        // Géométrie de la route, dans l'ordre. Un nœud manquant coupe le segment : on ne
        // relie jamais deux points non adjacents, ça inventerait une route qui n'existe pas.
        const geom = [];
        for (const ref of it.refs) {
          const k = noeuds.indexDe(ref);
          geom.push(k === -1 ? null : { lat: noeuds.lat[k] / ECHELLE, lng: noeuds.lng[k] / ECHELLE });
        }

        let minLat = 91, maxLat = -91, minLng = 181, maxLng = -181;
        for (const g of geom) {
          if (!g) continue;
          if (g.lat < minLat) minLat = g.lat;
          if (g.lat > maxLat) maxLat = g.lat;
          if (g.lng < minLng) minLng = g.lng;
          if (g.lng > maxLng) maxLng = g.lng;
        }
        if (minLat > maxLat) continue; // aucun nœud connu

        const margeLng = margeLat / Math.max(0.1, Math.cos((minLat * Math.PI) / 180));
        const candidats = grille.proches(minLat - margeLat, maxLat + margeLat, minLng - margeLng, maxLng + margeLng);
        if (candidats.length === 0) continue;

        const limite = limiteDeVoie(it.tags);
        for (const idx of candidats) {
          const c = cellules[idx];
          let d = Infinity;
          for (let i = 1; i < geom.length; i++) {
            const a = geom[i - 1], b = geom[i];
            if (!a || !b) continue; // segment incomplet : on ne l'invente pas
            const dd = distancePointSegment(c.lat, c.lng, a.lat, a.lng, b.lat, b.lng);
            if (dd < d) d = dd;
          }
          if (d < MATCH_M && (meilleur[idx] === null || d < meilleur[idx].d)) {
            meilleur[idx] = { d, limite };
          }
        }
      }
    });

    flux.on('error', reject);
    flux.on('end', () => {
      const out = new Map();
      cellules.forEach((c, i) => {
        const m = meilleur[i];
        out.set(cleCellule(c.lat, c.lng), m ? { limite: m.limite, trouvee: true } : { limite: null, trouvee: false });
      });
      journal(
        `index local : ${noeuds.n.toLocaleString('fr-FR')} noeuds, ${routes.toLocaleString('fr-FR')} routes, ` +
        `${Math.round(noeuds.octets() / 1048576)} Mo, ${((Date.now() - t0) / 1000).toFixed(0)}s`,
      );
      resolve(out);
    });
  });
}

module.exports = { resoudreDepuisExtrait, Noeuds, GrilleCibles, ECHELLE };
