import { SurveillanceSensitivity } from '@prisma/client';
import {
  isWithinSchedule,
  mapSensitivityToCobanLevel,
} from './surveillance.helpers';

describe('mapSensitivityToCobanLevel', () => {
  it('mappe LOW vers niveau 3 (peu sensible)', () => {
    expect(mapSensitivityToCobanLevel(SurveillanceSensitivity.LOW)).toBe('3');
  });

  it('mappe MEDIUM vers niveau 2', () => {
    expect(mapSensitivityToCobanLevel(SurveillanceSensitivity.MEDIUM)).toBe('2');
  });

  it('mappe HIGH vers niveau 1 (très sensible)', () => {
    expect(mapSensitivityToCobanLevel(SurveillanceSensitivity.HIGH)).toBe('1');
  });
});

describe('isWithinSchedule', () => {
  // Helper : crée une Date UTC à partir d'un jour/heure (dimanche=0..samedi=6).
  function utcDate(
    day: 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat',
    hour: number,
    minute = 0,
  ): Date {
    // Le 2026-05-10 est un dimanche, donc on calque les autres jours dessus.
    const baseDay: Record<typeof day, number> = {
      sun: 10, mon: 11, tue: 12, wed: 13, thu: 14, fri: 15, sat: 16,
    } as const;
    const d = new Date(Date.UTC(2026, 4 /* mai (0-indexed) */, baseDay[day], hour, minute, 0));
    return d;
  }

  describe('plage normale sans wrap minuit (08:00 → 18:00)', () => {
    it('est dans la plage à 12:00', () => {
      expect(isWithinSchedule(utcDate('mon', 12), '08:00', '18:00', null)).toBe(true);
    });

    it("n'est pas dans la plage à 07:00 (avant)", () => {
      expect(isWithinSchedule(utcDate('mon', 7), '08:00', '18:00', null)).toBe(false);
    });

    it("n'est pas dans la plage à 18:00 (borne sup exclusive)", () => {
      expect(isWithinSchedule(utcDate('mon', 18), '08:00', '18:00', null)).toBe(false);
    });

    it('est dans la plage à 08:00 (borne inf inclusive)', () => {
      expect(isWithinSchedule(utcDate('mon', 8), '08:00', '18:00', null)).toBe(true);
    });
  });

  describe('plage wrap minuit (20:00 → 06:00)', () => {
    it('est dans la plage à 22:00 (après start, même jour)', () => {
      expect(isWithinSchedule(utcDate('mon', 22), '20:00', '06:00', null)).toBe(true);
    });

    it('est dans la plage à 03:00 (avant end, jour suivant)', () => {
      expect(isWithinSchedule(utcDate('tue', 3), '20:00', '06:00', null)).toBe(true);
    });

    it("n'est pas dans la plage à 19:00 (avant start)", () => {
      expect(isWithinSchedule(utcDate('mon', 19), '20:00', '06:00', null)).toBe(false);
    });

    it("n'est pas dans la plage à 07:00 (après end)", () => {
      expect(isWithinSchedule(utcDate('tue', 7), '20:00', '06:00', null)).toBe(false);
    });

    it("filtre par jour côté start (plage du lundi soir = active à lundi 22h ET mardi 03h)", () => {
      // Lundi 22h : start côté lundi (dans days) → ON
      expect(isWithinSchedule(utcDate('mon', 22), '20:00', '06:00', ['mon'])).toBe(true);
      // Mardi 03h : c'est la fin de la plage qui a démarré lundi soir → on regarde le jour de la veille (lundi)
      expect(isWithinSchedule(utcDate('tue', 3), '20:00', '06:00', ['mon'])).toBe(true);
      // Mardi 22h : la plage du mardi soir, mais mardi n'est pas dans days → OFF
      expect(isWithinSchedule(utcDate('tue', 22), '20:00', '06:00', ['mon'])).toBe(false);
      // Mercredi 03h : ce serait la suite de mardi soir, qui n'est pas dans days → OFF
      expect(isWithinSchedule(utcDate('wed', 3), '20:00', '06:00', ['mon'])).toBe(false);
    });
  });

  describe('filtre par jours', () => {
    it("est ON lundi à 12:00 quand days=['mon','tue']", () => {
      expect(
        isWithinSchedule(utcDate('mon', 12), '08:00', '18:00', ['mon', 'tue']),
      ).toBe(true);
    });

    it("est OFF mercredi à 12:00 quand days=['mon','tue']", () => {
      expect(
        isWithinSchedule(utcDate('wed', 12), '08:00', '18:00', ['mon', 'tue']),
      ).toBe(false);
    });

    it('null = tous les jours', () => {
      for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const) {
        expect(isWithinSchedule(utcDate(day, 12), '08:00', '18:00', null)).toBe(true);
      }
    });

    it('liste vide = tous les jours (équivalent à null)', () => {
      expect(isWithinSchedule(utcDate('wed', 12), '08:00', '18:00', [])).toBe(true);
    });
  });

  describe('cas dégradés', () => {
    it('plage nulle (start == end) est toujours OFF', () => {
      expect(isWithinSchedule(utcDate('mon', 12), '12:00', '12:00', null)).toBe(false);
    });

    it('strings invalides → false (pas de crash)', () => {
      expect(isWithinSchedule(utcDate('mon', 12), 'invalid', '18:00', null)).toBe(false);
      expect(isWithinSchedule(utcDate('mon', 12), '08:00', 'invalid', null)).toBe(false);
    });
  });
});
