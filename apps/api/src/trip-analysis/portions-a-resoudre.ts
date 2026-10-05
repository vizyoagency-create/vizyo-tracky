import { Prisma, type PrismaClient } from '@prisma/client';
import { SPEEDING_CANDIDATE_KMH } from './trip-analysis.preprocessor';

/**
 * ══ CE QUE L'AGENT DES LIMITES DOIT ENCORE RÉSOUDRE — SA REQUÊTE, ÉCRITE ICI UNE FOIS ══════
 *
 * L'agent du poste (`outils/agent-limites-vitesse.cjs`, fonction `cellulesARésoudre`) choisit son
 * travail en SQL : les PORTIONS — coordonnées arrondies à 4 décimales, la clé du cache — parcourues
 * à plus de 33 km/h ces 60 derniers jours et absentes de `speed_limit_cache`. C'est le seul reste à
 * faire qui lui appartienne.
 *
 * ── CE QUE ÇA CORRIGE (mesuré en production le 2026-10-05, lecture seule) ─────────────────
 *
 * L'écran des tâches de fond lui attribuait « 576 trajets encore sans limite » (`limitsKnown =
 * false`). Aucun n'était son travail : 565 trajets sans point au-dessus de 33 km/h (aucune limite
 * n'y est demandée), 3 anciens aux positions purgées, 8 orphelines — et le nombre ne pouvait pas
 * descendre à zéro. Son vrai reste, ce jour-là : 145 portions sur les 197 455 parcourues vite en
 * 60 jours.
 *
 * ── POURQUOI LE TEXTE DE L'AGENT EST RECOPIÉ, ET VERROUILLÉ ──────────────────────────────────
 *
 * L'agent tourne sur le poste et ne lit de l'API que des modules compilés (`apps/api/dist`) : lui
 * faire importer cette requête l'arrêterait au premier passage suivant une mise à jour dont `dist`
 * n'aurait pas été reconstruit. Elle vit donc ici, et `portions-a-resoudre.spec.ts` relit le script
 * du poste pour exiger la MÊME relation au caractère près — changer l'une sans l'autre fait tomber
 * le test.
 *
 * Le seuil, lui, n'est pas recopié : c'est `SPEEDING_CANDIDATE_KMH`, celui au-dessus duquel
 * l'analyse demande une limite. S'il bouge, le test exige que l'agent bouge avec lui.
 */

/** Fenêtre de l'agent, en jours : celle des positions conservées (`POSITIONS_RETENTION_DAYS`). */
export const FENETRE_AGENT_LIMITES_JOURS = 60;

/** Les portions parcourues vite récemment — la CTE `c` de l'agent. */
export const PORTIONS_RAPIDES_RECENTES = `WITH c AS (
      SELECT DISTINCT round(lat::numeric,4) AS la, round(lng::numeric,4) AS ln
      FROM positions
      WHERE "speedKmh" > ${SPEEDING_CANDIDATE_KMH} AND valid IS DISTINCT FROM false AND NOT (lat=0 AND lng=0)
        AND timestamp >= now() - interval '${FENETRE_AGENT_LIMITES_JOURS} days'
    )`;

/**
 * La portion n'a encore AUCUNE ligne au cache. Une ligne à limite nulle (négatif vérifié, ou voie
 * sans limite déductible) est un constat : l'agent ne la reprend jamais.
 */
export const PORTION_SANS_CACHE = `NOT EXISTS (SELECT 1 FROM speed_limit_cache s WHERE s.key = c.la::text || ',' || c.ln::text)`;

/**
 * Combien de portions l'agent prendrait s'il passait maintenant.
 *
 * ⚠️ ~1 à 2 s en production (balayage des positions de la fenêtre, tri sur disque) : l'appelant
 * met le résultat en cache — un écran qui se recharge toutes les 30 s ne la rejoue pas à chaque fois.
 */
export async function compterPortionsAResoudre(prisma: Pick<PrismaClient, '$queryRaw'>): Promise<number> {
  const [ligne] = await prisma.$queryRaw<Array<{ n: number }>>`
    ${Prisma.raw(PORTIONS_RAPIDES_RECENTES)}
    SELECT count(*)::int AS n FROM c
    WHERE ${Prisma.raw(PORTION_SANS_CACHE)}`;
  return Number(ligne?.n ?? 0);
}
