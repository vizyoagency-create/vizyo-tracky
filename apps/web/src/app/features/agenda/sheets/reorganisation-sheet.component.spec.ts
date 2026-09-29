import { registerLocaleData } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import localeFr from '@angular/common/locales/fr';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { EcartPropositionsResultDto, ReorganisationResultDto } from '@vizyo/tracky-shared';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { AgendaSyncService } from '../agenda-sync.service';
import { ReorganisationSheetComponent, type PresetReorganisation } from './reorganisation-sheet.component';

const URL_PROPOSITIONS = '/api/agenda/agent/proposals/ecarter';
const URL_RESERVATIONS = '/api/reservations/reorganiser';

/**
 * ══ RÉORGANISER — L'ONGLET « PROPOSITIONS DE L'AGENT » (29/09, piste 3, puis relecture) ══════════
 *
 * La feuille n'avait aucune spec : ses garanties tenaient à la recette dans Chrome. Celles-ci se
 * vérifient ici, sur le DOM et sur les requêtes réellement parties :
 *  - elle s'ouvre sur les propositions quand il n'y a qu'elles, et n'en montre rien IA coupée ;
 *  - « Écarter » renvoie le lot EXACT de la simulation affichée (`ids`), et le compte-rendu reste
 *    affiché quand la page relit ses propositions (aucune nouvelle simulation ne l'écrase) ;
 *  - la simulation d'arrière-plan (onglet Réservations à l'écran) est silencieuse, et relancée en
 *    arrivant sur l'onglet si elle a échoué ;
 *  - changer de véhicule depuis l'onglet Propositions ne lève plus la limite aux refusées (T3) ;
 *  - un lot de l'Assistant IA en cours retient « Écarter » ; rien d'écarté n'est pas un succès.
 */
