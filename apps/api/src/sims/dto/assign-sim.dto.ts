import { IsUUID } from 'class-validator';

export class AssignSimDto {
  @IsUUID()
  trackerId!: string;
}
