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
  function build(avail: (fleetId: string | null | undefined, feature?: string) => boolean, configured = true) {
    // Comme le vrai service : `isEnabledForFleet` = une clé ET la porte ; `isFeatureOnForFleet` = la porte seule.
    const isFeatureOnForFleet = jest.fn(async (f: string | null | undefined, k?: string) => avail(f, k));
    const isEnabledForFleet = jest.fn(async (f: string | null | undefined, k?: string) => configured && avail(f, k));
    const ctrl = new AiStatusController({ isConfigured: () => configured, isEnabledForFleet, isFeatureOnForFleet } as never);
    return { ctrl, isEnabledForFleet, isFeatureOnForFleet };
  }

  /**
   * 29/09 — « c'est le client qui désactive » : l'écran masque toute l'IA sur le CHOIX de la société.
   * `enabled` le mélangeait avec la présence d'une clé : sur la démo (aucune clé, option imposée),
   * l'agenda montrait les propositions pendant que la barre latérale, l'Activité et les Paramètres
   * parlaient d'une IA coupée. `fleetEnabled` porte le choix seul.
   */
  it('serveur sans clé : `enabled` faux, mais `fleetEnabled` dit le choix du client', async () => {
    const { ctrl } = build((f) => f === 'fleet-9', false);
    const res = await ctrl.status(fleetAdmin, undefined);
    expect({ configured: res.configured, enabled: res.enabled, fleetEnabled: res.fleetEnabled }).toEqual({
      configured: false,
      enabled: false,
      fleetEnabled: true,
    });
  });

  it('`fleetEnabled` suit la société VISÉE et vaut faux quand le client a coupé l’IA', async () => {
    const { ctrl } = build((f) => f === 'fleet-payante');
    expect((await ctrl.status(superAdmin, 'fleet-payante')).fleetEnabled).toBe(true);
    expect((await ctrl.status(superAdmin, 'fleet-coupee')).fleetEnabled).toBe(false);
    expect((await ctrl.status(superAdmin, undefined)).fleetEnabled).toBe(false);
  });

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
