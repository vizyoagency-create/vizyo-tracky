import {
  CAUSES_PAUSE,
  PauseAgentsLocauxService,
  RAPPEL_PAUSE_MS,
  SEUIL_ECHECS_CONSECUTIFS_MS,
} from './pause-agents-locaux.service';

/**
 * ── CE QUE CES TESTS PROTÈGENT (T34 / D5, 2026-09-13) ──────────────────────────────────────
 *
 * La pause des agents du poste vit en base, et trois lecteurs en dépendent : les agents (qui
 * sortent aussitôt si elle est active), la sentinelle (qui la notifie, la pose après cinq heures
 * d'échecs, et la lève quand elle est périmée) et le bouton « Reprendre maintenant » de /admin.
 * Une pause périmée ne retient PERSONNE — c'est ce qui rend le marqueur sans risque.
 */
const HEURE = 3_600_000;
const NOW = Date.UTC(2026, 8, 13, 17, 0);

interface Ligne {
  id: string;
  poseeA: Date;
  cause: string;
  motif: string;
  poseePar: string;
  jusqua: Date | null;
  leveeA: Date | null;
  leveePar: string | null;
  notifieeA: Date | null;
}

function ligne(over: Partial<Ligne> = {}): Ligne {
  return {
    id: 'p-1',
    poseeA: new Date(NOW - HEURE),
    cause: 'plafond-hebdo',
    motif: "You've hit your weekly limit · resets Sep 20, 12pm (Europe/Paris)",
    poseePar: 'rattrapage-recits',
    jusqua: new Date(NOW + 6 * 24 * HEURE),
    leveeA: null,
    leveePar: null,
    notifieeA: null,
    ...over,
  };
}

function construire(ouvertes: Ligne[] = []) {
  const prisma = {
    pauseAgentsLocaux: {
      findFirst: jest.fn(async () => ouvertes[0] ?? null),
      findMany: jest.fn(async () => ouvertes),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'p-new', ...data })),
      updateMany: jest.fn(async () => ({ count: ouvertes.length })),
    },
  };
  return { svc: new PauseAgentsLocauxService(prisma as never), prisma };
}

describe('Pause des agents du poste — lecture', () => {
  it('aucune ligne ouverte → pas de pause', async () => {
    const { svc } = construire([]);
    await expect(svc.active(NOW)).resolves.toBeNull();
  });

  it('une pause dont la reprise est à venir est ACTIVE, avec son échéance', async () => {
    const { svc } = construire([ligne()]);
    const p = await svc.active(NOW);
    expect(p?.cause).toBe('plafond-hebdo');
    expect(p?.jusqua?.getTime()).toBe(NOW + 6 * 24 * HEURE);
  });

  it('une pause sans échéance (reprise manuelle) est active tant que personne ne la lève', async () => {
    const { svc } = construire([ligne({ cause: 'echecs-consecutifs', jusqua: null })]);
    await expect(svc.active(NOW)).resolves.toMatchObject({ cause: 'echecs-consecutifs', jusqua: null });
  });

  it('⚠️ une pause dont l’échéance est passée ne retient personne : elle n’est plus active', async () => {
    const { svc } = construire([ligne({ jusqua: new Date(NOW - 1) })]);
    await expect(svc.active(NOW)).resolves.toBeNull();
  });
});

