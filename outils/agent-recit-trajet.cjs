#!/usr/bin/env node
/**
 * Agent de RÉCIT DE TRAJET — tourne sur le poste, pas sur le VPS.
 *
 * ── POURQUOI IL EXISTE ───────────────────────────────────────────────────────────────
 *
 * Le récit de trajet était le premier poste de dépense IA de l'application : 4 410 appels et
 * 45,89 $ sur le seul mois de juillet, soit 89 % de la facture. Rallumé pour les trois sociétés
 * actives, il coûterait de l'ordre de 386 $/an.
 *
 * Ici, le même travail passe par l'abonnement Claude Code du poste : aucun crédit d'API n'est
 * consommé. C'est plus lent, et ça suppose un PC allumé — d'où un passage par nuit plutôt qu'un
 * cron horaire, et un état déduit du travail réellement écrit en base.
 *
 * ── AUCUNE DONNÉE INVENTÉE ───────────────────────────────────────────────────────────
 *
 * La construction du payload et l'assainissement de la réponse ne sont PAS réimplémentés : ils
 * sont importés du module que l'application elle-même utilise (`trip-narrative.shared`). Deux
 * copies auraient fini par diverger, et cet agent aurait écrit en base des récits que l'app
 * n'aurait jamais produits — sans que rien ne le signale.
 *
 * Trois règles, dans le même esprit que l'agent de limites de vitesse :
 *   — on n'écrit QUE les récits CONCLUANTS (`recitConcluant`). Un récit vide ou de trois mots
 *     n'est pas un récit, et l'écrire condamnerait le trajet à ne jamais être repris : le
 *     pipeline considère qu'un trajet avec récit est traité ;
 *   — toute réponse douteuse (JSON illisible, champ manquant, appel en échec) est une PANNE : on
 *     n'écrit rien et le trajet repassera au prochain créneau ;
 *   — on ne touche jamais un trajet qui a DÉJÀ un récit (`narrative IS NULL` dans la requête ET
 *     dans l'UPDATE) : deux passages concurrents ne peuvent pas s'écraser.
 *
 * ── PÉRIMÈTRE : LE COURANT, PAS L'HISTORIQUE ─────────────────────────────────────────
 *
 * Seules les sociétés dont l'IA est ACTIVE (`fleets."aiEnabled"`) sont servies — la même porte que
 * l'application. Que ce soit absorbé par l'abonnement ne change pas ce à quoi un client a droit.
 *
 * Et seuls les trajets RÉCENTS sont narrés — la fenêtre porte sur la date du TRAJET
 * (`trips."startedAt"`), pas sur celle de la ligne d'analyse. La nuance n'est pas cosmétique :
 * l'analyse déterministe rattrape en ce moment son propre retard, donc `trip_analyses."updatedAt"`
 * est frais sur des milliers de vieux trajets. Filtrer dessus ramenait 4 761 candidats au lieu
 * de 234 — c'est-à-dire tout l'historique, exactement ce qu'on avait décidé de ne pas faire.
 *
 * Décision du 20/08 : le retard historique n'est PAS rattrapé. Un récit sur le trajet d'hier a une
 * chance d'être lu ; sur un trajet d'il y a six semaines, aucune.
 *
 * ── UN APPEL, PLUSIEURS TRAJETS ──────────────────────────────────────────────────────
 *
 * Chaque invocation de la CLI renvoie son contexte complet, quel que soit le travail demandé :
 * un péage fixe par appel. Mesuré le 20/08 : un trajet par appel revient à peu près au double
 * de cinq trajets par appel. Grouper n'est donc pas une optimisation, c'est la condition pour
 * que le passage tienne dans une nuit.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────
 *
 *   node outils/agent-recit-trajet.cjs [--minutes=110] [--lot=5] [--heures=48] [--modele=sonnet] [--essai]
 *
 *   --essai   n'écrit RIEN et n'appelle PAS le modèle : montre les trajets retenus et le payload
 *             exact qui serait envoyé. Sert à vérifier la sélection et le module partagé.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// ── Configuration ────────────────────────────────────────────────────────────────────
const VPS = 'root@72.62.26.240';
const CONTENEUR = 'tracky-postgres';
const BASE = { user: 'tracky', db: 'tracky_prod' };
/**
 * Le BINAIRE de la CLI.
 *
 * ⚠️ Sous Windows, `claude` est un script (`.cmd`, `.ps1`) : `execFileSync('claude')` echoue en
 *    ENOENT / EINVAL selon la variante. Node refuse de lancer un `.cmd` sans shell depuis 20.x,
 *    et passer par un shell obligerait a echapper un prompt multiligne — la porte ouverte aux
 *    injections. On vise donc le binaire reel.
 */
