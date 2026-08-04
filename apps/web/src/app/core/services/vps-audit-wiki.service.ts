import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

/** Un document servi par le wiki VPS (référentiel, procédure, rapport, collecteur). */
export interface VpsWikiDocumentMeta {
  slug: string;
  title: string;
  description: string | null;
  section: string;
  order: number;
  /** `markdown`, ou le langage du bloc de code (`bash`, `sql`) pour les fichiers bruts. */
  format: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface VpsWikiSection {
  key: string;
  label: string;
  description: string | null;
  documents: VpsWikiDocumentMeta[];
}

/**
 * Un passage d'audit — « ce qui a été observé ce jour-là ». Tenu dans `app/wiki.json` par
 * l'agent : contrairement aux documents, ça ne se devine pas du disque.
 */
export interface VpsWikiPassage {
  date: string;
  origine?: string;
  rapport?: string;
  verdict?: string;
  chiffres?: Record<string, number>;
  constats?: { nouveaux?: number; misAJour?: number; resolus?: number };
  aTraiter?: string[];
  note?: string;
}

/** Le barème des statuts vit dans le manifeste, pas dans le code de l'écran. */
export interface VpsWikiStatut {
  cle: string;
  libelle: string;
  puce: string;
  ordre: number;
  aide?: string;
}

/**
 * L'état d'un constat, sous forme exploitable : **quand** on l'a vu, **quoi** c'est, et
 * **quoi faire**. C'est la partie qu'on veut lire d'un coup d'œil, sans dérouler le rapport.
 *
 * `gain` est propre à l'audit VPS : un constat de machine se juge d'abord à ce qu'il rend
 * (des gigaoctets, de la mémoire, un risque écarté).
 */
export interface VpsWikiConstat {
  id: string;
  titre: string;
  domaine: string;
  statut: string;
  gravite: number;
  vuPremiere?: string;
  vuDerniere?: string;
  mesure?: string;
  gain?: string;
  quoi: string;
  quoiFaire: string;
  pourquoiInvisible?: string;
  aNePasFaire?: string;
  doc?: string;
  ancre?: string;
}

export interface VpsWikiIndex {
  available: boolean;
  title: string;
  intro: string | null;
  updatedAt: string | null;
  sections: VpsWikiSection[];
  /** Les constats, sous la clé `fiches` du manifeste (même socle que le centre d'alerte). */
  fiches: VpsWikiConstat[];
  statuts: VpsWikiStatut[];
  passages: VpsWikiPassage[];
  documentCount: number;
}

export interface VpsWikiDocument {
  slug: string;
  title: string;
  format: string;
  updatedAt: string;
  content: string;
  truncated: boolean;
}

/**
 * Documentation de l'audit VPS (`docs/vps-audit/`), servie en lecture par l'API.
 *
 * Le `slug` voyage en QUERY et non dans le chemin : il contient un `/`
 * (`rapports/2026-08-04.md`) qu'un segment de route couperait.
 */
@Injectable({ providedIn: 'root' })
export class VpsAuditWikiService {
  private readonly http = inject(HttpClient);

  index() {
    return this.http.get<VpsWikiIndex>('/api/admin/vps/wiki');
  }

  document(slug: string) {
    return this.http.get<VpsWikiDocument>('/api/admin/vps/wiki/doc', { params: { slug } });
  }
}
