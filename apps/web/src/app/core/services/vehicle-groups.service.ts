import { inject, Injectable } from '@angular/core';
import { AuthService } from './auth.service';

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

@Injectable({ providedIn: 'root' })
export class VehicleGroupsService {
  private readonly auth = inject(AuthService);

  private get headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.auth.token}` };
  }

  async list(): Promise<VehicleGroup[]> {
    const res = await fetch('/api/vehicle-groups', { headers: this.headers });
    if (!res.ok) throw new Error('Failed to load groups');
    return res.json();
  }

  async create(name: string, fleetId?: string): Promise<VehicleGroup> {
    const body: Record<string, string> = { name };
    if (fleetId) body['fleetId'] = fleetId;
    const res = await fetch('/api/vehicle-groups', {
      method: 'POST', headers: this.headers, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as Record<string, string>;
      throw new Error(b['message'] ?? 'Failed to create group');
    }
    return res.json();
  }

  async rename(id: string, name: string): Promise<void> {
    await fetch(`/api/vehicle-groups/${id}`, {
      method: 'PATCH', headers: this.headers, body: JSON.stringify({ name }),
    });
  }

  async remove(id: string): Promise<void> {
    await fetch(`/api/vehicle-groups/${id}`, { method: 'DELETE', headers: this.headers });
  }

  async addVehicle(groupId: string, vehicleId: string): Promise<void> {
    await fetch(`/api/vehicle-groups/${groupId}/vehicles`, {
      method: 'POST', headers: this.headers, body: JSON.stringify({ vehicleId }),
    });
  }

  async removeVehicle(groupId: string, vehicleId: string): Promise<void> {
    await fetch(`/api/vehicle-groups/${groupId}/vehicles/${vehicleId}`, {
      method: 'DELETE', headers: this.headers,
    });
  }

  // User access
  async getUserAccess(userId: string): Promise<UserAccess> {
    const res = await fetch(`/api/users/${userId}/access`, { headers: this.headers });
    if (!res.ok) throw new Error('Failed to load access');
    return res.json();
  }

  async setUserAccess(userId: string, access: UserAccess): Promise<void> {
    await fetch(`/api/users/${userId}/access`, {
      method: 'PUT', headers: this.headers, body: JSON.stringify(access),
    });
  }
}
