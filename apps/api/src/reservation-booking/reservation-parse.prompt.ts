/**
 * Refonte agenda/IA (2026-07, P4) — Analyse IA rapide d'un besoin DICTÉ (voix → texte).
 * Claude extrait les champs structurés du formulaire depuis une phrase en langage naturel
 * (« demain matin, 11 places pour Carcassonne »). Best-effort : un repli déterministe couvre
 * les cas courants sans clé IA.
 */
export const BOOKING_PARSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['seatsNeeded', 'destination', 'startAt', 'endAt'],
  properties: {
    /** Nombre de places demandé, ou null si non précisé. */
    seatsNeeded: { type: ['integer', 'null'] },
    /** Ville / lieu de destination, ou null. */
    destination: { type: ['string', 'null'] },
    /** Début en ISO 8601 avec fuseau (ex. 2026-07-08T09:00:00+02:00), ou null si non précisé. */
    startAt: { type: ['string', 'null'] },
    /** Fin en ISO 8601 avec fuseau, ou null. */
    endAt: { type: ['string', 'null'] },
  },
} as const;

/** System prompt : `nowIso` = maintenant (référence pour résoudre « demain », « ce soir »…). */
export function renderBookingParseSystem(nowIso: string): string {
  return [
    "Tu extrais, d'une phrase en français décrivant un besoin de véhicule, des champs structurés.",
    `Référence temporelle (maintenant, fuseau Europe/Paris) : ${nowIso}.`,
    'Renseigne, en te basant sur cette phrase :',
    '- seatsNeeded : le nombre de PLACES / personnes demandé (entier), sinon null ;',
    '- destination : la ville ou le lieu de destination, sinon null ;',
    "- startAt / endAt : le créneau, en ISO 8601 AVEC fuseau (ex. 2026-07-08T09:00:00+02:00). Résous les",
    "  formulations relatives (« aujourd'hui », « demain matin », « ce soir », « lundi », « de 9h à 17h »)",
    '  par rapport à la référence ci-dessus (heure locale Europe/Paris). Si aucune heure de fin n\'est',
    "  donnée, propose une fin raisonnable (par défaut +8 h, ou la fin de la demi-journée évoquée).",
    '  Si le créneau n\'est pas précisé du tout, mets startAt et endAt à null.',
    '',
    "Réponds UNIQUEMENT le JSON demandé. Aucune supposition hasardeuse : dans le doute, null.",
  ].join('\n');
}
