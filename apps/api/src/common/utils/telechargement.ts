/**
 * EN-TÊTE DE TÉLÉCHARGEMENT — un nom de fichier qui ne fait pas tomber la réponse.
 *
 * ── LE DÉFAUT (trouvé le 4 septembre, en vérifiant le déploiement) ──────────────────────
 *
 * Les cinq exports de ce contrôleur écrivaient `filename="<nom>"` directement dans l'en-tête,
 * et le nom contient la PLAQUE du véhicule. Node refuse un en-tête HTTP contenant un caractère
 * hors Latin-1 :
 *
 *     TypeError [ERR_INVALID_CHAR]: Invalid character in header content ["Content-Disposition"]
 *
 * Deux véhicules sur quarante-quatre en production portent une plaque de ce genre — `GLA•KC•31`
 * et `KSR•370`. Pour eux, TOUS les exports répondaient 500 : le rapport de vitesse, présenté
 * comme pièce disciplinaire, était purement inaccessible. Personne ne l'avait vu, parce qu'un
 * 500 sur un téléchargement ressemble à une panne passagère.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────
 *
 * On envoie les DEUX formes prévues par la RFC 6266 :
 *   · `filename="…"`      — repli en ASCII pur, compris de tous les clients ;
 *   · `filename*=UTF-8''…` — le nom exact, pour les navigateurs qui savent le lire (tous,
 *     depuis longtemps). Les navigateurs préfèrent cette seconde forme quand elle est là.
 *
 * Le client garde donc le nom juste, et le serveur ne tombe plus jamais sur une plaque.
 */

/**
 * Réduit un nom de fichier à ce qu'un en-tête accepte sans discuter.
 *
 * Les caractères hors ASCII imprimable deviennent un tiret, comme les guillemets, les
 * antislashs et les points-virgules — qui, eux, casseraient la SYNTAXE de l'en-tête même en
 * restant lisibles par Node.
 */
export function nomFichierAscii(nom: string): string {
  const reduit = nom
    .normalize('NFKD')
    // L'accent SÉPARÉ de sa lettre par NFKD s'efface au lieu de devenir un tiret :
    // « société » doit donner « societe », pas « socie-te ».
    .replace(/[̀-ͯ]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '-')
    .replace(/["\\;]/g, '-')
    .replace(/-{2,}/g, '-')
    .trim();
  return reduit.length > 0 ? reduit : 'export';
}

/**
 * Valeur complète de `Content-Disposition` pour une pièce jointe.
 *
 * ⚠️ Toujours passer par ici. Un `filename="${x}"` écrit à la main rouvre le défaut au premier
 * nom accentué, et l'échec se produit chez le client — pas dans nos tests.
 */
export function enTeteTelechargement(nom: string): string {
  return `attachment; filename="${nomFichierAscii(nom)}"; filename*=UTF-8''${encodeURIComponent(nom)}`;
}
