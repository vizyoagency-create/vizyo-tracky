import { SocketRegistryService, type TrackerSocket } from './socket-registry.service';

/**
 * ÉTAPE 1 — FILET DE CARACTÉRISATION : L'ENVOI VERS LE BOÎTIER (2026-09-27)
 *
 * ══ Pourquoi ce fichier ════════════════════════════════════════════════════════════════
 *
 * `socket-registry.service.spec.ts` compte 5 tests, et TOUS portent sur l'événement
 * `tracker.connected` (T42). La méthode `send()` — celle par laquelle passe RÉELLEMENT
 * toute commande sortante, y compris la coupe et la reprise moteur — n'avait aucun test.
 * Elle porte pourtant quatre décisions non triviales : socket détruite, socket ouverte
 * mais plus inscriptible (« TCP à demi-mort »), exception à l'écriture, et contre-pression.
 * Trois d'entre elles DÉSINSCRIVENT le boîtier au passage.
 *
 * Ce filet la décrit telle qu'elle est, pour deux raisons :
 *
 *  1. c'est du chemin Coban en production — la coupe-circuit en dépend aujourd'hui ;
 *  2. c'est le point par lequel les commandes Codec 12 binaires devront sortir. Le
 *     dernier test verrouille la garantie dont ce chantier a besoin : **un Buffer passe
 *     octet pour octet, sans conversion**. Sans lui, rien ne détecterait qu'une
 *     conversion en chaîne s'est glissée là et a corrompu un CRC.
 */

/** Socket simulée, conforme au contrat `TrackerSocket` du registre. */
class FauxSocket implements TrackerSocket {
  readonly ecrits: Array<string | Buffer> = [];
  destroyed = false;
  writable = true;
  /** Renseigné pour simuler la contre-pression (`write` rend false) ou une exception. */
  resultatEcriture: boolean | Error = true;

  constructor(readonly remoteAddress = '10.0.0.9') {}

