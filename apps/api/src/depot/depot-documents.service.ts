import { ForbiddenException, Injectable } from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import {
  DEPOT_RETENTION_MONTHS,
  type DepotDocumentDto,
  type DepotDocumentsDto,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espace depot (2026-08) — l'onglet Documents (A3 § 4).
 *
 * ┌─ LES DOCUMENTS SONT DERIVES, PAS STOCKES ─────────────────────────────────┐
 * │ Un bon de livraison est produit A LA DEMANDE depuis la mission qu'il        │
 * │ documente. Rien n'est ecrit dans un bucket au moment de la cloture.         │
 * │                                                                            │
 * │ Pourquoi : un fichier stocke devient une seconde source de verite. Une      │
 * │ mission corrigee apres coup (creneau, plaque) laisserait un PDF perime qui  │
 * │ continue de circuler — et c'est le PDF que le depot presente a son          │
 * │ transporteur en cas de litige. On regenere, on ne conserve pas.             │
 * │                                                                            │
 * │ Corollaire assume : l'identifiant d'un document est DERIVE de la mission,   │
 * │ donc stable, donc partageable — sans etre un identifiant de stockage.       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * « Si le transporteur n'en produit pas, l'onglet affiche son etat vide sans erreur »
 * (A3 § 8) : aucune mission terminee ne produit aucun document, et c'est un etat
 * normal — jamais une erreur.
 */

/** Clef de `User.preferences` portant l'interrupteur du rapport hebdomadaire. */
const CLEF_RAPPORT_AUTO = 'depotWeeklyReport';

@Injectable()
export class DepotDocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async documents(userId: string): Promise<DepotDocumentsDto> {
    const plancher = new Date();
    plancher.setMonth(plancher.getMonth() - DEPOT_RETENTION_MONTHS);

    const missions = await this.prisma.mission.findMany({
      where: {
        depotUserId: userId,
        status: MissionStatus.DONE,
        startAt: { gte: plancher },
      },
      select: { id: true, ref: true, actualEndAt: true, endAt: true, destLabel: true },
      orderBy: { startAt: 'desc' },
      take: 200,
    });

    const bons: DepotDocumentDto[] = missions.map((m) => ({
      id: `note:${m.id}`,
      kind: 'DELIVERY_NOTE',
      label: `Bon de livraison · ${m.ref}`,
      at: (m.actualEndAt ?? m.endAt).toISOString(),
      format: 'PDF',
      missionRef: m.ref,
    }));

    const documents = [...this.rapportsHebdomadaires(missions), ...bons].sort((a, b) =>
      b.at.localeCompare(a.at),
    );

    return { documents, weeklyReportEnabled: await this.rapportActif(userId) };
  }

  /**
   * Les rapports hebdomadaires : un par semaine OU LE DEPOT A EU AU MOINS UNE MISSION.
   *
   * Pas un par semaine du calendrier : une liste de 52 rapports dont 40 sont vides
   * n'est pas un historique, c'est du bruit dans lequel les trois qui comptent se
   * perdent. Le rapport est date du lundi qui SUIT la semaine couverte — c'est le
   * moment de sa generation (« chaque lundi a 08:00 »).
   */
  private rapportsHebdomadaires(
    missions: Array<{ actualEndAt: Date | null; endAt: Date }>,
  ): DepotDocumentDto[] {
    const semaines = new Map<string, Date>();
    for (const m of missions) {
      const lundi = this.lundiSuivant(m.actualEndAt ?? m.endAt);
      const clef = lundi.toISOString().slice(0, 10);
      if (!semaines.has(clef)) semaines.set(clef, lundi);
    }

    const maintenant = new Date();
    return [...semaines.entries()]
      // Un rapport dont la date de generation n'est pas encore passee n'existe pas :
      // la semaine en cours n'a pas encore son lundi.
      .filter(([, lundi]) => lundi <= maintenant)
      .map(([clef, lundi]) => ({
        id: `weekly:${clef}`,
        kind: 'WEEKLY_REPORT' as const,
        label: `Rapport hebdomadaire · semaine du ${this.dateCourte(this.lundiPrecedent(lundi))}`,
        at: lundi.toISOString(),
        format: 'PDF' as const,
        missionRef: null,
      }));
  }

  /** L'interrupteur d'A3 § 4 : ACTIF par defaut. Un dépôt qui n'a rien choisi doit
   *  recevoir le rapport — c'est ce qui lui apprend qu'il existe. */
  async rapportActif(userId: string): Promise<boolean> {
    const compte = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    const prefs = (compte?.preferences as Record<string, unknown> | null) ?? {};
    return prefs[CLEF_RAPPORT_AUTO] !== false;
  }

  /** Fusion, jamais remplacement : le reste des preferences est preserve. */
  async definirRapportActif(userId: string, actif: boolean): Promise<{ weeklyReportEnabled: boolean }> {
    const compte = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    if (!compte) throw new ForbiddenException('Ressource hors de votre périmètre');

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        preferences: {
          ...((compte.preferences as Record<string, unknown>) ?? {}),
          [CLEF_RAPPORT_AUTO]: actif,
        },
      },
    });
    return { weeklyReportEnabled: actif };
  }

  /**
   * Resout un identifiant de document en la mission qu'il documente.
   *
   * ⚠️ Le `where` porte `depotUserId` : un identifiant fabrique a la main
   * (`note:<uuid d'une mission d'un autre depot>`) ne resout rien, et le refus est le
   * MEME que pour un identifiant inconnu.
   */
  async missionDuBon(userId: string, documentId: string): Promise<{ id: string; ref: string }> {
    const missionId = documentId.startsWith('note:') ? documentId.slice(5) : null;
    if (!missionId) throw new ForbiddenException('Ressource hors de votre périmètre');

    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, depotUserId: userId, status: MissionStatus.DONE },
      select: { id: true, ref: true },
    });
    if (!mission) throw new ForbiddenException('Ressource hors de votre périmètre');
    return mission;
  }

  /** Le lundi 08:00 qui suit une date. Un dimanche renvoie le lendemain. */
  private lundiSuivant(at: Date): Date {
    const d = new Date(at);
    d.setHours(8, 0, 0, 0);
    const joursAAjouter = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + joursAAjouter);
    return d;
  }

  private lundiPrecedent(lundi: Date): Date {
    const d = new Date(lundi);
    d.setDate(d.getDate() - 7);
    return d;
  }

  private dateCourte(at: Date): string {
    return at.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long' });
  }
}
