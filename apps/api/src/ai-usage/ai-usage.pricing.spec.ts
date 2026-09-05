import { AiUsageService, resolvePricing } from './ai-usage.service';

/**
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────
 *
 * Relevé du 2026-08-19 : 51,65 $ de facture IA, dont 45,89 $ (89 %) pour 4 410 récits de
 * trajet passés par le modèle le plus cher, parce qu'il était écrit en dur dans le client.
 *
 * En basculant sur Sonnet, un piège attendait : `resolvePricing` retombe sur le tarif LE PLUS
 * CHER pour tout modèle absent de la grille — un repli prudent (ne jamais SOUS-estimer un coût),
 * mais qui aurait facturé Sonnet au prix du repli. L'économie réelle serait restée invisible
 * dans les rapports, et la décision aurait paru sans effet. D'où ce test.
 *
 * ── C3 point 4 (2026-09-05) — la grille était FAUSSE, et les alias INCONNUS ───────────
 *
 * Sonnet 5 était compté 3 / 15 $ alors que la page officielle dit 2 / 10 $ : 26 lignes API =
 * 0,891 $ stockés contre 0,594 $ recalculés. Les agents du poste écrivaient `sonnet` et
 * `claude-code-poste`, absents de la grille, donc comptés au repli sans que rien ne le dise.
 * Mesuré sur le poste le même jour : l'alias CLI `sonnet` résout en Sonnet 4.6, pas Sonnet 5.
 */
const service = () => new AiUsageService(null as never, null as never, null as never);

/** Profil moyen mesuré sur les 4 410 récits de trajet réels. */
const RECIT = { inputTokens: 245, outputTokens: 313, cacheWriteTokens: 124, cacheReadTokens: 1154 };

