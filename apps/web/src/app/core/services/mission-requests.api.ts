import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { GrilleTarifaire } from '../../features/depot/devis-tarifaire';

/**
 * Espace dépôt, lot A6 — les demandes de mission et leur négociation.
 * Cf. docs/A6-DEMANDES-ET-DEVIS.md.
 *
 * ┌─ UN SEUL CLIENT POUR LES DEUX CAMPS, ET C'EST LE POINT ───────────────────┐
 * │ `/api/mission-requests` est le SEUL contrôleur que le dépôt et le          │
 * │ transporteur atteignent tous les deux. Le service borne chacun à son       │
 * │ périmètre — un dépôt ne voit que ses demandes, un transporteur que celles  │
 * │ de sa société — et l'écran, lui, est le MÊME.                              │
 * │                                                                            │
 * │ Deux clients auraient divergé à la première retouche : le dépôt aurait lu  │
 * │ un montant formaté d'une façon, le transporteur d'une autre, pour la même  │
 * │ ligne du même fil. Une négociation où les deux parties ne lisent pas la     │
 * │ même chose n'est pas une négociation.                                       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ SEULE SURFACE RÉSEAU DU DÉPÔT HORS `/api/depot/*`. `DepotApiService` porte le
 * reste et documente la règle ; ces routes-ci sont ouvertes au rôle DEPOT par
 * construction (cf. `MissionRequestsController` et son `DepotScopeBorneParLeService`).
 */

export type StatutDemande =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'NEGOTIATING'
  | 'ACCEPTED'
  | 'CONVERTED'
  | 'REJECTED'
  | 'EXPIRED';

/** Qui a écrit un tour. `SYSTEM` = le devis automatique du tour 0. */
export type AuteurTour = 'SYSTEM' | 'DEPOT' | 'CARRIER';

/** De quel côté de la table se trouve celui qui regarde. */
export type Camp = 'DEPOT' | 'CARRIER';

export interface ArretDemande {
  position: number;
  kind: string;
  label: string;
  wantedAt: string | null;
  note: string | null;
}

/** Le détail figé d'un devis, tel que le serveur l'a écrit dans le tour. */
export interface DetailDevis {
  statut: 'TARIF' | 'SUR_DEVIS' | 'PAS_DE_GRILLE';
  trancheLibelle?: string;
  distanceKm?: number;
  htCents?: number;
  tvaCents?: number;
  ttcCents?: number;
  motif?: string | null;
  lignes?: Array<{ libelle: string; montantCents: number }>;
}

export interface TourDemande {
  position: number;
  author: AuteurTour;
  /** `null` = « je ne chiffre pas » — un « sur devis », jamais un zéro. */
  amountCents: number | null;
  breakdown: DetailDevis | null;
  message: string | null;
  createdAt: string;
}

export interface Demande {
  id: string;
  ref: string;
  status: StatutDemande;
  wantedStartAt: string;
  wantedEndAt: string;
  goodsDescription: string | null;
  weightKg: number | null;
  declaredDistanceKm: number | null;
  usedDistanceKm: number | null;
  /** Le montant COURANT est celui du dernier tour, jamais un champ tenu à part. */
  currentAmountCents: number | null;
  agreedAmountCents: number | null;
  quoteExpiresAt: string | null;
  rejectedReason: string | null;
  missionId: string | null;
  createdAt: string;
  /** Qui doit répondre : l'autre camp que l'auteur du dernier tour. */
  awaiting: Camp | null;
  depot: { id: string; nom: string } | null;
  stops: ArretDemande[];
  rounds: TourDemande[];
}

/** Ce qu'un tour propose. Conditions absentes = on reprend celles en cours. */
export interface TourEntree {
  /** En CENTIMES. `null` = « sur devis ». Absent = on reprend le tarif calculé. */
  amountCents?: number | null;
  message?: string | null;
  stops?: Array<{ label: string }>;
  wantedStartAt?: string;
  wantedEndAt?: string;
  usedDistanceKm?: number | null;
}

export interface DemandeEntree {
  stops: Array<{ label: string }>;
  wantedStartAt: string;
  wantedEndAt: string;
  goodsDescription?: string | null;
  weightKg?: number | null;
  declaredDistanceKm?: number | null;
  message?: string | null;
}

@Injectable({ providedIn: 'root' })
export class MissionRequestsApi {
  private readonly http = inject(HttpClient);

  /**
   * La grille applicable, pour l'aperçu de devis pendant la saisie.
   *
   * `null` = aucune grille publiée : un état NORMAL que l'écran traduit, pas une panne.
   */
  grille(): Promise<GrilleTarifaire | null> {
    return firstValueFrom(this.http.get<GrilleTarifaire | null>('/api/mission-requests/pricing'));
  }

