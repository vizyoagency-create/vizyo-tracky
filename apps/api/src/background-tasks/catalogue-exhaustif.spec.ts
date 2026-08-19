import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * ── LE TEST QUI EMPÊCHE UN TRAITEMENT DE TOURNER EN SILENCE ──────────────────────────
 *
 * L'écran « Traitements de fond » repose sur un catalogue écrit à la main. C'est un choix
 * assumé — `SchedulerRegistry` ignore les `setInterval` bruts et ne connaît que des noms
 * auto-générés — mais un catalogue à la main se périme dès que quelqu'un ajoute un `@Cron`
 * sans y penser. Et un traitement absent du catalogue tourne INVISIBLE : personne ne sait
 * qu'il existe, personne ne remarque qu'il s'est arrêté.
 *
 * Ce n'est pas une inquiétude théorique. Audit du 2026-08-19 : 34 `@Cron` dans le code, et il
 * en manquait un au catalogue — `scheduled-task-heartbeat`, c'est-à-dire LA SONDE QUI DÉTECTE
 * LES TRAITEMENTS SILENCIEUX. Le point aveugle le plus coûteux possible : si elle s'arrêtait,
 * plus rien ne signalait aucun arrêt, y compris le sien.
 *
 * Le test parcourt donc les sources, relève chaque fichier portant un `@Cron`, et exige que le
 * catalogue le revendique via son champ `source`. Ajouter un cron sans l'inscrire fait échouer
 * la construction — l'oubli devient impossible, il ne dépend plus de la vigilance.
 */
const RACINE = join(__dirname, '..');
const CATALOGUE = join(__dirname, 'background-tasks.service.ts');

/** Tous les fichiers `.ts` de l'API, hors tests et hors le catalogue lui-même. */
function sourcesTs(dossier: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dossier)) {
    const p = join(dossier, e);
    if (statSync(p).isDirectory()) {
      sourcesTs(p, acc);
    } else if (e.endsWith('.ts') && !e.endsWith('.spec.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Fichiers portant au moins un vrai `@Cron(` OU `@Interval(` — les mentions en commentaire ne
 * comptent pas.
 *
 * ⚠️ LES DEUX DÉCORATEURS, ET C'EST UNE LEÇON PAYÉE. La première version de ce garde ne relevait
 *    que les `@Cron`. Il annonçait donc un catalogue exhaustif alors que
 *    `missions/mission-status.service.ts` — la bascule des statuts de mission, toutes les
 *    minutes — passait au travers, déclarée en `@Interval`. Un garde qui ne couvre qu'une moitié
 *    du problème est pire qu'un garde absent : il donne la certitude que tout va bien.
 */
function fichiersPlanifies(): string[] {
  const out: string[] = [];
  for (const f of sourcesTs(RACINE)) {
    if (f === CATALOGUE) continue;
    const lignes = readFileSync(f, 'utf8').split('\n');
    const porte = lignes.some((l) => {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      return t.includes('@Cron(') || t.includes('@Interval(');
    });
    if (porte) out.push(relative(RACINE, f).split(sep).join('/'));
  }
  return out.sort();
}

/** Valeurs du champ `source` declarees au catalogue. */
function sourcesCataloguees(): Set<string> {
  const texte = readFileSync(CATALOGUE, 'utf8');
  const out = new Set<string>();
  for (const m of texte.matchAll(/source:\s*'([^']+)'/g)) out.add(m[1]!);
  return out;
}

describe('Catalogue des traitements de fond — exhaustif par construction', () => {
  it('⚠️ CHAQUE fichier portant un @Cron OU un @Interval est revendique par le catalogue', () => {
    const cataloguees = sourcesCataloguees();
    const oublies = fichiersPlanifies().filter((f) => !cataloguees.has(f));

    expect(oublies).toEqual([]);
    // Si ce test tombe : un traitement planifie a ete ajoute sans etre inscrit au catalogue de
    // `background-tasks.service.ts`. Il tournerait INVISIBLE dans /admin/background-tasks.
    // Ajouter une entree avec son `source`, sa cadence reelle et ce qu'on perd s'il s'arrete.
  });

  it('aucun `source` du catalogue ne pointe vers un fichier disparu', () => {
    // Le miroir du test precedent : une entree qui survit a la suppression de son code
    // annonce un traitement qui ne tourne plus. Un catalogue qui ment rassure a tort.
    const tous = new Set(sourcesTs(RACINE).map((f) => relative(RACINE, f).split(sep).join('/')));
    const fantomes = [...sourcesCataloguees()].filter((s) => !tous.has(s));
    expect(fantomes).toEqual([]);
  });

  it('le catalogue couvre un nombre plausible de traitements — la liste ne s’est pas videe', () => {
    // Garde-fou grossier contre une regression silencieuse du parseur ci-dessus : s'il cessait
    // de trouver les @Cron, les deux tests passeraient en ne verifiant plus rien.
    expect(fichiersPlanifies().length).toBeGreaterThanOrEqual(30);
    expect(sourcesCataloguees().size).toBeGreaterThanOrEqual(30);
  });

  it('⚠️ la sonde des taches planifiees est elle-meme catalogue', () => {
    // Le trou trouve le 2026-08-19. Nommement teste : c'est le traitement dont l'absence
    // masquerait toutes les autres absences.
    expect(sourcesCataloguees()).toContain('observability/scheduled-task-heartbeat.service.ts');
  });

  it('⚠️ la bascule des statuts de mission aussi — trouvee en etendant le garde aux @Interval', () => {
    // Second trou du 2026-08-19 : un traitement METIER, toutes les minutes, invisible. Sans lui
    // une mission resterait « planifiee » alors que le vehicule est deja parti.
    expect(sourcesCataloguees()).toContain('missions/mission-status.service.ts');
  });
});
