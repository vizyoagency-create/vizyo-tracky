import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GpsDeadZonesService } from './gps-dead-zones.service';

/**
 * Zones mortes GPS — clustering incrémental des pertes GPS récurrentes (parking souterrain /
 * tunnel / brouilleur). Points vérifiés : création/extension d'un cluster, idempotence par
 * épisode (`lostAt`), promotion LEARNING→RECURRING au seuil, préservation des décisions
 * opérateur, et scoping d'accès de la revue.
 */
describe('GpsDeadZonesService', () => {
  const buildPrisma = () =>
    ({
      gpsLossEvent: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      gpsDeadZone: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
      vehicle: { findFirst: jest.fn() },
    }) as any;

  const build = () => {
    const prisma = buildPrisma();
    const geocode = { label: jest.fn().mockResolvedValue(null) } as any;
    const svc = new GpsDeadZonesService(prisma, geocode);
    return { svc, prisma, geocode };
  };

  const superAdmin = { userId: 'u1', role: 'SUPER_ADMIN', fleetId: null } as const;

  const lossInput = (over: Record<string, unknown> = {}) => ({
    vehicleId: 'v1',
    fleetId: 'f1',
    trackerId: 't1',
    lat: 43.6,
    lng: 1.45,
    lostAt: new Date('2026-07-14T08:00:00Z'),
    ...over,
  });

  it('crée une nouvelle zone (LEARNING) à la première perte et lie l\'épisode', async () => {
    const { svc, prisma } = build();
    prisma.gpsLossEvent.create.mockResolvedValue({ id: 'e1' });
    prisma.gpsDeadZone.findMany.mockResolvedValue([]);
    prisma.gpsDeadZone.create.mockResolvedValue({
      id: 'z1', vehicleId: 'v1', occurrences: 1, status: 'LEARNING', centroidLat: 43.6, centroidLng: 1.45, placeLabel: null,
    });

    const res = await svc.recordLoss(lossInput());

    expect(res).toMatchObject({ isNewEpisode: true });
    expect(res!.zone.id).toBe('z1');
    expect(prisma.gpsDeadZone.create).toHaveBeenCalledTimes(1);
    expect(prisma.gpsDeadZone.create.mock.calls[0][0].data).toMatchObject({
      vehicleId: 'v1', fleetId: 'f1', occurrences: 1, status: 'LEARNING', centroidLat: 43.6, centroidLng: 1.45,
    });
    // L'épisode est rattaché à la zone.
    expect(prisma.gpsLossEvent.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { zoneId: 'z1' } });
  });

  it('est IDEMPOTENT : un épisode déjà connu ne heurte PAS la contrainte (pas de create) et ne re-cluster pas', async () => {
    const { svc, prisma } = build();
    prisma.gpsLossEvent.findUnique.mockResolvedValue({ id: 'e1', zone: { id: 'z1', occurrences: 3 } });

    const res = await svc.recordLoss(lossInput());

    expect(res).toMatchObject({ isNewEpisode: false });
    expect(res!.zone.id).toBe('z1');
    // Le check préalable évite la contrainte unique → create JAMAIS appelé (plus de prisma:error en boucle).
    expect(prisma.gpsLossEvent.create).not.toHaveBeenCalled();
    // Aucune écriture de clustering : ni findMany, ni create, ni update de zone.
    expect(prisma.gpsDeadZone.findMany).not.toHaveBeenCalled();
    expect(prisma.gpsDeadZone.create).not.toHaveBeenCalled();
    expect(prisma.gpsDeadZone.update).not.toHaveBeenCalled();
  });

  it('course rare : create throw P2002 après un check vide → idempotent via re-lecture', async () => {
    const { svc, prisma } = build();
    const dup = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
    prisma.gpsLossEvent.findUnique
      .mockResolvedValueOnce(null) // check initial : rien
      .mockResolvedValueOnce({ id: 'e1', zone: { id: 'z1', occurrences: 2 } }); // re-lecture après P2002
    prisma.gpsLossEvent.create.mockRejectedValue(dup);

    const res = await svc.recordLoss(lossInput());

    expect(res).toMatchObject({ isNewEpisode: false });
    expect(prisma.gpsDeadZone.create).not.toHaveBeenCalled();
  });

  it('rattache une perte proche à la zone existante et incrémente les occurrences', async () => {
    const { svc, prisma } = build();
    prisma.gpsLossEvent.create.mockResolvedValue({ id: 'e2' });
    // Zone existante ~12 m plus loin, déjà 2 occurrences.
    prisma.gpsDeadZone.findMany.mockResolvedValue([
      { id: 'z1', vehicleId: 'v1', centroidLat: 43.6, centroidLng: 1.45, radiusM: 8, occurrences: 2, status: 'LEARNING', label: 'UNKNOWN', reviewedAt: null, placeLabel: 'Toulouse' },
    ]);
    prisma.gpsDeadZone.update.mockImplementation(({ data }: any) => ({ id: 'z1', ...data }));

    const res = await svc.recordLoss(lossInput({ lat: 43.6001, lng: 1.45, lostAt: new Date('2026-07-15T08:00:00Z') }));

    expect(prisma.gpsDeadZone.create).not.toHaveBeenCalled();
    expect(prisma.gpsDeadZone.update).toHaveBeenCalledTimes(1);
    const data = prisma.gpsDeadZone.update.mock.calls[0][0].data;
    expect(data.occurrences).toBe(3);
    // ⚠️ RECALIBRÉ le 2026-08-17. Ce test attendait `RECURRING` (3 >= minOccurrences).
    // Depuis la règle du parking souterrain, une zone JAMAIS revue est qualifiée dès la
    // 2ᵉ occurrence — elle est donc déjà `CONFIRMED_BENIGN` en arrivant à 3. La promotion
    // LEARNING→RECURRING reste testée ci-dessous, avec un seuil de parking relevé.
    expect(data.status).toBe('CONFIRMED_BENIGN');
    expect(data.label).toBe('UNDERGROUND_PARKING');
    expect(res!.zone.id).toBe('z1');
  });

  // --- 2026-08-17 : qualification AUTOMATIQUE en parking souterrain ----------------------
  //
  // Cause réelle terrain : les véhicules se garent dans des parkings souterrains. Reperdre
  // le GPS au MÊME endroit signe un lieu, pas une panne. À la 2ᵉ perte le lieu est qualifié
  // et devient silencieux ; la 1ʳᵉ alerte toujours.

  describe('qualification automatique en parking', () => {
    const zoneAt = (occurrences: number, over: Record<string, unknown> = {}) => ({
      id: 'z1',
      vehicleId: 'v1',
      centroidLat: 43.6,
      centroidLng: 1.45,
      radiusM: 8,
      occurrences,
      status: 'LEARNING',
      label: 'UNKNOWN',
      reviewedAt: null,
      placeLabel: 'Toulouse',
      ...over,
    });

    const recordSecondLoss = async (zone: Record<string, unknown>) => {
      const { svc, prisma } = build();
      prisma.gpsLossEvent.create.mockResolvedValue({ id: 'e9' });
      prisma.gpsDeadZone.findMany.mockResolvedValue([zone]);
      prisma.gpsDeadZone.update.mockImplementation(({ data }: any) => ({ id: 'z1', ...data }));
      await svc.recordLoss(lossInput({ lat: 43.6001, lng: 1.45, lostAt: new Date('2026-07-16T08:00:00Z') }));
      return prisma.gpsDeadZone.update.mock.calls[0][0].data;
    };

    it('🔑 qualifie UNDERGROUND_PARKING + CONFIRMED_BENIGN à la 2ᵉ occurrence', async () => {
      const data = await recordSecondLoss(zoneAt(1));
      expect(data.occurrences).toBe(2);
      expect(data.label).toBe('UNDERGROUND_PARKING');
      expect(data.status).toBe('CONFIRMED_BENIGN');
    });

    it('🔑 ne qualifie RIEN à la 1ʳᵉ occurrence — la première perte doit alerter', async () => {
      const { svc, prisma } = build();
      prisma.gpsLossEvent.create.mockResolvedValue({ id: 'e1' });
      prisma.gpsDeadZone.findMany.mockResolvedValue([]);
      prisma.gpsDeadZone.create.mockResolvedValue({ id: 'z1', occurrences: 1, status: 'LEARNING', label: 'UNKNOWN', centroidLat: 43.6, centroidLng: 1.45, placeLabel: null });

      await svc.recordLoss(lossInput());

      // C'est le seul signal utile pour l'exploitant : un véhicule a perdu le GPS ICI.
      const data = prisma.gpsDeadZone.create.mock.calls[0][0].data;
      expect(data.status).toBe('LEARNING');
      expect(data.label).toBeUndefined(); // défaut Prisma = UNKNOWN, jamais posé à la main
    });

    it('⚠️ ne TOUCHE PAS une zone revue par un opérateur (SUSPECT reste SUSPECT)', async () => {
      const data = await recordSecondLoss(
        zoneAt(1, { status: 'SUSPECT', label: 'JAMMER_SUSPECTED', reviewedAt: new Date('2026-08-01') }),
      );
      // Un humain qui soupçonne un brouilleur ne doit jamais voir son verdict écrasé par
      // une heuristique — sinon on éteint l'alerte exactement là où elle compte.
      expect(data.status).toBe('SUSPECT');
      expect(data.label).toBe('JAMMER_SUSPECTED');
    });

    it("⚠️ ne requalifie pas une zone revue laissée en UNKNOWN (l'opérateur a tranché le statut)", async () => {
      const data = await recordSecondLoss(
        zoneAt(1, { status: 'RECURRING', label: 'UNKNOWN', reviewedAt: new Date('2026-08-01') }),
      );
      expect(data.label).toBe('UNKNOWN');
      expect(data.status).toBe('RECURRING');
    });

    it('traite un champ ABSENT comme « jamais qualifiée » (mock partiel ≡ null Prisma)', async () => {
      // Garde-fou de cohérence mock/réalité : Prisma rend `null`/`UNKNOWN`, un objet partiel
      // rend `undefined`. Les deux doivent déclencher la qualification, sinon le test et la
      // production divergent en silence.
      const partielle = { id: 'z1', vehicleId: 'v1', centroidLat: 43.6, centroidLng: 1.45, radiusM: 8, occurrences: 1, status: 'LEARNING' };
      const data = await recordSecondLoss(partielle);
      expect(data.label).toBe('UNDERGROUND_PARKING');
      expect(data.status).toBe('CONFIRMED_BENIGN');
    });

    it('respecte GPS_DEADZONE_AUTO_PARKING_OCCURRENCES — et la promotion RECURRING reste vivante', async () => {
      const prev = process.env.GPS_DEADZONE_AUTO_PARKING_OCCURRENCES;
      process.env.GPS_DEADZONE_AUTO_PARKING_OCCURRENCES = '5';
      try {
        const prisma = buildPrisma();
        const svc = new GpsDeadZonesService(prisma, { label: jest.fn().mockResolvedValue(null) } as any);
        prisma.gpsLossEvent.create.mockResolvedValue({ id: 'e9' });
        prisma.gpsDeadZone.findMany.mockResolvedValue([zoneAt(2)]);
        prisma.gpsDeadZone.update.mockImplementation(({ data }: any) => ({ id: 'z1', ...data }));

        await svc.recordLoss(lossInput({ lat: 43.6001, lng: 1.45, lostAt: new Date('2026-07-16T08:00:00Z') }));

        // Seuil de parking relevé à 5 → à 3 occurrences, c'est la promotion historique
        // LEARNING→RECURRING (minOccurrences = 3) qui s'applique. Ce chemin n'est donc pas
        // du code mort : il redevient atteignable dès que les deux seuils se croisent.
        const data = prisma.gpsDeadZone.update.mock.calls[0][0].data;
        expect(data.occurrences).toBe(3);
        expect(data.status).toBe('RECURRING');
        expect(data.label).toBe('UNKNOWN');
      } finally {
        if (prev === undefined) delete process.env.GPS_DEADZONE_AUTO_PARKING_OCCURRENCES;
        else process.env.GPS_DEADZONE_AUTO_PARKING_OCCURRENCES = prev;
      }
    });

    it('plancher DUR à 2 : un seuil à 1 est refusé (la 1ʳᵉ perte doit toujours alerter)', () => {
      const prev = process.env.GPS_DEADZONE_AUTO_PARKING_OCCURRENCES;
      process.env.GPS_DEADZONE_AUTO_PARKING_OCCURRENCES = '1';
      try {
        const svc = new GpsDeadZonesService(buildPrisma(), { label: jest.fn() } as any);
        // Un 1 accepté rendrait le détecteur muet dès la première perte, donc inutile.
        expect(svc.autoParkingOccurrences).toBe(2);
      } finally {
        if (prev === undefined) delete process.env.GPS_DEADZONE_AUTO_PARKING_OCCURRENCES;
        else process.env.GPS_DEADZONE_AUTO_PARKING_OCCURRENCES = prev;
      }
    });
  });

  it('crée une SECONDE zone quand la perte est loin de toute zone existante', async () => {
    const { svc, prisma } = build();
    prisma.gpsLossEvent.create.mockResolvedValue({ id: 'e3' });
    prisma.gpsDeadZone.findMany.mockResolvedValue([
      { id: 'z1', vehicleId: 'v1', centroidLat: 43.6, centroidLng: 1.45, radiusM: 20, occurrences: 5, status: 'RECURRING', placeLabel: 'Toulouse' },
    ]);
    prisma.gpsDeadZone.create.mockResolvedValue({ id: 'z2', occurrences: 1, status: 'LEARNING', centroidLat: 48.85, centroidLng: 2.35, placeLabel: null });

    await svc.recordLoss(lossInput({ lat: 48.85, lng: 2.35 })); // Paris, très loin

    expect(prisma.gpsDeadZone.update).not.toHaveBeenCalled();
    expect(prisma.gpsDeadZone.create).toHaveBeenCalledTimes(1);
  });

  it('ne régresse PAS une décision opérateur (CONFIRMED_BENIGN reste, occurrences++)', async () => {
    const { svc, prisma } = build();
    prisma.gpsLossEvent.create.mockResolvedValue({ id: 'e4' });
    prisma.gpsDeadZone.findMany.mockResolvedValue([
      { id: 'z1', vehicleId: 'v1', centroidLat: 43.6, centroidLng: 1.45, radiusM: 15, occurrences: 4, status: 'CONFIRMED_BENIGN', placeLabel: 'Toulouse' },
    ]);
    prisma.gpsDeadZone.update.mockImplementation(({ data }: any) => ({ id: 'z1', ...data }));

    await svc.recordLoss(lossInput({ lat: 43.6, lng: 1.45 }));

    const data = prisma.gpsDeadZone.update.mock.calls[0][0].data;
    expect(data.occurrences).toBe(5);
    expect(data.status).toBe('CONFIRMED_BENIGN'); // préservé
  });

  it('renvoie null pour des coordonnées invalides', async () => {
    const { svc, prisma } = build();
    const res = await svc.recordLoss(lossInput({ lat: NaN }));
    expect(res).toBeNull();
    expect(prisma.gpsLossEvent.create).not.toHaveBeenCalled();
  });

  it('review() applique statut/label + traçabilité et scope l\'accès véhicule', async () => {
    const { svc, prisma } = build();
    prisma.gpsDeadZone.findUnique.mockResolvedValue({ id: 'z1', vehicleId: 'v1' });
    prisma.vehicle.findFirst.mockResolvedValue({ id: 'v1' });
    prisma.gpsDeadZone.update.mockResolvedValue({
      id: 'z1', vehicleId: 'v1', fleetId: 'f1', centroidLat: 43.6, centroidLng: 1.45, radiusM: 12, occurrences: 4,
      firstSeenAt: new Date(), lastSeenAt: new Date(), status: 'CONFIRMED_BENIGN', label: 'UNDERGROUND_PARKING',
      placeLabel: 'Toulouse', note: 'Parking bureau', reviewedAt: new Date(), events: [],
    });

    const dto = await svc.review('z1', superAdmin as any, { status: 'CONFIRMED_BENIGN' as any, label: 'UNDERGROUND_PARKING' as any, note: 'Parking bureau' });

    expect(dto.status).toBe('CONFIRMED_BENIGN');
    expect(dto.label).toBe('UNDERGROUND_PARKING');
    const data = prisma.gpsDeadZone.update.mock.calls[0][0].data;
    expect(data.reviewedById).toBe('u1');
    expect(data.reviewedAt).toBeInstanceOf(Date);
  });

  it('review() renvoie 404 si la zone est hors du périmètre d\'accès', async () => {
    const { svc, prisma } = build();
    prisma.gpsDeadZone.findUnique.mockResolvedValue({ id: 'z1', vehicleId: 'v1' });
    prisma.vehicle.findFirst.mockResolvedValue(null); // véhicule non accessible → 404

    await expect(
      svc.review('z1', { userId: 'u2', role: 'FLEET_MANAGER', fleetId: 'f2', accessibleVehicleIds: ['other'] } as any, { status: 'SUSPECT' as any }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listForMap() renvoie les zones scopées avec plaque + filtre statut/occurrences', async () => {
    const { svc, prisma } = build();
    prisma.gpsDeadZone.findMany.mockResolvedValue([
      { id: 'z1', vehicleId: 'v1', vehicle: { plate: 'AA-123-BB' }, centroidLat: 43.6, centroidLng: 1.45, radiusM: 30, occurrences: 5, status: 'CONFIRMED_BENIGN', label: 'UNDERGROUND_PARKING', placeLabel: 'Toulouse' },
    ]);

    const res = await svc.listForMap({ userId: 'u1', role: 'FLEET_ADMIN', fleetId: 'f1', accessibleVehicleIds: 'ALL' } as any);

    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: 'z1', plate: 'AA-123-BB', status: 'CONFIRMED_BENIGN', occurrences: 5 });
    const where = prisma.gpsDeadZone.findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBe('f1'); // non super-admin borné à sa flotte
    expect(where.OR).toBeDefined(); // filtre « installées » (statut/occurrences)
  });

  it('listForMap() : super-admin sans fleetId voit toutes les flottes', async () => {
    const { svc, prisma } = build();
    prisma.gpsDeadZone.findMany.mockResolvedValue([]);

    await svc.listForMap({ userId: 'u1', role: 'SUPER_ADMIN', fleetId: null, accessibleVehicleIds: 'ALL' } as any);

    const where = prisma.gpsDeadZone.findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBeUndefined();
  });
});
