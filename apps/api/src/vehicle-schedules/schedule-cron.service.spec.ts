import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { PresumedParkedException } from '../engine-control/engine-control.service';
import { parseKnownCountdown, ScheduleCronService } from './schedule-cron.service';
import type { VehicleSchedule } from '@prisma/client';

/** Helper to build a schedule with defaults. */
function makeSchedule(overrides: Partial<VehicleSchedule> = {}): VehicleSchedule {
  return {
    id: 'sched-1',
    vehicleId: 'v-1',
    enabled: true,
    timezone: 'Europe/Paris',
    mondayEnabled: true,
    mondayStart: '08:00',
    mondayEnd: '20:00',
    tuesdayEnabled: true,
    tuesdayStart: '08:00',
    tuesdayEnd: '20:00',
    wednesdayEnabled: true,
    wednesdayStart: '08:00',
    wednesdayEnd: '20:00',
    thursdayEnabled: true,
    thursdayStart: '08:00',
    thursdayEnd: '20:00',
    fridayEnabled: true,
    fridayStart: '08:00',
    fridayEnd: '20:00',
    saturdayEnabled: false,
    saturdayStart: null,
    saturdayEnd: null,
    sundayEnabled: false,
    sundayStart: null,
    sundayEnd: null,
    // V1.5 (Sprint K) — multi-plages + jours feries + dates speciales
    mondaySlots: null,
    tuesdaySlots: null,
    wednesdaySlots: null,
    thursdaySlots: null,
    fridaySlots: null,
    saturdaySlots: null,
    sundaySlots: null,
    countryCode: 'FR',
    cutOnHolidays: false,
    customDates: null,
    lastEvaluatedAt: null,
    lastEvaluatedState: null,
    overrideUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ScheduleCronService.computeState', () => {
  let service: ScheduleCronService;

  beforeEach(() => {
    // Only testing computeState — no DB/engine dependencies needed
    service = new ScheduleCronService(null as any, null as any, null as any, { emit: jest.fn() } as any);
  });

  it('should return IN_WINDOW when within allowed hours on an enabled day', () => {
    // Mock Intl to return a Wednesday 10:00
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '15' }, // Wednesday
            { type: 'hour', value: '10' },
            { type: 'minute', value: '00' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule();
    expect(service.computeState(schedule)).toBe('IN_WINDOW');

    jest.restoreAllMocks();
  });

  it('should return OUT_OF_WINDOW when outside allowed hours', () => {
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '15' }, // Wednesday
            { type: 'hour', value: '22' },
            { type: 'minute', value: '30' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule();
    expect(service.computeState(schedule)).toBe('OUT_OF_WINDOW');

    jest.restoreAllMocks();
  });

  it('should return OUT_OF_WINDOW when day is disabled (Saturday)', () => {
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '18' }, // Saturday
            { type: 'hour', value: '10' },
            { type: 'minute', value: '00' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule();
    expect(service.computeState(schedule)).toBe('OUT_OF_WINDOW');

    jest.restoreAllMocks();
  });

  it('should return IN_WINDOW when day enabled but no start/end defined', () => {
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '15' }, // Wednesday
            { type: 'hour', value: '23' },
            { type: 'minute', value: '59' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule({
      wednesdayEnabled: true,
      wednesdayStart: null,
      wednesdayEnd: null,
    });
    expect(service.computeState(schedule)).toBe('IN_WINDOW');

    jest.restoreAllMocks();
  });

  it('should return OUT_OF_WINDOW at the exact end time (end is exclusive)', () => {
    const original = Intl.DateTimeFormat;
    jest
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation((_locale: any, _opts: any) => {
        const fmt = new original('en-US', _opts);
        return {
          ...fmt,
          formatToParts: () => [
            { type: 'year', value: '2026' },
            { type: 'month', value: '04' },
            { type: 'day', value: '15' }, // Wednesday
            { type: 'hour', value: '20' },
            { type: 'minute', value: '00' },
            { type: 'second', value: '00' },
          ],
        } as any;
      });

    const schedule = makeSchedule();
    expect(service.computeState(schedule)).toBe('OUT_OF_WINDOW');

    jest.restoreAllMocks();
  });

  it('should detect transition from null to IN_WINDOW', () => {
    const schedule = makeSchedule({ lastEvaluatedState: null });
    // computeState doesn't deal with transitions, but the cron does:
    // if state !== lastEvaluatedState → action. null !== 'IN_WINDOW' → transition.
    const state = service.computeState(schedule);
    expect(state !== schedule.lastEvaluatedState).toBe(true);
  });
});

