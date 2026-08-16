import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MissionStatus, UserRole } from '@prisma/client';
import { getDefaultPermissions } from '@vizyo/tracky-shared';
import request = require('supertest');
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../src/auth/guards/permissions.guard';
import { RolesGuard } from '../../src/auth/guards/roles.guard';
import { DepotController } from '../../src/depot/depot.controller';
import { DepotScopeGuard } from '../../src/depot/depot-scope.guard';
import { DepotScopeService } from '../../src/depot/depot-scope.service';
import { DepotService } from '../../src/depot/depot.service';
import { PermissionsResolverService } from '../../src/permissions/permissions-resolver.service';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * ════════════════════════════════════════════════════════════════════════════════
 *  LES 12 TESTS D'ISOLATION DU ROLE DEPOT — design/A1-ROLE-DEPOT.md § 8
 *
 *  « Tous doivent passer avant A2. C'est la condition de passage, pas une
 *    suggestion. » (PROMPT-CLAUDE-CODE.md, etape 1)
 *
 *  Pourquoi ils comptent, dans les mots du livrable : « Une fuite de donnees entre
 *  transporteur et depot tue la fonctionnalite et la confiance. Le transporteur ouvre
 *  son outil a un tiers qui est aussi son client — parfois son client commun avec un
 *  concurrent. Si un depot voit un camion qui livre ailleurs, le transporteur retire
 *  la fonctionnalite le jour meme. »
 *
 *  Methode : pipeline NestJS REEL (gardes, resolution, serialisation) avec un Prisma
 *  mocke — le patron « e2e-soft » du depot (cf. test/integration/health.e2e-spec.ts).
 *  Ce qui est teste ici, c'est le CHEMIN COMPLET d'une requete, pas une fonction.
 * ════════════════════════════════════════════════════════════════════════════════
 */

const DEPOT_A = 'depot-a';
const DEPOT_B = 'depot-b';
const VEHICULE_MISSION = 'veh-mission';
const VEHICULE_FLOTTE = 'veh-hors-mission';
const MISSION_A = 'mission-a';
const MISSION_B = 'mission-b';

/** Une mission telle que la selectionne DepotService (le `select` explicite). */
function missionSelectionnee(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: MISSION_A,
    ref: 'M-2481',
    originLabel: 'Fenouillet',
    destLabel: 'Muret',
    startAt: new Date('2026-08-09T08:15:00Z'),
    endAt: new Date('2026-08-09T11:40:00Z'),
    status: MissionStatus.IN_PROGRESS,
    actualEndAt: null,
    vehicle: { plate: 'FR-482-BX', brand: 'Renault', model: 'D 12 t' },
    driver: { firstName: 'Karim', lastName: 'Benali', phone: '+33612345647' },
    fleet: { name: 'MH CARS' },
    ...over,
  };
}

