import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ON VERROUILLE SON TÉLÉPHONE, ON LE ROUVRE, ON EST DÉCONNECTÉ
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le renouvellement proactif repose sur un `setTimeout`. Son propre commentaire (TRK-002)
 * reconnaît qu'un minuteur est GELÉ quand l'onglet passe en arrière-plan — mais rien n'en
 * tirait la conséquence : au retour, il se déclenche EN RETARD, et la page a déjà eu le
 * temps de repartir avec un jeton mort.
 *
 * Le geste n'a rien d'exotique, c'est le plus banal du mobile : on verrouille l'écran, on
 * revient vingt minutes plus tard, l'application reprend et lance ses requêtes. Le
 * rattrapage par 401 existe (l'intercepteur renouvelle puis rejoue), mais il arrive APRÈS
 * l'échec — quelques requêtes perdues, un écran qui clignote, et une déconnexion si le
 * renouvellement rate à cet instant précis.
 *
 * Ces tests tiennent les trois décisions du contrôle au retour au premier plan : il agit
 * quand le jeton est à bout de course, il se TAIT quand il ne l'est pas, et il ne déconnecte
 * jamais de lui-même.
 */

/** Un jeton d'accès dont on choisit l'échéance. Seule la charge utile est lue. */
function jeton(expDansSecondes: number): string {
  const charge = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expDansSecondes }));
  return `entete.${charge}.signature`;
}

/** Le passage au premier plan, tel que le navigateur le produit. */
function revenirAuPremierPlan(): void {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function passerEnArrierePlan(): void {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('AuthService — le retour au premier plan rattrape le minuteur gelé', () => {
  let realFetch: typeof globalThis.fetch;
  let appels: number;
  let reponse: () => Promise<Response>;
  const visibiliteOrigine = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient()] });
    localStorage.setItem('vizyo-tracky-refresh', 'un-refresh-token');
    appels = 0;
    realFetch = globalThis.fetch;
    reponse = () => Promise.resolve(new Response(JSON.stringify({ accessToken: jeton(900) }), { status: 200 }));
    spyOn(globalThis, 'fetch').and.callFake((() => { appels++; return reponse(); }) as typeof globalThis.fetch);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.removeItem('vizyo-tracky-refresh');
    localStorage.removeItem('vizyo-tracky-token');
    if (visibiliteOrigine) Object.defineProperty(Document.prototype, 'visibilityState', visibiliteOrigine);
  });

  it('jeton EXPIRÉ pendant le sommeil de l’onglet : le retour déclenche un renouvellement', async () => {
    // Vingt minutes d'écran verrouillé : le minuteur n'a jamais tiré, le jeton est mort.
    localStorage.setItem('vizyo-tracky-token', jeton(-300));
    TestBed.inject(AuthService);
    const avant = appels;

    passerEnArrierePlan();
    revenirAuPremierPlan();
    await Promise.resolve();

    expect(appels)
      .withContext(
        'Sans ce contrôle, la page repart avec un jeton mort : les requêtes échouent d’abord, ' +
          'et le rattrapage par 401 n’arrive qu’après.',
      )
      .toBeGreaterThan(avant);
  });

  it('jeton ENCORE VALIDE : le retour ne déclenche AUCUN appel réseau', async () => {
    // Le témoin qui compte. Sans le garde d'échéance, chaque va-et-vient entre deux onglets
    // produirait un appel — c'est-à-dire un renouvellement toutes les quelques secondes.
    localStorage.setItem('vizyo-tracky-token', jeton(900));
    TestBed.inject(AuthService);
    const avant = appels;

    passerEnArrierePlan();
    revenirAuPremierPlan();
    revenirAuPremierPlan();
    await Promise.resolve();

    expect(appels).toBe(avant);
  });

  it('DÉCONNECTÉ : le retour au premier plan ne tente rien', async () => {
    // Sur l'écran de connexion il n'y a ni jeton ni refresh : un appel y serait un 401
    // gratuit, et un message d'erreur pour quelqu'un qui n'a rien demandé.
    localStorage.removeItem('vizyo-tracky-refresh');
    TestBed.inject(AuthService);
    const avant = appels;

    revenirAuPremierPlan();
    await Promise.resolve();

    expect(appels).toBe(avant);
  });

  it('le renouvellement ÉCHOUE au réveil : la session reste en place', async () => {
    // Au réveil d'un appareil, le réseau n'est pas encore revenu. C'est exactement le cas
    // que `refreshUnavailable` protège : une API injoignable ne coûte pas sa session.
    localStorage.setItem('vizyo-tracky-token', jeton(-300));
    reponse = () => Promise.resolve(new Response('', { status: 502 }));
    const auth = TestBed.inject(AuthService);

    revenirAuPremierPlan();
    await Promise.resolve();
    await Promise.resolve();

    expect(auth.token)
      .withContext('Un réseau encore endormi ne doit jamais déconnecter.')
      .not.toBeNull();
  });
});
