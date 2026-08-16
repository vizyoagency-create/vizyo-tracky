#!/usr/bin/env node
/**
 * Les variables CSS qui n'existent pas.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI CE CONTRÔLE EXISTE                                                │
 * │                                                                            │
 * │ `var(--surface)` s'écrit sans effort et ne provoque aucune erreur : ni au  │
 * │ typecheck, ni au build, ni dans la console. Le navigateur applique         │
 * │ silencieusement une des trois issues suivantes, selon la forme écrite.     │
 * │                                                                            │
 * │  1. SANS REPLI — la déclaration entière est jetée. `background:            │
 * │     var(--surface)` devient `transparent`, et le raccourci `border: 1px    │
 * │     solid var(--border)` retombe sur `border-style: none` : la bordure     │
 * │     DISPARAÎT. C'est la forme la plus visible, et la plus surprenante,     │
 * │     parce que la ligne semble pourtant écrite correctement.                │
 * │                                                                            │
 * │  2. REPLI EN DUR — `var(--color-fg-tertiary, #94a3b8)`. Le nom n'existant  │
 * │     pas, l'hexadécimal gagne TOUJOURS. La couleur ne suit alors aucun      │
 * │     thème. Relevé sur le panneau de surveillance : les pastilles d'état    │
 * │     tombaient à 1,47:1 en thème clair.                                     │
 * │                                                                            │
 * │  3. REPLI VERS UN VRAI JETON — `var(--surface, var(--bg-secondary))`.      │
 * │     S'affiche juste, mais le nom de tête est mort : il fait croire à un    │
 * │     second vocabulaire qui n'a jamais existé. Le prochain copier-coller le │
 * │     propagera sans son repli, et on retombe sur le cas 1.                  │
 * │                                                                            │
 * │ Les trois sont refusées. Tolérer la troisième, c'est laisser repousser les │
 * │ deux autres.                                                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Périmètre : tout `apps/web/src`. C'est le trou que `verif:couleurs-kit` laisse —
 * celui-ci ne regarde que `shared/ui` et `shared/components`, et les fantômes se
 * logent dans les écrans.
 *
 * CE QUI EST LÉGITIME et ne doit PAS être signalé :
 *   · les jetons de `styles.css`, qui sont le vocabulaire global ;
 *   · une variable définie dans le bloc `styles` du composant qui l'emploie ;
 *   · une variable POSÉE au rendu — `[style.--pill]`, `setProperty('--chart-height')`.
 *     Elle n'existe nulle part dans une feuille, et c'est normal : c'est une valeur
 *     calculée que le gabarit dépose sur l'élément.
 *
 *   node scripts/verif-variables.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RACINE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(RACINE, 'apps', 'web', 'src');

const CSS = readFileSync(join(SRC, 'styles.css'), 'utf8');

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ LE PIÈGE `@theme inline`                                                   │
 * │                                                                            │
 * │ Un nom déclaré dans `@theme inline` A L'AIR d'un jeton : il est dans       │
 * │ styles.css, il a une valeur, il est à côté des autres. Il n'en est pas un. │
 * │ `inline` demande à Tailwind d'injecter la VALEUR dans l'utilitaire au      │
 * │ moment de la compilation, au lieu d'émettre la variable dans `:root`.      │
 * │                                                                            │
 * │ Conséquence mesurée dans le navigateur, sur cette application :             │
 * │   getPropertyValue('--color-fg-tertiary')   →  ""      (vide)              │
 * │   getPropertyValue('--color-border-subtle') →  "rgba(255,255,255,0.08)"    │
 * │                                                                            │
 * │ Deux noms du MÊME bloc, deux résultats. Tailwind finit par émettre celui   │
 * │ dont la classe utilitaire est encore employée quelque part dans les        │
 * │ gabarits. Autrement dit : `var(--color-border-subtle)` marche tant que     │
 * │ quelqu'un écrit encore `border-subtle` dans un gabarit, et devient vide le │
 * │ jour où le dernier disparaît — dans un fichier sans rapport, sans erreur.  │
 * │                                                                            │
 * │ On refuse donc TOUT ce vocabulaire. L'équivalent `:root` existe pour       │
 * │ chacun : var(--color-fg-tertiary) → var(--fg-tertiary).                    │
 * │                                                                            │
 * │ Le bloc `@theme` SANS `inline` (l'accent de marque, les polices) est bien  │
 * │ émis dans `:root` : `--color-tracky-light` vaut #10e0a0 à l'exécution.     │
 * │ Celui-là reste autorisé.                                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const inlinees = new Set();
const blocInline = CSS.match(/@theme\s+inline\s*\{([\s\S]*?)\n\}/);
if (blocInline) {
  for (const m of blocInline[1].matchAll(/(--[\w-]+)\s*:/g)) inlinees.add(m[1]);
}

/** Le vocabulaire global : ce que `styles.css` émet réellement dans `:root`. */
const globales = new Set();
for (const m of CSS.matchAll(/(--[\w-]+)\s*:/g)) {
  if (!inlinees.has(m[1])) globales.add(m[1]);
}

