import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { CONDUCTEUR_AUCUN } from '@vizyo/tracky-shared';
import { DriversApiService } from '../../core/services/drivers.service';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { PreferencesService } from '../../core/services/preferences.service';
import { ReportsApiService } from '../../core/services/reports.service';
import { TripsApiService } from '../../core/services/trips.service';
import { ReportsComponent, trajetHorsPerimetreConducteur } from './reports.component';

/**
 * ══ CE QUE L'ÉCRAN AFFIRME SOUS UN FILTRE CONDUCTEUR (F13, seconde moitié) ══════════════
 *
 * La page Rapports n'avait aucune spec de composant : les quatre suites livrées avec ce lot
 * sont toutes côté API. C'est précisément ce qui a laissé passer les défauts relus ici — ils
 * ne vivent ni dans un `where` Prisma ni dans un DTO, mais dans ce que l'écran DIT, dans les
 * gestes qu'il offre (ou n'offre plus) et dans ce qu'il oublie de recharger.
 *
 * Chaque test verrouille une correction et tomberait sans elle ; c'est écrit au-dessus de
 * chacun.
 */

/** Un conducteur du menu, réduit à ce que `driverOptions` en lit. */
const conducteur = (id: string, firstName: string, lastName: string) =>
  ({ id, firstName, lastName, fleetId: null }) as never;

/**
 * Les membres visés sont `protected` — c'est-à-dire publics À L'EXÉCUTION : TypeScript ne les
 * protège qu'à la compilation. Cette porte les rend lisibles au test sans relâcher la visibilité
 * du composant, ce qui ferait de chaque signal interne une surface d'API.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Interne = Record<string, any>;
const interne = (c: ReportsComponent): Interne => c as unknown as Interne;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('Filtre conducteur — la règle qui décide si une ligne peut rester affichée', () => {
  /**
   * ⚠️ VERROUILLE LA CORRECTION DU CONSTAT « affecter un conducteur depuis le tableau filtré ne
   * recharge rien ». Sans elle, `onDriverPickedForTrip` rustinait la ligne en mémoire et la
   * laissait dans une liste dont elle ne faisait plus partie — vingt trajets nommés sous un
   * en-tête « Sans conducteur », au-dessus de compteurs qui ne les avaient jamais comptés.
   * Cette fonction est la règle nue : rendre `false` partout, c'est le défaut d'origine.
   */
  it('sans filtre, aucune ligne ne sort jamais du périmètre', () => {
    expect(trajetHorsPerimetreConducteur('', null)).toBe(false);
    expect(trajetHorsPerimetreConducteur('', 'd1')).toBe(false);
  });

  it('« Sans conducteur » : la ligne sort dès quʼelle en gagne un', () => {
    expect(trajetHorsPerimetreConducteur(CONDUCTEUR_AUCUN, 'd1')).toBe(true);
    // Retirer le conducteur d'un trajet qui n'en avait pas : rien ne change, elle reste.
    expect(trajetHorsPerimetreConducteur(CONDUCTEUR_AUCUN, null)).toBe(false);
  });

  it('filtre nominatif : la ligne sort si on retire son conducteur ou si on le change', () => {
    expect(trajetHorsPerimetreConducteur('d1', null)).toBe(true);
    expect(trajetHorsPerimetreConducteur('d1', 'd2')).toBe(true);
    // Réaffecter la MÊME personne ne déplace rien : le rustinage en mémoire y reste juste.
    expect(trajetHorsPerimetreConducteur('d1', 'd1')).toBe(false);
  });
});

