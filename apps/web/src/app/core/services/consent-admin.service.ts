import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface AdminConsentDoc {
  accepted: boolean;
  at?: string;
  ip?: string | null;
}
export interface AdminConsentUser {
  userId: string;
  email: string;
  name: string;
  role: string;
  version: string;
  cgu: AdminConsentDoc;
  privacy: AdminConsentDoc;
  compliant: boolean;
  /** null = permission jamais demandée, true = accordée, false = refusée. */
  notif: boolean | null;
  geo: boolean | null;
}
export interface AdminLpConsent {
  id: string;
  choice: string;
  ip: string | null;
  page: string | null;
  sessionId: string | null;
  categories: unknown;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class ConsentAdminService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/admin/consent';

  getUsers(): Promise<AdminConsentUser[]> {
    return firstValueFrom(this.http.get<AdminConsentUser[]>(`${this.base}/users`));
  }
  getLp(limit = 100): Promise<AdminLpConsent[]> {
    return firstValueFrom(this.http.get<AdminLpConsent[]>(`${this.base}/lp`, { params: { limit } }));
  }
}
