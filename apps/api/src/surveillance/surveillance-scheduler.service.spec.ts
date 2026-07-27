import { Test } from '@nestjs/testing';
import { SurveillanceMode } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { SurveillanceService } from './surveillance.service';
import { SurveillanceSchedulerService } from './surveillance-scheduler.service';

const TRACKER_ID = '00000000-0000-0000-0000-0000000000aa';
const VEHICLE_ID = '00000000-0000-0000-0000-0000000000bb';
const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000030';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Fabrique un profil FULL_TIME (donc « doit être armé en permanence ») non encore armé :
 * c'est la configuration qui, chaque minute, déclenchait un armement.
 */
function profile(overrides: {
  lastSeenAt?: Date | null;
  hasTracker?: boolean;
  currentlyArmed?: boolean;
  plate?: string;
}) {
  const hasTracker = overrides.hasTracker ?? true;
  return {
    id: 'profile-1',
    vehicleId: VEHICLE_ID,
    fleetId: FLEET_ID,
    createdBy: USER_ID,
    mode: SurveillanceMode.FULL_TIME,
    currentlyArmed: overrides.currentlyArmed ?? false,
    sensitivity: 'MEDIUM',
    scheduleStartTime: null,
    scheduleEndTime: null,
    scheduleDays: null,
    vehicle: {
      fleetId: FLEET_ID,
      plate: overrides.plate ?? 'FV-941-LZ',
      tracker: hasTracker
        ? { id: TRACKER_ID, lastSeenAt: overrides.lastSeenAt ?? new Date() }
        : null,
    },
  };
}

/**
 * Porte « boîtier muet » du planificateur antivol (seuil AGIR = 72 h).
 *
 * Cas réel reproduit ici : FV-941-LZ, profil FULL_TIME, boîtier muet depuis 89 jours.
 * Ce cron tourne CHAQUE minute et, `currentlyArmed` restant à false après chaque échec,
 * il retentait indéfiniment — ~1440 lignes `tracker_commands` FAILED par jour.
 */
