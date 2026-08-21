#!/usr/bin/env node
/**
 * Agent COURRIER IA — tourne sur le poste, pas sur le VPS (design/C1-TRAVAUX-IA-LOCAUX.md).
 *
 * ── CE QU'IL EST, ET SURTOUT CE QU'IL N'EST PAS ──────────────────────────────────────
 *
 * Le serveur prepare des travaux complets (prompt systeme, schema JSON, donnees) dans la table
 * `travaux_ia_locaux`. Cet agent les prend un par un, appelle le modele via l'abonnement Claude
 * Code du poste, et ecrit la reponse BRUTE dans `resultat`. C'est tout.
 *
 * Il ne connait AUCUN metier : pas de notion de « rapport » ni de « lieu ». La validation et la
 * persistance restent les fonctions serveur existantes — une reponse malformee sera rejetee
 * la-bas, exactement comme du temps de l'API. Ajouter un futur type de travail ne demande AUCUNE
 * modification ici : c'est la garantie structurelle contre la divergence, source des trois jours
 * d'incidents qui precedent ce fichier (recits orphelins, analyses inventees, limites fantomes).
 *
 * Aucun credit d'API : le travail passe par l'abonnement du poste (executor `local`, cout 0).
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────
 *
 *   node outils/agent-courrier-ia.cjs [--minutes=30] [--modele=sonnet] [--essai]
 *
 *   --essai   ne prend RIEN et n'appelle PAS le modele : montre la file et le prochain travail.
 */

const { execFileSync } = require('node:child_process');

// ── Configuration ────────────────────────────────────────────────────────────────────
const VPS = 'root@72.62.26.240';
const CONTENEUR = 'tracky-postgres';
const BASE = { user: 'tracky', db: 'tracky_prod' };
/**
 * Le BINAIRE de la CLI — meme piege que l'agent de recits : sous Windows, `claude` est un
 * script que Node refuse de lancer sans shell, et un shell obligerait a echapper le prompt.
 */
const CLI = process.platform === 'win32'
  ? 'C:/Program Files/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
  : 'claude';
/** Un travail (rapport 8-12k jetons d'entree) peut etre long : marge large. */
const TIMEOUT_TRAVAIL_MS = 8 * 60 * 1000;
/** L'action tracee dans les couts IA, par type de travail. */
const ACTION_PAR_TYPE = { 'rapport-activite': 'activity_report', 'analyse-lieu': 'place_analysis' };

const args = process.argv.slice(2);
const opt = (nom, defaut) => {
  const a = args.find((x) => x.startsWith(`--${nom}=`));
  return a ? a.split('=')[1] : defaut;
};
const ESSAI = args.includes('--essai');
const MINUTES = Number(opt('minutes', 30));
const MODELE = String(opt('modele', 'sonnet'));

// ── Base, via SSH ────────────────────────────────────────────────────────────────────
function psql(sql, { lecture = true } = {}) {
  const flags = lecture ? '-t -A' : '-q';
  return execFileSync(
    'ssh',
    ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', VPS,
      `docker exec -i ${CONTENEUR} psql -U ${BASE.user} -d ${BASE.db} ${flags} -f -`],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Prend UN travail, atomiquement : `FOR UPDATE SKIP LOCKED` — deux courriers concurrents (un
 * passage planifie plus un lancement manuel) ne prendront jamais la meme ligne.
 */
function prendreUnTravail() {
  const sql = `
    UPDATE travaux_ia_locaux SET statut='pris', "prisA"=now(), tentatives=tentatives+1
    WHERE id = (
      SELECT id FROM travaux_ia_locaux WHERE statut='a-faire'
      ORDER BY "creeA" ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id::text || '|' || type || '|' || encode(convert_to(payload::text,'UTF8'),'base64');`;
  const ligne = psql(sql).trim();
  if (!ligne) return null;
  const [id, type, b64] = ligne.split('|');
  return { id, type, payload: JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) };
}

/** La reponse du modele part en base64 : aucun echappement SQL a negocier. */
function livrer(id, contenu, modele) {
  const resultat = Buffer.from(JSON.stringify({ contenu, modele }), 'utf8').toString('base64');
  psql(
    `UPDATE travaux_ia_locaux
     SET statut='fait', "finiA"=now(),
         resultat = convert_from(decode(${q(resultat)},'base64'),'UTF8')::jsonb
     WHERE id=${q(id)} AND statut='pris';`,
    { lecture: false },
  );
}

function reposer(id, erreur) {
  psql(
    `UPDATE travaux_ia_locaux SET statut='a-faire', "prisA"=NULL, erreur=${q(String(erreur).slice(0, 400))}
     WHERE id=${q(id)} AND statut='pris';`,
    { lecture: false },
  );
}

