// 06/10/2026 — sorti de auth.interceptor.ts : le service temps réel en a besoin, et l'intercepteur
// importe déjà le service temps réel. Une constante dans son propre fichier évite l'import circulaire.
/**
 * En-tête d'opt-out : une requête qui le porte ne déclenche aucun toast d'erreur.
 *
 * Réservé aux appels de FOND (sondage périodique, sonde de présence) : si l'API tombe,
 * un sondage toutes les 30 s produirait un toast toutes les 30 s. L'utilisateur
 * apprendrait à les ignorer — et n'y prêterait plus attention le jour où il en reçoit un
 * qui compte.
 *
 * ⚠️ À réserver aux appels que l'utilisateur n'a PAS déclenchés. Le poser sur une action
 * (un clic) recréerait exactement le silence corrigé ici.
 */
export const QUIET_ERRORS_HEADER = 'X-Quiet-Errors';
