import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { decideAlerteExces, reglageEffectif } from '@vizyo/tracky-shared';
import { FRAICHEUR_MAX_MS } from '../alerts/speed-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorLogger, type ErrorLogContext } from './error-logger.service';
import { NIVEAU_DEGRADATION, type NiveauErreur } from './niveaux-erreur';
import { CLES_REFROIDISSEMENT, RefroidissementAlerteService } from './refroidissement-alerte.service';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * SENTINELLES DE COHÉRENCE (lot V6, 2026-09-03) — ce que Tracky sait, mais ne disait pas.
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── POURQUOI ELLES EXISTENT ─────────────────────────────────────────────────────────────
 *
 * Demande explicite du 3 septembre : « ajoute des viewers, pour que ça remonte dans le centre
 * d'alerte s'il y a des incohérences ». Le constat qui l'a provoquée : Tracky MESURAIT des
 * excès de vitesse depuis des mois, les rangeait dans les analyses, et personne — ni le client,
 * ni nous — n'a vu que la chaîne d'alerte n'existait pas. Il a fallu qu'un utilisateur ouvre un
 * replay et compte les excès à la main.
 *
 * Une sentinelle ne corrige rien. Elle pose une question à voix haute, une fois par jour, au
 * seul endroit où quelqu'un la lira : « le compte n'y est pas, allez voir ». C'est le filet qui
 * manquait — celui qui aurait crié à notre place.
 *
 * ── LA RÈGLE QUI GOUVERNE TOUT CE FICHIER ───────────────────────────────────────────────
 *
 * ⚠️ UNE LIGNE PAR INCOHÉRENCE ET PAR JOUR, JAMAIS UNE PAR TRAJET. Ce dépôt a déjà payé
 * 41 713 alertes d'alimentation parties d'un seul boîtier, et 1 627 excès acquittés en bloc
 * sans être lus. Un instrument qui crie à chaque trajet ne rend pas le centre plus vigilant :
 * il le rend illisible, et c'est exactement ainsi qu'on cesse de voir les vraies pannes.
 *
 * D'où : agrégation par société, seuils calibrés sur des chiffres RÉELS (relevés en production
 * le 3 septembre, cités constante par constante), et refroidissement PERSISTANT — celui qui
 * survit à un redéploiement, contrairement à un compteur en mémoire.
 *
 * ── CE QUI EST DÉLIBÉRÉMENT ABSENT ──────────────────────────────────────────────────────
 *
 * Aucune sentinelle ne notifie personne. Elles écrivent au centre d'alerte, et rien d'autre :
 * réveiller un téléphone pour dire « la couverture cartographique a baissé » serait le défaut
 * qu'on vient de corriger ailleurs, reproduit ici.
 */

/** Fenêtre observée par les sentinelles de flux : la journée écoulée. */
const FENETRE_JOUR_MS = 24 * 60 * 60 * 1000;

/**
 * Refroidissement des sentinelles quotidiennes.
 *
 * 20 heures et non 24 : le passage est planifié à heure fixe, et un redémarrage qui le décale
 * de quelques minutes ne doit pas faire sauter la journée entière. Assez long pour qu'un
 * double passage n'écrive pas deux lignes, assez court pour ne jamais rater un jour.
 */
const REFROIDISSEMENT_QUOTIDIEN_MS = 20 * 60 * 60 * 1000;

/** Refroidissement des sentinelles LENTES — un rappel hebdomadaire, pas un rappel du matin. */
const REFROIDISSEMENT_HEBDOMADAIRE_MS = 6.5 * 24 * 60 * 60 * 1000;

/** Analyses lues au plus par passage et par sentinelle. Un garde-fou ne doit pas peser. */
const MAX_ANALYSES_LUES = 2000;

/** Sociétés/comptes nommés dans un message. Au-delà, on compte sans énumérer. */
const MAX_NOMMES = 5;

/**
 * ── SEUIL — VITESSE NON CORROBORÉE ──────────────────────────────────────────────────────
 *
 * Un point écarté isolé est du bruit GPS ordinaire : le boîtier annonce 180 km/h sur une trame,
 * la trajectoire dit 131, le garde-fou du lot V1 l'écarte, tout fonctionne. Ce qui mérite un
 * regard, c'est la RÉCURRENCE : un boîtier qui ment tous les jours est un boîtier à changer.
 *
 * Deux conditions, et il faut les deux : un plancher absolu (sinon une société d'un seul trajet
 * déclencherait sur une trame) et une part (sinon une grosse flotte déclencherait toujours).
 */
