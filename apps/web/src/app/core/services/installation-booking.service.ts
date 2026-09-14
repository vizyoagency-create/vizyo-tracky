import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AbonnementCreneauDto,
  ConfirmInstallationBookingDto,
  CreateInstallationBookingLinkDto,
  CreatePublicBookingDto,
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
  deleteLink(id: string): Observable<void> {
    return this.http.delete<void>(`/api/installation-bookings/links/${id}`);
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
  confirmBooking(id: string, dto: ConfirmInstallationBookingDto): Observable<InstallationBookingDto> {
    return this.http.post<InstallationBookingDto>(`/api/installation-bookings/${id}/confirm`, dto);
  }
  rejectBooking(id: string, dto: RejectInstallationBookingDto): Observable<InstallationBookingDto> {
    return this.http.post<InstallationBookingDto>(`/api/installation-bookings/${id}/reject`, dto);
  }

  // ── Public (page /book/:token, hors auth) ──
  /**
   * `visiteId` : la visite déjà ouverte, pour qu'un rechargement ne compte pas pour une nouvelle.
   * `provenance` : `document.referrer` — d'où le client est arrivé (Gmail, WhatsApp, rien pour
   * un SMS). Envoyé EXPLICITEMENT parce que l'en-tête `Referer` de cet appel, c'est nous.
   */
  getPublicLink(token: string, visiteId?: string | null, provenance?: string): Observable<PublicBookingLinkDto> {
    const params: Record<string, string> = {};
    if (visiteId) params['visite'] = visiteId;
    if (provenance !== undefined) params['ref'] = provenance.slice(0, 500);
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
