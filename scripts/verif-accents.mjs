#!/usr/bin/env node
/**
 * Lot B0′ — « accents perdus ». Cherche les mots français écrits sans accent
 * dans les CHAÎNES AFFICHÉES (design/B0-SOCLE.md § « Accents perdus »).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI UN SCRIPT ET PAS UNE RELECTURE                                    │
 * │                                                                            │
 * │ « Pret a piloter votre flotte ? » se relit sans broncher : l'œil corrige    │
 * │ tout seul. C'est un motif récurrent du projet — il est réapparu dans        │
 * │ l'assistant, dans les e-mails et dans les messages d'erreur, à des mois     │
 * │ d'intervalle. Un contrôle qui tourne est le seul moyen de ne pas le         │
 * │ repayer une quatrième fois.                                                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ LE PIÈGE DU `\b` : en JavaScript, `\b` est ASCII. Dans « paramètres », le
 * `è` compte comme une non-lettre, donc `\btres\b` MATCHE la fin du mot — un
 * texte parfaitement accentué se fait signaler. On borne donc sur des lettres
 * Unicode : `(?<!\p{L})mot(?!\p{L})`.
 *
 * Ne sont inspectés que les contextes où une chaîne est vue par un humain :
 * message d'exception, toast, sujet d'e-mail, libellé, texte de gabarit. Les
 * identifiants (`role`, `depot`, `detail`) et les journaux techniques sont hors
 * périmètre — accentuer une clé d'objet casserait le code.
 *
 *   node scripts/verif-accents.mjs           → le compte par fichier
 *   node scripts/verif-accents.mjs --detail  → chaque occurrence
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RACINE = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CIBLES = ['apps/api/src', 'apps/web/src', 'packages/shared/src'];

/**
 * Formes sans accent dont l'orthographe française EXIGE un accent, quel que soit
 * le sens. Les mots ambigus en sont volontairement absents : « active », « annule »
 * ou « modifie » sont des verbes valides sans accent, les signaler dresserait une
 * liste que personne ne relirait.
 */
const MOTS = [
  'vehicule', 'vehicules', 'evenement', 'evenements', 'securite', 'securise',
  'activite', 'activites', 'verification', 'verifications', 'verifie', 'verifiee',
  'verifier', 'telephone', 'telecharger', 'telechargement', 'deja', 'tres', 'apres',
  'etre', 'etes', 'ete', 'systeme', 'systemes', 'probleme', 'problemes',
  'parametre', 'parametres', 'reglage', 'reglages', 'numero', 'numeros',
  'periode', 'periodes', 'journee', 'annee', 'annees', 'donnees',
  'acces', 'succes', 'echec', 'echecs', 'arret', 'arrets', 'controle', 'controles',
  'cout', 'couts', 'duree', 'durees', 'etat', 'etats', 'demarrage', 'demarrer',
  'envoye', 'envoyee', 'recu', 'recue', 'creee', 'creer', 'creation',
  'operation', 'operations', 'generation', 'resultat', 'resultats',
  'energie', 'immediat', 'immediatement', 'necessaire', 'necessaires',
  'reservation', 'reservations', 'depot', 'depots', 'detail', 'details',
  'interet', 'maniere', 'premiere', 'derniere', 'aout', 'decembre', 'fevrier',
  'selectionne', 'selectionner', 'selectionnez', 'desactive', 'desactiver', 'desactivee',
  'meme', 'memes', 'cle', 'cles', 'protege', 'protegee', 'reussi', 'echoue',
  'degrade', 'delai', 'delais', 'experience', 'prenom', 'modele', 'modeles',
  'gerer', 'ulterieurement', 'collegue', 'collegues', 'reel', 'reelle',
  'pret', 'prete', 'numerique', 'frequence', 'boitier', 'boitiers',
  'repondre', 'repondu', 'hebergees', 'apercu',
  // Participes féminins : aucune forme française ne finit en « -ee » sans accent.
  'acceptee', 'terminee', 'annulee', 'echouee', 'refusee', 'activee', 'detectee',
  'configuree', 'associee', 'enregistree', 'expiree', 'validee', 'utilisee',
  'supprimee', 'modifiee', 'ajoutee', 'entree', 'entrees', 'arrivee', 'creee',
  'partagees', 'perimetre', 'caracteres', 'requete', 'requetes', 'echeance', 'echeances',
];

