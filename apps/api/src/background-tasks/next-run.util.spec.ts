import { getNowInTimezone } from '../vehicle-schedules/schedule-evaluator';
import { nextFireInstant, nextPeriodicTick, previousFireInstant, previousPeriodicTick } from './next-run.util';

/**
 * ── LE DERNIER DÉCLENCHEMENT ATTENDU (PS du chantier C3, 2026-09-05) ─────────────────────
 *
 * La sentinelle des agents du poste demande « quand cet agent AURAIT DÛ tourner ? ». La réponse
 * doit être le miroir exact du « prochain lancement » que l'écran affiche, et en heure de PARIS :
 * ce serveur tourne en UTC, le poste en heure de Paris, et l'écran a déjà annoncé un jour un
 * passage « à 14:00 » deux heures après le passage réel (voir le catalogue).
 */
const HEURE = 3_600_000;
const PARIS = 'Europe/Paris';

/** Instant UTC d'une heure murale de Paris, sans coder le décalage été/hiver en dur. */
function paris(annee: number, mois: number, jour: number, heure: number, minute = 0): number {
  for (const decalage of [2, 1]) {
    const t = Date.UTC(annee, mois - 1, jour, heure - decalage, minute);
    const w = getNowInTimezone(PARIS, new Date(t));
    if (
      w.getFullYear() === annee && w.getMonth() === mois - 1 && w.getDate() === jour &&
      w.getHours() === heure && w.getMinutes() === minute
    ) return t;
  }
  throw new Error(`heure de Paris introuvable : ${annee}-${mois}-${jour} ${heure}:${minute}`);
}

/** L'agent de récits : 03:15 chaque nuit. */
const recit = (w: Date) => w.getHours() === 3 && w.getMinutes() === 15;

describe('previousFireInstant — le dernier créneau d’une heure fixe', () => {
  it('⚠️ rend le 03:15 de PARIS, et non celui du serveur en UTC — deux heures d’écart en été', () => {
    const now = paris(2026, 9, 5, 5, 30);
    const enParis = previousFireInstant(recit, now, PARIS);
    const enUtc = previousFireInstant(recit, now, 'UTC');

    expect(enParis?.getTime()).toBe(paris(2026, 9, 5, 3, 15));
    expect(enUtc?.getTime()).toBe(Date.UTC(2026, 8, 5, 3, 15));
    // Le même matcher, lu dans le mauvais fuseau, attend l'agent deux heures trop tard : à 05:30
    // Paris, la version UTC dirait « créneau de 05:15, encore dans la grâce » — et se tairait.
    expect(enUtc!.getTime() - enParis!.getTime()).toBe(2 * HEURE);
  });

  it('avant le créneau du jour, c’est celui de la VEILLE', () => {
    const now = paris(2026, 9, 5, 2, 0);
    expect(previousFireInstant(recit, now, PARIS)?.getTime()).toBe(paris(2026, 9, 4, 3, 15));
  });

  it('à la minute même du créneau, le créneau est déjà « attendu » (borne incluse), aligné à la seconde 0', () => {
    const now = paris(2026, 9, 5, 3, 15) + 20_500; // 03:15:20.500
    expect(previousFireInstant(recit, now, PARIS)?.getTime()).toBe(paris(2026, 9, 5, 3, 15));
  });

  it('miroir de nextFireInstant : précédent ≤ maintenant < suivant, et 24 h entre les deux', () => {
    const now = paris(2026, 9, 5, 5, 30);
    const precedent = previousFireInstant(recit, now, PARIS)!;
    const suivant = nextFireInstant(recit, now, PARIS, now)!;
    expect(precedent.getTime()).toBeLessThanOrEqual(now);
    expect(suivant.getTime()).toBeGreaterThan(now);
    expect(suivant.getTime() - precedent.getTime()).toBe(24 * HEURE);
  });

  it('plusieurs créneaux par jour : le plus récent gagne (limites de vitesse, 04:30 puis 08:30)', () => {
    const limites = (w: Date) =>
      (w.getHours() === 4 && w.getMinutes() === 30) || (w.getHours() === 8 && w.getMinutes() === 30);
    expect(previousFireInstant(limites, paris(2026, 9, 5, 9, 50), PARIS)?.getTime()).toBe(paris(2026, 9, 5, 8, 30));
    expect(previousFireInstant(limites, paris(2026, 9, 5, 6, 50), PARIS)?.getTime()).toBe(paris(2026, 9, 5, 4, 30));
  });

  it('aucune occurrence dans l’horizon → null, jamais un instant inventé', () => {
    expect(previousFireInstant(() => false, paris(2026, 9, 5, 5, 30), PARIS)).toBeNull();
  });
});

describe('previousPeriodicTick — le dernier tick aligné sur l’époque', () => {
  it('rattrapage des récits : heures PAIRES de Paris, dernier tick ≤ maintenant', () => {
    const now = paris(2026, 9, 5, 5, 30);
    // 04:00 Paris = 02:00 UTC : heure epoch paire, d'où l'offset 0 du catalogue.
    expect(previousPeriodicTick(2 * HEURE, 0, now).getTime()).toBe(paris(2026, 9, 5, 4, 0));
  });

  it('miroir de nextPeriodicTick : précédent ≤ maintenant < suivant, séparés d’exactement une période', () => {
    const now = paris(2026, 9, 5, 5, 30);
    const precedent = previousPeriodicTick(2 * HEURE, 0, now);
    const suivant = nextPeriodicTick(2 * HEURE, 0, now);
    expect(precedent.getTime()).toBeLessThanOrEqual(now);
    expect(suivant.getTime()).toBeGreaterThan(now);
    expect(suivant.getTime() - precedent.getTime()).toBe(2 * HEURE);
  });

  it('pile sur un tick, le tick courant est le précédent (borne incluse) — et le décalage est respecté', () => {
    const tick = 10 * 600_000 + 45_000; // toutes les 10 min à :45 s
    expect(previousPeriodicTick(600_000, 45_000, tick).getTime()).toBe(tick);
    expect(previousPeriodicTick(600_000, 45_000, tick + 1).getTime()).toBe(tick);
    expect(previousPeriodicTick(600_000, 45_000, tick - 1).getTime()).toBe(tick - 600_000);
  });
});
