/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * « OÙ ALLAIT-ON ? » — UNE SEULE DÉFINITION POUR LES TROIS ENDROITS QUI SE LE DEMANDENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Trois points du produit décident si l'adresse en cours mérite d'être reportée après une
 * connexion, et ils le décidaient chacun de leur côté :
 *
 *   - `authGuard`, quand une entrée profonde tombe sur une session absente ;
 *   - `authInterceptor`, quand la session expire pendant qu'on regarde quelque chose ;
 *   - `LoginComponent`, quand il faut CROIRE — ou non — le `?returnUrl=` qu'on lui tend.
 *
 * Les deux premiers écrivent le paramètre, le troisième le suit. Écrire la règle trois fois
 * la rendait fausse par avance : celui qui écrit est le seul à connaître l'origine du chemin,
 * et celui qui suit est le seul à en subir les conséquences. La règle ci-dessous vaut aux deux
 * bouts, et c'est le point : le lecteur n'a pas à faire confiance à l'écrivain.
 *
 * ── CE QUE CHAQUE CLAUSE PAIE ────────────────────────────────────────────────────────────
 *
 *   1. `/` en tête — INTERNE. Sans elle, `https://ailleurs.example/vol` serait un retour
 *      valide ; ce produit envoie des liens de connexion par courriel et par notification
 *      push, donc l'adresse arrive de l'extérieur et n'est pas de confiance.
 *
 *   2. pas de `//` — INTERNE POUR DE VRAI. `//ailleurs.example` a bien une barre de tête,
 *      et mène pourtant à un AUTRE domaine : c'est une URL relative au protocole. C'est le
 *      contournement classique du test naïf « ça commence par une barre ».
 *
 *   3. pas de `/\` — LA MÊME, ÉCRITE À L'ENVERS. Plusieurs navigateurs normalisent
 *      l'antislash en barre avant de résoudre l'adresse : `/\ailleurs.example` devient
 *      `//ailleurs.example`. La clause coûte huit caractères ; l'oublier a coûté des
 *      redirections ouvertes à assez de produits pour qu'elle ne se discute pas.
 *
 *   4. pas `/login` — PAS DE BOUCLE. Se connecter pour revenir à la page de connexion, puis
 *      recommencer. Un lien bricolé à la main suffirait à l'armer.
 *
 *   5. pas `/` tout seul — RIEN À REPORTER. La racine est déjà la destination par défaut, et
 *      surtout elle ne l'est pas pour tout le monde : un DEPOT va sur `/depot`, un conducteur
 *      sur `/driver`, un veilleur sur `/vehicles`. Reporter `/` écraserait cette destination
 *      par rôle par une redirection générique.
 */

/** Le retour à retenir, ou `null` quand il n'y a rien à retenir. */
export function retourSur(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith('/')) return null;
  if (url.startsWith('//') || url.startsWith('/\\')) return null;
  if (url === '/' || url.startsWith('/login')) return null;
  return url;
}