const CORROBORATION_MIN_ANALYSES = 3;
const CORROBORATION_PART_MIN = 0.1;

/**
 * ── SEUIL — LIMITE INVRAISEMBLABLE ──────────────────────────────────────────────────────
 *
 * « Limite 30, dépassement +72 » sur la rocade toulousaine : le point avait été rattaché au pont
 * qui franchit la voie, pas à la voie. Le lot V2 refuse désormais d'affirmer ces excès. Cette
 * sentinelle surveille le TRAVAIL du garde-fou : quelques cas par jour sont normaux (aucune carte
 * n'est parfaite), une dizaine trahit une zone mal cartographiée qu'il faut aller regarder.
 */
const INVRAISEMBLABLE_MIN = 10;

/**
 * ── SEUIL — COUVERTURE DES LIMITES ──────────────────────────────────────────────────────
 *
 * Sous cette part de points rapides résolus, l'analyse ne sait presque rien des limites légales,
 * et la note de conduite est plafonnée (lot V4). Une société dont un tiers des trajets est dans
 * ce cas n'a pas un problème de conduite : elle a un problème de carte, et il faut le dire —
 * sinon ses rapports paraissent cléments sans que personne sache pourquoi.
 *
 * ⚠️ Le seuil de couverture (0,5) est celui du plafonnement de la note : deux valeurs
 * différentes pour la même question créeraient deux vérités.
 */
const COUVERTURE_FAIBLE = 0.5;
const COUVERTURE_PART_MIN = 0.3;
const COUVERTURE_MIN_ANALYSES = 5;

/**
 * ── SEUIL — DESTINATAIRE SANS APPAREIL ──────────────────────────────────────────────────
 *
 * Relevé du 3 septembre en production : deux comptes SUPER_ADMIN cumulaient 21 notifications
 * étouffées chacun sur sept jours, sans le moindre appareil abonné — dont un compte technique
 * (`system@tracky.local`) qui n'en aura jamais. Les vrais clients, eux, avaient tous un appareil
 * et recevaient. Personne ne l'a jamais su : le motif `no_device` s'écrivait en base et
 * s'arrêtait là.
 *
 * Cinq notifications perdues dans la semaine : sous ce seuil, c'est un abonnement qui vient
 * d'expirer et qui se rétablira au prochain passage de l'intéressé.
 */
const SANS_APPAREIL_MIN = 5;

/**
 * ── SEUIL — ALERTES JAMAIS ACQUITTÉES ───────────────────────────────────────────────────
 *
 * Une alerte qu'on n'acquitte pas n'est pas forcément ignorée — l'exploitant peut avoir traité
 * l'incident sans cliquer. Un TAS d'alertes anciennes, en revanche, dit qu'on ne lit plus le
 * centre, et c'est le début de la cécité qu'on cherche à empêcher.
 *
 * ⚠️ Calibré sur la réalité, pas au jugé : la production du 3 septembre compte UNE seule alerte
 * non acquittée, toutes sociétés confondues. Dix est donc largement au-dessus du bruit de fond
 * actuel — la sentinelle restera muette tant que la situation ne se dégrade pas.
 */
const NON_ACQUITTEES_MIN = 10;
const NON_ACQUITTEES_AGE_JOURS = 7;

/** Un constat prêt à être écrit — ce que rend chaque sentinelle. */
export interface ConstatSentinelle {
  /** Clé de refroidissement : identifiant PERSISTANT, le renommer remet le garde à zéro. */
  cle: string;
  source: string;
  niveau: NiveauErreur;
  message: string;
  contexte: ErrorLogContext;
  /** Délai avant de pouvoir redire la même chose. */
  fenetreMs: number;
}

/**
 * Ce que rend un passage. Le DÉTAIL compte autant que les compteurs : lors d'un déclenchement
 * manuel, l'exploitant doit voir ce que les sentinelles ont trouvé — y compris ce que le
 * refroidissement a empêché d'écrire, sans quoi « 0 écrit » se confondrait avec « rien à dire ».
 */
export interface PassageSentinelles {
  constats: number;
  emis: number;
  lignes: { cle: string; niveau: NiveauErreur; message: string; emis: boolean }[];
}

