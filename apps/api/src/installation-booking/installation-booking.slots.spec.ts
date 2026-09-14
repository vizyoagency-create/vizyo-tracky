import {
  generateAvailability, parisParts, parisWallClockToUtc, windowFor, type SlotConfig,
} from './installation-booking.slots';

const CONFIG: SlotConfig = {
  slotMinutes: 120,
  dayStartMinutes: 480, // 08:00
  dayEndMinutes: 1260, // 21:00
  workingDays: [1, 2, 3, 4, 5, 6, 7],
  horizonDays: 4,
  leadDays: 1,
};

describe('installation-booking slots — fuseau Europe/Paris', () => {
  it('convertit une heure-murale Paris en UTC en tenant compte du DST', () => {
    // Été (CEST, +2) : 08:00 Paris = 06:00 UTC.
    expect(parisWallClockToUtc(2026, 7, 7, 8, 0).toISOString()).toBe('2026-07-07T06:00:00.000Z');
    // Hiver (CET, +1) : 08:00 Paris = 07:00 UTC.
    expect(parisWallClockToUtc(2026, 1, 7, 8, 0).toISOString()).toBe('2026-01-07T07:00:00.000Z');
  });

  it('génère une grille de créneaux 2h de 08:00 à 20:00 (6 créneaux/jour)', () => {
    const now = new Date('2026-07-05T00:00:00Z');
    const days = generateAvailability(CONFIG, now, []);
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) {
      const hours = day.slots.map((s) => parisParts(new Date(s.startAt)).hour);
      expect(hours).toEqual([8, 10, 12, 14, 16, 18]);
      // Chaque créneau dure bien 2h.
      for (const s of day.slots) {
        expect(new Date(s.endAt).getTime() - new Date(s.startAt).getTime()).toBe(120 * 60_000);
      }
    }
  });

  it('exclut un créneau occupé (chevauchement)', () => {
    const now = new Date('2026-07-05T00:00:00Z');
    const first = generateAvailability(CONFIG, now, [])[0].slots[0];
    const busy = [{ startMs: first.startAt.getTime(), endMs: first.endAt.getTime() }];
    const day0 = generateAvailability(CONFIG, now, busy)[0];
    expect(day0.slots.some((s) => s.startAt.getTime() === first.startAt.getTime())).toBe(false);
    expect(day0.slots.length).toBe(5); // 6 - 1
  });

  /**
   * JAMAIS LE JOUR MÊME — décision du propriétaire du 2026-09-14. Le premier jour proposé est
   * J+1, tout entier, quelle que soit l'heure ; un délai en heures n'existe plus.
   */
  it('ne propose jamais le jour même — même à 00:01 (Paris)', () => {
    // 22:01 UTC le 6 juillet = 00:01 Paris le 7 juillet : « aujourd'hui » est le 7.
    const days = generateAvailability(CONFIG, new Date('2026-07-06T22:01:00Z'), []);
    expect(days[0].date).toBe('2026-07-08');
  });

  it('à 23:59 Paris, le lendemain reste proposé EN ENTIER — le matin compris', () => {
    // 21:59 UTC le 7 juillet = 23:59 Paris le 7 : demain est le 8, dès 08:00.
    const days = generateAvailability(CONFIG, new Date('2026-07-07T21:59:00Z'), []);
    expect(days[0].date).toBe('2026-07-08');
    expect(days[0].slots.map((s) => parisParts(s.startAt).hour)).toEqual([8, 10, 12, 14, 16, 18]);
  });

  it('leadDays 3 → à partir de J+3 ; leadDays 0 ou absent → borné à J+1', () => {
    const now = new Date('2026-07-06T10:00:00Z'); // lundi 6 juillet, 12:00 Paris
    expect(generateAvailability({ ...CONFIG, leadDays: 3 }, now, [])[0].date).toBe('2026-07-09');
    expect(generateAvailability({ ...CONFIG, leadDays: 0 }, now, [])[0].date).toBe('2026-07-07');
  });

  it('J+1 qui tombe un dimanche décoché glisse au lundi ; coché, le dimanche est proposé', () => {
    const samedi = new Date('2026-07-11T10:00:00Z'); // samedi 11 juillet
    expect(generateAvailability({ ...CONFIG, workingDays: [1, 2, 3, 4, 5, 6], horizonDays: 7 }, samedi, [])[0].date).toBe('2026-07-13');
    expect(generateAvailability({ ...CONFIG, workingDays: [1, 2, 3, 4, 5, 6, 7], horizonDays: 7 }, samedi, [])[0].date).toBe('2026-07-12');
  });

  it('ne propose que les jours ouvrés configurés', () => {
    const now = new Date('2026-07-05T00:00:00Z');
    const days = generateAvailability({ ...CONFIG, workingDays: [3] }, now, []); // mercredi seulement
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) {
      // midi du jour pour lire un weekday stable
      expect(parisParts(new Date(`${day.date}T12:00:00Z`)).isoWeekday).toBe(3);
    }
  });

  it('grille vide si la fenêtre journalière est plus courte qu\'un créneau', () => {
    expect(generateAvailability({ ...CONFIG, dayStartMinutes: 480, dayEndMinutes: 540 }, new Date('2026-07-05T00:00:00Z'), [])).toEqual([]);
  });

  it('signale les jours de week-end (le client sait qu’il réserve un samedi)', () => {
    // Vendredi 3 juillet : J+1 = samedi 4, J+2 = dimanche 5.
    const days = generateAvailability(CONFIG, new Date('2026-07-03T00:00:00Z'), []);
    for (const day of days) {
      const iso = parisParts(new Date(`${day.date}T12:00:00Z`)).isoWeekday;
      expect(day.weekend).toBe(iso === 6 || iso === 7);
    }
    expect(days.some((d) => d.weekend)).toBe(true);
  });
});