/** Trace de cout : meme table que l'API, executor `local`, cout 0 — absorbe par l'abonnement. */
function tracerCout(type, modele) {
  const action = ACTION_PAR_TYPE[type] ?? type;
  psql(
    `INSERT INTO ai_usage_logs (id, action, model, executor, "inputTokens", "outputTokens",
       "cacheWriteTokens", "cacheReadTokens", "costUsd", "latencyMs", ok, "createdAt")
     VALUES (gen_random_uuid(), ${q(action)}, ${q(modele)}, 'local', 0, 0, 0, 0, 0, 0, true, now());`,
    { lecture: false },
  ).trim();
}

/** Journal des passages : l'ecran de supervision lit le TRAVAIL, pas une promesse. */
function journaliserPassage(demarreA, succes, resume, erreur) {
  try {
    psql(
      `INSERT INTO passages_agents_locaux (id, agent, "demarreA", "finiA", "dureeMs", succes, resume, erreur)
       VALUES (gen_random_uuid(), 'agent-courrier-ia', to_timestamp(${demarreA} / 1000.0), now(),
               ${Date.now() - demarreA}, ${succes ? 'true' : 'false'}, ${q(resume)},
               ${erreur ? q(String(erreur).slice(0, 500)) : 'NULL'});`,
      { lecture: false },
    );
  } catch (e) {
    console.warn(`  (passage non consigne : ${String(e).slice(0, 120)})`);
  }
}

// ── L'appel modele ───────────────────────────────────────────────────────────────────
/**
 * `--max-turns 1`, aucun outil : UNE reponse a partir des donnees fournies, pas un agent qui
 * explore le disque. Le schema JSON du travail est joint a la consigne — c'est le SERVEUR qui
 * l'a choisi, le courrier ne fait que le transmettre.
 */
function appelerModele(travail) {
  const p = travail.payload;
  const consigne =
    `Voici les donnees d'entree :\n\n${JSON.stringify(p.userPayload)}\n\n` +
    `Reponds UNIQUEMENT par un objet JSON conforme a ce schema (aucun texte autour, aucune balise de code) :\n` +
    `${JSON.stringify(p.schema)}`;

  const sortie = execFileSync(
    CLI,
    ['-p', '--output-format', 'json', '--max-turns', '1', '--allowed-tools', '',
     '--model', MODELE, '--append-system-prompt', String(p.system ?? '')],
    { input: consigne, encoding: 'utf8', timeout: TIMEOUT_TRAVAIL_MS, maxBuffer: 32 * 1024 * 1024 },
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

  const m = texte.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`reponse sans objet JSON (${texte.slice(0, 120)})`);
  return JSON.parse(m[0]); // JSON illisible => throw => le travail est repose, pas invente
}

// ── Boucle ───────────────────────────────────────────────────────────────────────────
(async () => {
  const demarreA = Date.now();
  const fin = demarreA + MINUTES * 60_000;
  const h = () => new Date().toISOString().slice(11, 19);

  const etat = psql(`SELECT statut || ':' || count(*) FROM travaux_ia_locaux GROUP BY statut;`)
    .trim().split('\n').filter(Boolean).join(' · ') || 'file vide';
  console.log(`[${h()}] courrier IA — modele ${MODELE}, budget ${MINUTES} min — file : ${etat}${ESSAI ? ' (ESSAI)' : ''}`);

  if (ESSAI) {
    const apercu = psql(`SELECT type || ' cree ' || "creeA"::timestamp(0) FROM travaux_ia_locaux WHERE statut='a-faire' ORDER BY "creeA" LIMIT 3;`).trim();
    console.log(apercu ? `[${h()}] prochains : ${apercu.split('\n').join(' | ')}` : `[${h()}] rien a prendre.`);
    return;
  }

  let faits = 0, erreurs = 0;
  let derniereErreur = null;
  while (Date.now() < fin) {
    const travail = prendreUnTravail();
    if (!travail) break; // file vide : on ne tourne pas a vide, la tache est un no-op
    const t0 = Date.now();
    try {
      const contenu = appelerModele(travail);
      livrer(travail.id, contenu, MODELE);
      tracerCout(travail.type, MODELE);
      faits++;
      console.log(`[${h()}] ${travail.type} livre en ${((Date.now() - t0) / 1000).toFixed(0)}s (${travail.id.slice(0, 8)})`);
    } catch (e) {
      erreurs++;
      derniereErreur = e;
      reposer(travail.id, e instanceof Error ? e.message : String(e));
      console.warn(`[${h()}] ${travail.type} repose : ${String(e).slice(0, 140)}`);
      // Session non authentifiee : inutile d'insister, tous les travaux echoueraient pareil.
      if (/non authentifiee/.test(String(e))) break;
    }
  }

  const resume = `${faits} travail(aux) livre(s), ${erreurs} repose(s)`;
  console.log(`[${h()}] fini — ${resume}`);
  journaliserPassage(demarreA, erreurs === 0 || faits > 0, resume, derniereErreur);
})().catch((e) => {
  console.error('ARRET sur erreur inattendue :', e && e.message ? e.message : e);
  process.exit(1);
});
