/**
 * Formatage des dates DESTINÉES AU CLIENT (e-mails, SMS, PDF).
 *
 * ⚠️ POURQUOI CE FICHIER EXISTE — le serveur tourne en **UTC** (VPS et
 * conteneurs). `date.toLocaleString('fr-FR')` sans `timeZone` utilise donc le
 * fuseau du PROCESSUS, pas celui du client : en été, tout s'affichait **2 h en
 * arrière**. Constaté le 2026-07-24. Une alerte SOS de 07:38 arrivait par
 * e-mail annoncée à « 05:38 » — alors que le SMS de la MÊME alerte disait
 * 07:38, parce que lui passait un `timeZone`. Deux canaux, deux heures : le
 * gestionnaire ne sait plus quand l'incident a eu lieu.
 *
 * ⚠️ NE JAMAIS « CORRIGER » CE GENRE D'ÉCART EN AJOUTANT +2 h. L'écart vaut +2 h
 * l'été (CEST) et +1 h l'hiver (CET) : un décalage codé en dur se retrouve faux
 * la moitié de l'année, et le bug ressurgit au changement d'heure, quand
 * personne ne le cherche. `timeZone: 'Europe/Paris'` gère les deux tout seul.
 *
 * ⚠️ Et surtout : ne PAS ajouter d'heures aux valeurs STOCKÉES. La base est en
 * UTC, c'est correct et c'est ce qui permet à l'application web d'afficher la
 * bonne heure (le navigateur convertit). Seul l'AFFICHAGE côté serveur doit
 * être localisé — parce que là, il n'y a pas de navigateur pour le faire.
 *
 * Utiliser ces helpers pour TOUTE date sortant vers un client.
 */

/** Fuseau de référence de la flotte. Les clients sont en France métropolitaine. */
export const FLEET_TIME_ZONE = 'Europe/Paris';

/** « 24/07/2026 07:38 » — le format par défaut des e-mails et PDF. */
export function formatFleetDateTime(date: Date | string | number): string {
  return new Date(date).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: FLEET_TIME_ZONE,
  });
}

/** « 24/07/2026 » — quand l'heure n'apporte rien (périodes de rapport). */
export function formatFleetDate(date: Date | string | number): string {
  return new Date(date).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: FLEET_TIME_ZONE,
  });
}

/** « 24/07/26 » — format court des tableaux PDF, où la place manque. */
export function formatFleetDateShort(date: Date | string | number): string {
  return new Date(date).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: FLEET_TIME_ZONE,
  });
}

/** « 07:38 » — heure seule (lignes de trajet, SMS). */
export function formatFleetTime(date: Date | string | number): string {
  return new Date(date).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: FLEET_TIME_ZONE,
  });
}

/** « 24 juillet 2026 à 07:38 » — ton posé, pour les e-mails de consentement. */
export function formatFleetDateTimeLong(date: Date | string | number): string {
  return new Date(date).toLocaleString('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: FLEET_TIME_ZONE,
  });
}
