/**
 * TRK-078 (2026-09-13) — L'ALERTE D'EXCÈS NE DOIT PAS PERDRE SON TRAJET AU RECALCUL.
 *
 * `Alert.trip` est une relation `onDelete: SetNull` : quand le recalcul supprime un trajet
 * pour le recréer sous une autre identité, l'alerte d'excès qui le désignait reste, mais sans
 * lien — le bouton « Voir le trajet » disparaît, et `payload.tripId` pointe sur un identifiant
 * mort. Mesuré en production : deux alertes orphelines, et un cinquième des notifications
 * d'excès en doublon parce que la nouvelle identité était analysée comme un trajet neuf.
 *
 * Le recalcul sait déjà reprendre les notes et le conducteur des trajets qu'il détruit, par
 * recouvrement de période. Les alertes suivent le même chemin, avec une clé plus précise
 * quand elle existe : l'INSTANT de l'excès, qui vient du GPS et survit au découpage.
 */
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from './trips.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { TripSegmenterService } from './trip-segmenter.service';

const VEHICULE = '00000000-0000-0000-0000-0000000000v1';
const HUMAIN = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const T0 = new Date('2026-09-01T08:00:00.000Z');
const a = (min: number) => new Date(T0.getTime() + min * 60_000);

const ancien = (id: string, debutMin: number, finMin: number) => ({
  id, startedAt: a(debutMin), endedAt: a(finMin),
  notes: null, notesUpdatedAt: null, notesUpdatedById: null,
  driverId: null, driverSource: null, missionId: null,
});

const decoupe = (debutMin: number, finMin: number) => ({
  startedAt: a(debutMin), endedAt: a(finMin),
  startLat: 43.6, startLng: 1.4, endLat: 43.7, endLng: 1.5,
  durationSeconds: (finMin - debutMin) * 60, distanceMeters: 5000,
  maxSpeed: 90, avgSpeed: 50, positionCount: 30,
  positions: [{ lat: 43.6, lng: 1.4 }, { lat: 43.7, lng: 1.5 }],
});

/** Une alerte d'excès telle que la base la rend AVANT la suppression de son trajet. */
const alerte = (id: string, tripId: string, excesMin: number | null) => ({
  id, tripId,
  payload: {
    source: 'trip-analysis', tripId,
    tripStartedAt: a(0).toISOString(), tripEndedAt: a(60).toISOString(),
    startAt: excesMin == null ? null : a(excesMin).toISOString(),
    endAt: excesMin == null ? null : a(excesMin + 1).toISOString(),
    speedKmh: 125,
  },
});

interface Monde {
  anciens?: ReturnType<typeof ancien>[];
  decoupes?: ReturnType<typeof decoupe>[];
  alertes?: ReturnType<typeof alerte>[];
}

