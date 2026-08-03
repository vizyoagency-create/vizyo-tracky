import { UserRole } from '@prisma/client';
import { AI_FEATURE_KEYS } from '@vizyo/tracky-shared';
import { AiStatusController } from './ai-status.controller';

/**
 * ── L'ÉTAT IA RENVOYÉ AU FRONT ─────────────────────────────────────────────────────────
 *
 * Cet endpoint décide de ce que l'utilisateur VOIT. Deux défauts corrigés le 2026-08-03 :
 *
 *  1. **La flotte visée était ignorée en pratique.** Le paramètre existait, mais le front ne
 *     l'envoyait jamais. Or les quatre super-admins de la plateforme n'ont pas de flotte et la
 *     porte serveur est fail-closed sans flotte : ils recevaient « IA coupée » sur TOUTE société,
 *     y compris une société ayant payé l'option.
 *
 *  2. **Un seul booléen pour trois verrous.** `enabled` ignorait le kill-switch GLOBAL par
 *     fonction. Couper `tripAnalysis` pour tout le monde laissait le bouton « Générer le récit
 *     IA » à l'écran : l'utilisateur cliquait, le serveur refusait. Un écran qui propose une
 *     action que le serveur refuse est pire qu'un écran qui ne la propose pas.
 */
describe('AiStatusController.status', () => {
  /** `avail` décide par (fleetId, feature) — on peut donc simuler un kill-switch ciblé. */
  function build(avail: (fleetId: string | null | undefined, feature?: string) => boolean) {
    const isEnabledForFleet = jest.fn(async (f: string | null | undefined, k?: string) => avail(f, k));
    const ctrl = new AiStatusController({ isConfigured: () => true, isEnabledForFleet } as never);
    return { ctrl, isEnabledForFleet };
  }

  const superAdmin = { user: { role: UserRole.SUPER_ADMIN, fleetId: null } } as never;
  const fleetAdmin = { user: { role: UserRole.FLEET_ADMIN, fleetId: 'fleet-9' } } as never;

  it('un super-admin qui vise une société obtient l’état de CETTE société', async () => {
    // Le cas réel : super-admin sans flotte, société cliente avec l'option payée.
    const { ctrl } = build((f) => f === 'fleet-payante');
    const res = await ctrl.status(superAdmin, 'fleet-payante');

    expect({ enabled: res.enabled, fleetId: res.fleetId }).toEqual({
      enabled: true,
      fleetId: 'fleet-payante',
    });
  });

  it('sans société visée, un super-admin (aucune flotte) obtient bien « coupé »', async () => {
    // ⚠️ Ce n'est PAS le bug : c'est le comportement fail-closed attendu. Le bug était que le
    // front ne transmettait jamais la société, donc n'obtenait JAMAIS autre chose que ceci.
    const { ctrl } = build((f) => f === 'fleet-payante');
    const res = await ctrl.status(superAdmin, undefined);
    expect({ enabled: res.enabled, fleetId: res.fleetId }).toEqual({ enabled: false, fleetId: null });
  });

  it('un fleet-admin est FORCÉ à sa flotte même s’il en vise une autre', async () => {
    const { ctrl, isEnabledForFleet } = build(() => true);
    const res = await ctrl.status(fleetAdmin, 'fleet-du-voisin');

    expect(res.fleetId).toBe('fleet-9');
    for (const call of isEnabledForFleet.mock.calls) expect(call[0]).toBe('fleet-9');
  });

  it('renvoie une entrée pour CHAQUE fonctionnalité connue', async () => {
    // Une fonction absente de `features` serait lue `undefined` par le front, donc masquée :
    // une option payée disparaîtrait de l'écran sans que rien ne le signale.
    const { ctrl } = build(() => true);
    const res = await ctrl.status(fleetAdmin);
    expect(Object.keys(res.features).sort()).toEqual([...AI_FEATURE_KEYS].sort());
  });

  it('un kill-switch sur UNE fonction ne coupe QUE celle-là', async () => {
    // Le cas qui produisait un bouton mort : `tripAnalysis` coupé globalement, société active.
    const { ctrl } = build((_f, k) => k !== 'tripAnalysis');
    const res = await ctrl.status(fleetAdmin);

    expect(res.features.tripAnalysis).toBe(false);
    expect(res.features.agendaAgent).toBe(true);
    expect(res.features.placeAnalysis).toBe(true);
  });

  it('`enabled` reste l’interrupteur MAÎTRE : il ne suit pas un kill-switch par fonction', async () => {
    // ⚠️ C'est la distinction qui rend `features` nécessaire. `enabled` répond « cette société
    // a-t-elle l'option ? » ; il ne peut donc pas servir à décider d'afficher un bouton.
    const { ctrl } = build((_f, k) => k !== 'tripAnalysis');
    const res = await ctrl.status(fleetAdmin);
    expect({ maitre: res.enabled, fonction: res.features.tripAnalysis }).toEqual({
      maitre: true,
      fonction: false,
    });
  });

  it('chaque fonction est interrogée pour la société VISÉE, pas pour une autre', async () => {
    const { ctrl, isEnabledForFleet } = build(() => true);
    await ctrl.status(superAdmin, 'fleet-ciblee');

    const parFonction = isEnabledForFleet.mock.calls.filter((c) => c[1] !== undefined);
    expect(parFonction).toHaveLength(AI_FEATURE_KEYS.length);
    for (const call of parFonction) expect(call[0]).toBe('fleet-ciblee');
  });
});
