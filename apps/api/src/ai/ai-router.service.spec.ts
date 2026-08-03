import { AiServiceError } from './ai-client.types';
import { AiRouter } from './ai-router.service';

/**
 * LE PLAFOND MENSUEL DE DÉPENSE IA — appliqué au POINT D'ENTRÉE UNIQUE.
 *
 * ── Le défaut (audit du 2026-08-03) ─────────────────────────────────────────────────
 * La règle vivait dans `PlaceAnalysisService`, **un seul des huit points d'appel IA**.
 * L'administrateur fixait 10 €, voyait la barre rouge et le badge « Dépassé » — et seules
 * les analyses de lieux s'arrêtaient. Le cron horaire de récits de trajets, l'agent
 * d'agenda, le rapport d'activité, l'optimiseur et la saisie vocale continuaient
 * d'appeler le modèle, et de facturer.
 *
 * **Un plafond qui ne plafonne pas est pire qu'aucun plafond** : il donne une fausse
 * assurance, donc on ne surveille plus.
 *
 * `AiRouter` se déclare « point d'entrée UNIQUE de tous les appels IA ». C'est le
 * seul endroit où la règle ne peut pas être oubliée par un futur appelant — et c'est donc
 * là qu'elle doit être testée, pas seulement chez ses consommateurs.
 */
function build(exhausted: boolean) {
  const completeJson = jest.fn().mockResolvedValue({ result: { ok: true }, model: 'm', usage: {}, latencyMs: 1 });
  const anthropic = { isConfigured: () => true, completeJson };
  const openai = { isConfigured: () => false, completeJson: jest.fn() };
  const settings = { current: jest.fn().mockResolvedValue('claude') };
  const usage = { monthBudgetExhausted: jest.fn().mockResolvedValue(exhausted) };
  const svc = new AiRouter(anthropic as never, openai as never, settings as never, usage as never);
  return { svc, completeJson, usage, settings };
}

const REQ = { system: 's', userPayload: {}, schema: {}, maxTokens: 10 } as never;

describe('AiRouter — plafond mensuel', () => {
  it('budget NON atteint : l appel part normalement', async () => {
    const t = build(false);
    await expect(t.svc.completeJson(REQ)).resolves.toMatchObject({ model: 'm' });
    expect(t.completeJson).toHaveBeenCalledTimes(1);
  });

  it('⚠️ budget ATTEINT : l appel est REFUSE, le modele n est jamais sollicite', async () => {
    // LE test du correctif. Sans lui, deplacer la garde ici ne serait couvert par rien —
    // les tests de `place-analysis` ne verifient que son pre-controle.
    const t = build(true);
    await expect(t.svc.completeJson(REQ)).rejects.toBeInstanceOf(AiServiceError);
    expect(t.completeJson).not.toHaveBeenCalled();
  });

  it('le refus est de type « quota » — donc lisible par le centre d alerte', async () => {
    const t = build(true);
    await t.svc.completeJson(REQ).catch((e: AiServiceError) => {
      expect(e.kind).toBe('quota');
    });
    expect.assertions(1);
  });

  it('⚠️ le plafond est verifie AVANT de choisir le fournisseur', async () => {
    // Sinon on paierait la resolution du mode (une lecture en base) pour un appel
    // qu'on va refuser — et surtout, un futur `pick()` qui appellerait le modele
    // passerait sous la garde.
    const t = build(true);
    await t.svc.completeJson(REQ).catch(() => undefined);
    expect(t.settings.current).not.toHaveBeenCalled();
  });

  it('le plafond est consulte a CHAQUE appel, jamais mis en cache ici', async () => {
    // Le budget bouge en cours de journee : le mettre en cache dans le routeur ferait
    // dépasser le plafond pendant toute la duree du cache.
    const t = build(false);
    await t.svc.completeJson(REQ);
    await t.svc.completeJson(REQ);
    expect(t.usage.monthBudgetExhausted).toHaveBeenCalledTimes(2);
  });
});
