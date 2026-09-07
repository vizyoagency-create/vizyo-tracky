import { instantLocal } from './heure-locale';

describe('instantLocal — jour de semaine et seconde du jour en heure de Paris', () => {
  it("l'été (UTC+2) : 06:14:30Z un mardi = 08:14:30 à Paris", () => {
    // 2026-09-08 est un mardi.
    expect(instantLocal(new Date('2026-09-08T06:14:30Z'))).toEqual({
      dayKey: '2026-09-08',
      weekday: 2,
      secondOfDay: 8 * 3600 + 14 * 60 + 30,
    });
  });

  it("l'hiver (UTC+1) : la même heure locale correspond à une autre seconde UTC", () => {
    // 2026-12-15 est un mardi ; 07:14:30Z = 08:14:30 à Paris.
    expect(instantLocal(new Date('2026-12-15T07:14:30Z'))).toEqual({
      dayKey: '2026-12-15',
      weekday: 2,
      secondOfDay: 8 * 3600 + 14 * 60 + 30,
    });
  });

  it('22:40Z un dimanche soir d\'été est DÉJÀ lundi à Paris — et la seconde repart de zéro', () => {
    // 2026-09-06 est un dimanche ; 22:40Z = 00:40 lundi 7 à Paris.
    expect(instantLocal(new Date('2026-09-06T22:40:00Z'))).toEqual({
      dayKey: '2026-09-07',
      weekday: 1,
      secondOfDay: 40 * 60,
    });
  });

  it('minuit local vaut la seconde 0, pas 86 400 (cycle h23)', () => {
    // 2026-09-06T22:00:00Z = 00:00:00 lundi à Paris.
    expect(instantLocal(new Date('2026-09-06T22:00:00Z')).secondOfDay).toBe(0);
  });

  it('accepte un autre fuseau', () => {
    expect(instantLocal(new Date('2026-09-08T06:14:30Z'), 'UTC').secondOfDay).toBe(6 * 3600 + 14 * 60 + 30);
  });
});
