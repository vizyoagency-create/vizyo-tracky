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

  /**
   * ── TRK-028 : LE RETOUR DU SIGNAL ──────────────────────────────────────────────────
   *
   * Jusqu'ici la table n'enregistrait que l'ENTRÉE en zone morte. La fiche véhicule
   * pouvait donc affirmer « la position réapparaîtra à la sortie » sans jamais pouvoir
   * le montrer — une promesse sans preuve. Ces tests verrouillent les deux moitiés :
   * fermer l'épisode au bon instant, et n'annoncer une durée que lorsqu'on en a une.
   */
  describe('recordRecovery — refermer un épisode', () => {
    const PERTE = new Date('2026-08-16T21:00:00Z');

    /**
     * @param lostAtCourant la perte de l'épisode ouvert le PLUS RÉCENT, ou `null` si le
     *                      véhicule n'en porte aucun.
     */
    const buildAvecRecovery = (lostAtCourant: Date | null = PERTE) => {
      const prisma = buildPrisma();
      prisma.gpsLossEvent.findFirst = jest
        .fn()
        .mockResolvedValue(lostAtCourant ? { lostAt: lostAtCourant } : null);
      prisma.gpsLossEvent.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const svc = new GpsDeadZonesService(prisma, { label: jest.fn() } as any);
      return { svc, prisma };
    };

    it('ne ferme QUE les épisodes ouverts — une date déjà posée ne se réécrit pas', async () => {
      // ⚠️ C'est l'invariant central. La PREMIÈRE position valide après la perte est la
      // bonne ; si un appel ultérieur pouvait écraser la date, chaque trame suivante
      // allongerait l'absence et la durée médiane deviendrait un pur artefact.
      //
      // ⚠️ TEST RECALIBRÉ le 2026-08-20 (TRK-031), PAS supprimé : il attendait
      // `where === { vehicleId, recoveredAt: null }` — c'est-à-dire qu'il VERROUILLAIT
      // l'absence de borne, donc le défaut lui-même. L'invariant qu'il défend (ne pas
      // réécrire une date posée) reste vrai et reste vérifié ici.
      const { svc, prisma } = buildAvecRecovery();
      const at = new Date('2026-08-17T09:30:00Z');

      await svc.recordRecovery({ vehicleId: 'v1', at });

      const appel = prisma.gpsLossEvent.updateMany.mock.calls[0][0];
      expect(appel.where.vehicleId).toBe('v1');
      expect(appel.where.recoveredAt).toBeNull();
      expect(appel.data).toEqual({ recoveredAt: at });
    });

    it('rend le nombre d’épisodes refermés — plusieurs peuvent traîner ouverts', async () => {
      const { svc, prisma } = buildAvecRecovery();
      prisma.gpsLossEvent.updateMany.mockResolvedValue({ count: 3 });
      const n = await svc.recordRecovery({ vehicleId: 'v1', at: new Date('2026-08-17T09:30:00Z') });
      expect(n).toBe(3);
    });

    it('refuse une date invalide sans toucher à la base', async () => {
      const { svc, prisma } = buildAvecRecovery();
      const n = await svc.recordRecovery({ vehicleId: 'v1', at: new Date('pas une date') });
      expect(n).toBe(0);
      expect(prisma.gpsLossEvent.updateMany).not.toHaveBeenCalled();
    });

    /**
     * ── TRK-031 : NE PAS FABRIQUER D'ABSENCE (2026-08-20) ────────────────────────────
     *
     * Le cas réel : FS-253-HR ressort de son parking le 19/08 à 13:48:56 et NEUF épisodes
     * se referment à cette seconde, dont un ouvert le 15/07 — déclaré long de 35,18 jours
     * alors que le boîtier a émis 5 027 positions pendant l'intervalle.
     */
    it('🔴 ne referme PAS un épisode d’un autre mois — il borne sur le plus récent', async () => {
      // LE test du correctif : il échoue sur le code d'avant, qui ne posait aucune borne.
      const { svc, prisma } = buildAvecRecovery(new Date('2026-08-12T15:20:59Z'));

      await svc.recordRecovery({ vehicleId: 'v1', at: new Date('2026-08-19T13:48:56Z') });

      const where = prisma.gpsLossEvent.updateMany.mock.calls[0][0].where;
      expect(where.lostAt).toBeDefined();
      // Un épisode du 15/07 est HORS de la fenêtre : il reste ouvert.
      expect(new Date('2026-07-15T09:31:02Z').getTime()).toBeLessThan(where.lostAt.gte.getTime());
    });

    it('mais ferme bien les DOUBLONS de la même perte — c’était l’intention d’origine', async () => {
      // Le cron peut ouvrir plusieurs épisodes pour une seule perte s'il tourne pendant
      // que la donnée est incohérente. Ceux-là naissent à quelques minutes d'écart.
      const { svc, prisma } = buildAvecRecovery(new Date('2026-08-12T15:20:59Z'));

      await svc.recordRecovery({ vehicleId: 'v1', at: new Date('2026-08-19T13:48:56Z') });

      const where = prisma.gpsLossEvent.updateMany.mock.calls[0][0].where;
      // Un doublon né 3 minutes avant l'épisode courant est DANS la fenêtre.
      expect(new Date('2026-08-12T15:17:59Z').getTime()).toBeGreaterThanOrEqual(
        where.lostAt.gte.getTime(),
      );
    });

    it('🔴 une absence de cinq semaines se ferme NORMALEMENT — la borne n’est pas une ancienneté', async () => {
      // ⚠️ Le piège qu'une « fenêtre max de 7 jours » aurait créé : un véhicule réellement
      // absent cinq semaines a une absence de cinq semaines. La refuser laisserait son
      // épisode ouvert pour toujours, ce qui est une autre façon de mentir.
      const { svc, prisma } = buildAvecRecovery(new Date('2026-07-15T09:31:02Z'));

      const n = await svc.recordRecovery({ vehicleId: 'v1', at: new Date('2026-08-19T13:48:56Z') });

      expect(n).toBe(1);
      expect(prisma.gpsLossEvent.updateMany).toHaveBeenCalled();
    });

    it('aucun épisode ouvert : aucune écriture', async () => {
      const { svc, prisma } = buildAvecRecovery(null);
      const n = await svc.recordRecovery({ vehicleId: 'v1', at: new Date('2026-08-19T13:48:56Z') });
      expect(n).toBe(0);
      expect(prisma.gpsLossEvent.updateMany).not.toHaveBeenCalled();
    });

    it('🔴 un retour ANTÉRIEUR à la perte est refusé — trame rejouée après coupure réseau', async () => {
      // Un Coban qui rejoue son tampon émet des horodatages antérieurs au temps réel
      // (TRK-015). Sans ce garde-fou : durée négative, écartée en silence du calcul de
      // médiane, et un épisode marqué clos qui ne l'est pas.
      const { svc, prisma } = buildAvecRecovery(new Date('2026-08-16T21:00:00Z'));

      const n = await svc.recordRecovery({ vehicleId: 'v1', at: new Date('2026-08-16T20:45:00Z') });

      expect(n).toBe(0);
      expect(prisma.gpsLossEvent.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('durée typique — la médiane, jamais la moyenne', () => {
    const zone = { id: 'z1', vehicleId: 'v1', fleetId: 'f1', centroidLat: 43.6, centroidLng: 1.45, radiusM: 40, occurrences: 4, firstSeenAt: new Date('2026-07-01T00:00:00Z'), lastSeenAt: new Date('2026-08-17T00:00:00Z'), status: 'CONFIRMED_BENIGN', label: 'UNDERGROUND_PARKING', placeLabel: 'Toulouse', note: null, reviewedById: null, reviewedAt: null, createdAt: new Date(), updatedAt: new Date() } as any;

    const episode = (lostAt: string, recoveredAt: string | null) => ({
      lat: 43.6, lng: 1.45, lostAt: new Date(lostAt),
      detectedAt: new Date(lostAt),
      recoveredAt: recoveredAt ? new Date(recoveredAt) : null,
    });

    const lire = async (events: unknown[]) => {
      const prisma = buildPrisma();
      prisma.vehicle.findFirst.mockResolvedValue({ id: 'v1', fleetId: 'f1' });
      prisma.gpsDeadZone.findMany.mockResolvedValue([{ ...zone, events }]);
      const svc = new GpsDeadZonesService(prisma, { label: jest.fn() } as any);
      const [dto] = await svc.listForVehicle('v1', superAdmin as any);
      return dto;
    };

    it('⚠️ un week-end au parking ne doit pas gonfler la durée annoncée', async () => {
      // Trois sorties ordinaires (~3 h) et un stationnement de 72 h. La MOYENNE donnerait
      // plus de 20 h — une durée que l'exploitant ne verra jamais. La médiane décrit le
      // cas ordinaire, qui est précisément ce qu'on cherche à faire comprendre.
      const dto = await lire([
        episode('2026-08-01T08:00:00Z', '2026-08-01T11:00:00Z'), // 180 min
        episode('2026-08-02T08:00:00Z', '2026-08-02T11:10:00Z'), // 190 min
        episode('2026-08-03T08:00:00Z', '2026-08-03T11:20:00Z'), // 200 min
        episode('2026-08-08T18:00:00Z', '2026-08-11T18:00:00Z'), // 4320 min (week-end)
      ]);
      // Médiane de [180, 190, 200, 4320] = (190 + 200) / 2 = 195.
      expect(dto.typicalOutageMinutes).toBe(195);
    });

    it('ignore les épisodes encore ouverts — une absence en cours n’a pas de durée', async () => {
      const dto = await lire([
        episode('2026-08-01T08:00:00Z', '2026-08-01T11:00:00Z'),
        episode('2026-08-17T08:00:00Z', null), // le véhicule est dedans en ce moment
      ]);
      expect(dto.typicalOutageMinutes).toBe(180);
    });

    it('reste NULL tant qu’aucun épisode n’est refermé — on se tait plutôt que deviner', async () => {
      const dto = await lire([episode('2026-08-17T08:00:00Z', null)]);
      expect(dto.typicalOutageMinutes).toBeNull();
    });

    it('expose le retour du signal sur chaque épisode', async () => {
      const dto = await lire([episode('2026-08-01T08:00:00Z', '2026-08-01T11:00:00Z')]);
      expect(dto.recentEvents[0].recoveredAt).toBe('2026-08-01T11:00:00.000Z');
    });
  });
});
