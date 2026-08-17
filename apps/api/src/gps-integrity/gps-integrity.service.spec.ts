import { GpsIntegrityService } from './gps-integrity.service';

/**
 * Incident FS-253 — le détecteur repère un boîtier VIVANT sans position GPS et lève une
 * alerte véhicule + une entrée centre d'alertes (ErrorLog), SANS spammer (dédup) et SANS
 * casser la boucle sur une erreur isolée.
 *
 * Zones mortes GPS (2026-07) — au-dessus : chaque perte est enregistrée (recordLoss). Si elle
 * tombe dans une zone CONFIRMÉE « normale » (parking souterrain) l'alerte est SUPPRIMÉE ; une
 * zone RÉCURRENTE non suspecte alerte le fleet-admin mais n'inonde plus le centre admin ; une
 * zone SUSPECTE (brouilleur) reste remontée au centre admin.
 */
describe('GpsIntegrityService', () => {
  const makeTracker = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    imei: '864035054757027',
    lastLat: 43.6,
    lastLng: 1.45,
    lastPositionAt: new Date(Date.now() - 29 * 3600_000), // 29 h
    vehicle: { id: 'v1', plate: 'FS-253-HR', fleetId: 'f1' },
    ...over,
  });

  const build = (recordLossResult: unknown = null) => {
    const prisma = {
      tracker: { findMany: jest.fn() },
      // Backoff des rappels (2026-08-10) : `null` = aucune ligne récente pour ce boîtier,
      // donc le rappel part. Les tests dédiés ci-dessous couvrent le cas inverse.
      errorLog: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any;
    const alerts = { createGpsLostAlert: jest.fn() } as any;
    const deadZones = {
      minOccurrences: 3,
      recordLoss: jest.fn().mockResolvedValue(recordLossResult),
    } as any;
    const errorLogger = {
      record: jest.fn().mockResolvedValue(undefined),
      recordBackground: jest.fn(),
    } as any;
    const svc = new GpsIntegrityService(prisma, alerts, deadZones, errorLogger);
    return { svc, prisma, alerts, deadZones, errorLogger };
  };

  it('lève une alerte + un ErrorLog pour un boîtier vivant sans GPS (nouvelle alerte)', async () => {
    const { svc, prisma, alerts, deadZones, errorLogger } = build();
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' }); // créée (pas un doublon)

    await svc.tick();

    // La perte est enregistrée pour le clustering des zones mortes.
    expect(deadZones.recordLoss).toHaveBeenCalledTimes(1);
    expect(deadZones.recordLoss.mock.calls[0][0]).toMatchObject({ vehicleId: 'v1', fleetId: 'f1', trackerId: 't1' });

    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(1);
    const [tracker, vehicle, ago] = alerts.createGpsLostAlert.mock.calls[0];
    expect(tracker.imei).toBe('864035054757027');
    expect(vehicle.plate).toBe('FS-253-HR');
    expect(ago).toContain('h'); // « 29 h »
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    expect(errorLogger.record.mock.calls[0][1]).toBe('gps-integrity');
  });

  it('ne remonte PAS d\'ErrorLog quand l\'alerte est dédupliquée (déjà ouverte)', async () => {
    const { svc, prisma, alerts, errorLogger } = build();
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue(null); // doublon → skip

    await svc.tick();

    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(1);
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('ne fait rien quand aucun boîtier n\'est concerné', async () => {
    const { svc, prisma, alerts } = build();
    prisma.tracker.findMany.mockResolvedValue([]);

    await svc.tick();

    expect(alerts.createGpsLostAlert).not.toHaveBeenCalled();
  });

  it('une erreur sur un boîtier ne casse pas la boucle (best-effort)', async () => {
    const { svc, prisma, alerts, errorLogger } = build();
    prisma.tracker.findMany.mockResolvedValue([
      makeTracker({ id: 't1', imei: 'AAA' }),
      makeTracker({ id: 't2', imei: 'BBB' }),
    ]);
    alerts.createGpsLostAlert
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'a2' });

    await expect(svc.tick()).resolves.toBeUndefined();

    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(2);
    expect(errorLogger.record).toHaveBeenCalledTimes(1); // seulement le 2e (le 1er a throw)
  });

  it('interroge la base avec le bon filtre (vivant + no_fix récent + position périmée)', async () => {
    const { svc, prisma } = build();
    prisma.tracker.findMany.mockResolvedValue([]);

    await svc.tick();

    const where = prisma.tracker.findMany.mock.calls[0][0].where;
    expect(where.vehicleId).toEqual({ not: null });
    expect(where.lastSeenAt.gte).toBeInstanceOf(Date);
    expect(where.lastNoFixAt.gte).toBeInstanceOf(Date);
    expect(where.OR).toEqual([{ lastPositionAt: null }, { lastPositionAt: { lt: expect.any(Date) } }]);
  });

  // --- Zones mortes GPS -----------------------------------------------------------------

  it('SUPPRIME l\'alerte quand la perte tombe dans une zone confirmée « normale »', async () => {
    const { svc, prisma, alerts, errorLogger } = build({
      zone: { id: 'z1', status: 'CONFIRMED_BENIGN', occurrences: 8 },
      isNewEpisode: false,
    });
    // ⚠️ Perte COURTE (3 h) : depuis TRK-011, le silence d'une zone bénigne est borné à 24 h.
    // Ce test utilisait le défaut de `makeTracker` (29 h) et verrouillait donc, sans le vouloir,
    // le trou que TRK-011 a bouché. Son intention — « un parking habituel ne réalerte pas » —
    // reste exacte ; c'est la durée qu'il fallait rendre explicite.
    prisma.tracker.findMany.mockResolvedValue([
      makeTracker({ lastPositionAt: new Date(Date.now() - 3 * 3600_000) }),
    ]);

    await svc.tick();

    // Parking souterrain habituel confirmé → aucune alerte, aucun ErrorLog.
    expect(alerts.createGpsLostAlert).not.toHaveBeenCalled();
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  // --- TRK-011 : le silence d'une zone bénigne est BORNÉ ---------------------------------

  it('alerte MALGRÉ une zone confirmée bénigne quand la perte dépasse le plafond', async () => {
    const { svc, prisma, alerts, errorLogger } = build({
      zone: { id: 'z1', status: 'CONFIRMED_BENIGN', occurrences: 5 },
      isNewEpisode: false,
    });
    // 29 h : au-delà du plafond de 24 h.
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

    await svc.tick();

    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(1);
    // Le 6e argument porte le dépassement → l'alerte flotte peut expliquer pourquoi elle parle.
    expect(alerts.createGpsLostAlert.mock.calls[0][5]).toEqual({ thresholdLabel: '1 j' });

    // 🔑 Le point décisif : une zone confirmée est aussi « recognized », donc sans le forçage
    // explicite le dépassement n'aurait produit AUCUNE ligne au centre d'alerte.
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    const [err, source, ctx] = errorLogger.record.mock.calls[0];
    expect(source).toBe('gps-integrity');
    expect((err as Error).message).toContain('ANORMALEMENT LONG');
    expect((ctx as Record<string, unknown>).benignSilenceExceeded).toBe(true);
  });

  // --- 2026-08-17 : la règle du parking souterrain ---------------------------------------
  //
  // Le plafond de TRK-011 ci-dessus reste juste pour une zone bénigne SANS nature connue.
  // Sur un parking, il est structurellement faux : un véhicule peut y rester garé des
  // semaines. Ces tests verrouillent la frontière entre les deux.

  describe('zone qualifiée PARKING — silence sans plafond de durée', () => {
    const parkingZone = (over: Record<string, unknown> = {}) => ({
      zone: {
        id: 'z1',
        status: 'CONFIRMED_BENIGN',
        label: 'UNDERGROUND_PARKING',
        occurrences: 2,
        ...over,
      },
      isNewEpisode: false,
    });

    it('reste MUET sur un parking souterrain, même à 29 h (au-delà du plafond)', async () => {
      const { svc, prisma, alerts, errorLogger } = build(parkingZone());
      prisma.tracker.findMany.mockResolvedValue([makeTracker()]); // 29 h

      await svc.tick();

      // C'est exactement le cas qui produisait « GPS perdu ANORMALEMENT LONG » en production :
      // 18 des 27 lignes `gps-integrity`, sur deux zones déjà qualifiées parking.
      expect(alerts.createGpsLostAlert).not.toHaveBeenCalled();
      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    it('reste MUET sur un parking après 5 JOURS — une durée n’est plus un signal ici', async () => {
      const { svc, prisma, alerts, errorLogger } = build(parkingZone());
      prisma.tracker.findMany.mockResolvedValue([
        makeTracker({ lastPositionAt: new Date(Date.now() - 120 * 3600_000) }),
      ]);

      await svc.tick();

      // 120 h = le cas réel de FS-253-HR au 17/08. Congés, immobilisation : un parking
      // explique une perte de durée quelconque.
      expect(alerts.createGpsLostAlert).not.toHaveBeenCalled();
      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    it('reste MUET aussi sur un parking COUVERT', async () => {
      const { svc, prisma, alerts, errorLogger } = build(parkingZone({ label: 'COVERED_PARKING' }));
      prisma.tracker.findMany.mockResolvedValue([makeTracker()]);

      await svc.tick();

      expect(alerts.createGpsLostAlert).not.toHaveBeenCalled();
      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    it('🔑 le plafond TRK-011 s’applique TOUJOURS à une zone bénigne SANS nature de parking', async () => {
      const { svc, prisma, alerts, errorLogger } = build(
        parkingZone({ label: 'JAMMER_SUSPECTED' }),
      );
      prisma.tracker.findMany.mockResolvedValue([makeTracker()]); // 29 h
      alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

      await svc.tick();

      // La levée du plafond est réservée aux PARKINGS. Ailleurs, la durée porte encore de
      // l'information et TRK-011 garde tout son sens — sinon on rouvre le trou en grand.
      expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(1);
      expect(errorLogger.record).toHaveBeenCalledTimes(1);
      expect((errorLogger.record.mock.calls[0][0] as Error).message).toContain('ANORMALEMENT LONG');
    });

    it('un boîtier silencié reste CONSULTABLE dans le journal de synthèse (pas notifié ≠ invisible)', async () => {
      const { svc, prisma } = build(parkingZone());
      const log = jest.spyOn((svc as unknown as { logger: { log: (m: string) => void } }).logger, 'log');
      prisma.tracker.findMany.mockResolvedValue([makeTracker()]);

      await svc.tick();

      // La contrepartie de la règle : le fait ne doit pas devenir invisible, seulement
      // silencieux. Le journal nomme le véhicule, la durée et la raison du silence.
      expect(log).toHaveBeenCalledWith(expect.stringContaining('FS-253-HR'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('parking'));
    });
  });

  it('ne conseille PAS de reconfirmer une zone déjà confirmée', async () => {
    const { svc, prisma, alerts, errorLogger } = build({
      zone: { id: 'z1', status: 'CONFIRMED_BENIGN', occurrences: 5 },
      isNewEpisode: false,
    });
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

    await svc.tick();

    // Envoyer reconfirmer un lieu déjà confirmé ferait chercher au mauvais endroit : le
    // problème est la DURÉE, pas le lieu.
    const message = (errorLogger.record.mock.calls[0][0] as Error).message;
    expect(message).not.toContain('confirmez');
    expect(message).toContain('antenne');
  });

  it('respecte GPS_DEADZONE_MAX_SILENCE_H', async () => {
    const previous = process.env.GPS_DEADZONE_MAX_SILENCE_H;
    process.env.GPS_DEADZONE_MAX_SILENCE_H = '48';
    try {
      const { svc, prisma, alerts } = build({
        zone: { id: 'z1', status: 'CONFIRMED_BENIGN', occurrences: 5 },
        isNewEpisode: false,
      });
      // 29 h : sous le plafond relevé à 48 h → toujours silencieux.
      prisma.tracker.findMany.mockResolvedValue([makeTracker()]);

      await svc.tick();

      expect(alerts.createGpsLostAlert).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GPS_DEADZONE_MAX_SILENCE_H;
      else process.env.GPS_DEADZONE_MAX_SILENCE_H = previous;
    }
  });

  it('ne change RIEN pour une zone récurrente non confirmée (le plafond ne vise que le bénin)', async () => {
    const { svc, prisma, alerts, errorLogger } = build({
      zone: { id: 'z1', status: 'RECURRING', occurrences: 8 },
      isNewEpisode: false,
    });
    // 29 h, soit bien au-delà du plafond — mais la zone n'est PAS confirmée bénigne.
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

    await svc.tick();

    // Comportement d'avant préservé : alerte flotte, pas d'inondation du centre admin,
    // et surtout aucun `benignOverride` — le plafond ne doit pas déborder sur ce chemin.
    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(1);
    expect(alerts.createGpsLostAlert.mock.calls[0][5]).toBeUndefined();
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('alerte le fleet-admin avec contexte récurrent MAIS n\'inonde pas le centre admin (zone récurrente non suspecte)', async () => {
    const { svc, prisma, alerts, errorLogger } = build({
      zone: { id: 'z1', status: 'RECURRING', occurrences: 4 },
      isNewEpisode: true,
    });
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

    await svc.tick();

    expect(alerts.createGpsLostAlert).toHaveBeenCalledTimes(1);
    const recurrence = alerts.createGpsLostAlert.mock.calls[0][4];
    expect(recurrence).toMatchObject({ count: 4, recognized: true, suspect: false });
    // Récurrente non suspecte → pas de spam du centre d'alertes super-admin.
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('REMONTE au centre admin quand la zone est marquée suspecte (brouilleur)', async () => {
    const { svc, prisma, alerts, errorLogger } = build({
      zone: { id: 'z1', status: 'SUSPECT', occurrences: 6 },
      isNewEpisode: true,
    });
    prisma.tracker.findMany.mockResolvedValue([makeTracker()]);
    alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

    await svc.tick();

    const recurrence = alerts.createGpsLostAlert.mock.calls[0][4];
    expect(recurrence).toMatchObject({ suspect: true });
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    expect(String(errorLogger.record.mock.calls[0][0])).toContain('SUSPECTE');
  });

  /**
   * Espacement des rappels (2026-08-10). FZ-862-VY, antenne morte depuis le 07/08, écrivait
   * une ligne d'erreur PAR JOUR pour un fait strictement inchangé. Un état stable qui dure
   * se consulte ; il ne se re-notifie pas quotidiennement.
   *
   * ⚠️ Le test qui compte vraiment est le DERNIER : le rappel doit s'espacer, jamais
   * s'éteindre. C'est le trou de TRK-011 qu'on ne veut surtout pas rouvrir.
   */
  describe('rappels espacés pour un épisode qui dure', () => {
    const DAY = 24 * 3600_000;

    it('un épisode RÉCENT (< 24 h) alerte sans consulter le backoff', async () => {
      const { svc, prisma, alerts, errorLogger } = build();
      prisma.tracker.findMany.mockResolvedValue([
        makeTracker({ lastPositionAt: new Date(Date.now() - 3 * 3600_000) }),
      ]);
      alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

      await svc.tick();

      // Un épisode NEUF ne doit jamais être étouffé par la trace d'un épisode précédent.
      expect(prisma.errorLog.findFirst).not.toHaveBeenCalled();
      expect(errorLogger.record).toHaveBeenCalledTimes(1);
    });

    it('ne réécrit PAS de ligne quand un rappel récent existe déjà', async () => {
      const { svc, prisma, alerts, errorLogger } = build();
      prisma.tracker.findMany.mockResolvedValue([
        makeTracker({ lastPositionAt: new Date(Date.now() - 3 * DAY) }),
      ]);
      alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });
      prisma.errorLog.findFirst.mockResolvedValue({ id: 'e1' }); // déjà signalé

      await svc.tick();

      expect(errorLogger.record).not.toHaveBeenCalled();
    });

    it('cherche le rappel précédent sur une fenêtre de 7 j à partir du 3ᵉ jour', async () => {
      const { svc, prisma, alerts } = build();
      prisma.tracker.findMany.mockResolvedValue([
        makeTracker({ lastPositionAt: new Date(Date.now() - 3 * DAY) }),
      ]);
      alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

      await svc.tick();

      const where = prisma.errorLog.findFirst.mock.calls[0][0].where;
      const windowMs = Date.now() - (where.createdAt.gte as Date).getTime();
      expect(Math.round(windowMs / DAY)).toBe(7);
      // Filtré sur le texte : les échecs techniques du détecteur partagent la source
      // `gps-integrity` et ne doivent pas faire taire un rappel légitime.
      expect(where.message).toMatchObject({ contains: 'GPS perdu' });
      expect(where.imei).toBe('864035054757027');
    });

    it("ne devient JAMAIS muet : un épisode d'un an rappelle encore chaque mois", async () => {
      const { svc, prisma, alerts, errorLogger } = build();
      prisma.tracker.findMany.mockResolvedValue([
        makeTracker({ lastPositionAt: new Date(Date.now() - 365 * DAY) }),
      ]);
      alerts.createGpsLostAlert.mockResolvedValue({ id: 'a1' });

      await svc.tick();

      const where = prisma.errorLog.findFirst.mock.calls[0][0].where;
      const windowMs = Date.now() - (where.createdAt.gte as Date).getTime();
      expect(Math.round(windowMs / DAY)).toBe(30); // borné, mais fini
      expect(errorLogger.record).toHaveBeenCalledTimes(1);
    });
  });
});