describe('Page Rapports — ce que lʼécran dit et offre sous filtre conducteur', () => {
  let ecran: Interne;

  const SOHAIB = 'aaaa1111-1111-4111-8111-111111111111';

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ReportsComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    // ⚠️ Aucun `detectChanges()` : `ngOnInit` lit l'URL et lance quatre chargements. Ce qui est
    // éprouvé ici est l'ÉTAT de l'écran, pas son démarrage — les signaux sont posés à la main.
    ecran = interne(TestBed.createComponent(ReportsComponent).componentInstance);
  });

  /**
   * ⚠️ VERROUILLE LA NORMALISATION DE `libelleVueProposee` (famille « l'écran valide une forme
   * normalisée mais compare la forme brute »). Sans elle, la proposition « Reprendre votre
   * dernier rapport » annonce « un conducteur » pour une vue mémorisée en `NONE`, pendant que
   * `reprendreVue` applique, lui, la forme canonique : le libellé et le clic ne décrivent pas
   * le même filtre.
   */
  it('« Reprendre votre dernier rapport » nomme le filtre même écrit en majuscules', () => {
    ecran['drivers'].set([conducteur(SOHAIB, 'Sohaib', 'Hamanni')]);

    ecran['vueProposee'].set('driver=NONE');
    expect(ecran['libelleVueProposee']()).toBe('sans conducteur');

    ecran['vueProposee'].set(`driver=${SOHAIB.toUpperCase()}`);
    expect(ecran['libelleVueProposee']()).toBe('Sohaib Hamanni');

    // Témoin : une valeur qui n'est pas une forme acceptée ne nomme rien du tout.
    ecran['vueProposee'].set('driver=tous');
    expect(ecran['libelleVueProposee']()).toBe('vos derniers filtres');
  });

  /**
   * ⚠️ VERROUILLE `oublierStatsPeriode()` DANS `reprendreVue`. Sans lui, la synthèse remplie au
   * démarrage — NON filtrée — restait affichée sous le nom du conducteur repris : le carburant,
   * le parc actif, les alertes et le récapitulatif de TOUTE la société, à côté des mentions de
   * ce lot qui, elles, affirment le filtre.
   */
  it('reprendre une vue oublie la synthèse du périmètre précédent', () => {
    ecran['statsPeriode'].set({ trips: { count: 15 } });
    ecran['vueProposee'].set(`driver=${SOHAIB}`);

    ecran['reprendreVue']();

    expect(ecran['statsPeriode']()).toBeNull();
    expect(ecran['selectedDriverId']()).toBe(SOHAIB);
  });

  /**
   * ⚠️ MÊME VERROU, SUR LES DEUX GESTES QUI POSENT RÉELLEMENT LE FILTRE. `reprendreVue` était
   * le seul tenu — le chemin que presque personne n'emprunte. Or `chargerStatsPeriode` ne vide
   * rien à l'entrée : sans `oublierStatsPeriode()`, la synthèse du parc ENTIER reste affichée
   * pendant tout l'aller-retour, non signalée comme partielle (`recapPartiel` la voit non
   * nulle), sous le nom de la personne et sous « Périmètre limité aux trajets de … ». Mesuré :
   * ces deux méthodes n'étaient exécutées par AUCUN des 509 tests du front.
   *
   * ⚠️ `filtrerSurConducteur` sort tôt si le conducteur est DÉJÀ sélectionné : ne pas pré-poser
   * SOHAIB, sinon le test passerait sans rien exercer — une seconde assertion morte.
   */
  it('choisir un conducteur au menu oublie la synthèse du périmètre précédent', () => {
    ecran['statsPeriode'].set({ trips: { count: 622 } });

    ecran['onSelectDriver'](SOHAIB);

    expect(ecran['statsPeriode']()).toBeNull();
    expect(ecran['selectedDriverId']()).toBe(SOHAIB);
  });

  it('« Filtrer » depuis le récapitulatif oublie la synthèse du périmètre précédent', () => {
    ecran['statsPeriode'].set({ trips: { count: 622 } });

    ecran['filtrerSurConducteur'](SOHAIB);

    expect(ecran['statsPeriode']()).toBeNull();
    expect(ecran['selectedDriverId']()).toBe(SOHAIB);
  });

  /**
   * ⚠️ VERROUILLE LE NOM RETENU AU CLIC. `GET /drivers` ne rend que les conducteurs ACTIFS,
   * `/reports/stats` nomme aussi les archivés : le bouton « Filtrer » du récapitulatif offre
   * donc, d'un clic ordinaire, un identifiant absent du menu. Et `filtrerSurConducteur` vide la
   * synthèse dans la MÊME instruction qui pose le filtre — c'est-à-dire la source du repli de
   * `selectedDriverLabel`. Sans la mémoire, six surfaces annoncent « Conducteur » : le bouton du
   * menu, la mention des exports, la note du récapitulatif, l'en-tête d'impression, le bandeau
   * de la modale PDF et sa phrase d'aperçu — pendant que le PDF, lui, imprime le vrai nom
   * résolu en base. DÉFINITIVEMENT si la synthèse échoue.
   *
   * ⚠️ C'est l'appel RÉEL à `filtrerSurConducteur` qui fait la preuve : poser le filtre à la
   * main passe déjà aujourd'hui, ce serait une assertion morte.
   */
  it('« Filtrer » sur un conducteur archivé garde son nom, même sans synthèse', () => {
    ecran['drivers'].set([]); // archivé : absent de GET /drivers
    ecran['statsPeriode'].set({
      trips: { count: 12 },
      byAttribution: [{
        key: `driver:${SOHAIB}`, label: 'Sohaib Hamanni', kind: 'driver',
        tripCount: 12, distanceKm: 340.2, durationHours: 6.5, avgSpeedKmh: 52,
        speedingCount: 40, speedingTripCount: 7, worstOverKmh: 55,
      }],
    });
    // Témoin de départ : le repli par le récapitulatif fonctionne tant qu'il est là.
    ecran['selectedDriverId'].set(SOHAIB);
    expect(ecran['selectedDriverLabel']()).toBe('Sohaib Hamanni');
    ecran['selectedDriverId'].set('');

    ecran['filtrerSurConducteur'](SOHAIB);

    expect(ecran['statsPeriode']()).toBeNull();          // la synthèse est bien oubliée…
    expect(ecran['selectedDriverLabel']()).toBe('Sohaib Hamanni');  // … et le nom survit
    expect(ecran['conducteurPourExport']()).toEqual({
      nom: 'Sohaib Hamanni', trajets: 'les trajets de Sohaib Hamanni',
    });
    expect(ecran['noteRecapConducteur']()).toContain('aux trajets de Sohaib Hamanni');
  });

  /**
   * ⚠️ ET LE SOUVENIR EST CLÉ PAR SON IDENTIFIANT : sans cela, il survivrait au filtre suivant
   * et nommerait quelqu'un d'autre — un mensonge pire que « Conducteur », parce que crédible.
   *
   * ⚠️ Le second filtre est posé SANS repasser par le bouton « Filtrer » : c'est ce que font la
   * vue mémorisée et la relecture d'URL, et c'est le seul chemin qui laisse le souvenir en
   * place. Enchaîner deux « Filtrer » ne prouverait rien — le second réécrit la mémoire, donc
   * l'assertion passerait même sans la clé : une assertion morte de plus.
   */
  it('le nom retenu ne déteint jamais sur le conducteur suivant', () => {
    const AUTRE = 'bbbb2222-2222-4222-8222-222222222222';
    ecran['drivers'].set([]);
    ecran['statsPeriode'].set({
      trips: { count: 12 },
      byAttribution: [{
        key: `driver:${SOHAIB}`, label: 'Sohaib Hamanni', kind: 'driver',
        tripCount: 12, distanceKm: 340.2, durationHours: 6.5, avgSpeedKmh: 52,
        speedingCount: 40, speedingTripCount: 7, worstOverKmh: 55,
      }],
    });

    ecran['filtrerSurConducteur'](SOHAIB);
    expect(ecran['selectedDriverLabel']()).toBe('Sohaib Hamanni');

    ecran['selectedDriverId'].set(AUTRE);

    expect(ecran['selectedDriverLabel']()).toBe('Conducteur');
  });

  /**
   * ⚠️ VERROUILLE LA NOTE DE LA CARTE « ALERTES » — la décision assumée (a). Une alerte
   * appartient à un VÉHICULE : ce compte ne suit PAS le filtre. Sans cette phrase, « 12 »
   * s'affiche muet sous un nom propre — ce n'est plus un chiffre, c'est une accusation. Le PDF
   * porte la même phrase et elle Y est testée (exports-filtre-conducteur.spec.ts) ; l'écran se
   * taisait là où le papier parle.
   *
   * Le `toBeNull()` d'ouverture n'est pas décoratif : il ferme le SECOND sens de la garde —
   * inversée, la note ne disparaît pas seulement sous filtre, elle apparaît SANS filtre et y
   * écrit « … ne sont pas filtrées sur Tous les conducteurs ».
   */
  it('la carte des alertes dit que ce compte ne suit pas le filtre conducteur', () => {
    expect(ecran['noteAlertesConducteur']()).toBeNull();

    ecran['selectedDriverId'].set(CONDUCTEUR_AUCUN);
    const note: string = ecran['noteAlertesConducteur']() ?? '';
    expect(note).toContain('appartiennent à un véhicule');
    expect(note).toContain('ne suivent pas le filtre');
    expect(note).toContain('les véhicules du périmètre');

    ecran['drivers'].set([conducteur(SOHAIB, 'Sohaib', 'Hamanni')]);
    ecran['selectedDriverId'].set(SOHAIB);
    expect(ecran['noteAlertesConducteur']()).toContain('Sohaib Hamanni');
  });

  /**
   * ⚠️ VERROUILLE LA NOTE DE LA CARTE « PARC ACTIF ». Contrairement aux alertes, ce compte SUIT
   * le filtre — et c'est justement pourquoi il faut le dire : « immobile » n'y veut plus dire
   * « n'a pas roulé » mais « n'a pas roulé AVEC cette personne ». Le chiffre reste vrai, sa
   * lecture change, et une lecture tacite se prend pour un fait.
   */
  it('la carte du parc actif redit ce que « immobile » veut dire sous filtre', () => {
    expect(ecran['noteParcConducteur']()).toBeNull();

    ecran['selectedDriverId'].set(CONDUCTEUR_AUCUN);
    expect(ecran['noteParcConducteur']()).toContain('aucun trajet sans conducteur');

    ecran['drivers'].set([conducteur(SOHAIB, 'Sohaib', 'Hamanni')]);
    ecran['selectedDriverId'].set(SOHAIB);
    const note: string = ecran['noteParcConducteur']() ?? '';
    expect(note).toContain('immobile');
    expect(note).toContain('aucun trajet avec Sohaib Hamanni');
  });

  /**
   * ⚠️ VERROUILLE LE FIL ÉCRAN → SERVEUR, le cœur de ce lot. `loadData()` est le SEUL point du
   * composant qui lance les quatre routes d'un coup, donc le seul endroit où une assertion
   * prouve que la liste et les agrégats décrivent la MÊME population. Mesuré avant correction :
   * retirer `summaryParams['driverId']` ou le `driverId` de l'appel `stats()` laissait la suite
   * web ENTIÈRE au vert, pendant que l'écran continuait d'imprimer « Périmètre limité aux
   * trajets de Sohaib Hamanni » au-dessus de compteurs, de courbes et d'une synthèse redevenus
   * ceux de toute la société — la récidive littérale du « 622 au compteur, 100 au tableau ».
   *
   * Les paramètres sont lus sur la REQUÊTE émise, pas sur un espion : le fil traverse ainsi
   * `buildFilterParams`, `trips.service` ET `reports.service`, dont aucun n'avait d'observateur.
   */
  it('le filtre conducteur part dans les QUATRE requêtes, pas seulement celle du tableau', async () => {
    const http = TestBed.inject(HttpTestingController);
    // `chargerStatsPeriode` ne demande rien sans période, et `periodePrecedente` n'accepte que
    // des JOURS civils — la forme que la page pose réellement (cf. `periods()`). Un horodatage
    // complet ferait taire la cinquième requête, et l'assertion sur la tendance serait morte.
    ecran['periodFrom'] = '2026-09-01';
    ecran['periodTo'] = '2026-10-01';
    ecran['selectedDriverId'].set(SOHAIB);

    // Pas d'`await` ici : les deux premières requêtes doivent être servies pour que `loadData`
    // enchaîne sur les graphiques, la synthèse et la période précédente.
    const fini = ecran['loadData']();
    const trajets = http.expectOne((r) => r.url === '/api/trips');
    // Capturée AVANT l'attente : `chargerPeriodePrecedente` en émettra une seconde ensuite.
    const resume = http.expectOne((r) => r.url === '/api/trips/daily-summary');
    trajets.flush({ items: [], nextCursor: null });
    resume.flush([]);
    await fini;

    const courbes = http.expectOne((r) => r.url === '/api/trips/period-charts');
    const synthese = http.expectOne((r) => r.url === '/api/reports/stats');
    for (const r of [trajets, resume, courbes, synthese]) {
      expect(r.request.params.get('driverId')).toBe(SOHAIB);
    }
    // La période PRÉCÉDENTE porte le même filtre, sinon la tendance compare une personne à
    // toute la flotte — un chiffre faux et parfaitement crédible.
    const precedente = http.match((r) => r.url === '/api/trips/daily-summary');
    expect(precedente.length).toBe(1);
    expect(precedente[0]!.request.params.get('driverId')).toBe(SOHAIB);
  });

  /**
   * ⚠️ VERROUILLE LE FILET DU MENU (constats « le bouton Filtrer pose un filtre dont le seul
   * contrôle peut ne pas exister » et « plus aucun aria-selected dans le listbox »). Un
   * conducteur archivé est nommé par /reports/stats mais absent de GET /drivers : sans ce
   * calculé, le listbox n'avait plus AUCUNE option sélectionnée pendant que le bouton, lui,
   * annonçait le nom — et le menu entier disparaissait quand c'était le seul de la société.
   */
  it('un conducteur filtré absent de la liste est reconnu comme hors liste', () => {
    ecran['drivers'].set([conducteur(SOHAIB, 'Sohaib', 'Hamanni')]);

    // Personne de filtré : rien à signaler.
    expect(ecran['conducteurHorsListe']()).toBe(false);

    // Un conducteur DE la liste : il porte lui-même la coche du menu.
    ecran['selectedDriverId'].set(SOHAIB);
    expect(ecran['conducteurHorsListe']()).toBe(false);

    // Le mot-clé : c'est l'option « Sans conducteur » qui porte la coche, pas une personne.
    ecran['selectedDriverId'].set(CONDUCTEUR_AUCUN);
    expect(ecran['conducteurHorsListe']()).toBe(false);

    // Un archivé (ou l'identifiant d'une autre société) : absent du menu, filtre pourtant posé.
    ecran['selectedDriverId'].set('bbbb2222-2222-4222-8222-222222222222');
    expect(ecran['conducteurHorsListe']()).toBe(true);
  });

  /**
   * ⚠️ VERROUILLE LA CINQUIÈME NOTE — celle de la carte « Carburant estimé ». Un passage en
   * station est un arrêt du VÉHICULE : la table qui les porte n'a pas de conducteur, et le
   * serveur GARDE donc ce prix et ce compte sur le périmètre véhicule sous filtre (le
   * neutraliser ferait écrire « Aucun prix relevé en station », ce qui serait faux). Sans
   * cette phrase, « … sur 12 passages » s'affichait muet sous un nom propre : douze pleins
   * attribués en silence à quelqu'un qui n'en a peut-être fait aucun. Ses deux cartes voisines
   * disaient déjà la leur, ce qui rendait ce silence encore plus trompeur.
   */
  it('la carte carburant dit que le prix constaté en station ne suit pas le filtre', () => {
    ecran['statsPeriode'].set({ consumption: { observedPriceEurL: 1.712, observedSampleCount: 12 } });

    // Personne de filtré : rien à expliquer, et une note permanente serait du bruit.
    expect(ecran['noteCarburantConducteur']()).toBeNull();

    ecran['selectedDriverId'].set(CONDUCTEUR_AUCUN);
    const note: string = ecran['noteCarburantConducteur']() ?? '';
    expect(note).toContain('arrêts du véhicule');
    expect(note).toContain('ne suivent pas le filtre');
    // La part qui SUIT le filtre est nommée : sans elle, le lecteur croit la carte entière
    // hors filtre, alors que le coût estimé ne compte que les kilomètres de cette personne.
    expect(note).toContain('les litres valorisés');

    ecran['drivers'].set([conducteur(SOHAIB, 'Sohaib', 'Hamanni')]);
    ecran['selectedDriverId'].set(SOHAIB);
    expect(ecran['noteCarburantConducteur']()).toContain('Sohaib Hamanni');

    // Aucun prix relevé : la phrase d'à côté dit déjà tout, la note se tait.
    ecran['statsPeriode'].set({ consumption: { observedPriceEurL: null, observedSampleCount: 0 } });
    expect(ecran['noteCarburantConducteur']()).toBeNull();
  });

  /**
   * ⚠️ VERROUILLE LA MENTION D'EXPORT. Elle accrochait l'exception au SEUL « CSV alertes » :
   * nommer une exception fait lire l'énumération comme complète, et le lecteur en concluait que
   * la section « Alertes » du PDF, elle, suivait le filtre — alors qu'elle porte le compte de
   * tout le périmètre véhicule (décision assumée), sur un document qui part par courriel.
   */
  it('la mention des exports dit que les ALERTES ne suivent jamais le filtre, PDF compris', () => {
    expect(ecran['noteExportsConducteur']()).toBeNull();

    ecran['selectedDriverId'].set(CONDUCTEUR_AUCUN);
    const note: string = ecran['noteExportsConducteur']() ?? '';
    expect(note).toContain('les trajets sans conducteur');
    expect(note).toContain('ne suivent jamais ce filtre');
    expect(note).toContain('Alertes');
    expect(note).toContain('les véhicules du périmètre');
  });

  /**
   * ⚠️ VERROUILLE LA QUATRIÈME NOTE. Le lot en avait écrit trois (alertes, parc actif, exports)
   * et laissé muette la carte où le rétrécissement est le plus spectaculaire : filtrée sur une
   * personne, elle ne contient plus qu'UNE ligne, la mention de troncature ne se déclenche pas
   * (rien n'est tronqué), et un classement de flotte à une ligne se lit « il n'y a qu'une
   * personne qui roule ».
   */
  it('le récapitulatif annonce son périmètre dès quʼun conducteur est filtré', () => {
    expect(ecran['noteRecapConducteur']()).toBeNull();

    ecran['selectedDriverId'].set(CONDUCTEUR_AUCUN);
    expect(ecran['noteRecapConducteur']()).toContain('aux trajets sans conducteur');
    // Sous « none » la carte garde des lignes de GROUPE : annoncer « une seule ligne » serait faux.
    expect(ecran['noteRecapConducteur']()).toContain('aucune ligne de conducteur');

    ecran['drivers'].set([conducteur(SOHAIB, 'Sohaib', 'Hamanni')]);
    ecran['selectedDriverId'].set(SOHAIB);
    expect(ecran['noteRecapConducteur']()).toContain('aux trajets de Sohaib Hamanni');
  });

  /**
   * ⚠️ VERROUILLE LE DÉNOMINATEUR DE « N TRAJETS SUR M ». Sous « Sans conducteur », le total suit
   * le filtre alors que le numérateur — « ni conducteur, ni groupe » — en est un sous-ensemble
   * qui ne bouge pas : la part passait de 33 % à 83 % sur les mêmes trajets. Cette mention est
   * une boîte à part, avec son role="status" : elle est lue seule, donc elle doit être vraie
   * seule — la note d'en-tête de la carte ne la couvre pas.
   */
  it('sous « Sans conducteur », le dénominateur des non-attribués nomme sa population', () => {
    expect(ecran['libelleDenominateurTrajets']()).toBe('');

    ecran['selectedDriverId'].set(CONDUCTEUR_AUCUN);
    expect(ecran['libelleDenominateurTrajets']()).toBe(' trajets sans conducteur');

    // Sous un conducteur nommé, le numérateur vaut zéro et la mention ne s'affiche pas :
    // qualifier le dénominateur y serait du bruit.
    ecran['drivers'].set([conducteur(SOHAIB, 'Sohaib', 'Hamanni')]);
    ecran['selectedDriverId'].set(SOHAIB);
    expect(ecran['libelleDenominateurTrajets']()).toBe('');
  });
});

