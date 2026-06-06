import { routeAnimationState, wrapPhase, type RouteSegment } from './route-animation';

describe('route-animation', () => {
  // 2 segments : aller vers l'est (0->10) puis retour vers l'ouest (10->0).
  const segments: RouteSegment[] = [
    { a: { lat: 0, lng: 0 }, b: { lat: 0, lng: 10 } },
    { a: { lat: 0, lng: 10 }, b: { lat: 0, lng: 0 } },
  ];

  describe('wrapPhase', () => {
    it('wrappe une phase négative dans [0,1)', () => {
      expect(wrapPhase(-0.3)).toBeCloseTo(0.7, 6);
    });
    it('wrappe une phase > 1 dans [0,1)', () => {
      expect(wrapPhase(2.25)).toBeCloseTo(0.25, 6);
    });
    it('renvoie 0 pour une valeur non finie', () => {
      expect(wrapPhase(NaN)).toBe(0);
      expect(wrapPhase(Infinity)).toBe(0);
    });
  });

  describe('routeAnimationState', () => {
    it('retourne null pour une liste de segments vide', () => {
      expect(routeAnimationState([], 0)).toBeNull();
    });

    it('phase 0 = début du premier segment, orienté est', () => {
      const s = routeAnimationState(segments, 0)!;
      expect(s).not.toBeNull();
      expect(s.lat).toBeCloseTo(0, 6);
      expect(s.lng).toBeCloseTo(0, 6);
      expect(s.facingRight).toBeTrue();
    });

    it('interpole au milieu d\'un segment', () => {
      // phase 0.25 -> segIdx 0, localT 0.5 -> eased 0.5 -> lng 5.
      const s = routeAnimationState(segments, 0.25)!;
      expect(s.lng).toBeCloseTo(5, 6);
    });

    it('passe au 2e segment (retour ouest)', () => {
      const s = routeAnimationState(segments, 0.5)!;
      expect(s.lng).toBeCloseTo(10, 6);
      expect(s.facingRight).toBeFalse();
    });

    it('RÉGRESSION : une phase négative (now < start) ne crashe pas et reste valide', () => {
      // Avant le fix : segIdx = -1 -> segments[-1] undefined -> crash de déstructuration.
      const s = routeAnimationState(segments, -0.0001);
      expect(s).not.toBeNull();
      expect(Number.isFinite(s!.lat)).toBeTrue();
      expect(Number.isFinite(s!.lng)).toBeTrue();
    });

    it('une phase > 1 (overflow) wrappe proprement', () => {
      const a = routeAnimationState(segments, 1.25)!;
      const b = routeAnimationState(segments, 0.25)!;
      expect(a.lng).toBeCloseTo(b.lng, 6);
    });
  });
});
