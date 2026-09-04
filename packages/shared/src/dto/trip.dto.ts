import type { DriverSummaryDto } from './driver.dto';

export interface TripNoteAuthorDto {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

export interface TripDto {
  id: string;
  vehicleId: string;
  trackerId: string | null;
  fleetId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  distanceMeters: number;
  maxSpeed: number;
  avgSpeed: number;
  startLat: number;
  startLng: number;
  endLat: number | null;
  endLng: number | null;
  positionCount: number;
  segmentationSource: string;
  polyline: string | null;
  /** Sprint G.3 V1.4 : polyligne snappee aux routes via OSRM. Optionnelle. */
  polylineMatched?: string | null;
  /** Note libre attachee au trajet (max 500 chars). null = pas de note. */
  notes?: string | null;
  /** ISO date de la derniere edition de la note. null si jamais posee. */
  notesUpdatedAt?: string | null;
  /** Dernier auteur de la note. null si jamais posee ou auteur supprime. */
  notesUpdatedBy?: TripNoteAuthorDto | null;
  /** Conducteur snape sur ce trajet. null si jamais assigne. */
  driver?: DriverSummaryDto | null;
  /** 'AUTO' = snape au finalize. 'MANUAL' = modifie manuellement. */
  driverSource?: 'AUTO' | 'MANUAL' | null;
}

export interface UpdateTripNoteDto {
  /** Texte de la note (max 500 chars). null ou chaine vide = effacer. */
  notes: string | null;
}

export interface TripDailySummaryDto {
  date: string;
  tripCount: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  maxSpeed: number;
}

/**
 * Données des graphiques de période — agrégées CÔTÉ SERVEUR, sans plafond.
 *
 * ⚠️ Ces deux graphiques se calculaient depuis la liste affichée des trajets, bornée à
 * 100. Sur 30 jours et 2 738 trajets, la fréquentation ne couvrait qu'une journée et
 * affichait zéro trajet le mardi, quand le résumé journalier de la même page en comptait
 * 132. Un graphique faux mais dessiné a plus d'autorité qu'un tableau juste.
 */
export interface TripPeriodChartsDto {
  /** Vitesse max de CHAQUE trajet de la période (déjà plafonnée aux valeurs plausibles). */
  speeds: number[];
  /** Grille 7×24 des départs, **lundi = 0**, en heure d'Europe/Paris. */
  heatmap: number[][];
}

export interface TripRecomputeResultDto {
  deleted: number;
  created: number;
  /**
   * ── LE TRAVAIL SAISI À LA MAIN, ET CE QU'IL EST DEVENU (2026-09-04) ──────────────────
   *
   * Le recalcul supprime les trajets puis les redécoupe depuis les positions. Les notes
   * rédigées par un exploitant, le conducteur affecté et la mission rattachée partaient avec
   * eux — en silence : le dialogue de confirmation annonçait la perte des récits IA, jamais
   * celle-là. Un texte écrit à la main disparaissait sans que personne ne l'ait accepté.
   *
   * Ces champs sont désormais REPRIS par recouvrement de temps. Le compte dit exactement ce
   * qui a été retrouvé, et surtout ce qui ne l'a pas été.
   */
  notesReprises: number;
  conducteursRepris: number;
  /**
   * Travail manuel qu'AUCUN nouveau trajet ne pouvait porter : le redécoupage a fondu deux
   * anciens trajets en un seul, et un seul jeu de notes peut y tenir. Ce nombre doit rester
   * visible — c'est la part de la perte qu'on ne sait pas éviter, et la taire reviendrait à
   * refaire, en plus petit, le défaut qu'on corrige.
   */
  notesPerdues: number;
}

export interface TripStartedEvent {
  tripId: string;
  vehicleId: string;
  trackerId: string;
  fleetId: string;
  startedAt: string;
  startLat: number;
  startLng: number;
}

export interface TripCompletedEvent {
  tripId: string;
  vehicleId: string;
  trackerId: string;
  fleetId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  distanceMeters: number;
  maxSpeed: number;
  avgSpeed: number;
}