async function recalculer(monde: Monde) {
  const crees: Record<string, unknown>[] = [];
  const prisma = {
    vehicle: { findUnique: jest.fn().mockResolvedValue({ id: VEHICULE, fleetId: 'f1', tracker: { id: 'trk-1' } }) },
    trip: {
      findMany: jest.fn().mockResolvedValue(monde.anciens ?? []),
      deleteMany: jest.fn().mockResolvedValue({ count: (monde.anciens ?? []).length }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        crees.push(data);
        return { id: `neuf-${crees.length}`, ...data };
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    tripFuelStop: { deleteMany: jest.fn().mockResolvedValue({}) },
    tripAnalysis: { deleteMany: jest.fn().mockResolvedValue({}) },
    position: { findMany: jest.fn().mockResolvedValue([]) },
    alert: {
      findMany: jest.fn().mockResolvedValue(monde.alertes ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const segmenter = { segmentPositions: jest.fn().mockReturnValue(monde.decoupes ?? []) };
  const journal = { record: jest.fn() };

  const module = await Test.createTestingModule({
    providers: [
      TripsService,
      { provide: PrismaService, useValue: prisma },
      { provide: TripSegmenterService, useValue: segmenter },
      { provide: SystemActivityService, useValue: journal },
    ],
  })
    .useMocker(() => ({}))
    .compile();

  const svc = module.get(TripsService);
  const resultat = await svc.recompute(
    { userId: HUMAIN, role: UserRole.SUPER_ADMIN, fleetId: null } as never,
    { vehicleId: VEHICULE, from: a(-60).toISOString(), to: a(600).toISOString() },
  );
  return { resultat, crees, prisma, journal };
}

describe('Recalcul — l’alerte d’excès suit son trajet', () => {
  it('relève les alertes des trajets à détruire AVANT de les supprimer — après, le lien est déjà nul', async () => {
    const { prisma } = await recalculer({ anciens: [ancien('vieux-1', 0, 60)], decoupes: [decoupe(0, 60)] });

    expect(prisma.alert.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.alert.findMany.mock.calls[0][0].where).toEqual({ tripId: { in: ['vieux-1'] } });
    const ordre = prisma.alert.findMany.mock.invocationCallOrder[0];
    expect(ordre).toBeLessThan(prisma.trip.deleteMany.mock.invocationCallOrder[0]);
  });

  it('rattache l’alerte au nouveau trajet qui CONTIENT l’instant de l’excès', async () => {
    // L'ancien trajet de 0 à 60 est coupé en deux ; l'excès a eu lieu à la 45e minute.
    const { resultat, prisma } = await recalculer({
      anciens: [ancien('vieux-1', 0, 60)],
      decoupes: [decoupe(0, 30), decoupe(30, 60)],
      alertes: [alerte('al-1', 'vieux-1', 45)],
    });

    expect(prisma.alert.update).toHaveBeenCalledTimes(1);
    const maj = prisma.alert.update.mock.calls[0][0];
    expect(maj.where).toEqual({ id: 'al-1' });
    expect(maj.data.tripId).toBe('neuf-2');
    // La charge utile suit : identifiant, période du trajet d'accueil, et la trace de l'ancien.
    expect(maj.data.payload).toMatchObject({
      tripId: 'neuf-2', tripPrecedentId: 'vieux-1',
      tripStartedAt: a(30).toISOString(), tripEndedAt: a(60).toISOString(),
      // Ce qui décrit l'EXCÈS ne bouge pas : c'est un fait GPS, pas un découpage.
      startAt: a(45).toISOString(), speedKmh: 125,
    });
    expect(resultat.alertesRattachees).toBe(1);
  });

  it('à défaut d’instant, rattache au trajet qui recouvre le MIEUX l’ancien', async () => {
    // Plafond absolu sans point de tracé : l'alerte ne sait pas où était l'excès.
    const { prisma } = await recalculer({
      anciens: [ancien('vieux-1', 0, 60)],
      decoupes: [decoupe(0, 10), decoupe(10, 60)],
      alertes: [alerte('al-1', 'vieux-1', null)],
    });

    expect(prisma.alert.update.mock.calls[0][0].data.tripId).toBe('neuf-2');
  });

  it('⚠️ laisse l’alerte orpheline plutôt que de la poser sur un trajet qui ne la contient pas', async () => {
    // Le redécoupage n'a rien produit autour de l'excès (positions absentes) : mieux vaut un
    // lien mort, compté, qu'un lien vers un trajet où l'excès n'a pas eu lieu.
    const { resultat, prisma } = await recalculer({
      anciens: [ancien('vieux-1', 0, 60)],
      decoupes: [decoupe(200, 260)],
      alertes: [alerte('al-1', 'vieux-1', 45)],
    });

    expect(prisma.alert.update).not.toHaveBeenCalled();
    expect(resultat.alertesRattachees).toBe(0);
    expect(resultat.alertesOrphelines).toBe(1);
  });

  it('sans alerte sur la période, n’écrit rien', async () => {
    const { resultat, prisma } = await recalculer({ anciens: [ancien('vieux-1', 0, 60)], decoupes: [decoupe(0, 60)] });

    expect(prisma.alert.update).not.toHaveBeenCalled();
    expect(resultat).toMatchObject({ alertesRattachees: 0, alertesOrphelines: 0 });
  });

  it('sans trajet à détruire, ne va même pas lire les alertes', async () => {
    const { prisma } = await recalculer({ decoupes: [decoupe(0, 60)] });
    expect(prisma.alert.findMany).not.toHaveBeenCalled();
  });

  it('le Journal Système porte les deux comptes, y compris à zéro', async () => {
    const { journal } = await recalculer({
      anciens: [ancien('vieux-1', 0, 60)],
      decoupes: [decoupe(0, 60)],
      alertes: [alerte('al-1', 'vieux-1', 45)],
    });

    expect(journal.record.mock.calls[0][0].meta).toMatchObject({ alertesRattachees: 1, alertesOrphelines: 0 });
  });
});
