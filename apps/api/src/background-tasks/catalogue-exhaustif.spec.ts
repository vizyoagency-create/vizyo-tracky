import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BackgroundTasksResponse } from '@vizyo/tracky-shared';
import { BackgroundTasksService } from './background-tasks.service';

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
 * Le test parcourt donc les sources, relève chaque `@Cron` et chaque `@Interval`, et exige que le
 * catalogue en porte AUTANT d'entrées pour ce fichier, via son champ `source`. Ajouter un cron sans
 * l'inscrire fait échouer la construction — l'oubli devient impossible, il ne dépend plus de la
 * vigilance. (Jusqu'au 2026-10-05, il comptait les FICHIERS : voir `decorateursParFichier`.)
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

type Genre = 'cron' | 'interval';

/**
 * Les DÉCORATEURS réels de chaque fichier — `@Cron(` et `@Interval(` hors commentaires, comptés
 * un par un.
 *
 * ⚠️ TROISIÈME TROU DU MÊME GARDE (2026-10-05). Raisonner par fichier (`fichiersPlanifies`) voit un
 *    fichier oublié, jamais un SECOND traitement dans un fichier déjà revendiqué. Deux crons du
 *    coupe-circuit sont passés ainsi : `drainAutomaticCutQueue` (schedule-cron, toutes les 10 s) et
 *    `processPendingRestores` (engine-control, toutes les 15 s) — le filet des reprises moteur.
 *    L'écran affichait le bon diagnostic, « 51 crons au runtime, 49 au catalogue », sans que rien ne
 *    dise lesquels. Le même trou avait déjà caché le second cron de sms-heartbeat (2026-08-21).
 */
function decorateursParFichier(): Map<string, Record<Genre, number>> {
  const out = new Map<string, Record<Genre, number>>();
  for (const f of sourcesTs(RACINE)) {
    if (f === CATALOGUE) continue;
    const n: Record<Genre, number> = { cron: 0, interval: 0 };
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      n.cron += t.split('@Cron(').length - 1;
      n.interval += t.split('@Interval(').length - 1;
    }
    if (n.cron + n.interval > 0) out.set(relative(RACINE, f).split(sep).join('/'), n);
  }
  return out;
}

function totalDecorateurs(): Record<Genre, number> {
  const total: Record<Genre, number> = { cron: 0, interval: 0 };
  for (const n of decorateursParFichier().values()) {
    total.cron += n.cron;
    total.interval += n.interval;
  }
  return total;
}

/**
 * Les entrées du catalogue, lues dans son TEXTE comme le reste de ce garde : une par objet de
 * premier niveau du tableau `CATALOG` — toutes s'ouvrent par « { » seul, indenté de deux espaces.
 */
