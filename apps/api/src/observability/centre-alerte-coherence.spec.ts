import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ── LE TEST QUI EMPÊCHE LES STATUTS DE MENTIR ────────────────────────────────────────
 *
 * Le centre d'alerte décrit chaque défaut sur TROIS surfaces, et une seule est lue par
 * l'exploitant selon l'endroit où il regarde :
 *
 *   1. l'INDEX de `REFERENCE-ERREURS.md`  — la table de tête, tenue par les audits ;
 *   2. l'EN-TÊTE de la fiche elle-même     — `**Statut : …**`, écrit à la CRÉATION ;
 *   3. `app/wiki.json`                     — le manifeste servi à `/admin/centre-alerte`.
 *
 * Aucune n'est dérivée d'une autre. Elles n'ont donc aucune raison mécanique de s'accorder,
 * et le 2026-08-25 elles ne s'accordaient plus : **18 en-têtes de fiche sur 50 contredisaient
 * les deux autres surfaces**. Le mécanisme est banal et c'est ce qui le rend durable — quand
 * un correctif arrive, on pose une SECTION DATÉE sous la fiche ; l'en-tête, lui, n'est jamais
 * retouché. Il reste figé à la rédaction initiale, parfois plusieurs semaines.
 *
 * Ce que ça coûte, mesuré ce jour-là : TRK-021 était faux DANS LES DEUX SENS (l'index disait
 * « non corrigé » alors que le correctif était en production, le manifeste disait « corrigé »
 * alors que rien ne l'avait jamais exercé) ; TRK-027 était annoncé corrigé alors que rien
 * n'avait été corrigé. Un statut faux ne fait pas perdre du temps : il fait PRENDRE UNE
 * DÉCISION FAUSSE — on ne rouvre pas une fiche qu'on croit close.
 *
 * Rectifier à la main ne tient pas : l'écart revient à la passe de correction suivante. Ce
 * test fait donc ÉCHOUER LA CONSTRUCTION dès que les trois surfaces divergent, sur le modèle
 * exact du catalogue des traitements de fond (`background-tasks/catalogue-exhaustif.spec.ts`),
 * qui a rendu impossible l'oubli d'un `@Cron`.
 *
 * ⚠️ IL NE JUGE PAS QUI A RAISON. Il exige seulement qu'on ne puisse pas publier trois
 *    réponses différentes à la même question. Trancher reste un acte humain, adossé au code
 *    déployé et à la mesure — jamais à une autre fiche.
 */
const RACINE_DOCS = join(__dirname, '..', '..', '..', '..', 'docs', 'centre-alerte');
const REFERENCE = join(RACINE_DOCS, 'REFERENCE-ERREURS.md');
const MANIFESTE = join(RACINE_DOCS, 'app', 'wiki.json');

function lire(chemin: string): string {
  return readFileSync(chemin, 'utf8').replace(/\r\n/g, '\n');
}

interface FicheManifeste {
  id: string;
  statut: string;
  ancre?: string;
}
interface Manifeste {
  statuts: { cle: string; puce: string }[];
  fiches: FicheManifeste[];
}

function manifeste(): Manifeste {
  return JSON.parse(lire(MANIFESTE)) as Manifeste;
}

/**
 * Correspondance puce → clé de statut, lue DANS LE MANIFESTE et non codée en dur.
 *
 * C'est délibéré : le vocabulaire des statuts est déjà déclaré une fois, à la racine de
 * `wiki.json`, et l'écran d'administration s'en sert pour afficher les libellés. Le dupliquer
 * ici créerait une QUATRIÈME surface à tenir d'accord — exactement le défaut que ce fichier
 * existe pour empêcher.
 */
function vocabulaire(): Map<string, string> {
  return new Map(manifeste().statuts.map((s) => [s.puce, s.cle]));
}

/** Clé du PREMIER statut cité dans un texte, ou `null`. */
function statutCite(texte: string, voc: Map<string, string>): string | null {
  let meilleur = -1;
  let cle: string | null = null;
  for (const [puce, c] of voc) {
    const i = texte.indexOf(puce);
    if (i !== -1 && (meilleur === -1 || i < meilleur)) {
      meilleur = i;
      cle = c;
    }
  }
  return cle;
}

/**
 * Lignes de l'INDEX, c'est-à-dire de `## Index` jusqu'à la première fiche.
 *
 * ⚠️ LE DÉCOUPAGE NAÏF EST FAUX, ET C'EST UNE LEÇON PAYÉE. Le document contient CINQ AUTRES
 *    tables citant des `[TRK-0xx]` avant la première fiche — les « tests datés » des anciens
 *    rapports. Un parseur qui prendrait « tout ce qui précède la première fiche » lirait le
 *    statut d'un relevé vieux de dix jours en croyant lire l'index.
 */
function lignesIndex(): string[] {
  const lignes = lire(REFERENCE).split('\n');
  const debut = lignes.findIndex((l) => l.startsWith('## Index'));
  const fin = lignes.findIndex((l) => /^## TRK-\d+\s*$/.test(l));
  if (debut === -1 || fin === -1 || fin <= debut) {
    throw new Error(
      `Structure de REFERENCE-ERREURS.md inattendue : "## Index" en ${debut}, 1re fiche en ${fin}. ` +
        `Le garde de cohérence ne sait plus où regarder — corriger le parseur, pas le document.`,
    );
  }
  return lignes.slice(debut, fin).filter((l) => /^\| \[TRK-\d+\]/.test(l));
}

/** Les cellules d'une ligne de table, bords vides retirés. */
function cellules(ligne: string): string[] {
  return ligne
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

/**
 * Cellules de statut d'une ligne d'index : celles qui COMMENCENT par une puce de statut.
 *
 * ⚠️ ON NE COMPTE PAS LES COLONNES. Une ligne d'index sur 50 contient un `|` à l'intérieur de
 *    son propre texte : `cellules()[3]` y désigne autre chose que le statut. On ne cherche pas
 *    non plus « la première puce de la ligne », car une signature peut en citer une. La règle
 *    retenue survit aux deux pièges — et le test ci-dessous vérifie qu'elle rend bien UNE
 *    réponse par ligne, faute de quoi il échoue au lieu de deviner.
 */
function cellulesDeStatut(ligne: string, voc: Map<string, string>): string[] {
  return cellules(ligne).filter((c) => [...voc.keys()].some((p) => c.startsWith(p)));
}

function statutsIndex(voc: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const ligne of lignesIndex()) {
    const id = /^\| \[(TRK-\d+)\]/.exec(ligne)![1]!;
    const cible = cellulesDeStatut(ligne, voc)[0];
    if (cible) out.set(id, statutCite(cible, voc)!);
  }
  return out;
}

/**
 * Statut lu sur l'EN-TÊTE de chaque fiche — la ligne `**Statut : …` qui suit son titre.
 *
 * On lit la PREMIÈRE puce de la ligne : depuis la rectification du 25/08, un en-tête rectifié
 * cite aussi son ancien statut (« Ancien en-tête : « 🔴 … » »), volontairement conservé en
 * clair. Ce rappel vient toujours APRÈS le statut courant.
 */
function statutsCorps(voc: Map<string, string>): Map<string, string> {
  const lignes = lire(REFERENCE).split('\n');
  const out = new Map<string, string>();
  for (let i = 0; i < lignes.length; i++) {
    const m = /^## (TRK-\d+)\s*$/.exec(lignes[i]!);
    if (!m) continue;
    for (let j = i + 1; j < Math.min(i + 25, lignes.length); j++) {
      if (lignes[j]!.startsWith('**Statut')) {
        const cle = statutCite(lignes[j]!, voc);
        if (cle) out.set(m[1]!, cle);
        break;
      }
    }
  }
  return out;
}

function statutsManifeste(): Map<string, string> {
  return new Map(manifeste().fiches.map((f) => [f.id, f.statut]));
}

/** Rend les écarts lisibles dans le rapport d'échec, plutôt qu'un diff de deux Map. */
function divergences(): string[] {
  const voc = vocabulaire();
  const [idx, corps, wiki] = [statutsIndex(voc), statutsCorps(voc), statutsManifeste()];
  const tous = [...new Set([...idx.keys(), ...corps.keys(), ...wiki.keys()])].sort();
  return tous
    .filter((id) => new Set([idx.get(id), corps.get(id), wiki.get(id)]).size !== 1)
    .map(
      (id) =>
        `${id} : index=${idx.get(id) ?? 'ABSENT'} | en-tête=${corps.get(id) ?? 'ABSENT'} | manifeste=${wiki.get(id) ?? 'ABSENT'}`,
    );
}

describe("Centre d'alerte — les trois surfaces disent le même statut", () => {
  it('⚠️ aucune fiche n’annonce deux statuts différents selon où on la lit', () => {
    expect(divergences()).toEqual([]);
    // Si ce test tombe : une fiche a été corrigée quelque part sans l'être partout. Trancher
    // par le CODE DÉPLOYÉ (`git merge-base --is-ancestor <pr> HEAD`) et par la MESURE en base,
    // jamais par une autre fiche — puis aligner les trois. Conserver l'ancien libellé en clair.
  });

  it('les trois surfaces couvrent exactement les mêmes fiches', () => {
    const voc = vocabulaire();
    const [idx, corps, wiki] = [statutsIndex(voc), statutsCorps(voc), statutsManifeste()];
    // Une fiche rédigée mais absente de l'index est invisible ; présente à l'index sans corps,
    // son lien de navigation ne mène nulle part ; absente du manifeste, l'écran d'admin l'ignore.
    expect([...corps.keys()].filter((id) => !idx.has(id))).toEqual([]);
    expect([...idx.keys()].filter((id) => !corps.has(id))).toEqual([]);
    expect([...idx.keys()].filter((id) => !wiki.has(id))).toEqual([]);
    expect([...wiki.keys()].filter((id) => !idx.has(id))).toEqual([]);
  });

  it('⚠️ chaque ligne d’index porte EXACTEMENT une cellule de statut', () => {
    const voc = vocabulaire();
    const anomalies = lignesIndex()
      .map((l) => ({ id: /^\| \[(TRK-\d+)\]/.exec(l)![1]!, n: cellulesDeStatut(l, voc).length }))
      .filter((x) => x.n !== 1);
    expect(anomalies).toEqual([]);
    // C'est CE test qui rend les précédents dignes de foi. S'il tombe, le parseur ne sait plus
    // quelle cellule est le statut : il pourrait en lire un faux — ou n'en lire aucun et
    // déclarer tout le monde d'accord. Un garde qui ne trouve rien passe toujours.
  });

  it('aucun statut illisible : chaque fiche est cotée sur ses trois surfaces', () => {
    const voc = vocabulaire();
    const [idx, corps, wiki] = [statutsIndex(voc), statutsCorps(voc), statutsManifeste()];
    const inconnus = [...wiki.values()].filter((s) => ![...voc.values()].includes(s));
    expect(inconnus).toEqual([]); // un `statut` hors vocabulaire ne s'afficherait nulle part
    expect(idx.size).toBe(lignesIndex().length);
    expect(corps.size).toBe(idx.size);
  });

  it('le document couvre un nombre plausible de fiches — rien ne s’est vidé', () => {
    // Garde-fou grossier contre une régression silencieuse des parseurs ci-dessus : s'ils
    // cessaient de trouver les fiches, tous les tests passeraient sans plus rien vérifier.
    expect(vocabulaire().size).toBeGreaterThanOrEqual(4);
    expect(lignesIndex().length).toBeGreaterThanOrEqual(45);
    expect(statutsManifeste().size).toBeGreaterThanOrEqual(45);
  });

  it('chaque ancre du manifeste pointe vers le titre réel de sa fiche', () => {
    // L'écran d'admin ouvre la fiche par cette ancre. Une ancre fausse ne casse rien de visible
    // à la construction : elle mène l'exploitant sur une page vide, le jour où il enquête.
    const texte = lire(REFERENCE);
    const perdues = manifeste()
      .fiches.filter((f) => f.ancre && f.ancre !== f.id.toLowerCase())
      .map((f) => f.id);
    expect(perdues).toEqual([]);
    expect(manifeste().fiches.filter((f) => !texte.includes(`## ${f.id}\n`))).toEqual([]);
  });

  it('aucun identifiant en double, ni à l’index ni au manifeste', () => {
    // Deux lignes pour le même TRK, et l'une des deux se périme sans que personne la voie.
    const ids = lignesIndex().map((l) => /^\| \[(TRK-\d+)\]/.exec(l)![1]!);
    expect(ids.length).toBe(new Set(ids).size);
    const idsWiki = manifeste().fiches.map((f) => f.id);
    expect(idsWiki.length).toBe(new Set(idsWiki).size);
  });
});
