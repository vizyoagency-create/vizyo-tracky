import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DUREES_PROLONGATION,
  PLAFOND_VIE_LIEN_MS,
  type DureeProlongation,
  type EtatLienPartage,
  type LienPartageAdminDto,
  type ResumeLiensPartagesDto,
  type TypeLienPartage,
  type VueLiensPartagesDto,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LES ACCÈS PUBLICS OUVERTS, TOUTES SOCIÉTÉS CONFONDUES
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Deux mécanismes ouvrent des URL publiques : le partage de trajet et le suivi de livraison.
 * Chacun a son écran, par société. Aucun ne répond à « qu'est-ce qui est ouvert, en ce moment,
 * chez TOUS mes clients ? » — et un lien qu'on ne voit qu'en pensant à aller le chercher est,
 * en pratique, un lien qu'on ne voit pas.
 *
 * ⚠️ CE SERVICE EST CROSS-SOCIÉTÉ PAR CONSTRUCTION. Il n'existe donc que pour le
 * super-administrateur, et le contrôleur le garde. Aucun appelant de société ne doit pouvoir
 * l'atteindre : ce serait lui montrer les accès des autres clients.
 */
@Injectable()
export class LiensPartagesAdminService {
  private readonly logger = new Logger(LiensPartagesAdminService.name);

  /**
   * Borne de lecture. Au-delà, la liste est tronquée ET le dit (`tronquee`) : un écran de
   * surveillance qui coupe en silence donne exactement la fausse assurance qu'il doit ôter.
   */
  private static readonly MAX_LIGNES = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /** L'état d'un lien, dérivé à l'heure serveur — jamais stocké. */
  private etatDe(lien: { revokedAt: Date | null; expiresAt: Date }, maintenant: number): EtatLienPartage {
    if (lien.revokedAt) return 'REVOQUE';
    return lien.expiresAt.getTime() > maintenant ? 'ACTIF' : 'EXPIRE';
  }

  private nomDe(u: { firstName?: string | null; lastName?: string | null; email?: string | null } | null): string | null {
    if (!u) return null;
    const nom = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return nom || u.email || null;
  }

