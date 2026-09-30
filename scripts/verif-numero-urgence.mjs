#!/usr/bin/env node
/**
 * Le numéro de contact Vizyo ne doit exister QU'À UN SEUL ENDROIT.
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI CE CONTRÔLE EXISTE                                                │
 * │                                                                            │
 * │ Le 27/09/2026, l'écran « Mise à jour en cours » est parti en production     │
 * │ avec un numéro d'assistance FAUX — recopié depuis un exemple en             │
 * │ commentaire de `env.validation.ts`. Il a traversé la relecture, la          │
 * │ compilation, les tests et le déploiement sans que rien ne le retienne :     │
 * │ un numéro se relit comme du décor, l'œil vérifie la forme et pas les        │
 * │ chiffres.                                                                   │
 * │                                                                            │
 * │ Le numéro vit désormais dans `packages/shared/src/utils/contact-urgence.ts` │
 * │ — l'application ET l'API l'importent de là. Ce script interdit qu'une       │
 * │ seconde copie réapparaisse.                                                 │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ Ce contrôle ne cherche PAS « un numéro de téléphone » : les exemples de DTO
 * et les substituts de formulaire (`+33612345678`) sont légitimes et nombreux.
 * Il cherche LE numéro réel, celui qui compte, et lui seul.
 *
 *   node scripts/verif-numero-urgence.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RACINE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SOURCE = 'packages/shared/src/utils/contact-urgence.ts';
const ZONES = ['apps/web/src', 'apps/api/src', 'packages/shared/src'];
const EXTENSIONS = ['.ts', '.html'];

/** Le récit de l'incident cite le numéro fautif : un document n'est pas du code. */
const IGNORES = [/[/\\]node_modules[/\\]/, /[/\\]dist[/\\]/];

const norm = (p) => p.replace(/\\/g, '/');

function fichiers(dossier) {
  const out = [];
  let entrees;
  try { entrees = readdirSync(dossier); } catch { return out; }
  for (const e of entrees) {
    const p = join(dossier, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
      out.push(...fichiers(p));
    } else if (EXTENSIONS.some((x) => e.endsWith(x)) && !IGNORES.some((r) => r.test(p))) {
      out.push(p);
    }
  }
  return out;
}

const source = readFileSync(join(RACINE, SOURCE), 'utf8');
const affiche = (source.match(/CONTACT_TEL_AFFICHE = '([^']+)'/) ?? [])[1];
const e164 = (source.match(/CONTACT_TEL_E164 = '([^']+)'/) ?? [])[1];
if (!affiche || !e164) {
  console.error(`✗ Numéro introuvable dans ${SOURCE} — le contrôle ne peut rien garantir.`);
  process.exit(2);
}

/** Cohérence interne : les deux écritures doivent désigner le même numéro. */
const chiffres = (s) => s.replace(/\D/g, '').replace(/^33/, '0');
if (chiffres(affiche) !== chiffres(e164)) {
  console.error(`✗ Les deux écritures ne désignent pas le même numéro : « ${affiche} » vs « ${e164} ».`);
  process.exit(1);
}

/** Toutes les façons d'écrire CE numéro-là. */
const nu = chiffres(affiche);                       // 0652077038
const variantes = [
  affiche, e164, nu,
  `+33${nu.slice(1)}`,
  affiche.replace(/ /g, '.'),
  affiche.replace(/ /g, ''),
  `+33 ${nu.slice(1, 2)} ${nu.slice(2, 4)} ${nu.slice(4, 6)} ${nu.slice(6, 8)} ${nu.slice(8)}`,
];

const fautifs = [];
for (const zone of ZONES) {
  for (const f of fichiers(join(RACINE, zone))) {
    const rel = norm(f).slice(norm(RACINE).length).replace(/^\/+/, '');
    if (rel === SOURCE) continue;
    const texte = readFileSync(f, 'utf8');
    for (const [i, ligne] of texte.split('\n').entries()) {
      for (const v of variantes) {
        if (ligne.includes(v)) { fautifs.push({ rel, ligne: i + 1, v }); break; }
      }
    }
  }
}

if (fautifs.length === 0) {
  console.log(`Numéro de contact : une seule source (${affiche}), aucune copie dans le code. ✓`);
  process.exit(0);
}

console.error(`✗ Le numéro de contact est écrit en dur à ${fautifs.length} endroit(s) hors de ${SOURCE} :\n`);
for (const x of fautifs) console.error(`   ${x.rel}:${x.ligne}  →  ${x.v}`);
console.error(`
   Un numéro codé en dur ne se relit pas : le 27/09/2026 un numéro FAUX est parti
   en production par ce chemin. Importez CONTACT_TEL_AFFICHE / CONTACT_TEL_E164
   depuis @vizyo/tracky-shared.`);
process.exit(1);
