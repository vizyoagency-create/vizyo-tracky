import { TrackerStatus } from '@prisma/client';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { TcpServerService } from './tcp-server.service';

/**
 * ÉTAPE 1 — FILET DE CARACTÉRISATION DU CHEMIN COBAN (2026-09-27)
 *
 * ══ Pourquoi ce fichier existe ══════════════════════════════════════════════════════════
 *
 * Avant ce fichier, `tcp-server.service.spec.ts` ne couvrait QUE le débounce OFFLINE
 * (9 cas sur `scheduleOffline` / `markOffline` / `handleSocketClose`). Les deux fonctions
 * qui portent réellement le trafic des boîtiers — `handleConnection` (bufferisation et
 * découpage des trames) et `dispatchFrame` (les cinq branches login / heartbeat /
 * position / no_fix / unknown) — n'avaient **aucun** test. Or c'est exactement là qu'un
 * second protocole viendra se greffer.
 *
 * Ces tests DÉCRIVENT le comportement ACTUEL, tel qu'il est, sans le juger. Ce ne sont
 * pas des tests d'intention : plusieurs d'entre eux verrouillent des choix contestables
 * (§ « PIÈGES CARACTÉRISÉS » plus bas). Leur rôle est de prouver qu'on n'a rien cassé.
 *
 * ⚠️ RÈGLE D'USAGE : si l'un de ces tests devient rouge pendant l'ajout du Teltonika,
 * la bonne réaction n'est PAS de l'adapter — c'est de défaire le changement qui l'a
 * cassé. Un test de caractérisation qui change de valeur attendue ne prouve plus rien.
 *
 * ══ PIÈGES CARACTÉRISÉS (comportements actuels, volontairement figés ici) ══════════════
 *
 *  1. `chunk.toString('ascii')` EFFACE le bit de poids fort de chaque octet : 0x8E — qui
 *     est précisément l'identifiant du Codec 8 Extended de Teltonika — arrive comme 0x0E.
 *     Sans exception, sans log. Voir le test « la conversion 'ascii' efface le bit 7 ».
 *  2. Le découpage des trames se fait sur `;`, CR ou LF, soit les octets 0x3B / 0x0D /
 *     0x0A, qui apparaissent naturellement à l'intérieur d'un payload binaire.
 *  3. Conséquence mesurée ici : un boîtier Teltonika branché sur le port Coban est
 *     TOTALEMENT INERTE — ni réponse, ni trame, ni erreur, ni entrée dans la liste des
 *     « boîtiers non reconnus ». Il n'existe pas, jusqu'au timeout de socket de 300 s.
 */

// ─── Trames Coban réelles (mêmes IMEI et mêmes formats que coban.parser.spec.ts) ─────────
const IMEI = '864035050002451';
const AUTRE_IMEI = '864035054757027';

const TRAME_LOGIN = `##,imei:${IMEI},A;`;
const TRAME_HEARTBEAT = `${IMEI};`;
const TRAME_POSITION = `imei:${IMEI},tracker,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;`;
/** Même trame, une seconde plus tard : sert à distinguer deux ingestions successives. */
const TRAME_POSITION_2 = `imei:${IMEI},tracker,201223064948,,F,064948,A,1935.70650,N,09859.94436,W,0.025,;`;
const TRAME_POSITION_SOS = `imei:${IMEI},help me,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;`;
/** Rapport LBS sans lock satellite : boîtier vivant, aucune coordonnée. */
const TRAME_NO_FIX = `imei:${IMEI},tracker,260620044013,100%,L,,,c22,,6764c47,,,,,0,0,0.00%,,;`;
const TRAME_POSITION_AUTRE_IMEI = `imei:${AUTRE_IMEI},tracker,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;`;

/** Handshake Teltonika : longueur d'IMEI sur 2 octets (`00 0F` = 15) puis l'IMEI en ASCII. */
const HANDSHAKE_TELTONIKA = Buffer.concat([
  Buffer.from([0x00, 0x0f]),
  Buffer.from(IMEI, 'ascii'),
]);

