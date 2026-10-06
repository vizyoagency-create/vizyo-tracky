import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import type { Socket } from 'socket.io-client';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { FleetFilterService } from './fleet-filter.service';
import { NotificationsApiService } from './notifications.service';
import { PermissionsService } from './permissions.service';
import { PreferencesService } from './preferences.service';
import { VisibilityService } from './visibility.service';
import { EtatsVehiculesBus } from './etats-vehicules.bus';
import { ToastService } from '../../shared/ui/toast/toast.service';
import {
  deciderApresTentativeDeRafraichissement,
  RealtimeService,
} from './realtime.service';

/**
 * ══ TRK-050 — LE CHEMIN WEBSOCKET NE DOIT PLUS DÉCONNECTER SUR UNE API INJOIGNABLE ═══════════
 *
 * Ce fichier existe parce que son absence a coûté trois semaines. Le correctif du 2026-08-03
 * (« un serveur injoignable ne doit pas déconnecter ») a été appliqué à l'intercepteur HTTP et
 * jamais au chemin WebSocket, qui porte sa PROPRE logique de déconnexion — et rien ne l'a
 * signalé, faute du moindre test sur ce chemin. Le défaut s'est reproduit 5 fois le 24/08 et
 * 2 fois le 25/08.
 *
 * Deux niveaux, volontairement :
 *   1. la DÉCISION, testée directement sur la fonction pure exportée ;
 *   2. le CÂBLAGE, testé en exerçant le VRAI handler `connect_error` du service via un faux
 *      socket. Une règle parfaite qui n'est appelée par personne ne protège de rien — c'est
 *      exactement la forme qu'avait ce défaut.
 */

describe('TRK-050 — décision après un rafraîchissement échoué (fonction pure)', () => {
  const SEUIL = 3;

  it('un rafraîchissement réussi remet le compteur à zéro', () => {
    expect(
      deciderApresTentativeDeRafraichissement({
        refreshReussi: true, serveurInjoignable: false, echecsCumules: 2, seuil: SEUIL,
      }),
    ).toBe('reinitialiser');
  });

  it('🔴 LE TEST DE RÉGRESSION — serveur injoignable : on IGNORE, même très au-delà du seuil', () => {
    // C'est le défaut de TRK-050 en une assertion. Sous l'ancien code, 3 échecs suffisaient à
    // vider le stockage ; ici, 99 échecs consécutifs ne doivent produire AUCUNE expiration.
    for (const echecsCumules of [0, 1, 2, 3, 10, 99]) {
      expect(
        deciderApresTentativeDeRafraichissement({
          refreshReussi: false, serveurInjoignable: true, echecsCumules, seuil: SEUIL,
        }),
      ).toBe('ignorer');
    }
  });

  it('refus RÉEL sous le seuil : on compte, sans déconnecter', () => {
    expect(
      deciderApresTentativeDeRafraichissement({
        refreshReussi: false, serveurInjoignable: false, echecsCumules: 0, seuil: SEUIL,
      }),
    ).toBe('compter');
    expect(
      deciderApresTentativeDeRafraichissement({
        refreshReussi: false, serveurInjoignable: false, echecsCumules: 1, seuil: SEUIL,
      }),
    ).toBe('compter');
  });

  it('refus RÉEL au seuil : la session expire — le comportement #9 est PRÉSERVÉ', () => {
    // Contrepoint indispensable : sans lui, on « corrigerait » en supprimant la garde, et un
    // onglet laissé ouvert avec un refresh mort martèlerait /auth/refresh à l'infini.
    expect(
      deciderApresTentativeDeRafraichissement({
        refreshReussi: false, serveurInjoignable: false, echecsCumules: 2, seuil: SEUIL,
      }),
    ).toBe('expirer');
  });
});

/**
 * Faux socket : juste assez pour que le service s'installe et que l'on puisse déclencher ses
 * VRAIS handlers. `declencher()` rejoue l'événement exactement comme socket.io le ferait.
 */
class FauxSocket {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  auth: Record<string, string> = {};
  connected = false;
  io = { on: (): void => undefined, off: (): void => undefined };

  on(evenement: string, handler: (...args: unknown[]) => unknown): this {
    this.handlers.set(evenement, handler);
    return this;
  }
  off(): this { return this; }
  emit(): this { return this; }
  connect(): this { this.connected = true; return this; }
  disconnect(): this { this.connected = false; return this; }

