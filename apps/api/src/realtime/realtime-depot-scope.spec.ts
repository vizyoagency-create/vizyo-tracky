import { RealtimeGateway } from './realtime.gateway';

/**
 * Espace depot — isolation du temps reel (A1 § 3, regle 5 ; A1 § 8, tests 9 et 10).
 *
 * Ce que ces tests protegent : un compte DEPOT ne rejoint QUE des salons de mission.
 * Jamais un salon de flotte, sous aucune combinaison de perimetre ou de permission.
 *
 * Pourquoi ils existent alors que l'exclusion « marchait deja » : avant ce lot, un
 * depot etait tenu hors des salons de flotte par EFFET DE BORD — sans ligne
 * `UserVehicleAccess`, `getAccessibleVehicleIds` renvoie `[]`, donc le compte partait
 * dans le registre restreint avec un ensemble vide. L'isolation dependait donc d'un
 * service qui n'a jamais eu le depot en tete. Ces tests verrouillent l'intention, pas
 * l'accident : ils echouent si quelqu'un retire la branche DEPOT, meme si le
 * comportement observable restait correct ce jour-la.
 */
describe('RealtimeGateway — isolation du role DEPOT', () => {
  const SALONS_INTERDITS = [
    'fleet:*',
    'pos:fleet:*',
    'fleet:f1',
    'pos:fleet:f1',
    'ops:fleet:f1',
    'alerts:fleet:f1',
    'alerts:fleet:*',
  ];

  function creerPasserelle(opts: {
    role: string;
    missionIds?: string[];
    accessible?: string[] | 'ALL';
  }) {
    const auth = {
      verifyAccessToken: jest.fn().mockReturnValue({ sub: 'auth-1' }),
      resolveLocalUser: jest.fn().mockResolvedValue({
        id: 'u-depot',
        email: 'depot@exemple.fr',
        role: opts.role,
        fleetId: 'f1',
      }),
    };
    const access = {
      getAccessibleVehicleIds: jest.fn().mockResolvedValue(opts.accessible ?? []),
    };
    const depotScope = {
      activeMissionIds: jest.fn().mockResolvedValue(opts.missionIds ?? []),
    };
    const prisma = {
      user: { findUnique: jest.fn(), findMany: jest.fn() },
      userVehicleAccess: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const gw = new RealtimeGateway(
      auth as never,
      prisma as never,
      access as never,
      depotScope as never,
    );
    return { gw, depotScope, access };
  }

  function creerClient() {
    const salons: string[] = [];
    return {
      id: 's-depot',
      handshake: { auth: { token: 'jeton' } },
      data: {} as Record<string, unknown>,
      join: jest.fn((salon: string) => salons.push(salon)),
      disconnect: jest.fn(),
      emit: jest.fn(),
      salons,
    };
  }

  it('ne rejoint AUCUN salon de flotte, meme sans mission active', async () => {
    const { gw } = creerPasserelle({ role: 'DEPOT', missionIds: [] });
    const client = creerClient();
    await gw.handleConnection(client as never);
    expect(client.salons).toEqual([]);
  });

  it('rejoint un salon par mission dont le suivi est actif', async () => {
    const { gw } = creerPasserelle({ role: 'DEPOT', missionIds: ['m-1', 'm-2'] });
    const client = creerClient();
    await gw.handleConnection(client as never);
    expect(client.salons).toEqual(['depot:mission:m-1', 'depot:mission:m-2']);
  });

  it.each(SALONS_INTERDITS)('ne rejoint jamais %s', async (salon) => {
    const { gw } = creerPasserelle({ role: 'DEPOT', missionIds: ['m-1'] });
    const client = creerClient();
    await gw.handleConnection(client as never);
    expect(client.salons).not.toContain(salon);
  });

  it('reste hors des salons de flotte MEME si son perimetre vehicule disait ALL', async () => {
    // Le scenario de regression qui justifie la branche explicite : si un jour
    // `getAccessibleVehicleIds` renvoyait 'ALL' pour un compte sans regle — un defaut
    // plausible, « aucune restriction = tout voir » — l'ancien chemin faisait entrer
    // le depot dans `fleet:f1` et `pos:fleet:f1`. La branche DEPOT s'arrete avant.
    const { gw } = creerPasserelle({ role: 'DEPOT', missionIds: ['m-1'], accessible: 'ALL' });
    const client = creerClient();
    await gw.handleConnection(client as never);
    expect(client.salons).toEqual(['depot:mission:m-1']);
  });

  it('ne consulte meme pas le perimetre vehicule — la question ne se pose pas', async () => {
    const { gw, access } = creerPasserelle({ role: 'DEPOT', missionIds: ['m-1'] });
    await gw.handleConnection(creerClient() as never);
    expect(access.getAccessibleVehicleIds).not.toHaveBeenCalled();
  });

  it('l\'empreinte de perimetre porte les missions — une fin de mission coupe la socket', async () => {
    // Les salons sont decides UNE FOIS, au raccordement. C'est l'empreinte qui permet
    // au tick de revalidation de voir qu'une mission s'est terminee et de couper : sans
    // elle, un socket ouvert avant `endAt` continuerait de recevoir apres (test 10).
    const { gw } = creerPasserelle({ role: 'DEPOT', missionIds: ['m-2', 'm-1'] });
    const client = creerClient();
    await gw.handleConnection(client as never);
    // Trie : l'ordre des missions ne doit pas rendre l'empreinte instable, sinon on
    // deconnecterait le depot a chaque tick.
    expect(client.data.scopeKey).toBe('DEPOT|m-1,m-2');
  });

  it('un autre role garde son comportement — la branche ne deborde pas', async () => {
    const { gw, depotScope } = creerPasserelle({ role: 'FLEET_ADMIN', accessible: 'ALL' });
    const client = creerClient();
    await gw.handleConnection(client as never);
    expect(depotScope.activeMissionIds).not.toHaveBeenCalled();
    expect(client.salons).toContain('fleet:f1');
  });
});
