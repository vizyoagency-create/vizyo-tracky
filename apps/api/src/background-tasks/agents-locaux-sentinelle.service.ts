import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { CLES_REFROIDISSEMENT, RefroidissementAlerteService } from '../observability/refroidissement-alerte.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentDuPoste, BackgroundTasksService, PassageLocal } from './background-tasks.service';

/** Source des lignes écrites au centre d'alerte — le contrôleur du centre et l'écran la lisent telle quelle. */
export const SOURCE_AGENTS_LOCAUX = 'agents-locaux';

/**
 * Échéancier RÉEL, contrôle horaire à :50 et grâce de 2 h — un agent est jugé au premier contrôle
 * qui suit son créneau plus la grâce : récits (03:15) et rattrapage (tick de 02:00) à 05:50,
 * limites de vitesse (04:30) à 06:50, qualité GPS (05:00) à 07:50, courrier IA (06:30) à 08:50.
 * Une nuit sans poste ne produit donc pas cinq lignes à 05:50 mais cinq lignes étalées jusqu'à
 * 08:50 — c'est ce que disent la fiche TRK-069 et son manifeste, et il faut que les trois
 * s'accordent (revue C3 du 2026-09-05).
 */
/**
 * GRÂCE : deux heures après le déclenchement planifié avant de parler de passage manqué.
 *
 * Les cinq tâches du Planificateur de Windows sont posées avec `StartWhenAvailable` : un créneau
 * raté parce que le PC dormait est rattrapé AU DÉMARRAGE du poste, sans réveil (relevé de
 * production du 2026-09-05, design/C3). Un agent de 03:15 qui tourne à 04:10 parce que le
 * propriétaire vient de rallumer la machine n'est donc pas en panne : c'est exactement le
 * comportement voulu, et le crier apprendrait à ignorer la sentinelle. Une heure de retard est
 * normale ; deux heures, non — au-delà, le créneau est perdu et le matin doit le dire.
 */
export const GRACE_MS = 2 * 3_600_000;

/**
 * Une ligne par agent, par épisode et par jour. C'est ce qui fait que « PC éteint la nuit » se lit
 * le matin comme CINQ lignes — une par agent — et non comme cinq lignes par heure jusqu'à ce que
 * quelqu'un rallume le poste. La clé est oubliée dès que l'agent repasse avec succès (voir
 * `resoudre`), pour que l'épisode suivant crie sans attendre la fin de cette fenêtre.
 *
 * ⚠️ 23 h et non 24 : le contrôle tire toutes les heures à la même minute, et une fenêtre de 24 h
 * PILE se referme quelques millisecondes trop tard — la ligne du lendemain glissait à 06:50, puis
 * 07:50, jusqu'à sortir de la matinée. Une fenêtre plus courte que le pas garantit « une par jour,
 * à la même heure ».
 */
export const REFROIDISSEMENT_MS = 23 * 3_600_000;

/**
 * Tolérance sur l'heure de DÉMARRAGE d'un passage face au déclenchement planifié : l'horloge du
 * poste et celle du serveur ne sont pas synchronisées à la seconde, et le Planificateur peut lancer
 * la tâche quelques secondes avant la minute pleine. Un passage démarré à 03:14:58 pour un créneau
 * de 03:15 EST le passage de ce créneau.
 */
const TOLERANCE_DEMARRAGE_MS = 60_000;

/** Les trois façons pour un agent du poste de manquer à l'appel. */
export type MotifAlerte = 'jamais' | 'manque' | 'echec';
const MOTIFS: readonly MotifAlerte[] = ['jamais', 'manque', 'echec'];

/** Clé de refroidissement d'un épisode : préfixe du catalogue des clés, agent, motif. */
export function cleRefroidissement(agent: Pick<AgentDuPoste, 'id'>, motif: MotifAlerte): string {
  return `${CLES_REFROIDISSEMENT.AGENT_LOCAL}:${agent.id}:${motif}`;
}

const FMT_DATE = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' });
const FMT_HEURE = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * « 05/09/2026 à 03:15 », en heure de PARIS — celle du poste et de ses tâches planifiées, jamais
 * celle du serveur (UTC en production). Un message qui annoncerait « attendu à 01:15 » enverrait
 * le lecteur vérifier une tâche qui n'existe pas à cette heure-là dans le Planificateur.
 */
export function dateHeureParis(d: Date): string {
  return `${FMT_DATE.format(d)} à ${FMT_HEURE.format(d)}`;
}