  async declencher(evenement: string, ...args: unknown[]): Promise<void> {
    const h = this.handlers.get(evenement);
    if (!h) throw new Error(`aucun handler pour « ${evenement} » — le service a changé de forme`);
    await h(...args);
  }
}

/** Service instrumenté : seule la CRÉATION du socket est remplacée, les handlers sont les vrais. */
class RealtimeServiceTestable extends RealtimeService {
  readonly faux = new FauxSocket();
  protected override creerSocket(): Socket {
    return this.faux as unknown as Socket;
  }
}

describe('TRK-050 — câblage : le vrai handler connect_error', () => {
  let service: RealtimeServiceTestable;
  let auth: { tryRefresh: jasmine.Spy; refreshUnavailable: jasmine.Spy; logout: jasmine.Spy; user: () => null; token: string | null };
  let router: { navigate: jasmine.Spy; url: string };

  beforeEach(() => {
    auth = {
      // Une API injoignable rend `null` — indistinguable d'un refus à l'appel : tout le sujet.
      tryRefresh: jasmine.createSpy('tryRefresh').and.resolveTo(null),
      refreshUnavailable: jasmine.createSpy('refreshUnavailable').and.returnValue(false),
      logout: jasmine.createSpy('logout'),
      user: () => null, // personne de connu : ces scénarios ne portent que sur la connexion
      token: 'jeton-de-test',
    };
    router = { navigate: jasmine.createSpy('navigate').and.resolveTo(true), url: '/dashboard' };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: router },
        // Dépendances non exercées par ces scénarios : mocks minimaux. `NotificationsApiService`
        // tire `SwPush` (service worker) — indisponible en test, et sans rapport avec le sujet.
        { provide: FleetFilterService, useValue: { matches: () => true, isActive: signal(false), selectedFleetId: signal(null) } },
        { provide: NotificationsApiService, useValue: { clearAppBadge: () => undefined, setAppBadge: () => undefined } },
        { provide: PreferencesService, useValue: { prefs: signal({ notifications: {} }) } },
        { provide: VisibilityService, useValue: { isVisible: signal(true), isUserActive: signal(true), lastHiddenDurationMs: () => null } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined, info: () => undefined } },
        // 05/10 — le service lit `alerts_view` ; ces scénarios ne l'exercent pas (voir le bloc dédié).
        { provide: PermissionsService, useValue: { can: () => true } },
        RealtimeServiceTestable,
      ],
    });
    service = TestBed.inject(RealtimeServiceTestable);
    service.connect('jeton-de-test');
  });

  afterEach(() => service.disconnect());

  it('🔴 API INJOIGNABLE : dix échecs de connexion ne déconnectent JAMAIS', async () => {
    // Le scénario exact d'un redéploiement : le socket casse, socket.io retente, chaque
    // tentative échoue à rafraîchir parce que l'API ne répond pas encore.
    auth.refreshUnavailable.and.returnValue(true);

    for (let i = 0; i < 10; i++) {
      await service.faux.declencher('connect_error', new Error('xhr poll error'));
    }

    expect(auth.logout).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('REFUS RÉEL : la session expire toujours au 3ᵉ échec (comportement #9 intact)', async () => {
    auth.refreshUnavailable.and.returnValue(false); // le serveur répond, et il REFUSE

    await service.faux.declencher('connect_error', new Error('unauthorized'));
    await service.faux.declencher('connect_error', new Error('unauthorized'));
    expect(auth.logout).not.toHaveBeenCalled(); // pas avant le seuil

    await service.faux.declencher('connect_error', new Error('unauthorized'));
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: '/dashboard' } });
  });

  it('🔴 LE COMPTEUR REDESCEND : deux pannes séparées par une reconnexion ne s\'additionnent pas', async () => {
    // Sans la remise à zéro, trois micro-coupures espacées de plusieurs heures suffisaient à
    // éjecter l'utilisateur — SANS aucun redémarrage d'API.
    auth.refreshUnavailable.and.returnValue(false);
    await service.faux.declencher('connect_error', new Error('unauthorized'));
    await service.faux.declencher('connect_error', new Error('unauthorized'));

    await service.faux.declencher('connect'); // le réseau revient

    await service.faux.declencher('connect_error', new Error('unauthorized'));
    await service.faux.declencher('connect_error', new Error('unauthorized'));
    expect(auth.logout).not.toHaveBeenCalled(); // 2 + 2 ne vaut pas 3 quand le compteur redescend
  });

  it('un rafraîchissement qui aboutit remet le compteur à zéro et ne déconnecte pas', async () => {
    auth.refreshUnavailable.and.returnValue(false);
    await service.faux.declencher('connect_error', new Error('unauthorized'));
    await service.faux.declencher('connect_error', new Error('unauthorized'));

    auth.tryRefresh.and.resolveTo('jeton-neuf');
    await service.faux.declencher('connect_error', new Error('unauthorized'));

    auth.tryRefresh.and.resolveTo(null);
    await service.faux.declencher('connect_error', new Error('unauthorized'));
    await service.faux.declencher('connect_error', new Error('unauthorized'));

    expect(auth.logout).not.toHaveBeenCalled();
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   * LA SESSION MEURT PAR LA SOCKET — ET L'ADRESSE DOIT SURVIVRE QUAND MEME
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * Le lot des liens profonds a appris au garde de route et a l'intercepteur HTTP a garder
   * l'adresse en cours. Cette porte-la, dont le commentaire dit pourtant « exactement comme
   * l'intercepteur HTTP », la jetait encore.
   *
   * Ce n'est pas la moins frequente des deux : ce sont la carte live et la fiche vehicule
   * qui tiennent une socket, donc precisement les ecrans qu'une notification d'exces ouvre.
   * Sur ces pages, le WS voit la session morte AVANT le premier appel HTTP — la reparation
   * d'a-cote n'aurait jamais joue.
   */
  async function expirerLaSession(): Promise<void> {
    auth.refreshUnavailable.and.returnValue(false); // le serveur repond, et il REFUSE
    for (let i = 0; i < 3; i++) {
      await service.faux.declencher('connect_error', new Error('unauthorized'));
    }
  }

  it('le trajet ouvert depuis une notification est reporte sur la connexion', async () => {
    router.url = '/vehicles/v1?tab=reports&trip=t1&tripDate=2026-09-06&alert=a1';

    await expirerLaSession();

    expect(router.navigate).toHaveBeenCalledWith(
      ['/login'],
      { queryParams: { returnUrl: '/vehicles/v1?tab=reports&trip=t1&tripDate=2026-09-06&alert=a1' } },
    );
  });

  it('depuis la page de connexion elle-meme, aucun retour : ce serait une boucle', async () => {
    router.url = '/login';

    await expirerLaSession();

    expect(router.navigate).toHaveBeenCalledWith(['/login'], {});
  });
});

