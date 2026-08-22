import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminAlertsController } from './admin-alerts.controller';

/**
 * ARCHIVAGE REVERSIBLE DU CENTRE D'ALERTE — 2026-08-22.
 *
 * Ce que ces tests verrouillent, et pourquoi chacun existe :
 *
 *  - ARCHIVER N'EFFACE PAS. C'est la regle du proprietaire depuis l'origine, et
 *    TRK-035 en montre le prix : des lignes disparaissent deja hors application.
 *    Un archivage qui supprimerait rendrait la sonde de recensement incapable de
 *    distinguer nos archivages des suppressions de l'intrus.
 *  - `avant` EST OBLIGATOIRE en masse. Sans lui, une ligne ecrite entre l'affichage
 *    de l'ecran et le clic serait archivee sans avoir ete lue.
 *  - LE PLAFOND REFUSE au lieu d'archiver a moitie : un archivage partiel qu'on
 *    croit total est pire que le refus.
 *  - REARCHIVER NE RE-DATE PAS : un double clic ne doit pas effacer qui a archive.
 */
describe("Archivage reversible du centre d'alerte", () => {
  const user = { id: 'u-1', email: 'admin@vizyo.fr', role: 'SUPER_ADMIN' };
  const req = { user } as never;
  /** Un instant toujours dans le passe : un test ne doit pas dependre de l'heure ou il tourne. */
  const lu = () => new Date(Date.now() - 60_000).toISOString();

  const ligne = {
    id: 'e-1',
    level: 'ERROR',
    source: 'trip-analysis',
    message: 'Limites de vitesse indisponibles',
    createdAt: new Date('2026-08-22T00:47:22.563Z'),
    resolvedAt: null as Date | null,
    resolvedById: null as string | null,
    resolvedNote: null as string | null,
  };

  const monter = (over: Record<string, unknown> = {}) => {
    const errorLog = {
      findUnique: jest.fn().mockResolvedValue(ligne),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...ligne, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      count: jest.fn().mockResolvedValue(3),
      deleteMany: jest.fn(),
      delete: jest.fn(),
      ...over,
    };
    const activity = { record: jest.fn() };
    const ctrl = new AdminAlertsController({ errorLog } as never, activity as never);
    return { ctrl, errorLog, activity };
  };

  describe('archiver une ligne', () => {
    it("🔑 marque resolue SANS jamais supprimer la ligne", async () => {
      const { ctrl, errorLog } = monter();

      const res = await ctrl.archiverErreur(req, 'e-1', { note: 'dependance tierce, suivi TRK-037' });

      expect(res.ok).toBe(true);
      expect(errorLog.update).toHaveBeenCalledTimes(1);
      const data = errorLog.update.mock.calls[0][0].data;
      expect(data.resolvedAt).toBeInstanceOf(Date);
      expect(data.resolvedById).toBe('u-1');
      expect(data.resolvedNote).toBe('dependance tierce, suivi TRK-037');
      // LA garde de cette fiche : aucun chemin de suppression n'est emprunte.
      expect(errorLog.delete).not.toHaveBeenCalled();
      expect(errorLog.deleteMany).not.toHaveBeenCalled();
    });

    it('journalise qui a archive, pour que le geste soit relisable', async () => {
      const { ctrl, activity } = monter();
      await ctrl.archiverErreur(req, 'e-1', {});
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'ALERT', action: 'error_log_archive', triggeredByUserId: 'u-1' }),
      );
    });

    it("⚠️ re-archiver ne RE-DATE pas : un double clic n'efface pas le premier archivage", async () => {
      const dejaArchivee = { ...ligne, resolvedAt: new Date('2026-08-22T18:00:00Z'), resolvedById: 'u-9' };
      const { ctrl, errorLog } = monter({ findUnique: jest.fn().mockResolvedValue(dejaArchivee) });

      const res = await ctrl.archiverErreur(req, 'e-1', {});

      expect(res).toMatchObject({ ok: true, dejaArchivee: true });
      expect(errorLog.update).not.toHaveBeenCalled();
    });

    it('ligne inconnue → 404, pas un succes silencieux', async () => {
      const { ctrl } = monter({ findUnique: jest.fn().mockResolvedValue(null) });
      await expect(ctrl.archiverErreur(req, 'e-1', {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('rouvrir', () => {
    const archivee = {
      ...ligne,
      resolvedAt: new Date('2026-08-22T18:00:00Z'),
      resolvedById: 'u-9',
      resolvedNote: 'cru corrige',
    };

    it("🔑 remet la ligne en vue par defaut — l'archivage est REVERSIBLE", async () => {
      const { ctrl, errorLog } = monter({ findUnique: jest.fn().mockResolvedValue(archivee) });

      await ctrl.rouvrirErreur(req, 'e-1');

      const data = errorLog.update.mock.calls[0][0].data;
      expect(data.resolvedAt).toBeNull();
      expect(data.resolvedById).toBeNull();
    });

    it('⚠️ CONSERVE la note : elle dit pourquoi on avait cru pouvoir classer', async () => {
      const { ctrl, errorLog } = monter({ findUnique: jest.fn().mockResolvedValue(archivee) });
      await ctrl.rouvrirErreur(req, 'e-1');
      expect(errorLog.update.mock.calls[0][0].data).not.toHaveProperty('resolvedNote');
    });

    it('rouvrir une ligne deja active ne fait rien', async () => {
      const { ctrl, errorLog } = monter();
      const res = await ctrl.rouvrirErreur(req, 'e-1');
      expect(res).toMatchObject({ ok: true, dejaActive: true });
      expect(errorLog.update).not.toHaveBeenCalled();
    });
  });

  describe('archivage en masse', () => {
    it("🔑 REFUSE sans `avant` — sinon on archive ce qu'on n'a pas lu", async () => {
      const { ctrl, errorLog } = monter();
      await expect(ctrl.archiverEnMasse(req, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(errorLog.updateMany).not.toHaveBeenCalled();
    });

    it('refuse un `avant` dans le futur', async () => {
      const { ctrl } = monter();
      const futur = new Date(Date.now() + 3600_000).toISOString();
      await expect(ctrl.archiverEnMasse(req, { avant: futur })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("n'archive QUE ce qui precede `avant`, et seulement les lignes actives", async () => {
      const { ctrl, errorLog } = monter();
      const avant = lu();

      await ctrl.archiverEnMasse(req, { avant });

      const where = errorLog.updateMany.mock.calls[0][0].where;
      expect(where.resolvedAt).toBeNull();
      expect(where.createdAt.lte).toEqual(new Date(avant));
    });

    it('⚠️ au-dela du plafond : REFUSE au lieu d\'archiver a moitie', async () => {
      const { ctrl, errorLog } = monter({ count: jest.fn().mockResolvedValue(501) });
      await expect(
        ctrl.archiverEnMasse(req, { avant: lu() }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(errorLog.updateMany).not.toHaveBeenCalled();
    });

    it('zero ligne concernee : succes a 0, sans ecriture', async () => {
      const { ctrl, errorLog } = monter({ count: jest.fn().mockResolvedValue(0) });
      const res = await ctrl.archiverEnMasse(req, { avant: lu() });
      expect(res).toEqual({ ok: true, archivees: 0 });
      expect(errorLog.updateMany).not.toHaveBeenCalled();
    });

    it('jamais de suppression, meme en masse', async () => {
      const { ctrl, errorLog } = monter();
      await ctrl.archiverEnMasse(req, { avant: lu() });
      expect(errorLog.deleteMany).not.toHaveBeenCalled();
      expect(errorLog.delete).not.toHaveBeenCalled();
    });
  });
});
