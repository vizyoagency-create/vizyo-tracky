#!/usr/bin/env node
/**
 * Critère de recette A3 n° 10 — contrastes ≥ 4,5:1 sur le texte, clair ET sombre.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI UN CALCUL, ET PAS UNE MESURE DANS LE NAVIGATEUR                   │
 * │                                                                            │
 * │ Une sonde DOM est tentante — elle lit les vraies couleurs. Mais            │
 * │ `getComputedStyle().backgroundColor` ne rend pas une valeur fiable quand le │
 * │ fond vient d'un raccourci `background: var(--x)` ou d'un `color-mix()` :    │
 * │ on obtient un blanc là où l'écran affiche du noir. Les faux positifs        │
 * │ noient les vrais, et on finit par ne plus lire le rapport.                  │
 * │                                                                            │
 * │ Les jetons, eux, sont des hexadécimaux écrits dans styles.css. On les lit,  │
 * │ on compose les teintes comme le fait `color-mix`, et on calcule. Le résultat│
 * │ est reproductible et se relit — c'est ce qu'on veut d'un critère de recette.│
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/verif-contraste-depot.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RACINE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CSS = readFileSync(join(RACINE, 'apps', 'web', 'src', 'styles.css'), 'utf8');

/** Extrait les jetons d'un bloc `[data-theme='X'] { ... }`. */
function jetons(theme) {
  const bloc = CSS.match(new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
  const table = {};
  for (const [, nom, valeur] of (bloc?.[1] ?? '').matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{3,8})/g)) {
    table[nom] = valeur;
  }
  return table;
}

const hex = (c) => {
  const v = c.replace('#', '');
  const n = v.length === 3 ? v.split('').map((x) => x + x).join('') : v;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
};
const melange = (a, b, part) => hex(a).map((v, i) => v * part + hex(b)[i] * (1 - part));
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

const clair = { ...jetons('light'), '--color-tracky-light': jetons('light')['--color-tracky-light'] ?? '#0A9E6C' };
const sombre = { ...jetons('dark'), '--color-tracky-light': '#10E0A0' };

/**
 * Les couples réellement employés par les écrans du dépôt : le texte, et le fond
 * sur lequel il se pose (souvent une teinte de lui-même à 12-14 %).
 */
function couples(t, nomTheme) {
  const fond = t['--surface-secondary'];
  const fondTertiaire = t['--surface-tertiary'] ?? fond;
  const attenue = t['--text-secondary'];
  const succes = nomTheme === 'light'
    ? melange(t['--color-tracky-light'], '#000000', 0.72)
    : hex(t['--color-tracky-light']);
  const alerte = nomTheme === 'light' ? melange(t['--danger'], '#000000', 0.82) : hex(t['--danger']);
  const attente = nomTheme === 'light' ? melange(t['--warning'], '#000000', 0.75) : hex(t['--warning']);
  const teinte = (couleur, part) => melange(
    typeof couleur === 'string' ? couleur : `#${couleur.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`,
    fond,
    part,
  );
  return [
    ['texte principal sur carte', hex(t['--text-primary']), hex(fond)],
    ['texte atténué sur carte', hex(attenue), hex(fond)],
    ['texte atténué sur surface tertiaire', hex(attenue), hex(fondTertiaire)],
    ['pastille « en mission » (succès sur teinte 13 %)', succes, teinte(t['--color-tracky-light'], 0.13)],
    ['statut « en retard » (alerte sur teinte 12 %)', alerte, teinte(t['--danger'], 0.12)],
    ['position indisponible (attente sur carte)', attente, hex(fond)],
    ['bouton d\'appel (succès sur teinte 11 %)', succes, teinte(t['--color-tracky-light'], 0.11)],
    ['chip de filtre actif (violet sur teinte 14 %)', hex(t['--violet']), teinte(t['--violet'], 0.14)],
  ];
}

let echecs = 0;
for (const [nomTheme, t] of [['light', clair], ['dark', sombre]]) {
  console.log(`\nThème ${nomTheme}`);
  for (const [libelle, texte, fond] of couples(t, nomTheme)) {
    const r = ratio(texte, fond);
    const ok = r >= 4.5;
    if (!ok) echecs += 1;
    console.log(`  ${ok ? 'ok  ' : 'ECHEC'} ${r.toFixed(2)}:1  ${libelle}`);
  }
}

console.log(echecs === 0 ? '\nTous les couples passent 4,5:1.\n' : `\n${echecs} couple(s) sous le seuil.\n`);
process.exit(echecs === 0 ? 0 : 1);
