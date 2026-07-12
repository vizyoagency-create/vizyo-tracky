import type { VehicleWorkSchedule } from '@prisma/client';
import { isWithinWorkHours, resolveEffectivePrivacy } from './effective-privacy';

/**
 * Résolution du mode vie privée EFFECTIF (calendrier de temps de travail + exceptions).
 * Le calendrier réutilise l'évaluateur moteur (fuseau/fériés/plages) — on vérifie ici le mapping
 * travail=tracé / hors-travail=privé et la précédence (manuel > exception > calendrier > défaut).
 */
function makeWS(overrides: Partial<VehicleWorkSchedule> = {}): VehicleWorkSchedule {
  return {
    id: 'ws1', vehicleId: 'v1', enabled: true, timezone: 'Europe/Paris',
    mondayEnabled: true, mondayStart: '08:00', mondayEnd: '18:00',
    tuesdayEnabled: true, tuesdayStart: '08:00', tuesdayEnd: '18:00',
    wednesdayEnabled: true, wednesdayStart: '08:00', wednesdayEnd: '18:00',
    thursdayEnabled: true, thursdayStart: '08:00', thursdayEnd: '18:00',
    fridayEnabled: true, fridayStart: '08:00', fridayEnd: '18:00',
    saturdayEnabled: false, saturdayStart: null, saturdayEnd: null,
    sundayEnabled: false, sundayStart: null, sundayEnd: null,
    mondaySlots: null, tuesdaySlots: null, wednesdaySlots: null, thursdaySlots: null,
    fridaySlots: null, saturdaySlots: null, sundaySlots: null,
    countryCode: 'FR', customDates: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as VehicleWorkSchedule;
}

const MON_10H = new Date('2026-01-05T09:00:00Z'); // lundi 5 janv. 10:00 Paris (hiver, UTC+1)
const MON_22H = new Date('2026-01-05T21:00:00Z'); // lundi 22:00 Paris
const SUN_13H = new Date('2026-01-04T12:00:00Z'); // dimanche 4 janv. 13:00 Paris
const LABOUR_DAY = new Date('2026-05-01T10:00:00Z'); // vendredi 1er mai 12:00 Paris (férié FR, été UTC+2)

const veh = (o: Partial<{ privacyModeEnabled: boolean; workOverrideUntil: Date | null }> = {}) => ({
  privacyModeEnabled: false,
  workOverrideUntil: null,
  ...o,
});

describe('resolveEffectivePrivacy', () => {
  it('dans une plage de temps de travail (lundi 10h) → TRACÉ', () => {
    expect(resolveEffectivePrivacy(veh(), makeWS(), MON_10H)).toEqual({ isPrivate: false, reason: 'WORK_HOURS' });
  });

  it('hors plage (lundi 22h) → PRIVÉ (non collecté)', () => {
    expect(resolveEffectivePrivacy(veh(), makeWS(), MON_22H)).toEqual({ isPrivate: true, reason: 'OUT_OF_HOURS' });
  });

  it('week-end (dimanche, jour désactivé) → PRIVÉ', () => {
    expect(resolveEffectivePrivacy(veh(), makeWS(), SUN_13H)).toEqual({ isPrivate: true, reason: 'OUT_OF_HOURS' });
  });

  it('jour férié FR (1er mai, pourtant un vendredi ouvré) → PRIVÉ (fériés hérités de l\'évaluateur)', () => {
    expect(resolveEffectivePrivacy(veh(), makeWS(), LABOUR_DAY)).toEqual({ isPrivate: true, reason: 'OUT_OF_HOURS' });
  });

  it('privé manuel explicite → PRIVÉ même en pleine plage de travail (le plus sûr)', () => {
    expect(resolveEffectivePrivacy(veh({ privacyModeEnabled: true }), makeWS(), MON_10H)).toEqual({
      isPrivate: true,
      reason: 'MANUAL',
    });
  });

  it('exception « je travaille » (workOverrideUntil futur) → TRACÉ même le dimanche', () => {
    const future = new Date(SUN_13H.getTime() + 3 * 3600_000);
    expect(resolveEffectivePrivacy(veh({ workOverrideUntil: future }), makeWS(), SUN_13H)).toEqual({
      isPrivate: false,
      reason: 'WORK_OVERRIDE',
    });
  });

  it('exception expirée (workOverrideUntil passé) → ignorée → PRIVÉ le dimanche', () => {
    const past = new Date(SUN_13H.getTime() - 3600_000);
    expect(resolveEffectivePrivacy(veh({ workOverrideUntil: past }), makeWS(), SUN_13H)).toEqual({
      isPrivate: true,
      reason: 'OUT_OF_HOURS',
    });
  });

  it('aucun cadre (null) → TRACÉ par défaut (opt-in par véhicule)', () => {
    expect(resolveEffectivePrivacy(veh(), null, MON_22H)).toEqual({ isPrivate: false, reason: 'NO_SCHEDULE' });
  });

  it('cadre présent mais désactivé → TRACÉ (comme si absent)', () => {
    expect(resolveEffectivePrivacy(veh(), makeWS({ enabled: false }), SUN_13H)).toEqual({
      isPrivate: false,
      reason: 'NO_SCHEDULE',
    });
  });
});

describe('isWithinWorkHours', () => {
  it('lundi 10h (plage 08-18) → true', () => expect(isWithinWorkHours(makeWS(), MON_10H)).toBe(true));
  it('lundi 22h → false', () => expect(isWithinWorkHours(makeWS(), MON_22H)).toBe(false));
  it('cadre absent → false', () => expect(isWithinWorkHours(null, MON_10H)).toBe(false));
  it('cadre désactivé → false', () => expect(isWithinWorkHours(makeWS({ enabled: false }), MON_10H)).toBe(false));
});
