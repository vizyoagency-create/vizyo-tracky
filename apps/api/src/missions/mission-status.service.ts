import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  MissionRequestStatus,
  MissionStatus,
  VehicleEventStatus,
  VehicleEventType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MissionShareService } from '../depot/mission-share.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Espace depot (2026-08) — la bascule des statuts de mission. Cf. design/A2-MISSIONS.md § 2.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ LE STATUT EST DERIVE, JAMAIS SAISI. Aucun bouton « passer en cours ».      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Pourquoi : un statut saisi a la main ment des qu'on oublie de le changer. Un depot
 * qui lit « en cours » sur une mission jamais partie perd confiance dans tout l'outil.
 * Le statut suit donc le terrain, pas l'intention.
 *
 *   PLANNED     → a la creation
 *   IN_PROGRESS → premiere position detectee apres startAt − 15 min
 *   LATE        → now > endAt et le vehicule n'est pas arrive
 *   DONE        → arrivee detectee, ou cloture manuelle, ou endAt + 4 h sans mouvement
 *   CANCELLED   → annulation explicite avec motif
 *
 * ⚠️ `LATE` N'INTERROMPT PAS LE SUIVI. Une mission en retard a depasse son `endAt`,
 * et c'est PRECISEMENT le moment ou le depot a le plus besoin de voir le camion. La
 * fenetre d'acces s'etend jusqu'a `DONE` ou cloture — cf. `DepotScopeService`.
 */

/** Tolerance de depart : une position juste avant l'heure prevue demarre la mission. */
const AVANCE_DEPART_MS = 15 * 60_000;
/** Sans le moindre mouvement, une mission est close d'office passe ce delai. */
const ABANDON_APRES_FIN_MS = 4 * 60 * 60_000;
/** Cadence de la bascule. La spec dit « toutes les minutes ». */
const CADENCE_MS = 60_000;