/** Une analyse telle que les sentinelles la lisent (sous-ensemble volontairement minimal). */
interface AnalyseLue {
  tripId: string;
  fleetId: string;
  vehicleId: string;
  computedAt: Date;
  maxSpeedKmh: number;
  speedingCount: number;
  limitsCoverage: number | null;
  detail: unknown;
}

/** Le détail JSON, tel qu'il est écrit par le préprocesseur (champs optionnels : analyses anciennes). */
interface DetailLu {
  speeding?: { startAt: string; endAt: string; durationSec: number; maxSpeedKmh: number; limitKmh: number; overKmh: number; lat: number; lng: number }[];
  track?: { lat: number; lng: number; t: string; speedKmh: number }[];
  aVerifier?: { motif: string }[];
  vitesse?: { pointeBruteKmh: number; pointsEcartes: number };
}

function detailDe(analyse: AnalyseLue): DetailLu {
  return (analyse.detail ?? {}) as DetailLu;
}

/** « 3 sociétés » / « la société X » — un compte qui se lit sans effort. */
function enumere(noms: string[], max = MAX_NOMMES): string {
  if (noms.length <= max) return noms.join(', ');
  return `${noms.slice(0, max).join(', ')} et ${noms.length - max} autre${noms.length - max > 1 ? 's' : ''}`;
}

@Injectable()
export class SentinellesCoherenceService {
  private readonly logger = new Logger(SentinellesCoherenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
    private readonly refroidissement: RefroidissementAlerteService,
  ) {}

  /**
   * 06:30 UTC — après la sonde de sauvegarde (06:00), avant les rappels d'entretien (07:00).
   * L'heure importe peu ; l'espacement, si : trois instruments qui écrivent à la même seconde
   * rendraient leurs lignes indiscernables dans le centre.
   */
  @Cron('0 30 6 * * *', { name: 'sentinelles-coherence' })
  async passage(maintenant = new Date()): Promise<PassageSentinelles> {
    const depuis = new Date(maintenant.getTime() - FENETRE_JOUR_MS);
    const constats: ConstatSentinelle[] = [];

    // Chaque sentinelle est isolée : celle qui tombe ne doit pas emporter les cinq autres.
    for (const [nom, sentinelle] of this.sentinelles()) {
      try {
        constats.push(...(await sentinelle(depuis, maintenant)));
      } catch (e) {
        this.logger.error(`Sentinelle « ${nom} » en échec : ${e instanceof Error ? e.message : String(e)}`);
        void this.errorLogger.recordBackground(
          e instanceof Error ? e : new Error(String(e)),
          'sentinelles',
          { sentinelle: nom },
        );
      }
    }

    const lignes: PassageSentinelles['lignes'] = [];
    for (const c of constats) {
      // Le refroidissement décide ET se consomme dans la même instruction : deux passages
      // concurrents ne peuvent pas franchir la garde ensemble.
      const emis = await this.refroidissement.tenterEmission(c.cle, c.fenetreMs);
      if (emis) await this.errorLogger.record(c.message, c.source, c.contexte, c.niveau);
      lignes.push({ cle: c.cle, niveau: c.niveau, message: c.message, emis });
    }

    const emis = lignes.filter((l) => l.emis).length;
    this.logger.log(`Sentinelles : ${constats.length} constat(s), ${emis} écrit(s) au centre d'alerte.`);
    return { constats: constats.length, emis, lignes };
  }

  private sentinelles(): [string, (depuis: Date, maintenant: Date) => Promise<ConstatSentinelle[]>][] {
    return [
      ['exces-sans-alerte', (d, m) => this.excesSansAlerte(d, m)],
      ['vitesse-non-corroboree', (d) => this.vitesseNonCorroboree(d)],
      ['limite-invraisemblable', (d) => this.limiteInvraisemblable(d)],
      ['couverture-limites', (d) => this.couvertureFaible(d)],
      ['destinataire-sans-appareil', (d, m) => this.destinataireSansAppareil(m)],
      ['alertes-non-acquittees', (d, m) => this.alertesNonAcquittees(m)],
    ];
  }

