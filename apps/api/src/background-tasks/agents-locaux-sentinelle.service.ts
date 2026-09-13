import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { EmailService } from '../email/email.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { NIVEAU_DEGRADATION } from '../observability/niveaux-erreur';
import { CLES_REFROIDISSEMENT, RefroidissementAlerteService } from '../observability/refroidissement-alerte.service';
import { PrismaService } from '../prisma/prisma.service';
import { DemoModeService } from '../demo/demo-mode.service';
import { AgentDuPoste, BackgroundTasksService, PassageLocal } from './background-tasks.service';
import { PauseAgents, PauseAgentsLocauxService, SEUIL_ECHECS_CONSECUTIFS_MS } from './pause-agents-locaux.service';

/** Source des lignes écrites au centre d'alerte — le contrôleur du centre et l'écran la lisent telle quelle. */
export const SOURCE_AGENTS_LOCAUX = 'agents-locaux';

/**
 * Échéancier RÉEL, contrôle horaire à :50 et grâce de 2 h — un agent est jugé au premier contrôle
 * qui suit son créneau plus la grâce : récits (03:15) et rattrapage (tick de 02:00) à 05:50,
 * qualité GPS (05:00) à 07:50, courrier IA (06:30) à 08:50, limites de vitesse (08:30) à 10:50.
 * Une nuit sans poste ne produit donc pas cinq lignes à 05:50 mais cinq lignes étalées jusqu'à
 * 10:50 — c'est ce que disent la fiche TRK-069 et son manifeste, et il faut que les trois
 * s'accordent (revue C3 du 2026-09-05 ; 04:30 retiré des rendez-vous le 2026-09-13, voir le
 * catalogue : le poste dort souvent à cette heure et 08:30 reprend le même travail).
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

/**
 * ── TRK-069 / T31 (2026-09-13) — UNE CAUSE COMMUNE, UNE LIGNE ────────────────────────────
 *
 * Du 10/09 04:00 au 13/09 12:00 (Paris), la CLI Claude du poste était à son plafond hebdomadaire.
 * Trente-six passages en échec avec la même phrase, et cette sentinelle a écrit VINGT-CINQ lignes
 * CRITICAL — une par agent et par jour, toutes pour la même cause, sur laquelle aucun agent ne
 * pouvait rien. Elle faisait exactement ce qu'on lui demandait ; c'est le NIVEAU qui était faux,
 * comme la fiche TRK-069 l'annonçait dès sa création. Même principe que T10 : le niveau suit la
 * CAUSE, pas la gravité apparente.
 *
 * Une cause extérieure CONNUE se reconnaît à son motif, produit UNE ligne en DEGRADATION (rien
 * n'est cassé sur la plateforme : les analyses déterministes continuent, la reprise a pris douze
 * minutes après la remise à zéro), sous une clé de refroidissement PAR CAUSE — dérivée du motif,
 * jamais du texte complet, qui change d'un jour à l'autre —, et se referme d'elle-même au premier
 * passage réussi d'un agent qu'elle touchait.
 *
 * ⚠️ Seules les causes dont on SAIT qu'elles sont communes figurent ici. Une erreur réseau nomme
 * un point de terminaison : Overpass qui refuse le poste ne touche que l'agent des limites — ce
 * n'est pas une cause commune, et le traiter comme telle ferait taire une vraie panne d'un agent.
 */
export interface CauseCommune {
  /** Clé stable — celle du refroidissement, du contexte de la ligne et de sa résolution. */
  cle: string;
  libelle: string;
  motif: RegExp;
  /** Les agents que la cause peut toucher : un échec de l'un d'eux la signale, un succès la lève. */
  concerne: (agent: Pick<AgentDuPoste, 'coutIa'>) => boolean;
}

/** Les agents qui passent par l'abonnement du poste, donc par la CLI Claude. */
const parLaCli = (agent: Pick<AgentDuPoste, 'coutIa'>): boolean => agent.coutIa === 'absorbe';

