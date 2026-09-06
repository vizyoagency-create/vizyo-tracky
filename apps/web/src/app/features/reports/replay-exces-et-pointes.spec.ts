import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TripReplayComponent } from './trip-replay.component';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UN DOUTE NE SE PEINT PAS COMME UNE FAUTE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'analyse distingue deux choses que l'écran confondait :
 *
 *   - `detail.speeding`   — les excès AFFIRMÉS. Ils comptent dans `speedingCount` et dans la
 *                           note de conduite ;
 *   - `detail.aVerifier`  — les pointes que l'analyse REFUSE d'affirmer (« point-unique »,
 *                           « limite-invraisemblable »). Elles ne comptent nulle part, mais on
 *                           les montre : un doute effacé est un doute que personne ne pourra
 *                           lever.
 *
 * Les deux partageaient le type `'exces'`. La frise peignait donc les pointes du même rouge et
 * de la même hauteur que les excès, sous un en-tête qui n'en annonçait qu'un et une légende qui
 * ne parlait que d'« Excès confirmé ».
 *
 * ⚠️ MESURÉ EN PRODUCTION LE 2026-09-06, trajet EZ-259-DB de « mh cars » (47,6 km, 1 h 07) :
 * 1 excès confirmé — 137 km/h pour 130, tenu 99 s — et 5 pointes « point unique ». La frise
 * affichait SIX traits rouges identiques. Le lecteur qui compte les repères lit six fautes ;
 * celui qui lit l'en-tête en lit une. Aucune des deux lectures ne peut être corrigée par
 * l'autre, puisque rien à l'écran ne disait qu'elles parlent de choses différentes.
 */
describe('Replay de trajet — excès confirmés et pointes à vérifier ne se confondent pas', () => {
  let fixture: ComponentFixture<TripReplayComponent>;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let interne: Record<string, any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const T0 = '2026-09-04T11:22:06.000Z';
  const T1 = '2026-09-04T12:29:06.000Z';

  const segment = (h: string, v: number, limite: number) => ({
    startAt: '2026-09-04T' + h + ':00.000Z',
    endAt: '2026-09-04T' + h + ':30.000Z',
    durationSec: 30, maxSpeedKmh: v, limitKmh: limite, overKmh: v - limite,
    lat: 43.55, lng: 1.48,
  });

  /** Le trajet mesuré en production, réduit à ce que le composant en lit. */
  const analyse = (pointes: number) => ({
    tripId: 't1', vehicleId: 'v1', computedAt: T1,
    distanceKm: 47.63, durationSec: 4020, movingSec: 3700,
    avgSpeedKmh: 31, maxSpeedKmh: 137, stopCount: 1, idleSec: 240,
    gpsPoints: 133, gpsValidRatio: 1, gpsLostCount: 0,
    speedingCount: 1, speedingSec: 99, maxOverKmh: 7, limitsKnown: true,
    harshAccel: 0, harshBrake: 0, ecoScore: null, fuelLiters: null,
    detail: {
      stops: [{
        lat: 43.5, lng: 1.4,
        arrivedAt: '2026-09-04T11:54:00.000Z', leftAt: '2026-09-04T11:58:00.000Z', durationMin: 4,
      }],
      speeding: [segment('11:38', 137, 130)],
      gpsGaps: [], track: [],
      aVerifier: [
        { ...segment('11:23', 45, 30), motif: 'point-unique' },
        { ...segment('11:35', 132, 90), motif: 'point-unique' },
        { ...segment('11:51', 58, 50), motif: 'point-unique' },
        { ...segment('12:18', 56, 50), motif: 'point-unique' },
        { ...segment('12:21', 88, 80), motif: 'point-unique' },
      ].slice(0, pointes),
    },
  }) as never;

  const trajet = {
    id: 't1', startedAt: T0, endedAt: T1, durationSeconds: 4020, distanceKm: 47.63,
  } as never;

  const ouvrir = (pointes = 5): void => {
    fixture.componentRef.setInput('trip', trajet);
    fixture.componentRef.setInput('analysis', analyse(pointes));
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TripReplayComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(TripReplayComponent);
    interne = fixture.componentInstance as unknown as Record<string, never>;
  });

  it('les pointes portent leur PROPRE type, jamais celui des excès', () => {
    ouvrir();
    const evs = interne['evenements']() as { type: string; titre: string }[];

    expect(evs.filter((e) => e.type === 'exces').length).toBe(1);
    expect(evs.filter((e) => e.type === 'pointe').length).toBe(5);
    expect(evs.filter((e) => e.type === 'arret').length).toBe(1);
  });

  it("le compte d'excès de l'en-tête ignore les pointes", () => {
    // C'est la moitié DÉJÀ juste de l'écran, et elle doit le rester : la correction ne
    // consiste pas à faire remonter les pointes dans le compte.
    ouvrir();

    expect(interne['nbExces']()).toBe(1);
    expect(interne['nbPointes']()).toBe(5);
  });

  it('la frise distingue les deux au niveau du DOM, pas seulement dans le modèle', () => {
    // ⚠️ Le défaut vivait ENTIÈREMENT dans le rendu : le modèle portait déjà les bons titres
    // (« Pointe à vérifier · 132 km/h »), et c'est l'attribut `data-type` — donc la couleur et
    // la hauteur du trait — qui aplatissait la distinction. Un test sur le seul modèle serait
    // resté vert pendant tout le temps où le défaut a existé.
    ouvrir();
    const marques = fixture.nativeElement.querySelectorAll('.tr-marque') as NodeListOf<HTMLElement>;
    const types = Array.from(marques).map((m) => m.getAttribute('data-type'));

    expect(types.filter((t) => t === 'exces').length).toBe(1);
    expect(types.filter((t) => t === 'pointe').length).toBe(5);
  });

  it('la légende nomme les pointes dès quʼil y en a', () => {
    ouvrir();
    const legende = fixture.nativeElement.querySelector('.tr-legend') as HTMLElement | null;

    expect(legende?.textContent).toContain('Excès confirmé');
    expect(legende?.textContent).toContain('Pointe à vérifier');
  });

  it("aucune pointe : la légende n'invente pas une catégorie vide", () => {
    // Une légende qui nomme une couleur absente de la carte fait chercher ce qui n'y est pas.
    ouvrir(0);
    const legende = fixture.nativeElement.querySelector('.tr-legend') as HTMLElement | null;

    expect(legende?.textContent).toContain('Excès confirmé');
    expect(legende?.textContent).not.toContain('Pointe à vérifier');
  });

  it('le titre de chaque événement dit lequel des deux il est', () => {
    // La liste était déjà juste ; on la fige, parce que c'est elle qui permet de lever le
    // doute une fois le repère cliqué.
    ouvrir();
    const evs = interne['evenements']() as { type: string; titre: string; detail: string }[];
    const pointe = evs.find((e) => e.type === 'pointe')!;
    const exces = evs.find((e) => e.type === 'exces')!;

    expect(pointe.titre).toContain('Pointe à vérifier');
    expect(pointe.detail).toContain('un seul point');
    expect(exces.titre).toContain('Excès confirmé');
    expect(exces.detail).toContain('Limite 130');
  });
});
