import { Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveTenantScope } from '../common/tenant-scope';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { DrivingScoreService } from '../trip-analysis/driving-score.service';
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
export const BUNDLE_KEYS = ['compte', 'activite', 'erreurs', 'vehicules', 'trajets', 'agenda', 'scores'] as const;
export type BundleKey = (typeof BUNDLE_KEYS)[number];

/** Ce que chaque lot contient, en français — sert au modèle ET à l'écran d'audit. */
export const BUNDLE_LIBELLES: Record<BundleKey, string> = {
  compte: 'Le compte du demandeur : rôle, société, ancienneté, état.',
  activite: 'Son activité récente dans l\'app : écrans visités, actions, sessions.',
  erreurs: 'Les erreurs que CE compte a réellement subies (front et serveur).',
  vehicules: 'Les véhicules auxquels il a accès, avec l\'état de leur boîtier.',
  trajets: 'Ses trajets récents et leur analyse (scores, limites connues).',
  agenda: 'Ce qui est planifié sur ses véhicules : missions (droit « missions »), et calendrier des réservations, maintenances et incidents (droit « agenda »). Les deux moitiés sont indépendantes : un compte peut n\'en avoir qu\'une.',
  scores: 'Le classement des scores de conduite de sa société (qui conduit le mieux, et sur quelle distance).',
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
  agenda: 40,
  scores: 30,
} as const;

/**
 * L'agenda regarde DEVANT autant que derrière : « qu'est-ce qui est prévu cette semaine ? » est
 * la question la plus fréquente, et la fenêtre de 14 jours en arrière n'y répondrait pas.
 */
const AGENDA_JOURS_AVANT = 30;

/**
 * Fenêtre du classement — 30 jours, comme l'écran « Scores de conduite » par défaut. Volontairement
 * plus large que `FENETRE_JOURS` : sur 14 jours, un conducteur en congé disparaît du classement, et
 * l'agent répondrait « il n'a pas de score » là où il en a un.
 */
