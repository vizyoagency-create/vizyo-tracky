import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { NotificationsApiService } from '../../core/services/notifications.service';
import { VehiclesListComponent } from './vehicles-list.component';

/**
 * ══ LE TOTAL DE LA PAGE VÉHICULES SUIT LE FILTRE SOCIÉTÉ (constat du propriétaire, 05/10/2026) ══
 *
 * Sous le filtre « mh cars », le titre annonçait toujours « 50 véhicules » — le parc de TOUTES les
 * sociétés — au-dessus d'une liste réduite à la société. Le titre, le compteur « affichés / total »
 * et les puces de statut lisaient la liste brute ; le menu des groupes proposait ceux des autres
 * sociétés, qui ne pouvaient rendre qu'une liste vide. Chaque test ci-dessous tombe sur le code
 * d'avant.
 */

/**
 * Les membres visés sont `protected` — publics À L'EXÉCUTION. Même porte que la spec des Rapports :
 * lisibles au test sans relâcher la visibilité du composant.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Interne = Record<string, any>;
const interne = (c: VehiclesListComponent): Interne => c as unknown as Interne;
/* eslint-enable @typescript-eslint/no-explicit-any */

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** Un véhicule réduit à ce que lisent le périmètre, les puces et le menu des groupes. Sans boîtier. */
const vehicule = (id: string, fleetId: string, groupe: { id: string; name: string } | null) =>
  ({ id, plate: id.toUpperCase(), fleetId, group: groupe, tracker: null, moving: false }) as never;

/** Deux sociétés : A a 2 véhicules (un groupe), B en a 3 (un autre groupe). */
const PARC = [
  vehicule('a1', A, { id: 'ga', name: 'Ateliers A' }),
  vehicule('a2', A, null),
  vehicule('b1', B, { id: 'gb', name: 'Navettes B' }),
  vehicule('b2', B, { id: 'gb', name: 'Navettes B' }),
  vehicule('b3', B, null),
];

describe('Page Véhicules — le total annoncé suit le filtre société', () => {
  let ecran: Interne;
  let filtre: FleetFilterService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [VehiclesListComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        // Le filtre société est un geste de SUPER-ADMIN : le compte est déclaré, pas hérité du
        // stockage du navigateur (même raison que la spec « bascule de société » des Rapports, 29/09).
        {
          provide: AuthService,
          useValue: {
            user: signal({ sub: 'u-sa', email: 'sa@exemple.fr', role: 'SUPER_ADMIN', fleetId: null, permissions: null }),
            isAuthenticated: () => false,
            isWatchman: () => false,
          },
        },
        // Tirée par le temps réel : elle injecte `SwPush` (service worker), indisponible en test et
        // sans rapport avec le sujet — même mock minimal que la spec du temps réel.
        { provide: NotificationsApiService, useValue: { clearAppBadge: () => undefined, setAppBadge: () => undefined } },
      ],
    });
    // ⚠️ Aucun `detectChanges()` : `ngOnInit` chargerait la liste depuis l'API. Ce qui est éprouvé
    // ici est ce que l'écran ANNONCE pour un parc donné — le parc est posé à la main.
    ecran = interne(TestBed.createComponent(VehiclesListComponent).componentInstance);
    filtre = TestBed.inject(FleetFilterService);
    ecran['vehicles'].set(PARC);
  });

  afterEach(() => {
    // Le filtre société est persisté : le spec suivant le relirait.
    localStorage.removeItem('vizyo-fleet-filter');
  });

  it('⚠️ sous une société, le total annoncé est celui de la société — plus celui de tout le parc', () => {
    filtre.set(A);
    expect(ecran['totalPerimetre']()).toBe(2);
    filtre.set(B);
    expect(ecran['totalPerimetre']()).toBe(3);
  });

  it('⚠️ la puce « Tous » compte la même chose que le titre, et les statuts aussi', () => {
    filtre.set(A);
    expect(ecran['compteursStatut']().tous).toBe(2);
    expect(ecran['compteursStatut']()['sans-boitier']).toBe(2);
  });

  it('⚠️ le menu des groupes ne propose que ceux de la société choisie', () => {
    filtre.set(B);
    expect(ecran['groupOptions']()).toEqual([{ id: 'gb', name: 'Navettes B' }]);
  });

  it('sans filtre, tout le parc : 5 véhicules et tous les groupes', () => {
    filtre.set(null);
    expect(ecran['totalPerimetre']()).toBe(5);
    expect(ecran['compteursStatut']().tous).toBe(5);
    expect(ecran['groupOptions']().map((g: { id: string }) => g.id)).toEqual(['ga', 'gb']);
  });
});
