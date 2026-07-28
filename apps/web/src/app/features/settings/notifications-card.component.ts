import { Component, computed, inject, type OnInit, signal } from '@angular/core';
import type {
  AlertSeverity,
  AlertType,
  NotificationPreferenceDto,
  UpdateNotificationPreferenceDto,
} from '@vizyo/tracky-shared';
// `shouldPushAlert` vient du contrat PARTAGE : c'est la fonction que le serveur applique
// pour decider d'un envoi. La reimplementer ici ferait diverger l'ecran de la realite au
// premier changement de regle — et cet ecran n'a qu'un seul travail, dire la verite.
import { DEFAULT_MUTED_TYPES, PUSH_MAX_PER_HOUR, shouldPushAlert } from '@vizyo/tracky-shared';
import {
  AlertTriangle,
  Bell,
  BellOff,
  BellRing,
  Check,
  ChevronDown,
  Info,
  LucideAngularModule,
  Send,
  Smartphone,
  Trash2,
} from 'lucide-angular';
import { AuthService } from '../../core/services/auth.service';
import { NotificationsApiService, type PushSubscriptionDto } from '../../core/services/notifications.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/* ════════════════════════════════════════════════════════════════════════════
   LOGIQUE PURE — testee sans DOM (notifications-card.component.spec.ts).
   Volontairement hors de la classe : c'est cette derivation qui decide ce que
   l'utilisateur comprend de sa situation, elle merite un test, pas un clic.
   ════════════════════════════════════════════════════════════════════════════ */

/* ─── Frequences observees ─────────────────────────────────────────────────────
   Sans ordre de grandeur affiche, cet ecran est un PIEGE : activer « Exces de
   vitesse » ressemble a activer « SOS », alors que l'un vaut 164 notifications par
   jour et l'autre trois par an. On affiche donc, pour CHAQUE type, ce qu'il coute
   reellement — avant le clic, pas apres.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Provenance des chiffres ci-dessous, affichee a l'ecran.
 *
 * ⚠️ Ce sont des ORDRES DE GRANDEUR DATES, comptes en base de PRODUCTION le 2026-07-27
 * sur les 30 jours precedents, pour l'ENSEMBLE du parc — pas une statistique recalculee
 * en direct. Ils vieilliront : le jour ou le parc double, ou ou la trame `ac alarm` des
 * boitiers Coban est corrigee (elle est a elle seule la source des 330 POWER_CUT
 * quotidiens), il faut REMESURER et remettre a jour cette constante avec les valeurs.
 * Un chiffre faux ici trompe l'utilisateur avec l'autorite d'une mesure : mieux vaut
 * une date visible qu'une precision inventee.
 */
export const FREQUENCY_SNAPSHOT_LABEL = 'relevé du 27/07/2026, 30 jours, tout le parc';

/** `measured` = compte non nul releve ce jour-la ; `none-observed` = zero sur la periode. */
export type FrequencyBasis = 'measured' | 'none-observed';

export interface AlertFrequency {
  /** Evenements par jour pour tout le parc. 0 avec `none-observed` = jamais vu. */
  perDay: number;
  basis: FrequencyBasis;
}

/** Compte releve sur 30 jours -> evenements par jour. */
function per30Days(count: number): AlertFrequency {
  return { perDay: count / 30, basis: 'measured' };
}

/** Type jamais observe sur la periode mesuree. Ce n'est pas « impossible », c'est « rien vu ». */
const NEVER_OBSERVED: AlertFrequency = { perDay: 0, basis: 'none-observed' };

/**
 * Phrase courte affichee sous chaque type. Volontairement sans decimale : « 0,47 par
 * jour » n'aide personne a decider, « environ 3 par semaine » si.
 */
export function frequencyLabel(f: AlertFrequency): string {
  if (f.basis === 'none-observed') return 'aucune en 30 jours';
  if (f.perDay >= 1) return `≈ ${Math.round(f.perDay)} / jour`;
  if (f.perDay >= 1 / 7) return `≈ ${Math.round(f.perDay * 7)} / semaine`;
  if (f.perDay >= 1 / 60) return `≈ ${Math.round(f.perDay * 30)} / mois`;
  return 'exceptionnelle (quelques-unes par an)';
}

/** Volume attendu, formule pour une phrase (« vous recevrez … »). */
export function dailyVolumeLabel(perDay: number): string {
  if (perDay >= 1) return `environ ${Math.round(perDay)} notification${Math.round(perDay) > 1 ? 's' : ''} par jour`;
  if (perDay >= 1 / 7) {
    // Accord au singulier obligatoire : la borne basse de cette branche (1/7 par jour)
    // s'arrondit a « 1 par semaine ». Un « environ 1 notifications » suffirait a faire
    // douter de la fiabilite du chiffre juste a cote, sur l'ecran dont le seul travail
    // est d'etre credible.
    const perWeek = Math.round(perDay * 7);
    return `environ ${perWeek} notification${perWeek > 1 ? 's' : ''} par semaine`;
  }
  if (perDay > 0) return 'moins d\'une notification par semaine';
  return 'aucune notification, au rythme observé';
}

/** Un type d'alerte tel qu'il est presente a l'utilisateur — jamais l'identifiant brut. */
export interface AlertTypeOption {
  type: AlertType;
  label: string;
  /**
   * Severite que l'API pose sur ce type AUJOURD'HUI (apps/api/src/alerts/alert-mapping.ts,
   * plus les producteurs dedies : `geofences.service`, `alerts.service#createGpsLostAlert`,
   * `alerts.service` pour SURVEILLANCE_TRIGGERED).
   *
   * ⚠️ Elle ne sert QU'A PREDIRE ce qui passera le seuil de gravite. C'est le serveur qui
   * decide de l'envoi : une divergence fausserait la prevision affichee, jamais la
   * livraison. Raison de plus pour ne rien promettre de plus qu'un ordre de grandeur.
   */
  severity: AlertSeverity;
  frequency: AlertFrequency;
  /**
   * Pourquoi ce type est bruyant. Affiche en permanence, allume ou coupe : coupe, il
   * justifie la coupure ; allume, il rappelle ce que l'utilisateur vient de s'infliger.
   */
  noiseNote?: string;
}

export interface AlertTypeGroup {
  key: string;
  label: string;
  /** Une phrase, pas un slogan : elle sert a decider si on coupe le groupe entier. */
  hint: string;
  types: AlertTypeOption[];
}

/**
 * Regroupement des 22 types d'alerte en 4 familles.
 *
 * Pourquoi grouper : une liste plate de 22 interrupteurs sur un ecran de telephone est
 * illisible, et l'utilisateur ne reconnait pas `HARSH_BRAKING` ni `MOVEMENT_IDLE`. Les
 * familles suivent la question qu'il se pose reellement (« est-ce grave ? », « est-ce du
 * comportement de conduite ? »), pas l'ordre de l'enum Prisma.
 *
 * `UNKNOWN` est volontairement absent : c'est le repli de typage pour une alerte dont le
 * type n'est pas reconnu, pas une categorie qu'on propose de couper.
 */
