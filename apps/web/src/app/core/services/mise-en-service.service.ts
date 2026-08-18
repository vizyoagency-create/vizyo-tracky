import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';

/**
 * Mise en service d'un boîtier. DTO définis localement, comme pour les zones mortes :
 * c'est la convention du projet pour les contrats propres à un écran.
 */
export type VoieOnboarding =
  | 'deja_rattache'
  | 'rattacher_maintenant'
  | 'attente_tcp'
  | 'provisioning_sms'
  | 'sim_a_activer'
  | 'inconnu';

export interface ResolutionIdentifiantDto {
  candidats: { type: 'imei' | 'iccid' | 'msisdn'; valeur: string }[];
  imei: string | null;
  iccid: string | null;
  msisdn: string | null;
  simStatutId: number | null;
  simStatutLibelle: string | null;
  trackerId: string | null;
  vehiculePlaque: string | null;
  flotteNom: string | null;
  frappeEnTcp: boolean;
  vuIlYaSecondes: number | null;
  voie: VoieOnboarding;
  message: string;
}

export interface RattachementDto {
  trackerId: string;
  imei: string;
  cree: boolean;
  vehiculePlaque: string;
  connecteDejaVu: boolean;
}

export interface EtatAttenteDto {
  connecte: boolean;
  /** Le boîtier frappe encore en inconnu : l'IMEI déclaré n'est pas le sien. */
  encoreInconnu: boolean;
  derniereVueIso: string | null;
  positions: number;
  statut: string;
}

export interface EtatVerrouDto {
  libre: boolean;
  parMoi: boolean;
  detenteurNom: string | null;
  detenteurEmail: string | null;
  contexte: string | null;
  depuisSecondes: number | null;
  expireDansSecondes: number | null;
}

@Injectable({ providedIn: 'root' })
export class MiseEnServiceApi {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/tracker-onboarding';

  /** Que vaut ce code ? Sert au scan ET à la saisie manuelle — même chemin. */
  resoudre(code: string): Observable<ResolutionIdentifiantDto> {
    return this.http.get<ResolutionIdentifiantDto>(`${this.base}/resoudre`, { params: { code } });
  }

  rattacher(body: { vehicleId: string; imei: string; msisdn: string | null }): Observable<RattachementDto> {
    return this.http.post<RattachementDto>(`${this.base}/rattacher`, body);
  }

  attente(trackerId: string): Observable<EtatAttenteDto> {
    return this.http.get<EtatAttenteDto>(`${this.base}/attente`, { params: { trackerId } });
  }

  /** Prend le verrou OU le rafraîchit : c'est le même appel, à dessein. */
  prendreVerrou(contexte: string | null): Observable<EtatVerrouDto> {
    return this.http.post<EtatVerrouDto>(`${this.base}/verrou`, { contexte });
  }

  rendreVerrou(): Observable<EtatVerrouDto> {
    return this.http.delete<EtatVerrouDto>(`${this.base}/verrou`);
  }

  forcerVerrou(): Observable<EtatVerrouDto> {
    return this.http.delete<EtatVerrouDto>(`${this.base}/verrou`, { params: { force: '1' } });
  }
}
