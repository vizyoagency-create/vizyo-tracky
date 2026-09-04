/**
 * Lot V5 — le réglage des alertes de vitesse : qui peut lire et écrire quoi, et ce qui
 * est écrit.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { SpeedAlertSettingsService } from './speed-alert-settings.service';

const FLEET = '00000000-0000-0000-0000-00000000000f';
const AUTRE = '00000000-0000-0000-0000-0000000000aa';

const superAdmin = { id: 'sa', email: 'sa@vizyo', role: UserRole.SUPER_ADMIN, fleetId: null } as unknown as AuthUser;
const fleetAdmin = { id: 'fa', email: 'fa@client', role: UserRole.FLEET_ADMIN, fleetId: FLEET } as unknown as AuthUser;

const fleetRow = (patch: Record<string, unknown> = {}) => ({
  id: FLEET, name: 'MH Cars',
  speedAlertEnabled: false, speedAlertOverKmh: 20, speedAlertAbsoluteKmh: 130,
  speedAlertUpdatedAt: null, speedAlertUpdatedById: null,
  ...patch,
});

describe('SpeedAlertSettingsService', () => {
  let service: SpeedAlertSettingsService;
  let prisma: {
    fleet: { findUnique: jest.Mock; update: jest.Mock };
    vehicle: { findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    user: { findUnique: jest.Mock; findMany: jest.Mock };
    tripAnalysis: { findMany: jest.Mock };
    trip: { findMany: jest.Mock };
    pushSubscription: { count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      fleet: { findUnique: jest.fn().mockResolvedValue(fleetRow()), update: jest.fn().mockResolvedValue({}) },
      vehicle: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue({ firstName: 'Youness', lastName: 'H.', email: 'y@vizyo' }), findMany: jest.fn().mockResolvedValue([]) },
      // Essai à blanc : il LIT des analyses et des trajets, il n'écrit nulle part.
      tripAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
      trip: { findMany: jest.fn().mockResolvedValue([]) },
      pushSubscription: { count: jest.fn().mockResolvedValue(1) },
    };
    const module = await Test.createTestingModule({
      providers: [SpeedAlertSettingsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(SpeedAlertSettingsService);
  });

  describe('périmètre', () => {
    it('un super-admin doit désigner une société', async () => {
      await expect(service.get(superAdmin)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.get(superAdmin, FLEET)).resolves.toMatchObject({ fleetId: FLEET, enabled: false, overKmh: 20 });
    });

    it('un administrateur de flotte ne règle que la sienne', async () => {
      await expect(service.get(fleetAdmin, AUTRE)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.get(fleetAdmin)).resolves.toMatchObject({ fleetId: FLEET });
      await expect(service.get({ ...fleetAdmin, fleetId: null } as AuthUser)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('écriture', () => {
    it('écrit le réglage avec son auteur et sa date, et rend l’auteur nommé', async () => {
      prisma.fleet.findUnique.mockResolvedValue(fleetRow({ speedAlertEnabled: true, speedAlertOverKmh: 30, speedAlertAbsoluteKmh: null, speedAlertUpdatedAt: new Date('2026-09-03T10:00:00Z'), speedAlertUpdatedById: 'sa' }));

      const dto = await service.set(superAdmin, { enabled: true, overKmh: 30, absoluteKmh: null }, FLEET);

      expect(prisma.fleet.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: FLEET },
        data: expect.objectContaining({ speedAlertEnabled: true, speedAlertOverKmh: 30, speedAlertAbsoluteKmh: null, speedAlertUpdatedById: 'sa' }),
      }));
      expect(dto).toMatchObject({ enabled: true, overKmh: 30, absoluteKmh: null, updatedBy: 'Youness H.', updatedAt: '2026-09-03T10:00:00.000Z' });
    });

    it('liste les véhicules qui dérogent', async () => {
      prisma.vehicle.findMany.mockResolvedValue([{ id: 'v1', plate: 'AA-111-AA', speedAlertEnabled: false, speedAlertOverKmh: null }]);
      const dto = await service.get(fleetAdmin);
      expect(dto.vehicles).toEqual([{ vehicleId: 'v1', plate: 'AA-111-AA', enabled: false, overKmh: null }]);
      // La requête ne demande QUE les dérogations, pas tout le parc.
      expect(prisma.vehicle.findMany.mock.calls[0][0].where).toMatchObject({ fleetId: FLEET });
    });

    it('refuse une dérogation sur un véhicule hors société — en 404, sans rien révéler', async () => {
      await expect(service.setVehicle(fleetAdmin, 'v-ailleurs', { enabled: true, overKmh: null })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.vehicle.update).not.toHaveBeenCalled();
    });

    it('écrit la dérogation ET date le réglage de la société', async () => {
      prisma.vehicle.findFirst.mockResolvedValue({ id: 'v1', plate: 'AA-111-AA' });
      await service.setVehicle(fleetAdmin, 'v1', { enabled: null, overKmh: 40 });

      expect(prisma.vehicle.findFirst.mock.calls[0][0].where).toEqual({ id: 'v1', fleetId: FLEET });
      expect(prisma.vehicle.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { speedAlertEnabled: null, speedAlertOverKmh: 40 } });
      expect(prisma.fleet.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ speedAlertUpdatedById: 'fa' }) }));
    });
  });

  describe('essai à blanc — voir sans être vu', () => {
    /**
     * Écrit après une leçon payée en production : activer sur deux sociétés clientes pour
     * éprouver la chaîne a envoyé trois notifications chez des clients avant qu'on ne coupe.
     * Les alertes ont pu être retirées de l'écran ; les notifications remises, non.
     */
    const T0 = new Date('2026-09-04T08:00:00.000Z');
    const analyse = (over: number, limite = 90) => ({
      tripId: 't1', vehicleId: 'v1', maxSpeedKmh: limite + over,
      detail: {
        speeding: [{
          startAt: T0.toISOString(), endAt: new Date(T0.getTime() + 40_000).toISOString(), durationSec: 40,
          maxSpeedKmh: limite + over, limitKmh: limite, overKmh: over, lat: 43.6, lng: 1.4,
        }],
      },
    });
    const preparer = (over: number) => {
      prisma.tripAnalysis.findMany.mockResolvedValue([analyse(over)]);
      prisma.trip.findMany.mockResolvedValue([{ id: 't1', startedAt: T0, endedAt: new Date(T0.getTime() + 600_000) }]);
      prisma.vehicle.findMany.mockResolvedValue([{ id: 'v1', plate: 'AB-123-CD', speedAlertEnabled: null, speedAlertOverKmh: null }]);
    };

    it('⚠️ N’ÉCRIT RIEN — c’est la seule garantie qui rende l’outil utilisable sur un client', async () => {
      preparer(35);
      await service.simuler(superAdmin, FLEET, { overKmh: 20, absoluteKmh: 130, heures: 48 });

      expect(prisma.fleet.update).not.toHaveBeenCalled();
      expect(prisma.vehicle.update).not.toHaveBeenCalled();
    });

    it('dit combien d’alertes partiraient, et le texte exact de chacune', async () => {
      preparer(35);
      const r = await service.simuler(superAdmin, FLEET, { overKmh: 20, absoluteKmh: 130, heures: 48 });

      expect(r.alertes).toBe(1);
      expect(r.critiques).toBe(0);
      expect(r.exemples[0]!.plate).toBe('AB-123-CD');
      expect(r.exemples[0]!.message).toContain('125 km/h relevés sur une voie limitée à 90 (+35 km/h)');
    });

    it('un seuil plus haut fait taire ce que le plus bas laissait passer', async () => {
      preparer(35);
      const bas = await service.simuler(superAdmin, FLEET, { overKmh: 20, absoluteKmh: null, heures: 48 });
      const haut = await service.simuler(superAdmin, FLEET, { overKmh: 40, absoluteKmh: null, heures: 48 });

      expect(bas.alertes).toBe(1);
      expect(haut.alertes).toBe(0);
    });

    it('compte les critiques à part — le seuil du délit routier', async () => {
      preparer(55);
      const r = await service.simuler(superAdmin, FLEET, { overKmh: 20, absoluteKmh: null, heures: 48 });
      expect(r.critiques).toBe(1);
    });

    it('respecte une dérogation véhicule qui coupe les alertes', async () => {
      preparer(35);
      prisma.vehicle.findMany.mockResolvedValue([{ id: 'v1', plate: 'AB-123-CD', speedAlertEnabled: false, speedAlertOverKmh: null }]);
      const r = await service.simuler(superAdmin, FLEET, { overKmh: 20, absoluteKmh: 130, heures: 48 });
      expect(r.alertes).toBe(0);
    });

    it('nomme qui serait réveillé, et dit qui n’a aucun appareil', async () => {
      preparer(35);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'gerant@client.fr', role: 'FLEET_ADMIN', notificationPreference: null },
        { id: 'u2', email: 'chauffeur@client.fr', role: 'DRIVER', notificationPreference: null },
      ]);
      prisma.pushSubscription.count.mockResolvedValue(0);

      const r = await service.simuler(superAdmin, FLEET, { overKmh: 20, absoluteKmh: 130, heures: 48 });

      // Le conducteur n'est pas destinataire des alertes de flotte par défaut de son rôle.
      expect(r.destinataires.map((d) => d.email)).toEqual(['gerant@client.fr']);
      expect(r.destinataires[0]!.notifications).toBe(1);
      expect(r.destinataires[0]!.appareils).toBe(0);
    });

    it('écarte celui qui a explicitement coupé les excès de vitesse', async () => {
      preparer(35);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'gerant@client.fr', role: 'FLEET_ADMIN', notificationPreference: { receivesFleetAlerts: null, pushEnabled: true, mutedTypes: ['OVERSPEED'] } },
      ]);
      const r = await service.simuler(superAdmin, FLEET, { overKmh: 20, absoluteKmh: 130, heures: 48 });
      expect(r.destinataires).toEqual([]);
    });

    it('borne la fenêtre demandée — un outil de réglage ne doit pas peser', async () => {
      preparer(35);
      const r = await service.simuler(superAdmin, FLEET, { overKmh: 20, absoluteKmh: 130, heures: 99999 });
      expect(r.heures).toBe(720);
    });
  });
});
