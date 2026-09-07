/**
 * Catégorie et actions du journal `system_activity_logs` propres à la démo — partagées entre
 * l'écran d'administration (dans l'API), l'importeur (processus à part) et le script du VPS
 * (`demo-refresh.sh`, qui les lit en SQL). Les changer ici sans changer le script casserait la
 * détection des demandes en silence : les trois doivent s'accorder.
 */
export const JOURNAL_DEMO = {
  categorie: 'DEMO',
  /** Posé UNE fois par le seed : sans cette ligne, l'importeur refuse d'écrire dans la base. */
  marqueur: 'base_de_demonstration',
  /** Écrit par le bouton « Rafraîchir maintenant » ; consommé par le script du VPS. */
  demande: 'refresh_requested',
  /** Écrit par l'importeur à la fin de chaque passage, réussi (SUCCESS) ou non (FAILURE). */
  passage: 'refresh_done',
} as const;
