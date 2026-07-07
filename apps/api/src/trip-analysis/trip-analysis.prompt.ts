/**
 * Traçabilité fine des trajets (Palier 3) — couche LLM par-dessus l'analyse DÉTERMINISTE.
 *
 * Le LLM ne recalcule RIEN : il reçoit le résumé déjà calculé (chiffres fiables) et produit un
 * RÉCIT vulgarisé, un « Tracky Trust Score » (fiabilité/cohérence de la donnée GPS) et des CONSEILS
 * d'éco-conduite actionnables. Consignes du guide fourni : raisonner sur l'ensemble du trajet, ne
 * JAMAIS inventer de faits, dire « probable » quand ce n'est pas certain. Sortie JSON stricte.
 */

/** Schéma de sortie (Structured Outputs) — commun Claude/GPT. */
export const TRIP_NARRATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['narrative', 'advice', 'trustScore'],
  properties: {
    narrative: {
      type: 'string',
      description: 'Récit clair et vulgarisé du trajet (3-6 phrases) : allure générale, arrêts, anomalies notables (excès, à-coups, ralenti). Factuel, basé UNIQUEMENT sur les données fournies. Emploie « probable » si incertain.',
    },
    advice: {
      type: 'string',
      description: 'Conseils d\'éco-conduite ACTIONNABLES (2-4 puces courtes, séparées par « • ») adaptés aux anomalies détectées (excès → anticiper/lever le pied ; à-coups → conduite souple ; ralenti → couper le moteur à l\'arrêt). Si conduite déjà exemplaire, le dire.',
    },
    trustScore: {
      type: 'integer',
      description: 'Tracky Trust Score, ENTIER de 0 à 100 : FIABILITÉ de la donnée du trajet (qualité GPS : ratio de points valides, trous de signal, cohérence vitesse/distance). 100 = données très fiables ; bas = données lacunaires/incohérentes (à interpréter avec prudence).',
    },
  },
} as const;

/** System prompt (préfixe stable → mis en cache par les providers). */
export function renderTripNarrativeSystem(): string {
  return [
    "Tu es l'assistant d'analyse de trajets de Tracky, une plateforme de suivi de flotte.",
    'On te fournit le RÉSUMÉ DÉTERMINISTE d\'UN trajet (déjà calculé à partir des positions GPS filtrées) :',
    "distance, durée, vitesses, arrêts, qualité du signal GPS, excès de vitesse (vs limites), et indicateurs",
    "d'éco-conduite (accélérations/freinages brusques, ralenti moteur, conso estimée).",
    '',
    'Ta mission :',
    "1) RÉCIT : raconter le trajet de façon claire pour un gestionnaire NON technique (allure, arrêts, anomalies).",
    "2) TRUST SCORE : noter la FIABILITÉ de la donnée (qualité GPS + cohérence), PAS la qualité de conduite.",
    "3) CONSEILS : recommandations d'éco-conduite concrètes, seulement si des anomalies le justifient.",
    '',
    'Règles STRICTES :',
    "- Raisonne sur l'ENSEMBLE du trajet. N'invente JAMAIS de fait absent des données.",
    "- Emploie « probable » quand une limite de vitesse n'est pas certaine (champ limitsKnown=false).",
    "- Reste FACTUEL et bref. Pas de morale, pas de jugement sur le conducteur — des faits et des conseils.",
    '- Réponds en FRANÇAIS, en JSON conforme au schéma.',
  ].join('\n');
}
