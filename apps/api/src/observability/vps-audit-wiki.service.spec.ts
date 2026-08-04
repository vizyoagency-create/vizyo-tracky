import { NotFoundException } from '@nestjs/common';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VpsAuditWikiService } from './vps-audit-wiki.service';

/**
 * La mécanique commune (parcours disque, manifeste, tri des rapports) est déjà verrouillée par
 * `centre-alerte-wiki.service.spec.ts` — les deux services partagent `DocsWikiService`. Ici on
 * ne teste QUE ce qui distingue le wiki VPS, plus la traversée de chemin : elle est trop grave
 * pour être vérifiée « ailleurs, par héritage ».
 */
describe('VpsAuditWikiService', () => {
  const service = new VpsAuditWikiService();
  const originalEnv = process.env['VPS_AUDIT_DOCS_DIR'];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['VPS_AUDIT_DOCS_DIR'];
    else process.env['VPS_AUDIT_DOCS_DIR'] = originalEnv;
  });

  describe('sur la documentation réelle du dépôt', () => {
    beforeEach(() => {
      process.env['VPS_AUDIT_DOCS_DIR'] = resolve(
        __dirname, '..', '..', '..', '..', 'docs', 'vps-audit',
      );
    });

    it('trouve la documentation et la classe en sections', async () => {
      const index = await service.index();

      expect(index.available).toBe(true);
      const slugs = index.sections.flatMap((s) => s.documents.map((d) => d.slug));
      expect(slugs).toContain('REFERENCE-CONSTATS.md');
      expect(slugs).toContain('PROCEDURE-AUDIT.md');
      expect(slugs).toContain('README.md');
      // Le collecteur est un script shell : il doit être servi, et reconnu comme tel.
      expect(slugs).toContain('collecte.sh');
    });

    it('sert le collecteur comme du bash, pas comme du markdown', async () => {
      // C'est le seul écart de format entre ce wiki et celui du centre d'alerte. S'il
      // repassait en `markdown`, l'écran essaierait d'interpréter le script au lieu de
      // l'afficher — un `#` de commentaire deviendrait un titre.
      const doc = await service.document('collecte.sh');
      expect(doc.format).toBe('bash');
      expect(doc.content).toContain('COLLECTEUR D\'AUDIT VPS');
    });

    it('lit le manifeste : constats, statuts et journal des passages', async () => {
      const index = await service.index();

      expect(index.sections.map((s) => s.key)).toContain('rapports');
      // Ces trois tableaux ne se devinent pas du disque : ils viennent du manifeste, et ce
      // sont eux qui alimentent le tableau de bord de l'écran.
      expect(index.fiches.length).toBeGreaterThan(0);
      expect(index.statuts.length).toBeGreaterThan(0);
      expect(index.passages.length).toBeGreaterThan(0);
    });

    it('affiche le rapport d\'amorçage', async () => {
      const doc = await service.document('rapports/2026-08-04.md');
      expect(doc.format).toBe('markdown');
      expect(doc.content).toContain('VPS-001');
    });
  });

  describe('traversée de chemin', () => {
    let parent: string;
    let root: string;

    beforeEach(async () => {
      parent = await mkdtemp(join(tmpdir(), 'vps-wiki-test-'));
      root = join(parent, 'docs');
      await mkdir(join(root, 'rapports'), { recursive: true });
      await writeFile(join(root, 'README.md'), '# Ici\n');
      await writeFile(join(parent, 'secret-hors-perimetre.md'), 'SECRET');
      process.env['VPS_AUDIT_DOCS_DIR'] = root;
    });

    afterEach(async () => {
      await rm(parent, { recursive: true, force: true });
    });

    it.each([
      '../secret-hors-perimetre.md',
      '../../etc/passwd',
      '..\\..\\windows\\win.ini',
      '/etc/passwd',
      'rapports/../../secret-hors-perimetre.md',
    ])('refuse le slug hostile « %s »', async (slug) => {
      await expect(service.document(slug)).rejects.toThrow(NotFoundException);
    });

    it('sert quand même le document légitime du même dossier', async () => {
      const doc = await service.document('README.md');
      expect(doc.content).toContain('# Ici');
    });
  });

  describe('isolation vis-à-vis du centre d\'alerte', () => {
    it('n\'emprunte pas la variable d\'environnement de l\'autre wiki', async () => {
      // Les deux services héritent du même socle : une confusion de descripteur ferait servir
      // la documentation des erreurs sous l'écran VPS, sans qu'aucun test ne s'en plaigne.
      delete process.env['VPS_AUDIT_DOCS_DIR'];
      process.env['CENTRE_ALERTE_DOCS_DIR'] = join(tmpdir(), 'peu-importe');
      try {
        const roots = await service.debugRoots();
        expect(roots.candidates.every((c) => c.includes('vps-audit'))).toBe(true);
        expect(roots.candidates.some((c) => c.includes('centre-alerte'))).toBe(false);
      } finally {
        delete process.env['CENTRE_ALERTE_DOCS_DIR'];
      }
    });
  });

  describe('dossier absent', () => {
    beforeEach(() => {
      process.env['VPS_AUDIT_DOCS_DIR'] = join(tmpdir(), 'vps-wiki-inexistant-xyz');
    });

    it('répond `available: false` au lieu d\'échouer', async () => {
      const index = await service.index();
      expect(index.available).toBe(false);
      expect(index.sections).toEqual([]);
    });
  });
});