/**
 * ══ LE FILTRE QUI ARRIVE SANS CLIC ══════════════════════════════════════════════════════
 *
 * Les deux SEULES portes par lesquelles un filtre conducteur entre dans l'état de l'écran sans
 * qu'on ait touché le menu : l'URL au démarrage, et la vue mémorisée. La forme partagée tolère
 * les blancs et la casse ; l'écran, lui, compare avec `===` et renvoie la valeur telle quelle
 * aux quatre routes. Poser la valeur BRUTE, c'était :
 *   - « %20none » jugée valide puis envoyée partout — 400 sur la liste (son DTO ne trime pas)
 *     pendant que les compteurs, les graphiques et la synthèse répondaient 200 filtrés : un
 *     écran, deux populations, ce que ce filtre existe précisément pour empêcher ;
 *   - « NONE » accepté partout par le serveur mais affiché « Conducteur » à l'écran, sous un
 *     PDF qui imprimait au même moment « Trajets sans conducteur ».
 *
 * Ces tests posent donc les formes NON canoniques et exigent la forme canonique en sortie.
 */
describe('Page Rapports — le filtre conducteur qui arrive sans clic', () => {
  const SOHAIB = 'aaaa1111-1111-4111-8111-111111111111';
  let urlDepart: string;

  /**
   * Monte l'écran comme le ferait `/rapports?driver=<valeur>` et joue son `ngOnInit`.
   *
   * `resetTestingModule` : le paramètre voyage par un fournisseur, donc chaque valeur demande
   * son propre module — et un module déjà instancié ne se reconfigure pas.
   */
  const ouvrirAvecUrl = (driver: string): Interne => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ReportsComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DriversApiService, useValue: { list: () => Promise.resolve([]) } },
        // La seule chose que `ngOnInit` lit de la route — et déjà décodée, comme le fait
        // Angular : « ?driver=%20none » arrive ici sous la forme ' none'.
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ driver }) } },
        },
      ],
    });
    const ecran = interne(TestBed.createComponent(ReportsComponent).componentInstance);
    ecran['ngOnInit']();
    return ecran;
  };

  beforeEach(() => { urlDepart = window.location.href; });

  afterEach(() => {
    // `ngOnInit` reporte l'état dans la barre d'adresse, partagée par toute la page de test.
    window.history.replaceState(window.history.state, '', urlDepart);
  });

  it('lʼURL de départ pose la forme canonique, jamais la brute', () => {
    // L'espace de trop d'une adresse recopiée : validée par la forme partagée, refusée par le
    // DTO de la liste. Ce qui est POSÉ ici est ce qui partira dans les quatre requêtes.
    expect(ouvrirAvecUrl(' none')['selectedDriverId']()).toBe(CONDUCTEUR_AUCUN);

    const majuscules = ouvrirAvecUrl('NONE');
    expect(majuscules['selectedDriverId']()).toBe(CONDUCTEUR_AUCUN);
    expect(majuscules['selectedDriverLabel']()).toBe('Sans conducteur');

    // Un UUID en majuscules : le serveur le résout (colonne @db.Uuid), l'écran ne le
    // retrouvait pas dans `driverOptions` — dont les identifiants viennent de la base.
    const ecran = ouvrirAvecUrl(SOHAIB.toUpperCase());
    expect(ecran['selectedDriverId']()).toBe(SOHAIB);

    // Témoin : une valeur qui n'est pas une forme acceptée ne pose aucun filtre.
    expect(ouvrirAvecUrl('tous')['selectedDriverId']()).toBe('');
  });

  it('la vue mémorisée pose la forme canonique, jamais la brute', () => {
    const ecran = ouvrirAvecUrl('');
    ecran['vueProposee'].set('driver=NONE');
    ecran['reprendreVue']();
    expect(ecran['selectedDriverId']()).toBe(CONDUCTEUR_AUCUN);
    expect(ecran['selectedDriverLabel']()).toBe('Sans conducteur');
  });

  /**
   * ⚠️ VERROUILLE LE MENU LUI-MÊME, tel qu'il est RENDU — les deux constats précédents ne
   * portaient que sur des calculés. Sans `|| conducteurFiltre()` à sa garde, le menu n'existe
   * pas dans le DOM dès que la liste est vide (conducteur archivé seul de la société, 403 sur
   * /drivers, lien ouvert dans une société sans conducteur) : le filtre reste posé, actif, et
   * plus rien à l'écran ne permet de l'ôter — sauf « Réinitialiser », qui emporte la période
   * et le tri. Et sans l'entrée « hors liste », le `role="listbox"` n'a AUCUN
   * `aria-selected="true"` pendant que le bouton, lui, annonce un nom.
   */
  it('un filtre posé sans conducteur dans la liste garde un menu, avec une option cochée', () => {
    TestBed.configureTestingModule({
      imports: [ReportsComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DriversApiService, useValue: { list: () => Promise.resolve([]) } },
      ],
    });
    const fixture = TestBed.createComponent(ReportsComponent);
    const ecran = interne(fixture.componentInstance);
    fixture.detectChanges();

    // `GET /drivers` n'a rien rendu, et le filtre vient du bouton « Filtrer » du récapitulatif.
    ecran['drivers'].set([]);
    ecran['selectedDriverId'].set('bbbb2222-2222-4222-8222-222222222222');
    ecran['driverDropdownOpen'].set(true);
    fixture.detectChanges();

    const menu: HTMLElement | null = fixture.nativeElement.querySelector('#rep-menu-conducteur');
    expect(menu).not.toBeNull();
    expect(menu!.querySelectorAll('[role="option"][aria-selected="true"]').length).toBe(1);
  });
});

