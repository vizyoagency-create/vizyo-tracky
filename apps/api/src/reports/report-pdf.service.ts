import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import {
  formatFleetDate,
  formatFleetDateShort,
  formatFleetDateTime,
  formatFleetTime,
} from '../common/utils/datetime';
import { buildExploitedScopeNotice, FleetStatsReport } from './reports-stats.service';
// `partLibelle` vient du contrat partagé, et n'a pas de copie ici : le gestionnaire ouvre
// son PDF à côté de son écran, et « 99 % » d'un côté contre « 100 % » de l'autre sur les
// MÊMES trajets se lit comme une erreur de calcul, pas comme une nuance d'arrondi.
import { libelleGraviteAlerte, libelleTypeAlerte, partLibelle } from '@vizyo/tracky-shared';

/**
 * V1.5 (Sprint L) — Generation PDF des rapports de flotte via pdfkit.
 *
 * Pas de Chromium / Puppeteer : pdfkit est ~5MB, 100% TS, controle total du
 * layout. Genere un buffer Node, le caller decide quoi en faire (download HTTP
 * ou attachment email).
 */

const COLOR_TRACKY = '#10E0A0';
const COLOR_FG = '#1f2937';
const COLOR_FG_MUTED = '#6b7280';
const COLOR_BG_ACCENT = '#ecfdf5';
// Mention « parc exploité » : ambre volontairement DOUX. Ce n'est pas une alerte
// (rien n'est cassé côté client), c'est une note de méthode sur la base de calcul.
const COLOR_BG_NOTICE = '#fffbeb';
const COLOR_FG_NOTICE = '#92400e';

export type PdfReportSection = 'kpi' | 'alerts' | 'topVehicles' | 'trips';

export const ALL_PDF_SECTIONS: PdfReportSection[] = ['kpi', 'alerts', 'topVehicles', 'trips'];

export interface PdfReportOptions {
  /** Sections a inclure. Si absent ou vide => toutes les sections. */
  sections?: PdfReportSection[];
  /** Cap sur le nombre de trajets detailles. Default 30, max 500. */
  maxTrips?: number;
  /** Cap sur le top vehicules. Default 10, max 50. */
  topN?: number;
  /** Sous-titre informatif (ex: "3 vehicules selectionnes") affiche sous le nom de flotte. */
  scopeLabel?: string;
  /** Titre sous le logo — « Rapport de flotte » par défaut, « Rapport véhicule » pour un seul. */
  title?: string;
  /**
   * ── LE CONDUCTEUR SUR LEQUEL LE DOCUMENT PORTE (F13) ────────────────────────────────
   *
   * Ex. « Conducteur : Sohaib Hamanni », ou « Trajets sans conducteur ». Absent quand aucun
   * filtre conducteur n'est demandé — un rapport de flotte n'a rien à annoncer.
   *
   * ⚠️ RENDU EN GRAS, sous le nom de la société : ce n'est pas une note de bas de page. Un
   * PDF calculé sur une seule personne et qui ne le dit pas est exactement le piège que ce
   * lot ferme — sauf qu'il voyage par courriel et ressort d'un classeur des mois plus tard,
   * quand plus personne ne peut le rapprocher de l'écran qui l'a produit.
   */
  driverLabel?: string;
}

const DEFAULT_MAX_TRIPS = 30;
const DEFAULT_TOP_N = 10;

/** Dernier jour INCLUS d'une période dont la borne haute est exclusive (lendemain minuit). */
/**
 * Ce qu'une cellule « Excès » écrit : le compte, et le pire dépassement entre parenthèses.
 *
 * ⚠️ UNE SEULE ÉCRITURE POUR LES DEUX TABLEAUX du document — le palmarès par véhicule et le
 * récapitulatif par conducteur ou groupe. Deux tableaux d'un même PDF qui compteraient la
 * même chose mais l'écriraient autrement (« 94 » ici, « 94 (+46 km/h) » là) laisseraient
 * croire à deux mesures différentes, et c'est le genre d'écart qu'on ne remarque qu'une fois
 * le document parti chez le client.
 *
 * Zéro s'écrit « 0 » tout court : « 0 (+0 km/h) » donnerait un dépassement à qui n'en a pas.
 */
function libelleExces(compte: number, pire: number): string {
  return compte === 0 ? '0' : `${compte} (+${pire.toFixed(0)} km/h)`;
}

function inclusiveEnd(toIso: string): Date {
  return new Date(new Date(toIso).getTime() - 1);
}

/**
 * ⚠️ LA TABLE DE LIBELLÉS A DÉMÉNAGÉ dans le contrat partagé (`dto/libelles-alerte`).
 *
 * Elle ne vivait qu'ici : le PDF disait « Excès de vitesse » là où le CSV et l'écran
 * écrivaient `OVERSPEED`. Un client qui lit les deux se demande, à juste titre, s'il s'agit
 * de la même chose. Ces deux fonctions ne sont plus que des alias locaux — ne PAS y remettre
 * une table, sinon les documents se remettront à diverger en silence.
 */
const alertTypeLabel = libelleTypeAlerte;
const alertSeverityLabel = libelleGraviteAlerte;

