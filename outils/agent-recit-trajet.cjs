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
 * ── PÉRIMÈTRE ────────────────────────────────────────────────────────────────────────
 *
 * Seules les sociétés dont l'IA est ACTIVE (`fleets."aiEnabled"`) sont servies — la même porte
 * que l'application. Le fait que ce soit gratuit ne change pas ce à quoi un client a droit.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────
 *
 *   node outils/agent-recit-trajet.cjs [--minutes=50] [--lot=10] [--essai]
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
/** Pause entre deux récits — on ne mitraille pas sa propre session. */
let PAUSE_MS = 1500;
/** Attentes avant de rejouer un trajet refusé. */
const BACKOFF_MS = [4000, 12000, 30000];
/** Au-delà, on considère que quelque chose est cassé et on s'arrête proprement. */
const ECHECS_CONSECUTIFS_MAX = 4;
/** Temps maximum accordé à UN récit. Au-delà, on abandonne ce trajet, pas le passage. */
const TIMEOUT_RECIT_MS = 180_000;

const args = process.argv.slice(2);
const opt = (nom, defaut) => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? Number(a.split('=')[1]) : defaut;
};
const ESSAI = args.includes('--essai');
const MINUTES = opt('minutes', 50);
const LOT = opt('lot', 10);
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
 * Trajets a narrer : analyses SANS recit, dans une societe dont l'IA est active.
 *
 * Les PLUS RECENTS d'abord, volontairement : un recit sur le trajet d'hier a une chance d'etre lu,
 * un recit sur un trajet d'il y a six semaines n'en a aucune. Si l'agent ne rattrape jamais tout
 * l'historique, ce n'est pas grave — c'est meme le bon arbitrage.
 */