/**
 * ══ CE QUE L'ÉCRAN REND VRAIMENT SOUS FILTRE ════════════════════════════════════════════
 *
 * Les describes précédents éprouvent des `computed` ; ceux-ci éprouvent le DOM, parce que les
 * trois défauts qu'ils tiennent vivent dans le GABARIT : une phrase de flotte laissée telle
 * quelle sous un nom propre, un motif inventé dans le menu, et un focus qui tombe sur le corps
 * du document.
 */
describe('Page Rapports — ce que lʼécran REND sous filtre conducteur', () => {
  const SOHAIB = 'aaaa1111-1111-4111-8111-111111111111';
  const ARCHIVE = 'bbbb2222-2222-4222-8222-222222222222';
  let urlDepart: string;

  /** L'agrégat de période, réduit à ce que la grille de synthèse en lit. */
  const synthese = () => ({
    fleet: { name: 'Vizyo Transport' },
    trips: { count: 22, totalKm: 318, totalDurationHours: 5.6, avgKmBasisVehicles: 2 },
    consumption: {
      estimatedCostEur: 210, estimatedLiters: 124, fuelPriceEurL: 1.69, estimatedCo2Kg: 290,
      observedPriceEurL: null, observedSampleCount: 0, estimatedCostAtObservedEur: 0,
      idleSecondsTotal: 0,
    },
    // Le cas de production : 39 véhicules au contrat, 2 conduits par cette personne.
    vehicles: {
      total: 39, activeDuringPeriod: 2, idleTotal: 37,
      idleVehicles: [
        { vehicleId: 'v1', plate: 'AA-111-BB', group: null, silencieux: false },
        { vehicleId: 'v2', plate: 'CC-222-DD', group: { name: 'Livraisons' }, silencieux: false },
      ],
    },
    alerts: { total: 12, byType: [] },
    topVehicles: [],
    byAttribution: [],
    byAttributionTotal: 0,
    unattributedTrips: { tripCount: 0, distanceKm: 0, durationHours: 0 },
  });

  /**
   * Monte l'écran, joue son premier rendu, et rend la paire (fixture, accès interne).
   *
   * `listeConducteurs` décide de l'état de `GET /drivers` : résolue, ou jamais résolue —
   * c'est-à-dire l'état exact du premier rendu d'un lien partagé.
   */
  const monter = (
    listeConducteurs: () => Promise<unknown>,
    driver = '',
  ): [ComponentFixture<ReportsComponent>, Interne] => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ReportsComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DriversApiService, useValue: { list: listeConducteurs } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ driver }) } },
        },
      ],
    });
    const fixture = TestBed.createComponent(ReportsComponent);
    fixture.detectChanges();
    return [fixture, interne(fixture.componentInstance)];
  };

  /** La carte « Parc actif » / « Véhicules conduits / parc », retrouvée par son intitulé. */
  const carteParc = (fixture: ComponentFixture<ReportsComponent>): string => {
    const cartes: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.rep-synthese-card'),
    );
    const carte = cartes.find((c) => /parc/i.test(c.querySelector('h2')?.textContent ?? ''));
    return (carte?.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  beforeEach(() => { urlDepart = window.location.href; });

  afterEach(() => {
    // `ngOnInit` et `onSelectDriver` reportent l'état dans la barre d'adresse, partagée par
    // toute la page de test.
    window.history.replaceState(window.history.state, '', urlDepart);
  });

  /**
   * ⚠️ VERROUILLE LES DEUX GESTES DE LA CARTE « PARC ACTIF » : l'intitulé ET les phrases.
   *
   * Sous filtre, le numérateur ne compte que les véhicules que ce filtre a fait rouler, le
   * dénominateur reste le parc entier. « Parc actif sur la période / 5 % du parc a roulé au
   * moins une fois / 37 véhicules n'ont fait aucun trajet : AA-111-BB, CC-222-DD » était donc
   * FAUX de bout en bout : ces 37 véhicules ont roulé, hors de ce filtre. Et la dernière phrase
   * NOMME des plaques — c'est la donnée sur laquelle se décide une mutualisation ou une
   * restitution. Le PDF, sur les mêmes chiffres, renomme son libellé (« Véhicules conduits /
   * parc ») avant de l'expliquer : les deux surfaces se contredisaient.
   *
   * ⚠️ L'assertion qui compte est l'ABSENCE de la phrase NUE : exiger la présence de la note
   * aurait été satisfait par le code d'avant, qui la portait déjà.
   */
  it('la carte du parc qualifie ses phrases dès quʼun conducteur est filtré', () => {
    const [fixture, ecran] = monter(() => Promise.resolve([]));

    // ── Témoin, sans filtre : les phrases de flotte sont justes telles quelles.
    ecran['statsPeriode'].set(synthese());
    fixture.detectChanges();
    let texte = carteParc(fixture);
    expect(texte).toContain('Parc actif sur la période');
    expect(texte).toContain('5 % du parc a roulé au moins une fois.');
    expect(texte).toContain('fait aucun trajet :');
    expect(texte).not.toContain('Véhicules conduits / parc');

    // ── Sous un conducteur nommé.
    ecran['drivers'].set([conducteur(SOHAIB, 'Sohaib', 'Hamanni')]);
    ecran['selectedDriverId'].set(SOHAIB);
    fixture.detectChanges();
    texte = carteParc(fixture);
    expect(texte).toContain('Véhicules conduits / parc');
    expect(texte).not.toContain('Parc actif sur la période');
    expect(texte).toContain('5 % du parc a roulé avec Sohaib Hamanni au moins une fois.');
    expect(texte).toContain('fait aucun trajet avec Sohaib Hamanni :');
    // Les deux phrases NUES ont disparu : c'est là toute la correction.
    expect(texte).not.toContain('du parc a roulé au moins une fois');
    expect(texte).not.toContain('fait aucun trajet :');

    // ── Et sous « Sans conducteur », l'autre forme du filtre, où le défaut existait aussi.
    ecran['selectedDriverId'].set(CONDUCTEUR_AUCUN);
    fixture.detectChanges();
    texte = carteParc(fixture);
    expect(texte).toContain('5 % du parc a roulé sans conducteur au moins une fois.');
    expect(texte).toContain('fait aucun trajet sans conducteur :');
  });

  /**
   * ⚠️ ET LA BRANCHE SANS AUCUN IMMOBILE, qui affirmait « tout le parc a servi » — vrai sans
   * filtre, muet sous filtre sur ce qui a réellement été mesuré.
   */
  it('la carte du parc dit aussi sous quel filtre elle ne trouve aucun immobile', () => {
    const [fixture, ecran] = monter(() => Promise.resolve([]));
    const stats = synthese();
    stats.vehicles.idleTotal = 0;
    stats.vehicles.idleVehicles = [];
    ecran['statsPeriode'].set(stats);
    fixture.detectChanges();
    expect(carteParc(fixture)).toContain('Aucun véhicule immobile : tout le parc a servi.');

    ecran['drivers'].set([conducteur(SOHAIB, 'Sohaib', 'Hamanni')]);
    ecran['selectedDriverId'].set(SOHAIB);
    fixture.detectChanges();
    const texte = carteParc(fixture);
    expect(texte).toContain('Tout le parc a roulé avec Sohaib Hamanni au moins une fois');
    expect(texte).not.toContain('tout le parc a servi');
  });

  /**
   * ⚠️ VERROUILLE LE MOTIF DU MENU. « absente de la liste » n'est pas « liste absente » :
   * `ngOnInit` pose le conducteur lu de l'URL PUIS lance `loadDrivers()`, et entre les deux
   * `driverOptions()` est vide. Le menu affirmait donc « archivé, ou hors de cette société »
   * pour une personne parfaitement ACTIVE de la société affichée — à chaque ouverture d'un lien
   * « /rapports?driver=… », et DÉFINITIVEMENT après un 403 sur une route qui exige une
   * permission distincte de celle de la page. Un motif fabriqué à partir d'une absence.
   *
   * ⚠️ L'assertion porte sur le TEXTE, jamais sur le compte d'`aria-selected` : celui-ci est
   * déjà tenu par le test voisin, et le reprendre ici ne prouverait rien de neuf.
   */
  it('le menu ne dit « archivé » que lorsque la liste a répondu', async () => {
    // ── A. La liste n'a pas répondu (premier rendu d'un lien partagé, ou 403).
    const [enCours, ecranA] = monter(() => new Promise<never[]>(() => { /* jamais servie */ }), SOHAIB);
    ecranA['driverDropdownOpen'].set(true);
    enCours.detectChanges();
    const menuA: HTMLElement = enCours.nativeElement.querySelector('#rep-menu-conducteur');
    expect(menuA.textContent).toContain('liste des conducteurs indisponible');
    expect(menuA.textContent).not.toContain('archivé');

    // ── B. La liste a répondu, vide : le conducteur filtré est réellement hors d'elle.
    const [servie, ecranB] = monter(() => Promise.resolve([]), ARCHIVE);
    await Promise.resolve();
    await Promise.resolve();
    ecranB['driverDropdownOpen'].set(true);
    servie.detectChanges();
    const menuB: HTMLElement = servie.nativeElement.querySelector('#rep-menu-conducteur');
    expect(menuB.textContent).toContain('archivé, ou hors de cette société');
    expect(menuB.textContent).not.toContain('indisponible');
  });

  /**
   * ⚠️ VERROUILLE LE FOCUS AU CLAVIER. La garde du menu conducteur est
   * « driverOptions().length > 0 || conducteurFiltre() » : choisir « Tous les conducteurs »
   * dans un menu SANS option rend les deux branches fausses, et la détection de changements qui
   * suit retire le bloc — déclencheur compris — pendant que `fermerMenuConducteur` vient de lui
   * rendre le focus. Le focus retombait sur `<body>` : l'utilisateur au clavier repartait du
   * haut du document. Le geste réussit, mais il coûtait la position de navigation, et seulement
   * sur ce troisième menu — les deux autres ne sont jamais démontés par leur propre sélection.
   */
  it('retirer le dernier filtre depuis un menu sans option garde le focus dans la barre', () => {
    const [fixture, ecran] = monter(() => Promise.resolve([]));
    ecran['drivers'].set([]);
    ecran['selectedDriverId'].set(ARCHIVE);
    // Le déclencheur voisin porte [disabled]="vehiclesLoading()" : un bouton désactivé ne prend
    // pas le focus. Ici les véhicules sont arrivés, comme sur un écran en usage.
    ecran['vehiclesLoading'].set(false);
    ecran['driverDropdownOpen'].set(true);
    fixture.detectChanges();

    const declencheur: HTMLButtonElement = fixture.nativeElement
      .querySelector('button[aria-controls="rep-menu-conducteur"]');
    declencheur.focus();
    expect(document.activeElement).toBe(declencheur);

    const options: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('#rep-menu-conducteur [role="option"]'),
    );
    const tous = options.find((b) => (b.textContent ?? '').includes('Tous les conducteurs'));
    tous!.click();
    fixture.detectChanges();

    // Le bloc a bien disparu — c'est la situation même que la garde ouvre.
    expect(fixture.nativeElement.querySelector('button[aria-controls="rep-menu-conducteur"]'))
      .toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(fixture.nativeElement.contains(document.activeElement)).toBe(true);
  });
});

