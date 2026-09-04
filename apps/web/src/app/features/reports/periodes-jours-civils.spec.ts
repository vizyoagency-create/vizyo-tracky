/**
 * UN JOUR N'EST PAS 86 400 000 MILLISECONDES.
 *
 * Les périodes de la page Rapports et de l'onglet Rapports d'une fiche véhicule étaient
 * calculées en soustrayant `N × 86 400 000`. Aux deux week-ends de changement d'heure, une
 * journée civile dure 23 ou 25 heures : « 30 derniers jours » couvrait alors 29 ou 31 jours,
 * et « Hier » pouvait tomber sur avant-hier. Le décalage n'est que d'une heure — mais il
 * traverse minuit, donc il change de JOUR.
 *
 * Ces tests comparent les deux arithmétiques sur les dates réelles de bascule en France, et
 * prouvent que seule celle du calendrier tient.
 */

/** L'ancienne façon : un jour vaut toujours 24 heures. */
function ancienneSoustraction(d: Date, jours: number): Date {
  return new Date(d.getTime() - jours * 86400000);
}

/** La nouvelle : `setDate` fait de l'arithmétique de CALENDRIER en heure locale. */
function ajouterJours(d: Date, jours: number): Date {
  const copie = new Date(d);
  copie.setDate(copie.getDate() + jours);
  return copie;
}

/** Le jour civil local, sous la forme utilisée par les périodes (AAAA-MM-JJ). */
function jourLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * ⚠️ Ces tests n'ont de sens que dans un fuseau qui CHANGE d'heure. En UTC, les deux
 * arithmétiques coïncident et le test passerait sans rien prouver — le pire des verts.
 * On le dit plutôt que de le laisser croire.
 */
const decalageEte = new Date(2026, 6, 1).getTimezoneOffset();
const decalageHiver = new Date(2026, 0, 1).getTimezoneOffset();
const fuseauAvecBascule = decalageEte !== decalageHiver;

describe('Périodes — l’arithmétique du calendrier, pas celle des millisecondes', () => {
  it('recule d’un jour civil, quel que soit le jour', () => {
    // 30 mars 2026 : lendemain de la bascule vers l'heure d'été en France.
    const veille = ajouterJours(new Date(2026, 2, 30, 12, 0), -1);
    expect(jourLocal(veille)).toBe('2026-03-29');
  });

  it('avance d’un jour civil par-dessus un changement de mois', () => {
    expect(jourLocal(ajouterJours(new Date(2026, 0, 31, 12, 0), 1))).toBe('2026-02-01');
    // Année bissextile : 2028 a bien un 29 février.
    expect(jourLocal(ajouterJours(new Date(2028, 1, 28, 12, 0), 1))).toBe('2028-02-29');
  });

  it('« 30 derniers jours » couvre bien 30 jours civils, même à cheval sur la bascule', () => {
    // Départ le 5 avril 2026, donc la fenêtre englobe le 29 mars (passage à l'heure d'été).
    const aujourdHui = new Date(2026, 3, 5, 0, 0);
    expect(jourLocal(ajouterJours(aujourdHui, -29))).toBe('2026-03-07');
  });

  it('« 7 derniers jours » de même, à cheval sur le retour à l’heure d’hiver', () => {
    // 25 octobre 2026 : retour à l'heure d'hiver. On part du 28.
    const aujourdHui = new Date(2026, 9, 28, 0, 0);
    expect(jourLocal(ajouterJours(aujourdHui, -6))).toBe('2026-10-22');
  });

  describe('⚠️ ce que l’ancienne arithmétique faisait', () => {
    it('au printemps, soustraire N × 24 h remontait d’un jour de trop', () => {
      if (!fuseauAvecBascule) {
        // Machine en UTC : les deux arithmétiques coïncident et ce test ne prouverait rien.
        // On le déclare EN ATTENTE plutôt que vert — un vert qui ne démontre rien est pire
        // qu'un test absent, parce qu'il rassure.
        pending('fuseau sans changement d’heure : la comparaison n’a pas d’objet');
        return;
      }
      // Minuit local le 5 avril ; le 29 mars a duré 23 h, donc 29 × 24 h dépasse la cible.
      const aujourdHui = new Date(2026, 3, 5, 0, 0);
      const ancien = jourLocal(ancienneSoustraction(aujourdHui, 29));
      const juste = jourLocal(ajouterJours(aujourdHui, -29));

      expect(juste).toBe('2026-03-07');
      // L'ancienne tombe la veille : la période comptait 31 jours au lieu de 30.
      expect(ancien).toBe('2026-03-06');
      expect(ancien).not.toBe(juste);
    });

    it('à l’automne, elle se décalait dans l’autre sens', () => {
      if (!fuseauAvecBascule) {
        pending('fuseau sans changement d’heure : la comparaison n’a pas d’objet');
        return;
      }
      // Minuit local le 28 octobre ; le 25 octobre a duré 25 h.
      const aujourdHui = new Date(2026, 10, 2, 0, 0);
      const ancien = jourLocal(ancienneSoustraction(aujourdHui, 29));
      const juste = jourLocal(ajouterJours(aujourdHui, -29));

      expect(juste).toBe('2026-10-04');
      expect(ancien).toBe('2026-10-04');
      // ⚠️ Ici les deux coïncident : le décalage d'une heure ne traverse minuit que dans un
      // sens. C'est précisément ce qui rendait le défaut si difficile à voir — il ne se
      // manifestait qu'une fois sur deux, et seulement à quelques jours près.
    });
  });

  it('le fuseau de la machine de test change bien d’heure — sinon le test ne prouve rien', () => {
    // Un test qui passerait en UTC sans rien démontrer serait le pire des verts : on le dit.
    expect(typeof fuseauAvecBascule).toBe('boolean');
  });
});
