import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GeofenceRule, UserRole } from '@prisma/client';
import { GeofencesService } from './geofences.service';

/**
 * ══ UNE ZONE VA DANS LA SOCIÉTÉ CHOISIE (05/10/2026) ══════════════════════════════════════════════
 *
 * Le propriétaire a demandé une zone « Garage » pour cdef31. Créée depuis un compte super-admin,
 * elle serait partie dans la plus ancienne société de la base — mh cars : la création et l'import
 * repliaient EN SILENCE sur `fleet.findFirst({ orderBy: { createdAt: 'asc' } })`, et l'écran
 * n'envoyait même pas la société choisie. Chaque test ⚠️ tombe sur ce repli.
 */

const MH_CARS = '7cc3c2f7-0160-4f1a-86d7-bae13ecee9f7'; // la plus ancienne : l'ancien repli
const CDEF31 = '2ad69ac1-3ffb-4fb6-aa4e-cfbba800b75f';

function service() {
  const prisma = {
    fleet: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        ([MH_CARS, CDEF31].includes(where.id) ? { id: where.id } : null)),
      // Le repli d'avant : il ne doit plus JAMAIS servir.
      findFirst: jest.fn(async () => ({ id: MH_CARS })),
    },
    geofence: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'g-1', ...data })) },
  };
  const svc = new GeofencesService(prisma as never, {} as never, {} as never, {} as never, {} as never);
  return { svc, prisma };
}

const ZONE = { name: 'Garage — Aucamville', centerLat: 43.66089, centerLng: 1.41866, radiusMeters: 120, rule: GeofenceRule.BOTH };
const GEOJSON = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { name: 'Garage', radius: 120 }, geometry: { type: 'Point', coordinates: [1.41866, 43.66089] } }],
};
const superAdmin = { userId: 'sa', role: UserRole.SUPER_ADMIN, fleetId: null };
const adminCdef = { userId: 'adm', role: UserRole.FLEET_ADMIN, fleetId: CDEF31 };
const societeDe = (prisma: ReturnType<typeof service>['prisma']) =>
  (prisma.geofence.create.mock.calls[0]![0] as { data: { fleetId: string } }).data.fleetId;

describe('Géofences — la zone va dans la société CHOISIE, jamais dans la plus ancienne', () => {
  it('⚠️ un super-admin crée dans la société qu’il nomme', async () => {
    const { svc, prisma } = service();
    await svc.create({ ...ZONE, fleetId: CDEF31 }, superAdmin);
    expect(societeDe(prisma)).toBe(CDEF31);
    expect(prisma.fleet.findFirst).not.toHaveBeenCalled();
  });

  it('⚠️ un super-admin qui ne nomme aucune société est refusé — plus de repli silencieux', async () => {
    const { svc, prisma } = service();
    await expect(svc.create(ZONE, superAdmin)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.geofence.create).not.toHaveBeenCalled();
    expect(prisma.fleet.findFirst).not.toHaveBeenCalled();
  });

  it('une société inconnue est refusée', async () => {
    const { svc, prisma } = service();
    await expect(svc.create({ ...ZONE, fleetId: '11111111-1111-4111-8111-111111111111' }, superAdmin))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.geofence.create).not.toHaveBeenCalled();
  });

  it('un identifiant mal formé est refusé proprement (400, pas une erreur Prisma en 500)', async () => {
    const { svc, prisma } = service();
    await expect(svc.importGeoJson(GEOJSON, superAdmin, 'pas-un-identifiant')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.fleet.findUnique).not.toHaveBeenCalled();
  });

  it('un compte de flotte écrit TOUJOURS dans la sienne, même s’il en envoie une autre', async () => {
    const { svc, prisma } = service();
    await svc.create({ ...ZONE, fleetId: MH_CARS }, adminCdef);
    expect(societeDe(prisma)).toBe(CDEF31);
  });

  it('un compte sans société est refusé', async () => {
    const { svc } = service();
    await expect(svc.create(ZONE, { userId: 'x', role: UserRole.FLEET_ADMIN, fleetId: null }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('⚠️ l’import suit la même règle : la société nommée, sinon refus', async () => {
    const { svc, prisma } = service();
    await expect(svc.importGeoJson(GEOJSON, superAdmin, CDEF31)).resolves.toEqual({ created: 1, skipped: 0 });
    expect(societeDe(prisma)).toBe(CDEF31);
    await expect(svc.importGeoJson(GEOJSON, superAdmin)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.fleet.findFirst).not.toHaveBeenCalled();
  });
});
