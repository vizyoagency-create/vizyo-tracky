#!/usr/bin/env node
/**
 * Toucher une source MapLibre sans avoir vérifié que la carte est vivante.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI CE CONTRÔLE EXISTE                                                │
 * │                                                                            │
 * │ Le navigateur peut retirer le contexte WebGL d'un onglet à tout moment :   │
 * │ pilote graphique qui redémarre, machine sous pression mémoire, portable    │
 * │ qui bascule entre GPU intégré et dédié. Ce n'est ni une erreur de          │
 * │ l'application ni une action de l'utilisateur.                              │
 * │                                                                            │
 * │ MapLibre 5 réagit ainsi (`maplibre-gl.js`) :                               │
 * │                                                                            │
 * │     this.style.destroy(), this.style = null, fire('webglcontextlost')      │
 * │                                                                            │
 * │ ⚠️ L'OBJET `Map` RESTE VIVANT. Toutes les gardes de la forme               │
 * │ `if (!this.map) return` passent donc — et `map.getSource(...)`, qui lit    │
 * │ `this.style.getSource(...)`, lève « Cannot read properties of null ».      │
 * │                                                                            │
 * │ Mesuré en production le 2026-09-07 : deux `[uncaught] TypeError` chez un   │
 * │ client sur /map. Reproduit au navigateur en forçant                        │
 * │ `WEBGL_lose_context.loseContext()` : QUATRE-VINGT-DIX erreurs identiques,  │
 * │ une par cycle de rendu, chacune postée au serveur — et une carte noire.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * CE QUE CE SCRIPT EXIGE : toute méthode du composant carte qui appelle `getSource`,
 * `getLayer`, `setPaintProperty` ou `setLayoutProperty` doit passer par
 * `carteUtilisable()` — la seule garde qui distingue « la référence existe » de
 * « la carte peut recevoir des ordres ».
 *
 * ⚠️ POURQUOI UN SCRIPT ET NON UN TEST. Karma ne lit pas le système de fichiers, et
 * l'invariant porte sur la FORME du source, pas sur un comportement observable. Le
 * défaut d'origine venait précisément d'une énumération tenue à la main : trois gardes
 * empilées, chacune ajoutée après un incident, et l'état suivant oublié à chaque fois.
 * Un contrôle mécanique est le seul qui n'oublie pas la vingtième méthode.
 */
import { readFileSync } from 'node:fs';

const FICHIER = 'apps/web/src/app/features/map/map.component.ts';
/** Les appels qui traversent `map.style` et lèvent donc sur une carte sans contexte. */
const APPELS = /\.(getSource|getLayer|setPaintProperty|setLayoutProperty)\s*\(/;
/** Mots-clés qui ressemblent à une déclaration de méthode sans en être une. */
const MOTS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'try', 'else', 'do', 'constructor']);
const DECL = /^ {2}(?:private |protected |public )?(?:static )?(?:async )?(?:get )?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/**
 * Exemptions NOMMÉES, jamais une catégorie.
 *
 * ⚠️ Chacune doit dire pourquoi elle ne peut pas porter la garde. « C'est du setup » n'est
 * pas une raison : une exemption par famille finirait par couvrir tout le fichier, et ce
 * contrôle ne contrôlerait plus rien.
 */
const EXEMPTES = new Map([
  [
    'carteUtilisable',
    "c'est la garde elle-même : elle ne peut pas s'appeler pour se protéger.",
  ],
]);

const lignes = readFileSync(FICHIER, 'utf8').split('\n');

/** La méthode qui contient la ligne donnée, en remontant jusqu'à sa déclaration. */
function methodeDe(i) {
  for (let j = i; j >= 0; j--) {
    const m = DECL.exec(lignes[j]);
    if (m && !MOTS.has(m[1])) return { nom: m[1], debut: j };
  }
  return null;
}

/** La méthode passe-t-elle par la garde, où que ce soit dans son corps ? */
function porteLaGarde(debut) {
  // On lit jusqu'à la prochaine déclaration de méthode — la fin du corps, en pratique.
  for (let j = debut + 1; j < lignes.length; j++) {
    const m = DECL.exec(lignes[j]);
    if (m && !MOTS.has(m[1])) return false;
    if (lignes[j].includes('carteUtilisable()')) return true;
  }
  return false;
}

const anomalies = [];
const vues = new Set();
lignes.forEach((ligne, i) => {
  // Un commentaire n'appelle rien.
  const t = ligne.trim();
  if (t.startsWith('*') || t.startsWith('//')) return;
  if (!APPELS.test(ligne)) return;
  const meth = methodeDe(i);
  if (!meth || EXEMPTES.has(meth.nom) || vues.has(meth.nom)) return;
  vues.add(meth.nom);
  if (!porteLaGarde(meth.debut)) {
    anomalies.push({ nom: meth.nom, ligne: meth.debut + 1, usage: i + 1, extrait: t.slice(0, 88) });
  }
});

if (anomalies.length === 0) {
  console.log(`\nCarte : les ${vues.size} méthodes qui touchent une source passent par carteUtilisable().\n`);
  process.exit(0);
}

console.log(`\n${anomalies.length} méthode(s) touchent une source MapLibre sans vérifier que la carte est vivante :\n`);
for (const a of anomalies) {
  console.log(`  l.${String(a.ligne).padStart(5)}  ${a.nom}`);
  console.log(`         appel l.${a.usage} : ${a.extrait}`);
}
console.log(
  '\nAjoutez `!this.carteUtilisable()` à la garde de tête. Sans elle, une perte de contexte\n'
  + 'WebGL fait lever cet appel à chaque cycle de rendu, chez un client, sans rien de\n'
  + 'reproductible en recette.\n',
);
process.exit(1);
