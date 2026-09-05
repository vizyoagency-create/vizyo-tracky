import {
  TravauxIaService,
  REPRISE_APRES_MS,
  TENTATIVES_MAX,
  PURGE_ECHECS_APRES_MS,
  REFROIDISSEMENT_ECHEC_MS,
  CLE_REFROIDISSEMENT_ECHEC,
  SOURCE_ALERTE,
  lireResultatLocal,
  actionUsagePourType,
} from './travaux-ia.service';

/**
 * ── LA FILE DE TRAVAUX IA LOCAUX (design/C1, durcie par design/C3 points 3 et 6) ────────
 *
 * Chaque règle testée ici vient d'un incident déjà payé sur ce chantier :
 *   — idempotence à l'enfilage : un producteur horaire qui repasse avant le courrier créerait
 *     un appel modèle PAR HEURE pour le même rapport ;
 *   — reprise des travaux « pris » périmés : l'agent du poste a été tué trois fois en deux
 *     jours (un reboot, deux crashs de session) ;
 *   — échec définitif après 3 tentatives : les 39 alertes Overpass en onze minutes ont montré
 *     ce que coûte l'acharnement — et le 05/09, 5 travaux `a-faire` repris 76 à 1 330 fois ont
 *     montré ce que coûte un plafond promis mais pas appliqué ;
 *   — rejet par le consommateur : une réponse que `sanitize()` refuse doit être rejouée puis
 *     actée, jamais persistée « à peu près » ;
 *   — un échec définitif SE VOIT : une alerte (une seule par travail), une ligne d'usage
 *     `ok=false`, et la ligne morte disparaît après 7 jours ;
 *   — les jetons RÉELS du courrier sont lus, et l'ancien format sans jetons ne casse rien.
 */
function fake() {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const matchWhere = (r: Record<string, unknown>, w: Record<string, unknown>): boolean => {
    if (w['OR'] && Array.isArray(w['OR'])) {
      if (!(w['OR'] as Record<string, unknown>[]).some((sub) => matchWhere(r, sub))) return false;
    }
    if (w['statut'] && typeof w['statut'] === 'object') {
      const list = (w['statut'] as { in: string[] }).in;
      if (!list.includes(String(r['statut']))) return false;
    } else if (w['statut'] && r['statut'] !== w['statut']) return false;
    if (w['type'] && r['type'] !== w['type']) return false;
    if (w['contexte']) {
      const c = w['contexte'] as { path: string[]; equals: string };
      if ((r['contexte'] as Record<string, unknown>)[c.path[0]!] !== c.equals) return false;
    }
    for (const champ of ['prisA', 'finiA', 'creeA'] as const) {
      if (!(champ in w)) continue;
      const cond = w[champ];
      const v = r[champ] as Date | null | undefined;
      if (cond === null) {
        if (v) return false;
      } else if (cond && typeof cond === 'object') {
        const lt = (cond as { lt: Date }).lt;
        if (!v || v.getTime() >= lt.getTime()) return false;
      }
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
        rows.set(id, { id, statut: 'a-faire', tentatives: 0, prisA: null, finiA: null, creeA: new Date(), resultat: null, erreur: null, ...data });
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
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const [id, r] of [...rows.entries()]) if (matchWhere(r, where)) { rows.delete(id); count++; }
        return { count };
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].filter((r) => matchWhere(r, where)).length,
    },
  };
  return { prisma, rows };
}

/** Les trois services optionnels, simulés : un refroidissement qui n'accorde qu'UNE émission par clé. */
function observabilite() {
  const emises = new Set<string>();
  const refroidissement = {
    tenterEmission: jest.fn(async (cle: string) => {
      if (emises.has(cle)) return false;
      emises.add(cle);
      return true;
    }),
  };
  const errorLogger = { record: jest.fn().mockResolvedValue('id') };
  const aiUsage = { record: jest.fn().mockResolvedValue(undefined) };
  return { refroidissement, errorLogger, aiUsage };
}

