/**
 * ⚠️ CETTE FORMULE A DÉMÉNAGÉ dans le contrat partagé (`utils/gps-sanity`).
 *
 * Trois implémentations du haversine coexistaient : celle-ci, celle du détecteur d'arrêts
 * (`agenda/trip-stop-detector.service`), et celle du paquet partagé — qui sert déjà à
 * l'ingestion, à l'accumulation de polyligne, au segmenteur et au replay. Elles sont
 * mathématiquement équivalentes (asin et atan2 donnent le même résultat), donc rien ne
 * signalait la divergence : c'est précisément ce qui la rendait durable. Le jour où l'une
 * gagne un rayon terrestre différent ou un garde-fou, deux écrans annoncent deux distances
 * pour le même trajet, et rien ne dit pourquoi.
 *
 * Ce fichier n'est plus qu'un alias, conservé pour ne pas réécrire une dizaine d'imports.
 * Ne PAS y remettre de calcul.
 */
export { haversineMeters as distanceMeters } from '@vizyo/tracky-shared';
