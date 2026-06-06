import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  CompleteInstallationTaskDto,
  CompleteInstallationTaskResultDto,
  CreateInstallationPlanDto,
  InstallationPlanDto,
  InstallationPlanSummaryDto,
  InstallationTaskDto,
  ReorderInstallationTasksDto,
  UpdateInstallationPlanDto,
  UpsertInstallationTaskDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';

/**
 * V1.15 — Client API Plannings d'installation.
 * Lecture : SUPER_ADMIN + FLEET_ADMIN. Gestion : SUPER_ADMIN (le serveur gate).
 * `reorder` est ouvert au FLEET_ADMIN (reordonner le sens d'installation).
 */
@Injectable({ providedIn: 'root' })
export class InstallationsApiService {
  private readonly http = inject(HttpClient);

  list(): Promise<InstallationPlanSummaryDto[]> {
    return firstValueFrom(this.http.get<InstallationPlanSummaryDto[]>('/api/installations'));
  }

  findOne(id: string): Promise<InstallationPlanDto> {
    return firstValueFrom(this.http.get<InstallationPlanDto>(`/api/installations/${id}`));
  }

  create(data: CreateInstallationPlanDto): Promise<InstallationPlanDto> {
    return firstValueFrom(this.http.post<InstallationPlanDto>('/api/installations', data));
  }

  update(id: string, data: UpdateInstallationPlanDto): Promise<InstallationPlanDto> {
    return firstValueFrom(this.http.patch<InstallationPlanDto>(`/api/installations/${id}`, data));
  }

  remove(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/installations/${id}`));
  }

  addTask(planId: string, data: UpsertInstallationTaskDto): Promise<InstallationTaskDto> {
    return firstValueFrom(
      this.http.post<InstallationTaskDto>(`/api/installations/${planId}/tasks`, data),
    );
  }

  updateTask(
    planId: string,
    taskId: string,
    data: UpsertInstallationTaskDto,
  ): Promise<InstallationTaskDto> {
    return firstValueFrom(
      this.http.patch<InstallationTaskDto>(`/api/installations/${planId}/tasks/${taskId}`, data),
    );
  }

  removeTask(planId: string, taskId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`/api/installations/${planId}/tasks/${taskId}`),
    );
  }

  /** Pose : capture IMEI/SIM/notes + provisioning auto du vehicule + tracker. */
  completeTask(
    planId: string,
    taskId: string,
    data: CompleteInstallationTaskDto,
  ): Promise<CompleteInstallationTaskResultDto> {
    return firstValueFrom(
      this.http.post<CompleteInstallationTaskResultDto>(
        `/api/installations/${planId}/tasks/${taskId}/complete`,
        data,
      ),
    );
  }

  /** Resync/retry manuel du provisioning. */
  provision(planId: string, taskId: string): Promise<InstallationTaskDto> {
    return firstValueFrom(
      this.http.post<InstallationTaskDto>(
        `/api/installations/${planId}/tasks/${taskId}/provision`,
        {},
      ),
    );
  }

  /** Reordonnancement du sens d'installation (ouvert au FLEET_ADMIN). */
  reorder(planId: string, data: ReorderInstallationTasksDto): Promise<InstallationPlanDto> {
    return firstValueFrom(
      this.http.patch<InstallationPlanDto>(`/api/installations/${planId}/reorder`, data),
    );
  }
}