function service(prisma: unknown, obs?: ReturnType<typeof observabilite>) {
  return obs
    ? new TravauxIaService(prisma as never, obs.errorLogger as never, obs.refroidissement as never, obs.aiUsage as never)
    : new TravauxIaService(prisma as never);
}

const PAYLOAD = { system: 'SYS', schema: { type: 'object' }, userPayload: { a: 1 }, maxTokens: 900 };
const JOUR = 24 * 3_600_000;

describe('File de travaux IA — enfiler sans doublon', () => {
  it('⚠️ la même clé d’idempotence ne crée qu’UN travail — sinon un appel modèle par heure', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma);

    const a = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'rapport:2026-08-14:2026-08-21' });
    const b = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'rapport:2026-08-14:2026-08-21' });

    expect(a.enfile).toBe(true);
    expect(b.enfile).toBe(false);
    expect(rows.size).toBe(1);
  });

  it('une clé différente (période suivante) enfile normalement', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma);
    await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p2' });
    expect(rows.size).toBe(2);
  });

  it('⚠️ un travail DÉJÀ FAIT mais pas encore rangé bloque aussi le doublon', async () => {
    // Entre le passage du courrier et celui du consommateur, le producteur peut repasser :
    // le travail « fait » compte comme vivant, sinon on paierait une seconde rédaction.
    const { prisma, rows } = fake();
    const svc = service(prisma);
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    rows.get(id!)!['statut'] = 'fait';
    const again = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    expect(again.enfile).toBe(false);
  });
});

describe('File de travaux IA — l’agent tué ne perd pas le travail', () => {
  it('⚠️ un travail « pris » depuis plus de 2 h redevient « a-faire »', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1' });
    Object.assign(rows.get(id!)!, { statut: 'pris', prisA: new Date(Date.now() - REPRISE_APRES_MS - 60_000), tentatives: 1 });

    const r = await svc.reprendrePerimes();

    expect(r.repris).toBe(1);
    expect(rows.get(id!)!['statut']).toBe('a-faire');
  });

  it('un travail pris DEPUIS PEU n’est pas touché — le courrier travaille peut-être encore', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1' });
    Object.assign(rows.get(id!)!, { statut: 'pris', prisA: new Date(), tentatives: 1 });
    const r = await svc.reprendrePerimes();
    expect(r.repris).toBe(0);
    expect(rows.get(id!)!['statut']).toBe('pris');
  });

  it('⚠️ après 3 prises sans livraison, l’échec est ACTÉ — pas d’acharnement silencieux', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1' });
    Object.assign(rows.get(id!)!, { statut: 'pris', prisA: new Date(Date.now() - REPRISE_APRES_MS - 1), tentatives: TENTATIVES_MAX });

    const r = await svc.reprendrePerimes();

    expect(r.abandonnes).toBe(1);
    expect(rows.get(id!)!['statut']).toBe('echec');
    expect(rows.get(id!)!['finiA']).toBeInstanceOf(Date);
  });
});

