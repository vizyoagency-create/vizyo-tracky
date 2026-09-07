import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DemoModeService } from './demo-mode.service';
import { DemoReplayService } from './demo-replay.service';
import { JOURNAL_DEMO } from './journal-demo';

/** Ce que la carte d'administration affiche. */
export interface StatutDemo {
  demo: boolean;
  /** Dernier passage de l'importeur, réussi ou non (journal `system_activity_logs`, catégorie DEMO). */
  dernierRafraichissement: {
    at: string;
    status: string;
    detail: string | null;
    meta: unknown;
  } | null;
  /** Une demande de rafraîchissement est en attente depuis cet instant (le passage suivant du timer la prendra). */
  demandeEnAttenteDepuis: string | null;
  compteurs: {
    vehicules: number;
    boitiersSimules: number;
    trajets: number;
    positions: number;
    tramesRejeu: number;
  } | null;
}

/**
 * L'écran d'administration de la démo : où en est l'import, et « rafraîchir maintenant ».
 *
 * ── POURQUOI LE BOUTON N'IMPORTE PAS LUI-MÊME ─────────────────────────────────────────────
 *
 * L'importeur lit la production. Le conteneur de la démo, lui, N'A AUCUNE ROUTE vers la
 * production — c'est la garantie n° 1 du plan (§ 11), et elle vaut plus qu'un bouton. Le
 * bouton ne fait donc qu'ÉCRIRE UNE DEMANDE dans le journal de la base de démo ; c'est le
 * script du VPS (`demo-refresh.sh --si-demande`, timer toutes les 15 min) qui la lit, lance
 * l'importeur dans un conteneur éphémère relié aux deux réseaux le temps de l'import, et
 * consigne le résultat au même endroit.
 */
@Injectable()
export class DemoAdminService {
  constructor(
    private readonly demoMode: DemoModeService,
    private readonly prisma: PrismaService,
    private readonly replay: DemoReplayService,
  ) {}

  async statut(): Promise<StatutDemo> {
    if (!this.demoMode.enabled) {
      return { demo: false, dernierRafraichissement: null, demandeEnAttenteDepuis: null, compteurs: null };
    }
    const [dernier, vehicules, trajets, positions, tramesRejeu] = await Promise.all([
      this.prisma.systemActivityLog.findFirst({
        where: { category: JOURNAL_DEMO.categorie, action: JOURNAL_DEMO.passage },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.vehicle.count(),
      this.prisma.trip.count(),
      this.prisma.position.count(),
      this.prisma.demoReplayFrame.count(),
    ]);
    const demande = await this.prisma.systemActivityLog.findFirst({
      where: {
        category: JOURNAL_DEMO.categorie,
        action: JOURNAL_DEMO.demande,
        ...(dernier ? { createdAt: { gt: dernier.createdAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      demo: true,
      dernierRafraichissement: dernier
        ? { at: dernier.createdAt.toISOString(), status: dernier.status, detail: dernier.detail, meta: dernier.meta }
        : null,
      demandeEnAttenteDepuis: demande ? demande.createdAt.toISOString() : null,
      compteurs: { vehicules, boitiersSimules: this.replay.nombreBoitiers, trajets, positions, tramesRejeu },
    };
  }

  async demanderRafraichissement(demandeur: { id: string; email: string }): Promise<{ demandeEnAttenteDepuis: string }> {
    if (!this.demoMode.enabled) {
      throw new NotFoundException("Cette instance n'est pas l'environnement de démonstration");
    }
    const ligne = await this.prisma.systemActivityLog.create({
      data: {
        category: JOURNAL_DEMO.categorie,
        action: JOURNAL_DEMO.demande,
        status: 'PENDING',
        actor: demandeur.email.slice(0, 120),
        detail: 'Rafraîchissement demandé depuis l\'écran d\'administration — pris en charge par le prochain passage du timer (15 min au plus).',
        triggeredByUserId: demandeur.id,
      },
    });
    return { demandeEnAttenteDepuis: ligne.createdAt.toISOString() };
  }
}
