#!/usr/bin/env node
/**
 * Contrastes ≥ 4,5:1 sur le texte, thème clair ET sombre.
 *
 * Critère de recette A3 n° 10 (espace dépôt) et critère commun du bloc B
 * (« Thème clair et sombre, contraste ≥ 4,5:1 sur le texte »).
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
 *   node scripts/verif-contraste.mjs
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
const rgb = (c) => (typeof c === 'string' ? hex(c) : c);
const melange = (a, b, part) => rgb(a).map((v, i) => v * part + rgb(b)[i] * (1 - part));
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (a, b) => { const l1 = lum(rgb(a)), l2 = lum(rgb(b)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

const clair = { ...jetons('light'), '--color-tracky-light': jetons('light')['--color-tracky-light'] ?? '#0A9E6C' };
const sombre = { ...jetons('dark'), '--color-tracky-light': '#10E0A0' };

/**
 * La famille `--texte-*` de `styles.css`, reproduite ici. Les pourcentages sont les
 * MÊMES des deux côtés — c'est tout l'objet du contrôle : si quelqu'un éclaircit un
 * jeton dans le CSS sans toucher à cette table, le script continue de passer sur une
 * valeur qui n'est plus affichée. La table se relit donc à côté du CSS, pas seule.
 */
const ASSOMBRISSEMENT = {
  '--texte-succes': ['--color-tracky-light', 0.72],
  '--texte-alerte': ['--danger', 0.78],
  '--texte-attente': ['--warning', 0.68],
  '--texte-info': ['--blue', 1],
  '--texte-violet': ['--violet', 1],
  '--texte-inactif': ['--text-secondary', 1],
};

/** Résout un jeton `--texte-*` dans un thème donné. */
function texte(t, nomTheme, jeton) {
  const [base, part] = ASSOMBRISSEMENT[jeton];
  return nomTheme === 'light' && part < 1 ? melange(t[base], '#000000', part) : hex(t[base]);
}

/**
 * Les couples réellement employés par les écrans du dépôt : le texte, et le fond
 * sur lequel il se pose (souvent une teinte de lui-même à 12-14 %).
 */
function couplesDepot(t, nomTheme) {
  const fond = t['--surface-secondary'];
  const fondTertiaire = t['--surface-tertiary'] ?? fond;
  const attenue = texte(t, nomTheme, '--texte-inactif');
  const succes = texte(t, nomTheme, '--texte-succes');
  const alerte = texte(t, nomTheme, '--texte-alerte');
  const attente = texte(t, nomTheme, '--texte-attente');
  const teinte = (couleur, part) => melange(couleur, fond, part);
  return [
    ['texte principal sur carte', hex(t['--text-primary']), hex(fond)],
    ['texte atténué sur carte', attenue, hex(fond)],
    ['texte atténué sur surface tertiaire', attenue, hex(fondTertiaire)],
    ['pastille « en mission » (succès sur teinte 13 %)', succes, teinte(succes, 0.13)],
    ['statut « en retard » (alerte sur teinte 12 %)', alerte, teinte(alerte, 0.12)],
    ['position indisponible (attente sur carte)', attente, hex(fond)],
    ['bouton d\'appel (succès sur teinte 11 %)', succes, teinte(succes, 0.11)],
    ['chip de filtre actif (violet sur teinte 14 %)', hex(t['--violet']), melange(t['--violet'], fond, 0.14)],
  ];
}

/**
 * Le badge de présence véhicule : 7 états, 10 px, un lavis de 12 % de sa propre
 * couleur en fond. Il apparaît sur les trois surfaces claires de l'application —
 * on retient la PIRE, jamais la plus flatteuse.
 */
function couplesBadge(t, nomTheme) {
  const surfaces = [t['--surface-secondary'], t['--surface-primary'], t['--surface-tertiary']].filter(Boolean);
  const etats = [
    ['badge « En ligne »', '--texte-succes'],
    ['badge « Recherche GPS »', '--texte-info'],
    ['badge « GPS perdu »', '--texte-alerte'],
    ['badge « Stationné »', '--texte-inactif'],
    ['badge « Hors ligne »', '--texte-attente'],
    ['badge « Dormant »', '--texte-violet'],
    ['badge « Non configuré »', '--texte-inactif'],
  ];
  return etats.map(([libelle, jeton]) => {
    const couleur = texte(t, nomTheme, jeton);
    // Le pire fond : celui qui donne le plus faible rapport.
    const pire = surfaces
      .map((s) => melange(couleur, s, 0.12))
      .reduce((a, b) => (ratio(couleur, a) <= ratio(couleur, b) ? a : b));
    return [libelle, couleur, pire];
  });
}

/** Les chips d'analyse du rejeu de trajet — mêmes jetons, lavis de 14-16 %. */
function couplesRejeu(t, nomTheme) {
  const fond = t['--surface-secondary'];
  const chip = (libelle, jeton, part) => {
    const couleur = texte(t, nomTheme, jeton);
    return [libelle, couleur, melange(couleur, fond, part)];
  };
  return [
    chip('rejeu · chip « bon » (succès sur teinte 16 %)', '--texte-succes', 0.16),
    chip('rejeu · chip « moyen » (attente sur teinte 16 %)', '--texte-attente', 0.16),
    chip('rejeu · chip « mauvais » (alerte sur teinte 16 %)', '--texte-alerte', 0.16),
    chip('rejeu · chip « excès » (alerte sur teinte 14 %)', '--texte-alerte', 0.14),
    ['rejeu · chip « arrêt » (info sur fond tertiaire)', texte(t, nomTheme, '--texte-info'), hex(t['--surface-tertiary'] ?? fond)],
  ];
}

/**
 * Les boutons des bulles de carte (12 px, gras) sur `--surface-secondary`, la surface
 * imposée par `.maplibregl-popup-content`. Le survol assombrit le fond : c'est LUI
 * qu'on mesure, pas l'état au repos — un bouton illisible sous le doigt l'est quand
 * l'utilisateur le regarde.
 */
function couplesBulle(t, nomTheme) {
  const fond = t['--surface-secondary'];
  const bouton = (libelle, jeton, part) => {
    const couleur = texte(t, nomTheme, jeton);
    return [libelle, couleur, melange(couleur, fond, part)];
  };
  return [
    bouton('bulle · bouton principal (survol, 18 %)', '--texte-succes', 0.18),
    bouton('bulle · bouton information (survol, 18 %)', '--texte-info', 0.18),
    bouton('bulle · bouton danger (survol, 18 %)', '--texte-alerte', 0.18),
  ];
}

const SECTIONS = [
  ['Espace dépôt', couplesDepot],
  ['Badge de présence', couplesBadge],
  ['Rejeu de trajet', couplesRejeu],
  ['Bulles de carte', couplesBulle],
];

let echecs = 0;
let total = 0;
for (const [nomTheme, t] of [['light', clair], ['dark', sombre]]) {
  console.log(`\nThème ${nomTheme}`);
  for (const [titre, fabrique] of SECTIONS) {
    console.log(`  ${titre}`);
    for (const [libelle, texteC, fond] of fabrique(t, nomTheme)) {
      const r = ratio(texteC, fond);
      const ok = r >= 4.5;
      total += 1;
      if (!ok) echecs += 1;
      console.log(`    ${ok ? 'ok  ' : 'ECHEC'} ${r.toFixed(2)}:1  ${libelle}`);
    }
  }
}

console.log(
  echecs === 0
    ? `\nLes ${total} couples passent 4,5:1.\n`
    : `\n${echecs} couple(s) sur ${total} sous le seuil.\n`,
);
process.exit(echecs === 0 ? 0 : 1);