export const ALERT_TYPE_GROUPS: readonly AlertTypeGroup[] = [
  {
    key: 'safety',
    label: 'Sécurité & urgence',
    hint: 'Ce qui justifie de sortir le téléphone de sa poche. Presque tout y est exceptionnel — sauf « alimentation coupée ».',
    types: [
      // 3 relevés sur 30 jours, lus comme « quelques-uns par an » : le type qui compte
      // le plus est aussi le plus rare. Aucun plafond ne le retiendra jamais.
      { type: 'SOS', label: 'Appel de détresse (SOS)', severity: 'critical', frequency: { perDay: 3 / 365, basis: 'measured' } },
      { type: 'ACCIDENT', label: 'Accident détecté', severity: 'critical', frequency: NEVER_OBSERVED },
      { type: 'COLLISION', label: 'Choc / collision', severity: 'critical', frequency: NEVER_OBSERVED },
      {
        type: 'POWER_CUT',
        label: 'Alimentation coupée',
        severity: 'critical',
        // 9 903 en 30 jours. Le type le plus bruyant du parc, et pourtant classé CRITICAL :
        // c'est la démonstration que la gravité seule ne trie rien.
        frequency: per30Days(9903),
        noiseNote:
          'Sur un boîtier câblé après contact, le boîtier signale « alimentation coupée » à chaque arrêt du moteur : du stationnement normal, envoyé comme une alarme critique.',
      },
      { type: 'TOW', label: 'Remorquage / déplacement suspect', severity: 'critical', frequency: NEVER_OBSERVED },
      { type: 'TAMPER', label: 'Boîtier manipulé', severity: 'critical', frequency: NEVER_OBSERVED },
      { type: 'ILLEGAL_IGNITION', label: 'Démarrage non autorisé', severity: 'critical', frequency: NEVER_OBSERVED },
    ],
  },
  {
    key: 'driving',
    label: 'Conduite',
    hint: 'Le comportement au volant. C\'est la famille la plus bavarde.',
    types: [
      {
        type: 'OVERSPEED',
        label: 'Excès de vitesse',
        severity: 'warning',
        // 4 933 en 30 jours : la deuxième source de bruit, et de loin.
        frequency: per30Days(4933),
        noiseNote:
          'Une notification toutes les neuf minutes en moyenne. Le suivi des excès reste consultable dans les rapports et le centre d\'alertes, sans faire vibrer le téléphone.',
      },
      // Les trois « brusques » n'ont produit AUCUNE alerte sur la période mesurée : soit
      // les boîtiers ne remontent pas ces trames, soit le seuil ne se déclenche pas. Leur
      // volume réel est donc INCONNU — d'où leur classement INFO, sous le seuil par défaut.
      { type: 'HARSH_BRAKING', label: 'Freinage brusque', severity: 'info', frequency: NEVER_OBSERVED },
      { type: 'HARSH_ACCELERATION', label: 'Accélération brusque', severity: 'info', frequency: NEVER_OBSERVED },
      { type: 'HARSH_TURN', label: 'Virage brusque', severity: 'info', frequency: NEVER_OBSERVED },
      { type: 'FATIGUE', label: 'Conduite prolongée (fatigue)', severity: 'warning', frequency: NEVER_OBSERVED },
    ],
  },
  {
    key: 'zones',
    label: 'Zones & mouvements',
    hint: 'Où va le véhicule, et quand il bouge sans raison.',
    types: [
      // 54 alertes de zone en 30 jours, ENTRÉES et SORTIES confondues (le relevé ne les
      // distinguait pas) : on répartit à parts égales, faute de mieux. C'est justement
      // pourquoi ces chiffres sont annoncés comme des ordres de grandeur.
      { type: 'GEOFENCE_ENTER', label: 'Entrée dans une zone', severity: 'warning', frequency: per30Days(27) },
      { type: 'GEOFENCE_EXIT', label: 'Sortie de zone', severity: 'warning', frequency: per30Days(27) },
      { type: 'MOVEMENT_IDLE', label: 'Mouvement moteur éteint', severity: 'warning', frequency: NEVER_OBSERVED },
      { type: 'IDLE_TIME', label: 'Arrêt prolongé', severity: 'info', frequency: NEVER_OBSERVED },
      { type: 'SURVEILLANCE_TRIGGERED', label: 'Surveillance déclenchée', severity: 'critical', frequency: NEVER_OBSERVED },
      { type: 'VIBRATION', label: 'Vibration détectée', severity: 'info', frequency: NEVER_OBSERVED },
    ],
  },
  {
    key: 'device',
    label: 'Véhicule & matériel',
    hint: 'L\'état du véhicule et du boîtier. Rare, et c\'est ce qui la rend utile.',
    types: [
      // 4 relevées, lues comme « quelques-unes par an ». C'est l'une des deux alertes que
      // l'utilisateur veut pouvoir vérifier — et elle est WARNING, donc invisible sous un
      // seuil « critiques uniquement ». D'où le défaut serveur calé sur `warning`.
      { type: 'LOW_BATTERY', label: 'Batterie faible', severity: 'warning', frequency: { perDay: 4 / 365, basis: 'measured' } },
      // 14 en 30 jours. Producteur réel : le cron d'intégrité GPS, qui pose WARNING (le
      // mapping Coban historique dit INFO, mais il n'alimente plus ce type en pratique).
      { type: 'GPS_LOST', label: 'Signal GPS perdu', severity: 'warning', frequency: per30Days(14) },
      { type: 'BONNET', label: 'Capot ouvert', severity: 'warning', frequency: NEVER_OBSERVED },
      { type: 'DOOR', label: 'Portière ouverte', severity: 'warning', frequency: NEVER_OBSERVED },
      // Aucun producteur côté serveur à ce jour : le type existe dans l'enum, rien ne
      // l'émet encore. La gravité annoncée est donc une intention, pas une observation.
      { type: 'MAINTENANCE_DUE', label: 'Entretien à échéance', severity: 'warning', frequency: NEVER_OBSERVED },
    ],
  },
];

/** Les seuls champs de préférence dont dépend l'affichage — le reste (`eligible`…) est ailleurs. */
export type PushPreferenceCore = Pick<
  NotificationPreferenceDto,
  'pushEnabled' | 'minSeverity' | 'mutedTypes'
>;

/** Ce type est-il coupé par le DÉFAUT serveur (et non par un choix de l'utilisateur) ? */
export function isMutedByDefault(type: AlertType): boolean {
  return DEFAULT_MUTED_TYPES.includes(type);
}

export interface AlertTypeItemView extends AlertTypeOption {
  /** L'interrupteur est-il allumé (= type absent de `mutedTypes`) ? */
  enabled: boolean;
  /** Coupé par le défaut serveur : l'écran doit dire QUI a coupé, et pourquoi. */
  mutedByDefault: boolean;
  /**
   * Ce type produira-t-il RÉELLEMENT une notification ? Décidé par `shouldPushAlert`, la
   * fonction que le serveur applique lui-même — jamais par une règle réécrite ici.
   */
  willReceive: boolean;
  /**
   * Interrupteur allumé mais rien ne partira, parce que la gravité du type est sous le
   * seuil choisi. C'est LE piège silencieux de cet écran : sans cette mention, l'utilisateur
   * active « batterie faible », ne reçoit rien, et conclut que la fonction est cassée.
   */
  blockedBySeverity: boolean;
  frequencyText: string;
}

export interface AlertTypeGroupView extends AlertTypeGroup {
  /** Types du groupe encore actifs (non coupés). */
  activeCount: number;
  total: number;
  /** Vrai si TOUT le groupe est coupé — l'en-tête doit le dire sans avoir à déplier. */
  allMuted: boolean;
  /** Types du groupe qui passeront vraiment les réglages courants (≤ activeCount). */
  receivedCount: number;
  /** Volume quotidien attendu pour ce groupe, réglages courants appliqués. */
  perDay: number;
  /** Volume du groupe, prêt à afficher dans l'en-tête replié. */
  volumeText: string;
  /** Etat par type, prêt pour le template (pas de `.includes()` dans le HTML). */
  items: AlertTypeItemView[];
}

/**
 * Projette les groupes + les réglages courants en une vue affichable.
 *
 * `pref.mutedTypes` est la liste des types EXPLICITEMENT coupés : tout type absent est
 * actif. « Actif » ne veut pas dire « reçu » — d'où `willReceive`, calculé avec la règle
 * du contrat partagé.
 */
export function buildGroupViews(
  groups: readonly AlertTypeGroup[],
  pref: PushPreferenceCore,
): AlertTypeGroupView[] {
  const muted = new Set(pref.mutedTypes);
  return groups.map((g) => {
    const items: AlertTypeItemView[] = g.types.map((t) => {
      const enabled = !muted.has(t.type);
      const willReceive = shouldPushAlert(pref, { type: t.type, severity: t.severity });
      return {
        ...t,
        enabled,
        mutedByDefault: isMutedByDefault(t.type),
        willReceive,
        // On ne parle du seuil que si c'est bien LUI qui bloque : un type coupé à la main
        // est déjà expliqué par son interrupteur, et l'interrupteur maître par son bandeau.
        blockedBySeverity: enabled && pref.pushEnabled && !willReceive,
        frequencyText: frequencyLabel(t.frequency),
      };
    });
    const activeCount = items.filter((i) => i.enabled).length;
    const received = items.filter((i) => i.willReceive);
    const perDay = received.reduce((sum, i) => sum + i.frequency.perDay, 0);
    return {
      ...g,
      items,
      activeCount,
      total: items.length,
      allMuted: activeCount === 0,
      receivedCount: received.length,
      perDay,
      volumeText: dailyVolumeLabel(perDay),
    };
  });
}

/* ─── Ce qui sera REELLEMENT recu ──────────────────────────────────────────────
   L'incident d'origine, c'est un ecran qui affirmait « actif » pendant que rien ne
   partait. La reciproque est tout aussi trompeuse : un ecran plein d'interrupteurs
   allumes qui laisse croire a une avalanche, ou qui la cache. On calcule donc la
   consequence des reglages, avec la MEME fonction que le serveur.
   ──────────────────────────────────────────────────────────────────────────── */

