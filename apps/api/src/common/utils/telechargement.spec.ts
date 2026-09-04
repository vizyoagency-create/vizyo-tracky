/**
 * Le nom de fichier d'un téléchargement ne doit jamais faire tomber la réponse.
 *
 * Trouvé le 4 septembre en vérifiant le déploiement en production : le rapport de vitesse
 * répondait 500 pour le véhicule `GLA•KC•31`. Node refuse un en-tête HTTP contenant un
 * caractère hors Latin-1, et la plaque part dans le nom du fichier. Deux véhicules sur
 * quarante-quatre étaient concernés — et pour eux, TOUS les exports étaient inaccessibles,
 * y compris la pièce présentée en procédure disciplinaire.
 */
import { enTeteTelechargement, nomFichierAscii } from './telechargement';

describe('nomFichierAscii — ce qu’un en-tête accepte sans discuter', () => {
  it('remplace le caractère qui faisait tomber la réponse', () => {
    expect(nomFichierAscii('rapport-vitesse-GLA•KC•31-2026-09-04.html')).toBe('rapport-vitesse-GLA-KC-31-2026-09-04.html');
  });

  it('déplie les accents au lieu de les effacer', () => {
    // NFKD sépare la lettre de son accent ; seul l'accent, non ASCII, disparaît.
    expect(nomFichierAscii('rapport-société-août.pdf')).toBe('rapport-societe-aout.pdf');
  });

  it('neutralise ce qui casserait la SYNTAXE de l’en-tête', () => {
    expect(nomFichierAscii('a"b\\c;d.csv')).toBe('a-b-c-d.csv');
  });

  it('laisse intact un nom déjà sain', () => {
    expect(nomFichierAscii('rapport-vitesse-AB-123-CD-2026-09-04.html')).toBe('rapport-vitesse-AB-123-CD-2026-09-04.html');
  });

  it('ne rend jamais une chaîne vide — un en-tête sans nom n’ouvre rien', () => {
    expect(nomFichierAscii('•••')).toBe('-');
    expect(nomFichierAscii('')).toBe('export');
    expect(nomFichierAscii('   ')).toBe('export');
  });
});

describe('enTeteTelechargement — les deux formes de la RFC 6266', () => {
  it('donne un repli ASCII ET le nom exact', () => {
    const v = enTeteTelechargement('rapport-vitesse-GLA•KC•31.html');
    expect(v).toContain('filename="rapport-vitesse-GLA-KC-31.html"');
    expect(v).toContain("filename*=UTF-8''rapport-vitesse-GLA%E2%80%A2KC%E2%80%A231.html");
  });

  it('⚠️ la valeur produite passe le contrôle de Node, qui refusait l’ancienne', () => {
    // Le test qui compte : c'est exactement ce que faisait tomber la production.
    const nom = 'rapport-vitesse-GLA•KC•31-2026-09-04.html';
    expect(() => {
      // eslint-disable-next-line no-control-regex
      if (/[^\x00-\xFF]/.test(enTeteTelechargement(nom))) throw new TypeError('Invalid character in header content');
    }).not.toThrow();
    // Et l'écriture naïve, elle, échouerait.
    expect(/[^\x00-\xFF]/.test(`attachment; filename="${nom}"`)).toBe(true);
  });
});
