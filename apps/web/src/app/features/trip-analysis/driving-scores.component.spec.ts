/**
 * ══ L'ENCART « NON ATTRIBUÉ » SE VOIT MÊME QUAND LE CLASSEMENT EST PLEIN ═══════════════
 *
 * Première version relue le 2026-09-05 : l'encart n'était rendu que dans la branche « aucune
 * ligne ». Chez cdef31, 17 groupes notés l'auraient masqué, et le gestionnaire aurait cru que
 * TOUT le parc est noté. Ce jeu d'essai monte le composant avec un classement plein ET des
 * trajets non attribués, et exige les deux à l'écran.
 */
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, delay } from 'rxjs';
import type { DrivingScoreRowDto, DrivingScoreScope, DrivingScoresDto } from '@vizyo/tracky-shared';
import { DrivingScoresComponent } from './driving-scores.component';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PlanService } from '../../core/services/plan.service';

/** `anciennes` = analyses écrites avant la règle actuelle, parmi les 25 qui font la note. */
const ligne = (id: string, label: string, sublabel: string | null, score: number, anciennes = 0): DrivingScoreRowDto => ({
  id, label, sublabel, color: null, score, grade: 'B', tripCount: 25, totalTripCount: 30, distanceKm: 400,
  oldFormulaTripCount: anciennes,
  speedingTrips: 0, speedingTripRefs: [], harshCount: 0, fuelLiters: 0, co2Kg: 0,
});

/** Chiffres < 1 000 exprès : le test ne doit pas dépendre de la locale du pipe `number`. */
const reponse = (scope: DrivingScoreScope, over: Partial<DrivingScoresDto> = {}): DrivingScoresDto => ({
  scope, from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z',
  rows: [], unattributed: null, overallScore: null, overallGrade: null, totalTrips: 0, rankedCount: 0,
  dormantExcludedCount: 0, dormantExcludedTrips: 0, dormantRows: [],
  minAnalysesForRanking: 20, insufficientRows: [], insufficientCount: 0,
  ...over,
} as DrivingScoresDto);

/**
 * Fournisseurs simulés, partagés par les deux suites de ce fichier : l'API rend la réponse
 * posée pour la portée demandée, avec un retard facultatif.
 */
const providersSimules = (
  parPortee: Partial<Record<DrivingScoreScope, DrivingScoresDto>>,
  retard: Partial<Record<DrivingScoreScope, number>>,
) => [
  provideRouter([]),
  { provide: TripAnalysisApiService, useValue: { scores: (scope: DrivingScoreScope) => {
    const o = of(parPortee[scope] ?? reponse(scope));
    return retard[scope] ? o.pipe(delay(retard[scope]!)) : o;
  } } },
  { provide: FleetFilterService, useValue: { selectedFleetId: signal<string | null>(null), isActive: signal(false), matches: () => true, set: () => undefined } },
  { provide: PlanService, useValue: { allows: () => true, ensureLoaded: () => undefined, label: () => '', requiredPlanLabel: () => '' } },
];