export interface DeliveryForecast {
  /** Types qui passent réellement les réglages. */
  keptCount: number;
  total: number;
  /** Volume quotidien attendu, tous types retenus confondus. */
  perDay: number;
  volumeText: string;
  /** Les types retenus les plus bavards (3 max) : dit d'où vient le volume. */
  loudest: string[];
  /** Types allumés que le seuil de gravité retient malgré tout. */
  blockedBySeverity: string[];
  /** Vrai quand le plafond horaire deviendra le vrai limiteur. */
  hitsHourlyCap: boolean;
  tone: 'ineligible' | 'off' | 'silent' | 'quiet' | 'busy' | 'flood';
}

/**
 * @param eligible Le push est-il OUVERT au rôle de cet utilisateur (`PUSH_ROLLOUT`) ?
 *
 * ⚠️ Ce paramètre existe pour une raison précise, et c'est la plus importante de cet écran.
 * En production, `PUSH_ROLLOUT=SUPER_ADMIN_ONLY` : pour tout compte qui n'est pas
 * super-admin, le serveur écarte l'envoi AVANT même de lire les préférences (motif
 * `rollout`). Un encadré « vous recevrez environ 2 notifications par jour » affiché à ces
 * comptes rejouerait mot pour mot le bug d'origine — un écran qui affirme pendant que rien
 * ne part. Le récapitulatif doit donc annoncer le périmètre AVANT tout le reste, y compris
 * avant l'interrupteur maître : c'est la cause qui rend les autres sans objet, et la seule
 * sur laquelle l'utilisateur ne peut rien.
 *
 * `keptCount` / `perDay` restent calculés dans ce cas : ils décrivent le FILTRE (ce que ces
 * réglages laisseraient passer à l'ouverture), pas une livraison promise. C'est le `tone`
 * qui distingue les deux, et la phrase qui le dit.
 */
export function buildDeliveryForecast(
  groups: readonly AlertTypeGroup[],
  pref: PushPreferenceCore,
  eligible = true,
): DeliveryForecast {
  const items = buildGroupViews(groups, pref).flatMap((g) => g.items);
  const kept = items.filter((i) => i.willReceive);
  const perDay = kept.reduce((sum, i) => sum + i.frequency.perDay, 0);

  const loudest = [...kept]
    .filter((i) => i.frequency.perDay > 0)
    .sort((a, b) => b.frequency.perDay - a.frequency.perDay)
    .slice(0, 3)
    .map((i) => i.label);

  const tone: DeliveryForecast['tone'] = !eligible
    ? 'ineligible'
    : !pref.pushEnabled
      ? 'off'
      : kept.length === 0
        ? 'silent'
        : perDay < 5
          ? 'quiet'
          : perDay < 50
            ? 'busy'
            : 'flood';

  return {
    keptCount: kept.length,
    total: items.length,
    perDay,
    volumeText: dailyVolumeLabel(perDay),
    loudest,
    blockedBySeverity: items.filter((i) => i.blockedBySeverity).map((i) => i.label),
    // Comparaison volontairement au volume QUOTIDIEN et non horaire : les alertes
    // n'arrivent pas de façon régulière (les excès de vitesse tombent en rafale sur un
    // trajet). Dès qu'on dépasse une douzaine par jour, le plafond horaire mordra sur
    // au moins une heure de la journée.
    // Hors périmètre, rien n'atteint jamais le plafond : annoncer un écrêtage serait
    // décrire un mécanisme qui ne s'appliquera pas.
    hitsHourlyCap: eligible && pref.pushEnabled && perDay >= PUSH_MAX_PER_HOUR,
    tone,
  };
}

/** Phrase principale du récapitulatif : ce qui arrivera, en français, sans jargon. */
export function forecastSentence(f: DeliveryForecast): string {
  // Le périmètre de déploiement d'abord : c'est le seul cas où l'utilisateur ne peut
  // RIEN changer depuis cet écran. Lui annoncer un volume qu'il ne recevra pas serait
  // exactement la promesse creuse qu'on est en train de réparer.
  if (f.tone === 'ineligible') {
    return 'Rien ne partira pour l\'instant : le push n\'est pas encore ouvert à votre rôle. Les réglages ci-dessous sont enregistrés et s\'appliqueront tels quels à l\'ouverture.';
  }
  if (f.tone === 'off') {
    return 'Rien ne partira : l\'interrupteur « Recevoir les notifications » est coupé.';
  }
  if (f.tone === 'silent') {
    return 'Aucun type d\'alerte ne passe vos réglages actuels : vous ne recevrez aucune notification.';
  }
  return `${f.keptCount} type${f.keptCount > 1 ? 's' : ''} d'alerte sur ${f.total} vous seront notifiés, soit ${f.volumeText} au rythme observé.`;
}

/**
 * Énumère quelques libellés sans transformer la phrase en liste de courses : au-delà de
 * `max`, on compte le reste. Une note de dix-huit noms n'est plus lue, donc plus utile —
 * le détail reste visible ligne par ligne, à côté de chaque interrupteur.
 */
function joinLabels(labels: readonly string[], max: number): string {
  if (labels.length <= max) return labels.join(', ');
  const rest = labels.length - max;
  return `${labels.slice(0, max).join(', ')} et ${rest} autre${rest > 1 ? 's' : ''}`;
}

/**
 * Précisions à afficher SOUS la phrase principale, dans l'ordre d'utilité.
 *
 * La première est la plus importante : elle nomme les types que l'utilisateur croit avoir
 * activés et qui ne partiront pas. C'est exactement le scénario « je teste la batterie
 * faible et je ne reçois rien » qu'on cherche à rendre impossible.
 */
export function forecastNotes(f: DeliveryForecast): string[] {
  // Deux cas sans aucune précision utile : le maître coupé et le rôle hors périmètre.
  // Détailler « tel type est retenu par le seuil » alors qu'AUCUN type ne part de toute
  // façon désignerait un coupable secondaire et enverrait l'utilisateur régler ce qui
  // n'est pas le problème.
  if (f.tone === 'off' || f.tone === 'ineligible') return [];
  const notes: string[] = [];

  if (f.blockedBySeverity.length === 1) {
    notes.push(
      `« ${f.blockedBySeverity[0]} » est activé mais retenu par le seuil de gravité : abaissez le seuil ci-dessus pour le recevoir.`,
    );
  } else if (f.blockedBySeverity.length > 1) {
    notes.push(
      `${f.blockedBySeverity.length} types sont activés mais retenus par le seuil de gravité (${joinLabels(f.blockedBySeverity, 3)}). Abaissez le seuil ci-dessus pour les recevoir.`,
    );
  }
  if (f.loudest.length > 0 && f.perDay >= 5) {
    notes.push(`L'essentiel du volume vient de : ${f.loudest.join(', ')}.`);
  }
  if (f.hitsHourlyCap) {
    notes.push(
      `À ce rythme, le plafond de ${PUSH_MAX_PER_HOUR} notifications par heure en retiendra une partie. Rien n'est perdu : les alertes restent dans le centre d'alertes.`,
    );
  }
  return notes;
}

/**
 * Ajoute/retire un type de la liste des coupés, sans doublon et sans mutation.
 * `enabled = true` signifie « je veux recevoir ce type » donc on le RETIRE des coupés.
 */
export function toggleMutedType(
  mutedTypes: readonly AlertType[],
  type: AlertType,
  enabled: boolean,
): AlertType[] {
  if (enabled) return mutedTypes.filter((t) => t !== type);
  return mutedTypes.includes(type) ? [...mutedTypes] : [...mutedTypes, type];
}

/** Coupe (ou rallume) un groupe entier d'un seul geste. */
export function setGroupMuted(
  mutedTypes: readonly AlertType[],
  group: AlertTypeGroup,
  enabled: boolean,
): AlertType[] {
  return group.types.reduce<AlertType[]>(
    (acc, t) => toggleMutedType(acc, t.type, enabled),
    [...mutedTypes],
  );
}

export type PushBanner =
  /** Le navigateur ne peut pas recevoir de push (souvent : iOS Safari non installé). */
  | 'unsupported'
  /** VAPID absent côté serveur : demander la permission ne servirait à rien. */
  | 'server-off'
  /** L'utilisateur a refusé — un bouton « Activer » ne peut plus rien y faire. */
  | 'denied'
  /** Tout est possible, il reste à s'abonner sur CET appareil. */
  | 'not-subscribed'
  /** Cet appareil est abonné. */
  | 'active';

