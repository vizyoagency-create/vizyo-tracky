import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TripReplayComponent } from './trip-replay.component';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEUX ÉCHELLES D'UN REPLAY
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La carte s'ouvre sur TOUT le trajet. Mesuré en production le 2026-09-06 : 47,6 km dans
 * 342 px de large, où la voiture est un point et la route un trait. À cette échelle, le suivi
 * mis en place au lot précédent ne sert à rien — la voiture ne quitte jamais les 60 % centraux,
 * donc la caméra ne bouge pas d'un pixel de toute la lecture.
 *
 * Pour regarder la conduite il fallait pincer trois fois, à chaque ouverture, et ce geste
 * coupait le suivi : on se retrouvait zoomé sur une route que la voiture venait de quitter.
 *
 * D'où deux modes, et surtout DEUX RÈGLES DE SUIVI :
 *
 *   - « trajet »   → recentrage seulement quand la voiture approche du bord ;
 *   - « conduite » → caméra collée à la voiture, à chaque image.
 *
 * ⚠️ La seconde règle n'est pas un réglage plus agressif de la première. À 1x ce replay
 * comprime 1 h 07 en 30 s — 134 fois le temps réel — donc la voiture traverse un cadre de
 * 700 m en moins de deux secondes : la règle du bord y produirait un défilement par à-coups.
 */
