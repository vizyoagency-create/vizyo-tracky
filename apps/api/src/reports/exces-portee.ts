import { Prisma, PrismaClient } from '@prisma/client';
import { EXCES_DUREE_MIN_SEC } from '@vizyo/tracky-shared';
import type { PorteeConducteur } from '../common/driver-scope';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * « COMBIEN D'EXCÈS » — UNE SEULE DÉFINITION, DEUX GRAINS DE LECTURE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Un excès ÉTABLI est un segment de `trip_analyses.detail->'speeding'` d'au moins
 * `EXCES_DUREE_MIN_SEC` secondes. Ce que le tableau `aVerifier` contient — les pointes que
 * l'analyse refuse d'affirmer — n'en fait PAS partie : c'est la distinction que le replay
 * peint en ambre et que le compte ne doit jamais avaler.
 *
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────────
 *
 * La requête vivait dans `reports-stats.service`, donc l'écran et le PDF comptaient les excès
 * et le CLASSEUR n'en parlait pas du tout. Le contrôle du 2026-09-06 l'a montré : sur
 * « mh cars », le PDF donnait 8, 17 et 8 excès pour les trois conducteurs, et la feuille
 * « Par conducteur ou groupe » n'avait pas la colonne.
 *
 * La réponse n'était pas d'en réécrire une seconde pour le classeur. Trois clauses portent
 * toute la justesse de ce compte, et chacune a déjà coûté :
 *
 *   1. le SEUIL de durée, sans quoi un point isolé devient une faute ;
 *   2. le MODE VIE PRIVÉE, qui avait échappé à cette requête jusqu'au 2026-09-05 parce
 *      qu'elle ne partage pas le `where` des trajets ;
 *   3. le FILTRE CONDUCTEUR, qui doit border les excès comme il borde tout le reste, sinon
 *      un rapport centré sur une personne lui impute les dépassements des autres.
 *
 * Elles sont écrites ICI, une fois, et les deux grains de lecture s'y branchent.
 *
 * ── DEUX GRAINS, PAS DEUX RÈGLES ─────────────────────────────────────────────────────────
 *
 *   - `excesParVehiculeEtConducteur` — ce que la synthèse agrège (écran, PDF) ;
 *   - `excesParTrajet` — ce que le classeur détaille, ligne à ligne, et d'où il rebâtit
 *     lui-même ses totaux par véhicule et par imputation.
 *
 * ⚠️ LE SECOND N'EST PAS UN SUPERFLU DU PREMIER. Le classeur a besoin du grain TRAJET pour
 * sa feuille « Trajets » — celle qu'on trie et qu'on filtre — et refaire une agrégation
 * serveur par-dessus lui coûterait une requête de plus pour un résultat qu'il peut sommer.
 */

/** Ce qui borne un compte d'excès : la société, la période, et les deux filtres du rapport. */
export interface PorteeExces {
  fleetId: string;
  from: Date;
  to: Date;
  /** Périmètre véhicule effectif, ou `null` quand le rapport porte sur toute la société. */
  vehicleIds?: readonly string[] | null;
  /** Filtre conducteur : `undefined` = aucun, `null` = sans conducteur, sinon l'identifiant. */
  driverScope?: PorteeConducteur;
}

export interface ExcesParVehiculeLigne {
  vehicleId: string;
  driverId: string | null;
  exces: number;
  trajets: number;
  pire: number;
}

export interface ExcesParTrajetLigne {
  tripId: string;
  vehicleId: string;
  driverId: string | null;
  exces: number;
  pire: number;
}

/**
 * Le corps commun des deux lectures : d'où viennent les lignes et ce qui les retient.
 *
 * ⚠️ EN SQL BRUT parce que le filtre porte sur les ÉLÉMENTS d'un tableau JSON. Prisma ne sait
 * pas exprimer « au moins un segment d'au moins N secondes », et ramener les détails en
 * mémoire chargerait aussi le tracé de chaque trajet — plusieurs dizaines de mégaoctets pour
 * un mois de flotte.
 *
 * ⚠️ LE SEUIL EST INTERPOLÉ DEPUIS LA CONSTANTE PARTAGÉE : c'est la seule façon d'avoir une
 * requête qui ne diverge pas de la règle le jour où celle-ci bouge. La FORME du prédicat est,
 * elle, forcément réécrite en SQL — ce commentaire est sa seule protection.
 */
function corps(p: PorteeExces): Prisma.Sql {
  const perimetre = p.vehicleIds && p.vehicleIds.length > 0
    ? Prisma.sql`AND ta."vehicleId" = ANY(${p.vehicleIds as string[]}::uuid[])`
    : Prisma.empty;
  const conducteur = p.driverScope === undefined
    ? Prisma.empty
    : p.driverScope === null
      ? Prisma.sql`AND t."driverId" IS NULL`
      : Prisma.sql`AND t."driverId" = ${p.driverScope}::uuid`;

  return Prisma.sql`
      FROM trip_analyses ta
      JOIN trips t ON t.id = ta."tripId"
      JOIN vehicles v ON v.id = ta."vehicleId" AND v."privacyModeEnabled" IS NOT TRUE
      CROSS JOIN LATERAL jsonb_array_elements(ta.detail->'speeding') s
     WHERE ta."fleetId" = ${p.fleetId}::uuid
       AND t."startedAt" >= ${p.from}
       AND t."startedAt" <  ${p.to}
       AND t."endedAt" IS NOT NULL
       ${perimetre}
       ${conducteur}
       AND (s->>'durationSec')::numeric >= ${EXCES_DUREE_MIN_SEC}`;
}

