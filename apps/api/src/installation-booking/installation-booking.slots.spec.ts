import { generateAvailability, parisParts, parisWallClockToUtc, type SlotConfig } from './installation-booking.slots';

const CONFIG: SlotConfig = {
  slotMinutes: 120,
  dayStartMinutes: 480, // 08:00
  dayEndMinutes: 1260, // 21:00
  workingDays: [1, 2, 3, 4, 5, 6, 7],
  horizonDays: 4,
  leadHours: 0,
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

  it('respecte le délai minimum (leadHours) — les créneaux trop proches sont retirés', () => {
    // now = mi-journée ; avec 48h de délai, aujourd'hui et demain sautent.
    const now = new Date('2026-07-06T10:00:00Z');
    const days = generateAvailability({ ...CONFIG, leadHours: 48 }, now, []);
    const earliest = Math.min(...days.flatMap((d) => d.slots.map((s) => s.startAt.getTime())));
    expect(earliest).toBeGreaterThanOrEqual(now.getTime() + 48 * 3_600_000);
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
});