describe('DrivingScoresComponent — portée « conducteur, sinon groupe »', () => {
  let fixture: ComponentFixture<DrivingScoresComponent>;
  let parPortee: Partial<Record<DrivingScoreScope, DrivingScoresDto>>;
  /** Retard (ms) de la réponse d'une portée — pour simuler une réponse qui arrive après la suivante. */
  let retard: Partial<Record<DrivingScoreScope, number>>;

  beforeEach(async () => {
    parPortee = {};
    retard = {};
    await TestBed.configureTestingModule({
      imports: [DrivingScoresComponent],
      providers: providersSimules(parPortee, retard),
    }).compileComponents();
    fixture = TestBed.createComponent(DrivingScoresComponent);
  });

  async function afficher(scope: DrivingScoreScope): Promise<HTMLElement> {
    fixture.detectChanges(); // ngOnInit → chargement de la portée par défaut
    await fixture.whenStable();
    fixture.componentInstance['setScope'](scope);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('rend l’encart AU-DESSUS d’un classement plein — pas seulement quand il est vide', async () => {
    parPortee.attribution = reponse('attribution', {
      rows: [ligne('group:g1', 'Livraisons', 'groupe — trajets sans conducteur', 82), ligne('driver:d1', 'Sohaib Hamanni', 'conducteur', 76)],
      rankedCount: 2, totalTrips: 50, overallScore: 79, overallGrade: 'B',
      unattributed: { tripCount: 3, totalTripCount: 42, periodTripCount: 100, distanceKm: 512 },
    });
    const el = await afficher('attribution');
    expect(el.querySelectorAll('.ds-row').length).toBe(2);
    const encart = el.querySelector('.ds-non-attribue');
    expect(encart).withContext('encart absent alors que 42 trajets ne sont imputés à personne').not.toBeNull();
    const texte = encart!.textContent!.replace(/\s+/g, ' ');
    expect(texte).toContain('42 trajets');
    // ⚠️ Le dénominateur est le total RÉEL de la période (100), pas les 50 trajets classés.
    expect(texte).toContain('sur 100 (42 %');
    expect(texte).toContain('ni conducteur, ni groupe');
    expect(encart!.querySelector('a')!.getAttribute('href')).toBe('/vehicles');
    // Et l'encart précède le classement dans le flux du document.
    const liste = el.querySelector('.ds-list')!;
    expect(encart!.compareDocumentPosition(liste) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('titre du podium au pluriel correct', async () => {
    parPortee.attribution = reponse('attribution', {
      rows: [ligne('group:g1', 'Livraisons', 'groupe — trajets sans conducteur', 82), ligne('driver:d1', 'Sohaib Hamanni', 'conducteur', 76)],
      rankedCount: 2, totalTrips: 50,
    });
    const el = await afficher('attribution');
    expect(el.querySelector('.ds-podium-cap')!.textContent).toContain('top 3 des conducteurs et groupes');
  });

  it('classement vide + rien d’imputé : l’état vide n’invite PAS à analyser des trajets', async () => {
    parPortee.attribution = reponse('attribution', {
      unattributed: { tripCount: 0, totalTripCount: 866, periodTripCount: 886, distanceKm: 9000 },
    });
    const el = await afficher('attribution');
    expect(el.querySelector('.ds-non-attribue')).not.toBeNull();
    const vide = el.querySelector('.ds-empty')!.textContent!;
    expect(vide).toContain('ne sont imputés à personne');
    expect(vide).not.toContain('Analysez des trajets');
  });

  it('un seul orphelin au milieu d’une flotte sous le seuil : le conseil reste « analysez »', async () => {
    parPortee.attribution = reponse('attribution', {
      insufficientRows: [ligne('group:g1', 'Livraisons', 'groupe — trajets sans conducteur', 82)], insufficientCount: 1,
      unattributed: { tripCount: 0, totalTripCount: 1, periodTripCount: 100, distanceKm: 12 },
    });
    const el = await afficher('attribution');
    expect(el.querySelector('.ds-non-attribue')).withContext('l’encart reste dû, même pour un seul trajet').not.toBeNull();
    const vide = el.querySelector('.ds-empty')!.textContent!;
    expect(vide).toContain('Analysez des trajets');
    expect(vide).not.toContain('ne sont imputés à personne');
  });

  /**
   * ⚠️ Deux bascules rapides : la réponse « Véhicules » revient APRÈS celle de « Conducteur ou
   * groupe ». Sans la garde, elle écrasait l'écran — et l'encart avec.
   */
  it('une réponse en retard d’une portée quittée n’écrase pas la portée courante', async () => {
    retard.vehicle = 40;
    parPortee.attribution = reponse('attribution', { unattributed: { tripCount: 0, totalTripCount: 5, periodTripCount: 5, distanceKm: 1 } });
    fixture.detectChanges(); // ngOnInit → « vehicle », réponse dans 40 ms
    fixture.componentInstance['setScope']('attribution'); // réponse immédiate
    await new Promise((r) => setTimeout(r, 90)); // la réponse « vehicle » arrive après coup
    fixture.detectChanges();
    expect(fixture.componentInstance['scope']()).toBe('attribution');
    expect((fixture.nativeElement as HTMLElement).querySelector('.ds-non-attribue')).withContext('la réponse en retard a écrasé la portée courante').not.toBeNull();
  });

  it('aucun encart hors de cette portée', async () => {
    parPortee.vehicle = reponse('vehicle', { rows: [ligne('v1', 'AB-123-CD', 'Renault Clio', 90)], rankedCount: 1, totalTrips: 25 });
    const el = await afficher('vehicle');
    expect(el.querySelector('.ds-non-attribue')).toBeNull();
    expect(el.querySelector('.ds-empty')).toBeNull();
  });
});

/**
 * ══ « SUR COMBIEN D'ANALYSES ANCIENNES CETTE NOTE EST-ELLE CALCULÉE ? » ════════════════
 *
 * Les écrans ne comptent plus les faux excès des analyses écrites avant la règle actuelle
 * (lot V1, 4 septembre 2026), mais la NOTE, elle, est toujours calculée dessus : un conducteur
 * pouvait être classé sur 40 analyses dont 35 anciennes, et rien à l'écran ne le disait.
 *
 * Ce que cette suite verrouille : la mention EXISTE quand il y a de quoi la dire, DISPARAÎT
 * quand tout est récent, et son info-bulle explique ce que ça change — sans jamais qualifier
 * la note du conducteur de fausse.
 */
describe('DrivingScoresComponent — réserve « analyses anciennes »', () => {
  let fixture: ComponentFixture<DrivingScoresComponent>;
  let parPortee: Partial<Record<DrivingScoreScope, DrivingScoresDto>>;

  beforeEach(async () => {
    parPortee = {};
    await TestBed.configureTestingModule({
      imports: [DrivingScoresComponent],
      providers: providersSimules(parPortee, {}),
    }).compileComponents();
    fixture = TestBed.createComponent(DrivingScoresComponent);
  });

  /** Portée par défaut (« véhicules ») : un seul chargement, aucune bascule à attendre. */
  async function afficher(): Promise<HTMLElement> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('annonce la réserve sous la ligne, à côté du taux d’analyse', async () => {
    parPortee.vehicle = reponse('vehicle', {
      rows: [ligne('v1', 'AB-123-CD', 'Renault Clio', 90, 18)],
      rankedCount: 1, totalTrips: 25, overallScore: 90, overallGrade: 'A',
    });
    const el = await afficher();

    const mention = el.querySelector('.ds-row .ds-ancien');
    expect(mention).withContext('la note repose sur 18 analyses anciennes, et rien ne le dit').not.toBeNull();
    expect(mention!.textContent!.replace(/\s+/g, ' ').trim()).toBe('dont 18 analyses anciennes');
    // Elle accompagne le « N analysés sur M », elle ne le remplace pas.
    expect(el.querySelector('.ds-row-stats')!.textContent).toContain('25 analysé');
  });

  it('disparaît quand toutes les analyses sont récentes', async () => {
    parPortee.vehicle = reponse('vehicle', {
      rows: [ligne('v1', 'AB-123-CD', 'Renault Clio', 90, 0)],
      rankedCount: 1, totalTrips: 25,
    });
    const el = await afficher();
    expect(el.querySelector('.ds-ancien')).withContext('« dont 0 analyse ancienne » n’a rien à dire').toBeNull();
  });

  /**
   * ⚠️ L'info-bulle doit dire les TROIS choses, et pas une quatrième : d'où viennent ces
   * analyses, ce que leur détail peut contenir, et pourquoi le nombre baissera tout seul.
   *
   * ⚠️ Et « faux » ne doit jamais qualifier la NOTE : la note reste la meilleure mesure
   * disponible. Un « note faussée » à cet endroit accuserait un conducteur d'un défaut de
   * données qu'il n'a pas choisi.
   */
  it('l’info-bulle explique la réserve sans mettre en cause la note', async () => {
    parPortee.vehicle = reponse('vehicle', {
      rows: [ligne('v1', 'AB-123-CD', 'Renault Clio', 90, 18)],
      rankedCount: 1, totalTrips: 25,
    });
    const el = await afficher();

    const titre = el.querySelector('.ds-ancien')!.getAttribute('title')!;
    expect(titre).toContain('18 des 25 analyses');
    expect(titre).toContain('avant la règle actuelle');
    expect(titre).toContain('faux excès');
    expect(titre).toContain('rattrapage');
    // Le mot « faux » porte sur le détail stocké, jamais sur la note.
    expect(titre).not.toMatch(/note\s+(fausse|faussée|erronée)/i);
  });

  /** Une seule analyse ancienne : la phrase reste du français, au singulier. */
  it('accorde au singulier', async () => {
    parPortee.vehicle = reponse('vehicle', {
      rows: [ligne('v1', 'AB-123-CD', 'Renault Clio', 90, 1)],
      rankedCount: 1, totalTrips: 25,
    });
    const el = await afficher();

    const mention = el.querySelector('.ds-ancien')!;
    expect(mention.textContent!.replace(/\s+/g, ' ').trim()).toBe('dont 1 analyse ancienne');
    expect(mention.getAttribute('title')).toContain('a été écrite');
  });

  /**
   * Les lignes ÉCARTÉES affichent déjà un compte d'analyses : la même question se pose sur
   * leur note, et un exploitant qui déplie ce bloc y cherche précisément ce que la note vaut.
   */
  it('la même mention accompagne les lignes écartées du classement', async () => {
    parPortee.vehicle = reponse('vehicle', {
      // ⚠️ Une ligne classée est nécessaire : le bloc des écartés vit dans la branche
      // « le classement n'est pas vide » du gabarit.
      rows: [ligne('v1', 'AB-123-CD', 'Renault Clio', 90, 0)],
      rankedCount: 1, totalTrips: 25,
      insufficientRows: [ligne('v2', 'HD-292-SH', 'Peugeot 208', 100, 12)],
      insufficientCount: 1,
    });
    const el = await afficher();

    const mention = el.querySelector('.ds-insuf-row .ds-ancien');
    expect(mention).withContext('les écartés affichent un compte d’analyses, donc la même réserve').not.toBeNull();
    expect(mention!.textContent!.replace(/\s+/g, ' ').trim()).toBe('dont 12 analyses anciennes');
    // …et la ligne classée, dont toutes les analyses sont récentes, n'en porte pas.
    expect(el.querySelector('.ds-row .ds-ancien')).toBeNull();
  });
});
