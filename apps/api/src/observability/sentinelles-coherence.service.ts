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

/**
 * ══ LES TROIS GARDES DU BRUIT — pourquoi ils comptent plus que les six autres ══════════
 *
 * Demande du propriétaire, le 4 septembre, après avoir dû couper les alertes de vitesse en
 * urgence : « il ne faut pas spammer les administrateurs, sinon ils désactivent les
 * notifications, et là on est pour les faire réactiver, c'est chaud. »
 *
 * 🔑 C'est le risque le plus cher du produit, et le plus discret. Un client saturé ne se
 * plaint pas : il coupe. Et le jour où un SOS part, il ne le reçoit pas non plus. Une alerte
 * qu'on ne reçoit plus est pire qu'une alerte qui n'a jamais existé, parce que tout le monde
 * croit encore qu'elle fonctionne.
 *
 * Ces trois sentinelles ne surveillent pas les données du client : elles surveillent NOTRE
 * PROPRE VOLUME. C'est l'instrument qui manquait ce matin.
 */

/**
 * ── SEUIL — DESTINATAIRE SATURÉ ─────────────────────────────────────────────────────────
 *
 * Mesuré en production le 4 septembre, sur trente jours : le pire jour d'un administrateur
 * client est de **10 notifications**, sa moyenne de 2. Le défaut du produit est calibré sur
 * ≈ 2,3 par jour, et cette valeur est démontrée dans `DEFAULT_PUSH_PREFERENCE`.
 *
 * Le même jour, un seuil d'alerte de vitesse trop bas aurait produit **29 notifications par
 * jour** pour le gérant de MH Cars — et c'est à ce moment que le propriétaire a demandé
 * l'arrêt. Quinze se situe donc au-dessus de tout ce qui a jamais été toléré, et bien en
 * dessous du volume qui a fait réagir : la sentinelle parle AVANT que le client ne coupe.
 */
const SATURATION_PAR_JOUR = 15;

/**
 * ── SEUIL — LE PLAFOND HORAIRE A DÛ INTERVENIR ──────────────────────────────────────────
 *
 * `PUSH_MAX_PER_HOUR` retient tout ce qui dépasse douze notifications par heure. En trente
 * jours de production, il n'a eu à intervenir **aucune fois**. Cette garde n'est donc pas un
 * régulateur du quotidien : c'est un disjoncteur. Qu'il saute est en soi l'information.
 *
 * Un seul cas suffit à écrire la ligne. Pas de seuil, pas de part : le fait est binaire.
 */
const PLAFOND_HORAIRE_MIN = 1;

/**
 * ── SEUIL — BOÎTIERS MUETS (VPS-038) ────────────────────────────────────────────────────
 *
 * Le 31/08 entre 11 h 53 et 13 h 50, **six boîtiers d'une même société se sont tus en deux
 * heures**. Le 06/09 ils l'étaient encore — **cinq jours et demi** —, et la flotte émettrice
 * était passée de 39 à 30 traceurs par jour, soit **−23 %**. Pendant tout ce temps, le centre
 * d'alerte n'a rien dit : les boîtiers sont bien marqués `OFFLINE` dans le registre, mais
 * personne ne lit un registre, et aucun instrument ne posait la question à voix haute.
 *
 * ⚠️ **Trois jours, et pas vingt-quatre heures.** Un véhicule garé le week-end, un chauffeur en
 * congé, une batterie débranchée pour un entretien : à un jour, cette sentinelle crierait tous
 * les lundis matin. Relevé du 06/09 sur les 44 boîtiers du parc — bande `6-24 h` : **0**,
 * `1-3 j` : **1**, `3-7 j` : **7**, `> 7 j` : **6**. C'est bien au-delà de trois jours que le
 * silence cesse d'être un usage normal.
 */
const MUET_SEUIL_JOURS = 3;