describe('Pause des agents du poste — pose et levée', () => {
  it('lever() ferme toutes les lignes ouvertes en disant qui, et rend leur nombre', async () => {
    const { svc, prisma } = construire([ligne()]);
    await expect(svc.lever('admin:u-1', NOW)).resolves.toBe(1);
    expect(prisma.pauseAgentsLocaux.updateMany).toHaveBeenCalledWith({
      where: { leveeA: null },
      data: { leveeA: new Date(NOW), leveePar: 'admin:u-1' },
    });
  });

  it('leverPerimees() ne ferme QUE les lignes dont l’échéance est passée, au nom de l’expiration', async () => {
    const { svc, prisma } = construire([ligne({ jusqua: new Date(NOW - HEURE) })]);
    await svc.leverPerimees(NOW);
    expect(prisma.pauseAgentsLocaux.updateMany).toHaveBeenCalledWith({
      where: { leveeA: null, jusqua: { lte: new Date(NOW) } },
      data: { leveeA: new Date(NOW), leveePar: 'expiration' },
    });
  });

  it('poser() refuse une cause inconnue, et n’empile pas une pause sur une pause active', async () => {
    const { svc, prisma } = construire([ligne()]);
    await expect(svc.poser({ cause: 'autre' as never, motif: 'x', poseePar: 'sentinelle', jusqua: null }, NOW)).rejects.toThrow(/cause/);
    await expect(svc.poser({ cause: 'echecs-consecutifs', motif: 'x', poseePar: 'sentinelle', jusqua: null }, NOW)).resolves.toBeNull();
    expect(prisma.pauseAgentsLocaux.create).not.toHaveBeenCalled();
  });

  it('poser() écrit la ligne quand rien ne retient encore les agents, et la rend', async () => {
    const { svc, prisma } = construire([]);
    const p = await svc.poser({ cause: 'echecs-consecutifs', motif: 'session Claude Code du poste expiree', poseePar: 'sentinelle', jusqua: null }, NOW);
    expect(p?.cause).toBe('echecs-consecutifs');
    expect(prisma.pauseAgentsLocaux.create).toHaveBeenCalledWith({
      data: { cause: 'echecs-consecutifs', motif: 'session Claude Code du poste expiree', poseePar: 'sentinelle', jusqua: null, poseeA: new Date(NOW) },
    });
  });

  it('les causes connues sont exactement celles que le poste et la sentinelle écrivent', () => {
    expect([...CAUSES_PAUSE]).toEqual(['plafond-hebdo', 'plafond-usage', 'echecs-consecutifs']);
    expect(SEUIL_ECHECS_CONSECUTIFS_MS).toBe(5 * HEURE);
  });
});

describe('Pause des agents du poste — notification', () => {
  it('aNotifier() rend les pauses ouvertes jamais notifiées, et marquerNotifiee() date l’envoi', async () => {
    const { svc, prisma } = construire([ligne()]);
    await expect(svc.aNotifier(NOW)).resolves.toHaveLength(1);
    expect(prisma.pauseAgentsLocaux.findMany).toHaveBeenCalledWith({
      where: {
        leveeA: null,
        OR: [{ notifieeA: null }, { jusqua: null, notifieeA: { lte: new Date(NOW - RAPPEL_PAUSE_MS) } }],
      },
      orderBy: { poseeA: 'asc' },
    });
    await svc.marquerNotifiee('p-1', NOW);
    expect(prisma.pauseAgentsLocaux.updateMany).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: { notifieeA: new Date(NOW) } });
  });

  /**
   * LE DÉFAUT DU 23/09 : une pause prévenait UNE fois puis se taisait. Celle du 17/09 a été
   * notifiée à 08:50 et n'a plus rien dit pendant six jours, pendant que la file grossissait.
   * La requête doit donc rappeler les pauses SANS échéance passé le délai — et elles seules :
   * une pause de plafond CLI porte son heure de reprise, elle se lève toute seule.
   */
  it('le rappel ne vise QUE les pauses sans échéance, passé le délai', async () => {
    const { svc, prisma } = construire([]);
    await svc.aNotifier(NOW);
    const args = (prisma.pauseAgentsLocaux.findMany as jest.Mock).mock.calls[0]?.[0] as
      | { where: { OR: Record<string, unknown>[] } }
      | undefined;
    expect(args?.where.OR[1]).toEqual({ jusqua: null, notifieeA: { lte: new Date(NOW - RAPPEL_PAUSE_MS) } });
    expect(RAPPEL_PAUSE_MS).toBe(12 * HEURE);
  });
});
