import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Min, ValidateNested } from 'class-validator';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export class ReorderTaskItemDto {
  @IsUUID()
  id!: string;

  @IsInt()
  @Min(0)
  orderIndex!: number;

  /** Optionnel — deplacer la tache vers un autre jour. "YYYY-MM-DD" ou null. */
  @IsOptional()
  @IsString()
  @Matches(DATE_REGEX, { message: 'scheduledDate: format YYYY-MM-DD attendu' })
  scheduledDate?: string | null;
}

/** Reordonnancement du "sens d'installation" — ouvert au FLEET_ADMIN de la flotte. */
export class ReorderInstallationTasksDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ReorderTaskItemDto)
  tasks!: ReorderTaskItemDto[];
}
