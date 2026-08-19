#!/usr/bin/env node
/**
 * Agent de rattrapage des LIMITES DE VITESSE — tourne sur le poste, pas sur le VPS.
 *
 * ── POURQUOI IL EXISTE ───────────────────────────────────────────────────────────────
 *
 * L'analyse des trajets a besoin de la limite légale de chaque point rapide, lue dans
 * OpenStreetMap via Overpass. Il reste ~213 000 cellules de route à résoudre pour que les
 * scores de conduite de l'historique redeviennent vrais.
 *
 * Deux raisons de faire ça ici plutôt que sur le serveur :
 *   1. l'IP du VPS s'est fait BANNIR de `overpass-api.de` (ECONNREFUSED immédiat, même sur une
 *      requête à deux points). Le serveur est retombé sur `kumi.systems`, qui répond en 30-40 s
 *      par lot. Depuis ce poste, `overpass-api.de` répond en 11 s — presque trois fois plus vite ;
 *   2. Overpass est GRATUIT. Aucun crédit d'API n'est consommé, ni ici ni ailleurs.
 *
 * ── AUCUNE DONNÉE INVENTÉE ───────────────────────────────────────────────────────────
 *
 * Le rattachement point → route n'est PAS réimplémenté ici : il est importé du module que
 * l'application elle-même utilise (`speed-limit.resolution`). Deux copies auraient fini par
 * diverger, et cet agent aurait écrit en base des limites que l'app n'aurait jamais déduites.
 *
 * Trois règles, dans le même esprit :
 *   — on n'écrit QUE les cellules où une voie routable a réellement été rattachée (`trouvee`) ;
 *   — toute réponse douteuse (HTTP != 200, corps non-JSON, champ `remark`) est une PANNE : on
 *     n'écrit rien et on réessaiera. Overpass sert ses erreurs de surcharge SOUS un HTTP 200,
 *     et les mémoriser est précisément ce qui avait stérilisé 98,8 % du cache ;
 *   — l'insertion est en `ON CONFLICT DO NOTHING` : jamais d'écrasement d'une valeur existante.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────
 *
 *   node outils/agent-limites-vitesse.cjs [--minutes=50] [--lot=200] [--essai]
 *
 *   --essai   n'écrit RIEN : résout un seul lot et affiche ce qui serait inséré.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// ── Configuration ────────────────────────────────────────────────────────────────────
const VPS = 'root@72.62.26.240';
const CONTENEUR = 'tracky-postgres';
const BASE = { user: 'tracky', db: 'tracky_prod' };
/** Instance rapide : ce poste n'est pas banni, contrairement au VPS. */
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'Tracky/1.0 (contact@vizyoagency.com)';
/** Pause entre deux requêtes : on reste poli, c'est un service public gratuit. */
let PAUSE_MS = 2000;
/** Attentes avant de rejouer un lot refusé (quota momentané, passerelle saturée). */
const BACKOFF_MS = [5000, 15000, 45000];
/** Au-delà, on considère qu'Overpass nous a fermé la porte et on s'arrête proprement. */
const ECHECS_CONSECUTIFS_MAX = 5;

const args = process.argv.slice(2);
const opt = (nom, defaut) => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? Number(a.split('=')[1]) : defaut;
};
const ESSAI = args.includes('--essai');
const MINUTES = opt('minutes', 50);
const LOT = opt('lot', 200);
PAUSE_MS = opt('pause', PAUSE_MS);

// ── Le module PARTAGÉ avec l'application ─────────────────────────────────────────────
const DIST = path.join(__dirname, '..', 'apps', 'api', 'dist', 'trip-analysis', 'speed-limit.resolution.js');
let resolution;
try {
  resolution = require(DIST);
} catch (e) {
  console.error(
    `\nARRET : le module de resolution partage est introuvable.\n  attendu : ${DIST}\n  cause   : ${e.message}\n\n` +
      `Cet agent REFUSE de reimplementer la logique de rattachement : deux copies divergeraient\n` +
      `et il finirait par ecrire de fausses limites en base. Construire l'API d'abord :\n\n` +
      `  cd apps/api && npm run build\n`,
  );
  process.exit(2);
}
const { requeteLot, panneDeguisee, resoudrePoints, MATCH_M } = resolution;