/**
 * ══ INCIDENT DU 2026-09-17 — L'OVERLAY « COUPÉ » SUIT LA SOURCE DE VÉRITÉ RELUE ═══════════════
 *
 * Pendant 56 min de panne de l'API, les reprises acquittées ont échappé aux onglets ouverts :
 * la page Horaires affichait « 2 coupés » pour des véhicules rallumés, et ses rechargements
 * périodiques ne corrigeaient rien puisque l'overlay temps réel passait AVANT la ligne relue.
 * `seedCutState` réaligne l'overlay sur la liste REST — sauf pour un tracker qu'un événement
 * WS a modifié PENDANT la lecture (le live est alors plus frais que le REST).
 */
describe('Incident du 17/09 — seedCutState réaligne l’overlay coupe sur la liste relue', () => {
  let service: RealtimeServiceTestable;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { tryRefresh: async () => null, refreshUnavailable: () => false, logout: () => undefined, token: 't' } },
        { provide: Router, useValue: { navigate: async () => true, url: '/fleet-schedules' } },
        { provide: FleetFilterService, useValue: { matches: () => true, isActive: signal(false), selectedFleetId: signal(null) } },
        { provide: NotificationsApiService, useValue: { clearAppBadge: () => undefined, setAppBadge: () => undefined } },
        { provide: PreferencesService, useValue: { prefs: signal({ notifications: {} }) } },
        { provide: VisibilityService, useValue: { isVisible: signal(true), isUserActive: signal(true), lastHiddenDurationMs: () => null } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined, info: () => undefined } },
        // 05/10 — le service lit `alerts_view` ; ces scénarios ne l'exercent pas (voir le bloc dédié).
        { provide: PermissionsService, useValue: { can: () => true } },
        RealtimeServiceTestable,
      ],
    });
    service = TestBed.inject(RealtimeServiceTestable);
  });

  it('un véhicule « coupé » dans l’overlay mais « normal » dans la liste relue est RETIRÉ (la reprise manquée)', () => {
    service.seedCutState([{ trackerId: 't1', state: 'cut' }, { trackerId: 't2', state: 'cut' }]);
    expect([...service.cutActiveTrackerIds()].sort()).toEqual(['t1', 't2']);

    // 20 s plus tard, la liste relue dit : t1 rallumé, t2 toujours coupé, t3 coupe envoyée.
    service.seedCutState([
      { trackerId: 't1', state: 'normal' }, { trackerId: 't2', state: 'cut' }, { trackerId: 't3', state: 'pending' },
    ]);
    expect([...service.cutActiveTrackerIds()]).toEqual(['t2']);
    expect([...service.cutPendingTrackerIds()]).toEqual(['t3']);
  });

  it('un tracker absent de la liste relue n’est pas touché (autre société, autre filtre)', () => {
    service.seedCutState([{ trackerId: 'ailleurs', state: 'cut' }]);
    service.seedCutState([{ trackerId: 't1', state: 'normal' }]);
    expect([...service.cutActiveTrackerIds()]).toEqual(['ailleurs']);
  });

  it('un événement WS arrivé PENDANT la lecture REST garde la main sur la ligne relue', () => {
    // Capture avant la lecture : rien de coupé.
    const avant = service.cutStateSnapshot();
    // Pendant le round-trip, le live annonce une coupe confirmée sur t1.
    service.seedCutState([{ trackerId: 't1', state: 'cut' }]);
    // La réponse REST (calculée AVANT l'événement) dit encore « normal » : elle ne doit pas l'écraser.
    service.seedCutState([{ trackerId: 't1', state: 'normal' }, { trackerId: 't2', state: 'normal' }], avant);
    expect([...service.cutActiveTrackerIds()]).toEqual(['t1']);
  });
});

