/**
 * Tests "golden" derives de VRAIES trames de production (vehicule HD 779 MA,
 * nuit du 2026-06-10/11, extraites de `positions` + `position_sampling_decisions`).
 *
 * Ce que les donnees ont revele : le bug "teleportation / double trace" n'etait
 * PAS du jitter GPS de stationnement, mais DEUX flux de position entrelaces pour
 * le meme vehicule :
 *   - flux REEL : gare a (44.0053, 1.3671) puis vrai trajet ;
 *   - flux FANTOME : positions a 7-21 km (vitesse 0 OU ~135 km/h, ignition t OU f),
 *     rejouees depuis le buffer du boitier (deviceTime hors fenetre live).
 *
 * Extraits bruts (position_sampling_decisions, receivedAt / state / speed / ign / distanceM) :
 *   21:55:02.238  MOVING  135  t  391m     <- reel
 *   21:55:02.241  MOVING    0  f  7387m    <- fantome (meme instant, +3ms)
 *   21:55:07.162  MOVING  132  t  7811m
 *   21:55:08.166  MOVING    0  f  7812m
 *   ... les sauts fantomes grossissent : 7 -> 10 -> 13 -> 17 -> 20 km
 *
 * Ces tests verrouillent : (1) les fantomes sont rejetes, (2) le vrai trajet et
 * le rattrapage post-coupure sont acceptes.
 */
import { isAcceptableLiveFix, maxPlausibleJumpMeters } from './gps-sanity';