describe('Replay de trajet — la caméra a deux échelles, et le doigt garde la main', () => {
  let fixture: ComponentFixture<TripReplayComponent>;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let interne: Record<string, any>;
  let carte: Record<string, any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /**
   * Un simulacre de carte MapLibre, réduit à ce que la caméra lui demande.
   *
   * ⚠️ `remove` en fait partie : `cleanup()` l'appelle à la destruction du composant, et un
   * simulacre sans lui fait échouer les dix tests d'un coup sur « 1 component threw errors
   * during cleanup » — un message qui ne dit ni quel composant, ni quelle méthode.
   */
  const fausseCarte = (zoom = 11) => ({
    zoom,
    easeTo: jasmine.createSpy('easeTo'),
    jumpTo: jasmine.createSpy('jumpTo'),
    remove: jasmine.createSpy('remove'),
    getZoom(): number { return this.zoom as number; },
    getCanvas: () => ({ clientWidth: 342, clientHeight: 220 }),
    // La voiture est pile au centre : sous la règle « trajet », rien ne doit bouger.
    project: () => ({ x: 171, y: 110 }),
  });

  const ouvrir = (zoom = 11): void => {
    fixture.componentRef.setInput('trip', {
      id: 't1', startedAt: '2026-09-04T11:22:06.000Z', endedAt: '2026-09-04T12:29:06.000Z',
      durationSeconds: 4020, distanceKm: 47.63,
    } as never);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    carte = fausseCarte(zoom);
    interne['map'] = carte;
    // `projeter` rend ce point unique tel quel : assez pour que la caméra ait une cible.
    interne['points'] = [[1.48, 43.55]];
    interne['distanceTotale'] = 0;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TripReplayComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(TripReplayComponent);
    interne = fixture.componentInstance as unknown as Record<string, never>;
  });

  it('à lʼouverture, on est à lʼéchelle du trajet', () => {
    ouvrir();

    expect(interne['modeCamera']()).toBe('trajet');
  });

  it('« Zoom sur la voiture » passe en conduite, centre, et arme le suivi', () => {
    ouvrir(11);
    interne['basculerCamera']();

    expect(interne['modeCamera']()).toBe('conduite');
    expect(interne['suiviActif']()).toBeTrue();
    const arg = carte['easeTo'].calls.mostRecent().args[0];
    expect(arg.center).toEqual([1.48, 43.55]);
    expect(arg.zoom).toBe(15);
  });

  it('un zoom DÉJÀ plus serré que la vue conduite est conservé', () => {
    // ⚠️ Quelqu'un qui a pincé jusqu'à 17 pour lire une rue ne veut pas être RECULÉ à 15
    // par un bouton qui promet de zoomer. Le mode fixe un plancher, pas une valeur.
    ouvrir(17);
    interne['basculerCamera']();

    expect(carte['easeTo'].calls.mostRecent().args[0].zoom).toBe(17);
  });

  it('« Tout le trajet » revient au cadrage complet et désarme le suivi', () => {
    // À l'échelle du trajet entier, un suivi armé recentrerait la carte au moindre passage
    // près du bord, sans que personne ne l'ait demandé.
    ouvrir();
    const fit = spyOn(interne['mapSvc'], 'fitBounds');
    interne['basculerCamera']();
    interne['basculerCamera']();

    expect(interne['modeCamera']()).toBe('trajet');
    expect(interne['suiviActif']()).toBeFalse();
    expect(fit).toHaveBeenCalled();
  });

  it('en conduite, la caméra colle à la voiture à CHAQUE image', () => {
    ouvrir();
    interne['basculerCamera']();
    carte['jumpTo'].calls.reset();

    interne['suivreSiBesoin'](1.49, 43.56);
    interne['suivreSiBesoin'](1.50, 43.57);

    expect(carte['jumpTo']).toHaveBeenCalledTimes(2);
    expect(carte['jumpTo'].calls.mostRecent().args[0]).toEqual({ center: [1.50, 43.57] });
  });

  it('en vue trajet, une voiture au centre ne fait bouger personne', () => {
    // La règle historique, qu'il ne faut surtout pas remplacer : recentrer à chaque image
    // au zoom choisi par l'utilisateur rendrait la carte illisible.
    ouvrir();
    carte['jumpTo'].calls.reset();
    carte['easeTo'].calls.reset();

    interne['suivreSiBesoin'](1.49, 43.56);

    expect(carte['jumpTo']).not.toHaveBeenCalled();
    expect(carte['easeTo']).not.toHaveBeenCalled();
  });

  it('un geste coupe le suivi, dans les deux modes', () => {
    ouvrir();
    interne['basculerCamera']();
    interne['suiviActif'].set(false); // ce que fait l'écoute de `dragstart`
    carte['jumpTo'].calls.reset();

    interne['suivreSiBesoin'](1.49, 43.56);

    expect(carte['jumpTo']).not.toHaveBeenCalled();
  });

  it('réarmer le suivi en conduite ramène À LʼÉCHELLE DE LA CONDUITE', () => {
    // ⚠️ Sans le zoom, « Suivre le véhicule » ramenait sur la voiture à l'échelle du trajet
    // entier — c'est-à-dire nulle part où l'on voit quoi que ce soit, sous un bouton qui
    // promet exactement le contraire.
    ouvrir(11);
    interne['basculerCamera']();
    interne['suiviActif'].set(false);
    carte['easeTo'].calls.reset();

    interne['reprendreLeSuivi']();

    expect(interne['suiviActif']()).toBeTrue();
    expect(carte['easeTo'].calls.mostRecent().args[0].zoom).toBe(15);
  });

  it('réarmer en vue trajet ne touche PAS au zoom', () => {
    ouvrir(11);
    interne['suiviActif'].set(false);
    carte['easeTo'].calls.reset();

    interne['reprendreLeSuivi']();

    expect(carte['easeTo'].calls.mostRecent().args[0].zoom).toBeUndefined();
  });

  it('le bouton dit ce que le clic VA FAIRE, pas où lʼon est', () => {
    // Un bouton qui affiche l'état courant fait cliquer à l'envers une fois sur deux.
    ouvrir();
    fixture.detectChanges();
    const bouton = () => fixture.nativeElement.querySelector('.tr-cam') as HTMLElement;

    expect(bouton().textContent).toContain('Zoom sur la voiture');
    expect(bouton().getAttribute('aria-pressed')).toBe('false');

    interne['basculerCamera']();
    fixture.detectChanges();

    expect(bouton().textContent).toContain('Tout le trajet');
    expect(bouton().getAttribute('aria-pressed')).toBe('true');
  });

  it('sans carte prête, la bascule ne change rien et ne jette pas', () => {
    // Le bouton existe dès l'ouverture ; la carte, elle, naît une image plus tard.
    ouvrir();
    interne['map'] = null;

    expect(() => interne['basculerCamera']()).not.toThrow();
    expect(interne['modeCamera']()).toBe('trajet');
  });

  /**
   * ── CE QUI APPARTIENT AU TRAJET QU'ON QUITTE ──────────────────────────────────────────
   *
   * Relevé en production le 2026-09-06 : après un replay passé en vue conduite, ouvrir un
   * AUTRE trajet donnait un bouton « Tout le trajet » — une modale qui se déclare en vue
   * conduite — alors que la caméra venait de faire son cadrage d'ouverture sur la trace
   * entière. Le bouton proposait de revenir là où on était déjà.
   */
  it('ouvrir un autre trajet repart de la vue trajet', () => {
    ouvrir();
    interne['basculerCamera']();
    expect(interne['modeCamera']()).toBe('conduite');

    // `cleanup()` est ce que `initReplay` exécute en premier pour le trajet suivant.
    interne['cleanup']();

    expect(interne['modeCamera']()).toBe('trajet');
  });

  it('et avec le suivi réarmé, même si le trajet précédent lʼavait coupé', () => {
    // Sinon le trajet suivant s'ouvre avec « Suivre le véhicule » affiché, sans que
    // personne n'ait touché à CETTE carte-là.
    ouvrir();
    interne['suiviActif'].set(false);

    interne['cleanup']();

    expect(interne['suiviActif']()).toBeTrue();
  });
});

