import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { DriversApiService } from '../../core/services/drivers.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { ReportsComponent } from './reports.component';
import { estIdentifiantSociete } from './reports.utils';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE LIEN DU RAPPORT HEBDOMADAIRE OUVRE LA SOCIÉTÉ DONT LE COURRIER PARLE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Cette page prend sa société dans le SÉLECTEUR DU HAUT, persisté en localStorage d'une visite
 * à l'autre. Le bouton du courrier hebdomadaire, lui, arrive de l'extérieur et parle d'UNE
 * société précise — et il ne disait que la période.
 *
 * Un super-admin l'ouvrait donc et lisait les chiffres de la société sur laquelle son
 * sélecteur était resté, sous le titre de la semaine annoncée par le courriel. Le nôtre reçoit
 * celui de la société d'essai : le cas n'est pas théorique.
 *
 * ⚠️ RIEN NE L'AURAIT SIGNALÉ. Deux sociétés donnent deux jeux de nombres également
 * plausibles ; l'écran montre un total de trajets, pas une preuve d'origine. C'est le mélange
 * de données que le lot des rapports par société interdit, arrivé par la porte d'un lien.
 *
 * ⚠️ ET CE N'EST PAS UN CONTOURNEMENT de la règle « le super-admin choisit sa société avant de
 * sortir un rapport ». C'est elle, appliquée : le paramètre POSE le sélecteur du haut, qui
 * affiche donc la société — l'écran continue de dire de qui il parle.
 */

const SOCIETE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SOCIETE_B = 'bbbbbbbb-2222-4222-8222-222222222222';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Interne = Record<string, any>;
const interne = (c: ReportsComponent): Interne => c as unknown as Interne;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Monte l'écran comme le ferait `/reports?fleet=…&from=…&to=…` pour un rôle donné, et joue
 * son `ngOnInit`.
 *
 * ⚠️ LE VRAI `FleetFilterService` est utilisé, pas un double : c'est LUI qui décide ce qu'un
 * `set` produit selon le rôle, et c'est LUI qui persiste. Un double rendrait le test vert quel
 * que soit le comportement réel du filtre.
 */
function ouvrir(
  role: string,
  params: Record<string, string>,
  filtrePrealable: string | null = null,
): { ecran: Interne; filtre: FleetFilterService } {
  TestBed.resetTestingModule();
  // ⚠️ AVANT la configuration du module : `FleetFilterService` lit le stockage À SA
  // CONSTRUCTION. Poser la valeur après ne simulerait aucune visite précédente.
  if (filtrePrealable) localStorage.setItem('vizyo-fleet-filter', filtrePrealable);
  else localStorage.removeItem('vizyo-fleet-filter');
  TestBed.configureTestingModule({
    imports: [ReportsComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: DriversApiService, useValue: { list: () => Promise.resolve([]) } },
      { provide: AuthService, useValue: { user: signal({ role, id: 'u1', email: 'a@b.c' }) } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(params) } },
      },
    ],
  });
  const ecran = interne(TestBed.createComponent(ReportsComponent).componentInstance);
  const filtre = TestBed.inject(FleetFilterService);
  ecran['ngOnInit']();
  return { ecran, filtre };
}

describe('Page Rapports — la société portée par le lien hebdomadaire', () => {
  let urlDepart: string;

  beforeEach(() => { urlDepart = window.location.href; });

  afterEach(() => {
    // `ngOnInit` reporte l'état dans la barre d'adresse, partagée par toute la page de test.
    window.history.replaceState(window.history.state, '', urlDepart);
    localStorage.removeItem('vizyo-fleet-filter');
  });

  it('🔴 LE DÉFAUT : le sélecteur resté sur une AUTRE société est repositionné', () => {
    // Un super-admin dont le sélecteur traîne sur la société B depuis sa visite précédente,
    // et qui ouvre le courrier de la société A.
    const { filtre } = ouvrir(
      'SUPER_ADMIN',
      { fleet: SOCIETE_A, from: '2026-09-01', to: '2026-09-08' },
      SOCIETE_B,
    );

    expect(filtre.selectedFleetId()).toBe(SOCIETE_A);
  });

  it('la période du courrier est appliquée telle quelle, borne haute exclusive comprise', () => {
    const { ecran } = ouvrir('SUPER_ADMIN', {
      fleet: SOCIETE_A, from: '2026-09-01', to: '2026-09-08',
    });

    expect(ecran['periodFrom']).toBe('2026-09-01');
    expect(ecran['periodTo']).toBe('2026-09-08');
  });

  /**
   * ⚠️ POUR TOUT AUTRE RÔLE, ON NE POSE RIEN. Le périmètre d'un gestionnaire est fixé par le
   * serveur et ce sélecteur n'existe pas pour lui. Poser une société ferait demander un
   * périmètre hors du sien — refus de l'API, écran vide — et lui laisserait un filtre fantôme
   * qu'aucune interface ne lui permettrait d'ôter.
   */
  it('un gestionnaire de flotte n’hérite d’aucun filtre société', () => {
    const { filtre } = ouvrir('FLEET_ADMIN', {
      fleet: SOCIETE_A, from: '2026-09-01', to: '2026-09-08',
    });

    expect(filtre.selectedFleetId()).toBeNull();
  });

  it('sans paramètre de société, le sélecteur garde ce qu’il avait', () => {
    const { filtre } = ouvrir('SUPER_ADMIN', { from: '2026-09-01', to: '2026-09-08' }, SOCIETE_B);

    expect(filtre.selectedFleetId()).toBe(SOCIETE_B);
  });

  /**
   * ⚠️ VALIDÉ PARCE QUE MÉMORISÉ. Ce paramètre ne cadre pas seulement l'écran : il pose un
   * sélecteur PERSISTANT. Une valeur bricolée y resterait après la visite, et le super-admin
   * retrouverait toutes ses pages filtrées sur une société inexistante — écrans vides, sans
   * rien pour dire pourquoi.
   */
  it('une société bricolée à la main est refusée, et ne s’installe pas', () => {
    for (const mauvais of ['toutes', '../../etc', SOCIETE_A.slice(0, 8), '']) {
      const { filtre } = ouvrir('SUPER_ADMIN', { fleet: mauvais }, SOCIETE_B);

      // Le sélecteur reste sur ce qu'il avait : la valeur bricolée n'est ni posée, ni retenue.
      expect(filtre.selectedFleetId()).toBe(SOCIETE_B);
    }
  });
});

describe('estIdentifiantSociete — la forme attendue', () => {
  it('accepte un UUID, quelle que soit sa casse', () => {
    expect(estIdentifiantSociete(SOCIETE_A)).toBe(true);
    expect(estIdentifiantSociete(SOCIETE_A.toUpperCase())).toBe(true);
  });

  it('refuse tout le reste', () => {
    for (const v of [null, undefined, '', 'toutes', 'aaaa', `${SOCIETE_A} `, `${SOCIETE_A}x`]) {
      expect(estIdentifiantSociete(v)).toBe(false);
    }
  });
});
