#!/usr/bin/env node
/**
 * Agent QUALITÉ GPS — tourne sur le poste, pas sur le VPS.
 *
 * ── CE QU'IL RÉPOND ──────────────────────────────────────────────────────────────────
 *
 * Les zones de perte de signal sont apprises PAR VÉHICULE : chaque véhicule accumule ses propres
 * centroïdes. Personne ne pouvait donc répondre à la seule question qui décide d'une action :
 *
 *   « Est-ce le LIEU qui est mauvais, ou le BOÎTIER ? »
 *
 * Un parking souterrain fait perdre le signal à tous ceux qui y entrent — rien à réparer. Un
 * boîtier mourant perd le signal PARTOUT — il faut le remplacer. Les deux produisent exactement
 * les mêmes lignes en base. Il faut croiser les véhicules entre eux.
 *
 * ── AUCUN MODÈLE N'EST APPELÉ ────────────────────────────────────────────────────────
 *
 * Contrairement à l'agent de récit, celui-ci ne consulte AUCUNE IA : le diagnostic est un calcul
 * géométrique déterministe. Il ne consomme donc ni crédits d'API, ni quota d'abonnement — et il
 * n'écrit rien dans le journal des coûts IA, qui n'a pas à s'enrichir de travail qui n'en est pas.
 *
 * La logique vit dans `gps-diagnostic.shared`, importée depuis `apps/api/dist` : la même que celle
 * que l'application pourra exposer. L'agent REFUSE de démarrer si le module compilé est absent.
 *
 * ── OÙ VONT LES CONCLUSIONS ──────────────────────────────────────────────────────────
 *
 *   BOÎTIER défaillant  ->  centre d'alerte. Une action datée, sur un canal déjà surveillé.
 *   ZONE MORTE (lieu)   ->  table `gps_zone_diagnostics`. Une qualification durable, à relire.
 *   INDÉTERMINÉ         ->  nulle part. On ne remonte pas ce sur quoi on n'a rien conclu.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────
 *
 *   node outils/agent-qualite-gps.cjs [--essai]
 *
 *   --essai   n'écrit RIEN : affiche les diagnostics qui seraient enregistrés.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const VPS = 'root@72.62.26.240';
const CONTENEUR = 'tracky-postgres';
const BASE = { user: 'tracky', db: 'tracky_prod' };
/** Source dédiée au centre d'alerte — filtrable, et distincte des pannes applicatives. */
const SOURCE_ALERTE = 'GPS_QUALITE';
/**
 * Un même boîtier n'est pas re-signalé avant ce délai.
 *
 * Sans cette garde, un agent nocturne réécrirait la même alerte toutes les nuits : au bout d'une
 * semaine le centre d'alerte serait illisible, et c'est précisément l'écran qu'on veut garder
 * digne de confiance. Sept jours laissent le temps d'aller voir le véhicule.
 */
const JOURS_SANS_REPETITION = 7;

const ESSAI = process.argv.slice(2).includes('--essai');

// ── Le module PARTAGÉ avec l'application ─────────────────────────────────────────────
const DIST = path.join(__dirname, '..', 'apps', 'api', 'dist', 'gps-dead-zones', 'gps-diagnostic.shared.js');
let partage;
try {
  partage = require(DIST);
} catch (e) {
  console.error(
    `\nARRET : le module de diagnostic partage est introuvable.\n  attendu : ${DIST}\n  cause   : ${e.message}\n\n` +
      `Cet agent REFUSE de reimplementer la correlation : deux copies divergeraient et il finirait\n` +
      `par accuser des boitiers que l'application aurait blanchis. Construire l'API d'abord :\n\n` +
      `  cd apps/api && npm run build\n`,
  );
  process.exit(2);
}
const { diagnostiquer, diagnosticsActionnables } = partage;

// ── Accès base ───────────────────────────────────────────────────────────────────────
function psql(sql, { lecture = true } = {}) {
  const flags = lecture ? ['-t', '-A'] : ['-q'];
  return execFileSync(
    'ssh',
    ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', VPS,
      // ⚠️ ON_ERROR_STOP=1 : sans lui, psql sort en 0 MEME quand le SQL echoue. L'agent
      //    comptait alors comme ecrit ce qui ne l'etait pas — il annoncait « 1 zone
      //    enregistree » sur une table inexistante. Un agent qui se felicite d'un travail
      //    qu'il n'a pas fait est pire qu'un agent en panne : la panne, elle, se voit.
      `docker exec -i ${CONTENEUR} psql -U ${BASE.user} -d ${BASE.db} -v ON_ERROR_STOP=1 ${flags.join(' ')} -f -`],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}
const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;
const tableau = (v) => `ARRAY[${v.map(q).join(',')}]::text[]`;

/** Toutes les zones connues, avec la plaque du vehicule — de quoi rendre un diagnostic lisible. */
function zones() {
  const sql = `SELECT coalesce(json_agg(row_to_json(x)),'[]')::text FROM (
    SELECT z.id, z."vehicleId", v.plate AS plaque, z."fleetId", z."centroidLat", z."centroidLng",
           z."radiusM", z.occurrences, z."firstSeenAt", z."lastSeenAt", z."placeLabel"
    FROM gps_dead_zones z JOIN vehicles v ON v.id = z."vehicleId") x;`;
  return JSON.parse(psql(sql).trim() || '[]');
}