const CLI = process.platform === 'win32'
  ? 'C:/Program Files/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
  : 'claude';
/** Pause entre deux lots — on ne mitraille pas sa propre session. */
let PAUSE_MS = 1500;
/** Attentes avant de rejouer un trajet refusé. */
const BACKOFF_MS = [4000, 12000, 30000];
/** Au-delà, on considère que quelque chose est cassé et on s'arrête proprement. */
const ECHECS_CONSECUTIFS_MAX = 4;
/** Temps maximum accorde a UN LOT. Au-dela, on abandonne le lot, pas le passage. */
const TIMEOUT_LOT_MS = 300_000;

const args = process.argv.slice(2);
const opt = (nom, defaut) => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? Number(a.split('=')[1]) : defaut;
};
const texteOpt = (nom, defaut) => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? a.split('=').slice(1).join('=') : defaut;
};
const ESSAI = args.includes('--essai');
const MINUTES = opt('minutes', 110);
/** Trajets envoyes en UN appel. Au-dela, la reponse devient longue et le JSON plus fragile. */
const LOT = opt('lot', 5);
/** Fenetre du « courant ». Un passage par nuit couvre largement 48 h. */
const HEURES = opt('heures', 48);
const MODELE = texteOpt('modele', 'sonnet');
PAUSE_MS = opt('pause', PAUSE_MS);

// ── Les modules PARTAGÉS avec l'application ──────────────────────────────────────────
const DIST = path.join(__dirname, '..', 'apps', 'api', 'dist', 'trip-analysis');
let partage;
let prompt;
try {
  partage = require(path.join(DIST, 'trip-narrative.shared.js'));
  prompt = require(path.join(DIST, 'trip-analysis.prompt.js'));
} catch (e) {
  console.error(
    `\nARRET : les modules partages sont introuvables.\n  attendus dans : ${DIST}\n  cause         : ${e.message}\n\n` +
      `Cet agent REFUSE de reimplementer la construction du payload et l'assainissement : deux\n` +
      `copies divergeraient et il finirait par ecrire des recits que l'application n'aurait jamais\n` +
      `produits. Construire l'API d'abord :\n\n  cd apps/api && npm run build\n`,
  );
  process.exit(2);
}
const { construirePayloadRecit, assainirRecit, recitConcluant } = partage;
const { renderTripNarrativeSystem, TRIP_NARRATIVE_SCHEMA } = prompt;

