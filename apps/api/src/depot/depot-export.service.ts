import { ForbiddenException, Injectable } from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import type { DepotExportFormat, DepotExportPreviewDto } from '@vizyo/tracky-shared';
import Papa from 'papaparse';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espace depot (2026-08) — l'export d'une periode (A3 § 5).
 *
 * ┌─ POURQUOI UN GENERATEUR A PART ───────────────────────────────────────────┐
 * │ « Ne pas reutiliser le generateur de `/reports` : ses colonnes exposent des │
 * │ donnees d'exploitation » (A3 § 8). Ce n'est pas une precaution de style :   │
 * │ `ReportCsvService.trips()` sert vitesse maximale, vitesse moyenne, conso et │
 * │ score — chacune interdite a un depot (A3 § 7, regle 2).                     │
 * │                                                                            │
 * │ Reutiliser puis retirer des colonnes, c'est se condamner a en oublier une   │
 * │ le jour ou quelqu'un en ajoutera une. Ici, les colonnes sont ECRITES A LA   │
 * │ MAIN, et la liste tient en dix lignes qu'on relit d'un coup d'oeil.         │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

const BOM = '﻿';

/** Charte : accent Tracky, encre foncee sur fond clair (le PDF s'imprime). */
const COULEUR_ACCENT = '#0A9E6C';
const COULEUR_TEXTE = '#0A1311';
const COULEUR_ATTENUE = '#56635E';
const COULEUR_VIOLET = '#7C3AED';

/** Borne dure : un export est bufferise en RAM avant d'etre servi. */
const MAX_MISSIONS = 2000;

/**
 * Poids moyen MESURE sur le jeu de reference, pour l'estimation affichee AVANT
 * generation (9 missions : 3,4 Ko en PDF, 0,9 Ko en CSV). Volontairement un peu
 * genereux : mieux vaut annoncer 1,2 Mo et en telecharger 900 Ko que l'inverse.
 */
const OCTETS_PAR_MISSION_PDF = 260;
const OCTETS_PAR_MISSION_CSV = 110;
const ENTETE_PDF_OCTETS = 3_200;

export interface FichierExport {
  filename: string;
  contentType: string;
  body: Buffer;
}

