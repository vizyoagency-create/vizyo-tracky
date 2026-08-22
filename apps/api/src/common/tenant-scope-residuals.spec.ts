import { UserRole } from '@prisma/client';
import { EngineControlService } from '../engine-control/engine-control.service';
import { GeofencesService } from '../geofences/geofences.service';
import { AdminAlertsController } from '../tracker-fix-mode/admin-alerts.controller';

/**
 * Lot 2b — fail-closed résiduels (même classe de bug que A3/B1/B2/D9).
 * Prouve que les endpoints restants traitent un non-super à fleetId null en
 * DENY (résultat vide, aucune requête « toutes flottes »), et filtrent sur la
 * flotte de l'utilisateur dans le cas normal.
 * (vehicle-access.service.ts:84 est couvert dans son propre spec.)
 */

const FLEET_A = '00000000-0000-0000-0000-00000000000a';
const denyUser = { userId: 'u', role: UserRole.FLEET_ADMIN, fleetId: null };
const fleetUser = { userId: 'u', role: UserRole.FLEET_ADMIN, fleetId: FLEET_A };

describe('tenant-scope résiduels (fail-closed)', () => {
  describe('EngineControlService.listCommands', () => {
    // ⚠️ Construction POSITIONNELLE : ce spec doit suivre la signature du constructeur.
    // Ajouter une dépendance au service casse ce fichier — c'est voulu, ça force à
    // vérifier que le nouveau collaborateur n'intervient pas dans le chemin fail-closed
    // testé ici (`listCommands` n'appelle ni les zones mortes, ni le reste).
    const make = (prisma: unknown) =>
      new EngineControlService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never, // deadZones — non sollicité par listCommands
        {} as never,
      );

    it('non-super sans fleetId → [] et aucune requête DB', async () => {
      const prisma = { engineControlCommand: { findMany: jest.fn() } };
      expect(await make(prisma).listCommands(denyUser as never)).toEqual([]);
      expect(prisma.engineControlCommand.findMany).not.toHaveBeenCalled();
    });

    it('utilisateur normal → where.tracker.vehicle.fleetId', async () => {
      const prisma = { engineControlCommand: { findMany: jest.fn().mockResolvedValue([]) } };
      await make(prisma).listCommands(fleetUser as never);
      expect(prisma.engineControlCommand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tracker: { vehicle: { fleetId: FLEET_A } } }),
        }),
      );
    });
  });

  describe('GeofencesService.findAll', () => {
    const make = (prisma: unknown) =>
      new GeofencesService(prisma as never, {} as never, {} as never, {} as never, {} as never);

    it('non-super sans fleetId → [] et aucune requête DB', async () => {
      const prisma = { geofence: { findMany: jest.fn() } };
      expect(await make(prisma).findAll(denyUser as never)).toEqual([]);
      expect(prisma.geofence.findMany).not.toHaveBeenCalled();
    });

    it('utilisateur normal → where.fleetId', async () => {
      const prisma = { geofence: { findMany: jest.fn().mockResolvedValue([]) } };
      await make(prisma).findAll(fleetUser as never);
      expect(prisma.geofence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fleetId: FLEET_A }) }),
      );
    });
  });

  describe('AdminAlertsController.list', () => {
    it('non-super sans fleetId → payload vide et aucune requête DB', async () => {
      const prisma = {
        tracker: { findMany: jest.fn() },
        trackerCommand: { findMany: jest.fn() },
        errorLog: { findMany: jest.fn(), count: jest.fn() },
      };
      const activity = { record: jest.fn() };
      const ctrl = new AdminAlertsController(prisma as never, activity as never);

      const res = await ctrl.list({ user: denyUser } as never);

      expect(res.summary).toEqual({
        failing: 0,
        offline: 0,
        pending: 0,
        errorsLast24h: 0,
        errorsPrev24h: 0,
        criticalLastHour: 0,
        errorsSinceLastVisit: null,
        vueArchivage: 'actives',
        errorsArchivees24h: 0,
      });
      expect(res.failing).toEqual([]);
      expect(res.offline).toEqual([]);
      expect(res.pendingCommands).toEqual([]);
      expect(prisma.tracker.findMany).not.toHaveBeenCalled();
      expect(prisma.errorLog.findMany).not.toHaveBeenCalled();
    });
  });
});