// ── Accès base, via SSH (le Postgres n'est pas expose publiquement) ───────────────────
function psql(sql, { lecture = true } = {}) {
  const flags = lecture ? ['-t', '-A'] : ['-q'];
  return execFileSync(
    'ssh',
    ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', VPS,
      `docker exec -i ${CONTENEUR} psql -U ${BASE.user} -d ${BASE.db} ${flags.join(' ')} -f -`],
    { input: sql, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
}

/** Echappe une chaine pour un litteral SQL. `standard_conforming_strings` est actif : seule la quote compte. */
const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

/**
 * Trajets a narrer : analyses SANS recit, societe a IA active, et RECENTES.
 *
 * La fenetre est la decision de fond : on ne rattrape pas l'historique. Les plus recents d'abord,
 * pour que le passage suivant reprenne naturellement la ou celui-ci s'est arrete.
 */
function trajetsANarrer(limite) {
  const sql = `
    SELECT a."tripId", row_to_json(a)::text
    FROM trip_analyses a
    JOIN trips    t ON t.id = a."tripId"
    JOIN vehicles v ON v.id = a."vehicleId"
    JOIN fleets   f ON f.id = v."fleetId"
    WHERE a.narrative IS NULL
      AND f."aiEnabled" = true
      AND t."startedAt" > now() - interval '${Number(HEURES) || 48} hours'
    ORDER BY t."startedAt" DESC
    LIMIT ${Number(limite) || 5};`;
  return psql(sql)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const sep = l.indexOf('|');
      try {
        return { tripId: l.slice(0, sep), ligne: JSON.parse(l.slice(sep + 1)) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function resteAFaire() {
  const sql = `
    SELECT count(*) FROM trip_analyses a
    JOIN trips    t ON t.id = a."tripId"
    JOIN vehicles v ON v.id = a."vehicleId"
    JOIN fleets   f ON f.id = v."fleetId"
    WHERE a.narrative IS NULL AND f."aiEnabled" = true
      AND t."startedAt" > now() - interval '${Number(HEURES) || 48} hours';`;
  return Number(psql(sql).trim()) || 0;
}

// ── Le modele, via l'abonnement du poste ─────────────────────────────────────────────

/**
 * Un appel, PLUSIEURS recits. Renvoie une Map index -> recit assaini.
 *
 * Chaque invocation de la CLI renvoie son contexte complet : c'est un peage fixe, paye que l'on
 * demande un trajet ou dix. Grouper est donc la condition pour que le passage tienne dans une nuit.
 *
 * `--max-turns 1` et aucun outil autorise : on veut UNE reponse a partir des donnees fournies, pas
 * un agent qui part explorer le disque. C'est aussi ce qui rend la duree previsible.
 *
 * Un trajet dont le recit manque ou est illisible n'est PAS invente : il est simplement absent de
 * la Map, et repassera au prochain creneau.
 */
function demanderRecits(lot) {
  const consigne =
    `Voici ${lot.length} trajet(s), chacun avec ses donnees deterministes deja calculees et fiables.

` +
    `${JSON.stringify(lot.map((x, i) => ({ index: i, donnees: x.payload })))}

` +
    `Pour CHAQUE trajet, produis un recit. Reponds UNIQUEMENT par un tableau JSON de ${lot.length} ` +
    `objet(s), dans le meme ordre, chacun de la forme ` +
    `{"index":<n>,"narrative":"...","advice":"...","trustScore":<0-100>}. ` +
    `Aucun texte autour, aucune balise de code.`;

  const sortie = execFileSync(
    CLI,
    ['-p', '--output-format', 'json', '--max-turns', '1', '--allowed-tools', '',
     '--model', MODELE, '--append-system-prompt', renderTripNarrativeSystem()],
    { input: consigne, encoding: 'utf8', timeout: TIMEOUT_LOT_MS, maxBuffer: 32 * 1024 * 1024 },
  );

  let texte;
  try {
    const env = JSON.parse(sortie);
    if (env.is_error) throw new Error(env.result || 'erreur CLI');
    texte = typeof env.result === 'string' ? env.result : JSON.stringify(env.result);
  } catch (e) {
    if (/OAuth|authenticate|401|revoked/i.test(sortie)) {
      throw new Error(`session Claude Code non authentifiee : ${sortie.trim().slice(0, 160)}`);
    }
    if (e && /erreur CLI/.test(e.message)) throw e;
    texte = sortie;
  }

  const m = texte.match(/\[[\s\S]*\]/);
  if (!m) return new Map();
  let brut;
  try {
    brut = JSON.parse(m[0]);
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const r of Array.isArray(brut) ? brut : []) {
    const i = Number(r && r.index);
    if (Number.isInteger(i) && i >= 0 && i < lot.length) out.set(i, assainirRecit(r));
  }
  return out;
}

// ── Ecriture ─────────────────────────────────────────────────────────────────────────

/**
 * Ecrit le recit, journalise le passage a cout ZERO (executor `local`) et conserve le couple
 * (entree, sortie). Le tout dans UNE transaction : un recit sans sa trace, ou une trace sans son
 * recit, serait un etat qu'on ne saurait pas interpreter ensuite.
 *
 * `WHERE narrative IS NULL` : deux passages concurrents ne peuvent pas s'ecraser.
 */
function ecrire(tripId, ligne, payload, recit) {
  const sql = `
    BEGIN;
    UPDATE trip_analyses
       SET narrative = ${q(recit.narrative)},
           advice = ${q(recit.advice)},
           "trustScore" = ${Math.round(recit.trustScore)},
           provider = 'local'
     WHERE "tripId" = ${q(tripId)} AND narrative IS NULL;

    INSERT INTO ai_usage_logs
      (id,"createdAt","userId","fleetId",model,action,"inputTokens","outputTokens",
       "cacheWriteTokens","cacheReadTokens","costUsd","latencyMs",ok,"resultCount",executor)
    VALUES (gen_random_uuid(), now(), NULL, ${q(ligne.fleetId)}, 'claude-code-poste',
            'trip_analysis', 0, 0, 0, 0, 0, NULL, true, 1, 'local');

    INSERT INTO ai_agent_traces
      (id,"createdAt",action,executor,model,"fleetId",input,output,"latencyMs",verdict)
    VALUES (gen_random_uuid(), now(), 'trip_analysis', 'local', 'claude-code-poste',
            ${q(ligne.fleetId)}, ${q(JSON.stringify(payload))}::jsonb,
            ${q(JSON.stringify(recit))}::jsonb, NULL, 'concluant');
    COMMIT;`;
  psql(sql, { lecture: false });
}

// ── Boucle principale ────────────────────────────────────────────────────────────────
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const debut = Date.now();
  const fin = debut + MINUTES * 60_000;
  const h = () => new Date().toISOString().slice(11, 19);

  console.log(
    `[${h()}] agent recit de trajet — lots de ${LOT}, fenetre ${HEURES} h, modele ${MODELE}, ` +
      `budget ${MINUTES} min${ESSAI ? ' (ESSAI, aucune ecriture, aucun appel)' : ''}`,
  );
  const avant = resteAFaire();
  console.log(`[${h()}] trajets recents sans recit (societes IA active) : ${avant}`);
  if (avant === 0) {
    console.log(`[${h()}] rien a faire — termine.`);
    return;
  }

  let ecrits = 0;
  let refuses = 0;
  let lotsRates = 0;

  while (Date.now() < fin) {
    const brut = trajetsANarrer(LOT);
    if (brut.length === 0) {
      console.log(`[${h()}] plus aucun trajet recent a narrer — termine.`);
      break;
    }
    const lot = brut.map((x) => ({ ...x, payload: construirePayloadRecit(x.ligne) }));

    if (ESSAI) {
      console.log(`[${h()}] ESSAI — ${lot.length} trajet(s) retenu(s), payload du premier :`);
      console.log(JSON.stringify(lot[0].payload, null, 1).split(String.fromCharCode(10)).slice(0, 22).join(String.fromCharCode(10)));
      console.log(`[${h()}] ESSAI : arret sans appel ni ecriture.`);
      return;
    }

    // Un seul appel pour tout le lot.
    let recits = new Map();
    const t0 = Date.now();
    try {
      recits = demanderRecits(lot);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/non authentifiee/i.test(msg)) {
        console.error(
          `[${h()}] ARRET : ${msg}` +
            ` — l'agent depend de la session Claude Code du poste. Ouvrir un terminal (compte` +
            ` YOUNESS, pas « en tant qu'administrateur »), lancer « claude » puis /login.`,
        );
        process.exit(3);
      }
      console.warn(`  lot abandonne : ${msg.slice(0, 140)}`);
      if (++lotsRates >= ECHECS_CONSECUTIFS_MAX) {
        console.error(`[${h()}] ${lotsRates} lots rates d'affilee — arret propre, rien de perdu.`);
        return;
      }
      await dors(BACKOFF_MS[Math.min(lotsRates - 1, BACKOFF_MS.length - 1)]);
      continue;
    }
    const secondes = Math.round((Date.now() - t0) / 1000);

    // ⚠️ On n'ecrit QUE le concluant. Un trajet absent de la reponse, ou dont le recit est vide,
    //    n'est pas ecrit : il repassera. L'ecrire condamnerait le trajet a ne jamais etre repris,
    //    puisque le pipeline considere qu'un trajet avec recit est traite.
    let ecritsLot = 0;
    for (let i = 0; i < lot.length; i++) {
      const recit = recits.get(i);
      if (!recit || !recitConcluant(recit)) {
        refuses++;
        continue;
      }
      try {
        ecrire(lot[i].tripId, lot[i].ligne, lot[i].payload, recit);
        ecrits++;
        ecritsLot++;
      } catch (e) {
        console.warn(`  ecriture refusee pour ${lot[i].tripId} : ${((e && e.message) || e).toString().slice(0, 120)}`);
        refuses++;
      }
    }

    // Un lot entierement refuse est un symptome, pas un alea : on compte, et on s'arrete si ca dure.
    if (ecritsLot === 0) {
      if (++lotsRates >= ECHECS_CONSECUTIFS_MAX) {
        console.error(`[${h()}] ${lotsRates} lots sans aucun recit retenu — arret propre.`);
        return;
      }
    } else {
      lotsRates = 0;
    }

    const reste = Math.max(0, Math.round((fin - Date.now()) / 60000));
    console.log(`[${h()}] lot de ${lot.length} en ${secondes}s : ${ecritsLot} ecrit(s) — ${ecrits} au total, ${reste} min restantes`);
    await dors(PAUSE_MS);
  }

  const apres = resteAFaire();
  console.log(`[${h()}] fini — ${ecrits} recit(s) ecrit(s), ${refuses} refuse(s). Reste ${apres} (etait ${avant}).`);
})().catch((e) => {
  console.error('ARRET sur erreur inattendue :', e && e.message ? e.message : e);
  process.exit(1);
});
