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

/** Les deux propriétés dont la valeur est un littéral gabarit contenant du balisage. */
const PROPRIETES = ['template: `', 'styles: [`'];

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
    let debut = source.indexOf(propriete);
    while (debut >= 0) {
      const ouverture = debut + propriete.length;
      const fermeture = source.indexOf('`', ouverture);
      if (fermeture < 0) break;
      // Ce qui SUIT la fermeture dit si le littéral s'est terminé là où il devait.
      const apres = source.slice(fermeture, fermeture + 4);
      const attendu = propriete.startsWith('template') ? /^`\s*,/ : /^`\s*\]/;
      if (!attendu.test(apres)) {
        const ligne = source.slice(0, fermeture).split('\n').length;
        fautes.push({
          fichier: relative(RACINE, chemin),
          ligne,
          extrait: source.slice(fermeture, fermeture + 60).split('\n')[0],
        });
      }
      debut = source.indexOf(propriete, fermeture + 1);
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