/**
 * LA FENÊTRE DU WEEK-END. Un samedi d'installateur est une matinée : sans fenêtre propre,
 * cocher le samedi promettait des créneaux de 08:00 à 21:00 que personne ne viendrait honorer.
 */
describe('installation-booking slots — horaires du week-end', () => {
  // Vendredi 3 juillet 2026 (02:00 Paris) ; jamais le jour même, donc J+1 → J+4 = sam. 4 → mar. 7.
  const now = new Date('2026-07-03T00:00:00Z');
  const isoOf = (date: string) => parisParts(new Date(`${date}T12:00:00Z`)).isoWeekday;

  it('sans fenêtre week-end, RIEN NE BOUGE : samedi et dimanche suivent la semaine', () => {
    const sans = generateAvailability(CONFIG, now, []);
    const nulls = generateAvailability({ ...CONFIG, weekendStartMinutes: null, weekendEndMinutes: null }, now, []);
    expect(nulls).toEqual(sans);
    const dimanche = sans.find((d) => isoOf(d.date) === 7)!;
    expect(dimanche.slots.map((s) => parisParts(s.startAt).hour)).toEqual([8, 10, 12, 14, 16, 18]);
  });

  it('avec une fenêtre week-end 09:00–13:00, le dimanche n’offre que la matinée et la semaine reste entière', () => {
    const days = generateAvailability({ ...CONFIG, weekendStartMinutes: 540, weekendEndMinutes: 780 }, now, []);
    const dimanche = days.find((d) => isoOf(d.date) === 7)!;
    expect(dimanche.weekend).toBe(true);
    expect(dimanche.slots.map((s) => parisParts(s.startAt).hour)).toEqual([9, 11]);
    const lundi = days.find((d) => isoOf(d.date) === 1)!;
    expect(lundi.weekend).toBe(false);
    expect(lundi.slots.map((s) => parisParts(s.startAt).hour)).toEqual([8, 10, 12, 14, 16, 18]);
  });

  it('la fenêtre week-end ne s’applique QUE si le jour est ouvré — décocher le dimanche reste décisif', () => {
    const days = generateAvailability(
      { ...CONFIG, workingDays: [1, 2, 3, 4, 5, 6], weekendStartMinutes: 540, weekendEndMinutes: 780 }, now, [],
    );
    expect(days.some((d) => isoOf(d.date) === 7)).toBe(false);
  });

  it('une fenêtre week-end trop courte pour un créneau retire le week-end SANS toucher la semaine', () => {
    const days = generateAvailability({ ...CONFIG, weekendStartMinutes: 540, weekendEndMinutes: 600 }, now, []);
    expect(days.some((d) => d.weekend)).toBe(false);
    expect(days.some((d) => !d.weekend)).toBe(true);
  });

  it('windowFor — la semaine pour lun.–ven., le week-end pour sam.–dim. quand elle existe', () => {
    const cfg = { ...CONFIG, weekendStartMinutes: 540, weekendEndMinutes: 780 };
    expect(windowFor(cfg, 3)).toEqual({ start: 480, end: 1260 });
    expect(windowFor(cfg, 6)).toEqual({ start: 540, end: 780 });
    expect(windowFor(CONFIG, 6)).toEqual({ start: 480, end: 1260 });
  });
});
