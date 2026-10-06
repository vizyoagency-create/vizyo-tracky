#!/usr/bin/env node
/**
 * « Une icône est un SVG, jamais un emoji » — demande du propriétaire, 06/10/2026, devant
 * « 🏢 Client test » dans la page Horaires : « Non, pour les icônes comme ça, mettre des SVG ».
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI UN SCRIPT                                                         │
 * │                                                                            │
 * │ Un emoji ne suit ni le thème ni la taille du texte, et chaque système le   │
 * │ dessine à sa façon : Windows sort la pompe ⛽ en ROUGE et les drapeaux en  │
 * │ deux lettres (« FR »). Il en restait 30 fichiers le jour où la règle a été │
 * │ posée : sans contrôle, il en reviendra un par semaine.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Ce qui est cherché, dans le code AFFICHABLE de `apps/web/src` (gabarits, chaînes, CSS en
 * ligne — commentaires `//`, `/* *\/` et `<!-- -->` retirés, specs exclues) :
 *   1. tout pictogramme emoji (propriété Unicode `Extended_Pictographic`), sauf les signes
 *      typographiques © ® ™ et les doubles flèches ↔ ↕ ;
 *   2. les glyphes qui servent d'icône : coches et croix (✓ ✔ ✗ ✘ ✕ ✖), étoiles, puces
 *      géométriques (● ○ ◆ ◇ ■ □), triangles et chevrons (▲ ▼ ▶ ◀ ▸ ▾…), flèches de reprise
 *      (↻ ↺ ⟳ ⟲) et la loupe ⌕ ;
 *   3. une flèche ou une croix SEULE dans un élément (« <button>×</button> », « <span>→</span> »)
 *      ou en bout de lien (« Voir le trajet →</a> », « <a …>← Retour ») : c'est une icône.
 *
 * Ce qui reste permis, parce que c'est de la TYPOGRAPHIE : la flèche dans une phrase ou une
 * plage (« 08:00 → 10:00 », « Réglages → Sécurité », « Lyon → Paris »), le signe × d'une
 * dimension ou d'un compte (« 60 × 90 mm », « ×3 »), la puce •, le point médian ·.
 *
 *   node scripts/verif-icones.mjs           → le compte par fichier
 *   node scripts/verif-icones.mjs --detail  → chaque occurrence
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RACINE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CIBLES = ['apps/web/src'];

/** 1 + 2 : pictogrammes et glyphes-icônes, partout dans le code affichable. */
const GLYPHE = /(?![©®™‼⁉↔↕\u{FE0F}])[\p{Extended_Pictographic}✓✔✗✘✕✖★☆●○◆◇■□▲△▼▽▶▷◀◁▸▹▾▿◂◃↻↺⟳⟲⌕]/gu;
/**
 * 3 : flèche ou croix SEULE dans un élément — suivie de sa balise fermante (« >×</button> ») ;
 * une flèche ENTRE deux éléments (« </span> → <span> », « </strong> → <em> ») reste une
 * phrase —, ou au bord d'un lien.
 */
const SEULE = />\s*[←→↑↓×]\s*<\//g;
const BORD_DE_LIEN = /[←→]\s*<\/(?:a|button|span)>|<(?:a|button)\b[^>]*>\s*[←→]/g;

/**
 * Occurrences TOLÉRÉES, nommées une à une (fichier|caractère) avec leur raison. Si la ligne
 * bouge, le contrôle redevient bavard : c'est voulu.
 */
const TOLERES = new Set([]);

const fichiers = [];
function marche(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'node_modules' && e !== 'dist') marche(p); }
    else if (/\.(ts|html)$/.test(e) && !/\.spec\.ts$/.test(e)) fichiers.push(p);
  }
}
for (const c of CIBLES) marche(join(RACINE, c));

/**
 * Retire les commentaires JS (`//`, `/* *\/`) en respectant les chaînes, puis — DANS les gabarits
 * littéraux — les commentaires CSS (`/* *\/` des `styles: [...]`). Les positions sont gardées
 * (espaces à la place) pour que les numéros de ligne restent justes.
 */