export const CAUSES_COMMUNES: readonly CauseCommune[] = [
  {
    cle: 'plafond-hebdo',
    libelle: 'Plafond hebdomadaire de la CLI Claude atteint sur le poste',
    motif: /hit your weekly limit/i,
    concerne: parLaCli,
  },
  {
    // Le plafond glissant (cinq heures) : même canal, même remède, une échéance plus proche.
    cle: 'plafond-usage',
    libelle: 'Plafond d’usage de la CLI Claude atteint sur le poste',
    motif: /hit your (usage |rate )?limit|usage limit reached/i,
    concerne: parLaCli,
  },
  {
    // T34 — un agent qui sort parce que la PAUSE le retient (« en pause (cause) — … »). En dernier :
    // s'il cite la phrase du plafond, il reste rangé sous le plafond, dont la ligne est déjà
    // ouverte ; seule une pause posée par la sentinelle (échecs consécutifs) a la sienne.
    cle: 'pause',
    libelle: 'Agents du poste en pause',
    motif: /^en pause\b/i,
    concerne: parLaCli,
  },
];

/** Un passage que la pause a fait sortir : il ne dit rien de la CLI, il ne compte ni pour ni contre. */
export function passageEnPause(p: Pick<PassageLocal, 'erreur'>): boolean {
  return /^en pause\b/i.test(p.erreur ?? '');
}

/** Destinataire des courriels d'exploitation — le même que la vigie des erreurs critiques. */
const DESTINATAIRE_EXPLOITATION = 'contact@vizyoagency.com';
const LIBELLE_CAUSE_PAUSE: Record<string, string> = {
  'plafond-hebdo': 'plafond hebdomadaire de la CLI Claude',
  'plafond-usage': 'plafond d’usage de la CLI Claude',
  'echecs-consecutifs': 'cinq heures d’échecs d’affilée',
};

/** La cause commune que ce motif d'échec trahit, ou rien — auquel cas l'échec est celui de l'agent. */
export function causeCommune(motif: string): CauseCommune | null {
  return CAUSES_COMMUNES.find((c) => c.motif.test(motif)) ?? null;
}

/** Clé de refroidissement d'une cause : une par cause, tous agents confondus. */
export function cleCause(cause: Pick<CauseCommune, 'cle'>): string {
  return `${CLES_REFROIDISSEMENT.AGENT_LOCAL}:cause:${cause.cle}`;
}

/**
 * L'échéance que la CLI annonce dans son message (« … · resets Sep 13, 12pm (Europe/Paris) ») —
 * la seule information utile de la phrase, reprise telle quelle. `null` quand elle n'y est pas.
 */
