import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AssistanceAdminDetailDto,
  AssistanceAdminListItemDto,
  AssistanceConversationDto,
  AssistanceListItemDto,
  ReviewAssistanceDto,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Assistance IA (2026-08) — client HTTP.
 *
 * Deux surfaces distinctes, comme côté serveur : ce qu'un utilisateur voit de SA conversation, et
 * ce qu'un administrateur voit de l'archive. Le cloisonnement est appliqué par le serveur ; ce
 * service ne fait que l'appeler — aucun filtrage ici, qui donnerait l'illusion d'une garde.
 */
@Injectable({ providedIn: 'root' })
export class AssistanceApiService {
  private readonly http = inject(HttpClient);

  /** L'assistance est-elle utilisable ? Sert à ne pas proposer un chat mort. */
  disponible(): Observable<{ disponible: boolean }> {
    return this.http.get<{ disponible: boolean }>('/api/assistance/disponible');
  }

  /** Poser une question. Sans `conversationId`, une conversation est ouverte. */
  ask(message: string, conversationId?: string): Observable<AssistanceConversationDto> {
    return this.http.post<AssistanceConversationDto>('/api/assistance/ask', { message, conversationId });
  }

  mesConversations(): Observable<AssistanceListItemDto[]> {
    return this.http.get<AssistanceListItemDto[]>('/api/assistance/conversations');
  }

  conversation(id: string): Observable<AssistanceConversationDto> {
    return this.http.get<AssistanceConversationDto>(`/api/assistance/conversations/${encodeURIComponent(id)}`);
  }

  /** Demander un rappel humain — ne consomme aucun appel IA. */
  rappel(id: string, motif?: string): Observable<AssistanceConversationDto> {
    return this.http.post<AssistanceConversationDto>(
      `/api/assistance/conversations/${encodeURIComponent(id)}/rappel`,
      { motif },
    );
  }

  // ─── Archive (admin) ───────────────────────────────────────────────────────

  adminListe(statut?: string): Observable<AssistanceAdminListItemDto[]> {
    return this.http.get<AssistanceAdminListItemDto[]>('/api/assistance/admin/conversations', {
      params: statut ? { statut } : {},
    });
  }

  adminDetail(id: string): Observable<AssistanceAdminDetailDto> {
    return this.http.get<AssistanceAdminDetailDto>(
      `/api/assistance/admin/conversations/${encodeURIComponent(id)}`,
    );
  }

  /** Marquer relue + consigner la correction à retenir. */
  relire(id: string, dto: ReviewAssistanceDto): Observable<AssistanceAdminDetailDto> {
    return this.http.post<AssistanceAdminDetailDto>(
      `/api/assistance/admin/conversations/${encodeURIComponent(id)}/review`,
      dto,
    );
  }

  /** Réponse d'un conseiller humain, insérée dans le fil que l'utilisateur voit. */
  repondre(id: string, message: string): Observable<AssistanceAdminDetailDto> {
    return this.http.post<AssistanceAdminDetailDto>(
      `/api/assistance/admin/conversations/${encodeURIComponent(id)}/reply`,
      { message },
    );
  }
}
