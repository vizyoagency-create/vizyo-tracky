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
 * ── CE QUI A CHANGE LE 2026-09-05 (design/C3, points 3 et 6) ─────────────────────────
 *
 *   — L'abonnement est VERIFIE avant de prendre quoi que ce soit (`cli-claude.verifierAbonnement`) :
 *     une cle Anthropic dans l'environnement ou une session hors claude.ai = passage refuse, journalise
 *     en echec explicite, code de sortie 2. Le « cout 0 » etait une hypothese ; c'est une garantie.
 *   — Les JETONS REELS, l'identifiant REEL du modele, le cout equivalent API et la duree sont ranges
 *     dans `resultat` avec la reponse. Le courrier n'ecrit PLUS RIEN dans `ai_usage_logs` : c'est le
 *     consommateur serveur qui trace l'usage a partir de ces chiffres (AM-023 : 20 lignes en doublon
 *     courrier + serveur relevees le 2026-09-05).
 *   — Plafond de tentatives applique ICI aussi (AM-005) : ne prend que `tentatives < 3`, ne reprend
 *     jamais dans le meme passage un travail qu'il vient de reposer, passe lui-meme en `echec` a la
 *     3e tentative, et s'arrete apres 4 echecs consecutifs. Releve du 2026-09-05 : 5 travaux
 *     `analyse-lieu` avaient ete repris 76 a 1 330 fois depuis le 27/08, l'abonnement brule en boucle.
 *   — Le motif conserve dans `erreur` vient de la SORTIE de la CLI (stderr), jamais de la ligne de
 *     commande — `execFileSync` y range le prompt systeme entier.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────
 *
 *   node outils/agent-courrier-ia.cjs [--minutes=30] [--modele=sonnet] [--essai]
 *
 *   --essai   ne prend RIEN et n'appelle PAS le modele : montre la file et le prochain travail.
 */

const { execFileSync } = require('node:child_process');
const { verifierAbonnement, appeler } = require('./cli-claude.cjs');

// ── Configuration ────────────────────────────────────────────────────────────────────
const VPS = 'root@72.62.26.240';
const CONTENEUR = 'tracky-postgres';
const BASE = { user: 'tracky', db: 'tracky_prod' };
/** Un travail (rapport 8-12k jetons d'entree) peut etre long : marge large. */
const TIMEOUT_TRAVAIL_MS = 8 * 60 * 1000;
/**
 * Plafond de tentatives — la MEME valeur que `TENTATIVES_MAX` cote serveur
 * (apps/api/src/travaux-ia/travaux-ia.service.ts). Le serveur acte aussi l'echec des `a-faire`
 * arrives a ce plafond : les deux bords se completent, aucun ne compte sur l'autre.
 */
const TENTATIVES_MAX = 3;
/** Au-dela, quelque chose est casse (session, reseau, modele) : on s'arrete proprement, comme l'agent de recits. */
const ECHECS_CONSECUTIFS_MAX = 4;

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
 *
 * `tentatives < 3` : un travail arrive au plafond n'est plus pour nous (le serveur l'acte en echec).
 * `id <> ALL(exclus)` : un travail repose DANS CE PASSAGE n'est pas repris deux minutes plus tard —
 * il etait en tete de file (tri `creeA ASC`), il y reviendrait a chaque tour et consommerait ses
 * trois tentatives en un seul passage sans que rien ait change entre-temps.
 * Le RETURNING rend `tentatives` APRES increment : c'est ce compteur qui decide, a l'echec, entre
 * reposer et acter.
 */
