#!/usr/bin/env node
/**
 * Lot B-kit — « une modale de danger doit nommer ce qui est perdu ».
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI UN CONTRÔLE ET PAS UNE CONVENTION                                 │
 * │                                                                            │
 * │ La règle vient de `Kit Partage Refonte` : « une modale danger doit nommer  │
 * │ ce qui est perdu, chiffres compris. "Êtes-vous sûr ?" seul est interdit. » │
 * │                                                                            │
 * │ Une règle de ce genre ne tient pas toute seule : la modale SANS conséquence│
 * │ fonctionne parfaitement — elle s'ouvre, elle se ferme, elle supprime. Rien │
 * │ ne signale le manque, sauf l'utilisateur qui a supprimé 3 412 trajets sans │
 * │ savoir qu'ils existaient. Le contrôle rend l'oubli visible au moment où on │
 * │ l'écrit, pas au moment où il coûte.                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Trois vérifications :
 *   1. `[danger]` ou `[critique]` sans `[consequences]` → refusé.
 *   2. un `confirmLabel` vide de verbe (« OK », « Oui », « Valider ») → refusé.
 *   3. `[critique]` sans `[confirmationAttendue]` → refusé (le 3ᵉ marqueur manque).
 *
 *   node scripts/verif-confirmations.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RACINE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CIBLE = join(RACINE, 'apps', 'web', 'src');

/** Libellés qui ne disent pas ce que le bouton fait. */
const SANS_VERBE = ['ok', 'oui', 'valider', 'continuer', 'confirmer', 'd\'accord'];

const fichiers = [];
function marche(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'node_modules' && e !== 'dist') marche(p); }
    else if (/\.(ts|html)$/.test(e) && !/\.spec\.ts$/.test(e)) fichiers.push(p);
  }
}
marche(CIBLE);

const anomalies = [];
for (const f of fichiers) {
  const src = readFileSync(f, 'utf8');
  const rel = f.replace(/\\/g, '/').replace(RACINE.replace(/\\/g, '/'), '').replace(/^\//, '');
  const debuts = [];
  let acc = 0;
  for (const l of src.split('\n')) { debuts.push(acc); acc += l.length + 1; }
  const ligneDe = (i) => { let k = 0; while (k + 1 < debuts.length && debuts[k + 1] <= i) k += 1; return k + 1; };

  // Chaque balise <app-confirm-modal …> jusqu'à son premier '>' hors guillemets.
  for (const m of src.matchAll(/<app-confirm-modal\b([\s\S]*?)(?:\/>|>)/g)) {
    const attrs = m[1];
    const l = ligneDe(m.index);
    const a = (nom) => new RegExp(`\\[?${nom}\\]?\\s*=`).test(attrs);
    // `[danger]="false"` ne compte pas : on cherche un danger réellement posé.
    const dangerPose = /\[danger\]\s*=\s*"(?!false)/.test(attrs) || /\bdanger\b(?!\s*\])/.test(attrs.replace(/\[danger\]\s*=\s*"[^"]*"/g, ''));
    const critiquePose = /\[?critique\]?\s*=\s*"(?!false)/.test(attrs);

    if ((dangerPose || critiquePose) && !a('consequences')) {
      anomalies.push({ rel, l, quoi: 'danger sans [consequences] — « ce qui est perdu » n\'est pas nommé' });
    }
    if (critiquePose && !a('confirmationAttendue')) {
      anomalies.push({ rel, l, quoi: 'critique sans [confirmationAttendue] — le 3ᵉ marqueur manque' });
    }
    const lab = attrs.match(/confirmLabel\]?\s*=\s*"'?([^"']+)'?"/);
    if (lab && SANS_VERBE.includes(lab[1].trim().toLowerCase())) {
      anomalies.push({ rel, l, quoi: `confirmLabel « ${lab[1].trim()} » ne dit pas ce que le bouton fait` });
    }
  }
}

for (const a of anomalies) console.log(`  ${a.rel}:${a.l}\n      ${a.quoi}`);
console.log(
  anomalies.length === 0
    ? '\nToutes les confirmations nomment ce qui est perdu.\n'
    : `\n${anomalies.length} confirmation(s) à compléter.\n`,
);
process.exit(anomalies.length === 0 ? 0 : 1);
