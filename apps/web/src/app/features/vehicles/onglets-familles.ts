/**
 * Le classement des onglets de la fiche véhicule en QUATRE FAMILLES (B1 § C).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI DEUX NIVEAUX                                                      │
 * │                                                                            │
 * │ Dix onglets alignés dans une rangée qui défile obligent à chercher : on ne │
 * │ voit jamais l'ensemble, et « Géofences » se trouve après « Maintenance »   │
 * │ sans qu'aucune logique ne le dise. Quatre familles rendent la carte lisible│
 * │ d'un coup d'œil.                                                           │
 * │                                                                            │
 * │ RIEN N'EST SUPPRIMÉ — la consigne est explicite. Chaque onglet reste       │
 * │ accessible ; il est seulement rangé. C'est la propriété que verrouillent   │
 * │ les tests : l'union des familles doit redonner la liste d'entrée, à        │
 * │ l'identique, pour tous les profils de permission.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Extrait du composant pour être testable sans monter la fiche véhicule entière —
 * elle demande une carte MapLibre, un socle temps réel et une dizaine de services.
 */

/** Un onglet, réduit à ce dont le classement a besoin. */
export interface OngletRangeable {
  key: string;
  label: string;
}

export interface FamilleOnglets<T extends OngletRangeable> {
  cle: 'suivi' | 'analyse' | 'securite' | 'exploitation';
  libelle: string;
  onglets: T[];
  /** Compteur remonté au niveau de la famille (les alertes non acquittées). */
  badge: number;
}

/**
 * L'ordre des clés dans une famille est l'ordre d'affichage ; l'ordre des familles est
 * celui de la fréquence d'usage — on ouvre une fiche véhicule pour voir où il est, pas
 * pour lire ses commandes.
 */
const FAMILLES = [
  { cle: 'suivi', libelle: 'Suivi', onglets: ['map', 'history'] },
  { cle: 'analyse', libelle: 'Analyse', onglets: ['reports'] },
  { cle: 'securite', libelle: 'Sécurité', onglets: ['alerts', 'surveillance', 'geofences'] },
  { cle: 'exploitation', libelle: 'Exploitation', onglets: ['maintenance', 'schedule', 'commands'] },
] as const;

const RANGEES: ReadonlySet<string> = new Set(FAMILLES.flatMap((f) => f.onglets as readonly string[]));

/**
 * Range les onglets VISIBLES (déjà filtrés par les permissions) en familles.
 *
 * ⚠️ Un onglet ajouté à la fiche sans être rangé ici rejoint « Suivi » plutôt que de
 * disparaître. C'est le point délicat : un classement qui perd ce qu'il ne connaît pas
 * transforme un oubli de rangement en perte de fonctionnalité, sans une ligne d'erreur.
 * Le classement est un confort ; l'accès est un dû.
 */
export function rangerEnFamilles<T extends OngletRangeable>(
  visibles: readonly T[],
  nbAlertes = 0,
): FamilleOnglets<T>[] {
  const orphelins = visibles.filter((t) => !RANGEES.has(t.key)).map((t) => t.key);

  return FAMILLES
    .map((f) => {
      const cles: string[] = f.cle === 'suivi' ? [...f.onglets, ...orphelins] : [...f.onglets];
      // On suit l'ordre DÉCLARÉ de la famille, pas celui de la liste d'entrée : sans
      // quoi le rangement dépendrait de l'ordre d'origine, qu'on cherche justement à
      // ne plus subir.
      const onglets = cles
        .map((cle) => visibles.find((t) => t.key === cle))
        .filter((t): t is T => t !== undefined);
      return {
        cle: f.cle,
        libelle: f.libelle,
        onglets,
        // Le compteur d'alertes remonte au niveau de la famille : replié dans
        // « Sécurité », il serait invisible tant qu'on n'a pas ouvert la famille.
        badge: onglets.some((t) => t.key === 'alerts') ? nbAlertes : 0,
      };
    })
    .filter((f) => f.onglets.length > 0);
}
