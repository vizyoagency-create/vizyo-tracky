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

/**
 * Lot A6 — la modale de demande de mission et l'onglet Paramètres de `/missions`.
 *
 * Deux écrans qui affichent de l'ARGENT. Un montant qu'on lit mal se relit de travers,
 * et un devis mal relu se conteste — c'est exactement le litige que ces écrans
 * existent pour éviter. L'avertissement de borne en particulier — « 3 km de plus font
 * passer à 169 € » — est un texte de 12,5 px sur un lavis d'ambre : s'il y a un couple
 * à mesurer plutôt qu'à supposer sur ce lot, c'est celui-là.
 *
 * ⚠️ La modale vit sur `--surface-secondary` (la coque `depot-modal`) et ses encarts
 * sur `--surface-tertiary`. On mesure sur les DEUX quand le composant apparaît sur les
 * deux, et on retient la pire — jamais la plus flatteuse.
 */
function couplesDemande(t, nomTheme) {
  const fond = t['--surface-secondary'];
  const fondTertiaire = t['--surface-tertiary'] ?? fond;
  const vert = t['--color-tracky-light'];
  const succes = texte(t, nomTheme, '--texte-succes');
  const attente = texte(t, nomTheme, '--texte-attente');
  const alerte = texte(t, nomTheme, '--texte-alerte');
  const attenue = texte(t, nomTheme, '--texte-inactif');
  const secondaire = hex(t['--text-secondary']);
  const principal = hex(t['--text-primary']);
  /** Le pire des deux fonds sur lesquels l'élément peut se poser. */
  const pire = (couleur, part) =>
    [melange(couleur, fond, part), melange(couleur, fondTertiaire, part)].reduce((a, b) =>
      ratio(couleur, a) <= ratio(couleur, b) ? a : b,
    );
  return [
    // La pastille « Chargement ». Le fond est un lavis du vert de MARQUE, le texte le
    // jeton --texte-succes : le vert brut y tombait a 2,71:1 en theme clair, et c'est
    // exactement le genre d'ecart qu'on ne voit pas a l'œil sur un ecran de bureau.
    ['demande · pastille « Chargement » (succès sur teinte 16 %)', succes, pire(hex(vert), 0.16)],
    ['demande · pastille de livraison (secondaire sur surface secondaire)', secondaire, hex(fond)],
    ['demande · nom de l\'étape courante', principal, hex(fond)],
    ['demande · nom des étapes à venir', attenue, hex(fond)],
    ['demande · libellé de segment (secondaire sur tertiaire)', secondaire, hex(fondTertiaire)],
    // L'AVERTISSEMENT DE BORNE : la phrase qui evite l'appel « pourquoi le double ».
    ['demande · avertissement de borne (attente sur teinte 12 %)', attente, pire(attente, 0.12)],
    ['demande · montant TTC du devis', principal, melange(hex(vert), fond, 0.1)],
    ['demande · détail HT et TVA du devis', secondaire, melange(hex(vert), fond, 0.1)],
    ['demande · bandeau permanent (secondaire sur teinte 9 %)', secondaire, melange(hex(vert), fond, 0.09)],
    ['demande · demande fermée, faute de grille', attente, melange(attente, fond, 0.1)],
    ['demande · créneau incohérent', alerte, hex(fond)],
    ['demande · aide sur le retour au dépôt', attenue, hex(fond)],
  ];
}

/**
 * L'onglet Paramètres de `/missions` — l'éditeur de tranches et son simulateur.
 *
 * Il vit sur `--bg-secondary` / `--fg-*`, la famille de l'espace TRANSPORTEUR, et non
 * sur les jetons du dépôt. Ses couples n'avaient jamais été mesurés : c'est la dette
 * n° 1 du lot A6, ouverte depuis la tranche T3.
 */
function couplesTarifs(t) {
  const fond = t['--bg-secondary'] ?? t['--surface-secondary'];
  const fondPrimaire = t['--bg-primary'] ?? t['--surface-primary'] ?? fond;
  const secondaire = hex(t['--fg-secondary'] ?? t['--text-secondary']);
  return [
    ['tarifs · titre de bloc', hex(t['--fg-primary'] ?? t['--text-primary']), hex(fond)],
    // Ces deux-la passaient en --fg-tertiary : 3,16:1 en clair, 3,75:1 en sombre. Ils
    // sont repasses en --fg-secondary. Les laisser mesures ici est le seul moyen qu'un
    // futur allegement du jeton ne les fasse pas retomber en silence.
    ['tarifs · texte d\'aide', secondaire, hex(fond)],
    ['tarifs · en-tête de colonne', secondaire, hex(fond)],
    ['tarifs · unité du simulateur', secondaire, hex(fond)],
    ['tarifs · mention « facultatif »', secondaire, hex(fond)],
    ['tarifs · libellé de champ', secondaire, hex(fond)],
    // Les champs de saisie posent leur propre fond, plus sombre que le bloc.
    ['tarifs · valeur saisie dans une tranche', hex(t['--fg-primary'] ?? t['--text-primary']), hex(fondPrimaire)],
  ];
}