export interface PushDeviceState {
  banner: PushBanner;
  /** Vrai seulement si un bouton « Activer » a une chance d'aboutir. */
  canSubscribe: boolean;
  /** Cas iOS Safari non installé : le seul remède est « Ajouter à l'écran d'accueil ». */
  iosNeedsInstall: boolean;
}

/**
 * Décide ce qu'on montre pour l'appareil courant.
 *
 * L'ordre des cas n'est pas arbitraire : on affiche d'abord la cause qui rend les autres
 * sans objet. Proposer « Activer » à quelqu'un sur iOS Safari non installé produit un
 * échec silencieux — c'est précisément la cause classique de « ça ne marche pas ».
 */
export function derivePushDeviceState(input: {
  supported: boolean;
  /** `null` = statut serveur pas encore connu : on n'accuse pas le serveur trop tôt. */
  serverEnabled: boolean | null;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  isIOS: boolean;
  isStandalone: boolean;
}): PushDeviceState {
  const iosNeedsInstall = input.isIOS && !input.isStandalone;
  if (!input.supported) {
    return { banner: 'unsupported', canSubscribe: false, iosNeedsInstall };
  }
  if (input.serverEnabled === false) {
    return { banner: 'server-off', canSubscribe: false, iosNeedsInstall: false };
  }
  if (input.permission === 'denied') {
    return { banner: 'denied', canSubscribe: false, iosNeedsInstall: false };
  }
  if (!input.subscribed) {
    return { banner: 'not-subscribed', canSubscribe: true, iosNeedsInstall: false };
  }
  return { banner: 'active', canSubscribe: false, iosNeedsInstall: false };
}

/**
 * Reconnaît l'appareil courant dans la liste des abonnements.
 *
 * L'API tronque volontairement l'endpoint (il contient un secret) et le suffixe par
 * « ... ». On compare donc sur le préfixe. Sert à marquer « cet appareil » et surtout à
 * savoir qu'une révocation doit aussi désabonner LOCALEMENT — sinon l'écran affiche
 * « actif » alors que le serveur a oublié l'abonnement.
 */
export function isCurrentDeviceEndpoint(
  truncatedEndpoint: string | null | undefined,
  currentEndpoint: string | null | undefined,
): boolean {
  if (!truncatedEndpoint || !currentEndpoint) return false;
  const prefix = truncatedEndpoint.endsWith('...')
    ? truncatedEndpoint.slice(0, -3)
    : truncatedEndpoint;
  // Un préfixe trop court matcherait n'importe quel endpoint du même service push
  // (tous les endpoints FCM commencent pareil) : on exige une longueur significative.
  if (prefix.length < 30) return false;
  return currentEndpoint.startsWith(prefix);
}

/**
 * Ne garde que les abonnements de l'utilisateur COURANT.
 *
 * Le signal `devices` du service est partagé : l'écran Observabilité le remplit parfois
 * avec `scope=all`, c'est-à-dire les appareils de TOUS les comptes, clients compris. Tant
 * que le chargement `mine` de cette carte n'a pas répondu, la liste ci-dessous afficherait
 * donc les appareils d'autres personnes — avec un bouton « Révoquer » à côté, que le
 * backend accepte pour un SUPER_ADMIN. Un aller-retour lent suffit à ouvrir la fenêtre de
 * tir : on filtre ici, le drapeau `isMine` venant du serveur.
 */
export function ownDevices(devices: readonly PushSubscriptionDto[]): PushSubscriptionDto[] {
  return devices.filter((d) => d.isMine);
}

/**
 * Phrase affichée quand CET appareil est abonné : elle doit dire ce qui va réellement
 * arriver, pas ce que l'abonnement rend théoriquement possible.
 *
 * Le bug qu'on répare est né d'un écran qui affirmait « c'est actif » pendant que rien ne
 * partait. Un abonnement valide ne suffit pas : l'interrupteur maître peut être coupé, et
 * le rôle peut ne pas être dans le périmètre de déploiement en cours (`eligible=false`).
 * Dans ces deux cas, promettre une livraison serait rejouer exactement la même erreur.
 *
 * `preferencesUnavailable` est traité à part : le repli local porte `eligible: false` faute
 * d'avoir pu vérifier — ce n'est pas un verdict, et l'annoncer comme tel accuserait à tort
 * le déploiement. Le bandeau « réglages non chargés » dit déjà le nécessaire.
 */
export function activeDeliveryHint(
  pref: Pick<NotificationPreferenceDto, 'pushEnabled' | 'eligible'> | null,
  preferencesUnavailable: boolean,
): string {
  const nominal = 'Les alertes retenues ci-dessous arriveront ici.';
  if (!pref || preferencesUnavailable) return nominal;
  if (!pref.eligible) {
    return 'L\'abonnement est bien enregistré, mais le push n\'est pas encore ouvert à votre rôle : rien n\'arrivera d\'ici là.';
  }
  if (!pref.pushEnabled) {
    return 'L\'abonnement est bien enregistré, mais l\'interrupteur ci-dessous est coupé : rien n\'arrivera.';
  }
  return nominal;
}

export interface SeverityOption {
  value: AlertSeverity;
  label: string;
  hint: string;
}

/**
 * Le seuil est formulé en volume attendu, pas en jargon : « à partir de warning » ne dit
 * rien, « vous recevrez aussi les excès de vitesse » dit tout.
 *
 * ⚠️ Chaque libellé porte le PIÈGE de son option, pas seulement son bénéfice :
 *   - « Critiques uniquement » a l'air prudent, mais « alimentation coupée » est classée
 *     CRITICAL et vaut 330 alertes par jour à elle seule ;
 *   - et ce même réglage écarte « batterie faible », qui est un simple avertissement.
 * C'est la raison pour laquelle le défaut serveur est `warning` ET coupe deux types.
 */
export const SEVERITY_OPTIONS: readonly SeverityOption[] = [
  {
    value: 'critical',
    label: 'Critiques uniquement',
    hint: 'SOS, accident, remorquage, démarrage non autorisé : quelques-uns par an. Mais « batterie faible » et les sorties de zone ne passeront plus.',
  },
  {
    value: 'warning',
    label: 'Critiques et avertissements',
    hint: 'Recommandé. Ajoute batterie faible, zones et perte de signal GPS : deux ou trois par jour.',
  },
  {
    value: 'info',
    label: 'Tout recevoir',
    hint: 'Ajoute freinage, accélération et virages brusques. Aucun n\'a été observé en 30 jours : leur volume réel est inconnu.',
  },
];

/* ════════════════════════════════════════════════════════════════════════════ */

/**
 * Carte « Notifications push » des Paramètres.
 *
 * Contexte réel : pendant des mois, aucune notification push n'est partie alors que
 * l'infrastructure (VAPID, abonnements, service worker) fonctionnait — l'aiguillage ne
 * routait rien. Cet écran est la contrepartie visible du correctif : il doit permettre de
 * répondre à « est-ce que je vais recevoir quelque chose, et quoi ? » sans ouvrir un log.
 *
 * Cible prioritaire : PWA installée sur téléphone. Aucun élément en position fixe ici —
 * les zones sûres iOS sont déjà gérées au niveau du conteneur `.content` (styles.css,
 * bloc `body.ios-pwa`) ; y ajouter un padding local produirait un double décalage.
 */