describe('File de travaux IA — le plafond de tentatives vaut AUSSI pour les « a-faire » (C3, point 6)', () => {
  it('⚠️ un « a-faire » à 3 tentatives passe en echec en CONSERVANT le motif du courrier', async () => {
    // Le cas des 5 travaux morts du 27/08 : reposés 76 à 1 330 fois, jamais actés, motif écrasé
    // à chaque tour. Le motif dit POURQUOI ; il doit survivre à la transition.
    const { prisma, rows } = fake();
    const obs = observabilite();
    const svc = service(prisma, obs);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1', fleetId: 'f-1', placeId: 'p-1' });
    Object.assign(rows.get(id!)!, { tentatives: TENTATIVES_MAX, erreur: 'echec de la CLI : Error: Prompt is too long' });

    const r = await svc.reprendrePerimes();

    expect(r.plafonnes).toBe(1);
    const ligne = rows.get(id!)!;
    expect(ligne['statut']).toBe('echec');
    expect(ligne['erreur']).toBe('plafond de tentatives atteint — echec de la CLI : Error: Prompt is too long');
    expect(ligne['finiA']).toBeInstanceOf(Date);
  });

  it('sans motif stocké, la transition en écrit un — jamais une colonne vide', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma, observabilite());
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1' });
    Object.assign(rows.get(id!)!, { tentatives: TENTATIVES_MAX, erreur: null });

    await svc.reprendrePerimes();

    expect(String(rows.get(id!)!['erreur'])).toMatch(/^plafond de tentatives atteint — .+/);
  });

  it('un « a-faire » SOUS le plafond n’est pas touché', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma, observabilite());
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1' });
    Object.assign(rows.get(id!)!, { tentatives: TENTATIVES_MAX - 1, erreur: 'un premier raté' });

    const r = await svc.reprendrePerimes();

    expect(r.plafonnes).toBe(0);
    expect(rows.get(id!)!['statut']).toBe('a-faire');
    expect(rows.get(id!)!['erreur']).toBe('un premier raté');
  });

  it('⚠️ l’échec définitif écrit UNE alerte au centre, derrière un refroidissement PAR TRAVAIL', async () => {
    const { prisma, rows } = fake();
    const obs = observabilite();
    const svc = service(prisma, obs);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1', fleetId: 'f-1' });
    Object.assign(rows.get(id!)!, { tentatives: TENTATIVES_MAX, erreur: 'delai depasse' });

    await svc.reprendrePerimes();

    expect(obs.refroidissement.tenterEmission).toHaveBeenCalledWith(`${CLE_REFROIDISSEMENT_ECHEC}:${id}`, REFROIDISSEMENT_ECHEC_MS);
    expect(obs.errorLogger.record).toHaveBeenCalledTimes(1);
    const [erreur, source, contexte, niveau] = obs.errorLogger.record.mock.calls[0] as [Error, string, Record<string, unknown>, string];
    expect(erreur.message).toBe(`Travail IA local en échec définitif : analyse-lieu (${TENTATIVES_MAX} tentatives) — plafond de tentatives atteint — delai depasse`);
    expect(source).toBe(SOURCE_ALERTE);
    expect(contexte).toMatchObject({ id, type: 'analyse-lieu', tentatives: TENTATIVES_MAX, contexte: { fleetId: 'f-1' } });
    expect(niveau).toBe('ERROR');
  });

  it('⚠️ deux chemins qui actent le MÊME échec ne produisent qu’une alerte (refroidissement simulé)', async () => {
    // Le courrier acte à la 3e tentative, puis le consommateur rejette le même travail : le
    // refroidissement par id n'accorde la seconde émission qu'après 30 jours — la ligne aura été
    // purgée bien avant. Une alerte par travail, jamais une par chemin.
    const { prisma, rows } = fake();
    const obs = observabilite();
    const svc = service(prisma, obs);
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    Object.assign(rows.get(id!)!, { statut: 'fait', tentatives: TENTATIVES_MAX, resultat: { contenu: 'illisible' } });

    await svc.rejeter(id!, 'summary manquant');
    await svc.rejeter(id!, 'summary manquant, encore');

    expect(rows.get(id!)!['statut']).toBe('echec');
    expect(obs.refroidissement.tenterEmission).toHaveBeenCalledTimes(2);
    expect(obs.errorLogger.record).toHaveBeenCalledTimes(1);
  });

  it('⚠️ l’échec définitif laisse une ligne d’usage ok=false, sous la MÊME action que les succès', async () => {
    // Jusqu'au 05/09, `ai_usage_logs` n'avait jamais porté une ligne `ok=false` : le KPI
    // « Échecs » de la page « Coûts IA » n'avait rien à compter.
    const { prisma, rows } = fake();
    const obs = observabilite();
    const svc = service(prisma, obs);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1', fleetId: 'f-1' });
    Object.assign(rows.get(id!)!, { tentatives: TENTATIVES_MAX, erreur: 'x' });

    await svc.reprendrePerimes();

    expect(obs.aiUsage.record).toHaveBeenCalledTimes(1);
    expect(obs.aiUsage.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'place_analysis', executor: 'local', ok: false, model: 'local', fleetId: 'f-1',
      inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, resultCount: 0,
    }));
  });

  it('sans services d’observabilité (construit avec le seul Prisma), la transition tient quand même', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma);
    const { id } = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'l1' });
    Object.assign(rows.get(id!)!, { tentatives: TENTATIVES_MAX, erreur: 'x' });

    await expect(svc.reprendrePerimes()).resolves.toMatchObject({ plafonnes: 1 });
    expect(rows.get(id!)!['statut']).toBe('echec');
  });
});

