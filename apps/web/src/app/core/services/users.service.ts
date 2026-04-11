import { inject, Injectable } from '@angular/core';
import { AuthService } from './auth.service';

export interface TrackyUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
}

export interface CreateUserPayload {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  role: string;
}

@Injectable({ providedIn: 'root' })
export class UsersApiService {
  private readonly auth = inject(AuthService);

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.auth.token}`,
    };
  }

  async findAll(): Promise<TrackyUser[]> {
    const res = await fetch('/api/users', { headers: this.headers });
    if (!res.ok) throw new Error('Failed to load users');
    return res.json();
  }

  async create(payload: CreateUserPayload): Promise<TrackyUser> {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, string>;
      throw new Error(body['message'] ?? 'Failed to create user');
    }
    return res.json();
  }

  async remove(id: string): Promise<void> {
    const res = await fetch(`/api/users/${id}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok && res.status !== 204) throw new Error('Failed to delete user');
  }
}