function prendreUnTravail(exclus) {
  const tableau = exclus.length ? `ARRAY[${exclus.map(q).join(',')}]::uuid[]` : 'ARRAY[]::uuid[]';
  const sql = `
    UPDATE travaux_ia_locaux SET statut='pris', "prisA"=now(), tentatives=tentatives+1
    WHERE id = (
      SELECT id FROM travaux_ia_locaux
      WHERE statut='a-faire' AND tentatives < ${TENTATIVES_MAX} AND id <> ALL(${tableau})
      ORDER BY "creeA" ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id::text || '|' || type || '|' || tentatives::text || '|' || encode(convert_to(payload::text,'UTF8'),'base64');`;
  /**
   * ⚠️ LE TAG DE COMMANDE (« UPDATE 1 ») SUIT LA DONNEE dans la sortie psql — et les
   * caracteres U-P-D-A-T-E et le chiffre appartiennent a l'ALPHABET BASE64. Quand le
   * payload encode tombe sur une longueur SANS padding « = », Node decode le tag en
   * octets parasites colles au JSON : « Unexpected non-whitespace character after JSON
   * at position N ». Mesure le 2026-08-23 : l'analyse de Toulouse (1 945 octets, pas de
   * padding) plantait, celle d'Auchan (padding « = », qui stoppe le decodeur) passait.
   * Un bogue dependant de la taille du payload modulo 3 — on retire donc les lignes de
   * tag AVANT tout decodage. Le filtre recolle aussi le base64 que psql replie a 76
   * colonnes.
   */
  const ligne = psql(sql)
    .split(/\r?\n/)
    .filter((l) => !/^[A-Z]+ \d+$/.test(l.trim()))
    .join('')
    .trim();
  if (!ligne) return null;
  const parts = ligne.split('|');
  /**
   * ⚠️ UNE SORTIE NON VIDE NE PROUVE PAS QU'UN TRAVAIL A ETE PRIS.
   *
   * Quand le `RETURNING` ne ramene aucune ligne, psql rend le TAG de commande (« UPDATE 0 »).
   * L'ancien code le decoupait quand meme : `b64` valait undefined, `Buffer.from(undefined)`
   * levait, et l'agent PLANTAIT — a la fin de chaque passage REUSSI, au moment ou la file se
   * vide. Consequence mesuree le 2026-08-21 : le rapport etait bien livre, mais le passage
   * n'etait jamais journalise, donc l'ecran de supervision annonçait « jamais lance » un agent
   * qui venait de travailler. Exactement l'agent invisible qu'on traque depuis deux jours.
   */
  if (parts.length !== 4) return null;
  const [id, type, tentativesTexte, b64] = parts;
  const tentatives = Number(tentativesTexte) || 0;
  /**
   * ⚠️ LA LIGNE EST DEJA MARQUEE `pris` A CE STADE. Un payload illisible doit donc etre
   * REPOSE avant de lever — sinon le travail reste orphelin : aucun passage ne reprend
   * une ligne `pris`. Paye le 2026-08-23 (analyse de lieu de Toulouse) : le crash de
   * decodage laissait la ligne en `pris`, et le resume du passage comptait « repose »
   * un travail qui ne l'etait pas. Au plafond, on ACTE : un payload illisible ne le
   * deviendra pas au passage suivant.
   */
  try {
    return { id, type, tentatives, payload: JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) };
  } catch (e) {
    const motif = e instanceof Error ? e.message : String(e);
    // Repose dans TOUS les cas, plafond compris : `tentatives < 3` empeche toute reprise, et c'est
    // le SERVEUR qui actera l'echec (`reprendrePerimes`) — la seule transition qui alerte.
    reposer(id, `payload illisible au decodage : ${motif}`);
    throw new Error(`travail ${id.slice(0, 8)} repose${tentatives >= TENTATIVES_MAX ? ' (plafond atteint : le serveur l\'actera en echec)' : ''} — payload illisible (${motif})`);
  }
}

/**
 * La reponse du modele part en base64 : aucun echappement SQL a negocier.
 * `resultat` porte, a cote du contenu, ce que le SERVEUR ecrira dans `ai_usage_logs` : le modele
 * REEL (identifiant date rendu par la CLI, pas l'alias « sonnet »), les jetons reels, le cout
 * equivalent API et la duree. Le courrier ne trace rien lui-meme : une seule ecriture par travail.
 */
function livrer(id, reponse) {
  const resultat = Buffer.from(JSON.stringify({
    contenu: reponse.contenu,
    modele: reponse.modele,
    usage: reponse.usage,
    coutEquivalentUsd: reponse.coutEquivalentUsd,
    dureeMs: reponse.dureeMs,
  }), 'utf8').toString('base64');
  psql(
    `UPDATE travaux_ia_locaux
     SET statut='fait', "finiA"=now(),
         resultat = convert_from(decode(${q(resultat)},'base64'),'UTF8')::jsonb
     WHERE id=${q(id)} AND statut='pris';`,
    { lecture: false },
  );
}

