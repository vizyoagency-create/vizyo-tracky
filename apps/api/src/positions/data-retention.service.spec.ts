import { DataRetentionService } from './data-retention.service';

/** Mock ConfigService : `get(key)` lit une table de valeurs (ignore l'option {infer}). */
function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    SAMPLING_DECISIONS_RETENTION_DAYS: 7,
    POSITIONS_RETENTION_DAYS: 365,
    POSITIONS_ARCHIVE_DAYS: 30,
    POSITIONS_PURGE_ENABLED: 'false',
    ...overrides,
  };
  return { get: (k: string) => values[k] } as never;
}

/** Mock du journal des actions système (fire-and-forget, jamais awaité). */
const sysAct = { record: jest.fn() } as never;

/** Mock Prisma : compteurs de fenetre + flottes + snapshot + delete par lots. */
function makePrisma() {
  return {
    positionSamplingDecision: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $queryRawUnsafe: jest
      .fn()
      // 1) global counts
      .mockResolvedValueOnce([{ active: 100, archive: 5, todelete: 3, oldest: new Date('2024-01-01') }])
      // 2) per-fleet counts
      .mockResolvedValueOnce([
        { fleetid: 'f1', active: 100, archive: 5, todelete: 3, oldest: new Date('2024-01-01') },
      ]),
    fleet: { findMany: jest.fn().mockResolvedValue([{ id: 'f1', name: 'Flotte 1' }]) },
    retentionSnapshot: { deleteMany: jest.fn(), createMany: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(3),
  } as never;
}

describe('DataRetentionService — retention positions (Sprint 6)', () => {
  it('DRY-RUN par defaut : calcule le snapshot mais ne supprime AUCUNE position', async () => {
    const prisma = makePrisma();
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_PURGE_ENABLED: 'false' }), sysAct);

    const res = await svc.runPositionsRetention();

    expect(res.mode).toBe('DRY_RUN');
    expect(res.deletedCount).toBe(0);
    expect(res.toDeleteCount).toBe(3);
    // snapshot stocke (un seul $transaction deleteMany+createMany)
    expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).toHaveBeenCalledTimes(1);
    // AUCUNE suppression de position
    expect((prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('flag arme : supprime par lots et ne cible QUE la table positions (perimetre strict)', async () => {
    const prisma = makePrisma();
    const exec = (prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe;
    exec.mockResolvedValue(3); // < batch => un seul lot
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_PURGE_ENABLED: 'true' }), sysAct);

    const res = await svc.runPositionsRetention();

    expect(res.mode).toBe('REAL');
    expect(res.deletedCount).toBe(3);
    expect(exec).toHaveBeenCalledTimes(1);
    const sql = exec.mock.calls[0][0] as string;
    expect(sql).toContain('DELETE FROM positions');
    expect(sql).toContain('"createdAt"'); // ancrage createdAt (heure serveur)
    // perimetre : aucune autre table n'est ciblee par un DELETE
    expect(sql).not.toMatch(/DELETE FROM (users|vehicles|fleets|trackers|trips|drivers|alerts)/i);
  });

  it('flag arme : borne le volume par run (MAX_BATCHES_PER_RUN) si le lot reste plein', async () => {
    const prisma = makePrisma();
    const exec = (prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe;
    exec.mockResolvedValue(10_000); // lot toujours plein => doit s'arreter a la borne
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_PURGE_ENABLED: 'true' }), sysAct);

    const res = await svc.runPositionsRetention();

    expect(res.mode).toBe('REAL');
    expect(exec).toHaveBeenCalledTimes(50); // borne anti-emballement
    expect(res.deletedCount).toBe(500_000);
  });

  it('POSITIONS_RETENTION_DAYS=0 : desactive, ni snapshot ni suppression', async () => {
    const prisma = makePrisma();
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_RETENTION_DAYS: 0 }), sysAct);

    const res = await svc.runPositionsRetention();

    expect(res.disabled).toBe(true);
    expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).not.toHaveBeenCalled();
    expect((prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('recomputeSnapshot : calcule le snapshot sans rien supprimer (refresh lecture seule)', async () => {
    const prisma = makePrisma();
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_PURGE_ENABLED: 'true' }), sysAct);

    const at = await svc.recomputeSnapshot();

    expect(at).toBeInstanceOf(Date);
    expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).toHaveBeenCalledTimes(1);
    expect((prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('DataRetentionService — cible CNIL 60 jours (lot 1)', () => {
  const DAY = 86_400_000;

  /** Borne de suppression reellement utilisee par le DELETE (2e argument = date). */
  async function captureDeleteFrom(overrides: Record<string, unknown> = {}): Promise<Date> {
    const prisma = makePrisma();
    const svc = new DataRetentionService(
      prisma,
      makeConfig({ POSITIONS_RETENTION_DAYS: 60, POSITIONS_ARCHIVE_DAYS: 0, POSITIONS_PURGE_ENABLED: 'true', ...overrides }),
      sysAct,
    );
    await svc.runPositionsRetention();
    const call = (prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe.mock.calls[0];
    return call[1] as Date;
  }

  it('une position de 61 j est PURGEE, une position de 59 j est CONSERVEE', async () => {
    const deleteFrom = await captureDeleteFrom();
    const now = Date.now();
    const pos61j = new Date(now - 61 * DAY);
    const pos59j = new Date(now - 59 * DAY);

    // Le DELETE cible tout ce qui est ANTERIEUR a deleteFrom.
    expect(pos61j.getTime()).toBeLessThan(deleteFrom.getTime()); // supprimee
    expect(pos59j.getTime()).toBeGreaterThan(deleteFrom.getTime()); // conservee
    // Et la borne est bien a 60 jours (tolerance 1 min pour le temps d'execution).
    expect(Math.abs(deleteFrom.getTime() - (now - 60 * DAY))).toBeLessThan(60_000);
  });

  it('supprime REELLEMENT (mode REAL) avec les defauts 60 + 0 armes', async () => {
    const prisma = makePrisma();
    const svc = new DataRetentionService(
      prisma,
      makeConfig({ POSITIONS_RETENTION_DAYS: 60, POSITIONS_ARCHIVE_DAYS: 0, POSITIONS_PURGE_ENABLED: 'true' }),
      sysAct,
    );
    const res = await svc.runPositionsRetention();
    expect(res.mode).toBe('REAL');
    expect(res.deletedCount).toBeGreaterThan(0);
    expect((prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe).toHaveBeenCalled();
  });

  it('GARDE-FOU : une fenetre de 6 j fait ECHOUER le job et ne supprime RIEN', async () => {
    const prisma = makePrisma();
    const errorLogger = { recordBackground: jest.fn() };
    const svc = new DataRetentionService(
      prisma,
      makeConfig({ POSITIONS_RETENTION_DAYS: 6, POSITIONS_ARCHIVE_DAYS: 0, POSITIONS_PURGE_ENABLED: 'true' }),
      sysAct,
      errorLogger as never,
    );

    const res = await svc.runPositionsRetention();

    expect(res.disabled).toBe(true); // resultat neutre = run echoue
    expect((prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe).not.toHaveBeenCalled();
    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(1);
    expect(String(errorLogger.recordBackground.mock.calls[0][0])).toMatch(/30 j|RetentionWindowTooShort/);
  });

  it('PRODUCTION : POSITIONS_PURGE_ENABLED=false est IGNORE (purge quand meme armee)', async () => {
    const prisma = makePrisma();
    const svc = new DataRetentionService(
      prisma,
      makeConfig({ NODE_ENV: 'production', POSITIONS_RETENTION_DAYS: 60, POSITIONS_ARCHIVE_DAYS: 0, POSITIONS_PURGE_ENABLED: 'false' }),
      sysAct,
    );
    const res = await svc.runPositionsRetention();
    expect(res.mode).toBe('REAL');
  });

  it('ARRET D URGENCE : POSITIONS_RETENTION_DAYS=0 desactive tout, meme en production', async () => {
    const prisma = makePrisma();
    const svc = new DataRetentionService(
      prisma,
      makeConfig({ NODE_ENV: 'production', POSITIONS_RETENTION_DAYS: 0, POSITIONS_PURGE_ENABLED: 'true' }),
      sysAct,
    );
    const res = await svc.runPositionsRetention();
    expect(res.disabled).toBe(true);
    expect((prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
