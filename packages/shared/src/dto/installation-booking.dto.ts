/**
 * Prise de RDV en ligne — DTOs partagés frontend/backend.
 *
 * Le SUPER_ADMIN génère un LIEN public (scope flotte) ; le client ouvre
 * `/book/<token>` (hors auth), choisit un créneau LIBRE et dépose une DEMANDE
 * (`InstallationBooking`, statut PENDING). L'opérateur valide → la pose est créée
 * dans le planning du lien (même lien = même planning) + e-mails.
 *
 * Dates : `startAt`/`endAt`/`createdAt`… en ISO 8601 (instant UTC). L'affichage
 * des créneaux se fait en Europe/Paris (le backend fournit aussi des libellés).
 */

import type { InstallationEnergy } from './installation.dto';

export type InstallationBookingStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';

// ───────────────────────── Public (page /book/:token) ─────────────────────────

/** Un créneau proposable. */
export interface BookingSlotDto {
  /** ISO 8601 (instant). */
  startAt: string;
  endAt: string;
  /** Libellé heure lisible, fuseau Europe/Paris (ex. « 08:00 – 10:00 »). */
  label: string;
}

/** Un jour avec ses créneaux libres (jour local Europe/Paris). */
export interface BookingDayDto {
  /** "YYYY-MM-DD" (jour local Paris). */
  date: string;
  /** Libellé lisible (ex. « lun. 7 juil. »). */
  label: string;
  slots: BookingSlotDto[];
}

/** Réponse publique : infos du lien + disponibilités. */
export interface PublicBookingLinkDto {
  /** Nom affiché au client (société / flotte). */
  companyName: string;
  /** false si le lien est actif et réservable. */
  closed: boolean;
  /** Message si fermé (expiré / désactivé / usage unique consommé). */
  closedReason: string | null;
  /** true = lien générique (le client saisit ses infos) ; false = client connu (pré-rempli). */
  needsClientInfo: boolean;
  /** Pré-remplissage (mode « lien direct »). */
  prefill: { name: string | null; email: string | null; phone: string | null; address: string | null } | null;
  slotMinutes: number;
  days: BookingDayDto[];
}

/** Soumission d'une réservation (POST public). */
export interface CreatePublicBookingDto {
  /** ISO d'un créneau proposé (doit correspondre à une disponibilité). */
  startAt: string;
  /** Requis si `needsClientInfo` (lien générique) ; ignoré sinon. */
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  clientAddress?: string;
  vehiclePlate?: string;
  vehicleBrand?: string;
  vehicleModel?: string;
  vehicleEnergy?: InstallationEnergy | null;
  notes?: string;
}

export interface PublicBookingResultDto {
  ok: boolean;
  startAt: string;
  endAt: string;
  /** Libellé lisible du créneau confirmé (Europe/Paris). */
  slotLabel: string;
}

// ───────────────────────────────── Admin ──────────────────────────────────────

export interface InstallationBookingDto {
  id: string;
  linkId: string;
  linkLabel: string;
  fleetId: string;
  planId: string | null;
  startAt: string;
  endAt: string;
  status: InstallationBookingStatus;
  clientName: string;
  clientEmail: string;
  clientPhone: string | null;
  clientAddress: string | null;
  vehiclePlate: string | null;
  vehicleBrand: string | null;
  vehicleModel: string | null;
  vehicleEnergy: InstallationEnergy | null;
  notes: string | null;
  taskId: string | null;
  rejectionReason: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationBookingLinkDto {
  id: string;
  fleetId: string;
  fleetName: string;
  planId: string | null;
  label: string;
  /** URL publique COMPLÈTE (`/book/<token>`) — à copier/partager. */
  publicUrl?: string;
  clientName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  clientAddress: string | null;
  slotMinutes: number;
  dayStartMinutes: number;
  dayEndMinutes: number;
  workingDays: number[];
  horizonDays: number;
  leadHours: number;
  active: boolean;
  singleUse: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  pendingCount: number;
  confirmedCount: number;
}

export interface CreateInstallationBookingLinkDto {
  fleetId: string;
  label: string;
  /** Lier à un planning existant (sinon un planning est créé à la 1re validation). */
  planId?: string | null;
  /** clientEmail renseigné => « lien direct » : la page publique ne redemande pas l'e-mail. */
  clientName?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  clientAddress?: string | null;
  slotMinutes?: number;
  dayStartMinutes?: number;
  dayEndMinutes?: number;
  workingDays?: number[];
  horizonDays?: number;
  leadHours?: number;
  singleUse?: boolean;
  expiresAt?: string | null;
}

export interface UpdateInstallationBookingLinkDto {
  label?: string;
  active?: boolean;
  slotMinutes?: number;
  dayStartMinutes?: number;
  dayEndMinutes?: number;
  workingDays?: number[];
  horizonDays?: number;
  leadHours?: number;
  singleUse?: boolean;
  expiresAt?: string | null;
}

export interface ConfirmInstallationBookingDto {
  /** Plaque du véhicule (requise pour créer la pose) — défaut : celle fournie par le client. */
  vehiclePlate?: string | null;
  vehicleBrand?: string | null;
  vehicleModel?: string | null;
  vehicleEnergy?: InstallationEnergy | null;
  /** Date de pose "YYYY-MM-DD" — défaut : le jour du créneau réservé. */
  scheduledDate?: string | null;
}

export interface RejectInstallationBookingDto {
  reason?: string | null;
  /** Envoyer un e-mail de refus au client (défaut false). */
  notifyClient?: boolean;
}