  /**
   * La vue d'ensemble.
   *
   * ⚠️ LES DEUX TABLES SONT LUES SÉPARÉMENT PUIS FUSIONNÉES EN MÉMOIRE, et non par une union
   * SQL : leurs colonnes de cible n'ont rien de commun (un trajet a une plaque et une date, une
   * mission a une référence), et une union forcerait des colonnes nulles des deux côtés pour
   * un gain nul à cette échelle — quelques centaines de lignes, bornées par `MAX_LIGNES`.
   */
  async vue(filtres: { fleetId?: string; etat?: EtatLienPartage; type?: TypeLienPartage } = {}): Promise<VueLiensPartagesDto> {
    const maintenant = Date.now();
    const auteur = { select: { firstName: true, lastName: true, email: true } };

    const [trajets, missions] = await Promise.all([
      filtres.type === 'MISSION' ? Promise.resolve([]) : this.prisma.tripShareLink.findMany({
        where: filtres.fleetId ? { fleetId: filtres.fleetId } : {},
        orderBy: { createdAt: 'desc' },
        take: LiensPartagesAdminService.MAX_LIGNES + 1,
        include: {
          createdBy: auteur,
          fleet: { select: { name: true } },
          trip: { select: { startedAt: true, vehicle: { select: { plate: true } } } },
        },
      }),
      filtres.type === 'TRAJET' ? Promise.resolve([]) : this.prisma.missionShareLink.findMany({
        orderBy: { createdAt: 'desc' },
        take: LiensPartagesAdminService.MAX_LIGNES + 1,
        include: {
          createdBy: auteur,
          mission: {
            select: {
              ref: true, startAt: true, fleetId: true,
              fleet: { select: { name: true } },
              vehicle: { select: { plate: true } },
            },
          },
        },
      }),
    ]);

    const lignes: LienPartageAdminDto[] = [];

    for (const l of trajets) {
      lignes.push({
        id: l.id,
        type: 'TRAJET',
        etat: this.etatDe(l, maintenant),
        fleetId: l.fleetId,
        fleetNom: l.fleet?.name ?? null,
        cible: {
          plaque: l.trip?.vehicle?.plate ?? null,
          reference: null,
          debutAt: l.trip?.startedAt?.toISOString() ?? null,
        },
        creePar: this.nomDe(l.createdBy),
        creeAt: l.createdAt.toISOString(),
        expireAt: l.expiresAt.toISOString(),
        dureeOrigine: l.duration,
        nbOuvertures: l.openCount,
        premiereOuvertureAt: l.firstOpenedAt?.toISOString() ?? null,
        derniereOuvertureAt: l.lastOpenedAt?.toISOString() ?? null,
        derniereOuvertureDe: l.lastOpenedFrom,
        nbProlongations: l.extendedCount,
        derniereProlongationAt: l.lastExtendedAt?.toISOString() ?? null,
        derniereProlongationPar: null,
        revoqueAt: l.revokedAt?.toISOString() ?? null,
        revoquePar: null,
      });
    }

    for (const l of missions) {
      lignes.push({
        id: l.id,
        type: 'MISSION',
        etat: this.etatDe(l, maintenant),
        // ⚠️ La société vient de la MISSION : contrairement au partage de trajet, ce modèle ne
        // la dénormalise pas. C'est aussi pourquoi le filtre par société s'applique ici en
        // mémoire plutôt qu'en base.
        fleetId: l.mission?.fleetId ?? '',
        fleetNom: l.mission?.fleet?.name ?? null,
        cible: {
          plaque: l.mission?.vehicle?.plate ?? null,
          reference: l.mission?.ref ?? null,
          debutAt: l.mission?.startAt?.toISOString() ?? null,
        },
        creePar: this.nomDe(l.createdBy),
        creeAt: l.createdAt.toISOString(),
        expireAt: l.expiresAt.toISOString(),
        dureeOrigine: l.duration,
        nbOuvertures: l.openCount,
        premiereOuvertureAt: l.firstOpenedAt?.toISOString() ?? null,
        derniereOuvertureAt: l.lastOpenedAt?.toISOString() ?? null,
        derniereOuvertureDe: l.lastOpenedFrom,
        nbProlongations: l.extendedCount,
        derniereProlongationAt: l.lastExtendedAt?.toISOString() ?? null,
        derniereProlongationPar: null,
        revoqueAt: l.revokedAt?.toISOString() ?? null,
        revoquePar: null,
      });
    }

    const filtrees = lignes
      .filter((l) => !filtres.fleetId || l.fleetId === filtres.fleetId)
      .filter((l) => !filtres.etat || l.etat === filtres.etat)
      // Les plus récemment créés d'abord : c'est l'ordre dans lequel on cherche un lien
      // qu'on vient d'envoyer, et celui dans lequel les oublis remontent naturellement.
      .sort((a, b) => b.creeAt.localeCompare(a.creeAt));

    const tronquee = filtrees.length > LiensPartagesAdminService.MAX_LIGNES;
    const servies = tronquee ? filtrees.slice(0, LiensPartagesAdminService.MAX_LIGNES) : filtrees;

    return { resume: this.resume(lignes, maintenant), liens: servies, tronquee };
  }

  /**
   * Les compteurs de tête.
   *
   * ⚠️ CALCULÉS SUR L'ENSEMBLE, PAS SUR LA PAGE SERVIE. Un résumé qui ne compterait que les
   * lignes affichées annoncerait « 12 liens actifs » sous une liste tronquée à 12 — c'est-à-dire
   * exactement le faux calme que cet écran existe pour dissiper.
   */
  private resume(lignes: LienPartageAdminDto[], maintenant: number): ResumeLiensPartagesDto {
    const actifs = lignes.filter((l) => l.etat === 'ACTIF');
    return {
      actifs: actifs.length,
      actifsConsultes: actifs.filter((l) => l.nbOuvertures > 0).length,
      actifsExpirantSous24h: actifs.filter(
        (l) => Date.parse(l.expireAt) - maintenant < 24 * 3600 * 1000,
      ).length,
      expires: lignes.filter((l) => l.etat === 'EXPIRE').length,
      revoques: lignes.filter((l) => l.etat === 'REVOQUE').length,
      societesConcernees: new Set(actifs.map((l) => l.fleetId).filter(Boolean)).size,
    };
  }

