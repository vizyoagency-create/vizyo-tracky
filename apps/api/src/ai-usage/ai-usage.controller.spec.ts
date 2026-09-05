import { AiUsageController, libelleModele } from './ai-usage.controller';

/**
 * C3 point 4 (2026-09-05) — la carte « Moteur IA » nommait « Opus 4.8 » en dur pendant que chaque
 * appel partait sur Sonnet 5 (le défaut du client a changé le 19/08). Le libellé est désormais
 * DÉRIVÉ du modèle réel que le routeur emploierait ; ce fichier fige la dérivation.
 */
describe('libelleModele — un identifiant de modèle devient un nom lisible', () => {
  it.each([
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['gpt-4.1', '4.1'],
    ['gpt-4.1-2025-04-14', '4.1'],
    ['gpt-5-mini', '5 mini'],
    ['gpt-4o-mini', '4o mini'],
  ])('%s → « %s »', (id, attendu) => {
    expect(libelleModele(id)).toBe(attendu);
  });

  it('une forme inconnue est rendue telle quelle — un nom brut vaut mieux qu’un nom inventé', () => {
    expect(libelleModele('modele-maison')).toBe('modele-maison');
  });
});

describe('AiUsageController.getProvider — le moteur par défaut est nommé d’après le modèle réel', () => {
  function build(modeles: { claude: string; gpt: string }) {
    const aiProvider = { view: jest.fn().mockResolvedValue({ provider: 'claude', updatedAt: null }) };
    const aiRouter = {
      availability: () => ({ claude: true, gpt: true }),
      etatFournisseurs: () => ({ claude: { configure: true }, gpt: { configure: true } }),
      mixteAvailable: () => true,
      modeleParDefaut: (p: 'claude' | 'gpt') => modeles[p],
    };
    return new AiUsageController(null as never, aiProvider as never, aiRouter as never, null as never);
  }

  it('claude-sonnet-5 → « Claude — Sonnet 5 (défaut) », gpt-4.1 → « GPT — 4.1 (défaut) »', async () => {
    const vue = await build({ claude: 'claude-sonnet-5', gpt: 'gpt-4.1' }).getProvider();
    expect(vue.providers.map((p) => p.label)).toEqual(['Claude — Sonnet 5 (défaut)', 'GPT — 4.1 (défaut)']);
    expect(vue.quarantines).toEqual([]);
  });

  it('suit un changement de défaut (ANTHROPIC_MODEL) sans toucher au code', async () => {
    const vue = await build({ claude: 'claude-haiku-4-5-20251001', gpt: 'gpt-5-mini' }).getProvider();
    expect(vue.providers[0].label).toBe('Claude — Haiku 4.5 (défaut)');
    expect(vue.providers[1].label).toBe('GPT — 5 mini (défaut)');
  });
});