/**
 * Préfixes posés par un tiers, jamais écrits à la main : Tailwind fabrique ses
 * `--tw-*` au moment où il génère l'utilitaire. Les signaler serait du bruit.
 */
const PREFIXES_TOLERES = ['--tw-'];

const fichiers = [];
function marche(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) marche(p);
    else if (/\.(ts|css|html)$/.test(e) && !/\.spec\.ts$/.test(e)) fichiers.push(p);
  }
}
marche(SRC);

/** Les trois façons de POSER une variable au rendu, depuis le gabarit ou le code. */
const POSE = [
  /\[style\.(--[\w-]+)/g,
  /setProperty\(\s*['"`](--[\w-]+)/g,
  /style="[^"]*?(--[\w-]+)\s*:/g,
];

const anomalies = [];
for (const f of fichiers) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(SRC, f).replace(/\\/g, '/');

  // Ce que CE fichier connaît en propre : ses définitions et ses poses au rendu.
  const locales = new Set();
  for (const m of src.matchAll(/(--[\w-]+)\s*:/g)) locales.add(m[1]);
  for (const re of POSE) for (const m of src.matchAll(re)) locales.add(m[1]);

  src.split('\n').forEach((ligne, i) => {
    const t = ligne.trim();
    // Un commentaire qui CITE `var(--x)` l'explique, il ne l'emploie pas.
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('│')) return;
    for (const m of ligne.matchAll(/var\(\s*(--[\w-]+)\s*(,\s*([^)]*))?/g)) {
      const nom = m[1];
      if (globales.has(nom) || locales.has(nom)) continue;
      if (PREFIXES_TOLERES.some((p) => nom.startsWith(p))) continue;
      const repli = m[3]?.trim() ?? '';
      const forme = inlinees.has(nom)
        ? `déclarée dans @theme inline — non émise dans :root. Employer ${nom.replace('--color-', '--')}`
        : !m[2]
          ? 'SANS REPLI — la déclaration est jetée'
          : /^var\(/.test(repli)
            ? 'repli vers un jeton — le nom de tête est mort'
            : 'repli EN DUR — la couleur ne suit plus le thème';
      anomalies.push({ rel, l: i + 1, nom, forme, extrait: t.slice(0, 88) });
    }
  });
}

const parFichier = {};
for (const a of anomalies) (parFichier[a.rel] ??= []).push(a);
for (const [f, l] of Object.entries(parFichier).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(l.length).padStart(4)}  ${f}`);
  for (const a of l) console.log(`        ${String(a.l).padStart(5)}  ${a.nom}  — ${a.forme}\n               ${a.extrait}`);
}
console.log(
  anomalies.length === 0
    ? '\nAucune variable CSS fantôme dans apps/web/src.\n'
    : `\n${anomalies.length} variable(s) CSS employée(s) sans jamais être définie(s), dans ${Object.keys(parFichier).length} fichier(s).\n`,
);
process.exit(anomalies.length === 0 ? 0 : 1);