/** Le motif d'un passage en échec, tel que le poste l'a consigné — à défaut, son résumé. */
function motifDe(p: PassageLocal): string {
  return p.erreur?.trim() || p.resume?.trim() || 'motif non consigné';
}

/** Ce que le dernier passage a dit de lui-même, issue comprise : c'est ce que le message reprend. */
function resumeDe(p: PassageLocal): string {
  return p.succes ? p.resume?.trim() || 'sans résumé' : `en échec : ${motifDe(p)}`;
}

/**
 * SENTINELLE DES AGENTS DU POSTE — « le PC a-t-il fait son travail cette nuit ? »
 *
 * ══ Ce qu'elle répare (PS du chantier C3, 2026-09-05) ═════════════════════════════════════
 *
 * Cinq traitements de cette application ne tournent pas sur le serveur : ils dépendent d'un PC
 * allumé, d'une session Windows et d'un abonnement Claude. Leur arrêt ne lève AUCUNE erreur côté
 * serveur — rien à corréler, rien dans les journaux, rien du tout. L'écran des traitements de fond
 * sait les afficher « silencieux »… au-delà de DEUX FOIS leur cadence, soit 48 h pour l'agent de
 * récits : un PC éteint la nuit ne s'y voyait que le surlendemain, et seulement si quelqu'un
 * ouvrait cet écran-là. Décision du propriétaire : « je veux tout voir : PC éteint la nuit, le
 * matin tous les agents en échec ».
 *
 * ══ Comment elle juge ═════════════════════════════════════════════════════════════════════
 *
 * Elle ne raisonne PAS sur la cadence mais sur le DERNIER DÉCLENCHEMENT PLANIFIÉ, lu au catalogue
 * (heure de Paris) et recalculé à rebours : l'agent de 03:15 est attendu à 03:15, le rattrapage aux
 * heures paires. Au-delà de la grâce, si le dernier passage journalisé a démarré AVANT ce créneau,
 * le créneau est manqué. Un dernier passage en échec se signale avec son motif ; un agent qui n'a
 * jamais écrit une ligne se signale aussi. Le rattrapage des récits fait exception quand l'écran
 * le juge « sans objet » (arriéré résorbé) : une tâche qui a fini son travail n'a rien à écrire, la
 * déclarer en panne reviendrait à crier sur un succès.
 *
 * ══ Comment elle se tait ═════════════════════════════════════════════════════════════════
 *
 * Une ligne par agent, par épisode et par jour (refroidissement 24 h par agent et par motif) ; les
 * lignes ouvertes d'un agent sont ARCHIVÉES automatiquement dès qu'il repasse avec succès, et le
 * refroidissement est oublié pour que la panne suivante crie sans délai. Les super-admins reçoivent
 * une notification à chaque NOUVELLE ligne — la ligne du centre d'alerte prime : la notification
 * peut échouer, elle ne fait jamais échouer l'alerte.
 */
@Injectable()
export class AgentsLocauxSentinelleService {
  private readonly logger = new Logger(AgentsLocauxSentinelleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: BackgroundTasksService,
    private readonly errorLogger: ErrorLogger,
    private readonly refroidissement: RefroidissementAlerteService,
    // Optionnel : la ligne du centre d'alerte est le contrat, la notification un confort. Un
    // module qui n'aurait pas le dispatch (spec, environnement réduit) ne doit pas perdre l'alerte.
    @Optional() private readonly dispatch?: NotificationDispatchService,
  ) {}

  /**
   * ⚠️ RIEN ENTRE CE DÉCORATEUR ET SA MÉTHODE (même règle que la sonde des tâches planifiées).
   *
   * Toutes les heures à la 50ᵉ minute : APRÈS les passages du serveur de :30 (courrier, limites
   * de vitesse aux demi-heures) et de :45 (automatisation des trajets), et après la sonde de :35.
   * Le premier passage utile est celui de 05:50 : l'agent de récits (03:15, jusqu'à 110 min) et
   * l'agent qualité GPS (05:00) ont eu leur créneau et leur grâce ou presque — et le propriétaire
   * lit le centre d'alerte au réveil, pas à minuit.
   */
  @Cron('0 50 * * * *')
  async verifier(nowMs = Date.now()): Promise<void> {
    for (const agent of this.catalogue.agentsDuPoste()) {
      try {
        await this.examiner(agent, nowMs);
      } catch (e) {
        // Une lecture qui échoue n'est PAS un agent à l'arrêt : accuser le poste d'une panne de
        // base enverrait chercher au mauvais endroit. On le dit avec l'opération nommée et le motif
        // technique EN FIN de phrase (règle des fiches TRK-060/066/068 : jamais un message brut),
        // sans réveiller les super-admins, et on continue avec les autres agents.
        const err = e instanceof Error ? e : new Error(String(e));
        this.errorLogger.recordBackground(
          new Error(`Journal des passages illisible pour ${agent.id} : ${err.message}`),
          SOURCE_AGENTS_LOCAUX,
          { agent: agent.id, cleJournal: agent.cleJournal, motif: 'lecture' },
          'ERROR',
        );
      }
    }
  }

