import { TEMPLATE_META as EMAIL_TEMPLATE_META } from '../email/email-admin.service';

/**
 * CATALOGUE UNIFIÉ DES COMMUNICATIONS (e-mail / SMS / notification push).
 *
 * Un SEUL endroit décrit tout ce que Tracky peut envoyer à un humain, quel que soit
 * le canal. C'est ce catalogue qui alimente le module admin « Communications »
 * (libellés des journaux, espace Modèles, statistiques par modèle).
 *
 * Règle : tout envoi DOIT déclarer un `template` typé. Contrairement à l'e-mail (où
 * le champ est optionnel pour raisons historiques), `template` est OBLIGATOIRE côté
 * SMS et push — le compilateur refuse un envoi anonyme. Plus aucun message ne peut
 * partir sans être identifiable dans l'espace admin.
 */

export type CommChannel = 'EMAIL' | 'SMS' | 'PUSH';

/** Modèles SMS — un par intention d'envoi (cf. SmsGatewayService.send). */
export type SmsTemplateId =
  | 'alert_notification'
  | 'alert_whatsapp'
  | 'tracker_provisioning'
  | 'gateway_heartbeat'
  | 'admin_test_fallback'
  | 'admin_manual'
  | 'engine_control_fallback'
  | 'fix_mode_fallback'
  | 'tracker_command_sms'
  | 'audio_arm'
  | 'audio_disarm'
  | 'audio_auto_disarm'
  | 'reservation_public'
  | 'sim_direct';

/** Modèles de notification push (cf. WebPushService). */
/**
 * ⚠️ CE CATALOGUE A ÉTÉ COMPLÉTÉ À LA CENTRALISATION DU 2026-08-16, ET C'EST UNE
 * CORRECTION, PAS UN AJOUT DE CONFORT.
 *
 * Le module « Communications » date du 2026-07-20 et n'avait jamais été fusionné. Entre
 * temps, la notification est passée par un CHEMIN GÉNÉRIQUE (`notifyUsers`) qui sert
 * quatre catégories : MAINTENANCE, REPORT, VALIDATION et SYSTEM. Le catalogue, lui, n'en
 * connaissait qu'une — `maintenance_due`.
 *
 * Conséquence à la fusion : `PushPayload.template` est OBLIGATOIRE (c'est la promesse du
 * module : « aucun envoi anonyme »), et le compilateur refusait les trois catégories sans
 * modèle. Les inventer ici est le seul choix cohérent — les taire aurait signifié rendre
 * `template` optionnel, c'est-à-dire vider le module de sa raison d'être.
 */
export type PushTemplateId =
  | 'alert'
  | 'maintenance_due'
  | 'report_ready'
  | 'validation_pending'
  | 'system_notice'
  | 'assistance'
  | 'admin_test';

export interface CommTemplateMeta {
  channel: CommChannel;
  id: string;
  label: string;
  category: string;
  /** Ce qui déclenche l'envoi — lisible par un non-technicien. */
  trigger: string;
  description: string;
  /** E-mails de sécurité : pas de pixel d'ouverture → taux affiché « — ». */
  noOpenTracking?: boolean;
}