@Injectable()
export class MissionStatusService {
  private readonly logger = new Logger(MissionStatusService.name);
  /** Verrou anti-chevauchement : un tick lent ne doit pas en croiser un autre. */
  private enCours = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly partage: MissionShareService,
  ) {}

  @Interval(CADENCE_MS)
  async tick(): Promise<void> {
    if (this.enCours) return;
    this.enCours = true;
    try {
      await this.demarrerCellesQuiRoulent();
      await this.marquerLesRetards();
      await this.cloreCellesSansMouvement();
      await this.expirerLesDevis();
    } catch (err) {
      // Une tache de fond qui leve tue l'ordonnanceur pour toutes les suivantes.
      this.logger.error(
        `Bascule des statuts de mission en échec : ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.enCours = false;
    }
  }

  /**
   * PLANNED → IN_PROGRESS : une position est arrivee apres `startAt − 15 min`.
   *
   * C'est la PREMIERE POSITION qui demarre la mission, pas l'horloge. Une mission dont
   * l'heure de depart est passee mais dont le camion n'a pas bouge reste `PLANNED` — et
   * le depot lit « le suivi demarrera a 08:15 », ce qui est vrai, plutot qu'une carte
   * vide qu'il ne saurait pas interpreter.
   */
  private async demarrerCellesQuiRoulent(): Promise<void> {
    const maintenant = new Date();
    // ⚠️ On lit `Tracker.lastPositionAt`, DENORMALISE sur le boitier, et non la table
    // `positions`. Celle-ci porte des dizaines de millions de lignes et se joint par
    // `trackerId`, pas par vehicule : un scan par mission et par minute mettrait le VPS
    // a genoux. La denormalisation existe exactement pour ce genre de lecture.
    const candidates = await this.prisma.mission.findMany({
      where: {
        status: MissionStatus.PLANNED,
        startAt: { lte: new Date(maintenant.getTime() + AVANCE_DEPART_MS) },
        endAt: { gte: maintenant },
      },
      select: {
        id: true,
        ref: true,
        startAt: true,
        vehicle: { select: { tracker: { select: { lastPositionAt: true } } } },
      },
      take: 500,
    });

    for (const m of candidates) {
      const vue = m.vehicle.tracker?.lastPositionAt;
      if (!vue) continue; // Pas de boitier, ou boitier muet : la mission attend.

      // La position doit etre POSTERIEURE a `startAt − 15 min`. Une derniere position
      // datant d'hier ne demarre rien : ce serait confondre « le camion est parti »
      // avec « le camion existe ».
      const seuil = new Date(m.startAt.getTime() - AVANCE_DEPART_MS);
      if (vue < seuil) continue;

      await this.basculer(m.id, MissionStatus.IN_PROGRESS, { actualStartAt: vue });
      this.logger.log(`Mission ${m.ref} demarree (position vue le ${vue.toISOString()})`);
    }
  }

  /**
   * IN_PROGRESS → LATE : l'heure de fin est passee et le camion roule encore.
   *
   * Le suivi CONTINUE. On ne stocke aucun retard en minutes : il change a chaque
   * minute, et une valeur figee en base serait fausse des la minute suivante. Le DTO
   * le calcule a la volee.
   */
  private async marquerLesRetards(): Promise<void> {
    const maintenant = new Date();
    const { count } = await this.prisma.mission.updateMany({
      where: { status: MissionStatus.IN_PROGRESS, endAt: { lt: maintenant } },
      data: { status: MissionStatus.LATE },
    });
    if (count > 0) this.logger.log(`${count} mission(s) passee(s) en retard`);
  }

  /**
   * PLANNED ou LATE → DONE, 4 h apres la fin prevue.
   *
   * Deux situations, une meme conclusion : au-dela d'un tel depassement, la mission
   * n'a plus de sens ouvert. Elle est close, son vehicule libere, ses liens publics
   * fermes.
   *
   * `actualStartAt` reste `null` pour une mission jamais partie : c'est ce qui
   * distingue « livree » de « jamais partie », et l'historique du depot doit pouvoir
   * le dire. Une mission qui a roule recoit en revanche un `actualEndAt`, pris sur sa
   * derniere position connue — la seule heure d'arrivee dont on dispose.
   */
  private async cloreCellesSansMouvement(): Promise<void> {
    const limite = new Date(Date.now() - ABANDON_APRES_FIN_MS);
    const abandonnees = await this.prisma.mission.findMany({
      // ⚠️ LATE AUTANT QUE PLANNED.
      //
      // Cette methode ne visait que les missions JAMAIS PARTIES. Une mission qui a
      // roule et depasse son heure passe en LATE — et rien ne la refermait ensuite :
      // `marquerLesRetards` fait IN_PROGRESS → LATE, personne ne fait LATE → DONE.
      //
      // Elle restait donc en retard indefiniment, avec deux consequences reelles,
      // constatees en production le 2026-08-13 sur six missions de la veille :
      // le vehicule restait IMMOBILISE dans l'agenda et les reservations (l'evenement
      // suit le statut, et LATE se mappe sur IN_PROGRESS), et le depot continuait de
      // voir sa position — la fenetre censee se refermer ne se refermait jamais.
      //
      // Le seuil reste celui d'ABANDON_APRES_FIN_MS : 4 h de depassement, bien
      // au-dela d'un simple retard de livraison. On ne coupe pas un camion en route.
      where: {
        status: { in: [MissionStatus.PLANNED, MissionStatus.LATE] },
        endAt: { lt: limite },
      },
      select: { id: true, ref: true, status: true, vehicle: { select: { tracker: { select: { lastPositionAt: true } } } } },
      take: 200,
    });
    for (const m of abandonnees) {
      // `actualEndAt` n'est renseigne que pour une mission qui a REELLEMENT roule :
      // sur une mission jamais partie il resterait faux, et l'historique du depot
      // doit pouvoir distinguer « livree » de « jamais partie ».
      const aRoule = m.status === MissionStatus.LATE;
      const finReelle = aRoule ? (m.vehicle.tracker?.lastPositionAt ?? new Date()) : undefined;
      await this.basculer(m.id, MissionStatus.DONE, finReelle ? { actualEndAt: finReelle } : {});
      this.logger.log(
        aRoule
          ? `Mission ${m.ref} close apres depassement prolonge (etait en retard)`
          : `Mission ${m.ref} close sans deplacement detecte`,
      );
      // Lot A3 — la mission se termine PENDANT que le depot regarde sa carte.
      //
      // Sans cet avertissement, le marqueur disparait au rafraichissement suivant et
      // le depot croit avoir perdu le suivi : il appelle. Avec lui, l'interface
      // retire le marqueur en transition et explique — critere de recette n° 4.
      //
      // Emis APRES la bascule, jamais avant : un evenement « terminee » suivi d'une
      // position serait pire que pas d'evenement du tout.
      this.gateway.emitDepotMissionEnded(m.id, m.ref);
      // Lot A4 — la fin de mission ferme ses liens publics. Sans cela, un lien « fin
      // de mission + 30 min » suivrait le camion sur sa TOURNEE SUIVANTE, chez un
      // autre client. La fermeture laisse cinq minutes sans position, le temps que le
      // destinataire lise l'issue de son attente (cf. `fermerLiensDeMission`).
      await this.partage.fermerLiensDeMission(m.id, 'DONE');
    }
  }

  /**
   * SUBMITTED ou NEGOTIATING → EXPIRED, a l'echeance du devis (A6 § 6).
   *
   * ┌─ UN DEVIS QUI NE PERIME PAS N'EST PAS UN DEVIS ───────────────────────────┐
   * │ `quoteExpiresAt` etait ecrit a la creation et personne ne le lisait. Un    │
   * │ depot pouvait donc accepter en octobre un prix calcule en aout, sur une    │
   * │ grille entre-temps revue — et le transporteur se retrouvait engage sur un  │
   * │ tarif qu'il ne pratique plus. La date affichee au depot annoncait une      │
   * │ echeance qui n'arrivait jamais : pire qu'une absence de date.              │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * ⚠️ SEULES LES DEMANDES ENCORE VIVANTES EXPIRENT. `ACCEPTED` a fige son
   * montant, `CONVERTED` est devenue une mission, `REJECTED` est close : les
   * faire expirer reecrirait une histoire deja terminee. Le filtre porte donc
   * sur les deux seuls statuts en attente de reponse, exactement ceux que
   * `MissionRequestsService` considere comme negociables.
   *
   * Les demandes sans echeance — grille absente au moment de la creation — ne
   * sont jamais touchees : en SQL, `quoteExpiresAt < maintenant` est faux pour
   * un NULL, et c'est le comportement voulu. Une demande sans date de validite
   * n'est pas une demande perimee.
   */
  private async expirerLesDevis(): Promise<void> {
    const maintenant = new Date();
    // On lit AVANT d'ecrire pour pouvoir nommer les demandes dans le journal : une
    // demande qui disparait de la file du transporteur sans laisser de trace est
    // exactement le genre d'evenement qu'on cherche a reconstituer six mois plus tard.
    const echues = await this.prisma.missionRequest.findMany({
      where: {
        status: { in: [MissionRequestStatus.SUBMITTED, MissionRequestStatus.NEGOTIATING] },
        quoteExpiresAt: { lt: maintenant },
      },
      select: { id: true, ref: true },
      take: 200,
    });
    if (echues.length === 0) return;

    const { count } = await this.prisma.missionRequest.updateMany({
      // Le statut est REPETE dans le where de l'ecriture : entre la lecture et la
      // mise a jour, une des deux parties a pu accepter. Sans cette garde, le tick
      // ecraserait un accord conclu une seconde plus tot.
      where: {
        id: { in: echues.map((d) => d.id) },
        status: { in: [MissionRequestStatus.SUBMITTED, MissionRequestStatus.NEGOTIATING] },
      },
      data: { status: MissionRequestStatus.EXPIRED },
    });
    if (count > 0) {
      this.logger.log(
        `${count} demande(s) de mission expiree(s) : ${echues.map((d) => d.ref).join(', ')}`,
      );
    }
  }

  /**
   * Bascule un statut ET l'evenement d'agenda qui lui correspond, dans la MEME
   * transaction.
   *
   * Sans cette synchronisation, l'evenement resterait `PLANNED` : le vehicule
   * apparaitrait indisponible bien apres la fin de sa mission, et le gestionnaire
   * chercherait longtemps pourquoi.
   */
  private async basculer(
    missionId: string,
    statut: MissionStatus,
    champs: { actualStartAt?: Date; actualEndAt?: Date },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.mission.update({ where: { id: missionId }, data: { status: statut, ...champs } });
      await tx.vehicleEvent.updateMany({
        where: {
          type: VehicleEventType.MISSION,
          metadata: { path: ['missionId'], equals: missionId },
        },
        data: { status: STATUT_EVENEMENT[statut] },
      });
    });
  }
}

/**
 * Correspondance mission → evenement d'agenda.
 *
 * `LATE` retombe sur `IN_PROGRESS` : l'agenda n'a pas de statut « en retard », et
 * surtout le vehicule doit rester IMMOBILISE tant que la mission n'est pas close.
 * Le mapper sur `DONE` libererait le vehicule alors qu'il roule encore.
 */
const STATUT_EVENEMENT: Record<MissionStatus, VehicleEventStatus> = {
  [MissionStatus.PLANNED]: VehicleEventStatus.PLANNED,
  [MissionStatus.IN_PROGRESS]: VehicleEventStatus.IN_PROGRESS,
  [MissionStatus.LATE]: VehicleEventStatus.IN_PROGRESS,
  [MissionStatus.DONE]: VehicleEventStatus.DONE,
  [MissionStatus.CANCELLED]: VehicleEventStatus.CANCELLED,
};

export { STATUT_EVENEMENT, AVANCE_DEPART_MS, ABANDON_APRES_FIN_MS };