function sansCommentaires(src, estTs) {
  const blanc = (s) => s.replace(/[^\n]/g, ' ');
  if (!estTs) return src.replace(/<!--[\s\S]*?-->/g, blanc);
  let out = '';
  let i = 0;
  const pile = [];
  let etat = 'code';
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (etat === 'code') {
      if (c === '/' && d === '/') { const j = src.indexOf('\n', i); const fin = j < 0 ? n : j; out += blanc(src.slice(i, fin)); i = fin; continue; }
      if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const fin = j < 0 ? n : j + 2; out += blanc(src.slice(i, fin)); i = fin; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        out += src.slice(i, j + 1); i = j + 1; continue;
      }
      if (c === '`') { out += c; i++; pile.push('code'); etat = 'tpl'; continue; }
      if (c === '{') { pile.push('accolade'); out += c; i++; continue; }
      if (c === '}') {
        const haut = pile[pile.length - 1];
        if (haut === 'tpl') { pile.pop(); etat = 'tpl'; out += c; i++; continue; }
        if (haut === 'accolade') pile.pop();
        out += c; i++; continue;
      }
      out += c; i++; continue;
    }
    // Dans un gabarit littéral : commentaires CSS et HTML retirés, interpolations suivies.
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === '`') { out += c; i++; pile.pop(); etat = 'code'; continue; }
    if (c === '$' && d === '{') { out += '${'; i += 2; pile.push('tpl'); etat = 'code'; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); const fin = j < 0 ? n : j + 2; out += blanc(src.slice(i, fin)); i = fin; continue; }
    if (c === '<' && src.startsWith('<!--', i)) { const j = src.indexOf('-->', i + 4); const fin = j < 0 ? n : j + 3; out += blanc(src.slice(i, fin)); i = fin; continue; }
    out += c; i++;
  }
  return out;
}

const trouvailles = [];
/** Une même icône attrapée par deux règles (« <span>→</span> ») ne compte qu'une fois. */
const dejaVus = new Set();
for (const f of fichiers) {
  const brut = readFileSync(f, 'utf8');
  const src = sansCommentaires(brut, f.endsWith('.ts'));
  const rel = f.replace(/\\/g, '/').replace(RACINE.replace(/\\/g, '/'), '').replace(/^\//, '');
  const lignesBrutes = brut.split('\n');
  const debuts = [];
  let acc = 0;
  for (const l of src.split('\n')) { debuts.push(acc); acc += l.length + 1; }
  const ligneDe = (i) => { let k = 0; while (k + 1 < debuts.length && debuts[k + 1] <= i) k += 1; return k + 1; };
  const noter = (index, signe, regle) => {
    if (TOLERES.has(`${rel}|${signe}`)) return;
    const l = ligneDe(index);
    const cle = `${rel}|${l}|${signe}`;
    if (dejaVus.has(cle)) return;
    dejaVus.add(cle);
    trouvailles.push({ f: rel, l, signe, regle, extrait: (lignesBrutes[l - 1] ?? '').trim().slice(0, 110) });
  };
  for (const m of src.matchAll(GLYPHE)) noter(m.index, m[0], 'pictogramme');
  for (const m of src.matchAll(SEULE)) noter(m.index, m[0].match(/[←→↑↓×]/)[0], 'seul dans un élément');
  for (const m of src.matchAll(BORD_DE_LIEN)) noter(m.index, m[0].match(/[←→]/)[0], 'au bord d’un lien');
}

const parFichier = {};
for (const t of trouvailles) (parFichier[t.f] ??= []).push(t);
const tri = Object.entries(parFichier).sort((a, b) => b[1].length - a[1].length);
const detail = process.argv.includes('--detail');
for (const [f, l] of tri) {
  console.log(`${String(l.length).padStart(4)}  ${f}`);
  if (detail) for (const t of l) console.log(`        ${String(t.l).padStart(5)} ${t.signe}  [${t.regle}] ${t.extrait}`);
}
console.log(
  trouvailles.length === 0
    ? '\nAucun emoji ni glyphe servant d’icône : les icônes sont des SVG.\n'
    : `\n${trouvailles.length} icône(s) en emoji ou glyphe dans ${tri.length} fichier(s) — à remplacer par une icône lucide.\n`,
);
process.exit(trouvailles.length === 0 ? 0 : 1);
