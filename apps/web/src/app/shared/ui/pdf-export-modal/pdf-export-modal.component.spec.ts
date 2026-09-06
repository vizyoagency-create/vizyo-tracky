import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PdfExportModalComponent } from './pdf-export-modal.component';

/**
 * ══ CE QUE LA MODALE PROMET, JUSTE AVANT LE CLIC ════════════════════════════════════════
 *
 * La modale d'export est la dernière surface lue avant qu'un PDF parte par courriel. Elle a
 * gagné quatre phrases avec le filtre conducteur (F13) — le bandeau « Filtré sur … », la
 * réserve des alertes dans l'indice de section, le suffixe « et seulement les trajets de … »
 * de l'aperçu et le rappel « des véhicules du périmètre » de l'énumération — et n'avait
 * AUCUNE spec : mesuré, les neutraliser toutes les quatre laissait la suite web au vert, au
 * test près. Le document produit, lui, est verrouillé côté API (`report-pdf.service.spec`).
 * C'est la promesse d'avant le clic, et elle seule, qui n'était tenue par rien.
 *
 * ⚠️ CHAQUE AFFIRMATION A SON TÉMOIN SANS FILTRE. Une phrase qui contient déjà le mot en
 * l'absence de filtre ne prouve rien : ce serait une assertion morte de plus.
 */

/**
 * Les membres visés sont `protected` — publics À L'EXÉCUTION. Cette porte les rend lisibles
 * au test sans élargir la visibilité du composant, qui ferait de chaque signal une API.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Interne = Record<string, any>;
const interne = (c: PdfExportModalComponent): Interne => c as unknown as Interne;
/* eslint-enable @typescript-eslint/no-explicit-any */

const vehicule = (id: string, plate: string) => ({ id, plate }) as never;

/** Douze véhicules : le plafond « top 10 » n'est alors pas rogné par le périmètre. */
const FLOTTE = Array.from({ length: 12 }, (_, i) =>
  vehicule('v' + (i + 1), 'AA-' + String(101 + i) + '-BB'));

const SOHAIB = { nom: 'Sohaib Hamanni', trajets: 'les trajets de Sohaib Hamanni' };
const SANS_CONDUCTEUR = { nom: 'Sans conducteur', trajets: 'les trajets sans conducteur' };

/** La clé de préférences est partagée par toute la page de test : on part toujours des défauts. */
const CLE_PREFS = 'tracky:export-pdf:prefs';

