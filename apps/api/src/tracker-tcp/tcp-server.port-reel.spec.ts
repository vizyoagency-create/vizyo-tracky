import { createConnection, type Server, type Socket } from 'node:net';
import { TcpServerService } from './tcp-server.service';

/**
 * ÉTAPE 1 — FILET DE CARACTÉRISATION : LE LISTENER, SUR UN VRAI PORT (2026-09-27)
 *
 * ══ Pourquoi ce fichier, en plus de tcp-server.caracterisation.spec.ts ═════════════════
 *
 * Le filet unitaire pilote `handleConnection` directement, avec un faux socket. Il prouve
 * la logique, pas le CÂBLAGE : il ne dirait rien si `onModuleInit` cessait d'écouter, si
 * le port lu changeait, si le `createServer` n'était plus branché sur `handleConnection`,
 * ou si la fermeture fuyait. Aucun test du dépôt n'ouvrait de socket TCP réelle — les
 * quatre specs e2e existantes (depot-isolation, health, privacy-ingestion, retention) ne
 * touchent pas au listener.
 *
 * Ici on ouvre un VRAI serveur sur un port éphémère (port 0 → le noyau en attribue un),
 * on s'y connecte avec un VRAI client `node:net`, et on parle le protocole sur le fil.
 * Seule la persistance est simulée : aucune base n'est requise.
 *
 * C'est ce test qui verra une régression de branchement le jour où un second écouteur
 * (Teltonika) sera ajouté à côté.
 */

const IMEI = '864035050002451';
const TRAME_LOGIN = `##,imei:${IMEI},A;`;
const TRAME_HEARTBEAT = `${IMEI};`;
const TRAME_POSITION = `imei:${IMEI},tracker,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;`;

/** Handshake Teltonika : `00 0F` (longueur 15) puis l'IMEI en ASCII. */
const HANDSHAKE_TELTONIKA = Buffer.concat([
  Buffer.from([0x00, 0x0f]),
  Buffer.from(IMEI, 'ascii'),
]);

type Dependances = ConstructorParameters<typeof TcpServerService>;

interface SurfacePrivee {
  server: Server | null;
  pendingOffline: Map<string, ReturnType<typeof setTimeout>>;
}