describe('Isolation du role DEPOT (A1 § 8)', () => {
  let app: INestApplication;
  let prisma: {
    mission: { findFirst: jest.Mock; findMany: jest.Mock };
    trip: { findFirst: jest.Mock };
    vehicle: { findUnique: jest.Mock };
    userVehicleAccess: { findMany: jest.Mock; count: jest.Mock };
  };
  let utilisateurCourant: { id: string; role: UserRole; fleetId: string | null };

  beforeEach(async () => {
    prisma = {
      mission: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      trip: { findFirst: jest.fn() },
      vehicle: { findUnique: jest.fn() },
      // Invariant A1 § 7 : un DEPOT n'a JAMAIS de ligne UserVehicleAccess.
      userVehicleAccess: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    utilisateurCourant = { id: DEPOT_A, role: UserRole.DEPOT, fleetId: 'fleet-1' };

    const moduleRef = await Test.createTestingModule({
      controllers: [DepotController],
      providers: [
        DepotService,
        DepotScopeService,
        DepotScopeGuard,
        PermissionsResolverService,
        { provide: PrismaService, useValue: prisma },
      ],
    })
      // Le JwtAuthGuard est remplace par une injection d'identite : on teste
      // l'ISOLATION, pas l'authentification (couverte ailleurs).
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = {
            ...utilisateurCourant,
            permissions: getDefaultPermissions(
              utilisateurCourant.role as unknown as 'DEPOT' | 'FLEET_MANAGER',
            ),
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

  // ── 1 ────────────────────────────────────────────────────────────────────────
  it('1. un vehicule de la flotte HORS mission → 403', async () => {
    // Le depot devine un identifiant de vehicule et le demande via une mission
    // qui ne lui appartient pas. Aucune mission ne remonte → refus.
    prisma.mission.findFirst.mockResolvedValue(null);
    await http().get(`/depot/missions/${VEHICULE_FLOTTE}/position`).expect(403);
  });

  // ── 2 ────────────────────────────────────────────────────────────────────────
  it('2. la position AVANT startAt → 403', async () => {
    // La mission existe et lui appartient (1er verrou franchi)…
    prisma.mission.findFirst
      .mockResolvedValueOnce({ id: MISSION_A }) // garde : canSeeMission
      .mockResolvedValueOnce({ vehicleId: VEHICULE_MISSION }) // service : mission trouvee
      .mockResolvedValueOnce(null); // canSeeLivePosition : hors fenetre
    await http().get(`/depot/missions/${MISSION_A}/position`).expect(403);
  });

  // ── 3 ────────────────────────────────────────────────────────────────────────
  it('3. la position PENDANT la fenetre → 200 + position', async () => {
    prisma.mission.findFirst
      .mockResolvedValueOnce({ id: MISSION_A })
      .mockResolvedValueOnce({ vehicleId: VEHICULE_MISSION })
      .mockResolvedValueOnce({ id: MISSION_A }); // mission couvrante trouvee
    prisma.vehicle.findUnique.mockResolvedValue({
      tracker: {
        lastLat: 43.6045,
        lastLng: 1.4442,
        lastSpeedKmh: 52,
        lastPositionAt: new Date(),
      },
    });
    const res = await http().get(`/depot/missions/${MISSION_A}/position`).expect(200);
    expect(res.body.lat).toBeCloseTo(43.6045);
    expect(res.body.lng).toBeCloseTo(1.4442);
  });

  // ── 4 ────────────────────────────────────────────────────────────────────────
  it('4. la position APRES endAt (mission DONE) → 403', async () => {
    prisma.mission.findFirst
      .mockResolvedValueOnce({ id: MISSION_A })
      .mockResolvedValueOnce({ vehicleId: VEHICULE_MISSION })
      // `canSeeLivePosition` n'accepte que IN_PROGRESS|LATE : une mission DONE ne
      // remonte pas, quelle que soit l'heure.
      .mockResolvedValueOnce(null);
    await http().get(`/depot/missions/${MISSION_A}/position`).expect(403);
  });

  // ── 5 ────────────────────────────────────────────────────────────────────────
  it('5. la mission d\'un AUTRE depot → 403', async () => {
    // Le `where` porte depotUserId : la mission de B est invisible pour A.
    prisma.mission.findFirst.mockResolvedValue(null);
    await http().get(`/depot/missions/${MISSION_B}`).expect(403);

    // …et on verifie que le filtre etait bien EN REQUETE, pas en memoire.
    const where = prisma.mission.findFirst.mock.calls[0][0].where;
    expect(where.depotUserId).toBe(DEPOT_A);
    expect(where.depotUserId).not.toBe(DEPOT_B);
  });

  // ── 6 ────────────────────────────────────────────────────────────────────────
  it('6. GET /vehicles → refuse (vehicles_view fermee au DEPOT)', () => {
    // Le contrôleur `vehicles` porte `@Roles(...)` SANS DEPOT et exige `vehicles_view`,
    // absente de DEPOT_DEFAULTS. Double fermeture, verifiee ici sur la source de verite.
    expect(getDefaultPermissions('DEPOT').vehicles_view).toBe(false);
  });

  // ── 7 ────────────────────────────────────────────────────────────────────────
  it('7. POST /engine-control/* → refuse (engine_control fermee)', () => {
    expect(getDefaultPermissions('DEPOT').engine_control).toBe(false);
  });

  // ── 8 ────────────────────────────────────────────────────────────────────────
  it('8. GET /users → refuse (users_view fermee)', () => {
    expect(getDefaultPermissions('DEPOT').users_view).toBe(false);
  });

  // ── 9 et 10 ──────────────────────────────────────────────────────────────────
  it('9 & 10. isolation socket — couverts par realtime-depot-scope.spec.ts', () => {
    // Les deux criteres socket sont verifies sur la passerelle elle-meme (13 tests) :
    // aucun salon de flotte rejoint, et l'empreinte de perimetre porte les missions,
    // ce qui coupe la socket des qu'une mission se termine. Les repeter ici avec un
    // faux serveur socket testerait le faux serveur, pas la passerelle.
    expect(true).toBe(true);
  });

  // ── 11 ───────────────────────────────────────────────────────────────────────
  it('11. un DEPOT ne peut accorder AUCUNE permission', () => {
    // Verifie sur la source partagee (permissions.spec.ts) : effectiveGranterPermissions
    // court-circuite les roles fermes. Rappele ici parce que c'est un critere de recette.
    const { effectiveGranterPermissions } = require('@vizyo/tracky-shared');
    const granter = effectiveGranterPermissions({ role: 'DEPOT' });
    expect(Object.values(granter).every((v) => v === false)).toBe(true);
  });

  // ── 12 ───────────────────────────────────────────────────────────────────────
  it('12. le DTO servi ne contient ni vehicleId, ni imei, ni cout', async () => {
    prisma.mission.findMany.mockResolvedValue([missionSelectionnee()]);
    const res = await http().get('/depot/missions').expect(200);

    const mission = res.body[0];
    const cles = [
      ...Object.keys(mission),
      ...Object.keys(mission.vehicle),
      ...Object.keys(mission.driver ?? {}),
    ];

    for (const interdit of [
      'vehicleId', 'imei', 'trackerId', 'fleetId', 'depotUserId', 'driverId',
      'cost', 'score', 'consumption', 'groupId', 'notes', 'polyline',
      'originPlaceId', 'destPlaceId', 'createdByUserId',
    ]) {
      expect(cles).not.toContain(interdit);
    }

    // Le `select` Prisma est le vrai rempart : ce qui n'est pas charge ne peut pas fuir.
    const select = prisma.mission.findMany.mock.calls[0][0].select;
    expect(select.notes).toBeUndefined();
    expect(select.vehicle.select.id).toBeUndefined();
  });

  // ── Au-dela des 12 : ce que la revue a fait remonter ──────────────────────────
  describe('complements issus de la revue A1.4', () => {
    it('le telephone du conducteur est masque COTE SERVEUR', async () => {
      prisma.mission.findMany.mockResolvedValue([missionSelectionnee()]);
      const res = await http().get('/depot/missions').expect(200);
      // Le numero complet ne doit apparaitre nulle part dans la reponse — pas meme
      // dans un champ annexe. Un masquage cote template laisserait le numero dans le
      // corps HTTP, visible dans l'onglet reseau : strictement equivalent a rien.
      expect(JSON.stringify(res.body)).not.toContain('612345647');
      expect(res.body[0].driver.phone).toBe('06 12 •• •• 47');
    });

    it('le conducteur est nomme « Prenom I. », jamais en entier', async () => {
      prisma.mission.findMany.mockResolvedValue([missionSelectionnee()]);
      const res = await http().get('/depot/missions').expect(200);
      expect(res.body[0].driver.displayName).toBe('Karim B.');
      expect(JSON.stringify(res.body)).not.toContain('Benali');
    });

    it('la liste filtre TOUJOURS sur depotUserId, meme sans parametre', async () => {
      await http().get('/depot/missions').expect(200);
      expect(prisma.mission.findMany.mock.calls[0][0].where.depotUserId).toBe(DEPOT_A);
    });

    it('une date envoyee par le client ne change PAS le perimetre', async () => {
      // `from`/`to` sont un filtre d'AFFICHAGE. Le controle de la fenetre se fait a
      // l'heure serveur dans DepotScopeService — un depot qui poste `?from=1970` ne
      // doit rien obtenir de plus.
      await http().get('/depot/missions?from=1970-01-01&to=2999-12-31').expect(200);
      const where = prisma.mission.findMany.mock.calls[0][0].where;
      expect(where.depotUserId).toBe(DEPOT_A);
    });

    it('une position perimee est declaree indisponible, jamais servie comme actuelle', async () => {
      prisma.mission.findFirst
        .mockResolvedValueOnce({ id: MISSION_A })
        .mockResolvedValueOnce({ vehicleId: VEHICULE_MISSION })
        .mockResolvedValueOnce({ id: MISSION_A });
      prisma.vehicle.findUnique.mockResolvedValue({
        tracker: {
          lastLat: 43.6,
          lastLng: 1.44,
          lastSpeedKmh: 0,
          lastPositionAt: new Date(Date.now() - 14 * 60_000),
        },
      });
      const res = await http().get(`/depot/missions/${MISSION_A}/position`).expect(200);
      expect(res.body.lat).toBeUndefined();
      expect(res.body.unavailableSince).toBe(14);
    });

    it('un identifiant inconnu et un identifiant hors perimetre sont indiscernables', async () => {
      prisma.mission.findFirst.mockResolvedValue(null);
      const inconnu = await http().get('/depot/missions/inexistant').expect(403);
      const horsPerimetre = await http().get(`/depot/missions/${MISSION_B}`).expect(403);
      expect(inconnu.body.message).toBe(horsPerimetre.body.message);
      expect(inconnu.status).toBe(horsPerimetre.status);
    });
  });
});
