import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { URGENCE_WHATSAPP_RETARD_MAX_S } from '@vizyo/tracky-shared';
import { AssistanceApiService, CLE_APPUI_RETENU } from './assistance.service';
import { AuthService } from './auth.service';

/**
 * ══ LA LIGNE D'URGENCE — CE QUE LE NAVIGATEUR DIT AU SERVEUR, ET QUAND ═══════════════════════
 *
 * Un appui sur « WhatsApp » prévient les super-admins et s'écrit au centre d'activité. Trois
 * propriétés comptent, et chacune a un cas réel derrière elle :
 *
 *   1. SANS SESSION, RIEN NE PART. L'écran « mise à jour en cours » couvre aussi la page de
 *      connexion et la page publique de suivi : le 401 en retour y déclencherait la redirection
 *      de l'intercepteur vers `/login`, sous les yeux d'un destinataire sans compte.
 *   2. L'APPUI FAIT PENDANT UNE PANNE N'EST PAS PERDU. Cet écran n'apparaît que quand l'API ne
 *      répond plus : c'est le seul moment où le signalement échoue À COUP SÛR. Il est retenu,
 *      puis retransmis avec son âge — le serveur en tire l'heure réelle de l'appui.
 *   3. UN APPUI NE PART JAMAIS SOUS LE NOM D'UN AUTRE. Chez CDEF31 les veilleurs se relaient sur
 *      le même appareil : la clé de stockage porte le compte.
 */