const SCORES_JOURS = 30;

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
    /** Le classement de l'écran « Scores de conduite », tel quel — voir `scores()`. */
    private readonly drivingScores: DrivingScoreService,
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
        case 'agenda':
          return { key, libelle, ...(await this.agenda(user)) };
        case 'scores':
          return { key, libelle, ...(await this.scores(user)) };
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

  /**
   * Ce qui est PLANIFIÉ : missions, réservations, maintenances, incidents.
   *
   * Ajouté le 01/10/2026 — l'assistant ignorait jusque-là que les missions existaient : il
   * répondait « l'agenda contient trois types d'événements », ce qui était vrai avant la refonte
   * du 28/09 et faux depuis. Un assistant qui décrit une version antérieure du produit fait
   * perdre plus de temps qu'il n'en fait gagner.
   *
   * ⚠️ DEUX DROITS, PAS UN — et c'est contre-intuitif. L'écran « Agenda » réunit deux choses qui
   * n'appartiennent pas au même droit :
   *
   *   • le calendrier (maintenances, incidents, réservations) → `agenda_view`
   *   • l'onglet Missions                                     → `missions_view`
   *
   * Un FLEET_MANAGER a `missions_view: true` et **`agenda_view: false` par défaut** : c'est le rôle
   * qui POSSÈDE les missions. Tout gater derrière `agenda_view` aurait refusé les missions à
   * exactement l'audience qui les pilote — le contraire du but de ce lot. La route web porte déjà
   * la même leçon en commentaire (`app.routes.ts`, « Trouvé en testant l'écran, invisible en test
   * unitaire »). L'inverse est aussi vrai : servir les missions à qui n'a que `agenda_view` lui
   * donnerait par l'assistant ce que son écran lui cache.
   *
   * Chaque moitié est donc lue séparément, et la moitié refusée se DIT dans `nonConsulte` : le
   * modèle doit pouvoir répondre « je vois vos missions mais pas vos entretiens » plutôt que de
   * faire passer une absence de droit pour une absence d'entretien.
   *
   * Ce qui n'est JAMAIS servi : les descriptions libres et les noms de conducteurs. Un champ de
   * texte libre porte ce que l'utilisateur y a mis — parfois le nom d'un mineur placé, chez un
   * client comme CDEF31. L'agent n'a besoin que du QUOI, du QUAND et du QUEL VÉHICULE.
   */
  private async agenda(user: AuthUser): Promise<Omit<ContextBundle, 'key' | 'libelle'>> {
    const perms = await this.permissions.resolveGlobal(user);
    const voitCalendrier = !!perms?.agenda_view;
    const voitMissions = !!perms?.missions_view;
    if (!voitCalendrier && !voitMissions) {
      return {
        data: null, volume: 0,
        refus: 'Ce compte n\'a le droit de consulter ni le calendrier ni les missions.',
      };
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
    const jusqua = new Date(Date.now() + AGENDA_JOURS_AVANT * 86_400_000);
    const perimetreVehicule = Array.isArray(accessibles) ? { in: accessibles } : undefined;

    const [evenements, missions] = await Promise.all([
      // Chaque moitié n'est lue QUE si son droit est là. Lire puis filtrer à l'affichage
      // laisserait la donnée transiter, et un journal de requête lente suffirait à la révéler.
      voitCalendrier
        ? this.prisma.vehicleEvent.findMany({
            where: {
              startAt: { gte: depuis, lte: jusqua },
              ...(scope.mode === 'FLEET' ? { fleetId: scope.fleetId } : {}),
              ...(perimetreVehicule ? { vehicleId: perimetreVehicule } : {}),
            },
            orderBy: { startAt: 'asc' },
            take: CAPS.agenda,
            select: {
              type: true, category: true, status: true, title: true, severity: true,
              startAt: true, endAt: true, allDay: true, blocksVehicle: true,
              vehicle: { select: { plate: true } },
            },
          })
        : [],
      voitMissions
        ? this.prisma.mission.findMany({
            where: {
              startAt: { gte: depuis, lte: jusqua },
              ...(scope.mode === 'FLEET' ? { fleetId: scope.fleetId } : {}),
              ...(perimetreVehicule ? { vehicleId: perimetreVehicule } : {}),
            },
            orderBy: { startAt: 'asc' },
            take: CAPS.agenda,
            select: {
              ref: true, status: true, startAt: true, endAt: true,
              originLabel: true, destLabel: true,
              vehicle: { select: { plate: true } },
            },
          })
        : [],
    ]);

    // Ce que l'agent n'a PAS pu regarder, en clair. Sans cette liste, « aucun entretien prévu »
    // sortirait d'une absence de droit — une affirmation fausse, et la plus difficile à rattraper.
    const nonConsulte = [
      ...(voitCalendrier ? [] : ['calendrier (maintenances, incidents, réservations) : droit « agenda_view » absent']),
      ...(voitMissions ? [] : ['missions : droit « missions_view » absent']),
    ];

    return {
      volume: evenements.length + missions.length,
      data: {
        fenetre: { duJour: -FENETRE_JOURS, auJour: AGENDA_JOURS_AVANT },
        ...(nonConsulte.length ? { nonConsulte } : {}),
        missions: missions.map((m) => ({
          reference: m.ref,
          etat: m.status,
          plaque: m.vehicle?.plate ?? null,
          depart: m.startAt.toISOString(),
          arrivee: m.endAt.toISOString(),
          de: m.originLabel,
          vers: m.destLabel,
        })),
        evenements: evenements.map((e) => ({
          type: e.type,
          sousType: e.category,
          etat: e.status,
          gravite: e.severity,
          // Titre TRONQUÉ, description JAMAIS servie : même raison que les messages d'erreur.
          intitule: (e.title ?? '').slice(0, 80),
          plaque: e.vehicle?.plate ?? null,
          debut: e.startAt.toISOString(),
          fin: e.endAt?.toISOString() ?? null,
          journeeEntiere: e.allDay,
          immobiliseLeVehicule: e.blocksVehicle,
        })),
      },
    };
  }

  /**
   * Le classement des scores de conduite — « qui conduit le mieux ? ».
   *
   * ── LE CLASSEMENT N'EST PAS RECALCULÉ ICI ───────────────────────────────────────────
   *
   * Ce lot appelle `DrivingScoreService.scores`, le service qui alimente l'écran « Scores de
   * conduite ». Il ne refait PAS la moyenne à sa façon, et ce n'est pas un raccourci : la
   * première version de ce lot agrégeait les éco-scores à la main, et perdait du même coup tout
   * ce que ce service a appris à la dure. Le pire :
   *
   *   • une analyse sans aucun point GPS est remplie de zéros par le préprocesseur, ce qui lui
   *     donne un éco-score de **100**. Le service les écarte (`gpsPoints > 0`) ; une moyenne
   *     naïve, elle, aurait mis les véhicules les plus mal suivis sur le podium — juste à la
   *     question « qui conduit le mieux ? » ;
   *   • `tripCount` (trajets NOTÉS) et `totalTripCount` (trajets RÉELS) sont deux nombres
   *     différents : un véhicule a déjà été classé 2ᵉ à 100/100 sur 1 trajet noté parmi 75 ;
   *   • les véhicules dormants sont exclus du concours, et la note lettrée A→E vient d'un seul
   *     barème.
   *
   * Un second calcul dans l'assistance serait un second barème à maintenir — et celui que
   * personne ne regarderait le jour où le premier change.
   *
   * ── DEUX DROITS POUR REGARDER, UN TROISIÈME POUR NOMMER ─────────────────────────────
   *
   * C'est le seul lot qui compare des personnes entre elles. Dans le produit, ce classement est
   * derrière DEUX portes : l'écran `/scores` exige `reports_view`, et la route qui sert les
   * données exige `trips_view`. On exige donc les deux — l'assistance n'a pas à être la porte la
   * plus large. Le cas concret : un compte DÉPÔT a `trips_view` mais pas `reports_view`, et
   * n'atteint le classement par aucun écran ; il ne l'atteindra pas par l'assistant non plus.
   *
   * Le VEILLEUR DE NUIT n'a ni l'un ni l'autre : il reçoit un refus qui le dit, et l'agent répond
   * « je n'ai pas accès à cette information » au lieu d'inventer un classement.
   *
   * Les NOMS ne sortent qu'avec `drivers_view` en plus — le droit que les routes `/drivers`
   * exigent pour nommer quelqu'un. Sans lui, on ne masque pas les lignes : on demande le
   * classement PAR VÉHICULE, qui répond à la même question par plaque. Un classement de
   * « conducteur 1, conducteur 2 » n'aurait renseigné personne.
   */
  private async scores(user: AuthUser): Promise<Omit<ContextBundle, 'key' | 'libelle'>> {
    const perms = await this.permissions.resolveGlobal(user);
    if (!perms?.reports_view || !perms?.trips_view) {
      return {
        data: null, volume: 0,
        refus: 'Ce compte n\'a pas le droit de consulter les scores de conduite (il faut les rapports ET les trajets).',
      };
    }
    const scope = resolveTenantScope(user);
    if (scope.mode === 'DENY') {
      return { data: null, volume: 0, refus: 'Aucune société rattachée à ce compte.' };
    }
    const accessibles = await this.vehicleAccess.getAccessibleVehicleIds(user);
    if (Array.isArray(accessibles) && accessibles.length === 0) {
      return { data: null, volume: 0, refus: 'Aucun véhicule n\'est attribué à ce compte.' };
    }
    const nomsAutorises = !!perms.drivers_view;
    const to = new Date();
    const from = new Date(to.getTime() - SCORES_JOURS * 86_400_000);

    /**
     * `fleetId` laissé vide : le service borne lui-même au périmètre du demandeur. Ce paramètre
     * ne sert qu'au SUPER_ADMIN pour CHOISIR une société ; ne pas le passer lui donne la vue
     * qu'il a déjà partout, et à tous les autres leur seule société.
     */
    const demander = (portee: 'driver' | 'vehicle') =>
      this.drivingScores.scores(user, portee, from.toISOString(), to.toISOString());

    let portee: 'driver' | 'vehicle' = nomsAutorises ? 'driver' : 'vehicle';
    let res = await demander(portee);
    // Beaucoup de trajets n'ont aucun conducteur renseigné : le classement par conducteur peut
    // être vide alors que la flotte roule. Plutôt qu'un « aucun score » trompeur, on répond par
    // véhicule — la même question, une autre clé de lecture.
    if (res.rows.length === 0 && portee === 'driver') {
      portee = 'vehicle';
      res = await demander(portee);
    }
    if (res.rows.length === 0) {
      return {
        data: null, volume: 0,
        refus: 'Aucun trajet analysé sur la période : aucun score n\'est calculable. (Un trajet sans analyse n\'entre pas dans la note.)',
      };
    }

    const classement = res.rows.slice(0, CAPS.scores).map((r, i) => ({
      rang: i + 1,
      qui: r.label,
      note: r.grade,
      score: r.score,
      // Les DEUX nombres, toujours ensemble : « 100/100 » sur 1 trajet noté parmi 75 ne veut
      // pas dire la même chose que sur 70 parmi 75, et l'agent doit pouvoir le nuancer.
      trajetsNotes: r.tripCount,
      trajetsReels: r.totalTripCount,
      distanceKm: Math.round(r.distanceKm),
      trajetsAvecExces: r.speedingTrips,
      acoups: r.harshCount,
    }));
    // Note calculée sur d'anciennes analyses : une réserve à dire, pas un défaut à taire.
    const ancienBareme = res.rows.reduce((n, r) => n + (r.oldFormulaTripCount ?? 0), 0);

    return {
      volume: classement.length,
      data: {
        fenetreJours: SCORES_JOURS,
        portee: portee === 'driver' ? 'par conducteur' : 'par véhicule (plaque)',
        nomsDesConducteurs: nomsAutorises
          ? 'servis'
          : 'masqués (droit « conducteurs » absent) — d\'où le classement par véhicule',
        moyenneFlotte: res.overallScore,
        noteMoyenneFlotte: res.overallGrade,
        nbClasses: res.rankedCount,
        // Le sens du score est rappelé : un nombre seul se fait interpréter à l'envers.
        lecture: 'score sur 100, plus haut = meilleure conduite ; note lettrée A (≥ 85) à E. Le classement est trié du meilleur au moins bon. Un trajet sans analyse n\'entre pas dans la note, et les véhicules dormants ne concourent pas.',
        ...(ancienBareme > 0
          ? { reserve: `${ancienBareme} des analyses notées sont antérieures à la règle de calcul actuelle : la note reste la meilleure mesure disponible, mais elle se dit avec cette réserve.` }
          : {}),
        classement,
      },
    };
  }
}
