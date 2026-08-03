import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { authInterceptor } from '../interceptors/auth.interceptor';
import { AuthService } from './auth.service';
import { UsersApiService } from './users.service';
import { VehicleGroupsService } from './vehicle-groups.service';

/**
 * ── DÉMARRAGE DE L'INJECTION — le pendant web du smoke-boot de l'API ─────────────────
 *
 * ⚠️ POURQUOI CE FICHIER EXISTE (migration du 2026-08-03).
 *
 * `AuthService` injecte désormais `HttpClient`, alors que `authInterceptor` injecte
 * `AuthService`. Sur le papier, c'est une boucle. En pratique non — les intercepteurs
 * sont résolus PAR REQUÊTE, pas à la construction du client — mais cette nuance ne se
 * vérifie qu'à l'EXÉCUTION : `tsc` et `ng build` compilent parfaitement un graphe
 * d'injection circulaire, et l'application ne casse qu'au premier chargement réel.
 *
 * Or ce graphe-là porte l'authentification : s'il casse, PERSONNE ne peut se connecter.
 * C'est exactement le scénario qui a déjà provoqué des redémarrages en boucle côté API,
 * et c'est pour cela que ce projet a un smoke-boot de DI. Voici son équivalent web.
 *
 * ⚠️ Ne pas remplacer ces instanciations par des mocks : c'est le CÂBLAGE RÉEL qu'on
 * teste. Un mock rendrait ce fichier vert pour toujours, et parfaitement inutile.
 */
describe('démarrage de l’injection — services migrés vers HttpClient', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        // L'intercepteur RÉEL, celui qui injecte AuthService. C'est tout l'objet du test.
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
  });

  it('AuthService s’instancie malgré la boucle apparente avec l’intercepteur', () => {
    // Si le graphe était réellement circulaire, cette ligne lèverait
    // « Circular dependency in DI detected ».
    expect(() => TestBed.inject(AuthService)).not.toThrow();
    expect(TestBed.inject(AuthService)).toBeTruthy();
  });

  it('UsersApiService s’instancie', () => {
    expect(TestBed.inject(UsersApiService)).toBeTruthy();
  });

  it('VehicleGroupsService s’instancie', () => {
    expect(TestBed.inject(VehicleGroupsService)).toBeTruthy();
  });

  it('les trois cohabitent dans le même injecteur', () => {
    // Instancier chacun séparément ne prouve pas qu'ils coexistent : c'est en les
    // résolvant ensemble qu'un cycle se révèle.
    const auth = TestBed.inject(AuthService);
    const users = TestBed.inject(UsersApiService);
    const groups = TestBed.inject(VehicleGroupsService);
    expect([auth, users, groups].every(Boolean)).toBeTrue();
  });

  /**
   * ⚠️ TestBed SÉPARÉ, SANS l'intercepteur réel — et c'est délibéré.
   *
   * `authInterceptor` injecte RealtimeService, ToastService, ConsentService et
   * SecurityService. Les monter tous ici ferait de ce fichier un test d'intégration de
   * la moitié de l'application : lent, fragile, et rouge pour des raisons sans rapport
   * avec ce qu'on veut vérifier.
   *
   * Les deux préoccupations sont distinctes et testées séparément :
   *   - le bloc du dessus vérifie que le GRAPHE D'INJECTION ne boucle pas (avec
   *     l'intercepteur réel, puisque c'est lui qui crée la boucle apparente) ;
   *   - celui-ci vérifie que les appels partent bien par `HttpClient` (sans lui, puisque
   *     l'intercepteur n'a rien à voir avec cette question).
   */
  describe('les appels migrés partent bien par HttpClient', () => {
    beforeEach(() => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [provideHttpClient(), provideHttpClientTesting()],
      });
    });

    it('findAll passe par HttpClient — donc par les intercepteurs', async () => {
      const users = TestBed.inject(UsersApiService);
      const httpMock = TestBed.inject(HttpTestingController);

      const promise = users.findAll();
      // ⚠️ Si l'appel partait encore en `fetch` natif, AUCUNE requête n'arriverait ici
      // et `expectOne` échouerait. C'est la preuve que la migration est effective, pas
      // seulement que le code compile.
      const req = httpMock.expectOne((r) => r.url === '/api/users');
      expect(req.request.method).toBe('GET');
      req.flush([]);

      await expectAsync(promise).toBeResolvedTo({ users: [], pendingInvitations: [] });
      httpMock.verify();
    });

    it('setUserAccess REJETTE sur un refus du serveur — le défaut corrigé par la migration', async () => {
      // ⚠️ AVANT LA MIGRATION, cette méthode ne vérifiait pas `res.ok` : un 403 rendait
      // un succès, et l'écran affichait « Accès enregistré » alors que le périmètre
      // d'accès de l'utilisateur n'avait pas bougé d'un pouce.
      const groups = TestBed.inject(VehicleGroupsService);
      const httpMock = TestBed.inject(HttpTestingController);

      const promise = groups.setUserAccess('u1', { type: 'ALL', groupIds: [], vehicleIds: [] });
      const req = httpMock.expectOne('/api/users/u1/access');
      expect(req.request.method).toBe('PUT');
      req.flush({ message: 'refusé' }, { status: 403, statusText: 'Forbidden' });

      await expectAsync(promise).toBeRejected();
      httpMock.verify();
    });

    it('remove REJETTE sur une erreur serveur', async () => {
      const groups = TestBed.inject(VehicleGroupsService);
      const httpMock = TestBed.inject(HttpTestingController);

      const promise = groups.remove('g1');
      httpMock.expectOne('/api/vehicle-groups/g1').flush(null, {
        status: 500,
        statusText: 'Server Error',
      });

      await expectAsync(promise).toBeRejected();
      httpMock.verify();
    });
  });
});
