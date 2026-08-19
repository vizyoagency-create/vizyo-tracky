import { Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveTenantScope } from '../common/tenant-scope';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

/**
 * Lots de contexte que l'agent d'assistance peut demander. **Liste FERMÉE.**
 *
 * ── LA règle de cloisonnement ────────────────────────────────────────────────────────
 * Le modèle choisit des CLÉS dans cette liste. Il ne fournit JAMAIS d'identifiant : ni
 * `userId`, ni `vehicleId`, ni `fleetId`. Tous les identifiants viennent du serveur, déduits
 * de l'`AuthUser` de celui qui pose la question.
 *
 * Ce n'est pas un détail d'implémentation, c'est TOUTE la sécurité du dispositif. Si le modèle
 * pouvait passer un `vehicleId`, alors une phrase bien tournée dans la question — ou un texte
 * piégé recopié depuis une alerte — suffirait à lui faire réclamer le véhicule d'une autre
 * société. Ici c'est structurellement impossible : il n'y a pas de paramètre à détourner.
 * Un prompt n'est pas un contrôle d'accès ; celui-ci n'en dépend pas.
 */
export const BUNDLE_KEYS = ['compte', 'activite', 'erreurs', 'vehicules', 'trajets'] as const;
export type BundleKey = (typeof BUNDLE_KEYS)[number];

/** Ce que chaque lot contient, en français — sert au modèle ET à l'écran d'audit. */
export const BUNDLE_LIBELLES: Record<BundleKey, string> = {
  compte: 'Le compte du demandeur : rôle, société, ancienneté, état.',
  activite: 'Son activité récente dans l\'app : écrans visités, actions, sessions.',
  erreurs: 'Les erreurs que CE compte a réellement subies (front et serveur).',
  vehicules: 'Les véhicules auxquels il a accès, avec l\'état de leur boîtier.',
  trajets: 'Ses trajets récents et leur analyse (scores, limites connues).',
};

export interface ContextBundle {
  key: BundleKey;
  libelle: string;
  /** Données réellement lues, déjà réduites à l'utile. `null` quand le lot est refusé. */
  data: unknown;
  /** Nombre d'enregistrements lus — trace d'audit, et garde-fou de volume. */
  volume: number;
  /**
   * Renseigné UNIQUEMENT si le lot a été refusé, avec la raison en clair.
   *
   * On ne se contente pas d'omettre le lot : le modèle doit SAVOIR qu'il a été refusé, sinon il
   * conclut « aucune erreur sur ce compte » là où la vraie réponse est « je n'ai pas le droit de
   * regarder ». Un silence se lit comme une absence, et l'agent affirmerait alors du faux.
   */
  refus?: string;
}

/** Plafonds de lecture. Bornent le coût ET la quantité de données exposée au modèle. */
const CAPS = {
  activite: 40,
  erreurs: 20,
  vehicules: 30,
  trajets: 20,
} as const;

/** Fenêtre d'historique consultée. Au-delà, une donnée n'explique plus une question du jour. */
const FENETRE_JOURS = 14;

/**
 * Construit les lots de contexte que l'agent d'assistance est autorisé à lire, pour la personne
 * qui pose la question — et pour elle seule.
 *
 * Chaque lot applique les MÊMES gardes que le reste de l'API : `resolveTenantScope` (fail-closed),
 * `VehicleAccessService` pour les véhicules, `PermissionsResolverService` pour les droits. Aucune
 * requête n'est réécrite « en plus simple » pour l'assistance : réimplémenter un cloisonnement,
 * c'est se donner une deuxième chance de le rater.
 */
@Injectable()
export class AssistanceContextService {
  private readonly logger = new Logger(AssistanceContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly permissions: PermissionsResolverService,
  ) {}

  /** Vrai si la clé demandée fait partie de la liste fermée. */
  static estCleValide(k: unknown): k is BundleKey {
    return typeof k === 'string' && (BUNDLE_KEYS as readonly string[]).includes(k);
  }

  /**
   * Construit les lots demandés. Les clés inconnues sont IGNORÉES (jamais interprétées) : le
   * modèle qui invente une clé n'obtient rien, il ne déclenche pas une requête approximative.
   */
  async build(user: AuthUser, demandes: readonly string[]): Promise<ContextBundle[]> {
    const cles = [...new Set(demandes.filter(AssistanceContextService.estCleValide))];
    const inconnues = demandes.filter((d) => !AssistanceContextService.estCleValide(d));
    if (inconnues.length) {
      this.logger.warn(`Lots de contexte inconnus ignorés : ${inconnues.join(', ')}`);
    }
    const lots = await Promise.all(cles.map((k) => this.buildOne(user, k)));
    return lots;
  }

