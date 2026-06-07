import { IsInt, Max, Min } from 'class-validator';

/** Changement de statut operateur via WhereverSIM updateSim (cf. SIM_STATUS). */
export class SetSimStatusDto {
  @IsInt()
  @Min(1)
  @Max(20)
  statusId!: number;
}
