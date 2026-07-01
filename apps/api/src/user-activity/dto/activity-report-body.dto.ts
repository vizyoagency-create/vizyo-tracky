import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';

/** Génération à la demande d'un rapport d'observation. */
export class GenerateActivityReportBodyDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  userIds!: string[];

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/** Réglage de la planification (super-admin). */
export class SetActivityReportScheduleBodyDto {
  @IsBoolean()
  enabled!: boolean;

  @IsIn(['daily', 'weekly', 'monthly'])
  frequency!: 'daily' | 'weekly' | 'monthly';

  @IsIn(['ACTIVE', 'ALL'])
  scope!: 'ACTIVE' | 'ALL';
}
