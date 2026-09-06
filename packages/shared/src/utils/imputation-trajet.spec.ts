/**
 * La règle d'imputation vit à UN seul endroit — c'est tout l'objet de ce fichier.
 *
 * Deux écrans la posent : le classement des notes (portée « conducteur ou groupe ») et le
 * récapitulatif de la page Rapports (F13). Tant qu'ils appellent cette fonction, ils ne
 * peuvent pas répondre différemment à « combien a roulé ce conducteur ce mois-ci ? ».
 */
import {
  CLE_NON_ATTRIBUE,
  CONDUCTEUR_AUCUN,
  marqueFichierConducteurDeFiltre,
  FILTRE_CONDUCTEUR_REGEX,
  cleImputationTrajet,
  normaliserFiltreConducteur,
  sorteImputation,
} from './imputation-trajet';

describe('Imputation d’un trajet — conducteur, sinon groupe, sinon personne', () => {
  it('le conducteur PRIME sur le groupe : un véhicule groupé ET conduit compte pour son conducteur', () => {
    // Sans cette priorité, les kilomètres d'un conducteur connu tomberaient dans le total de
    // son groupe, et le classement « qui conduit comment ? » serait muet là où il a une réponse.
    expect(cleImputationTrajet('d1', 'g1')).toBe('driver:d1');
    expect(cleImputationTrajet('d1', null)).toBe('driver:d1');
  });

  it('sans conducteur, le groupe du véhicule prend le relais', () => {
    // Mesuré le 2026-09-05 : 2 675 trajets sur 2 707 chez cdef31 sont dans ce cas. Sans le
    // repli, 99 % du parc serait « non attribué » et l'écran ne dirait rien de personne.
    expect(cleImputationTrajet(null, 'g1')).toBe('group:g1');
  });

  it('ni l’un ni l’autre : la clé « non attribué », qui est comptée mais jamais classée', () => {
    expect(cleImputationTrajet(null, null)).toBe(CLE_NON_ATTRIBUE);
    expect(cleImputationTrajet(undefined, undefined)).toBe(CLE_NON_ATTRIBUE);
    // Une chaîne vide n'est pas un identifiant : elle ne doit pas fabriquer « driver: ».
    expect(cleImputationTrajet('', '')).toBe(CLE_NON_ATTRIBUE);
  });

  it('la sorte se relit sur la clé — l’écran n’a pas à la deviner', () => {
    expect(sorteImputation(cleImputationTrajet('d1', 'g1'))).toBe('driver');
    expect(sorteImputation(cleImputationTrajet(null, 'g1'))).toBe('group');
    expect(sorteImputation(CLE_NON_ATTRIBUE)).toBe('non-attribue');
  });

  it('⚠️ un identifiant qui contiendrait le préfixe de l’autre ne trompe pas la lecture', () => {
    // Les identifiants sont des UUID ; la garde protège d'un futur identifiant plus libre.
    expect(sorteImputation('driver:group:x')).toBe('driver');
    expect(sorteImputation('group:driver:x')).toBe('group');
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LA FORME DU FILTRE CONDUCTEUR — une seule définition, parce que DEUX côtés la posent
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le serveur valide ce qu'il reçoit (huit routes, dont cinq lisent des paramètres bruts sans
 * DTO), et l'écran valide ce qu'il relit de l'URL avant de le renvoyer. Deux expressions
 * écrites séparément finissent par diverger, et c'est le côté le plus permissif qui gagne —
 * celui qui laisse passer.
 */
const UUID = '3f1c9a2e-5b7d-4c8e-9a1f-2d3e4b5c6a7b';

describe('normaliserFiltreConducteur — la VALEUR canonique, jamais un simple verdict', () => {
  /**
   * ⚠️ LE DÉFAUT QUE CETTE FONCTION REMPLACE. Une première version rendait un BOOLÉEN après
   * avoir testé `valeur.trim()` : les appelants validaient donc une chaîne et en posaient une
   * autre. Sur `/rapports?driver=%20none`, l'écran jugeait la valeur bonne, gardait `' none'`,
   * le réécrivait dans l'URL et le mémorisait — puis la LISTE la refusait (400) pendant que les
   * compteurs, les courbes et la synthèse répondaient 200 filtrés « sans conducteur ».
   *
   * Le test tient à ce que la fonction rende la valeur NETTOYÉE : c'est elle, et non l'entrée,
   * qui doit être posée dans l'état de l'écran et envoyée au serveur.
   */
  it('rend la valeur nettoyée, pas un verdict — c’est elle que l’appelant doit poser', () => {
    expect(normaliserFiltreConducteur(' none')).toBe('none');
    expect(normaliserFiltreConducteur('none ')).toBe('none');
    expect(normaliserFiltreConducteur(`  ${UUID}  `)).toBe(UUID);
  });

  /**
   * ⚠️ `NONE` passait partout côté serveur (l'expression porte le drapeau `i`) mais l'écran
   * compare avec `===` : le bouton affichait « Conducteur », la mention d'export promettait
   * « les trajets de Conducteur », et le PDF imprimait au même moment le vrai nom résolu en
   * base. Même faute que ci-dessus, mais en silence.
   */
  it('la casse est ramenée à la forme que les deux côtés comparent', () => {
    expect(normaliserFiltreConducteur('NONE')).toBe(CONDUCTEUR_AUCUN);
    expect(normaliserFiltreConducteur('None')).toBe(CONDUCTEUR_AUCUN);
    // Sans perte : la colonne est `@db.Uuid`, Postgres stocke et rend en minuscules — c'est
    // aussi la forme des clés `driver:<id>` construites plus haut dans ce fichier.
    expect(normaliserFiltreConducteur(UUID.toUpperCase())).toBe(UUID);
  });

  it('ce qui n’est pas une des deux formes rend `null` — y compris le vide', () => {
    for (const v of ['', '   ', 'tous', 'null', "' OR 1=1 --", `driver:${UUID}`, '12345', undefined, null]) {
      expect(normaliserFiltreConducteur(v)).toBeNull();
    }
  });

  /**
   * ⚠️ LE PIÈGE DU DRAPEAU `g`, ET POURQUOI IL A SA PLACE DANS UN TEST. Une expression globale
   * garde un curseur (`lastIndex`) entre deux appels de `test` : elle rendrait faux UN APPEL
   * SUR DEUX. Ici la même valeur est jugée par l'écran puis par le serveur, et par plusieurs
   * routes de suite — un filtre qui marche une fois sur deux serait diagnostiqué comme un
   * incident réseau avant d'être vu comme une expression régulière mal déclarée.
   */
  it('deux appels de suite sur la même valeur rendent la même chose (pas de drapeau `g`)', () => {
    expect(FILTRE_CONDUCTEUR_REGEX.global).toBe(false);
    expect(normaliserFiltreConducteur(UUID)).toBe(UUID);
    expect(normaliserFiltreConducteur(UUID)).toBe(UUID);
    expect(normaliserFiltreConducteur(CONDUCTEUR_AUCUN)).toBe(CONDUCTEUR_AUCUN);
    expect(normaliserFiltreConducteur(CONDUCTEUR_AUCUN)).toBe(CONDUCTEUR_AUCUN);
  });

  it('l’expression est ANCRÉE : un identifiant valide noyé dans du texte ne passe pas', () => {
    // Sans les ancres, `?driver=x' OR 1=1 -- <uuid>` serait accepté et descendrait dans un
    // `where` Prisma côté serveur, dans l'URL côté écran.
    expect(normaliserFiltreConducteur(`x${UUID}`)).toBeNull();
    expect(normaliserFiltreConducteur(`${UUID}x`)).toBeNull();
    expect(normaliserFiltreConducteur('none none')).toBeNull();
  });
});

/**
 * ══ LA MARQUE DU FILTRE DANS LE NOM D'UN FICHIER ════════════════════════════════════════
 *
 * Trois surfaces l'écrivent : le serveur pose le `Content-Disposition`, la modale ANNONCE le
 * nom avant le clic, et l'écran s'en sert de repli quand l'en-tête manque. Mesuré en
 * production le 2026-09-06, la modale promettait `…_2026-09-06.pdf` là où arrivait
 * `…_2026-09-06-conducteur-83c26191.pdf` : deux écritures du même format avaient divergé.
 */
describe('marqueFichierConducteurDeFiltre — une seule écriture pour trois surfaces', () => {
  const ID = '83C26191-D254-4989-A5CF-D3AA16D9802E';

  it('aucun filtre : aucune marque, le nom historique ne bouge pas', () => {
    // ⚠️ Le cas de l'immense majorité des exports. Une marque « neutre » ici renommerait
    // TOUS les fichiers que les clients reçoivent depuis toujours.
    expect(marqueFichierConducteurDeFiltre(undefined)).toBe('');
    expect(marqueFichierConducteurDeFiltre(null)).toBe('');
    expect(marqueFichierConducteurDeFiltre('')).toBe('');
    expect(marqueFichierConducteurDeFiltre('   ')).toBe('');
  });

  it('sans conducteur : la marque le dit en toutes lettres', () => {
    // Le document le plus dangereux : chez « mh cars », 1 905 trajets sur 1 956 n'ont aucun
    // conducteur, donc il ressemble trait pour trait à l'export complet.
    expect(marqueFichierConducteurDeFiltre(CONDUCTEUR_AUCUN)).toBe('-sans-conducteur');
  });

  it('un conducteur : huit caractères de son identifiant, jamais son nom', () => {
    expect(marqueFichierConducteurDeFiltre(ID.toLowerCase())).toBe('-conducteur-83c26191');
  });

  it('la casse ne fabrique pas deux noms pour le même conducteur', () => {
    // Un identifiant recopié en majuscules depuis une URL doit produire le MÊME fichier :
    // sinon deux exports de la même personne se retrouvent côte à côte sous deux noms.
    expect(marqueFichierConducteurDeFiltre(ID)).toBe(marqueFichierConducteurDeFiltre(ID.toLowerCase()));
  });

  it('les blancs autour ne changent rien non plus', () => {
    expect(marqueFichierConducteurDeFiltre(' none ')).toBe('-sans-conducteur');
  });

  it('valeur non reconnue : aucune marque, comme elle ne filtrerait rien', () => {
    // Une valeur que le serveur refuserait ne doit pas marquer un fichier qu'il rendra
    // complet — ce serait la promesse inverse de la vérité.
    expect(marqueFichierConducteurDeFiltre('tout')).toBe('');
    expect(marqueFichierConducteurDeFiltre('83c26191')).toBe('');
  });
});
