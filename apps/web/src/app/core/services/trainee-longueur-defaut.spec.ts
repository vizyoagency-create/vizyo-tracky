import { TestBed } from '@angular/core/testing';
import { PreferencesService, TRAINEE_POINTS_DEFAUT, TRAINEE_POINTS_MAX } from './preferences.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA TRAÎNÉE EST COURTE PAR DÉFAUT — ET UN ANCIEN RÉGLAGE À 20 POINTS NE LA RALLONGE PLUS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Demande du propriétaire (2026-09-07) : deux ou trois traînées derrière ceux qui roulent. À
 * 20 points et une trame toutes les 10 à 16 s (mesuré en production), la traînée faisait 3 à
 * 5 minutes de route : c'est le « en retard » ressenti.
 *
 * ⚠️ LE DÉFAUT NE SUFFIT PAS. Chaque utilisateur porte déjà `trailLength: 20` dans ses
 * préférences enregistrées — l'ancien défaut, recopié à la première visite. Le fusionner tel
 * quel garderait l'ancienne longueur pour tout le monde, et le nouveau défaut ne s'appliquerait
 * qu'aux comptes créés demain.
 */
const UTILISATEUR = 'u-test-trainee';
const CLE = `vizyo-tracky-prefs-${UTILISATEUR}`;

describe('Préférences — longueur de la traînée', () => {
  beforeEach(() => localStorage.removeItem(CLE));
  afterEach(() => localStorage.removeItem(CLE));

  const visite = (): PreferencesService => {
    TestBed.resetTestingModule();
    const s = TestBed.configureTestingModule({}).inject(PreferencesService);
    s.load(UTILISATEUR);
    return s;
  };

  it('🔴 le défaut est court : quatre points, trois tronçons', () => {
    expect(TRAINEE_POINTS_DEFAUT).toBe(4);
    expect(visite().prefs().map.trailLength).toBe(4);
  });

  it('🔴 un réglage hérité de 20 points retombe au nouveau défaut', () => {
    localStorage.setItem(CLE, JSON.stringify({ map: { style: 'osm', zoom: 12, trailLength: 20 } }));

    const s = visite();

    expect(s.prefs().map.trailLength).toBe(TRAINEE_POINTS_DEFAUT);
    // …sans toucher au reste de ses réglages.
    expect(s.prefs().map.zoom).toBe(12);
  });

  it('un réglage explicite dans la plage est conservé', () => {
    localStorage.setItem(CLE, JSON.stringify({ map: { trailLength: 6 } }));

    expect(visite().prefs().map.trailLength).toBe(6);
    expect(TRAINEE_POINTS_MAX).toBeGreaterThanOrEqual(6);
  });
});