function trajetsANarrer(limite) {
  const sql = `
    SELECT a."tripId", row_to_json(a)::text
    FROM trip_analyses a
    JOIN vehicles v ON v.id = a."vehicleId"
    JOIN fleets  f ON f.id = v."fleetId"
    WHERE a.narrative IS NULL
      AND f."aiEnabled" = true
    ORDER BY a."updatedAt" DESC
    LIMIT ${Number(limite) || 10};`;
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
    JOIN vehicles v ON v.id = a."vehicleId"
    JOIN fleets  f ON f.id = v."fleetId"
    WHERE a.narrative IS NULL AND f."aiEnabled" = true;`;
  return Number(psql(sql).trim()) || 0;
}

// ── Le modele, via l'abonnement du poste ─────────────────────────────────────────────

/**
 * Un recit. Renvoie null si la reponse est douteuse — jamais un recit approximatif.
 *
 * `--max-turns 1` et aucun outil autorise : on veut UNE reponse a partir des donnees fournies,
 * pas un agent qui part explorer le disque. C'est aussi ce qui rend la duree previsible.
 */
function demanderRecit(payload) {
  const consigne =
    `Voici les donnees deterministes d'un trajet, deja calculees et fiables.\n\n` +
    `${JSON.stringify(payload, null, 1)}\n\n` +
    `Reponds UNIQUEMENT par un objet JSON valide conforme a ce schema, sans texte autour, ` +
    `sans balise de code :\n${JSON.stringify(TRIP_NARRATIVE_SCHEMA)}`;

  const sortie = execFileSync(
    'claude',
    ['-p', '--output-format', 'json', '--max-turns', '1', '--allowed-tools', '',
     '--append-system-prompt', renderTripNarrativeSystem()],
    { input: consigne, encoding: 'utf8', timeout: TIMEOUT_RECIT_MS, maxBuffer: 16 * 1024 * 1024 },
  );

  // La CLI rend une enveloppe JSON ; le texte du modele est dans `result`.
  let texte;
  try {
    const env = JSON.parse(sortie);
    if (env.is_error) throw new Error(env.result || 'erreur CLI');
    texte = typeof env.result === 'string' ? env.result : JSON.stringify(env.result);
  } catch (e) {
    // Reponse non enveloppee (ancienne CLI) : on tente le texte brut.
    texte = sortie;
    if (/OAuth|authenticate|401/i.test(sortie)) throw new Error(`session Claude Code non authentifiee : ${sortie.trim().slice(0, 160)}`);
    if (e && /erreur CLI/.test(e.message)) throw e;
  }

  // Le modele encadre parfois son JSON malgre la consigne : on prend le premier objet complet.
  const m = texte.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return assainirRecit(JSON.parse(m[0]));
  } catch {
    return null;
  }
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

  console.log(`[${h()}] agent recit de trajet — lots de ${LOT}, budget ${MINUTES} min${ESSAI ? ' (ESSAI, aucune ecriture, aucun appel)' : ''}`);
  const avant = resteAFaire();
  console.log(`[${h()}] trajets sans recit (societes IA active) : ${avant}`);
  if (avant === 0) {
    console.log(`[${h()}] rien a faire — termine.`);
    return;
  }

  let ecrits = 0, refuses = 0, echecs = 0;

  while (Date.now() < fin) {
    const lot = trajetsANarrer(LOT);
    if (lot.length === 0) {
      console.log(`[${h()}] plus aucun trajet a narrer — termine.`);
      break;
    }

    for (const { tripId, ligne } of lot) {
      if (Date.now() >= fin) break;
      const payload = construirePayloadRecit(ligne);

      if (ESSAI) {
        console.log(`[${h()}] ESSAI ${tripId} — payload qui serait envoye :`);
        console.log(JSON.stringify(payload, null, 1).split('\n').slice(0, 24).join('\n'));
        console.log(`[${h()}] ESSAI : arret apres un trajet.`);
        return;
      }

      let recit = null;
      for (let essai = 0; essai <= BACKOFF_MS.length; essai++) {
        try {
          recit = demanderRecit(payload);
          break;
        } catch (e) {
          const msg = (e && e.message) || String(e);
          if (/non authentifiee/i.test(msg)) {
            console.error(
              `\n[${h()}] ARRET : ${msg}\n\n` +
                `L'agent depend de la session Claude Code du poste. Ouvrir un terminal et se\n` +
                `reconnecter (commande « claude », puis /login), puis relancer.\n`,
            );
            process.exit(3);
          }
          if (essai >= BACKOFF_MS.length) {
            console.warn(`  ${tripId} abandonne : ${msg.slice(0, 140)}`);
            recit = null;
            break;
          }
          console.warn(`  reprise ${essai + 1}/${BACKOFF_MS.length} dans ${BACKOFF_MS[essai] / 1000}s : ${msg.slice(0, 100)}`);
          await dors(BACKOFF_MS[essai]);
        }
      }

      // ⚠️ On n'ecrit QUE le concluant. Un recit vide ou de trois mots condamnerait le trajet a
      //    ne jamais etre repris : le pipeline considere qu'un trajet avec recit est traite.
      if (!recit || !recitConcluant(recit)) {
        refuses++;
        if (++echecs >= ECHECS_CONSECUTIFS_MAX) {
          console.error(`[${h()}] ${echecs} refus consecutifs — arret propre, rien de perdu.`);
          return;
        }
        await dors(PAUSE_MS);
        continue;
      }
      echecs = 0;

      try {
        ecrire(tripId, ligne, payload, recit);
        ecrits++;
        const reste = Math.max(0, Math.round((fin - Date.now()) / 60000));
        console.log(`[${h()}] ${tripId} ecrit (${recit.narrative.length} car., confiance ${recit.trustScore}) — ${ecrits} au total, ${reste} min restantes`);
      } catch (e) {
        console.warn(`  ecriture refusee pour ${tripId} : ${(e && e.message ? e.message : e).toString().slice(0, 140)}`);
        refuses++;
      }
      await dors(PAUSE_MS);
    }
  }

  const apres = resteAFaire();
  console.log(`[${h()}] fini — ${ecrits} recit(s) ecrit(s), ${refuses} refuse(s). Reste ${apres} (etait ${avant}).`);
})().catch((e) => {
  console.error('ARRET sur erreur inattendue :', e && e.message ? e.message : e);
  process.exit(1);
});
