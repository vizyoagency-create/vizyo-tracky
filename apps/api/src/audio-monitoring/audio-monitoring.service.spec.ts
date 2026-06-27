import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AudioCommandStatus, UserRole } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { AudioMonitoringService } from './audio-monitoring.service';

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
    audioMonitoringCommand: { create: jest.Mock; update: jest.Mock; findMany: jest.Mock };
    fleet: { findUnique: jest.Mock; findMany: jest.Mock };
    user: { findMany: jest.Mock; findUnique: jest.Mock };
  };
  let email: { send: jest.Mock; buildAudioActivationEmail: jest.Mock };

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
    };

    const config = {
      get: (key: string) => (key === 'NODE_ENV' ? 'development' : undefined),
    } as unknown as ConfigService;

    const module = await Test.createTestingModule({
      providers: [
        AudioMonitoringService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
        { provide: ConfigService, useValue: config },
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
      // Dispatch MOCKÉ → SENT + sentAt.
      expect(prisma.audioMonitoringCommand.update).toHaveBeenCalledWith({
        where: { id: expect.any(String) },
        data: expect.objectContaining({ status: AudioCommandStatus.SENT, sentAt: expect.any(Date) }),
      });
      expect(command.status).toBe(AudioCommandStatus.SENT);
      // Scénario A : on renvoie le n° SIM à appeler.
      expect(simPhoneNumber).toBe('+33656691615');
    });

    // scope tenant : tracker d'une autre flotte → NotFound (fail-closed via where)
    it('returns NotFound for a cross-tenant tracker (fail-closed)', async () => {
      // findFirst renvoie null car le where exige vehicle.fleetId = otherFleetAdmin.fleetId.
      prisma.tracker.findFirst.mockResolvedValue(null);
      await expect(
        service.requestListen(TRACKER_ID, 'vol suspecté', otherFleetAdmin),
      ).rejects.toThrow(NotFoundException);
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