describe('Modale dʼexport PDF — la promesse lue juste avant le clic', () => {
  let fixture: ComponentFixture<PdfExportModalComponent>;
  let modale: Interne;
  let prefsDepart: string | null;

  /** Ouvre la modale avec (ou sans) filtre conducteur, et rend son état interne. */
  const ouvrir = (cond: { nom: string; trajets: string } | null, alertes: number | null = 12): void => {
    fixture.componentRef.setInput('vehicles', FLOTTE);
    fixture.componentRef.setInput('alertCount', alertes);
    fixture.componentRef.setInput('tripCount', 391);
    fixture.componentRef.setInput('driverFilter', cond);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
  };

  beforeEach(() => {
    prefsDepart = localStorage.getItem(CLE_PREFS);
    localStorage.removeItem(CLE_PREFS);
    TestBed.configureTestingModule({ imports: [PdfExportModalComponent] });
    fixture = TestBed.createComponent(PdfExportModalComponent);
    modale = interne(fixture.componentInstance);
  });

  afterEach(() => {
    if (prefsDepart === null) localStorage.removeItem(CLE_PREFS);
    else localStorage.setItem(CLE_PREFS, prefsDepart);
  });

  /**
   * ⚠️ LE BANDEAU VIT DANS LE GABARIT : un test qui n'interrogerait que les calculés le
   * laisserait aussi nu qu'avant. Sans lui, « Toute la flotte (12 véhicules) » se lit au pied
   * de la lettre au-dessus d'un rapport calculé sur une seule personne.
   */
  it('le bandeau nomme la personne sur laquelle lʼécran est filtré', () => {
    // Témoin : sans filtre, le bandeau n'existe pas dans le DOM.
    ouvrir(null);
    expect(fixture.nativeElement.querySelector('.pem-scope-banner--driver')).toBeNull();

    ouvrir(SOHAIB);
    const bandeau: HTMLElement = fixture.nativeElement.querySelector('.pem-scope-banner--driver');
    expect(bandeau).not.toBeNull();
    expect(bandeau.textContent).toContain('Filtré sur');
    expect(bandeau.textContent).toContain('Sohaib Hamanni');
  });

  /**
   * ⚠️ LA RAISON D'ÊTRE DU TYPE À DEUX CHAMPS, éprouvée. Le bandeau NOMME (« Sans conducteur »),
   * l'aperçu ENCHÂSSE (« et seulement les trajets sans conducteur ») : deux entrées séparées
   * auraient fini par se contredire, et c'est l'aperçu — la dernière ligne lue — qui mentirait.
   */
  it('sous « Sans conducteur », le bandeau nomme et lʼaperçu enchâsse', () => {
    ouvrir(SANS_CONDUCTEUR);
    const bandeau: HTMLElement = fixture.nativeElement.querySelector('.pem-scope-banner--driver');
    expect(bandeau.textContent).toContain('Sans conducteur');
    expect(modale['previewSentence']()).toContain('portant uniquement sur les trajets sans conducteur');
    expect(modale['previewSentence']()).not.toContain('Sans conducteur, quel que soit');
  });


  /**
   * ⚠️ LA PHRASE NE DOIT PLUS SE DÉMENTIR ELLE-MÊME.
   *
   * Relevé par le propriétaire sur une capture d'écran, et il avait raison :
   *
   *   « pour toute la flotte (7 véhicules), et seulement les trajets de Sohaib Hamanni »
   *
   * Les deux moitiés disent le contraire l'une de l'autre. Et « toute la flotte » y est
   * doublement trompeur : mesuré en production, Sohaib n'a conduit qu'UN véhicule sur sept
   * — le document ne montrera jamais les six autres. C'est la DERNIÈRE ligne lue avant de
   * cliquer : elle ne peut pas être celle qui embrouille.
   */
  it('sous filtre conducteur, lʼaperçu ne dit JAMAIS « toute la flotte »', () => {
    ouvrir(SOHAIB);
    const phrase: string = modale['previewSentence']();

    expect(phrase).toContain('portant uniquement sur les trajets de Sohaib Hamanni');
    expect(phrase).toContain('quel que soit le véhicule');
    expect(phrase).not.toContain('toute la flotte');
    // Le témoin : SANS filtre, « toute la flotte » reste la bonne formule.
    ouvrir(null);
    expect(modale['previewSentence']()).toContain('toute la flotte');
  });

  it('conducteur ET sélection de véhicules : le véhicule restreint, il ne contredit pas', () => {
    ouvrir(SOHAIB);
    modale['onScopeSelected']();
    modale['onToggleVehicle']('v1');
    fixture.detectChanges();

    const phrase: string = modale['previewSentence']();
    expect(phrase).toContain('portant uniquement sur les trajets de Sohaib Hamanni');
    expect(phrase).toContain('et parmi eux ceux faits avec');
    expect(phrase).not.toContain('quel que soit le véhicule');
  });

  /**
   * ⚠️ L'EXCEPTION DES ALERTES, DITE AVANT LA COCHE (décision assumée). Une alerte appartient à
   * un VÉHICULE : cette section ne suit pas le filtre. Les QUATRE branches de `alertCount`
   * concatènent la même réserve — en oublier une la ferait disparaître pour un compte
   * particulier, exactement le genre d'angle mort que ce lot ferme ailleurs.
   */
  it('lʼindice de la section Alertes porte sa réserve dans les quatre branches', () => {
    for (const n of [null, 0, 1, 12]) {
      ouvrir(null, n);
      expect(modale['alertsHint']()).not.toContain('appartiennent à un véhicule');

      ouvrir(SOHAIB, n);
      const indice: string = modale['alertsHint']();
      expect(indice).toContain('appartiennent à un véhicule');
      expect(indice).toContain('ne suit pas le filtre');
      expect(indice).toContain('les véhicules du périmètre');
    }
  });

  /**
   * ⚠️ LE SUFFIXE DE L'APERÇU DANS LES DEUX BRANCHES DE PÉRIMÈTRE. Le bogue naturel est de ne
   * recoller le suffixe que sur « Toute la flotte » : « pour EP-047-TY » resterait alors muet
   * sur le conducteur, sur le chemin le plus utilisé après un filtre véhicule.
   */
  it('lʼaperçu dit le conducteur, que le périmètre soit la flotte ou une sélection', () => {
    ouvrir(null);
    expect(modale['previewSentence']()).not.toContain('portant uniquement sur');

    ouvrir(SOHAIB);
    expect(modale['scope']()).toBe('all');
    expect(modale['previewSentence']()).toContain('portant uniquement sur les trajets de Sohaib Hamanni');

    modale['onScopeSelected']();
    modale['onToggleVehicle']('v1');
    fixture.detectChanges();
    expect(modale['scope']()).toBe('selected');
    expect(modale['previewSentence']()).toContain('portant uniquement sur les trajets de Sohaib Hamanni');
  });

  /**
   * ⚠️ ET L'ÉNUMÉRATION, qui suit immédiatement « et seulement les trajets de X » : « les 12
   * alertes » s'y relisait « ses 12 alertes ». C'est la quatrième surface, la plus exposée.
   */
  it('lʼénumération rattache les alertes aux véhicules, pas à la personne', () => {
    ouvrir(null);
    expect(modale['previewSentence']()).toContain('les 12 alertes');
    expect(modale['previewSentence']()).not.toContain('alertes des véhicules du périmètre');

    ouvrir(SOHAIB);
    expect(modale['previewSentence']()).toContain('les 12 alertes des véhicules du périmètre');
  });

  /**
   * ⚠️ LA CASE « TOP VÉHICULES » COMMANDE AUSSI LE CLASSEMENT NOMINATIF. Le document couple
   * délibérément les deux (le récapitulatif « Par conducteur ou groupe » sort sous la section
   * `topVehicles`, et c'est testé dans les deux sens côté API) ; ce qui ne suivait pas, c'est la
   * promesse. Le gestionnaire cochait un palmarès de véhicules et recevait, EN PLUS, un
   * classement de PERSONNES avec leurs excès et leur pire dépassement, sur un document qui part
   * par courriel — et, symétriquement, décocher jetait la nouveauté du lot sans un mot.
   */
  it('la case « Top véhicules » annonce le récapitulatif par conducteur ou groupe', () => {
    ouvrir(null);

    const indice: string = modale['topHint']();
    expect(indice).toContain('par conducteur ou groupe');
    expect(indice).toContain('excès');
    expect(indice).toContain('non attribués');

    // La dernière ligne lue avant le clic le nomme elle aussi.
    expect(modale['previewSentence']())
      .toContain('le top 10 des véhicules et le même récapitulatif par conducteur ou groupe');

    // Témoin : la case décochée, ni le palmarès ni le classement nominatif ne sont annoncés —
    // et c'est bien la MÊME case qui commande les deux.
    modale['includeTopVehicles'].set(false);
    fixture.detectChanges();
    expect(modale['previewSentence']()).not.toContain('par conducteur ou groupe');
    expect(modale['previewSentence']()).not.toContain('le top 10 des véhicules');
  });
});
