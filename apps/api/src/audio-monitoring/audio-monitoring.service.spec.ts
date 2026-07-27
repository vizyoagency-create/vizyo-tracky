import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AudioCommandStatus, UserRole } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { AudioMonitoringService } from './audio-monitoring.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const VEHICLE_ID = '00000000-0000-0000-0000-000000000020';
const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET_ID = '00000000-0000-0000-0000-000000000099';
const USER_ID = '00000000-0000-0000-0000-000000000030';

const trackerWithVehicle = {
  id: TRACKER_ID,
  imei: '123456789012345',
  simPhoneNumber: '+33656691615',
  vehicleId: VEHICLE_ID,
  vehicle: {
    id: VEHICLE_ID,
    fleetId: FLEET_ID,
    plate: 'AB-123-CD',
    fleet: { id: FLEET_ID, name: 'Test Fleet' },
  },
};

const createdCommand = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-0000-0000-000000000050',
  trackerId: TRACKER_ID,
  vehicleId: VEHICLE_ID,
  fleetId: FLEET_ID,
  status: AudioCommandStatus.PENDING,
  reason: 'vol suspecté',
  requestedBy: USER_ID,
  requestedByRole: UserRole.FLEET_ADMIN,
  requestedInEnv: 'development',
  source: 'MANUAL',
  lastError: null,
  sentAt: null,
  ackedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const fleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };
const otherFleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: OTHER_FLEET_ID };