/**
 * Lot A6 — LE FIL DE NÉGOCIATION, et la file d'attente du transporteur.
 *
 * ⚠️ Le fil est le SEUL composant du produit rendu dans les DEUX espaces : celui du
 * dépôt (`--surface-*`) et celui du transporteur (`--bg-*`). Comme les seconds sont des
 * alias des premiers, une seule mesure vaut pour les deux — mais c'est précisément
 * pourquoi ce composant ne doit consommer AUCUN jeton `--depot-*` : ceux-là sont
 * définis sous `.layout--depot` et n'existent pas côté transporteur. Une variable
 * absente ne casse rien de visible : la couleur retombe sur l'héritage, et ce script
 * continuerait de mesurer un jeton que l'écran n'applique pas.
 */
function couplesNegociation(t, nomTheme) {
  const fond = t['--surface-secondary'];
  const fondTertiaire = t['--surface-tertiary'] ?? fond;
  const vert = t['--color-tracky-light'];
  const succes = texte(t, nomTheme, '--texte-succes');
  const attente = texte(t, nomTheme, '--texte-attente');
  const alerte = texte(t, nomTheme, '--texte-alerte');
  const attenue = texte(t, nomTheme, '--texte-inactif');
  const secondaire = hex(t['--text-secondary']);
  const principal = hex(t['--text-primary']);
  return [
    // Les trois bandeaux d'etat : le badge se pose sur un lavis a 10 % de sa teinte.
    ['fil · état « accord conclu »', succes, melange(hex(vert), fond, 0.1)],
    ['fil · état « en négociation »', attente, melange(attente, fond, 0.1)],
    ['fil · état « refusée ou expirée »', alerte, melange(alerte, fond, 0.1)],
    ['fil · phrase d\'état', secondaire, melange(attente, fond, 0.1)],
    // Le fil lui-meme.
    ['fil · auteur d\'un tour', secondaire, hex(fond)],
    ['fil · horodatage d\'un tour', attenue, hex(fond)],
    ['fil · montant d\'un tour', principal, hex(fond)],
    ['fil · message d\'un tour', secondaire, hex(fond)],
    // Le devis fige, sur son lavis vert.
    ['fil · intitulé du devis figé', attenue, melange(hex(vert), fond, 0.08)],
    ['fil · total TTC du devis figé', principal, melange(hex(vert), fond, 0.08)],
    ['fil · libellés du devis figé', principal, melange(hex(vert), fond, 0.08)],
    // Les gestes.
    ['fil · bouton « Refuser »', alerte, hex(fondTertiaire)],
    ['fil · « la balle est dans l\'autre camp »', attente, melange(attente, fond, 0.1)],
    ['fil · aide de contre-proposition', secondaire, hex(fond)],
    // La file du transporteur : memes jetons, fond --bg-* (alias de --surface-*).
    ['file · badge « en négociation »', attente, hex(fondTertiaire)],
    ['file · badge « accord conclu »', succes, hex(fondTertiaire)],
    ['file · badge « refusée »', alerte, hex(fondTertiaire)],
    ['file · ancienneté d\'une demande', secondaire, hex(fond)],
    ['file · dépôt et créneau', secondaire, hex(fond)],
    ['file · pastille « en attente de vous »', attente, melange(attente, fond, 0.14)],
  ];
}

/**
 * Lot A6 — LA TRAÇABILITÉ DES TOURNÉES : la modale d'édition du transporteur, et la
 * ligne « tournée modifiée » que lit le dépôt.
 *
 * Ces deux écrans annoncent un ÉCART DE PRIX. Un montant qu'on lit mal se relit de
 * travers, et un montant mal relu se conteste — c'est très exactement le litige que
 * cette fonctionnalité existe pour éviter.
 */
function couplesTracabilite(t, nomTheme) {
  const fond = t['--surface-secondary'];
  const fondTertiaire = t['--surface-tertiary'] ?? fond;
  const vert = t['--color-tracky-light'];
  const succes = texte(t, nomTheme, '--texte-succes');
  const attente = texte(t, nomTheme, '--texte-attente');
  const attenue = texte(t, nomTheme, '--texte-inactif');
  const secondaire = hex(t['--text-secondary']);
  const principal = hex(t['--text-primary']);
  return [
    // La modale du transporteur.
    ['tournée · pastille « Chargement »', succes, melange(hex(vert), fondTertiaire, 0.16)],
    ['tournée · aide sous les champs', attenue, hex(fond)],
    ['tournée · écart de prix annoncé', secondaire, hex(fondTertiaire)],
    ['tournée · écart en hausse (attente sur teinte 12 %)', attente, melange(attente, fond, 0.12)],
    // Le journal.
    ['journal · titre d\'une révision', principal, hex(fondTertiaire)],
    ['journal · auteur et motif', secondaire, hex(fondTertiaire)],
    ['journal · horodatage', attenue, hex(fondTertiaire)],
    ['journal · montant de la révision', principal, hex(fondTertiaire)],
    // Ce que le depot lit sur sa carte.
    ['dépôt · « tournée modifiée » (attente sur teinte 11 %)', attente, melange(attente, fond, 0.11)],
    ['dépôt · montant dans « tournée modifiée »', principal, melange(attente, fond, 0.11)],
  ];
}

const SECTIONS = [
  ['Espace dépôt', couplesDepot],
  ['Badge de présence', couplesBadge],
  ['Rejeu de trajet', couplesRejeu],
  ['Bulles de carte', couplesBulle],
  ['Demande de mission (A6)', couplesDemande],
  ['Négociation (A6)', couplesNegociation],
  ['Traçabilité des tournées (A6)', couplesTracabilite],
  ['Grille tarifaire (A6)', couplesTarifs],
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
