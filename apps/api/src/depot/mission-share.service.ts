import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MissionStatus, ShareDuration, UserRole, type VehicleWorkSchedule } from '@prisma/client';
import {
  SHARE_MAX_ACTIFS_PAR_MISSION,
  type MissionShareCreatedDto,
  type MissionShareLinkDto,
  type PublicTrackingDto,
  type ShareDurationDto,
} from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { resolveEffectivePrivacy } from '../privacy-mode/effective-privacy';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { genererTokenPartage, tronquerAdresse } from './share-token';

/**
 * Espace depot (2026-08), lot A4 — LE LIEN PUBLIC TEMPORAIRE.
 *
 * ┌─ LE LOT LE PLUS SENSIBLE DU BLOC A ───────────────────────────────────────┐
 * │ Tout le reste de l'espace depot protege des donnees derriere une           │
 * │ authentification. Ici, il n'y en a pas : le destinataire est un numero de  │
 * │ telephone a qui on a envoye une URL. Trois consequences tenues ici :        │
 * │                                                                            │
 * │  1. LE TEMPS EST LE SEUL VERROU. 15 minutes par defaut, non prolongeable,   │
 * │     verifie a l'heure SERVEUR a chaque requete. Un lien qui traine dans un  │
 * │     e-mail transfere doit etre mort avant d'y arriver.                      │
 * │                                                                            │
 * │  2. `410` UNIFORME. Expire, revoque, inexistant : meme code, meme corps.    │
 * │     Distinguer permettrait d'enumerer — « ce token a existe » est deja une  │
 * │     information.                                                            │
 * │                                                                            │
 * │  3. UN POINT, JAMAIS UNE LIGNE. Le trace revelerait les points de livraison │
 * │     precedents, donc les AUTRES clients du depot (A4 § 2).                  │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Cf. design/A4-PARTAGE.md.
 */

/** Marge sur `UNTIL_MISSION_END` : un lien qui expire pile a l'heure prevue meurt au
 *  moment ou le client en a le plus besoin (A4 § 4). */
const MARGE_FIN_MISSION_MS = 30 * 60_000;

/** Au-dela, la position n'est plus « actuelle » : meme regle que la carte du depot. */
const FRAICHEUR_MAX_MINUTES = 10;

/**
 * Fenetre laissee au destinataire APRES la cloture, pour qu'il lise l'issue de son
 * attente. Aucune position n'y transite (cf. `fermerLiensDeMission`).
 */
const GRACE_FIN_MISSION_MS = 5 * 60_000;

/**
 * Plafond de creation PAR COMPTE et par heure (A4 § 3).
 *
 * ⚠️ Applique ici, et pas par `@Throttle` : celui-ci compte par ADRESSE IP. Deux
 * depots derriere le meme routeur d'entreprise partageraient alors un seul compteur,
 * et le premier qui partage beaucoup bloquerait le second — un refus qu'aucun des
 * deux ne pourrait comprendre.
 */
const CREATIONS_MAX_PAR_HEURE = 20;

/** Statuts pour lesquels une mission peut encore etre partagee (A4 § 7, regle 3). */
const STATUTS_PARTAGEABLES: MissionStatus[] = [
  MissionStatus.PLANNED,
  MissionStatus.IN_PROGRESS,
  MissionStatus.LATE,
];

@Injectable()
export class MissionShareService {
  private readonly logger = new Logger(MissionShareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly activite: SystemActivityService,
  ) {}

  // ═══ COTE CREATEUR (authentifie) ═══════════════════════════════════════════