describe('File de travaux IA — le consommateur décide, jamais l’agent', () => {
  it('consommer efface la ligne : l’objet métier persisté EST la trace', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma);
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    rows.get(id!)!['statut'] = 'fait';

    await svc.consommer(id!);

    expect(rows.size).toBe(0);
  });

  it('⚠️ un résultat que sanitize() refuse est REJOUÉ, puis acté en échec à bout de tentatives', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma);
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    Object.assign(rows.get(id!)!, { statut: 'fait', tentatives: 1, resultat: { contenu: 'illisible' } });

    await svc.rejeter(id!, 'summary manquant');
    expect(rows.get(id!)!['statut']).toBe('a-faire');
    expect(rows.get(id!)!['resultat']).not.toEqual({ contenu: 'illisible' });

    Object.assign(rows.get(id!)!, { statut: 'fait', tentatives: TENTATIVES_MAX });
    await svc.rejeter(id!, 'summary manquant, encore');
    expect(rows.get(id!)!['statut']).toBe('echec');
    expect(rows.get(id!)!['erreur']).toBe('plafond de tentatives atteint — summary manquant, encore');
  });

  it('⚠️ rejeter à 3 tentatives écrit l’alerte et la ligne d’usage ok=false sous l’action du rapport', async () => {
    const { prisma, rows } = fake();
    const obs = observabilite();
    const svc = service(prisma, obs);
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'p1' });
    Object.assign(rows.get(id!)!, { statut: 'fait', tentatives: TENTATIVES_MAX, resultat: { contenu: {} } });

    await svc.rejeter(id!, 'summary manquant');

    expect(obs.errorLogger.record).toHaveBeenCalledTimes(1);
    expect((obs.errorLogger.record.mock.calls[0] as [Error])[0].message).toContain('rapport-activite');
    expect(obs.aiUsage.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'activity_report', ok: false, executor: 'local' }));
  });

  it('l’état pour l’écran compte les quatre statuts', async () => {
    const { prisma, rows } = fake();
    const svc = service(prisma);
    await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'a' });
    const { id } = await svc.enfiler('rapport-activite', PAYLOAD, { cleIdempotence: 'b' });
    rows.get(id!)!['statut'] = 'echec';

    const etat = await svc.etat();
    expect(etat).toEqual({ aFaire: 1, pris: 0, faits: 0, echecs: 1 });
  });
});

