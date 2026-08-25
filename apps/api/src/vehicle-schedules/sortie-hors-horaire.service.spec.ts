import { CommandStatus, EngineAction } from '@prisma/client';
import type { SortieHorsChampEvent } from '../positions/sortie-hors-champ.event';
import { SortieHorsHoraireService } from './sortie-hors-horaire.service';

/**
 * TRK-046 — le filet de sécurité « véhicule hors champ roule hors horaire autorisé ».
 *
 * Style du fichier voisin (schedule-cron.service.spec) : instanciation manuelle, mocks
 * littéraux, et surtout INSTANTS FIGÉS passés par l'événement — l'évaluateur de planning est
 * pur et prend une base, donc aucun `Date.now()` ne décide d'un verdict (leçon TRK-044).
 */

/** Planning SANS aucun jour actif → OUT_OF_WINDOW quel que soit le jour d'exécution. */
const HORS_PLAGE = () => ({
  id: 'sch-1',
  vehicleId: 'veh-1',
  enabled: true,
  timezone: 'Europe/Paris',
  mondayEnabled: false, mondayStart: null, mondayEnd: null,
  tuesdayEnabled: false, tuesdayStart: null, tuesdayEnd: null,
  wednesdayEnabled: false, wednesdayStart: null, wednesdayEnd: null,
  thursdayEnabled: false, thursdayStart: null, thursdayEnd: null,
  fridayEnabled: false, fridayStart: null, fridayEnd: null,
  saturdayEnabled: false, saturdayStart: null, saturdayEnd: null,
  sundayEnabled: false, sundayStart: null, sundayEnd: null,
  mondaySlots: null, tuesdaySlots: null, wednesdaySlots: null, thursdaySlots: null,
  fridaySlots: null, saturdaySlots: null, sundaySlots: null,
  countryCode: '', // pas de jours fériés → déterministe
  cutOnHolidays: false,
  customDates: null,
  lastEvaluatedAt: null,
  lastEvaluatedState: null,
  overrideUntil: null as Date | null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** Planning tous jours actifs sans bornes → IN_WINDOW quel que soit le jour. */
const EN_PLAGE = () => ({
  ...HORS_PLAGE(),
  mondayEnabled: true, tuesdayEnabled: true, wednesdayEnabled: true, thursdayEnabled: true,
  fridayEnabled: true, saturdayEnabled: true, sundayEnabled: true,
});

const EVT = (over: Partial<SortieHorsChampEvent> = {}): SortieHorsChampEvent => ({
  trackerId: 'tr-1',
  imei: '123456789012345',
  vehicleId: 'veh-1',
  fleetId: 'fl-1',
  plate: 'FZ-862-VY',
  at: '2026-08-25T01:30:00.000Z',
  sombreDepuis: '2026-08-24T17:29:47.000Z',
  sombreMs: new Date('2026-08-25T01:30:00.000Z').getTime() - new Date('2026-08-24T17:29:47.000Z').getTime(),
  speedKmh: 32,
  lat: 43.6,
  lng: 1.44,
  lieuValide: true,
  ...over,
});

function build(opts: { schedule?: unknown; restore?: unknown } = {}) {
  const prisma = {
    vehicleSchedule: { findFirst: jest.fn().mockResolvedValue(opts.schedule ?? null) },
    engineControlCommand: { findFirst: jest.fn().mockResolvedValue(opts.restore ?? null) },
  } as any;
  const alerts = { createSortieHorsHoraireAlert: jest.fn().mockResolvedValue({ id: 'al-1' }) } as any;
  const service = new SortieHorsHoraireService(prisma, alerts);
  return { service, prisma, alerts };
}

describe('SortieHorsHoraireService (TRK-046)', () => {
  it('crée l\'alerte quand un véhicule hors champ réapparaît en roulant HORS plage', async () => {
    const { service, alerts } = build({ schedule: HORS_PLAGE() });
    await service.onSortieHorsChamp(EVT());
    expect(alerts.createSortieHorsHoraireAlert).toHaveBeenCalledTimes(1);
    const [trackerArg, vehicleArg, contexte] = alerts.createSortieHorsHoraireAlert.mock.calls[0];
    expect(trackerArg).toEqual({ id: 'tr-1', imei: '123456789012345' });
    expect(vehicleArg).toEqual({ id: 'veh-1', plate: 'FZ-862-VY', fleetId: 'fl-1' });
    // 17:29:47 → 01:30:00 = 480 min — la durée vient de l'ÉVÉNEMENT, pas d'une horloge locale.
    expect(contexte).toMatchObject({ sombreMin: 480, speedKmh: 32, lieuValide: true });
  });

  it('s\'abstient sans planning actif : la sortie n\'enfreint rien', async () => {
    const { service, alerts, prisma } = build({ schedule: null });
    await service.onSortieHorsChamp(EVT());
    expect(alerts.createSortieHorsHoraireAlert).not.toHaveBeenCalled();
    // Et ne va même pas chercher un RESTORE : l'abstention est décidée au plus tôt.
    expect(prisma.engineControlCommand.findFirst).not.toHaveBeenCalled();
  });

  it('s\'abstient pendant un override manuel : un humain a explicitement autorisé', async () => {
    const schedule = { ...HORS_PLAGE(), overrideUntil: new Date('2026-08-25T06:00:00.000Z') };
    const { service, alerts } = build({ schedule });
    await service.onSortieHorsChamp(EVT()); // at = 01:30 < override 06:00
    expect(alerts.createSortieHorsHoraireAlert).not.toHaveBeenCalled();
  });

  it('s\'abstient DANS la plage autorisée : trajet normal', async () => {
    const { service, alerts } = build({ schedule: EN_PLAGE() });
    await service.onSortieHorsChamp(EVT());
    expect(alerts.createSortieHorsHoraireAlert).not.toHaveBeenCalled();
  });

  it('s\'abstient si un RESTORE est né pendant l\'obscurité (déverrouillage conducteur)', async () => {
    const { service, alerts, prisma } = build({ schedule: HORS_PLAGE(), restore: { id: 'cmd-1' } });
    await service.onSortieHorsChamp(EVT());
    expect(alerts.createSortieHorsHoraireAlert).not.toHaveBeenCalled();
    // Le filtre exclut les commandes qui n'ont RIEN autorisé (refus/échec), et la fenêtre
    // démarre au début de l'obscurité — pas à un « récemment » flottant.
    expect(prisma.engineControlCommand.findFirst).toHaveBeenCalledWith({
      where: {
        trackerId: 'tr-1',
        action: EngineAction.RESTORE,
        createdAt: { gte: new Date('2026-08-24T17:29:47.000Z') },
        status: { notIn: [CommandStatus.REJECTED_SPEED, CommandStatus.FAILED] },
      },
      select: { id: true },
    });
  });

  it('ne laisse JAMAIS une erreur remonter vers l\'ingestion (écouteur d\'événement)', async () => {
    const { service, prisma } = build({ schedule: HORS_PLAGE() });
    prisma.vehicleSchedule.findFirst.mockRejectedValue(new Error('DB down'));
    await expect(service.onSortieHorsChamp(EVT())).resolves.toBeUndefined();
  });
});
