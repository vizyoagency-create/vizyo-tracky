/**
 * Lot V5 — la décision d'alerter sur un excès est PARTAGÉE : ces tests protègent la seule
 * définition que le serveur et l'écran appliquent.
 */
import { decideAlerteExces, reglageEffectif } from './alerte-exces';
import { parametresTrajet, urlDuTrajet } from './lien-trajet';
import type { SpeedingSegmentDto } from '../dto/trip-analysis.dto';

const FLOTTE = { speedAlertEnabled: true, speedAlertOverKmh: 20, speedAlertAbsoluteKmh: 130 };

function segment(over: number, opts: Partial<SpeedingSegmentDto> = {}): SpeedingSegmentDto {
  const limit = opts.limitKmh ?? 90;
  return {
    startAt: '2026-08-29T12:20:00.000Z', endAt: '2026-08-29T12:20:40.000Z', durationSec: 40,
    maxSpeedKmh: limit + over, limitKmh: limit, overKmh: over, lat: 43.6, lng: 1.4,
    ...opts,
  };
}

describe('reglageEffectif — société, surchargée par le véhicule', () => {
  it('hérite entièrement de la société sans surcharge', () => {
    expect(reglageEffectif(FLOTTE, null)).toEqual({ enabled: true, overKmh: 20, absoluteKmh: 130 });
  });

  it('un véhicule peut couper ce que la société active, et inversement', () => {
    expect(reglageEffectif(FLOTTE, { speedAlertEnabled: false, speedAlertOverKmh: null }).enabled).toBe(false);
    expect(reglageEffectif({ ...FLOTTE, speedAlertEnabled: false }, { speedAlertEnabled: true, speedAlertOverKmh: null }).enabled).toBe(true);
  });

  it('un seuil véhicule remplace celui de la société ; le plafond absolu, jamais', () => {
    const r = reglageEffectif(FLOTTE, { speedAlertEnabled: null, speedAlertOverKmh: 35 });
    expect(r.overKmh).toBe(35);
    expect(r.absoluteKmh).toBe(130);
  });
});

describe('decideAlerteExces — quand un trajet mérite une alerte', () => {
  const reglage = reglageEffectif(FLOTTE, null);

  it('ne dit rien quand les alertes sont coupées, quelle que soit la faute', () => {
    expect(decideAlerteExces({ maxSpeedKmh: 180, speeding: [segment(70)] }, { ...reglage, enabled: false })).toBeNull();
  });

  it('ne dit rien sous le seuil réglé', () => {
    expect(decideAlerteExces({ maxSpeedKmh: 105, speeding: [segment(12), segment(19)] }, reglage)).toBeNull();
  });

  it('retient le PIRE dépassement, et compte tous les excès du trajet', () => {
    const d = decideAlerteExces({ maxSpeedKmh: 125, speeding: [segment(22), segment(35), segment(8)] }, reglage);
    expect(d).toMatchObject({ motif: 'limite', overKmh: 35, limitKmh: 90, speedKmh: 125, segmentCount: 3, severity: 'WARNING' });
  });

  it('à dépassement égal, retient le plus long', () => {
    const d = decideAlerteExces(
      { maxSpeedKmh: 120, speeding: [segment(30, { durationSec: 5 }), segment(30, { durationSec: 90 })] },
      reglage,
    );
    expect(d?.durationSec).toBe(90);
  });

  it('devient CRITIQUE à partir de 50 km/h au-dessus de la limite — le seuil du délit', () => {
    expect(decideAlerteExces({ maxSpeedKmh: 139, speeding: [segment(49)] }, reglage)?.severity).toBe('WARNING');
    expect(decideAlerteExces({ maxSpeedKmh: 140, speeding: [segment(50)] }, reglage)?.severity).toBe('CRITICAL');
  });

  it('rattrape une pointe au-delà du plafond même sans aucune limite connue', () => {
    // Le trajet à 168 km/h dont la carte n’avait rien dit : aucun segment, mais 168 > 130.
    const d = decideAlerteExces(
      { maxSpeedKmh: 168, speeding: [], track: [{ lat: 43.1, lng: 1.1, t: '2026-08-29T12:30:00.000Z', speedKmh: 168 }, { lat: 43.2, lng: 1.2, t: '2026-08-29T12:31:00.000Z', speedKmh: 120 }] },
      reglage,
    );
    expect(d).toMatchObject({ motif: 'absolu', overKmh: 38, limitKmh: null, speedKmh: 168, lat: 43.1, lng: 1.1, severity: 'WARNING' });
  });

  it('sans plafond réglé, une pointe sans limite connue ne produit rien', () => {
    expect(decideAlerteExces({ maxSpeedKmh: 168, speeding: [] }, { ...reglage, absoluteKmh: null })).toBeNull();
  });

  it('entre la limite et le plafond, la voie la plus GRAVE l’emporte', () => {
    // +22 sur une voie à 90, mais 195 km/h ailleurs sans limite : c’est le 195 qu’il faut dire.
    const grave = decideAlerteExces({ maxSpeedKmh: 195, speeding: [segment(22)] }, reglage);
    expect(grave?.motif).toBe('absolu');
    expect(grave?.severity).toBe('CRITICAL');
    // +60 sur une voie à 90 (150 km/h) : le dépassement de limite dit plus que « 150 > 130 ».
    const precis = decideAlerteExces({ maxSpeedKmh: 150, speeding: [segment(60)] }, reglage);
    expect(precis?.motif).toBe('limite');
  });
});

describe('lien vers le trajet — un seul format, serveur et écran', () => {
  it('produit l’adresse que la fiche véhicule sait déjà lire', () => {
    expect(urlDuTrajet('veh-1', 'trip-1', '2026-08-29T12:12:00.000Z', 'al-1')).toBe(
      '/vehicles/veh-1?tab=reports&trip=trip-1&tripDate=2026-08-29T12%3A12%3A00.000Z&alert=al-1',
    );
  });

  it('omet l’alerte quand il n’y en a pas', () => {
    expect(parametresTrajet('trip-1', '2026-08-29T12:12:00.000Z')).toEqual({ tab: 'reports', trip: 'trip-1', tripDate: '2026-08-29T12:12:00.000Z' });
  });
});
