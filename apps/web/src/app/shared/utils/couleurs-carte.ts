/**
 * Couleurs des COUCHES DE CARTE — la seule exception assumée à la règle « aucune
 * couleur en dur » du socle (`design/B0-SOCLE.md` § « Couleurs en dur »).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI CELLES-CI NE DEVIENNENT PAS DES JETONS                            │
 * │                                                                            │
 * │ Les chips, les légendes et le reste de l'habillage se posent sur les        │
 * │ SURFACES DE L'APPLICATION : ils doivent suivre son thème, et ils le font.   │
 * │                                                                            │
 * │ Ces valeurs-là se posent sur le FOND DE CARTE, qui n'est pas le thème. Le   │
 * │ fond est un choix séparé de l'utilisateur (`MapStyleService` : clair,       │
 * │ sombre, satellite, terrain). Quelqu'un en thème CLAIR peut afficher un fond │
 * │ SATELLITE : un tracé lu depuis `--texte-succes` y deviendrait un vert foncé │
 * │ sur une forêt sombre, illisible — le contraire de ce qu'on cherchait.       │
 * │                                                                            │
 * │ Accessoirement, MapLibre ne résout aucune variable CSS : ce qu'on lui passe │
 * │ est toujours une valeur. Un `var(--x)` y donne une couche invisible, sans   │
 * │ erreur ni avertissement.                                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Une seule définition pour les deux rejeux : la légende du rejeu de trajet lit
 * ces mêmes valeurs, faute de quoi la pastille de la légende et la pastille de la
 * carte dérivent l'une de l'autre au premier ajustement.
 */
export const COULEURS_CARTE = {
  /** Le tracé du trajet — vert de marque, lisible sur les quatre fonds. */
  trace: '#10E0A0',
  /** Les arrêts — bleu, information. */
  arret: '#3B82F6',
  /** Les excès de vitesse — rouge, à vérifier. */
  exces: '#EF4444',
  /** Le contour blanc qui détache les pastilles du fond, quel qu'il soit. */
  contour: '#FFFFFF',
} as const;