  private async examiner(agent: AgentDuPoste, nowMs: number): Promise<void> {
    // Lecture STRICTE : un journal illisible remonte à `verifier`, il ne devient pas « jamais vu ».
    const passage = await this.catalogue.dernierPassage(agent.cleJournal, { strict: true });

    if (!passage) {
      await this.signaler(agent, 'jamais', `Agent du poste jamais journalisé : ${agent.id}`, { attendu: null, passage: null });
      return;
    }

    // Le créneau jugé est le DERNIER DONT LA GRÂCE EST ÉCOULÉE — planifié il y a plus de 2 h —,
    // et non le dernier tout court. Pour un agent quotidien, c'est le créneau du jour dès 05:15.
    // Pour le rattrapage, toutes les 2 h, c'est le tick PRÉCÉDENT : sur le dernier tick, la grâce
    // ne serait jamais écoulée quand le suivant arrive, et cet agent n'aurait jamais pu manquer
    // (défaut trouvé par le jeu d'essai, 2026-09-05).
    const attendu = this.catalogue.dernierDeclenchementAttendu(agent.id, nowMs - GRACE_MS);
    if (await this.passageManque(agent, passage, attendu)) {
      await this.signaler(
        agent,
        'manque',
        `Passage manqué : ${agent.id} attendu le ${dateHeureParis(attendu!)} (Paris), ` +
          `dernier passage le ${dateHeureParis(passage.demarreA)} — ${resumeDe(passage)}`,
        { attendu, passage },
      );
    } else if (!passage.succes) {
      await this.signaler(
        agent,
        'echec',
        `Dernier passage en échec : ${agent.id} le ${dateHeureParis(passage.demarreA)} — ${motifDe(passage)}`,
        { attendu, passage },
      );
    }

    // Un passage réussi referme tout épisode qui lui est antérieur — y compris quand un créneau
    // plus récent vient d'être signalé manqué : la ligne du jour est postérieure au passage, la
    // borne `createdAt < demarreA` la laisse ouverte (voir `resoudre`).
    if (passage.succes) await this.resoudre(agent, passage, nowMs);
  }

  /**
   * Le dernier créneau dont la grâce est écoulée n'a pas eu son passage : le dernier passage
   * journalisé a démarré AVANT lui.
   *
   * ⚠️ « Avant le créneau » et non « il y a plus de N heures » : à 05:50, l'agent de récits
   * attendu à 03:15 est manqué si son dernier passage date de la veille, même s'il n'a que 26 h —
   * ce que deux fois sa cadence (48 h) n'aurait vu que le lendemain.
   */
  private async passageManque(agent: AgentDuPoste, passage: PassageLocal, attendu: Date | null): Promise<boolean> {
    if (!attendu) return false; // aucune planification datée au catalogue : rien à comparer
    if (passage.demarreA.getTime() >= attendu.getTime() - TOLERANCE_DEMARRAGE_MS) return false; // a tourné pour ce créneau
    // Silence VOULU (rattrapage dont l'arriéré est résorbé) : l'agent sort sans rien écrire.
    return !(await this.catalogue.silenceLegitime(agent.id));
  }

