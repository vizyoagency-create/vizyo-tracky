import { TestBed } from '@angular/core/testing';
import { MiseAJourEnCoursService } from './mise-a-jour-en-cours.service';

/**
 * ══ L'ÉCRAN DE MISE À JOUR — incident CDEF31 du 24 septembre 2026 ═════════════════════════════
 *
 * Ce service décide quand l'application doit s'avouer indisponible. Deux erreurs coûteraient
 * cher, en sens inverse, et les deux sont fixées ici :
 *
 *   - AFFICHER À TORT : un écran plein « mise à jour en cours » sur un simple hoquet réseau, ou
 *     pire sur un `500` (qui prouve que l'API est VIVANTE), masquerait un vrai défaut derrière un
 *     message rassurant. C'est la faute la plus grave : elle fabrique de la fausse tranquillité.
 *   - N'AFFICHER JAMAIS : c'est l'état d'avant, et il a coûté une nuit à un veilleur de CDEF31.
 */
describe('MiseAJourEnCoursService — quand l’application doit s’avouer indisponible', () => {
  let service: ServiceTestable;
  let rechargements: number;
  let horsLigne: boolean;

  /**
   * Sous-classe : le rechargement est OBSERVÉ, jamais exécuté (il tuerait le contexte de test),
   * et l'état réseau est piloté par le cas de test.
   */
  class ServiceTestable extends MiseAJourEnCoursService {
    protected override recharger(): void {
      rechargements += 1;
    }
    protected override estHorsLigne(): boolean {
      return horsLigne;
    }
  }

  beforeEach(() => {
    rechargements = 0;
    horsLigne = false;
    jasmine.clock().install();
    // La sonde ne doit jamais partir pour de vrai depuis un test : elle reste injoignable.
    spyOn(window, 'fetch').and.callFake(() => Promise.reject(new Error('injoignable')));
    TestBed.configureTestingModule({ providers: [ServiceTestable] });
    service = TestBed.inject(ServiceTestable);
  });

  afterEach(() => {
    // Arrêter la sonde AVANT de désinstaller l'horloge : un intervalle qui survit se réveille
    // dans la suite suivante (leçon de l'instabilité diagnostiquée le 2026-07-20).
    service.signalerReponseDeLApi();
    jasmine.clock().uninstall();
    TestBed.resetTestingModule();
  });

  it('un hoquet court n’affiche RIEN : une réponse arrive avant le délai', () => {
    service.signalerEchecDeTransport(0);
    jasmine.clock().tick(3_000);
    expect(service.indisponible()).toBeFalse();

    service.signalerReponseDeLApi(); // l'API a répondu entre-temps
    jasmine.clock().tick(10_000);
    expect(service.indisponible())
      .withContext('un hoquet de 3 s ne doit jamais produire un écran plein')
      .toBeFalse();
    expect(rechargements).toBe(0);
  });

  it('🔴 une injoignabilité qui DURE affiche l’écran', () => {
    service.signalerEchecDeTransport(502);
    jasmine.clock().tick(6_000);
    expect(service.indisponible()).toBeTrue();
  });

  it('🔴 un 500 n’affiche RIEN : l’API a répondu, donc elle vit — le défaut doit rester visible', () => {
    // Le piège : « erreur serveur » ressemble à « serveur en panne ». Ce n'en est pas.
    service.signalerReponseDeLApi(); // ce que fait l'intercepteur sur un 5xx applicatif
    jasmine.clock().tick(30_000);
    expect(service.indisponible()).toBeFalse();
  });

  it('les codes applicatifs (401, 403, 404, 409, 422, 500) ne déclenchent jamais, même répétés', () => {
    for (const code of [401, 403, 404, 409, 422, 500]) {
      service.signalerEchecDeTransport(code);
    }
    jasmine.clock().tick(60_000);
    expect(service.indisponible()).toBeFalse();
  });

  it('503 compte comme une passerelle sans personne derrière — le conteneur qui redémarre', () => {
    service.signalerEchecDeTransport(503);
    jasmine.clock().tick(6_000);
    expect(service.indisponible()).toBeTrue();
  });

  it('🔴 le retour de l’API RECHARGE la page — masquer l’écran rendrait la main sur du code périmé', () => {
    service.signalerEchecDeTransport(0);
    jasmine.clock().tick(6_000);
    expect(service.indisponible()).toBeTrue();

    service.signalerReponseDeLApi();
    expect(service.indisponible()).toBeFalse();
    expect(rechargements)
      .withContext('une page ouverte pendant un déploiement porte des morceaux de code qui n’existent plus')
      .toBe(1);
  });

  it('réseau du POSTE coupé : le message change de coupable', () => {
    horsLigne = true;
    service.signalerEchecDeTransport(0);
    jasmine.clock().tick(6_000);
    expect(service.indisponible()).toBeTrue();
    expect(service.horsLigne())
      .withContext('accuser « mise à jour en cours » quand c’est le wifi fait perdre du temps à 3 h du matin')
      .toBeTrue();
  });

  it('dix échecs simultanés n’arment qu’UNE minuterie : le délai se compte en temps, pas en échecs', () => {
    // Une page qui charge lance dix requêtes en parallèle ; un compteur d'échecs atteindrait
    // n'importe quel seuil d'un seul coup, sur un hoquet d'une seconde.
    for (let i = 0; i < 10; i++) service.signalerEchecDeTransport(0);
    jasmine.clock().tick(5_999);
    expect(service.indisponible()).toBeFalse();
    jasmine.clock().tick(1);
    expect(service.indisponible()).toBeTrue();
  });
});
