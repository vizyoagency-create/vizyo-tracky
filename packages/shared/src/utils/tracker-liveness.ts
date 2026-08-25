/**
 * Liveness d'un tracker basée sur la FRAÎCHEUR de son dernier signal.
 *
 * Pourquoi ce helper existe (Sprint 0.1) : la colonne `Tracker.status` en base
 * est COLLANTE — mise à `ONLINE` à la première trame ingérée, JAMAIS remise à
 * `OFFLINE` (aucun sweep côté serveur, invariant vérifié par grep). Elle ne
 * reflète donc pas l'état live : un tracker mort depuis des heures reste
 * `ONLINE`, et un tracker qui n'a jamais émis reste `OFFLINE` (défaut) même s'il
 * communique sans fix valide.
 *
 * Ce prédicat, calculé au read-time (non destructif, aucune écriture DB), donne
 * la seule définition fiable de « online maintenant » : le boîtier nous a parlé
 * récemment. C'est la source de vérité d'affichage partagée par l'admin
 * Trackers et la chip « actif » de la carte — cf. docs/sprint-0.1.
 */

/**
 * Seuil de fraîcheur (ms) au-delà duquel un tracker est considéré offline.
 *
 * 15 min : un véhicule à l'arrêt émet jusqu'à toutes les ~300 s (intervalle de
 * fix adaptatif maximal, cf. PositionSamplingService). 15 min tolère ~2 trames
 * manquées sans faux-offline, tout en détectant un vrai silence en moins d'un
 * quart d'heure. Ajustable sans changer la logique.
 */
