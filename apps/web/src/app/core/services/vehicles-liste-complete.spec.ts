import { TestBed } from '@angular/core/testing';
import { HttpRequest, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { PAGE_VEHICULES, VehiclesApiService, type VehicleDetailDto } from './vehicles.service';

/**
 * ══ LA LISTE DES VÉHICULES, C'EST LE PARC ENTIER (constat du propriétaire, 05/10/2026) ══════════
 *
 * GET /vehicles plafonne à 50 lignes par appel. La page Véhicules, la carte, les groupes, les
 * rapports, les utilisateurs, le tableau de bord et les écrans d'admin n'en faisaient qu'UN : un
 * super-admin (53 véhicules) ne voyait plus les trois plus anciens — trois camions de mh cars,
 * « 10 véhicules » au tableau de bord, 7 sur la page et sur la carte. Chaque test tombe sur l'ancien
 * `list()`, qui n'émettait qu'une requête.
 */

const vehicule = (n: number) => ({ id: `v-${String(n).padStart(3, '0')}`, plate: `AA-${n}` }) as unknown as VehicleDetailDto;
const lot = (de: number, nombre: number) => Array.from({ length: nombre }, (_, i) => vehicule(de + i));

/** Laisse la boucle de pagination émettre sa requête suivante (elle attend la réponse précédente). */
const prochaineRequete = () => new Promise((r) => setTimeout(r, 0));

describe('VehiclesApiService.list — le parc entier, page après page', () => {
  let api: VehiclesApiService;
  let http: HttpTestingController;
  const estListe = (r: HttpRequest<unknown>) => r.method === 'GET' && r.url === '/api/vehicles';

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(VehiclesApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('⚠️ suit le curseur jusqu’à la dernière page : 50 + 3 = 53 véhicules, pas 50', async () => {
    const resultat = firstValueFrom(api.list());

    const p1 = http.expectOne((r) => estListe(r) && r.params.get('limit') === String(PAGE_VEHICULES) && !r.params.has('cursor'));
    p1.flush(lot(1, 50));
    await prochaineRequete();

    const p2 = http.expectOne((r) => estListe(r) && r.params.get('cursor') === 'v-050');
    p2.flush(lot(51, 3));

    const tous = await resultat;
    expect(tous.length).toBe(53);
    expect(tous[52].id).toBe('v-053');
  });

  it('s’arrête dès qu’une page est incomplète — une seule requête pour un petit parc', async () => {
    const resultat = firstValueFrom(api.list());
    http.expectOne(estListe).flush(lot(1, 10));
    expect((await resultat).length).toBe(10);
    // `afterEach` vérifie qu'aucune autre requête n'est partie.
  });

  it('transmet les filtres à CHAQUE page', async () => {
    const resultat = firstValueFrom(api.list({ hasTracker: 'false' }));
    const p1 = http.expectOne((r) => estListe(r) && r.params.get('hasTracker') === 'false' && !r.params.has('cursor'));
    p1.flush(lot(1, 50));
    await prochaineRequete();
    const p2 = http.expectOne((r) => estListe(r) && r.params.get('hasTracker') === 'false' && r.params.get('cursor') === 'v-050');
    p2.flush([]);
    expect((await resultat).length).toBe(50);
  });

  it('ne rend jamais deux fois le même véhicule, même s’il réapparaît d’une page à l’autre', async () => {
    const resultat = firstValueFrom(api.list());
    http.expectOne((r) => estListe(r) && !r.params.has('cursor')).flush(lot(1, 50));
    await prochaineRequete();
    http.expectOne((r) => estListe(r) && r.params.get('cursor') === 'v-050').flush([vehicule(50), vehicule(51)]);
    const ids = (await resultat).map((v) => v.id);
    expect(ids.length).toBe(51);
    expect(new Set(ids).size).toBe(51);
  });

  it('`page()` reste UN appel, pour qui gère lui-même limit et cursor', async () => {
    const resultat = firstValueFrom(api.page({ limit: '50', cursor: 'v-050' }));
    http.expectOne((r) => estListe(r) && r.params.get('cursor') === 'v-050').flush(lot(51, 3));
    expect((await resultat).length).toBe(3);
  });
});
