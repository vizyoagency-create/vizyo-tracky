/**
 * LE TRAVAIL SAISI À LA MAIN NE DOIT PAS PARTIR AVEC LA GÉOMÉTRIE.
 *
 * Le recalcul supprime les trajets d'une période et les redécoupe depuis les positions. Il
 * emportait avec eux les NOTES rédigées par un exploitant, le CONDUCTEUR affecté et la MISSION
 * rattachée — et le dialogue de confirmation n'en disait pas un mot : il annonçait la perte des
 * analyses et des récits IA, produits par une machine, en taisant celle du seul contenu qu'un
 * humain avait écrit.
 *
 * Ces tests protègent les trois moitiés de la correction : ce qui est repris, ce qui ne peut
 * pas l'être, et le fait qu'on le DISE au lieu de l'effacer en silence.
 */
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService } from './trips.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { TripSegmenterService } from './trip-segmenter.service';

const VEHICULE = '00000000-0000-0000-0000-0000000000v1';
const T0 = new Date('2026-09-01T08:00:00.000Z');
const a = (min: number) => new Date(T0.getTime() + min * 60_000);

/** Un ancien trajet, tel que la base le rend avant suppression. */
const ancien = (id: string, debutMin: number, finMin: number, patch: Record<string, unknown> = {}) => ({
  id, startedAt: a(debutMin), endedAt: a(finMin),
  notes: null, notesUpdatedAt: null, notesUpdatedById: null,
  driverId: null, driverSource: null, missionId: null,
  ...patch,
});

/** Un découpage produit par le segmenteur. */
const decoupe = (debutMin: number, finMin: number) => ({
  startedAt: a(debutMin), endedAt: a(finMin),
  startLat: 43.6, startLng: 1.4, endLat: 43.7, endLng: 1.5,
  durationSeconds: (finMin - debutMin) * 60, distanceMeters: 5000,
  maxSpeed: 90, avgSpeed: 50, positionCount: 30,
  positions: [{ lat: 43.6, lng: 1.4 }, { lat: 43.7, lng: 1.5 }],
});

interface Monde {
  anciens?: ReturnType<typeof ancien>[];
  decoupes?: ReturnType<typeof decoupe>[];
}

async function recalculer(monde: Monde) {
  const crees: Record<string, unknown>[] = [];
  const prisma = {
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({
        id: VEHICULE, fleetId: 'f1', tracker: { id: 'trk-1' },
      }),
    },
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
  };
  const segmenter = { segmentPositions: jest.fn().mockReturnValue(monde.decoupes ?? []) };

  /**
   * ⚠️ Le journal système est fourni EXPLICITEMENT, pas par `useMocker` : celui-ci rend un
   * objet vide, sur lequel `record` n'est pas une fonction. Un double qui ne porte pas la
   * méthode appelée décrit un service qui n'existe pas.
   */
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
    { userId: 'u1', role: UserRole.SUPER_ADMIN, fleetId: null } as never,
    { vehicleId: VEHICULE, from: a(-60).toISOString(), to: a(600).toISOString() },
  );
  return { resultat, crees, journal };
}

