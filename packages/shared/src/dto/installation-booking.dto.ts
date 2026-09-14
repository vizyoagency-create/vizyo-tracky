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
  /** Samedi ou dimanche — l'écran le signale, le client sait qu'il réserve un week-end. */
  weekend: boolean;
  slots: BookingSlotDto[];
}

// ───────────────────────── Découverte (vitrine) ─────────────────────────

export type DecouverteVideoId = 'supervision' | 'analyse' | 'administration' | 'depot';

/** Une scène animée de la vitrine (`decouvrir.html#…`), présentée comme une vidéo. */
export interface DecouverteVideoDto {
  id: DecouverteVideoId;
  titre: string;
  description: string;
  /** URL ABSOLUE sur la vitrine, avec `?from=` pour que la vitrine sache d'où on vient. */
  url: string;
}

/**
 * Les liens « découvrir Tracky » affichés sur la page de RDV : le client qui attend sa pose
 * peut voir à quoi ressemble ce qu'on va lui installer. Les URL sont décidées CÔTÉ SERVEUR
 * (une seule adresse de vitrine, la même que les courriels).
 */
export interface DecouverteDto {
  /** `decouvrir.html` — la présentation en vidéo (supervision, analyse, administration). */
  presentationUrl: string;
  /** `decouvrir-depot.html` — l'espace dépôt, pour les clients d'un transporteur. */
  depotUrl: string;
  videos: DecouverteVideoDto[];
}

// ───────────────────────── Visites (suivi) ─────────────────────────

/**
 * Les gestes qu'une visite peut raconter. Ceux marqués « serveur » sont posés par l'API
 * elle-même (une réservation qui aboutit) ; les autres viennent de la page, via
 * `POST /public/booking/:token/visites/:id/evenements`, et sont horodatés à la RÉCEPTION —
 * jamais avec l'heure du navigateur.
 */
export type BookingVisitEventType =
  | 'ouverture'          // serveur — target : 'nouvelle' | 'rechargement'
  | 'jour'               // page — target : "YYYY-MM-DD"
  | 'creneau'            // page — target : libellé du créneau
  | 'formulaire'         // page — premier champ touché
  | 'decouverte'         // page — target : 'presentation' | 'depot' | 'video:<id>'
  | 'appel'              // page — clic sur « Appeler »
  | 'courriel'           // page — target : 'nouveau-lien' | 'creneau' | 'question'
  | 'reservation'        // serveur — target : libellé du créneau
  | 'reservation_echec'  // serveur — target : motif
  | 'abonnement';        // serveur — « prévenez-moi » déposé

/** Ce que la page a le droit d'envoyer. Le reste, seule l'API le pose. */
export const BOOKING_VISIT_EVENTS_PAGE: readonly BookingVisitEventType[] = [
  'jour', 'creneau', 'formulaire', 'decouverte', 'appel', 'courriel',
];

export interface BookingVisitEventDto {
  /** ISO 8601, horodatage serveur. */
  t: string;
  type: BookingVisitEventType;
  target: string | null;
}

/** Un geste envoyé par la page publique. */
export interface EnregistrerEvenementVisiteDto {
  type: BookingVisitEventType;
  target?: string;
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
  /**
   * Téléphone de l'ATELIER, prêt à afficher. `null` = ne pas montrer le bouton.
   *
   * ⚠️ Numéro d'atelier, **jamais** celui d'une personne — confirmé par le client
   * le 2026-08-16. Cette page est publique, son URL circule, et un numéro
   * personnel exposé là ne se reprend plus. Il vient d'une configuration serveur,
   * pas d'une fiche utilisateur.
   */
  telephonePublic: string | null;
  /**
   * L'atelier accepte-t-il de prévenir quand un créneau se libère ?
   * `false` → on n'offre pas une sortie qui ne mène nulle part.
   */
  abonnementCreneauDisponible: boolean;
  /** Au moins un jour de week-end est ouvert : l'écran le dit avant même la liste des jours. */
  weekendOuvert: boolean;
  /**
   * La visite créée (ou réutilisée) par cet appel. `null` si le suivi a échoué : la page
   * fonctionne exactement pareil, elle n'envoie simplement plus de gestes.
   */
  visite: { id: string } | null;
  decouverte: DecouverteDto;
}

/** « Prévenez-moi » — la sortie n° 3 quand aucun créneau ne convient. */
export interface AbonnementCreneauDto {
  /** Rien d'autre n'est demandé : le strict nécessaire pour envoyer un e-mail. */
  email: string;
  /** La visite en cours, pour que la chronologie raconte l'abonnement. */
  visiteId?: string;
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
  /** La visite en cours, pour rattacher la demande à la chronologie de la page. */
  visiteId?: string;
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
  /** Fenêtre du week-end (minutes depuis minuit, Europe/Paris) ; `null` = comme la semaine. */
  weekendStartMinutes: number | null;
  weekendEndMinutes: number | null;
  horizonDays: number;
  leadHours: number;
  active: boolean;
  singleUse: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  pendingCount: number;
  confirmedCount: number;
  /** Observabilité : nombre d'ouvertures de la page publique + 1re / dernière ouverture. */
  openCount: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  /** Visites HUMAINES enregistrées (les robots de prévisualisation sont comptés à part). */
  visitCount: number;
  robotVisitCount: number;
}

/** Une visite de la page publique, telle que l'admin la lit. */
export interface InstallationBookingLinkVisitDto {
  id: string;
  openedAt: string;
  lastSeenAt: string;
  /** « 92.184.x.x » — tronquée, jamais complète. */
  ipTruncated: string | null;
  device: 'mobile' | 'tablet' | 'desktop' | null;
  os: string | null;
  browser: string | null;
  referrerHost: string | null;
  /** Provenance lisible, dérivée côté serveur (« Gmail », « Ouverture directe… »). */
  provenance: string;
  robot: boolean;
  contactName: string | null;
  contactEmail: string | null;
  /** 'LIEN_DIRECT' = présumé (lien nominatif) ; 'RESERVATION' / 'ABONNEMENT' = certain. */
  identitySource: 'LIEN_DIRECT' | 'RESERVATION' | 'ABONNEMENT' | null;
  events: BookingVisitEventDto[];
  bookingId: string | null;
}

export interface InstallationBookingLinkVisitsDto {
  linkId: string;
  /** Visites humaines. */
  humaines: number;
  robots: number;
  /** Visites humaines qui ont abouti à une demande de créneau. */
  avecReservation: number;
  /** Les plus récentes d'abord, bornées côté serveur. */
  visites: InstallationBookingLinkVisitDto[];
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
  /** Fenêtre du week-end ; les deux ensemble, ou `null` pour « comme la semaine ». */
  weekendStartMinutes?: number | null;
  weekendEndMinutes?: number | null;
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
  weekendStartMinutes?: number | null;
  weekendEndMinutes?: number | null;
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