  // ══ 1. UN EXCÈS SANS SON ALERTE ═══════════════════════════════════════════════════════
  //
  // La sentinelle que le client a demandée en propres termes : « si un user a activé les
  // alertes de vitesse d'une voiture ou d'une flotte, alors check les trajets. Si un trajet a
  // un excès et qu'il n'y a pas de notification, c'est louche. »
  //
  // ⚠️ ELLE APPLIQUE LA MÊME FONCTION QUE LE PRODUCTEUR (`decideAlerteExces`). Réécrire ici
  // la règle « qu'est-ce qui mérite une alerte » créerait un second juge, et deux juges qui
  // divergent produisent soit un silence, soit un cri permanent — jamais la vérité.
  private async excesSansAlerte(depuis: Date, maintenant: Date): Promise<ConstatSentinelle[]> {
    const flottes = await this.prisma.fleet.findMany({
      where: { OR: [{ speedAlertEnabled: true }, { vehicles: { some: { speedAlertEnabled: true } } }] },
      select: {
        id: true, name: true,
        speedAlertEnabled: true, speedAlertOverKmh: true, speedAlertAbsoluteKmh: true, speedAlertUpdatedAt: true,
      },
    });
    if (flottes.length === 0) return [];

    const analyses = await this.lireAnalyses({
      fleetId: { in: flottes.map((f) => f.id) },
      computedAt: { gte: depuis },
      // Sans excès NI vitesse notable, aucune décision ne peut naître : on ne lit pas ces lignes.
      OR: [{ speedingCount: { gt: 0 } }, { maxSpeedKmh: { gt: 100 } }],
    });
    if (analyses.length === 0) return [];

    const vehicules = await this.prisma.vehicle.findMany({
      where: { id: { in: [...new Set(analyses.map((a) => a.vehicleId))] } },
      select: { id: true, plate: true, speedAlertEnabled: true, speedAlertOverKmh: true },
    });
    const parVehicule = new Map(vehicules.map((v) => [v.id, v]));

    const trajets = await this.prisma.trip.findMany({
      where: { id: { in: analyses.map((a) => a.tripId) } },
      select: { id: true, startedAt: true, endedAt: true },
    });
    const parTrajet = new Map(trajets.map((t) => [t.id, t]));

    const avecAlerte = new Set(
      (await this.prisma.alert.findMany({
        where: { tripId: { in: analyses.map((a) => a.tripId) }, type: 'OVERSPEED' },
        select: { tripId: true },
      })).map((a) => a.tripId!),
    );

    const manquants = new Map<string, { nom: string; trajets: string[] }>();
    for (const a of analyses) {
      if (avecAlerte.has(a.tripId)) continue;
      const flotte = flottes.find((f) => f.id === a.fleetId);
      const trajet = parTrajet.get(a.tripId);
      if (!flotte || !trajet) continue;

      // Le réglage a-t-il seulement été en vigueur au moment de l'analyse ? Un trajet analysé
      // AVANT l'activation n'a jamais eu de raison d'alerter — le signaler accuserait la chaîne
      // d'une faute qui n'existe pas.
      if (flotte.speedAlertUpdatedAt && a.computedAt < flotte.speedAlertUpdatedAt) continue;

      // Même borne de fraîcheur que le producteur : au-delà, l'absence d'alerte est VOULUE.
      const fin = (trajet.endedAt ?? trajet.startedAt).getTime();
      if (a.computedAt.getTime() - fin > FRAICHEUR_MAX_MS) continue;

      const reglage = reglageEffectif(flotte, parVehicule.get(a.vehicleId) ?? null);
      if (!reglage.enabled) continue;

      const detail = detailDe(a);
      const decision = decideAlerteExces(
        { maxSpeedKmh: a.maxSpeedKmh, speeding: detail.speeding ?? [], track: detail.track },
        reglage,
      );
      if (!decision) continue;

      const entree = manquants.get(a.fleetId) ?? { nom: flotte.name, trajets: [] };
      entree.trajets.push(a.tripId);
      manquants.set(a.fleetId, entree);
    }

    return [...manquants.entries()].map(([fleetId, { nom, trajets }]) => ({
      cle: `${CLES_REFROIDISSEMENT.SENTINELLE_EXCES_SANS_ALERTE}:${fleetId}`,
      source: 'sentinelles',
      niveau: 'ERROR' as NiveauErreur,
      message:
        `${trajets.length} trajet${trajets.length > 1 ? 's' : ''} de « ${nom} » ${trajets.length > 1 ? 'ont' : 'a'} un excès ` +
        `qui aurait dû produire une alerte, et n'en a pas. Les alertes de vitesse sont pourtant actives pour cette société. ` +
        `Premier trajet concerné : ${trajets[0]}.`,
      contexte: { fleetId, tripId: trajets[0], trajets: trajets.slice(0, 20), total: trajets.length, depuis: depuis.toISOString() },
      fenetreMs: REFROIDISSEMENT_QUOTIDIEN_MS,
    }));
  }

