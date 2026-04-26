import {
  douglasPeucker,
  haversineMeters,
  isPlausibleJump,
  isValidLatLng,
  sanitizePositions,
} from './gps-sanity';

describe('gps-sanity', () => {
  describe('haversineMeters', () => {
    it('returns 0 for identical coordinates', () => {
      expect(haversineMeters(48.8566, 2.3522, 48.8566, 2.3522)).toBe(0);
    });

    it('returns positive distance for different coordinates', () => {
      // Paris -> Marseille ~ 660 km
      const d = haversineMeters(48.8566, 2.3522, 43.2965, 5.3698);
      expect(d).toBeGreaterThan(600_000);
      expect(d).toBeLessThan(700_000);
    });

    it('is symmetric (a->b = b->a)', () => {
      const a = haversineMeters(48.8, 2.3, 43.3, 5.4);
      const b = haversineMeters(43.3, 5.4, 48.8, 2.3);
      expect(a).toBeCloseTo(b, 5);
    });
  });

  describe('isValidLatLng', () => {
    it('accepts ordinary coordinates', () => {
      expect(isValidLatLng(48.8566, 2.3522)).toBe(true);
      expect(isValidLatLng(-33.86, 151.21)).toBe(true);
    });

    it('rejects Null Island (0, 0)', () => {
      expect(isValidLatLng(0, 0)).toBe(false);
      expect(isValidLatLng(0.00005, 0.00005)).toBe(false);
    });

    it('rejects out-of-bounds coordinates', () => {
      expect(isValidLatLng(91, 0)).toBe(false);
      expect(isValidLatLng(-91, 0)).toBe(false);
      expect(isValidLatLng(0, 181)).toBe(false);
      expect(isValidLatLng(0, -181)).toBe(false);
    });

    it('rejects NaN / Infinity', () => {
      expect(isValidLatLng(NaN, 0)).toBe(false);
      expect(isValidLatLng(0, Infinity)).toBe(false);
    });
  });

  describe('isPlausibleJump', () => {
    const t0 = new Date('2026-04-26T10:00:00Z');
    const t30s = new Date('2026-04-26T10:00:30Z');

    it('accepts realistic vehicle movement', () => {
      // ~1 km in 30s = 120 km/h
      const ok = isPlausibleJump(
        { lat: 48.8566, lng: 2.3522, timestamp: t0 },
        { lat: 48.866, lng: 2.3522, timestamp: t30s },
      );
      expect(ok).toBe(true);
    });

    it('rejects teleportation (>250 km/h)', () => {
      // Paris -> Marseille in 30s
      const ok = isPlausibleJump(
        { lat: 48.8566, lng: 2.3522, timestamp: t0 },
        { lat: 43.2965, lng: 5.3698, timestamp: t30s },
      );
      expect(ok).toBe(false);
    });

    it('rejects identical timestamps', () => {
      const ok = isPlausibleJump(
        { lat: 48.8566, lng: 2.3522, timestamp: t0 },
        { lat: 48.866, lng: 2.3522, timestamp: t0 },
      );
      expect(ok).toBe(false);
    });

    it('rejects backwards timestamps', () => {
      const ok = isPlausibleJump(
        { lat: 48.8566, lng: 2.3522, timestamp: t30s },
        { lat: 48.866, lng: 2.3522, timestamp: t0 },
      );
      expect(ok).toBe(false);
    });
  });

  describe('sanitizePositions', () => {
    const baseTs = new Date('2026-04-26T10:00:00Z').getTime();
    const at = (deltaSec: number) => new Date(baseTs + deltaSec * 1000);

    it('removes (0,0) Null Island points', () => {
      const out = sanitizePositions([
        { lat: 48.8566, lng: 2.3522, timestamp: at(0) },
        { lat: 0, lng: 0, timestamp: at(30) },
        { lat: 48.857, lng: 2.353, timestamp: at(60) },
      ]);
      expect(out).toHaveLength(2);
      expect(out[0]!.lat).toBeCloseTo(48.8566);
      expect(out[1]!.lat).toBeCloseTo(48.857);
    });

    it('removes teleportation jumps', () => {
      const out = sanitizePositions([
        { lat: 48.8566, lng: 2.3522, timestamp: at(0) },
        { lat: 43.2965, lng: 5.3698, timestamp: at(30) }, // saut Paris -> Marseille
        { lat: 48.857, lng: 2.353, timestamp: at(60) },
      ]);
      expect(out).toHaveLength(2);
      expect(out[1]!.lat).toBeCloseTo(48.857);
    });

    it('removes duplicate / backwards timestamps', () => {
      const out = sanitizePositions([
        { lat: 48.8566, lng: 2.3522, timestamp: at(0) },
        { lat: 48.857, lng: 2.353, timestamp: at(0) }, // meme ts
        { lat: 48.858, lng: 2.354, timestamp: at(-10) }, // remontee dans le temps
        { lat: 48.859, lng: 2.355, timestamp: at(30) },
      ]);
      expect(out).toHaveLength(2);
      expect(out[1]!.timestamp).toEqual(at(30));
    });

    it('keeps a clean trip intact', () => {
      const clean = [
        { lat: 48.8566, lng: 2.3522, timestamp: at(0) },
        { lat: 48.857, lng: 2.353, timestamp: at(30) },
        { lat: 48.858, lng: 2.354, timestamp: at(60) },
        { lat: 48.859, lng: 2.355, timestamp: at(90) },
      ];
      const out = sanitizePositions(clean);
      expect(out).toHaveLength(4);
    });
  });

  describe('douglasPeucker', () => {
    it('returns input unchanged when fewer than 3 points', () => {
      const a = [{ lat: 0.001, lng: 0.001 }];
      const b = [{ lat: 0.001, lng: 0.001 }, { lat: 0.002, lng: 0.002 }];
      expect(douglasPeucker(a)).toEqual(a);
      expect(douglasPeucker(b)).toEqual(b);
    });

    it('removes collinear intermediate points within tolerance', () => {
      const line = [
        { lat: 48.8, lng: 2.3 },
        { lat: 48.8001, lng: 2.3001 },
        { lat: 48.8002, lng: 2.3002 },
        { lat: 48.8003, lng: 2.3003 },
      ];
      const out = douglasPeucker(line, 50);
      expect(out.length).toBe(2);
    });

    it('preserves significant turns', () => {
      // ~ 100m moves
      const path = [
        { lat: 48.8, lng: 2.3 },
        { lat: 48.801, lng: 2.3 },
        { lat: 48.802, lng: 2.301 },
        { lat: 48.802, lng: 2.302 },
      ];
      const out = douglasPeucker(path, 5);
      expect(out.length).toBeGreaterThanOrEqual(3);
    });
  });
});
