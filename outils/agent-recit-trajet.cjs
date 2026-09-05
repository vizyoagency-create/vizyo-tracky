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
 * ── PÉRIMÈTRE : TOUTES LES SOCIÉTÉS, LE COURANT PAR DÉFAUT ───────────────────────────
 *
 * Décision du 2026-09-02 : l'agent narre TOUTES les sociétés, option IA active ou non. Ce que
 * le client a le droit de VOIR est tranché à la lecture, par l'API (`fleets."aiEnabled"` :
 * option coupée = récit masqué). Découpler les deux permet d'activer l'option pour un client
 * et de lui montrer un historique déjà rédigé, au lieu d'un compteur qui repart de zéro.
 * Avant : le filtre `aiEnabled = true` ici même laissait 5 128 analyses sans récit chez les
 * sociétés dont l'option était coupée.
 *
 * Seuls les trajets RÉCENTS sont narrés par défaut — la fenêtre porte sur la date du TRAJET
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
/**
 * La CLI Claude Code passe par le module partage des agents (design/C3, point 3) : chemin du
 * binaire, verification de l'ABONNEMENT (une cle Anthropic dans l'environnement ferait facturer
 * l'API sans aucun signal), environnement nettoye, et JETONS REELS rendus avec l'identifiant
 * reel du modele — ce que cet agent ecrivait en dur (0 jeton, « claude-code-poste ») depuis le 20/08.
 */
const { verifierAbonnement, appeler, repartirUsage } = require('./cli-claude.cjs');

// ── Configuration ────────────────────────────────────────────────────────────────────
const VPS = 'root@72.62.26.240';
const CONTENEUR = 'tracky-postgres';
const BASE = { user: 'tracky', db: 'tracky_prod' };
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
      // ⚠️ ON_ERROR_STOP=1 : sans lui, psql sort en 0 MEME quand le SQL echoue. L'agent
      //    comptait alors comme ecrit ce qui ne l'etait pas — il annoncait « 1 zone
      //    enregistree » sur une table inexistante. Un agent qui se felicite d'un travail
      //    qu'il n'a pas fait est pire qu'un agent en panne : la panne, elle, se voit.
      `docker exec -i ${CONTENEUR} psql -U ${BASE.user} -d ${BASE.db} -v ON_ERROR_STOP=1 ${flags.join(' ')} -f -`],
    { input: sql, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
}

/** Echappe une chaine pour un litteral SQL. `standard_conforming_strings` est actif : seule la quote compte. */
const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

// ── Trace du PASSAGE (et pas seulement du travail ecrit) ─────────────────────────────
//
// ⚠️ POURQUOI. L'ecran de supervision deduisait l'etat de cet agent du dernier recit
// ECRIT. Il ne savait donc pas distinguer « il a tourne et n'avait rien a faire » de
// « il ne tourne plus depuis trois jours » : dans les deux cas, aucune ecriture recente.
// Le jour ou l'arriere de recits sera resorbe, l'agent en bonne sante passerait pour mort.
// Une ligne par passage, ecrite A LA FIN avec son issue reelle, tranche la question.
//
// La MEME source sert DEUX taches planifiees : le creneau nocturne (fenetre 48 h) et le
// rattrapage (--heures=9000). Une cle unique les confondrait, et l'arret de l'une se
// cacherait derriere les passages de l'autre.
const CLE_AGENT = HEURES > 200 ? 'rattrapage-recits' : 'agent-recit-trajet';
const DEMARRE_A = Date.now();
let passageSucces = false;
let passageResume = 'passage interrompu avant la fin';
let passageErreur = null;
let passageConsigne = false;

/**
 * Ecrit la trace du passage. Posee sur `process.on('exit')` : toutes les sorties sont
 * couvertes, y compris `process.exit(3)` (session Claude expiree) et l'erreur inattendue.
 * Un marqueur pose au DEMARRAGE mentirait — il dirait « passe » d'un agent mort en route.
 */
