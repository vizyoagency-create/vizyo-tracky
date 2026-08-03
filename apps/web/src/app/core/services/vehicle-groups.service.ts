import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface VehicleGroup {
  id: string;
  name: string;
  fleetId: string;
  createdAt: string;
  vehicles: { vehicleId: string }[];
  _count: { vehicles: number };
}

export interface UserAccess {
  type: 'ALL' | 'CUSTOM';
  groupIds: string[];
  vehicleIds: string[];
}

/**
 * ── MIGRÉ VERS `HttpClient` (2026-08-03) ─────────────────────────────────────────────
 *
 * ⚠️⚠️ CE FICHIER CACHAIT UN DÉFAUT SÉRIEUX, ET IL EST ANTÉRIEUR À LA MIGRATION.
 *
 * Cinq méthodes sur neuf ne vérifiaient PAS `res.ok` : `rename`, `remove`, `addVehicle`,
 * `removeVehicle` et — la plus grave — `setUserAccess`.
 *
 * `setUserAccess` enregistre le PÉRIMÈTRE D'ACCÈS d'un utilisateur : quels véhicules il a
 * le droit de voir. Un refus de l'API (403, 500, validation) ne levait aucune erreur : la
 * méthode rendait un succès. L'écran affichait donc « Accès enregistré » alors que rien
 * ne l'avait été, et l'administrateur repartait convaincu d'avoir restreint quelqu'un.
 *
 * Un réglage de sécurité qui échoue en annonçant qu'il a réussi est la pire des trois
 * situations possibles : pire qu'une erreur affichée, et pire que pas de réglage du tout —
 * parce qu'on cesse de vérifier ce qu'on croit avoir fait.
 *
 * `HttpClient` rend ce défaut IMPOSSIBLE À REPRODUIRE : toute réponse non-2xx devient une
 * erreur, sans que l'appelant ait à y penser. C'est la vraie raison de cette migration —
 * pas l'élégance, mais le fait qu'oublier un contrôle ne soit plus une option.
 *
 * Les signatures publiques sont inchangées (des `Promise`) : aucun appelant modifié.
 */
@Injectable({ providedIn: 'root' })
export class VehicleGroupsService {
  private readonly http = inject(HttpClient);

  list(): Promise<VehicleGroup[]> {
    return firstValueFrom(this.http.get<VehicleGroup[]>('/api/vehicle-groups'));
  }

  create(name: string, fleetId?: string): Promise<VehicleGroup> {
    const body: Record<string, string> = { name };
    if (fleetId) body['fleetId'] = fleetId;
    return firstValueFrom(this.http.post<VehicleGroup>('/api/vehicle-groups', body));
  }

  async rename(id: string, name: string): Promise<void> {
    await firstValueFrom(this.http.patch(`/api/vehicle-groups/${id}`, { name }));
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/vehicle-groups/${id}`));
  }

  async addVehicle(groupId: string, vehicleId: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`/api/vehicle-groups/${groupId}/vehicles`, { vehicleId }),
    );
  }

  async removeVehicle(groupId: string, vehicleId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`/api/vehicle-groups/${groupId}/vehicles/${vehicleId}`),
    );
  }

  // ─── Périmètre d'accès d'un utilisateur ──────────────────────────────────────────

  getUserAccess(userId: string): Promise<UserAccess> {
    return firstValueFrom(this.http.get<UserAccess>(`/api/users/${userId}/access`));
  }

  /**
   * ⚠️ RÉGLAGE DE SÉCURITÉ. Un échec DOIT remonter jusqu'à l'écran : c'est précisément
   * ce que cette méthode ne faisait pas (cf. l'en-tête du fichier).
   */
  async setUserAccess(userId: string, access: UserAccess): Promise<void> {
    await firstValueFrom(this.http.put(`/api/users/${userId}/access`, access));
  }
}
