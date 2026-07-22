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

/**
 * Sollicitation d'un client pour autoriser le partage vers une application
 * partenaire, et ce qu'il en a fait. `state` est DÉRIVÉ côté serveur (il dépend
 * de l'heure) — ne pas le recalculer ici, on obtiendrait deux vérités.
 */
export interface AdminPartnerInvitation {
  id: string;
  fleetName: string;
  partner: string;
  email: string;
  sentAt: string;
  expiresAt: string;
  openedAt: string | null;
  openCount: number;
  openIp: string | null;
  acceptedAt: string | null;
  acceptedScopes: string[];
  state: 'ACCEPTED' | 'OPENED' | 'EXPIRED' | 'SENT';
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
  /** Servi par le module partenaire — 404 si l'intégration est éteinte. */
  getPartnerInvitations(): Promise<AdminPartnerInvitation[]> {
    return firstValueFrom(
      this.http.get<AdminPartnerInvitation[]>('/api/admin/partner-links/invitations'),
    );
  }
}
