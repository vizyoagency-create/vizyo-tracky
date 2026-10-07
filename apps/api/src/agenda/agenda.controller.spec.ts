import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { getDefaultPermissions } from '@vizyo/tracky-shared';
import request = require('supertest');
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { AgendaController } from './agenda.controller';
import { MaintenancePlansService } from './maintenance-plans.service';
import { VehicleEventsService } from './vehicle-events.service';

/**
 * ══ L'ONGLET MAINTENANCE LIT TOUS LES ÉVÈNEMENTS D'UN VÉHICULE (constaté en prod le 07/10/2026) ══
 *
 * L'onglet Maintenance de la fiche véhicule appelait `GET /agenda/events?vehicleId=…&type=MAINTENANCE`.
 * Cette route exige une fenêtre depuis sa création (28/06) : 400 « from (ISO) requis », avalé par
 * l'écran — « Aucun entretien » sur tous les véhicules. Correctif : une lecture SANS fenêtre, bornée
 * par le véhicule du chemin, `GET /agenda/vehicles/:vehicleId/events`. La route de flotte, elle,
 * garde sa fenêtre obligatoire : rien n'y est rouvert.
 *
 * Chemin complet d'une requête — gardes, tubes de validation, service réel — avec un Prisma simulé :
 * le patron « e2e-soft » de `test/integration/depot-isolation.e2e-spec.ts`, posé sous `src/` pour
 * tourner dans `pnpm verify`. Chaque test sur la nouvelle route tombe sur le code d'avant (404).
 */

const SOCIETE = 'f0000000-0000-4000-8000-000000000001';
const AUTRE_SOCIETE = 'f0000000-0000-4000-8000-000000000002';
const VEHICULE = 'a0000000-0000-4000-8000-00000000000a';

/** Une ligne telle que la rend `findMany` (avec la plaque incluse), lue par `toDto`. */
function ligne(id: string, status: string, startAt: string) {
  return {
    id, fleetId: SOCIETE, vehicleId: VEHICULE, vehicle: { plate: 'AB-123-CD' }, type: 'MAINTENANCE',
    category: 'Révision', status, severity: null, title: `Entretien ${id}`, description: null,
    startAt: new Date(startAt), endAt: null, allDay: true, blocksVehicle: true, odometerKm: null,
    planId: null, linkedEventId: null, resolvedAt: null, metadata: null, source: 'MANUAL',
    createdAt: new Date('2026-06-28T10:00:00Z'), updatedAt: new Date('2026-06-28T10:00:00Z'),
  };
}

