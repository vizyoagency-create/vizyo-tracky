import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface AdminSecurityUser {
  userId: string;
  email: string;
  name: string;
  role: string;
  twoFactorEnabled: boolean;
  lastLogin: {
    at: string;
    city: string | null;
    region: string | null;
    country: string | null;
    ip: string | null;
  } | null;
  connections: number;
  devices: number;
}

export interface AdminLoginPoint {
  lat: number;
  lng: number;
  city: string | null;
  region: string | null;
  country: string | null;
  createdAt: string;
  deviceId: string | null;
  newDevice: boolean;
  farFromUsual: boolean;
  challenged: boolean;
}

export interface AdminUserLocations {
  user: { id: string; name: string; email: string; twoFactorEnabled: boolean };
  points: AdminLoginPoint[];
  cities: Array<{ city: string; count: number }>;
}

/** Vue admin sécurité (SUPER_ADMIN) : 2FA + carte des lieux de connexion. */
@Injectable({ providedIn: 'root' })
export class SecurityAdminService {
  private readonly http = inject(HttpClient);

  getUsers(): Observable<AdminSecurityUser[]> {
    return this.http.get<AdminSecurityUser[]>('/api/admin/security/users');
  }

  getUserLocations(userId: string): Observable<AdminUserLocations> {
    return this.http.get<AdminUserLocations>(`/api/admin/security/users/${userId}/locations`);
  }
}
