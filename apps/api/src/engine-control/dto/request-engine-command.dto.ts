import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { EngineAction } from '@prisma/client';

export class RequestEngineCommandDto {
  @IsEnum(EngineAction, { message: 'action doit être CUT ou RESTORE' })
  action!: EngineAction;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
