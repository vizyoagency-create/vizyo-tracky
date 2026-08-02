import { WS_EVENTS } from '@vizyo/tracky-shared';
import { RealtimeGateway } from './realtime.gateway';

/**
 * PÉRIMÈTRE PAR VÉHICULE EN TEMPS RÉEL.
 *
 * ── Le défaut (audit du 2026-08-02) ─────────────────────────────────────────────────
 * Les salons de flotte diffusent à TOUS leurs membres. Un gestionnaire limité à
 * 2 véhicules recevait donc en continu la latitude et la longitude des 28 autres —
 * alors que l'API HTTP, elle, les lui refuse.
 *
 * Le masquage existait uniquement dans le navigateur (`map.component.ts`), c'est-à-dire
 * APRÈS que la donnée soit arrivée : lisible dans l'onglet réseau, et absent pendant le
 * chargement initial. **Un filtrage côté client n'est pas un cloisonnement.**
 *
 * Règle appliquée : un compte au périmètre restreint n'entre dans AUCUN salon de flotte.
 * Il est servi socket par socket, filtré. Les comptes à périmètre complet — la très
 * grande majorité — gardent le chemin collectif, qui ne coûte rien.
 */
function makeClient(id: string) {
  const rooms: string[] = [];
  return {
    rooms,
    id,
    handshake: { auth: { token: 'tok' } },
    data: {} as Record<string, unknown>,
    join: jest.fn((r: string) => rooms.push(r)),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

function makeGateway(
  user: { id: string; role: string; fleetId: string | null },
  accessible: string[] | 'ALL',
) {
  const auth = {
    verifyAccessToken: jest.fn().mockReturnValue({ sub: user.id }),
    resolveLocalUser: jest.fn().mockResolvedValue({ email: 'u@x.com', ...user }),
  };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ role: user.role, permissions: { alerts_view: true } }) },
  };
  const access = { getAccessibleVehicleIds: jest.fn().mockResolvedValue(accessible) };
  const gw = new RealtimeGateway(auth as never, prisma as never, access as never);
  const chain = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
  gw.server = { to: jest.fn().mockReturnValue(chain) } as never;
  return { gw, chain };
}

describe('RealtimeGateway — périmètre par véhicule', () => {
  describe('adhésion aux salons', () => {
    it('périmètre COMPLET : les salons de flotte, comme avant', async () => {
      const { gw } = makeGateway({ id: 'u1', role: 'FLEET_ADMIN', fleetId: 'f1' }, 'ALL');
      const client = makeClient('s1');
      await gw.handleConnection(client as never);

      expect(client.rooms).toContain('fleet:f1');
      expect(client.rooms).toContain('pos:fleet:f1');
    });

    it('⚠️ périmètre RESTREINT : AUCUN salon de flotte', async () => {
      // LE test du correctif. Y entrer, c'est recevoir tout le reste de la flotte.
      const { gw } = makeGateway({ id: 'u2', role: 'FLEET_MANAGER', fleetId: 'f1' }, ['v1', 'v2']);
      const client = makeClient('s2');
      await gw.handleConnection(client as never);

      expect(client.rooms).not.toContain('fleet:f1');
      expect(client.rooms).not.toContain('pos:fleet:f1');
      expect(client.rooms).not.toContain('alerts:fleet:f1');
    });
  });

  describe('lot de positions', () => {
    async function withRestricted(allowed: string[]) {
      const { gw, chain } = makeGateway({ id: 'u2', role: 'FLEET_MANAGER', fleetId: 'f1' }, allowed);
      const client = makeClient('s2');
      await gw.handleConnection(client as never);
      return { gw, chain, client };
    }

    it('⚠️ un compte restreint ne recoit QUE ses vehicules', async () => {
      const t = await withRestricted(['v1']);
      t.gw.emitPositionsBatch('f1', [{ vehicleId: 'v1' }, { vehicleId: 'v2' }, { vehicleId: 'v3' }]);

      expect(t.client.emit).toHaveBeenCalledTimes(1);
      const [evt, payload] = t.client.emit.mock.calls[0] as [string, { positions: unknown[] }];
      expect(evt).toBe(WS_EVENTS.POSITIONS_BATCH);
      expect(payload.positions).toEqual([{ vehicleId: 'v1' }]);
    });

    it('le salon collectif recoit TOUJOURS le lot complet', async () => {
      // Le chemin des comptes non restreints ne doit pas etre degrade par le correctif.
      const t = await withRestricted(['v1']);
      t.gw.emitPositionsBatch('f1', [{ vehicleId: 'v1' }, { vehicleId: 'v2' }]);

      const [, payload] = t.chain.emit.mock.calls[0] as [string, { positions: unknown[] }];
      expect(payload.positions).toHaveLength(2);
    });

    it('aucun vehicule concerne : on n envoie RIEN plutot qu un lot vide', async () => {
      // Sinon c'est du bruit reseau chaque seconde pour un compte qui ne suit aucun
      // des vehicules en mouvement.
      const t = await withRestricted(['v9']);
      t.gw.emitPositionsBatch('f1', [{ vehicleId: 'v1' }, { vehicleId: 'v2' }]);
      expect(t.client.emit).not.toHaveBeenCalled();
    });

    it('une position sans vehicule n est jamais servie a un compte restreint', async () => {
      const t = await withRestricted(['v1']);
      t.gw.emitPositionsBatch('f1', [{ vehicleId: null }]);
      expect(t.client.emit).not.toHaveBeenCalled();
    });
  });

  describe('robustesse', () => {
    it('⚠️ perimetre illisible : AUCUN live, jamais « tout »', async () => {
      // Fail-closed. Une panne de lecture ne doit jamais elargir ce qu'un compte recoit :
      // le pire cas acceptable est un ecran sans live, visible immediatement.
      const auth = {
        verifyAccessToken: jest.fn().mockReturnValue({ sub: 'u3' }),
        resolveLocalUser: jest.fn().mockResolvedValue({ id: 'u3', email: 'u@x.com', role: 'FLEET_MANAGER', fleetId: 'f1' }),
      };
      const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ role: 'FLEET_MANAGER', permissions: {} }) } };
      const access = { getAccessibleVehicleIds: jest.fn().mockRejectedValue(new Error('base indisponible')) };
      const gw = new RealtimeGateway(auth as never, prisma as never, access as never);
      gw.server = { to: jest.fn().mockReturnValue({ to: jest.fn().mockReturnThis(), emit: jest.fn() }) } as never;

      const client = makeClient('s3');
      await gw.handleConnection(client as never);

      expect(client.rooms).not.toContain('pos:fleet:f1');
      gw.emitPositionsBatch('f1', [{ vehicleId: 'v1' }]);
      expect(client.emit).not.toHaveBeenCalled();
    });

    it('la deconnexion retire le raccordement du registre', async () => {
      // Sans ce retrait, le registre grossirait a chaque reconnexion et on emettrait
      // vers des sockets mortes.
      const { gw } = makeGateway({ id: 'u2', role: 'FLEET_MANAGER', fleetId: 'f1' }, ['v1']);
      const client = makeClient('s2');
      await gw.handleConnection(client as never);

      gw.handleDisconnect(client as never);
      gw.emitPositionsBatch('f1', [{ vehicleId: 'v1' }]);
      expect(client.emit).not.toHaveBeenCalled();
    });
  });
});
