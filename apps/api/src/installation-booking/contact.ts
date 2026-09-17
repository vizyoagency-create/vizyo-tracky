import { isE164 } from '../common/utils/phone';

/**
 * Le CONTACT d'une demande de créneau — obligatoire depuis le 16/09 (décision du propriétaire) :
 * un installateur qui se déplace a besoin d'un téléphone qui sonne et d'un e-mail qui arrive.
 *
 * Le téléphone est saisi par un client FRANÇAIS, au clavier d'un téléphone : « 06 12 34 56 78 »,
 * « 0612345678 », « +33 6 12 34 56 78 », « 0033612345678 ». `toE164` (utils) refuse volontairement
 * les numéros nationaux (il sert aux SIM de boîtiers, où un « 0 » en tête est une erreur) ; ici,
 * on SAIT que le numéro est français, et on le dit dans l'aide du champ. Tout le reste est refusé —
 * mieux vaut redemander qu'enregistrer un numéro qui ne sonne nulle part.
 */
export function telephoneClientE164(brut: string | null | undefined): string | null {
  if (!brut) return null;
  const propre = brut.trim().replace(/[\s.\-()]/g, '');
  if (!propre) return null;
  if (propre.startsWith('+')) return isE164(propre) ? propre : null;
  if (propre.startsWith('00')) {
    const candidat = `+${propre.slice(2)}`;
    return isE164(candidat) ? candidat : null;
  }
  // Numéro national français : 10 chiffres, commence par 0 (fixe ou mobile).
  if (/^0[1-9]\d{8}$/.test(propre)) return `+33${propre.slice(1)}`;
  // 9 chiffres sans le 0 (quelqu'un a retiré le zéro « pour l'international »).
  if (/^[1-9]\d{8}$/.test(propre)) return `+33${propre}`;
  return null;
}

/** L'e-mail, en minuscules, ou `null` s'il n'a pas la forme d'une adresse. */
export function emailClientPropre(brut: string | null | undefined): string | null {
  const propre = (brut ?? '').trim().toLowerCase();
  if (!propre || propre.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(propre) ? propre : null;
}

/** « +33612345678 » → « 06 12 34 56 78 » pour l'affichage ; les autres pays restent en E.164. */
export function telephoneLisible(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const m = /^\+33([1-9])(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(e164);
  return m ? `0${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}` : e164;
}
