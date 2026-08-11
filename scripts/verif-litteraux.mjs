#!/usr/bin/env node
/**
 * Garde anti-piège : un accent grave dans un commentaire de `template:` ou de
 * `styles: [...]` TERMINE le littéral.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Pourquoi ce script existe : ce piège a coûté QUATRE cycles de débogage sur │
 * │ le chantier de refonte (deux au lot A2, deux au lot A3).                    │
 * │                                                                            │
 * │ Ce qui le rend coûteux, c'est qu'il ne ressemble pas à ce qu'il est :       │
 * │  · `tsc --noEmit` PASSE — le fichier reste syntaxiquement valide ;          │
 * │  · le message d'Angular parle de « styles at position 1 », sans nommer      │
 * │    le fichier fautif ;                                                      │
 * │  · le serveur de dev garde silencieusement l'ancien bundle, et l'écran      │
 * │    affiche une version périmée — on croit à un cache, pas à une erreur.     │
 * │                                                                            │
 * │ Le nommer coûte trente lignes. Le retrouver coûte vingt minutes.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/verif-litteraux.mjs
 *
 * Sortie 0 = rien à signaler. Sortie 1 = fichiers et lignes fautifs listés.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RACINE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SOURCES = join(RACINE, 'apps', 'web', 'src');

/**
 * Les deux propriétés dont la valeur est un littéral gabarit contenant du balisage.
 *
 * ⚠️ EN EXPRESSION RÉGULIÈRE, ET NON EN CHAÎNE LITTÉRALE — angle mort trouvé le 2026-08-11.
 * La version précédente cherchait les chaînes exactes `template: \`` et `styles: [\``, donc
 * uniquement quand l'accent grave suit IMMÉDIATEMENT. Or Angular accepte tout aussi bien :
 *
 *     styles: [
 *       ` … `,
 *     ],
 *
 * et cette forme — utilisée par plusieurs composants du dépôt, dont les portes d'accès —
 * était **entièrement ignorée par le contrôle**. Un accent grave dans un commentaire y
 * cassait le build sans que `pnpm verif:litteraux` ne bronche : le garde ne voyait pas le
 * fichier où le piège se trouvait. Le saut de ligne et l'indentation sont désormais admis.
 */
const PROPRIETES = [
  { nom: 'template', ouvre: /template:\s*`/g, ferme: /^`\s*,/ },
  { nom: 'styles', ouvre: /styles:\s*\[\s*`/g, ferme: /^`\s*[,\]]/ },
];

function fichiers(dossier) {
  const sortie = [];
  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) sortie.push(...fichiers(chemin));
    else if (entree.endsWith('.ts') && !entree.endsWith('.spec.ts')) sortie.push(chemin);
  }
  return sortie;
}

const fautes = [];

for (const chemin of fichiers(SOURCES)) {
  const source = readFileSync(chemin, 'utf8');
  for (const propriete of PROPRIETES) {
    propriete.ouvre.lastIndex = 0;
    let m;
    while ((m = propriete.ouvre.exec(source)) !== null) {
      // `ouverture` = juste APRÈS l'accent grave ouvrant, quelle que soit l'indentation.
      const ouverture = m.index + m[0].length;
      const fermeture = source.indexOf('`', ouverture);
      if (fermeture < 0) break;
      // Ce qui SUIT la fermeture dit si le littéral s'est terminé là où il devait.
      const apres = source.slice(fermeture, fermeture + 4);
      if (!propriete.ferme.test(apres)) {
        const ligne = source.slice(0, fermeture).split('\n').length;
        fautes.push({
          fichier: relative(RACINE, chemin),
          ligne,
          extrait: source.slice(fermeture, fermeture + 60).split('\n')[0],
        });
      }
      propriete.ouvre.lastIndex = fermeture + 1;
    }
  }
}

if (fautes.length === 0) {
  console.log('Littéraux de gabarit : rien à signaler.');
  process.exit(0);
}

console.error(`\n${fautes.length} littéral(aux) terminé(s) par un accent grave inattendu :\n`);
for (const f of fautes) {
  console.error(`  ${f.fichier}:${f.ligne}`);
  console.error(`    → ${f.extrait}`);
}
console.error('\nUn accent grave dans un commentaire de template/styles ferme le littéral.');
console.error("Retirez-le : écrivez :host-context() sans accent grave, pas `:host-context()`.\n");
process.exit(1);
