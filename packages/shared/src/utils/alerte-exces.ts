import { EXCES_CRITIQUE_KMH } from '../dto/speed-alert.dto';
import type { SpeedingSegmentDto } from '../dto/trip-analysis.dto';

/**
 * Lot V5 — DÉCIDER si un trajet analysé mérite une alerte de vitesse, et laquelle.
 *
 * Fonction PURE, partagée : le serveur l'applique pour créer l'alerte, et l'écran peut
 * l'appliquer pour expliquer pourquoi un trajet en a produit une — ou pas. Une seule
 * définition, deux lecteurs, aucune divergence possible.
 */

/** Réglage EFFECTIF d'un véhicule, société et surcharge confondues. */
export interface ReglageAlerteVitesse {
  enabled: boolean;
  overKmh: number;
  absoluteKmh: number | null;
}

/** Ce que la décision lit d'une analyse — un sous-ensemble volontairement minimal. */
export interface AnalysePourAlerte {
  /** Vitesse maximale CORROBORÉE du trajet (km/h). */
  maxSpeedKmh: number;
  /** Excès confirmés contre la limite légale — jamais les pointes « à vérifier ». */
  speeding: SpeedingSegmentDto[];
  /** Tracé simplifié, pour situer une pointe absolue. Facultatif. */
  track?: { lat: number; lng: number; t: string; speedKmh: number }[];
}

export type MotifAlerteVitesse = 'limite' | 'absolu';

export interface DecisionAlerteVitesse {
  /** `limite` : dépassement de la limite légale ; `absolu` : au-delà du plafond, carte ou pas. */
  motif: MotifAlerteVitesse;
  severity: 'WARNING' | 'CRITICAL';
  /** Vitesse retenue (km/h). */
  speedKmh: number;
  /** Limite légale du segment retenu ; nulle pour le plafond absolu. */
  limitKmh: number | null;
  /** Dépassement retenu (km/h) — de la limite, ou du plafond. */
  overKmh: number;
  durationSec: number;
  /** Nombre d'excès confirmés sur le trajet, tous seuils confondus. */
  segmentCount: number;
  lat: number | null;
  lng: number | null;
  startAt: string | null;
  endAt: string | null;
}

/**
 * Compose société et surcharge véhicule : chaque champ nul de la surcharge hérite.
 * Le plafond absolu ne se surcharge pas — c'est une règle du pays, pas d'un véhicule.
 */
export function reglageEffectif(
  fleet: { speedAlertEnabled: boolean; speedAlertOverKmh: number; speedAlertAbsoluteKmh: number | null },
  vehicle: { speedAlertEnabled: boolean | null; speedAlertOverKmh: number | null } | null | undefined,
): ReglageAlerteVitesse {
  return {
    enabled: vehicle?.speedAlertEnabled ?? fleet.speedAlertEnabled,
    overKmh: vehicle?.speedAlertOverKmh ?? fleet.speedAlertOverKmh,
    absoluteKmh: fleet.speedAlertAbsoluteKmh,
  };
}

function severitePour(overKmh: number): 'WARNING' | 'CRITICAL' {
  return overKmh >= EXCES_CRITIQUE_KMH ? 'CRITICAL' : 'WARNING';
}

/**
 * Rend la décision, ou `null` quand rien ne justifie d'alerter.
 *
 * Deux voies, et la plus GRAVE l'emporte :
 *   · le pire dépassement de limite légale au-dessus du seuil réglé ;
 *   · la pointe au-delà du plafond absolu, qui tient même quand la carte n'a rien dit —
 *     c'est elle qui rattrape le trajet à 168 km/h sans limite connue.
 */
