import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import type {
  DepotDocumentsDto,
  DepotExportFormat,
  DepotExportPreviewDto,
  DepotHistoryDto,
  DepotIncidentDto,
  DepotIncidentReason,
  DepotLiveDto,
  DepotTripDto,
  MissionShareCreatedDto,
  MissionShareLinkDto,
  ShareDurationDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';

/**
 * Espace dépôt (2026-08) — le seul point de contact avec l'API `/depot`.
 *
 * ┌─ UN SERVICE, ET AUCUN AUTRE ──────────────────────────────────────────────┐
 * │ Les écrans du dépôt n'appellent JAMAIS `/api/vehicles`, `/api/trips`,      │
 * │ `/api/positions` ni aucune route de la flotte : ils répondraient `403`,    │
 * │ et un écran qui déclenche des 403 légitimes en continu rend illisibles les │
 * │ refus réels dans les journaux — ceux par lesquels on prouve l'isolation.   │
 * │                                                                            │
 * │ Concentrer les appels ici rend cette règle VÉRIFIABLE : il suffit de lire  │
 * │ ce fichier pour connaître l'intégralité de la surface réseau du dépôt.     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ UNE SEULE EXCEPTION, NOMMÉE ICI POUR QUE LA RÈGLE RESTE VÉRIFIABLE : lot A6,
 * `/api/mission-requests`, servi par `MissionRequestsApi` (core/services). Ce n'est pas
 * une route de la flotte empruntée par commodité — c'est le seul contrôleur ouvert AUX
 * DEUX camps par construction, borné à `depotUserId = user.id` à chaque requête. Il
 * vit hors de ce fichier parce que le transporteur l'appelle aussi, et qu'un fil de
 * négociation lu différemment de chaque côté ne serait pas un fil.
 *
 * La surface réseau du dépôt se lit donc dans DEUX fichiers, et seulement deux.
 */
@Injectable({ providedIn: 'root' })
export class DepotApiService {
  private readonly http = inject(HttpClient);

  /**
   * Vrai quand la dernière lecture a échoué en 401/403.
   *
   * « Votre accès a été retiré par votre transporteur » (A3 § 6) : un dépôt dont le
   * compte est désactivé ne doit pas voir une page qui charge indéfiniment. On expose
   * l'état plutôt qu'un `throw` que chaque écran retraduirait à sa façon.
   */
  readonly accesRetire = signal(false);

  live(): Promise<DepotLiveDto> {
    return this.lire<DepotLiveDto>('/api/depot/live');
  }

  history(filtres: { from?: string; to?: string; plate?: string; destination?: string } = {}): Promise<DepotHistoryDto> {
    const params = new URLSearchParams();
    for (const [clef, valeur] of Object.entries(filtres)) {
      if (valeur) params.set(clef, valeur);
    }
    const q = params.toString();
    return this.lire<DepotHistoryDto>(`/api/depot/history${q ? `?${q}` : ''}`);
  }

  trip(tripId: string): Promise<DepotTripDto> {
    return this.lire<DepotTripDto>(`/api/depot/trips/${tripId}`);
  }

  /** Depuis la carte live, on ne connaît que la mission : `Trip.missionId` n'est
   *  rattaché qu'à la clôture. Cf. `DepotTripService.tripDeMission`. */
  tripDeMission(missionId: string): Promise<DepotTripDto> {
    return this.lire<DepotTripDto>(`/api/depot/missions/${missionId}/trip`);
  }

  documents(): Promise<DepotDocumentsDto> {
    return this.lire<DepotDocumentsDto>('/api/depot/documents');
  }

  setRapportHebdo(actif: boolean): Promise<{ weeklyReportEnabled: boolean }> {
    return firstValueFrom(
      this.http.patch<{ weeklyReportEnabled: boolean }>('/api/depot/documents/settings', {
        weeklyReportEnabled: actif,
      }),
    );
  }

  apercuExport(from: string, to: string, format: DepotExportFormat): Promise<DepotExportPreviewDto> {
    return firstValueFrom(
      this.http.post<DepotExportPreviewDto>('/api/depot/exports/preview', { from, to, format }),
    );
  }

  /** Le fichier arrive en binaire : c'est l'appelant qui décide d'en faire un
   *  téléchargement, pour pouvoir afficher son état de chargement pendant l'attente. */
  export(from: string, to: string, format: DepotExportFormat): Promise<Blob> {
    return firstValueFrom(
      this.http.post('/api/depot/exports', { from, to, format }, { responseType: 'blob' }),
    );
  }

  bonDeLivraison(documentId: string): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`/api/depot/documents/${encodeURIComponent(documentId)}/download`, {
        responseType: 'blob',
      }),
    );
  }

  signalerIncident(
    missionId: string,
    reason: DepotIncidentReason,
    message: string,
  ): Promise<DepotIncidentDto> {
    return firstValueFrom(
      this.http.post<DepotIncidentDto>('/api/depot/incidents', { missionId, reason, message }),
    );
  }

  // ─── Lot A4 — le partage ────────────────────────────────────────────────────

  /** Crée un lien public. Le token ne transite QU'ICI : la liste ne le renvoie pas. */
  creerPartage(missionId: string, duration: ShareDurationDto): Promise<MissionShareCreatedDto> {
    return firstValueFrom(
      this.http.post<MissionShareCreatedDto>(`/api/depot/missions/${missionId}/share`, { duration }),
    );
  }

  /** Les liens d'une mission et leur usage — pour révoquer en connaissance de cause. */
  partages(missionId: string): Promise<MissionShareLinkDto[]> {
    return this.lire<MissionShareLinkDto[]>(`/api/depot/missions/${missionId}/shares`);
  }

  revoquerPartage(lienId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/depot/shares/${lienId}`));
  }

  /**
   * Le numéro COMPLET du conducteur, pour déclencher un appel.
   *
   * Le DTO ne porte qu'un numéro masqué (« 06 12 •• •• 47 ») : le numéro entier ne
   * transite que par cet appel, et le serveur journalise chaque passage. Un masquage
   * côté template aurait laissé le numéro complet visible dans l'onglet réseau —
   * c'est-à-dire strictement équivalent à ne rien masquer.
   */
  numeroConducteur(missionId: string): Promise<{ phone: string }> {
    return firstValueFrom(
      this.http.post<{ phone: string }>(`/api/depot/missions/${missionId}/call`, {}),
    );
  }

  private async lire<T>(url: string): Promise<T> {
    try {
      const reponse = await firstValueFrom(this.http.get<T>(url));
      this.accesRetire.set(false);
      return reponse;
    } catch (err) {
      const statut = (err as { status?: number })?.status;
      // 401 = session morte ; 403 = compte encore valide mais périmètre vidé (accès
      // retiré). Les deux mènent au même écran : on ne laisse pas un dépôt devant une
      // page qui charge sans fin, sans savoir que son accès a changé.
      if (statut === 401 || statut === 403) this.accesRetire.set(true);
      throw err;
    }
  }
}