@Injectable()
export class ReportPdfService {
  generate(report: FleetStatsReport, options?: PdfReportOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const sections = this.resolveSections(options?.sections);
        const maxTrips = this.clampInt(options?.maxTrips, DEFAULT_MAX_TRIPS, 1, 500);
        const topN = this.clampInt(options?.topN, DEFAULT_TOP_N, 1, 50);

        const doc = new PDFDocument({
          size: 'A4',
          margin: 40,
          // ⚠️ bufferPages : sans lui, `bufferedPageRange()` ne connaît que la page
          //    courante — le pied de page n'était écrit que sur la dernière, et comme il
          //    était posé à 800 pt (sous la marge basse), PDFKit ouvrait une page de plus
          //    pour l'y loger : chaque rapport finissait par une page blanche.
          bufferPages: true,
          info: {
            Title: `Vizyo Tracky — Rapport ${report.fleet.name}`,
            Author: 'Vizyo Tracky',
          },
        });

        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this.renderHeader(doc, report, options?.scopeLabel, options?.title, options?.driverLabel);
        // Rendue AVANT les sections, et hors du bloc `kpi` : la base de calcul du
        // parc exploité vaut pour tout le document (top véhicules compris), et un
        // rapport dont on aurait décoché la section KPI ne doit pas perdre la
        // mention — c'est justement le chiffre qu'elle explique qui se retrouverait
        // ailleurs sans avertissement.
        this.renderExploitedScopeNotice(doc, report, options?.driverLabel);
        if (sections.has('kpi')) this.renderKpis(doc, report, options?.driverLabel);
        if (sections.has('alerts')) this.renderAlerts(doc, report, options?.driverLabel);
        if (sections.has('topVehicles')) {
          this.renderTopVehicles(doc, report, topN, options?.driverLabel);
          // ⚠️ SOUS LA MÊME SECTION QUE LE TOP VÉHICULES, ET CE N'EST PAS UN RACCOURCI.
          // À l'écran, les deux tableaux sont les DEUX FACES d'une même carte (une
          // bascule « Par véhicule » / « Par conducteur ou groupe ») : c'est le même
          // récapitulatif, posé sur une autre clé. Et surtout, un cinquième identifiant de
          // section n'atteindrait aucun lecteur : la modale d'export poste toujours la
          // liste EXPLICITE des quatre sections qu'elle connaît, et le rapport
          // hebdomadaire filtre la sienne sur `FleetReportSection` du contrat partagé —
          // le bloc serait donc absent des deux seuls chemins qui produisent des PDF.
          this.renderAttribution(doc, report, topN, options?.driverLabel);
        } else {
          // Le CLASSEMENT suit « Top véhicules » (les deux faces d'une même carte) ;
          // l'ENCART des non attribués, non — cf. `renderNonAttribues`. Exactement un
          // rendu sur chaque branche : le rapport complet reste identique au pixel.
          this.renderNonAttribues(doc, report, options?.driverLabel);
        }
        if (sections.has('trips')) this.renderRecentTrips(doc, report, maxTrips, options?.driverLabel);
        this.renderFooter(doc);

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  private resolveSections(requested: PdfReportSection[] | undefined): Set<PdfReportSection> {
    if (!requested || requested.length === 0) return new Set(ALL_PDF_SECTIONS);
    const valid = requested.filter((s): s is PdfReportSection => ALL_PDF_SECTIONS.includes(s));
    return valid.length > 0 ? new Set(valid) : new Set(ALL_PDF_SECTIONS);
  }

  private clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
    if (value == null || Number.isNaN(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
  }

  private renderHeader(
    doc: PDFKit.PDFDocument,
    report: FleetStatsReport,
    scopeLabel?: string,
    title?: string,
    driverLabel?: string,
  ): void {
    // Logo / nom Tracky en haut-gauche
    doc.fillColor(COLOR_TRACKY).fontSize(20).font('Helvetica-Bold')
      .text('Vizyo Tracky', 40, 40);
    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
      .text(title ?? 'Rapport de flotte', 40, 65);

    // Bandeau période en haut-droite.
    // ⚠️ « du … au … inclus », pas « → » : Helvetica (WinAnsi) n'a pas la flèche, elle
    //    s'imprimait « !' ». Et la borne `to` de l'API est EXCLUSIVE (lendemain minuit) :
    //    affichée telle quelle, un rapport du 3 au 9 se lisait « 03/08 → 10/08 ».
    const fromStr = formatFleetDate(report.period.from);
    const toStr = formatFleetDate(inclusiveEnd(report.period.to));
    doc.fillColor(COLOR_FG).fontSize(11).font('Helvetica')
      .text(`du ${fromStr} au ${toStr} inclus`, 340, 42, { width: 215, align: 'right' });
    doc.fillColor(COLOR_FG_MUTED).fontSize(9)
      .text(`${report.period.days} jour${report.period.days > 1 ? 's' : ''}`, 340, 60, { width: 215, align: 'right' });

    // Fleet name + sous-titre scope (ex: "3 véhicules sélectionnés")
    doc.fillColor(COLOR_FG).fontSize(16).font('Helvetica-Bold')
      .text(report.fleet.name, 40, 95);
    /**
     * ⚠️ LE PÉRIMÈTRE S'ÉCRIT LIGNE À LIGNE, ET LE TRAIT DESCEND AVEC LUI.
     *
     * Le périmètre VÉHICULE tenait sur une ligne posée à 116, sous un trait figé à 130. La
     * seconde ligne — le CONDUCTEUR (F13) — n'avait donc nulle part où aller : écrite là, elle
     * serait passée SOUS le trait, dans le corps du document. On empile ce qu'il y a à dire et
     * on repousse le trait d'autant ; sans mention, la mise en page est celle d'avant, au pixel.
     */
    let ligneY = 116;
    if (scopeLabel) {
      doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
        .text(scopeLabel, 40, ligneY);
      ligneY += 13;
    }
    if (driverLabel) {
      // GRAS et en couleur de texte pleine, pas en gris de note : ce libellé ne commente pas
      // le rapport, il dit DE QUI il parle. Un lecteur qui le survole doit le heurter.
      doc.fillColor(COLOR_FG).fontSize(9.5).font('Helvetica-Bold')
        .text(driverLabel, 40, ligneY);
      ligneY += 14;
    }

    const traitY = Math.max(130, ligneY + 1);
    doc.moveTo(40, traitY).lineTo(555, traitY).strokeColor(COLOR_TRACKY).lineWidth(1.5).stroke();
    doc.y = traitY + 15;
  }

  /**
   * Encart « parc exploité » — pourquoi la moyenne ne se divise pas par le parc entier.
   *
   * Le client relit ce rapport chaque semaine et compare les chiffres d'une semaine
   * sur l'autre. Le jour où deux boîtiers muets sortent du dénominateur, la moyenne
   * monte : sans cette phrase, la seule lecture possible est « leur outil s'est mis à
   * mentir ». Avec, il lit une méthode, des plaques, et le fait que la réintégration
   * est automatique.
   *
   * Aucune mention quand rien n'est exclu (`buildExploitedScopeNotice` renvoie null) :
   * un encart permanent deviendrait du bruit qu'on ne lit plus.
   *
   * ⚠️ `driverLabel` DESCEND JUSQU'ICI (F13). L'encart énonce la base de la moyenne ; sous
   * filtre conducteur cette base n'est plus celle du parc, et la phrase de flotte devenait
   * un faux imprimé à trois lignes du nom de la personne. Il est rendu HORS du bloc `kpi` :
   * un rapport dont on a décoché « Indicateurs clés » porte quand même cette phrase.
   */
  private renderExploitedScopeNotice(
    doc: PDFKit.PDFDocument,
    report: FleetStatsReport,
    driverLabel?: string,
  ): void {
    const notice = buildExploitedScopeNotice(report, { filtreConducteur: !!driverLabel });
    if (!notice) return;
    this.renderEncartAmbre(doc, notice);
  }

  /**
   * Un encart ambre sur toute la largeur — le fond, la hauteur mesurée, le saut de page.
   *
   * ⚠️ EXTRAIT TEL QUEL de `renderExploitedScopeNotice` le jour où un SECOND encart est
   * apparu (les trajets non attribués, F13). Deux copies de cette géométrie auraient
   * dérivé : la mesure de hauteur se fait avec la police COURANTE, et c'est précisément
   * l'oubli qui fait couper le texte par son propre fond. Les nombres sont inchangés — un
   * rapport sans filtre doit rester identique au pixel près.
   */
  private renderEncartAmbre(doc: PDFKit.PDFDocument, texte: string): void {
    const boxW = 515;
    const padX = 8;
    const textW = boxW - padX * 2;
    // heightOfString mesure avec la police COURANTE : on la fixe avant, sinon la
    // hauteur est calculée pour une autre taille et le fond coupe le texte.
    doc.fontSize(8.5).font('Helvetica');
    const boxH = doc.heightOfString(texte, { width: textW }) + 12;

    // Saut de page défensif : la mention doit rester lisible d'un bloc.
    if (doc.y + boxH > 780) doc.addPage();

    const top = doc.y;
    doc.roundedRect(40, top, boxW, boxH, 4).fill(COLOR_BG_NOTICE);
    doc.fillColor(COLOR_FG_NOTICE).fontSize(8.5).font('Helvetica')
      .text(texte, 40 + padX, top + 6, { width: textW });
    doc.y = top + boxH + 12;
  }

  /**
   * @param driverLabel présent = le rapport est filtré sur un conducteur.
   *
   * ── LA RÈGLE DE LECTURE DES INDICATEURS, ÉCRITE DANS LE DOCUMENT ──────────────────────
   *
   * Deux cartes changent de SENS sous un filtre conducteur, sans changer d'apparence :
   *
   *  • « Véhicules ayant roulé : 2 / 39 » oppose un numérateur CONDUCTEUR (les véhicules
   *    que ce filtre a fait rouler) à un dénominateur PARC. Muette, la fraction se lit
   *    « 37 véhicules sont restés au garage » — et l'encart du dessus, qui nomme les
   *    plaques dormantes, pousse activement cette lecture-là ;
   *  • « Distance moy./véhicule » divise désormais par les seuls véhicules de ce filtre
   *    (cf. `baseMoyenneIds` dans `reports-stats.service`) : sans le dire, le chiffre a
   *    silencieusement changé de base entre deux rapports.
   *
   * DEUX GESTES, PAS UN. L'INTITULÉ DE LA CARTE CHANGE, puis la phrase l'explique. Un
   * lecteur pressé ne lit que le libellé en petites capitales ; laisser « VÉHICULES AYANT
   * ROULÉ » au-dessus de « 2 / 39 » et se contenter d'un paragraphe au-dessus de la grille,
   * c'est annoter un piège au lieu de le retirer. Les intitulés filtrés tiennent tous sur
   * UNE ligne de carte (mesurés à 150 px utiles, fontSize 8) : au-delà, le libellé passerait
   * sous la valeur.
   *
   * L'écran fait désormais LES DEUX MÊMES GESTES : sa carte du parc change d'intitulé sous
   * filtre (« Véhicules conduits / parc », le libellé exact d'ici) et qualifie ses phrases,
   * en plus de porter la mention (`noteParcConducteur`). Les deux surfaces nomment donc la
   * même chose — c'est la condition pour qu'on puisse les lire côte à côte. Le papier, lui,
   * voyage par courriel et ressort d'un classeur des mois plus tard, sans écran pour le
   * démentir. Même discipline que `renderAlerts`, dont c'est le patron.
   */
  private renderKpis(doc: PDFKit.PDFDocument, report: FleetStatsReport, driverLabel?: string): void {
    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Indicateurs clés', 40, doc.y);
    doc.moveDown(0.4);

    const base = report.trips.avgKmBasisVehicles;
    if (driverLabel) {
      doc.fillColor(COLOR_FG_NOTICE).fontSize(8.5).font('Helvetica')
        .text(
          'Lecture sous filtre conducteur : « Véhicules conduits / parc » ne compte, au '
          + 'premier chiffre, que les véhicules que ce filtre a fait rouler sur la période — '
          + 'les autres ne sont pas immobiles, ils ont roulé hors de ce filtre — tandis que le '
          + 'second reste le parc total de la société. '
          // ⚠️ `base === 0` est atteignable (conducteur qui n'a pas roulé du mois) : écrire
          // « se divise par les 0 véhicules » imprimerait une division par zéro.
          + (base > 0
            ? `« Distance moy./véhicule conduit » se divise, elle, par ces ${base} `
              + `véhicule${base > 1 ? 's' : ''}, jamais par le parc.`
            : 'Aucun trajet retenu par ce filtre sur la période : la distance moyenne n’a '
              + 'pas de base et vaut 0.'),
          40, doc.y, { width: 515 },
        );
      doc.moveDown(0.5);
    }

    const kpis: { label: string; value: string }[] = [
      // « ayant roulé » et non « actifs » : l'encart du dessus peut dire, juste avant, que des
      // véhicules sont sortis du parc exploité — « 6 actifs / 6 » se lisait comme une contradiction.
      //
      // ⚠️ SOUS FILTRE, « AYANT ROULÉ » DEVIENT UN FAUX SENS : le numérateur ne compte que
      // les véhicules de CE filtre, le dénominateur reste le parc. « 1 / 4 » se lisait « un
      // seul véhicule sur quatre a roulé ce mois-ci ». Le libellé dit donc ce que chaque
      // moitié compte, et la phrase du dessus finit le travail.
      {
        label: driverLabel ? 'Véhicules conduits / parc' : 'Véhicules ayant roulé',
        value: `${report.vehicles.activeDuringPeriod} / ${report.vehicles.total}`,
      },
      { label: 'Trajets', value: report.trips.count.toString() },
      { label: 'Distance totale', value: `${report.trips.totalKm.toFixed(1)} km` },
      // La moyenne par vehicule etait absente du PDF alors que c'est elle que le
      // client compare d'une semaine sur l'autre : il la lisait ailleurs (app,
      // export) sans jamais voir sur quelle base elle etait calculee. On l'affiche
      // ici, adossee a l'encart « parc exploite » rendu juste au-dessus.
      //
      // « conduit » sous filtre : le dénominateur a changé de population (cf.
      // `baseMoyenneIds`), et ce chiffre n'existe QUE dans le PDF — aucun écran ne peut
      // dire au lecteur sur quoi on a divisé.
      {
        label: driverLabel ? 'Distance moy./véhicule conduit' : 'Distance moy./véhicule',
        value: `${report.trips.avgKmPerVehicle.toFixed(1)} km`,
      },
      { label: 'Durée totale', value: `${report.trips.totalDurationHours.toFixed(1)} h` },
      { label: 'Vitesse moy. (km / h de conduite)', value: `${report.trips.avgSpeedKmh.toFixed(1)} km/h` },
      { label: 'Vitesse max', value: `${report.trips.maxSpeedKmh.toFixed(0)} km/h` },
      { label: 'Conso estimée', value: `${report.consumption.estimatedLiters.toFixed(1)} L` },
      { label: 'Coût carburant', value: `${report.consumption.estimatedCostEur.toFixed(2)} EUR` },
    ];
    // P3 carburant — prix RÉELLEMENT CONSTATÉ en station (si des passages ont été captés).
    if (report.consumption.observedPriceEurL != null) {
      kpis.push({ label: 'Prix constaté', value: `${report.consumption.observedPriceEurL.toFixed(3)} EUR/L` });
      if (report.consumption.estimatedCostAtObservedEur != null) {
        kpis.push({ label: 'Coût au prix constaté', value: `${report.consumption.estimatedCostAtObservedEur.toFixed(2)} EUR` });
      }
    }

    // Grille 3 × 3 : neuf cartes (onze avec le prix constaté) sur quatre colonnes laissaient
    // une carte orpheline sur la dernière ligne.
    const cols = 3;
    const gap = 8;
    const startX = 40;
    const cardW = Math.floor((515 - gap * (cols - 1)) / cols);
    const cardH = 56;
    let x = startX;
    let y = doc.y;

    for (let i = 0; i < kpis.length; i++) {
      const kpi = kpis[i]!;
      doc.roundedRect(x, y, cardW, cardH, 6).fill(COLOR_BG_ACCENT);
      doc.fillColor(COLOR_FG_MUTED).fontSize(8).font('Helvetica')
        .text(kpi.label.toUpperCase(), x + 8, y + 6, { width: cardW - 16 });
      doc.fillColor(COLOR_FG).fontSize(15).font('Helvetica-Bold')
        .text(kpi.value, x + 8, y + 22, { width: cardW - 16 });
      if ((i + 1) % cols === 0) {
        x = startX;
        y += cardH + gap;
      } else {
        x += cardW + gap;
      }
    }
    doc.y = y + cardH + 16;

    // P3 carburant — ligne de comparaison prix constaté vs paramétré (base du calcul de coût).
    const c = report.consumption;
    if (c.observedPriceEurL != null && c.estimatedCostAtObservedEur != null) {
      const delta = Math.round((c.estimatedCostAtObservedEur - c.estimatedCostEur) * 100) / 100;
      const passages = `${c.observedSampleCount} passage${c.observedSampleCount > 1 ? 's' : ''} station`;
      const txt = `Prix carburant constaté en station (${passages}) : ${c.observedPriceEurL.toFixed(3)} EUR/L, contre ${c.fuelPriceEurL.toFixed(2)} EUR/L paramétré. `
        + `Coût estimé au prix réel : ${c.estimatedCostAtObservedEur.toFixed(2)} EUR (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} EUR vs paramétré).`;
      doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica').text(txt, 40, doc.y, { width: 515 });
      doc.y += 6;
      doc.moveDown(1);
    }

    /**
     * ── LE PRIX CONSTATÉ NE SUIT PAS LE FILTRE, ET LE DOCUMENT LE DIT (F13) ─────────────
     *
     * `TripFuelStop` n'a pas de conducteur : l'agrégat porte sur le périmètre VÉHICULE
     * (cf. `reports-stats.service`). Le PDF GARDE le chiffre — un prix de station est un
     * fait de marché, et « Coût au prix constaté » = les litres de ce filtre valorisés à
     * ce prix reste une comparaison utile —, mais « (12 passages station) » est un
     * DÉNOMBREMENT D'ÉVÉNEMENTS imprimé sous un nom propre : muet, il s'attribue tout seul
     * à la personne nommée en tête de page.
     *
     * ⚠️ Le classeur Excel, lui, les RETIRE et l'écrit (`mentionConducteur`) : il liste les
     * arrêts un par un, une liste nominative d'arrêts d'autrui n'a pas d'excuse. Les deux
     * documents donnent donc la même réponse — « ces passages ne sont pas les siens » —
     * par deux gestes différents. Ce qui n'était pas permis, c'est qu'un seul des deux se
     * taise ; le silence se lisait « celui-ci, si, il suit le filtre ».
     */
    if (driverLabel && c.observedPriceEurL != null) {
      doc.fillColor(COLOR_FG_NOTICE).fontSize(8.5).font('Helvetica')
        .text(
          'Les passages en station sont des arrêts du véhicule, pas d’une personne : ce prix '
          + 'et ce nombre de passages ne suivent pas le filtre conducteur et portent sur les '
          + 'véhicules du périmètre. Seuls les litres valorisés le suivent.',
          40, doc.y, { width: 515 },
        );
      doc.moveDown(1);
    }
  }

  /**
   * @param driverLabel présent = le rapport est filtré sur un conducteur.
   *
   * ── L'EXCEPTION DES ALERTES, ÉCRITE DANS LE DOCUMENT ──────────────────────────────────
   *
   * Une alerte appartient à un VÉHICULE : elle n'a pas de conducteur, et lui en attribuer un
   * demanderait de deviner qui conduisait à son horodatage. Ce compte reste donc calculé sur
   * le périmètre véhicule, alors que tout le reste de la page suit le conducteur (cf.
   * `alertWhere` dans `reports-stats.service`).
   *
   * ⚠️ SANS CETTE PHRASE, la section serait lue comme « voici ses alertes ». Ce n'est plus un
   * chiffre, c'est une accusation — et sur du papier qui circule, elle n'a pas de démenti.
   * L'écran porte exactement la même mention (`noteAlertesConducteur`).
   */
  private renderAlerts(doc: PDFKit.PDFDocument, report: FleetStatsReport, driverLabel?: string): void {
    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Alertes', 40, doc.y);
    doc.moveDown(0.4);

    if (driverLabel) {
      doc.fillColor(COLOR_FG_NOTICE).fontSize(8.5).font('Helvetica')
        .text(
          'Les alertes appartiennent à un véhicule, pas à un conducteur : ce compte ne suit '
          + 'pas le filtre conducteur du rapport et porte sur les véhicules du périmètre.',
          40, doc.y, { width: 515 },
        );
      doc.moveDown(0.5);
    }

    if (report.alerts.total === 0) {
      doc.fillColor(COLOR_FG_MUTED).fontSize(10).font('Helvetica')
        .text('Aucune alerte sur la période.', 40, doc.y);
      doc.moveDown();
      return;
    }

    doc.fillColor(COLOR_FG).fontSize(11).font('Helvetica')
      .text(`Total : ${report.alerts.total} alertes`, 40, doc.y);
    doc.moveDown(0.4);

    const startY = doc.y;
    let leftY = startY;
    let rightY = startY;

    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica-Bold')
      .text('PAR TYPE', 40, leftY);
    leftY += 14;
    for (const t of report.alerts.byType.slice(0, 8)) {
      doc.fillColor(COLOR_FG).fontSize(9).font('Helvetica')
        .text(alertTypeLabel(t.type), 40, leftY, { width: 200, continued: true })
        .fillColor(COLOR_FG_MUTED).text(`  ${t.count}`, { align: 'right' });
      leftY += 12;
    }

    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica-Bold')
      .text('PAR SÉVÉRITÉ', 300, rightY);
    rightY += 14;
    for (const s of report.alerts.bySeverity) {
      doc.fillColor(COLOR_FG).fontSize(9).font('Helvetica')
        .text(alertSeverityLabel(s.severity), 300, rightY, { width: 200, continued: true })
        .fillColor(COLOR_FG_MUTED).text(`  ${s.count}`, { align: 'right' });
      rightY += 12;
    }
    doc.y = Math.max(leftY, rightY) + 14;
  }

  /**
   * @param driverLabel présent = le rapport est filtré sur un conducteur.
   *
   * ── UN PALMARÈS DE VÉHICULES SOUS UN NOM DE PERSONNE ─────────────────────────────────
   *
   * Sous filtre, ce tableau ne compte QUE les trajets retenus : les kilomètres de chaque
   * véhicule sont amputés de tout ce que les autres conducteurs y ont roulé, et un véhicule
   * qui n'apparaît pas n'est pas un véhicule à l'arrêt. Muet, il se lit comme le palmarès du
   * parc — imprimé trois lignes sous « Conducteur : Sohaib Hamanni ».
   *
   * Même discipline que `renderKpis`, `renderAlerts` et `renderAttribution` : le document
   * dit sur quelle population il compte. ⚠️ Et il le dit avec SES mots — deux phrases qui
   * ouvriraient pareil rendraient le test de l'une satisfait par l'autre.
   */
  private renderTopVehicles(
    doc: PDFKit.PDFDocument,
    report: FleetStatsReport,
    topN: number,
    driverLabel?: string,
  ): void {
    if (report.topVehicles.length === 0) return;
    // Le seuil descend quand une mention doit tenir sous le titre : ce tableau ne pagine
    // pas ses rangées, une section poussée trop bas déborderait sous le pied de page.
    if (doc.y > (driverLabel ? 660 : 700)) doc.addPage();

    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Top véhicules (km parcourus)', 40, doc.y);
    doc.moveDown(0.4);

    if (driverLabel) {
      doc.fillColor(COLOR_FG_NOTICE).fontSize(8.5).font('Helvetica')
        .text(
          'Lecture sous filtre conducteur : ce palmarès ne compte que les trajets retenus par '
          + 'le filtre annoncé en tête de rapport. Les kilomètres de chaque véhicule sont donc '
          + 'ceux de ce seul périmètre, et un véhicule qui n’y figure pas a pu rouler pour '
          + 'quelqu’un d’autre — ce n’est pas le palmarès du parc.',
          40, doc.y, { width: 515 },
        );
      doc.moveDown(0.5);
    }

    /**
     * ── LA COLONNE « EXCÈS » MANQUAIT ICI, ET NULLE PART AILLEURS ────────────────────────
     *
     * Le récapitulatif PAR CONDUCTEUR du même PDF la porte depuis toujours, l'écran l'affiche
     * sur ses deux vues, et le classeur vient de l'obtenir. Ce tableau-ci — le seul palmarès
     * par VÉHICULE que le client reçoive imprimé — s'arrêtait aux kilomètres et au carburant.
     *
     * Le chiffre était pourtant déjà là : `topVehicles[].speedingCount` et `worstOverKmh` sont
     * calculés et transmis depuis le lot F06. Seule la colonne manquait.
     *
     * Les cinq abscisses sont resserrées pour lui faire place, sans déborder les 555 pt de la
     * zone de texte : la plaque garde ses 160 pt (elle porte aussi le nom du groupe, en gris).
     */
    const colX = [40, 200, 285, 340, 455];
    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica-Bold')
      .text('Plaque', colX[0]!, doc.y, { continued: false })
      .text('Distance', colX[1]!, doc.y - 11)
      .text('Trajets', colX[2]!, doc.y - 11)
      .text('Excès', colX[3]!, doc.y - 11)
      .text('Carburant est.', colX[4]!, doc.y - 11);
    doc.moveDown(0.3);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#e5e7eb').stroke();
    doc.moveDown(0.3);

    for (const v of report.topVehicles.slice(0, topN)) {
      const y = doc.y;
      doc.fillColor(COLOR_FG).fontSize(10).font('Helvetica')
        .text(v.plate, colX[0]!, y, { continued: !!v.group });
      // Groupe accolé à la plaque, en gris (la colonne Plaque a la place ; pas de
      // re-layout des autres colonnes qui sont ancrées sur le même `y`).
      if (v.group) {
        doc.fillColor(COLOR_FG_MUTED).fontSize(8).font('Helvetica')
          .text(`   ${v.group.name}`, { continued: false });
      }
      // Réinitialise le style (le bloc groupe l'a passé en gris/8) avant les colonnes suivantes.
      doc.fillColor(COLOR_FG).fontSize(10).font('Helvetica');
      doc.text(`${v.distanceKm.toFixed(1)} km`, colX[1]!, y);
      doc.text(`${v.tripCount}`, colX[2]!, y);
      // Même écriture que le récapitulatif par conducteur, à la parenthèse près : deux
      // tableaux du même document qui compteraient pareil mais l'écriraient autrement
      // laisseraient croire à deux mesures différentes.
      doc.text(libelleExces(v.speedingCount, v.worstOverKmh), colX[3]!, y, { width: colX[4]! - colX[3]! - 6, lineBreak: false });
      doc.text(`${v.estimatedConsumptionL.toFixed(1)} L`, colX[4]!, y);
      doc.moveDown(0.6);
    }
    doc.moveDown();
  }

  /**
   * ══ « QUI ROULE, ET QUI DÉPASSE ? » — LE RÉCAPITULATIF PAR IMPUTATION (F13) ══════════
   *
   * ── CE QUI MANQUAIT, ET CE QUE LE SILENCE COÛTAIT ───────────────────────────────────
   *
   * L'écran des Rapports rend ce bloc depuis le 5 septembre ; le PDF, l'Excel et le rapport
   * hebdomadaire, non — « le client voit à l'écran ce que son PDF ne dit pas ». Or c'est le
   * document, pas l'écran, qui part par courriel et ressort d'un classeur six mois plus tard,
   * quand plus personne ne peut le rapprocher de la page qui l'a produit.
   *
   * MÊME VÉRITÉ QUE L'ÉCRAN, PAS UNE VARIANTE : les lignes viennent de `byAttribution`, que
   * `ReportsStatsService.compute` calcule UNE fois avec la règle du contrat partagé
   * (`cleImputationTrajet`) — le conducteur s'il est connu, sinon le GROUPE du véhicule,
   * sinon personne. Ce service met en page, il n'impute rien lui-même : une seconde règle
   * d'imputation finirait par répondre autrement à la même question.
   *
   * ⚠️ L'ENCART « NON ATTRIBUÉ » SE REND QUEL QUE SOIT L'ÉTAT DU CLASSEMENT. L'écran a déjà
   * payé cette faute : une première version ne l'affichait que si le classement était vide,
   * et chez cdef31 dix-sept groupes classés l'auraient masqué. Mesuré en production le
   * 2026-09-05 : cdef31, 2 675 trajets sur 2 707 sans conducteur mais avec un groupe ;
   * mh cars, 1 866 sur 1 886 sans NI l'un NI l'autre. Un bloc qui tairait ces trajets ferait
   * lire une image complète là où il en manque 99 %.
   *
   * @param driverLabel présent = le rapport est filtré sur un conducteur. Le classement se
   *   réduit alors par construction, et le dit — même discipline que `renderAlerts` et que
   *   la mention des passages en station.
   */
  private renderAttribution(
    doc: PDFKit.PDFDocument,
    report: FleetStatsReport,
    topN: number,
    driverLabel?: string,
  ): void {
    // ⚠️ `byAttribution` est OPTIONNEL dans le contrat : d'autres producteurs de
    // `FleetStatsReport` n'en fabriquent pas. Absent, le document se TAIT — il n'imprime
    // pas un classement vide, qui se lirait « personne n'a roulé ce mois-ci ».
    const lignes = report.byAttribution;
    if (!lignes) return;
    const nonAttribue = report.unattributedTrips ?? { tripCount: 0, distanceKm: 0, durationHours: 0 };
    // Rien à classer ET rien à signaler = aucun trajet sur la période : la grille
    // d'indicateurs le dit déjà, une section vide ne ferait qu'inquiéter.
    if (lignes.length === 0 && nonAttribue.tripCount === 0) return;

    if (doc.y > 640) doc.addPage();

    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Par conducteur ou groupe', 40, doc.y);
    doc.moveDown(0.4);
    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
      .text(
        'Chaque trajet compte pour son conducteur, sinon pour le groupe de son véhicule.',
        40, doc.y, { width: 515 },
      );
    doc.moveDown(0.5);

    /**
     * ⚠️ SOUS FILTRE, CE CLASSEMENT SE RÉDUIT PAR CONSTRUCTION — et un classement d'une
     * seule ligne, imprimé sans contexte, se lit « il n'y a qu'une personne qui roule ».
     *
     * La phrase vaut pour les DEUX formes du filtre, et c'est voulu : sur un conducteur
     * nommé il ne reste qu'une ligne, tandis que sous « sans conducteur » il reste
     * plusieurs lignes de GROUPE et aucune de personne. Le document ne reçoit que le
     * LIBELLÉ (`driverLabel`), pas la forme du filtre ; deviner la seconde en lisant le
     * premier coudrait ce fichier au contrôleur qui le compose.
     */
    if (driverLabel) {
      doc.fillColor(COLOR_FG_NOTICE).fontSize(8.5).font('Helvetica')
        .text(
          'Lecture sous filtre conducteur : ce classement ne porte que sur les trajets retenus '
          + 'par le filtre annoncé en tête de rapport. Un rapport centré sur une personne ne peut '
          + 'donc contenir qu’une seule ligne, et un rapport « sans conducteur » n’en contient '
          + 'aucune de conducteur — ce n’est pas le classement de la société.',
          40, doc.y, { width: 515 },
        );
      doc.moveDown(0.5);
    }

    const colX = { nom: 40, dist: 255, duree: 330, trajets: 400, exces: 455 };
    /** Place laissée au nom, la sorte étant posée à sa suite (cf. la rangée ci-dessous). */
    const NOM_LARGEUR = 150;
    const renderEnTete = (): void => {
      const y = doc.y;
      doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica-Bold')
        .text('CONDUCTEUR OU GROUPE', colX.nom, y, { width: colX.dist - colX.nom - 6 })
        .text('DISTANCE', colX.dist, y)
        .text('CONDUITE', colX.duree, y)
        .text('TRAJETS', colX.trajets, y)
        .text('EXCÈS', colX.exces, y);
      doc.moveDown(0.3);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#e5e7eb').stroke();
      doc.moveDown(0.3);
    };

    const affichees = lignes.slice(0, topN);
    if (affichees.length > 0) {
      renderEnTete();
      for (const l of affichees) {
        // Chaque rangée vérifie la place qui reste : quinze groupes ne tiennent pas sous
        // un top véhicules qui a déjà mangé la page.
        if (doc.y + 15 > 770) {
          doc.addPage();
          renderEnTete();
        }
        const y = doc.y;
        doc.fillColor(COLOR_FG).fontSize(10).font('Helvetica');
        const nom = this.tronquerA(doc, l.label, NOM_LARGEUR);
        doc.text(nom, colX.nom, y, { lineBreak: false });
        /**
         * La SORTE, en gris, à la suite du nom — même geste que le groupe accolé à la plaque
         * du top véhicules. Elle n'est pas décorative : sans elle, « Atelier » et « Amine
         * Berrada » se lisent comme deux personnes.
         *
         * ⚠️ Mesure prise AVANT de changer de police (`widthOfString` mesure avec la police
         * courante), et le nom est déjà coupé à `NOM_LARGEUR` : le mot ne peut donc pas
         * dépasser 40 + 150 + 6 + 38 = 234 pt, soit avant la colonne « Distance » (255).
         */
        const xSorte = colX.nom + doc.widthOfString(nom) + 6;
        doc.fillColor(COLOR_FG_MUTED).fontSize(8).font('Helvetica')
          .text(l.kind === 'driver' ? 'conducteur' : 'groupe', xSorte, y + 2, { lineBreak: false });
        doc.fillColor(COLOR_FG).fontSize(10).font('Helvetica');
        doc.text(`${l.distanceKm.toFixed(1)} km`, colX.dist, y, { lineBreak: false });
        // Les heures décimales du contrat repassent en secondes AVANT d'être mises en
        // forme, exactement comme l'écran : « 2.5 h » et « 2h30 » doivent être le même fait.
        doc.text(this.formatDuration(Math.round(l.durationHours * 3600)), colX.duree, y, { lineBreak: false });
        doc.text(`${l.tripCount}`, colX.trajets, y, { lineBreak: false });
        // MÊME compte que la vue par véhicule : les excès ÉTABLIS de la règle partagée,
        // jamais le compteur écrit au moment de l'analyse (4 036 analyses de production ne
        // portent que des segments de durée nulle).
        doc.text(
          libelleExces(l.speedingCount, l.worstOverKmh),
          colX.exces, y, { width: 555 - colX.exces, lineBreak: false },
        );
        doc.y = y + 15;
      }

      // La troncature se dit : sans cette ligne, un parc de quarante conducteurs semblerait
      // n'en compter que dix. Le total RÉEL vient du serveur (`byAttributionTotal`), la liste
      // servie étant déjà plafonnée par `compute`.
      const total = report.byAttributionTotal ?? lignes.length;
      if (total > affichees.length) {
        doc.moveDown(0.4);
        doc.fillColor(COLOR_FG_MUTED).fontSize(8.5).font('Helvetica')
          .text(
            `${affichees.length} ligne${affichees.length > 1 ? 's' : ''} affichée${affichees.length > 1 ? 's' : ''} `
            + `sur ${total} — les plus gros rouleurs d’abord.`,
            40, doc.y, { width: 515 },
          );
      }
      doc.moveDown(1);
    } else {
      doc.fillColor(COLOR_FG_MUTED).fontSize(10).font('Helvetica')
        .text(
          driverLabel
            // « de la période » serait un FAUX sous filtre : la vue vient d'écarter les
            // autres conducteurs par construction, ce n'est pas une lacune de la société.
            ? 'Aucun trajet de ce périmètre n’est imputé à un conducteur ni à un groupe.'
            : 'Aucun trajet de la période n’est imputé à un conducteur ni à un groupe.',
          40, doc.y, { width: 515 },
        );
      doc.moveDown(1);
    }

    this.renderNonAttribues(doc, report, driverLabel);
  }

  /**
   * L'ENCART DES NON ATTRIBUÉS — RENDU HORS DE TOUTE SECTION.
   *
   * Même geste que `renderExploitedScopeNotice`, et pour la même raison. Le CLASSEMENT est
   * la seconde face de la carte « Top véhicules » : le décocher emporte le tableau, c'est
   * assumé. L'ENCART, lui, n'est pas une face de ce tableau — c'est le contre-poids qui
   * empêche de lire le document comme complet. Il vivait dans `renderAttribution`, donc
   * sous `if (sections.has('topVehicles'))` : un rapport hebdomadaire réglé sur
   * ['kpi','alerts','trips'] — la route l'accepte — perdait la seule phrase du PDF qui dise
   * que 99 % des kilomètres n'appartiennent à personne (mh cars, 1 866 trajets sur 1 886 au
   * 2026-09-05), pendant que le corps du COURRIEL, lui, l'écrivait inconditionnellement
   * (`buildUnattributedNote`). La pièce jointe est le document qu'on classe et qu'on relit
   * six mois plus tard : elle ne peut pas contredire son courriel par omission.
   *
   * ⚠️ MÊME GARDE QU'AVANT, à la ligne près : `byAttribution` absent = producteur muet =
   * document muet (d'autres producteurs de `FleetStatsReport` n'en fabriquent pas, et un
   * encart seul, sans classement, se lirait comme un reproche sorti de nulle part).
   */
  private renderNonAttribues(
    doc: PDFKit.PDFDocument,
    report: FleetStatsReport,
    driverLabel?: string,
  ): void {
    if (!report.byAttribution) return;
    const na = report.unattributedTrips;
    if (!na || na.tripCount <= 0) return;
    this.renderEncartAmbre(doc, this.libelleNonAttribues(na, report.trips.count, !!driverLabel));
  }

  /**
   * Coupe une chaîne à la largeur donnée, points de suspension compris.
   *
   * ⚠️ `{ ellipsis: true }` DE PDFKIT NE FAIT PAS CELA. Vérifié dans son source
   * (`LineWrapper`) : l'ellipse n'est posée que sur un débordement VERTICAL, quand une
   * `height` est donnée et que la ligne suivante sortirait du cadre. Sur une largeur, elle
   * ne coupe rien — avec `lineBreak: false`, un nom de groupe un peu long passe simplement
   * par-dessus la colonne voisine ; avec le retour à la ligne, il écrase la rangée du
   * dessous. Mesuré sur la grille d'aujourd'hui : sans cette coupe, « Groupe très long qui
   * déborde de la colonne voisine » finit à 265,98 pt et sa sorte à 296,80 pt, pour une
   * colonne DISTANCE (`colX.dist`) qui commence à 255 — le libellé s'imprime donc
   * par-dessus les kilomètres de SA PROPRE LIGNE. Rien ne borne cette longueur en amont :
   * `VehicleGroup.name` est un `String` nu au schéma et son DTO n'a pas de `@MaxLength`.
   * (Le test « coupe un libellé trop long AVANT la colonne DISTANCE » tient ces nombres.)
   *
   * ⚠️ La POLICE DOIT ÊTRE POSÉE avant l'appel : `widthOfString` mesure avec la police
   * courante, et une mesure faite dans une autre taille rendrait une coupe fausse.
   */
  private tronquerA(doc: PDFKit.PDFDocument, texte: string, largeur: number): string {
    if (doc.widthOfString(texte) <= largeur) return texte;
    let coupe = texte;
    while (coupe.length > 1 && doc.widthOfString(`${coupe}…`) > largeur) {
      coupe = coupe.slice(0, -1);
    }
    return `${coupe}…`;
  }

  /**
   * L'encart « ni conducteur, ni groupe » — au mot près celui de l'écran.
   *
   * ⚠️ SON DÉNOMINATEUR EST LE TOTAL RÉEL DE LA PÉRIODE (`trips.count`), jamais la somme des
   * lignes classées : chez mh cars, « 1 866 sur 12 » aurait été un mensonge parfaitement
   * crédible. Les deux nombres viennent donc de la MÊME passe d'agrégation, celle qui compte
   * les trajets réels.
   *
   * @param filtre le rapport porte sur un conducteur : le dénominateur a lui aussi été
   *   filtré, et l'annoncer « de la période » ferait passer une population bornée pour
   *   la société entière.
   */
  private libelleNonAttribues(
    na: { tripCount: number; distanceKm: number; durationHours: number },
    totalTrajets: number,
    filtre: boolean,
  ): string {
    const n = na.tripCount;
    const perimetre = filtre ? 'retenus par ce filtre' : 'de la période';
    return `${n} trajet${n > 1 ? 's' : ''} sur ${totalTrajets} ${perimetre} `
      + `(${partLibelle(n, totalTrajets)}, ${na.distanceKm.toFixed(1)} km) `
      + `n’${n > 1 ? 'ont' : 'a'} ni conducteur, ni groupe : `
      + `${n > 1 ? 'ils ne peuvent être attribués' : 'il ne peut être attribué'} à personne. `
      + 'Renseignez un conducteur ou un groupe sur ces véhicules, depuis la page Véhicules, '
      + 'pour que leurs kilomètres comptent pour quelqu’un.';
  }

  /**
   * Section "Trajets recents" — liste les 30 derniers trajets avec leurs
   * informations cles + la note libre. Une nouvelle page est ajoutee si on
   * approche du bas, et le tableau est paginé tout seul (chaque rangee
   * verifie l'espace restant).
   *
   * Phase 2 ajoutera la colonne "Conducteur" entre Plaque et Distance.
   *
   * @param driverLabel présent = le rapport est filtré sur un conducteur. La liste n'est
   *   alors PAS celle des derniers trajets de la société : « les 30 derniers trajets sur la
   *   période » décrit une population bornée, et la colonne « Conducteur » qui répète le même
   *   nom trente fois pousse à croire que la société n'a qu'un conducteur. Le compte total
   *   entre parenthèses, lui aussi filtré, achève la confusion s'il n'est pas situé.
   */
  private renderRecentTrips(
    doc: PDFKit.PDFDocument,
    report: FleetStatsReport,
    maxTrips: number,
    driverLabel?: string,
  ): void {
    if (!report.recentTrips || report.recentTrips.length === 0) return;

    // Cf. `renderTopVehicles` : la mention prend deux lignes, le seuil descend d'autant.
    if (doc.y > (driverLabel ? 650 : 680)) doc.addPage();

    const trips = report.recentTrips.slice(0, maxTrips);

    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Trajets récents', 40, doc.y);
    doc.moveDown(0.4);
    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
      .text(
        `${trips.length} derniers trajets sur la période, du plus récent au plus ancien` +
        (report.trips.count > trips.length
          ? ` (sur ${report.trips.count} au total)`
          : ''),
        40, doc.y,
      );
    if (driverLabel) {
      doc.moveDown(0.4);
      doc.fillColor(COLOR_FG_NOTICE).fontSize(8.5).font('Helvetica')
        .text(
          'Lecture sous filtre conducteur : cette liste ne montre que les trajets retenus par '
          + 'le filtre annoncé en tête de rapport'
          // Le total entre parenthèses n'est écrit que s'il y a plus de trajets que de
          // rangées : le nommer quand il est absent enverrait chercher un chiffre inexistant.
          + (report.trips.count > trips.length
            ? ', et le total entre parenthèses est celui de ce seul périmètre'
            : '')
          + ' — ce ne sont pas les derniers trajets de la société.',
          40, doc.y, { width: 515 },
        );
    }
    doc.moveDown(0.6);

    // Colonnes : Date | Plaque | Duree | Distance | Conducteur | Note
    const colX = { date: 40, plate: 120, duration: 175, distance: 220, driver: 275, notes: 365 };
    const colW = { driver: 85, notes: 190 };

    const renderHeader = () => {
      const y = doc.y;
      doc.fillColor(COLOR_FG_MUTED).fontSize(8).font('Helvetica-Bold')
        .text('DATE', colX.date, y)
        .text('PLAQUE', colX.plate, y)
        .text('DURÉE', colX.duration, y)
        .text('DISTANCE', colX.distance, y)
        .text('CONDUCTEUR', colX.driver, y)
        .text('NOTE', colX.notes, y);
      doc.moveDown(0.3);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#e5e7eb').stroke();
      doc.moveDown(0.3);
    };
    renderHeader();

    for (const t of trips) {
      // Estime la hauteur de la note (max 2 lignes affichees) pour gerer le
      // saut de page proprement.
      const noteHeight = t.notes ? doc.heightOfString(t.notes, { width: colW.notes }) : 0;
      const rowHeight = Math.max(14, Math.min(28, noteHeight) + 4);

      if (doc.y + rowHeight > 770) {
        doc.addPage();
        renderHeader();
      }

      const rowY = doc.y;
      // Serveur en UTC : sans fuseau, un trajet parti a 07:30 s'affichait
      // 05:30 dans le PDF du client. Cf. common/utils/datetime.ts.
      const date = formatFleetDateShort(t.startedAt);
      const time = formatFleetTime(t.startedAt);

      doc.fillColor(COLOR_FG).fontSize(9).font('Helvetica')
        .text(`${date} ${time}`, colX.date, rowY, { width: colX.plate - colX.date - 4 });
      doc.text(t.plate, colX.plate, rowY, { width: colX.duration - colX.plate - 4 });
      doc.text(this.formatDuration(t.durationSeconds), colX.duration, rowY,
        { width: colX.distance - colX.duration - 4 });
      doc.text(`${t.distanceKm.toFixed(1)} km`, colX.distance, rowY,
        { width: colX.driver - colX.distance - 4 });

      if (t.driverName) {
        doc.fillColor(COLOR_FG).fontSize(9).font('Helvetica')
          .text(t.driverName, colX.driver, rowY, { width: colW.driver, ellipsis: true });
      } else {
        doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
          .text('—', colX.driver, rowY);
      }

      if (t.notes) {
        // Tronque a ~110 chars pour eviter qu'une note tres longue ecrase la mise en page.
        const truncated = t.notes.length > 110 ? `${t.notes.slice(0, 110)}…` : t.notes;
        doc.fillColor(COLOR_FG).fontSize(9).font('Helvetica-Oblique')
          .text(truncated, colX.notes, rowY, { width: colW.notes });
      } else {
        doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
          .text('—', colX.notes, rowY);
      }
      doc.moveDown(0.5);
    }
    doc.moveDown();
  }

  /** "1h05" / "23min" — format compact pour les tableaux PDF. */
  private formatDuration(seconds: number): string {
    if (!seconds || seconds < 0) return '0min';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
    return `${m}min`;
  }

  private renderFooter(doc: PDFKit.PDFDocument): void {
    const range = doc.bufferedPageRange();
    const generated = formatFleetDateTime(new Date());
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // Dans la marge basse, SANS retour à la ligne : un texte qui déborde de la zone
      // imprimable déclenche une nouvelle page — c'était la page blanche finale.
      const y = doc.page.height - 30;
      doc.fontSize(8).fillColor(COLOR_FG_MUTED).font('Helvetica')
        .text(`Généré automatiquement par Vizyo Tracky — ${generated}`, 40, y, { width: 400, align: 'left', lineBreak: false })
        .text(`Page ${i + 1} / ${range.count}`, 440, y, { width: 115, align: 'right', lineBreak: false });
    }
  }
}
