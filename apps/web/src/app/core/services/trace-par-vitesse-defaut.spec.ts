import { TestBed } from '@angular/core/testing';
import { PreferencesService } from './preferences.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE TRACÉ EST COLORÉ PAR LA VITESSE PAR DÉFAUT — ET LE CHOIX INVERSE EST RETENU
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Décision du 2026-09-08. Le client veut un maximum de détail lisible, et paramétrable :
 * la couleur de vitesse est donc là d'emblée, et qui la trouve trompeuse (le rouge des
 * 101-140 km/h ressemble au rouge des excès) la coupe d'une case, une fois pour toutes.
 */
const UTILISATEUR = 'u-test-trace-vitesse';
const CLE = `vizyo-tracky-prefs-${UTILISATEUR}`;

describe('Préférences — tracé coloré par la vitesse', () => {
  beforeEach(() => localStorage.removeItem(CLE));
  afterEach(() => localStorage.removeItem(CLE));

  const visite = (): PreferencesService => {
    TestBed.resetTestingModule();
    const s = TestBed.configureTestingModule({}).inject(PreferencesService);
    s.load(UTILISATEUR);
    return s;
  };

  it('🔴 par défaut, le tracé est coloré par la vitesse', () => {
    expect(visite().prefs().map.traceParVitesse).toBeTrue();
  });

  it('🔴 un utilisateur qui a coupé la couleur la retrouve coupée à sa prochaine visite', () => {
    const s = visite();
    s.update({ map: { ...s.prefs().map, traceParVitesse: false } });

    expect(visite().prefs().map.traceParVitesse).toBeFalse();
  });

  it('des préférences enregistrées avant ce réglage reçoivent le défaut, sans toucher au reste', () => {
    localStorage.setItem(CLE, JSON.stringify({ map: { style: 'osm', zoom: 12, trailLength: 6 } }));

    const s = visite();

    expect(s.prefs().map.traceParVitesse).toBeTrue();
    expect(s.prefs().map.trailLength).toBe(6);
  });
});
