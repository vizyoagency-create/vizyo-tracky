import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Forme minimale d'un viewer : on ne dépend que du flag owner. */
interface OwnerAwareViewer {
  isOwner?: boolean | null;
}

/**
 * « Owner » plateforme (niveau au-dessus des SUPER_ADMIN).
 *
 * Un compte owner reste techniquement SUPER_ADMIN (pouvoirs inchangés) mais doit
 * être INVISIBLE aux autres super-admins : exclu des listes d'utilisateurs, de
 * toutes les vues d'activité, des rapports/coûts IA, et masqué comme auteur
 * d'action. Ce service centralise la seule brique variable — l'ensemble des IDs
 * owner — et la logique « un owner voit tout, un non-owner voit tout sauf les
 * owners ». Les points de lecture construisent leur filtre Prisma à partir d'ici.
 *
 * Les IDs sont cachés (TTL court) car les vues admin peuvent être fréquentes et
 * l'ensemble owner ne change quasiment jamais.
 */
@Injectable()
export class OwnerVisibilityService {
  private cache: { rows: { id: string; email: string }[]; at: number } | null = null;
  private readonly ttlMs = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  /** Comptes owner (en général un seul), id + email. Caché (TTL 30 s) — évite
   *  une requête par requête HTTP sur les vues admin ; l'ensemble owner ne change
   *  quasiment jamais. */
  async getOwners(): Promise<{ id: string; email: string }[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.rows;
    const rows = await this.prisma.user.findMany({
      where: { isOwner: true },
      select: { id: true, email: true },
    });
    this.cache = { rows, at: now };
    return rows;
  }

  /** IDs de tous les comptes owner. */
  async getOwnerIds(): Promise<string[]> {
    return (await this.getOwners()).map((r) => r.id);
  }

  /** Emails (lowercase) de tous les comptes owner — pour les rapprochements par
   *  email (ex: sync Auth/Tracky qui lit la base Auth directement). */
  async getOwnerEmailsLower(): Promise<string[]> {
    return (await this.getOwners()).map((r) => r.email.toLowerCase());
  }

  /** Invalide le cache (à appeler si on ajoute/retire un owner à chaud). */
  invalidate(): void {
    this.cache = null;
  }

  /** true si ce viewer doit voir les owners masqués (= n'est pas lui-même owner). */
  isMasked(viewer: OwnerAwareViewer | null | undefined): boolean {
    return !viewer?.isOwner;
  }

  /**
   * IDs owner à MASQUER pour ce viewer : liste vide si le viewer est lui-même
   * owner (il voit tout, y compris les autres owners), sinon la liste des owners.
   */
  async hiddenIdsFor(viewer: OwnerAwareViewer | null | undefined): Promise<string[]> {
    if (viewer?.isOwner) return [];
    return this.getOwnerIds();
  }

  /**
   * Fragment Prisma pour un champ userId NON-nullable (ex: user_activities.userId,
   * engine_control_commands.requestedBy). `{}` si rien à masquer → sûr à étaler
   * dans un `where`.
   */
  async userIdExclusion(
    viewer: OwnerAwareViewer | null | undefined,
    field = 'userId',
  ): Promise<Record<string, unknown>> {
    const ids = await this.hiddenIdsFor(viewer);
    if (ids.length === 0) return {};
    return { [field]: { notIn: ids } };
  }

  /**
   * Fragment Prisma pour un champ userId NULLABLE (ex:
   * system_activity_logs.triggeredByUserId). Conserve explicitement les lignes à
   * NULL (actions système sans acteur humain) et n'exclut QUE les owners —
   * contrairement à un simple `notIn` qui écarterait aussi les NULL en SQL.
   * `{}` si rien à masquer. Le fragment contient un `OR` : à combiner via un `AND`.
   */
  async nullableUserIdExclusion(
    viewer: OwnerAwareViewer | null | undefined,
    field = 'triggeredByUserId',
  ): Promise<Record<string, unknown>> {
    const ids = await this.hiddenIdsFor(viewer);
    if (ids.length === 0) return {};
    return { OR: [{ [field]: null }, { [field]: { notIn: ids } }] };
  }
}