/**
 * ══ C2 — INCIDENT CDEF31 DU 24/09/2026 : UNE RECONNEXION DOIT RE-LIRE LE SNAPSHOT ═════════════
 *
 * `connect()` hydrate. Une reconnexion socket.io, elle, ne repasse JAMAIS par `connect()` : seul
 * le handler `'connect'` s'exécute — et il ne rechargeait que les alertes. Tout `CUT`/`RESTORE`
 * survenu pendant la coupure était donc perdu POUR TOUJOURS côté affichage.
 *
 * Nuit du 23 au 24/09 : quatre recréations de conteneur entre 00h56 et 01h40. Le veilleur de
 * CDEF31 — à qui `GET /engine-control/commands` répond 403, et dont le bouton n'a donc que cet
 * overlay comme source de vérité — a vu « Couper » sur un véhicule déjà coupé, et n'a pas eu de
 * bouton « Rallumer » sur celui qu'il devait sortir. 50 clics, 15 commandes, une heure perdue.
 *
 * Le test porte sur le CÂBLAGE, pas sur l'intention : c'est précisément un câblage manquant
 * (`seedCutState` écrit après l'incident du 17/09, jamais appelé sur /vehicles) qui a coûté
 * cette nuit-là.
 */
describe('C2 — incident CDEF31 : la reconnexion re-hydrate', () => {
  let service: RealtimeServiceTestable;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            tryRefresh: jasmine.createSpy('tryRefresh').and.resolveTo(null),
            refreshUnavailable: () => false,
            logout: () => undefined,
            isDepot: () => false,
            isDriver: () => false,
            // Sans lui, chaque ouverture de socket levait « this.auth.user is not a function » dans
            // `loadInitialAlerts` — avalé par la promesse, mais imprimé en ERROR à chaque passage.
            user: () => null,
            token: 'jeton-de-test',
          },
        },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true), url: '/vehicles' } },
        { provide: FleetFilterService, useValue: { matches: () => true, isActive: signal(false), selectedFleetId: signal(null) } },
        { provide: NotificationsApiService, useValue: { clearAppBadge: () => undefined, setAppBadge: () => undefined } },
        { provide: PreferencesService, useValue: { prefs: signal({ notifications: {} }) } },
        { provide: VisibilityService, useValue: { isVisible: signal(true), isUserActive: signal(true), lastHiddenDurationMs: () => null } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined, info: () => undefined } },
        // 05/10 — le service lit `alerts_view` ; ces scénarios ne l'exercent pas (voir le bloc dédié).
        { provide: PermissionsService, useValue: { can: () => true } },
        RealtimeServiceTestable,
      ],
    });
    service = TestBed.inject(RealtimeServiceTestable);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => service.disconnect());

  /** Compte les lectures de snapshot DEPUIS le dernier appel (`match` retire les requêtes vues). */
  const lecturesDuSnapshot = (): number =>
    httpMock.match((r) => r.url.includes('/api/vehicles/snapshot')).length;

  it('🔴 LE TEST DE RÉGRESSION — une RE-connexion relit le snapshot, la première ne le lit qu’une fois', async () => {
    service.connect('jeton-de-test');
    expect(lecturesDuSnapshot()).toBe(1); // hydratation initiale, faite par connect() lui-même

    await service.faux.declencher('connect');
    expect(lecturesDuSnapshot())
      .withContext('première ouverture du socket : connect() a déjà hydraté, ne pas doubler')
      .toBe(0);

    await service.faux.declencher('disconnect', 'transport close');
    await service.faux.declencher('connect');
    expect(lecturesDuSnapshot())
      .withContext('RECONNEXION — sous l’ancien code : 0, et l’état coupe restait faux pour toujours')
      .toBe(1);
  });

  it('chaque reconnexion suivante re-hydrate aussi (quatre déploiements = quatre rattrapages)', async () => {
    service.connect('jeton-de-test');
    lecturesDuSnapshot(); // on purge l'hydratation initiale

    await service.faux.declencher('connect'); // 1re ouverture
    lecturesDuSnapshot();

    for (const _ of [1, 2, 3, 4]) {
      await service.faux.declencher('disconnect', 'transport close');
      await service.faux.declencher('connect');
      expect(lecturesDuSnapshot()).toBe(1);
    }
  });
});

