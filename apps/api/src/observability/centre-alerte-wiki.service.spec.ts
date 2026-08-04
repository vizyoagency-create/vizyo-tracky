import { NotFoundException } from '@nestjs/common';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CentreAlerteWikiService } from './centre-alerte-wiki.service';

/**
 * Ces tests s'exécutent contre de VRAIS fichiers, pas contre un `fs` simulé : tout l'intérêt
 * du service est justement de trouver ce qui est réellement sur le disque. Un mock de `fs`
 * validerait la logique tout en laissant passer une erreur de résolution de chemin — le seul
 * défaut qui compte vraiment ici.
 */
describe('CentreAlerteWikiService', () => {
  const service = new CentreAlerteWikiService();
  const originalEnv = process.env['CENTRE_ALERTE_DOCS_DIR'];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['CENTRE_ALERTE_DOCS_DIR'];
    else process.env['CENTRE_ALERTE_DOCS_DIR'] = originalEnv;
  });

  describe('sur la documentation réelle du dépôt', () => {
    beforeEach(() => {
      // `apps/api` → racine du dépôt → docs/. Le même calcul relatif que le service fait
      // depuis `process.cwd()`, mais ancré sur ce fichier pour ne pas dépendre du répertoire
      // depuis lequel Jest est lancé.
      process.env['CENTRE_ALERTE_DOCS_DIR'] = resolve(__dirname, '..', '..', '..', '..', 'docs', 'centre-alerte');
    });

    it('trouve la documentation et la classe en sections', async () => {
      const index = await service.index();

      expect(index.available).toBe(true);
      expect(index.documentCount).toBeGreaterThan(0);

      const slugs = index.sections.flatMap((s) => s.documents.map((d) => d.slug));
      expect(slugs).toContain('REFERENCE-ERREURS.md');
      expect(slugs).toContain('PROCEDURE-AUDIT.md');
      expect(slugs).toContain('README.md');
      // Le collecteur est du SQL : il doit être servi lui aussi, et reconnu comme tel.
      expect(slugs).toContain('collecte.sql');
    });

    it('lit le manifeste : titres, sections et journal des passages', async () => {
      const index = await service.index();

      expect(index.sections.map((s) => s.key)).toContain('rapports');
      const reference = index.sections
        .flatMap((s) => s.documents)
        .find((d) => d.slug === 'REFERENCE-ERREURS.md');
      expect(reference?.title).toBe('Référentiel des erreurs');
      // `passages` ne se devine pas du disque : c'est la partie qui vient du manifeste.
      expect(index.passages.length).toBeGreaterThan(0);
    });

    it('n\'expose pas le manifeste lui-même comme un document', async () => {
      const index = await service.index();
      const slugs = index.sections.flatMap((s) => s.documents.map((d) => d.slug));
      expect(slugs).not.toContain('app/wiki.json');
    });

    it('sert le contenu d\'un document', async () => {
      const doc = await service.document('REFERENCE-ERREURS.md');
      expect(doc.format).toBe('markdown');
      expect(doc.content).toContain('TRK-008');
      expect(doc.truncated).toBe(false);
    });

    it('reconnaît le collecteur comme du SQL', async () => {
      const doc = await service.document('collecte.sql');
      expect(doc.format).toBe('sql');
      expect(doc.content).toContain('SECTION volumetrie');
    });
  });

  describe('traversée de chemin', () => {
    let parent: string;
    let root: string;

    beforeEach(async () => {
      // Le secret est un FRÈRE du dossier servi, dans un parent isolé : c'est la cible
      // qu'une traversée `../` viserait naturellement.
      parent = await mkdtemp(join(tmpdir(), 'wiki-test-'));
      root = join(parent, 'docs');
      await mkdir(join(root, 'rapports'), { recursive: true });
      await writeFile(join(root, 'README.md'), '# Ici\n');
      await writeFile(join(parent, 'secret-hors-perimetre.md'), 'SECRET');
      process.env['CENTRE_ALERTE_DOCS_DIR'] = root;
    });

    afterEach(async () => {
      await rm(parent, { recursive: true, force: true });
    });

    it.each([
      '../secret-hors-perimetre.md',
      '../../etc/passwd',
      '..\\..\\windows\\win.ini',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      './../secret-hors-perimetre.md',
      'rapports/../../secret-hors-perimetre.md',
    ])('refuse le slug hostile « %s »', async (slug) => {
      // Le slug ne sert QUE de clé de recherche dans la liste découverte : aucun chemin
      // n'est dérivé de l'entrée client, donc la traversée n'a rien à quoi s'accrocher.
      await expect(service.document(slug)).rejects.toThrow(NotFoundException);
    });

    it('sert quand même le document légitime du même dossier', async () => {
      const doc = await service.document('README.md');
      expect(doc.content).toContain('# Ici');
    });
  });

  describe('découverte sans manifeste', () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'wiki-nomanifest-'));
      await mkdir(join(root, 'rapports'), { recursive: true });
      await writeFile(join(root, 'rapports', '2026-08-03.md'), '# vieux\n');
      await writeFile(join(root, 'rapports', '2026-08-05.md'), '# recent\n');
      await writeFile(join(root, 'rapports', '2026-08-04.md'), '# milieu\n');
      process.env['CENTRE_ALERTE_DOCS_DIR'] = root;
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('affiche un rapport que le manifeste ne déclare pas', async () => {
      // C'est la garantie qui compte pour l'agent d'audit : il dépose un fichier chaque
      // nuit et ne doit pas pouvoir le rendre invisible en oubliant de le déclarer.
      const index = await service.index();
      const rapports = index.sections.find((s) => s.key === 'rapports');
      expect(rapports?.documents.map((d) => d.slug)).toEqual([
        'rapports/2026-08-05.md',
        'rapports/2026-08-04.md',
        'rapports/2026-08-03.md',
      ]);
    });

    it('donne un titre lisible à un rapport non déclaré', async () => {
      const index = await service.index();
      const doc = index.sections
        .flatMap((s) => s.documents)
        .find((d) => d.slug === 'rapports/2026-08-04.md');
      expect(doc?.title).toBe('Audit du 2026-08-04');
    });
  });

  describe('résolution PAR DÉFAUT (sans variable d\'environnement)', () => {
    // C'est le chemin réellement emprunté en développement ET en production : aucune
    // variable n'est posée, et `WORKDIR` vaut `<racine>/apps/api` dans les deux cas.
    // Sans ce test, toute la suite ne validerait que la surcharge explicite — et une
    // erreur de `..` de trop ne se verrait qu'une fois déployée.
    it('trouve la documentation depuis apps/api via `../../docs/centre-alerte`', async () => {
      delete process.env['CENTRE_ALERTE_DOCS_DIR'];
      const apiDir = resolve(__dirname, '..', '..'); // src/observability → src → apps/api
      const spy = jest.spyOn(process, 'cwd').mockReturnValue(apiDir);
      try {
        const roots = await service.debugRoots();
        expect(roots.resolved).not.toBeNull();

        const index = await service.index();
        expect(index.available).toBe(true);
        expect(index.sections.flatMap((s) => s.documents.map((d) => d.slug))).toContain(
          'REFERENCE-ERREURS.md',
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('dossier absent', () => {
    beforeEach(() => {
      process.env['CENTRE_ALERTE_DOCS_DIR'] = join(tmpdir(), 'wiki-inexistant-xyz');
    });

    it('répond `available: false` au lieu d\'échouer', async () => {
      // ⚠️ C'est le cas PROD si l'image Docker n'embarque pas `docs/centre-alerte` :
      // l'écran doit pouvoir le dire, pas tomber en 500.
      const index = await service.index();
      expect(index.available).toBe(false);
      expect(index.sections).toEqual([]);
    });
  });
});