describe('Recalcul — le travail saisi à la main survit', () => {
  it('rattache la note et le conducteur au trajet qui couvre la MÊME période', async () => {
    const { resultat, crees } = await recalculer({
      anciens: [ancien('vieux-1', 0, 60, {
        notes: 'Livraison retardée par un contrôle',
        notesUpdatedAt: a(70), notesUpdatedById: 'u9',
        driverId: 'd1', driverSource: 'manual', missionId: 'm1',
      })],
      decoupes: [decoupe(0, 60)],
    });

    expect(crees[0]).toMatchObject({
      notes: 'Livraison retardée par un contrôle',
      notesUpdatedById: 'u9',
      driverId: 'd1',
      driverSource: 'manual',
      missionId: 'm1',
    });
    expect(resultat.notesReprises).toBe(1);
    expect(resultat.conducteursRepris).toBe(1);
    expect(resultat.notesPerdues).toBe(0);
  });

  it('choisit l’ancien trajet dont le recouvrement est le PLUS grand', async () => {
    // Deux anciens, un nouveau qui couvre surtout le second.
    const { crees } = await recalculer({
      anciens: [
        ancien('vieux-1', 0, 20, { notes: 'le mauvais' }),
        ancien('vieux-2', 100, 200, { notes: 'le bon' }),
      ],
      decoupes: [decoupe(150, 210)],
    });
    expect(crees[0]!.notes).toBe('le bon');
  });

  it('⚠️ n’écrit JAMAIS la même note sur deux trajets', async () => {
    // Un ancien trajet coupé en deux : un seul des deux peut porter la note, sinon personne
    // ne saurait laquelle fait foi.
    const { crees, resultat } = await recalculer({
      anciens: [ancien('vieux-1', 0, 120, { notes: 'une seule note' })],
      decoupes: [decoupe(0, 60), decoupe(60, 120)],
    });

    const porteurs = crees.filter((c) => c.notes === 'une seule note');
    expect(porteurs).toHaveLength(1);
    expect(resultat.notesReprises).toBe(1);
  });

  it('⚠️ COMPTE la note qu’aucun trajet ne peut porter, au lieu de l’effacer en silence', async () => {
    // Deux anciens fondus en un seul nouveau : une note trouve preneur, l'autre non.
    const { resultat } = await recalculer({
      anciens: [
        ancien('vieux-1', 0, 50, { notes: 'première' }),
        ancien('vieux-2', 55, 110, { notes: 'seconde' }),
      ],
      decoupes: [decoupe(0, 110)],
    });

    expect(resultat.notesReprises).toBe(1);
    expect(resultat.notesPerdues).toBe(1);
  });

  it('ne rattache rien à un trajet qui ne recouvre AUCUN ancien', async () => {
    // Mieux vaut une note orpheline, comptée et annoncée, qu'une note posée sur le mauvais
    // trajet : un exploitant qui lit une note fausse prend une décision fausse.
    const { crees, resultat } = await recalculer({
      anciens: [ancien('vieux-1', 0, 30, { notes: 'ailleurs' })],
      decoupes: [decoupe(200, 260)],
    });

    expect(crees[0]!.notes).toBeNull();
    expect(resultat.notesReprises).toBe(0);
    expect(resultat.notesPerdues).toBe(1);
  });

  it('un trajet sans aucune trace humaine ne fait rien remonter', async () => {
    const { resultat, crees } = await recalculer({
      anciens: [ancien('vieux-1', 0, 60)],
      decoupes: [decoupe(0, 60)],
    });

    expect(crees[0]!.notes).toBeNull();
    expect(resultat).toMatchObject({ notesReprises: 0, conducteursRepris: 0, notesPerdues: 0 });
  });

  /**
   * ── LE SEUL GESTE DE CETTE PAGE QUI DÉTRUIT DES DONNÉES DOIT LAISSER UNE TRACE ──────
   *
   * Le recalcul supprime des trajets et en recrée d'autres. Il ne laissait qu'une ligne dans
   * les journaux du conteneur — c'est-à-dire nulle part, pour qui enquête depuis l'espace
   * admin. Un client qui écrit « mes trajets d'août ont changé » ne pouvait être ni confirmé
   * ni démenti : personne ne savait qui avait recalculé quoi, ni quand.
   */
  it('inscrit au Journal Système ce qui a été supprimé, recréé et perdu', async () => {
    const { journal, resultat } = await recalculer({
      anciens: [ancien('vieux-1', 0, 60, { notes: 'Livraison Carrefour', driverId: 'd1' })],
      decoupes: [decoupe(0, 60)],
    });

    expect(journal.record).toHaveBeenCalledTimes(1);
    const ligne = journal.record.mock.calls[0][0];
    expect(ligne.category).toBe('MUTATION');
    expect(ligne.action).toBe('trips_recompute');
    expect(ligne.triggeredByUserId).toBe('u1');
    expect(ligne.fleetId).toBe('f1');
    // Les cinq chiffres qu'on vient chercher après coup — Y COMPRIS celui qui vaut zéro.
    // Une ligne qui ne porte la perte que lorsqu'elle est non nulle oblige à interpréter
    // son absence, et une absence s'interprète toujours dans le sens qui arrange.
    expect(ligne.meta).toMatchObject({
      supprimes: resultat.deleted,
      recrees: resultat.created,
      notesReprises: resultat.notesReprises,
      conducteursRepris: resultat.conducteursRepris,
      notesPerdues: resultat.notesPerdues,
    });
    expect(ligne.meta.notesPerdues).toBe(0);
    expect(ligne.detail).toContain('supprimé');
  });

  it('journalise AUSSI la note qu’aucun trajet n’a pu reprendre', async () => {
    // Deux anciens trajets notés fondus en un seul : une seule note peut tenir.
    const { journal } = await recalculer({
      anciens: [
        ancien('vieux-1', 0, 30, { notes: 'Première tournée' }),
        ancien('vieux-2', 30, 60, { notes: 'Seconde tournée' }),
      ],
      decoupes: [decoupe(0, 60)],
    });

    expect(journal.record.mock.calls[0][0].meta.notesPerdues).toBe(1);
  });

  it('reprend le conducteur seul, même sans note', async () => {
    const { crees, resultat } = await recalculer({
      anciens: [ancien('vieux-1', 0, 60, { driverId: 'd7', driverSource: 'badge' })],
      decoupes: [decoupe(0, 60)],
    });

    expect(crees[0]).toMatchObject({ driverId: 'd7', driverSource: 'badge' });
    expect(resultat.conducteursRepris).toBe(1);
    expect(resultat.notesReprises).toBe(0);
  });
});
