import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  TripShareCreatedDto,
  TripShareDurationDto,
  TripShareLinkAvecTrajetDto,
  TripShareLinkDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARTAGE PUBLIC D'UN TRAJET — CÔTÉ ÉCRAN
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le bouton « Partager » du replay copiait l'URL INTERNE de l'application
 * (`/reports?from=…&to=…&trip=…`). Envoyée au conducteur concerné — qui n'a pas de compte —
 * elle affichait un écran de connexion. L'application annonçait pourtant « Lien copié ».
 *
 * ⚠️ CRÉER UN LIEN EST UN APPEL RÉSEAU, PAS UNE CONCATÉNATION DE CHAÎNES. C'est ce qui change
 * tout : le serveur tire un token imprévisible, pose une échéance, et INSCRIT le lien quelque
 * part où on pourra le retrouver et le couper. Un lien qu'on fabrique côté navigateur ne
 * s'inscrit nulle part — c'est exactement l'accès fantôme qu'on ne veut pas.
 */
@Injectable({ providedIn: 'root' })
export class TripShareApiService {
  private readonly http = inject(HttpClient);

  /** Crée un lien public. Le token n'est renvoyé QU'ICI. */
  creer(tripId: string, duration: TripShareDurationDto): Promise<TripShareCreatedDto> {
    return firstValueFrom(
      this.http.post<TripShareCreatedDto>(`/api/trips/${tripId}/share`, { duration }),
    );
  }

  /** Les liens d'UN trajet — pour savoir si celui qu'on regarde est déjà partagé. */
  listerPourTrajet(tripId: string): Promise<TripShareLinkDto[]> {
    return firstValueFrom(this.http.get<TripShareLinkDto[]>(`/api/trips/${tripId}/shares`));
  }

  /**
   * TOUS les liens de la société — l'écran de surveillance.
   *
   * ⚠️ `fleetId` EST OBLIGATOIRE POUR UN SUPER-ADMIN. Sans société désignée, il n'en a pas de
   * courante : servir « tous les liens de tous les clients » mélangerait les sociétés sur un
   * écran dont l'objet est précisément de savoir qui a ouvert quoi.
   */
  listerPourSociete(fleetId: string | null): Promise<TripShareLinkAvecTrajetDto[]> {
    // `params` typé : un objet vide littéral fait choisir à TypeScript la surcharge qui rend
    // un ArrayBuffer, et l'erreur ne parle alors ni de partage ni de société.
    const params: Record<string, string> = fleetId ? { fleetId } : {};
    return firstValueFrom(
      this.http.get<TripShareLinkAvecTrajetDto[]>('/api/trips/shares/all', { params }),
    );
  }

  /** Révocation immédiate : le lien cesse de fonctionner à la requête suivante. */
  revoquer(shareId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/trips/shares/${shareId}`));
  }
}