describe('AudioMonitoringService', () => {
  let service: AudioMonitoringService;
  let prisma: {
    tracker: { findFirst: jest.Mock };
    fleetAudioConfig: { findUnique: jest.Mock; upsert: jest.Mock; update: jest.Mock };
    audioMonitoringCommand: {
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
    fleet: { findUnique: jest.Mock; findMany: jest.Mock };
    user: { findMany: jest.Mock; findUnique: jest.Mock };
  };
  let email: { send: jest.Mock; buildAudioActivationEmail: jest.Mock; buildAudioInfoEmail: jest.Mock };
  let errorLogger: { record: jest.Mock };
  // Passerelle SMS mockée — JAMAIS de vrai SMS dans les tests. isEnabled()=true + send() OK
  // par défaut ; chaque test ajuste selon le scénario (désactivée, refus, throw).
  let sms: { isEnabled: jest.Mock; send: jest.Mock };
  let systemActivity: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      tracker: { findFirst: jest.fn() },
      fleetAudioConfig: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      audioMonitoringCommand: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(createdCommand(data))),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(createdCommand({ ...data }))),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      fleet: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Test Fleet' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ firstName: 'Jean', lastName: 'Dupont' }),
      },
    };

    email = {
      send: jest.fn().mockResolvedValue({ ok: true }),
      buildAudioActivationEmail: jest
        .fn()
        .mockReturnValue({ subject: 's', html: 'h', text: 't' }),
      buildAudioInfoEmail: jest
        .fn()
        .mockReturnValue({ subject: 'info-s', html: 'info-h', text: 'info-t' }),
    };

    errorLogger = { record: jest.fn().mockResolvedValue('error-id') };

    sms = {
      isEnabled: jest.fn().mockReturnValue(true),
      send: jest.fn().mockResolvedValue({ ok: true }),
    };

    systemActivity = { record: jest.fn() };

    const config = {
      get: (key: string) =>
        key === 'NODE_ENV'
          ? 'development'
          : key === 'AUDIO_DEVICE_PASSWORD'
            ? '123456'
            : undefined,
    } as unknown as ConfigService;

    const module = await Test.createTestingModule({
      providers: [
        AudioMonitoringService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
        { provide: ConfigService, useValue: config },
        { provide: ErrorLogger, useValue: errorLogger },
        { provide: SmsGatewayService, useValue: sms },
        { provide: SystemActivityService, useValue: systemActivity },
      ],
    }).compile();

    service = module.get(AudioMonitoringService);
  });

  describe('requestListen', () => {
    // (#4) motif vide → BadRequest (défense au-delà du DTO)
    it('rejects an empty motif (#4)', async () => {
      await expect(service.requestListen(TRACKER_ID, '   ', fleetAdmin)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.tracker.findFirst).not.toHaveBeenCalled();
    });

    // (#1) gating deux étages — seule l'ÉLIGIBILITÉ N1 posée (consentement N2 manquant) → Forbidden
    it('rejects when only superAdminEnabled is set (N2 missing → both-flags, #1)', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.fleetAudioConfig.findUnique.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: false,
      });
      await expect(
        service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.audioMonitoringCommand.create).not.toHaveBeenCalled();
    });

    // (#1) gating deux étages — seul le CONSENTEMENT N2 posé (éligibilité N1 manquante) → Forbidden
    it('rejects when only assistanceEnabled is set (N1 missing → both-flags, #1)', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.fleetAudioConfig.findUnique.mockResolvedValue({
        superAdminEnabled: false,
        assistanceEnabled: true,
      });
      await expect(
        service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.audioMonitoringCommand.create).not.toHaveBeenCalled();
    });

    // (#1) config absente → Forbidden (fail-closed)
    it('rejects when FleetAudioConfig is missing (fail-closed, #1)', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.fleetAudioConfig.findUnique.mockResolvedValue(null);
      await expect(
        service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin),
      ).rejects.toThrow(ForbiddenException);
    });

    // (#7) audit créé AVANT dispatch (PENDING), puis passe SENT — exige les DEUX étages
    it('creates the audit row before dispatch then marks it SENT when BOTH flags set (#1/#7)', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.fleetAudioConfig.findUnique.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
      });

      const { command, simPhoneNumber } = await service.requestListen(
        TRACKER_ID,
        'vol suspecté',
        fleetAdmin,
      );

      // L'audit est créé en PENDING avec le motif/qui/rôle/env, AVANT toute MAJ.
      expect(prisma.audioMonitoringCommand.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          trackerId: TRACKER_ID,
          vehicleId: VEHICLE_ID,
          fleetId: FLEET_ID,
          status: AudioCommandStatus.PENDING,
          reason: 'vol suspecté',
          requestedBy: USER_ID,
          requestedByRole: UserRole.FLEET_ADMIN,
          requestedInEnv: 'development',
        }),
      });
      // create appelé AVANT update (audit avant dispatch).
      const createOrder = prisma.audioMonitoringCommand.create.mock.invocationCallOrder[0];
      const updateOrder = prisma.audioMonitoringCommand.update.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(updateOrder);
      // ARMEMENT RÉEL : SMS `monitor123456` envoyé à la SIM du boîtier (mode monitor Coban).
      expect(sms.send).toHaveBeenCalledWith(
        '+33656691615',
        'monitor123456',
        expect.objectContaining({ imei: '123456789012345', source: 'audio-monitor' }),
      );
      // Dispatch OK → SENT + sentAt.
      expect(prisma.audioMonitoringCommand.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: expect.objectContaining({ status: AudioCommandStatus.SENT, sentAt: expect.any(Date) }),
      });
      expect(command.status).toBe(AudioCommandStatus.SENT);
      // Scénario A : on renvoie le n° SIM à appeler.
      expect(simPhoneNumber).toBe('+33656691615');
    });

    // ARMEMENT RÉEL — SMS désactivé ⇒ on NE peut PAS armer → FAILED + alerte CRITICAL +
    // ServiceUnavailableException. AUCUN sms.send n'est tenté.
    it('marks FAILED + alerts + throws 503 when the SMS gateway is disabled', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.fleetAudioConfig.findUnique.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
      });
      sms.isEnabled.mockReturnValue(false);

      await expect(
        service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(sms.send).not.toHaveBeenCalled();
      // commande marquée FAILED.
      expect(prisma.audioMonitoringCommand.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: expect.objectContaining({ status: AudioCommandStatus.FAILED }),
      });
      // alerte centre d'alertes (source audio-monitoring, CRITICAL).
      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.any(String),
        'audio-monitoring',
        expect.objectContaining({ trackerId: TRACKER_ID, commandId: expect.any(String) }),
        'CRITICAL',
      );
    });

    // ARMEMENT RÉEL — SIM absente ⇒ pas de numéro pour armer → FAILED + alerte + 503.
    it('marks FAILED + alerts + throws 503 when the tracker has no SIM', async () => {
      prisma.tracker.findFirst.mockResolvedValue({ ...trackerWithVehicle, simPhoneNumber: null });
      prisma.fleetAudioConfig.findUnique.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
      });

      await expect(
        service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(sms.send).not.toHaveBeenCalled();
      expect(prisma.audioMonitoringCommand.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: expect.objectContaining({ status: AudioCommandStatus.FAILED }),
      });
      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.any(String),
        'audio-monitoring',
        expect.objectContaining({ trackerId: TRACKER_ID }),
        'CRITICAL',
      );
    });

    // ARMEMENT RÉEL — la passerelle refuse l'envoi (r.ok=false) → FAILED + alerte + 503.
    it('marks FAILED + alerts + throws 503 when the gateway rejects the monitor SMS', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.fleetAudioConfig.findUnique.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
      });
      sms.send.mockResolvedValue({ ok: false, error: 'HTTP 500' });

      await expect(
        service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(sms.send).toHaveBeenCalledWith('+33656691615', 'monitor123456', expect.any(Object));
      expect(prisma.audioMonitoringCommand.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: expect.objectContaining({ status: AudioCommandStatus.FAILED }),
      });
      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.stringContaining('monitor'),
        'audio-monitoring',
        expect.objectContaining({ trackerId: TRACKER_ID }),
        'CRITICAL',
      );
    });

    // scope tenant : tracker d'une autre flotte → NotFound (fail-closed via where)
    it('returns NotFound for a cross-tenant tracker (fail-closed)', async () => {
      // findFirst renvoie null car le where exige vehicle.fleetId = otherFleetAdmin.fleetId.
      prisma.tracker.findFirst.mockResolvedValue(null);
      await expect(
        service.requestListen(TRACKER_ID, 'vol suspecté', otherFleetAdmin),
      ).rejects.toThrow(NotFoundException);
    });

    // Part A — une panne SYSTÈME au DISPATCH (update SENT qui throw) doit :
    //  (a) marquer la commande FAILED (best-effort, trace d'audit cohérente),
    //  (b) alimenter le centre d'alertes via errorLogger.record(source='audio-monitoring',
    //      niveau CRITICAL),
    //  (c) re-throw l'erreur d'origine.
    it('marks FAILED + records an audio-monitoring CRITICAL alert on a forced dispatch failure', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.fleetAudioConfig.findUnique.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
      });
      const boom = new Error('DB write failed');
      // 1er update (dispatch → SENT) throw ; 2e update (FAILED best-effort) ok.
      prisma.audioMonitoringCommand.update
        .mockRejectedValueOnce(boom)
        .mockResolvedValueOnce(
          createdCommand({ status: AudioCommandStatus.FAILED, lastError: 'DB write failed' }),
        );

      await expect(
        service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin),
      ).rejects.toThrow(boom);

      // (a) commande marquée FAILED + lastError.
      expect(prisma.audioMonitoringCommand.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: expect.objectContaining({
          status: AudioCommandStatus.FAILED,
          lastError: 'DB write failed',
        }),
      });
      // (b) alerte poussée avec la BONNE source + le niveau CRITICAL + le contexte.
      expect(errorLogger.record).toHaveBeenCalledWith(
        boom,
        'audio-monitoring',
        expect.objectContaining({
          trackerId: TRACKER_ID,
          commandId: expect.any(String),
          vehicleId: VEHICLE_ID,
          fleetId: FLEET_ID,
          userId: USER_ID,
        }),
        'CRITICAL',
      );
    });

    // Part A (garde-fou) — un refus de validation ATTENDU (404/403/400) ne doit JAMAIS
    // alimenter le centre d'alertes (ce ne sont pas des erreurs système).
    it('does NOT record an alert for an expected validation throw (empty motif)', async () => {
      await expect(service.requestListen(TRACKER_ID, '   ', fleetAdmin)).rejects.toThrow(
        BadRequestException,
      );
      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    /**
     * Silence prolongé du boîtier : l'écoute reste POSSIBLE (aucune porte « boîtier muet »).
     *
     * Une porte à 72 h avait été posée ici puis retirée à la relecture. `lastSeenAt` ne
     * mesure QUE le lien data (trames TCP/GPRS) ; l'armement part en SMS et l'écoute se
     * fait en APPELANT la SIM — deux porteuses GSM indépendantes du data. Un forfait data
     * épuisé, un APN cassé ou un boîtier arraché de son alimentation data (soit exactement
     * le cas « vol suspecté ») rend le boîtier muet en TCP alors que le SMS et la voix
     * passent encore. La route étant purement manuelle (1 SMS par clic humain, pas de
     * boucle d'automate), bloquer coûterait une capacité d'enquête pour économiser 2 SMS.
     */
    describe('silence prolongé du boîtier — la voie SMS reste ouverte', () => {
      const HOUR = 60 * 60 * 1000;
      const DAY = 24 * HOUR;
      const withLastSeen = (ms: number | null) => ({
        ...trackerWithVehicle,
        lastSeenAt: ms === null ? null : new Date(Date.now() - ms),
      });
      const bothFlagsOn = () =>
        prisma.fleetAudioConfig.findUnique.mockResolvedValue({
          superAdminEnabled: true,
          assistanceEnabled: true,
        });

      // LE cas à ne pas casser : boîtier muet en data depuis 89 j (prod : FV-941-LZ). La SIM
      // peut parfaitement répondre au SMS — l'opérateur doit pouvoir tenter le micro.
      it('arme quand même le micro sur un boîtier muet depuis 89 jours (SMS ≠ data)', async () => {
        prisma.tracker.findFirst.mockResolvedValue(withLastSeen(89 * DAY));
        bothFlagsOn();

        const { command } = await service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin);

        expect(command.status).toBe(AudioCommandStatus.SENT);
        expect(sms.send).toHaveBeenCalledWith('+33656691615', 'monitor123456', expect.any(Object));
      });

      // La trace ne dépend pas d'une porte : la ligne d'audit est créée AVANT tout envoi,
      // donc une tentative sur boîtier injoignable reste lisible (traçabilité légale).
      it('crée la ligne d\'audit avant l\'envoi, même sur un boîtier muet', async () => {
        prisma.tracker.findFirst.mockResolvedValue(withLastSeen(89 * DAY));
        bothFlagsOn();

        await service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin);

        expect(prisma.audioMonitoringCommand.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: AudioCommandStatus.PENDING,
              reason: 'vol suspecté',
            }),
          }),
        );
      });

      // Un silence de 2 h (stationnement normal) n'a évidemment jamais rien changé non plus.
      it('laisse armer un boîtier silencieux depuis 2 h', async () => {
        prisma.tracker.findFirst.mockResolvedValue(withLastSeen(2 * HOUR));
        bothFlagsOn();

        const { command } = await service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin);

        expect(command.status).toBe(AudioCommandStatus.SENT);
        expect(sms.send).toHaveBeenCalledWith('+33656691615', 'monitor123456', expect.any(Object));
      });

      // Boîtier jamais vu (lastSeenAt null) : chemin historique inchangé.
      it('ne bloque pas un boîtier qui n\'a jamais émis (lastSeenAt null)', async () => {
        prisma.tracker.findFirst.mockResolvedValue(withLastSeen(null));
        bothFlagsOn();

        await service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin);

        expect(sms.send).toHaveBeenCalled();
      });

      // Le gating flotte (garde de sécurité) reste PRIORITAIRE et intact : aucune dormance
      // ne doit jamais servir de raccourci au-dessus d'un refus d'habilitation.
      it('refuse toujours quand le mode assistance n\'est pas consenti (403)', async () => {
        prisma.tracker.findFirst.mockResolvedValue(withLastSeen(89 * DAY));
        prisma.fleetAudioConfig.findUnique.mockResolvedValue({
          superAdminEnabled: true,
          assistanceEnabled: false,
        });

        await expect(
          service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin),
        ).rejects.toThrow(ForbiddenException);
        expect(sms.send).not.toHaveBeenCalled();
      });
    });

    // Non-régression — le chemin nominal (dispatch OK) ne loggue AUCUNE alerte.
    it('does NOT record an alert on a successful listen', async () => {
      prisma.tracker.findFirst.mockResolvedValue(trackerWithVehicle);
      prisma.fleetAudioConfig.findUnique.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
      });
      await service.requestListen(TRACKER_ID, 'vol suspecté', fleetAdmin);
      expect(errorLogger.record).not.toHaveBeenCalled();
    });
  });

  describe('stopListen (DISARM — retour mode track)', () => {
    // tracker mocké pour le SELECT de stopListen (id/imei/simPhoneNumber/vehicle).
    const stopTracker = {
      id: TRACKER_ID,
      imei: '123456789012345',
      simPhoneNumber: '+33656691615',
      vehicle: { id: VEHICLE_ID, fleetId: FLEET_ID },
    };

    // Désarmement nominal : envoie `tracker123456` + pose disarmedAt sur l'écoute armée
    // la plus récente (SENT + disarmedAt null).
    it('sends tracker123456 and stamps disarmedAt on the most recent armed command', async () => {
      prisma.tracker.findFirst.mockResolvedValue(stopTracker);
      prisma.audioMonitoringCommand.findFirst.mockResolvedValue({ id: 'armed-cmd-id' });

      const res = await service.stopListen(TRACKER_ID, superAdmin);

      expect(sms.send).toHaveBeenCalledWith(
        '+33656691615',
        'tracker123456',
        expect.objectContaining({ imei: '123456789012345', source: 'audio-disarm' }),
      );
      // recherche de l'écoute armée la plus récente.
      expect(prisma.audioMonitoringCommand.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { trackerId: TRACKER_ID, status: AudioCommandStatus.SENT, disarmedAt: null },
          orderBy: { sentAt: 'desc' },
        }),
      );
      // disarmedAt posé sur cette ligne.
      expect(prisma.audioMonitoringCommand.update).toHaveBeenCalledWith({
        where: { id: 'armed-cmd-id' },
        data: { disarmedAt: expect.any(Date) },
      });
      expect(res.ok).toBe(true);
    });

    // Aucune écoute armée trouvée → on envoie quand même le désarmement (forcer un boîtier
    // qu'on croit en monitor) mais on ne pose pas de disarmedAt (no-op update).
    it('still sends the disarm SMS when no armed command exists (no stamp)', async () => {
      prisma.tracker.findFirst.mockResolvedValue(stopTracker);
      prisma.audioMonitoringCommand.findFirst.mockResolvedValue(null);

      const res = await service.stopListen(TRACKER_ID, superAdmin);

      expect(sms.send).toHaveBeenCalledWith('+33656691615', 'tracker123456', expect.any(Object));
      expect(prisma.audioMonitoringCommand.update).not.toHaveBeenCalled();
      expect(res.ok).toBe(true);
    });

    // Échec d'envoi (passerelle refuse) → alerte centre d'alertes, ok=false.
    it('records an alert when the disarm SMS is rejected', async () => {
      prisma.tracker.findFirst.mockResolvedValue(stopTracker);
      prisma.audioMonitoringCommand.findFirst.mockResolvedValue({ id: 'armed-cmd-id' });
      sms.send.mockResolvedValue({ ok: false, error: 'HTTP 500' });

      const res = await service.stopListen(TRACKER_ID, superAdmin);

      expect(res.ok).toBe(false);
      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.stringContaining('tracker'),
        'audio-monitoring',
        expect.objectContaining({ trackerId: TRACKER_ID }),
        'CRITICAL',
      );
    });

    // SMS désactivé → 503 + alerte, aucun envoi.
    it('throws 503 when the SMS gateway is disabled', async () => {
      prisma.tracker.findFirst.mockResolvedValue(stopTracker);
      sms.isEnabled.mockReturnValue(false);
      await expect(service.stopListen(TRACKER_ID, superAdmin)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(sms.send).not.toHaveBeenCalled();
    });

    // La porte « boîtier muet » ne s'applique PAS au désarmement, volontairement : elle
    // retient ce qui aggrave, jamais ce qui restaure. Un boîtier peut s'être tu JUSTEMENT
    // parce qu'il est resté en mode monitor (ce mode coupe le report GPS) — refuser le
    // désarmement l'y enfermerait définitivement.
    it('désarme quand même un boîtier muet depuis 89 jours (jamais de porte sur une restauration)', async () => {
      prisma.tracker.findFirst.mockResolvedValue({
        ...stopTracker,
        lastSeenAt: new Date(Date.now() - 89 * 24 * 60 * 60 * 1000),
      });
      prisma.audioMonitoringCommand.findFirst.mockResolvedValue({ id: 'armed-cmd-id' });

      const res = await service.stopListen(TRACKER_ID, superAdmin);

      expect(sms.send).toHaveBeenCalledWith('+33656691615', 'tracker123456', expect.any(Object));
      expect(res.ok).toBe(true);
    });

    // tracker introuvable (cross-tenant pour un non-super) → NotFound, aucun envoi.
    it('throws NotFound for an unknown/cross-tenant tracker', async () => {
      prisma.tracker.findFirst.mockResolvedValue(null);
      await expect(service.stopListen(TRACKER_ID, otherFleetAdmin)).rejects.toThrow(
        NotFoundException,
      );
      expect(sms.send).not.toHaveBeenCalled();
    });
  });

  // Helper : seed la config existante lue par le gate d'éligibilité (N1) de
  // setFleetAssistanceMode. eligible=true ⇒ la flotte est ÉLIGIBLE (N1 posé).
  const eligibleConfig = (eligible = true) =>
    prisma.fleetAudioConfig.findUnique.mockResolvedValue({ superAdminEnabled: eligible });

  describe('setFleetEligibility (N1 — super-admin)', () => {
    // poser l'éligibilité : upsert superAdminEnabled, assistanceEnabled inchangé si true.
    it('sets superAdminEnabled=true (fleet becomes eligible)', async () => {
      prisma.fleetAudioConfig.upsert.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: false,
        attestedAt: null,
        attestationVersion: null,
        activationEmailSentAt: null,
      });
      const result = await service.setFleetEligibility(FLEET_ID, true, superAdmin);
      expect(prisma.fleetAudioConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { fleetId: FLEET_ID },
          update: expect.objectContaining({ superAdminEnabled: true }),
        }),
      );
      expect(result.superAdminEnabled).toBe(true);
    });

    // retirer l'éligibilité (false) CASCADE : assistanceEnabled forcé à false (tout OFF).
    it('eligible=false cascades assistanceEnabled to false (tout OFF)', async () => {
      prisma.fleetAudioConfig.upsert.mockResolvedValue({
        superAdminEnabled: false,
        assistanceEnabled: false,
        attestedAt: null,
        attestationVersion: null,
        activationEmailSentAt: null,
      });
      await service.setFleetEligibility(FLEET_ID, false, superAdmin);
      // l'update DOIT inclure assistanceEnabled:false (cascade).
      expect(prisma.fleetAudioConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            superAdminEnabled: false,
            assistanceEnabled: false,
          }),
        }),
      );
    });
  });

  describe('setFleetAssistanceMode (N2 — fleet-admin)', () => {
    // (N1) flotte NON éligible (superAdminEnabled false) → Forbidden, AVANT toute écriture.
    it('rejects when the fleet is not eligible (superAdminEnabled false → 403)', async () => {
      eligibleConfig(false);
      await expect(
        service.setFleetAssistanceMode(
          FLEET_ID,
          { assistanceEnabled: true, attestation: true },
          fleetAdmin,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.fleetAudioConfig.upsert).not.toHaveBeenCalled();
    });

    // (N1) config absente → non éligible → Forbidden (fail-closed).
    it('rejects when no config exists (not eligible, fail-closed → 403)', async () => {
      prisma.fleetAudioConfig.findUnique.mockResolvedValue(null);
      await expect(
        service.setFleetAssistanceMode(
          FLEET_ID,
          { assistanceEnabled: true, attestation: true },
          fleetAdmin,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.fleetAudioConfig.upsert).not.toHaveBeenCalled();
    });

    // (#5) activer sans attestation → BadRequest (flotte éligible).
    it('rejects enabling without attestation (#5)', async () => {
      eligibleConfig(true);
      await expect(
        service.setFleetAssistanceMode(FLEET_ID, { assistanceEnabled: true }, fleetAdmin),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.fleetAudioConfig.upsert).not.toHaveBeenCalled();
    });

    // (#6) activer avec attestation par un acteur NON super-admin → mail envoyé
    //      + activationEmailSentAt posé
    it('enabling sends the obligations mail and sets activationEmailSentAt (#6)', async () => {
      eligibleConfig(true);
      prisma.fleetAudioConfig.upsert.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
        attestedAt: new Date(),
        attestationVersion: 'v1',
        activationEmailSentAt: null,
      });
      prisma.user.findMany.mockResolvedValue([
        { email: 'a@test.fr' },
        { email: 'b@test.fr' },
      ]);

      const result = await service.setFleetAssistanceMode(
        FLEET_ID,
        { assistanceEnabled: true, attestation: true, attestationVersion: 'v1' },
        fleetAdmin,
      );

      // mail OBLIGATIONS construit + envoyé à chaque user actif de la flotte.
      expect(email.buildAudioActivationEmail).toHaveBeenCalled();
      expect(email.send).toHaveBeenCalledTimes(2);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { fleetId: FLEET_ID, isActive: true },
        select: { email: true },
      });
      // activationEmailSentAt persisté (trace #6).
      expect(prisma.fleetAudioConfig.update).toHaveBeenCalledWith({
        where: { fleetId: FLEET_ID },
        data: expect.objectContaining({ activationEmailSentAt: expect.any(Date) }),
      });
      expect(result.assistanceEnabled).toBe(true);
      expect(result.activationEmailSentAt).not.toBeNull();
    });

    // Part A — un ÉCHEC d'envoi du mail OBLIGATIONS est best-effort (l'activation est
    // conservée, stamp laissé null) MAIS doit devenir VISIBLE au centre d'alertes via
    // errorLogger.record(source='audio-monitoring', niveau ERROR).
    it('records an audio-monitoring ERROR alert when the activation mail fails (#6)', async () => {
      eligibleConfig(true);
      prisma.fleetAudioConfig.upsert.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
        attestedAt: new Date(),
        attestationVersion: 'v1',
        activationEmailSentAt: null,
      });
      prisma.user.findMany.mockResolvedValue([{ email: 'a@test.fr' }]);
      // L'envoi du mail échoue → sendActivationEmails catch → alerte ERROR.
      email.send.mockRejectedValue(new Error('SMTP down'));

      const result = await service.setFleetAssistanceMode(
        FLEET_ID,
        { assistanceEnabled: true, attestation: true, attestationVersion: 'v1' },
        fleetAdmin,
      );

      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.any(Error),
        'audio-monitoring',
        expect.objectContaining({ fleetId: FLEET_ID }),
        'ERROR',
      );
      // Activation conservée, mais on ne prétend pas avoir notifié la flotte (#6 honnête).
      expect(result.assistanceEnabled).toBe(true);
      expect(result.activationEmailSentAt).toBeNull();
    });

    // désactiver → pas de mail, pas d'attestation exigée (flotte éligible).
    it('disabling does not require attestation and sends no mail', async () => {
      eligibleConfig(true);
      prisma.fleetAudioConfig.upsert.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: false,
        attestedAt: null,
        attestationVersion: null,
        activationEmailSentAt: null,
      });
      await service.setFleetAssistanceMode(FLEET_ID, { assistanceEnabled: false }, fleetAdmin);
      expect(email.send).not.toHaveBeenCalled();
    });

    // tenant : un FLEET_ADMIN configurant une AUTRE flotte → Forbidden (avant le gate N1).
    it('rejects a FLEET_ADMIN configuring another fleet (tenant)', async () => {
      await expect(
        service.setFleetAssistanceMode(
          OTHER_FLEET_ID,
          { assistanceEnabled: true, attestation: true },
          fleetAdmin,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.fleetAudioConfig.upsert).not.toHaveBeenCalled();
    });

    // SUPER_ADMIN peut configurer n'importe quelle flotte ÉLIGIBLE.
    it('allows SUPER_ADMIN to configure any eligible fleet', async () => {
      eligibleConfig(true);
      prisma.fleetAudioConfig.upsert.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
        attestedAt: new Date(),
        attestationVersion: null,
        activationEmailSentAt: null,
      });
      await expect(
        service.setFleetAssistanceMode(
          OTHER_FLEET_ID,
          { assistanceEnabled: true, attestation: true },
          superAdmin,
        ),
      ).resolves.toBeDefined();
      expect(prisma.fleetAudioConfig.upsert).toHaveBeenCalled();
    });

    // Sprint 4 — activation SUPER_ADMIN (phase de test interne) → AUCUN mail OBLIGATIONS
    //   (la flotte ne doit pas être notifiée d'une bascule technique) et
    //   activationEmailSentAt reste null.
    it('does NOT send the obligations mail on a SUPER_ADMIN activation (test phase, stamp stays null)', async () => {
      eligibleConfig(true);
      prisma.fleetAudioConfig.upsert.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
        attestedAt: new Date(),
        attestationVersion: 'v1',
        activationEmailSentAt: null,
      });
      prisma.user.findMany.mockResolvedValue([
        { email: 'a@test.fr' },
        { email: 'b@test.fr' },
      ]);

      const result = await service.setFleetAssistanceMode(
        FLEET_ID,
        { assistanceEnabled: true, attestation: true, attestationVersion: 'v1' },
        superAdmin,
      );

      // aucun mail construit ni envoyé, pas de persistance d'horodatage d'envoi.
      expect(email.buildAudioActivationEmail).not.toHaveBeenCalled();
      expect(email.send).not.toHaveBeenCalled();
      expect(prisma.fleetAudioConfig.update).not.toHaveBeenCalled();
      // activationEmailSentAt reste null (la flotte n'a pas été notifiée).
      expect(result.activationEmailSentAt).toBeNull();
      expect(result.assistanceEnabled).toBe(true);
    });
  });

  describe('getFleetAudioConfig', () => {
    // tenant : un FLEET_ADMIN lisant une AUTRE flotte → Forbidden
    it('rejects a FLEET_ADMIN reading another fleet (tenant)', async () => {
      await expect(
        service.getFleetAudioConfig(OTHER_FLEET_ID, fleetAdmin),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.fleetAudioConfig.findUnique).not.toHaveBeenCalled();
    });

    // own fleet → ok (renvoie l'état des DEUX étages + attestation)
    it('returns the config for the own fleet (both flags)', async () => {
      const attestedAt = new Date();
      prisma.fleetAudioConfig.findUnique.mockResolvedValue({
        superAdminEnabled: true,
        assistanceEnabled: true,
        attestedAt,
        attestationVersion: 'v1',
        activationEmailSentAt: attestedAt,
      });
      const result = await service.getFleetAudioConfig(FLEET_ID, fleetAdmin);
      expect(prisma.fleetAudioConfig.findUnique).toHaveBeenCalledWith({
        where: { fleetId: FLEET_ID },
      });
      expect(result).toEqual({
        superAdminEnabled: true,
        assistanceEnabled: true,
        attestedAt: attestedAt.toISOString(),
        attestationVersion: 'v1',
        activationEmailSentAt: attestedAt.toISOString(),
      });
    });

    // own fleet sans config → fail-closed (les deux étages false + nulls)
    it('returns a fail-closed default when no config exists', async () => {
      prisma.fleetAudioConfig.findUnique.mockResolvedValue(null);
      const result = await service.getFleetAudioConfig(FLEET_ID, fleetAdmin);
      expect(result).toEqual({
        superAdminEnabled: false,
        assistanceEnabled: false,
        attestedAt: null,
        attestationVersion: null,
        activationEmailSentAt: null,
      });
    });
  });

  describe('sendAudioInfoMail (info à la demande — super-admin)', () => {
    const RECIPIENT_ID = '00000000-0000-0000-0000-000000000040';

    // envoi nominal : charge le user (+ flotte), construit le template info-mail,
    // et l'envoie via email.send avec le contexte feature='audio-info'.
    it('sends the audio-info template to a known user', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        email: 'anouar@test.fr',
        firstName: 'Anouar',
        lastName: 'B',
        fleet: { name: 'Flotte Anouar' },
      });

      const res = await service.sendAudioInfoMail(RECIPIENT_ID, superAdmin);

      // template info construit avec le nom + la flotte du destinataire.
      expect(email.buildAudioInfoEmail).toHaveBeenCalledWith(
        expect.objectContaining({ recipientName: 'Anouar B', fleetName: 'Flotte Anouar' }),
      );
      // mail envoyé au bon destinataire + contexte feature='audio-info'.
      expect(email.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'anouar@test.fr',
          subject: 'info-s',
          html: 'info-h',
          text: 'info-t',
          context: expect.objectContaining({ feature: 'audio-info', userId: RECIPIENT_ID }),
        }),
      );
      expect(res).toEqual({ ok: true, sentTo: 'anouar@test.fr' });
      // aucun échec → pas d'alerte.
      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    // utilisateur inconnu → NotFound, aucun mail envoyé.
    it('throws NotFound for an unknown user (no mail sent)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.sendAudioInfoMail(RECIPIENT_ID, superAdmin)).rejects.toThrow(
        NotFoundException,
      );
      expect(email.send).not.toHaveBeenCalled();
    });

    // échec d'envoi (provider KO) → alerte ERROR au centre d'alertes, mais réponse ok.
    it('records an audio-monitoring ERROR alert when the send fails', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: RECIPIENT_ID,
        email: 'anouar@test.fr',
        firstName: 'Anouar',
        lastName: 'B',
        fleet: { name: 'Flotte Anouar' },
      });
      email.send.mockResolvedValue({ ok: false, error: 'provider down' });

      const res = await service.sendAudioInfoMail(RECIPIENT_ID, superAdmin);

      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.stringContaining('Mode assistance'),
        'audio-monitoring',
        expect.objectContaining({ userId: RECIPIENT_ID }),
        'ERROR',
      );
      expect(res).toEqual({ ok: true, sentTo: 'anouar@test.fr' });
    });
  });

  describe('getFleetsWithAudio (super-admin)', () => {
    // left-join fleets ⟕ FleetAudioConfig : config absente ⇒ both false ; présente ⇒ reflète l'état.
    it('lists all fleets with their two-stage state (missing config ⇒ both false)', async () => {
      prisma.fleet.findMany.mockResolvedValue([
        { id: 'f1', name: 'Alpha', audioConfig: { superAdminEnabled: true, assistanceEnabled: true } },
        { id: 'f2', name: 'Bravo', audioConfig: { superAdminEnabled: true, assistanceEnabled: false } },
        { id: 'f3', name: 'Charlie', audioConfig: null },
      ]);
      const rows = await service.getFleetsWithAudio(superAdmin);
      // tri par nom demandé à Prisma.
      expect(prisma.fleet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { name: 'asc' } }),
      );
      expect(rows).toEqual([
        { fleetId: 'f1', fleetName: 'Alpha', superAdminEnabled: true, assistanceEnabled: true },
        { fleetId: 'f2', fleetName: 'Bravo', superAdminEnabled: true, assistanceEnabled: false },
        { fleetId: 'f3', fleetName: 'Charlie', superAdminEnabled: false, assistanceEnabled: false },
      ]);
    });
  });

  describe('getAudit', () => {
    const auditRow = {
      id: 'c1',
      status: AudioCommandStatus.SENT,
      requestedBy: USER_ID,
      requestedByRole: UserRole.FLEET_ADMIN,
      requestedInEnv: 'production',
      reason: 'vol',
      source: 'MANUAL',
      lastError: null,
      createdAt: new Date(),
      sentAt: new Date(),
      tracker: { imei: '123456789012345', vehicle: { plate: 'AB-123-CD' } },
    };

    // FLEET_ADMIN → scope sa flotte
    it('scopes a FLEET_ADMIN to their own fleet', async () => {
      prisma.audioMonitoringCommand.findMany.mockResolvedValue([auditRow]);
      const rows = await service.getAudit({}, fleetAdmin);
      expect(prisma.audioMonitoringCommand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fleetId: FLEET_ID }) }),
      );
      expect(rows[0]).toMatchObject({ action: 'LISTEN', trackerImei: '123456789012345' });
    });

    // SUPER_ADMIN → pas de filtre flotte (voit tout)
    it('does not scope a SUPER_ADMIN by fleet (sees all)', async () => {
      prisma.audioMonitoringCommand.findMany.mockResolvedValue([]);
      await service.getAudit({}, superAdmin);
      const arg = prisma.audioMonitoringCommand.findMany.mock.calls[0][0];
      expect(arg.where.fleetId).toBeUndefined();
    });

    // DENY (non-super sans flotte) → vide, aucune requête
    it('returns empty for a non-super user without fleet (DENY)', async () => {
      const rows = await service.getAudit(
        {},
        { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: null },
      );
      expect(rows).toEqual([]);
      expect(prisma.audioMonitoringCommand.findMany).not.toHaveBeenCalled();
    });
  });
});