/**
 * ══ 05/10/2026 — ON NE DEMANDE PAS AU SERVEUR CE QU'IL REFUSERAIT ════════════════════════════
 *
 * Juste après un redéploiement, l'API a journalisé des 403 « Permission requise : alerts_view »
 * pour un gestionnaire de flotte : le temps réel chargeait les alertes à CHAQUE (re)connexion, en
 * ne gardant que le rôle dépôt. Le veilleur de nuit (qui n'a jamais ce droit), un conducteur, un
 * gestionnaire restreint : tous payaient un 403 par reconnexion — et un redéploiement les
 * reconnecte tous à la fois.
 *
 * Ces tests montent le VRAI `PermissionsService` : c'est SA règle qui doit décider (droits du
 * compte, union des portées par véhicule, administrateurs toujours autorisés — comme le serveur).
 * Un bouchon `can: () => false` prouverait seulement que le bouchon dit non.
 */
describe('alerts_view — le temps réel ne demande pas les alertes à qui ne peut pas les lire', () => {
  let service: RealtimeServiceTestable;
  let httpMock: HttpTestingController;
  type Compte = { sub: string; email: string; role: string; fleetId: string | null; permissions: Record<string, boolean> };
  const user = signal<Compte | null>(null);

  const compte = (role: string, alertsView: boolean): Compte => ({
    sub: 'u-1', email: 'compte@exemple.fr', role, fleetId: 'f-1', permissions: { alerts_view: alertsView },
  });
  /** Une portée « tout le parc » qui ACCORDE le droit — union des portées, comme au serveur. */
  const porteeQuiAccorde = {
    id: 'acc-1', accessType: 'ALL', groupId: null, vehicleId: null, permissions: { alerts_view: true },
    createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', group: null, vehicle: null,
  };

  beforeEach(() => {
    user.set(null);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            user,
            isDepot: () => user()?.role === 'DEPOT',
            isDriver: () => user()?.role === 'DRIVER',
            tryRefresh: async () => null,
            refreshUnavailable: () => false,
            logout: () => undefined,
            token: 'jeton-de-test',
          },
        },
        { provide: Router, useValue: { navigate: async () => true, navigateByUrl: async () => true, url: '/vehicles' } },
        { provide: FleetFilterService, useValue: { matches: () => true, isActive: signal(false), selectedFleetId: signal(null) } },
        { provide: NotificationsApiService, useValue: { clearAppBadge: () => undefined, setAppBadge: () => undefined } },
        { provide: PreferencesService, useValue: { prefs: signal({ notifications: {} }) } },
        { provide: VisibilityService, useValue: { isVisible: signal(true), isUserActive: signal(true), lastHiddenDurationMs: () => null } },
        {
          provide: ToastService,
          useValue: { error: () => undefined, success: () => undefined, info: () => undefined, show: () => undefined, critical: () => undefined },
        },
        // PermissionsService : PAS de bouchon — le vrai, fourni à la racine.
        RealtimeServiceTestable,
      ],
    });
    service = TestBed.inject(RealtimeServiceTestable);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => service.disconnect());

  /** Laisse tourner les effets ET les promesses (le service des droits lit ses portées en `toPromise`). */
  const stabiliser = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      TestBed.tick();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  /** Répond aux lectures des portées par véhicule, que le vrai service lance dès qu'un compte est connu. */
  const repondreAcces = async (entries: unknown[]): Promise<void> => {
    await stabiliser();
    for (const r of httpMock.match((q) => q.url.includes('/api/users/me/access'))) r.flush({ entries });
    await stabiliser();
  };
  /** Les demandes d'alertes depuis le dernier appel (`match` retire celles qu'il a vues). */
  const demandesAlertes = (): number => httpMock.match((r) => r.url === '/api/alerts').length;
  const ouvrirSocket = async (): Promise<void> => {
    await service.faux.declencher('connect');
    await stabiliser();
  };

  it('🔴 un gestionnaire SANS alerts_view : aucune demande — ni à la connexion, ni aux reconnexions', async () => {
    user.set(compte('FLEET_MANAGER', false));
    await repondreAcces([]);
    service.connect('jeton-de-test');
    await ouvrirSocket();
    expect(demandesAlertes()).toBe(0);

    // Un redéploiement : la socket tombe et revient — c'est là que les 403 pleuvaient.
    for (const _ of [1, 2, 3]) {
      await service.faux.declencher('disconnect', 'transport close');
      await ouvrirSocket();
    }
    expect(demandesAlertes()).withContext('sous l’ancien code : une demande refusée par reconnexion').toBe(0);
  });

  it('🔴 le veilleur de nuit (jamais alerts_view) : aucune demande', async () => {
    user.set(compte('NIGHT_WATCHMAN', false));
    await repondreAcces([]);
    service.connect('jeton-de-test');
    await ouvrirSocket();
    expect(demandesAlertes()).toBe(0);
  });

  it('un gestionnaire AVEC alerts_view : les alertes sont bien chargées', async () => {
    user.set(compte('FLEET_MANAGER', true));
    await repondreAcces([]);
    service.connect('jeton-de-test');
    await ouvrirSocket();
    expect(demandesAlertes()).toBeGreaterThan(0);
  });

  it('un administrateur de flotte est toujours autorisé — la même règle que le serveur', async () => {
    // Côté serveur, FLEET_ADMIN figure dans ADMIN_ROLES : `canGlobally` dit oui sans lire ses droits.
    user.set(compte('FLEET_ADMIN', false));
    await repondreAcces([]);
    service.connect('jeton-de-test');
    await ouvrirSocket();
    expect(demandesAlertes()).toBeGreaterThan(0);
  });

  it('🔴 une portée chargée APRÈS la connexion qui accorde le droit déclenche le chargement', async () => {
    // Sinon le correctif troquerait un défaut bruyant (403) contre un défaut silencieux : une
    // liste d'alertes vide pour quelqu'un qui a le droit de la voir.
    user.set(compte('FLEET_MANAGER', false));
    service.connect('jeton-de-test');
    await ouvrirSocket();
    expect(demandesAlertes()).withContext('portées pas encore lues : on s’en tient aux droits du compte').toBe(0);

    await repondreAcces([porteeQuiAccorde]);
    expect(demandesAlertes()).withContext('la portée accorde alerts_view : l’effet doit rejouer l’appel').toBeGreaterThan(0);
  });

  it('🔴 relire les MÊMES portées (retour de l’onglet au premier plan) ne redemande PAS les alertes', async () => {
    // `PermissionsService` relit ses portées à chaque retour au premier plan et pose un NOUVEAU
    // tableau. Un effet qui lirait `can()` en direct se rejouerait à chaque fois : un
    // `GET /api/alerts` par retour d'onglet, pour un droit qui n'a pas bougé.
    user.set(compte('FLEET_MANAGER', true));
    await repondreAcces([]);
    service.connect('jeton-de-test');
    await ouvrirSocket();
    expect(demandesAlertes()).toBeGreaterThan(0); // le chargement normal — et la purge du compteur

    const relecture = TestBed.inject(PermissionsService).refreshAccessEntries();
    await repondreAcces([]);
    await relecture;
    await stabiliser();
    expect(demandesAlertes()).withContext('droit inchangé : rien à redemander').toBe(0);
  });

  it('un droit retiré en cours de session vide la liste au lieu de la laisser figée', async () => {
    user.set(compte('FLEET_MANAGER', true));
    await repondreAcces([]);
    service.connect('jeton-de-test');
    await ouvrirSocket();
    for (const r of httpMock.match((q) => q.url === '/api/alerts')) {
      r.flush({ items: [{ id: 'al-1', fleetId: 'f-1' }] });
    }
    await stabiliser();
    expect(service.alerts().length).toBe(1);

    user.set(compte('FLEET_MANAGER', false));
    await repondreAcces([]);
    expect(service.alerts()).toEqual([]);
  });
});