  // ══ 2. UNE VITESSE QUE LA TRAJECTOIRE CONTREDIT ═══════════════════════════════════════
  //
  // Le 180 km/h du 29 août : 727 mètres en vingt secondes, soit 131 km/h réels. Le lot V1
  // écarte ces points ; celui-ci compte combien de fois il a dû le faire. Un boîtier qui ment
  // tous les jours ne se répare pas tout seul.
  private async vitesseNonCorroboree(depuis: Date): Promise<ConstatSentinelle[]> {
    const analyses = await this.lireAnalyses({ computedAt: { gte: depuis } });
    const parFlotte = new Map<string, { total: number; touchees: number; vehicules: Map<string, number> }>();

    for (const a of analyses) {
      const stat = parFlotte.get(a.fleetId) ?? { total: 0, touchees: 0, vehicules: new Map<string, number>() };
      stat.total++;
      const ecartes = detailDe(a).vitesse?.pointsEcartes ?? 0;
      if (ecartes > 0) {
        stat.touchees++;
        stat.vehicules.set(a.vehicleId, (stat.vehicules.get(a.vehicleId) ?? 0) + ecartes);
      }
      parFlotte.set(a.fleetId, stat);
    }

    const constats: ConstatSentinelle[] = [];
    for (const [fleetId, stat] of parFlotte) {
      if (stat.touchees < CORROBORATION_MIN_ANALYSES) continue;
      if (stat.touchees / stat.total < CORROBORATION_PART_MIN) continue;

      const nom = await this.nomFlotte(fleetId);
      const pires = [...stat.vehicules.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_NOMMES);
      const plaques = await this.plaques(pires.map(([id]) => id));
      constats.push({
        cle: `${CLES_REFROIDISSEMENT.SENTINELLE_VITESSE_NON_CORROBOREE}:${fleetId}`,
        source: 'sentinelles',
        niveau: NIVEAU_DEGRADATION,
        message:
          `${stat.touchees} analyses sur ${stat.total} de « ${nom} » contiennent une vitesse que la distance parcourue ` +
          `contredit — le boîtier annonce plus vite que le déplacement ne le permet. Ces points sont écartés du calcul, ` +
          `mais la répétition désigne un boîtier à vérifier. Véhicules les plus concernés : ${enumere(plaques)}.`,
        contexte: { fleetId, analysesTouchees: stat.touchees, analysesTotal: stat.total, depuis: depuis.toISOString() },
        fenetreMs: REFROIDISSEMENT_QUOTIDIEN_MS,
      });
    }
    return constats;
  }

  // ══ 3. UN EXCÈS BÂTI SUR UNE LIMITE INVRAISEMBLABLE ═══════════════════════════════════
  //
  // 102 km/h sur une voie à 30 : personne ne roule ainsi dans une rue à 30, le point a été
  // rattaché au pont. Le lot V2 refuse d'affirmer ces excès et les range en « à vérifier ».
  // Ici on compte : au-delà d'une dizaine par jour, c'est une ZONE mal cartographiée, pas
  // l'imperfection ordinaire d'une carte libre.
  private async limiteInvraisemblable(depuis: Date): Promise<ConstatSentinelle[]> {
    const analyses = await this.lireAnalyses({ computedAt: { gte: depuis } });
    const parFlotte = new Map<string, { cas: number; trajets: string[] }>();

    for (const a of analyses) {
      const douteux = (detailDe(a).aVerifier ?? []).filter((v) => v.motif === 'limite-invraisemblable').length;
      if (douteux === 0) continue;
      const stat = parFlotte.get(a.fleetId) ?? { cas: 0, trajets: [] };
      stat.cas += douteux;
      stat.trajets.push(a.tripId);
      parFlotte.set(a.fleetId, stat);
    }

    const constats: ConstatSentinelle[] = [];
    for (const [fleetId, stat] of parFlotte) {
      if (stat.cas < INVRAISEMBLABLE_MIN) continue;
      const nom = await this.nomFlotte(fleetId);
      constats.push({
        cle: `${CLES_REFROIDISSEMENT.SENTINELLE_LIMITE_INVRAISEMBLABLE}:${fleetId}`,
        source: 'sentinelles',
        niveau: NIVEAU_DEGRADATION,
        message:
          `${stat.cas} pointes de « ${nom} » ont été refusées comme excès : la limite retrouvée est trop basse pour la ` +
          `vitesse relevée (typiquement un pont rattaché à la voie qu'il franchit). Le garde-fou fait son travail, mais ` +
          `cette concentration désigne une zone à corriger dans la carte. Premier trajet : ${stat.trajets[0]}.`,
        contexte: { fleetId, cas: stat.cas, tripId: stat.trajets[0], trajets: stat.trajets.slice(0, 20), depuis: depuis.toISOString() },
        fenetreMs: REFROIDISSEMENT_QUOTIDIEN_MS,
      });
    }
    return constats;
  }

