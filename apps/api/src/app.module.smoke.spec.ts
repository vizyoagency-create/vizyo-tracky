/**
 * SMOKE-BOOT — vérifie que le graphe d'injection de dépendances de l'API se résout.
 *
 * Pourquoi ce test existe (2026-07-22) : le module `api-traffic` est parti en production
 * sans importer `AuthModule`, alors que son contrôleur utilise `JwtAuthGuard`. L'API a
 * démarré en boucle de plantage et l'ingestion GPS est tombée. Le typecheck était vert,
 * les 1000+ tests unitaires étaient verts — parce qu'AUCUN n'instancie l'application
 * entière. Les tests unitaires fournissent leurs dépendances à la main : par construction,
 * ils ne peuvent pas voir un `imports:` manquant.
 *
 * Ce que ce test attrape : `UnknownDependenciesException`, dépendances circulaires,
 * providers non déclarés, tokens d'injection absents — c'est-à-dire tout ce qui fait
 * qu'un conteneur redémarre en boucle au lieu de servir.
 *
 * `.compile()` construit le graphe et instancie les providers, mais n'appelle PAS
 * `onModuleInit` : aucune connexion base/réseau n'est ouverte. C'est précisément la
 * frontière voulue — on valide le CÂBLAGE, pas le comportement.
 *
 * ⚠️ Si ce test échoue après l'ajout d'un module : ne le neutralisez pas. Il décrit une
 * panne de démarrage bien réelle. Le correctif est presque toujours un `imports:` manquant
 * dans le module fautif (nommé dans le message d'erreur Nest).
 */
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

/**
 * Env factice, suffisant pour `validateEnv`. Volontairement inerte : URL non résolvables
 * et secrets bidon — rien ici ne doit permettre d'atteindre un vrai service.
 */
const FAKE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://smoke:smoke@127.0.0.1:1/smoke?schema=public',
  REDIS_URL: 'redis://127.0.0.1:1',
  VIZYO_AUTH_API_URL: 'http://127.0.0.1:1',
  VIZYO_AUTH_APP_ID: 'app_smoke_boot',
  VIZYO_AUTH_APP_SECRET: 'smoke_secret_at_least_16_chars',
  VIZYO_AUTH_JWT_ACCESS_SECRET: 'smoke_jwt_secret',
  VIZYO_AUTH_JWT_ISSUER: 'http://127.0.0.1:1',
  VIZYO_AUTH_APP_INTERNAL_ID: 'smoke_internal_id',
  INTERNAL_API_SECRET: 'smoke_internal_at_least_16_chars',
};