/**
 * ⚠️ **Un boîtier SANS véhicule n'est pas une panne, et il ne doit jamais déclencher.**
 *
 * Relevé du 06/09 : trois boîtiers sont muets depuis **7,3, 66,8 et 92,7 jours** et ne sont
 * rattachés à aucun véhicule. Ce n'est pas un incident, c'est du matériel déposé que personne
 * n'a sorti du parc — une décision produit, pas une alerte. Les compter ferait crier cette
 * ligne **tous les jours, pour toujours**, et un instrument qui crie toujours cesse d'être lu.
 *
 * 🔑 **Mais on ne les efface pas : on les classe.** Ils sont comptés dans le contexte de la
 * ligne (`deposesSansVehicule`), pour qu'un lecteur puisse vérifier que le tri est juste — même
 * traitement que `comptesTechniquesEcartes` pour la sentinelle nº 5.
 *
 * ⚠️ **Et surtout : PAS de borne HAUTE sur l'ancienneté d'un boîtier rattaché.** La tentation
 * serait d'écarter au-delà de sept jours en les rangeant, eux aussi, dans « matériel déposé ».
 * Ce serait le piège de VPS-M76 reproduit ici : *un compteur qui décroît à mesure que la panne
 * dure*. Les six boîtiers du 31/08 auraient franchi les sept jours le 07/09 et **auraient
 * disparu de l'alerte le jour même où l'incident devenait le plus grave.* Tant qu'un boîtier
 * est rattaché à un véhicule, son silence se signale — c'est le rattachement qui décide, jamais
 * la durée.
 */
const MUET_EXIGE_UN_VEHICULE = true;

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

/**
 * ── TRK-065 — LES COMPTES TECHNIQUES NE SONT PAS DES DESTINATAIRES ──────────────────────
 *
 * Mesuré le 2026-09-04, au premier passage de la sentinelle nº 5 : **42 notifications perdues
 * en sept jours, dont exactement 21 pour `system@tracky.local`** — un compte de service, qui
 * n'installera jamais d'application et n'attend rien de personne.
 *
 * 🔑 **Sans cette exclusion, l'instrument crierait chaque semaine avec un chiffre à moitié
 * structurel.** C'est ainsi qu'un garde-fou neuf devient du bruit en trois passages, puis cesse
 * d'être lu — exactement ce que l'en-tête de ce fichier existe pour empêcher.
 *
 * ⚠️ Le critère est le DOMAINE, pas une liste d'adresses : `.local` est réservé par la RFC 6762
 * et n'est routable nulle part. Une adresse qui s'y trouve ne peut, par construction, appartenir
 * à une personne joignable. Une liste d'adresses en dur, elle, serait fausse au prochain compte
 * de service créé.
 *
 * ⚠️ **On n'efface rien : on classe.** Les comptes écartés sont comptés et rendus dans le
 * contexte de la ligne (`comptesTechniquesEcartes`), pour qu'un lecteur puisse toujours vérifier
 * que le tri est juste.
 */
const DOMAINES_TECHNIQUES = ['.local', '.invalid', '.internal'];

