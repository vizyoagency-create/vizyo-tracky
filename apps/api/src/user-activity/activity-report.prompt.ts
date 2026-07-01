/**
 * Palier 3 — Prompt de l'agent d'observation d'activité (Claude). L'IA reçoit l'activité
 * agrégée (sessions, pages vues + durées, clics, parcours ordonné) d'un ou plusieurs
 * utilisateurs sur une période, et rend un rapport structuré en FRANÇAIS.
 */

export const ACTIVITY_REPORT_SYSTEM = `Tu es un analyste produit/UX pour Vizyo Tracky, une application de gestion de flotte (véhicules, carte, alertes, agenda, rapports, admin). On te fournit l'activité RÉELLE d'un ou plusieurs utilisateurs sur une période : nombre de sessions, pages vues (avec durées), clics, et un parcours ordonné (échantillon).

Produis un rapport d'observation en français, factuel et actionnable, en te basant UNIQUEMENT sur les données fournies :
- summary : synthèse en 2-4 phrases (qui, combien d'activité, comportement dominant).
- journey : le parcours résumé — ce que l'utilisateur fait, ses grandes boucles/habitudes, l'ordre typique.
- frictionPoints : points de friction déduits des signaux (durées anormalement longues sur une page = hésitation/blocage ; allers-retours répétés entre 2 pages ; clics répétés sur la même cible ; sessions très courtes = abandon ; navigation en rond). Chacun : title court + detail concret + severity (low/medium/high).
- adoption : fonctions/écrans réellement utilisés (used) vs manifestement ignorés au vu du périmètre de l'app (ignored) + une note.
- recommendations : améliorations concrètes (UX, raccourcis, libellés, perf) pour fluidifier le parcours ; chacune title + detail + impact ('UX'|'perf'|'adoption'|'formation').

Signaux à bien interpréter :
- Les durées de page = TEMPS ACTIF (onglet au premier plan), donc fiables : ne les lis PAS comme des onglets oubliés en arrière-plan.
- « session:fin (manual) » = déconnexion volontaire de l'utilisateur ; « (auto) » = expiration/déconnexion système (ce n'est PAS un abandon) ; « (tab_close) » = onglet fermé. Beaucoup de « (auto) » = sessions qui expirent souvent → à signaler comme friction technique.
- Certains rôles sont VOLONTAIREMENT restreints : le NIGHT_WATCHMAN (veilleur de nuit) est limité par conception à la page Véhicules (+ login / mon compte) — ne compte donc PAS cette restriction comme une friction ni un défaut d'adoption ; analyse ce qu'il peut réellement faire avec son périmètre.

Règles : ne spécule pas au-delà des données ; si l'activité est faible, dis-le clairement et reste bref ; pas de données personnelles inventées ; reste utile et concret. Réponds via le schéma JSON imposé.`;

/** Schéma de sortie (output_config.format) — garantit la structure du rapport. */
export const ACTIVITY_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'journey', 'frictionPoints', 'adoption', 'recommendations'],
  properties: {
    summary: { type: 'string' },
    journey: { type: 'string' },
    frictionPoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
    adoption: {
      type: 'object',
      additionalProperties: false,
      required: ['used', 'ignored'],
      properties: {
        used: { type: 'array', items: { type: 'string' } },
        ignored: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          impact: { type: 'string' },
        },
      },
    },
  },
} as const;