export function remiseAZeroAnnoncee(motif: string): string | null {
  const m = /\bresets?\s+(.+?)\s*$/i.exec(motif);
  return m ? m[1]!.trim() : null;
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
    // Environnement de démonstration : aucun agent du poste ne vise la démo — la juger « à
    // l'arrêt » toutes les heures serait un faux CRITICAL de plus. Optionnel pour les specs.
    @Optional() private readonly demoMode?: DemoModeService,
    // T34 — la pause des agents : levée quand périmée, posée après cinq heures d'échecs, notifiée
    // par courriel. Optionnels : sans eux, la sentinelle juge comme avant et ne touche pas la pause.
    @Optional() private readonly pauses?: PauseAgentsLocauxService,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly config?: ConfigService,
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
    // Démo : les agents du poste n'écrivent que dans la production. Rien à juger ici.
    if (this.demoMode?.enabled) return;
    // T34 — une pause périmée ne retient personne : on la ferme avant de juger qui que ce soit.
    await this.entretenirPause('lever les pauses périmées', () => this.pauses!.leverPerimees(nowMs));
    // TRK-069 — les causes communes déjà signalées PENDANT CE CONTRÔLE : trois agents en échec
    // pour la même phrase ne doivent pas produire trois lignes, même si le refroidissement (base
    // injoignable → « émets ») laissait passer chacune.
    const causesSignalees = new Set<string>();
    for (const agent of this.catalogue.agentsDuPoste()) {
      try {
        await this.examiner(agent, nowMs, causesSignalees);
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
    // T34 — cinq heures d'échecs d'affilée : on arrête d'essayer, on prévient, un bouton relance.
    await this.entretenirPause('poser une pause après cinq heures d’échecs', () => this.poserApresEchecs(nowMs));
    await this.entretenirPause('notifier les pauses', () => this.notifierPauses(nowMs));
  }

  /**
   * Un geste sur la pause qui échoue (base, courriel) ne doit ni casser le contrôle des agents ni
   * passer inaperçu : ligne ERROR nommée, sans réveiller personne, et on continue.
   */
  private async entretenirPause(geste: string, action: () => Promise<unknown>): Promise<void> {
    if (!this.pauses) return;
    try {
      await action();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.errorLogger.recordBackground(
        new Error(`Pause des agents du poste — impossible de ${geste} : ${err.message}`),
        SOURCE_AGENTS_LOCAUX,
        { motif: 'pause', geste },
        'ERROR',
      );
    }
  }

  /**
   * ── T34 — CINQ HEURES D'ÉCHECS D'AFFILÉE → PAUSE SANS ÉCHÉANCE ──────────────────────────
   *
   * Le chiffre est celui du propriétaire (D5). Les agents qui passent par la CLI (récits,
   * rattrapage, courrier) sont regardés ENSEMBLE : depuis leur dernier passage réussi, s'ils n'ont
   * produit que des échecs pendant au moins cinq heures — deux au moins, pour qu'un échec isolé
   * suivi de silence ne suffise pas —, quelque chose est cassé que réessayer n'arrangera pas
   * (session expirée, CLI absente, réseau). La pause est posée sans échéance : seul le bouton
   * « Reprendre maintenant » la lève, et le courriel dit lequel.
   *
   * Les passages « en pause » sont écartés : ce sont des conséquences de la pause, pas des
   * échecs de la CLI — sinon une pause en engendrerait une autre à l'infini.
   */
  private async poserApresEchecs(nowMs: number): Promise<void> {
    if (await this.pauses!.active(nowMs)) return;
    const cles = this.catalogue.agentsDuPoste().filter((a) => a.coutIa === 'absorbe').map((a) => a.cleJournal);
    if (cles.length === 0) return;
    const depuis = new Date(nowMs - 2 * SEUIL_ECHECS_CONSECUTIFS_MS);
    const passages = await this.prisma.passageAgentLocal.findMany({
      where: { agent: { in: cles }, finiA: { gte: depuis } },
      orderBy: { finiA: 'desc' },
      select: { agent: true, demarreA: true, finiA: true, succes: true, resume: true, erreur: true },
    });
    const utiles = passages.filter((p) => !passageEnPause(p));
    const dernierSucces = utiles.find((p) => p.succes)?.finiA.getTime() ?? 0;
    const rates = utiles.filter((p) => !p.succes && p.finiA.getTime() > dernierSucces);
    if (rates.length < 2) return;
    const premier = Math.min(...rates.map((p) => p.demarreA.getTime()));
    if (nowMs - premier < SEUIL_ECHECS_CONSECUTIFS_MS) return;
    const dernier = rates[0]!;
    const pause = await this.pauses!.poser(
      { cause: 'echecs-consecutifs', motif: motifDe(dernier), poseePar: 'sentinelle', jusqua: null },
      nowMs,
    );
    if (pause) {
      this.logger.warn(
        `Pause des agents du poste posée : ${rates.length} échecs d'affilée depuis ${dateHeureParis(new Date(premier))} (Paris), dernier ${dernier.agent} — ${motifDe(dernier)}`,
      );
    }
  }

  /**
   * ── T34 — UN COURRIEL PAR PAUSE ────────────────────────────────────────────────────────────
   *
   * Qu'elle vienne du poste (plafond lu dans la réponse de la CLI) ou d'ici (échecs consécutifs),
   * une pause posée et jamais notifiée part une fois : par courriel à l'exploitation, et par le
   * socle générique aux super-admins. La pause n'est datée « notifiée » que si le courriel est
   * parti — sinon, le contrôle suivant réessaie : mieux vaut un courriel en retard qu'un silence.
   */
  private async notifierPauses(nowMs: number): Promise<void> {
    for (const pause of await this.pauses!.aNotifier()) {
      const agents = this.catalogue.agentsDuPoste().filter((a) => a.coutIa === 'absorbe').map((a) => a.id);
      const libelle = LIBELLE_CAUSE_PAUSE[pause.cause] ?? pause.cause;
      const reprise = pause.jusqua
        ? `reprise automatique le ${dateHeureParis(pause.jusqua)} (Paris), ou avant par le bouton « Reprendre maintenant »`
        : 'reprise MANUELLE : bouton « Reprendre maintenant » sur /admin/background-tasks';
      const message =
        `Agents du poste en pause depuis le ${dateHeureParis(pause.poseeA)} (Paris) — ${libelle}, posée par ${pause.poseePar}. ` +
        `Motif : ${pause.motif}. Concerne ${agents.join(', ')}. ${reprise}.`;
      if (!(await this.envoyerCourrielPause(pause, agents, message))) continue;
      await this.prevenir(`pause:${pause.cause}`, message);
      await this.pauses!.marquerNotifiee(pause.id, nowMs);
      this.logger.warn(message);
    }
  }

  /** `true` si le courriel est parti — ou s'il n'y a pas de service de courriel (rien à attendre). */
  private async envoyerCourrielPause(pause: PauseAgents, agents: string[], texte: string): Promise<boolean> {
    if (!this.email) return true;
    const to = (this.config?.get<string>('ERROR_RATE_ALERT_TO') || DESTINATAIRE_EXPLOITATION).trim();
    const libelle = LIBELLE_CAUSE_PAUSE[pause.cause] ?? pause.cause;
    const res = await this.email.send({
      to,
      subject: `[Tracky] Agents du poste en pause — ${libelle}`,
      html: this.email.buildPauseAgentsEmail({
        cause: pause.cause,
        libelle,
        motif: pause.motif,
        poseeA: pause.poseeA,
        poseePar: pause.poseePar,
        jusqua: pause.jusqua,
        agents,
      }),
      text: texte,
    });
    if (!res.ok) this.logger.warn(`courriel de pause non parti (${pause.id}) : ${res.error ?? 'sans motif'}`);
    return res.ok;
  }

  private async examiner(agent: AgentDuPoste, nowMs: number, causesSignalees: Set<string>): Promise<void> {
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
      // TRK-069 — un échec dont le motif trahit une cause commune (plafond de la CLI) n'est pas
      // l'échec de CET agent : une ligne pour la cause, aucune pour lui.
      const cause = causeCommune(motifDe(passage));
      if (cause && cause.concerne(agent)) {
        await this.signalerCauseCommune(cause, agent, passage, causesSignalees);
      } else {
        await this.signaler(
          agent,
          'echec',
          `Dernier passage en échec : ${agent.id} le ${dateHeureParis(passage.demarreA)} — ${motifDe(passage)}`,
          { attendu, passage },
        );
      }
    }

    // Un passage réussi referme tout épisode qui lui est antérieur — y compris quand un créneau
    // plus récent vient d'être signalé manqué : la ligne du jour est postérieure au passage, la
    // borne `createdAt < demarreA` la laisse ouverte (voir `resoudre`).
    if (passage.succes) await this.resoudre(agent, passage, nowMs);
  }

  /**
   * TRK-069 — UNE ligne pour une cause commune, en DEGRADATION, tous agents confondus.
   *
   * Trois gardes, dans cet ordre : déjà signalée pendant ce contrôle ; déjà OUVERTE au centre
   * d'alerte (une par épisode — la ligne reste jusqu'à ce qu'un passage réussi la referme, ou
   * qu'un humain l'archive) ; refroidissement par cause (une par jour si l'épisode s'éternise ou
   * si la ligne a été archivée à la main). Le premier agent touché est nommé, et la remise à zéro
   * que la CLI annonce est reprise : c'est la seule échéance qui compte.
   */
  private async signalerCauseCommune(
    cause: CauseCommune,
    agent: AgentDuPoste,
    passage: PassageLocal,
    causesSignalees: Set<string>,
  ): Promise<void> {
    if (causesSignalees.has(cause.cle)) return;
    causesSignalees.add(cause.cle);

    const ouverte = await this.prisma.errorLog.findFirst({
      where: { source: SOURCE_AGENTS_LOCAUX, resolvedAt: null, context: { path: ['cause'], equals: cause.cle } },
      select: { id: true },
    });
    if (ouverte) return;
    if (!(await this.refroidissement.tenterEmission(cleCause(cause), REFROIDISSEMENT_MS))) return;

    const concernes = this.catalogue.agentsDuPoste().filter((a) => cause.concerne(a)).map((a) => a.id);
    const remise = remiseAZeroAnnoncee(motifDe(passage));
    const message =
      `Cause commune aux agents du poste : ${cause.libelle}` +
      (remise ? ` — remise à zéro annoncée : ${remise}` : '') +
      `. Premier agent touché : ${agent.id} le ${dateHeureParis(passage.demarreA)}. ` +
      `Concerne ${concernes.join(', ')} ; une seule ligne pour tous, refermée au premier passage réussi.`;
    await this.errorLogger.record(
      new Error(message),
      SOURCE_AGENTS_LOCAUX,
      {
        motif: 'cause',
        cause: cause.cle,
        agent: agent.id,
        cleJournal: agent.cleJournal,
        concerne: concernes,
        remiseAZero: remise,
        dernierPassageAt: passage.demarreA.toISOString(),
        erreur: passage.erreur ?? null,
      },
      NIVEAU_DEGRADATION,
    );
    this.logger.warn(message);
    await this.prevenir(`cause:${cause.cle}`, message);
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
    await this.prevenir(agent.id, message);
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

    await this.leverCausesCommunes(agent, passage, nowMs);
  }

  /**
   * TRK-069 — un passage réussi d'un agent que la cause TOUCHAIT prouve qu'elle est levée : la
   * ligne de cause antérieure à ce passage est archivée, son refroidissement oublié.
   *
   * ⚠️ Seulement les causes qui concernent CET agent : les 11 et 12/09, l'agent des limites de
   * vitesse — qui n'appelle pas la CLI — passait à 08:30 et 14:00 pendant que la CLI restait au
   * plafond. Son succès ne prouvait rien sur elle, et n'aurait pas dû refermer la ligne.
   */
  private async leverCausesCommunes(agent: AgentDuPoste, passage: PassageLocal, nowMs: number): Promise<void> {
    const fin = passage.finiA ?? passage.demarreA;
    for (const cause of CAUSES_COMMUNES) {
      if (!cause.concerne(agent)) continue;
      const { count } = await this.prisma.errorLog.updateMany({
        where: {
          source: SOURCE_AGENTS_LOCAUX,
          resolvedAt: null,
          createdAt: { lt: fin },
          context: { path: ['cause'], equals: cause.cle },
        },
        data: {
          resolvedAt: new Date(nowMs),
          resolvedNote: `Cause levée : ${agent.id} repassé le ${dateHeureParis(passage.demarreA)} (résolution automatique)`,
        },
      });
      if (count > 0) this.logger.log(`Cause « ${cause.cle} » levée par ${agent.id} : ${count} ligne(s) archivée(s).`);

      const derniere = await this.refroidissement.derniereEmission(cleCause(cause));
      if (derniere && derniere.getTime() < fin.getTime()) await this.refroidissement.oublier(cleCause(cause));
    }
  }

  /**
   * Prévenir les super-admins — par le socle générique (`notifyUsers`) : mêmes préférences, même
   * anti-spam (cloisonné par sujet via `subjectKey` : un agent, ou une cause commune), même
   * journal que toute autre notification. Best-effort : la ligne du centre d'alerte est déjà
   * écrite, un échec ici se note et ne casse rien.
   */
  private async prevenir(sujet: string, message: string): Promise<void> {
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
        subjectKey: sujet,
        title: 'Agent du poste en alerte',
        body: message,
        url: '/admin/alerts',
      });
    } catch (e) {
      this.logger.warn(`notification des super-admins non envoyée pour ${sujet} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
