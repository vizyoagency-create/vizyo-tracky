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

const ligne = (id: string, label: string, sublabel: string | null, score: number): DrivingScoreRowDto => ({
  id, label, sublabel, color: null, score, grade: 'B', tripCount: 25, totalTripCount: 30, distanceKm: 400,
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
      providers: [
        provideRouter([]),
        { provide: TripAnalysisApiService, useValue: { scores: (scope: DrivingScoreScope) => {
          const o = of(parPortee[scope] ?? reponse(scope));
          return retard[scope] ? o.pipe(delay(retard[scope]!)) : o;
        } } },
        { provide: FleetFilterService, useValue: { selectedFleetId: signal<string | null>(null), isActive: signal(false), matches: () => true, set: () => undefined } },
        { provide: PlanService, useValue: { allows: () => true, ensureLoaded: () => undefined, label: () => '', requiredPlanLabel: () => '' } },
      ],
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
