'use strict';
/**
 * Jeux d'essai de `pause-agents.cjs` — SANS base : un `psql` factice rend des lignes et garde le SQL.
 *
 *   node --test outils/pause-agents.test.cjs
 *
 * Ce qu'ils protegent (T34 / D5) : la regle « active = ouverte ET (sans echeance OU a venir) »,
 * identique a celle du serveur ; une pause perimee qui ne retient personne ; une pose qui
 * n'empile jamais ; et un motif de sortie qui commence par « en pause » et garde la phrase de
 * la CLI — c'est ce que la sentinelle lit.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const pa = require('./pause-agents.cjs');

const NOW = new Date('2026-09-13T17:00:00.000Z');
const LIGNE = {
  id: '0f2b0f8c-1d2e-4c3a-9b1f-000000000001',
  cause: 'plafond-hebdo',
  motif: "You've hit your weekly limit · resets Sep 20, 12pm (Europe/Paris)",
  poseePar: 'rattrapage-recits',
  poseeA: '2026-09-13 16:30:00.123',
  jusqua: '2026-09-20 10:00:00',
};

function faussePsql(lignes) {
  const appels = [];
  const psql = (sql, opts) => {
    appels.push({ sql, opts });
    return lignes.map((l) => JSON.stringify(l)).join('\n');
  };
  psql.appels = appels;
  return psql;
}

test('lirePause : aucune ligne → null ; une ligne a venir → active, dates lues en UTC', () => {
  assert.equal(pa.lirePause(faussePsql([]), NOW), null);
  const p = pa.lirePause(faussePsql([LIGNE]), NOW);
  assert.equal(p.active, true);
  assert.equal(p.perimee, false);
  assert.equal(p.cause, 'plafond-hebdo');
  assert.equal(p.poseeA.toISOString(), '2026-09-13T16:30:00.123Z');
  assert.equal(p.jusqua.toISOString(), '2026-09-20T10:00:00.000Z');
});

test('⚠️ lirePause : une echeance passee → perimee, PAS active — elle ne retient personne', () => {
  const p = pa.lirePause(faussePsql([{ ...LIGNE, jusqua: '2026-09-13 10:00:00' }]), NOW);
  assert.equal(p.active, false);
  assert.equal(p.perimee, true);
});

test('lirePause : sans echeance (reprise manuelle) → active tant que personne ne la leve', () => {
  const p = pa.lirePause(faussePsql([{ ...LIGNE, cause: 'echecs-consecutifs', jusqua: null }]), NOW);
  assert.equal(p.active, true);
  assert.equal(p.jusqua, null);
});

test('lirePause : la requete ne prend que les lignes ouvertes, la plus recente, en JSON (un motif peut contenir « | »)', () => {
  const psql = faussePsql([]);
  pa.lirePause(psql, NOW);
  assert.match(psql.appels[0].sql, /"leveeA" IS NULL/);
  assert.match(psql.appels[0].sql, /ORDER BY "poseeA" DESC LIMIT 1/);
  assert.match(psql.appels[0].sql, /row_to_json/);
});

test('poserPause : l echeance part en UTC explicite, la pose est refusee par SQL si une pause active existe', () => {
  const psql = faussePsql([]);
  psql.appels.length = 0;
  const ecrit = pa.poserPause(psql, { cause: 'plafond-hebdo', motif: LIGNE.motif, poseePar: 'rattrapage-recits', jusqua: new Date('2026-09-20T10:00:00.000Z') });
  assert.equal(ecrit, false); // le faux psql ne rend aucun id : rien d ecrit
  const sql = psql.appels[0].sql;
  assert.match(sql, /INSERT INTO pauses_agents_locaux/);
  assert.match(sql, /'2026-09-20T10:00:00\.000Z'::timestamptz AT TIME ZONE 'UTC'/);
  assert.match(sql, /WHERE NOT EXISTS[\s\S]*"leveeA" IS NULL AND \(jusqua IS NULL OR jusqua > now\(\)\)/);
  assert.match(sql, /RETURNING id/);
});

test('poserPause : sans echeance → NULL ; un id rendu → true ; une apostrophe dans le motif est echappee', () => {
  const psql = (sql) => { psql.sql = sql; return '0f2b0f8c-1d2e-4c3a-9b1f-000000000009\n'; };
  const ecrit = pa.poserPause(psql, { cause: 'echecs-consecutifs', motif: "session Claude Code du poste expiree — l'agent", poseePar: 'sentinelle', jusqua: null });
  assert.equal(ecrit, true);
  assert.match(psql.sql, /'sentinelle', NULL/);
  assert.match(psql.sql, /l''agent/);
});

test('poserPause : cause ou auteur manquant → refus immediat, sans SQL', () => {
  const psql = faussePsql([]);
  assert.throws(() => pa.poserPause(psql, { cause: '', motif: 'x', poseePar: 'a', jusqua: null }), /obligatoires/);
  assert.equal(psql.appels.length, 0);
});

test('leverPause : toutes les lignes ouvertes, signees', () => {
  const psql = faussePsql([]);
  pa.leverPause(psql, 'appel-reussi:rattrapage-recits');
  assert.match(psql.appels[0].sql, /UPDATE pauses_agents_locaux SET "leveeA" = now\(\), "leveePar" = 'appel-reussi:rattrapage-recits' WHERE "leveeA" IS NULL/);
  assert.deepEqual(psql.appels[0].opts, { lecture: false });
});

test('⚠️ motifEnPause : commence par « en pause », garde la phrase de la CLI, et dit la reprise en heure de Paris', () => {
  const p = pa.lirePause(faussePsql([LIGNE]), NOW);
  const m = pa.motifEnPause(p);
  assert.match(m, /^en pause \(plafond-hebdo\) depuis le 13\/09 a 18:30 \(Paris\)/);
  assert.ok(m.includes("You've hit your weekly limit"));
  assert.match(m, /reprise prevue le 20\/09 a 12:00 \(Paris\)/);
  const manuelle = pa.motifEnPause({ ...p, cause: 'echecs-consecutifs', jusqua: null });
  assert.match(manuelle, /reprise MANUELLE : bouton « Reprendre maintenant »/);
});