describe("SMOKE-BOOT — graphe d'injection de l'API", () => {
  const saved = new Map<string, string | undefined>();
  let moduleRef: TestingModule | undefined;

  beforeAll(() => {
    for (const [key, value] of Object.entries(FAKE_ENV)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  afterAll(async () => {
    // `close()` déclenche onModuleDestroy : c'est lui qui arrête les setInterval
    // démarrés par certains constructeurs. Sans ça, le worker Jest reste vivant et
    // les timers se réveillent pendant une AUTRE suite.
    await moduleRef?.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("résout toutes les dépendances de l'application complète", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { AppModule } = require('./app.module') as { AppModule: unknown };

    moduleRef = await Test.createTestingModule({
      imports: [AppModule as never],
    }).compile();

    expect(moduleRef).toBeDefined();
  }, 120_000); // le graphe complet est gros ; le défaut de 5 s ne suffit pas

  /**
   * Un contrôleur OUBLIÉ dans `controllers:` de son module est un angle mort TOTAL :
   * le typecheck est vert (le fichier compile), le smoke-boot ci-dessus est vert (le
   * graphe se résout — il n'y a simplement rien à résoudre), les tests unitaires du
   * service sont verts. Et pourtant l'API ne sert AUCUNE de ses routes.
   *
   * Cas réel (2026-07-28) : `NotificationCenterController` est parti en production sans
   * être déclaré. Le déploiement s'est passé sans une erreur, l'API répondait `healthy`,
   * et le centre de notifications renvoyait 404 sur toutes ses routes. Détecté seulement
   * en cherchant les routes dans les logs de démarrage.
   *
   * Ce test ferme l'angle mort : il énumère les routes RÉELLEMENT enregistrées et exige
   * la présence de celles dont l'absence est silencieuse mais grave. Ajoutez-y toute route
   * dont vous voulez garantir l'existence.
   */
  it('ne laisse AUCUN contrôleur orphelin (non déclaré dans un module)', () => {
    // On lit les MÉTADONNÉES, on ne démarre rien : `app.init()` déclencherait les
    // `onModuleInit` et donc de vraies connexions base — précisément ce que ce fichier
    // évite (cf. en-tête). Le câblage se vérifie sans allumer le moteur.
    const declared = new Set<unknown>();
    for (const file of sourceFiles('.module.ts')) {
      for (const exported of Object.values(safeRequire(file))) {
        if (typeof exported !== 'function') continue;
        const list = Reflect.getMetadata('controllers', exported) as unknown[] | undefined;
        for (const c of list ?? []) declared.add(c);
      }
    }

    const orphans: string[] = [];
    let seen = 0;
    for (const file of sourceFiles('.controller.ts')) {
      for (const exported of Object.values(safeRequire(file))) {
        if (typeof exported !== 'function') continue;
        // `@Controller()` pose la métadonnée 'path' : c'est le discriminant fiable,
        // plus robuste qu'un test sur le nom de la classe.
        if (!Reflect.hasMetadata('path', exported)) continue;
        seen++;
        if (!declared.has(exported)) orphans.push((exported as { name: string }).name);
      }
    }

    // Filet : si l'énumération se casse un jour (arborescence, build), on veut un échec
    // franc plutôt qu'un test vert qui ne vérifie plus rien.
    expect(seen).toBeGreaterThan(20);
    expect(orphans).toEqual([]);
  }, 60_000);
});

/**
 * UNE SEULE PORTE POUR LE PUSH.
 *
 * Tout le socle de notification — preferences, seuil, anti-spam, journal, centre
 * d'administration — repose sur un invariant unique : personne n'envoie de push sans
 * passer par `NotificationDispatchService`.
 *
 * Cet invariant a DEJA ete casse une fois, en silence. Le rappel d'entretien appelait
 * `webPush.sendToUser()` en direct : impossible de le couper depuis les reglages, aucun
 * garde-fou anti-spam, et invisible dans le centre de notifications. Le defaut n'etait
 * visible nulle part — ni au typage, ni a l'execution, ni a l'ecran. Il a fallu relire le
 * code pour le trouver.
 *
 * Ce test transforme cette relecture en verification automatique : le jour ou une
 * fonctionnalite ajoutera un second chemin, il tombera avec le nom du fichier fautif.
 *
 * Deux exceptions, volontaires et nommees :
 *   - `notification-dispatch.service.ts` — LA porte elle-meme ;
 *   - `notifications.controller.ts` — le bouton « tester », qui doit justement contourner
 *     les preferences pour prouver que la plomberie fonctionne (un test bride par les
 *     reglages ne testerait rien).
 */
describe('socle de notification — une seule porte', () => {
  const AUTHORIZED = ['notification-dispatch.service.ts', 'notifications.controller.ts'];

  it('aucun service n envoie de push en dehors du dispatch', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const offenders = sourceFiles('.ts')
      .filter((f) => !AUTHORIZED.some((allowed) => f.endsWith(allowed)))
      .filter((f) => {
        // On cherche l'APPEL, pas la MENTION : plusieurs fichiers expliquent la regle en
        // commentaire, et les compter comme fautes rendrait le garde-fou infalsifiable —
        // il faudrait supprimer l'explication pour le faire passer.
        const code = fs
          .readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*/g, '');
        return /\bwebPush\s*\.\s*sendTo/.test(code);
      })
      // Separateur Windows ET POSIX : ne couper que sur / renverrait le chemin entier
      // sous Windows, et le message d'echec deviendrait illisible la ou il sert le plus.
      .map((f) => f.split(/[\\/]/).pop());

    expect(offenders).toEqual([]);
  });
});

/** Chemins absolus des fichiers `src/**\/*<suffix>`, hors specs. */
function sourceFiles(suffix: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix) && !entry.name.includes('.spec.')) out.push(full);
    }
  };
  walk(__dirname);
  return out;
}

