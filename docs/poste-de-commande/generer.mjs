#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE POSTE DE COMMANDE — une SECONDE VUE de `taches.json`, jamais une seconde liste
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Usage, depuis la racine du dépôt :
 *     node docs/poste-de-commande/generer.mjs
 *     node docs/poste-de-commande/generer.mjs --etat page-publiee.html
 *
 * ── POURQUOI CE GÉNÉRATEUR EXISTE ─────────────────────────────────────────────────────
 *
 * Le propriétaire suit son avancement sur une page publiée. La tentation était d'y recopier
 * les tâches à la main, et d'ajouter les nouvelles à chaque audit. C'est exactement ainsi
 * qu'on fabrique des doublons : deux listes du même fait finissent par diverger, et la plus
 * récemment ouverte gagne — ce qui n'est pas un critère.
 *
 * Ici, il n'y a qu'une source : `docs/centre-alerte/app/taches.json`, tenue chaque nuit par
 * l'audit du centre d'alerte, où chaque tâche porte un identifiant STABLE et JAMAIS réutilisé
 * (`T1`… pour l'application, `V0`… pour le VPS). **Un doublon est donc impossible par
 * construction** : une tâche est présente, ou absente, jamais deux fois. Le tableau de bord de
 * l'audit est la première vue de cette source ; cette page en est la seconde.
 *
 * Ce que ce fichier ajoute et qu'aucune tâche ne porte — les mesures de tête, les mécaniques
 * qui tournent seules, les décisions posées au propriétaire, ce qui est prouvé — vit dans
 * `contexte.json`, à côté.
 *
 * ── CE QUI NE DOIT JAMAIS ÊTRE PERDU ──────────────────────────────────────────────────
 *
 * Les cases que le propriétaire coche sur la page vivent dans son bloc `<script id="etat">`.
 * Régénérer sans les reprendre les effacerait. `--etat <fichier>` lit la page PUBLIÉE et
 * reporte ce bloc tel quel. Sans l'option, on repart d'un état vide : à n'utiliser que pour
 * une première génération.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const TACHES = join(ICI, '..', 'centre-alerte', 'app', 'taches.json');
const CONTEXTE = join(ICI, 'contexte.json');
const GABARIT = join(ICI, 'gabarit.html');
const SORTIE = join(ICI, 'poste-de-commande.html');

/**
 * ── LA RÉPARTITION EN QUATRE PAQUETS ──────────────────────────────────────────────────
 *
 * Une tâche tombe dans UN paquet et un seul, décidé par sa `classe`. Le propriétaire lit la
 * page pour savoir ce qui dépend de lui : ce qui demande un geste humain, un arbitrage ou une
 * action de terrain va donc ensemble, quelle que soit la nuance interne de la roadmap.
 *
 * ⚠️ Toute classe inconnue tombe dans `moi` et le générateur le DIT. Une classe qu'on
 * inventerait la nuit ne doit pas disparaître en silence de la page.
 */
const PAQUETS = {
  HUMAIN: 'toi', TERRAIN: 'toi', PRODUIT: 'toi', PREPARE: 'toi',
  A_CODER: 'moi', CHANTIER: 'moi', AUTO: 'moi', DETTE_DOC: 'moi',
  // « Guetter » et « bloqué » partagent une section : dans les deux cas il n'y a rien à faire
  // maintenant, et la pastille de droite dit laquelle des deux raisons s'applique.
  NON_EXERCE: 'guette', TEST_DATE: 'guette', BLOQUE: 'guette',
};

/** La pastille affichée à droite d'une ligne, par paquet. */
const PASTILLE = {
  toi: { l: 'toi', c: 'chip--alerte' },
  moi: { l: 'à coder', c: 'chip--accent' },
  guette: { l: 'à guetter', c: 'chip--calme' },
  bloque: { l: 'bloqué', c: 'chip--attente' },
  vps: { l: 'infra', c: 'chip--neutre' },
};

const lire = (f) => JSON.parse(readFileSync(f, 'utf8'));

function main() {
  const argEtat = process.argv.indexOf('--etat');
  const source = lire(TACHES);
  const ctx = lire(CONTEXTE);

  if (!Array.isArray(source.taches) || source.taches.length === 0) {
    throw new Error(`${TACHES} ne porte aucune tâche : rien ne sera écrasé.`);
  }

  const inconnues = new Set();
  const paquets = { toi: [], moi: [], guette: [], vps: [] };
  const faits = [];

  for (const t of source.taches) {
    // Une tâche close quitte les paquets : elle rejoint la liste de ce qui est prouvé.
    if (t.etat === 'FAIT') { faits.push(t); continue; }

    // Le VPS garde sa section : c'est l'état de la MACHINE, pas de l'application, et le
    // propriétaire les sépare dans sa tête. Une tâche n'est donc jamais dans les deux.
    if (t.partie === 'vps') { paquets.vps.push(t); continue; }

    let paquet = PAQUETS[t.classe];
    if (!paquet) { inconnues.add(t.classe); paquet = 'moi'; }
    // Déployé sans preuve : ce n'est plus à faire, c'est à guetter.
    if (t.etat === 'DEPLOYE') paquet = 'guette';
    paquets[paquet].push(t);
  }

  // Le plus grave d'abord, puis l'ordre stable de l'identifiant : deux passages successifs
  // rendent la même page si rien n'a bougé.
  const numero = (id) => parseInt(String(id).replace(/\D+/g, ''), 10) || 0;
  const trier = (a, b) => (a.gravite - b.gravite) || (numero(a.id) - numero(b.id));
  for (const k of Object.keys(paquets)) paquets[k].sort(trier);

  const enLigne = (t, paquet) => ({
    id: t.id,
    ref: t.fiche || '—',
    // Gravité 1 et 2 sont les deux crans qui bloquent quelque chose en amont : la page en
    // fait un ou deux triangles, et n'en met aucun au-delà.
    feu: t.gravite === 1 ? 2 : (t.gravite === 2 ? 1 : 0),
    quoi: t.titre,
    note: t.detail || '',
    pastille: PASTILLE[paquet],
    phare: !!t.phare,
  });

  const donnees = {
    releve: ctx.releve,
    machines: ctx.machines,
    chiffres: ctx.chiffres.map((c) => ({ ...c })),
    toi: paquets.toi.map((t) => enLigne(t, 'toi')),
    moi: paquets.moi.map((t) => enLigne(t, 'moi')),
    // La pastille dit POURQUOI il n'y a rien à faire : un prérequis manque, ou l'occasion.
    guette: paquets.guette.map((t) => ({
      id: t.id,
      quoi: t.titre,
      quand: t.classe === 'BLOQUE' ? 'bloqué' : (t.classe === 'TEST_DATE' ? 'test daté' : 'occasion'),
    })),
    vps: paquets.vps.map((t) => ({ id: t.id, quoi: t.titre })),
    decisions: ctx.decisions,
    faits: ctx.faits,
    // Les tâches closes ne sont PAS recopiées ici : leur preuve est rédigée pour l'audit,
    // longue et technique. La page en donne le compte et renvoie à la roadmap — un récit court
    // à côté d'un compte juste vaut mieux qu'une liste dupliquée qui divergera.
    faitsClos: faits.length,
    rangement: ctx.rangement,
  };

  // Les deux chiffres marqués « auto » se calculent, pour qu'ils ne puissent pas vieillir
  // séparément de la liste qu'ils résument.
  const aTraiter = donnees.toi.length + donnees.decisions.length;
  donnees.chiffres = donnees.chiffres.map((c) => {
    if (c.v !== 'auto') return c;
    return c.alerte ? { ...c, v: String(aTraiter) } : { ...c, v: String(source.taches.length) };
  });

  let page = readFileSync(GABARIT, 'utf8');
  if (!page.includes('id="donnees"')) {
    throw new Error('Le gabarit ne porte pas de bloc <script id="donnees"> : génération refusée.');
  }

  // Les cases cochées par le propriétaire, reprises telles quelles depuis la page publiée.
  let etat = '{"version":1,"taches":{},"decisions":{},"maj":null}';
  if (argEtat > -1 && process.argv[argEtat + 1]) {
    const publiee = readFileSync(process.argv[argEtat + 1], 'utf8');
    const m = publiee.match(/<script id="etat" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('Page publiée sans bloc <script id="etat"> : je refuse d’effacer les coches.');
    etat = m[1].trim();
    JSON.parse(etat); // un état illisible casse ici, pas dans le navigateur du propriétaire.
  }

  page = page
    .replace(/<script id="donnees" type="application\/json">[\s\S]*?<\/script>/,
      '<script id="donnees" type="application/json">' + JSON.stringify(donnees) + '</script>')
    .replace(/<script id="etat" type="application\/json">[\s\S]*?<\/script>/,
      '<script id="etat" type="application/json">' + etat + '</script>');

  writeFileSync(SORTIE, page, 'utf8');

  const dit = (s) => process.stdout.write(s + '\n');
  dit(`poste-de-commande.html écrit — ${source.taches.length} tâches lues`);
  dit(`  toi ${donnees.toi.length} · à coder ${donnees.moi.length} · à guetter ${donnees.guette.length}`
    + ` · VPS ${donnees.vps.length} · faites ${faits.length}`);
  dit(`  décisions ${donnees.decisions.length} · coches reprises : ${argEtat > -1 ? 'oui' : 'NON (état vide)'}`);
  if (inconnues.size) {
    dit(`  ⚠️ classes inconnues, rangées dans « à coder » : ${[...inconnues].join(', ')}`);
    dit('     Ajoute-les à PAQUETS dans ce fichier plutôt que de les laisser là.');
  }
}

main();
