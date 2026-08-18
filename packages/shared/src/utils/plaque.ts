/**
 * Plaques d'immatriculation : mise en forme pendant la frappe, et validation.
 *
 * ── CE QUE CE FICHIER EMPÊCHE ────────────────────────────────────────────────────────
 *
 * Le formulaire n'exigeait qu'une chaîne non vide. Un véhicule a donc été créé en
 * production avec la plaque « FT- » — une saisie interrompue, validée sans un mot. Une
 * plaque tronquée ne se rattrape pas toute seule : elle sert d'identifiant à l'écran, sur
 * les rapports et sur les cartes QR, et personne ne la relit avant des semaines.
 *
 * ── POURQUOI UNE CASE « PLAQUE ÉTRANGÈRE » PLUTÔT QU'UNE DÉTECTION ───────────────────
 *
 * Une heuristique qui devinerait le pays se tromperait sur les plaques courtes, et
 * refuserait une plaque allemande légitime — ce parc en compte une, KSR370. On demande
 * donc à l'utilisateur, une case à cocher, une fois. Deviner ici, c'est bloquer
 * quelqu'un qui a raison.
 */

/** Format français depuis 2009 : deux lettres, trois chiffres, deux lettres. */
const SIV = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/;

/** Ne garde que ce qui peut composer une plaque, en majuscules. */
export function normaliserPlaque(saisie: string): string {
  return (saisie ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Pose les tirets au fil de la frappe : « ab123cd » devient « AB-123-CD ».
 *
 * ⚠️ MISE EN FORME PROGRESSIVE, PAS APRÈS COUP. Attendre la fin de la saisie ferait
 * sauter le texte sous le curseur au dernier caractère ; ici chaque frappe rend un état
 * cohérent, et l'utilisateur voit le gabarit se remplir. On ne tronque jamais au-delà :
 * les caractères en trop sont écartés plutôt que d'insérer un tiret absurde.
 */
export function formaterPlaqueFr(saisie: string): string {
  const c = normaliserPlaque(saisie).slice(0, 7);
  if (c.length <= 2) return c;
  if (c.length <= 5) return `${c.slice(0, 2)}-${c.slice(2)}`;
  return `${c.slice(0, 2)}-${c.slice(2, 5)}-${c.slice(5)}`;
}

/** La plaque française est-elle complète et bien formée ? */
export function plaqueFrValide(plaque: string): boolean {
  return SIV.test((plaque ?? '').trim().toUpperCase());
}

/**
 * Une plaque étrangère est acceptée telle quelle, avec un plancher de vraisemblance.
 *
 * On ne connaît pas les formats de tous les pays et on n'essaiera pas : le seul garde-fou
 * utile est qu'il reste quelque chose d'identifiable. Quatre caractères écartent « FT- »
 * sans écarter une plaque courte légitime.
 */
export function plaqueEtrangereValide(plaque: string): boolean {
  return normaliserPlaque(plaque).length >= 4;
}

/** Ce qui manque à cette plaque, en clair — `null` si elle est valide. */
export function messagePlaque(plaque: string, etrangere: boolean): string | null {
  const brut = (plaque ?? '').trim();
  if (brut.length === 0) return 'La plaque est obligatoire.';
  if (etrangere) {
    return plaqueEtrangereValide(brut) ? null : 'Plaque trop courte pour être identifiable.';
  }
  if (plaqueFrValide(brut)) return null;

  // On dit CE QU'IL MANQUE, pas « format invalide » : l'utilisateur doit savoir quoi
  // taper de plus, pas seulement qu'il a tort.
  const c = normaliserPlaque(brut);
  const lettres1 = c.slice(0, 2).replace(/[^A-Z]/g, '').length;
  const chiffres = c.slice(2, 5).replace(/\D/g, '').length;
  const lettres2 = c.slice(5, 7).replace(/[^A-Z]/g, '').length;
  if (c.length < 7) {
    if (lettres1 < 2) return 'Commencez par deux lettres, par exemple AB-123-CD.';
    if (chiffres < 3) return `Il manque ${3 - chiffres} chiffre${3 - chiffres > 1 ? 's' : ''}.`;
    return `Il manque ${2 - lettres2} lettre${2 - lettres2 > 1 ? 's' : ''} à la fin.`;
  }
  return 'Format attendu : deux lettres, trois chiffres, deux lettres — AB-123-CD. Cochez « plaque étrangère » si ce n’est pas une plaque française.';
}
