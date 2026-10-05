import { Prisma } from '@prisma/client';
import { TripAutomationService } from '../trip-analysis/trip-automation.service';
import { BackgroundTasksService } from './background-tasks.service';

/**
 * ── LE COMPTEUR « À REPRENDRE » COMPTE CE QUE LA REPRISE PREND, ET RIEN D'AUTRE ──────────
 *
 * Le 2026-10-05, l'écran des tâches de fond annonçait 4 051 analyses « reprises par lots à chaque
 * passage » ; la reprise (`reprendreAnalysesAnciennes`) n'en trouvait AUCUNE. L'écran comptait
 * `limitsCoverage IS NULL`, la reprise sélectionne les analyses sans clé `vitesse` dont le trajet
 * est encore dans la rétention des positions. Deux définitions, deux nombres — et celui de l'écran
 * ne pouvait jamais descendre à zéro : 2 936 analyses aux positions purgées, 1 090 trajets lents à
 * la couverture nulle à bon droit, 25 orphelines.
 *
 * ── CE QUE CES TESTS FIXENT : UNE ÉGALITÉ, PAS UN NOMBRE ──────────────────────────────────
 *
 * On fait tourner la VRAIE reprise et le VRAI écran, branché sur le VRAI service d'automatisation,
 * horloge figée. On capture les requêtes réellement envoyées — fragments `Prisma.sql` aplatis par
 * Prisma lui-même — et leurs RELATIONS (`FROM … WHERE …`, valeurs liées comprises) doivent être
 * identiques au caractère près. Une clause posée d'un seul côté, une jointure retirée, un horizon
 * calculé autrement : le premier test tombe. Vérifié par mutation le 2026-10-05 (une clause
 * `limitsCoverage IS NULL` ajoutée au seul compteur ; puis l'ancien `count` rétabli dans l'écran).
 */
const JOUR = 86_400_000;
/** 05/10/2026 15:07 à Paris : l'instant de la mesure de production. */
const MAINTENANT = Date.UTC(2026, 9, 5, 13, 7, 0);

/** La requête telle que Postgres la reçoit : Prisma aplatit lui-même les fragments imbriqués. */
function requete(appel: readonly unknown[]): Prisma.Sql {
  const [morceaux, ...valeurs] = appel as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(morceaux, ...valeurs);
}

/** Les marqueurs `$1`, `$2`… remplacés par `$?`, et les valeurs qu'ils désignaient, dans l'ordre. */
function lier(segment: string, q: Prisma.Sql): { sql: string; valeurs: unknown[] } {
  return {
    sql: segment.replace(/\$\d+/g, '$?'),
    valeurs: [...segment.matchAll(/\$(\d+)/g)].map((m) => q.values[Number(m[1]) - 1]),
  };
}

/**
 * La RELATION d'une requête — de `FROM trip_analyses` jusqu'à `ORDER BY` ou la fin. C'est elle
 * qui décide QUELLES lignes sont prises ; la liste sélectionnée, le tri et la limite ne changent
 * pas le périmètre.
 */
function relation(q: Prisma.Sql): { sql: string; valeurs: unknown[] } {
  const texte = q.text.replace(/\s+/g, ' ');
  const debut = texte.indexOf('FROM trip_analyses');
  expect(debut).toBeGreaterThanOrEqual(0);
  const tri = texte.indexOf(' ORDER BY ', debut);
  return lier(texte.slice(debut, tri >= 0 ? tri : undefined).trim(), q);
}

/** Le sous-SELECT de `backlog()` qui alimente la colonne `alias`, isolé de ses voisins. */
function colonne(q: Prisma.Sql, alias: string): { sql: string; valeurs: unknown[] } {
  const texte = q.text.replace(/\s+/g, ' ');
  const fin = texte.indexOf(`)::int AS "${alias}"`);
  expect(fin).toBeGreaterThan(0);
  const debut = texte.lastIndexOf('(SELECT count(*) ', fin) + '(SELECT count(*) '.length;
  return lier(texte.slice(debut, fin).trim(), q);
}