  private async buildOne(user: AuthUser, key: BundleKey): Promise<ContextBundle> {
    const libelle = BUNDLE_LIBELLES[key];
    try {
      switch (key) {
        case 'compte':
          return { key, libelle, ...(await this.compte(user)) };
        case 'activite':
          return { key, libelle, ...(await this.activite(user)) };
        case 'erreurs':
          return { key, libelle, ...(await this.erreurs(user)) };
        case 'vehicules':
          return { key, libelle, ...(await this.vehicules(user)) };
        case 'trajets':
          return { key, libelle, ...(await this.trajets(user)) };
      }
    } catch (e) {
      // Un lot qui échoue est un lot REFUSÉ, pas un lot vide : le modèle doit pouvoir dire
      // « je n'ai pas pu vérifier » au lieu d'affirmer qu'il n'y a rien.
      this.logger.warn(`Lot « ${key} » illisible : ${(e as Error)?.message ?? e}`);
      return { key, libelle, data: null, volume: 0, refus: 'Donnée temporairement illisible.' };
    }
  }

  // ─── Lots ────────────────────────────────────────────────────────────────────

  /** Le compte du demandeur. Jamais un autre : l'id vient de la session, pas de la question. */
  private async compte(user: AuthUser): Promise<Omit<ContextBundle, 'key' | 'libelle'>> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        role: true, createdAt: true, isActive: true,
        fleet: { select: { name: true, metier: true, aiEnabled: true } },
      },
    });
    if (!row) return { data: null, volume: 0, refus: 'Compte introuvable.' };
    return {
      volume: 1,
      data: {
        role: row.role,
        societe: row.fleet?.name ?? null,
        metier: row.fleet?.metier ?? null,
        iaActiveSurLaSociete: row.fleet?.aiEnabled ?? false,
        compteActif: row.isActive,
        membreDepuis: row.createdAt.toISOString().slice(0, 10),
      },
    };
  }

  /** Activité récente du DEMANDEUR. `userId` figé sur la session — aucun paramètre à détourner. */
  private async activite(user: AuthUser): Promise<Omit<ContextBundle, 'key' | 'libelle'>> {
    const depuis = new Date(Date.now() - FENETRE_JOURS * 86_400_000);
    const [sessions, pages, actions] = await Promise.all([
      this.prisma.userSession.count({ where: { userId: user.id, startedAt: { gte: depuis } } }),
      this.prisma.userActivity.groupBy({
        by: ['route'],
        where: { userId: user.id, type: 'PAGE_VIEW', route: { not: null }, createdAt: { gte: depuis } },
        _count: { _all: true },
        orderBy: { _count: { route: 'desc' } },
        take: CAPS.activite,
      }),
      this.prisma.userActivity.groupBy({
        by: ['target'],
        where: { userId: user.id, type: { in: ['CLICK', 'FORM_SUBMIT'] }, target: { not: null }, createdAt: { gte: depuis } },
        _count: { _all: true },
        orderBy: { _count: { target: 'desc' } },
        take: CAPS.activite,
      }),
    ]);
    return {
      volume: pages.length + actions.length,
      data: {
        fenetreJours: FENETRE_JOURS,
        sessions,
        ecransVisites: pages.map((p) => ({ ecran: p.route, fois: p._count._all })),
        actions: actions.map((a) => ({ action: a.target, fois: a._count._all })),
      },
    };
  }

  /** Erreurs RÉELLEMENT subies par ce compte. Le filtre `userId` est la garde, pas le prompt. */
  private async erreurs(user: AuthUser): Promise<Omit<ContextBundle, 'key' | 'libelle'>> {
    const depuis = new Date(Date.now() - FENETRE_JOURS * 86_400_000);
    const rows = await this.prisma.errorLog.findMany({
      where: { userId: user.id, createdAt: { gte: depuis }, source: { in: ['frontend', 'http'] } },
      orderBy: { createdAt: 'desc' },
      take: CAPS.erreurs,
      select: { createdAt: true, source: true, level: true, message: true },
    });
    return {
      volume: rows.length,
      data: rows.map((r) => ({
        quand: r.createdAt.toISOString(),
        origine: r.source,
        niveau: r.level,
        // Message TRONQUÉ : une pile d'appel complète exposerait des chemins de fichiers et des
        // noms de classes — exactement ce que l'agent n'a pas le droit de divulguer.
        message: (r.message ?? '').slice(0, 200),
      })),
    };
  }

  /** Véhicules accessibles — via le MÊME service que le reste de l'API, jamais une requête à part. */
  private async vehicules(user: AuthUser): Promise<Omit<ContextBundle, 'key' | 'libelle'>> {
    const scope = resolveTenantScope(user);
    // Fail-closed : un non-super-admin sans société ne voit RIEN. Jamais « toutes les flottes ».
    if (scope.mode === 'DENY') {
      return { data: null, volume: 0, refus: 'Aucune société rattachée à ce compte : aucun véhicule visible.' };
    }
    const accessibles = await this.vehicleAccess.getAccessibleVehicleIds(user);
    if (Array.isArray(accessibles) && accessibles.length === 0) {
      return { data: null, volume: 0, refus: 'Aucun véhicule n\'est attribué à ce compte.' };
    }
    const rows = await this.prisma.vehicle.findMany({
      where: {
        ...(scope.mode === 'FLEET' ? { fleetId: scope.fleetId } : {}),
        ...(Array.isArray(accessibles) ? { id: { in: accessibles } } : {}),
      },
      take: CAPS.vehicules,
      orderBy: { plate: 'asc' },
      select: { id: true, plate: true, tracker: { select: { lastSeenAt: true } } },
    });
    const now = Date.now();
    return {
      volume: rows.length,
      data: rows.map((v) => ({
        plaque: v.plate,
        boitier: !v.tracker
          ? 'aucun boîtier'
          : !v.tracker.lastSeenAt
            ? 'jamais connecté'
            : `vu il y a ${Math.round((now - v.tracker.lastSeenAt.getTime()) / 60_000)} min`,
      })),
    };
  }

  /**
   * Trajets récents. Double garde, dans cet ordre : le DROIT (`trips_view`), puis le PÉRIMÈTRE
   * (véhicules réellement accessibles). Vérifier le périmètre sans le droit laisserait un compte
   * sans permission lire par la bande ce que l'écran lui refuse.
   */
  private async trajets(user: AuthUser): Promise<Omit<ContextBundle, 'key' | 'libelle'>> {
    const perms = await this.permissions.resolveGlobal(user);
    if (!perms?.trips_view) {
      return { data: null, volume: 0, refus: 'Ce compte n\'a pas le droit de consulter les trajets.' };
    }
    const scope = resolveTenantScope(user);
    if (scope.mode === 'DENY') {
      return { data: null, volume: 0, refus: 'Aucune société rattachée à ce compte.' };
    }
    const accessibles = await this.vehicleAccess.getAccessibleVehicleIds(user);
    if (Array.isArray(accessibles) && accessibles.length === 0) {
      return { data: null, volume: 0, refus: 'Aucun véhicule n\'est attribué à ce compte.' };
    }
    const depuis = new Date(Date.now() - FENETRE_JOURS * 86_400_000);
    const rows = await this.prisma.trip.findMany({
      where: {
        startedAt: { gte: depuis },
        endedAt: { not: null },
        ...(scope.mode === 'FLEET' ? { fleetId: scope.fleetId } : {}),
        ...(Array.isArray(accessibles) ? { vehicleId: { in: accessibles } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: CAPS.trajets,
      select: {
        id: true, startedAt: true, durationSeconds: true, distanceKm: true,
        maxSpeed: true, segmentationSource: true,
        vehicle: { select: { plate: true } },
      },
    });
    const analyses = rows.length
      ? await this.prisma.tripAnalysis.findMany({
          where: { tripId: { in: rows.map((r) => r.id) } },
          select: { tripId: true, ecoScore: true, limitsKnown: true },
        })
      : [];
    const parTrajet = new Map(analyses.map((a) => [a.tripId, a]));
    return {
      volume: rows.length,
      data: rows.map((t) => {
        const a = parTrajet.get(t.id);
        return {
          plaque: t.vehicle?.plate ?? null,
          debut: t.startedAt.toISOString(),
          dureeMin: Math.round(t.durationSeconds / 60),
          distanceKm: Math.round(t.distanceKm * 10) / 10,
          vitesseMaxKmh: Math.round(t.maxSpeed),
          // Le découpage explique une bonne part des questions (« pourquoi deux trajets ? »).
          decoupage: t.segmentationSource,
          scoreEco: a?.ecoScore ?? null,
          // Sans limite connue, aucun excès n'est affirmable : l'agent doit le dire plutôt que
          // de conclure « aucun excès », qui serait faux.
          limitesConnues: a ? a.limitsKnown : null,
        };
      }),
    };
  }
}
