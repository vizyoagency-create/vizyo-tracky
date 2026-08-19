import type { CobanPositionFrame } from '@vizyo/tracky-shared';

/**
 * Une alarme d'alimentation est-elle une VRAIE coupure, ou un simple contact coupé ?
 *
 * ── LE PROBLÈME, MESURÉ ──────────────────────────────────────────────────────────────
 *
 * En 24 h, 202 alertes CRITIQUES « Alimentation coupée » sont parties pour DEUX véhicules
 * garés la nuit (relevé du 2026-08-19). Aucune n'était utile. Un client qui reçoit ça
 * cesse de lire les alertes de l'application — et le jour où une vraie coupure arrive,
 * elle se noie dans le bruit que nous avons nous-mêmes créé.
 *
 * ── POURQUOI LE BOÎTIER A RAISON DE CRIER ────────────────────────────────────────────
 *
 * `ac alarm` est le code Coban pour « alimentation externe perdue ». Ce n'est PAS une
 * confusion avec une alarme huile (`oil*` a son propre code) : le décodage est juste.
 * Simplement, un boîtier câblé sur du +12V COMMUTÉ perd son alimentation à chaque coupure
 * de contact. Les trames le montrent : `jt` (contact coupé) à 20:00, salve d'`ac alarm`
 * à 00:44, `kt` (contact remis) à 06:00. Le boîtier dit la vérité ; c'est nous qui en
 * tirions la mauvaise conclusion.
 *
 * ── LE DISCRIMINANT EST DANS LA TRAME ────────────────────────────────────────────────
 *
 * Une VRAIE coupure vide la batterie de secours. Un contact coupé la laisse pleine. Le
 * boîtier transmet ce pourcentage à chaque trame — encore fallait-il le lire, il était
 * rangé dans le champ RFID et perdu.
 *
 * Seuil retenu : 90 %, décision du propriétaire. Au-dessus, le boîtier va parfaitement
 * bien et l'information n'a pas à réveiller quelqu'un ; elle reste consultable sur la
 * fiche véhicule. En dessous, la batterie se vide pour de bon : c'est une coupure.
 */
export const SEUIL_BATTERIE_COUPURE = 90;

export type VerdictAlimentation =
  /** C'est NOUS qui avons coupé : coupure moteur commandée. Jamais une alerte. */
  | 'coupure_commandee'
  /** Batterie qui se vide : coupure réelle, on alerte. */
  | 'coupure_reelle'
  /** Batterie pleine : contact coupé ou câblage commuté. Information, pas alerte. */
  | 'contact_coupe'
  /** Le boîtier ne transmet pas sa batterie : on ne peut pas trancher. */
  | 'indetermine';

export interface AnalyseAlimentation {
  verdict: VerdictAlimentation;
  batterie: number | null;
  /** Faut-il créer une alerte notifiable ? */
  alerter: boolean;
  motif: string;
}

/**
 * Analyse une alarme d'alimentation.
 *
 * ⚠️ L'INDÉTERMINÉ ALERTE. Quand le boîtier ne transmet pas sa batterie, on ne sait pas
 * — et devant une coupure d'alimentation possible, le silence est le mauvais défaut. On
 * préfère une alerte de trop qu'un vol non signalé. C'est l'inverse du choix fait pour
 * les zones mortes GPS, parce que l'enjeu n'est pas le même : là c'était une absence de
 * position, ici c'est peut-être un arrachage.
 */
export function analyserAlimentation(
  frame: CobanPositionFrame,
  contexte: { moteurCoupeParNous?: boolean } = {},
): AnalyseAlimentation {
  const batterie = frame.batteryPercent ?? null;

  /**
   * ⚠️ LA CAUSE PREMIÈRE, ET LA PLUS EMBARRASSANTE : C'EST NOUS.
   *
   * L'automatisation horaire coupe le moteur via le relais (`stopoil`) hors des heures
   * de travail. Le boîtier constate alors la disparition du +12V et le signale — à juste
   * titre. Faute de lui dire que la coupure vient de nous, l'application transformait sa
   * propre action en 156 alertes CRITIQUES envoyées au client (DZ-034-CA, nuit du 18 au
   * 19 août : CUT du planificateur à 22:00, puis `ac alarm` de 00:57 à 08:52).
   *
   * Ce test passe AVANT celui de la batterie : même une batterie basse pendant une
   * coupure commandée n'est pas un incident, c'est la conséquence attendue.
   */
  if (contexte.moteurCoupeParNous) {
    return {
      verdict: 'coupure_commandee',
      batterie,
      alerter: false,
      motif:
        "Coupure moteur commandée par l'application (automatisation horaire ou action manuelle) : la perte d'alimentation est attendue.",
    };
  }

  if (batterie === null) {
    return {
      verdict: 'indetermine',
      batterie: null,
      alerter: true,
      motif: "Le boîtier ne transmet pas son niveau de batterie : coupure impossible à confirmer.",
    };
  }

  if (batterie >= SEUIL_BATTERIE_COUPURE) {
    return {
      verdict: 'contact_coupe',
      batterie,
      alerter: false,
      motif: `Batterie interne à ${batterie} % : alimentation externe absente, mais le boîtier n'est pas en péril. Typique d'un contact coupé sur un montage commuté.`,
    };
  }

  return {
    verdict: 'coupure_reelle',
    batterie,
    alerter: true,
    motif: `Batterie interne à ${batterie} %, sous le seuil de ${SEUIL_BATTERIE_COUPURE} % : l'alimentation externe manque réellement.`,
  };
}

/**
 * Le message d'une alerte de coupure — il doit permettre de JUGER sans aller chercher.
 *
 * Les 202 alertes envoyées avaient un message VIDE : « Alimentation coupée », rien
 * d'autre. Ni depuis quand, ni le niveau de batterie, ni si le véhicule roulait.
 */
export function messageCoupure(a: AnalyseAlimentation, frame: CobanPositionFrame): string {
  const mouvement =
    frame.ignition === true || (frame.speedKph ?? 0) > 3
      ? 'véhicule en mouvement'
      : 'véhicule à l’arrêt';
  const bat = a.batterie === null ? 'niveau de batterie inconnu' : `batterie interne ${a.batterie} %`;
  return `Alimentation externe perdue — ${bat}, ${mouvement}. ${a.motif}`;
}