/**
 * ══ AFFECTER UN CONDUCTEUR DEPUIS LE TABLEAU FILTRÉ ═════════════════════════════════════
 *
 * Le geste que le filtre « Sans conducteur » existe pour servir — 1 905 trajets sur 1 956 chez
 * « mh cars ». Le handler rustinait la ligne en mémoire et ne rejouait rien : elle restait
 * affichée avec un nom sous un en-tête « Sans conducteur », au-dessus de compteurs, de courbes
 * et d'une synthèse qui décrivaient toujours la population d'avant le clic — et d'une modale
 * PDF qui annonçait un compte périmé pour un document qui, lui, était recalculé serveur.
 */
describe('Page Rapports — affecter un conducteur sous filtre conducteur', () => {
  let ecran: Interne;
  let trajetRendu: unknown;

  const SOHAIB = 'aaaa1111-1111-4111-8111-111111111111';
  const trajet = (id: string, driverId: string | null) => ({
    id,
    driver: driverId ? { id: driverId, firstName: 'Sohaib', lastName: 'Hamanni' } : null,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ReportsComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: DriversApiService,
          useValue: {
            list: () => Promise.resolve([]),
            assignToTrip: () => of(trajetRendu),
          },
        },
      ],
    });
    ecran = interne(TestBed.createComponent(ReportsComponent).componentInstance);
  });

  /**
   * ⚠️ VERROUILLE LE RETRAIT DE LA LIGNE ET L'OUBLI DE LA SYNTHÈSE. Sans eux, `trips()` garde
   * les deux lignes (dont une nommée) et `statsPeriode()` garde la synthèse d'avant : c'est
   * exactement l'état que le constat décrit.
   */
  it('sous « Sans conducteur », la ligne affectée quitte la liste et la synthèse est oubliée', async () => {
    trajetRendu = trajet('t1', SOHAIB);
    ecran['selectedDriverId'].set(CONDUCTEUR_AUCUN);
    ecran['trips'].set([trajet('t1', null), trajet('t2', null)]);
    ecran['statsPeriode'].set({ trips: { count: 55 } });
    ecran['driverPickerTrip'].set(trajet('t1', null));

    await ecran['onDriverPickedForTrip']({ id: SOHAIB, firstName: 'Sohaib', lastName: 'Hamanni' });

    expect(ecran['trips']().map((t: { id: string }) => t.id)).toEqual(['t2']);
    expect(ecran['statsPeriode']()).toBeNull();
  });

  /**
   * ⚠️ ET LE SYMÉTRIQUE : retirer le conducteur sous un filtre nominatif sort le trajet de SA
   * liste. Sans la correction, la ligne y restait, avec un bouton « Assigner » à la place du nom.
   */
  it('sous un conducteur nommé, retirer le conducteur sort la ligne de sa liste', async () => {
    trajetRendu = trajet('t1', null);
    ecran['selectedDriverId'].set(SOHAIB);
    ecran['trips'].set([trajet('t1', SOHAIB), trajet('t2', SOHAIB)]);
    ecran['driverPickerTrip'].set(trajet('t1', SOHAIB));

    await ecran['onDriverPickedForTrip'](null);

    expect(ecran['trips']().map((t: { id: string }) => t.id)).toEqual(['t2']);
  });

  /**
   * ⚠️ ET LE TÉMOIN, qui protège le confort existant : SANS filtre conducteur, le rustinage en
   * mémoire reste juste — la ligne ne change pas de population, et recharger renverrait le
   * tableau à sa première page pour rien.
   */
  it('sans filtre conducteur, la ligne est mise à jour sur place et la synthèse reste', async () => {
    trajetRendu = trajet('t1', SOHAIB);
    ecran['selectedDriverId'].set('');
    ecran['trips'].set([trajet('t1', null), trajet('t2', null)]);
    ecran['statsPeriode'].set({ trips: { count: 55 } });
    ecran['driverPickerTrip'].set(trajet('t1', null));

    await ecran['onDriverPickedForTrip']({ id: SOHAIB, firstName: 'Sohaib', lastName: 'Hamanni' });

    expect(ecran['trips']().map((t: { id: string }) => t.id)).toEqual(['t1', 't2']);
    expect(ecran['trips']()[0].driver.id).toBe(SOHAIB);
    expect(ecran['statsPeriode']()).not.toBeNull();
  });

  /**
   * ⚠️ ET LA PORTE D'À CÔTÉ, RESTÉE OUVERTE : MÊME SANS AUCUN FILTRE, LE RÉCAPITULATIF SE PÉRIME.
   *
   * La ligne reste dans le tableau (test précédent), mais elle vient de changer de CAMP dans la
   * carte « Par conducteur ou groupe » : elle passe de `unattributedTrips` à `byAttribution`. Le
   * « N trajets sur M ni conducteur, ni groupe » et sa part en pourcentage décrivaient donc
   * l'état d'AVANT le clic — et c'est LE geste que cette carte sert à provoquer (1 866 trajets
   * sur 1 886 sans imputation chez « mh cars »). Sans la correction, `stats` n'est jamais
   * rappelé et ce test tombe.
   */
  it('sans filtre, affecter un conducteur rejoue la synthèse — et ELLE SEULE', async () => {
    const reportsApi = TestBed.inject(ReportsApiService);
    const stats = spyOn(reportsApi, 'stats').and.returnValue(of({ trips: { count: 55 } }) as never);
    // Le résumé journalier et les graphiques comptent des trajets et des kilomètres : sans
    // filtre conducteur, une affectation n'en change pas un seul. Les rejouer serait deux
    // allers-retours pour un résultat identique.
    const resumeJournalier = spyOn(TestBed.inject(TripsApiService), 'dailySummary');

    trajetRendu = trajet('t1', SOHAIB);
    ecran['selectedDriverId'].set('');
    // `chargerStatsPeriode` ne demande rien sans période : c'est ce qui rend les trois tests
    // ci-dessus muets côté réseau, et ce qu'il faut poser ici pour atteindre la requête.
    ecran['periodFrom'] = '2026-09-01T00:00:00.000Z';
    ecran['periodTo'] = '2026-09-30T00:00:00.000Z';
    ecran['trips'].set([trajet('t1', null), trajet('t2', null)]);
    ecran['statsPeriode'].set({ trips: { count: 55 } });
    ecran['driverPickerTrip'].set(trajet('t1', null));

    await ecran['onDriverPickedForTrip']({ id: SOHAIB, firstName: 'Sohaib', lastName: 'Hamanni' });

    expect(stats).toHaveBeenCalledTimes(1);
    expect(resumeJournalier).not.toHaveBeenCalled();
    // La liste, elle, ne bouge pas : renvoyer le tableau à sa première page à chaque
    // affectation rendrait inutilisable le geste même que cette carte sert.
    expect(ecran['trips']().map((t: { id: string }) => t.id)).toEqual(['t1', 't2']);
    // Et la grille n'est pas vidée : le carburant, le parc actif et les alertes ne bougent
    // pas, les faire clignoter pour un rafraîchissement de la seule imputation serait un prix
    // payé pour rien.
    expect(ecran['statsPeriode']()).not.toBeNull();
  });

  /**
   * ⚠️ LE TÉMOIN DE LA PORTE : réaffecter la MÊME personne ne change aucune imputation, donc ne
   * redemande rien. Sans ce garde, tout clic sur le nom déjà affiché coûterait un aller-retour.
   */
  it('réaffecter la même personne ne redemande pas la synthèse', async () => {
    const stats = spyOn(TestBed.inject(ReportsApiService), 'stats').and.returnValue(of({}) as never);

    trajetRendu = trajet('t1', SOHAIB);
    ecran['selectedDriverId'].set('');
    ecran['periodFrom'] = '2026-09-01T00:00:00.000Z';
    ecran['periodTo'] = '2026-09-30T00:00:00.000Z';
    ecran['trips'].set([trajet('t1', SOHAIB)]);
    ecran['driverPickerTrip'].set(trajet('t1', SOHAIB));

    await ecran['onDriverPickedForTrip']({ id: SOHAIB, firstName: 'Sohaib', lastName: 'Hamanni' });

    expect(stats).not.toHaveBeenCalled();
  });
});