  /**
   * La liste. Le SERVEUR décide de ce qu'on voit : un dépôt n'obtient que les siennes,
   * un transporteur celles de sa société. Aucun filtre côté client ne remplace ça.
   */
  lister(fleetId?: string, statut?: StatutDemande): Promise<Demande[]> {
    const params = new URLSearchParams();
    if (fleetId) params.set('fleetId', fleetId);
    if (statut) params.set('status', statut);
    const q = params.toString();
    return firstValueFrom(this.http.get<Demande[]>(`/api/mission-requests${q ? `?${q}` : ''}`));
  }

  detail(id: string): Promise<Demande> {
    return firstValueFrom(this.http.get<Demande>(`/api/mission-requests/${id}`));
  }

  creer(entree: DemandeEntree): Promise<Demande> {
    return firstValueFrom(this.http.post<Demande>('/api/mission-requests', entree));
  }

  /** Un tour de plus. Le prix ET les conditions peuvent changer (arbitrage I). */
  contreProposer(id: string, entree: TourEntree): Promise<Demande> {
    return firstValueFrom(this.http.post<Demande>(`/api/mission-requests/${id}/counter`, entree));
  }

  /** Accepter le dernier tour. Le serveur refuse qu'on accepte le sien. */
  accepter(id: string): Promise<Demande> {
    return firstValueFrom(this.http.post<Demande>(`/api/mission-requests/${id}/accept`, {}));
  }

  /** Refuser, motif OBLIGATOIRE : sans lui, l'autre partie repose la même demande. */
  refuser(id: string, reason: string): Promise<Demande> {
    return firstValueFrom(this.http.post<Demande>(`/api/mission-requests/${id}/reject`, { reason }));
  }

  /**
   * Affecter un camion : la demande DEVIENT une mission.
   *
   * Réservé au transporteur — c'est son parc qu'il engage. Le serveur le revérifie.
   */
  affecter(
    id: string,
    entree: { vehicleId: string; driverId?: string | null; notes?: string | null },
  ): Promise<{ mission: { id: string; ref: string }; avertissements: string[]; request: Demande }> {
    return firstValueFrom(
      this.http.post<{ mission: { id: string; ref: string }; avertissements: string[]; request: Demande }>(
        `/api/mission-requests/${id}/assign`,
        entree,
      ),
    );
  }
}

// ═══ OUTILS PARTAGÉS PAR LES DEUX ÉCRANS ═══════════════════════════════════════

/**
 * Une demande est-elle encore NÉGOCIABLE ?
 *
 * ⚠️ C'est la question qui commande l'accès des deux parties au fil, et elle a une
 * seule bonne réponse : tant que les deux camps n'ont pas validé. `ACCEPTED` en est
 * donc EXCLU — l'accord est conclu, il ne se rediscute plus ; il reste consultable,
 * mais plus modifiable. Laisser contre-proposer sur un accord permettrait à une partie
 * de revenir sur un montant que l'autre a déjà accepté.
 */
export function estNegociable(d: Demande): boolean {
  return d.status === 'SUBMITTED' || d.status === 'NEGOTIATING';
}

/**
 * Le camp a-t-il la main ? Il l'a quand la demande se négocie ET que le dernier tour
 * vient de l'AUTRE. On ne répond pas à soi-même : le serveur le refuse, l'écran ne doit
 * donc pas le proposer.
 */
export function aLaMain(d: Demande, camp: Camp): boolean {
  return estNegociable(d) && d.awaiting === camp;
}

/** Centimes → « 79,00 € ». Le même formatage des deux côtés de la table. */
export function montantEuros(cents: number | null): string {
  if (cents === null) return 'Sur devis';
  return `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

const LIBELLES_STATUT: Record<StatutDemande, string> = {
  DRAFT: 'Brouillon',
  SUBMITTED: 'Envoyée',
  NEGOTIATING: 'En négociation',
  ACCEPTED: 'Accord conclu',
  CONVERTED: 'Devenue mission',
  REJECTED: 'Refusée',
  EXPIRED: 'Expirée',
};

export function libelleStatut(s: StatutDemande): string {
  return LIBELLES_STATUT[s] ?? s;
}

/** La teinte d'un statut — succès, attente, alerte, ou neutre. */
export function tonStatut(s: StatutDemande): 'succes' | 'attente' | 'alerte' | 'neutre' {
  if (s === 'ACCEPTED' || s === 'CONVERTED') return 'succes';
  if (s === 'SUBMITTED' || s === 'NEGOTIATING') return 'attente';
  if (s === 'REJECTED' || s === 'EXPIRED') return 'alerte';
  return 'neutre';
}