  /**
   * Cree un lien. Le `where` porte le perimetre de l'appelant : un DEPOT ne partage
   * que SES missions, un gestionnaire que celles de SA flotte.
   */
  async creer(
    utilisateur: { id: string; role: string; fleetId: string | null },
    missionId: string,
    duree: ShareDurationDto,
  ): Promise<MissionShareCreatedDto> {
    const mission = await this.missionAccessible(utilisateur, missionId);

    // Une mission close ne se partage plus : suivre un camion apres sa livraison,
    // c'est suivre sa tournee suivante (A4 § 4, regle 3).
    if (!STATUTS_PARTAGEABLES.includes(mission.status)) {
      throw new BadRequestException(
        'Cette livraison est terminée ou annulée : elle ne peut plus être partagée.',
      );
    }

    // Le plafond par COMPTE, avant le plafond par mission : un compte qui a epuise son
    // quota horaire ne doit pas apprendre au passage combien de liens porte la mission.
    const depuisUneHeure = new Date(Date.now() - 3_600_000);
    const recents = await this.prisma.missionShareLink.count({
      where: { createdByUserId: utilisateur.id, createdAt: { gte: depuisUneHeure } },
    });
    if (recents >= CREATIONS_MAX_PAR_HEURE) {
      throw new HttpException(
        `Vous avez créé ${CREATIONS_MAX_PAR_HEURE} liens dans la dernière heure. Réessayez plus tard.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // La limite de 3 n'est pas un garde-fou theorique : sans elle, un depot genere un
    // lien par client et transforme le suivi en flux public (A4 § 3).
    const actifs = await this.prisma.missionShareLink.count({
      where: { missionId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (actifs >= SHARE_MAX_ACTIFS_PAR_MISSION) {
      throw new BadRequestException(
        `Cette mission a déjà ${SHARE_MAX_ACTIFS_PAR_MISSION} liens actifs. Révoquez-en un avant d'en créer un nouveau.`,
      );
    }

    const dureePrisma = this.dureeValide(duree);
    const lien = await this.prisma.missionShareLink.create({
      data: {
        missionId,
        // ⚠️ Un token NEUF a chaque partage. Reutiliser rendrait la revocation
        // illusoire : un ancien destinataire reviendrait par son ancienne URL.
        token: genererTokenPartage(),
        createdByUserId: utilisateur.id,
        duration: dureePrisma,
        expiresAt: this.calculerExpiration(dureePrisma, mission.endAt),
      },
      select: this.selectionLien(),
    });

    this.journaliser('mission_share_created', utilisateur.id, mission, {
      duree: dureePrisma,
      expiresAt: lien.expiresAt.toISOString(),
    });

    return { ...this.versDto(lien), token: lien.token, url: this.urlPublique(lien.token) };
  }

