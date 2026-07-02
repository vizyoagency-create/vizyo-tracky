/**
 * Palier 3 — Rapports d'observation IA de l'activité utilisateur (super-admin).
 *
 * Un agent (Claude) analyse le journal d'activité SCOPÉ d'un ou plusieurs utilisateurs sur
 * une période et rend un rapport structuré (parcours + points de friction + adoption +
 * recommandations). Le rapport est PERSISTÉ (conservé, ré-exploitable) et son coût est
 * journalisé dans le tableau de bord « Coûts IA ». Génération à la demande OU planifiée.
 */

export type ActivityReportStatus = 'PENDING' | 'READY' | 'FAILED';
export type ActivityReportFrequency = 'daily' | 'weekly' | 'monthly';
export type ActivityReportScope = 'ACTIVE' | 'ALL';
export type ActivityReportOrigin = 'manual' | 'scheduled';

/** Un point de friction repéré dans le parcours. */
export interface ActivityFrictionPoint {
  title: string;
  detail: string;
  /** 'low' | 'medium' | 'high' (indicatif). */
  severity?: string;
}

/** Une recommandation d'amélioration. */
export interface ActivityRecommendation {
  title: string;
  detail: string;
  /** Impact estimé, ex. 'UX', 'perf', 'adoption'. */
  impact?: string;
}

/** Contenu structuré du rapport (garanti par le schéma de sortie IA). */
export interface ActivityReportContent {
  /** Synthèse en quelques phrases. */
  summary: string;
  /** Parcours résumé (ce que l'utilisateur a fait, dans l'ordre / les grandes boucles). */
  journey: string;
  /** Points de friction : blocages, hésitations, allers-retours, abandons, erreurs subies. */
  frictionPoints: ActivityFrictionPoint[];
  /** Adoption : fonctions réellement utilisées vs ignorées + note. */
  adoption: { used: string[]; ignored: string[]; note?: string };
  /** Recommandations concrètes (UX / app / accompagnement). */
  recommendations: ActivityRecommendation[];
  /** Rapports multi-utilisateurs : 1-2 phrases PAR personne (absent si un seul utilisateur). */
  perUser?: { name: string; highlight: string; mainFriction?: string }[];
}

export interface ActivityReportUserRef {
  userId: string;
  name: string | null;
}

/** Rapport complet (détail). */
export interface ActivityReportDto {
  id: string;
  createdAt: string;
  createdByName: string | null;
  targets: ActivityReportUserRef[];
  from: string;
  to: string;
  status: ActivityReportStatus;
  origin: ActivityReportOrigin;
  title: string | null;
  content: ActivityReportContent | null;
  error: string | null;
  costUsd: number;
  costEur: number;
}

/** Entrée de la liste des rapports (aperçu). */
export interface ActivityReportListItemDto {
  id: string;
  createdAt: string;
  title: string | null;
  status: ActivityReportStatus;
  origin: ActivityReportOrigin;
  targetCount: number;
  from: string;
  to: string;
}

/** Demande de génération à la demande : 1+ utilisateurs + période optionnelle. */
export interface GenerateActivityReportDto {
  userIds: string[];
  from?: string;
  to?: string;
}

/** Planification réglable (lecture). */
export interface ActivityReportScheduleDto {
  enabled: boolean;
  frequency: ActivityReportFrequency;
  scope: ActivityReportScope;
  lastRunAt: string | null;
  updatedAt: string | null;
}

/** Réglage de la planification. */
export interface SetActivityReportScheduleDto {
  enabled: boolean;
  frequency: ActivityReportFrequency;
  scope: ActivityReportScope;
}