/**
 * 06/10/2026 — « un système d'état qui fonctionne dans toute l'app » : l'état d'un véhicule (hors
 * service déclaré, maintenance de l'agenda, parking souterrain) vit dans l'instantané, que rien ne
 * relisait hors reconnexion. Une maintenance posée dans l'agenda n'apparaissait sur la carte déjà
 * ouverte qu'au rechargement de la page.
 */
describe('06/10/2026 — relecture des ÉTATS de l’instantané', () => {
  let service: RealtimeServiceTestable;
  let httpMock: HttpTestingController;
  /** Le compte connecté est-il un conducteur ? (la route de l'instantané le refuse : 403) */
  let conducteur = false;

  const ligne = (over: Record<string, unknown> = {}) => ({
    vehicleId: 'v-998', fleetId: 'f1', plate: 'HD-998-XY', type: 'VAN', brand: null, model: null,
    trackerId: 't-998', trackerImei: null, trackerStatus: null,
    lastSeenAt: '2026-10-06T08:00:00.000Z', lastLat: 43.6, lastLng: 1.44, lastSpeedKmh: 0,
    lastHeading: 0, lastIgnition: false, lastValid: true, lastPositionAt: '2026-10-06T08:00:00.000Z',
    lastNoFixAt: null, accConnected: null, trackerCreatedAt: null, engineCutActive: false,
    engineCutState: 'normal', scheduleEnabled: true, privacyModeEnabled: false, privacyModeSince: null,
    group: null, presumedParkedZone: null, outOfServiceReason: null, outOfServiceSince: null,
    immobilisationAgenda: null,
    ...over,
  });
  const maintenance = {
    eventId: 'ev-1', type: 'MAINTENANCE', title: 'Pneus',
    startAt: '2026-10-06T07:00:00.000Z', endAt: '2026-10-06T16:00:00.000Z',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            tryRefresh: jasmine.createSpy('tryRefresh').and.resolveTo(null),
            refreshUnavailable: () => false,
            logout: () => undefined,
            isDepot: () => false,
            isDriver: () => conducteur,
            user: () => null,
            token: 'jeton-de-test',
          },
        },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true), url: '/map' } },
        { provide: FleetFilterService, useValue: { matches: () => true, isActive: signal(false), selectedFleetId: signal(null) } },
        { provide: NotificationsApiService, useValue: { clearAppBadge: () => undefined, setAppBadge: () => undefined } },
        { provide: PreferencesService, useValue: { prefs: signal({ notifications: {} }) } },
        { provide: VisibilityService, useValue: { isVisible: signal(true), isUserActive: signal(true), lastHiddenDurationMs: () => null } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined, info: () => undefined } },
        { provide: PermissionsService, useValue: { can: () => true } },
        RealtimeServiceTestable,
      ],
    });
    conducteur = false;
    service = TestBed.inject(RealtimeServiceTestable);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => service.disconnect());

  const repondreSnapshot = async (items: unknown[]): Promise<void> => {
    const req = httpMock.expectOne((r) => r.url.includes('/api/vehicles/snapshot'));
    req.flush({ items });
    await Promise.resolve();
    await Promise.resolve();
  };

  it('ne recopie QUE les champs d’état : la position tenue par le direct n’est pas écrasée', async () => {
    service.snapshot.set([ligne() as never]);
    const p = service.rafraichirEtats();
    // La réponse REST porte une position plus ancienne : elle ne doit pas gagner sur le direct.
    await repondreSnapshot([ligne({ immobilisationAgenda: maintenance, lastLat: 1, lastLng: 2 })]);
    await p;
    const [l] = service.snapshot();
    expect(l.immobilisationAgenda).toEqual(maintenance as never);
    expect(l.lastLat).toBe(43.6);
    expect(l.lastLng).toBe(1.44);
  });

  it('rien n’a bougé : le signal n’est pas réémis (la carte ne redessine pas pour rien)', async () => {
    const avant = [ligne() as never];
    service.snapshot.set(avant);
    const p = service.rafraichirEtats();
    await repondreSnapshot([ligne()]);
    await p;
    expect(service.snapshot()).toBe(avant);
  });

  it('une maintenance terminée (null) remplace bien l’ancienne', async () => {
    service.snapshot.set([ligne({ immobilisationAgenda: maintenance }) as never]);
    const p = service.rafraichirEtats();
    await repondreSnapshot([ligne({ immobilisationAgenda: null })]);
    await p;
    expect(service.snapshot()[0].immobilisationAgenda).toBeNull();
  });

  it('appliquerEtatDeclare : la fiche vient d’enregistrer « immobilisé », la ligne le dit TOUT DE SUITE', () => {
    service.snapshot.set([ligne() as never]);
    service.appliquerEtatDeclare('v-998', 'IMMOBILIZED', '2026-10-06T09:30:00.000Z');
    expect(service.snapshot()[0].outOfServiceReason).toBe('IMMOBILIZED');
    expect(service.snapshot()[0].outOfServiceSince).toBe('2026-10-06T09:30:00.000Z');
    // Un véhicule absent de l'instantané : rien à poser, et surtout rien de cassé.
    expect(() => service.appliquerEtatDeclare('inconnu', null, null)).not.toThrow();
  });

  it('rafraichirEtatsSiAnciens : rien juste après l’hydratation, une lecture quand elle a vieilli', async () => {
    service.connect('jeton-de-test');
    await repondreSnapshot([ligne()]); // hydratation initiale
    service.rafraichirEtatsSiAnciens();
    httpMock.expectNone((r) => r.url.includes('/api/vehicles/snapshot'));
    service.rafraichirEtatsSiAnciens(0);
    await repondreSnapshot([ligne()]);
  });

  it('🔴 un CONDUCTEUR ne demande jamais l’instantané : ni à la connexion, ni en relecture (403 → bandeau)', async () => {
    conducteur = true;
    service.connect('jeton-de-test');
    await service.rafraichirEtats();
    service.rafraichirEtatsSiAnciens(0);
    TestBed.inject(EtatsVehiculesBus).signaler();
    TestBed.tick();
    await Promise.resolve();
    httpMock.expectNone((r) => r.url.includes('/api/vehicles/snapshot'));
  });

  it('la relecture de FOND porte l’en-tête « silencieux » : un échec ne devient jamais un bandeau', async () => {
    service.snapshot.set([ligne() as never]);
    const p = service.rafraichirEtats();
    const req = httpMock.expectOne((r) => r.url.includes('/api/vehicles/snapshot'));
    expect(req.request.headers.has('X-Quiet-Errors')).toBeTrue();
    req.flush({ items: [ligne()] });
    await p;
  });

  it('un geste de l’agenda (EtatsVehiculesBus) déclenche une relecture', async () => {
    service.snapshot.set([ligne() as never]);
    TestBed.inject(EtatsVehiculesBus).signaler();
    TestBed.tick();
    await repondreSnapshot([ligne({ immobilisationAgenda: maintenance })]);
    expect(service.snapshot()[0].immobilisationAgenda).toEqual(maintenance as never);
  });
});
