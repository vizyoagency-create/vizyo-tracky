import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AbonnementCreneauDto,
  CancelInstallationBookingDto,
  ConfirmInstallationBookingDto,
  CreateInstallationBookingLinkDto,
  CreatePublicBookingDto,
  DeleteLinkConsequencesDto,
  DeleteLinkMode,
  EnregistrerEvenementVisiteDto,
  InstallationBookingDto,
  InstallationBookingLinkDto,
  InstallationBookingLinkVisitsDto,
  InstallationBookingStatus,
  PublicBookingLinkDto,
  PublicBookingResultDto,
  RejectInstallationBookingDto,
  UpdateInstallationBookingLinkDto,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';
import { QUIET_ERRORS_HEADER } from '../interceptors/auth.interceptor';

/**
 * Prise de RDV en ligne — client HTTP (admin + public). Les endpoints publics
 * (`/api/public/booking/*`) n'exigent pas d'auth ; l'intercepteur ajoute un bearer
 * s'il existe mais le backend l'ignore.
 */
@Injectable({ providedIn: 'root' })
export class InstallationBookingApiService {
  private readonly http = inject(HttpClient);

  // ── Admin (SUPER_ADMIN) ── base `installation-bookings` (évite la collision avec /installations/:id)
  listLinks(): Observable<InstallationBookingLinkDto[]> {
    return this.http.get<InstallationBookingLinkDto[]>('/api/installation-bookings/links');
  }
  createLink(dto: CreateInstallationBookingLinkDto): Observable<InstallationBookingLinkDto> {
    return this.http.post<InstallationBookingLinkDto>('/api/installation-bookings/links', dto);
  }
  updateLink(id: string, dto: UpdateInstallationBookingLinkDto): Observable<InstallationBookingLinkDto> {
    return this.http.patch<InstallationBookingLinkDto>(`/api/installation-bookings/links/${id}`, dto);
  }
  /**
   * Supprimer un lien (Q8). Sans `mode` alors qu'il porte des demandes, l'API répond 409 avec
   * `consequences` : l'écran demande alors « conserver » ou « effacer » et rappelle avec le mode.
   */
  deleteLink(id: string, mode?: DeleteLinkMode): Observable<void> {
    const params: Record<string, string> = mode ? { demandes: mode } : {};
    return this.http.delete<void>(`/api/installation-bookings/links/${id}`, { params });
  }
  consequencesSuppression(id: string): Observable<DeleteLinkConsequencesDto> {
    return this.http.get<DeleteLinkConsequencesDto>(`/api/installation-bookings/links/${id}/consequences-suppression`);
  }
  /** Les visites de la page publique d'un lien : qui, quand, depuis quoi, et la suite. */
  listVisites(linkId: string): Observable<InstallationBookingLinkVisitsDto> {
    return this.http.get<InstallationBookingLinkVisitsDto>(`/api/installation-bookings/links/${linkId}/visites`);
  }
  listBookings(filters?: { status?: InstallationBookingStatus; from?: string; to?: string }): Observable<InstallationBookingDto[]> {
    const params: Record<string, string> = {};
    if (filters?.status) params['status'] = filters.status;
    if (filters?.from) params['from'] = filters.from;
    if (filters?.to) params['to'] = filters.to;
    return this.http.get<InstallationBookingDto[]>('/api/installation-bookings', { params });
  }
  /**
   * Silencieux côté intercepteur (`QUIET_ERRORS_HEADER`) : un 503 « Manager non configuré » est
   * une réponse métier que l'écran affiche lui-même — le toast générique ferait doublon.
   */
  confirmBooking(id: string, dto: ConfirmInstallationBookingDto): Observable<InstallationBookingDto> {
    return this.http.post<InstallationBookingDto>(`/api/installation-bookings/${id}/confirm`, dto, { headers: { [QUIET_ERRORS_HEADER]: '1' } });
  }
  rejectBooking(id: string, dto: RejectInstallationBookingDto): Observable<InstallationBookingDto> {
    return this.http.post<InstallationBookingDto>(`/api/installation-bookings/${id}/reject`, dto);
  }
  /** Annuler une demande (en attente ou confirmée) : ses poses non faites sont retirées. */
  cancelBooking(id: string, dto: CancelInstallationBookingDto): Observable<InstallationBookingDto> {
    return this.http.post<InstallationBookingDto>(`/api/installation-bookings/${id}/cancel`, dto);
  }

  // ── Public (page /book/:token, hors auth) ──
  /**
   * `visiteId` : la visite déjà ouverte, pour qu'un rechargement ne compte pas pour une nouvelle.
   * `provenance` : `document.referrer` — d'où le client est arrivé (Gmail, WhatsApp, rien pour
   * un SMS). Envoyé EXPLICITEMENT parce que l'en-tête `Referer` de cet appel, c'est nous.
   */
  getPublicLink(token: string, visiteId?: string | null, provenance?: string, vehicules?: number): Observable<PublicBookingLinkDto> {
    const params: Record<string, string> = {};
    if (visiteId) params['visite'] = visiteId;
    if (provenance !== undefined) params['ref'] = provenance.slice(0, 500);
    // La grille dépend du nombre de véhicules (créneaux de n × 2 h).
    if (vehicules && vehicules > 1) params['vehicules'] = String(vehicules);
    return this.http.get<PublicBookingLinkDto>(`/api/public/booking/${encodeURIComponent(token)}`, { params });
  }
  book(token: string, dto: CreatePublicBookingDto): Observable<PublicBookingResultDto> {
    return this.http.post<PublicBookingResultDto>(`/api/public/booking/${encodeURIComponent(token)}`, dto);
  }
  /** « Prévenez-moi si un créneau se libère ». */
  prevenirMoi(token: string, dto: AbonnementCreneauDto): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`/api/public/booking/${encodeURIComponent(token)}/prevenir-moi`, dto);
  }
  /** Un geste de la page, ajouté à la chronologie de la visite (best-effort côté appelant). */
  evenement(token: string, visiteId: string, dto: EnregistrerEvenementVisiteDto): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(
      `/api/public/booking/${encodeURIComponent(token)}/visites/${encodeURIComponent(visiteId)}/evenements`,
      dto,
    );
  }
}
