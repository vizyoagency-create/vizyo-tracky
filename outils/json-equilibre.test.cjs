'use strict';
/**
 * Jeux d'essai de `json-equilibre.cjs` (T58) :
 *
 *   node --test outils/json-equilibre.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { premierObjetJson, lireObjetJson } = require('./json-equilibre.cjs');

const GUILLEMET_ECHAPPE = String.fromCharCode(92) + '"'; // \" tel que le modèle l'écrit dans du JSON

test('un objet suivi d une phrase est accepté — la phrase est ignorée', () => {
  assert.deepEqual(lireObjetJson('{"objet":"Rapport","corps":"ok"}\n\nVoilà, dites-moi si vous voulez des ajustements.'), {
    objet: 'Rapport',
    corps: 'ok',
  });
});

test('🔴 le cas du 13/09 : une phrase APRÈS l objet qui contient elle-même des accolades', () => {
  const texte = '{"objet":"x","corps":"y"} (le gabarit {objet, corps} est respecté)';
  assert.equal(premierObjetJson(texte), '{"objet":"x","corps":"y"}');
  assert.deepEqual(lireObjetJson(texte), { objet: 'x', corps: 'y' });
});

test('du texte AVANT l objet est ignoré aussi', () => {
  assert.deepEqual(lireObjetJson('Bien sûr, voici la réponse :\n{"a":1}'), { a: 1 });
});

test('les accolades DANS les chaînes ne comptent pas, ni les guillemets échappés', () => {
  const texte = `{"corps":"Bonjour {prenom}, voici ${GUILLEMET_ECHAPPE}l'offre${GUILLEMET_ECHAPPE} }","n":2} suite`;
  assert.deepEqual(lireObjetJson(texte), { corps: `Bonjour {prenom}, voici "l'offre" }`, n: 2 });
});

test('les objets imbriqués sont rendus entiers', () => {
  assert.deepEqual(lireObjetJson('{"a":{"b":{"c":1}},"d":[{"e":2}]} fin'), { a: { b: { c: 1 } }, d: [{ e: 2 }] });
});

test('sans objet complet : null, et lireObjetJson lève « reponse sans objet JSON »', () => {
  assert.equal(premierObjetJson('pas de json ici'), null);
  assert.equal(premierObjetJson('{"a":1'), null);
  assert.throws(() => lireObjetJson('rien'), /reponse sans objet JSON/);
});

test('un objet complet mais illisible lève l erreur de JSON.parse — le travail sera reposé, pas inventé', () => {
  assert.throws(() => lireObjetJson('{"a":}'), SyntaxError);
});