/**
 * `require` tolérant : un fichier qui refuse de se charger ne doit pas faire échouer le
 * test pour la MAUVAISE raison (on chercherait un contrôleur orphelin et on trouverait
 * une erreur d'import sans rapport).
 */
function safeRequire(file: string): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(file) as Record<string, unknown>;
  } catch {
    return {};
  }
}


/**
 * UN DÉCORATEUR DOIT TOUCHER LA MÉTHODE QU'IL DÉCORE.
 *
 * ── L'incident (2026-08-02) ─────────────────────────────────────────────────────────
 * Une méthode privée a été insérée ENTRE `@Interval(60_000)` et la méthode qu'il
 * décorait. L'ordonnanceur a donc appelé ce CALCUL toutes les 60 s — sans arguments —
 * pendant que la revalidation des connexions ne tournait PLUS DU TOUT.
 *
 * Le symptôme (« accessible is not iterable ») pointait vers la VALEUR, pas vers la
 * cause : j'ai d'abord rendu le calcul défensif, ce qui a simplement déplacé l'erreur
 * à la ligne suivante. Rien — ni le typage, ni les tests unitaires, ni le smoke-boot —
 * ne voyait le problème : le code compilait et la classe se construisait.
 *
 * Ce garde-fou lit les fichiers en TEXTE : c'est la seule façon de voir un décorateur
 * séparé de sa cible, l'information étant perdue à la compilation.
 */

/**
 * UNE TÂCHE PLANIFIÉE NE PREND AUCUN ARGUMENT.
 *
 * ── L'incident (2026-08-02) ─────────────────────────────────────────────────────────
 * Une méthode privée s'est glissée ENTRE `@Interval(60_000)` et la méthode qu'il
 * décorait. L'ordonnanceur a donc appelé ce CALCUL toutes les 60 s — sans arguments —
 * pendant que la revalidation des connexions ne tournait PLUS DU TOUT.
 *
 * Rien ne pouvait le voir : le code compile, la classe se construit, le typage est
 * correct, et les tests unitaires appellent la méthode directement. Le lien
 * décorateur → méthode est perdu à la compilation.
 *
 * ── Pourquoi CET invariant, et pas « le décorateur touche sa méthode » ──────────────
 * Ma première version exigeait que la ligne suivante soit la signature. Elle criait
 * donc à tort sur un commentaire placé entre un décorateur et sa méthode — ce qui est
 * parfaitement légitime (TypeScript ignore les commentaires) et même souhaitable :
 * `audio-monitoring.controller.ts:54` documente ainsi une restriction temporaire.
 * Un garde-fou qui crie à tort finit par être désarmé.
 *
 * L'invariant retenu est SÉMANTIQUE : l'ordonnanceur appelle une tâche SANS argument.
 * Toute méthode planifiée qui en réclame est forcément la mauvaise cible — c'est
 * exactement ce qui s'est produit (`scopeKey(user, accessible, canSeeAlerts)`).
 */