  // ══ 4. UNE ANALYSE QUI NE SAIT PRESQUE RIEN DES LIMITES ═══════════════════════════════
  //
  // `limitsKnown` ne répond qu'à « au moins une limite ? » : un trajet couvert à 2 % lui
  // répondait oui comme un trajet couvert à 100 %, et pouvait décrocher la meilleure note par
  // ignorance. Le taux existe depuis le lot V3 ; cette sentinelle dit quand il s'effondre.
  private async couvertureFaible(depuis: Date): Promise<ConstatSentinelle[]> {
    const analyses = await this.lireAnalyses({ computedAt: { gte: depuis }, limitsCoverage: { not: null } });
    const parFlotte = new Map<string, { total: number; faibles: number }>();

    for (const a of analyses) {
      const stat = parFlotte.get(a.fleetId) ?? { total: 0, faibles: 0 };
      stat.total++;
      if ((a.limitsCoverage ?? 1) < COUVERTURE_FAIBLE) stat.faibles++;
      parFlotte.set(a.fleetId, stat);
    }

    const constats: ConstatSentinelle[] = [];
    for (const [fleetId, stat] of parFlotte) {
      if (stat.total < COUVERTURE_MIN_ANALYSES) continue;
      const part = stat.faibles / stat.total;
      if (part < COUVERTURE_PART_MIN) continue;

      const nom = await this.nomFlotte(fleetId);
      constats.push({
        cle: `${CLES_REFROIDISSEMENT.SENTINELLE_COUVERTURE_LIMITES}:${fleetId}`,
        source: 'sentinelles',
        niveau: NIVEAU_DEGRADATION,
        message:
          `${stat.faibles} analyses sur ${stat.total} de « ${nom} » (${Math.round(part * 100)} %) n'ont retrouvé la limite ` +
          `légale que pour moins de la moitié de leurs points rapides. Les excès y sont sous-comptés et la note de conduite ` +
          `est plafonnée : ce n'est pas la conduite qui est en cause, c'est la couverture cartographique.`,
        contexte: { fleetId, analysesFaibles: stat.faibles, analysesTotal: stat.total, depuis: depuis.toISOString() },
        fenetreMs: REFROIDISSEMENT_QUOTIDIEN_MS,
      });
    }
    return constats;
  }

  // ══ 5. QUELQU'UN QU'ON CROIT PRÉVENIR, ET QUI NE REÇOIT RIEN ══════════════════════════
  //
  // Relevé en production : deux comptes cumulaient 21 notifications étouffées chacun sur sept
  // jours, sans un seul appareil abonné. Le motif `no_device` s'écrivait en base et s'arrêtait
  // là — l'intéressé se croyait couvert. Une ligne par semaine, nommée, suffit à le savoir.
  private async destinataireSansAppareil(maintenant: Date): Promise<ConstatSentinelle[]> {
    const depuis = new Date(maintenant.getTime() - 7 * FENETRE_JOUR_MS);
    const groupes = await this.prisma.notificationDelivery.groupBy({
      by: ['userId'],
      where: { status: 'SUPPRESSED', reason: 'no_device', createdAt: { gte: depuis } },
      _count: { _all: true },
    });
    const concernes = groupes.filter((g) => g._count._all >= SANS_APPAREIL_MIN);
    if (concernes.length === 0) return [];

    const comptes = await this.prisma.user.findMany({
      where: { id: { in: concernes.map((g) => g.userId) }, isActive: true },
      select: { id: true, email: true },
    });
    if (comptes.length === 0) return [];

    const parCompte = new Map(concernes.map((g) => [g.userId, g._count._all]));
    const decrits = comptes
      .map((u) => ({ email: u.email, perdues: parCompte.get(u.id) ?? 0 }))
      .sort((a, b) => b.perdues - a.perdues);
    const total = decrits.reduce((s, d) => s + d.perdues, 0);

    return [{
      cle: CLES_REFROIDISSEMENT.SENTINELLE_SANS_APPAREIL,
      source: 'sentinelles',
      niveau: 'ERROR' as NiveauErreur,
      message:
        `${total} notifications n'ont pas pu être remises cette semaine faute d'appareil abonné, sur ` +
        `${decrits.length} compte${decrits.length > 1 ? 's' : ''} actif${decrits.length > 1 ? 's' : ''} : ` +
        `${enumere(decrits.map((d) => `${d.email} (${d.perdues})`))}. ` +
        `Ces personnes se croient prévenues et ne le sont pas — soit elles doivent activer les notifications sur un ` +
        `appareil, soit elles n'ont rien à faire dans la liste des destinataires.`,
      contexte: { comptes: decrits.slice(0, 20), total, depuis: depuis.toISOString() },
      fenetreMs: REFROIDISSEMENT_HEBDOMADAIRE_MS,
    }];
  }