/** Plaques deja signalees recemment : on ne re-alerte pas tant que le delai n'est pas ecoule. */
function dejaSignalees() {
  const sql = `SELECT coalesce(json_agg(DISTINCT context->>'plaque'),'[]')::text
    FROM error_logs
    WHERE source = ${q(SOURCE_ALERTE)}
      AND "createdAt" > now() - interval '${JOURS_SANS_REPETITION} days'
      AND context->>'plaque' IS NOT NULL;`;
  return new Set(JSON.parse(psql(sql).trim() || '[]'));
}

/**
 * Cle STABLE d'un lieu : societe + coordonnees arrondies au millieme (~110 m).
 *
 * C'est elle qui fait qu'un passage nocturne MET A JOUR le diagnostic d'hier au lieu d'en creer un
 * nouveau. Sans cle stable, la table accumulerait une ligne par nuit pour le meme parking.
 */
const cleLieu = (d) => `${d.fleetId}:${d.lat.toFixed(3)}:${d.lng.toFixed(3)}`;

function enregistrerLieu(d) {
  const sql = `
    INSERT INTO gps_zone_diagnostics
      (id,"createdAt","updatedAt","fleetId",cle,lat,lng,"placeLabel",vehicules,episodes,
       "etalementM",constat,recommandation)
    VALUES (gen_random_uuid(), now(), now(), ${q(d.fleetId)}, ${q(cleLieu(d))}, ${d.lat}, ${d.lng},
            ${d.placeLabel ? q(d.placeLabel) : 'NULL'}, ${tableau(d.vehicules)}, ${d.episodes},
            ${d.etalementM}, ${q(d.constat)}, ${q(d.recommandation)})
    ON CONFLICT (cle) DO UPDATE SET
      "updatedAt" = now(),
      vehicules = EXCLUDED.vehicules,
      episodes = EXCLUDED.episodes,
      "etalementM" = EXCLUDED."etalementM",
      constat = EXCLUDED.constat,
      "placeLabel" = coalesce(EXCLUDED."placeLabel", gps_zone_diagnostics."placeLabel");`;
  psql(sql, { lecture: false });
}

/**
 * Un boitier defaillant part au centre d'alerte.
 *
 * `CRITICAL` seulement pour une gravite haute : le centre perd sa valeur si tout y est critique.
 */
function alerterBoitier(d) {
  const niveau = d.gravite === 'haute' ? 'CRITICAL' : 'ERROR';
  const contexte = JSON.stringify({
    plaque: d.vehicules[0],
    episodes: d.episodes,
    etalementM: d.etalementM,
    zones: d.zoneIds.length,
    recommandation: d.recommandation,
  });
  const sql = `
    INSERT INTO error_logs (id,level,source,message,context,"createdAt")
    VALUES (gen_random_uuid(), ${q(niveau)}, ${q(SOURCE_ALERTE)},
            ${q(`${d.constat} ${d.recommandation}`)}, ${q(contexte)}::jsonb, now());`;
  psql(sql, { lecture: false });
}

// ── Passage ──────────────────────────────────────────────────────────────────────────
function passage() {
  const h = () => new Date().toISOString().slice(11, 19);
  console.log(`[${h()}] agent qualite GPS${ESSAI ? ' (ESSAI, aucune ecriture)' : ''} — aucun modele appele`);

  const brutes = zones();
  if (brutes.length === 0) {
    console.log(`[${h()}] aucune zone connue — rien a diagnostiquer.`);
    return;
  }

  // Une societe a la fois : correler les zones de deux clients entre elles n'aurait aucun sens,
  // et melangerait leurs donnees.
  const parFlotte = new Map();
  for (const z of brutes) {
    const l = parFlotte.get(z.fleetId) ?? [];
    l.push(z);
    parFlotte.set(z.fleetId, l);
  }

  let lieux = 0;
  let boitiers = 0;
  let tus = 0;
  const deja = ESSAI ? new Set() : dejaSignalees();

  for (const [, zonesFlotte] of parFlotte) {
    const tous = diagnostiquer(zonesFlotte);
    tus += tous.length - diagnosticsActionnables(tous).length;

    for (const d of diagnosticsActionnables(tous)) {
      if (ESSAI) {
        console.log(`  [${d.gravite.toUpperCase()}] ${d.nature} — ${d.constat}`);
        if (d.nature === 'lieu') lieux++;
        else boitiers++;
        continue;
      }
      if (d.nature === 'lieu') {
        enregistrerLieu(d);
        lieux++;
      } else if (!deja.has(d.vehicules[0])) {
        alerterBoitier(d);
        boitiers++;
      }
      // Boitier deja signale dans les 7 jours : on ne repete pas. Le silence ici est voulu.
    }
  }

  console.log(
    `[${h()}] fini — ${lieux} zone(s) enregistree(s), ${boitiers} boitier(s) signale(s), ` +
      `${tus} cas laisses sans conclusion.`,
  );
}

try {
  passage();
} catch (e) {
  // Un echec doit se lire en une ligne dans le journal de la tache planifiee, pas sous une pile
  // Node. Et il doit sortir en NON-ZERO : c'est ce que Windows retient pour dire « derniere
  // execution en echec ».
  const msg = (e && e.message ? e.message : String(e)).split(String.fromCharCode(10))[0];
  console.error(`ARRET : ${msg.slice(0, 300)}`);
  process.exit(1);
}