export const TRACKER_ONLINE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Seuil (ms) au-delà duquel une dernière position GPS est considérée « périmée »
 * alors que le boîtier est vivant → état {@link VehicleConnectivityState} `GPS_LOST`.
 *
 * 30 min : tolère un tunnel / parking couvert transitoire (le fix revient) sans
 * flaguer, mais détecte une vraie perte de GPS prolongée. Couplé à `lastNoFixAt`
 * frais (le boîtier ÉMET mais sans lock) pour ne PAS confondre avec un simple
 * stationnement (un boîtier garé sain n'émet pas de `no_fix`).
 */
export const GPS_FIX_STALE_THRESHOLD_MS = 30 * 60 * 1000;

/** Normalise une date (Date | ISO | epoch ms | null) en ms epoch, ou null si invalide. */
function toEpochMs(value: Date | string | number | null | undefined): number | null {
  if (value == null) return null;
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Retourne `true` si le tracker a émis depuis moins de `thresholdMs`.
 *
 * @param lastSeenAt  dernier signal connu (`Date`, ISO string, epoch ms) ou null.
 * @param now         instant de référence en ms epoch. Défaut : `Date.now()`.
 * @param thresholdMs fenêtre de fraîcheur. Défaut : {@link TRACKER_ONLINE_THRESHOLD_MS}.
 */
export function isTrackerOnline(
  lastSeenAt: Date | string | number | null | undefined,
  now: number = Date.now(),
  thresholdMs: number = TRACKER_ONLINE_THRESHOLD_MS,
): boolean {
  if (lastSeenAt == null) return false;
  const ms =
    lastSeenAt instanceof Date
      ? lastSeenAt.getTime()
      : typeof lastSeenAt === 'number'
        ? lastSeenAt
        : new Date(lastSeenAt).getTime();
  if (!Number.isFinite(ms)) return false;
  // age < 0 (horloge boîtier dans le futur, skew GPRS) : on considère online —
  // le boîtier vient de parler, on ne le pénalise pas pour un décalage d'horloge.
  return now - ms <= thresholdMs;
}

/**
 * État de connectivité d'un véhicule vis-à-vis de l'application, vu côté UI.
 *
 * Tri-état dérivé (read-time, aucune écriture) qui répond à : « ce véhicule est-il
 * réellement suivi en ce moment ? ». Il distingue les deux causes de
 * non-suivi que l'exploitant doit traiter différemment :
 *  - `ONLINE`         : boîtier vivant, signal frais (< seuil) ET position GPS connue → suivi direct.
 *  - `AWAITING_GPS`   : boîtier vivant (signal frais) mais SANS aucune position GPS valide (jamais) →
 *                       connecté, pas encore de lock satellite (rapport LBS / démarrage à froid / antenne).
 *  - `GPS_LOST`       : boîtier vivant qui ÉMET encore (trames `no_fix` récentes) mais dont la
 *                       DERNIÈRE position GPS est PÉRIMÉE (> {@link GPS_FIX_STALE_THRESHOLD_MS}) →
 *                       il AVAIT un fix puis l'a perdu (antenne débranchée/masquée, ciel bouché).
 *                       Distinct d'`AWAITING_GPS` (jamais eu de fix) et de `PARKED` (garé sain, muet).
 *  - `PARKED`         : silencieux > seuil MAIS contact coupé à la dernière trame →
 *                       garé, boîtier en veille (silence NORMAL, pas une panne).
 *  - `OFFLINE`        : silencieux > seuil alors que le contact était ON (coupé en
 *                       roulant) ou ignition inconnue → débranché / vraie perte de signal.
 *  - `NOT_CONFIGURED` : aucun boîtier affecté, OU boîtier affecté qui n'a JAMAIS
 *                       émis → pas (encore) installé / mal configuré pour Tracky.
 */
export type VehicleConnectivityState =
  | 'ONLINE'
  | 'AWAITING_GPS'
  | 'GPS_LOST'
  | 'PARKED'
  | 'OFFLINE'
  | 'NOT_CONFIGURED';

export interface VehicleConnectivityInput {
  /** Présence d'un tracker affecté au véhicule. null/undefined = aucun tracker. */
  trackerId?: string | null;
  /** Dernier signal reçu du boîtier (trame TCP). Source de fraîcheur primaire. */
  lastSeenAt?: Date | string | number | null;
  /** Dernière position valide connue. Repli si `lastSeenAt` absent. */
  lastPositionAt?: Date | string | number | null;
  /**
   * Dernière trame `no_fix` (LBS sans lock GPS). Fournie explicitement (opt-in) par les
   * surfaces qui veulent distinguer `GPS_LOST` : un boîtier vivant qui émet des `no_fix`
   * FRAIS mais dont `lastPositionAt` est périmé a PERDU son GPS. Absente (undefined) →
   * l'appelant reste sur l'ancien comportement (jamais `GPS_LOST`).
   */
  lastNoFixAt?: Date | string | number | null;
  /**
   * Dernier état ignition connu. `false` (contact coupé) → un silence prolongé est
   * une mise en veille NORMALE du boîtier garé (→ PARKED), pas un débranchement.
   */
  lastIgnition?: boolean | null;
}

/**
 * Calcule le tri-état de connectivité. Réutilise {@link isTrackerOnline} (donc le
 * même seuil de 15 min) pour la définition d'« online maintenant ». Pur, non
 * destructif : c'est la source de vérité partagée par toutes les surfaces UI
 * (liste véhicules, carte, détail, rapports) pour marquer les véhicules « pas
 * dans l'app ».
 *
 * @param now         instant de référence ms epoch. Défaut : `Date.now()`.
 * @param thresholdMs fenêtre de fraîcheur. Défaut : {@link TRACKER_ONLINE_THRESHOLD_MS}.
 */
export function getVehicleConnectivityState(
  input: VehicleConnectivityInput,
  now: number = Date.now(),
  thresholdMs: number = TRACKER_ONLINE_THRESHOLD_MS,
  gpsFixStaleMs: number = GPS_FIX_STALE_THRESHOLD_MS,
): VehicleConnectivityState {
  const { trackerId, lastSeenAt, lastPositionAt, lastNoFixAt, lastIgnition } = input;
  // Aucun boîtier affecté → véhicule pas équipé pour Tracky.
  if (!trackerId) return 'NOT_CONFIGURED';
  // Le boîtier a parlé récemment → vivant.
  if (isTrackerOnline(lastSeenAt, now, thresholdMs)) {
    // …mais s'il n'a JAMAIS eu de position GPS valide, il est connecté sans lock
    // satellite (rapport LBS sans fix : intérieur / démarrage à froid / antenne). On le
    // distingue d'ONLINE pour montrer qu'il est vivant mais pas encore localisable —
    // sinon ces boîtiers restaient « non configurés », donc invisibles.
    //
    // `=== null` (et non `== null`) est VOLONTAIRE : l'état est opt-in. Un appelant qui
    // ne fournit pas `lastPositionAt` (undefined) reste ONLINE — seuls ceux qui passent
    // explicitement `lastPositionAt: … ?? null` (liste/détail) obtiennent AWAITING_GPS.
    if (lastPositionAt === null) return 'AWAITING_GPS';
    // GPS PERDU (incident FS-253) : le boîtier ÉMET encore activement des trames `no_fix`
    // RÉCENTES (il tente de reporter mais sans lock satellite) ALORS QUE sa dernière
    // position GPS est PÉRIMÉE (> gpsFixStaleMs). Il avait un fix puis l'a perdu →
    // antenne débranchée/masquée ou ciel bouché. `lastNoFixAt` est le discriminant qui
    // évite de flaguer une voiture simplement garée (garée saine = MUETTE, pas de no_fix).
    // Opt-in : sans `lastNoFixAt` fourni, on ne bascule jamais en GPS_LOST (compat).
    const noFixMs = toEpochMs(lastNoFixAt);
    const posMs = toEpochMs(lastPositionAt);
    if (
      noFixMs != null &&
      now - noFixMs <= thresholdMs &&
      posMs != null &&
      now - posMs > gpsFixStaleMs
    ) {
      return 'GPS_LOST';
    }
    return 'ONLINE';
  }
  // Boîtier affecté mais JAMAIS aucun signal ni position → affecté mais jamais
  // connecté (SIM/APN/provisioning KO). On le traite comme « non configuré »
  // plutôt que « hors-ligne » : il n'a jamais fonctionné, ce n'est pas un débranchement.
  if (lastSeenAt == null && lastPositionAt == null) return 'NOT_CONFIGURED';
  // Silencieux mais contact coupé à la dernière trame → garé, boîtier en veille
  // (le Coban dort quand l'ignition est OFF) : silence normal, pas une panne.
  if (lastIgnition === false) return 'PARKED';
  // Silencieux alors que le contact était ON (ou inconnu) → vraie perte de signal.
  return 'OFFLINE';
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * DORMANCE — « ce véhicule fait-il encore partie du parc EXPLOITÉ ? »
 *
 * ORTHOGONAL à `getVehicleConnectivityState`, qui répond à « est-il live
 * MAINTENANT ? » (15 min). Un véhicule `PARKED` depuis 2 h et un véhicule
 * `PARKED` depuis 89 jours produisent aujourd'hui le MÊME état : c'est
 * exactement le trou que ces prédicats comblent.
 *
 * Source unique : `Tracker.lastSeenAt`, jamais autre chose.
 *  - PAS `Trip`/`Position` : en mode vie privée les positions sont JETÉES alors
 *    que le boîtier parle — en dériver marquerait dormant tout véhicule sous RGPD.
 *  - PAS `Tracker.status` : colonne COLLANTE (cf. en-tête de ce fichier).
 *
 * Dérivé au read-time, aucune écriture, aucun champ en base, aucun drapeau à
 * maintenir : dès que le boîtier ré-émet, `lastSeenAt` redevient frais et le
 * véhicule réintègre tout automatiquement, en moins d'une minute.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Seuil « ARRÊTER D'AGIR » — automatisations, commandes boîtier, repli SMS.
 *
 * 72 h. Un boîtier alimenté émet au moins toutes les ~300 s MÊME à l'arrêt
 * (intervalle de fix adaptatif maximal). 72 h de silence total ≈ 860 trames
 * manquées : batterie débranchée, fusible, SIM coupée ou boîtier déposé —
 * jamais un simple stationnement. Au-delà, toute commande est une tentative
 * dont on connaît déjà l'issue.
 *
 * Le coût d'une exclusion à tort est NUL : l'action reprend au tick suivant la
 * première trame reçue.
 */
export const DORMANT_STOP_ACTING_MS = 72 * 60 * 60 * 1000;

/**
 * Seuil « ARRÊTER DE COMPTER » — KPI, dénominateurs, classements, viviers de
 * proposition (réservation, optimisation IA).
 *
 * 7 jours. Ici le coût d'une exclusion à tort est ÉLEVÉ (on retirerait un vrai
 * véhicule du parc affiché au client), donc on est plus prudent que pour
 * l'action. 7 j couvre tout stationnement légitime — week-end, pont férié, une
 * semaine d'atelier ou de congés.
 */
export const DORMANT_STOP_COUNTING_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fraîcheur exigée pour affirmer qu'un véhicule est EN MOUVEMENT.
 *
 * 5 min, volontairement plus serré que la liveness de 15 min : un véhicule qui
 * roule émet toutes les ~30 s, donc une trame de plus de 5 min ne prouve aucun
 * mouvement EN COURS. Déclaré ici pour que ce seuil cesse d'être réinventé
 * localement dans les services et les composants de carte.
 */
export const MOVING_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * ⚠️ Ces seuils sont des littéraux, PAS des `process.env`.
 *
 * Ce package est consommé par l'application Angular, où `process` n'existe pas :
 * un `process.env.X` au chargement du module ferait planter le démarrage du web.
 * Bénéfice collatéral : API et UI lisent forcément la MÊME valeur, donc un bouton
 * ne peut pas être actif pour une commande que le serveur refusera déjà.
 */

export interface VehicleDormancyInput {
  /** null/undefined = aucun boîtier affecté. */
  trackerId?: string | null;
  /** Dernier signal reçu CÔTÉ SERVEUR. Jamais l'horloge du boîtier. */
  lastSeenAt?: Date | string | number | null;
}

/**
 * Durée de silence en ms, ou null si la question n'a pas de sens (entrée absente
 * ou illisible). Un âge négatif (horloge boîtier en avance, skew GPRS) est ramené
 * à 0 — cohérent avec `isTrackerOnline`, et évite un libellé « il y a -3 j ».
 */
export function trackerSilenceMs(
  lastSeenAt: Date | string | number | null | undefined,
  now: number = Date.now(),
): number | null {
  const ms = toEpochMs(lastSeenAt);
  if (ms == null) return null;
  return Math.max(0, now - ms);
}

/**
 * DORMANT = « il parlait, puis il s'est tu ».
 *
 * Renvoie `false` sans boîtier ET `false` si le boîtier n'a JAMAIS émis : ce sont
 * des faits DIFFÉRENTS, déjà nommés `NOT_CONFIGURED` par le tri-état. Les
 * confondre exclurait à tort des véhicules non équipés que l'exploitant gère
 * légitimement (agenda, capacités, réservation).
 * Pour un DÉNOMINATEUR, utiliser plutôt {@link isVehicleExploited}, qui couvre les deux.
 */
export function isVehicleDormant(
  input: VehicleDormancyInput,
  now: number = Date.now(),
  thresholdMs: number = DORMANT_STOP_COUNTING_MS,
): boolean {
  if (!input.trackerId) return false;
  const silent = trackerSilenceMs(input.lastSeenAt, now);
  if (silent == null) return false;
  return silent > thresholdMs;
}

/**
 * EXPLOITÉ = « il a un boîtier, ce boîtier a déjà parlé, et il a parlé récemment ».
 *
 * LE prédicat des dénominateurs : un seul appel écarte à la fois les non équipés
 * et les dormants. Ce n'est PAS la négation d'`isVehicleDormant` — un véhicule
 * sans boîtier n'est ni dormant, ni exploité.
 */
export function isVehicleExploited(
  input: VehicleDormancyInput,
  now: number = Date.now(),
  thresholdMs: number = DORMANT_STOP_COUNTING_MS,
): boolean {
  if (!input.trackerId) return false;
  const silent = trackerSilenceMs(input.lastSeenAt, now);
  if (silent == null) return false;
  return silent <= thresholdMs;
}

/**
 * Libellé d'ancienneté en français — source unique pour l'API (alertes, e-mails,
 * diagnostics) et l'UI. Paliers : minutes sous 2 h, heures sous 48 h, puis jours.
 * C'est ce qui rend lisible un « muet depuis 128160 min ».
 */
export function formatSilenceLabel(
  lastSeenAt: Date | string | number | null | undefined,
  now: number = Date.now(),
): string | null {
  const ms = trackerSilenceMs(lastSeenAt, now);
  if (ms == null) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 120) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} j`;
}

/**
 * État de présence = tri-état de connectivité ÉLARGI d'un cran `DORMANT`.
 *
 * ⚠️ Type SÉPARÉ, et non une extension de `VehicleConnectivityState` : plusieurs
 * consommateurs UI écrivent `case 'NOT_CONFIGURED': default:`. Ajouter `DORMANT`
 * à l'union existante leur ferait rendre « Non configuré » en silence, SANS la
 * moindre erreur de compilation pour le signaler.
 */
export type VehiclePresenceState = VehicleConnectivityState | 'DORMANT' | 'PRESUMED_PARKED';

/**
 * TRK-046 — « considéré stationné » : hors champ GPS (GPS_LOST, ou silence prolongé) avec la
 * dernière position dans un parking VALIDÉ. L'état n'est PAS calculé ici : la qualification
 * du lieu vit côté serveur (zones par véhicule) et arrive par les DTO (`presumedParkedZone`).
 * Les surfaces UI SUBSTITUENT alors cet état au tri-état calculé — même philosophie opt-in
 * que `lastNoFixAt` : un appelant qui l'ignore garde le comportement d'aujourd'hui.
 */
export function overlayPresumedParked(
  base: VehiclePresenceState,
  presumedParkedZone: string | null | undefined,
): VehiclePresenceState {
  if (!presumedParkedZone) return base;
  // La présomption ne maquille JAMAIS un état plus grave qu'une perte de champ : un véhicule
  // dormant (muet > 7 j) ou jamais configuré reste affiché tel quel.
  if (base === 'GPS_LOST' || base === 'OFFLINE' || base === 'PARKED' || base === 'ONLINE') {
    return 'PRESUMED_PARKED';
  }
  return base;
}

/**
 * Compose la dormance avec le tri-état existant — qui n'est PAS remplacé.
 *
 * `DORMANT` prime sur `PARKED` et `OFFLINE`. Il ne peut mathématiquement pas
 * entrer en concurrence avec `ONLINE`/`AWAITING_GPS`/`GPS_LOST`, qui exigent tous
 * un `lastSeenAt` de moins de 15 min. `NOT_CONFIGURED` est préservé tel quel :
 * « jamais connecté » n'est pas « s'est tu ».
 */
export function getVehiclePresenceState(
  input: VehicleConnectivityInput,
  now: number = Date.now(),
  dormantMs: number = DORMANT_STOP_COUNTING_MS,
): VehiclePresenceState {
  const base = getVehicleConnectivityState(input, now);
  if (base === 'NOT_CONFIGURED') return base;
  if (isVehicleDormant(input, now, dormantMs)) return 'DORMANT';
  return base;
}

/**
 * Fenêtre « installation récente » : un boîtier ajouté il y a moins d'1 mois est
 * encore en période de rodage. Au-delà, une déconnexion n'est plus imputée à la pose.
 */
export const INSTALLATION_REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * « Installation à revoir » : un boîtier installé depuis MOINS d'un mois, qui a
 * déjà communiqué (état OFFLINE = a émis puis devenu silencieux), mais qui est
 * actuellement hors-ligne → pose probablement bâclée, à revoir au plus vite.
 *
 * On ne flague PAS :
 *  - les `NOT_CONFIGURED` (jamais connectés — autre problème, pas une déconnexion) ;
 *  - les `ONLINE` ;
 *  - les installations de plus d'un mois (déconnexion = usure/externe, pas la pose).
 *
 * @param state             tri-état déjà calculé via {@link getVehicleConnectivityState}.
 * @param trackerCreatedAt  date d'ajout du tracker (proxy de date d'installation).
 */
export function isInstallationToReview(
  state: VehicleConnectivityState,
  trackerCreatedAt: Date | string | number | null | undefined,
  now: number = Date.now(),
  windowMs: number = INSTALLATION_REVIEW_WINDOW_MS,
): boolean {
  if (state !== 'OFFLINE') return false;
  if (trackerCreatedAt == null) return false;
  const ms =
    trackerCreatedAt instanceof Date
      ? trackerCreatedAt.getTime()
      : typeof trackerCreatedAt === 'number'
        ? trackerCreatedAt
        : new Date(trackerCreatedAt).getTime();
  if (!Number.isFinite(ms)) return false;
  // Installé il y a moins de `windowMs` → période où une déconnexion = pose suspecte.
  return now - ms <= windowMs;
}