describe('gps-sanity — golden (trames reelles prod HD 779 MA)', () => {
  // Position de stationnement reelle (CSV positions, 21:54-22:06).
  const PARK = { lat: 44.0053, lng: 1.3671, speedKmh: 0 };
  const at = (iso: string) => new Date(iso);

  describe('flux FANTOME (replay buffer) — doit etre rejete', () => {
    it('rejette un fantome vitesse 0 a ~7,3 km (le cas dominant des donnees)', () => {
      const prev = { ...PARK, timestamp: at('2026-06-10T21:55:02.238Z') };
      // ~7,3 km plein nord, vitesse 0, ignition f — comme la trame +3ms.
      const phantom = {
        lat: 44.0053 + 7300 / 111_111, lng: 1.3671,
        valid: true, speedKmh: 0, ignition: false,
        timestamp: at('2026-06-10T21:55:05.000Z'),
      };
      expect(isAcceptableLiveFix(phantom, prev)).toBe(false);
    });

    it('rejette un fantome a vitesse elevee (135 km/h) impliquant ~5600 km/h', () => {
      // Variante "meme instant" : meme si le deviceTime est en avant de 5s, le
      // saut de 7,8 km implique une vitesse absurde -> plafond 250 km/h.
      const prev = { ...PARK, timestamp: at('2026-06-10T21:55:07.000Z') };
      const phantom = {
        lat: 44.0053 + 7800 / 111_111, lng: 1.3671,
        valid: true, speedKmh: 135, ignition: true,
        timestamp: at('2026-06-10T21:55:12.000Z'), // +5s -> 7,8 km/5s = 5616 km/h
      };
      expect(isAcceptableLiveFix(phantom, prev)).toBe(false);
    });

    it('rejette une trame REJOUEE (deviceTime anterieur a la derniere verite)', () => {
      // Cause racine : le buffer rejoue un ancien trajet -> deviceTime dans le passe.
      const prev = { ...PARK, timestamp: at('2026-06-10T21:55:00.000Z') };
      const replay = {
        lat: 44.07, lng: 1.42, // loin (ancien trajet)
        valid: true, speedKmh: 132, ignition: true,
        timestamp: at('2026-06-10T19:30:00.000Z'), // dt < 0
      };
      expect(isAcceptableLiveFix(replay, prev)).toBe(false);
    });

    it('flux entrelaces : l\'ancre reste sur le flux REEL, les fantomes degagent', () => {
      // Mini-reducer reproduisant la logique d'ancrage de map.component
      // (hors resync) : on n'avance l'ancre que sur trame acceptee.
      let anchor: { lat: number; lng: number; timestamp: Date; speedKmh: number } = {
        ...PARK, timestamp: at('2026-06-10T21:55:00.000Z'),
      };
      const accepted: string[] = [];

      // Sequence reelle simplifiee : reel(gare) puis fantomes (replay, deviceTime passe)
      // intercales avec d'autres trames reelles "gare".
      const frames = [
        { tag: 'real-1',    lat: 44.00531, lng: 1.36710, speedKmh: 0, ignition: true,  ts: '2026-06-10T21:55:11Z' },
        { tag: 'phantom-1', lat: 44.0700,  lng: 1.36710, speedKmh: 0, ignition: false, ts: '2026-06-10T19:30:11Z' },
        { tag: 'real-2',    lat: 44.00531, lng: 1.36709, speedKmh: 0, ignition: true,  ts: '2026-06-10T21:55:31Z' },
        { tag: 'phantom-2', lat: 44.0800,  lng: 1.36710, speedKmh: 0, ignition: false, ts: '2026-06-10T19:30:31Z' },
        { tag: 'real-3',    lat: 44.00531, lng: 1.36709, speedKmh: 0, ignition: true,  ts: '2026-06-10T21:55:51Z' },
      ];

      for (const f of frames) {
        const ok = isAcceptableLiveFix(
          { lat: f.lat, lng: f.lng, valid: true, speedKmh: f.speedKmh, ignition: f.ignition, timestamp: at(f.ts) },
          anchor,
        );
        if (ok) {
          accepted.push(f.tag);
          anchor = { lat: f.lat, lng: f.lng, timestamp: at(f.ts), speedKmh: f.speedKmh };
        }
      }

      expect(accepted).toEqual(['real-1', 'real-2', 'real-3']);
      // L'ancre finale est bien le vrai stationnement, pas le fantome a 7+ km.
      expect(anchor.lat).toBeCloseTo(44.00531, 4);
    });
  });

  describe('flux REEL — doit etre accepte', () => {
    it('accepte une sequence autoroute normale (292 m en 20 s)', () => {
      const p1 = { lat: 44.00054, lng: 1.37339, speedKmh: 22, timestamp: at('2026-06-10T22:13:51Z') };
      const p2 = {
        lat: 44.00203, lng: 1.37638,
        valid: true, speedKmh: 102, ignition: true,
        timestamp: at('2026-06-10T22:14:11Z'),
      };
      expect(isAcceptableLiveFix(p2, p1)).toBe(true);
    });

    it('accepte le RATTRAPAGE apres coupure reseau (1,87 km en 106 s, vitesse rapportee basse)', () => {
      // Gap reel 22:16:11 -> 22:17:57. La trame de rattrapage affiche 11 km/h
      // alors que la precedente roulait a 80 -> sans prevSpeedKmh on rejetterait.
      const beforeGap = { lat: 44.00225, lng: 1.40135, speedKmh: 80, timestamp: at('2026-06-10T22:16:11Z') };
      const afterGap = {
        lat: 43.99457, lng: 1.42218,
        valid: true, speedKmh: 11, ignition: true,
        timestamp: at('2026-06-10T22:17:57Z'),
      };
      expect(isAcceptableLiveFix(afterGap, beforeGap)).toBe(true);
    });

    it('le rattrapage post-coupure SERAIT rejete sans la vitesse precedente (justifie prevSpeedKmh)', () => {
      // Demonstration : meme saut, mais en ne fournissant que la vitesse basse
      // de la trame courante -> la borne s'effondre et rejette a tort.
      const dtSec = 106;
      const jumpM = 1870;
      const withPrev = maxPlausibleJumpMeters({ dtSec, speedKmh: 11, prevSpeedKmh: 80 });
      const withoutPrev = maxPlausibleJumpMeters({ dtSec, speedKmh: 11 });
      expect(jumpM).toBeLessThan(withPrev);     // accepte avec la vitesse precedente
      expect(jumpM).toBeGreaterThan(withoutPrev); // aurait ete rejete sans
    });
  });
});