/**
 * Backoff des coupes en échec (incident 2026-07-19 — 954 commandes en échec en une nuit).
 *
 * Le test qui compte le plus est le 3e : une RESTAURATION ne doit JAMAIS être retardée. Rater une
 * coupe est un désagrément ; rater une restauration immobilise un véhicule.
 */
describe('ScheduleCronService — backoff des coupes', () => {
  const OUT_OF_WINDOW_SCHEDULE = () => ({
    ...makeSchedule({
      lastEvaluatedState: 'IN_WINDOW',
      // Samedi désactivé → toujours hors plage, quel que soit le jour du test.
      mondayEnabled: false, tuesdayEnabled: false, wednesdayEnabled: false,
      thursdayEnabled: false, fridayEnabled: false,
    }),
    vehicle: { id: 'v-1', fleetId: 'f-1', tracker: { id: 't-1', imei: '123', status: 'OFFLINE' } },
  } as any);

  function build(failWith?: Error) {
    const prisma = {
      vehicleSchedule: { update: jest.fn().mockResolvedValue({}) },
      scheduleHistory: { create: jest.fn().mockResolvedValue({}) },
    } as any;
    const engine = {
      requestCommand: failWith
        ? jest.fn().mockRejectedValue(failWith)
        : jest.fn().mockResolvedValue({}),
    } as any;
    const errorLogger = { record: jest.fn().mockResolvedValue('id') } as any;
    const service = new ScheduleCronService(prisma, engine, errorLogger, { emit: jest.fn() } as any);
    return { service, engine, prisma, errorLogger };
  }

  afterEach(() => jest.useRealTimers());

  it('ne retente PAS une coupe au tick suivant (c\'est l\'appel qui inondait le centre d\'alerte)', async () => {
    const { service, engine } = build(new ServiceUnavailableException('Tracker hors ligne'));
    const schedule = OUT_OF_WINDOW_SCHEDULE();

    await service.evaluateOne(schedule); // 1re tentative → échec, backoff armé
    await service.evaluateOne(schedule); // tick suivant (1 min plus tard)
    await service.evaluateOne(schedule);

    expect(engine.requestCommand).toHaveBeenCalledTimes(1);
  });

  it('retente une fois le délai écoulé, avec un palier croissant', async () => {
    jest.useFakeTimers();
    const { service, engine } = build(new ServiceUnavailableException('Tracker hors ligne'));
    const schedule = OUT_OF_WINDOW_SCHEDULE();

    await service.evaluateOne(schedule);
    expect(engine.requestCommand).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2 * 60 * 1000 + 1000); // palier 1 = 2 min
    await service.evaluateOne(schedule);
    expect(engine.requestCommand).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(2 * 60 * 1000 + 1000); // palier 2 = 5 min → pas encore
    await service.evaluateOne(schedule);
    expect(engine.requestCommand).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(3 * 60 * 1000 + 1000); // total 5 min → OK
    await service.evaluateOne(schedule);
    expect(engine.requestCommand).toHaveBeenCalledTimes(3);
  });

  it('⚠️ ne retarde JAMAIS une RESTAURATION, même juste après une coupe en échec', async () => {
    const { service, engine } = build(new ServiceUnavailableException('Tracker hors ligne'));
    const cut = OUT_OF_WINDOW_SCHEDULE();

    await service.evaluateOne(cut); // coupe en échec → backoff armé pour ce véhicule
    expect(engine.requestCommand).toHaveBeenCalledTimes(1);

    // Même véhicule, mais on est maintenant DANS la plage → RESTAURATION attendue.
    const restore = {
      ...makeSchedule({ lastEvaluatedState: 'OUT_OF_WINDOW' }),
      mondayEnabled: true, tuesdayEnabled: true, wednesdayEnabled: true,
      thursdayEnabled: true, fridayEnabled: true, saturdayEnabled: true, sundayEnabled: true,
      mondayStart: null, mondayEnd: null, tuesdayStart: null, tuesdayEnd: null,
      wednesdayStart: null, wednesdayEnd: null, thursdayStart: null, thursdayEnd: null,
      fridayStart: null, fridayEnd: null, saturdayStart: null, saturdayEnd: null,
      sundayStart: null, sundayEnd: null,
      vehicle: { id: 'v-1', fleetId: 'f-1', tracker: { id: 't-1', imei: '123', status: 'OFFLINE' } },
    } as any;

    await service.evaluateOne(restore);

    // 2e appel = la restauration est bien partie SANS attendre le backoff de la coupe.
    expect(engine.requestCommand).toHaveBeenCalledTimes(2);
    expect(engine.requestCommand).toHaveBeenLastCalledWith(
      't-1', 'RESTORE', expect.any(String), expect.anything(), 'SCHEDULER',
    );
  });

  it('remet le compteur à zéro quand la coupe finit par passer', async () => {
    const engineMock = jest.fn()
      .mockRejectedValueOnce(new ServiceUnavailableException('hors ligne'))
      .mockResolvedValue({});
    const prisma = {
      vehicleSchedule: { update: jest.fn().mockResolvedValue({}) },
      scheduleHistory: { create: jest.fn().mockResolvedValue({}) },
    } as any;
    const service = new ScheduleCronService(
      prisma, { requestCommand: engineMock } as any,
      { record: jest.fn().mockResolvedValue('id') } as any, { emit: jest.fn() } as any,
    );
    jest.useFakeTimers();
    const schedule = OUT_OF_WINDOW_SCHEDULE();

    await service.evaluateOne(schedule);            // échec → backoff
    jest.advanceTimersByTime(2 * 60 * 1000 + 1000);
    await service.evaluateOne(schedule);            // succès → backoff effacé

    // Un nouvel échec doit repartir du PREMIER palier (2 min), pas du dernier atteint.
    engineMock.mockRejectedValue(new ServiceUnavailableException('hors ligne'));
    await service.evaluateOne({ ...schedule, lastEvaluatedState: 'IN_WINDOW' });
    expect(engineMock).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(2 * 60 * 1000 + 1000);
    await service.evaluateOne({ ...schedule, lastEvaluatedState: 'IN_WINDOW' });
    expect(engineMock).toHaveBeenCalledTimes(4);
  });

  it('sur une nuit entière : quelques tentatives au lieu d\'une par minute, et le blocage reste visible', async () => {
    jest.useFakeTimers();
    const { service, engine, errorLogger } = build(new ServiceUnavailableException('Tracker hors ligne'));
    const schedule = OUT_OF_WINDOW_SCHEDULE();

    // 12 h de ticks minute par minute — exactement le scénario de l'incident.
    for (let minute = 0; minute < 720; minute++) {
      await service.evaluateOne(schedule);
      jest.advanceTimersByTime(60 * 1000);
    }

    // Avant : 720 commandes (chacune tentant TCP puis SMS, chacune journalisée).
    // Après : paliers 2/5/15 puis 30 min → une trentaine.
    expect(engine.requestCommand.mock.calls.length).toBeLessThan(30);
    expect(engine.requestCommand.mock.calls.length).toBeGreaterThan(5); // on n'abandonne jamais

    // Et le blocage reste REMONTÉ au centre d'alerte (sinon on l'aurait juste rendu silencieux).
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('coupe/reprise impossible') }),
      'schedule-cron',
      expect.objectContaining({ phase: 'stuck-schedule-action' }),
    );
  });

  /**
   * L'alerte doit nommer la CAUSE, pas l'attente.
   *
   * Constat 2026-07-27 au centre d'alerte : 16 lignes sur 16 rédigées « coupe/reprise impossible
   * depuis N min (coupe en attente de nouvelle tentative (backoff)) » — une phrase circulaire, et
   * AUCUNE ne nommait la cause réelle. C'est mécanique : le backoff plafonne à 30 min et le seuil
   * d'alerte vaut 30 min, donc l'alerte tombe presque toujours pendant l'attente et jamais sur le
   * tick qui a réellement échoué.
   */
  it('nomme la CAUSE RÉELLE du blocage (et la plaque), pas l\'état d\'attente', async () => {
    jest.useFakeTimers();
    const { service, errorLogger } = build(new ForbiddenException('Aucune position connue pour ce tracker'));
    const schedule = { ...OUT_OF_WINDOW_SCHEDULE() };
    schedule.vehicle = { ...schedule.vehicle, plate: 'FV-941-LZ' };

    // 90 min de ticks : le 1er échec arme le backoff, l'alerte part à 30 min — donc en pleine attente.
    for (let minute = 0; minute < 90; minute++) {
      await service.evaluateOne(schedule);
      jest.advanceTimersByTime(60 * 1000);
    }

    expect(errorLogger.record).toHaveBeenCalled();
    const [err, source, ctx] = errorLogger.record.mock.calls[0];
    expect(source).toBe('schedule-cron');
    expect(err.message).toContain('Aucune position connue pour ce tracker');
    expect(err.message).toContain('FV-941-LZ'); // identifiable sans ouvrir la base
    expect(err.message).not.toContain('backoff'); // l'attente n'est plus présentée comme la cause
    expect(ctx).toMatchObject({ cause: 'Aucune position connue pour ce tracker', waitingBackoff: true });
  });

  /**
   * DORMANCE — un boîtier muet depuis des jours ne doit plus être piloté.
   *
   * Cas réel : FV-941-LZ, 89 jours de silence, planning toujours actif → ~48 tentatives
   * de coupe par jour, chacune créant une commande, tentant TCP puis SMS et journalisant.
   */
  describe('véhicule dormant', () => {
    const DORMANT = () => {
      const s = OUT_OF_WINDOW_SCHEDULE();
      s.vehicle = {
        ...s.vehicle,
        plate: 'FV-941-LZ',
        tracker: { ...s.vehicle.tracker, lastSeenAt: new Date(Date.now() - 89 * 24 * 60 * 60 * 1000) },
      };
      return s;
    };

    it('n\'appelle plus le moteur de commande du tout', async () => {
      jest.useFakeTimers();
      const { service, engine } = build();
      const schedule = DORMANT();

      for (let minute = 0; minute < 240; minute++) {
        await service.evaluateOne(schedule);
        jest.advanceTimersByTime(60 * 1000);
      }

      expect(engine.requestCommand).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ N'ÉCRIT RIEN au centre d'alerte — correctif d'un incident réel (2026-07-28).
     *
     * La version précédente y écrivait « une fois puis silence 7 j ». Deux fautes :
     * l'anti-répétition était EN MÉMOIRE pour un état qui dure des mois (chaque
     * redémarrage la remettait à zéro — six déploiements dans la soirée, plus chaque
     * smoke-boot qui exécute un tick avant de mourir → 12 lignes pour 2 véhicules), et
     * c'était classé ERREUR alors qu'un planning suspendu sur un boîtier mort est un
     * ÉTAT, déjà exposé par la page Horaires (`presence: 'DORMANT'`).
     *
     * Un état stable se LIT, il ne se notifie pas en boucle.
     */
    it('n\'écrit RIEN au centre d\'alerte, même sur 24 h de ticks', async () => {
      jest.useFakeTimers();
      const { service, errorLogger } = build();
      const schedule = DORMANT();

      for (let minute = 0; minute < 24 * 60; minute++) {
        await service.evaluateOne(schedule);
        jest.advanceTimersByTime(60 * 1000);
      }

      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    it('⚠️ un REDÉMARRAGE ne réémet rien (l\'incident venait d\'un compteur en mémoire)', async () => {
      // Trois instances successives = trois déploiements/smoke-boots dans la soirée.
      for (let redemarrage = 0; redemarrage < 3; redemarrage++) {
        const { service, errorLogger } = build();
        await service.evaluateOne(DORMANT());
        expect(errorLogger.record).not.toHaveBeenCalled();
      }
    });

    it('⚠️ ne laisse AUCUNE entrée résiduelle dans les suivis (fuite mémoire)', async () => {
      const { service } = build(new ServiceUnavailableException('Tracker hors ligne'));
      const vivant = OUT_OF_WINDOW_SCHEDULE();

      await service.evaluateOne(vivant); // échec → backoff + report armés
      const maps = service as unknown as Record<string, Map<string, unknown>>;
      expect(maps['deferredSince'].has('v-1')).toBe(true);

      // Le même véhicule devient dormant : les suivis doivent être purgés.
      await service.evaluateOne(DORMANT());

      for (const nom of ['deferredSince', 'lastStuckAlertAt', 'cutRetryAfter', 'cutFailures', 'cutRetryDeadline', 'lastFailureReason', 'stuckAlertLogIds']) {
        expect(maps[nom].has('v-1')).toBe(false);
      }
    });

    it('RÉINTÉGRATION : dès que le boîtier réémet, le planning repart au tick suivant', async () => {
      const { service, engine } = build();

      await service.evaluateOne(DORMANT());
      expect(engine.requestCommand).not.toHaveBeenCalled();

      // Une seule trame fraîche — aucun geste d'exploitant, aucun drapeau à décocher.
      const reveille = OUT_OF_WINDOW_SCHEDULE();
      reveille.vehicle = { ...reveille.vehicle, tracker: { ...reveille.vehicle.tracker, lastSeenAt: new Date() } };
      await service.evaluateOne(reveille);

      expect(engine.requestCommand).toHaveBeenCalledTimes(1);
    });

    it('⚠️ un véhicule silencieux depuis 2 h (garé la nuit) reste piloté', async () => {
      const { service, engine } = build();
      const gare = OUT_OF_WINDOW_SCHEDULE();
      gare.vehicle = {
        ...gare.vehicle,
        tracker: { ...gare.vehicle.tracker, lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      };

      await service.evaluateOne(gare);

      expect(engine.requestCommand).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ScheduleCronService.evaluateOne override', () => {
  it('should skip evaluation when overrideUntil is in the future', async () => {
    const prisma = { vehicleSchedule: { update: jest.fn() } } as any;
    const engine = { requestCommand: jest.fn() } as any;
    const service = new ScheduleCronService(
      prisma, engine,
      { record: jest.fn().mockResolvedValue('id') } as any,
      { emit: jest.fn() } as any,
    );

    const schedule = {
      ...makeSchedule({
        overrideUntil: new Date(Date.now() + 60_000),
        lastEvaluatedState: 'OUT_OF_WINDOW',
      }),
      vehicle: { id: 'v-1', fleetId: 'f-1', tracker: { id: 't-1', imei: '123', status: 'ONLINE' } },
    } as any;

    await service.evaluateOne(schedule);

    expect(engine.requestCommand).not.toHaveBeenCalled();
  });

  describe("TRK-029 — réessai à l'échéance connue, rédaction, clôture", () => {
    const COUNTDOWN_MSG = 'Coupe auto différée : véhicule arrêté depuis seulement 256s (minimum requis 600s)';
    const ALERT_UUID = '3f2c8a5e-0000-4abc-9def-0123456789ab';

    // Fixture DUPLIQUÉE du describe backoff (volontairement : ses tests sont verrouillés,
    // on ne les touche pas) — hors plage quel que soit le jour du test.
    const HORS_PLAGE = () => ({
      ...makeSchedule({
        lastEvaluatedState: 'IN_WINDOW',
        mondayEnabled: false, tuesdayEnabled: false, wednesdayEnabled: false,
        thursdayEnabled: false, fridayEnabled: false,
      }),
      vehicle: { id: 'v-1', fleetId: 'f-1', plate: 'DZ-034-CA', tracker: { id: 't-1', imei: '123', status: 'OFFLINE' } },
    } as any);

    function buildTrk029(failWith?: Error) {
      const prisma = {
        vehicleSchedule: { update: jest.fn().mockResolvedValue({}) },
        scheduleHistory: { create: jest.fn().mockResolvedValue({}) },
        errorLog: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      } as any;
      const engine = {
        requestCommand: failWith ? jest.fn().mockRejectedValue(failWith) : jest.fn().mockResolvedValue({}),
      } as any;
      const errorLogger = { record: jest.fn().mockResolvedValue(ALERT_UUID) } as any;
      const service = new ScheduleCronService(prisma, engine, errorLogger, { emit: jest.fn() } as any);
      return { service, engine, prisma, errorLogger };
    }

    const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

    afterEach(() => jest.useRealTimers());

    it('🔑 programme le réessai à M − N (+ un tick), pas au palier de backoff', async () => {
      jest.useFakeTimers();
      const { service, engine } = buildTrk029(new ForbiddenException(COUNTDOWN_MSG));
      const schedule = HORS_PLAGE();

      await service.evaluateOne(schedule); // échec : compte à rebours lisible → réessai programmé
      expect(engine.requestCommand).toHaveBeenCalledTimes(1);

      // LE discriminant : au palier 1 du backoff (2 min), l'ancien code retentait — plus ici.
      jest.advanceTimersByTime(2 * 60 * 1000 + 1000);
      await service.evaluateOne(schedule);
      expect(engine.requestCommand).toHaveBeenCalledTimes(1);

      // À l'échéance (344 s restants + 60 s de marge), l'essai part — jamais 30 min d'attente.
      engine.requestCommand.mockResolvedValue({});
      jest.advanceTimersByTime((344 + 60) * 1000 + 1000 - (2 * 60 * 1000 + 1000));
      await service.evaluateOne(schedule);
      expect(engine.requestCommand).toHaveBeenCalledTimes(2);
    });

    it("l'alerte dit « différée, réessai à HH:MM » — jamais « impossible » — quand l'échéance est connue", async () => {
      jest.useFakeTimers();
      const { service, errorLogger } = buildTrk029(new ForbiddenException(COUNTDOWN_MSG));
      const schedule = HORS_PLAGE();

      for (let i = 0; i < 35; i++) {
        await service.evaluateOne(schedule);
        jest.advanceTimersByTime(60 * 1000);
      }

      expect(errorLogger.record).toHaveBeenCalled();
      const [err, , ctx] = errorLogger.record.mock.calls[0];
      expect((err as Error).message).toContain('coupe différée');
      expect((err as Error).message).toContain('réessai à');
      expect((err as Error).message).not.toContain('impossible');
      expect((err as Error).message).toContain('256 s sur 600 s requis');
      expect(ctx).toMatchObject({ knownDeadline: true, phase: 'stuck-schedule-action' });
      expect(ctx.deferredUntil).toEqual(expect.any(String));
    });

    it("clôt la ligne d'origine quand la coupe aboutit", async () => {
      jest.useFakeTimers();
      const { service, engine, prisma } = buildTrk029(new ServiceUnavailableException('Tracker hors ligne'));
      const schedule = HORS_PLAGE();

      for (let i = 0; i < 31; i++) {
        await service.evaluateOne(schedule);
        await flush(); // le .then de capture d'id est fire-and-forget
        jest.advanceTimersByTime(60 * 1000);
      }
      engine.requestCommand.mockResolvedValue({});
      for (let i = 0; i < 35; i++) {
        await service.evaluateOne(schedule);
        jest.advanceTimersByTime(60 * 1000);
      }
      await flush();

      expect(prisma.errorLog.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [ALERT_UUID] }, resolvedAt: null },
        data: expect.objectContaining({
          resolvedAt: expect.any(Date),
          resolvedNote: expect.stringContaining('coupe aboutie'),
        }),
      });
    });

    it("ne clôt RIEN si aucune alerte n'a été écrite", async () => {
      jest.useFakeTimers();
      const { service, engine, prisma } = buildTrk029(new ServiceUnavailableException('Tracker hors ligne'));
      const schedule = HORS_PLAGE();

      await service.evaluateOne(schedule); // un seul échec, sous le seuil des 30 min
      engine.requestCommand.mockResolvedValue({});
      jest.advanceTimersByTime(3 * 60 * 1000);
      await service.evaluateOne(schedule);
      await flush();

      expect(prisma.errorLog.updateMany).not.toHaveBeenCalled();
    });

    it("⚠️ les sentinelles d'ErrorLogger ne deviennent pas des ids à clore", async () => {
      jest.useFakeTimers();
      const { service, engine, prisma, errorLogger } = buildTrk029(new ServiceUnavailableException('Tracker hors ligne'));
      errorLogger.record.mockResolvedValue('deduped');
      const schedule = HORS_PLAGE();

      for (let i = 0; i < 31; i++) {
        await service.evaluateOne(schedule);
        await flush();
        jest.advanceTimersByTime(60 * 1000);
      }
      engine.requestCommand.mockResolvedValue({});
      for (let i = 0; i < 35; i++) {
        await service.evaluateOne(schedule);
        jest.advanceTimersByTime(60 * 1000);
      }
      await flush();

      expect(prisma.errorLog.updateMany).not.toHaveBeenCalled();
    });

    it('le parseur : compte à rebours lisible, sinon null — jamais de devinette', () => {
      expect(parseKnownCountdown(COUNTDOWN_MSG)).toEqual({ stoppedS: 256, minS: 600 });
      expect(parseKnownCountdown('Coupe auto différée : véhicule en mouvement (32,4 km/h)')).toBeNull();
      expect(parseKnownCountdown('Tracker hors ligne')).toBeNull();
    });

    it('⚠️ une cause qui perd son échéance perd sa promesse — plus de « réessai à » mensonger', async () => {
      jest.useFakeTimers();
      const { service, engine, errorLogger } = buildTrk029(new ForbiddenException(COUNTDOWN_MSG));
      const schedule = HORS_PLAGE();

      await service.evaluateOne(schedule); // échéance connue mémorisée
      // Au réessai, l'engine change de refus : plus d'échéance lisible.
      engine.requestCommand.mockRejectedValue(new ForbiddenException('Coupe auto différée : véhicule en mouvement (32,4 km/h)'));
      for (let i = 0; i < 70; i++) {
        jest.advanceTimersByTime(60 * 1000);
        await service.evaluateOne(schedule);
      }

      expect(errorLogger.record).toHaveBeenCalled();
      const derniers = errorLogger.record.mock.calls.map((c: unknown[]) => (c[0] as Error).message);
      expect(derniers[derniers.length - 1]).not.toContain('réessai à');
    });
  });

  /**
   * ── TRK-046 — « considéré stationné » : un ÉTAT calme, jamais un échec ────────────────────
   *
   * Un véhicule hors champ GPS dans un parking VALIDÉ ne doit produire NI alerte « coupe
   * impossible », NI backoff d'échec, NI martèlement de commandes — et il doit REFERMER les
   * lignes de blocage antérieures (il n'est plus bloqué : il est stationné). Discriminé par
   * TYPE d'exception, jamais par texte (même revue que isDeferrable).
   */
  describe('TRK-046 — véhicule considéré stationné (PresumedParkedException)', () => {
    const PARKED_MSG =
      'Coupe auto en veille : véhicule hors champ GPS dans un lieu validé (parking souterrain) — considéré stationné, sortie surveillée';
    const ALERT_UUID = '3f2c8a5e-0000-4abc-9def-0123456789ab';

    const HORS_PLAGE = () => ({
      ...makeSchedule({
        lastEvaluatedState: 'IN_WINDOW',
        mondayEnabled: false, tuesdayEnabled: false, wednesdayEnabled: false,
        thursdayEnabled: false, fridayEnabled: false,
      }),
      vehicle: { id: 'v-1', fleetId: 'f-1', plate: 'FZ-862-VY', tracker: { id: 't-1', imei: '123', status: 'ONLINE' } },
    } as any);

    function buildParked(failWith: Error) {
      const prisma = {
        vehicleSchedule: { update: jest.fn().mockResolvedValue({}) },
        scheduleHistory: { create: jest.fn().mockResolvedValue({}) },
        errorLog: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      } as any;
      const engine = { requestCommand: jest.fn().mockRejectedValue(failWith) } as any;
      const errorLogger = { record: jest.fn().mockResolvedValue(ALERT_UUID) } as any;
      const service = new ScheduleCronService(prisma, engine, errorLogger, { emit: jest.fn() } as any);
      return { service, engine, prisma, errorLogger };
    }

    const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

    afterEach(() => jest.useRealTimers());

    it("n'écrit JAMAIS d'alerte « coupe impossible » pour un véhicule considéré stationné — même après des heures", async () => {
      jest.useFakeTimers();
      const { service, errorLogger } = buildParked(new PresumedParkedException(PARKED_MSG));
      const schedule = HORS_PLAGE();

      // 6 h de ticks minute : l'ancien traitement (ForbiddenException générique) aurait
      // déclenché l'alerte à 30 min puis toutes les 3 h. Ici : RIEN, c'est un état.
      for (let minute = 0; minute < 360; minute++) {
        await service.evaluateOne(schedule);
        jest.advanceTimersByTime(60 * 1000);
      }
      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    it('re-vérifie calmement (10 min), sans marteler le moteur de commande à chaque tick', async () => {
      jest.useFakeTimers();
      const { service, engine } = buildParked(new PresumedParkedException(PARKED_MSG));
      const schedule = HORS_PLAGE();

      await service.evaluateOne(schedule);
      expect(engine.requestCommand).toHaveBeenCalledTimes(1);

      // Les 9 ticks suivants tombent dans la fenêtre de re-vérification : aucun appel.
      for (let minute = 0; minute < 9; minute++) {
        jest.advanceTimersByTime(60 * 1000);
        await service.evaluateOne(schedule);
      }
      expect(engine.requestCommand).toHaveBeenCalledTimes(1);

      // Passée la fenêtre, on re-vérifie — la présomption n'est jamais définitive.
      jest.advanceTimersByTime(2 * 60 * 1000);
      await service.evaluateOne(schedule);
      expect(engine.requestCommand).toHaveBeenCalledTimes(2);
    });

    it('REFERME les lignes de blocage antérieures : « stationné » résout « coupe impossible »', async () => {
      jest.useFakeTimers();
      const { service, engine, prisma } = buildParked(new ServiceUnavailableException('Tracker hors ligne'));
      const schedule = HORS_PLAGE();

      // 31 min d'échecs réels → une alerte « impossible » est écrite (id capturé).
      for (let minute = 0; minute < 31; minute++) {
        await service.evaluateOne(schedule);
        await flush();
        jest.advanceTimersByTime(60 * 1000);
      }
      // Puis le lieu est qualifié : le véhicule devient « considéré stationné ».
      engine.requestCommand.mockRejectedValue(new PresumedParkedException(PARKED_MSG));
      for (let minute = 0; minute < 31; minute++) {
        await service.evaluateOne(schedule);
        jest.advanceTimersByTime(60 * 1000);
      }
      await flush();

      expect(prisma.errorLog.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [ALERT_UUID] }, resolvedAt: null },
        data: expect.objectContaining({
          resolvedNote: expect.stringContaining('considéré stationné'),
        }),
      });
    });

    it("une ForbiddenException ORDINAIRE garde le traitement d'échec (le type est le seul discriminant)", async () => {
      jest.useFakeTimers();
      const { service, errorLogger } = buildParked(
        new ForbiddenException("Coupe auto différée : véhicule hors champ GPS depuis 212 min — dernière vitesse connue (27.15 km/h) datée d'avant la perte, non probante"),
      );
      const schedule = HORS_PLAGE();

      for (let minute = 0; minute < 35; minute++) {
        await service.evaluateOne(schedule);
        jest.advanceTimersByTime(60 * 1000);
      }
      // L'alerte « impossible » part bien — c'est elle qui pousse à VALIDER le lieu.
      expect(errorLogger.record).toHaveBeenCalled();
      const [err] = errorLogger.record.mock.calls[0];
      expect((err as Error).message).toContain('hors champ GPS');
    });
  });
});