describe('Réorganiser — onglet « Propositions de l’agent » (29/09, piste 3)', () => {
  let fixture: ComponentFixture<ReorganisationSheetComponent>;
  let http: HttpTestingController;
  let toast: jasmine.SpyObj<Pick<ToastService, 'success' | 'warning' | 'error' | 'info'>>;
  let sync: AgendaSyncService;

  const JOUR = 86_400_000;
  const resultatR = (over: Partial<ReorganisationResultDto> = {}): ReorganisationResultDto => ({
    simulation: true, concernees: 0, appliquees: 0, refusees: [], apercu: [], plafonne: false,
    totaux: { agent: 0, public: 0, manuelle: 0 }, parVehicule: [], lotIds: [], ...over,
  });
  const resultatP = (over: Partial<EcartPropositionsResultDto> = {}): EcartPropositionsResultDto => ({
    simulation: true, concernees: 2, ecartees: 0, dejaTraitees: 0, restees: 0,
    apercu: [
      { id: 'p1', vehicleId: 'v1', plate: 'AA-1', startAt: '2026-10-01T06:00:00.000Z', endAt: '2026-10-01T10:00:00.000Z', destinationLabel: 'Toulouse' },
      { id: 'p2', vehicleId: 'v1', plate: 'AA-1', startAt: '2026-10-02T06:00:00.000Z', endAt: '2026-10-02T10:00:00.000Z', destinationLabel: null },
    ],
    parVehicule: [{ vehicleId: 'v1', plate: 'AA-1', n: 2 }],
    horsGestion: 0, plafonne: false, lotIds: ['p1', 'p2'], ...over,
  });

  // La période d'un pré-réglage se dit en français (`libellePeriode`) : l'application enregistre la locale
  // dans `main.ts`, un spec l'enregistre lui-même — sinon il dépend de l'ordre (aléatoire) des fichiers.
  beforeAll(() => registerLocaleData(localeFr));

  beforeEach(() => {
    localStorage.removeItem('vizyo-fleet-filter');
    toast = jasmine.createSpyObj('ToastService', ['success', 'warning', 'error', 'info']);
    TestBed.configureTestingModule({
      imports: [ReorganisationSheetComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        // Un gestionnaire de société (pas super-admin) : la société n'est jamais envoyée.
        { provide: AuthService, useValue: { user: () => ({ role: 'FLEET_ADMIN', fleetId: 'f1' }) } },
        { provide: ToastService, useValue: toast },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    sync = TestBed.inject(AgendaSyncService);
    fixture = TestBed.createComponent(ReorganisationSheetComponent);
  });

  afterEach(() => {
    http.verify();
    localStorage.removeItem('vizyo-fleet-filter');
    document.body.style.overflow = '';
  });

  const ouvrir = (e: { iaActive?: boolean; total?: number | null; nbPropositions?: number; preset?: PresetReorganisation | null } = {}): void => {
    const total = e.total === undefined ? 0 : e.total;
    fixture.componentRef.setInput('iaActive', e.iaActive ?? true);
    fixture.componentRef.setInput('reorganisables', total === null ? null : { total, jours: 30, societe: 'cdef31' });
    fixture.componentRef.setInput('nbPropositions', e.nbPropositions ?? 5);
    fixture.componentRef.setInput('preset', e.preset ?? null);
    fixture.componentRef.setInput('vehicles', [
      { id: 'v1', plate: 'AA-1', fleetId: 'f1' },
      { id: 'v2', plate: 'BB-2', fleetId: 'f1' },
    ]);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
  };
  const rendre = (): void => fixture.detectChanges();
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const textes = (sel: string): string[] => [...el().querySelectorAll(sel)].map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim());
  const ongletActif = (): string => textes('.ro-body > .ro-f:first-child .ro-seg-btn--on')[0] ?? '';
  /**
   * Répond à TOUTES les simulations de propositions en attente (une simulation périmée — un critère
   * changé entre-temps — est ignorée par la feuille) et rend la dernière, celle qui compte.
   */
  const repondreP = (res: EcartPropositionsResultDto | { erreur: number }): TestRequest | undefined => {
    const reqs = http.match((r) => r.url === URL_PROPOSITIONS);
    for (const r of reqs) {
      if ('erreur' in res) r.flush({ message: 'panne' }, { status: res.erreur, statusText: 'Erreur' });
      else r.flush(res);
    }
    return reqs[reqs.length - 1];
  };
  const repondreR = (res: ReorganisationResultDto = resultatR()): TestRequest | undefined => {
    const reqs = http.match((r) => r.url === URL_RESERVATIONS);
    for (const r of reqs) r.flush(res);
    return reqs[reqs.length - 1];
  };
  const composant = (): {
    choisirQuoi(q: 'reservations' | 'propositions'): void;
    choisirVehicule(id: string): void;
    choisirDuree(jours: number): void;
  } => fixture.componentInstance as unknown as never;
  const boutonEcarter = (): HTMLButtonElement | null =>
    [...el().querySelectorAll<HTMLButtonElement>('.ro-foot button')].find((b) => /Écarter/.test(b.textContent ?? '')) ?? null;

  it('aucune réservation, des propositions : s’ouvre sur l’onglet Propositions, les simule, et propose d’écarter CE lot', () => {
    ouvrir({ total: 0, nbPropositions: 5 });

    const simu = repondreP(resultatP());
    repondreR();
    rendre();

    expect(simu?.request.body).toEqual(jasmine.objectContaining({ simulation: true }));
    // Un gestionnaire : la société n'est jamais envoyée (le filtre est relu du navigateur, quel que soit le rôle).
    expect(simu?.request.body.fleetId).toBeUndefined();
    expect(ongletActif()).toContain('Propositions');
    expect(textes('.ro-title')[0]).toBe('Réorganiser');
    expect(textes('.ro-bilan')[0]).toContain("2 propositions de l'agent seraient écartées");
    expect(boutonEcarter()?.textContent).toContain('Écarter ces 2 propositions');
  });

  it('« Écarter » renvoie le lot EXACT de la simulation, et le compte-rendu RESTE quand la page relit ses propositions', () => {
    ouvrir({ total: 0 });
    const simu = repondreP(resultatP());
    repondreR();
    rendre();
    const avant = sync.propositions();

    boutonEcarter()?.click();
    const app = http.expectOne((r) => r.url === URL_PROPOSITIONS);
    expect(app.request.body).toEqual({ ...simu?.request.body, simulation: false, ids: ['p1', 'p2'] });
    app.flush(resultatP({ simulation: false, ecartees: 2, parVehicule: [] }));
    rendre();

    expect(toast.success).toHaveBeenCalledWith('2 propositions écartées', '');
    expect(sync.propositions()).toBe(avant + 1); // la page relit calendrier, badge et Assistant IA
    // La page relit ses propositions (compte en baisse) : aucune nouvelle simulation ne l'écrase.
    fixture.componentRef.setInput('nbPropositions', 0);
    rendre();
    expect(http.match((r) => r.url === URL_PROPOSITIONS).length).toBe(0);
    expect(textes('.ro-bilan')[0]).toContain('propositions écartées');
    expect(textes('.ro-foot button')).toEqual(['Terminé']);
  });

  it('IA coupée : ni onglet, ni simulation de propositions, ni mention de l’agent', () => {
    ouvrir({ iaActive: false, total: 2 });

    expect(http.match((r) => r.url === URL_PROPOSITIONS).length).toBe(0);
    repondreR(resultatR({ parVehicule: [{ vehicleId: 'v1', plate: 'AA-1', n: 2 }] }));
    rendre();

    expect(textes('.ro-body > .ro-f:first-child .ro-seg-btn').filter((t) => /Propositions/.test(t))).toEqual([]);
    expect(textes('.ro-title')[0]).toBe('Réorganiser des réservations');
  });

  it('ouverte après une immobilisation (`quoi: propositions`) : sur les propositions, même s’il y a des réservations', () => {
    const from = new Date(Date.now() + JOUR).toISOString();
    const to = new Date(Date.now() + 2 * JOUR).toISOString();
    ouvrir({ total: 3, preset: { vehicleId: 'v1', from, to, quoi: 'propositions' } });

    const simu = repondreP(resultatP());
    repondreR();
    rendre();

    expect(simu?.request.body).toEqual(jasmine.objectContaining({ vehicleId: 'v1', from, to }));
    expect(ongletActif()).toContain('Propositions');
  });

  it('T3 : changer de véhicule depuis l’onglet Propositions ne LÈVE plus la limite aux refusées', () => {
    const from = new Date(Date.now() + JOUR).toISOString();
    const to = new Date(Date.now() + 3 * JOUR).toISOString();
    ouvrir({ total: 3, preset: { vehicleId: 'v1', from, to, action: 'reaffecter', ids: ['r1'] } });
    repondreP(resultatP());
    expect(repondreR()?.request.body.ids).toEqual(['r1']);

    composant().choisirQuoi('propositions');
    composant().choisirVehicule('');
    rendre();
    repondreP(resultatP());
    // Sur un autre véhicule, les refusées ne sont pas là : pas de liste blanche…
    expect(repondreR()?.request.body.ids).toBeUndefined();

    composant().choisirVehicule('v1');
    rendre();
    repondreP(resultatP());
    // … et de retour sur le véhicule, la limite est toujours là : rien n'a été élargi en silence.
    expect(repondreR()?.request.body.ids).toEqual(['r1']);

    composant().choisirQuoi('reservations');
    rendre();
    expect(textes('.ro-limite')[0]).toContain('1 réservation refusée à reprendre');
  });

  it('en arrière-plan (onglet Réservations à l’écran), la simulation des propositions est silencieuse ; à l’écran, non', () => {
    ouvrir({ total: 3 });
    const fond = repondreP(resultatP());
    repondreR();
    expect(fond?.request.headers.get('X-Quiet-Errors')).toBe('1');

    composant().choisirQuoi('propositions');
    rendre();
    // Changer d'onglet ne relance rien…
    expect(http.match((r) => r.url === URL_PROPOSITIONS).length).toBe(0);
    // … un critère changé À L'ÉCRAN est un geste de l'utilisateur : ses erreurs se disent.
    composant().choisirDuree(7);
    rendre();
    const ecran = repondreP(resultatP());
    repondreR();
    expect(ecran?.request.headers.has('X-Quiet-Errors')).toBe(false);
  });

  it('une simulation d’arrière-plan en échec est relancée en arrivant sur l’onglet', () => {
    ouvrir({ total: 3 });
    repondreP({ erreur: 500 });
    repondreR();
    rendre();

    composant().choisirQuoi('propositions');
    rendre();
    const relance = repondreP(resultatP());
    rendre();

    expect(relance?.request.body.simulation).toBeTrue();
    expect(textes('.ro-bilan')[0]).toContain('2 propositions');
  });

  it('un lot « Tout réserver / Tout écarter » de l’Assistant IA tourne : « Écarter » attend son bilan', () => {
    sync.debutLot('-|v1');
    ouvrir({ total: 0 });
    repondreP(resultatP());
    repondreR();
    rendre();

    expect(boutonEcarter()?.disabled).toBeTrue();
    expect(textes('.ro-avert').join(' ')).toContain('attendez son bilan');

    sync.finLot('-|v1');
    rendre();
    expect(boutonEcarter()?.disabled).toBeFalse();
  });

  it('rien d’écarté (tout était déjà traité) : un avertissement qui dit pourquoi, pas un toast vert', () => {
    ouvrir({ total: 0 });
    repondreP(resultatP());
    repondreR();
    rendre();

    boutonEcarter()?.click();
    http.expectOne((r) => r.url === URL_PROPOSITIONS).flush(resultatP({ simulation: false, ecartees: 0, dejaTraitees: 2 }));
    rendre();

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith('Aucune proposition écartée', jasmine.stringContaining('2 déjà traitées entre-temps'));
  });

  it('un véhicule dont on ne gère pas les réservations : la feuille le dit, sans bouton', () => {
    const from = new Date(Date.now() + JOUR).toISOString();
    const to = new Date(Date.now() + 2 * JOUR).toISOString();
    ouvrir({ total: 0, preset: { vehicleId: 'v2', from, to, quoi: 'propositions' } });
    repondreP(resultatP({ concernees: 0, apercu: [], lotIds: [], parVehicule: [], horsGestion: 3, vehiculeNonGere: true }));
    repondreR();
    rendre();

    const vide = textes('.ro-vide p').join(' ');
    expect(vide).toContain('Vous ne gérez pas les réservations de BB-2');
    expect(vide).toContain('ses 3 propositions');
    expect(boutonEcarter()).toBeNull();
  });
});
