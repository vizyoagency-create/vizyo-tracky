import { rangerEnFamilles, type OngletRangeable } from './onglets-familles';

/**
 * ── « RIEN SUPPRIMÉ » ───────────────────────────────────────────────────────────────
 *
 * La consigne de `B1-PAGES.md` § C est explicite : les dix onglets sont REGROUPÉS, pas
 * réduits. C'est exactement le genre de propriété qu'un regroupement fait perdre sans
 * bruit — un onglet oublié dans la table de classement ne provoque aucune erreur, il
 * cesse simplement d'exister à l'écran, et personne ne s'en aperçoit avant que
 * quelqu'un cherche « Commandes ».
 *
 * D'où le test central : pour n'importe quel profil de permission, l'union des familles
 * doit redonner la liste d'entrée, à l'identique.
 */
describe('rangerEnFamilles — les 10 onglets en 4 familles', () => {
  const o = (key: string): OngletRangeable => ({ key, label: key });

  /** L'ensemble complet, tel qu'un administrateur de flotte le voit. */
  const TOUS = ['map', 'reports', 'history', 'alerts', 'surveillance', 'maintenance', 'geofences', 'schedule', 'commands'].map(o);

  const clesDe = (familles: { onglets: OngletRangeable[] }[]) =>
    familles.flatMap((f) => f.onglets.map((t) => t.key));

  it('ne perd aucun onglet — l\'union des familles redonne la liste d\'entrée', () => {
    const rendu = clesDe(rangerEnFamilles(TOUS));
    expect(rendu.slice().sort()).toEqual(TOUS.map((t) => t.key).slice().sort());
  });

  it('ne duplique aucun onglet — un onglet appartient à UNE famille', () => {
    const rendu = clesDe(rangerEnFamilles(TOUS));
    expect(new Set(rendu).size).toBe(rendu.length);
  });

  it('range dans les quatre familles de la spécification', () => {
    const f = rangerEnFamilles(TOUS);
    const par = Object.fromEntries(f.map((x) => [x.cle, x.onglets.map((t) => t.key)]));
    expect(par['suivi']).toEqual(['map', 'history']);
    expect(par['analyse']).toEqual(['reports']);
    expect(par['securite']).toEqual(['alerts', 'surveillance', 'geofences']);
    expect(par['exploitation']).toEqual(['maintenance', 'schedule', 'commands']);
  });

  it('ne perd rien non plus sur un profil restreint', () => {
    // Un gestionnaire sans agenda ni commandes.
    const partiel = ['map', 'reports', 'history', 'alerts', 'geofences'].map(o);
    const rendu = clesDe(rangerEnFamilles(partiel));
    expect(rendu.slice().sort()).toEqual(partiel.map((t) => t.key).slice().sort());
  });

  it('fait disparaître une famille vide plutôt que d\'ouvrir une boîte vide', () => {
    const sansSecurite = ['map', 'history', 'reports'].map(o);
    const cles = rangerEnFamilles(sansSecurite).map((f) => f.cle);
    expect(cles).not.toContain('securite');
    expect(cles).not.toContain('exploitation');
    expect(cles).toEqual(['suivi', 'analyse']);
  });

  it('RATTRAPE un onglet inconnu du classement au lieu de le perdre', () => {
    // Le scénario redouté : quelqu'un ajoute un onglet à la fiche et oublie de le
    // ranger. Sans ce repli, il disparaîtrait de l'écran sans une ligne d'erreur.
    const avecNouveau = [...TOUS, o('nouvel-onglet')];
    const rendu = clesDe(rangerEnFamilles(avecNouveau));
    expect(rendu).toContain('nouvel-onglet');
    expect(rendu.length).toBe(avecNouveau.length);
  });

  it('ne dépend pas de l\'ordre d\'entrée — c\'est ce qu\'on cherche à ne plus subir', () => {
    const melange = [...TOUS].reverse();
    const a = rangerEnFamilles(TOUS).map((f) => ({ cle: f.cle, cles: f.onglets.map((t) => t.key) }));
    const b = rangerEnFamilles(melange).map((f) => ({ cle: f.cle, cles: f.onglets.map((t) => t.key) }));
    expect(b).toEqual(a);
  });

  it('remonte le compteur d\'alertes au niveau de la famille', () => {
    // Replié dans « Sécurité », le compteur serait invisible tant qu'on n'a pas ouvert
    // la famille — c'est-à-dire au moment où il ne sert plus à rien.
    const f = rangerEnFamilles(TOUS, 6);
    expect(f.find((x) => x.cle === 'securite')?.badge).toBe(6);
    expect(f.find((x) => x.cle === 'suivi')?.badge).toBe(0);
  });

  it('le veilleur de nuit ne voit que deux onglets, dans une seule famille', () => {
    // Son périmètre est Carte + Horaires. Deux familles d'un onglet chacune seraient un
    // classement qui ne classe rien : le composant retombe alors sur la rangée plate,
    // et cette fonction se contente de dire qu'il y a deux familles.
    const veilleur = ['map', 'schedule'].map(o);
    const f = rangerEnFamilles(veilleur);
    expect(clesDe(f).slice().sort()).toEqual(['map', 'schedule']);
  });
});
