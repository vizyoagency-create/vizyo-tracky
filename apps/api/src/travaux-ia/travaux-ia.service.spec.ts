import { TravauxIaService, REPRISE_APRES_MS, TENTATIVES_MAX } from './travaux-ia.service';

/**
 * ── LA FILE DE TRAVAUX IA LOCAUX (design/C1) ─────────────────────────────────────────
 *
 * Chaque règle testée ici vient d'un incident déjà payé sur ce chantier :
 *   — idempotence à l'enfilage : un producteur horaire qui repasse avant le courrier créerait
 *     un appel modèle PAR HEURE pour le même rapport ;
 *   — reprise des travaux « pris » périmés : l'agent du poste a été tué trois fois en deux
 *     jours (un reboot, deux crashs de session) ;
 *   — échec définitif après 3 tentatives : les 39 alertes Overpass en onze minutes ont montré
 *     ce que coûte l'acharnement ;
 *   — rejet par le consommateur : une réponse que `sanitize()` refuse doit être rejouée puis
 *     actée, jamais persistée « à peu près ».
 */
function fake() {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const matchWhere = (r: Record<string, unknown>, w: Record<string, unknown>): boolean => {
    if (w['statut'] && typeof w['statut'] === 'object') {
      const list = (w['statut'] as { in: string[] }).in;
      if (!list.includes(String(r['statut']))) return false;
    } else if (w['statut'] && r['statut'] !== w['statut']) return false;
    if (w['type'] && r['type'] !== w['type']) return false;
    if (w['contexte']) {
      const c = w['contexte'] as { path: string[]; equals: string };
      if ((r['contexte'] as Record<string, unknown>)[c.path[0]!] !== c.equals) return false;
    }
    if (w['prisA'] && typeof w['prisA'] === 'object') {
      const lt = (w['prisA'] as { lt: Date }).lt;
      const v = r['prisA'] as Date | null;
      if (!v || v.getTime() >= lt.getTime()) return false;
    }
    if (w['tentatives'] && typeof w['tentatives'] === 'object') {
      const t = w['tentatives'] as { lt?: number; gte?: number };
      const v = Number(r['tentatives']);
      if (t.lt !== undefined && !(v < t.lt)) return false;
      if (t.gte !== undefined && !(v >= t.gte)) return false;
    }
    return true;
  };
  const prisma = {
    travailIaLocal: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].find((r) => matchWhere(r, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].filter((r) => matchWhere(r, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `t-${++seq}`;
        rows.set(id, { id, statut: 'a-faire', tentatives: 0, prisA: null, resultat: null, ...data });
        return { id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error('introuvable');
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of rows.values()) if (matchWhere(r, where)) { Object.assign(r, data); count++; }
        return { count };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        if (!rows.delete(where.id)) throw new Error('introuvable');
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].filter((r) => matchWhere(r, where)).length,
    },
  };
  return { prisma, rows };
}

const PAYLOAD = { system: 'SYS', schema: { type: 'object' }, userPayload: { a: 1 }, maxTokens: 900 };

describe('File de travaux IA — enfiler sans doublon', () => {
  it('⚠️ la même clé d’idempotence ne crée qu’UN travail — sinon un appel modèle par heure', async () => {
    const { prisma, rows } = fake();
    const svc = new TravauxIaService(prisma as never);

    const a = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'rapport:2026-08-14:2026-08-21' });
    const b = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'rapport:2026-08-14:2026-08-21' });

    expect(a.enfile).toBe(true);
    expect(b.enfile).toBe(false);
    expect(rows.size).toBe(1);
  });

  it('une clé différente (période suivante) enfile normalement', async () => {
    const { prisma, rows } = fake();
    const svc = new TravauxIaService(prisma as never);
    await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p2' });
    expect(rows.size).toBe(2);
  });

  it('⚠️ un travail DÉJÀ FAIT mais pas encore rangé bloque aussi le doublon', async () => {
    // Entre le passage du courrier et celui du consommateur, le producteur peut repasser :
    // le travail « fait » compte comme vivant, sinon on paierait une seconde rédaction.
    const { prisma, rows } = fake();
    const svc = new TravauxIaService(prisma as never);
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    rows.get(id!)!['statut'] = 'fait';
    const again = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    expect(again.enfile).toBe(false);
  });
});

describe('File de travaux IA — l’agent tué ne perd pas le travail', () => {
  it('⚠️ un travail « pris » depuis plus de 2 h redevient « a-faire »', async () => {
    const { prisma, rows } = fake();
    const svc = new TravauxIaService(prisma as never);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1' });
    Object.assign(rows.get(id!)!, { statut: 'pris', prisA: new Date(Date.now() - REPRISE_APRES_MS - 60_000), tentatives: 1 });

    const r = await svc.reprendrePerimes();

    expect(r.repris).toBe(1);
    expect(rows.get(id!)!['statut']).toBe('a-faire');
  });

  it('un travail pris DEPUIS PEU n’est pas touché — le courrier travaille peut-être encore', async () => {
    const { prisma, rows } = fake();
    const svc = new TravauxIaService(prisma as never);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1' });
    Object.assign(rows.get(id!)!, { statut: 'pris', prisA: new Date(), tentatives: 1 });
    const r = await svc.reprendrePerimes();
    expect(r.repris).toBe(0);
    expect(rows.get(id!)!['statut']).toBe('pris');
  });

  it('⚠️ après 3 prises sans livraison, l’échec est ACTÉ — pas d’acharnement silencieux', async () => {
    const { prisma, rows } = fake();
    const svc = new TravauxIaService(prisma as never);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1' });
    Object.assign(rows.get(id!)!, { statut: 'pris', prisA: new Date(Date.now() - REPRISE_APRES_MS - 1), tentatives: TENTATIVES_MAX });

    const r = await svc.reprendrePerimes();

    expect(r.abandonnes).toBe(1);
    expect(rows.get(id!)!['statut']).toBe('echec');
  });
});

describe('File de travaux IA — le consommateur décide, jamais l’agent', () => {
  it('consommer efface la ligne : l’objet métier persisté EST la trace', async () => {
    const { prisma, rows } = fake();
    const svc = new TravauxIaService(prisma as never);
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    rows.get(id!)!['statut'] = 'fait';

    await svc.consommer(id!);

    expect(rows.size).toBe(0);
  });

  it('⚠️ un résultat que sanitize() refuse est REJOUÉ, puis acté en échec à bout de tentatives', async () => {
    const { prisma, rows } = fake();
    const svc = new TravauxIaService(prisma as never);
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    Object.assign(rows.get(id!)!, { statut: 'fait', tentatives: 1, resultat: { contenu: 'illisible' } });

    await svc.rejeter(id!, 'summary manquant');
    expect(rows.get(id!)!['statut']).toBe('a-faire');
    expect(rows.get(id!)!['resultat']).not.toEqual({ contenu: 'illisible' });

    Object.assign(rows.get(id!)!, { statut: 'fait', tentatives: TENTATIVES_MAX });
    await svc.rejeter(id!, 'summary manquant, encore');
    expect(rows.get(id!)!['statut']).toBe('echec');
  });

  it('l’état pour l’écran compte les quatre statuts', async () => {
    const { prisma, rows } = fake();
    const svc = new TravauxIaService(prisma as never);
    await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'a' });
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'b' });
    rows.get(id!)!['statut'] = 'echec';

    const etat = await svc.etat();
    expect(etat).toEqual({ aFaire: 1, pris: 0, faits: 0, echecs: 1 });
  });
});
