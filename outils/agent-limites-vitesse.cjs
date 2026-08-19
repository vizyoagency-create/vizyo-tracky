#!/usr/bin/env node
/**
 * Agent de rattrapage des LIMITES DE VITESSE — tourne sur le poste, pas sur le VPS.
 *
 * ── POURQUOI IL EXISTE ───────────────────────────────────────────────────────────────
 *
 * L'analyse des trajets a besoin de la limite légale de chaque point rapide, lue dans
 * OpenStreetMap. Sans elle, aucun excès n'est calculable et le score de conduite ne mesure
 * rien. Il reste ~220 000 cellules de route à résoudre pour que l'historique redevienne vrai.
 *
 * Overpass est GRATUIT : aucun crédit d'API n'est consommé, ni ici ni ailleurs.
 *
 * ── CE QUE LA JOURNÉE DU 2026-08-19 A APPRIS ─────────────────────────────────────────
 *
 * DEUX IP bannies d'`overpass-api.de` en une seule journée : celle du VPS le matin, celle de
 * ce poste l'après-midi. Même scénario les deux fois — une série de HTTP 429, puis un
 * ECONNREFUSED immédiat qui ressemble à une panne réseau alors que c'est une porte fermée.
 *
 * La faute n'était pas le choix du miroir mais le refus d'écouter : le code réessayait de la
 * même façon dans les deux cas. Il insistait quand on lui demandait de ralentir, puis
 * tambourinait sur une porte close — ce qui prolonge le bannissement au lieu de le laisser
 * expirer. La politique de cadence vit désormais dans `overpass-miroirs`, testée sans réseau.
 *
 * ── AUCUNE DONNÉE INVENTÉE ───────────────────────────────────────────────────────────
 *
 * Le rattachement point → route n'est PAS réimplémenté ici : il vient du module que
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
 *   node outils/agent-limites-vitesse.cjs [--minutes=110] [--lot=50] [--essai]
 *
 *   --essai   n'écrit RIEN : résout un seul lot et affiche ce qui serait inséré.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// ── Configuration ────────────────────────────────────────────────────────────────────
const VPS = 'root@72.62.26.240';
const CONTENEUR = 'tracky-postgres';
const BASE = { user: 'tracky', db: 'tracky_prod' };
const UA = 'Tracky/1.0 (contact@vizyoagency.com)';
/** Reprises immédiates sur un même lot avant de rendre la main au pool. */
const BACKOFF_MS = [5000, 15000];

const args = process.argv.slice(2);
const opt = (nom, defaut) => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? Number(a.split('=')[1]) : defaut;
};
const ESSAI = args.includes('--essai');
const MINUTES = opt('minutes', 110);
// 50 points : mesure du 2026-08-19, les miroirs sous pression rendent 504 sur des lots de 200.
// Une requete legere passe plus souvent, et nous fait moins remarquer.
const LOT = opt('lot', 50);

// ── Modules PARTAGÉS avec l'application ──────────────────────────────────────────────
const dist = (f) => path.join(__dirname, '..', 'apps', 'api', 'dist', 'trip-analysis', f);
let resolution, miroirs;
try {
  resolution = require(dist('speed-limit.resolution.js'));
  miroirs = require(dist('overpass-miroirs.js'));
} catch (e) {
  console.error(
    `\nARRET : un module partage est introuvable.\n  cause : ${e.message}\n\n` +
      `Cet agent REFUSE de reimplementer la logique de rattachement ou la politique de cadence :\n` +
      `deux copies divergeraient, et il finirait par ecrire de fausses limites en base ou par\n` +
      `refaire bannir nos IP. Construire l'API d'abord :\n\n  cd apps/api && npm run build\n`,
  );
  process.exit(2);
}
const { requeteLot, panneDeguisee, resoudrePoints, MATCH_M } = resolution;
const { PoolMiroirs, MIROIRS_PAR_DEFAUT } = miroirs;