describe('AssistanceApiService — la ligne d’urgence WhatsApp', () => {
  const URL = '/api/assistance/urgence/whatsapp';
  const MOI = 'u-veilleur';
  const user = signal<{ sub: string } | null>({ sub: MOI });
  let svc: AssistanceApiService;
  let http: HttpTestingController;

  const cle = (id = MOI): string => CLE_APPUI_RETENU + id;
  const retenu = (id = MOI): { ecran: string; plaque?: string; a: number } | null => {
    const brut = localStorage.getItem(cle(id));
    return brut ? JSON.parse(brut) : null;
  };
  const T0 = Date.parse('2026-10-01T04:00:00Z');

  beforeEach(() => {
    localStorage.removeItem(cle());
    localStorage.removeItem(cle('u-autre'));
    user.set({ sub: MOI });
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(T0));
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user } }],
    });
    svc = TestBed.inject(AssistanceApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    jasmine.clock().uninstall();
    localStorage.removeItem(cle());
    localStorage.removeItem(cle('u-autre'));
  });

  describe('le signalement', () => {
    it('envoie l’écran et la plaque — rien d’autre', () => {
      svc.signalerUrgenceWhatsapp('vehicules', 'GS-187-NY');
      const req = http.expectOne(URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ ecran: 'vehicules', plaque: 'GS-187-NY' });
      req.flush(null, { status: 204, statusText: 'No Content' });
    });

    it('sans plaque, le corps n’en porte pas — le serveur refuserait une plaque vide', () => {
      svc.signalerUrgenceWhatsapp('assistance', null);
      expect(http.expectOne(URL).request.body).toEqual({ ecran: 'assistance' });
    });

    it('🔴 sans session, RIEN ne part — pas de 401 qui renverrait vers la connexion', () => {
      user.set(null);
      svc.signalerUrgenceWhatsapp('mise-a-jour');
      expect(http.match(URL)).toEqual([]);
      expect(retenu()).withContext('rien à retenir non plus : personne à qui l’attribuer').toBeNull();
    });

    it('une erreur est avalée : l’urgence ne dépend pas de la réponse', () => {
      expect(() => {
        svc.signalerUrgenceWhatsapp('vehicules');
        http.expectOne(URL).flush({}, { status: 500, statusText: 'Erreur' });
      }).not.toThrow();
    });
  });

  describe('l’appui fait pendant une panne', () => {
    it('🔴 sur l’écran de mise à jour, une panne de transport RETIENT l’appui, sous le compte', () => {
      svc.signalerUrgenceWhatsapp('mise-a-jour');
      http.expectOne(URL).flush(null, { status: 502, statusText: 'Bad Gateway' });
      expect(retenu()).toEqual({ ecran: 'mise-a-jour', a: T0 });
    });

    it('le réseau coupé (statut 0) retient aussi', () => {
      svc.signalerUrgenceWhatsapp('mise-a-jour');
      http.expectOne(URL).error(new ProgressEvent('error'), { status: 0 });
      expect(retenu()?.a).toBe(T0);
    });

    it('ailleurs, rien n’est retenu : la requête a pu arriver pendant le basculement vers WhatsApp', () => {
      svc.signalerUrgenceWhatsapp('vehicules');
      http.expectOne(URL).error(new ProgressEvent('error'), { status: 0 });
      expect(retenu()).toBeNull();
    });

    it('un refus (4xx) n’est pas une panne : rien n’est retenu', () => {
      svc.signalerUrgenceWhatsapp('mise-a-jour');
      http.expectOne(URL).flush({}, { status: 403, statusText: 'Forbidden' });
      expect(retenu()).toBeNull();
    });

    it('le PREMIER appui compte : trois appuis impatients ne rajeunissent pas l’appel à l’aide', () => {
      svc.signalerUrgenceWhatsapp('mise-a-jour');
      http.expectOne(URL).flush(null, { status: 503, statusText: 'Unavailable' });
      jasmine.clock().tick(90_000);
      svc.signalerUrgenceWhatsapp('mise-a-jour');
      http.expectOne(URL).flush(null, { status: 503, statusText: 'Unavailable' });
      expect(retenu()?.a).toBe(T0);
    });
  });

  describe('la retransmission', () => {
    const poser = (appui: object, id = MOI): void => localStorage.setItem(cle(id), JSON.stringify(appui));

    it('🔴 envoie l’ÂGE de l’appui, puis l’oublie une fois reçu', () => {
      poser({ ecran: 'mise-a-jour', a: T0 - 30 * 60_000 });
      svc.retransmettreAppuiRetenu();
      const req = http.expectOne(URL);
      expect(req.request.body).toEqual({ ecran: 'mise-a-jour', retardS: 1800 });
      req.flush(null, { status: 204, statusText: 'No Content' });
      expect(retenu()).toBeNull();
    });

    it('garde la plaque quand l’appui en avait une', () => {
      poser({ ecran: 'mise-a-jour', plaque: 'HM-787-GA', a: T0 - 120_000 });
      svc.retransmettreAppuiRetenu();
      expect(http.expectOne(URL).request.body).toEqual({ ecran: 'mise-a-jour', plaque: 'HM-787-GA', retardS: 120 });
    });

    it('si l’API est encore à terre, l’appui attend la prochaine occasion', () => {
      poser({ ecran: 'mise-a-jour', a: T0 - 60_000 });
      svc.retransmettreAppuiRetenu();
      http.expectOne(URL).flush(null, { status: 502, statusText: 'Bad Gateway' });
      expect(retenu()).not.toBeNull();
    });

    it('un refus définitif (4xx) l’oublie — sinon il serait retenté à chaque démarrage', () => {
      poser({ ecran: 'mise-a-jour', a: T0 - 60_000 });
      svc.retransmettreAppuiRetenu();
      http.expectOne(URL).flush({}, { status: 400, statusText: 'Bad Request' });
      expect(retenu()).toBeNull();
    });

    it('🔴 l’appui d’un AUTRE compte ne part jamais sous ce nom — il attend son auteur', () => {
      poser({ ecran: 'mise-a-jour', a: T0 - 60_000 }, 'u-autre');
      svc.retransmettreAppuiRetenu();
      http.expectNone(URL);
      expect(retenu('u-autre')).not.toBeNull();
    });

    it('au-delà de deux heures, l’alerte n’a plus de sens : oubliée sans rien envoyer', () => {
      poser({ ecran: 'mise-a-jour', a: T0 - (URGENCE_WHATSAPP_RETARD_MAX_S + 1) * 1000 });
      svc.retransmettreAppuiRetenu();
      http.expectNone(URL);
      expect(retenu()).toBeNull();
    });

    it('une horloge qui a reculé rend l’âge absurde : oublié', () => {
      poser({ ecran: 'mise-a-jour', a: T0 + 600_000 });
      svc.retransmettreAppuiRetenu();
      http.expectNone(URL);
      expect(retenu()).toBeNull();
    });

    it('une valeur illisible est effacée au lieu d’être retentée indéfiniment', () => {
      localStorage.setItem(cle(), '{"ecran":"<script>","a":1}');
      svc.retransmettreAppuiRetenu();
      http.expectNone(URL);
      expect(localStorage.getItem(cle())).toBeNull();
    });

    it('deux appels rapprochés ne retransmettent qu’une fois', () => {
      poser({ ecran: 'mise-a-jour', a: T0 - 60_000 });
      svc.retransmettreAppuiRetenu();
      svc.retransmettreAppuiRetenu();
      const envois = http.match(URL);
      expect(envois.length).toBe(1);
      envois[0].flush(null, { status: 204, statusText: 'No Content' });
    });
  });
});