describe('File de travaux IA — purge des échecs anciens (C3, point 6)', () => {
  it('⚠️ un echec de plus de 7 jours disparaît, un echec récent et un a-faire ancien restent', async () => {
    // Les 5 travaux morts du 27/08 étaient encore en file le 05/09, lieux ré-analysés avec succès
    // entre-temps : une ligne qui n'apprend plus rien doit partir sans geste manuel.
    const { prisma, rows } = fake();
    const svc = service(prisma);
    const maintenant = new Date('2026-09-05T04:50:00Z');
    const vieux = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'vieux' });
    const recent = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'recent' });
    const sansFin = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'sans-fin' });
    const vivant = await svc.enfiler('analyse-lieu', PAYLOAD, { cleIdempotence: 'vivant' });
    Object.assign(rows.get(vieux.id!)!, { statut: 'echec', finiA: new Date(maintenant.getTime() - 8 * JOUR) });
    Object.assign(rows.get(recent.id!)!, { statut: 'echec', finiA: new Date(maintenant.getTime() - 2 * JOUR) });
    // Acté avant que la transition ne pose `finiA` : c'est `creeA` qui fait foi.
    Object.assign(rows.get(sansFin.id!)!, { statut: 'echec', finiA: null, creeA: new Date(maintenant.getTime() - 10 * JOUR) });
    Object.assign(rows.get(vivant.id!)!, { statut: 'a-faire', creeA: new Date(maintenant.getTime() - 30 * JOUR) });

    const n = await svc.purgerEchecsAnciens(maintenant);

    expect(n).toBe(2);
    expect(rows.has(vieux.id!)).toBe(false);
    expect(rows.has(sansFin.id!)).toBe(false);
    expect(rows.has(recent.id!)).toBe(true);
    expect(rows.has(vivant.id!)).toBe(true);
  });

  it('la borne est exactement 7 jours', () => {
    expect(PURGE_ECHECS_APRES_MS).toBe(7 * JOUR);
  });

  it('le passage planifié ne propage jamais une panne de base (elle tuerait l’ordonnanceur)', async () => {
    const prisma = { travailIaLocal: { deleteMany: async () => { throw new Error('base injoignable'); } } };
    const svc = service(prisma);
    await expect(svc.purgerEchecsAnciensPlanifie()).resolves.toBeUndefined();
  });
});

describe('Résultat du courrier — jetons réels, ancien format toléré (C3, point 3)', () => {
  it('le nouveau format rend le modèle réel, les jetons, la durée et le coût équivalent', () => {
    const lu = lireResultatLocal({
      contenu: { summary: 'ok' },
      modele: 'claude-sonnet-4-5-20250929',
      usage: { inputTokens: 10, outputTokens: 49, cacheWriteTokens: 28031, cacheReadTokens: 0 },
      coutEquivalentUsd: 0.03529375,
      dureeMs: 2198,
    });
    expect(lu.modele).toBe('claude-sonnet-4-5-20250929');
    expect(lu.usage).toEqual({ inputTokens: 10, outputTokens: 49, cacheWriteTokens: 28031, cacheReadTokens: 0 });
    expect(lu.latencyMs).toBe(2198);
    expect(lu.coutEquivalentUsd).toBe(0.03529375);
    expect(lu.contenu).toEqual({ summary: 'ok' });
  });

  it('⚠️ l’ancien format { contenu, modele } (travaux faits avant le déploiement) → jetons 0, sans erreur', () => {
    const lu = lireResultatLocal({ contenu: { summary: 'ok' }, modele: 'sonnet' });
    expect(lu.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
    expect(lu.modele).toBe('sonnet');
    expect(lu.latencyMs).toBe(0);
    expect(lu.coutEquivalentUsd).toBeNull();
  });

  it('un résultat nul, difforme ou négatif ne lève pas et ne compte pas de jeton', () => {
    expect(lireResultatLocal(null).modele).toBe('local');
    expect(lireResultatLocal('texte').usage.inputTokens).toBe(0);
    expect(lireResultatLocal({ usage: { inputTokens: -5, outputTokens: 'x' }, dureeMs: -1 }).usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
    expect(lireResultatLocal({ modele: '  ' }).modele).toBe('local');
  });

  it('l’action d’usage d’un type est celle du consommateur ; un type inconnu garde son nom', () => {
    expect(actionUsagePourType('analyse-lieu')).toBe('place_analysis');
    expect(actionUsagePourType('rapport-activite')).toBe('activity_report');
    expect(actionUsagePourType('jugement-agenda')).toBe('jugement-agenda');
  });
});