function monter(opts: { compte?: { n: number; plusAncien: Date | null } } = {}) {
  const compte = opts.compte ?? { n: 0, plusAncien: null };
  /** Le client Prisma du service d'automatisation : on y lit les trois requêtes qui comptent. */
  const $queryRaw = jest.fn(async (...appel: unknown[]) => {
    const texte = requete(appel).text;
    if (texte.includes('FROM fleets f')) return []; // backlog() : aucune société
    if (texte.includes('count(*)')) return [compte]; // resteReprise()
    return []; // la reprise : aucun candidat
  });
  const automatisation = new TripAutomationService(
    { $queryRaw } as never,
    { recompute: jest.fn() } as never,
    { analyze: jest.fn().mockResolvedValue({}) } as never,
    { narrate: jest.fn() } as never,
    { isEnabledForFleet: jest.fn() } as never,
    { record: jest.fn().mockResolvedValue('id') } as never,
    { record: jest.fn() } as never,
    { recaler: jest.fn() } as never,
  );

  /** Le client de l'ÉCRAN : `tripAnalysis.count` est espionné, l'ancien compte y passait. */
  const tripAnalysisCount = jest.fn().mockResolvedValue(0);
  const prismaEcran: Record<string, unknown> = {
    $queryRaw: jest.fn(async () => [{ n: BigInt(0) }]),
    trip: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _min: { endedAt: null } }),
    },
    tripAnalysis: { count: tripAnalysisCount },
    tripAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    activityReportSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    agendaAgentSettings: { findMany: jest.fn().mockResolvedValue([]) },
    placeAutomationSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    speedLimitCache: {
      aggregate: jest.fn().mockResolvedValue({ _max: { createdAt: null } }),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const registry = { getCronJobs: () => new Map(), getIntervals: () => [] };
  const ecran = new BackgroundTasksService(prismaEcran as never, registry as never, automatisation);
  return { ecran, automatisation, $queryRaw, tripAnalysisCount };
}

/** Fait tourner la VRAIE reprise, telle que le passage horaire l'appelle (budget illimité). */
async function reprendre(svc: TripAutomationService): Promise<void> {
  const stats = { reprises: 0, failed: 0, budgetAtteint: false };
  await (svc as unknown as {
    reprendreAnalysesAnciennes(user: unknown, stats: unknown, echeance: number): Promise<void>;
  }).reprendreAnalysesAnciennes({ id: 'systeme' }, stats, Number.POSITIVE_INFINITY);
}

/** La requête capturée dont le texte contient `marqueur` — exactement une. */
function capturee($queryRaw: jest.Mock, marqueur: string): Prisma.Sql {
  const trouvees = $queryRaw.mock.calls.map((c) => requete(c)).filter((q) => q.text.includes(marqueur));
  expect(trouvees).toHaveLength(1);
  return trouvees[0];
}

async function ligneReprise(ecran: BackgroundTasksService) {
  const ligne = (await ecran.list()).rattrapages.find((r) => r.id === 'couverture-limites');
  expect(ligne).toBeDefined();
  return ligne!;
}