/** Remet en file avec le motif : le serveur ou le prochain passage retentera. */
function reposer(id, erreur) {
  psql(
    `UPDATE travaux_ia_locaux SET statut='a-faire', "prisA"=NULL, erreur=${q(String(erreur).slice(-400))}
     WHERE id=${q(id)} AND statut='pris';`,
    { lecture: false },
  );
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
 * UNE reponse a partir des donnees fournies (`--max-turns 1`, aucun outil — cf. cli-claude). Le
 * schema JSON du travail est joint a la consigne — c'est le SERVEUR qui l'a choisi, le courrier ne
 * fait que le transmettre. `maxTokens` vient aussi du travail : le producteur sait ce qu'il attend
 * (900 pour un lieu, 16 000 pour un rapport), le courrier non.
 */
function appelerModele(travail) {
  const p = travail.payload;
  const consigne =
    `Voici les donnees d'entree :\n\n${JSON.stringify(p.userPayload)}\n\n` +
    `Reponds UNIQUEMENT par un objet JSON conforme a ce schema (aucun texte autour, aucune balise de code) :\n` +
    `${JSON.stringify(p.schema)}`;

  const reponse = appeler({
    system: String(p.system ?? ''),
    consigne,
    modele: MODELE,
    maxTokens: p.maxTokens,
    timeoutMs: TIMEOUT_TRAVAIL_MS,
  });

  const m = reponse.texte.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`reponse sans objet JSON (${reponse.texte.slice(0, 120)})`);
  // JSON illisible => throw => le travail est repose, pas invente.
  return { ...reponse, contenu: JSON.parse(m[0]) };
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
    const apercu = psql(`SELECT type || ' cree ' || "creeA"::timestamp(0) || ' (tentatives ' || tentatives || ')' FROM travaux_ia_locaux WHERE statut='a-faire' AND tentatives < ${TENTATIVES_MAX} ORDER BY "creeA" LIMIT 3;`).trim();
    console.log(apercu ? `[${h()}] prochains : ${apercu.split('\n').join(' | ')}` : `[${h()}] rien a prendre.`);
    return;
  }

  /**
   * ⚠️ AVANT de prendre le moindre travail. Prendre puis decouvrir que la CLI est hors
   * abonnement, c'est deja une tentative consommee pour rien — et, pire, un appel qui aurait pu
   * partir sur l'API facturee. Un refus est un passage en ECHEC, dit tel quel : la supervision
   * doit le voir, pas le deviner d'une file qui n'avance plus.
   */
  const abonnement = verifierAbonnement();
  if (!abonnement.ok) {
    const erreur = `CLI hors abonnement : ${abonnement.motif}`;
    console.error(`[${h()}] REFUS — ${erreur} — aucun travail pris.`);
    journaliserPassage(demarreA, false, '0 travail pris — CLI hors abonnement, passage refuse', erreur);
    process.exit(2);
  }

  let faits = 0, reposes = 0, actes = 0;
  let derniereErreur = null;
  let echecsConsecutifs = 0;
  /** Les travaux reposes ou actes DANS CE PASSAGE : jamais repris avant le prochain. */
  const exclus = [];
  /**
   * `finally` : le passage est journalise MEME sur une panne imprevue. Un agent qui meurt sans
   * laisser de trace est un agent invisible — et l'ecran, faute de mieux, rassure a tort.
   */
  try {
  while (Date.now() < fin) {
    const travail = prendreUnTravail(exclus);
    if (!travail) break; // file vide : on ne tourne pas a vide, la tache est un no-op
    const t0 = Date.now();
    try {
      const reponse = appelerModele(travail);
      livrer(travail.id, reponse);
      faits++;
      echecsConsecutifs = 0;
      const j = reponse.usage;
      console.log(
        `[${h()}] ${travail.type} livre en ${((Date.now() - t0) / 1000).toFixed(0)}s (${travail.id.slice(0, 8)}) — ` +
          `${reponse.modele}, ${j.inputTokens + j.cacheWriteTokens + j.cacheReadTokens} jetons entree / ${j.outputTokens} sortie, ` +
          `equivalent API ${reponse.coutEquivalentUsd.toFixed(4)} $ (absorbe par l'abonnement)`,
      );
    } catch (e) {
      derniereErreur = e;
      const motif = e instanceof Error ? e.message : String(e);
      exclus.push(travail.id);
      if (travail.tentatives >= TENTATIVES_MAX) {
        // 3e tentative sans livraison : on ne s'acharne pas (les 5 travaux morts du 27/08 avaient
        // ete repris jusqu'a 1 330 fois avant que quelqu'un ne les voie). Le travail est REPOSE
        // avec son motif, pas acte ici : `tentatives < 3` garantit qu'aucun courrier ne le
        // reprendra, et c'est le SERVEUR qui l'actera en `echec` (`reprendrePerimes`, branche
        // « plafonnes ») — la seule transition qui ecrit l'alerte et la ligne d'usage `ok=false`.
        // Un `echec` pose d'ici n'entrait dans aucun de ses filtres : invisible (revue C3).
        reposer(travail.id, motif);
        actes++;
        console.warn(`[${h()}] ${travail.type} au PLAFOND apres ${travail.tentatives} tentatives (${travail.id.slice(0, 8)}) : repose, le serveur l'actera en echec — ${motif.slice(0, 140)}`);
      } else {
        reposer(travail.id, motif);
        reposes++;
        console.warn(`[${h()}] ${travail.type} repose (tentative ${travail.tentatives}/${TENTATIVES_MAX}, ${travail.id.slice(0, 8)}) : ${motif.slice(0, 140)}`);
      }
      // Session non authentifiee : inutile d'insister, tous les travaux echoueraient pareil.
      if (e && e.code === 'AUTH') {
        console.error(`[${h()}] ARRET : session Claude Code du poste invalide — ouvrir un terminal (compte YOUNESS), lancer « claude » puis /login.`);
        process.exitCode = 2;
        break;
      }
      if (++echecsConsecutifs >= ECHECS_CONSECUTIFS_MAX) {
        console.error(`[${h()}] ${echecsConsecutifs} echecs d'affilee — arret propre, le reste attendra le prochain passage.`);
        break;
      }
    }
  }

  } catch (e) {
    derniereErreur = e;
    console.error(`[${h()}] ARRET sur erreur inattendue : ${e && e.message ? e.message : e}`);
  } finally {
    const resume = `${faits} travail(aux) livre(s), ${reposes} repose(s), ${actes} acte(s) en echec`;
    console.log(`[${h()}] fini — ${resume}`);
    // Une file vide est un passage REUSSI : « rien a faire » n'est pas une panne.
    journaliserPassage(demarreA, derniereErreur === null, resume, derniereErreur);
  }
})().catch((e) => {
  console.error('ARRET :', e && e.message ? e.message : e);
  process.exit(1);
});