// ── Accès base, via SSH (le Postgres n'est pas exposé publiquement) ───────────────────
function psql(sql, { lecture = true } = {}) {
  const flags = lecture ? '-t -A' : '-q';
  return execFileSync(
    'ssh',
    ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', VPS,
      `docker exec -i ${CONTENEUR} psql -U ${BASE.user} -d ${BASE.db} ${flags} -f -`],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Cellules déjà tentées SANS SUCCÈS pendant ce passage.
 *
 * ⚠️ SANS CETTE MÉMOIRE, L'AGENT TOURNE EN ROND. Certaines cellules sont réellement
 * insolubles : un véhicule relevé à plus de 33 km/h dans un tunnel de Barcelone voit sa
 * position dériver en surface, où la seule voie à 20 m est un TROTTOIR (vérifié sur deux
 * miroirs indépendants). On refuse — à raison — de les mémoriser, puisqu'aucune route n'a été
 * rattachée. Mais la requête suivante les remet en tête de liste, et l'agent repasse
 * indéfiniment sur les mêmes points sans jamais atteindre ceux qui, eux, se résoudraient.
 *
 * On les écarte donc pour la durée du passage seulement : au créneau suivant elles seront
 * retentées, car un tunnel cartographié entre-temps ou un point voisin peut les débloquer.
 */
const echouees = new Set();

/** Cellules restant à résoudre : points rapides dont la clé n'est pas déjà en cache. */
function cellulesARésoudre(limite) {
  // UNE colonne deja concatenee : plus robuste que de negocier un separateur a travers ssh.
  const exclues = echouees.size
    ? `AND (c.la::text || ',' || c.ln::text) NOT IN (${[...echouees].map((k) => `'${k}'`).join(',')})`
    : '';
  const sql = `
    WITH c AS (
      SELECT DISTINCT round(lat::numeric,4) AS la, round(lng::numeric,4) AS ln
      FROM positions
      WHERE "speedKmh" > 33 AND valid IS DISTINCT FROM false AND NOT (lat=0 AND lng=0)
        AND timestamp >= now() - interval '60 days'
    )
    SELECT c.la::text || ' ' || c.ln::text FROM c
    WHERE NOT EXISTS (SELECT 1 FROM speed_limit_cache s WHERE s.key = c.la::text || ',' || c.ln::text)
    ${exclues}
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

// ── Overpass, via le pool ────────────────────────────────────────────────────────────
const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new PoolMiroirs();

/** Une tentative sur UN miroir donné. Lève avec un motif exploitable par le pool. */
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

/**
 * Résout un lot en s'appuyant sur le pool : rotation, ralentissement sur 429, mise à l'écart
 * sur bannissement. Renvoie null si aucun miroir n'a pu répondre.
 */
async function resoudreLot(points) {
  // ⚠️ AU MOINS UNE CHANCE PAR MIROIR. Avec un plafond de 3 tentatives, un lot etait abandonne
  //    alors que le 4e miroir n'avait jamais ete sollicite — mesure le 2026-08-19 : deux
  //    instances ecartees, une en 504, et `maps.mail.ru` jamais interroge.
  const maxTentatives = MIROIRS_PAR_DEFAUT.length + BACKOFF_MS.length;
  for (let essai = 0; essai < maxTentatives; essai++) {
    const choix = pool.choisir();
    if (!choix) return null; // tous ecartes : l'appelant doit s'arreter
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
  const debut = Date.now();
  const fin = debut + MINUTES * 60_000;
  const h = () => new Date().toISOString().slice(11, 19);

  console.log(`[${h()}] agent limites de vitesse - lots de ${LOT}, budget ${MINUTES} min${ESSAI ? ' (ESSAI, aucune ecriture)' : ''}`);
  const avant = compteCache();
  console.log(`[${h()}] cache au demarrage : ${avant} cellules`);

  let ecrites = 0, lots = 0, abandons = 0;

  while (Date.now() < fin) {
    if (pool.tousEcartes()) {
      console.error(`[${h()}] tous les miroirs sont ecartes. Arret propre - rien de perdu, on reprendra au prochain creneau.`);
      break;
    }
    const points = cellulesARésoudre(LOT);
    if (points.length === 0) {
      console.log(`[${h()}] plus aucune cellule a resoudre - termine.`);
      break;
    }

    lots++;
    const t0 = Date.now();
    const sortie = await resoudreLot(points);
    const secondes = ((Date.now() - t0) / 1000).toFixed(1);

    if (sortie === null) {
      abandons++;
      console.warn(`[${h()}] lot ${lots} abandonne (${points.length} pts) - ${pool.resume()}`);
      continue;
    }

    // Seules les cellules CONCLUANTES sont ecrites. `trouvee: false` = aucune voie routable a
    // portee : on n'en fait pas une verite en base, mais on les ecarte du passage pour ne pas
    // les repiocher en boucle et ne jamais atteindre les suivantes.
    const evaluees = points.map((p, i) => ({ ...p, ...sortie.res[i] }));
    const concluantes = evaluees.filter((r) => r.trouvee);
    for (const r of evaluees) {
      if (!r.trouvee) echouees.add(`${r.lat.toFixed(4)},${r.lng.toFixed(4)}`);
    }

    if (ESSAI) {
      console.log(`[${h()}] ESSAI : ${concluantes.length}/${points.length} concluantes via ${sortie.miroir} en ${secondes}s`);
      concluantes.slice(0, 5).forEach((r) => console.log(`    ${r.lat.toFixed(4)},${r.lng.toFixed(4)} -> ${r.limite ?? 'type inconnu'}`));
      break;
    }

    ecrites += ecrire(concluantes);
    const restant = Math.max(0, Math.round((fin - Date.now()) / 60000));
    console.log(`[${h()}] lot ${lots} : ${concluantes.length}/${points.length} via ${sortie.miroir} en ${secondes}s - ${ecrites} ecrites, ${restant} min restantes`);
  }

  if (!ESSAI) {
    const apres = compteCache();
    console.log(`[${h()}] fini - cache ${avant} -> ${apres} (+${apres - avant}), ${lots} lot(s), ${abandons} abandon(s), ${echouees.size} cellule(s) sans route a portee`);
    console.log(`[${h()}] miroirs : ${pool.resume()}`);
  }
})().catch((e) => {
  console.error('ARRET sur erreur inattendue :', e && e.message ? e.message : e);
  process.exit(1);
});
