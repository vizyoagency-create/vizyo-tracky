import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  CreateReservationBookingLinkDto,
  ParsedNeedDto,
  PublicReservationLinkDto,
  ReservationBookingLinkDto,
  SubmitPublicReservationDto,
  SubmitPublicReservationResultDto,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Refonte agenda/IA (2026-07, P4) — Client HTTP du lien public de réservation.
 * Endpoints PUBLICS (`/api/public/reserve/*`, hors auth) pour la page tierce + endpoints ADMIN
 * (`/api/reservation-booking-links`, super/fleet admin) pour gérer les liens.
 */
@Injectable({ providedIn: 'root' })
export class ReservationBookingApiService {
  private readonly http = inject(HttpClient);

  // ── Public (hors auth) ──
  getPublicLink(token: string): Observable<PublicReservationLinkDto> {
    return this.http.get<PublicReservationLinkDto>(`/api/public/reserve/${encodeURIComponent(token)}`);
  }
  /** Analyse IA rapide d'un besoin dicté (voix → texte) → champs du formulaire. */
  parse(token: string, text: string): Observable<ParsedNeedDto> {
    return this.http.post<ParsedNeedDto>(`/api/public/reserve/${encodeURIComponent(token)}/parse`, { text });
  }

  submit(token: string, body: SubmitPublicReservationDto): Observable<SubmitPublicReservationResultDto> {
    return this.http.post<SubmitPublicReservationResultDto>(`/api/public/reserve/${encodeURIComponent(token)}/submit`, body);
  }

  // ── Admin ──
  listLinks(fleetId?: string): Observable<ReservationBookingLinkDto[]> {
    return this.http.get<ReservationBookingLinkDto[]>('/api/reservation-booking-links', {
      params: fleetId ? { fleetId } : {},
    });
  }
  createLink(body: CreateReservationBookingLinkDto): Observable<ReservationBookingLinkDto> {
    return this.http.post<ReservationBookingLinkDto>('/api/reservation-booking-links', body);
  }
  setActive(id: string, active: boolean): Observable<ReservationBookingLinkDto> {
    return this.http.patch<ReservationBookingLinkDto>(`/api/reservation-booking-links/${id}`, { active });
  }
}
