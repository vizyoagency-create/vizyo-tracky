import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import {
  formatFleetDate,
  formatFleetDateShort,
  formatFleetDateTime,
  formatFleetTime,
} from '../common/utils/datetime';
import { buildExploitedScopeNotice, FleetStatsReport } from './reports-stats.service';

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
}

const DEFAULT_MAX_TRIPS = 30;
const DEFAULT_TOP_N = 10;

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
          info: {
            Title: `Vizyo Tracky — Rapport ${report.fleet.name}`,
            Author: 'Vizyo Tracky',
          },
        });

        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this.renderHeader(doc, report, options?.scopeLabel);
        // Rendue AVANT les sections, et hors du bloc `kpi` : la base de calcul du
        // parc exploité vaut pour tout le document (top véhicules compris), et un
        // rapport dont on aurait décoché la section KPI ne doit pas perdre la
        // mention — c'est justement le chiffre qu'elle explique qui se retrouverait
        // ailleurs sans avertissement.
        this.renderExploitedScopeNotice(doc, report);
        if (sections.has('kpi')) this.renderKpis(doc, report);
        if (sections.has('alerts')) this.renderAlerts(doc, report);
        if (sections.has('topVehicles')) this.renderTopVehicles(doc, report, topN);
        if (sections.has('trips')) this.renderRecentTrips(doc, report, maxTrips);
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

  private renderHeader(doc: PDFKit.PDFDocument, report: FleetStatsReport, scopeLabel?: string): void {
    // Logo / nom Tracky en haut-gauche
    doc.fillColor(COLOR_TRACKY).fontSize(20).font('Helvetica-Bold')
      .text('Vizyo Tracky', 40, 40);
    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
      .text('Rapport de flotte', 40, 65);

    // Bandeau periode en haut-droite
    const fromStr = formatFleetDate(report.period.from);
    const toStr = formatFleetDate(report.period.to);
    doc.fillColor(COLOR_FG).fontSize(11).font('Helvetica')
      .text(`${fromStr} → ${toStr}`, 400, 42, { width: 155, align: 'right' });
    doc.fillColor(COLOR_FG_MUTED).fontSize(9)
      .text(`${report.period.days} jours`, 400, 60, { width: 155, align: 'right' });

    // Fleet name + sous-titre scope (ex: "3 vehicules selectionnes")
    doc.fillColor(COLOR_FG).fontSize(16).font('Helvetica-Bold')
      .text(report.fleet.name, 40, 95);
    if (scopeLabel) {
      doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
        .text(scopeLabel, 40, 116);
    }

    doc.moveTo(40, 130).lineTo(555, 130).strokeColor(COLOR_TRACKY).lineWidth(1.5).stroke();
    doc.y = 145;
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
   */
  private renderExploitedScopeNotice(doc: PDFKit.PDFDocument, report: FleetStatsReport): void {
    const notice = buildExploitedScopeNotice(report);
    if (!notice) return;

    const boxW = 515;
    const padX = 8;
    const textW = boxW - padX * 2;
    // heightOfString mesure avec la police COURANTE : on la fixe avant, sinon la
    // hauteur est calculée pour une autre taille et le fond coupe le texte.
    doc.fontSize(8.5).font('Helvetica');
    const boxH = doc.heightOfString(notice, { width: textW }) + 12;

    // Saut de page défensif : la mention doit rester lisible d'un bloc.
    if (doc.y + boxH > 780) doc.addPage();

    const top = doc.y;
    doc.roundedRect(40, top, boxW, boxH, 4).fill(COLOR_BG_NOTICE);
    doc.fillColor(COLOR_FG_NOTICE).fontSize(8.5).font('Helvetica')
      .text(notice, 40 + padX, top + 6, { width: textW });
    doc.y = top + boxH + 12;
  }

  private renderKpis(doc: PDFKit.PDFDocument, report: FleetStatsReport): void {
    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Indicateurs cles', 40, doc.y);
    doc.moveDown(0.4);

    const kpis: { label: string; value: string }[] = [
      { label: 'Véhicules actifs', value: `${report.vehicles.activeDuringPeriod} / ${report.vehicles.total}` },
      { label: 'Trajets', value: report.trips.count.toString() },
      { label: 'Distance totale', value: `${report.trips.totalKm.toFixed(1)} km` },
      // La moyenne par vehicule etait absente du PDF alors que c'est elle que le
      // client compare d'une semaine sur l'autre : il la lisait ailleurs (app,
      // export) sans jamais voir sur quelle base elle etait calculee. On l'affiche
      // ici, adossee a l'encart « parc exploite » rendu juste au-dessus.
      { label: 'Distance moy./véhicule', value: `${report.trips.avgKmPerVehicle.toFixed(1)} km` },
      { label: 'Durée totale', value: `${report.trips.totalDurationHours.toFixed(1)} h` },
      { label: 'Vitesse moy.', value: `${report.trips.avgSpeedKmh.toFixed(1)} km/h` },
      { label: 'Vitesse max', value: `${report.trips.maxSpeedKmh.toFixed(0)} km/h` },
      { label: 'Conso estimee', value: `${report.consumption.estimatedLiters.toFixed(1)} L` },
      { label: 'Coût carburant', value: `${report.consumption.estimatedCostEur.toFixed(2)} EUR` },
    ];
    // P3 carburant — prix REELLEMENT CONSTATE en station (si des passages ont ete captes).
    if (report.consumption.observedPriceEurL != null) {
      kpis.push({ label: 'Prix constate', value: `${report.consumption.observedPriceEurL.toFixed(3)} EUR/L` });
      if (report.consumption.estimatedCostAtObservedEur != null) {
        kpis.push({ label: 'Coût au prix constate', value: `${report.consumption.estimatedCostAtObservedEur.toFixed(2)} EUR` });
      }
    }

    const cardW = 124;
    const cardH = 56;
    const gap = 8;
    const startX = 40;
    let x = startX;
    let y = doc.y;
    const cols = 4;

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
      const txt = `Prix carburant constate en station (${passages}) : ${c.observedPriceEurL.toFixed(3)} EUR/L, contre ${c.fuelPriceEurL.toFixed(2)} EUR/L parametre. `
        + `Cout estime au prix reel : ${c.estimatedCostAtObservedEur.toFixed(2)} EUR (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} EUR vs parametre).`;
      doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica').text(txt, 40, doc.y, { width: 515 });
      doc.y += 6;
      doc.moveDown(1);
    }
  }

  private renderAlerts(doc: PDFKit.PDFDocument, report: FleetStatsReport): void {
    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Alertes', 40, doc.y);
    doc.moveDown(0.4);

    if (report.alerts.total === 0) {
      doc.fillColor(COLOR_FG_MUTED).fontSize(10).font('Helvetica')
        .text('Aucune alerte sur la periode.', 40, doc.y);
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
        .text(`${t.type}`, 40, leftY, { continued: true })
        .fillColor(COLOR_FG_MUTED).text(`  ${t.count}`, { align: 'right' });
      leftY += 12;
    }

    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica-Bold')
      .text('PAR SEVERITE', 300, rightY);
    rightY += 14;
    for (const s of report.alerts.bySeverity) {
      doc.fillColor(COLOR_FG).fontSize(9).font('Helvetica')
        .text(`${s.severity}`, 300, rightY, { continued: true })
        .fillColor(COLOR_FG_MUTED).text(`  ${s.count}`, { align: 'right' });
      rightY += 12;
    }
    doc.y = Math.max(leftY, rightY) + 14;
  }

  private renderTopVehicles(doc: PDFKit.PDFDocument, report: FleetStatsReport, topN: number): void {
    if (report.topVehicles.length === 0) return;
    if (doc.y > 700) doc.addPage();

    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Top vehicules (km parcourus)', 40, doc.y);
    doc.moveDown(0.4);

    // Table header
    const colX = [40, 200, 320, 410];
    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica-Bold')
      .text('Plaque', colX[0]!, doc.y, { continued: false })
      .text('Trajets', colX[2]!, doc.y - 11)
      .text('Distance', colX[1]!, doc.y - 11)
      .text('Carburant est.', colX[3]!, doc.y - 11);
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
      doc.text(`${v.estimatedConsumptionL.toFixed(1)} L`, colX[3]!, y);
      doc.moveDown(0.6);
    }
    doc.moveDown();
  }

  /**
   * Section "Trajets recents" — liste les 30 derniers trajets avec leurs
   * informations cles + la note libre. Une nouvelle page est ajoutee si on
   * approche du bas, et le tableau est paginé tout seul (chaque rangee
   * verifie l'espace restant).
   *
   * Phase 2 ajoutera la colonne "Conducteur" entre Plaque et Distance.
   */
  private renderRecentTrips(doc: PDFKit.PDFDocument, report: FleetStatsReport, maxTrips: number): void {
    if (!report.recentTrips || report.recentTrips.length === 0) return;

    if (doc.y > 680) doc.addPage();

    const trips = report.recentTrips.slice(0, maxTrips);

    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Trajets recents', 40, doc.y);
    doc.moveDown(0.4);
    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
      .text(
        `${trips.length} derniers trajets sur la periode` +
        (report.trips.count > trips.length
          ? ` (sur ${report.trips.count} au total)`
          : ''),
        40, doc.y,
      );
    doc.moveDown(0.6);

    // Colonnes : Date | Plaque | Duree | Distance | Conducteur | Note
    const colX = { date: 40, plate: 120, duration: 175, distance: 220, driver: 275, notes: 365 };
    const colW = { driver: 85, notes: 190 };

    const renderHeader = () => {
      const y = doc.y;
      doc.fillColor(COLOR_FG_MUTED).fontSize(8).font('Helvetica-Bold')
        .text('DATE', colX.date, y)
        .text('PLAQUE', colX.plate, y)
        .text('DUREE', colX.duration, y)
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
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(8).fillColor(COLOR_FG_MUTED).font('Helvetica')
        .text(
          `Genere automatiquement par Vizyo Tracky — ${formatFleetDateTime(new Date())}`,
          40, 800, { width: 515, align: 'center' },
        );
    }
  }
}
