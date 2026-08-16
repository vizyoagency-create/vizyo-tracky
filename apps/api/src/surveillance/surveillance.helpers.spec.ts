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
  /**
   * Instant correspondant à une heure de PENDULE parisienne — l'heure que
   * l'utilisateur a saisie et que l'écran lui affiche.
   *
   * Le décalage `+02:00` est écrit en clair : la semaine du 2026-05-10 est en heure
   * d'été (CEST). C'est volontairement explicite, et non calculé — un test qui
   * calcule le décalage avec le même code que la fonction testée ne prouve rien.
   */
  function utcDate(
    day: 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat',
    hour: number,
    minute = 0,
  ): Date {
    // Le 2026-05-10 est un dimanche, donc on calque les autres jours dessus.
    const baseDay: Record<typeof day, number> = {
      sun: 10, mon: 11, tue: 12, wed: 13, thu: 14, fri: 15, sat: 16,
    } as const;
    const jj = String(baseDay[day]).padStart(2, '0');
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return new Date(`2026-05-${jj}T${hh}:${mm}:00+02:00`);
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

  /**
   * Le défaut corrigé au lot B0′ (`design/B0-SOCLE.md` § « Surveillance réglée en UTC »).
   *
   * Ces tests ne vérifient pas une préférence d'affichage : ils vérifient QUAND
   * l'antivol s'arme. Une plage récurrente n'a pas d'équivalent UTC — son décalage
   * vaut +2 h l'été et +1 h l'hiver — donc aucune constante ne peut la porter. C'est
   * exactement ce que le changement d'heure met en évidence.
   */
  describe('heure de la flotte, pas heure UTC', () => {
    /** Instant UTC brut, sans conversion — ce que le serveur voit réellement. */
    const utc = (iso: string) => new Date(iso);

    it("arme à 18:00 heure de Paris, pas à 18:00 UTC (le défaut : deux heures nues en été)", () => {
      // Été (CEST, +2). La plage commence à 18:00 sur l'horloge de l'exploitant.
      expect(isWithinSchedule(utc('2026-07-13T15:59:00Z'), '18:00', '23:00', null)).toBe(false);
      expect(isWithinSchedule(utc('2026-07-13T16:00:00Z'), '18:00', '23:00', null)).toBe(true);
      // 18:00 UTC, c'est 20:00 à Paris : l'ancienne lecture n'armait que là. Deux heures
      // pendant lesquelles le véhicule n'était pas protégé — et rien ne le disait.
      expect(isWithinSchedule(utc('2026-07-13T17:00:00Z'), '18:00', '23:00', null)).toBe(true);
    });

    it('suit le changement d\'heure : la même plage démarre à 17:00 UTC en hiver', () => {
      // Hiver (CET, +1) — même réglage « 18:00 », un instant UTC différent.
      expect(isWithinSchedule(utc('2026-01-12T16:59:00Z'), '18:00', '23:00', null)).toBe(false);
      expect(isWithinSchedule(utc('2026-01-12T17:00:00Z'), '18:00', '23:00', null)).toBe(true);
    });

    it('le jour de la semaine est celui de Paris, pas celui d\'UTC', () => {
      // Lundi 00:30 à Paris = dimanche 22:30 UTC en été. Un filtre « lundi » doit
      // s'appliquer : sinon la protection du lundi commence avec deux heures de retard,
      // une fois par semaine, sans que le calendrier affiché ne change.
      const lundiTotJuillet = utc('2026-07-12T22:30:00Z');
      expect(lundiTotJuillet.getUTCDay()).toBe(0); // dimanche côté serveur
      expect(isWithinSchedule(lundiTotJuillet, '00:00', '06:00', ['mon'])).toBe(true);
      expect(isWithinSchedule(lundiTotJuillet, '00:00', '06:00', ['sun'])).toBe(false);
    });

    it('accepte un autre fuseau — le jour où une flotte sortira de France', () => {
      // 18:00 à Fort-de-France (UTC-4) = 22:00 UTC.
      const t = utc('2026-07-13T22:30:00Z');
      expect(isWithinSchedule(t, '18:00', '23:00', null, 'America/Martinique')).toBe(true);
      expect(isWithinSchedule(t, '18:00', '23:00', null)).toBe(false); // à Paris, il est 00:30
    });
  });
});