/** Paquet Codec 8 Extended : trame d'exemple de la documentation Teltonika officielle. */
const PAQUET_AVL_TELTONIKA = Buffer.from(
  '000000000000004A8E010000016B412CEE0001000000000000000000000000000000000100' +
    '05000100010100010011001D00010010015E2C880002000B000000003544C87A000E0000' +
    '00001DD7E06A00000100002994',
  'hex',
);

// ─── Faux socket : émet des octets exactement comme le noyau les livrerait ────────────────

class FauxSocket extends EventEmitter {
  readonly ecrits: Array<string | Buffer> = [];
  readonly remoteAddress = '10.0.0.7';
  readonly remotePort = 51234;
  destroyed = false;
  writable = true;
  readonly setKeepAlive = jest.fn();
  readonly setTimeout = jest.fn();
  readonly end = jest.fn(() => {
    this.destroyed = true;
  });

  write(donnees: string | Buffer): boolean {
    this.ecrits.push(donnees);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /**
   * Livre des octets sur le fil. On construit le Buffer en `latin1` et non en `utf8` :
   * `latin1` garantit UN octet par caractère, donc une fidélité exacte à ce que le
   * boîtier a réellement émis. Un `utf8` sur un octet >= 0x80 en produirait deux.
   */
  recevoir(octets: string | Buffer): void {
    this.emit('data', Buffer.isBuffer(octets) ? octets : Buffer.from(octets, 'latin1'));
  }

  /** Tout ce que le serveur a écrit vers le boîtier, concaténé. */
  get texteEcrit(): string {
    return this.ecrits
      .map((e) => (typeof e === 'string' ? e : e.toString('latin1')))
      .join('');
  }
}

// ─── Montage ─────────────────────────────────────────────────────────────────────────────

/** Les dépendances du constructeur, nommées par position : évite dix `import type`. */
type Dependances = ConstructorParameters<typeof TcpServerService>;

/** Surface privée réellement pilotée ici. Typée plutôt que `any` (style imposé). */
interface SurfacePrivee {
  handleConnection(socket: Socket): void;
  pendingOffline: Map<string, ReturnType<typeof setTimeout>>;
}

/**
 * Laisse la chaîne de promesses interne (`chain`, sérialisation par socket) se vider.
 * Chaque trame traverse plusieurs `await` ; un seul tick de microtâche ne suffit pas.
 */
const laisserTraiter = async (tours = 12): Promise<void> => {
  for (let i = 0; i < tours; i += 1) {
    await new Promise<void>((resoudre) => setImmediate(resoudre));
  }
};

function monter() {
  const trackerRow = { id: 'tracker-1', imei: IMEI, vehicle: { id: 'veh-1', fleetId: 'fleet-1' } };

  const registry = {
    register: jest.fn(),
    touch: jest.fn(),
    unregister: jest.fn(),
    get: jest.fn(),
    has: jest.fn().mockReturnValue(false),
  };
  const prisma = {
    tracker: {
      findUnique: jest.fn().mockResolvedValue(trackerRow),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const positions = { ingest: jest.fn().mockResolvedValue(undefined) };
  const alerts = { createFromCobanFrame: jest.fn().mockResolvedValue(null) };
  const gateway = { emitTrackerStatus: jest.fn() };
  const wireLogger = { in: jest.fn(), out: jest.fn(), ackMatch: jest.fn(), ackTimeout: jest.fn() };
  const errorLogger = { record: jest.fn().mockResolvedValue('erreur-1') };
  const ackWaiter = { tryMatch: jest.fn().mockReturnValue(false), cancelAll: jest.fn() };
  const unknownTrackers = { record: jest.fn(), forget: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(0) };

  const service = new TcpServerService(
    config as unknown as Dependances[0],
    registry as unknown as Dependances[1],
    prisma as unknown as Dependances[2],
    positions as unknown as Dependances[3],
    alerts as unknown as Dependances[4],
    gateway as unknown as Dependances[5],
    wireLogger as unknown as Dependances[6],
    errorLogger as unknown as Dependances[7],
    ackWaiter as unknown as Dependances[8],
    unknownTrackers as unknown as Dependances[9],
  );

  const prive = service as unknown as SurfacePrivee;
  const socket = new FauxSocket();
  prive.handleConnection(socket as unknown as Socket);

  return {
    service,
    prive,
    socket,
    trackerRow,
    registry,
    prisma,
    positions,
    alerts,
    gateway,
    wireLogger,
    errorLogger,
    ackWaiter,
    unknownTrackers,
  };
}

type Contexte = ReturnType<typeof monter>;

describe('TcpServerService — caractérisation du chemin Coban', () => {
  let c: Contexte;

  beforeEach(() => {
    c = monter();
  });

  afterEach(() => {
    // Un passage OFFLINE laisse un timer de 90 s : on le purge pour ne pas retenir Jest.
    for (const timer of c.prive.pendingOffline.values()) clearTimeout(timer);
    c.prive.pendingOffline.clear();
    jest.clearAllMocks();
  });

  /** Ouvre la session : la plupart des branches exigent un IMEI déjà lié. */
  const connecter = async (): Promise<void> => {
    c.socket.recevoir(TRAME_LOGIN);
    await laisserTraiter();
    c.socket.ecrits.length = 0;
    jest.clearAllMocks();
  };

  // ══════════════════════════════════════════════════════════════════════════════════════
  // A. Réglage de la socket et découpage des trames (handleConnection)
  // ══════════════════════════════════════════════════════════════════════════════════════

  describe('A. bufferisation et découpage des trames', () => {
    it('arme keep-alive 30 s et timeout de socket 300 s dès la connexion', () => {
      expect(c.socket.setKeepAlive).toHaveBeenCalledWith(true, 30_000);
      expect(c.socket.setTimeout).toHaveBeenCalledWith(300_000);
    });

    it('une trame terminée par « ; » est traitée', async () => {
      c.socket.recevoir(TRAME_LOGIN);
      await laisserTraiter();

      expect(c.registry.register).toHaveBeenCalledTimes(1);
      expect(c.socket.texteEcrit).toBe('LOAD');
    });

    it('DEUX trames dans UN SEUL chunk sont traitées toutes les deux, dans l’ordre', async () => {
      c.socket.recevoir(TRAME_LOGIN + TRAME_POSITION);
      await laisserTraiter();

      expect(c.registry.register).toHaveBeenCalledTimes(1);
      expect(c.positions.ingest).toHaveBeenCalledTimes(1);
      // L'ordre compte : sans lui, la position arriverait avant que l'IMEI soit lié et
      // serait jetée (« Position received before login »).
      expect(c.registry.register.mock.invocationCallOrder[0]).toBeLessThan(
        c.positions.ingest.mock.invocationCallOrder[0],
      );
    });

    it('une trame COUPÉE EN DEUX chunks est recollée (le « ; » arrive au second)', async () => {
      const coupe = TRAME_LOGIN.length - 5;
      c.socket.recevoir(TRAME_LOGIN.slice(0, coupe));
      await laisserTraiter();
      expect(c.registry.register).not.toHaveBeenCalled(); // rien tant que le « ; » manque

      c.socket.recevoir(TRAME_LOGIN.slice(coupe));
      await laisserTraiter();
      expect(c.registry.register).toHaveBeenCalledTimes(1);
    });

    it('le tampon survit à TROIS chunks successifs (un octet à la fois)', async () => {
      for (const octet of TRAME_LOGIN.slice(0, -1)) {
        c.socket.recevoir(octet);
      }
      await laisserTraiter();
      expect(c.registry.register).not.toHaveBeenCalled();

      c.socket.recevoir(';');
      await laisserTraiter();
      expect(c.registry.register).toHaveBeenCalledTimes(1);
    });

    it('CR et LF terminent aussi une trame, pas seulement « ; »', async () => {
      c.socket.recevoir(`##,imei:${IMEI},A\r\n`);
      await laisserTraiter();

      expect(c.registry.register).toHaveBeenCalledWith(IMEI, c.socket);
    });

    it('les segments vides (« ;; ») sont ignorés sans erreur', async () => {
      c.socket.recevoir(';;;' + TRAME_LOGIN + ';;');
      await laisserTraiter();

      expect(c.registry.register).toHaveBeenCalledTimes(1);
      expect(c.errorLogger.record).not.toHaveBeenCalled();
    });

    it('un chunk SANS séparateur ne déclenche aucun traitement', async () => {
      c.socket.recevoir('imei:864035050002451,tracker,201223064947');
      await laisserTraiter();

      expect(c.positions.ingest).not.toHaveBeenCalled();
      expect(c.errorLogger.record).not.toHaveBeenCalled();
      expect(c.socket.texteEcrit).toBe('');
    });

    it('les trames d’un même chunk sont traitées STRICTEMENT l’une après l’autre', async () => {
      await connecter();

      // La première ingestion est bloquée : la seconde trame ne doit pas démarrer.
      let debloquer!: () => void;
      const premiereIngestion = new Promise<void>((resoudre) => {
        debloquer = resoudre;
      });
      c.positions.ingest.mockImplementationOnce(() => premiereIngestion);

      c.socket.recevoir(TRAME_POSITION + TRAME_POSITION_2);
      await laisserTraiter();
      expect(c.positions.ingest).toHaveBeenCalledTimes(1); // la 2e attend son tour

      debloquer();
      await laisserTraiter();
      expect(c.positions.ingest).toHaveBeenCalledTimes(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // B. login
  // ══════════════════════════════════════════════════════════════════════════════════════

  describe('B. login', () => {
    it('IMEI connu : inscrit la socket, répond LOAD, passe ONLINE et oublie le « non reconnu »', async () => {
      c.socket.recevoir(TRAME_LOGIN);
      await laisserTraiter();

      expect(c.prisma.tracker.findUnique).toHaveBeenCalledWith({ where: { imei: IMEI } });
      expect(c.unknownTrackers.forget).toHaveBeenCalledWith(IMEI);
      expect(c.registry.register).toHaveBeenCalledWith(IMEI, c.socket);
      expect(c.socket.texteEcrit).toBe('LOAD');
      expect(c.prisma.tracker.update).toHaveBeenCalledWith({
        where: { id: c.trackerRow.id },
        data: { status: TrackerStatus.ONLINE, lastSeenAt: expect.any(Date) },
      });
      expect(c.socket.end).not.toHaveBeenCalled();
    });

    it('LOAD est écrit AVANT l’écriture en base (le boîtier n’attend pas la DB)', async () => {
      c.socket.recevoir(TRAME_LOGIN);
      await laisserTraiter();

      // Caractérisation d'un choix de latence délibéré : inverser l'ordre ferait
      // dépendre l'acceptation du boîtier de la disponibilité de PostgreSQL.
      expect(c.socket.ecrits).toEqual(['LOAD']);
      expect(c.registry.register.mock.invocationCallOrder[0]).toBeLessThan(
        c.prisma.tracker.update.mock.invocationCallOrder[0],
      );
    });

    it('IMEI INCONNU : mémorise la tentative, ferme la socket, n’écrit RIEN', async () => {
      c.prisma.tracker.findUnique.mockResolvedValueOnce(null);

      c.socket.recevoir(TRAME_LOGIN);
      await laisserTraiter();

      expect(c.unknownTrackers.record).toHaveBeenCalledWith(IMEI, c.socket.remoteAddress);
      expect(c.socket.end).toHaveBeenCalledTimes(1);
      expect(c.socket.texteEcrit).toBe(''); // pas de LOAD
      expect(c.registry.register).not.toHaveBeenCalled();
      expect(c.prisma.tracker.update).not.toHaveBeenCalled();
    });

    it('le login annule un passage OFFLINE en attente (anti-flapping)', async () => {
      c.prive.pendingOffline.set(IMEI, setTimeout(() => undefined, 90_000));

      c.socket.recevoir(TRAME_LOGIN);
      await laisserTraiter();

      expect(c.prive.pendingOffline.has(IMEI)).toBe(false);
    });

    it('journalise la trame de login sous l’IMEI qu’elle porte', async () => {
      c.socket.recevoir(TRAME_LOGIN);
      await laisserTraiter();

      expect(c.wireLogger.in).toHaveBeenCalledWith(IMEI, TRAME_LOGIN.slice(0, -1), 'login');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // C. heartbeat
  // ══════════════════════════════════════════════════════════════════════════════════════

  describe('C. heartbeat', () => {
    it('IMEI concordant : rafraîchit le registre et répond ON', async () => {
      await connecter();

      c.socket.recevoir(TRAME_HEARTBEAT);
      await laisserTraiter();

      expect(c.registry.touch).toHaveBeenCalledWith(IMEI);
      expect(c.socket.texteEcrit).toBe('ON');
    });

    it('IMEI NON concordant : ignoré, ni touch ni ON', async () => {
      await connecter();

      c.socket.recevoir(`${AUTRE_IMEI};`);
      await laisserTraiter();

      expect(c.registry.touch).not.toHaveBeenCalled();
      expect(c.socket.texteEcrit).toBe('');
    });

    it('AVANT tout login : ignoré (aucun IMEI lié à comparer)', async () => {
      c.socket.recevoir(TRAME_HEARTBEAT);
      await laisserTraiter();

      expect(c.registry.touch).not.toHaveBeenCalled();
      expect(c.socket.texteEcrit).toBe('');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // D. position
  // ══════════════════════════════════════════════════════════════════════════════════════

  describe('D. position', () => {
    it('ingère la trame décodée avec ses champs métier', async () => {
      await connecter();

      c.socket.recevoir(TRAME_POSITION);
      await laisserTraiter();

      expect(c.positions.ingest).toHaveBeenCalledTimes(1);
      expect(c.positions.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'position',
          imei: IMEI,
          alarm: 'none',
          valid: true,
          latitude: expect.closeTo(19.5951, 3),
          longitude: expect.closeTo(-98.9991, 3),
        }),
      );
    });

    it('AVANT le login : jetée, aucune ingestion', async () => {
      c.socket.recevoir(TRAME_POSITION);
      await laisserTraiter();

      expect(c.positions.ingest).not.toHaveBeenCalled();
    });

    it('IMEI NON concordant : jetée, aucune ingestion', async () => {
      await connecter();

      c.socket.recevoir(TRAME_POSITION_AUTRE_IMEI);
      await laisserTraiter();

      expect(c.positions.ingest).not.toHaveBeenCalled();
    });

    it('SANS alarme : aucune lecture du tracker, aucune alerte créée', async () => {
      await connecter();

      c.socket.recevoir(TRAME_POSITION);
      await laisserTraiter();

      // Économie délibérée : le snapshot TRK-040 ne se paie que s'il y a une alarme.
      expect(c.prisma.tracker.findUnique).not.toHaveBeenCalled();
      expect(c.alerts.createFromCobanFrame).not.toHaveBeenCalled();
    });

    it('AVEC alarme : lit le tracker AVANT d’ingérer (TRK-040), puis crée l’alerte', async () => {
      await connecter();

      c.socket.recevoir(TRAME_POSITION_SOS);
      await laisserTraiter();

      expect(c.prisma.tracker.findUnique).toHaveBeenCalledWith({
        where: { imei: IMEI },
        include: { vehicle: { include: { fleet: true } } },
      });
      // L'ordre EST le correctif TRK-040 : l'état du contact qui départage une alarme
      // d'alimentation est celui d'AVANT la trame, pas celui qu'elle vient d'écrire.
      expect(c.prisma.tracker.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        c.positions.ingest.mock.invocationCallOrder[0],
      );
      expect(c.alerts.createFromCobanFrame).toHaveBeenCalledTimes(1);
    });

    it('alarme SOS : renvoie l’accusé « **,imei:<IMEI>,E; »', async () => {
      await connecter();

      c.socket.recevoir(TRAME_POSITION_SOS);
      await laisserTraiter();

      expect(c.socket.texteEcrit).toBe(`**,imei:${IMEI},E;`);
    });

    it('tente de résoudre un ACK en attente avec la trame brute', async () => {
      await connecter();

      c.socket.recevoir(TRAME_POSITION);
      await laisserTraiter();

      expect(c.ackWaiter.tryMatch).toHaveBeenCalledWith(IMEI, TRAME_POSITION.slice(0, -1));
    });

    it('une alerte qui échoue n’interrompt pas le traitement de la trame', async () => {
      await connecter();
      c.alerts.createFromCobanFrame.mockRejectedValueOnce(new Error('alerte cassée'));

      c.socket.recevoir(TRAME_POSITION_SOS);
      await laisserTraiter();

      expect(c.positions.ingest).toHaveBeenCalledTimes(1); // la position est bien enregistrée
      expect(c.errorLogger.record).toHaveBeenCalledWith(
        expect.any(Error),
        'tcp-server',
        expect.objectContaining({ imei: IMEI, alarm: 'sos' }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // E. no_fix — boîtier vivant, sans lock GPS
  // ══════════════════════════════════════════════════════════════════════════════════════

  describe('E. no_fix', () => {
    it('rafraîchit lastSeenAt ET lastNoFixAt, SANS écrire de position', async () => {
      await connecter();

      c.socket.recevoir(TRAME_NO_FIX);
      await laisserTraiter();

      expect(c.registry.touch).toHaveBeenCalledWith(IMEI);
      expect(c.prisma.tracker.update).toHaveBeenCalledWith({
        where: { imei: IMEI },
        data: { lastSeenAt: expect.any(Date), lastNoFixAt: expect.any(Date) },
      });
      // Le discriminant « GPS perdu » : vivant mais aucune coordonnée à persister.
      expect(c.positions.ingest).not.toHaveBeenCalled();
    });

    it('AVANT le login : ignorée', async () => {
      c.socket.recevoir(TRAME_NO_FIX);
      await laisserTraiter();

      expect(c.prisma.tracker.update).not.toHaveBeenCalled();
      expect(c.registry.touch).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // F. unknown
  // ══════════════════════════════════════════════════════════════════════════════════════

  describe('F. trame non reconnue', () => {
    it('tente d’abord de la faire correspondre à un ACK en attente', async () => {
      await connecter();
      c.ackWaiter.tryMatch.mockReturnValue(true);

      c.socket.recevoir('fix030s ok;');
      await laisserTraiter();

      expect(c.ackWaiter.tryMatch).toHaveBeenCalledWith(IMEI, 'fix030s ok');
      expect(c.errorLogger.record).not.toHaveBeenCalled();
    });

    it('sans ACK correspondant : ne lève pas, n’écrit rien, ne persiste rien', async () => {
      await connecter();

      c.socket.recevoir('n’importe quoi;');
      await laisserTraiter();

      expect(c.errorLogger.record).not.toHaveBeenCalled();
      expect(c.positions.ingest).not.toHaveBeenCalled();
      expect(c.socket.texteEcrit).toBe('');
    });

    it('une trame OBD n’est PAS implémentée et reste sans effet', async () => {
      await connecter();

      c.socket.recevoir(`imei:${IMEI},OBD,201223064947,,,,,,,,,,,;`);
      await laisserTraiter();

      expect(c.positions.ingest).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // G. robustesse — une trame fautive ne doit pas tuer la socket
  // ══════════════════════════════════════════════════════════════════════════════════════

  describe('G. robustesse de la chaîne', () => {
    it('une ingestion qui lève est journalisée, et la trame SUIVANTE est quand même traitée', async () => {
      await connecter();
      c.positions.ingest.mockRejectedValueOnce(new Error('base indisponible'));

      c.socket.recevoir(TRAME_POSITION);
      await laisserTraiter();
      expect(c.errorLogger.record).toHaveBeenCalledWith(
        expect.any(Error),
        'tcp-server',
        expect.objectContaining({ imei: IMEI, frameRaw: TRAME_POSITION.slice(0, -1) }),
      );

      // La chaîne de promesses ne doit pas être morte avec l'erreur.
      c.socket.recevoir(TRAME_POSITION_2);
      await laisserTraiter();
      expect(c.positions.ingest).toHaveBeenCalledTimes(2);
      expect(c.socket.destroyed).toBe(false);
    });

    it('avant tout login, une trame non-login n’est PAS journalisée sur le fil', async () => {
      c.socket.recevoir(TRAME_POSITION);
      await laisserTraiter();

      // Condition actuelle : `boundImei || frame.type === 'login'`.
      expect(c.wireLogger.in).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // H. FRONTIÈRE DE PROTOCOLE — ce que fait AUJOURD'HUI le port Coban face à du Teltonika
  // ══════════════════════════════════════════════════════════════════════════════════════

  describe('H. frontière de protocole (état des lieux avant le second port)', () => {
    it('la conversion « ascii » EFFACE le bit 7 : l’octet 0x8E arrive comme 0x0E', async () => {
      await connecter();

      // 0x8E est l'identifiant du Codec 8 Extended de Teltonika ; 0x3B est le « ; » qui
      // clôt la trame côté Coban. On observe ce que le décodeur a RÉELLEMENT reçu.
      c.socket.recevoir(Buffer.from([0x8e, 0x3b]));
      await laisserTraiter();

      expect(c.wireLogger.in).toHaveBeenCalledTimes(1);
      const brut = c.wireLogger.in.mock.calls[0][1] as string;
      expect(brut).toHaveLength(1);
      expect(brut.charCodeAt(0)).toBe(0x0e); // et NON 0x8e : le bit de poids fort est perdu
    });

    it('un handshake Teltonika sur le port Coban est TOTALEMENT INERTE', async () => {
      c.socket.recevoir(HANDSHAKE_TELTONIKA);
      await laisserTraiter();

      // Aucun de ses octets n'est « ; », CR ou LF : rien ne sort jamais du tampon.
      expect(c.socket.texteEcrit).toBe(''); // ni 0x01 ni 0x00 : le boîtier attend dans le vide
      expect(c.registry.register).not.toHaveBeenCalled();
      expect(c.unknownTrackers.record).not.toHaveBeenCalled(); // pas même signalé en admin
      expect(c.errorLogger.record).not.toHaveBeenCalled();
      expect(c.positions.ingest).not.toHaveBeenCalled();
      expect(c.socket.destroyed).toBe(false); // il mourra au timeout de 300 s, en silence
    });

    it('un paquet AVL Codec 8 Extended sur le port Coban est TOTALEMENT INERTE', async () => {
      c.socket.recevoir(PAQUET_AVL_TELTONIKA);
      await laisserTraiter();

      expect(c.socket.texteEcrit).toBe(''); // aucun accusé de 4 octets : le boîtier réémettra
      expect(c.positions.ingest).not.toHaveBeenCalled();
      expect(c.errorLogger.record).not.toHaveBeenCalled();
    });

    it('un octet binaire valant « ; » découpe le flux Teltonika en trames non reconnues', async () => {
      await connecter();

      // Cas général, sans lequel le test précédent rassurerait à tort : dès qu'une valeur
      // CAN vaut 0x3B, le découpage Coban tranche au milieu du binaire. Rien n'est
      // persistable, mais il faut que rien ne casse non plus.
      c.socket.recevoir(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x3b, 0x8e, 0x01, 0x3b]));
      await laisserTraiter();

      expect(c.positions.ingest).not.toHaveBeenCalled();
      expect(c.prisma.tracker.update).not.toHaveBeenCalled();
      expect(c.errorLogger.record).not.toHaveBeenCalled();
      expect(c.socket.destroyed).toBe(false);
    });
  });
});