function entreesCataloguees(): { id: string; source: string | null; kind: string; externe: boolean }[] {
  const texte = readFileSync(CATALOGUE, 'utf8');
  const debut = texte.indexOf('const CATALOG: CatalogEntry[] = [');
  const fin = texte.indexOf('\n];', debut);
  if (debut < 0 || fin < 0) throw new Error('tableau CATALOG introuvable dans background-tasks.service.ts');
  return texte
    .slice(debut, fin)
    .split(/\n {2}\{\r?\n/)
    .slice(1)
    .map((bloc) => ({
      id: /\bid:\s*'([^']+)'/.exec(bloc)?.[1] ?? '?',
      source: /\bsource:\s*'([^']+)'/.exec(bloc)?.[1] ?? null,
      kind: /\bkind:\s*'([^']+)'/.exec(bloc)?.[1] ?? '?',
      externe: /\bexterne:\s*'/.test(bloc),
    }));
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

  /**
   * ── LE MEME GARDE POUR LES AGENTS DU POSTE ─────────────────────────────────────────
   *
   * Les traitements ne tournent pas tous sur ce serveur : quatre taches du Planificateur de
   * Windows travaillent sur le poste du proprietaire, lancees par les fichiers .cmd de outils/.
   * Le 2026-08-21, une tache de rattrapage a ete creee SANS etre cataloguee — elle tournait
   * invisible, quelques heures apres qu'on avait jure que rien ne pouvait plus l'etre. La
   * vigilance ne suffit pas ; seul un garde mecanique tient.
   *
   * Chaque .cmd de outils/ est un point d'entree du Planificateur : il doit etre revendique par
   * une entree du catalogue via son champ `poste`. Et chaque `poste` doit pointer vers un
   * fichier existant — une entree qui survit a la suppression de son lanceur decrirait une tache
   * qui ne tourne plus.
   */
  const OUTILS = join(__dirname, '..', '..', '..', '..', 'outils');

  function lanceursDuPoste(): string[] {
    return readdirSync(OUTILS)
      .filter((f) => f.endsWith('.cmd'))
      .map((f) => 'outils/' + f)
      .sort();
  }

  function lanceursCatalogues(): Set<string> {
    const texte = readFileSync(CATALOGUE, 'utf8');
    const out = new Set<string>();
    for (const m of texte.matchAll(/poste:\s*'([^']+)'/g)) out.add(m[1]!);
    return out;
  }

  it('⚠️ CHAQUE lanceur .cmd du poste est revendique par le catalogue', () => {
    const catalogues = lanceursCatalogues();
    const oublies = lanceursDuPoste().filter((f) => !catalogues.has(f));
    expect(oublies).toEqual([]);
    // Si ce test tombe : une tache du Planificateur de Windows a ete creee sans etre inscrite
    // au catalogue. Elle tournerait INVISIBLE dans /admin/background-tasks.
  });

  it('aucun lanceur catalogue ne pointe vers un fichier disparu', () => {
    const presents = new Set(lanceursDuPoste());
    const fantomes = [...lanceursCatalogues()].filter((f) => !presents.has(f));
    expect(fantomes).toEqual([]);
  });

  it('⚠️ la tache de rattrapage — celle qui a tourne invisible — est cataloguee', () => {
    expect(lanceursCatalogues()).toContain('outils/rattrapage-recits.cmd');
  });

  it('⚠️ le SECOND cron de sms-heartbeat est catalogue — le garde par fichier le masquait', () => {
    // 35 crons au runtime, 34 au catalogue : l'ecart permanent venait de la, un fichier deja
    // revendique cachant son deuxieme @Cron. Le drift avait raison, personne ne pouvait le voir.
    const texte = readFileSync(CATALOGUE, 'utf8');
    expect(texte).toContain("id: 'sms-heartbeat-verify'");
  });

  it('⚠️ la bascule des statuts de mission aussi — trouvee en etendant le garde aux @Interval', () => {
    // Second trou du 2026-08-19 : un traitement METIER, toutes les minutes, invisible. Sans lui
    // une mission resterait « planifiee » alors que le vehicule est deja parti.
    expect(sourcesCataloguees()).toContain('missions/mission-status.service.ts');
  });

  it('le parseur du catalogue lit toutes les entrées — il ne s’est pas vidé en silence', () => {
    // Même rôle que le garde « nombre plausible » plus haut : si la lecture du tableau cassait,
    // les tests par décorateur ci-dessous passeraient en ne comparant plus rien.
    const entrees = entreesCataloguees();
    expect(entrees.length).toBeGreaterThanOrEqual(60);
    expect(entrees.filter((e) => e.id === '?' || e.kind === '?')).toEqual([]);
  });

  it('⚠️ CHAQUE @Cron et CHAQUE @Interval a SA PROPRE entrée — un fichier revendiqué ne couvre plus son second traitement', () => {
    const code = decorateursParFichier();
    const entrees = entreesCataloguees().filter((e) => !e.externe && e.source !== null);
    const fichiers = new Set([...code.keys(), ...entrees.map((e) => e.source!)]);
    const ecarts: string[] = [];
    for (const f of [...fichiers].sort()) {
      for (const genre of ['cron', 'interval'] as const) {
        const dansLeCode = code.get(f)?.[genre] ?? 0;
        const auCatalogue = entrees.filter((e) => e.source === f && e.kind === genre).length;
        if (dansLeCode !== auCatalogue) {
          ecarts.push(`${f} : ${dansLeCode} @${genre === 'cron' ? 'Cron' : 'Interval'} dans le code, ${auCatalogue} au catalogue`);
        }
      }
    }
    expect(ecarts).toEqual([]);
    // Si ce test tombe : un traitement planifié n'a pas sa ligne dans /admin/background-tasks — ou
    // une ligne décrit un traitement qui n'existe plus. Une entrée PAR décorateur, pas par fichier.
  });

  it('⚠️ l’écran compare le runtime à CE décompte : code = catalogue → plus de bandeau « écart »', () => {
    // Au runtime, chaque décorateur devient un job du registre NestJS : c'est ce que `buildHealth`
    // compare au catalogue, et l'écran affiche « écart » dès que les deux diffèrent.
    const reels = totalDecorateurs();
    const registry = {
      getCronJobs: () => new Map(Array.from({ length: reels.cron }, (_, i): [string, object] => [`cron_${i}`, {}])),
      getIntervals: () => Array.from({ length: reels.interval }, (_, i) => `interval_${i}`),
    };
    const svc = new BackgroundTasksService({} as never, registry as never, {} as never);
    const sante = (svc as unknown as { buildHealth(): BackgroundTasksResponse['health'] }).buildHealth();

    expect(sante.catalogCronCount).toBe(reels.cron);
    expect(sante.catalogIntervalCount).toBe(reels.interval);
    expect(sante.registeredCronCount).toBe(sante.catalogCronCount);
    expect(sante.uncataloguedJobs).toEqual([]);
  });

  it('⚠️ les deux crons du coupe-circuit que le garde par fichier masquait sont catalogués', () => {
    const ids = entreesCataloguees().map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['vehicle-schedules-cut-drain', 'engine-restore-reliability']));
  });
});