  /** UNE ligne au centre d'alerte par agent, par motif et par jour — puis les super-admins. */
  private async signaler(
    agent: AgentDuPoste,
    motif: MotifAlerte,
    message: string,
    faits: { attendu: Date | null; passage: PassageLocal | null },
  ): Promise<void> {
    const cle = cleRefroidissement(agent, motif);
    // `tenterEmission` demande le droit d'écrire ET le consomme dans la même instruction ; base
    // injoignable → il rend vrai, et l'on émet : devant le doute, le silence est le mauvais défaut.
    if (!(await this.refroidissement.tenterEmission(cle, REFROIDISSEMENT_MS))) return;

    const { cadenceMs } = this.catalogue.surveillance(agent.id);
    await this.errorLogger.record(
      new Error(message),
      SOURCE_AGENTS_LOCAUX,
      {
        // `agent` porte l'id du CATALOGUE : c'est sur lui que `resoudre` filtre les lignes ouvertes
        // (chemin JSON `context.agent`), et lui que l'écran affiche en tête de ligne.
        agent: agent.id,
        cleJournal: agent.cleJournal,
        motif,
        attenduAt: faits.attendu?.toISOString() ?? null,
        dernierPassageAt: faits.passage?.demarreA.toISOString() ?? null,
        resume: faits.passage?.resume ?? null,
        erreur: faits.passage?.erreur ?? null,
        cadenceMs,
      },
      'CRITICAL',
    );
    this.logger.error(message);
    await this.prevenir(agent, message);
  }

  /**
   * L'agent a repassé avec succès : les lignes ouvertes ANTÉRIEURES à ce passage décrivent un
   * épisode clos. On les archive (jamais effacées — règle du centre d'alerte depuis TRK-035), avec
   * une note qui dit pourquoi, et l'on oublie tout refroidissement émis avant ce passage pour que
   * la panne suivante crie sans attendre la fin de sa fenêtre de 24 h.
   *
   * Filtre par CHEMIN JSON (`context.agent`) et non par `message contains` : « courrier-ia » est
   * contenu dans « agent-courrier-ia », un filtre textuel archiverait les lignes d'un autre agent.
   *
   * La borne est la FIN du passage (`createdAt < finiA`), pas son début : le journal du poste
   * n'existe qu'à la fin, et un passage lancé à 05:41 (rattrapage au démarrage du PC) qui se
   * termine à 05:58 répond bel et bien à la ligne écrite à 05:50 — la borner sur `demarreA` la
   * laissait ouverte jusqu'au lendemain. Le garde-fou tient toujours : la ligne de CE matin n'est
   * pas refermée par un passage d'HIER, dont la fin est antérieure.
   */
  private async resoudre(agent: AgentDuPoste, passage: PassageLocal, nowMs: number): Promise<void> {
    const { count } = await this.prisma.errorLog.updateMany({
      where: {
        source: SOURCE_AGENTS_LOCAUX,
        resolvedAt: null,
        createdAt: { lt: passage.finiA ?? passage.demarreA },
        context: { path: ['agent'], equals: agent.id },
      },
      data: {
        resolvedAt: new Date(nowMs),
        resolvedNote: `Agent repassé le ${dateHeureParis(passage.demarreA)} (résolution automatique)`,
      },
    });
    if (count > 0) {
      this.logger.log(`${agent.id} : ${count} ligne(s) du centre d'alerte archivée(s) — repassé le ${dateHeureParis(passage.demarreA)}.`);
    }

    // Toute émission ANTÉRIEURE au passage réussi appartient à un épisode clos — même si un humain
    // avait déjà archivé la ligne à la main : le refroidissement, lui, courrait encore.
    for (const motif of MOTIFS) {
      const cle = cleRefroidissement(agent, motif);
      const derniere = await this.refroidissement.derniereEmission(cle);
      if (derniere && derniere.getTime() < (passage.finiA ?? passage.demarreA).getTime()) {
        await this.refroidissement.oublier(cle);
      }
    }
  }

  /**
   * Prévenir les super-admins — par le socle générique (`notifyUsers`) : mêmes préférences, même
   * anti-spam (cloisonné par agent via `subjectKey`), même journal que toute autre notification.
   * Best-effort : la ligne du centre d'alerte est déjà écrite, un échec ici se note et ne casse rien.
   */
  private async prevenir(agent: AgentDuPoste, message: string): Promise<void> {
    if (!this.dispatch) return;
    try {
      const admins = await this.prisma.user.findMany({
        where: { role: UserRole.SUPER_ADMIN, isActive: true },
        select: { id: true },
      });
      if (admins.length === 0) return;
      await this.dispatch.notifyUsers({
        userIds: admins.map((a) => a.id),
        category: 'SYSTEM',
        kind: 'agent-local-absent',
        subjectKey: agent.id,
        title: 'Agent du poste en alerte',
        body: message,
        url: '/admin/alerts',
      });
    } catch (e) {
      this.logger.warn(`notification des super-admins non envoyée pour ${agent.id} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