describe('TcpServerService — le listener sur un vrai port TCP', () => {
  const trackerRow = { id: 'tracker-1', imei: IMEI, vehicle: { id: 'veh-1', fleetId: 'fleet-1' } };

  let service: TcpServerService;
  let prive: SurfacePrivee;
  let port: number;
  let clients: Socket[];

  let prisma: { tracker: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock } };
  let positions: { ingest: jest.Mock };
  let registry: { register: jest.Mock; touch: jest.Mock; unregister: jest.Mock; get: jest.Mock; has: jest.Mock };
  let unknownTrackers: { record: jest.Mock; forget: jest.Mock };

  beforeEach(async () => {
    clients = [];
    registry = {
      register: jest.fn(),
      touch: jest.fn(),
      unregister: jest.fn(),
      get: jest.fn(),
      has: jest.fn().mockReturnValue(false),
    };
    prisma = {
      tracker: {
        findUnique: jest.fn().mockResolvedValue(trackerRow),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    positions = { ingest: jest.fn().mockResolvedValue(undefined) };
    unknownTrackers = { record: jest.fn(), forget: jest.fn() };

    // Port 0 : le noyau attribue un port libre. Aucun conflit possible avec un vrai
    // serveur de développement, et aucune valeur codée en dur à maintenir.
    const config = { get: jest.fn().mockReturnValue(0) };

    service = new TcpServerService(
      config as unknown as Dependances[0],
      registry as unknown as Dependances[1],
      prisma as unknown as Dependances[2],
      positions as unknown as Dependances[3],
      { createFromCobanFrame: jest.fn().mockResolvedValue(null) } as unknown as Dependances[4],
      { emitTrackerStatus: jest.fn() } as unknown as Dependances[5],
      { in: jest.fn(), out: jest.fn(), ackMatch: jest.fn(), ackTimeout: jest.fn() } as unknown as Dependances[6],
      { record: jest.fn().mockResolvedValue('erreur-1') } as unknown as Dependances[7],
      { tryMatch: jest.fn().mockReturnValue(false), cancelAll: jest.fn() } as unknown as Dependances[8],
      unknownTrackers as unknown as Dependances[9],
    );

    prive = service as unknown as SurfacePrivee;
    service.onModuleInit();

    // `listen` est asynchrone : on attend que l'adresse soit attribuée.
    port = await new Promise<number>((resoudre, rejeter) => {
      const serveur = prive.server;
      if (!serveur) return rejeter(new Error("onModuleInit n'a pas créé de serveur"));
      serveur.on('listening', () => {
        const adresse = serveur.address();
        if (adresse && typeof adresse === 'object') resoudre(adresse.port);
        else rejeter(new Error('adresse de serveur inattendue'));
      });
      serveur.on('error', rejeter);
    });
  });

  afterEach(async () => {
    for (const client of clients) client.destroy();
    for (const timer of prive.pendingOffline.values()) clearTimeout(timer);
    prive.pendingOffline.clear();
    await service.onModuleDestroy();
  });

  /** Ouvre un vrai client TCP vers le serveur sous test. */
  const connecter = (): Promise<Socket> =>
    new Promise((resoudre, rejeter) => {
      const client = createConnection({ host: '127.0.0.1', port }, () => resoudre(client));
      client.on('error', rejeter);
      clients.push(client);
    });

  /** Attend la prochaine réponse du serveur, ou échoue au bout de `delaiMs`. */
  const attendreReponse = (client: Socket, delaiMs = 2_000): Promise<string> =>
    new Promise((resoudre, rejeter) => {
      const minuterie = setTimeout(() => {
        client.off('data', surDonnees);
        rejeter(new Error(`aucune réponse du serveur en ${delaiMs} ms`));
      }, delaiMs);
      function surDonnees(donnees: Buffer): void {
        clearTimeout(minuterie);
        client.off('data', surDonnees);
        resoudre(donnees.toString('latin1'));
      }
      client.on('data', surDonnees);
    });

  /** Vérifie que le serveur ne répond RIEN pendant `delaiMs`. */
  const attendreSilence = (client: Socket, delaiMs = 400): Promise<void> =>
    new Promise((resoudre, rejeter) => {
      const surDonnees = (donnees: Buffer): void => {
        clearTimeout(minuterie);
        rejeter(new Error(`réponse inattendue: ${donnees.toString('hex')}`));
      };
      const minuterie = setTimeout(() => {
        client.off('data', surDonnees);
        resoudre();
      }, delaiMs);
      client.on('data', surDonnees);
    });

  it('écoute réellement sur le port que la configuration désigne', () => {
    expect(prive.server).not.toBeNull();
    expect(port).toBeGreaterThan(0);
    expect(prive.server?.listening).toBe(true);
  });

  it('un vrai boîtier Coban ouvre sa session et reçoit LOAD sur le fil', async () => {
    const client = await connecter();

    client.write(TRAME_LOGIN);

    await expect(attendreReponse(client)).resolves.toBe('LOAD');
    expect(registry.register).toHaveBeenCalledWith(IMEI, expect.anything());
  });

  it('puis son heartbeat reçoit ON', async () => {
    const client = await connecter();
    client.write(TRAME_LOGIN);
    await attendreReponse(client);

    client.write(TRAME_HEARTBEAT);

    await expect(attendreReponse(client)).resolves.toBe('ON');
  });

  it('puis sa position est ingérée', async () => {
    const client = await connecter();
    client.write(TRAME_LOGIN);
    await attendreReponse(client);

    client.write(TRAME_POSITION);
    await new Promise((resoudre) => setTimeout(resoudre, 200));

    expect(positions.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'position', imei: IMEI }),
    );
  });

  it('session et position dans un SEUL envoi TCP : les deux sont traitées', async () => {
    const client = await connecter();

    // Coalescing TCP réel : un boîtier qui se reconnecte envoie souvent tout d'un coup.
    client.write(TRAME_LOGIN + TRAME_POSITION);
    await attendreReponse(client);
    await new Promise((resoudre) => setTimeout(resoudre, 200));

    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(positions.ingest).toHaveBeenCalledTimes(1);
  });

  it('un IMEI inconnu est mémorisé et le serveur FERME la connexion', async () => {
    prisma.tracker.findUnique.mockResolvedValue(null);
    const client = await connecter();

    const fermeture = new Promise<void>((resoudre) => client.on('close', () => resoudre()));
    client.write(TRAME_LOGIN);
    await fermeture;

    expect(unknownTrackers.record).toHaveBeenCalledWith(IMEI, expect.any(String));
    expect(registry.register).not.toHaveBeenCalled();
  });

  it('deux boîtiers connectés en même temps sont servis tous les deux', async () => {
    const premier = await connecter();
    const second = await connecter();

    premier.write(TRAME_LOGIN);
    second.write(TRAME_LOGIN);

    await expect(attendreReponse(premier)).resolves.toBe('LOAD');
    await expect(attendreReponse(second)).resolves.toBe('LOAD');
    expect(registry.register).toHaveBeenCalledTimes(2);
  });

  it('CARACTÉRISATION — un handshake Teltonika sur ce port reste SANS RÉPONSE', async () => {
    const client = await connecter();

    client.write(HANDSHAKE_TELTONIKA);

    // Ni 0x01 (accepté) ni 0x00 (refusé) : le boîtier attendrait jusqu'au timeout de 300 s.
    // C'est précisément ce que le second port devra corriger — en refusant explicitement.
    await expect(attendreSilence(client)).resolves.toBeUndefined();
    expect(registry.register).not.toHaveBeenCalled();
    expect(unknownTrackers.record).not.toHaveBeenCalled();
  });

  it('onModuleDestroy ferme le serveur et libère le port', async () => {
    await service.onModuleDestroy();

    expect(prive.server?.listening).toBe(false);
    await expect(connecter()).rejects.toThrow();
  });
});
