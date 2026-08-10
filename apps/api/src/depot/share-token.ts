import { randomBytes } from 'node:crypto';

/**
 * Espace depot (2026-08), lot A4 — la generation du token de partage public.
 *
 * ┌─ TROIS PROPRIETES, ET AUCUNE N'EST NEGOCIABLE ────────────────────────────┐
 * │                                                                            │
 * │ 1. CRYPTOGRAPHIQUE. `randomBytes`, jamais `Math.random` : ce dernier est    │
 * │    predictible a partir de quelques sorties observees, et le lien est       │
 * │    justement fait pour etre observe par un tiers.                           │
 * │                                                                            │
 * │ 2. NON DERIVE. Le token ne contient RIEN de la mission — ni son uuid, ni sa │
 * │    reference, ni son horodatage. Un token derive d'un identifiant donne     │
 * │    acces a TOUTES les missions des qu'on comprend la derivation.            │
 * │                                                                            │
 * │ 3. NON REUTILISABLE. Chaque partage cree un nouveau lien. Regenerer le meme │
 * │    token pour la meme mission rendrait la revocation illusoire : un ancien  │
 * │    destinataire reviendrait par son ancienne URL.                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Cf. design/A4-PARTAGE.md § 1.
 */

/** L'alphabet base62. Ni `-` ni `_` : le token se lit au telephone et se recopie. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 22 caracteres. Espace de 62²² ≈ 1,4 × 10³⁹ — l'enumeration est hors de portee, y
 * compris avec le debit borne retire. C'est la meme longueur qu'un uuid en base62,
 * choisie pour tenir dans un SMS sans couper la ligne.
 */
export const LONGUEUR_TOKEN = 22;

/**
 * Tirage UNIFORME sur l'alphabet.
 *
 * ⚠️ Le rejet des octets ≥ 248 n'est pas une precaution theorique : 256 n'est pas un
 * multiple de 62, donc un simple `octet % 62` favoriserait les huit premiers
 * caracteres de l'alphabet (probabilite 5/256 contre 4/256). Le biais est faible,
 * mais il reduit l'entropie reelle — et l'entropie est tout ce qui protege ce token.
 */
export function genererTokenPartage(): string {
  const seuil = 248; // 4 × 62 : le plus grand multiple de 62 sous 256.
  let sortie = '';
  while (sortie.length < LONGUEUR_TOKEN) {
    // On tire par lots : un appel systeme par caractere serait absurde.
    const octets = randomBytes(LONGUEUR_TOKEN * 2);
    for (const octet of octets) {
      if (octet >= seuil) continue;
      sortie += ALPHABET[octet % ALPHABET.length];
      if (sortie.length === LONGUEUR_TOKEN) break;
    }
  }
  return sortie;
}

/**
 * Empreinte TRONQUEE de l'appelant, pour le suivi d'usage : « 92.184.x.x ».
 *
 * On veut distinguer deux destinataires — « ouvert depuis deux endroits » — pas
 * identifier une personne. Conserver l'IP complete d'un tiers non authentifie, qui
 * n'a consenti a rien et n'a pas de compte, serait disproportionne (RGPD).
 *
 * IPv6 : on garde les deux premiers groupes, qui designent l'operateur, pas l'abonne.
 */
export function tronquerAdresse(adresse: string | undefined | null): string | null {
  if (!adresse) return null;
  // Express prefixe parfois l'IPv4 en IPv6 (« ::ffff:92.184.1.2 »).
  const nettoyee = adresse.replace(/^::ffff:/, '').trim();
  if (!nettoyee) return null;

  if (nettoyee.includes('.')) {
    const parties = nettoyee.split('.');
    if (parties.length !== 4) return null;
    return `${parties[0]}.${parties[1]}.x.x`;
  }
  if (nettoyee.includes(':')) {
    const parties = nettoyee.split(':').filter(Boolean);
    if (parties.length < 2) return null;
    return `${parties[0]}:${parties[1]}::`;
  }
  return null;
}