export function decideAlerteExces(analyse: AnalysePourAlerte, reglage: ReglageAlerteVitesse): DecisionAlerteVitesse | null {
  if (!reglage.enabled) return null;

  const segmentCount = analyse.speeding.length;
  let parLimite: DecisionAlerteVitesse | null = null;
  for (const seg of analyse.speeding) {
    if (seg.overKmh < reglage.overKmh) continue;
    const meilleur = !parLimite
      || seg.overKmh > parLimite.overKmh
      || (seg.overKmh === parLimite.overKmh && seg.durationSec > parLimite.durationSec);
    if (!meilleur) continue;
    parLimite = {
      motif: 'limite',
      severity: severitePour(seg.overKmh),
      speedKmh: Math.round(seg.maxSpeedKmh),
      limitKmh: seg.limitKmh,
      overKmh: Math.round(seg.overKmh),
      durationSec: seg.durationSec,
      segmentCount,
      lat: seg.lat, lng: seg.lng,
      startAt: seg.startAt, endAt: seg.endAt,
    };
  }

  let parPlafond: DecisionAlerteVitesse | null = null;
  if (reglage.absoluteKmh != null && analyse.maxSpeedKmh > reglage.absoluteKmh) {
    const over = Math.round(analyse.maxSpeedKmh - reglage.absoluteKmh);
    // Situer la pointe : le point du tracé le plus rapide au-delà du plafond, s'il existe.
    let point: { lat: number; lng: number; t: string; speedKmh: number } | null = null;
    for (const pt of analyse.track ?? []) {
      if (pt.speedKmh > reglage.absoluteKmh && (!point || pt.speedKmh > point.speedKmh)) point = pt;
    }
    parPlafond = {
      motif: 'absolu',
      severity: severitePour(over),
      speedKmh: Math.round(analyse.maxSpeedKmh),
      limitKmh: null,
      overKmh: over,
      durationSec: 0,
      segmentCount,
      lat: point?.lat ?? null, lng: point?.lng ?? null,
      startAt: point?.t ?? null, endAt: point?.t ?? null,
    };
  }

  if (parLimite && parPlafond) return parPlafond.overKmh > parLimite.overKmh ? parPlafond : parLimite;
  return parLimite ?? parPlafond;
}

/**
 * ── TRK-078 (2026-09-13) — QU'EST-CE QU'UN « MÊME EXCÈS » ? ─────────────────────────────
 *
 * L'alerte d'excès était dédupliquée par identifiant de trajet. Or le recalcul horaire
 * redécoupe sa fenêtre : il supprime les trajets et les recrée sous une autre identité, et
 * chaque identité neuve est analysée comme un trajet neuf. Onze doublons sur cinquante-cinq
 * alertes en quatorze jours — même véhicule, même instant à la seconde, deux `tripId`.
 *
 * L'identité d'un trajet est un ARTEFACT du découpage ; l'instant d'un excès est un FAIT
 * mesuré par le GPS. Deux fenêtres d'excès d'un même véhicule qui se recouvrent décrivent le
 * même dépassement — un véhicule n'est pas à deux endroits à la fois. La tolérance absorbe
 * un découpage qui coupe l'excès un point plus tôt ou plus tard : elle est courte, parce que
 * deux excès distincts sur un même trajet sont typiquement à plusieurs minutes l'un de
 * l'autre, et qu'un seul des deux est retenu par trajet de toute façon.
 */
export const TOLERANCE_MEME_EXCES_MS = 30_000;

/** Un horodatage ISO tel que la charge utile le porte, ou rien — jamais `NaN`. */
export function instantMs(valeur: unknown): number | null {
  if (typeof valeur !== 'string' || valeur === '') return null;
  const ms = Date.parse(valeur);
  return Number.isFinite(ms) ? ms : null;
}

/** Les deux fenêtres se recouvrent, à la tolérance près. Sans instant d'un côté : jamais. */
export function memeExces(
  a: { startAt: unknown; endAt: unknown },
  b: { startAt: unknown; endAt: unknown },
): boolean {
  const aDebut = instantMs(a.startAt);
  const bDebut = instantMs(b.startAt);
  if (aDebut == null || bDebut == null) return false;
  const aFin = instantMs(a.endAt) ?? aDebut;
  const bFin = instantMs(b.endAt) ?? bDebut;
  return aDebut - TOLERANCE_MEME_EXCES_MS <= bFin && bDebut - TOLERANCE_MEME_EXCES_MS <= aFin;
}
