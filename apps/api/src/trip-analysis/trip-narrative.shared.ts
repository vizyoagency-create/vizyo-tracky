/**
 * Récit de trajet — la logique PURE, partagée par l'application et par l'agent sur poste.
 *
 * ── Pourquoi ce fichier existe ───────────────────────────────────────────────────────
 * Le récit peut être produit à deux endroits : par l'API (bouton « Récit IA », cron horaire) ou
 * par un agent qui tourne sur le poste du propriétaire, où le travail est absorbé par l'abonnement
 * au lieu d'être facturé. Les deux DOIVENT construire le même payload et assainir la réponse de la
 * même façon.
 *
 * Deux copies de cette logique divergeraient — et le jour où elles divergent, l'agent écrit en base
 * des récits que l'application n'aurait jamais produits, sans que rien ne le signale. C'est
 * exactement le raisonnement qui a présidé à `speed-limit.resolution.ts` : un module pur, importé
 * depuis `apps/api/dist` par l'agent, qui REFUSE de démarrer s'il ne le trouve pas.
 *
 * ── Ce que ce fichier ne fait pas ────────────────────────────────────────────────────
 * Aucun accès base, aucun appel réseau, aucune dépendance Nest ou Prisma. Il transforme une ligne
 * d'analyse en payload, et une réponse de modèle en valeurs bornées. Rien d'autre — c'est ce qui
 * le rend consommable par un script Node quelconque.
 */

/**
 * Ligne d'analyse telle qu'elle sort de la base, vue comme un sac de champs.
 *
 * Volontairement indexable et sans type Prisma : l'agent lit la même ligne via SQL brut, il n'a ni
 * client Prisma ni types générés. Exiger `TripAnalysis` ici rendrait le module inutilisable
 * précisément là où on veut le réutiliser.
 */
export type LigneAnalyse = Record<string, unknown> & { tripId: string; fleetId: string; vehicleId: string };

/** Sortie du modèle, une fois bornée. */
export interface RecitAssaini {
  narrative: string;
  advice: string;
  trustScore: number;
}

/** Plafonds de conservation — les mêmes des deux côtés, sinon les textes diffèrent selon l'auteur. */
export const NARRATIVE_MAX = 1500;
export const ADVICE_MAX = 800;
/** Nombre d'excès et d'arrêts détaillés transmis. Au-delà, le modèle ne gagne plus rien. */
export const SPEEDING_MAX = 8;
export const STOPS_MAX = 12;

type DetailAnalyse = {
  stops?: { durationMin: number }[];
  speeding?: { maxSpeedKmh: number; limitKmh: number; overKmh: number; durationSec: number }[];
};

/**
 * Payload COMPACT envoyé au modèle. Jamais les positions brutes : le travail déterministe
 * (distance, arrêts, excès, éco-score) est déjà fait et fiable — le modèle le met en mots, il ne
 * le recalcule pas. Lui envoyer les points GPS l'inviterait à recompter, donc à se tromper.
 */
