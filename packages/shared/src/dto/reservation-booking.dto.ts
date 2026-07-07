/**
 * Refonte agenda/IA (2026-07, P4) — Lien PUBLIC de demande de réservation.
 * Un tiers décrit un besoin (places, date, destination) sur une page hors auth ; l'app propose des
 * véhicules/combinaisons DISPONIBLES de la société FIXE du lien ; la demande atterrit en REQUESTED.
 * Types partagés API ↔ web.
 */

/** Info publique d'un lien (page hors auth). */
export interface PublicReservationLinkDto {
  fleetName: string | null;
  label: string | null;
  horizonDays: number;
  leadHours: number;
}

/** Analyse IA rapide d'un besoin DICTÉ (voix → texte) : extrait les champs du formulaire. */
export interface ParsePublicNeedDto {
  text: string;
}

/** Résultat de l'analyse : champs extraits (null = non compris). Créneaux en ISO. */
export interface ParsedNeedDto {
  seatsNeeded: number | null;
  destination: string | null;
  startAt: string | null;
  endAt: string | null;
}

/** Soumission publique : le BESOIN (le serveur choisit le véhicule, invisible au demandeur). */
export interface SubmitPublicReservationDto {
  startAt: string;
  endAt: string;
  seatsNeeded?: number;
  destination?: string;
  freeText?: string;
  requesterName?: string;
  requesterContact?: string;
  // #4 — Plus de `vehicleIds` : un lien public n'expose AUCUN véhicule. Le serveur choisit le
  // véhicule à la soumission (d'après le besoin) ; le gestionnaire valide.
}

export interface SubmitPublicReservationResultDto {
  created: number;
  message: string;
}

/* ── Admin ── */

/** Lien de réservation (vue admin). */
export interface ReservationBookingLinkDto {
  id: string;
  fleetId: string;
  fleetName: string | null;
  token: string;
  publicUrl: string;
  label: string | null;
  active: boolean;
  openCount: number;
  lastOpenedAt: string | null;
  createdAt: string;
}

/** Création d'un lien (admin). `fleetId` requis pour un super-admin. */
export interface CreateReservationBookingLinkDto {
  fleetId?: string;
  label?: string;
  horizonDays?: number;
  leadHours?: number;
}