/**
 * Excès agrégés par véhicule ET par conducteur.
 *
 * ⚠️ `driverId` dans le GROUP BY, et `COUNT(DISTINCT ta."tripId")` reste sommable : un trajet
 * ne portant qu'un seul conducteur, il ne peut pas être compté dans deux partitions du même
 * véhicule. C'est ce qui permet à l'écran de basculer entre « par véhicule » et « par
 * conducteur » sans refaire de requête.
 */
export function excesParVehiculeEtConducteur(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  p: PorteeExces,
): Promise<ExcesParVehiculeLigne[]> {
  return prisma.$queryRaw<ExcesParVehiculeLigne[]>`
    SELECT ta."vehicleId"                                     AS "vehicleId",
           t."driverId"                                       AS "driverId",
           COUNT(*)::int                                      AS "exces",
           COUNT(DISTINCT ta."tripId")::int                   AS "trajets",
           COALESCE(MAX((s->>'overKmh')::numeric), 0)::float8 AS "pire"
    ${corps(p)}
     GROUP BY ta."vehicleId", t."driverId"
  `;
}

/**
 * Excès agrégés par TRAJET — le grain le plus fin, celui du classeur.
 *
 * Le véhicule et le conducteur voyagent avec la ligne pour que l'appelant puisse rebâtir
 * n'importe quel total sans repasser par la base.
 */
export function excesParTrajet(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  p: PorteeExces,
): Promise<ExcesParTrajetLigne[]> {
  return prisma.$queryRaw<ExcesParTrajetLigne[]>`
    SELECT ta."tripId"                                        AS "tripId",
           ta."vehicleId"                                     AS "vehicleId",
           t."driverId"                                       AS "driverId",
           COUNT(*)::int                                      AS "exces",
           COALESCE(MAX((s->>'overKmh')::numeric), 0)::float8 AS "pire"
    ${corps(p)}
     GROUP BY ta."tripId", ta."vehicleId", t."driverId"
  `;
}

/** Un cumul d'excès, quelle que soit la portée sur laquelle on l'a bâti. */
export interface CumulExces {
  exces: number;
  trajets: number;
  pire: number;
}

export const CUMUL_EXCES_VIDE: CumulExces = { exces: 0, trajets: 0, pire: 0 };

/**
 * Additionne des lignes par trajet dans un cumul, sous la clé qu'on veut.
 *
 * ⚠️ `pire` est un MAXIMUM, jamais une somme : additionner des dépassements donnerait un
 * nombre qui ne correspond à aucun instant du trajet. Et `trajets` compte les lignes, ce qui
 * est exact PARCE QUE le grain d'entrée est le trajet — une ligne, un trajet.
 */
export function cumulerParCle<T extends ExcesParTrajetLigne>(
  lignes: readonly T[],
  cle: (ligne: T) => string | null,
): Map<string, CumulExces> {
  const out = new Map<string, CumulExces>();
  for (const l of lignes) {
    const k = cle(l);
    if (k === null) continue;
    const c = out.get(k) ?? { ...CUMUL_EXCES_VIDE };
    c.exces += l.exces;
    c.trajets += 1;
    c.pire = Math.max(c.pire, l.pire);
    out.set(k, c);
  }
  return out;
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA LECTURE QUI NE FAIT JAMAIS TOMBER SON DOCUMENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Les excès sont une colonne ACCESSOIRE d'exports qui, eux, ne le sont pas : le classeur et le
 * CSV sont ce qu'on ouvre quand l'écran ne répond plus. Les faire tomber pour une colonne
 * serait une régression bien plus grave que son absence — deux colonnes à zéro se remarquent
 * et se comprennent, un export en erreur ne sert plus à rien.
 *
 * ⚠️ LE `try` ENGLOBE L'APPEL, pas seulement la promesse. Un `.catch()` seul ne rattrape que
 * les REJETS : si `$queryRaw` n'existe pas — client Prisma remplacé, double de test — l'erreur
 * est SYNCHRONE et traverse. Les deux appelants ont fait l'erreur à tour de rôle ; elle est
 * corrigée une fois, ici.
 *
 * @param onErreur ce que l'appelant veut journaliser. Sans trace, une table vide serait
 *   indiscernable d'un parc irréprochable.
 */
export async function lireExcesParTrajet(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  portee: PorteeExces,
  onErreur?: (raison: string) => void,
): Promise<Map<string, ExcesParTrajetLigne>> {
  try {
    const lignes = await excesParTrajet(prisma, portee);
    return new Map(lignes.map((l) => [l.tripId, l]));
  } catch (e: unknown) {
    onErreur?.(e instanceof Error ? e.message : String(e));
    return new Map();
  }
}

