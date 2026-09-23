#!/usr/bin/env node
/**
 * `pnpm verify` — les quatre gardes, TOUJOURS jusqu'au bout, et un verdict qui ne ment pas.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ Pourquoi ce lanceur existe — mesuré le 2026-09-23.                                        │
 * │                                                                                            │
 * │ `verify` était une chaîne `typecheck && verif:migrations && smoke && test`. Le Postgres   │
 * │ de dev était éteint : `verif:migrations` a échoué, la chaîne s'est arrêtée là, et LES     │
 * │ TESTS N'ONT JAMAIS TOURNÉ. La sortie se terminait par « 1 problème(s) de migration » —    │
 * │ rien ne disait que 4 260 tests venaient d'être sautés. Lu vite, ça ressemble à « vérifié, │
 * │ un souci de migration » alors que c'est « rien n'a été vérifié ».                          │
 * │                                                                                            │
 * │ Deux règles, donc :                                                                        │
 * │   1. on exécute les QUATRE étapes, quoi qu'il arrive — un obstacle sur l'une ne doit pas  │
 * │      coûter le signal des trois autres ;                                                   │
 * │   2. le récapitulatif final distingue ÉCHEC (un défaut trouvé) de NON VÉRIFIÉ (on n'a pas │
 * │      pu regarder). Les confondre, c'est ce qui fait croire qu'on a vérifié.                │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ Et une leçon d'usage, apprise le même jour : `pnpm verify | tail -40` rend le code de
 * sortie de `tail`, pas celui de `verify`. Un pipe masque le verdict. Ce récapitulatif est
 * écrit pour être lisible EN FIN DE SORTIE, justement pour survivre à un `tail`.
 *
 * Sorties : 0 = tout vert · 1 = au moins un échec · 2 = rien d'échoué mais au moins une étape
 * n'a pas pu être vérifiée (base de dev éteinte, par exemple).
 */
import { spawnSync } from 'node:child_process';

/** Une étape du harnais. `sortieNonVerifie` = code que le script rend quand il n'a PAS pu juger. */
const ETAPES = [
  { cle: 'typecheck', titre: 'Types (turbo)', script: 'typecheck' },
  {
    cle: 'migrations',
    titre: 'Rejeu des migrations',
    script: 'verif:migrations',
    // `verif-migrations.mjs` sort 2 quand le Postgres de dev ne répond pas : ce n'est pas une
    // migration cassée, c'est une migration qu'on n'a pas pu lire. Cf. l'incident du 17/09 :
    // le seul juge d'une migration est une base qui la joue — sans base, pas de verdict.
    sortieNonVerifie: 2,
  },
  { cle: 'smoke', titre: 'Smoke-boot (graphe d’injection)', script: 'smoke' },
  { cle: 'tests', titre: 'Tests', script: 'test' },
];

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const resultats = [];

for (const etape of ETAPES) {
  console.log(`\n\u001b[1m━━ ${etape.titre} ━━\u001b[0m\n`);
  const r = spawnSync(pnpm, [etape.script], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const code = r.status ?? 1;
  const etat = code === 0 ? 'ok' : code === etape.sortieNonVerifie ? 'non-verifie' : 'echec';
  resultats.push({ ...etape, code, etat });
}

const SYMBOLE = { ok: '\u001b[32m✓\u001b[0m', echec: '\u001b[31m✗\u001b[0m', 'non-verifie': '\u001b[33m⚠\u001b[0m' };
const LIBELLE = { ok: 'ok', echec: 'ÉCHEC', 'non-verifie': 'NON VÉRIFIÉ' };

console.log('\n\u001b[1m━━ Récapitulatif ━━\u001b[0m\n');
for (const r of resultats) {
  console.log(`  ${SYMBOLE[r.etat]} ${r.titre.padEnd(34)} ${LIBELLE[r.etat]}`);
}

const echecs = resultats.filter((r) => r.etat === 'echec');
const nonVerifies = resultats.filter((r) => r.etat === 'non-verifie');

console.log('');
if (echecs.length > 0) {
  console.log(`\u001b[31m✗ ${echecs.length} étape(s) en échec : ${echecs.map((r) => r.titre).join(', ')}.\u001b[0m`);
  if (nonVerifies.length > 0) {
    console.log(`\u001b[33m  (et ${nonVerifies.length} non vérifiée(s) : ${nonVerifies.map((r) => r.titre).join(', ')})\u001b[0m`);
  }
  console.log('');
  process.exit(1);
}
if (nonVerifies.length > 0) {
  // Volontairement NON-ZÉRO : « je n'ai pas pu regarder » ne doit jamais se lire comme « c'est bon ».
  console.log(`\u001b[33m⚠ Rien en échec, mais ${nonVerifies.length} étape(s) NON VÉRIFIÉE(S) : ${nonVerifies.map((r) => r.titre).join(', ')}.\u001b[0m`);
  console.log('\u001b[33m  Ne pas conclure « vérifié » sur cette sortie — relancer une fois l’obstacle levé.\u001b[0m');
  console.log('');
  process.exit(2);
}
console.log('\u001b[32m✓ Tout est vert.\u001b[0m\n');
