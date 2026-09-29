import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { SystemActivityDto } from '@vizyo/tracky-shared';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';

/** Colonnes `@db.Uuid` : toute autre forme ferait rejeter la requête par Prisma (erreur 500). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SystemActivityInput {
  /** 'EMAIL' | 'SMS' | 'PUSH' | 'ENGINE' | 'RETENTION' | 'AI_REPORT' */
  category: string;
  /** Libellé court machine ('email_sent', 'engine_cut', 'positions_purged'…). */
  action: string;
  status?: 'SUCCESS' | 'FAILURE' | 'SKIPPED';
  /** 'system' | 'planning' | nom d'un cron | nom d'utilisateur. */
  actor?: string | null;
  target?: string | null;
  detail?: string | null;
  fleetId?: string | null;
  /** Renseigné si l'action découle d'un acte manuel (sinon null = auto/système). */
  triggeredByUserId?: string | null;
  durationMs?: number | null;
  meta?: Record<string, unknown> | null;
}

/**
 * Palier B — Journal des actions AUTOMATIQUES / système (arrière-plan).
 *
 * `record()` est FIRE-AND-FORGET : aucun `await` requis, et il ne jette JAMAIS —
 * une défaillance du journal ne doit pas casser l'action métier qu'il observe.
 * Appelé depuis les primitives d'envoi (e-mail / SMS / push), les commandes
 * moteur, la purge de rétention et les rapports IA planifiés. La couche « feed »
 * lisible ; l'audit technique détaillé reste dans smsLog / engineControlCommand.
 */
