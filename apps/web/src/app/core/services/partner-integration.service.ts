import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/** Une catégorie de données, telle que présentée à l'écran de consentement. */
export interface PartnerScopeOption {
  key: string;
  label: string;
  description: string;
  defaultOn: boolean;
}

/** Aperçu renvoyé par `claim` — n'active rien, sert à décider. */
export interface PartnerClaimPreview {
  partner: string;
  organizationName: string;
  siret: string | null;
  expiresAt: string;
  scopes: PartnerScopeOption[];
}

export interface PartnerLinkEventRow {
  action: string;
  actorType: string;
  scope: string | null;
  detail: string | null;
  createdAt: string;
}

export interface PartnerLinkStatus {
  status: 'NONE' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  suspendedByPlatform: boolean;
  suspendedReason?: string | null;
  billingStatus?: string;
  organizationName?: string | null;
  scopes?: string[];
  /**
   * Ce que chaque catégorie ACTIVE donne à voir, sur 30 jours glissants —
   * « 3 412 trajets ». Clé = nom du périmètre.
   *
   * ⚠️ C'est un volume EXPOSÉ, pas consommé : rien n'enregistre ce que le
   * partenaire lit réellement. C'est le bon chiffre pour cet écran, qui décide
   * d'un ACCÈS — il répond à « cocher cette case donne accès à combien ».
   *
   * Une clé absente = compteur indisponible pour cette catégorie. L'écran se tait
   * alors, au lieu d'afficher un zéro qui affirmerait « aucune donnée ».
   */
  volume30j?: Record<string, number>;
  approvedAt?: string | null;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
  events?: PartnerLinkEventRow[];
}

/**
 * Intégrations partenaires — client HTTP. Toutes les routes exigent le rôle
 * fleet-admin ET la permission `integrations_manage`.
 */
@Injectable({ providedIn: 'root' })
export class PartnerIntegrationService {
  private readonly http = inject(HttpClient);

  status(): Observable<PartnerLinkStatus> {
    return this.http.get<PartnerLinkStatus>('/api/integrations/partner');
  }

  /** Résout un code d'appairage. N'ACTIVE RIEN — le client doit pouvoir regarder avant. */
  claim(code: string): Observable<PartnerClaimPreview> {
    return this.http.post<PartnerClaimPreview>('/api/integrations/partner/claim', { code });
  }

  /** Acte explicite : active le partage sur les catégories cochées. */
  approve(code: string, scopes: string[]): Observable<{ linkId: string; scopes: string[] }> {
    return this.http.post<{ linkId: string; scopes: string[] }>(
      '/api/integrations/partner/approve',
      { code, scopes },
    );
  }

  /** L'interrupteur vivant : allume ou éteint UNE catégorie, à tout moment. */
  setScope(scope: string, enabled: boolean): Observable<{ scopes: string[]; changed: boolean }> {
    return this.http.patch<{ scopes: string[]; changed: boolean }>(
      '/api/integrations/partner/scopes',
      { scope, enabled },
    );
  }

  revoke(reason: string): Observable<{ status: string; tokensRevoked: number }> {
    return this.http.request<{ status: string; tokensRevoked: number }>(
      'delete',
      '/api/integrations/partner',
      { body: { reason } },
    );
  }
}