describe('Agenda — lecture des évènements d’UN véhicule, sans fenêtre (07/10/2026)', () => {
  let app: INestApplication;
  let prisma: {
    vehicle: { findUnique: jest.Mock };
    vehicleEvent: { findMany: jest.Mock };
    userVehicleAccess: { findMany: jest.Mock };
  };
  let acces: { getAccessibleVehicleIds: jest.Mock };
  let compte: { role: UserRole; fleetId: string | null; agendaView?: boolean };

  beforeEach(async () => {
    prisma = {
      vehicle: { findUnique: jest.fn().mockResolvedValue({ id: VEHICULE, fleetId: SOCIETE }) },
      vehicleEvent: { findMany: jest.fn().mockResolvedValue([]) },
      // Aucune ligne d'accès : la permission globale retombe sur `User.permissions`, puis le rôle.
      userVehicleAccess: { findMany: jest.fn().mockResolvedValue([]) },
    };
    acces = { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') };
    compte = { role: UserRole.FLEET_ADMIN, fleetId: SOCIETE };

    const moduleRef = await Test.createTestingModule({
      controllers: [AgendaController],
      providers: [
        VehicleEventsService,
        PermissionsResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: VehicleAccessService, useValue: acces },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: MaintenancePlansService, useValue: {} },
      ],
    })
      // L'identité est injectée : on éprouve la lecture et ses bornes, pas l'authentification.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
          const role = compte.role as unknown as 'FLEET_MANAGER';
          ctx.switchToHttp().getRequest().user = {
            id: 'u1', authUserId: 'auth-u1', email: 'gestion@exemple.fr', firstName: null, lastName: null,
            role: compte.role, isOwner: false, fleetId: compte.fleetId, isActive: true,
            permissions:
              compte.agendaView === undefined ? null : { ...getDefaultPermissions(role), agenda_view: compte.agendaView },
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  it('⚠️ rend TOUT l’historique et toutes les échéances du véhicule : aucune borne de date dans la requête', async () => {
    // Un entretien fait en 2023, une échéance oubliée depuis mars 2025, un contrôle technique de 2029.
    prisma.vehicleEvent.findMany.mockResolvedValue([
      ligne('ct-2029', 'PLANNED', '2029-03-01T00:00:00Z'),
      ligne('vidange-retard', 'PLANNED', '2025-03-01T00:00:00Z'),
      ligne('revision-2023', 'DONE', '2023-05-10T00:00:00Z'),
    ]);

    const res = await http().get(`/agenda/vehicles/${VEHICULE}/events?type=MAINTENANCE`).expect(200);

    expect(res.body.map((e: { id: string }) => e.id)).toEqual(['ct-2029', 'vidange-retard', 'revision-2023']);
    expect(res.body[2]).toMatchObject({ vehicleId: VEHICULE, vehiclePlate: 'AB-123-CD', startAt: '2023-05-10T00:00:00.000Z' });
    const requete = prisma.vehicleEvent.findMany.mock.calls[0][0];
    // La borne est le VÉHICULE et sa société — pas une fenêtre (ni `startAt`, ni `endAt`, ni `AND`).
    expect(requete.where).toEqual({ fleetId: SOCIETE, vehicleId: VEHICULE, type: 'MAINTENANCE' });
    // Du plus tardif au plus ancien : si le plafond mordait, c'est le plus ancien qui manquerait.
    expect(requete.orderBy).toEqual({ startAt: 'desc' });
  });

  it('sans `type`, tous les types du véhicule — toujours bornés au véhicule', async () => {
    await http().get(`/agenda/vehicles/${VEHICULE}/events`).expect(200);
    expect(prisma.vehicleEvent.findMany.mock.calls[0][0].where).toEqual({ fleetId: SOCIETE, vehicleId: VEHICULE });
  });

  it('un véhicule d’une AUTRE société → 403, et rien n’est lu', async () => {
    prisma.vehicle.findUnique.mockResolvedValue({ id: VEHICULE, fleetId: AUTRE_SOCIETE });
    await http().get(`/agenda/vehicles/${VEHICULE}/events?type=MAINTENANCE`).expect(403);
    expect(prisma.vehicleEvent.findMany).not.toHaveBeenCalled();
  });

  it('un véhicule inconnu → 404, et rien n’est lu', async () => {
    prisma.vehicle.findUnique.mockResolvedValue(null);
    const res = await http().get(`/agenda/vehicles/${VEHICULE}/events`).expect(404);
    // Le 404 du VÉHICULE, pas celui d'une route absente (« Cannot GET … », le code d'avant).
    expect(res.body.message).toBe('Véhicule introuvable');
    expect(prisma.vehicleEvent.findMany).not.toHaveBeenCalled();
  });

  it('un gestionnaire limité à d’autres véhicules → 403 (anti-IDOR intra-société)', async () => {
    compte = { role: UserRole.FLEET_MANAGER, fleetId: SOCIETE, agendaView: true };
    acces.getAccessibleVehicleIds.mockResolvedValue(['b0000000-0000-4000-8000-00000000000b']);
    await http().get(`/agenda/vehicles/${VEHICULE}/events?type=MAINTENANCE`).expect(403);
    expect(prisma.vehicleEvent.findMany).not.toHaveBeenCalled();
  });

  it('sans la permission « agenda_view » → 403 avant toute lecture ; avec, la lecture passe', async () => {
    compte = { role: UserRole.FLEET_MANAGER, fleetId: SOCIETE }; // défaut du rôle : agenda_view à false
    const refus = await http().get(`/agenda/vehicles/${VEHICULE}/events?type=MAINTENANCE`).expect(403);
    expect(refus.body.message).toBe('Permission requise : agenda_view');
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();

    compte = { role: UserRole.FLEET_MANAGER, fleetId: SOCIETE, agendaView: true };
    await http().get(`/agenda/vehicles/${VEHICULE}/events?type=MAINTENANCE`).expect(200);
  });

  it('un identifiant de véhicule qui n’est pas un UUID, ou un type inconnu → 400, sans lecture', async () => {
    await http().get('/agenda/vehicles/%20/events').expect(400);
    await http().get('/agenda/vehicles/pas-un-uuid/events').expect(400);
    await http().get(`/agenda/vehicles/${VEHICULE}/events?type=VIDANGE`).expect(400);
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
    expect(prisma.vehicleEvent.findMany).not.toHaveBeenCalled();
  });

  it('⚠️ la route de FLOTTE garde sa fenêtre obligatoire : la requête de l’ancien onglet reste un 400', async () => {
    // Exactement ce qu'envoyait l'onglet depuis le 28/06 — et la forme qui, rendue légale, aurait
    // ouvert une lecture sans fenêtre de toute la société (`vehicleId=%20` : identifiant écarté).
    const ancien = await http().get(`/agenda/events?vehicleId=${VEHICULE}&type=MAINTENANCE`).expect(400);
    expect(ancien.body.message).toBe('from (ISO) requis');
    await http().get('/agenda/events?vehicleId=%20').expect(400);
    await http().get('/agenda/events').expect(400);
    expect(prisma.vehicleEvent.findMany).not.toHaveBeenCalled();
  });
});
