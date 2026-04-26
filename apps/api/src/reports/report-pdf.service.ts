import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { FleetStatsReport } from './reports-stats.service';

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

@Injectable()
export class ReportPdfService {
  generate(report: FleetStatsReport): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
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

        this.renderHeader(doc, report);
        this.renderKpis(doc, report);
        this.renderAlerts(doc, report);
        this.renderTopVehicles(doc, report);
        this.renderFooter(doc);

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  private renderHeader(doc: PDFKit.PDFDocument, report: FleetStatsReport): void {
    // Logo / nom Tracky en haut-gauche
    doc.fillColor(COLOR_TRACKY).fontSize(20).font('Helvetica-Bold')
      .text('Vizyo Tracky', 40, 40);
    doc.fillColor(COLOR_FG_MUTED).fontSize(9).font('Helvetica')
      .text('Rapport de flotte', 40, 65);

    // Bandeau periode en haut-droite
    const fromStr = new Date(report.period.from).toLocaleDateString('fr-FR');
    const toStr = new Date(report.period.to).toLocaleDateString('fr-FR');
    doc.fillColor(COLOR_FG).fontSize(11).font('Helvetica')
      .text(`${fromStr} → ${toStr}`, 400, 42, { width: 155, align: 'right' });
    doc.fillColor(COLOR_FG_MUTED).fontSize(9)
      .text(`${report.period.days} jours`, 400, 60, { width: 155, align: 'right' });

    // Fleet name
    doc.moveDown(2);
    doc.fillColor(COLOR_FG).fontSize(16).font('Helvetica-Bold')
      .text(report.fleet.name, 40, 95);

    doc.moveTo(40, 125).lineTo(555, 125).strokeColor(COLOR_TRACKY).lineWidth(1.5).stroke();
    doc.y = 140;
  }

  private renderKpis(doc: PDFKit.PDFDocument, report: FleetStatsReport): void {
    doc.fillColor(COLOR_FG).fontSize(13).font('Helvetica-Bold')
      .text('Indicateurs cles', 40, doc.y);
    doc.moveDown(0.4);

    const kpis: { label: string; value: string }[] = [
      { label: 'Vehicules actifs', value: `${report.vehicles.activeDuringPeriod} / ${report.vehicles.total}` },
      { label: 'Trajets', value: report.trips.count.toString() },
      { label: 'Distance totale', value: `${report.trips.totalKm.toFixed(1)} km` },
      { label: 'Duree totale', value: `${report.trips.totalDurationHours.toFixed(1)} h` },
      { label: 'Vitesse moy.', value: `${report.trips.avgSpeedKmh.toFixed(1)} km/h` },
      { label: 'Vitesse max', value: `${report.trips.maxSpeedKmh.toFixed(0)} km/h` },
      { label: 'Conso estimee', value: `${report.consumption.estimatedLiters.toFixed(1)} L` },
      { label: 'Cout carburant', value: `${report.consumption.estimatedCostEur.toFixed(2)} EUR` },
    ];

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

  private renderTopVehicles(doc: PDFKit.PDFDocument, report: FleetStatsReport): void {
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

    for (const v of report.topVehicles) {
      const y = doc.y;
      doc.fillColor(COLOR_FG).fontSize(10).font('Helvetica')
        .text(v.plate, colX[0]!, y);
      doc.text(`${v.distanceKm.toFixed(1)} km`, colX[1]!, y);
      doc.text(`${v.tripCount}`, colX[2]!, y);
      doc.text(`${v.estimatedConsumptionL.toFixed(1)} L`, colX[3]!, y);
      doc.moveDown(0.6);
    }
    doc.moveDown();
  }

  private renderFooter(doc: PDFKit.PDFDocument): void {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(8).fillColor(COLOR_FG_MUTED).font('Helvetica')
        .text(
          `Genere automatiquement par Vizyo Tracky — ${new Date().toLocaleString('fr-FR')}`,
          40, 800, { width: 515, align: 'center' },
        );
    }
  }
}
