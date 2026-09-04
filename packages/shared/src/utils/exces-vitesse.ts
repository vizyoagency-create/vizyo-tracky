import type { SpeedingSegmentDto } from '../dto/trip-analysis.dto';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * « CECI EST-IL UN EXCÈS ? » — LA SEULE DÉFINITION (lot V7, 2026-09-04).
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── CE QUI COEXISTAIT ───────────────────────────────────────────────────────────────────
 *
 * Quatre réponses vivaient dans le produit, et deux écrans donnaient deux chiffres pour le
 * même trajet :
 *   1. le bit d'alarme du boîtier, seuil réglé dans l'appareil, sans aucune limite légale ;
 *   2. l'analyse de trajet : limite légale de la voie + 5 km/h de tolérance, sur une vitesse
 *      corroborée par le déplacement, et sur au moins deux points ;
 *   3. le rapport de vitesse — celui qui sert de PIÈCE DISCIPLINAIRE — qui retenait un seuil
 *      FIXE à 90 km/h, sans jamais consulter la limite de la voie ni écarter une vitesse que
 *      la trajectoire contredit. Un trajet entier sur une voie rapide à 110 y comptait des
 *      « excès » ; le même trajet en ville à 80 dans une zone 50 n'en comptait aucun ;
 *   4. trois plafonds de vitesse maximale — 200 à l'ingestion, 200 à l'analyse, 250 sur le
 *      trajet — donc trois vitesses maximales possibles pour un seul et même trajet.
 *
 * ── LA RÈGLE, ÉNONCÉE UNE FOIS ──────────────────────────────────────────────────────────
 *
 * Un excès est un dépassement de la LIMITE LÉGALE de la voie, au-delà d'une tolérance de
 * 5 km/h, par une vitesse que le DÉPLACEMENT SOUTIENT, observé sur au moins deux positions.
 * Tout le reste est un doute, et un doute se montre — il ne se compte pas.
 *
 * ⚠️ Ce fichier ne connaît ni Prisma, ni Angular, ni le préprocesseur : c'est la condition
 * pour qu'il n'en existe qu'un. Toute réponse à « est-ce un excès ? » passe par ici.
 */

/**
 * Tolérance avant de compter un dépassement (km/h au-dessus de la limite).
 *
 * Elle couvre le bruit de la mesure Doppler (±3 km/h dans le pire cas, chiffre que le rapport
 * de vitesse énonce lui-même) et la marge d'usage. En dessous, affirmer une faute reviendrait
 * à opposer à quelqu'un l'imprécision de notre propre instrument.
 */
export const TOLERANCE_EXCES_KMH = 5;

/**
 * Durée minimale d'un excès établi.
 *
 * Un segment bâti sur UN SEUL point ne prouve rien : une position aberrante suffisait à
 * produire un « excès confirmé ». On exige que le dépassement soit vu sur au moins deux
 * positions, donc sur une durée non nulle. Le point isolé ne disparaît pas pour autant : il
 * rejoint les pointes à vérifier.
 */
export const EXCES_DUREE_MIN_SEC = 1;

/**
 * ── UN DÉPASSEMENT ÉNORME EST UN RATTACHEMENT RATÉ, PAS UNE FAUTE ───────────────────────
 *
 * Constat du 3 septembre : « Limite 30 · dépassement +72 » sur la rocade toulousaine. Personne
 * ne roule à 102 km/h dans une rue à 30 : c'est le point qui a été rattaché au pont qui franchit
 * la rocade, pas le conducteur qui a fauté.
 *
 * ⚠️ On ne remonte PAS la limite et on n'invente pas d'excès plus doux : on refuse seulement
 * d'affirmer. Le doute doit se voir, pas disparaître.
 */
export const LIMITE_LENTE_KMH = 50;
export const ECART_INVRAISEMBLABLE_KMH = 40;

/** Le couple (limite, vitesse) est-il crédible, ou trahit-il un mauvais rattachement ? */
export function ecartCredible(limiteKmh: number, vitesseKmh: number): boolean {
  if (limiteKmh > LIMITE_LENTE_KMH) return true;
  return vitesseKmh - limiteKmh <= ECART_INVRAISEMBLABLE_KMH;
}

