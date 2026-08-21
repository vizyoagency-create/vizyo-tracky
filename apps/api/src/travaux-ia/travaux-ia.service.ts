import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * File de travaux IA exécutés sur le POSTE du propriétaire — cf. design/C1-TRAVAUX-IA-LOCAUX.md.
 *
 * ── LE CONTRAT, EN UNE PHRASE ────────────────────────────────────────────────────────
 *
 * Le serveur PRÉPARE tout (prompt système, schéma JSON, données) et CONSOMME tout (validation,
 * persistance) ; l'agent du poste n'est qu'un COURRIER qui remplit `resultat`. Aucune logique
 * métier ne quitte le serveur — c'est ce qui a permis de basculer le rapport d'activité et
 * l'analyse de lieux en local SANS recopier une seule requête Prisma dans un `.cjs`, la
 * recopie étant la source des trois jours d'incidents qui précèdent ce fichier.
 *
 * ── CYCLE DE VIE D'UN TRAVAIL ────────────────────────────────────────────────────────
 *
 *   a-faire ──(courrier)──▶ pris ──▶ fait ──(consommateur)──▶ ligne EFFACÉE
 *                             │                    (l'objet métier persisté EST la trace)
 *                             └──▶ a-faire (repris après 2 h : agent tué — payé trois fois
 *                                  en deux jours : un reboot, deux crashs de session)
 *                             └──▶ echec (après 3 tentatives — pas d'acharnement, une alerte)
 */

export type TypeTravailIa = 'rapport-activite' | 'analyse-lieu';

/** Un travail pris depuis plus longtemps que ça est réputé abandonné (agent tué). */
export const REPRISE_APRES_MS = 2 * 60 * 60 * 1000;
/** Au-delà, on cesse d'essayer : le travail passe en `echec` et se voit au catalogue. */
export const TENTATIVES_MAX = 3;

@Injectable()
export class TravauxIaService {
  private readonly logger = new Logger(TravauxIaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enfile un travail, en refusant le doublon : si un travail du même type encore vivant
   * (`a-faire`, `pris` ou `fait` non consommé) porte le même `cleIdempotence` dans son
   * contexte, on ne ré-enfile pas. Un producteur horaire qui repasse avant que le courrier
   * soit passé créerait sinon un travail — donc un appel modèle — par heure.
   */
  async enfiler(
    type: TypeTravailIa,
    payload: { system: string; schema: unknown; userPayload: unknown; maxTokens?: number },
    contexte: Record<string, unknown> & { cleIdempotence: string },
  ): Promise<{ enfile: boolean; id?: string }> {
    const existant = await this.prisma.travailIaLocal.findFirst({
      where: {
        type,
        statut: { in: ['a-faire', 'pris', 'fait'] },
        contexte: { path: ['cleIdempotence'], equals: contexte.cleIdempotence },
      },
      select: { id: true },
    });
    if (existant) return { enfile: false };

    const row = await this.prisma.travailIaLocal.create({
      data: {
        type,
        payload: payload as unknown as Prisma.InputJsonValue,
        contexte: contexte as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    this.logger.log(`travail ${type} enfile (${row.id})`);
    return { enfile: true, id: row.id };
  }

  /**
   * Redonne leur chance aux travaux abandonnés, et acte les échecs définitifs.
   * Appelé par les crons consommateurs — pas besoin d'un traitement dédié pour si peu.
   */
  async reprendrePerimes(): Promise<{ repris: number; abandonnes: number }> {
    const limite = new Date(Date.now() - REPRISE_APRES_MS);
    const { count: repris } = await this.prisma.travailIaLocal.updateMany({
      where: { statut: 'pris', prisA: { lt: limite }, tentatives: { lt: TENTATIVES_MAX } },
      data: { statut: 'a-faire', prisA: null },
    });
    const { count: abandonnes } = await this.prisma.travailIaLocal.updateMany({
      where: { statut: 'pris', prisA: { lt: limite }, tentatives: { gte: TENTATIVES_MAX } },
      data: { statut: 'echec', erreur: `abandonne apres ${TENTATIVES_MAX} tentatives (agent interrompu a chaque fois)` },
    });
    if (repris || abandonnes) {
      this.logger.log(`travaux perimes : ${repris} repris, ${abandonnes} abandonnes`);
    }
    return { repris, abandonnes };
  }

  /**
   * Les travaux d'un type que le courrier a terminés et que le consommateur doit ranger.
   * Le `payload` est rendu aussi : l'analyse de lieux persiste les FAITS qui ont nourri le
   * modèle (colonne `facts` + empreinte anti-redite), et ils vivent dans le payload.
   */
  async faits(type: TypeTravailIa): Promise<Array<{ id: string; resultat: unknown; contexte: Record<string, unknown>; payload: Record<string, unknown> }>> {
    const rows = await this.prisma.travailIaLocal.findMany({
      where: { type, statut: 'fait' },
      select: { id: true, resultat: true, contexte: true, payload: true },
      orderBy: { finiA: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, resultat: r.resultat, contexte: r.contexte as Record<string, unknown>, payload: r.payload as Record<string, unknown> }));
  }

  /**
   * Le consommateur a persisté l'objet métier : la ligne s'efface — l'objet EST la trace.
   * S'il a jugé le résultat inexploitable, il repasse par `rejeter` à la place.
   */
  async consommer(id: string): Promise<void> {
    await this.prisma.travailIaLocal.delete({ where: { id } }).catch(() => {
      /* deja consomme par un passage concurrent : sans gravite */
    });
  }

  /** Résultat inexploitable (sanitize a refusé) : on rejoue, puis on acte l'échec. */
  async rejeter(id: string, motif: string): Promise<void> {
    const row = await this.prisma.travailIaLocal.findUnique({ where: { id }, select: { tentatives: true } });
    if (!row) return;
    if (row.tentatives >= TENTATIVES_MAX) {
      await this.prisma.travailIaLocal.update({
        where: { id },
        data: { statut: 'echec', erreur: motif.slice(0, 400) },
      });
    } else {
      await this.prisma.travailIaLocal.update({
        where: { id },
        data: { statut: 'a-faire', resultat: Prisma.DbNull, prisA: null, erreur: motif.slice(0, 400) },
      });
    }
  }

  /** Pour l'écran des traitements : la file en un coup d'œil. */
  async etat(): Promise<{ aFaire: number; pris: number; faits: number; echecs: number }> {
    const [aFaire, pris, faits, echecs] = await Promise.all([
      this.prisma.travailIaLocal.count({ where: { statut: 'a-faire' } }),
      this.prisma.travailIaLocal.count({ where: { statut: 'pris' } }),
      this.prisma.travailIaLocal.count({ where: { statut: 'fait' } }),
      this.prisma.travailIaLocal.count({ where: { statut: 'echec' } }),
    ]);
    return { aFaire, pris, faits, echecs };
  }
}
