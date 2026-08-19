import { AiUsageService } from './ai-usage.service';

/**
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────
 *
 * Relevé du 2026-08-19 : 51,65 $ de facture IA, dont 45,89 $ (89 %) pour 4 410 récits de
 * trajet passés par le modèle le plus cher, parce qu'il était écrit en dur dans le client.
 *
 * En basculant sur Sonnet, un piège attendait : `resolvePricing` retombe sur le tarif OPUS
 * pour tout modèle absent de la grille — un repli prudent (ne jamais SOUS-estimer un coût),
 * mais qui aurait facturé Sonnet au prix d'Opus. L'économie réelle serait restée invisible
 * dans les rapports, et la décision aurait paru sans effet. D'où ce test.
 */
const service = () => new AiUsageService(null as never, null as never, null as never);

/** Profil moyen mesuré sur les 4 410 récits de trajet réels. */
const RECIT = { inputTokens: 245, outputTokens: 313, cacheWriteTokens: 124, cacheReadTokens: 1154 };

describe('Tarification IA — la grille connaît les modèles qu’on emploie vraiment', () => {
  it('⚠️ Sonnet 5 coûte MOINS qu’Opus : sans sa ligne dans la grille, il serait facturé au prix d’Opus', () => {
    const svc = service();
    const opus = svc.costOf('claude-opus-4-8', RECIT);
    const sonnet = svc.costOf('claude-sonnet-5', RECIT);
    expect(sonnet).toBeLessThan(opus);
    // 3/15 $ contre 5/25 $ : 40 % de moins, et pas un repli déguisé.
    expect(sonnet / opus).toBeCloseTo(0.6, 1);
  });

  it('Haiku 4.5 est le moins cher des trois — le palier si l’on veut aller plus loin', () => {
    const svc = service();
    expect(svc.costOf('claude-haiku-4-5', RECIT)).toBeLessThan(svc.costOf('claude-sonnet-5', RECIT));
  });

  it('une version DATÉE est résolue par préfixe (le provider renvoie `…-20251001`)', () => {
    const svc = service();
    expect(svc.costOf('claude-haiku-4-5-20251001', RECIT)).toBe(svc.costOf('claude-haiku-4-5', RECIT));
  });

  it('un modèle inconnu retombe sur le tarif le plus cher — on ne sous-estime jamais', () => {
    const svc = service();
    expect(svc.costOf('modele-jamais-vu', RECIT)).toBe(svc.costOf('claude-opus-4-8', RECIT));
  });

  it('le coût réel d’un récit reste de l’ordre du centime — l’ordre de grandeur est tenu', () => {
    // 4 410 récits ont coûté 45,89 $, soit 0,0104 $ pièce sur Opus.
    const svc = service();
    expect(svc.costOf('claude-opus-4-8', RECIT)).toBeCloseTo(0.0104, 4);
  });
});
