import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import type { Socket } from 'socket.io-client';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { FleetFilterService } from './fleet-filter.service';
import { NotificationsApiService } from './notifications.service';
import { PreferencesService } from './preferences.service';
import { VisibilityService } from './visibility.service';
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
  let auth: { tryRefresh: jasmine.Spy; refreshUnavailable: jasmine.Spy; logout: jasmine.Spy; token: string | null };
  let router: { navigate: jasmine.Spy; url: string };

  beforeEach(() => {
    auth = {
      // Une API injoignable rend `null` — indistinguable d'un refus à l'appel : tout le sujet.
      tryRefresh: jasmine.createSpy('tryRefresh').and.resolveTo(null),
      refreshUnavailable: jasmine.createSpy('refreshUnavailable').and.returnValue(false),
      logout: jasmine.createSpy('logout'),
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
