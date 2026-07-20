import { EmailService, type EmailTemplateId } from './email.service';
import { TEMPLATE_META } from './email-admin.service';

/**
 * Garde anti-dérive du CENTRE E-MAILS admin. Tout modèle réellement envoyé (déclaré
 * dans EmailTemplateId) doit :
 *   1. figurer au catalogue TEMPLATE_META → libellé au centre e-mails + carte dans
 *      l'espace « Modèles » ;
 *   2. être prévisualisable via previewTemplate() → aperçu + bouton « Envoyer un test ».
 *
 * Le Record<EmailTemplateId, true> ci-dessous FORCE la mise à jour de cette liste à
 * chaque nouveau modèle (erreur de compilation si une clé manque). L'admin garde
 * ainsi une vue exhaustive de TOUS les e-mails envoyés depuis Tracky.
 */
const EVERY_TEMPLATE: Record<EmailTemplateId, true> = {
  invitation: true,
  password_reset: true,
  device_verification: true,
  two_factor_disable: true,
  weekly_report: true,
  alert: true,
  error_rate_alert: true,
  lead: true,
  lead_welcome: true,
  quote_signed: true,
  quote_client: true,
  audio_activation: true,
  audio_info: true,
  installation_slot_requested: true,
  installation_slot_confirmed: true,
  reservation_requested: true,
  reservation_confirmed: true,
  ai_invoice_request: true,
};
const ALL_IDS = Object.keys(EVERY_TEMPLATE) as EmailTemplateId[];

describe('Catalogue e-mails — couverture exhaustive des modèles', () => {
  // previewTemplate() n'utilise que config.get('APP_BASE_URL') ; RESEND_API_KEY vide
  // ⇒ service en mode no-op (aucune instanciation Resend).
  const config = {
    get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.test' : ''),
  } as never;
  // 4e argument = ErrorLogger (remontée des échecs d'envoi au centre d'alerte) : inutilisé par
  // previewTemplate(), mais requis par le constructeur.
  const email = new EmailService(config, {} as never, {} as never, {} as never);

  it('chaque EmailTemplateId figure au catalogue TEMPLATE_META (centre e-mails)', () => {
    const cataloged = new Set(TEMPLATE_META.map((t) => t.id));
    const missing = ALL_IDS.filter((id) => !cataloged.has(id));
    expect(missing).toEqual([]);
  });

  it('le catalogue ne référence aucun modèle fantôme', () => {
    const known = new Set<string>(ALL_IDS);
    const unknown = TEMPLATE_META.map((t) => t.id).filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  it('chaque modèle est prévisualisable (pas de fallback « Modèle inconnu »)', () => {
    for (const id of ALL_IDS) {
      const tpl = email.previewTemplate(id);
      expect(tpl.subject).not.toBe('Aperçu');
      expect(tpl.html).not.toContain('Modèle inconnu');
      expect(tpl.html.length).toBeGreaterThan(200);
    }
  });
});
