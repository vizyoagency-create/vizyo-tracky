#!/usr/bin/env node
/**
 * Agent de rattrapage des LIMITES DE VITESSE — tourne sur le poste, pas sur le VPS.
 *
 * ── POURQUOI IL EXISTE ───────────────────────────────────────────────────────────────
 *
 * L'analyse des trajets a besoin de la limite légale de chaque portion de route parcourue.
 * Sans elle, aucun excès n'est calculable et le score de conduite ne mesure rien. Il reste
 * ~220 000 portions à résoudre pour que l'historique redevienne vrai.
 *
 * Rien de tout cela ne consomme de crédit d'API : OpenStreetMap est gratuit.
 *
 * ── DEUX VOIES, DANS CET ORDRE ───────────────────────────────────────────────────────
 *
 * 1. L'EXTRAIT LOCAL, d'abord et pour l'essentiel. On télécharge une fois la carte des régions
 *    parcourues (250-350 Mo chacune) et on fait le rattachement sur le disque. Mesuré : 0,3 s
 *    pour l'Andorre entière. Aucun réseau, aucun quota, aucun bannissement possible.
 *
 * 2. OVERPASS, en secours seulement, pour les portions qu'aucun extrait ne couvre — la flotte
 *    peut rouler ailleurs demain. Le pool de miroirs écoute les refus (cf. `overpass-miroirs`).
 *
 * Pourquoi cet ordre : interroger Overpass pour 220 000 portions s'est soldé le 2026-08-19 par
 * DEUX de nos IP bannies en une journée — celle du VPS le matin, celle de ce poste l'après-midi.
 * Les instances survivantes répondaient en 150 à 450 s par lot de cinquante, soit des semaines
 * de travail en dérangeant des serveurs bénévoles.
 *
 * ── AUCUNE DONNÉE INVENTÉE ───────────────────────────────────────────────────────────
 *
 * Les deux voies appliquent les MÊMES règles, importées du module que l'application utilise
 * elle-même (`speed-limit.resolution`). Vérifié point par point contre Overpass sur un extrait
 * réel : 6 correspondances sur 6, y compris les « aucune route à portée ». Une seconde
 * implémentation aurait fini par diverger, et l'agent écrirait des limites que l'app n'aurait
 * jamais déduites.
 *
 * Trois règles, dans le même esprit :
 *   — on n'écrit QUE les portions où une voie routable a réellement été rattachée ;
 *   — toute réponse douteuse est une PANNE : on n'écrit rien et on réessaiera ;
 *   — l'insertion est en `ON CONFLICT DO NOTHING` : jamais d'écrasement.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────
 *
 *   node outils/agent-limites-vitesse.cjs [--minutes=110] [--lot=50] [--essai] [--sans-local]
 *
 *   --essai        n'écrit RIEN : résout et affiche ce qui serait inséré.
 *   --sans-local   saute l'extrait local (utile pour comparer les deux voies).
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// ── Configuration ────────────────────────────────────────────────────────────────────
const VPS = 'root@72.62.26.240';
const CONTENEUR = 'tracky-postgres';
const BASE = { user: 'tracky', db: 'tracky_prod' };
const UA = 'Tracky/1.0 (contact@vizyoagency.com)';
/** Lignes insérées par requête SQL — au-delà, la commande devient déraisonnablement longue. */
const LOT_ECRITURE = 2000;

const args = process.argv.slice(2);
const opt = (nom, defaut) => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? Number(a.split('=')[1]) : defaut;
};
const ESSAI = args.includes('--essai');
const SANS_LOCAL = args.includes('--sans-local');
const MINUTES = opt('minutes', 110);
// 50 points par requête Overpass : sous pression les miroirs rendent 504 au-delà.
const LOT = opt('lot', 50);

// ── Modules PARTAGÉS avec l'application ──────────────────────────────────────────────
const dist = (f) => path.join(__dirname, '..', 'apps', 'api', 'dist', 'trip-analysis', f);
let resolution, miroirsMod, zones;
try {
  resolution = require(dist('speed-limit.resolution.js'));
  miroirsMod = require(dist('overpass-miroirs.js'));
  zones = require(dist('zones-osm.js'));
} catch (e) {
  console.error(
    `\nARRET : un module partage est introuvable.\n  cause : ${e.message}\n\n` +
      `Cet agent REFUSE de reimplementer les regles de rattachement, la politique de cadence ou\n` +
      `le decoupage des regions : deux copies divergeraient, et il finirait par ecrire de fausses\n` +
      `limites en base ou par refaire bannir nos IP. Construire l'API d'abord :\n\n` +
      `  cd apps/api && npm run build\n`,
  );
  process.exit(2);
}
const { requeteLot, panneDeguisee, resoudrePoints, MATCH_M, cleCellule } = resolution;
const { PoolMiroirs, MIROIRS_PAR_DEFAUT } = miroirsMod;
const { planTelechargement, cellulesOrphelines, couvre } = zones;

