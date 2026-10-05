import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { compterPortionsAResoudre } from './portions-a-resoudre';
import { SPEEDING_CANDIDATE_KMH } from './trip-analysis.preprocessor';

/**
 * ── LE RESTE DE L'AGENT DES LIMITES EST CELUI QUE L'AGENT PREND, PAS UN AUTRE ─────────────
 *
 * Le 2026-10-05, l'écran des tâches de fond attribuait à l'agent « 576 trajets encore sans
 * limite » : aucun n'était son travail, et le nombre ne pouvait pas descendre à zéro. L'agent
 * choisit des PORTIONS, par sa propre requête (`cellulesARésoudre`, dans le script du poste) ;
 * l'écran compte désormais cette requête-là — 145 portions ce jour-là.
 *
 * L'agent ne peut pas importer la requête de l'API sans risquer de s'arrêter sur un `dist` périmé :
 * elle est donc écrite deux fois, et CE TEST relit le script du poste pour exiger la même relation
 * — la CTE et le filtre, au caractère près. Vérifié par mutation le 2026-10-05 : un seuil passé à 35
 * dans le seul script, une clause ajoutée au seul compteur — rouge les deux fois.
 */
const AGENT = readFileSync(join(__dirname, '..', '..', '..', '..', 'outils', 'agent-limites-vitesse.cjs'), 'utf8');

/** Le SQL de `cellulesARésoudre()` — la requête par laquelle l'agent choisit son travail. */
function sqlDeLAgent(): string {
  const fonction = AGENT.indexOf('function cellulesARésoudre');
  expect(fonction).toBeGreaterThan(0);
  const debut = AGENT.indexOf('const sql = `', fonction) + 'const sql = `'.length;
  return AGENT.slice(debut, AGENT.indexOf('`;', debut));
}

/** Le SQL que l'écran envoie, fragments `Prisma.raw` aplatis par Prisma lui-même. */
async function sqlDeLEcran(): Promise<string> {
  const $queryRaw = jest.fn().mockResolvedValue([{ n: 145 }]);
  await compterPortionsAResoudre({ $queryRaw } as never);
  expect($queryRaw).toHaveBeenCalledTimes(1);
  const [morceaux, ...valeurs] = $queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  const q = Prisma.sql(morceaux, ...valeurs);
  // Rien n'est lié : la requête est entièrement écrite, comme celle de l'agent.
  expect(q.values).toEqual([]);
  return q.text;
}

/**
 * La RELATION d'une requête de portions : la CTE `c` et le filtre posé sur elle. Ni la liste
 * sélectionnée (l'agent veut des coordonnées, l'écran un nombre), ni la limite de l'agent.
 */
function relation(sql: string): { cte: string; filtre: string } {
  const t = sql.replace(/\s+/g, ' ').trim();
  const finCte = t.indexOf(') SELECT ');
  expect(finCte).toBeGreaterThan(0);
  return {
    cte: t.slice(t.indexOf('WITH c AS'), finCte + 1),
    filtre: t.slice(t.indexOf(' FROM c ', finCte) + 1).split(' LIMIT ')[0].replace(/;$/, '').trim(),
  };
}

describe("Agent des limites — l'écran compte les portions que l'agent prend", () => {
  it("⚠️ la relation de l'écran est celle du script du poste, au caractère près", async () => {
    expect(relation(await sqlDeLEcran())).toEqual(relation(sqlDeLAgent()));
  });

  it("des portions rapides, récentes, absentes du cache — jamais des analyses ni `limitsKnown`", async () => {
    const { cte, filtre } = relation(await sqlDeLEcran());

    // Le seuil est celui au-dessus duquel l'analyse demande une limite — pas un 33 recopié.
    expect(cte).toContain(`"speedKmh" > ${SPEEDING_CANDIDATE_KMH} `);
    expect(cte).toContain(`timestamp >= now() - interval '60 days'`);
    expect(cte).toContain('round(lat::numeric,4) AS la, round(lng::numeric,4) AS ln');
    // Une portion inscrite au cache SANS limite est un constat : elle ne compte plus.
    expect(filtre).toBe(
      `FROM c WHERE NOT EXISTS (SELECT 1 FROM speed_limit_cache s WHERE s.key = c.la::text || ',' || c.ln::text)`,
    );
    for (const morceau of [cte, filtre]) {
      expect(morceau).not.toContain('trip_analyses');
      expect(morceau).not.toContain('limitsKnown');
    }
  });

  it('rend le nombre que la base compte, sans le retoucher', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ n: 145 }]);
    expect(await compterPortionsAResoudre({ $queryRaw } as never)).toBe(145);
    $queryRaw.mockResolvedValue([]);
    expect(await compterPortionsAResoudre({ $queryRaw } as never)).toBe(0);
  });
});