@Component({
  selector: 'app-notifications-card',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <div class="nc-card">
      <div class="nc-head">
        <div class="nc-head-icon"><lucide-icon [img]="BellIcon" [size]="16" /></div>
        <div class="nc-head-text">
          <span class="nc-title">Notifications push</span>
          <span class="nc-sub">Recevez les alertes même quand l'application est fermée.</span>
        </div>
      </div>

      <div class="nc-body">
        <!-- ─── 1. Etat de cet appareil (autorisation navigateur + abonnement) ─── -->
        @if (deviceState().banner === 'unsupported') {
          <div class="nc-state nc-state-off">
            <lucide-icon [img]="BellOffIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Impossible sur cet appareil</p>
              <p class="nc-state-desc">{{ unsupportedReason() }}</p>
            </div>
          </div>
          @if (deviceState().iosNeedsInstall) {
            <div class="nc-ios">
              <p class="nc-ios-title">Sur iPhone et iPad, il faut installer Tracky</p>
              <ol class="nc-ios-steps">
                <li>Ouvrez Tracky dans <b>Safari</b>.</li>
                <li>Touchez <b>Partager</b> (le carré avec une flèche).</li>
                <li>Choisissez <b>Sur l'écran d'accueil</b>.</li>
                <li>Rouvrez Tracky depuis l'icône ainsi créée, puis revenez ici.</li>
              </ol>
              <p class="nc-ios-note">
                Apple ne permet les notifications web que depuis une application installée.
                Tant que Tracky est ouvert dans l'onglet Safari, aucune notification ne peut
                arriver — même autorisation accordée.
              </p>
            </div>
          }
        } @else if (deviceState().banner === 'server-off') {
          <div class="nc-state nc-state-off">
            <lucide-icon [img]="AlertIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Push indisponible</p>
              <p class="nc-state-desc">
                Le service d'envoi n'est pas activé côté serveur. Vos réglages ci-dessous sont
                conservés et s'appliqueront dès sa remise en service.
              </p>
            </div>
          </div>
        } @else if (deviceState().banner === 'denied') {
          <div class="nc-state nc-state-warn">
            <lucide-icon [img]="BellOffIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Autorisation refusée</p>
              <p class="nc-state-desc">
                Vous avez refusé les notifications pour Tracky. Le navigateur ne redemandera
                plus : réautorisez-les dans ses réglages de site, puis revenez sur cette page.
              </p>
            </div>
          </div>
        } @else if (deviceState().banner === 'not-subscribed') {
          <div class="nc-state nc-state-off">
            <lucide-icon [img]="BellOffIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Pas encore activé sur cet appareil</p>
              <p class="nc-state-desc">Une autorisation vous sera demandée par le navigateur.</p>
            </div>
          </div>
          <button type="button" class="nc-btn nc-btn-primary" [disabled]="busyDevice()" (click)="enable()">
            {{ busyDevice() ? 'Activation…' : 'Activer sur cet appareil' }}
          </button>
        } @else {
          <div class="nc-state nc-state-on">
            <lucide-icon [img]="BellRingIcon" [size]="18" />
            <div class="nc-state-text">
              <p class="nc-state-title">Actif sur cet appareil</p>
              <!-- « Abonné » n'est pas « vous recevrez » : cf. activeDeliveryHint(). -->
              <p class="nc-state-desc">{{ deliveryHint() }}</p>
            </div>
          </div>
          <button type="button" class="nc-btn nc-btn-ghost" [disabled]="busyDevice()" (click)="disable()">
            Désactiver sur cet appareil
          </button>
        }

        <!-- ─── 2. Avertissements de portee (deploiement / serveur injoignable) ─── -->
        @if (prefsUnavailable()) {
          <p class="nc-notice nc-notice-warn">
            <lucide-icon [img]="AlertIcon" [size]="13" />
            Vos réglages n'ont pas pu être chargés. Les valeurs affichées sont celles par
            défaut et ne sont pas enregistrées tant que le serveur ne répond pas.
          </p>
        } @else if (pref() && !pref()!.eligible) {
          <p class="nc-notice">
            <lucide-icon [img]="InfoIcon" [size]="13" />
            Le push n'est pas encore ouvert à votre rôle. Vous pouvez préparer vos réglages
            dès maintenant : ils seront appliqués tels quels à l'ouverture.
          </p>
        } @else if (pref()?.isDefault) {
          <!-- Le défaut n'est PAS neutre : il coupe deux types ET pose un seuil. Le taire
               produirait exactement le symptôme qu'on répare (« j'ai activé, je ne reçois
               rien »).
               ⚠️ Ne PAS écrire « tout le reste vous est envoyé » : c'est faux. Le seuil par
               défaut est « avertissements et plus », donc les alertes de conduite classées
               information (freinage, accélération, virage brusque, vibration, arrêt
               prolongé) ne partent pas non plus. Une phrase fausse ici est pire que pas de
               phrase : elle envoie l'utilisateur chercher une panne inexistante. -->
          <p class="nc-notice">
            <lucide-icon [img]="InfoIcon" [size]="13" />
            Vous n'avez encore rien réglé. Deux réglages s'appliquent par défaut :
            « alimentation coupée » et « excès de vitesse » sont coupés (près de 500 alertes
            par jour sur le parc à eux deux), et le seuil retient les alertes de simple
            information. Le récapitulatif ci-dessous indique ce qu'il reste ; tout se
            rallume ici même.
          </p>
        }

        @if (pref(); as p) {
          <!-- ─── 3. Interrupteur MAITRE ─── -->
          <div class="nc-row nc-row-master">
            <div class="nc-row-text">
              <p class="nc-row-title">Recevoir les notifications</p>
              <p class="nc-row-desc">Coupe tout, sans perdre les réglages ci-dessous.</p>
            </div>
            <label class="nc-toggle">
              <input
                type="checkbox"
                [checked]="p.pushEnabled"
                [disabled]="saving()"
                (change)="setPushEnabled($any($event.target).checked)"
                aria-label="Recevoir les notifications push"
              />
              <span class="nc-track"><span class="nc-thumb"></span></span>
            </label>
          </div>

          <!-- ─── 3 ter. SUIS-JE DESTINATAIRE ? ───
               Question AMONT de toutes les autres : sans être destinataire, aucun canal
               ne part, quels que soient les réglages ci-dessous. Elle était impossible à
               poser jusqu'ici — la liste des destinataires était codée en dur aux
               FLEET_ADMIN. Constat prod 2026-07-28 : une flotte de 6 utilisateurs actifs
               n'avait qu'UN destinataire, sans recours possible. -->
          <div class="nc-row">
            <div class="nc-row-text">
              <p class="nc-row-title">Recevoir les alertes de la flotte</p>
              <p class="nc-row-desc">
                @if (p.receivesFleetAlertsIsDefault) {
                  Selon votre rôle : {{ p.receivesFleetAlerts ? 'vous êtes destinataire' : 'vous ne l’êtes pas' }}.
                } @else {
                  Choix personnel — il ne suit plus votre rôle.
                }
              </p>
            </div>
            <label class="nc-toggle">
              <input
                type="checkbox"
                [checked]="p.receivesFleetAlerts"
                [disabled]="saving()"
                (change)="setReceivesFleetAlerts($any($event.target).checked)"
                aria-label="Recevoir les alertes de la flotte"
              />
              <span class="nc-track"><span class="nc-thumb"></span></span>
            </label>
          </div>

          @if (!p.receivesFleetAlerts) {
            <p class="nc-hint-strong">
              Vous n’êtes pas destinataire des alertes de la flotte : aucun canal
              (application, push, e-mail) ne vous préviendra, quels que soient les
              réglages ci-dessous.
            </p>
          }

          <!-- ─── 3 bis. Ce que ces reglages produisent VRAIMENT ───
               Place juste sous l'interrupteur maitre, avant les reglages : c'est la
               reponse a « est-ce que je vais recevoir quelque chose, et combien ? », et
               elle doit etre lisible sans derouler quoi que ce soit. -->
          @if (forecast(); as f) {
            <div
              class="nc-forecast"
              [class.nc-forecast-off]="f.tone === 'off' || f.tone === 'silent' || f.tone === 'ineligible'"
              [class.nc-forecast-loud]="f.tone === 'flood'"
            >
              <p class="nc-forecast-title">Ce que vous recevrez</p>
              <p class="nc-forecast-main">{{ summaryText() }}</p>
              @for (note of summaryNotes(); track note) {
                <p class="nc-forecast-note">{{ note }}</p>
              }
            </div>
          }

          <!-- ─── 4. Seuil de severite ─── -->
          <div class="nc-block" [class.nc-dimmed]="!p.pushEnabled">
            <p class="nc-block-title">À partir de quelle gravité ?</p>
            <div class="nc-sev" role="radiogroup" aria-label="Gravité minimale">
              @for (opt of severityOptions; track opt.value) {
                <button
                  type="button"
                  role="radio"
                  class="nc-sev-opt"
                  [class.active]="p.minSeverity === opt.value"
                  [attr.aria-checked]="p.minSeverity === opt.value"
                  [disabled]="saving()"
                  (click)="setMinSeverity(opt.value)"
                >
                  <span class="nc-sev-mark">
                    @if (p.minSeverity === opt.value) { <lucide-icon [img]="CheckIcon" [size]="13" /> }
                  </span>
                  <span class="nc-sev-text">
                    <span class="nc-sev-label">{{ opt.label }}</span>
                    <span class="nc-sev-hint">{{ opt.hint }}</span>
                  </span>
                </button>
              }
            </div>
          </div>

          <!-- ─── 5. Types d'alerte, par famille ─── -->
          <div class="nc-block" [class.nc-dimmed]="!p.pushEnabled">
            <p class="nc-block-title">Quelles alertes ?</p>
            <p class="nc-block-desc">
              Chaque type indique sa fréquence observée sur l'ensemble du parc
              ({{ frequencySnapshot }}) : de quoi choisir en connaissance de cause plutôt
              qu'au nom.
            </p>
            @for (g of groups(); track g.key) {
              <div class="nc-group">
                <button type="button" class="nc-group-head" (click)="toggleOpen(g.key)" [attr.aria-expanded]="isOpen(g.key)">
                  <span class="nc-group-text">
                    <span class="nc-group-label">{{ g.label }}</span>
                    <span class="nc-group-count" [class.off]="g.receivedCount === 0">
                      @if (g.allMuted) {
                        tout coupé
                      } @else if (prefsUnavailable()) {
                        <!-- Réglages non chargés : les valeurs affichées viennent d'un repli
                             local, pas du serveur. Le compte « x sur y » reste vrai pour la
                             liste montrée, mais le VOLUME qu'on en déduirait serait un
                             chiffre inventé — et un chiffre inventé a l'autorité d'une
                             mesure. On le tait plutôt que de le fabriquer. -->
                        {{ g.activeCount }} sur {{ g.total }}
                      } @else {
                        {{ g.activeCount }} sur {{ g.total }} · {{ g.volumeText }}
                      }
                    </span>
                  </span>
                  <span class="nc-chevron" [class.open]="isOpen(g.key)">
                    <lucide-icon [img]="ChevronIcon" [size]="16" />
                  </span>
                </button>
                @if (isOpen(g.key)) {
                  <p class="nc-group-hint">{{ g.hint }}</p>
                  <button
                    type="button"
                    class="nc-group-all"
                    [disabled]="saving()"
                    (click)="setGroup(g, g.allMuted)"
                  >
                    {{ g.allMuted ? 'Tout réactiver' : 'Tout couper' }}
                  </button>
                  @for (item of g.items; track item.type) {
                    <div class="nc-row nc-row-type">
                      <div class="nc-row-text">
                        <p class="nc-row-title">
                          {{ item.label }}
                          @if (item.mutedByDefault && !item.enabled) {
                            <span class="nc-tag">coupé par défaut</span>
                          }
                        </p>
                        <p class="nc-row-desc">
                          <span class="nc-freq" [class.loud]="item.frequency.perDay >= 1">{{ item.frequencyText }}</span>
                          <!-- L'information la plus importante de la ligne : interrupteur
                               allumé ET pourtant rien ne partira. -->
                          @if (item.blockedBySeverity) {
                            <span class="nc-blocked">· ne partira pas : sous le seuil choisi</span>
                          }
                        </p>
                        @if (item.noiseNote) {
                          <p class="nc-row-note">{{ item.noiseNote }}</p>
                        }
                      </div>
                      <label class="nc-toggle">
                        <input
                          type="checkbox"
                          [checked]="item.enabled"
                          [disabled]="saving()"
                          (change)="setType(item.type, $any($event.target).checked)"
                          [attr.aria-label]="item.label + ' — ' + item.frequencyText"
                        />
                        <span class="nc-track"><span class="nc-thumb"></span></span>
                      </label>
                    </div>
                  }
                }
              </div>
            }
          </div>
        }

        <!-- ─── 6. Appareils abonnes ─── -->
        <div class="nc-block">
          <p class="nc-block-title">Appareils abonnés</p>
          @if (devices().length === 0) {
            <p class="nc-empty">Aucun appareil abonné pour l'instant.</p>
          } @else {
            @for (d of devices(); track d.id) {
              <div class="nc-device">
                <div class="nc-device-icon"><lucide-icon [img]="PhoneIcon" [size]="15" /></div>
                <div class="nc-device-text">
                  <p class="nc-device-name">
                    {{ deviceLabel(d) }}
                    @if (isThisDevice(d)) { <span class="nc-badge">cet appareil</span> }
                  </p>
                  <p class="nc-device-meta">{{ d.endpointHost }} · vu le {{ shortDate(d.lastSeenAt) }}</p>
                </div>
                <button
                  type="button"
                  class="nc-icon-btn"
                  [disabled]="revoking() === d.id"
                  (click)="revoke(d)"
                  [attr.aria-label]="'Révoquer ' + deviceLabel(d)"
                >
                  <lucide-icon [img]="TrashIcon" [size]="16" />
                </button>
              </div>
            }
          }
        </div>

        <!-- ─── 7. Notification de test ───
             L'endpoint POST /notifications/test est reserve aux SUPER_ADMIN et exige un
             abonnement existant. On n'affiche donc le bouton que dans ce cas : proposer un
             bouton qui repondra 403 ou 400 est exactement le genre d'echec silencieux
             qu'on essaie de supprimer. -->
        @if (canTest()) {
          <div class="nc-block">
            <p class="nc-block-title">Vérifier que ça arrive</p>
            <p class="nc-block-desc">
              Envoie une notification de test à vos appareils abonnés. Elle ignore les réglages
              ci-dessus : c'est un test de la chaîne d'envoi, pas du filtrage.
            </p>
            <button type="button" class="nc-btn nc-btn-primary" [disabled]="testing()" (click)="sendTest()">
              <lucide-icon [img]="SendIcon" [size]="15" />
              {{ testing() ? 'Envoi…' : 'Envoyer une notification de test' }}
            </button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      /* Mobile d'abord : toutes les cibles tactiles font au moins 44px, aucun etat
         accessible uniquement au survol, aucune ligne horizontale a faire defiler. */
      .nc-card { background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 16px; overflow: hidden; }
      .nc-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
      .nc-head-icon { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: color-mix(in srgb, var(--tracky) 12%, transparent); color: var(--tracky-light); }
      .nc-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .nc-title { font-size: 13px; font-weight: 700; color: var(--fg-primary); }
      .nc-sub { font-size: 11px; color: var(--fg-tertiary); }
      .nc-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }

      /* Etat de l'appareil */
      .nc-state { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
      .nc-state lucide-icon { flex-shrink: 0; margin-top: 1px; }
      .nc-state-text { min-width: 0; }
      .nc-state-title { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); margin: 0 0 2px; }
      .nc-state-desc { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0; }
      .nc-state-on { border-color: color-mix(in srgb, var(--tracky) 35%, var(--border-subtle)); }
      .nc-state-on lucide-icon { color: var(--tracky-light); }
      .nc-state-warn { border-color: color-mix(in srgb, #f59e0b 35%, var(--border-subtle)); }
      .nc-state-warn lucide-icon { color: #f59e0b; }
      .nc-state-off lucide-icon { color: var(--fg-tertiary); }

      /* Mode d'emploi iOS — la cause n°1 de « je ne recois rien » */
      .nc-ios { padding: 12px 14px; border-radius: 12px; background: var(--bg-tertiary); border: 1px dashed var(--border-strong, var(--border-subtle)); }
      .nc-ios-title { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); margin: 0 0 8px; }
      .nc-ios-steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
      .nc-ios-steps li { font-size: 11.5px; color: var(--fg-secondary); line-height: 1.5; }
      .nc-ios-note { font-size: 11px; color: var(--fg-tertiary); line-height: 1.5; margin: 10px 0 0; }

      .nc-notice { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0; }
      .nc-notice lucide-icon { flex-shrink: 0; margin-top: 2px; }
      .nc-notice-warn { color: #f59e0b; }

      /* Blocs */
      .nc-block { border-top: 1px solid var(--border-subtle); padding-top: 14px; }
      .nc-block-title { font-size: 12px; font-weight: 700; color: var(--fg-primary); margin: 0 0 4px; }
      .nc-block-desc { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 0 0 10px; }
      /* Volontairement pas de champs desactives : l'interrupteur maitre coupe l'envoi,
         il ne doit pas empecher de preparer ses reglages. On attenue seulement. */
      .nc-dimmed { opacity: .55; }

      /* Recapitulatif « ce que vous recevrez » — encadre, jamais une ligne de plus.
         C'est la reponse a la question que l'utilisateur se pose vraiment. */
      .nc-forecast { padding: 12px 14px; border-radius: 12px; background: color-mix(in srgb, var(--tracky) 8%, var(--bg-tertiary)); border: 1px solid color-mix(in srgb, var(--tracky) 28%, var(--border-subtle)); }
      .nc-forecast-title { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--tracky-light); margin: 0 0 5px; }
      .nc-forecast-main { font-size: 12.5px; font-weight: 600; color: var(--fg-primary); line-height: 1.5; margin: 0; }
      .nc-forecast-note { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.5; margin: 7px 0 0; }
      /* Aucun envoi : on retire l'accent positif, sinon l'encadre felicite d'un silence. */
      .nc-forecast-off { background: var(--bg-tertiary); border-color: var(--border-subtle); }
      .nc-forecast-off .nc-forecast-title { color: var(--fg-tertiary); }
      .nc-forecast-loud { background: color-mix(in srgb, #f59e0b 10%, var(--bg-tertiary)); border-color: color-mix(in srgb, #f59e0b 38%, var(--border-subtle)); }
      .nc-forecast-loud .nc-forecast-title { color: #f59e0b; }

      /* Lignes a interrupteur — 48px minimum de hauteur tactile */
      .nc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 6px 0; }
      /* Une ligne de type porte 2 a 3 lignes de texte : on aligne en haut pour que
         l'interrupteur ne flotte pas au milieu d'un paragraphe. */
      .nc-row-type { align-items: flex-start; padding: 8px 0; }
      .nc-row-type .nc-toggle { margin-top: -2px; }
      .nc-tag { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; margin-left: 6px; border-radius: 999px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); white-space: nowrap; }
      .nc-freq { color: var(--fg-tertiary); }
      /* Au-dela d'une par jour, la frequence n'est plus un detail : elle doit sauter aux yeux. */
      .nc-freq.loud { color: #f59e0b; font-weight: 700; }
      .nc-blocked { color: #f59e0b; margin-left: 4px; }
      .nc-row-note { font-size: 11px; color: var(--fg-tertiary); line-height: 1.45; margin: 4px 0 0; }
      .nc-row-master { padding: 12px 14px; border-radius: 12px; background: var(--bg-tertiary); }
      .nc-row-text { flex: 1; min-width: 0; }
      .nc-row-title { font-size: 12.5px; font-weight: 600; color: var(--fg-primary); margin: 0; }
      .nc-row-desc { font-size: 11px; color: var(--fg-tertiary); margin: 2px 0 0; line-height: 1.45; }

      .nc-toggle { position: relative; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; width: 52px; height: 44px; }
      .nc-toggle input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
      .nc-track { width: 46px; height: 26px; border-radius: 9999px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); transition: background .2s; position: relative; display: inline-block; pointer-events: none; }
      .nc-thumb { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left .2s; }
      .nc-toggle input:checked + .nc-track { background: var(--tracky); border-color: var(--tracky); }
      .nc-toggle input:checked + .nc-track .nc-thumb { left: 22px; }
      .nc-toggle input:disabled + .nc-track { opacity: .5; }
      .nc-toggle input:focus-visible + .nc-track { outline: 2px solid var(--tracky-light); outline-offset: 2px; }

      /* Seuil de severite — 3 lignes empilees, lisibles au pouce */
      .nc-sev { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
      .nc-sev-opt { display: flex; align-items: flex-start; gap: 10px; width: 100%; min-height: 52px; padding: 11px 13px; border-radius: 12px; border: 1px solid var(--border-subtle); background: var(--bg-tertiary); text-align: left; cursor: pointer; }
      .nc-sev-opt.active { border-color: var(--tracky); background: color-mix(in srgb, var(--tracky) 10%, var(--bg-tertiary)); }
      .nc-sev-opt:disabled { opacity: .6; cursor: default; }
      .nc-sev-mark { flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; border: 1.5px solid var(--border-strong, var(--border-subtle)); display: flex; align-items: center; justify-content: center; color: var(--accent-ink, #06281f); }
      .nc-sev-opt.active .nc-sev-mark { background: var(--tracky); border-color: var(--tracky); }
      .nc-sev-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .nc-sev-label { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
      .nc-sev-hint { font-size: 11px; color: var(--fg-tertiary); line-height: 1.45; }

      /* Familles de types */
      .nc-group { border-top: 1px solid var(--border-subtle); }
      .nc-group:first-of-type { border-top: none; }
      .nc-group-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 48px; padding: 10px 0; background: transparent; border: none; cursor: pointer; text-align: left; }
      .nc-group-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .nc-group-label { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
      .nc-group-count { font-size: 11px; color: var(--tracky-light); }
      .nc-group-count.off { color: var(--fg-tertiary); }
      .nc-chevron { color: var(--fg-tertiary); display: inline-flex; transition: transform .18s; }
      .nc-chevron.open { transform: rotate(180deg); }
      .nc-group-hint { font-size: 11px; color: var(--fg-tertiary); line-height: 1.45; margin: 0 0 8px; }
      .nc-group-all { min-height: 44px; padding: 0 14px; margin-bottom: 4px; border-radius: 10px; border: 1px solid var(--border-subtle); background: transparent; color: var(--fg-secondary); font-size: 12px; font-weight: 700; cursor: pointer; }
      .nc-group-all:disabled { opacity: .55; cursor: default; }

      /* Appareils */
      .nc-device { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 0; border-bottom: 1px solid var(--border-subtle); }
      .nc-device:last-child { border-bottom: none; }
      .nc-device-icon { width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--bg-tertiary); color: var(--fg-tertiary); }
      .nc-device-text { flex: 1; min-width: 0; }
      .nc-device-name { font-size: 12.5px; font-weight: 600; color: var(--fg-primary); margin: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .nc-device-meta { font-size: 10.5px; color: var(--fg-tertiary); margin: 2px 0 0; overflow-wrap: anywhere; }
      .nc-badge { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--tracky) 16%, transparent); color: var(--tracky-light); }
      .nc-empty { font-size: 11.5px; color: var(--fg-tertiary); margin: 0; }
      .nc-icon-btn { width: 44px; height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 10px; border: 1px solid var(--border-subtle); background: transparent; color: var(--fg-tertiary); cursor: pointer; }
      .nc-icon-btn:disabled { opacity: .5; cursor: default; }

      /* Boutons */
      .nc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 46px; padding: 0 16px; border-radius: 12px; border: none; font-size: 13px; font-weight: 700; cursor: pointer; }
      .nc-btn:disabled { opacity: .6; cursor: default; }
      .nc-btn-primary { background: var(--tracky); color: var(--accent-ink, #06281f); }
      .nc-btn-ghost { background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-subtle); }

      /* A partir de la tablette, on laisse les boutons reprendre leur largeur naturelle. */
      @media (min-width: 640px) {
        .nc-btn { width: auto; align-self: flex-start; }
      }
    `,
  ],
})
export class NotificationsCardComponent implements OnInit {
  private readonly api = inject(NotificationsApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly BellIcon = Bell;
  protected readonly BellOffIcon = BellOff;
  protected readonly BellRingIcon = BellRing;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly InfoIcon = Info;
  protected readonly CheckIcon = Check;
  protected readonly ChevronIcon = ChevronDown;
  protected readonly TrashIcon = Trash2;
  protected readonly SendIcon = Send;
  protected readonly PhoneIcon = Smartphone;

  /** Copie mutable : `@for` attend un itérable simple, pas un tableau en lecture seule. */
  protected readonly severityOptions: SeverityOption[] = [...SEVERITY_OPTIONS];

  protected readonly pref = this.api.preferences;
  protected readonly prefsUnavailable = this.api.preferencesUnavailable;
  /** Jamais `api.devices` brut : ce signal est partagé avec Observabilité (`scope=all`). */
  protected readonly devices = computed(() => ownDevices(this.api.devices()));

  protected readonly busyDevice = signal(false);
  protected readonly saving = signal(false);
  protected readonly testing = signal(false);
  protected readonly revoking = signal<string | null>(null);

  /** Permission navigateur relue apres chaque action (elle change hors Angular). */
  private readonly permission = signal<NotificationPermission | 'unsupported'>('default');
  private readonly openGroups = signal<Set<string>>(new Set());

  /** Provenance des fréquences, affichée une fois pour toutes sous le titre du bloc. */
  protected readonly frequencySnapshot = FREQUENCY_SNAPSHOT_LABEL;

  protected readonly groups = computed(() => {
    const p = this.pref();
    // Pas de repli inventé ici : sans préférence chargée, il n'y a rien d'honnête à
    // prédire, et le template ne rend ce bloc que lorsque `pref()` existe.
    return p ? buildGroupViews(ALERT_TYPE_GROUPS, p) : [];
  });

  /**
   * Ce que les réglages courants produiront réellement — calculé, jamais promis.
   *
   * Deux garde-fous, pour la même raison : ce bloc est le plus affirmatif de l'écran, donc
   * celui qui coûte le plus cher s'il ment.
   *   - `prefsUnavailable()` : les valeurs affichées sont un repli local inventé côté PWA
   *     (`fallbackPreference()`), pas ce que le serveur applique. En tirer « vous recevrez
   *     330 notifications par jour » serait une prévision fabriquée de bout en bout. On
   *     n'affiche alors RIEN — le bandeau « réglages non chargés » dit déjà le nécessaire.
   *   - `p.eligible` : hors périmètre de déploiement, le serveur écarte l'envoi au motif
   *     `rollout` avant même de lire les préférences.
   */
  protected readonly forecast = computed(() => {
    const p = this.pref();
    if (!p || this.prefsUnavailable()) return null;
    return buildDeliveryForecast(ALERT_TYPE_GROUPS, p, p.eligible);
  });

  protected readonly summaryText = computed(() => {
    const f = this.forecast();
    return f ? forecastSentence(f) : '';
  });

  protected readonly summaryNotes = computed(() => {
    const f = this.forecast();
    return f ? forecastNotes(f) : [];
  });

  protected readonly deviceState = computed(() => {
    const diag = this.api.pushSupportDiagnostic();
    return derivePushDeviceState({
      supported: diag.supported,
      serverEnabled: this.api.pushEnabled(),
      permission: this.permission(),
      subscribed: this.api.isSubscribed(),
      isIOS: diag.isIOS,
      isStandalone: diag.isStandalone,
    });
  });

  protected readonly unsupportedReason = computed(
    () => this.api.pushSupportDiagnostic().reason ?? 'Ce navigateur ne gère pas les notifications web.',
  );

  /** Ce que cet appareil abonné va RÉELLEMENT recevoir (maître coupé, rôle hors périmètre). */
  protected readonly deliveryHint = computed(
    () => activeDeliveryHint(this.pref(), this.prefsUnavailable()),
  );

  /**
   * `POST /notifications/test` est gardé par `@Roles(SUPER_ADMIN)` et refuse un compte
   * sans abonnement. On reproduit la condition ici plutôt que d'afficher un bouton qui
   * échoue.
   */
  protected readonly canTest = computed(
    () => this.auth.user()?.role === 'SUPER_ADMIN' && this.devices().length > 0,
  );

  async ngOnInit(): Promise<void> {
    this.refreshPermission();
    // loadStatus() interroge le serveur (VAPID actif ?) et resynchronise l'abonnement
    // local — il peut avoir ete revoque silencieusement par iOS depuis la derniere visite.
    await this.api.loadStatus().catch(() => undefined);
    this.refreshPermission();
    await Promise.all([
      this.api.loadPreferences(),
      this.api.listDevices('mine').catch(() => undefined),
    ]);
  }

  private refreshPermission(): void {
    this.permission.set(
      typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
    );
  }

  // ─── Abonnement de cet appareil ─────────────────────────────

  protected async enable(): Promise<void> {
    if (this.busyDevice()) return;
    this.busyDevice.set(true);
    try {
      const res = await this.api.subscribePush();
      this.refreshPermission();
      if (res.ok) {
        await this.api.listDevices('mine').catch(() => undefined);
        this.toast.success('Notifications activées sur cet appareil');
      } else {
        this.toast.error('Activation impossible', res.reason);
      }
    } catch {
      this.toast.error('Activation impossible', 'Réessayez dans un instant.');
    } finally {
      this.busyDevice.set(false);
    }
  }

  protected async disable(): Promise<void> {
    if (this.busyDevice()) return;
    this.busyDevice.set(true);
    try {
      await this.api.unsubscribePush();
      await this.api.listDevices('mine').catch(() => undefined);
      this.toast.success('Notifications désactivées sur cet appareil');
    } catch {
      this.toast.error('Désactivation impossible');
    } finally {
      this.busyDevice.set(false);
    }
  }

  // ─── Preferences ────────────────────────────────────────────

  /**
   * Être destinataire, c'est la condition AMONT : sans elle, aucun canal ne part.
   * On envoie un booléen explicite — le retour à « selon mon rôle » (`null`) existe
   * côté API mais n'est pas exposé ici, pour ne pas imposer un troisième état à l'écran.
   */
  protected setReceivesFleetAlerts(value: boolean): void {
    void this.patch({ receivesFleetAlerts: value });
  }

  protected setPushEnabled(value: boolean): void {
    void this.patch({ pushEnabled: value });
  }

  protected setMinSeverity(value: AlertSeverity): void {
    if (this.pref()?.minSeverity === value) return;
    void this.patch({ minSeverity: value });
  }

  protected setType(type: AlertType, enabled: boolean): void {
    const current = this.pref()?.mutedTypes ?? [];
    void this.patch({ mutedTypes: toggleMutedType(current, type, enabled) });
  }

  protected setGroup(group: AlertTypeGroup, enabled: boolean): void {
    const current = this.pref()?.mutedTypes ?? [];
    void this.patch({ mutedTypes: setGroupMuted(current, group, enabled) });
  }

  /**
   * Un seul point d'enregistrement : le service applique le changement de façon
   * optimiste et revient en arrière si le serveur refuse. On ne signale que l'échec —
   * un toast à chaque interrupteur transformerait le réglage en champ de confettis.
   */
  private async patch(payload: UpdateNotificationPreferenceDto): Promise<void> {
    this.saving.set(true);
    const ok = await this.api.savePreferences(payload);
    this.saving.set(false);
    if (!ok) {
      this.toast.error('Réglage non enregistré', 'Vérifiez votre connexion et réessayez.');
    }
  }

  // ─── Groupes deplies ────────────────────────────────────────

  protected isOpen(key: string): boolean {
    return this.openGroups().has(key);
  }

  protected toggleOpen(key: string): void {
    const next = new Set(this.openGroups());
    if (!next.delete(key)) next.add(key);
    this.openGroups.set(next);
  }

  // ─── Appareils ──────────────────────────────────────────────

  protected isThisDevice(d: PushSubscriptionDto): boolean {
    return isCurrentDeviceEndpoint(d.endpoint, this.api.currentSubscription()?.endpoint ?? null);
  }

  /** Libellé lisible depuis le user-agent — on ne montre jamais l'endpoint brut. */
  protected deviceLabel(d: PushSubscriptionDto): string {
    const ua = d.userAgent ?? '';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Appareil Android';
    if (/Windows/i.test(ua)) return 'Ordinateur Windows';
    if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
    if (/Linux/i.test(ua)) return 'Ordinateur Linux';
    return 'Appareil';
  }

  protected shortDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  protected async revoke(d: PushSubscriptionDto): Promise<void> {
    if (this.revoking()) return;
    this.revoking.set(d.id);
    try {
      const wasCurrent = this.isThisDevice(d);
      await this.api.deleteDevice(d.id);
      // Si on vient de révoquer CET appareil, il faut aussi couper l'abonnement local :
      // sinon le navigateur reste abonné à un endpoint que le serveur a oublié, et
      // l'écran continue d'afficher « actif » alors que plus rien n'arrivera.
      if (wasCurrent) await this.api.unsubscribePush().catch(() => undefined);
      this.toast.success('Appareil révoqué');
    } catch {
      this.toast.error('Révocation impossible');
    } finally {
      this.revoking.set(null);
    }
  }

  // ─── Test ───────────────────────────────────────────────────

  protected async sendTest(): Promise<void> {
    if (this.testing()) return;
    this.testing.set(true);
    try {
      const res = await this.api.sendTestPush({
        title: 'Test Tracky',
        body: 'Si vous lisez ceci, les notifications fonctionnent sur cet appareil.',
        severity: 'INFO',
      });
      const sent = res.sent ?? 0;
      if (res.scheduled) {
        this.toast.success('Test programmé', `Envoi vers ${res.targetDevices} appareil(s).`);
      } else if (sent > 0) {
        this.toast.success('Test envoyé', `${sent} appareil(s) touché(s). Elle peut mettre quelques secondes à arriver.`);
      } else {
        // 0 envoi mais pas d'erreur HTTP : les abonnements existent mais le service push
        // les a refusés (endpoint périmé). Le dire plutôt que d'afficher un faux succès.
        this.toast.error('Aucune notification envoyée', 'Les abonnements enregistrés ont été refusés. Réactivez les notifications sur cet appareil.');
      }
    } catch {
      this.toast.error('Envoi du test impossible', 'Activez d\'abord les notifications sur cet appareil.');
    } finally {
      this.testing.set(false);
    }
  }
}