/** Contextes où une chaîne finit sous les yeux de quelqu'un. */
const CONTEXTES = [
  ['exception', /(?:Exception|Error)\(\s*(?:`([^`]+)`|'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")/g],
  ['toast', /\.(?:success|error|info|warn)\(\s*(?:`([^`]+)`|'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")/g],
  ['sujet', /subject\s*[:=]\s*(?:`([^`]+)`|'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")/g],
  ['message', /\bmessage:\s*(?:`([^`]+)`|'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")/g],
  ['libellé', /\b(?:label|title|titre|placeholder|description|resume|hint)\s*[:=]\s*(?:`([^`]+)`|'((?:[^'\\]|\\.)+)'|"((?:[^"\\]|\\.)+)")/g],
  ['gabarit', />\s*([A-Za-zÀ-ÿ][^<>{}]{6,})</g],
];

/**
 * Faux positifs assumés : du CODE que les motifs de contexte attrapent malgré tout.
 * `permissions-resolver` cite une règle en commentaire au milieu d'une signature, et
 * `depot-documents` expose un signal `donnees()` dans une expression de gabarit. Les
 * lister ici les rend visibles plutôt que de détendre un motif — et si la ligne bouge,
 * le contrôle redevient bavard, ce qui est le bon comportement.
 */
const TOLERES = new Set([
  'apps/api/src/permissions/permissions-resolver.service.ts|requete',
  'apps/web/src/app/features/depot/depot-documents.component.ts|donnees',
  // Signal `evenements()` du rejeu de trajet : un identifiant, jamais affiche.
  // Le commentaire francais qui le suit, lui, est bien accentue.
  'apps/web/src/app/features/reports/trip-replay.component.ts|evenements',
]);

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
 * Bornes Unicode, pas `\b` — cf. le piège documenté en tête de fichier. Le `_` est
 * exclu des deux côtés : `reservations_manage` est un nom de permission cité dans une
 * phrase, pas un mot français à accentuer. L'accentuer casserait le code.
 */
const motif = new RegExp(`(?<![\\p{L}_])(${MOTS.join('|')})(?![\\p{L}_])`, 'gu');

const trouvailles = [];
for (const f of fichiers) {
  const src = readFileSync(f, 'utf8');
  const rel = f.replace(/\\/g, '/').replace(RACINE.replace(/\\/g, '/'), '').replace(/^\//, '');
  const debuts = [];
  let acc = 0;
  for (const l of src.split('\n')) { debuts.push(acc); acc += l.length + 1; }
  const ligneDe = (i) => { let k = 0; while (k + 1 < debuts.length && debuts[k + 1] <= i) k += 1; return k + 1; };

  for (const [ctx, re] of CONTEXTES) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const s = m[1] ?? m[2] ?? m[3] ?? '';
      if (!s || !/\s/.test(s)) continue;                       // un seul mot : identifiant
      if (/^[a-z0-9 _-]+$/.test(s) && !/[.,!?']/.test(s)) continue; // classes CSS
      /**
       * On NEUTRALISE les interpolations avant de chercher : `${entree.originLabel}`
       * n'est pas du texte, c'est du code au milieu du texte. Accentuer `entree` y
       * renomme une variable — le typecheck l'attrape, mais seulement si quelqu'un le
       * lance ; une occurrence dans un gabarit Angular, elle, ne casse qu'à l'exécution.
       */
      const texte = s.replace(/\$\{[^}]*\}/g, ' ');
      for (const w of texte.matchAll(motif)) {
        if (TOLERES.has(`${rel}|${w[1]}`)) continue;
        trouvailles.push({ f: rel, l: ligneDe(m.index), ctx, mot: w[1], extrait: s.replace(/\s+/g, ' ').trim().slice(0, 100) });
      }
    }
  }
}

const vus = new Set();
const uniques = trouvailles.filter((t) => {
  const k = `${t.f}|${t.l}|${t.mot}|${t.extrait}`;
  if (vus.has(k)) return false;
  vus.add(k);
  return true;
});

const parFichier = {};
for (const t of uniques) (parFichier[t.f] ??= []).push(t);
const tri = Object.entries(parFichier).sort((a, b) => b[1].length - a[1].length);
const detail = process.argv.includes('--detail');
for (const [f, l] of tri) {
  console.log(`${String(l.length).padStart(4)}  ${f}`);
  if (detail) for (const t of l) console.log(`        ${String(t.l).padStart(5)} [${t.ctx}] ${t.mot} « ${t.extrait} »`);
}
console.log(
  uniques.length === 0
    ? '\nAucun mot français sans accent dans les chaînes affichées.\n'
    : `\n${uniques.length} occurrence(s) dans ${tri.length} fichier(s).\n`,
);
process.exit(uniques.length === 0 ? 0 : 1);
