import type { FleetMetier } from '@vizyo/tracky-shared';

/**
 * Refonte agenda/IA (2026-07, P3+) — Couche de JUGEMENT/EXPLICATION Claude par-dessus la détection
 * DÉTERMINISTE. L'app détecte les récurrences (fiable, gratuit) ; Claude décide lesquelles valent
 * la peine d'être pré-réservées (keep) et rédige un « pourquoi » vulgarisé pour un gestionnaire non
 * technique. Best-effort : en cas d'échec, l'app retombe sur le raisonnement déterministe.
 */
const METIER_HINT: Record<FleetMetier, string> = {
  CHILDREN_TRANSPORT: "transport d'enfants — fiabilité et sécurité prioritaires",
  PARCELS: 'livraison de colis — ponctualité et coût au km',
  RENTAL: 'location de véhicules',
  GENERIC: 'usage général',
};

/** Schéma STRICT de la sortie Claude (une revue par trajet récurrent, référencée par index). */
export const AGENDA_AGENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reviews'],
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'keep', 'reasoning'],
        properties: {
          index: { type: 'integer' },
          keep: { type: 'boolean' },
          reasoning: { type: 'string' },
        },
      },
    },
  },
} as const;

export function renderAgendaAgentSystem(metier: FleetMetier): string {
  return [
    `Tu assistes le gestionnaire d'une flotte de véhicules (métier : ${METIER_HINT[metier] ?? METIER_HINT.GENERIC}).`,
    "On te fournit des trajets RÉCURRENTS détectés automatiquement à partir de l'historique GPS :",
    'chacun a un index, une plaque, un jour de semaine, un créneau horaire, une destination, le nombre',
    "de semaines où il a été observé (sur 10) et une confiance (0..1).",
    '',
    'Pour CHAQUE trajet (référencé par son index), tu dois :',
    "- décider `keep` : true s'il est pertinent de PRÉ-RÉSERVER ce véhicule d'avance pour cette habitude,",
    '  false si la récurrence est trop faible/instable ou si la pré-réservation n\'a pas de sens ;',
    '- rédiger `reasoning` : une phrase COURTE, en français simple, pour un gestionnaire NON technique',
    '  (ex. « Ce véhicule va presque tous les lundis matin à Carcassonne — on le bloque à l\'avance pour',
    '  être sûr qu\'il soit disponible »).',
    '',
    "Réponds UNIQUEMENT le JSON demandé. N'invente jamais d'index absent de l'entrée.",
  ].join('\n');
}