/**
 * ══ CHANGEMENT DE SOCIÉTÉ ═══════════════════════════════════════════════════════════════
 *
 * Le sélecteur de société ne navigue pas : il pose un signal. L'effet remettait bien les trois
 * filtres à zéro EN MÉMOIRE, mais la barre d'adresse et la vue mémorisée gardaient le `driver=`
 * du client qu'on venait de quitter — et le F5 réflexe rouvrait le rapport borné sur une
 * personne qui n'appartient pas à la nouvelle société : zéro ligne, pour un parc qui roule.
 */
describe('Page Rapports — bascule de société', () => {
  const AUTRE_CONDUCTEUR = 'cccc3333-3333-4333-8333-333333333333';
  let urlDepart: string;

  beforeEach(() => {
    urlDepart = window.location.href;
    TestBed.configureTestingModule({
      imports: [ReportsComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DriversApiService, useValue: { list: () => Promise.resolve([]) } },
      ],
    });
  });

  afterEach(() => {
    // La barre d'adresse est partagée par toute la page de test : on la rend telle qu'on l'a prise.
    window.history.replaceState(window.history.state, '', urlDepart);
  });

  /**
   * ⚠️ VERROUILLE `ecrireEtatDansUrl()` + L'OUBLI DE LA VUE MÉMORISÉE DANS L'EFFET DE SOCIÉTÉ.
   * Sans eux, `driver=` reste dans l'URL et dans `reportsLastView` : le filtre revient au
   * rechargement, ou par « Reprendre votre dernier rapport ».
   */
  it('efface le conducteur de lʼURL ET de la vue mémorisée', () => {
    const fleetFilter = TestBed.inject(FleetFilterService);
    const preferences = TestBed.inject(PreferencesService);
    fleetFilter.set('societe-a');

    const fixture = TestBed.createComponent(ReportsComponent);
    const ecran = interne(fixture.componentInstance);
    // Premier passage de l'effet : il ne fait que mémoriser la société de départ.
    fixture.detectChanges();

    // L'écran est filtré sur un conducteur de la société A, URL et préférence à l'appui.
    ecran['selectedDriverId'].set(AUTRE_CONDUCTEUR);
    ecran['ecrireEtatDansUrl']();
    preferences.update({ reportsLastView: `driver=${AUTRE_CONDUCTEUR}` });
    expect(window.location.search).toContain(AUTRE_CONDUCTEUR);

    fleetFilter.set('societe-b');
    fixture.detectChanges();

    expect(ecran['selectedDriverId']()).toBe('');
    expect(window.location.search).not.toContain(AUTRE_CONDUCTEUR);
    expect(window.location.search).not.toContain('driver=');
    expect(preferences.prefs().reportsLastView).not.toContain(AUTRE_CONDUCTEUR);
  });
});