export function construirePayloadRecit(row: LigneAnalyse): unknown {
  const n = (k: string): number => Number(row[k] ?? 0);
  const detail = (row['detail'] as DetailAnalyse) ?? {};
  return {
    vehicle: { type: undefined, energy: undefined }, // enrichi si besoin ; le résumé suffit au récit
    summary: {
      distanceKm: n('distanceKm'),
      durationMin: Math.round(n('durationSec') / 60),
      movingMin: Math.round(n('movingSec') / 60),
      /**
       * ⚠️ LES SECONDES AUSSI, ET C'EST LA MÊME PRUDENCE QUE `limitsKnown` CI-DESSOUS.
       *
       * Les minutes seules faisaient DISPARAÎTRE les trajets courts : un déplacement de
       * 24 secondes arrivait au modèle en `durationMin: 0`, c'est-à-dire « ce trajet a duré
       * zéro minute ». Relevé en production le 2026-09-06 sur un trajet de 90 m — le récit
       * publié disait « Déplacement de 90 mètres en quelques secondes (durée non
       * enregistrée) ». La durée ÉTAIT enregistrée : c'est l'arrondi qui l'avait effacée, et
       * le modèle en a tiré la seule conclusion que le chiffre autorisait.
       *
       * On garde les minutes — la formulation des trajets normaux ne change pas — et on
       * ajoute la valeur exacte, pour que le court puisse se dire en secondes.
       */
      durationSec: n('durationSec'),
      movingSec: n('movingSec'),
      avgSpeedKmh: n('avgSpeedKmh'),
      maxSpeedKmh: n('maxSpeedKmh'),
      stopCount: n('stopCount'),
      idleMin: Math.round(n('idleSec') / 60),
      idleSec: n('idleSec'),
    },
    gpsQuality: { points: n('gpsPoints'), validRatio: n('gpsValidRatio'), lostSignals: n('gpsLostCount') },
    speeding: {
      count: n('speedingCount'),
      durationSec: n('speedingSec'),
      maxOverKmh: n('maxOverKmh'),
      // ⚠️ Transmis au modèle À DESSEIN : quand les limites ne sont pas toutes connues, il doit
      //    écrire « aucun excès SIGNALÉ » et non « aucun excès ». Sans ce drapeau, il affirmerait
      //    une conformité qu'on n'a jamais mesurée.
      limitsKnown: !!row['limitsKnown'],
      segments: (detail.speeding ?? []).slice(0, SPEEDING_MAX).map((s) => ({
        maxSpeedKmh: s.maxSpeedKmh, limitKmh: s.limitKmh, overKmh: s.overKmh, durationSec: s.durationSec,
      })),
    },
    ecoDriving: {
      harshAccel: n('harshAccel'),
      harshBrake: n('harshBrake'),
      ecoScore: n('ecoScore'),
      fuelLiters: (row['fuelLiters'] as number | null) ?? null,
      co2Kg: (row['co2Kg'] as number | null) ?? null,
    },
    stops: (detail.stops ?? []).slice(0, STOPS_MAX).map((s) => ({ durationMin: s.durationMin })),
  };
}

/**
 * Indice de confiance borné à 0-100.
 *
 * Repli à 50 et non à 0 : une valeur illisible veut dire « on ne sait pas », pas « donnée
 * catastrophique ». Un 0 afficherait un badge rouge alarmant sur un trajet peut-être irréprochable.
 */
export function clampScore(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

/**
 * Borne la réponse du modèle. Le schéma garantit la FORME, jamais la longueur ni le sens : rien
 * n'empêche un modèle de rendre trois pages ou un champ vide.
 *
 * Un récit VIDE est rendu tel quel — c'est à l'appelant de décider qu'il ne vaut pas la peine
 * d'être écrit. Ce module ne décide pas à sa place : l'API affiche un échec, l'agent réessaie.
 */
export function assainirRecit(res: unknown): RecitAssaini {
  const r = (res ?? {}) as { narrative?: unknown; advice?: unknown; trustScore?: unknown };
  return {
    narrative: typeof r.narrative === 'string' ? r.narrative.slice(0, NARRATIVE_MAX) : '',
    advice: typeof r.advice === 'string' ? r.advice.slice(0, ADVICE_MAX) : '',
    trustScore: clampScore(r.trustScore),
  };
}

/**
 * Un récit mérite-t-il d'être écrit en base ?
 *
 * Le principe repris de l'agent de limites de vitesse : on n'écrit QUE ce qui est concluant, toute
 * réponse douteuse est une panne et on réessaiera. Un récit vide ou réduit à quelques mots n'est
 * pas un récit — l'écrire condamnerait le trajet à ne jamais être repris, puisque le pipeline
 * considère qu'un trajet avec récit est traité.
 */
export function recitConcluant(r: RecitAssaini): boolean {
  return r.narrative.trim().length >= 40;
}