export const SMS_TEMPLATE_META: (CommTemplateMeta & { id: SmsTemplateId })[] = [
  { channel: 'SMS', id: 'alert_notification', label: 'Alerte véhicule', category: 'Alerte', trigger: 'Alerte temps réel routée sur le canal SMS', description: 'Excès de vitesse, sortie de zone, SOS, batterie…' },
  { channel: 'SMS', id: 'alert_whatsapp', label: 'Alerte WhatsApp', category: 'Alerte', trigger: 'Alerte routée sur le canal WhatsApp', description: 'Même contenu que l’alerte SMS, remis via WhatsApp.' },
  { channel: 'SMS', id: 'engine_control_fallback', label: 'Coupe-circuit (repli)', category: 'Commande', trigger: 'Boîtier injoignable en TCP lors d’une coupure/restauration', description: 'Repli SMS du coupe-circuit — chemin critique antivol.' },
  { channel: 'SMS', id: 'fix_mode_fallback', label: 'Mode fix GPS (repli)', category: 'Commande', trigger: 'Boîtier injoignable en TCP lors d’un réglage de fix', description: 'Repli SMS pour forcer la cadence de position.' },
  // ⚠️ Ce n'est PAS un repli, contrairement aux deux lignes précédentes : c'est le canal
  // NORMAL de 19 gabarits du catalogue Coban, que ces boîtiers n'acceptent pas en TCP
  // descendant. Mesuré le 20/08 : 625 155 trames TCP entrantes, zéro accusé — et des
  // « fix ok » / « admin ok! » arrivant par SMS.
  { channel: 'SMS', id: 'tracker_command_sms', label: 'Commande boîtier (canal SMS)', category: 'Commande', trigger: 'Gabarit déclaré `availableVia: [sms]` — capteur de choc, sensibilité, configuration', description: 'Seul canal que ces boîtiers écoutent pour ces commandes. L’accusé revient par SMS, parfois plusieurs heures après.' },
  { channel: 'SMS', id: 'audio_arm', label: 'Écoute audio — armement', category: 'Audio', trigger: 'Armement du micro embarqué (mode assistance)', description: 'Commande d’ouverture du micro, tracée et limitée dans le temps.' },
  { channel: 'SMS', id: 'audio_disarm', label: 'Écoute audio — désarmement', category: 'Audio', trigger: 'Désarmement manuel du micro embarqué', description: 'Referme le micro à la demande d’un opérateur.' },
  { channel: 'SMS', id: 'audio_auto_disarm', label: 'Écoute audio — désarmement auto', category: 'Audio', trigger: 'Garde-fou : 5 min après l’armement', description: 'Sécurité automatique — le micro ne peut pas rester ouvert.' },
  { channel: 'SMS', id: 'reservation_public', label: 'Réservation (lien public)', category: 'Réservation', trigger: 'Demande/validation via un lien public de réservation', description: 'Accusé ou confirmation envoyé au demandeur sans compte.' },
  { channel: 'SMS', id: 'tracker_provisioning', label: 'Provisioning boîtier', category: 'Technique', trigger: 'Configuration à distance d’un boîtier Coban', description: 'Séquence APN / serveur / cadence envoyée au boîtier.' },
  { channel: 'SMS', id: 'gateway_heartbeat', label: 'Heartbeat passerelle', category: 'Technique', trigger: 'Cron hebdomadaire (lundi 09:00)', description: 'Maintient la ligne active et vérifie la passerelle.' },
  { channel: 'SMS', id: 'admin_test_fallback', label: 'Test du repli SMS', category: 'Technique', trigger: 'Bouton « tester le repli » d’un boîtier', description: 'Vérifie qu’un boîtier répond bien par SMS.' },
  { channel: 'SMS', id: 'admin_manual', label: 'Envoi manuel (admin)', category: 'Technique', trigger: 'Envoi libre depuis l’espace admin', description: 'SMS rédigé à la main par un super-administrateur.' },
  { channel: 'SMS', id: 'sim_direct', label: 'SMS direct opérateur (SIM)', category: 'Technique', trigger: 'Envoi via l’API opérateur WhereverSIM', description: 'Passe par l’opérateur SIM et non par la passerelle.' },
];

export const PUSH_TEMPLATE_META: (CommTemplateMeta & { id: PushTemplateId })[] = [
  { channel: 'PUSH', id: 'alert', label: 'Alerte véhicule', category: 'Alerte', trigger: 'Alerte temps réel (et escalades)', description: 'Notification instantanée, même application fermée.' },
  { channel: 'PUSH', id: 'maintenance_due', label: 'Entretien à prévoir', category: 'Agenda', trigger: 'Échéance d’entretien atteinte', description: 'Rappel de maintenance planifiée sur un véhicule.' },
  { channel: 'PUSH', id: 'report_ready', label: 'Rapport disponible', category: 'Rapports', trigger: 'Rapport périodique généré', description: 'Le rapport demandé est prêt à être consulté.' },
  { channel: 'PUSH', id: 'validation_pending', label: 'Validation attendue', category: 'Agenda', trigger: 'Demande en attente d’arbitrage', description: 'Une réservation ou une demande attend une décision.' },
  { channel: 'PUSH', id: 'system_notice', label: 'Information système', category: 'Technique', trigger: 'Événement de plateforme à porter à connaissance', description: 'Message de service — maintenance, incident, changement.' },
  { channel: 'PUSH', id: 'assistance', label: 'Assistance', category: 'Assistance', trigger: 'Demande d’aide ouverte, ou reprise par un conseiller', description: 'Prévient l’exploitant qu’un utilisateur demande de l’aide, et l’utilisateur qu’un humain lui a répondu.' },
  { channel: 'PUSH', id: 'admin_test', label: 'Notification de test', category: 'Technique', trigger: 'Bouton de test dans l’espace admin', description: 'Vérifie qu’un appareil reçoit bien les notifications.' },
];

/** Métadonnées e-mail réexportées telles quelles (source unique : EmailAdminService). */
export const EMAIL_TEMPLATE_CATALOG: CommTemplateMeta[] = EMAIL_TEMPLATE_META.map((t) => ({
  channel: 'EMAIL' as const,
  id: t.id,
  label: t.label,
  category: t.category,
  trigger: t.trigger,
  description: t.subject,
  noOpenTracking: t.noOpenTracking,
}));

/** Catalogue complet, tous canaux confondus. */
export const ALL_TEMPLATE_META: CommTemplateMeta[] = [
  ...EMAIL_TEMPLATE_CATALOG,
  ...SMS_TEMPLATE_META,
  ...PUSH_TEMPLATE_META,
];

const LABELS = new Map(ALL_TEMPLATE_META.map((t) => [`${t.channel}:${t.id}`, t.label]));

/** Libellé lisible d'un modèle ; retombe sur l'identifiant brut si inconnu. */
export function templateLabel(channel: CommChannel, id: string | null | undefined): string {
  if (!id) return 'Inconnu';
  return LABELS.get(`${channel}:${id}`) ?? id;
}
