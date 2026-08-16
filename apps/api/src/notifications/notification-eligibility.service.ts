import { Injectable, Logger } from '@nestjs/common';
import { AccessType, UserRole } from '@prisma/client';
import type { UserPermissions, UserRoleSlug } from '@vizyo/tracky-shared';
import { PERMISSION_KEYS, getDefaultPermissions } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A-T-IL LE DROIT DE SAVOIR ? — le filtre qui manquait à toute la chaîne de notification.
 *
 * ── Le défaut constaté (audit du 2026-08-02) ─────────────────────────────────────────
 * Deux modèles d'autorisation coexistaient sans jamais se parler :
 *   - le modèle de PERMISSIONS (`UserPermissions`, `UserVehicleAccess`) gardait les routes HTTP ;
 *   - un booléen `receivesFleetAlerts`, réglable par l'intéressé, gardait les notifications.
 * Le second n'interrogeait jamais le premier. Le mot « permission » n'apparaissait pas une
 * seule fois dans `apps/api/src/notifications/` en dehors de la surface HTTP.
 *
 * Conséquence mesurée en production : la MÊME alerte était filtrée en HTTP (`GET /alerts`
 * répond 403 à qui n'a pas `alerts_view`) et non filtrée en push et en temps réel. Un
 * compte pouvait recevoir sur son téléphone le titre, la plaque et la position d'une alerte
 * que le serveur lui refusait à l'écran.
 *
 * ── Pourquoi un service dédié plutôt que `PermissionsResolverService` ────────────────
 * Ce résolveur-là travaille sur un `AuthUser` porté par une requête HTTP, avec un cache
 * mémoïsé sur l'objet. Le dispatch, lui, est un chemin de FOND : pas de requête, pas
 * d'`AuthUser`, et N destinataires à trancher d'un coup. Le réutiliser tel quel imposerait
 * de fabriquer de faux `AuthUser` et produirait une requête par destinataire.
 *
 * ⚠️ La SÉMANTIQUE, elle, est copiée à l'identique (`applyFallbacks` de ce résolveur) :
 * défauts de rôle, surchargés par `User.permissions`, surchargés par les permissions du
 * scope d'accès. Deux réponses différentes à « a-t-il le droit ? » selon le canal seraient
 * pires que pas de filtre du tout — on ne saurait plus laquelle est la vraie.
 */

/** Pourquoi un destinataire est écarté — repris tel quel comme motif de journal. */
export type EligibilityVerdict =
  /** Le droit est là, et le véhicule est dans son périmètre. */
  | 'ok'
  /** `alerts_view` est faux pour ce compte. */
  | 'no_permission'
  /** Le droit est là, mais ce véhicule n'est pas dans son périmètre d'accès. */
  | 'out_of_scope';

interface UserRow {
  id: string;
  role: UserRole | string;
  permissions: unknown;
}

@Injectable()
export class NotificationEligibilityService {
  private readonly logger = new Logger(NotificationEligibilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tranche, pour un lot de destinataires, s'ils ont le droit d'être notifiés de CETTE alerte.
   *
   * Deux requêtes au total, quel que soit le nombre de destinataires — le dispatch traite
   * jusqu'à une dizaine de personnes par alerte et tourne des centaines de fois par jour.
   *
   * @param vehicleId véhicule concerné, ou `null` pour une alerte de flotte (le périmètre
   *                  véhicule ne s'applique alors pas : il n'y a pas de véhicule à cadrer).
   */
  async check(userIds: string[], vehicleId: string | null): Promise<Map<string, EligibilityVerdict>> {
    const verdicts = new Map<string, EligibilityVerdict>();
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return verdicts;

    let users: UserRow[];
    try {
      users = await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, role: true, permissions: true },
      });
    } catch (err) {
      // ⚠️ FAIL-CLOSED, à l'inverse de l'anti-spam.
      //
      // L'anti-spam laisse passer en cas de panne : son pire cas est une notification de
      // trop. Ici le pire cas est la divulgation d'une alerte — plaque, position — à
      // quelqu'un qui n'y a pas droit. Une panne ne doit jamais ÉLARGIR une audience.
      this.logger.error(
        `[notif] vérification des droits indisponible — aucun destinataire retenu: ${err instanceof Error ? err.message : err}`,
      );
      for (const id of ids) verdicts.set(id, 'no_permission');
      return verdicts;
    }

    const found = new Set(users.map((u) => u.id));
    // Un identifiant qui ne correspond à aucun compte (compte supprimé entre la résolution
    // et ici) n'est pas « autorisé par défaut ».
    for (const id of ids) if (!found.has(id)) verdicts.set(id, 'no_permission');

    // Les administrateurs court-circuitent, exactement comme `PermissionsResolverService.isAdmin`.
    const scoped = users.filter((u) => u.role !== UserRole.SUPER_ADMIN && u.role !== UserRole.FLEET_ADMIN);
    for (const u of users) {
      if (u.role === UserRole.SUPER_ADMIN || u.role === UserRole.FLEET_ADMIN) {
        verdicts.set(u.id, this.hasAlertsView(getDefaultPermissions(u.role as UserRoleSlug)) ? 'ok' : 'no_permission');
      }
    }
    if (scoped.length === 0) return verdicts;

    const access = await this.prisma.userVehicleAccess.findMany({
      where: { userId: { in: scoped.map((u) => u.id) } },
      select: { userId: true, accessType: true, groupId: true, vehicleId: true, permissions: true },
    });

    // Les groupes ne portent pas la liste de leurs véhicules ici : on ne la charge QUE si
    // au moins une règle de groupe existe et qu'un véhicule est à cadrer.
    const groupIds = [...new Set(access.filter((a) => a.accessType === AccessType.GROUP && a.groupId).map((a) => a.groupId as string))];
    let vehicleInGroups = new Set<string>();
    if (vehicleId && groupIds.length > 0) {
      const assignments = await this.prisma.vehicleGroupAssignment.findMany({
        where: { groupId: { in: groupIds }, vehicleId },
        select: { groupId: true },
      });
      vehicleInGroups = new Set(assignments.map((a) => a.groupId));
    }

    for (const u of scoped) {
      const rules = access.filter((a) => a.userId === u.id);

      // Règles qui COUVRENT ce véhicule. Sans véhicule (alerte de flotte), toutes comptent :
      // il n'y a rien à cadrer, seul le droit compte.
      const covering = vehicleId
        ? rules.filter((r) =>
            r.accessType === AccessType.ALL ||
            (r.accessType === AccessType.VEHICLE && r.vehicleId === vehicleId) ||
            (r.accessType === AccessType.GROUP && r.groupId != null && vehicleInGroups.has(r.groupId)),
          )
        : rules;

      if (vehicleId && rules.length > 0 && covering.length === 0) {
        // Il a un périmètre défini, et ce véhicule n'en fait pas partie. C'est un refus de
        // PORTÉE, pas de droit : le distinguer permet de corriger au bon endroit.
        verdicts.set(u.id, 'out_of_scope');
        continue;
      }

      // Aucune ligne d'accès : repli sur `User.permissions` puis les défauts du rôle —
      // identique à `applyFallbacks(null, user)`.
      const base = this.userPermissions(u);
      if (covering.length === 0) {
        verdicts.set(u.id, this.hasAlertsView(base) ? 'ok' : 'no_permission');
        continue;
      }

      // « Peut globalement » = au moins un scope couvrant l'autorise. Même union que
      // `resolveGlobal`, restreinte aux scopes qui couvrent ce véhicule.
      const allowed = covering.some((r) => this.hasAlertsView(this.mergeScope(base, r.permissions)));
      verdicts.set(u.id, allowed ? 'ok' : 'no_permission');
    }

    return verdicts;
  }

  /** `User.permissions` par-dessus les défauts du rôle. */
  private userPermissions(u: UserRow): UserPermissions {
    const roleDefaults = getDefaultPermissions(u.role as UserRoleSlug);
    const explicit = u.permissions as Partial<UserPermissions> | null;
    return explicit ? { ...roleDefaults, ...explicit } : roleDefaults;
  }

  /** Permissions du scope par-dessus la base — seules les clés RENSEIGNÉES écrasent. */
  private mergeScope(base: UserPermissions, scopePerms: unknown): UserPermissions {
    const scope = scopePerms as Partial<UserPermissions> | null;
    if (!scope) return base;
    const merged: UserPermissions = { ...base };
    for (const key of PERMISSION_KEYS) {
      if (scope[key] !== undefined) merged[key] = scope[key] as boolean;
    }
    return merged;
  }

  private hasAlertsView(p: UserPermissions): boolean {
    return p.alerts_view === true;
  }
}
