import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MissionStatus, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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

  constructor(private readonly prisma: PrismaService) {}

  @Interval(CADENCE_MS)
  async tick(): Promise<void> {
    if (this.enCours) return;
    this.enCours = true;
    try {
      await this.demarrerCellesQuiRoulent();
      await this.marquerLesRetards();
      await this.cloreCellesSansMouvement();
    } catch (err) {
      // Une tache de fond qui leve tue l'ordonnanceur pour toutes les suivantes.
      this.logger.error(
        `Bascule des statuts de mission en echec : ${err instanceof Error ? err.message : err}`,
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
   * PLANNED → DONE, 4 h apres la fin prevue, sans qu'aucune position ne soit arrivee.
   *
   * `actualStartAt` reste `null` : c'est ce qui distingue « livree » de « jamais
   * partie », et l'historique du depot doit pouvoir le dire. Sans cette bascule, une
   * mission fantome bloquerait le vehicule indefiniment.
   */
  private async cloreCellesSansMouvement(): Promise<void> {
    const limite = new Date(Date.now() - ABANDON_APRES_FIN_MS);
    const abandonnees = await this.prisma.mission.findMany({
      where: { status: MissionStatus.PLANNED, endAt: { lt: limite } },
      select: { id: true, ref: true },
      take: 200,
    });
    for (const m of abandonnees) {
      await this.basculer(m.id, MissionStatus.DONE, {});
      this.logger.log(`Mission ${m.ref} close sans deplacement detecte`);
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
