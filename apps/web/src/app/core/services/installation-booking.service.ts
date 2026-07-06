import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ConfirmInstallationBookingDto,
  CreateInstallationBookingLinkDto,
  CreatePublicBookingDto,
  InstallationBookingDto,
  InstallationBookingLinkDto,
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

  // ── Admin (SUPER_ADMIN) ──
  listLinks(): Observable<InstallationBookingLinkDto[]> {
    return this.http.get<InstallationBookingLinkDto[]>('/api/installations/booking-links');
  }
  createLink(dto: CreateInstallationBookingLinkDto): Observable<InstallationBookingLinkDto> {
    return this.http.post<InstallationBookingLinkDto>('/api/installations/booking-links', dto);
  }
  updateLink(id: string, dto: UpdateInstallationBookingLinkDto): Observable<InstallationBookingLinkDto> {
    return this.http.patch<InstallationBookingLinkDto>(`/api/installations/booking-links/${id}`, dto);
  }
  deleteLink(id: string): Observable<void> {
    return this.http.delete<void>(`/api/installations/booking-links/${id}`);
  }
  listBookings(filters?: { status?: InstallationBookingStatus; from?: string; to?: string }): Observable<InstallationBookingDto[]> {
    const params: Record<string, string> = {};
    if (filters?.status) params['status'] = filters.status;
    if (filters?.from) params['from'] = filters.from;
    if (filters?.to) params['to'] = filters.to;
    return this.http.get<InstallationBookingDto[]>('/api/installations/bookings', { params });
  }
  confirmBooking(id: string, dto: ConfirmInstallationBookingDto): Observable<InstallationBookingDto> {
    return this.http.post<InstallationBookingDto>(`/api/installations/bookings/${id}/confirm`, dto);
  }
  rejectBooking(id: string, dto: RejectInstallationBookingDto): Observable<InstallationBookingDto> {
    return this.http.post<InstallationBookingDto>(`/api/installations/bookings/${id}/reject`, dto);
  }

  // ── Public (page /book/:token, hors auth) ──
  getPublicLink(token: string): Observable<PublicBookingLinkDto> {
    return this.http.get<PublicBookingLinkDto>(`/api/public/booking/${encodeURIComponent(token)}`);
  }
  book(token: string, dto: CreatePublicBookingDto): Observable<PublicBookingResultDto> {
    return this.http.post<PublicBookingResultDto>(`/api/public/booking/${encodeURIComponent(token)}`, dto);
  }
}