function consignerPassage() {
  if (ESSAI || passageConsigne) return;
  passageConsigne = true;
  const sql = `
    INSERT INTO passages_agents_locaux (id,agent,"demarreA","finiA","dureeMs",succes,resume,erreur)
    VALUES (gen_random_uuid(), ${q(CLE_AGENT)}, to_timestamp(${DEMARRE_A} / 1000.0), now(),
            ${Date.now() - DEMARRE_A}, ${passageSucces ? 'true' : 'false'}, ${q(passageResume)},
            ${passageErreur ? q(String(passageErreur).slice(0, 500)) : 'NULL'});`;
  try {
    psql(sql, { lecture: false });
  } catch (e) {
    // Ne JAMAIS faire echouer un passage reussi a cause de sa propre tracabilite.
    console.error(`  (passage non consigne : ${String((e && e.message) || e).slice(0, 120)})`);
  }
}
process.on('exit', consignerPassage);

/**
 * Trajets a narrer : analyses SANS recit, toutes societes, et RECENTES (fenetre).
 *
 * Les plus recents d'abord, pour que le passage suivant reprenne naturellement la ou
 * celui-ci s'est arrete. La visibilite cote client (`fleets."aiEnabled"`) n'est PAS un
 * critere ici : elle se joue a la lecture, dans l'API.
 */
function trajetsANarrer(limite) {
  const sql = `
    SELECT a."tripId", row_to_json(a)::text
    FROM trip_analyses a
    JOIN trips    t ON t.id = a."tripId"
    JOIN vehicles v ON v.id = a."vehicleId"
    JOIN fleets   f ON f.id = v."fleetId"
    WHERE a.narrative IS NULL
      AND t."startedAt" > now() - interval '${Number(HEURES) || 48} hours'
      -- ⚠️ NE PAS NARRER UN TRAJET QUI VA ETRE DETRUIT. Le recalcul supprime les trajets encore
      --    marques autrement que 'recompute' pour les re-segmenter : leur analyse, et le recit
      --    ecrit dessus, partent avec eux. Releve du 2026-08-21 : 493 recits orphelins accumules,
      --    autant de jetons depenses pour un texte que plus personne ne peut lire.
      AND t."segmentationSource" = 'recompute'
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
    WHERE a.narrative IS NULL
      AND t."startedAt" > now() - interval '${Number(HEURES) || 48} hours'
      AND t."segmentationSource" = 'recompute';`;
  return Number(psql(sql).trim()) || 0;
}

// ── Le modele, via l'abonnement du poste ─────────────────────────────────────────────

/**
 * Un appel, PLUSIEURS recits. Renvoie { recits: Map index -> recit assaini, appel } ou `appel`
 * porte ce que la CLI a REELLEMENT mesure : modele (identifiant date), jetons, cout equivalent
 * API, duree.
 *
 * Chaque invocation de la CLI renvoie son contexte complet : c'est un peage fixe, paye que l'on
 * demande un trajet ou dix. Grouper est donc la condition pour que le passage tienne dans une nuit.
 * Mesure le 2026-09-05 sur la 2.1.168 : ~28 000 jetons d'ecriture de cache par appel, quel que
 * soit le lot — c'est ce peage que les jetons reels rendent enfin visible sur la page « Couts IA ».
 *
 * `--max-turns 1` et aucun outil autorise (cf. cli-claude) : on veut UNE reponse a partir des
 * donnees fournies, pas un agent qui part explorer le disque. C'est aussi ce qui rend la duree
 * previsible.
 *
 * Un trajet dont le recit manque ou est illisible n'est PAS invente : il est simplement absent de
 * la Map, et repassera au prochain creneau. Une session invalide leve une erreur `.code = 'AUTH'`.
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

  const appel = appeler({
    system: renderTripNarrativeSystem(),
    consigne,
    modele: MODELE,
    timeoutMs: TIMEOUT_LOT_MS,
  });

  const out = new Map();
  const m = appel.texte.match(/\[[\s\S]*\]/);
  if (!m) return { recits: out, appel };
  let brut;
  try {
    brut = JSON.parse(m[0]);
  } catch {
    return { recits: out, appel };
  }
  for (const r of Array.isArray(brut) ? brut : []) {
    const i = Number(r && r.index);
    if (Number.isInteger(i) && i >= 0 && i < lot.length) out.set(i, assainirRecit(r));
  }
  return { recits: out, appel };
}

// ── Ecriture ─────────────────────────────────────────────────────────────────────────

/**
 * Ecrit le recit, journalise l'usage (executor `local`, `costUsd` 0 : c'est ce qui est facture)
 * et conserve le couple (entree, sortie). Le tout dans UNE transaction : un recit sans sa trace,
 * ou une trace sans son recit, serait un etat qu'on ne saurait pas interpreter ensuite.
 *
 * `trace` porte les chiffres REELS de l'appel (design/C3, point 3) : le modele tel que la CLI le
 * nomme et la PART de jetons de ce recit. Un lot est un seul appel, mais chaque recit garde sa
 * ligne — un lot melange des societes, et `fleetId` est ce que la page « Couts IA » ventile. Les
 * jetons de l'appel sont donc repartis a parts egales entre les recits ecrits du lot
 * (`repartirUsage`) ; la somme des lignes est exactement l'appel, `resultCount` vaut 1 par ligne,
 * et `latencyMs` porte la duree de l'appel entier (c'est bien ce que ce recit a attendu). Le cout
 * equivalent API se recalcule a la lecture, a partir de ces jetons et de la grille.
 *
 * `WHERE narrative IS NULL` : deux passages concurrents ne peuvent pas s'ecraser.
 */
