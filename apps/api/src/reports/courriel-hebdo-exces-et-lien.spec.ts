import { EmailService } from '../email/email.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE COURRIER DU LUNDI : UNE LIGNE POUR LES EXCÈS, ET UN BOUTON QUI MÈNE AU RAPPORT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Deux manques sur le seul document que la plupart des gestionnaires ouvrent vraiment :
 *
 *   1. les EXCÈS n'existaient que dans la pièce jointe. Sur un téléphone, le lundi matin,
 *      c'est le résumé qu'on lit — et il parlait de trajets, de kilomètres, d'alertes et de
 *      carburant, jamais de dépassements ;
 *   2. le seul bouton ouvrait le TABLEAU DE BORD. Un courrier intitulé « rapport
 *      hebdomadaire » obligeait donc à refaire à la main la période qu'on venait de lire.
 */
function service() {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const config: any = { get: () => 'https://app-tracky.vizyoagency.com' };
  return new EmailService(config, {} as any, {} as any, {} as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const BASE = {
  fromStr: '01/09/2026', toStr: '07/09/2026',
  tripsCount: 430, totalKm: 9543.1, alertsTotal: 20,
  liters: 2745.1, costEur: 4941.09,
  pdfName: 'tracky-rapport-2026-09-01_2026-09-07.pdf',
};

describe('Courriel hebdomadaire — la ligne des excès', () => {
  it('affiche le compte quand il y en a', () => {
    const html = service().buildWeeklyReportEmail({ ...BASE, speedingCount: 271 });

    expect(html).toContain('271');
    expect(html).toContain('excès de vitesse');
  });

  it('⚠️ se tait à zéro — ce courrier part à TOUTES les sociétés', () => {
    // Une ligne « 0 excès » chaque lundi serait un reproche sans objet. Même règle que la
    // ligne des non attribués, muette elle aussi quand il n'y a rien à signaler.
    const html = service().buildWeeklyReportEmail({ ...BASE, speedingCount: 0 });

    expect(html).not.toContain('excès de vitesse');
  });

  it('se tait aussi quand le compte n’est pas fourni', () => {
    const html = service().buildWeeklyReportEmail(BASE);

    expect(html).not.toContain('excès de vitesse');
  });

  it('renvoie vers la pièce jointe plutôt que d’étaler le détail', () => {
    // ⚠️ UNE LIGNE, pas une cinquième tuile : la grille en compte quatre, et ce courrier se
    // lit en trois secondes. Le détail par véhicule et par conducteur est dans le PDF.
    const html = service().buildWeeklyReportEmail({ ...BASE, speedingCount: 271 });

    expect(html).toContain('pièce jointe');
  });
});

describe('Courriel hebdomadaire — le bouton mène au rapport', () => {
  it('ouvre la page Rapports sur la période du document', () => {
    const html = service().buildWeeklyReportEmail({
      ...BASE, lienRapport: '/reports?from=2026-09-01&to=2026-09-08',
    });

    expect(html).toContain('https://app-tracky.vizyoagency.com/reports?from=2026-09-01&to=2026-09-08');
    expect(html).toContain('Ouvrir le rapport');
    expect(html).not.toContain('Ouvrir le tableau de bord');
  });

  it('sans lien fourni, le tableau de bord reste le repli', () => {
    const html = service().buildWeeklyReportEmail(BASE);

    expect(html).toContain('https://app-tracky.vizyoagency.com/dashboard');
  });

  /**
   * ⚠️ REDIRECTION OUVERTE : un gabarit d'e-mail n'a aucune raison de faire confiance à ce
   * qu'on lui passe. `//evil.example` est un chemin valide pour un navigateur — il mène à un
   * AUTRE domaine — et ce courrier part à tous les clients de toutes les sociétés.
   */
  it('refuse un chemin qui sortirait du domaine', () => {
    for (const mechant of ['//evil.example/vol', 'https://evil.example', 'reports', '']) {
      const html = service().buildWeeklyReportEmail({ ...BASE, lienRapport: mechant });

      expect(html).toContain('https://app-tracky.vizyoagency.com/dashboard');
      expect(html).not.toContain('evil.example');
    }
  });
});