const { assurerExtrait, nettoyerPartiels } = require('./osm-extraits.cjs');
const { resoudreDepuisExtrait } = require('./osm-index.cjs');

// ── Accès base, via SSH (le Postgres n'est pas exposé publiquement) ───────────────────
function psql(sql, { lecture = true } = {}) {
  const flags = lecture ? '-t -A' : '-q';
  return execFileSync(
    'ssh',
    ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', VPS,
      `docker exec -i ${CONTENEUR} psql -U ${BASE.user} -d ${BASE.db} ${flags} -f -`],
    { input: sql, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
}

/** Toutes les portions restant à résoudre. UNE colonne concaténée : robuste à travers ssh. */
function cellulesARésoudre(limite = 400000) {
  const sql = `
    WITH c AS (
      SELECT DISTINCT round(lat::numeric,4) AS la, round(lng::numeric,4) AS ln
      FROM positions
      WHERE "speedKmh" > 33 AND valid IS DISTINCT FROM false AND NOT (lat=0 AND lng=0)
        AND timestamp >= now() - interval '60 days'
    )
    SELECT c.la::text || ' ' || c.ln::text FROM c
    WHERE NOT EXISTS (SELECT 1 FROM speed_limit_cache s WHERE s.key = c.la::text || ',' || c.ln::text)
    LIMIT ${limite};`;
  return psql(sql)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [la, ln] = l.split(' ');
      return { lat: Number(la), lng: Number(ln) };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

const compteCache = () => Number(psql(`SELECT count(*) FROM speed_limit_cache;`).trim());

/**
 * Écrit les portions CONCLUANTES. `ON CONFLICT DO NOTHING` : on n'écrase jamais une valeur
 * déjà connue, et deux exécutions concurrentes ne se marchent pas dessus.
 */
function ecrire(lignes) {
  let total = 0;
  for (let i = 0; i < lignes.length; i += LOT_ECRITURE) {
    const tranche = lignes.slice(i, i + LOT_ECRITURE);
    const valeurs = tranche
      .map((r) => {
        const ms = r.limite === null ? 'NULL' : String(Math.round(r.limite));
        return `(gen_random_uuid(),'${cleCellule(r.lat, r.lng)}',${ms},${r.lat},${r.lng},now())`;
      })
      .join(',');
    psql(
      `INSERT INTO speed_limit_cache (id,key,maxspeed,lat,lng,"createdAt") VALUES ${valeurs} ON CONFLICT (key) DO NOTHING;`,
      { lecture: false },
    );
    total += tranche.length;
  }
  return total;
}

// ── Voie 1 : l'extrait local ─────────────────────────────────────────────────────────
/**
 * Résout le maximum de portions depuis les extraits téléchargés. Renvoie celles qui restent
 * sans réponse — soit hors de toute région connue, soit sans route routable à portée.
 */
async function voieLocale(cellules, journal) {
  const plan = planTelechargement(cellules);
  if (plan.length === 0) {
    journal('aucune region ne justifie un telechargement : tout part vers Overpass');
    return { restantes: cellules, ecrites: 0 };
  }
  journal(`plan : ${plan.map((p) => `${p.region.nom} (${p.gain.toLocaleString('fr-FR')} portions, ${p.region.tailleMo} Mo)`).join(' + ')}`);

  let restantes = cellules;
  let ecrites = 0;

  for (const { region } of plan) {
    if (restantes.length === 0) break;
    // On ne soumet a l'extrait que les portions qu'il est cense couvrir : inutile de comparer
    // Barcelone a la carte de Midi-Pyrenees.
    const dedans = restantes.filter((c) => couvre(region, c.lat, c.lng));
    if (dedans.length === 0) continue;

    let chemin;
    try {
      chemin = await assurerExtrait(region, { journal });
    } catch (e) {
      journal(`${region.nom} : extrait indisponible (${e.message}) — ces portions iront vers Overpass`);
      continue;
    }

    const resolu = await resoudreDepuisExtrait(chemin, dedans, { journal });
    const concluantes = [];
    const sansReponse = new Set();
    for (const c of dedans) {
      const r = resolu.get(cleCellule(c.lat, c.lng));
      if (r && r.trouvee) concluantes.push({ ...c, limite: r.limite });
      else sansReponse.add(cleCellule(c.lat, c.lng));
    }

    journal(`${region.nom} : ${concluantes.length.toLocaleString('fr-FR')} resolues, ${sansReponse.size.toLocaleString('fr-FR')} sans route a portee`);
    if (!ESSAI) ecrites += ecrire(concluantes);
    restantes = restantes.filter((c) => !couvre(region, c.lat, c.lng) || sansReponse.has(cleCellule(c.lat, c.lng)));
  }
  return { restantes, ecrites };
}

// ── Voie 2 : Overpass, en secours ────────────────────────────────────────────────────
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new PoolMiroirs();

async function interroger(miroir, points) {
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), 190_000);
  try {
    const res = await fetch(miroir.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'data=' + encodeURIComponent(requeteLot(points, 20, 180)),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const texte = await res.text();
    // Overpass sert ses erreurs de surcharge SOUS un HTTP 200. Une panne n'est pas une absence
    // de route : on n'ecrit rien plutot que d'inventer un « inconnu » definitif.
    const panne = panneDeguisee(texte);
    if (panne) throw new Error(panne.motif);
    return resoudrePoints(points, JSON.parse(texte), MATCH_M);
  } finally {
    clearTimeout(minuteur);
  }
}

/** Un lot via le pool. Au moins une chance PAR MIROIR avant d'abandonner. */
async function lotOverpass(points) {
  for (let essai = 0; essai < MIROIRS_PAR_DEFAUT.length + 2; essai++) {
    const choix = pool.choisir();
    if (!choix) return null;
    if (choix.attendreMs > 0) await dors(choix.attendreMs);
    try {
      const res = await interroger(choix.miroir, points);
      pool.succes(choix.miroir);
      return { res, miroir: choix.miroir.nom };
    } catch (e) {
      const { ecarte } = pool.echec(choix.miroir, e.message);
      console.warn(`  ${choix.miroir.nom} : ${e.message}${ecarte ? ' -> ECARTE 1 h' : ''}`);
    }
  }
  return null;
}

// ── Boucle principale ────────────────────────────────────────────────────────────────
(async () => {
  const fin = Date.now() + MINUTES * 60_000;
  const h = () => new Date().toISOString().slice(11, 19);
  const journal = (s) => console.log(`[${h()}] ${s}`);

  journal(`agent limites de vitesse - budget ${MINUTES} min${ESSAI ? ' (ESSAI, aucune ecriture)' : ''}${SANS_LOCAL ? ' (sans extrait local)' : ''}`);
  const restes = nettoyerPartiels();
  if (restes) journal(`${restes} telechargement(s) interrompu(s) nettoye(s)`);

  const avant = compteCache();
  const cellules = cellulesARésoudre();
  journal(`cache : ${avant.toLocaleString('fr-FR')} portions connues - ${cellules.length.toLocaleString('fr-FR')} a resoudre`);
  if (cellules.length === 0) { journal('rien a faire.'); return; }

  const orphelines = cellulesOrphelines(cellules);
  if (orphelines.length > 0) {
    // Signal « la flotte roule ailleurs » : sans lui, ces trajets resteraient sans limites
    // sans que rien n'explique pourquoi.
    const ex = orphelines[0];
    journal(`ATTENTION : ${orphelines.length.toLocaleString('fr-FR')} portion(s) hors de toute region connue (ex. ${ex.lat},${ex.lng}) - a couvrir par un nouvel extrait`);
  }

  let ecrites = 0;
  let restantes = cellules;

  if (!SANS_LOCAL) {
    const r = await voieLocale(cellules, journal);
    restantes = r.restantes;
    ecrites += r.ecrites;
    journal(`voie locale : ${r.ecrites.toLocaleString('fr-FR')} ecrites, ${restantes.length.toLocaleString('fr-FR')} restantes pour Overpass`);
  }

  if (ESSAI) { journal(`ESSAI termine - ${restantes.length} portions seraient passees par Overpass`); return; }

  // Secours Overpass, dans le temps qui reste.
  const echouees = new Set();
  let lots = 0;
  while (Date.now() < fin && restantes.length > 0) {
    if (pool.tousEcartes()) { journal('tous les miroirs ecartes - on s\'arrete la, le reste attendra le prochain creneau.'); break; }
    const lot = restantes.filter((c) => !echouees.has(cleCellule(c.lat, c.lng))).slice(0, LOT);
    if (lot.length === 0) break;
    lots++;
    const sortie = await lotOverpass(lot);
    if (!sortie) { journal(`lot ${lots} abandonne - ${pool.resume()}`); for (const c of lot) echouees.add(cleCellule(c.lat, c.lng)); continue; }
    const concluantes = [];
    for (let i = 0; i < lot.length; i++) {
      if (sortie.res[i].trouvee) concluantes.push({ ...lot[i], limite: sortie.res[i].limite });
      else echouees.add(cleCellule(lot[i].lat, lot[i].lng));
    }
    ecrites += ecrire(concluantes);
    journal(`overpass lot ${lots} : ${concluantes.length}/${lot.length} via ${sortie.miroir} - ${ecrites.toLocaleString('fr-FR')} ecrites au total`);
    restantes = restantes.filter((c) => !echouees.has(cleCellule(c.lat, c.lng)) && !concluantes.some((x) => x.lat === c.lat && x.lng === c.lng));
  }

  const apres = compteCache();
  journal(`fini - cache ${avant.toLocaleString('fr-FR')} -> ${apres.toLocaleString('fr-FR')} (+${(apres - avant).toLocaleString('fr-FR')})`);
  if (lots > 0) journal(`miroirs : ${pool.resume()}`);
})().catch((e) => {
  console.error('ARRET sur erreur inattendue :', e && e.stack ? e.stack : e);
  process.exit(1);
});
