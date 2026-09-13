'use strict';
/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA PAUSE DES AGENTS DU POSTE — cote poste (T34 / D5, 2026-09-13)
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Pendant le plafond hebdomadaire de la CLI Claude (10 → 13/09), les agents ont essaye
 * trente-six fois pour rien — un passage toutes les deux heures, chacun avec son controle de
 * session, sa ligne d'echec et, pour le courrier, une tentative consommee sur un travail qui ne
 * pouvait pas aboutir — alors que la CLI annoncait l'heure de remise a zero des la premiere
 * reponse. Decision du proprietaire : « on s'arrete, un mail, et un bouton pour tout relancer ».
 *
 * La pause vit EN BASE (`pauses_agents_locaux`), pas dans un fichier du poste : c'est ce qui permet
 * au bouton « Reprendre maintenant » de /admin de la lever, et a la sentinelle du serveur de la
 * notifier par courriel. Ce module est la seule facon pour un agent de la lire et de l'ecrire ; il
 * recoit le `psql` de l'agent (une requete SQL par ssh, comme tout le reste) et ne lance rien.
 *
 * Regle partagee avec le serveur (PauseAgentsLocauxService) : une pause est ACTIVE si elle n'est
 * pas levee ET (sans echeance OU echeance a venir). Une pause perimee ne retient personne : le
 * premier appel qui reussit la leve pour de bon.
 *
 * Les colonnes `timestamp(3)` de Prisma sont en UTC : on les lit comme telles, on ecrit les
 * instants explicites en UTC (`AT TIME ZONE 'UTC'`), et `now()` comme les autres agents.
 */

const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

const FMT_PARIS = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** « 13/09 à 12:00 » en heure de Paris — celle du poste. */
function heureParis(d) {
  const c = {};
  for (const p of FMT_PARIS.formatToParts(d)) c[p.type] = p.value;
  return `${c.day}/${c.month} a ${c.hour}:${c.minute}`;
}

/** Une colonne timestamp(3) rendue par psql (« 2026-09-13 17:00:00.123 »), lue en UTC. `null` reste `null`. */
function instantUtc(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * La pause ouverte la plus recente, ou `null`. `active` dit si elle retient les agents en ce
 * moment ; `perimee` si son echeance est passee (elle attend qu'un appel reussi la leve).
 */
function lirePause(psql, maintenant = new Date()) {
  const sortie = psql(`
    SELECT row_to_json(p)::text FROM (
      SELECT id, cause, motif, "poseePar", "poseeA", jusqua
      FROM pauses_agents_locaux
      WHERE "leveeA" IS NULL
      ORDER BY "poseeA" DESC LIMIT 1
    ) p;`);
  const ligne = String(sortie || '').trim().split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!ligne) return null;
  let brut;
  try {
    brut = JSON.parse(ligne);
  } catch {
    return null;
  }
  const poseeA = instantUtc(brut.poseeA);
  const jusqua = instantUtc(brut.jusqua);
  const perimee = jusqua !== null && jusqua.getTime() <= maintenant.getTime();
  return {
    id: String(brut.id),
    cause: String(brut.cause),
    motif: String(brut.motif || ''),
    poseePar: String(brut.poseePar || ''),
    poseeA,
    jusqua,
    perimee,
    active: !perimee,
  };
}

/**
 * Pose une pause — sauf si une pause ACTIVE retient deja les agents (rien n'est empile). Rend
 * `true` si une ligne a ete ecrite. `jusqua` : une Date (reprise automatique) ou `null` (manuelle).
 */
function poserPause(psql, { cause, motif, poseePar, jusqua }) {
  if (!cause || !poseePar) throw new Error('poserPause : cause et poseePar sont obligatoires');
  const echeance = jusqua instanceof Date && !Number.isNaN(jusqua.getTime())
    ? `(${q(jusqua.toISOString())}::timestamptz AT TIME ZONE 'UTC')`
    : 'NULL';
  const sortie = psql(`
    INSERT INTO pauses_agents_locaux (id, "poseeA", cause, motif, "poseePar", jusqua)
    SELECT gen_random_uuid(), now(), ${q(cause)}, ${q(String(motif || '').slice(0, 400))}, ${q(poseePar)}, ${echeance}
    WHERE NOT EXISTS (
      SELECT 1 FROM pauses_agents_locaux
      WHERE "leveeA" IS NULL AND (jusqua IS NULL OR jusqua > now())
    )
    RETURNING id;`);
  return /[0-9a-f]{8}-[0-9a-f]{4}/i.test(String(sortie || ''));
}

/** Leve toutes les pauses ouvertes, au nom de `par` (« appel-reussi:<agent> »). */
function leverPause(psql, par) {
  psql(`UPDATE pauses_agents_locaux SET "leveeA" = now(), "leveePar" = ${q(par)} WHERE "leveeA" IS NULL;`, { lecture: false });
}

/** Ce que l'agent dit de la reprise, en une phrase lisible sans contexte. */
function texteReprise(pause) {
  return pause.jusqua
    ? `reprise prevue le ${heureParis(pause.jusqua)} (Paris), ou avant par le bouton « Reprendre maintenant » de /admin/background-tasks`
    : 'reprise MANUELLE : bouton « Reprendre maintenant » sur /admin/background-tasks';
}

/**
 * Le motif que l'agent consigne quand la pause le fait sortir. Il COMMENCE par « en pause » (la
 * sentinelle le range sous une cause commune, jamais en CRITICAL par agent) et reprend la phrase
 * d'origine : un plafond en pause reste range sous le plafond, dont la ligne est deja ouverte.
 */
function motifEnPause(pause) {
  const depuis = pause.poseeA ? ` depuis le ${heureParis(pause.poseeA)} (Paris)` : '';
  return `en pause (${pause.cause})${depuis} — ${pause.motif} — ${texteReprise(pause)}`;
}

module.exports = { lirePause, poserPause, leverPause, texteReprise, motifEnPause, heureParis, instantUtc };