  // ══ 6. DES ALERTES QUE PLUS PERSONNE NE LIT ═══════════════════════════════════════════
  //
  // Une alerte non acquittée n'est pas forcément ignorée. Un TAS d'alertes anciennes, si : c'est
  // le moment où le centre cesse d'être lu, et donc où la prochaine vraie panne passera inaperçue.
  private async alertesNonAcquittees(maintenant: Date): Promise<ConstatSentinelle[]> {
    const avant = new Date(maintenant.getTime() - NON_ACQUITTEES_AGE_JOURS * FENETRE_JOUR_MS);
    const groupes = await this.prisma.alert.groupBy({
      by: ['fleetId'],
      where: { acknowledgedAt: null, createdAt: { lt: avant } },
      _count: { _all: true },
    });

    const constats: ConstatSentinelle[] = [];
    for (const g of groupes) {
      if (g._count._all < NON_ACQUITTEES_MIN) continue;
      const nom = await this.nomFlotte(g.fleetId);
      constats.push({
        cle: `${CLES_REFROIDISSEMENT.SENTINELLE_ALERTES_NON_ACQUITTEES}:${g.fleetId}`,
        source: 'sentinelles',
        niveau: 'ERROR' as NiveauErreur,
        message:
          `${g._count._all} alertes de « ${nom} » ont plus de ${NON_ACQUITTEES_AGE_JOURS} jours et ne sont toujours pas ` +
          `acquittées. Soit elles n'intéressent personne — et il faut couper ce qui les produit — soit plus personne ne ` +
          `lit le centre d'alerte, ce qui revient à être aveugle à la prochaine.`,
        contexte: { fleetId: g.fleetId, nonAcquittees: g._count._all, avant: avant.toISOString() },
        fenetreMs: REFROIDISSEMENT_HEBDOMADAIRE_MS,
      });
    }
    return constats;
  }

  // ── Lectures communes ───────────────────────────────────────────────────────────────────

  private async lireAnalyses(where: Record<string, unknown>): Promise<AnalyseLue[]> {
    return this.prisma.tripAnalysis.findMany({
      where: where as never,
      select: {
        tripId: true, fleetId: true, vehicleId: true, computedAt: true,
        maxSpeedKmh: true, speedingCount: true, limitsCoverage: true, detail: true,
      },
      orderBy: { computedAt: 'desc' },
      take: MAX_ANALYSES_LUES,
    }) as unknown as Promise<AnalyseLue[]>;
  }

  private readonly nomsFlotte = new Map<string, string>();

  private async nomFlotte(fleetId: string): Promise<string> {
    const connu = this.nomsFlotte.get(fleetId);
    if (connu) return connu;
    const f = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { name: true } });
    const nom = f?.name ?? fleetId;
    this.nomsFlotte.set(fleetId, nom);
    return nom;
  }

  private async plaques(vehicleIds: string[]): Promise<string[]> {
    if (vehicleIds.length === 0) return [];
    const v = await this.prisma.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { id: true, plate: true } });
    const parId = new Map(v.map((x) => [x.id, x.plate]));
    return vehicleIds.map((id) => parId.get(id) ?? id);
  }
}