function estCompteTechnique(email: string): boolean {
  const bas = (email ?? '').toLowerCase().trim();
  return DOMAINES_TECHNIQUES.some((d) => bas.endsWith(d));
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
      // Les trois gardes du BRUIT : elles surveillent notre propre volume, pas les données.
      ['destinataire-sature', (d, m) => this.destinataireSature(d, m)],
      ['plafond-horaire', (d) => this.plafondHoraireAtteint(d)],
      ['notifications-coupees', (d) => this.notificationsCoupees(d)],
      // VPS-038 : la flotte elle-même se tait, et rien ne le disait à voix haute.
      ['boitiers-muets', (d, m) => this.boitiersMuets(m)],
    ];
  }

  // ══ 10. DES BOÎTIERS RATTACHÉS À UN VÉHICULE NE PARLENT PLUS ══════════════════════════
  //
  // Née de VPS-038, relevée par l'audit VPS du 06/09 : six boîtiers d'une même société muets
  // depuis cinq jours et demi, une flotte passée de 39 à 30 émetteurs par jour, et **aucune
  // ligne nulle part**. Le registre `trackers` portait l'information depuis le premier jour —
  // il n'a simplement jamais eu de lecteur.
  //
  // ⚠️ UNE LIGNE PAR SOCIÉTÉ, jamais une par boîtier : six boîtiers d'une même flotte sont un
  // seul fait, et six lignes le rendraient six fois moins lisible.
  private async boitiersMuets(maintenant: Date): Promise<ConstatSentinelle[]> {
    const seuil = new Date(maintenant.getTime() - MUET_SEUIL_JOURS * FENETRE_JOUR_MS);

    // ⚠️ `lt` ne rend PAS les lignes dont `lastSeenAt` est nul : un boîtier enregistré qui n'a
    // JAMAIS émis est hors de portée de cette sentinelle. C'est délibéré — c'est un défaut de
    // provisionnement, pas une perte de contact, et les deux ne se traitent pas au même endroit.
    const muets = await this.prisma.tracker.findMany({
      where: { lastSeenAt: { lt: seuil } },
      select: {
        imei: true,
        lastSeenAt: true,
        vehicle: { select: { plate: true, fleetId: true, fleet: { select: { name: true } } } },
      },
    });
    if (muets.length === 0) return [];

    const joursDe = (d: Date | null | undefined): number =>
      d ? (maintenant.getTime() - d.getTime()) / FENETRE_JOUR_MS : 0;

    const sansVehicule = muets.filter((t) => !t.vehicle);
    const rattaches = MUET_EXIGE_UN_VEHICULE ? muets.filter((t) => t.vehicle) : muets;
    if (rattaches.length === 0) return [];

    const parFlotte = new Map<string, { nom: string; boitiers: { imei: string; plaque: string; jours: number }[] }>();
    for (const t of rattaches) {
      const v = t.vehicle;
      if (!v) continue;
      const groupe = parFlotte.get(v.fleetId) ?? { nom: v.fleet?.name ?? v.fleetId, boitiers: [] };
      groupe.boitiers.push({
        imei: t.imei,
        plaque: v.plate,
        jours: Math.round(joursDe(t.lastSeenAt) * 10) / 10,
      });
      parFlotte.set(v.fleetId, groupe);
    }

    const constats: ConstatSentinelle[] = [];
    for (const [fleetId, groupe] of parFlotte) {
      // Le plus ancien silence en tête : c'est celui qui date l'épisode.
      const boitiers = groupe.boitiers.sort((a, b) => b.jours - a.jours);
      const n = boitiers.length;
      const pluriel = n > 1 ? 's' : '';

      constats.push({
        // Le compte entre dans la clé : un effectif qui bouge parle tout de suite, un effectif
        // stable se tait pour la semaine. Voir le commentaire de la clé.
        cle: `${CLES_REFROIDISSEMENT.SENTINELLE_BOITIERS_MUETS}:${fleetId}:${n}`,
        source: 'sentinelles',
        niveau: 'ERROR' as NiveauErreur,
        message:
          `${n} boîtier${pluriel} de ${groupe.nom} n'émet${n > 1 ? 'tent' : ''} plus depuis plus de ` +
          `${MUET_SEUIL_JOURS} jours : ` +
          `${enumere(boitiers.map((b) => `${b.plaque} (${b.imei}, ${b.jours} j)`))}. ` +
          `Au-delà de trois jours, un silence n'est plus un stationnement : ${n > 1 ? 'ces véhicules ne sont' : 'ce véhicule n’est'} ` +
          `ni suivi${pluriel} ni géolocalisable${pluriel}, et aucune alerte de vol ou de mouvement ne partira ${n > 1 ? 'les' : 'le'} concernant. ` +
          `À porter à l'exploitant de la flotte avec l'heure de la dernière trame.`,
        contexte: {
          flotteId: fleetId,
          flotte: groupe.nom,
          boitiers: boitiers.slice(0, 20),
          total: n,
          // ⚠️ Le plus ancien EST l'information : six boîtiers à 5,6 jours sont un incident
          // groupé, six boîtiers à 3, 12, 40, 60, 90 et 200 jours sont un parc mal tenu.
          silenceMaxJours: boitiers[0]?.jours ?? 0,
          silenceMinJours: boitiers[n - 1]?.jours ?? 0,
          seuilJours: MUET_SEUIL_JOURS,
          // Rendu visible plutôt qu'effacé : un lecteur doit pouvoir vérifier que le tri est juste.
          deposesSansVehicule: sansVehicule.length,
        },
        fenetreMs: REFROIDISSEMENT_HEBDOMADAIRE_MS,
      });
    }
    return constats;
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
    // TRK-064 : « aucune société concernée » n'est PAS un non-événement. Voir `chaineJamaisArmee`.
    if (flottes.length === 0) return this.chaineJamaisArmee(depuis);

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

  /**
   * ══ 1 bis. L'ANGLE MORT DE LA SENTINELLE PRÉCÉDENTE (TRK-064, 2026-09-04) ═════════════
   *
   * Mesuré en production le lendemain de la mise en ligne du lot V5 : **0 société sur 5 et
   * 0 véhicule sur 44** avaient les alertes de vitesse activées, aucun seuil n'était
   * renseigné — pendant que **145 analyses fraîches portaient un excès**. La sentinelle
   * ci-dessus sortait donc sur sa toute première ligne et rendait EXACTEMENT le même silence
   * qu'une chaîne d'alerte en parfait état de marche.
   *
   * 🔑 Un garde-fou doit savoir dire qu'il n'a rien à garder. Le réglage en opt-in est un
   * choix produit défendable ; ce qui ne l'est pas, c'est que personne ne puisse apprendre
   * qu'il vaut zéro partout. *C'est la leçon du témoin désarmé (TRK-026), repayée ici sur
   * l'instrument censé la porter.*
   *
   * ⚠️ Niveau DEGRADATION, pas ERROR : rien n'est cassé, une capacité est simplement
   * inactive — le raisonnement retenu pour Overpass en TRK-037. Et refroidissement
   * HEBDOMADAIRE : c'est un état durable, pas une nouvelle du matin.
   *
   * ⚠️ DEUX conditions, et il faut les deux — c'est ce qui sépare un garde-fou d'un râleur :
   *
   *   1. **Des sociétés EXISTENT.** « Aucune société armée » et « aucune société du tout » se
   *      ressemblent trait pour trait dans une requête filtrée, et ne veulent pas du tout dire
   *      la même chose : sur une plateforme vide, il n'y a rien à armer et rien à signaler.
   *      *Ce piège a été trouvé par les tests des cinq AUTRES sentinelles, dont les fixtures
   *      ne déclarent aucune société parce qu'elles ne s'y intéressent pas — et que cette
   *      sentinelle s'est mise à interrompre.*
   *   2. **Des excès ont réellement été mesurés.** Une chaîne inactive sur une flotte qui ne
   *      roule pas vite ne prive de rien, et le répéter chaque semaine serait exactement le
   *      bruit que ce fichier existe pour éviter.
   */
  private async chaineJamaisArmee(depuis: Date): Promise<ConstatSentinelle[]> {
    const societes = await this.prisma.fleet.count();
    if (societes === 0) return [];

    const analyses = await this.lireAnalyses({ computedAt: { gte: depuis }, speedingCount: { gt: 0 } });
    if (analyses.length === 0) return [];

    const vehicules = new Set(analyses.map((a) => a.vehicleId)).size;
    return [{
      cle: CLES_REFROIDISSEMENT.SENTINELLE_CHAINE_JAMAIS_ARMEE,
      source: 'sentinelles',
      niveau: NIVEAU_DEGRADATION,
      message:
        `Les alertes de vitesse ne sont activées sur AUCUNE des ${societes} sociétés, ni sur aucun véhicule, alors que ` +
        `${analyses.length} analyse${analyses.length > 1 ? 's' : ''} ${analyses.length > 1 ? 'ont' : 'a'} relevé un ` +
        `excès depuis la veille, sur ${vehicules} véhicule${vehicules > 1 ? 's' : ''}. Personne n'est prévenu de ces ` +
        `excès, et la sentinelle qui devrait le signaler ne peut pas parler : elle n'a aucune société à surveiller. ` +
        `Action : activer le réglage sur au moins une société, ou acter que cette chaîne ne sert pas.`,
      contexte: { societes, analysesAvecExces: analyses.length, vehicules, depuis: depuis.toISOString() },
      fenetreMs: REFROIDISSEMENT_HEBDOMADAIRE_MS,
    }];
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
    const tous = comptes
      .map((u) => ({ email: u.email, perdues: parCompte.get(u.id) ?? 0 }))
      .sort((a, b) => b.perdues - a.perdues);

    // TRK-065 — un compte de service n'est pas quelqu'un qu'on croit prévenir.
    const decrits = tous.filter((d) => !estCompteTechnique(d.email));
    const ecartes = tous.length - decrits.length;
    if (decrits.length === 0) return [];

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
      contexte: {
        comptes: decrits.slice(0, 20),
        total,
        // Rendu visible plutôt qu'effacé : un lecteur doit pouvoir vérifier que le tri est juste.
        comptesTechniquesEcartes: ecartes,
        depuis: depuis.toISOString(),
      },
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

  // ══ 7. QUELQU'UN REÇOIT TROP, ET VA COUPER ════════════════════════════════════════════
  //
  // Le compteur qui prévient AVANT la perte. Un administrateur saturé ne se plaint pas : il
  // désactive ses notifications, et personne ne l'apprend — jusqu'au jour où un SOS ne lui
  // parvient plus. Le remède (le faire réactiver) coûte infiniment plus cher que le réglage
  // qui aurait évité la saturation.
  private async destinataireSature(depuis: Date, maintenant: Date): Promise<ConstatSentinelle[]> {
    const envois = await this.prisma.notificationDelivery.groupBy({
      by: ['userId'],
      where: { status: 'SENT', createdAt: { gte: depuis } },
      _count: { _all: true },
    });
    const satures = envois.filter((e) => e._count._all >= SATURATION_PAR_JOUR);
    if (satures.length === 0) return [];

    const comptes = await this.prisma.user.findMany({
      where: { id: { in: satures.map((s) => s.userId) } },
      select: { id: true, email: true, role: true },
    });
    const parCompte = new Map(comptes.map((c) => [c.id, c]));

    const constats: ConstatSentinelle[] = [];
    for (const s of satures) {
      const compte = parCompte.get(s.userId);
      if (!compte) continue;

      // De quoi vient le bruit ? Sans ce détail, la ligne dit « trop » sans dire quoi couper.
      const parType = await this.prisma.notificationDelivery.groupBy({
        by: ['alertType'],
        where: { userId: s.userId, status: 'SENT', createdAt: { gte: depuis } },
        _count: { _all: true },
      });
      const dominant = [...parType].sort((a, b) => b._count._all - a._count._all)[0];
      // Ce que le regroupement a déjà absorbé : le volume PRODUIT est plus élevé encore.
      const regroupes = await this.prisma.notificationDelivery.count({
        where: { userId: s.userId, reason: 'cooldown', createdAt: { gte: depuis } },
      });

      constats.push({
        cle: `${CLES_REFROIDISSEMENT.SENTINELLE_DESTINATAIRE_SATURE}:${s.userId}`,
        source: 'sentinelles',
        niveau: 'ERROR' as NiveauErreur,
        message:
          `${compte.email} a reçu ${s._count._all} notifications en 24 h` +
          (dominant ? `, dont ${dominant._count._all} de type ${dominant.alertType}` : '') +
          (regroupes > 0 ? ` (et ${regroupes} de plus ont été repliées par le regroupement)` : '') +
          `. Le produit est calibré sur deux à trois par jour. À ce rythme, cette personne va couper ses ` +
          `notifications — et elle ne recevra alors plus rien, pas même un SOS. Relever le seuil qui produit ` +
          `ce type, ou restreindre ses destinataires, AVANT qu'elle ne le fasse elle-même.`,
        contexte: { userId: s.userId, email: compte.email, role: String(compte.role), envois: s._count._all, regroupes, type: dominant?.alertType ?? null },
        fenetreMs: REFROIDISSEMENT_QUOTIDIEN_MS,
      });
    }
    return constats;
  }

  // ══ 8. LE DISJONCTEUR A SAUTÉ ═════════════════════════════════════════════════════════
  //
  // Le plafond horaire retient tout ce qui dépasse douze notifications par heure pour une même
  // personne. En trente jours de production, il n'a eu à intervenir aucune fois : ce n'est pas
  // un régulateur du quotidien, c'est un disjoncteur. Qu'il saute EST l'information.
  private async plafondHoraireAtteint(depuis: Date): Promise<ConstatSentinelle[]> {
    const bloques = await this.prisma.notificationDelivery.groupBy({
      by: ['userId'],
      where: { reason: 'hourly_cap', createdAt: { gte: depuis } },
      _count: { _all: true },
    });
    const total = bloques.reduce((n, b) => n + b._count._all, 0);
    if (total < PLAFOND_HORAIRE_MIN) return [];

    const comptes = await this.prisma.user.findMany({
      where: { id: { in: bloques.map((b) => b.userId) } },
      select: { id: true, email: true },
    });
    const nom = new Map(comptes.map((c) => [c.id, c.email]));
    const decrits = bloques.map((b) => `${nom.get(b.userId) ?? b.userId} (${b._count._all})`);

    return [{
      cle: CLES_REFROIDISSEMENT.SENTINELLE_PLAFOND_HORAIRE,
      source: 'sentinelles',
      niveau: 'ERROR' as NiveauErreur,
      message:
        `${total} notifications ont été BLOQUÉES par le plafond horaire en 24 h, sur ${bloques.length} compte(s) : ` +
        `${enumere(decrits)}. Ce garde-fou n'était jamais intervenu depuis sa mise en service : qu'il se déclenche ` +
        `signifie qu'une source produit plus de douze notifications par heure pour une seule personne. ` +
        `Le destinataire, lui, n'a rien vu — et c'est la seule raison pour laquelle il n'a pas encore coupé.`,
      contexte: { total, comptes: decrits.slice(0, 20), depuis: depuis.toISOString() },
      fenetreMs: REFROIDISSEMENT_QUOTIDIEN_MS,
    }];
  }

  // ══ 9. QUELQU'UN VIENT DE COUPER ══════════════════════════════════════════════════════
  //
  // La perte elle-même. Elle doit se voir le jour où elle arrive, pas au moment où l'on
  // s'étonnera qu'un client n'ait pas réagi à une alerte.
  //
  // ⚠️ Ne se déclenche QUE sur un réglage modifié dans la fenêtre. Un client qui a coupé il y a
  // trois mois et qui l'assume ne doit pas être signalé chaque matin — ce serait reproduire,
  // sur l'instrument de surveillance, le défaut qu'il surveille.
  private async notificationsCoupees(depuis: Date): Promise<ConstatSentinelle[]> {
    const reglages = await this.prisma.notificationPreference.findMany({
      where: { updatedAt: { gte: depuis } },
      select: { userId: true, pushEnabled: true, mutedTypes: true, mutedCategories: true, updatedAt: true },
    });
    const coupures = reglages.filter(
      (r) => !r.pushEnabled || (r.mutedTypes ?? []).length > 0 || (r.mutedCategories ?? []).length > 0,
    );
    if (coupures.length === 0) return [];

    const comptes = await this.prisma.user.findMany({
      where: { id: { in: coupures.map((c) => c.userId) }, isActive: true },
      select: { id: true, email: true, role: true },
    });
    if (comptes.length === 0) return [];
    const parCompte = new Map(comptes.map((c) => [c.id, c]));

    const decrits = coupures
      .filter((c) => parCompte.has(c.userId))
      .map((c) => {
        const compte = parCompte.get(c.userId)!;
        const quoi = !c.pushEnabled
          ? 'TOUT coupé'
          : [
              (c.mutedTypes ?? []).length > 0 ? `types : ${(c.mutedTypes ?? []).join(', ')}` : null,
              (c.mutedCategories ?? []).length > 0 ? `familles : ${(c.mutedCategories ?? []).join(', ')}` : null,
            ].filter(Boolean).join(' · ');
        return `${compte.email} (${quoi})`;
      });

    return [{
      cle: CLES_REFROIDISSEMENT.SENTINELLE_NOTIFICATIONS_COUPEES,
      source: 'sentinelles',
      niveau: 'ERROR' as NiveauErreur,
      message:
        `${decrits.length} compte(s) ont RÉDUIT leurs notifications dans les dernières 24 h : ${enumere(decrits)}. ` +
        `C'est le signal qu'on cherche à ne jamais voir : quelqu'un a jugé qu'on le dérangeait. Il ne recevra plus ` +
        `ce qu'il a coupé, y compris le jour où cela comptera. Comprendre ce qui l'a saturé, corriger le volume, ` +
        `puis lui proposer de rouvrir — dans cet ordre.`,
      contexte: { comptes: decrits.slice(0, 20), depuis: depuis.toISOString() },
      fenetreMs: REFROIDISSEMENT_QUOTIDIEN_MS,
    }];
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