  write(donnees: string | Buffer): boolean {
    if (this.resultatEcriture instanceof Error) throw this.resultatEcriture;
    this.ecrits.push(donnees);
    return this.resultatEcriture;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

const IMEI = '864035050002451';

describe('SocketRegistryService — caractérisation de send()', () => {
  let registre: SocketRegistryService;
  let socket: FauxSocket;

  beforeEach(() => {
    // Sans EventEmitter2 : le registre doit fonctionner tel quel (cas des outils et specs).
    registre = new SocketRegistryService();
    socket = new FauxSocket();
    registre.register(IMEI, socket);
  });

  it('écrit sur la socket inscrite et rend true', () => {
    const resultat = registre.send(IMEI, '**,imei:864035050002451,J;');

    expect(resultat).toBe(true);
    expect(socket.ecrits).toEqual(['**,imei:864035050002451,J;']);
  });

  it('IMEI non inscrit : rend false, sans rien écrire', () => {
    const resultat = registre.send('999999999999999', 'peu importe');

    expect(resultat).toBe(false);
    expect(socket.ecrits).toHaveLength(0);
  });

  it('socket DÉTRUITE : rend false, sans écrire — et le boîtier reste inscrit', () => {
    socket.destroyed = true;

    expect(registre.send(IMEI, 'commande')).toBe(false);
    expect(socket.ecrits).toHaveLength(0);
    // Caractérisation : ce cas-là ne désinscrit PAS (contrairement aux deux suivants).
    expect(registre.has(IMEI)).toBe(true);
  });

  it('socket ouverte mais NON INSCRIPTIBLE (TCP à demi-mort) : rend false ET désinscrit', () => {
    socket.writable = false;

    expect(registre.send(IMEI, 'commande')).toBe(false);
    expect(socket.ecrits).toHaveLength(0);
    // Le nettoyage est délibéré : une socket qui n'accepte plus d'écriture ne doit plus
    // faire croire que le boîtier est joignable.
    expect(registre.has(IMEI)).toBe(false);
  });

  it('une écriture qui LÈVE : rend false ET désinscrit', () => {
    socket.resultatEcriture = new Error('EPIPE');

    expect(registre.send(IMEI, 'commande')).toBe(false);
    expect(registre.has(IMEI)).toBe(false);
  });

  it('CONTRE-PRESSION (write rend false) : rend quand même TRUE — le payload est mis en file', () => {
    socket.resultatEcriture = false;

    // Piège caractérisé : `write` qui rend false ne signifie PAS un échec d'envoi, mais
    // « tampon plein, le noyau écoulera plus tard ». Traiter ce cas comme un échec
    // ferait renvoyer la commande une seconde fois.
    expect(registre.send(IMEI, 'commande')).toBe(true);
    expect(socket.ecrits).toEqual(['commande']);
    expect(registre.has(IMEI)).toBe(true);
  });

  it('🔴 un Buffer traverse OCTET POUR OCTET, sans conversion en chaîne', () => {
    // Trame Codec 12 « getinfo » de la documentation Teltonika : son CRC (0x4312) ne
    // survit à AUCUNE conversion de texte. Ce test est la garantie sur laquelle
    // reposera l'envoi des commandes binaires.
    const trame = Buffer.from('000000000000000F0C010500000007676574696E666F0100004312', 'hex');

    expect(registre.send(IMEI, trame)).toBe(true);
    expect(socket.ecrits).toHaveLength(1);
    const ecrit = socket.ecrits[0];
    expect(Buffer.isBuffer(ecrit)).toBe(true);
    expect((ecrit as Buffer).equals(trame)).toBe(true);
    // L'octet 0x8E n'est pas dans cette trame, mais 0x9F et 0x8E le seraient dans une
    // trame Codec 8E : on vérifie donc explicitement qu'aucun octet > 0x7F n'est touché.
    const avecBitHaut = Buffer.from([0x00, 0x8e, 0xff, 0x0c]);
    socket.ecrits.length = 0;
    expect(registre.send(IMEI, avecBitHaut)).toBe(true);
    expect((socket.ecrits[0] as Buffer).equals(avecBitHaut)).toBe(true);
  });

  it('après désinscription, plus rien ne part', () => {
    registre.unregister(IMEI);

    expect(registre.send(IMEI, 'commande')).toBe(false);
    expect(registre.has(IMEI)).toBe(false);
    expect(registre.listOnline()).toEqual([]);
  });

  it('une socket neuve pour le même IMEI reçoit les envois suivants, l’ancienne plus rien', () => {
    const neuve = new FauxSocket('10.0.0.10');
    registre.register(IMEI, neuve);

    expect(registre.send(IMEI, 'commande')).toBe(true);
    expect(neuve.ecrits).toEqual(['commande']);
    expect(socket.ecrits).toHaveLength(0);
    expect(socket.destroyed).toBe(true); // l'ancienne est détruite au remplacement
  });

  it('listOnline et get reflètent l’inscription', () => {
    expect(registre.listOnline()).toEqual([IMEI]);
    expect(registre.get(IMEI)?.remoteAddress).toBe('10.0.0.9');
    expect(registre.get('999999999999999')).toBeUndefined();
  });

  it('touch rafraîchit lastSeenAt sans toucher à la socket', () => {
    const avant = registre.get(IMEI)?.lastSeenAt;
    jest.useFakeTimers().setSystemTime(Date.now() + 5_000);

    registre.touch(IMEI);

    const apres = registre.get(IMEI)?.lastSeenAt;
    expect(apres?.getTime()).toBeGreaterThan(avant?.getTime() ?? 0);
    expect(socket.ecrits).toHaveLength(0);
    jest.useRealTimers();
  });

  it('touch sur un IMEI inconnu ne lève pas', () => {
    expect(() => registre.touch('999999999999999')).not.toThrow();
  });
});