@Injectable()
export class SystemActivityService {
  private readonly logger = new Logger(SystemActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerVis: OwnerVisibilityService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** Enregistre une action système. Ne bloque pas et n'échoue JAMAIS dans l'appelant. */
  record(entry: SystemActivityInput): void {
    // Défense en profondeur : le `try` capture même une erreur SYNCHRONE (ex. client Prisma
    // désynchronisé → `systemActivityLog` absent) que le `.catch` sur la promesse ne verrait
    // pas — le journal ne doit JAMAIS casser l'action métier qu'il observe (e-mail/SMS/moteur).
    try {
      this.prisma.systemActivityLog
        .create({
          data: {
            category: entry.category,
            action: entry.action,
            status: entry.status ?? 'SUCCESS',
            actor: entry.actor ? entry.actor.slice(0, 120) : null,
            target: entry.target ? entry.target.slice(0, 200) : null,
            detail: entry.detail ? entry.detail.slice(0, 500) : null,
            fleetId: entry.fleetId ?? null,
            triggeredByUserId: entry.triggeredByUserId ?? null,
            durationMs: entry.durationMs ?? null,
            meta: (entry.meta ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        })
        .catch((e) => {
          // Log local : visible immédiatement dans `docker logs` pendant un incident.
          this.logger.warn(`record failed: ${e instanceof Error ? e.message : String(e)}`);
          // Le journal Système (e-mails, SMS, moteur, déverrouillages…) qui ne s'écrit
          // plus = audit troué en silence → centre d'alerte (dédup ErrorLogger).
          this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'system-activity', {
            note: 'échec écriture journal système (async)', action: entry.action,
          });
        });
    } catch (e) {
      this.logger.warn(`record threw synchronously: ${e instanceof Error ? e.message : String(e)}`);
      this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'system-activity', {
        note: 'échec écriture journal système (sync)', action: entry.action,
      });
    }
  }

  /**
   * Feed admin (SUPER_ADMIN) — timeline des actions système récentes.
   * 29/09 : filtres optionnels `fleetId` (la société de la ligne) et période `from`/`to` (ISO).
   * Un `fleetId` mal formé rend une liste VIDE (et non tout le journal : l'écran se croirait filtré).
   */
  async getFeed(
    opts: {
      limit?: number;
      before?: string;
      beforeId?: string;
      category?: string;
      status?: string;
      fleetId?: string;
      from?: string;
      to?: string;
    } = {},
    viewer: { isOwner?: boolean | null } = {},
  ): Promise<SystemActivityDto[]> {
    const take = Math.min(Math.max(opts.limit ?? 60, 1), 200);
    // Chaque filtre est une clause du AND : aucun ne peut en écraser un autre (le cursor et
    // l'exclusion owner portent chacun un OR).
    const and: Prisma.SystemActivityLogWhereInput[] = [];
    if (opts.category) and.push({ category: opts.category });
    if (opts.status && ['SUCCESS', 'FAILURE', 'SKIPPED'].includes(opts.status)) and.push({ status: opts.status });
    if (opts.fleetId) {
      if (!UUID_RE.test(opts.fleetId)) return [];
      and.push({ fleetId: opts.fleetId });
    }
    if (opts.from) {
      const d = new Date(opts.from);
      if (!Number.isNaN(d.getTime())) and.push({ createdAt: { gte: d } });
    }
    if (opts.to) {
      const d = new Date(opts.to);
      if (!Number.isNaN(d.getTime())) and.push({ createdAt: { lte: d } });
    }
    if (opts.before) {
      const d = new Date(opts.before);
      if (!Number.isNaN(d.getTime())) {
        // Cursor composite (createdAt, id) — même timestamp = tiebreak id. Un beforeId qui n'est
        // pas un UUID ferait rejeter la requête par Prisma (colonne uuid) : on retombe sur la date.
        and.push(
          opts.beforeId && UUID_RE.test(opts.beforeId)
            ? { OR: [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: opts.beforeId } }] }
            : { createdAt: { lt: d } },
        );
      }
    }
    // Owner plateforme — actions déclenchées par l'owner masquées pour un viewer
    // non-owner. Champ NULLABLE (null = action système sans acteur) → un OR qui
    // CONSERVE les null et n'exclut que les owners, posé comme clause du AND.
    const ownerExcl = await this.ownerVis.nullableUserIdExclusion(viewer, 'triggeredByUserId');
    if (Object.keys(ownerExcl).length) and.push(ownerExcl as Prisma.SystemActivityLogWhereInput);
    const where: Prisma.SystemActivityLogWhereInput = and.length ? { AND: and } : {};
    const rows = await this.prisma.systemActivityLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });

    // Résolution des noms (flotte + déclencheur) en 2 requêtes groupées (pas de N+1).
    const fleetIds = [...new Set(rows.map((r) => r.fleetId).filter((x): x is string => !!x))];
    const userIds = [
      ...new Set(rows.map((r) => r.triggeredByUserId).filter((x): x is string => !!x)),
    ];
    const [fleets, users] = await Promise.all([
      fleetIds.length
        ? this.prisma.fleet.findMany({ where: { id: { in: fleetIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      userIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, firstName: true, lastName: true },
          })
        : Promise.resolve([]),
    ]);
    const fleetName = new Map(fleets.map((f) => [f.id, f.name]));
    const userName = new Map(
      users.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Utilisateur']),
    );

    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      category: r.category,
      action: r.action,
      status: r.status,
      actor: r.actor,
      target: r.target,
      detail: r.detail,
      fleetId: r.fleetId,
      fleetName: r.fleetId ? (fleetName.get(r.fleetId) ?? null) : null,
      triggeredByUserId: r.triggeredByUserId,
      triggeredByName: r.triggeredByUserId ? (userName.get(r.triggeredByUserId) ?? null) : null,
      durationMs: r.durationMs,
      // Cause d'échec extraite de meta.error — rétroactif sur les lignes déjà en base.
      error:
        r.meta && typeof r.meta === 'object' && typeof (r.meta as Record<string, unknown>)['error'] === 'string'
          ? ((r.meta as Record<string, unknown>)['error'] as string)
          : null,
    }));
  }
}