  private msDe(duree: DureeProlongation): number {
    return duree === 'HOUR_1' ? 3600_000 : duree === 'DAY_7' ? 7 * 24 * 3600_000 : 24 * 3600_000;
  }

  /**
   * PROLONGER — repousser l'échéance d'un lien existant.
   *
   * ── LES TROIS RÈGLES, ET POURQUOI ────────────────────────────────────────────────────────
   *
   * 1. UN LIEN RÉVOQUÉ NE SE PROLONGE PAS. La révocation est une décision prise par quelqu'un ;
   *    la défaire par une prolongation la transformerait en accident réversible. Il faut créer
   *    un nouveau lien — geste volontaire, nouvelle trace, nouveau compteur.
   *
   * 2. UN LIEN EXPIRÉ, EN REVANCHE, SE PROLONGE. C'est le cas d'usage principal : le
   *    destinataire n'a pas ouvert à temps. Régénérer à la place laisserait l'ancien lien dans
   *    la nature et ferait perdre son historique de consultation.
   *
   * 3. PLAFOND DE VIE TOTALE — 30 jours DEPUIS LA CRÉATION. Sans borne, « prolonger » devient
   *    « publier » : trois clics et un lien de 24 h vit un trimestre. Compté depuis la création
   *    et non depuis la dernière prolongation, sinon il suffirait de repousser régulièrement
   *    pour ne jamais l'atteindre.
   *
   * ⚠️ On repart de `max(maintenant, échéance)` : prolonger de 24 h un lien expiré depuis trois
   * jours doit donner 24 h à partir de MAINTENANT, pas une échéance déjà passée.
   */
  async prolonger(
    type: TypeLienPartage,
    id: string,
    duree: DureeProlongation,
    utilisateur: { id: string; email?: string | null },
  ): Promise<LienPartageAdminDto> {
    const parUtilisateurId = utilisateur.id;
    const acteur = utilisateur.email ?? 'utilisateur';
    if (!DUREES_PROLONGATION.includes(duree)) {
      throw new BadRequestException({ code: 'DUREE_INVALIDE', message: 'Durée de prolongation inconnue.' });
    }

    const maintenant = Date.now();
    const lien = type === 'TRAJET'
      ? await this.prisma.tripShareLink.findUnique({ where: { id }, select: { id: true, createdAt: true, expiresAt: true, revokedAt: true, fleetId: true } })
      : await this.prisma.missionShareLink.findUnique({ where: { id }, select: { id: true, createdAt: true, expiresAt: true, revokedAt: true, mission: { select: { fleetId: true } } } });

    if (!lien) throw new NotFoundException('Lien introuvable.');
    if (lien.revokedAt) {
      throw new ConflictException({
        code: 'LIEN_REVOQUE',
        message: 'Ce lien a été révoqué : il ne se prolonge pas. Créez-en un nouveau si l’accès doit reprendre.',
      });
    }

    const base = Math.max(maintenant, lien.expiresAt.getTime());
    const nouvelle = base + this.msDe(duree);
    const plafond = lien.createdAt.getTime() + PLAFOND_VIE_LIEN_MS;
    if (nouvelle > plafond) {
      const joursRestants = Math.max(0, Math.floor((plafond - base) / (24 * 3600_000)));
      throw new ConflictException({
        code: 'PLAFOND_VIE_ATTEINT',
        message: `Un lien ne peut pas vivre plus de 30 jours après sa création (il reste ${joursRestants} j). Créez-en un nouveau.`,
        plafondAt: new Date(plafond).toISOString(),
      });
    }

    const donnees = {
      expiresAt: new Date(nouvelle),
      extendedCount: { increment: 1 },
      lastExtendedAt: new Date(maintenant),
      lastExtendedById: parUtilisateurId,
    };
    if (type === 'TRAJET') {
      await this.prisma.tripShareLink.update({ where: { id }, data: donnees });
    } else {
      await this.prisma.missionShareLink.update({ where: { id }, data: donnees });
    }

    const fleetId = type === 'TRAJET'
      ? (lien as { fleetId: string }).fleetId
      : (lien as { mission?: { fleetId?: string } }).mission?.fleetId ?? null;

    /**
     * ⚠️ LA TRACE EST LA CONTREPARTIE DE LA PROLONGATION. Repousser une échéance sans
     * l'inscrire quelque part rendrait la surveillance décorative : on verrait un lien vivant
     * sans pouvoir dire s'il l'est par nature ou parce qu'on l'a repoussé.
     */
    this.systemActivity.record({
      // Même catégorie que la création et la révocation d'un partage : les trois gestes se
      // lisent ensemble dans le journal, ou ils ne se lisent pas.
      category: 'EXPORT',
      action: 'share_link_extended',
      status: 'SUCCESS',
      actor: acteur,
      target: id,
      fleetId,
      triggeredByUserId: parUtilisateurId,
      detail: `Lien de partage ${type === 'TRAJET' ? 'de trajet' : 'de mission'} prolongé de ${duree} — nouvelle échéance ${new Date(nouvelle).toISOString()}.`,
      meta: { type, lienId: id, duree, ancienneEcheance: lien.expiresAt.toISOString(), nouvelleEcheance: new Date(nouvelle).toISOString() },
    });
    this.logger.log(`Lien ${type}/${id} prolongé de ${duree} → ${new Date(nouvelle).toISOString()}`);

    const apres = await this.vue({});
    const ligne = apres.liens.find((l) => l.id === id && l.type === type);
    if (!ligne) throw new NotFoundException('Lien introuvable après prolongation.');
    return ligne;
  }

