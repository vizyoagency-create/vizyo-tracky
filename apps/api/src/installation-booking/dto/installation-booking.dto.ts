import {
  ArrayMaxSize,
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
} from 'class-validator';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ENERGIES = ['DIESEL', 'ESSENCE', 'ELECTRIQUE', 'HYBRIDE', 'AUTRE'] as const;

/** Création d'un lien public (SUPER_ADMIN). */
export class CreateBookingLinkDto {
  @IsUUID()
  fleetId!: string;

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

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  horizonDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  leadHours?: number;

  @IsOptional()
  @IsBoolean()
  singleUse?: boolean;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}

/** Mise à jour d'un lien (config + activation). */
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

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  horizonDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  leadHours?: number;

  @IsOptional()
  @IsBoolean()
  singleUse?: boolean;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}

/** Soumission d'une réservation depuis la page publique (hors auth). */
export class CreatePublicBookingDto {
  @IsISO8601()
  startAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  clientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  clientPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  clientAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  vehiclePlate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicleBrand?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicleModel?: string;

  @IsOptional()
  @IsIn(ENERGIES)
  vehicleEnergy?: (typeof ENERGIES)[number] | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** Validation d'une demande → création de la pose (SUPER_ADMIN). */
export class ConfirmBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  vehiclePlate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicleBrand?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicleModel?: string | null;

  @IsOptional()
  @IsIn(ENERGIES)
  vehicleEnergy?: (typeof ENERGIES)[number] | null;

  @IsOptional()
  @IsString()
  @Matches(DATE_REGEX, { message: 'scheduledDate: format YYYY-MM-DD attendu' })
  scheduledDate?: string | null;
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
