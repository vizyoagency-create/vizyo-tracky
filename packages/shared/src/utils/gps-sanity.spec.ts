import {
  douglasPeucker,
  evaluateIngestionFix,
  MAX_DEVICE_CLOCK_AHEAD_MS,
  haversineMeters,
  isAcceptableLiveFix,
  isPlausibleJump,
  isValidLatLng,
  maxPlausibleJumpMeters,
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

  describe('evaluateIngestionFix', () => {
    /**
     * HORLOGE BOITIER DANS LE FUTUR (critere 0).
     *
     * Le degat n'est pas la trame elle-meme : c'est qu'elle DEVIENT la baseline
     * (`Tracker.lastValidFrameAt`). Toutes les trames REELLES qui suivent sont alors
     * « anterieures » a un futur qui n'existe pas encore et tombent en 'stale_devicetime'.
     * Un seul paquet date de 2035 suffisait a faire disparaitre un vehicule des positions,
     * des trajets et des rapports — durablement.
     */
    describe('horloge boitier en avance', () => {
      const NOW = new Date('2026-06-11T01:00:00Z').getTime();

      it('REJETTE une trame nettement dans le futur, meme SANS baseline', () => {
        // Le tracker neuf (ou remis a zero) est justement le plus vulnerable :
        // sans reference, la trame folle s'installerait comme verite.
        const v = evaluateIngestionFix(
          { lat: 33.5, lng: -7.5, deviceTime: NOW + 7 * 24 * 3600 * 1000 },
          undefined,
          { now: NOW },
        );
        expect(v.authoritative).toBe(false);
        expect(v.reason).toBe('future_devicetime');
      });

      it('TOLERE un decalage de fuseau mal interprete (2 h) — sinon on blackhole un parc entier', () => {
        const v = evaluateIngestionFix(
          { lat: 33.5, lng: -7.5, deviceTime: NOW + 2 * 3600 * 1000 },
          undefined,
          { now: NOW },
        );
        expect(v.authoritative).toBe(true);
      });

      it('frontiere du seuil de tolerance', () => {
        const dansLaTolerance = evaluateIngestionFix(
          { lat: 33.5, lng: -7.5, deviceTime: NOW + MAX_DEVICE_CLOCK_AHEAD_MS },
          undefined,
          { now: NOW },
        );
        expect(dansLaTolerance.authoritative).toBe(true);
        const auDela = evaluateIngestionFix(
          { lat: 33.5, lng: -7.5, deviceTime: NOW + MAX_DEVICE_CLOCK_AHEAD_MS + 1 },
          undefined,
          { now: NOW },
        );
        expect(auDela.authoritative).toBe(false);
        expect(auDela.reason).toBe('future_devicetime');
      });

      it('tolerance surchargeable par l appelant', () => {
        const v = evaluateIngestionFix(
          { lat: 33.5, lng: -7.5, deviceTime: NOW + 30 * 60 * 1000 },
          undefined,
          { now: NOW, maxAheadMs: 10 * 60 * 1000 },
        );
        expect(v.reason).toBe('future_devicetime');
      });

      /**
       * AUTO-REPARATION : un tracker dont la baseline est DEJA datee du futur (trame passee
       * avant l'existence du critere 0) doit pouvoir s'en sortir. Sans cette branche, ses
       * trames reelles resteraient rejetees jusqu'a ce que l'horloge murale rattrape —
       * des annees pour une date de 2035.
       */
      it('REPARE une baseline deja empoisonnee : une seule trame saine suffit', () => {
        const v = evaluateIngestionFix(
          { lat: 33.5, lng: -7.5, deviceTime: NOW },
          { lat: 33.4, lng: -7.4, deviceTime: NOW + 365 * 24 * 3600 * 1000 },
          { now: NOW },
        );
        expect(v.authoritative).toBe(true);
        expect(v.reason).toBeNull();
      });

      it('une baseline SAINE garde toute sa force de rejet (pas d effet de bord)', () => {
        // La reparation ne doit pas devenir une porte derobee : face a une baseline
        // normale, le critere « non strictement croissant » s applique comme avant.
        const v = evaluateIngestionFix(
          { lat: 33.5, lng: -7.5, deviceTime: NOW - 30_000 },
          { lat: 33.4, lng: -7.4, deviceTime: NOW },
          { now: NOW },
        );
        expect(v.authoritative).toBe(false);
        expect(v.reason).toBe('stale_devicetime');
      });

      it('une date illisible garde le comportement d avant (arbitree par les criteres suivants)', () => {
        const v = evaluateIngestionFix(
          { lat: 33.5, lng: -7.5, deviceTime: 'pas-une-date' },
          { lat: 33.4, lng: -7.4, deviceTime: NOW },
          { now: NOW },
        );
        expect(v.reason).not.toBe('future_devicetime');
      });
    });

    const t0 = new Date('2026-06-11T01:00:00Z');
    const tPast = new Date('2026-06-11T00:59:30Z'); // 30s AVANT t0
    const tFwd30 = new Date('2026-06-11T01:00:30Z'); // 30s APRES t0

    it('accepts the first ever fix (no prev reference) — establishes baseline', () => {
      const v = evaluateIngestionFix({ lat: 33.5, lng: -7.5, deviceTime: t0 });
      expect(v.authoritative).toBe(true);
      expect(v.reason).toBeNull();
    });

    it('accepts when prev has no deviceTime (tracker jamais vu valide)', () => {
      const v = evaluateIngestionFix(
        { lat: 33.5, lng: -7.5, deviceTime: t0 },
        { lat: 33.4, lng: -7.4, deviceTime: null },
      );
      expect(v.authoritative).toBe(true);
    });

    it('REJECTS a replayed frame (deviceTime anterieur — flux fantome buffer boitier)', () => {
      // Cause racine prod (HD-779-MA) : meme IMEI, deviceTime dans le passe,
      // position a ~10 km. C'est la trame qui polluait `positions`.
      const v = evaluateIngestionFix(
        { lat: 33.45, lng: -7.4, deviceTime: tPast },
        { lat: 33.5, lng: -7.5, deviceTime: t0 },
      );
      expect(v.authoritative).toBe(false);
      expect(v.reason).toBe('stale_devicetime');
    });

    it('REJECTS an exactly-equal deviceTime (retransmission / doublon)', () => {
      const v = evaluateIngestionFix(
        { lat: 33.5001, lng: -7.5001, deviceTime: t0 },
        { lat: 33.5, lng: -7.5, deviceTime: t0 },
      );
      expect(v.authoritative).toBe(false);
      expect(v.reason).toBe('stale_devicetime');
    });

    it('REJECTS a forward-time teleport (saut infaisable au dt reel, ~1200 km/h)', () => {
      // deviceTime en avant mais ~10 km en 30s : ni replay ni mouvement reel.
      const v = evaluateIngestionFix(
        { lat: 33.59, lng: -7.5, deviceTime: tFwd30 },
        { lat: 33.5, lng: -7.5, deviceTime: t0 },
      );
      expect(v.authoritative).toBe(false);
      expect(v.reason).toBe('implausible_jump');
    });

    it('accepts a normal forward move (~555m en 30s = 66 km/h)', () => {
      const v = evaluateIngestionFix(
        { lat: 33.505, lng: -7.5, deviceTime: tFwd30 },
        { lat: 33.5, lng: -7.5, deviceTime: t0 },
      );
      expect(v.authoritative).toBe(true);
      expect(v.reason).toBeNull();
    });

    it('accepts a large gap at a plausible average speed (post-GPRS / deplace hors-ligne)', () => {
      // ~60 km en 1h = 60 km/h : LEGITIME. La version dt-bornee
      // (maxPlausibleJumpMeters, cap 60s) rejetterait a tort ce rattrapage ;
      // isPlausibleJump avec le dt PLEIN l'accepte → aucune position reelle perdue.
      const v = evaluateIngestionFix(
        { lat: 34.04, lng: -7.5, deviceTime: new Date('2026-06-11T02:00:00Z') },
        { lat: 33.5, lng: -7.5, deviceTime: t0 },
      );
      expect(v.authoritative).toBe(true);
    });
  });

  describe('isAcceptableLiveFix', () => {
    const t0 = new Date('2026-04-26T10:00:00Z');
    const t30s = new Date('2026-04-26T10:00:30Z');

    it('accepts a fresh valid fix without prev', () => {
      expect(
        isAcceptableLiveFix({ lat: 48.8566, lng: 2.3522, valid: true, timestamp: t0 }),
      ).toBe(true);
    });

    it('accepts a fix where `valid` is omitted (legacy / non-WS callers)', () => {
      expect(isAcceptableLiveFix({ lat: 48.8566, lng: 2.3522, timestamp: t0 })).toBe(true);
    });

    it('rejects a fix with valid:false (backend signals degraded GPS)', () => {
      expect(
        isAcceptableLiveFix({ lat: 48.8566, lng: 2.3522, valid: false, timestamp: t0 }),
      ).toBe(false);
    });

    it('rejects Null Island even when valid:true', () => {
      expect(
        isAcceptableLiveFix({ lat: 0, lng: 0, valid: true, timestamp: t0 }),
      ).toBe(false);
    });

    it('rejects out-of-bounds coordinates', () => {
      expect(
        isAcceptableLiveFix({ lat: 91, lng: 2.3522, valid: true, timestamp: t0 }),
      ).toBe(false);
    });

    it('accepts realistic movement from a previous truth', () => {
      const prev = { lat: 48.8566, lng: 2.3522, timestamp: t0 };
      const next = { lat: 48.866, lng: 2.3522, valid: true, timestamp: t30s };
      expect(isAcceptableLiveFix(next, prev)).toBe(true);
    });

    it('rejects a teleportation jump from previous truth (>250 km/h)', () => {
      const prev = { lat: 48.8566, lng: 2.3522, timestamp: t0 };
      const next = { lat: 43.2965, lng: 5.3698, valid: true, timestamp: t30s };
      expect(isAcceptableLiveFix(next, prev)).toBe(false);
    });

    it('skips jump check when prev is null', () => {
      expect(
        isAcceptableLiveFix(
          { lat: 43.2965, lng: 5.3698, valid: true, timestamp: t30s },
          null,
        ),
      ).toBe(true);
    });

    it('skips jump check when next has no timestamp', () => {
      // Cas du dashboard : on filtre juste valid:false + bornes, sans prev/timestamp.
      const prev = { lat: 48.8566, lng: 2.3522, timestamp: t0 };
      expect(
        isAcceptableLiveFix({ lat: 43.2965, lng: 5.3698, valid: true }, prev),
      ).toBe(true);
    });
  });

  describe('maxPlausibleJumpMeters', () => {
    it('engine off → only GPS jitter tolerated (~150m), independent of dt', () => {
      // Vehicule gare la nuit : trame STOPPED toutes les 300s. Le moteur coupe
      // garantit qu'aucun deplacement reel n'est possible.
      expect(maxPlausibleJumpMeters({ dtSec: 300, ignition: false })).toBeCloseTo(150, 0);
      expect(maxPlausibleJumpMeters({ dtSec: 20, ignition: false })).toBeCloseTo(150, 0);
    });

    it('caps dt so a long silence does not blow up the tolerance', () => {
      // Sans cap : 250 km/h x 300s ~= 20833m (le bug). Avec cap 60s ~= 4167m.
      const m = maxPlausibleJumpMeters({ dtSec: 300 });
      expect(m).toBeGreaterThan(4000);
      expect(m).toBeLessThan(4200);
    });

    it('moving at 20s allows a normal frame but not a kilometric jump', () => {
      // 50 km/h rapporte, 20s : plancher 150 + 13.9*20*2 ~= 706m.
      const m = maxPlausibleJumpMeters({ dtSec: 20, speedKmh: 50, ignition: true });
      expect(m).toBeGreaterThan(600);
      expect(m).toBeLessThan(800);
    });

    it('reported speed ~0 contradicts a large jump (urban multipath outlier)', () => {
      // Vitesse 0 rapportee → cap ~= plancher 150m meme moteur tournant.
      expect(maxPlausibleJumpMeters({ dtSec: 20, speedKmh: 0, ignition: true })).toBeCloseTo(150, 0);
    });

    it('returns the most restrictive of all applicable bounds', () => {
      // ignition off (150) gagne sur la borne vitesse 90 km/h (1150m).
      expect(maxPlausibleJumpMeters({ dtSec: 20, speedKmh: 90, ignition: false })).toBeCloseTo(150, 0);
    });
  });

  // Scenarios reproduisant les DONNEES DE PROD (boitier Coban / VPS), pas le
  // seed local : c'est ici qu'on verrouille le comportement reel.
  describe('isAcceptableLiveFix — scenarios prod (Coban / VPS)', () => {
    const base = new Date('2026-06-11T00:30:00Z').getTime(); // ~00:34, vehicule gare
    const at = (sec: number) => new Date(base + sec * 1000);

    it('REJECTS the night-parked teleport from the screenshots (engine off, dt 300s, ~3.8km outlier)', () => {
      const prev = { lat: 48.8566, lng: 2.3522, timestamp: at(0) };
      const next = {
        lat: 48.8835, lng: 2.385, // ~3.8 km plus loin
        valid: true, ignition: false, speedKmh: 0,
        timestamp: at(300),
      };
      expect(isAcceptableLiveFix(next, prev)).toBe(false);
    });

    it('dt-cap alone is NOT enough — the ignition/speed signal is what kills the outlier', () => {
      // Sans ignition ni speed (signaux absents), dt borne a 60s tolere ~4.2km :
      // un saut de 3.8km passerait encore. Documente pourquoi on a besoin des
      // signaux physiques de la trame.
      const prev = { lat: 48.8566, lng: 2.3522, timestamp: at(0) };
      const next = { lat: 48.8835, lng: 2.385, valid: true, timestamp: at(300) };
      expect(isAcceptableLiveFix(next, prev)).toBe(true);
    });

    it('accepts a real moving frame (50 km/h, 20s, ~278m, engine on)', () => {
      const prev = { lat: 48.8566, lng: 2.3522, timestamp: at(0) };
      const next = {
        lat: 48.8591, lng: 2.3522, // ~278m
        valid: true, ignition: true, speedKmh: 50,
        timestamp: at(20),
      };
      expect(isAcceptableLiveFix(next, prev)).toBe(true);
    });

    it('rejects a parked GPS spike even engine ON when reported speed is ~0', () => {
      const prev = { lat: 48.8566, lng: 2.3522, timestamp: at(0) };
      const next = {
        lat: 48.87, lng: 2.3522, // ~1.5 km
        valid: true, ignition: true, speedKmh: 0,
        timestamp: at(20),
      };
      expect(isAcceptableLiveFix(next, prev)).toBe(false);
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