/**
 * ══ LE NOM DU FICHIER CSV, JUSQU'AU NAVIGATEUR ══════════════════════════════════════════
 *
 * Le serveur marque déjà ce nom avec ce que le client ne peut pas deviner : le FILTRE
 * CONDUCTEUR (« -sans-conducteur », « -conducteur-<8 caractères> ») et le « -PARTIEL » de la
 * troncature. La chaîne s'arrêtait pourtant au `Content-Disposition` : l'écran refabriquait le
 * nom, `a.download` écrasait l'en-tête, et la marque n'atteignait que les appels directs à
 * l'API. Sous « Sans conducteur » — 1 905 trajets sur 1 956 chez « mh cars » —, le gestionnaire
 * recevait donc deux fichiers de MÊME nom pour deux populations différentes, dont l'un
 * ressemble trait pour trait à l'autre (conducteur vide sur presque toutes les lignes).
 *
 * ⚠️ CE BLOC N'EST PAS DANS `core/services/` FAUTE DE PLACE, PAS PAR CHOIX : ce lot ne peut
 * créer aucun fichier, et `reports.service.ts` n'a pas de spec. C'est le maillon manquant du
 * même constat que les tests ci-dessus, il vit donc avec eux.
 */
describe('Export CSV — la marque conducteur du nom de fichier atteint le navigateur', () => {
  let api: ReportsApiService;
  let http: HttpTestingController;
  let nomsTelecharges: string[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ReportsApiService);
    http = TestBed.inject(HttpTestingController);
    nomsTelecharges = [];
    // Le seul point d'observation : la suite ne peut pas cliquer un `a[download]` sans
    // déclencher un vrai téléchargement dans le navigateur de test. `triggerDownload` est
    // `private` à la COMPILATION seulement — la porte est réelle à l'exécution.
    spyOn(api as unknown as { triggerDownload(b: Blob, n: string): void }, 'triggerDownload')
      .and.callFake((_blob: Blob, nom: string) => { nomsTelecharges.push(nom); });
  });

  afterEach(() => http.verify());

  /** Joue un export « trajets » filtré sur « Sans conducteur » et rend le nom retenu. */
  const exporter = async (contentDisposition: string | null): Promise<string> => {
    const promesse = api.downloadCsv('trips', 'f1', '2026-09-01', '2026-09-30', [], CONDUCTEUR_AUCUN);
    const requete = http.expectOne((r) => r.url === '/api/reports/csv');
    requete.flush(
      new Blob(['id\n']),
      contentDisposition
        ? { headers: new HttpHeaders({ 'Content-Disposition': contentDisposition }) }
        : {},
    );
    await promesse;
    return nomsTelecharges[0];
  };

  it('reprend le nom marqué par le serveur au lieu de le refabriquer', async () => {
    const nom = await exporter(
      'attachment; filename="tracky-trips-2026-09-01_2026-09-30-sans-conducteur.csv"; '
      + "filename*=UTF-8''tracky-trips-2026-09-01_2026-09-30-sans-conducteur.csv",
    );
    expect(nom).toBe('tracky-trips-2026-09-01_2026-09-30-sans-conducteur.csv');
  });

  it('reprend aussi le marqueur de troncature, avalé de la même façon depuis toujours', async () => {
    const nom = await exporter('attachment; filename="tracky-trips-2026-09-01_2026-09-30-PARTIEL.csv"');
    expect(nom).toBe('tracky-trips-2026-09-01_2026-09-30-PARTIEL.csv');
  });

  it("en-tête absent : le repli est le nom d'avant, jamais un nom vide", async () => {
    // Un proxy peut filtrer l'en-tête. Un `a.download` vide ferait enregistrer le fichier
    // sous « download », sans extension : le repli doit rester exactement le nom historique.
    expect(await exporter(null)).toBe('tracky-trips-2026-09-01_2026-09-30.csv');
  });

  it('en-tête mal formé : même repli, aucun nom bricolé', async () => {
    expect(await exporter('attachment')).toBe('tracky-trips-2026-09-01_2026-09-30.csv');
  });
});
