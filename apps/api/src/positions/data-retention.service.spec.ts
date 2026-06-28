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
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_PURGE_ENABLED: 'false' }));

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
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_PURGE_ENABLED: 'true' }));

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
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_PURGE_ENABLED: 'true' }));

    const res = await svc.runPositionsRetention();

    expect(res.mode).toBe('REAL');
    expect(exec).toHaveBeenCalledTimes(50); // borne anti-emballement
    expect(res.deletedCount).toBe(500_000);
  });

  it('POSITIONS_RETENTION_DAYS=0 : desactive, ni snapshot ni suppression', async () => {
    const prisma = makePrisma();
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_RETENTION_DAYS: 0 }));

    const res = await svc.runPositionsRetention();

    expect(res.disabled).toBe(true);
    expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).not.toHaveBeenCalled();
    expect((prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('recomputeSnapshot : calcule le snapshot sans rien supprimer (refresh lecture seule)', async () => {
    const prisma = makePrisma();
    const svc = new DataRetentionService(prisma, makeConfig({ POSITIONS_PURGE_ENABLED: 'true' }));

    const at = await svc.recomputeSnapshot();

    expect(at).toBeInstanceOf(Date);
    expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).toHaveBeenCalledTimes(1);
    expect((prisma as unknown as { $executeRawUnsafe: jest.Mock }).$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