@Injectable()
export class DepotExportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Le nombre de trajets concernes, affiche AVANT de generer (A3 § 5).
   *
   * Sur mobile s'y ajoute le poids estime : un export lance en 4G sans avertissement
   * est une mauvaise surprise. L'estimation est volontairement grossiere — elle sert
   * a distinguer 200 Ko de 4 Mo, pas a annoncer un chiffre au kilo-octet pres.
   */
  async apercu(userId: string, from: Date, to: Date, format: DepotExportFormat): Promise<DepotExportPreviewDto> {
    const missionCount = await this.prisma.mission.count({ where: this.perimetre(userId, from, to) });
    const parMission = format === 'PDF' ? OCTETS_PAR_MISSION_PDF : OCTETS_PAR_MISSION_CSV;
    return {
      missionCount,
      estimatedBytes: (format === 'PDF' ? ENTETE_PDF_OCTETS : 0) + missionCount * parMission,
    };
  }

  async generer(
    userId: string,
    from: Date,
    to: Date,
    format: DepotExportFormat,
  ): Promise<FichierExport> {
    const missions = await this.prisma.mission.findMany({
      where: this.perimetre(userId, from, to),
      select: {
        ref: true,
        originLabel: true,
        destLabel: true,
        startAt: true,
        endAt: true,
        actualStartAt: true,
        actualEndAt: true,
        vehicle: { select: { plate: true } },
        trips: { select: { distanceKm: true } },
        // Volontairement ABSENTS : notes, driverId, fleetId, vehicleId, depotUserId,
        // et TOUTE donnee d'exploitation (vitesses, conso, score, cout).
      },
      orderBy: { startAt: 'asc' },
      take: MAX_MISSIONS,
    });

    const compte = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, fleet: { select: { name: true } } },
    });
    const transporteur = compte?.fleet?.name ?? 'Votre transporteur';
    const depot = [compte?.firstName, compte?.lastName].filter(Boolean).join(' ').trim() || 'Dépôt';

    const lignes = missions.map((m) => this.versLigne(m));
    const suffixe = `${this.jourCourt(from)}_${this.jourCourt(to)}`;

    if (format === 'CSV') {
      const csv = Papa.unparse(lignes, { delimiter: ';', header: true });
      return {
        filename: `missions_${suffixe}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: Buffer.from(BOM + csv, 'utf8'),
      };
    }

    return {
      filename: `missions_${suffixe}.pdf`,
      contentType: 'application/pdf',
      body: await this.pdf({ lignes, from, to, transporteur, depot }),
    };
  }

  /**
   * Le bon de livraison d'une mission terminee (A3 § 4).
   *
   * Genere a la demande depuis la mission, jamais lu depuis un stockage : une mission
   * corrigee apres coup ne doit pas laisser circuler un PDF perime — et c'est ce PDF
   * que le depot presentera en cas de litige (cf. `DepotDocumentsService`).
   */
  async bonDeLivraison(userId: string, missionId: string): Promise<FichierExport> {
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, depotUserId: userId, status: MissionStatus.DONE },
      select: {
        ref: true,
        originLabel: true,
        destLabel: true,
        startAt: true,
        endAt: true,
        actualStartAt: true,
        actualEndAt: true,
        vehicle: { select: { plate: true } },
        trips: { select: { distanceKm: true } },
        fleet: { select: { name: true } },
      },
    });
    if (!mission) throw new ForbiddenException('Ressource hors de votre périmètre');

    const compte = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    const depot = [compte?.firstName, compte?.lastName].filter(Boolean).join(' ').trim() || 'Dépôt';

    return {
      filename: `bon-de-livraison_${mission.ref}.pdf`,
      contentType: 'application/pdf',
      body: await this.pdfBon(mission, depot),
    };
  }

  private pdfBon(m: MissionExportee & { fleet: { name: string } }, depot: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 48,
          info: { Title: `Bon de livraison ${m.ref}`, Author: m.fleet.name },
        });
        const morceaux: Buffer[] = [];
        doc.on('data', (c: Buffer) => morceaux.push(c));
        doc.on('end', () => resolve(Buffer.concat(morceaux)));
        doc.on('error', reject);

        doc.fillColor(COULEUR_TEXTE).fontSize(20).font('Helvetica-Bold').text(m.fleet.name, 48, 48);
        doc.fillColor(COULEUR_ATTENUE).fontSize(10).font('Helvetica').text('Bon de livraison', 48, 74);
        doc.fillColor(COULEUR_VIOLET).fontSize(15).font('Helvetica-Bold').text(m.ref, 48, 94);

        doc.moveTo(48, 122).lineTo(doc.page.width - 48, 122).strokeColor('#E2E8E5').stroke();

        const retard = m.actualEndAt
          ? Math.max(0, Math.floor((m.actualEndAt.getTime() - m.endAt.getTime()) / 60_000))
          : null;
        const distance = m.trips.reduce((somme, t) => somme + (t.distanceKm ?? 0), 0);

        let y = 144;
        const champ = (libelle: string, valeur: string): void => {
          doc.fillColor(COULEUR_ATTENUE).fontSize(9).font('Helvetica').text(libelle, 48, y);
          doc.fillColor(COULEUR_TEXTE).fontSize(12).font('Helvetica-Bold').text(valeur, 190, y - 2);
          y += 30;
        };

        champ('Destinataire', depot);
        champ('Trajet', `${m.originLabel} → ${m.destLabel}`);
        champ('Créneau annoncé', `${this.horodatage(m.startAt)} → ${this.heure(m.endAt)}`);
        champ('Départ réel', m.actualStartAt ? this.horodatage(m.actualStartAt) : '—');
        champ('Arrivée réelle', m.actualEndAt ? this.horodatage(m.actualEndAt) : '—');
        champ('Camion', m.vehicle.plate);
        if (m.trips.length > 0) champ('Distance', `${Math.round(distance * 10) / 10} km`);
        champ(
          'Ponctualité',
          retard === null ? '—' : retard === 0 ? "Livrée à l'heure" : `+${retard} min`,
        );

        doc.fillColor('#8A938F').fontSize(7.5).font('Helvetica')
          .text('Propulsé par Vizyo Tracky', 48, doc.page.height - 60);

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * LE PERIMETRE. `depotUserId` d'abord, toujours : les bornes de date sont un filtre
   * qui RESTREINT, jamais qui ouvre. Un depot qui poste `from=2000-01-01` n'obtient
   * que ses propres missions, sur une periode plus large.
   */
  private perimetre(userId: string, from: Date, to: Date) {
    return {
      depotUserId: userId,
      startAt: { gte: from, lte: to },
      status: { in: [MissionStatus.DONE, MissionStatus.LATE, MissionStatus.IN_PROGRESS] },
    };
  }

  /** Les colonnes, ECRITES A LA MAIN. Ce qui n'est pas ici ne sort pas. */
  private versLigne(m: MissionExportee): Record<string, string> {
    const distance = m.trips.reduce((somme, t) => somme + (t.distanceKm ?? 0), 0);
    const retard = m.actualEndAt
      ? Math.max(0, Math.floor((m.actualEndAt.getTime() - m.endAt.getTime()) / 60_000))
      : null;
    return {
      Référence: m.ref,
      Départ: m.originLabel,
      Destination: m.destLabel,
      'Créneau prévu': `${this.horodatage(m.startAt)} → ${this.heure(m.endAt)}`,
      'Départ réel': m.actualStartAt ? this.horodatage(m.actualStartAt) : '—',
      'Arrivée réelle': m.actualEndAt ? this.horodatage(m.actualEndAt) : '—',
      Camion: m.vehicle.plate,
      'Distance (km)': m.trips.length > 0 ? (Math.round(distance * 10) / 10).toString() : '—',
      Ponctualité: retard === null ? '—' : retard === 0 ? 'À l\'heure' : `+${retard} min`,
    };
  }

  private pdf(opts: {
    lignes: Record<string, string>[];
    from: Date;
    to: Date;
    transporteur: string;
    depot: string;
  }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          layout: 'landscape',
          margin: 36,
          info: { Title: `${opts.transporteur} — Missions ${opts.depot}`, Author: opts.transporteur },
        });
        const morceaux: Buffer[] = [];
        doc.on('data', (c: Buffer) => morceaux.push(c));
        doc.on('end', () => resolve(Buffer.concat(morceaux)));
        doc.on('error', reject);

        // ── En-tete : la marque du TRANSPORTEUR d'abord, Tracky en pied (A3 § 7,
        //    regle 5). Le depot presente ce document a son transporteur, pas a nous.
        doc.fillColor(COULEUR_TEXTE).fontSize(19).font('Helvetica-Bold').text(opts.transporteur, 36, 34);
        doc.fillColor(COULEUR_ATTENUE).fontSize(9.5).font('Helvetica')
          .text(`Missions livrées à ${opts.depot}`, 36, 58);
        doc.fillColor(COULEUR_VIOLET).fontSize(10).font('Helvetica-Bold')
          .text(`${this.jourLong(opts.from)} → ${this.jourLong(opts.to)}`, 36, 74);

        doc.moveTo(36, 96).lineTo(doc.page.width - 36, 96).strokeColor('#E2E8E5').stroke();

        const colonnes = Object.keys(opts.lignes[0] ?? { Référence: '' });
        const largeurUtile = doc.page.width - 72;
        const largeurs = this.largeurs(colonnes, largeurUtile);

        let y = 112;
        y = this.enteteTableau(doc, colonnes, largeurs, y);

        for (const ligne of opts.lignes) {
          if (y > doc.page.height - 60) {
            doc.addPage();
            y = 48;
            y = this.enteteTableau(doc, colonnes, largeurs, y);
          }
          let x = 36;
          doc.fillColor(COULEUR_TEXTE).fontSize(8.5).font('Helvetica');
          for (const [i, col] of colonnes.entries()) {
            doc.text(ligne[col] ?? '', x, y, { width: largeurs[i]! - 6, ellipsis: true });
            x += largeurs[i]!;
          }
          y += 17;
        }

        if (opts.lignes.length === 0) {
          doc.fillColor(COULEUR_ATTENUE).fontSize(11).font('Helvetica')
            .text('Aucune mission sur cette période.', 36, y + 10);
        }

        // ── Pied : la mention de perimetre. Le document dit CE QU'IL NE CONTIENT PAS,
        //    exactement comme l'encart de la carte — sinon un depot compare ce PDF a
        //    l'activite reelle du camion et croit l'export incomplet.
        doc.fillColor(COULEUR_ATTENUE).fontSize(8).font('Helvetica').text(
          'Ce document ne contient que les missions qui vous sont assignées. ' +
            'Les autres trajets du transporteur n\'y figurent pas.',
          36,
          doc.page.height - 46,
          { width: largeurUtile },
        );
        doc.fillColor('#8A938F').fontSize(7.5).text('Propulsé par Vizyo Tracky', 36, doc.page.height - 32);

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  private enteteTableau(
    doc: PDFKit.PDFDocument,
    colonnes: string[],
    largeurs: number[],
    y: number,
  ): number {
    let x = 36;
    doc.fillColor(COULEUR_ACCENT).fontSize(8).font('Helvetica-Bold');
    for (const [i, col] of colonnes.entries()) {
      doc.text(col.toUpperCase(), x, y, { width: largeurs[i]! - 6, ellipsis: true });
      x += largeurs[i]!;
    }
    doc.moveTo(36, y + 13).lineTo(doc.page.width - 36, y + 13).strokeColor('#E2E8E5').stroke();
    return y + 21;
  }

  /** La reference et les libelles de trajet ont besoin de place ; les dates non. */
  private largeurs(colonnes: string[], total: number): number[] {
    const poids = colonnes.map((c) =>
      c === 'Départ' || c === 'Destination' ? 1.35 : c === 'Créneau prévu' ? 1.25 : 1,
    );
    const somme = poids.reduce((a, b) => a + b, 0);
    return poids.map((p) => (p / somme) * total);
  }

  private horodatage(d: Date): string {
    return d.toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private heure(d: Date): string {
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  private jourLong(d: Date): string {
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  private jourCourt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}

type MissionExportee = {
  ref: string;
  originLabel: string;
  destLabel: string;
  startAt: Date;
  endAt: Date;
  actualStartAt: Date | null;
  actualEndAt: Date | null;
  vehicle: { plate: string };
  trips: Array<{ distanceKm: number }>;
};