/**
 * La question, posée sur UN point : cette vitesse dépasse-t-elle cette limite ?
 *
 * `null`/`undefined` en limite = on ne SAIT pas, et ne pas savoir n'est pas une innocence :
 * c'est l'absence de fait. La fonction rend `false`, et c'est au taux de couverture
 * (`limitsCoverage`) de dire combien de fois on n'a pas su.
 */
export function estEnExces(limiteKmh: number | null | undefined, vitesseKmh: number): boolean {
  if (limiteKmh == null || !Number.isFinite(limiteKmh)) return false;
  return vitesseKmh > limiteKmh + TOLERANCE_EXCES_KMH;
}

/** Un segment est-il ÉTABLI, ou trop court pour être affirmé ? */
export function excesEtabli(segment: { durationSec: number }): boolean {
  return segment.durationSec >= EXCES_DUREE_MIN_SEC;
}

/** Le compte d'un trajet, tel que TOUS les écrans doivent le lire. */
export interface ResumeExces {
  /** Nombre d'excès établis. */
  nombre: number;
  /** Durée cumulée passée en excès (s). */
  dureeSec: number;
  /** Le pire dépassement, ou `null` si aucun excès. */
  pire: SpeedingSegmentDto | null;
}

/**
 * Résume les excès d'un trajet.
 *
 * ⚠️ Filtre les segments non établis. Les analyses écrites AVANT le lot V2 peuvent contenir
 * des segments de durée nulle : les compter ferait dire au rapport disciplinaire ce que
 * l'analyse a depuis cessé d'affirmer.
 */
export function resumeExces(segments: readonly SpeedingSegmentDto[] | null | undefined): ResumeExces {
  const etablis = (segments ?? []).filter(excesEtabli);
  let pire: SpeedingSegmentDto | null = null;
  let dureeSec = 0;
  for (const s of etablis) {
    dureeSec += s.durationSec;
    if (!pire || s.overKmh > pire.overKmh || (s.overKmh === pire.overKmh && s.durationSec > pire.durationSec)) {
      pire = s;
    }
  }
  return { nombre: etablis.length, dureeSec, pire };
}

/**
 * LE compte d'un trajet, à partir de son analyse — la fonction que TOUS les écrans appellent.
 *
 * ⚠️ Le détail fait FOI quand il existe. `speedingCount` est un compteur écrit au moment de
 * l'analyse : sur les analyses antérieures au lot V2, il inclut des segments de durée nulle
 * (une position aberrante suffisait à produire un « excès confirmé ») que le détail, relu
 * aujourd'hui, écarte. S'en remettre au compteur ferait dire à l'écran ce que la règle
 * actuelle a cessé d'affirmer — et le rapport disciplinaire, lui, lit le détail.
 *
 * Le compteur reste le repli pour les analyses dont le détail n'a pas été chargé : mieux vaut
 * un chiffre approché qu'un zéro faux.
 */
export function excesDuTrajet(
  analyse: { speedingCount?: number; detail?: { speeding?: SpeedingSegmentDto[] } | null } | null | undefined,
): ResumeExces {
  const segments = analyse?.detail?.speeding;
  if (Array.isArray(segments)) return resumeExces(segments);
  return { nombre: Math.max(0, analyse?.speedingCount ?? 0), dureeSec: 0, pire: null };
}

/**
 * Cette position tombe-t-elle DANS un excès établi ? Rend le segment concerné, ou `null`.
 *
 * C'est ce qui permet à un document de dire « cette mesure appartient à l'excès de 14 h 03,
 * sur une voie limitée à 90 » au lieu de « cette mesure dépasse 90 », phrase qui n'a de sens
 * sur aucune route en particulier.
 */
export function excesContenant(
  segments: readonly SpeedingSegmentDto[] | null | undefined,
  instant: Date | string | number,
): SpeedingSegmentDto | null {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(t)) return null;
  for (const s of segments ?? []) {
    if (!excesEtabli(s)) continue;
    const debut = new Date(s.startAt).getTime();
    const fin = new Date(s.endAt).getTime();
    if (Number.isFinite(debut) && Number.isFinite(fin) && t >= debut && t <= fin) return s;
  }
  return null;
}