describe('Tarification IA — la grille connaît les modèles qu’on emploie vraiment', () => {
  it('⚠️ Sonnet 5 coûte 40 % d’Opus (2/10 $ contre 5/25 $, page officielle du 05/09) — pas 60 %', () => {
    const svc = service();
    const opus = svc.costOf('claude-opus-4-8', RECIT);
    const sonnet = svc.costOf('claude-sonnet-5', RECIT);
    expect(sonnet).toBeLessThan(opus);
    // 3/15 $ donnait 0,6 : c'est le chiffre faux que la page a affiché jusqu'au 05/09.
    expect(sonnet / opus).toBeCloseTo(0.4, 5);
  });

  it('Sonnet 5 : cache à 2,50 $ en écriture et 0,20 $ en lecture (1,25× et 0,1× l’entrée)', () => {
    const svc = service();
    expect(svc.costOf('claude-sonnet-5', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 0 })).toBeCloseTo(2.5, 9);
    expect(svc.costOf('claude-sonnet-5', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2, 9);
  });

  it('Haiku 4.5 est le moins cher de la famille — le palier si l’on veut aller plus loin', () => {
    const svc = service();
    expect(svc.costOf('claude-haiku-4-5', RECIT)).toBeLessThan(svc.costOf('claude-sonnet-5', RECIT));
  });

  it('une version DATÉE est résolue par préfixe (le provider renvoie `…-20251001`)', () => {
    const svc = service();
    expect(svc.costOf('claude-haiku-4-5-20251001', RECIT)).toBe(svc.costOf('claude-haiku-4-5', RECIT));
    expect(svc.costOf('claude-sonnet-4-6-20260301', RECIT)).toBe(svc.costOf('claude-sonnet-4-6', RECIT));
  });

  it('⚠️ le plus LONG préfixe gagne : gpt-4o-mini n’est pas facturé au prix de gpt-4o, ni gpt-5-mini à celui de gpt-5', () => {
    const svc = service();
    expect(svc.costOf('gpt-4o-mini-2024-07-18', RECIT)).toBe(svc.costOf('gpt-4o-mini', RECIT));
    expect(svc.costOf('gpt-4o-mini-2024-07-18', RECIT)).toBeLessThan(svc.costOf('gpt-4o', RECIT));
    expect(svc.costOf('gpt-5-mini-2025-08-07', RECIT)).toBe(svc.costOf('gpt-5-mini', RECIT));
    expect(svc.costOf('gpt-5.1-2025-11-13', RECIT)).toBe(svc.costOf('gpt-5.1', RECIT));
    expect(resolvePricing('gpt-5.2-2025-12-11').cle).toBe('gpt-5.2');
  });

  it('les nouvelles familles sont connues : Opus 4.5 à 4.7, Fable 5 et 5.1, gpt-5, gpt-4.1-nano', () => {
    for (const m of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-fable-5', 'claude-fable-5-1', 'gpt-5', 'gpt-5-nano', 'gpt-4.1-nano', 'gpt-4o-mini']) {
      expect(resolvePricing(m).connu).toBe(true);
    }
    // Fable 5.1 lit son cache à 0,25 $ (exception mesurée sur la page), Fable 5 à 1 $.
    expect(resolvePricing('claude-fable-5-1').pricing.cacheRead).toBe(0.25);
    expect(resolvePricing('claude-fable-5').pricing.cacheRead).toBe(1);
  });

  describe('alias des modèles écrits par le poste et les consommateurs', () => {
    it('⚠️ `sonnet` et `claude-code-poste` sont du Sonnet 4.6 (alias CLI mesuré le 05/09), PAS du Sonnet 5', () => {
      const svc = service();
      const sonnet46 = svc.costOf('claude-sonnet-4-6', RECIT);
      expect(svc.costOf('sonnet', RECIT)).toBe(sonnet46);
      expect(svc.costOf('claude-code-poste', RECIT)).toBe(sonnet46);
      expect(sonnet46).not.toBe(svc.costOf('claude-sonnet-5', RECIT));
    });

    it('`local` (modèle inconnu du résultat) compte au tarif Sonnet 4.6 — le moteur du poste', () => {
      const svc = service();
      expect(svc.costOf('local', RECIT)).toBe(svc.costOf('claude-sonnet-4-6', RECIT));
    });

    it('`opus` → Opus 5, `haiku` → Haiku 4.5', () => {
      const svc = service();
      expect(svc.costOf('opus', RECIT)).toBe(svc.costOf('claude-opus-5', RECIT));
      expect(svc.costOf('haiku', RECIT)).toBe(svc.costOf('claude-haiku-4-5', RECIT));
    });

    it('un alias ne se signale pas comme inconnu', () => {
      expect(resolvePricing('sonnet')).toMatchObject({ cle: 'claude-sonnet-4-6', connu: true });
    });
  });

  describe('modèle inconnu', () => {
    it('retombe sur le tarif LE PLUS CHER — Fable 5.1, au-dessus d’Opus — on ne sous-estime jamais', () => {
      const svc = service();
      expect(svc.costOf('modele-jamais-vu', RECIT)).toBe(svc.costOf('claude-fable-5-1', RECIT));
      expect(svc.costOf('modele-jamais-vu', RECIT)).toBeGreaterThan(svc.costOf('claude-opus-4-8', RECIT));
      expect(resolvePricing('modele-jamais-vu').connu).toBe(false);
    });

    it('⚠️ est signalé UNE fois : une ligne DEGRADATION (source AI_TARIF) derrière un refroidissement de 7 j par modèle', async () => {
      const errorLogger = { record: jest.fn().mockResolvedValue('log-1') };
      const refroidissement = { tenterEmission: jest.fn().mockResolvedValue(true) };
      const svc = new AiUsageService(null as never, null as never, null as never, errorLogger as never, refroidissement as never);

      svc.costOf('modele-jamais-vu', RECIT);
      svc.costOf('modele-jamais-vu', RECIT);
      svc.costOf('modele-jamais-vu', RECIT);
      await new Promise((r) => setImmediate(r));

      expect(refroidissement.tenterEmission).toHaveBeenCalledTimes(1);
      expect(refroidissement.tenterEmission).toHaveBeenCalledWith('tarif-inconnu:modele-jamais-vu', 7 * 24 * 3_600_000);
      expect(errorLogger.record).toHaveBeenCalledTimes(1);
      const [err, source, ctx, niveau] = errorLogger.record.mock.calls[0];
      expect((err as Error).message).toContain('modele-jamais-vu');
      expect((err as Error).message).toContain('claude-fable-5-1');
      expect(source).toBe('AI_TARIF');
      expect(ctx).toMatchObject({ model: 'modele-jamais-vu', repli: 'claude-fable-5-1' });
      expect(niveau).toBe('DEGRADATION');
    });

    it('deux modèles inconnus = deux signalements (la clé porte le modèle)', async () => {
      const errorLogger = { record: jest.fn().mockResolvedValue('log-1') };
      const refroidissement = { tenterEmission: jest.fn().mockResolvedValue(true) };
      const svc = new AiUsageService(null as never, null as never, null as never, errorLogger as never, refroidissement as never);
      svc.costOf('inconnu-a', RECIT);
      svc.costOf('inconnu-b', RECIT);
      await new Promise((r) => setImmediate(r));
      expect(refroidissement.tenterEmission.mock.calls.map((c) => c[0])).toEqual(['tarif-inconnu:inconnu-a', 'tarif-inconnu:inconnu-b']);
      expect(errorLogger.record).toHaveBeenCalledTimes(2);
    });

    it('refroidissement encore actif (déjà signalé cette semaine) : aucune ligne, le coût est calculé quand même', async () => {
      const errorLogger = { record: jest.fn().mockResolvedValue('log-1') };
      const refroidissement = { tenterEmission: jest.fn().mockResolvedValue(false) };
      const svc = new AiUsageService(null as never, null as never, null as never, errorLogger as never, refroidissement as never);
      expect(svc.costOf('modele-jamais-vu', RECIT)).toBeGreaterThan(0);
      await new Promise((r) => setImmediate(r));
      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    it('sans centre d’alerte (jeux d’essai), le repli fonctionne en silence', () => {
      expect(() => service().costOf('modele-jamais-vu', RECIT)).not.toThrow();
    });
  });

  it('le coût réel d’un récit reste de l’ordre du centime — l’ordre de grandeur est tenu', () => {
    // 4 410 récits ont coûté 45,89 $, soit 0,0104 $ pièce sur Opus.
    const svc = service();
    expect(svc.costOf('claude-opus-4-8', RECIT)).toBeCloseTo(0.0104, 4);
  });

  it('estimateInputCostUsd : des jetons d’entrée au prix d’entrée du modèle, sortie 0', () => {
    const svc = service();
    // 1 000 jetons sur Sonnet 5 (2 $/M) = 0,002 $ ; l'alias `sonnet` (3 $/M) = 0,003 $.
    expect(svc.estimateInputCostUsd('claude-sonnet-5', 1000)).toBeCloseTo(0.002, 9);
    expect(svc.estimateInputCostUsd('sonnet', 1000)).toBeCloseTo(0.003, 9);
    expect(svc.estimateInputCostUsd('claude-sonnet-5', -5)).toBe(0);
  });
});
