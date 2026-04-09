import { IsUUID } from 'class-validator';

export class AssignTrackerDto {
  @IsUUID()
  vehicleId!: string;
}