describe('SurveillanceSchedulerService — porte « boîtier muet » (72 h)', () => {
  let service: SurveillanceSchedulerService;
  let prisma: { surveillanceProfile: { findMany: jest.Mock } };
  let surveillance: { armProfile: jest.Mock; disarmProfile: jest.Mock };
  let errorLogger: { recordBackground: jest.Mock };
  let systemActivity: { record: jest.Mock };

  beforeEach(async () => {
    prisma = { surveillanceProfile: { findMany: jest.fn().mockResolvedValue([]) } };
    surveillance = {
      armProfile: jest.fn().mockResolvedValue({}),
      disarmProfile: jest.fn().mockResolvedValue({}),
    };
    errorLogger = { recordBackground: jest.fn() };
    systemActivity = { record: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        SurveillanceSchedulerService,
        { provide: PrismaService, useValue: prisma },
        { provide: SurveillanceService, useValue: surveillance },
        { provide: ErrorLogger, useValue: errorLogger },
        { provide: SystemActivityService, useValue: systemActivity },
      ],
    }).compile();

    service = module.get(SurveillanceSchedulerService);
  });

  // (a) LE cas qui motive la porte : boîtier muet depuis 89 jours → aucune commande.
  it('n\'arme pas un véhicule dont le boîtier est muet depuis 89 jours', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 89 * DAY) }),
    ]);

    await service.run();

    expect(surveillance.armProfile).not.toHaveBeenCalled();
    // Sortie sèche : pas d'erreur remontée au centre d'alertes non plus.
    expect(errorLogger.recordBackground).not.toHaveBeenCalled();
  });

  // (b) Un silence NORMAL (véhicule garé pour la nuit) ne doit rien changer.
  it('arme normalement un véhicule silencieux depuis 2 h (stationnement, pas dormance)', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 2 * HOUR) }),
    ]);

    await service.run();

    expect(surveillance.armProfile).toHaveBeenCalledTimes(1);
  });

  // Frontière du seuil : 71 h agit encore, 73 h ne doit plus agir.
  it('agit encore à 71 h de silence et plus du tout à 73 h', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 71 * HOUR) }),
    ]);
    await service.run();
    expect(surveillance.armProfile).toHaveBeenCalledTimes(1);

    surveillance.armProfile.mockClear();
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 73 * HOUR) }),
    ]);
    await service.run();
    expect(surveillance.armProfile).not.toHaveBeenCalled();
  });

  // (c) « Jamais connecté » n'est PAS « s'est tu » : un véhicule sans boîtier (TEST-001-XX
  // en prod) n'est pas dormant. On ne change RIEN à son traitement existant.
  it('ne traite pas comme dormant un véhicule SANS boîtier', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ hasTracker: false, plate: 'TEST-001-XX' }),
    ]);

    await service.run();

    expect(surveillance.armProfile).toHaveBeenCalledTimes(1);
  });

  // …ni un boîtier affecté qui n'a JAMAIS émis (lastSeenAt null) : autre problème
  // (provisioning SIM/APN), déjà nommé NOT_CONFIGURED ailleurs.
  it('ne traite pas comme dormant un boîtier qui n\'a jamais émis (lastSeenAt null)', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: null }),
    ]);

    await service.run();

    expect(surveillance.armProfile).toHaveBeenCalledTimes(1);
  });

  // (d) Réintégration automatique : aucun drapeau à lever, aucune action manuelle.
  it('réintègre le véhicule dès que lastSeenAt redevient frais', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 89 * DAY) }),
    ]);
    await service.run();
    expect(surveillance.armProfile).not.toHaveBeenCalled();

    // Le boîtier ré-émet : rien d'autre n'a changé en base.
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 30 * 1000) }),
    ]);
    await service.run();
    expect(surveillance.armProfile).toHaveBeenCalledTimes(1);
  });

  // Le DÉSARMEMENT d'un dormant est lui aussi suspendu : le boîtier est injoignable,
  // écrire « désarmé » serait affirmer un état physique qu'on ne peut pas obtenir.
  // L'état affiché reste le dernier état réellement connu, et il n'est pas effacé.
  it('ne désarme pas non plus un dormant (pas de faux état « désarmé »)', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      {
        ...profile({ lastSeenAt: new Date(Date.now() - 52 * DAY), currentlyArmed: true }),
        mode: SurveillanceMode.SCHEDULED,
        scheduleStartTime: '00:00',
        scheduleEndTime: '00:01', // fenêtre déjà refermée → désarmement attendu
        scheduleDays: null,
      },
    ]);

    await service.run();

    expect(surveillance.disarmProfile).not.toHaveBeenCalled();
    expect(surveillance.armProfile).not.toHaveBeenCalled();
  });

  // On EXCLUT, donc on EXPOSE — et sur la surface que l'exploitant REGARDE. Avant la
  // porte, chaque échec écrivait une ligne SURVEILLANCE (FAILURE) au journal Système ;
  // s'en tenir à un log Docker ferait disparaître de l'écran un antivol qui n'arme plus.
  it('trace l\'exclusion au journal Système, par véhicule (SKIPPED)', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 89 * DAY), plate: 'FV-941-LZ' }),
    ]);

    await service.run();

    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'SURVEILLANCE',
        action: 'surveillance_skipped_dormant',
        status: 'SKIPPED',
        actor: 'planning',
        target: 'FV-941-LZ',
        fleetId: FLEET_ID,
        detail: expect.stringContaining('89 j'),
      }),
    );
  });

  // …au même palier horaire que l'ancienne ligne d'échec : le cron tourne chaque minute.
  it('n\'écrit qu\'une ligne de journal par heure et par profil', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 89 * DAY) }),
    ]);

    await service.run();
    await service.run();
    await service.run();

    expect(systemActivity.record).toHaveBeenCalledTimes(1);
  });

  // Un véhicule VIVANT ne produit évidemment aucune ligne « en attente ».
  it('n\'écrit aucune ligne pour un véhicule vivant', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([profile({ lastSeenAt: new Date() })]);

    await service.run();

    expect(systemActivity.record).not.toHaveBeenCalled();
  });

  // On EXCLUT, donc on COMPTE et on EXPOSE : le nombre de véhicules retirés du
  // traitement doit apparaître, sinon l'exploitant croit son antivol actif.
  it('expose le nombre de profils exclus (résumé lisible)', async () => {
    const warn = jest.spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn');
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 89 * DAY), plate: 'FV-941-LZ' }),
      profile({ lastSeenAt: new Date(Date.now() - 52 * DAY), plate: 'FL-787-KV' }),
    ]);

    await service.run();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 profil(s)'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FV-941-LZ'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('89 j'));
  });

  // …mais une seule fois par heure : le cron tourne chaque minute et la dormance dure
  // des semaines. Sans palier, 1440 lignes de log par jour répéteraient le même fait.
  it('ne répète pas le résumé à chaque tick (palier anti-flood)', async () => {
    const warn = jest.spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn');
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 89 * DAY) }),
    ]);

    await service.run();
    await service.run();
    await service.run();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Un dormant ne doit pas empêcher les autres véhicules de la flotte d'être armés.
  it('continue de traiter les véhicules vivants du même tick', async () => {
    prisma.surveillanceProfile.findMany.mockResolvedValue([
      profile({ lastSeenAt: new Date(Date.now() - 89 * DAY), plate: 'FV-941-LZ' }),
      { ...profile({ lastSeenAt: new Date() , plate: 'AB-123-CD' }), id: 'profile-2' },
    ]);

    await service.run();

    expect(surveillance.armProfile).toHaveBeenCalledTimes(1);
    expect(surveillance.armProfile.mock.calls[0][0].id).toBe('profile-2');
  });
});
