import { analyzeTrip, type RawPosition } from './trip-analysis.preprocessor';

const T0 = new Date('2026-07-01T08:00:00Z').getTime();
const at = (sec: number) => new Date(T0 + sec * 1000);
/** Point ~à `m` mètres à l'est de la base (1° lng ≈ 78 km à 45°N → 0.0000128°/m env.). */
const east = (m: number) => 1.44 + m * 0.0000128;

function p(sec: number, lngMeters: number, speedKmh: number, over: Partial<RawPosition> = {}): RawPosition {
  return { lat: 43.6, lng: east(lngMeters), speedKmh, timestamp: at(sec), valid: true, ...over };
}

describe('analyzeTrip (préprocesseur déterministe)', () => {
  it('trajet simple : distance / durée / vitesses cohérentes', () => {
    const pts: RawPosition[] = [];
    for (let i = 0; i <= 10; i++) pts.push(p(i * 10, i * 250, 90)); // 250 m / 10 s = 90 km/h
    const r = analyzeTrip(pts);
    expect(r.distanceKm).toBeGreaterThan(2.3);
    expect(r.distanceKm).toBeLessThan(2.7);
    expect(r.maxSpeedKmh).toBe(90);
    expect(r.avgSpeedKmh).toBeGreaterThan(80);
    expect(r.durationSec).toBe(100);
    expect(r.gpsPoints).toBe(11);
  });

  it('filtre les positions muettes / (0,0) / vitesses impossibles', () => {
    const pts: RawPosition[] = [
      p(0, 0, 50),
      { lat: 0, lng: 0, speedKmh: 50, timestamp: at(10), valid: true },       // (0,0) → jeté
      { lat: 43.6, lng: east(300), speedKmh: 50, timestamp: at(20), valid: false }, // invalide → jeté
      p(30, 600, 999),                                                          // vitesse impossible → jeté
      p(40, 800, 50),
    ];
    const r = analyzeTrip(pts);
    expect(r.gpsPoints).toBe(2);           // seuls les 2 valides plausibles
    expect(r.gpsValidRatio).toBeCloseTo(2 / 5, 2);
    expect(r.maxSpeedKmh).toBe(50);        // 999 exclu
  });

  it('détecte un arrêt (stationnaire ≥ 4 min)', () => {
    const pts: RawPosition[] = [p(0, 0, 40), p(30, 800, 40)];
    for (let s = 60; s <= 60 + 300; s += 30) pts.push(p(s, 810, 0)); // ~5 min à l'arrêt au même endroit
    pts.push(p(400, 1200, 40));
    const r = analyzeTrip(pts);
    expect(r.stopCount).toBe(1);
    expect(r.detail.stops[0].durationMin).toBeGreaterThanOrEqual(4);
  });

  it('excès de vitesse : 90 km/h en zone 50 → segment + dépassement', () => {
    const pts: RawPosition[] = [];
    for (let i = 0; i <= 6; i++) pts.push(p(i * 10, i * 250, 90));
    const limit = () => 50; // toute la zone est limitée à 50
    const r = analyzeTrip(pts, {}, limit);
    expect(r.limitsKnown).toBe(true);
    expect(r.speedingCount).toBeGreaterThanOrEqual(1);
    expect(r.maxOverKmh).toBeCloseTo(40, 0); // 90 - 50
    expect(r.detail.speeding[0].limitKmh).toBe(50);
  });

  it('freinage brusque : 90 → 20 km/h en 2 s', () => {
    const pts: RawPosition[] = [p(0, 0, 90), p(2, 40, 20), p(12, 100, 20)];
    const r = analyzeTrip(pts);
    expect(r.harshBrake).toBeGreaterThanOrEqual(1);
  });

  it('ralenti : moteur tournant à l\'arrêt compte en idleSec', () => {
    const pts: RawPosition[] = [];
    for (let s = 0; s <= 180; s += 30) pts.push(p(s, 0, 0, { ignition: true })); // 3 min moteur ON, immobile
    const r = analyzeTrip(pts);
    expect(r.idleSec).toBeGreaterThanOrEqual(150);
    expect(r.ecoScore).toBeLessThan(100); // pénalisé
  });

  it('véhicule électrique : pas de conso/CO₂', () => {
    const pts: RawPosition[] = [p(0, 0, 50), p(10, 250, 50)];
    const r = analyzeTrip(pts, { energy: 'ELECTRIQUE' });
    expect(r.fuelLiters).toBeNull();
    expect(r.co2Kg).toBeNull();
  });

  it('conso estimée diesel : distance × L/100', () => {
    const pts: RawPosition[] = [];
    for (let i = 0; i <= 40; i++) pts.push(p(i * 10, i * 250, 90)); // ~10 km
    const r = analyzeTrip(pts, { energy: 'DIESEL', fuelConsumptionL100km: 10 });
    expect(r.fuelLiters).toBeGreaterThan(0.8); // ~1 L pour 10 km à 10 L/100
    expect(r.co2Kg).toBeGreaterThan(0);
  });
});
