import { TEMPLATE_META } from '../email/email-admin.service';
import {
  ALL_TEMPLATE_META,
  PUSH_TEMPLATE_META,
  SMS_TEMPLATE_META,
  templateLabel,
  type PushTemplateId,
  type SmsTemplateId,
} from './communications.catalog';

/**
 * Garde anti-dérive du module COMMUNICATIONS — pendant SMS/push de
 * `email-templates-catalog.spec.ts`.
 *
 * Tout message sortant doit être recensé : les `Record<…TemplateId, true>` forcent
 * la mise à jour de ces listes à chaque nouveau modèle (erreur de compilation si une
 * clé manque), et les tests vérifient que le catalogue les expose bien. Objectif :
 * l'admin garde une vue exhaustive de TOUT ce que Tracky envoie, sur les 3 canaux.
 */
const EVERY_SMS: Record<SmsTemplateId, true> = {
  alert_notification: true,
  alert_whatsapp: true,
  tracker_provisioning: true,
  gateway_heartbeat: true,
  admin_test_fallback: true,
  admin_manual: true,
  engine_control_fallback: true,
  fix_mode_fallback: true,
  audio_arm: true,
  audio_disarm: true,
  audio_auto_disarm: true,
  reservation_public: true,
  sim_direct: true,
};
const EVERY_PUSH: Record<PushTemplateId, true> = {
  alert: true,
  maintenance_due: true,
  // Ajoutés à la centralisation du 2026-08-16 : le chemin générique de notification
  // sert quatre catégories, le catalogue n'en connaissait qu'une.
  report_ready: true,
  validation_pending: true,
  system_notice: true,
  // Assistance IA (2026-08) : demande d'aide ouverte, ou reprise par un conseiller.
  assistance: true,
  admin_test: true,
};

const SMS_IDS = Object.keys(EVERY_SMS) as SmsTemplateId[];
const PUSH_IDS = Object.keys(EVERY_PUSH) as PushTemplateId[];

describe('Catalogue communications — couverture exhaustive (SMS + push)', () => {
  it('chaque SmsTemplateId est recensé au catalogue SMS', () => {
    const known = new Set(SMS_TEMPLATE_META.map((t) => t.id));
    expect(SMS_IDS.filter((id) => !known.has(id))).toEqual([]);
  });

  it('chaque PushTemplateId est recensé au catalogue push', () => {
    const known = new Set(PUSH_TEMPLATE_META.map((t) => t.id));
    expect(PUSH_IDS.filter((id) => !known.has(id))).toEqual([]);
  });

  it('aucun modèle fantôme dans les catalogues SMS/push', () => {
    const sms = new Set<string>(SMS_IDS);
    const push = new Set<string>(PUSH_IDS);
    expect(SMS_TEMPLATE_META.map((t) => t.id).filter((id) => !sms.has(id))).toEqual([]);
    expect(PUSH_TEMPLATE_META.map((t) => t.id).filter((id) => !push.has(id))).toEqual([]);
  });

  it('le catalogue unifié couvre les 3 canaux (e-mails inclus)', () => {
    const emails = ALL_TEMPLATE_META.filter((t) => t.channel === 'EMAIL');
    expect(emails).toHaveLength(TEMPLATE_META.length);
    expect(ALL_TEMPLATE_META.filter((t) => t.channel === 'SMS')).toHaveLength(SMS_IDS.length);
    expect(ALL_TEMPLATE_META.filter((t) => t.channel === 'PUSH')).toHaveLength(PUSH_IDS.length);
    expect(ALL_TEMPLATE_META).toHaveLength(TEMPLATE_META.length + SMS_IDS.length + PUSH_IDS.length);
  });

  it('chaque modèle porte un libellé et un déclencheur lisibles', () => {
    for (const t of ALL_TEMPLATE_META) {
      expect(t.label.length).toBeGreaterThan(2);
      expect(t.trigger.length).toBeGreaterThan(2);
      // Le libellé résolu ne doit jamais retomber sur l'id brut.
      expect(templateLabel(t.channel, t.id)).toBe(t.label);
    }
  });

  it('un modèle inconnu reste lisible (pas de crash, repli sur l’id)', () => {
    expect(templateLabel('SMS', null)).toBeTruthy();
    expect(templateLabel('SMS', 'modele_inexistant')).toBe('modele_inexistant');
  });
});