  /** Les liens d'une mission, avec leur usage — pour revoquer en connaissance de cause. */
  async lister(
    utilisateur: { id: string; role: string; fleetId: string | null },
    missionId: string,
  ): Promise<MissionShareLinkDto[]> {
    await this.missionAccessible(utilisateur, missionId);
    const liens = await this.prisma.missionShareLink.findMany({
      where: { missionId },
      select: this.selectionLien(),
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    // Le TOKEN n'est pas dans le DTO de liste : elle sert a revoquer, pas a
    // re-copier un lien qu'on aurait laisse filer. Le token ne transite qu'une fois.
    return liens.map((l) => this.versDto(l));
  }

  /**
   * Revocation immediate.
   *
   * ⚠️ Le transporteur peut revoquer N'IMPORTE QUEL lien de sa flotte, y compris ceux
   * crees par un depot (A4 § 7, regle 5) : c'est lui qui porte la responsabilite des
   * donnees devant son client. Un depot, lui, ne revoque que les liens de ses missions.
   */
  async revoquer(
    utilisateur: { id: string; role: string; fleetId: string | null },
    lienId: string,
  ): Promise<void> {
    const lien = await this.prisma.missionShareLink.findUnique({
      where: { id: lienId },
      select: {
        id: true,
        revokedAt: true,
        mission: {
          select: { id: true, ref: true, fleetId: true, depotUserId: true, endAt: true },
        },
      },
    });
    // Inconnu et hors perimetre donnent le MEME refus (regle d'A1 § 3).
    if (!lien) throw new ForbiddenException('Ressource hors de votre périmètre');

    const estDepot = utilisateur.role === UserRole.DEPOT;
    const autorise = estDepot
      ? lien.mission.depotUserId === utilisateur.id
      : lien.mission.fleetId === utilisateur.fleetId;
    if (!autorise) throw new ForbiddenException('Ressource hors de votre périmètre');

    // Idempotent : revoquer deux fois n'est pas une erreur, c'est le meme resultat.
    if (lien.revokedAt) return;

    await this.prisma.missionShareLink.update({
      where: { id: lienId },
      data: { revokedAt: new Date(), revokedByUserId: utilisateur.id },
    });
    this.journaliser('mission_share_revoked', utilisateur.id, lien.mission, {});
  }

  /**
   * Ferme TOUS les liens d'une mission. Appele a la cloture et a l'annulation.
   *
   * ┌─ POURQUOI UNE FENETRE DE 5 MINUTES, ET PAS UNE COUPURE SECHE ────────────┐
   * │ La regle est « la fin de mission ferme tous les liens » (A4 § 4). Mais    │
   * │ A4 § 8 demande aussi que le destinataire QUI REGARDE lise « livraison     │
   * │ effectuee a 11:34 » — ou « cette livraison a ete annulee » — plutot que de │
   * │ tomber sur un ecran de lien mort au moment precis ou son attente aboutit.  │
   * │                                                                            │
   * │ Les deux tiennent ensemble parce que la POSITION s'arrete AVANT le lien :  │
   * │ des que la mission n'est plus IN_PROGRESS/LATE, `positionPublique` renvoie │
   * │ null. Pendant ces cinq minutes le lien ne sert donc qu'un statut et une    │
   * │ heure — aucune coordonnee, aucun suivi de la tournee suivante.             │
   * │                                                                            │
   * │ On RACCOURCIT `expiresAt`, on ne le repousse jamais : un lien qui expirait  │
   * │ dans deux minutes continue d'expirer dans deux minutes.                    │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  async fermerLiensDeMission(missionId: string, motif: 'DONE' | 'CANCELLED'): Promise<number> {
    const fin = new Date(Date.now() + GRACE_FIN_MISSION_MS);
    const { count } = await this.prisma.missionShareLink.updateMany({
      where: { missionId, revokedAt: null, expiresAt: { gt: fin } },
      data: { expiresAt: fin },
    });
    if (count > 0) {
      this.logger.log(
        `${count} lien(s) de partage ramene(s) a ${GRACE_FIN_MISSION_MS / 60_000} min — mission ${missionId} (${motif})`,
      );
    }
    return count;
  }

  /**
   * Ferme les liens actifs cres par un compte. Appele a sa desactivation (A4 § 8).
   *
   * Un compte desactive ne doit pas laisser derriere lui des acces qu'il a ouverts :
   * on retire l'acces au compte ET ce que le compte a distribue.
   */
  async fermerLiensDuCompte(userId: string): Promise<number> {
    const { count } = await this.prisma.missionShareLink.updateMany({
      where: { createdByUserId: userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count > 0) this.logger.log(`${count} lien(s) ferme(s) — compte ${userId} desactive`);
    return count;
  }

  // ═══ COTE PUBLIC (aucune authentification) ═════════════════════════════════

  /**
   * Ce que voit le destinataire du lien.
   *
   * ⚠️ TROIS ETATS, UN SEUL CODE. Expire, revoque, inexistant : `410 Gone`, meme
   * message. Distinguer permettrait d'enumerer les tokens — et « ce token a existe »
   * est deja une information sur l'activite du depot.
   */
  async suivrePublic(token: string, adresseAppelant?: string): Promise<PublicTrackingDto> {
    const lien = await this.prisma.missionShareLink.findUnique({
      where: { token },
      select: {
        id: true,
        expiresAt: true,
        revokedAt: true,
        mission: {
          select: {
            status: true,
            startAt: true,
            endAt: true,
            actualEndAt: true,
            destLabel: true,
            fleet: { select: { name: true } },
            vehicle: {
              select: {
                mixedUseEnabled: true,
                privacyModeEnabled: true,
                workOverrideUntil: true,
                workSchedule: true,
                tracker: { select: { lastLat: true, lastLng: true, lastPositionAt: true } },
              },
            },
            // Volontairement ABSENTS : ref, originLabel, driver, plaque, notes, trips.
          },
        },
      },
    });

    const maintenant = new Date();
    if (!lien || lien.revokedAt || lien.expiresAt <= maintenant) {
      throw new GoneException('Ce lien de suivi n\'est plus valide');
    }

    // Le suivi d'usage, en tache de fond : il alimente la revocation eclairee du depot.
    void this.enregistrerOuverture(lien.id, adresseAppelant);

    return this.versDtoPublic(lien.mission, lien.expiresAt, maintenant);
  }

  // ═══ Interne ═══════════════════════════════════════════════════════════════

  /**
   * Le DTO public, construit champ par champ.
   *
   * LA LISTE EST LE CONTRAT : ce qui n'est pas ecrit ici ne sort pas. Comparez avec
   * le `select` ci-dessus — ni plaque, ni conducteur, ni reference, ni origine, ni
   * trace n'ont meme ete charges.
   */
  private versDtoPublic(
    mission: MissionPublique,
    expiresAt: Date,
    maintenant: Date,
  ): PublicTrackingDto {
    const suiviActif =
      mission.status === MissionStatus.IN_PROGRESS || mission.status === MissionStatus.LATE;
    const position = this.positionPublique(mission, suiviActif, maintenant);
    const perimee = position ? null : this.ageDerniereePosition(mission, suiviActif, maintenant);

    return {
      status: mission.status as PublicTrackingDto['status'],
      position: position ? { lat: position.lat, lng: position.lng } : null,
      etaAt: (mission.actualEndAt ?? mission.endAt).toISOString(),
      // La VILLE, pas l'adresse exacte : elle suffit a confirmer « c'est ma livraison ».
      destinationLabel: mission.destLabel,
      carrierName: mission.fleet.name,
      expiresAt: expiresAt.toISOString(),
      lastUpdateAt: position?.at.toISOString() ?? null,
      positionUnavailableSince: perimee,
      startAt: mission.startAt.toISOString(),
    };
  }

  /**
   * Un POINT, et seulement s'il est frais.
   *
   * Trois refus, dans cet ordre : hors suivi actif (avant le depart, apres la
   * livraison), vehicule en mode vie privee, position de plus de dix minutes. Le
   * dernier est le plus important : un point perime presente comme actuel enverrait
   * le client attendre au quai pour rien.
   */
  private positionPublique(
    mission: MissionPublique,
    suiviActif: boolean,
    maintenant: Date,
  ): { lat: number; lng: number; at: Date } | null {
    if (!suiviActif) return null;
    const v = mission.vehicle;
    if (resolveEffectivePrivacy(v, v.workSchedule, maintenant).isPrivate) return null;

    const t = v.tracker;
    if (!t?.lastLat || !t?.lastLng || !t?.lastPositionAt) return null;
    const ageMinutes = (maintenant.getTime() - t.lastPositionAt.getTime()) / 60_000;
    if (ageMinutes > FRAICHEUR_MAX_MINUTES) return null;

    return { lat: t.lastLat, lng: t.lastLng, at: t.lastPositionAt };
  }

  /**
   * L'age de la derniere position connue, quand elle existe mais est trop vieille.
   *
   * ⚠️ Rend null si le vehicule est en MODE VIE PRIVEE : une duree apprendrait au
   * destinataire quand le conducteur est passe en prive. On dit l'absence, jamais sa
   * raison ni son debut — meme regle qu'en A3.
   */
  private ageDerniereePosition(
    mission: MissionPublique,
    suiviActif: boolean,
    maintenant: Date,
  ): number | null {
    if (!suiviActif) return null;
    const v = mission.vehicle;
    if (resolveEffectivePrivacy(v, v.workSchedule, maintenant).isPrivate) return null;
    const vue = v.tracker?.lastPositionAt;
    if (!vue) return null;
    return Math.max(1, Math.floor((maintenant.getTime() - vue.getTime()) / 60_000));
  }

  /**
   * Le suivi d'ouverture. Volontairement DETACHE de la reponse : une ecriture lente ou
   * en echec ne doit pas empecher un client de voir arriver son camion.
   */
  private async enregistrerOuverture(lienId: string, adresse?: string): Promise<void> {
    try {
      const maintenant = new Date();
      await this.prisma.missionShareLink.update({
        where: { id: lienId },
        data: {
          openCount: { increment: 1 },
          lastOpenedAt: maintenant,
          // ⚠️ TRONQUEE. On veut distinguer deux destinataires, pas identifier une
          // personne qui n'a ni compte ni consentement (RGPD).
          lastOpenedFrom: tronquerAdresse(adresse),
        },
      });
      // `firstOpenedAt` ne se pose qu'une fois : un `set` conditionnel en SQL evite de
      // relire la ligne avant d'ecrire.
      await this.prisma.missionShareLink.updateMany({
        where: { id: lienId, firstOpenedAt: null },
        data: { firstOpenedAt: maintenant },
      });
    } catch (err) {
      this.logger.warn(
        `Suivi d'ouverture ignore pour le lien ${lienId} : ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Le perimetre de l'appelant : un DEPOT ne voit que SES missions. */
  private async missionAccessible(
    utilisateur: { id: string; role: string; fleetId: string | null },
    missionId: string,
  ): Promise<{ id: string; ref: string; fleetId: string; endAt: Date; status: MissionStatus }> {
    const estDepot = utilisateur.role === UserRole.DEPOT;
    const mission = await this.prisma.mission.findFirst({
      where: {
        id: missionId,
        ...(estDepot ? { depotUserId: utilisateur.id } : { fleetId: utilisateur.fleetId ?? '' }),
      },
      select: { id: true, ref: true, fleetId: true, endAt: true, status: true },
    });
    if (!mission) throw new ForbiddenException('Ressource hors de votre périmètre');
    return mission;
  }

  /**
   * A4 § 4. `UNTIL_MISSION_END` porte une marge de 30 min pour couvrir le retard.
   *
   * ⚠️ AUCUNE DUREE NE PEUT DEPASSER CE PLAFOND.
   *
   * `MIN_15` et `HOUR_1` calculaient `maintenant + duree` SANS REGARDER `endAt`.
   * Choisir « 1 h » sur une mission qui se terminait 48 minutes plus tard produisait
   * donc un lien public vivant 12 minutes APRES la fenetre — constate en recette le
   * 2026-08-13 : mission 18:00→19:00, lien cree a 18:18, expiration annoncee 19:18.
   *
   * Ce n'est pas un detail d'affichage. La promesse du dossier est que la fenetre
   * horaire borne l'acces, et le destinataire d'un lien public n'a NI COMPTE NI
   * PERMISSION : le temps est le seul verrou (cf. l'encadre en tete de ce service).
   * Un lien qui survit a la mission remet une position live a un tiers alors que le
   * transporteur a referme son creneau.
   *
   * Le plafond retenu est exactement celui de `UNTIL_MISSION_END` — l'option la plus
   * longue — pour qu'aucun autre choix ne puisse offrir davantage.
   */
  private calculerExpiration(duree: ShareDuration, finMission: Date): Date {
    const plafond = this.plafondDeMission(finMission);
    const borner = (echeance: number) => new Date(Math.min(echeance, plafond));
    switch (duree) {
      case ShareDuration.MIN_15:
        return borner(Date.now() + 15 * 60_000);
      case ShareDuration.HOUR_1:
        return borner(Date.now() + 60 * 60_000);
      case ShareDuration.UNTIL_MISSION_END: {
        // ⚠️ `max(endAt, maintenant)`, et pas `endAt` seul.
        //
        // Une mission EN RETARD a deja depasse son `endAt` : le calcul litteral
        // produisait un lien NE MEME NE : cree, expire, inutilisable. Or c'est
        // precisement sur une mission en retard qu'un depot partage le suivi — son
        // client s'impatiente, c'est la raison meme du lien.
        //
        // La marge de 30 minutes court donc a partir du plus tardif des deux : la fin
        // annoncee si elle est a venir, l'instant present si elle est passee.
        return new Date(this.plafondDeMission(finMission));
      }
    }
  }

  /**
   * L'instant au-dela duquel AUCUN lien de cette mission ne peut vivre.
   *
   * `max(endAt, maintenant)`, et pas `endAt` seul : une mission EN RETARD a deja
   * depasse son `endAt`, et le calcul litteral produirait un plafond dans le passe —
   * donc un lien mort-ne, cree et deja expire. Or c'est precisement sur une mission
   * en retard qu'un depot partage le suivi : son client s'impatiente, c'est la raison
   * meme du lien. La marge court donc a partir du plus tardif des deux.
   */
  private plafondDeMission(finMission: Date): number {
    return Math.max(finMission.getTime(), Date.now()) + MARGE_FIN_MISSION_MS;
  }

  /** Une duree inconnue retombe sur la plus COURTE : par defaut on protege. */
  private dureeValide(valeur: ShareDurationDto): ShareDuration {
    const connues: Record<ShareDurationDto, ShareDuration> = {
      MIN_15: ShareDuration.MIN_15,
      HOUR_1: ShareDuration.HOUR_1,
      UNTIL_MISSION_END: ShareDuration.UNTIL_MISSION_END,
    };
    return connues[valeur] ?? ShareDuration.MIN_15;
  }

  private urlPublique(token: string): string {
    const base = this.config.get('APP_BASE_URL', { infer: true }) ?? '';
    return `${base}/s/${token}`;
  }

  private selectionLien() {
    return {
      id: true,
      token: true,
      duration: true,
      expiresAt: true,
      createdAt: true,
      revokedAt: true,
      openCount: true,
      lastOpenedAt: true,
    } as const;
  }

  private versDto(l: LienSelectionne): MissionShareLinkDto {
    return {
      id: l.id,
      duration: l.duration as ShareDurationDto,
      expiresAt: l.expiresAt.toISOString(),
      createdAt: l.createdAt.toISOString(),
      openCount: l.openCount,
      lastOpenedAt: l.lastOpenedAt?.toISOString() ?? null,
      active: l.revokedAt === null && l.expiresAt > new Date(),
    };
  }

  /** Toute creation et toute revocation sont tracees : qui, quand, quelle mission,
   *  quelle duree (A4 § 7, regle 6). C'est ce journal qui repond a « qui a ouvert cet
   *  acces » le jour ou la question se pose. */
  private journaliser(
    action: string,
    userId: string,
    mission: { ref: string; fleetId: string },
    meta: Record<string, unknown>,
  ): void {
    this.activite.record({
      category: 'DEPOT',
      action,
      status: 'SUCCESS',
      actor: userId,
      target: `mission ${mission.ref}`,
      detail:
        action === 'mission_share_created'
          ? `Lien public de suivi créé (${String(meta['duree'])}), expire le ${String(meta['expiresAt'])}`
          : 'Lien public de suivi révoqué',
      fleetId: mission.fleetId,
      triggeredByUserId: userId,
      meta,
    });
  }
}

type LienSelectionne = {
  id: string;
  token: string;
  duration: ShareDuration;
  expiresAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
  openCount: number;
  lastOpenedAt: Date | null;
};

type MissionPublique = {
  status: MissionStatus;
  startAt: Date;
  endAt: Date;
  actualEndAt: Date | null;
  destLabel: string;
  fleet: { name: string };
  vehicle: {
    mixedUseEnabled: boolean;
    privacyModeEnabled: boolean;
    workOverrideUntil: Date | null;
    workSchedule: VehicleWorkSchedule | null;
    tracker: { lastLat: number | null; lastLng: number | null; lastPositionAt: Date | null } | null;
  };
};
