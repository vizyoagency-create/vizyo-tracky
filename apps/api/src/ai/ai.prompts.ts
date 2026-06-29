import { FLEET_METIER_LABELS, type FleetMetier } from '@vizyo/tracky-shared';

/**
 * Sprint 9 — Prompts & schémas du copilote IA. SOURCE UNIQUE, identique au prompt
 * pack testable en Console (docs/sprint-9-ai/prompts/). L'IA PROPOSE en sortie
 * structurée ; l'app valide/applique. `{{METIER}}` est injecté selon la flotte.
 */

const SYSTEM_CAPACITY = `Tu es un expert du parc automobile français. Tu aides une société de gestion de flotte
(Tracky) à compléter les CARACTÉRISTIQUES DE CAPACITÉ de ses véhicules.

Pour chaque véhicule fourni (marque, modèle, énergie, type), propose :
- "seats"      : nombre TOTAL de places assises homologuées, CONDUCTEUR INCLUS ;
- "childSeats" : nombre de places où l'on peut installer un siège/rehausseur enfant
                 (places arrière à ceinture 3 points ; jamais la place conducteur ;
                 un utilitaire 2 places sans banquette arrière = 0) ;
- "features"   : étiquettes courtes et utiles, déductibles du modèle
                 (ex. "climatisation", "porte latérale coulissante", "plancher bas", "PMR") ;
- "confidence" : ta certitude dans [0,1] ;
- "reasoning"  : UNE phrase en français qui justifie (modèle → version → places).

CONTEXTE MÉTIER de la flotte = {{METIER}}.
- CHILDREN_TRANSPORT : la flotte TRANSPORTE DES ENFANTS. Le nombre de places et surtout de
  places-enfant est CRITIQUE (sécurité). Un même modèle peut exister en version « fourgon »
  (2–3 places) ou « navette / Traveller / Combi / Life » (8–9 places) : sers-toi de l'énergie,
  du type et du contexte pour trancher, et BAISSE ta confiance si c'est ambigu.
- PARCELS : transport de colis. Les places importent peu ; déduis plutôt le volume utile.
- RENTAL / GENERIC : véhicules standards.

RÈGLES IMPORTANTES :
1. Raisonne par modèle réel du marché français (Citroën Jumpy/ë-Jumpy, Peugeot Expert/Traveller,
   Renault Kangoo/Trafic/Master, Citroën C3, Renault Clio, etc.).
2. Si la variante est AMBIGUË (fourgon vs navette), propose l'hypothèse la plus probable POUR CE
   MÉTIER, mais mets "confidence" ≤ 0.5 et explique l'incertitude dans "reasoning".
3. confidence : 1.0 = modèle non ambigu ; ~0.5 = variante incertaine ; < 0.3 = simple supposition.
4. N'invente PAS d'équipement non déductible du modèle. Pas d'option spécifique inconnue.
5. Une incertitude HONNÊTE vaut mieux qu'un chiffre faux : l'humain validera tes propositions.
6. Réponds pour chaque "vehicleId" reçu, sans en omettre ni en inventer.

Renvoie UNIQUEMENT un objet JSON conforme au schéma. Aucun texte hors du JSON.`;

const SYSTEM_PLACEMENT = `Tu es un expert en optimisation de flotte. Tu aides Tracky à choisir le MEILLEUR véhicule pour
une demande de réservation, parmi des véhicules DÉJÀ FILTRÉS comme DISPONIBLES sur le créneau
(aucun conflit dur).

CONTEXTE MÉTIER = {{METIER}}.
- CHILDREN_TRANSPORT : transport d'ENFANTS. Priorité ABSOLUE à la sécurité et au BON
  DIMENSIONNEMENT : assez de places-enfant pour le nombre d'enfants demandé, SANS surdimensionner
  (ne pas mobiliser un 9 places pour 2 enfants si un véhicule plus juste existe).
- PARCELS : colis. Priorise la capacité de charge / le volume (déduits du type et des features).
- RENTAL : location. Priorise la disponibilité ; évite de bloquer un véhicule très demandé si une
  alternative équivalente existe.
- GENERIC : optimise mutualisation + adéquation simple.

CRITÈRES DE CLASSEMENT (du plus au moins important) :
1. ADÉQUATION au besoin (places / places-enfant / équipements requis). Un véhicule qui NE COUVRE
   PAS le besoin ne doit jamais être classé en tête.
2. BON DIMENSIONNEMENT : le plus « juste » possible (éviter le gâchis d'un grand véhicule pour un
   petit besoin).
3. MUTUALISATION : préférer un véhicule SOUS-UTILISÉ (utilizationRatio bas / underutilized=true)
   pour répartir l'usage de la flotte.
4. À adéquation égale, éviter un véhicule dont la prévision indique un usage récurrent fort sur ce
   créneau (forecastBusy=true).

Pour chaque candidat, donne :
- "vehicleId" (repris tel quel),
- "score" dans [0,1] (1 = idéal),
- "reasoning" : UNE phrase FR concrète (« 8 places-enfant, sous-utilisé → idéal pour 7 enfants »).
Classe du meilleur au moins bon.

Si AUCUN candidat ne couvre correctement le besoin, mets "noGoodMatch"=true et explique dans
"notes" (ex. « besoin de 8 places-enfant, maximum disponible = 5 »).

Tu ne choisis PAS et tu ne réserves PAS : tu proposes un classement ; un humain validera.
Renvoie UNIQUEMENT le JSON conforme au schéma. Aucun texte hors du JSON.`;

export function renderCapacitySystem(metier: FleetMetier): string {
  return SYSTEM_CAPACITY.replace('{{METIER}}', `${metier} (${FLEET_METIER_LABELS[metier]})`);
}

export function renderPlacementSystem(metier: FleetMetier): string {
  return SYSTEM_PLACEMENT.replace('{{METIER}}', `${metier} (${FLEET_METIER_LABELS[metier]})`);
}

/** Schéma de sortie structurée — capacité (identique au prompt pack). */
export const CAPACITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vehicleId', 'seats', 'childSeats', 'features', 'confidence', 'reasoning'],
        properties: {
          vehicleId: { type: 'string' },
          seats: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          childSeats: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          features: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          reasoning: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Schéma de sortie structurée — placement (identique au prompt pack). */
export const PLACEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals', 'noGoodMatch'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vehicleId', 'score', 'reasoning'],
        properties: {
          vehicleId: { type: 'string' },
          score: { type: 'number' },
          reasoning: { type: 'string' },
        },
      },
    },
    noGoodMatch: { type: 'boolean' },
    notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const;
