import { TestBed } from '@angular/core/testing';
import { PreferencesService } from './preferences.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA LÉGENDE DU HUD EST REPLIÉE PAR DÉFAUT, ET LE CHOIX SE RETIENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Cinq bandes de vitesse et jusqu'à sept repères, en permanence à l'écran : c'est de la
 * référence qu'on lit une fois. Même patron que `lieuxAffichage` — un défaut, une persistance,
 * et les préférences enregistrées AVANT ce réglage reçoivent le défaut.
 */
const UTILISATEUR = 'u-test-legende';
const CLE = `vizyo-tracky-prefs-${UTILISATEUR}`;

describe('Préférences — légende du HUD', () => {
  beforeEach(() => localStorage.removeItem(CLE));
  afterEach(() => localStorage.removeItem(CLE));

  const visite = (): PreferencesService => {
    TestBed.resetTestingModule();
    const s = TestBed.configureTestingModule({}).inject(PreferencesService);
    s.load(UTILISATEUR);
    return s;
  };

  it('🔴 le défaut est « repliée »', () => {
    expect(visite().prefs().map.legendeRepliee).toBeTrue();
  });

  it('🔴 dépliée une fois, elle reste dépliée à la visite suivante', () => {
    const s = visite();
    s.update({ map: { ...s.prefs().map, legendeRepliee: false } });

    expect(visite().prefs().map.legendeRepliee).toBeFalse();
  });

  it('des préférences enregistrées AVANT ce réglage reçoivent le défaut, sans rien perdre', () => {
    localStorage.setItem(CLE, JSON.stringify({ map: { style: 'osm', zoom: 12, lieuxAffichage: 'tous' } }));

    const s = visite();

    expect(s.prefs().map.legendeRepliee).toBeTrue();
    expect(s.prefs().map.lieuxAffichage).toBe('tous');
  });
});
