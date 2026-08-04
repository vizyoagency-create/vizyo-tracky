import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

/** Un document servi par le wiki (référentiel, procédure, rapport d'audit, collecteur SQL). */
export interface WikiDocumentMeta {
  slug: string;
  title: string;
  description: string | null;
  section: string;
  order: number;
  format: 'markdown' | 'sql';
  sizeBytes: number;
  updatedAt: string;
}

export interface WikiSection {
  key: string;
  label: string;
  description: string | null;
  documents: WikiDocumentMeta[];
}

/**
 * Un passage d'audit — « ce qui a été fait ». Tenu à la main dans `app/wiki.json` par
 * l'agent d'audit : contrairement aux documents, ça ne se devine pas du disque.
 */
export interface WikiPassage {
  date: string;
  origine?: string;
  rapport?: string;
  verdict?: string;
  chiffres?: Record<string, number>;
  fiches?: { nouvelles?: number; misesAJour?: number };
  aTraiter?: string[];
  note?: string;
}

/** Le barème des statuts vit dans le manifeste, pas dans le code de l'écran. */
export interface WikiStatut {
  cle: string;
  libelle: string;
  puce: string;
  ordre: number;
  aide?: string;
}

/**
 * L'état d'une famille d'erreur, sous forme exploitable : **quand** on l'a vue,
 * **quoi** c'est, et **quoi faire**. C'est la partie du référentiel qu'on veut lire d'un
 * coup d'œil, sans dérouler la prose de la fiche.
 */
export interface WikiFiche {
  id: string;
  titre: string;
  source: string;
  statut: string;
  gravite: number;
  vuPremiere?: string;
  vuDerniere?: string;
  occurrences?: number;
  occurrencesLibelle?: string;
  quoi: string;
  quoiFaire: string;
  pourquoiInvisible?: string;
  aNePasFaire?: string;
  seuilReescalade?: string;
  doc?: string;
  ancre?: string;
}

export interface WikiIndex {
  available: boolean;
  title: string;
  intro: string | null;
  updatedAt: string | null;
  sections: WikiSection[];
  fiches: WikiFiche[];
  statuts: WikiStatut[];
  passages: WikiPassage[];
  documentCount: number;
}

export interface WikiDocument {
  slug: string;
  title: string;
  format: 'markdown' | 'sql';
  updatedAt: string;
  content: string;
  truncated: boolean;
}

/**
 * Documentation du centre d'alerte (`docs/centre-alerte/`), servie en lecture par l'API.
 *
 * Le `slug` voyage en QUERY et non dans le chemin : il contient un `/`
 * (`rapports/2026-08-03.md`) qu'un segment de route couperait.
 */
@Injectable({ providedIn: 'root' })
export class CentreAlerteWikiService {
  private readonly http = inject(HttpClient);

  index() {
    return this.http.get<WikiIndex>('/api/admin/alerts/wiki');
  }

  document(slug: string) {
    return this.http.get<WikiDocument>('/api/admin/alerts/wiki/doc', { params: { slug } });
  }
}