  /**
   * RÉVOQUER — couper l'accès immédiatement, quel que soit le type.
   *
   * Idempotent : révoquer un lien déjà révoqué ne fait rien et ne lève pas. Le geste vise un
   * résultat (« que ce lien ne serve plus »), pas une transition d'état ; échouer parce que
   * quelqu'un d'autre a coupé une seconde plus tôt n'aiderait personne.
   */
  async revoquer(
    type: TypeLienPartage,
    id: string,
    utilisateur: { id: string; email?: string | null },
  ): Promise<void> {
    const maintenant = new Date();
    const acteur = utilisateur.email ?? 'utilisateur';
    const donnees = { revokedAt: maintenant, revokedByUserId: utilisateur.id };

    if (type === 'TRAJET') {
      const l = await this.prisma.tripShareLink.findUnique({ where: { id }, select: { revokedAt: true, fleetId: true } });
      if (!l) throw new NotFoundException('Lien introuvable.');
      if (l.revokedAt) return;
      await this.prisma.tripShareLink.update({ where: { id }, data: donnees });
      this.traceRevocation(type, id, utilisateur.id, acteur, l.fleetId);
      return;
    }

    const l = await this.prisma.missionShareLink.findUnique({ where: { id }, select: { revokedAt: true, mission: { select: { fleetId: true } } } });
    if (!l) throw new NotFoundException('Lien introuvable.');
    if (l.revokedAt) return;
    await this.prisma.missionShareLink.update({ where: { id }, data: donnees });
    this.traceRevocation(type, id, utilisateur.id, acteur, l.mission?.fleetId ?? null);
  }

  private traceRevocation(
    type: TypeLienPartage,
    id: string,
    parUtilisateurId: string,
    acteur: string,
    fleetId: string | null,
  ): void {
    this.systemActivity.record({
      category: 'EXPORT',
      action: 'share_link_revoked',
      status: 'SUCCESS',
      actor: acteur,
      target: id,
      fleetId,
      triggeredByUserId: parUtilisateurId,
      detail: `Lien de partage ${type === 'TRAJET' ? 'de trajet' : 'de mission'} révoqué depuis la vue d'ensemble.`,
      meta: { type, lienId: id },
    });
  }
}