// ── Accès base, via SSH (le Postgres n'est pas exposé publiquement) ───────────────────
function psql(sql, { lecture = true } = {}) {
  const flags = lecture ? ['-t', '-A'] : ['-q'];
  return execFileSync(
    'ssh',
    ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', VPS,
      `docker exec -i ${CONTENEUR} psql -U ${BASE.user} -d ${BASE.db} ${flags.join(' ')} -f -`],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

/** Cellules restant à résoudre : points rapides dont la clé n'est pas déjà en cache. */
function cellulesARésoudre(limite) {
  const sql = `
    WITH c AS (
      SELECT DISTINCT round(lat::numeric,4) AS la, round(lng::numeric,4) AS ln
      FROM positions
      WHERE "speedKmh" > 33 AND valid IS DISTINCT FROM false AND NOT (lat=0 AND lng=0)
        AND timestamp >= now() - interval '60 days'
    )
    SELECT c.la::text || ' ' || c.ln::text FROM c
    WHERE NOT EXISTS (SELECT 1 FROM speed_limit_cache s WHERE s.key = c.la::text||','||c.ln::text)
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

function compteCache() {
  return Number(psql(`SELECT count(*) FROM speed_limit_cache;`).trim());
}

/**
 * Écrit les cellules CONCLUANTES. `ON CONFLICT DO NOTHING` : on n'écrase jamais une valeur
 * déjà connue, et deux exécutions concurrentes ne se marchent pas dessus.
 */
function ecrire(lignes) {
  if (lignes.length === 0) return 0;
  const valeurs = lignes
    .map((r) => {
      const key = `${r.lat.toFixed(4)},${r.lng.toFixed(4)}`;
      const ms = r.limite === null ? 'NULL' : String(Math.round(r.limite));
      return `(gen_random_uuid(),'${key}',${ms},${r.lat},${r.lng},now())`;
    })
    .join(',');
  psql(
    `INSERT INTO speed_limit_cache (id,key,maxspeed,lat,lng,"createdAt") VALUES ${valeurs} ON CONFLICT (key) DO NOTHING;`,
    { lecture: false },
  );
  return lignes.length;
}

// ── Overpass ─────────────────────────────────────────────────────────────────────────
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

/** Un lot, avec reprise sur refus de quota. Renvoie null si Overpass reste indisponible. */
async function resoudreLot(points) {
  for (let essai = 0; ; essai++) {
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), 190_000);
    try {
      const res = await fetch(OVERPASS, {
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
    } catch (e) {
      if (essai >= BACKOFF_MS.length) {
        console.warn(`  lot abandonne (${points.length} pts) : ${e.message}`);
        return null;
      }
      console.warn(`  reprise ${essai + 1}/${BACKOFF_MS.length} dans ${BACKOFF_MS[essai] / 1000}s : ${e.message}`);
      await dors(BACKOFF_MS[essai]);
    } finally {
      clearTimeout(minuteur);
    }
  }
}

// ── Boucle principale ────────────────────────────────────────────────────────────────
(async () => {
  const debut = Date.now();
  const fin = debut + MINUTES * 60_000;
  const horodatage = () => new Date().toISOString().slice(11, 19);

  console.log(`[${horodatage()}] agent limites de vitesse — lots de ${LOT}, budget ${MINUTES} min${ESSAI ? ' (ESSAI, aucune ecriture)' : ''}`);
  const avant = compteCache();
  console.log(`[${horodatage()}] cache au demarrage : ${avant} cellules`);

  let resolues = 0, ecrites = 0, lots = 0, echecs = 0;

  while (Date.now() < fin) {
    const points = cellulesARésoudre(LOT);
    if (points.length === 0) {
      console.log(`[${horodatage()}] plus aucune cellule a resoudre — termine.`);
      break;
    }

    lots++;
    const t0 = Date.now();
    const res = await resoudreLot(points);
    const secondes = ((Date.now() - t0) / 1000).toFixed(1);

    if (res === null) {
      if (++echecs >= ECHECS_CONSECUTIFS_MAX) {
        console.error(`[${horodatage()}] ${echecs} echecs consecutifs : Overpass nous refuse. Arret propre, rien de perdu.`);
        break;
      }
      await dors(PAUSE_MS * 5);
      continue;
    }
    echecs = 0;

    // ⚠️ Seules les cellules CONCLUANTES sont ecrites. `trouvee: false` = aucune voie a portee,
    //    symptome d'une reponse degradee et non un fait : on n'en fait pas une verite en base.
    const concluantes = points
      .map((p, i) => ({ ...p, ...res[i] }))
      .filter((r) => r.trouvee);
    resolues += concluantes.length;

    if (ESSAI) {
      const apercu = concluantes.slice(0, 5).map((r) => `${r.lat.toFixed(4)},${r.lng.toFixed(4)} -> ${r.limite ?? 'type inconnu'}`);
      console.log(`[${horodatage()}] ESSAI : ${concluantes.length}/${points.length} concluantes en ${secondes}s`);
      apercu.forEach((a) => console.log(`    ${a}`));
      break;
    }

    ecrites += ecrire(concluantes);
    const restant = Math.max(0, Math.round((fin - Date.now()) / 60000));
    console.log(`[${horodatage()}] lot ${lots} : ${concluantes.length}/${points.length} concluantes en ${secondes}s — ${ecrites} ecrites, ${restant} min restantes`);
    await dors(PAUSE_MS);
  }

  if (!ESSAI) {
    const apres = compteCache();
    console.log(`[${horodatage()}] fini — cache ${avant} -> ${apres} (+${apres - avant}), ${lots} lot(s), ${resolues} resolues`);
  }
})().catch((e) => {
  console.error('ARRET sur erreur inattendue :', e && e.message ? e.message : e);
  process.exit(1);
});
