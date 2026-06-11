import {
  angleDiffDeg,
  bearingDeg,
  deriveMotion,
  extrapolate,
  MAX_EXTRAP_ROTATION_DEG,
  normalizeDeg,
  type TruthSample,
} from './live-motion';

describe('live-motion', () => {
  describe('normalizeDeg / angleDiffDeg', () => {
    it('normalizes into [0,360)', () => {
      expect(normalizeDeg(-10)).toBeCloseTo(350);
      expect(normalizeDeg(370)).toBeCloseTo(10);
      expect(normalizeDeg(0)).toBe(0);
    });

    it('returns the signed shortest difference, crossing 0', () => {
      expect(angleDiffDeg(350, 10)).toBeCloseTo(20);
      expect(angleDiffDeg(10, 350)).toBeCloseTo(-20);
      // L'antipode (±180) est ambigu en signe : on verifie la magnitude.
      expect(Math.abs(angleDiffDeg(0, 180))).toBeCloseTo(180);
    });
  });

  describe('bearingDeg', () => {
    it('points north for a due-north segment', () => {
      expect(bearingDeg(48.0, 2.0, 48.01, 2.0)).toBeCloseTo(0, 0);
    });

    it('points east for a due-east segment', () => {
      expect(bearingDeg(48.0, 2.0, 48.0, 2.01)).toBeCloseTo(90, 0);
    });
  });

  describe('deriveMotion', () => {
    const mk = (
      lat: number, lng: number, t: number, speedKmh: number, heading: number,
    ): TruthSample => ({ lat, lng, timestamp: t, speedKmh, heading });

    it('falls back to reported values without prev', () => {
      const d = deriveMotion(null, mk(48, 2, 1000, 50, 90));
      expect(d.speedMs).toBeCloseTo(50 / 3.6);
      expect(d.headingDeg).toBeCloseTo(90);
      expect(d.turnRateDegPerS).toBe(0);
    });

    it('derives speed from displacement when Coban reports 0 (kills the gray flash)', () => {
      const prev = { lat: 48.0, lng: 2.0, timestamp: 0 };
      // ~278m plein est en 20s, alors que le boitier rapporte speed=0 / heading=0.
      const eastDeg = 278 / (111_111 * Math.cos((48 * Math.PI) / 180));
      const next = mk(48.0, 2.0 + eastDeg, 20_000, 0, 0);
      const d = deriveMotion(prev, next, 90);
      expect(d.effectiveSpeedKmh).toBeGreaterThan(40); // ~50 km/h reconstruit
      expect(d.headingDeg).toBeCloseTo(90, 0);          // direction = vecteur reel, pas 0 rapporte
    });

    it('keeps the reported speed when it exceeds the displacement-derived one', () => {
      const prev = { lat: 48.0, lng: 2.0, timestamp: 0 };
      const next = mk(48.0001, 2.0, 20_000, 80, 0); // micro-deplacement, vitesse haute rapportee
      const d = deriveMotion(prev, next, 0);
      expect(d.effectiveSpeedKmh).toBeCloseTo(80, 0);
    });

    it('computes a positive turn rate when the heading rotates right', () => {
      const prev = { lat: 48.0, lng: 2.0, timestamp: 0 };
      const next = mk(48.001, 2.001, 20_000, 30, 0); // cap ~34°, precedemment 0
      const d = deriveMotion(prev, next, 0);
      expect(d.turnRateDegPerS).toBeGreaterThan(0);
      expect(d.turnRateDegPerS).toBeLessThan(3.5);
    });

    it('ignores micro-jitter for heading (keeps reported heading under threshold)', () => {
      const prev = { lat: 48.0, lng: 2.0, timestamp: 0 };
      const next = mk(48.00001, 2.0, 20_000, 0, 123); // ~1m → sous le seuil de segment
      const d = deriveMotion(prev, next, 50);
      expect(d.headingDeg).toBeCloseTo(123, 0);
      expect(d.turnRateDegPerS).toBe(0);
    });
  });

  describe('extrapolate', () => {
    const CAP = 26; // ~20s * 1.3

    it('stays put below the motion threshold (no drift at standstill)', () => {
      const p = extrapolate({ lat: 48, lng: 2, headingDeg: 90 }, 0, 0, 20, CAP);
      expect(p.lat).toBe(48);
      expect(p.lng).toBe(2);
    });

    it('extrapolates a straight line when yaw ~ 0 (historical behavior preserved)', () => {
      // 13.9 m/s plein nord pendant 20s = 278m → dLat = 278/111111.
      const p = extrapolate({ lat: 48, lng: 2, headingDeg: 0 }, 13.9, 0, 20, CAP);
      expect(p.lat - 48).toBeCloseTo(278 / 111_111, 5);
      expect(p.lng).toBeCloseTo(2, 6);
      expect(p.headingDeg).toBeCloseTo(0);
    });

    it('moves east for an east heading', () => {
      const p = extrapolate({ lat: 48, lng: 2, headingDeg: 90 }, 13.9, 0, 20, CAP);
      expect(p.lng).toBeGreaterThan(2);
      expect(p.lat).toBeCloseTo(48, 5);
    });

    it('freezes past capSec (lost frame / GPRS cut)', () => {
      const atCap = extrapolate({ lat: 48, lng: 2, headingDeg: 0 }, 13.9, 0, CAP, CAP);
      const wayPast = extrapolate({ lat: 48, lng: 2, headingDeg: 0 }, 13.9, 0, 120, CAP);
      expect(wayPast.lat).toBeCloseTo(atCap.lat, 9); // identique → borne respectee
    });

    it('curves into a turn (arc) instead of going tangent, and rotates its heading', () => {
      const straight = extrapolate({ lat: 48, lng: 2, headingDeg: 0 }, 13.9, 0, 20, CAP);
      const turning = extrapolate({ lat: 48, lng: 2, headingDeg: 0 }, 13.9, 2, 20, CAP); // +2°/s
      expect(turning.lng).toBeGreaterThan(straight.lng); // derive vers l'interieur du virage
      expect(turning.headingDeg).toBeGreaterThan(0);
    });

    it('bounds the total rotation (anti-spiral) on a noisy yaw rate', () => {
      const p = extrapolate({ lat: 48, lng: 2, headingDeg: 0 }, 13.9, 999, 20, CAP);
      expect(p.headingDeg).toBeLessThanOrEqual(MAX_EXTRAP_ROTATION_DEG + 1e-6);
    });
  });
});