describe('taches planifiees — aucune ne prend d argument', () => {
  it('chaque @Cron/@Interval/@Timeout decore une methode SANS parametre', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const SCHEDULER = /^@(Cron|Interval|Timeout)\s*\(/;
    // Capture le nom et la liste de parametres de la methode decoree.
    const METHOD = /^(?:public |private |protected )?(?:async )?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
    const offenders: string[] = [];

    for (const file of sourceFiles('.ts')) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!SCHEDULER.test(lines[i]!.trim())) continue;

        // Le decorateur peut s'etendre sur plusieurs lignes : on suit la parenthese.
        let depth = 0;
        let k = i;
        do {
          for (const ch of lines[k]!) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
          }
          k++;
        } while (depth > 0 && k < lines.length);

        // On saute ce que TypeScript ignore — lignes vides, commentaires — et les
        // autres decorateurs, pour atteindre la METHODE reellement decoree.
        while (k < lines.length) {
          const t = lines[k]!.trim();
          if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('@')) {
            k++;
            continue;
          }
          break;
        }

        const m = METHOD.exec(lines[k]?.trim() ?? '');
        if (!m) continue; // decorateur de classe, ou forme non reconnue
        const [, name, params] = m;
        // ⚠️ L'invariant exact n'est pas « aucun paramètre » mais « APPELABLE SANS
        // ARGUMENT » : un paramètre à valeur par défaut ou optionnel est légitime, et
        // sert même à injecter l'horloge dans les tests — voir
        // `error-rate-watchdog.service.ts` : `check(now = Date.now())`.
        // C'est la sémantique de `Function.length`, que ce scan textuel reproduit.
        const required = params!
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p !== '')
          .filter((p) => !p.includes('=') && !/\?\s*:/.test(p) && !p.startsWith('...'));
        if (required.length > 0) {
          offenders.push(`${file.split(/[\\/]/).pop()}:${i + 1} -> ${name}(${required.join(', ').slice(0, 50)})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * ⚠️ GARDE SUR LES GABARITS ANGULAR — oui, depuis la suite de l'API.
   *
   * Elle est ici parce que c'est le seul harnais du dépôt qui tourne en Node avec accès
   * au disque : les tests web tournent dans un navigateur, où `require.context` ne rend
   * que des modules COMPILÉS, sans le texte des gabarits. Une première version côté web
   * a échoué pour cette raison exacte.
   *
   * ── Ce qu'elle empêche ───────────────────────────────────────────────────────────
   *
   * Un gabarit Angular est un TEMPLATE LITERAL. Un backtick écrit dans un commentaire
   * HTML y ferme la chaîne — TypeScript ne voit pas un commentaire, il n'a même pas fini
   * de lire la chaîne. Le message produit ne parle jamais de backtick :
   *
   *     NG1002: Incorrect number of arguments to @Component decorator
   *     + une cascade de TS1005 sur des lignes sans rapport
   *
   * Et `tsc` ne compile pas les gabarits : seul `ng build` le voit, après plusieurs
   * minutes. Cette erreur a cassé le build CINQ fois dans la même journée (2026-08-03),
   * toujours en citant un identifiant entre backticks dans un commentaire explicatif.
   */
  it('aucun backtick dans un commentaire HTML de gabarit Angular', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');

    const webSrc = path.resolve(__dirname, '..', '..', 'web', 'src');
    if (!fs.existsSync(webSrc)) {
      // Dépôt partiel (image API seule) : on ne fait pas échouer pour un dossier absent.
      return;
    }

    const fichiers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') && !e.name.includes('.spec.')) fichiers.push(full);
      }
    };
    walk(webSrc);

    const offenders: string[] = [];
    for (const file of fichiers) {
      const src = fs.readFileSync(file, 'utf8');
      const debut = src.indexOf('template: `');
      if (debut === -1) continue;
      // On ne scanne que la zone du gabarit : un backtick dans un commentaire TS normal
      // (hors littéral) est parfaitement légitime et très courant dans ce dépôt.
      const zone = src.slice(debut);
      for (const m of zone.matchAll(/<!--([\s\S]*?)-->/g)) {
        if ((m[1] ?? '').includes('`')) {
          const extrait = (m[1] ?? '').trim().split('\n')[0]?.slice(0, 60) ?? '';
          offenders.push(`${file.split(/[\\/]/).pop()} -> « ${extrait} »`);
        }
      }
    }

    // Si ceci casse : remplacez le backtick par des « guillemets », ou retirez la citation
    // de code du commentaire. Le gabarit est une chaîne — le backtick la termine.
    expect(offenders).toEqual([]);
  });
});
