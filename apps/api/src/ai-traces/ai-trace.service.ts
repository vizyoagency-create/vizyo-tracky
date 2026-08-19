import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Verdict d'une trace — le champ qui a de la valeur.
 *
 * `concluant` : le résultat a été retenu par l'application.
 * `rejete`    : il a été écarté (réponse vide, tronquée, hors schéma, jugée fausse, appel en
 *               échec). C'est CE lot qu'on relit pour améliorer un agent ; l'autre ne sert qu'à
 *               savoir à quoi ressemble une bonne entrée.
 */
export type AiTraceVerdict = 'concluant' | 'rejete';

export interface AiTraceEntry {
  /** Même vocabulaire que `ai_usage_logs.action` : les deux tables se lisent ensemble. */
  action: string;
  executor?: 'api' | 'local';
  model?: string | null;
  fleetId?: string | null;
  /** Ce qui a été envoyé au modèle. */
  input: unknown;
  /** Ce qu'il a rendu, AVANT assainissement. Absent si l'appel a échoué. */
  output?: unknown;
  error?: string | null;
  latencyMs?: number | null;
  verdict: AiTraceVerdict;
  verdictNote?: string | null;
}

/**
 * Traces conservées PAR ACTION.
 *
 * Un plafond par action plutôt qu'une purge par ancienneté : une purge à N mois effacerait
 * intégralement les traces d'une action rare — précisément celle dont on a le moins d'exemples et
 * le plus besoin. Le plafond, lui, garantit un échantillon récent pour CHAQUE action, y compris
 * celles qui ne tournent qu'une fois par semaine.
 */
const KEEP_PER_ACTION = 200;
/** Au-delà, le payload est tronqué et MARQUÉ comme tel — jamais coupé en silence. */
const INPUT_MAX_CHARS = 32_000;
const OUTPUT_MAX_CHARS = 16_000;

/**
 * Conservation des couples (entrée, sortie) des appels IA.
 *
 * ── Pourquoi ce service existe ───────────────────────────────────────────────────────
 * L'application gardait les RÉSULTATS mais jamais l'ENTRÉE. On n'améliore pas un agent en
 * relisant ses bonnes réponses : on l'améliore en retrouvant les payloads qui ont produit une
 * réponse fausse, vide ou hors sujet. Sans l'entrée, un échec n'est pas reproductible et la seule
 * correction possible reste l'intuition.
 *
 * ── Ce service ne lève JAMAIS ────────────────────────────────────────────────────────
 * Une trace est une commodité de mise au point. Faire échouer un récit de trajet parce que son
 * archivage a raté serait absurde : on perdrait le travail utile pour sauver son commentaire.
 */
@Injectable()
export class AiTraceService {
  private readonly logger = new Logger(AiTraceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AiTraceEntry): Promise<void> {
    try {
      await this.prisma.aiAgentTrace.create({
        data: {
          action: entry.action,
          executor: entry.executor === 'local' ? 'local' : 'api',
          model: entry.model ?? null,
          fleetId: entry.fleetId ?? null,
          input: this.borner(entry.input, INPUT_MAX_CHARS) as Prisma.InputJsonValue,
          output:
            entry.output === undefined
              ? Prisma.JsonNull
              : (this.borner(entry.output, OUTPUT_MAX_CHARS) as Prisma.InputJsonValue),
          error: entry.error ? entry.error.slice(0, 1000) : null,
          latencyMs: entry.latencyMs ?? null,
          verdict: entry.verdict,
          verdictNote: entry.verdictNote ? entry.verdictNote.slice(0, 600) : null,
        },
      });
      await this.elaguer(entry.action);
    } catch (e) {
      // Une trace perdue est un désagrément ; une requête métier cassée par son archivage
      // serait une faute. On journalise et on continue.
      this.logger.warn(`Trace IA non conservée (${entry.action}) : ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * Ramène une action à ses {@link KEEP_PER_ACTION} traces les plus récentes.
   *
   * Best-effort et volontairement séparé de l'insertion : si l'élagage échoue, la trace est déjà
   * écrite — c'est le bon ordre. L'inverse perdrait la trace pour cause de ménage raté.
   */
  private async elaguer(action: string): Promise<void> {
    try {
      const trop = await this.prisma.aiAgentTrace.findMany({
        where: { action },
        orderBy: { createdAt: 'desc' },
        skip: KEEP_PER_ACTION,
        select: { id: true },
      });
      if (trop.length > 0) {
        await this.prisma.aiAgentTrace.deleteMany({ where: { id: { in: trop.map((t) => t.id) } } });
      }
    } catch (e) {
      this.logger.warn(`Élagage des traces (${action}) : ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * Borne un payload. Au-delà du plafond, on ne coupe PAS le JSON en silence — on rend un objet
   * qui DIT qu'il est tronqué, avec la taille d'origine et un aperçu. Un JSON coupé au milieu
   * serait illisible et, pire, passerait pour la donnée réelle.
   */
  private borner(valeur: unknown, max: number): unknown {
    let texte: string;
    try {
      texte = JSON.stringify(valeur) ?? 'null';
    } catch {
      return { tronque: true, motif: 'payload non sérialisable' };
    }
    if (texte.length <= max) return valeur;
    return {
      tronque: true,
      tailleOriginale: texte.length,
      apercu: texte.slice(0, max),
    };
  }

  /** Traces les plus récentes, pour relire un cas. Filtrable par action et par verdict. */
  async list(opts: { action?: string; verdict?: AiTraceVerdict; limit?: number } = {}) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.prisma.aiAgentTrace.findMany({
      where: {
        ...(opts.action ? { action: opts.action } : {}),
        ...(opts.verdict ? { verdict: opts.verdict } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Combien de traces par action et par verdict — de quoi savoir où il y a de la matière. */
  async resume(): Promise<Array<{ action: string; verdict: string; total: number }>> {
    const rows = await this.prisma.aiAgentTrace.groupBy({
      by: ['action', 'verdict'],
      _count: { _all: true },
    });
    return rows
      .map((r) => ({ action: r.action, verdict: r.verdict, total: r._count._all }))
      .sort((a, b) => b.total - a.total);
  }
}