function ecrire(tripId, ligne, payload, recit, trace) {
  const u = trace.usage;
  const sql = `
    BEGIN;
    UPDATE trip_analyses
       SET narrative = ${q(recit.narrative)},
           advice = ${q(recit.advice)},
           "trustScore" = ${Math.round(recit.trustScore)},
           provider = 'local',
           -- ⚠️ EXPLICITE, et ce n'est pas une precaution de style. L'annotation updatedAt de
           --    Prisma est appliquee par le CLIENT, pas par la base : un UPDATE en SQL brut ne
           --    la declenche pas. Or l'ecran des taches de fond deduit l'etat de cet agent du
           --    plus recent updatedAt de ses lignes. Sans cela, l'horodatage n'avancait jamais
           --    et la supervision affichait un agent a l'arret pendant qu'il travaillait —
           --    exactement le mensonge que le principe « etat deduit du travail reellement
           --    ecrit » doit empecher. Constate le 20/08 : 15 recits ecrits a 04:59, dates 04:45.
           "updatedAt" = now(),
           -- Date du TEXTE, distincte de celle des chiffres (computedAt). Un recalcul de
           -- l'analyse remplace les mesures et conserve le recit : sans cette date, rien ne
           -- permettait de dire que le texte affiche decrivait un etat anterieur.
           "narratedAt" = now()
     WHERE "tripId" = ${q(tripId)} AND narrative IS NULL;

    INSERT INTO ai_usage_logs
      (id,"createdAt","userId","fleetId",model,action,"inputTokens","outputTokens",
       "cacheWriteTokens","cacheReadTokens","costUsd","latencyMs",ok,"resultCount",executor)
    VALUES (gen_random_uuid(), now(), NULL, ${q(ligne.fleetId)}, ${q(trace.modele)},
            'trip_analysis', ${u.inputTokens}, ${u.outputTokens}, ${u.cacheWriteTokens}, ${u.cacheReadTokens},
            0, ${Number.isFinite(trace.latencyMs) && trace.latencyMs > 0 ? Math.round(trace.latencyMs) : 'NULL'}, true, 1, 'local');

    INSERT INTO ai_agent_traces
      (id,"createdAt",action,executor,model,"fleetId",input,output,"latencyMs",verdict)
    VALUES (gen_random_uuid(), now(), 'trip_analysis', 'local', ${q(trace.modele)},
            ${q(ligne.fleetId)}, ${q(JSON.stringify(payload))}::jsonb,
            ${q(JSON.stringify(recit))}::jsonb,
            ${Number.isFinite(trace.latencyMs) && trace.latencyMs > 0 ? Math.round(trace.latencyMs) : 'NULL'}, 'concluant');
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
  console.log(`[${h()}] trajets recents sans recit (toutes societes) : ${avant}`);
  if (avant === 0) {
    // ⚠️ « Rien a faire » est un passage REUSSI (design/C3, point 3). Ce `return` sortait avant
    //    que `passageSucces` soit pose, et le journal consignait un ECHEC chaque nuit sans trajet
    //    recent : la supervision ne pouvait plus distinguer l'agent qui n'avait rien a narrer de
    //    l'agent en panne. C'est le prealable a toute alerte fondee sur `succes`.
    passageSucces = true;
    passageResume = 'rien a faire : aucun trajet recent sans recit';
    console.log(`[${h()}] rien a faire — termine.`);
    return;
  }

  /**
   * ⚠️ AVANT le premier appel. Une cle Anthropic dans l'environnement ou une session hors
   * claude.ai ferait facturer l'API sans aucun signal — le « cout 0 » de cet agent etait une
   * hypothese. Un refus est un passage en ECHEC explicite (code 3, comme la session expiree) :
   * la supervision doit le lire, pas le deviner d'un compteur qui n'avance plus.
   */
  if (!ESSAI) {
    const abonnement = verifierAbonnement();
    if (!abonnement.ok) {
      passageErreur = `CLI hors abonnement : ${abonnement.motif}`;
      passageResume = 'passage refuse : CLI hors abonnement (aucun appel, aucune ecriture)';
      console.error(`[${h()}] ARRET : ${passageErreur}`);
      process.exit(3);
    }
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
    let appel = null;
    const t0 = Date.now();
    try {
      ({ recits, appel } = demanderRecits(lot));
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (e && e.code === 'AUTH') {
        passageErreur = msg;
        passageResume = 'session Claude Code du poste expiree';
        console.error(
          `[${h()}] ARRET : ${msg}` +
            ` — l'agent depend de la session Claude Code du poste. Ouvrir un terminal (compte` +
            ` YOUNESS, pas « en tant qu'administrateur »), lancer « claude » puis /login.`,
        );
        process.exit(3);
      }
      console.warn(`  lot abandonne : ${msg.slice(0, 140)}`);
      if (++lotsRates >= ECHECS_CONSECUTIFS_MAX) {
        passageErreur = msg;
        passageResume = `${lotsRates} lots rates d'affilee — arret apres ${ecrits} recit(s)`;
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
    //
    // Les jetons de l'appel sont partages entre les recits CONCLUANTS du lot (cf. `ecrire`). La
    // part d'un recit dont l'ecriture est refusee est perdue — au plus 1/n de l'appel, et le cas
    // (recit deja ecrit par un passage concurrent) est rare : on prefere une somme legerement
    // sous-estimee a une ligne d'usage sans recit.
    const concluants = [];
    for (let i = 0; i < lot.length; i++) {
      const recit = recits.get(i);
      if (recit && recitConcluant(recit)) concluants.push(i);
      else refuses++;
    }
    const parts = repartirUsage(appel.usage, concluants.length);
    let ecritsLot = 0;
    for (let k = 0; k < concluants.length; k++) {
      const i = concluants[k];
      try {
        ecrire(lot[i].tripId, lot[i].ligne, lot[i].payload, recits.get(i), {
          modele: appel.modele,
          usage: parts[k],
          latencyMs: appel.dureeMs,
        });
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
        passageResume = `${lotsRates} lots sans aucun recit retenu — arret apres ${ecrits} recit(s)`;
        passageErreur = 'aucun recit concluant sur les derniers lots';
        console.error(`[${h()}] ${lotsRates} lots sans aucun recit retenu — arret propre.`);
        return;
      }
    } else {
      lotsRates = 0;
    }

    const reste = Math.max(0, Math.round((fin - Date.now()) / 60000));
    const j = appel.usage;
    console.log(
      `[${h()}] lot de ${lot.length} en ${secondes}s : ${ecritsLot} ecrit(s) — ${ecrits} au total, ${reste} min restantes` +
        ` — ${appel.modele}, ${j.inputTokens + j.cacheWriteTokens + j.cacheReadTokens} jetons entree / ${j.outputTokens} sortie,` +
        ` equivalent API ${appel.coutEquivalentUsd.toFixed(4)} $ (absorbe)`,
    );
    await dors(PAUSE_MS);
  }

  const apres = resteAFaire();
  console.log(`[${h()}] fini — ${ecrits} recit(s) ecrit(s), ${refuses} refuse(s). Reste ${apres} (etait ${avant}).`);
  // Passage mene a son terme : c'est CE cas, et lui seul, qui vaut un succes.
  passageSucces = true;
  passageResume = `${ecrits} recit(s) ecrit(s), ${refuses} refuse(s), reste ${apres}`;
})().catch((e) => {
  const msg = e && e.message ? e.message : String(e);
  passageErreur = msg;
  passageResume = 'arret sur erreur inattendue';
  console.error('ARRET sur erreur inattendue :', msg);
  process.exit(1);
});
