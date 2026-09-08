import { NotFoundException } from '@nestjs/common';
import { TripMapMatchingService } from './trip-map-matching.service';

/**
 * Le recalage à la demande : un trajet regardé sans tracé recalé en reçoit un, une fois, et
 * pour tout le monde ensuite. Ce qui est protégé : le périmètre (celui de `findOne`), l'absence
 * de travail quand le tracé existe déjà, le verrou par trajet, et le refus qui ne casse rien.
 */
const DEMANDEUR = { userId: 'u1', role: 'FLEET_ADMIN' as never, fleetId: 'f1' };
const BRUT = [{ lat: 43.600, lng: 1.400 }, { lat: 43.601, lng: 1.401 }, { lat: 43.602, lng: 1.402 }];
const RECALE = [{ lat: 43.6001, lng: 1.4001 }, { lat: 43.6005, lng: 1.4005 }, { lat: 43.601, lng: 1.401 }, { lat: 43.602, lng: 1.402 }];

function build(trip: Record<string, unknown> | null, recale: typeof RECALE | null = RECALE, delaiMs = 0) {
  const prisma = { trip: { update: jest.fn().mockResolvedValue({}) } };
  const trips = {
    findOne: jest.fn(async () => {
      if (!trip) throw new NotFoundException('Trajet introuvable');
      return trip;
    }),
  };
  const mapMatching = {
    match: jest.fn(async () => {
      if (delaiMs > 0) await new Promise((r) => setTimeout(r, delaiMs));
      return recale;
    }),
  };
  const svc = new TripMapMatchingService(prisma as never, trips as never, mapMatching as never);
  return { svc, prisma, trips, mapMatching };
}

describe('TripMapMatchingService — recalage à la demande', () => {
  it('recale un trajet qui ne l’est pas, le range en base et le rend', async () => {
    const { svc, prisma, mapMatching } = build({ id: 't1', polyline: JSON.stringify(BRUT), polylineMatched: null });

    const r = await svc.recaler('t1', DEMANDEUR);

    expect(mapMatching.match).toHaveBeenCalledWith(BRUT);
    expect(prisma.trip.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { polylineMatched: JSON.stringify(RECALE) } });
    expect(r).toEqual({ polylineMatched: JSON.stringify(RECALE), enCours: false });
  });

  it('un trajet déjà recalé ne coûte aucune requête : on rend ce qui existe', async () => {
    const { svc, mapMatching, prisma } = build({ id: 't1', polyline: JSON.stringify(BRUT), polylineMatched: JSON.stringify(RECALE) });

    const r = await svc.recaler('t1', DEMANDEUR);

    expect(mapMatching.match).not.toHaveBeenCalled();
    expect(prisma.trip.update).not.toHaveBeenCalled();
    expect(r.polylineMatched).toBe(JSON.stringify(RECALE));
  });

  it('le périmètre est celui de findOne : hors périmètre, 404, et rien n’est recalé', async () => {
    const { svc, mapMatching } = build(null);

    await expect(svc.recaler('t1', DEMANDEUR)).rejects.toBeInstanceOf(NotFoundException);
    expect(mapMatching.match).not.toHaveBeenCalled();
  });

  it('un refus d’OSRM ne range rien et le dit, sans lever', async () => {
    const { svc, prisma } = build({ id: 't1', polyline: JSON.stringify(BRUT), polylineMatched: null }, null);

    const r = await svc.recaler('t1', DEMANDEUR);

    expect(r).toEqual({ polylineMatched: null, enCours: false });
    expect(prisma.trip.update).not.toHaveBeenCalled();
  });

  it('deux rejeux ouverts en même temps ne lancent qu’un recalage — le second apprend qu’il est en cours', async () => {
    const { svc, mapMatching } = build({ id: 't1', polyline: JSON.stringify(BRUT), polylineMatched: null }, RECALE, 30);

    const premier = svc.recaler('t1', DEMANDEUR);
    const second = await svc.recaler('t1', DEMANDEUR);
    const r1 = await premier;

    expect(second).toEqual({ polylineMatched: null, enCours: true });
    expect(r1.polylineMatched).toBe(JSON.stringify(RECALE));
    expect(mapMatching.match).toHaveBeenCalledTimes(1);
  });

  it('une polyligne illisible ou d’un seul point ne lance rien', async () => {
    const { svc, mapMatching } = build({ id: 't1', polyline: '{pas du json', polylineMatched: null });
    expect(await svc.recaler('t1', DEMANDEUR)).toEqual({ polylineMatched: null, enCours: false });
    const seul = build({ id: 't1', polyline: JSON.stringify([BRUT[0]]), polylineMatched: null });
    expect(await seul.svc.recaler('t1', DEMANDEUR)).toEqual({ polylineMatched: null, enCours: false });
    expect(mapMatching.match).not.toHaveBeenCalled();
    expect(seul.mapMatching.match).not.toHaveBeenCalled();
  });
});
