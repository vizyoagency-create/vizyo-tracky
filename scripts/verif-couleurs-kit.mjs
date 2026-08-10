#!/usr/bin/env node
/**
 * Lot B-kit, règle n° 1 : **aucune couleur en dur**.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CE QUE « EN DUR » VEUT DIRE ICI                                           │
 * │                                                                            │
 * │ Deux formes, et la première trompe son monde :                             │
 * │                                                                            │
 * │  · une classe de la PALETTE Tailwind — `text-red-400`, `bg-amber-500`.     │
 * │    Elle a l'air d'appartenir au système parce qu'elle en a la syntaxe.     │
 * │    Elle n'en fait pas partie : elle porte une valeur figée, identique en   │
 * │    thème clair et sombre, et elle double un jeton qui existe déjà.         │
 * │                                                                            │
 * │  · un hexadécimal écrit à la main.                                          │
 * │                                                                            │
 * │ Aucune des deux ne casse quoi que ce soit. Elles s'affichent — simplement  │
 * │ dans la mauvaise teinte, et personne ne le remarque tant qu'on développe   │
 * │ en thème sombre. C'est pourquoi ce contrôle existe.                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Périmètre : `shared/ui` et `shared/components`, c'est-à-dire le KIT. Les écrans
 * relèvent du lot B-pages, et les signaler ici noierait le signal.
 *
 *   node scripts/verif-couleurs-kit.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RACINE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CIBLES = [
  join(RACINE, 'apps', 'web', 'src', 'app', 'shared', 'ui'),
  join(RACINE, 'apps', 'web', 'src', 'app', 'shared', 'components'),
];

const TEINTES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const PALETTE = new RegExp(`\\b(?:text|bg|border|from|to|via|ring|fill|stroke|decoration|outline|shadow|accent|caret)-(?:${TEINTES})-(?:50|[1-9]00)\\b`, 'g');
const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

/**
 * `rgba()` TEINTÉ — la troisième forme, et celle qui a échappé au premier passage :
 * `rgba(16, 224, 160, .35)` est le vert de marque écrit autrement. Elle ne ressemble
 * pas à une couleur en dur parce qu'elle n'a pas de `#`.
 *
 * Le noir et le blanc en sont EXCLUS : `rgba(0,0,0,.5)` est un voile, pas une couleur
 * de marque — il assombrit ce qu'il y a dessous, quel que soit le thème, et c'est
 * précisément son rôle.
 */
const RGBA_TEINTE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)/g;
function estTeinte(m) {
  const [r, v, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const gris = r === v && v === b;
  return !gris;
}

/**
 * Exceptions assumées, avec leur raison. Une exception se justifie ; une exception
 * muette redevient une couleur en dur au premier copier-coller.
 */
const TOLERES = new Map([
  // Les couches MapLibre ne résolvent aucune variable CSS, et se posent sur un fond
  // de carte qui n'est pas le thème. Cf. shared/utils/couleurs-carte.ts.
  ['shared/utils/couleurs-carte.ts', 'couches de carte — MapLibre ne lit pas les variables CSS'],
  ['ui/mini-map/mini-map.component.ts', 'couche de carte MapLibre — même raison'],
  // Les graphiques dessinent dans un CANVAS, qui ne connaît pas var(). Les couleurs y
  // sont lues au moment du rendu par `getComputedStyle` ; le second argument de `get()`
  // n'est qu'un filet si la lecture échoue — la valeur affichée reste celle du jeton.
  ['ui/charts/line-bar-chart.component.ts', 'canvas — couleurs lues via getComputedStyle'],
  ['ui/charts/histogram-chart.component.ts', 'canvas — couleurs lues via getComputedStyle'],
  ['ui/charts/error-timeline-chart.component.ts', 'canvas — couleurs lues via getComputedStyle'],
  ['ui/charts/heatmap-chart.component.ts', 'canvas — couleurs lues via getComputedStyle'],
  // Plaque de logo CONSTRUCTEUR : support d'image, pas surface d'interface. Un logo
  // noir sur une surface sombre du thème disparaîtrait.
  ['ui/brand-logo/brand-logo.component.ts', 'plaque de logo constructeur — fond imposé par les images'],
]);

const fichiers = [];
function marche(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) marche(p);
    else if (/\.ts$/.test(e) && !/\.spec\.ts$/.test(e)) fichiers.push(p);
  }
}
for (const c of CIBLES) marche(c);

const anomalies = [];
for (const f of fichiers) {
  const src = readFileSync(f, 'utf8');
  const rel = f.replace(/\\/g, '/').replace(RACINE.replace(/\\/g, '/'), '').replace(/^\//, '');
  if ([...TOLERES.keys()].some((t) => rel.endsWith(t))) continue;

  src.split('\n').forEach((ligne, i) => {
    const t = ligne.trim();
    // Un commentaire qui CITE une couleur retirée est une explication, pas une couleur.
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const m of [...(ligne.match(PALETTE) ?? []), ...(ligne.match(HEX) ?? [])]) {
      anomalies.push({ rel, l: i + 1, quoi: m, extrait: t.slice(0, 90) });
    }
    RGBA_TEINTE.lastIndex = 0;
    for (const m of ligne.matchAll(RGBA_TEINTE)) {
      if (estTeinte(m)) anomalies.push({ rel, l: i + 1, quoi: m[0], extrait: t.slice(0, 90) });
    }
  });
}

const parFichier = {};
for (const a of anomalies) (parFichier[a.rel] ??= []).push(a);
for (const [f, l] of Object.entries(parFichier).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(l.length).padStart(4)}  ${f}`);
  for (const a of l) console.log(`        ${String(a.l).padStart(5)}  ${a.quoi}   ${a.extrait}`);
}
console.log(
  anomalies.length === 0
    ? '\nAucune couleur en dur dans le kit partagé.\n'
    : `\n${anomalies.length} couleur(s) en dur dans ${Object.keys(parFichier).length} composant(s).\n`,
);
process.exit(anomalies.length === 0 ? 0 : 1);
