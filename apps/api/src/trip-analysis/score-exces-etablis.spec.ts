/**
 * ══ LE CLASSEMENT NE DOIT COMPTER QUE LES EXCÈS ÉTABLIS ══════════════════════════════
 *
 * Il lisait `speedingCount`, le compteur écrit au moment de l'analyse — qui, sur les analyses
 * antérieures au lot V2, inclut des segments de durée nulle : un dépassement vu sur UN point
 * GPS. Mesuré en production le 2026-09-05 : 1 625 trajets marqués « avec excès » sur 30 jours
 * dont le seul excès était un point unique. C'est ce chiffre qu'un gestionnaire lisait sous
 * le nom d'un conducteur.
 *
 * Depuis, la question est posée à Postgres avec la règle partagée (`EXCES_DUREE_MIN_SEC`),
 * exactement comme la colonne « Excès » du récapitulatif de la page Rapports.
 */
import { Prisma, UserRole } from '@prisma/client';
import { EXCES_DUREE_MIN_SEC } from '@vizyo/tracky-shared';
import { DrivingScoreService } from './driving-score.service';

const FLEET = 'f1';
const VEH = 'veh-1';
const T0 = new Date('2026-08-10T08:00:00.000Z');

function build(opts: { etablis: string[]; queryRawEchoue?: boolean }) {
  const analyses = [
    // ⚠️ `speedingCount` vaut 3 sur les DEUX : c'est précisément le compteur qu'on ne veut
    // plus croire. Seule la réponse SQL doit décider.
    { tripId: 't-faux', vehicleId: VEH, ecoScore: 80, distanceKm: 20, speedingCount: 3, harshAccel: 0, harshBrake: 0, fuelLiters: 1, co2Kg: 3 },
    { tripId: 't-vrai', vehicleId: VEH, ecoScore: 70, distanceKm: 30, speedingCount: 3, harshAccel: 0, harshBrake: 0, fuelLiters: 2, co2Kg: 5 },
  ];
  const trips = analyses.map((a, i) => ({
    id: a.tripId, vehicleId: VEH, driverId: null, startedAt: new Date(T0.getTime() + i * 3_600_000), driver: null,
  }));
  const captured: { sql?: string; params?: unknown[] } = {};
  const prisma = {
    tripAnalysis: { findMany: jest.fn().mockResolvedValue(analyses) },
    trip: {
      findMany: jest.fn().mockResolvedValue(trips),
      groupBy: jest.fn().mockResolvedValue([{ vehicleId: VEH, driverId: null, _count: { _all: 2 }, _sum: { distanceKm: 0 } }]),
    },
    vehicle: {
      findMany: jest.fn().mockResolvedValue([{ id: VEH, plate: 'AB-123-CD', brand: 'Renault', model: 'Clio', groups: [], tracker: { id: 'trk', lastSeenAt: new Date() } }]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray, ...params: unknown[]) => {
      captured.sql = strings.join('?');
      captured.params = params;
      if (opts.queryRawEchoue) return Promise.reject(new Prisma.PrismaClientUnknownRequestError('base injoignable', { clientVersion: 'test' }));
      return Promise.resolve(opts.etablis.map((tripId) => ({ tripId })));
    }),
  };
  const access = { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') };
  const user = { id: 'u', role: UserRole.FLEET_ADMIN, fleetId: FLEET } as never;
  return { svc: new DrivingScoreService(prisma as never, access as never), captured, user };
}

describe('Classement — seuls les excès ÉTABLIS comptent', () => {
  it('ignore un trajet dont le compteur dit 3 mais dont aucun segment n’est établi', async () => {
    const { svc, user } = build({ etablis: ['t-vrai'] });
    const res = await svc.scores(user, 'vehicle', '2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z', FLEET);
    const ligne = res.rows[0] ?? res.insufficientRows[0];
    expect(ligne).toBeDefined();
    // Deux analyses à speedingCount = 3 ; UNE seule a un excès établi.
    expect(ligne!.speedingTrips).toBe(1);
    expect(ligne!.speedingTripRefs.map((r) => r.tripId)).toEqual(['t-vrai']);
  });

  it('pose la question à Postgres avec la CONSTANTE PARTAGÉE, sur les trajets chargés', async () => {
    const { svc, captured, user } = build({ etablis: [] });
    await svc.scores(user, 'vehicle', '2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z', FLEET);
    expect(captured.sql).toContain('durationSec');
    // Le seuil interpolé est celui du contrat partagé — pas un « 1 » écrit à la main.
    expect(captured.params).toContain(EXCES_DUREE_MIN_SEC);
    // Et la liste des trajets est passée en paramètre lié, jamais concaténée.
    expect(captured.params).toContainEqual(['t-faux', 't-vrai']);
  });

  /**
   * ⚠️ Le repli est ZÉRO, jamais `speedingCount`. Un classement sans sa colonne « avec excès »
   * reste un classement juste ; un repli sur l'ancien compteur réintroduirait exactement ce
   * qu'on vient de retirer, au moment précis où personne ne regarde.
   */
  it('en cas d’échec de BASE, ne compte AUCUN excès plutôt que de retomber sur l’ancien compteur', async () => {
    const { svc, user } = build({ etablis: ['t-vrai'], queryRawEchoue: true });
    const res = await svc.scores(user, 'vehicle', '2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z', FLEET);
    const ligne = res.rows[0] ?? res.insufficientRows[0];
    expect(ligne!.speedingTrips).toBe(0);
  });

  /**
   * ⚠️ Une erreur de PROGRAMMATION n'est pas une panne de base : elle doit REMONTER. La
   * rattraper transformerait une colonne mal orthographiée en zéro silencieux pour toute la
   * flotte, avec un avertissement que personne ne lit.
   */
  it('laisse remonter une erreur de programmation au lieu de la transformer en zéro', async () => {
    const { svc, user } = build({ etablis: [] });
    (svc as unknown as { prisma: { $queryRaw: jest.Mock } }).prisma.$queryRaw.mockImplementation(() => Promise.reject(new TypeError('colonne inconnue')));
    await expect(
      svc.scores(user, 'vehicle', '2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z', FLEET),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
