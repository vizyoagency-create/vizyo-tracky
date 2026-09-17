import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { BOOKING_VISIT_EVENTS_PAGE, type BookingVisitEventType } from '@vizyo/tracky-shared';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ENERGIES = ['DIESEL', 'ESSENCE', 'ELECTRIQUE', 'HYBRIDE', 'AUTRE'] as const;

/** Un véhicule déclaré par le client — tout est facultatif, il ne sait pas toujours. */
export class BookingVehicleInputDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  plate?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  brand?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  model?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(ENERGIES)
  energy?: (typeof ENERGIES)[number] | null;
}

/** Correction d'un véhicule à la validation (par position). */
export class BookingVehicleFixDto extends BookingVehicleInputDto {
  @IsInt()
  @Min(0)
  @Max(9)
  position!: number;
}

/** Plafond absolu du multi-véhicules (6 × 2 h = une journée entière). */
export const MAX_VEHICULES_ABSOLU = 6;

/** Création d'un lien public (SUPER_ADMIN). */
export class CreateBookingLinkDto {
  /** Facultatif (lien prospect) : `companyName` est alors obligatoire — règle du service. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  fleetId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  companyName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_VEHICULES_ABSOLU)
  maxVehicles?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsOptional()
  @IsUUID()
  planId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientName?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  clientEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  clientPhone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  clientAddress?: string | null;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(480)
  slotMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  dayStartMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  dayEndMinutes?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  workingDays?: number[];

  /**
   * Fenêtre horaire du WEEK-END (minutes depuis minuit, Europe/Paris). `null` explicite =
   * « comme la semaine ». Les deux vont ensemble : le service refuse l'une sans l'autre.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1440)
  weekendStartMinutes?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1440)
  weekendEndMinutes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  horizonDays?: number;

  /** Premier jour proposé : J+N (jours entiers). 1 = dès demain ; le jour même n'existe pas. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  leadDays?: number;

  @IsOptional()
  @IsBoolean()
  singleUse?: boolean;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}

/** Mise à jour d'un lien (config + activation + rattachement d'une flotte). */
export class UpdateBookingLinkDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  fleetId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  companyName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_VEHICULES_ABSOLU)
  maxVehicles?: number;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(480)
  slotMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  dayStartMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  dayEndMinutes?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  workingDays?: number[];

  /**
   * Fenêtre horaire du WEEK-END (minutes depuis minuit, Europe/Paris). `null` explicite =
   * « comme la semaine ». Les deux vont ensemble : le service refuse l'une sans l'autre.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1440)
  weekendStartMinutes?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1440)
  weekendEndMinutes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  horizonDays?: number;

  /** Premier jour proposé : J+N (jours entiers). 1 = dès demain ; le jour même n'existe pas. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  leadDays?: number;

  @IsOptional()
  @IsBoolean()
  singleUse?: boolean;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}

/**
 * Soumission d'une réservation depuis la page publique (hors auth).
 *
 * Le CONTACT est obligatoire (décision du 16/09) — nom, e-mail, téléphone — même sur un lien
 * nominatif (le lien pré-remplit, le client corrige). Les formats fins (E.164, e-mail en
 * minuscules) sont posés par le service, qui sait dire pourquoi il refuse.
 */
export class CreatePublicBookingDto {
  @IsISO8601()
  startAt!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VEHICULES_ABSOLU)
  vehicleCount!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VEHICULES_ABSOLU)
  @ValidateNested({ each: true })
  @Type(() => BookingVehicleInputDto)
  vehicles!: BookingVehicleInputDto[];

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  clientName!: string;

  @IsString()
  @MaxLength(254)
  clientEmail!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(40)
  clientPhone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  clientAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /** La visite en cours (rendue par le GET). Inconnue ou d'un autre lien → ignorée, jamais refusée. */
  @IsOptional()
  @IsUUID()
  visiteId?: string;
}

/** « Prévenez-moi si un créneau se libère » (page publique). */
export class AbonnementCreneauDto {
  @IsString()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsUUID()
  visiteId?: string;
}

/**
 * Un geste de la page publique, ajouté à la chronologie de sa visite.
 *
 * ⚠️ Seuls les types que la PAGE a le droit de poser sont acceptés ici : « réservation »
 * ou « abonnement » sont posés par l'API elle-même quand l'acte a réellement eu lieu. Sans
 * cette liste, n'importe quel appel pourrait écrire « a réservé » dans une chronologie.
 */
export class EnregistrerEvenementVisiteDto {
  @IsIn(BOOKING_VISIT_EVENTS_PAGE as readonly string[])
  type!: BookingVisitEventType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  target?: string;
}

/** Validation d'une demande → création des poses, une par véhicule (SUPER_ADMIN). */
export class ConfirmBookingDto {
  /** Demande sans flotte : rattacher celle-ci… */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  fleetId?: string | null;

  /** …ou la créer via Vizyo Manager (actif quand le lot D est déployé et configuré). */
  @IsOptional()
  @IsBoolean()
  creerClient?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_VEHICULES_ABSOLU)
  @ValidateNested({ each: true })
  @Type(() => BookingVehicleFixDto)
  vehicles?: BookingVehicleFixDto[];

  @IsOptional()
  @IsString()
  @Matches(DATE_REGEX, { message: 'scheduledDate: format YYYY-MM-DD attendu' })
  scheduledDate?: string | null;
}

/** Annulation d'une demande par l'opérateur (SUPER_ADMIN). */
export class CancelBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @IsOptional()
  @IsBoolean()
  notifyClient?: boolean;
}

/** Refus d'une demande (SUPER_ADMIN). */
export class RejectBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @IsOptional()
  @IsBoolean()
  notifyClient?: boolean;
}
