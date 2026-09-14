'use strict';
/**
 * PREMIER OBJET JSON ÉQUILIBRÉ d'un texte — T58 (2026-09-14).
 *
 * Le courrier IA extrayait l'objet rendu par le modèle avec `/\{[\s\S]*\}/` : du PREMIER `{` au
 * DERNIER `}`. Un modèle qui ajoute une phrase après son objet — « {…} Voilà, dites-moi si… » —
 * n'est pas un problème tant que la phrase ne contient pas d'accolade ; mais « {…} (voir {x}) »
 * donnait `{…} (voir {x}` et `JSON.parse` échouait : « Unexpected non-whitespace character after
 * JSON at position 407 » (13/09, 17:52 — un rapport d'activité client reposé, puis rendu).
 *
 * Ici : on avance depuis le premier `{`, on compte les accolades HORS chaînes (une chaîne JSON
 * commence et finit par `"`, `\"` n'en ferme pas une), et l'on s'arrête à la première fermeture
 * qui ramène le compte à zéro. Ce qui suit est ignoré. Rend `null` s'il n'y a pas d'objet
 * complet — l'appelant repose le travail, comme avant.
 */
const ANTISLASH = String.fromCharCode(92);

function premierObjetJson(texte) {
  const s = String(texte ?? '');
  const debut = s.indexOf('{');
  if (debut < 0) return null;
  let profondeur = 0;
  let enChaine = false;
  for (let i = debut; i < s.length; i++) {
    const c = s[i];
    if (enChaine) {
      if (c === ANTISLASH) i++; // le caractère échappé, quel qu'il soit, ne compte pas
      else if (c === '"') enChaine = false;
      continue;
    }
    if (c === '"') enChaine = true;
    else if (c === '{') profondeur++;
    else if (c === '}') {
      profondeur--;
      if (profondeur === 0) return s.slice(debut, i + 1);
    }
  }
  return null;
}

/** L'objet parsé, ou une erreur explicite : sans objet complet, ou objet illisible. */
function lireObjetJson(texte) {
  const brut = premierObjetJson(texte);
  if (brut === null) throw new Error(`reponse sans objet JSON (${String(texte ?? '').slice(0, 120)})`);
  return JSON.parse(brut);
}

module.exports = { premierObjetJson, lireObjetJson };