describe("Tâches de fond — les analyses à reprendre sont celles que la reprise prend", () => {
  let retention: string | undefined;
  beforeEach(() => {
    retention = process.env.POSITIONS_RETENTION_DAYS;
    process.env.POSITIONS_RETENTION_DAYS = '60';
    jest.useFakeTimers({ now: MAINTENANT });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (retention === undefined) delete process.env.POSITIONS_RETENTION_DAYS;
    else process.env.POSITIONS_RETENTION_DAYS = retention;
  });

  it("⚠️ l'écran compte la relation EXACTE que la reprise sélectionne — texte et valeurs liées", async () => {
    const { ecran, automatisation, $queryRaw } = monter();
    await ecran.list();
    await reprendre(automatisation);

    const selection = relation(capturee($queryRaw, 'SELECT ta."tripId"'));
    const compte = relation(capturee($queryRaw, 'AS "plusAncien"'));

    expect(compte.sql).toBe(selection.sql);
    expect(compte.valeurs).toEqual(selection.valeurs);
  });

  it('la relation partagée tient les trois clauses de la reprise — et ignore le taux de couverture', async () => {
    const { automatisation, $queryRaw } = monter();
    await reprendre(automatisation);
    const { sql, valeurs } = relation(capturee($queryRaw, 'SELECT ta."tripId"'));

    // Ancienne = sans clé `vitesse`. Un taux nul, lui, est aussi celui d'un trajet trop lent :
    // c'est par lui que 1 090 trajets lents gonflaient l'écran, et le nombre croissait.
    expect(sql).toContain(`NOT (ta.detail ? 'vitesse')`);
    expect(sql).not.toContain('limitsCoverage');
    // La reprise relit le trajet : une analyse orpheline n'est reprise par personne.
    expect(sql).toContain('JOIN trips t ON t.id = ta."tripId"');
    // Au-delà de l'horizon, les positions sont purgées : 60 jours de rétention, un de marge.
    expect(sql).toMatch(/t\."startedAt" > \$\?$/);
    expect(valeurs).toHaveLength(1);
    expect((MAINTENANT - (valeurs[0] as Date).getTime()) / JOUR).toBe(59);
  });

  it("le nombre affiché est celui que rend la requête de la reprise — l'écran ne recompte rien", async () => {
    const { ecran, tripAnalysisCount } = monter({ compte: { n: 3, plusAncien: new Date('2026-08-12T06:00:00Z') } });
    const ligne = await ligneReprise(ecran);

    expect(ligne.restant).toBe(3);
    // Le plus ancien encore reprenable est aussi le prochain à franchir l'horizon de purge.
    expect(ligne.plusAncien).toBe('2026-08-12T06:00:00.000Z');
    expect(ligne.explication).toContain('moins de 59 j');
    // L'ancien compte ne revient pas par la bande.
    const parCouverture = tripAnalysisCount.mock.calls.filter(([a]) => 'limitsCoverage' in (a?.where ?? {}));
    expect(parCouverture).toEqual([]);
  });

  it('zéro se dit « arriéré résorbé » — et les analyses perdues sont nommées, pas tues', async () => {
    const { ecran } = monter({ compte: { n: 0, plusAncien: null } });
    const ligne = await ligneReprise(ecran);

    expect(ligne.restant).toBe(0);
    expect(ligne.plusAncien).toBeNull();
    expect(ligne.explication).toContain('Arriéré résorbé');
    // Un compteur tombé de 4 051 à 0 ne doit pas laisser croire que tout a été repris.
    expect(ligne.explication).toContain('jamais reprises');
    expect(ligne.explication).toContain('« Perdues »');
  });

  it("l'écran d'automatisation compte « À reprendre » et « Perdues » sur la même relation, coupée à l'horizon", async () => {
    const { automatisation, $queryRaw } = monter();
    await automatisation.backlog();
    await reprendre(automatisation);

    const selection = relation(capturee($queryRaw, 'SELECT ta."tripId"'));
    const backlog = capturee($queryRaw, 'FROM fleets f');
    const aReprendre = colonne(backlog, 'reprisesARattraper');
    const perdues = colonne(backlog, 'reprisesHorsPortee');

    expect(aReprendre.sql).toBe(`${selection.sql} AND ta."fleetId" = f.id`);
    expect(aReprendre.valeurs).toEqual(selection.valeurs);
    // Le complément EXACT : même table, même jointure, même absence de clé — seule la date bascule.
    expect(perdues.sql).toBe(
      `${selection.sql.replace('t."startedAt" > $?', 't."startedAt" <= $?')} AND ta."fleetId" = f.id`,
    );
    expect(perdues.valeurs).toEqual(selection.valeurs);
  });

  it("rétention désactivée : rien n'est purgé, tout reste reprenable — et la phrase le dit", async () => {
    process.env.POSITIONS_RETENTION_DAYS = '0';
    const { ecran, automatisation, $queryRaw } = monter({ compte: { n: 5, plusAncien: null } });
    const ligne = await ligneReprise(ecran);
    await reprendre(automatisation);

    const selection = relation(capturee($queryRaw, 'SELECT ta."tripId"'));
    const compte = relation(capturee($queryRaw, 'AS "plusAncien"'));
    expect(compte).toEqual(selection);
    expect(selection.valeurs).toEqual([new Date(0)]);
    expect(ligne.explication).toContain('rétention des positions désactivée');
  });
});
