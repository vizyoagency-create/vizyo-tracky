import { teinteDeGroupe } from './group-badge.component';

/**
 * ── « CHANTIER NORD » RESTE ROUGE ───────────────────────────────────────────────────
 *
 * Le badge n'a d'utilité que si la couleur tient : on reconnaît un groupe sans le lire.
 * Une couleur tirée du rang d'affichage change au premier tri, au premier filtre, à la
 * première création — et le badge devient alors PIRE qu'inutile, puisqu'il apprend une
 * association qu'il dément à l'écran suivant.
 *
 * Ces tests verrouillent la seule propriété qui compte : même entrée, même teinte,
 * indépendamment de l'ordre.
 */
describe('teinteDeGroupe — la couleur vient de l\'identifiant', () => {
  const GROUPES = [
    'a3f1c2d4-0000-4000-8000-000000000001',
    'b7e2d3a5-0000-4000-8000-000000000002',
    'c1a4b6e7-0000-4000-8000-000000000003',
    'd9c8b7a6-0000-4000-8000-000000000004',
  ];

  it('rend la même teinte pour le même identifiant, appel après appel', () => {
    for (const id of GROUPES) {
      const attendu = teinteDeGroupe(id);
      for (let i = 0; i < 20; i += 1) expect(teinteDeGroupe(id)).toBe(attendu);
    }
  });

  it('ne dépend PAS de l\'ordre : trier la liste ne change aucune couleur', () => {
    const avant = GROUPES.map((id) => [id, teinteDeGroupe(id)] as const);
    const apres = [...GROUPES].reverse().map((id) => [id, teinteDeGroupe(id)] as const);
    for (const [id, teinte] of avant) {
      expect(apres.find(([autre]) => autre === id)?.[1]).toBe(teinte);
    }
  });

  it('n\'utilise que des jetons du système, jamais une valeur en dur', () => {
    for (const id of GROUPES) {
      expect(teinteDeGroupe(id)).toMatch(/^--texte-/);
    }
  });

  it('distribue sur plusieurs teintes — un badge monochrome ne distingue rien', () => {
    // 30 identifiants plausibles doivent toucher au moins trois teintes différentes.
    const teintes = new Set(
      Array.from({ length: 30 }, (_, i) => teinteDeGroupe(`groupe-${i}-0000-4000-8000-00000000000${i % 10}`)),
    );
    expect(teintes.size).toBeGreaterThanOrEqual(3);
  });

  it('un renommage ne change rien tant qu\'on passe l\'identifiant', () => {
    // Le repli sur le nom existe, mais il n'a pas cette propriété — d'où la consigne
    // « passez id dès que vous l'avez » dans la documentation du composant.
    const id = GROUPES[0]!;
    expect(teinteDeGroupe(id)).toBe(teinteDeGroupe(id));
    expect(teinteDeGroupe('Chantier Nord')).not.toBe(teinteDeGroupe('Chantier Sud'));
  });
});
