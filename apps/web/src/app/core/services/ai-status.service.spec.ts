import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AiStatusDto } from '@vizyo/tracky-shared';
import { AiStatusService } from './ai-status.service';
import { FleetFilterService } from './fleet-filter.service';

/**
 * ── L'ÉTAT IA DEMANDÉ POUR LA MAUVAISE SOCIÉTÉ ──────────────────────────────────────
 *
 * ⚠️ Défaut du 2026-08-03. L'endpoint accepte `fleetId` depuis toujours ; ce service ne
 * l'envoyait jamais. Or les QUATRE super-admins de la plateforme n'ont pas de flotte, et la
 * porte serveur est fail-closed sans flotte : ils recevaient donc « IA coupée » sur TOUTE
 * société, y compris une société ayant payé l'option. Toute la couche IA de l'agenda et des
 * récits leur était structurellement invisible.
 *
 * Le défaut est resté caché parce qu'aucune société n'avait l'IA active — il se serait
 * déclaré au premier client payant, c'est-à-dire au pire moment.
 *
 * Second volet : le statut était chargé UNE fois et ne suivait pas le filtre société. Après
 * un changement de société, il décrivait encore la précédente — boutons proposés sur une
 * société sans option (→ 403), ou masqués sur une société qui l'a payée.
 */
describe('AiStatusService', () => {
  let svc: AiStatusService;
  let http: HttpTestingController;
  let fleetFilter: FleetFilterService;

  const reponse = (over: Partial<AiStatusDto> = {}): AiStatusDto => ({
    configured: true,
    enabled: true,
    fleetId: 'fleet-1',
    features: {
      tripAnalysis: true, agendaAgent: true, capacity: true, placement: true,
      bookingParse: true, activityReport: true, placeAnalysis: true,
    },
    ...over,
  });

  beforeEach(() => {
    localStorage.removeItem('vizyo-fleet-filter');
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    svc = TestBed.inject(AiStatusService);
    http = TestBed.inject(HttpTestingController);
    fleetFilter = TestBed.inject(FleetFilterService);
  });

  afterEach(() => {
    http.verify();
    localStorage.removeItem('vizyo-fleet-filter');
  });

  it('transmet la société sélectionnée au serveur', () => {
    // ⚠️ LE défaut : sans ce paramètre, un super-admin (aucune flotte) reçoit toujours « coupé ».
    fleetFilter.set('fleet-payante');
    svc.refresh();

    const req = http.expectOne((r) => r.url === '/api/ai/status');
    expect(req.request.params.get('fleetId')).toBe('fleet-payante');
    req.flush(reponse());
  });

  it('sans société sélectionnée, n’invente pas de paramètre', () => {
    svc.refresh();
    const req = http.expectOne((r) => r.url === '/api/ai/status');
    expect(req.request.params.has('fleetId')).toBe(false);
    req.flush(reponse({ fleetId: null }));
  });

  it('recharge quand la société change', () => {
    fleetFilter.set('fleet-a');
    svc.refresh();
    http.expectOne((r) => r.url === '/api/ai/status').flush(reponse({ fleetId: 'fleet-a' }));

    fleetFilter.set('fleet-b');
    TestBed.tick(); // laisse l'effect réagir au changement de filtre

    const req = http.expectOne((r) => r.url === '/api/ai/status');
    expect(req.request.params.get('fleetId')).toBe('fleet-b');
    req.flush(reponse({ fleetId: 'fleet-b' }));
  });

  it('ne déclenche AUCUN appel tant qu’aucun écran IA n’a demandé le statut', () => {
    // Sinon on paierait un aller-retour sur chaque écran, IA ou non, à chaque changement
    // de société — pour un statut que personne ne lit.
    fleetFilter.set('fleet-a');
    TestBed.tick();
    http.expectNone((r) => r.url === '/api/ai/status');
  });

  it('`can()` suit la fonction demandée, pas l’interrupteur maître', () => {
    // Le cas qui produisait un bouton mort : société active, fonction coupée globalement.
    svc.refresh();
    http.expectOne((r) => r.url === '/api/ai/status').flush(
      reponse({
        enabled: true,
        features: {
          tripAnalysis: false, agendaAgent: true, capacity: true, placement: true,
          bookingParse: true, activityReport: true, placeAnalysis: true,
        },
      }),
    );

    expect({ maitre: svc.enabled(), recit: svc.can('tripAnalysis'), agent: svc.can('agendaAgent') })
      .toEqual({ maitre: true, recit: false, agent: true });
  });

  it('une fonction absente de la réponse est traitée comme COUPÉE', () => {
    // Fail-closed : un serveur plus ancien (sans `features`) ne doit pas rouvrir les
    // affordances IA. Mieux vaut un bouton manquant qu'un bouton qui échoue.
    svc.refresh();
    http.expectOne((r) => r.url === '/api/ai/status')
      .flush({ configured: true, enabled: true, fleetId: 'fleet-1' } as AiStatusDto);

    expect(svc.can('tripAnalysis')).toBe(false);
  });

  it('un statut en échec ne déverrouille rien', () => {
    svc.refresh();
    http.expectOne((r) => r.url === '/api/ai/status').flush('boom', { status: 500, statusText: 'err' });

    expect({ maitre: svc.enabled(), recit: svc.can('tripAnalysis') }).toEqual({
      maitre: false,
      recit: false,
    });
  });

  /**
   * 29/09 — « c'est le client qui désactive » : l'écran MONTRE l'IA sur le choix de la société
   * (`fleetEnabled`), pas sur `enabled`, qui exige aussi une clé au serveur. Sur la démo (aucune clé,
   * option imposée), l'agenda montrait les propositions pendant que la barre latérale, l'Activité et
   * les Paramètres parlaient d'une IA coupée.
   */
  it('`societeActive` suit le choix du client (`fleetEnabled`), même sans clé au serveur', () => {
    svc.refresh();
    http.expectOne((r) => r.url === '/api/ai/status')
      .flush(reponse({ configured: false, enabled: false, fleetEnabled: true }));
    expect({ enabled: svc.enabled(), societe: svc.societeActive() }).toEqual({ enabled: false, societe: true });
  });

  it('`societeActive` : client qui a coupé l’IA → faux, clé ou pas ; serveur d’avant (sans le champ) → `enabled`', () => {
    svc.refresh();
    http.expectOne((r) => r.url === '/api/ai/status').flush(reponse({ enabled: true, fleetEnabled: false }));
    expect(svc.societeActive()).toBe(false);

    svc.refresh();
    http.expectOne((r) => r.url === '/api/ai/status').flush(reponse({ enabled: true }));
    expect(svc.societeActive()).toBe(true);
  });

  it('deux changements de société rapprochés : la réponse de la PREMIÈRE, arrivée en retard, n’écrase rien', () => {
    fleetFilter.set('fleet-a');
    svc.refresh();
    const premiere = http.expectOne((r) => r.url === '/api/ai/status' && r.params.get('fleetId') === 'fleet-a');

    fleetFilter.set('fleet-b');
    svc.refresh();
    const seconde = http.expectOne((r) => r.url === '/api/ai/status' && r.params.get('fleetId') === 'fleet-b');

    seconde.flush(reponse({ fleetId: 'fleet-b', fleetEnabled: false }));
    premiere.flush(reponse({ fleetId: 'fleet-a', fleetEnabled: true }));

    expect({ societe: svc.status()?.fleetId, active: svc.societeActive() }).toEqual({ societe: 'fleet-b', active: false });
  });
});
