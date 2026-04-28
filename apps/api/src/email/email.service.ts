import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { Env } from '../config/env.validation';

/**
 * V1.5 (Sprint J) — Service d'envoi d'emails via Resend.
 *
 * Mode "no-op" : si RESEND_API_KEY est vide, le service log les envois mais
 * ne fait pas d'appel reseau. Permet de developper / tester en local sans
 * compte Resend (ex: copier-coller le lien d'invitation depuis les logs).
 *
 * Templates HTML inlines : pas de dependance externe (react-email, mjml, etc.)
 * — design coherent avec le visuel Tracky (mint/green sur fond fonce). A
 * extraire dans des fichiers separes si on multiplie les templates.
 */

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  context?: Record<string, unknown>;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly client: Resend | null;
  private readonly fromAddress: string;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService<Env, true>) {
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    this.fromAddress = this.config.get('RESEND_FROM', { infer: true });
    this.enabled = !!apiKey;
    this.client = this.enabled ? new Resend(apiKey) : null;
    if (this.enabled) {
      this.logger.log(`Email service active (from ${this.fromAddress})`);
    } else {
      this.logger.warn('Email service disabled (RESEND_API_KEY missing) — running in no-op mode');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async send(params: SendEmailParams): Promise<{ ok: boolean; id?: string; error?: string }> {
    if (!this.enabled || !this.client) {
      this.logger.debug(
        { to: params.to, subject: params.subject, ctx: params.context },
        `[noop] Email to ${params.to}: ${params.subject}`,
      );
      return { ok: true };
    }
    try {
      const result = await this.client.emails.send({
        from: this.fromAddress,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
      });
      if (result.error) {
        this.logger.warn(`Email send failed to ${params.to}: ${result.error.message}`);
        return { ok: false, error: result.error.message };
      }
      return { ok: true, id: result.data?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Email send threw to ${params.to}: ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * Template invitation utilisateur — utilise par InvitationsService.
   * Couleurs Tracky : mint/green (#10e0a0), fond sombre (#0b0f12).
   */
  buildInvitationEmail(opts: {
    recipientName?: string | null;
    inviterName: string;
    fleetName: string;
    role: string;
    acceptUrl: string;
    expiresAt: Date;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const expiresLabel = opts.expiresAt.toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const subject = `[Vizyo Tracky] Vous etes invite a rejoindre ${opts.fleetName}`;

    const html = `<!DOCTYPE html>
<html lang="fr">
<body style="margin:0;padding:0;background:#0b0f12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#f4f4f5;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0b0f12;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#13181d;border:1px solid #2a3036;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 32px 0 32px;">
          <div style="font-size:24px;font-weight:700;color:#10e0a0;letter-spacing:-0.5px;">Vizyo Tracky</div>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#f4f4f5;">${greeting}</h1>
          <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#cbd2d9;">
            <strong style="color:#f4f4f5;">${escapeHtml(opts.inviterName)}</strong> vous a invite a rejoindre la flotte
            <strong style="color:#f4f4f5;">${escapeHtml(opts.fleetName)}</strong>
            sur Vizyo Tracky en tant que <strong style="color:#10e0a0;">${escapeHtml(opts.role)}</strong>.
          </p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#cbd2d9;">
            Cliquez le bouton ci-dessous pour creer votre mot de passe et acceder a votre compte :
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${opts.acceptUrl}" style="display:inline-block;background:#10e0a0;color:#0b0f12;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:10px;">
              Accepter l'invitation
            </a>
          </div>
          <p style="margin:0 0 8px;font-size:13px;color:#8b939c;">
            Ce lien est valide jusqu'au <strong>${expiresLabel}</strong>. Si vous ne reconnaissez pas cette invitation, ignorez cet email.
          </p>
          <p style="margin:24px 0 0;font-size:12px;color:#6b727a;border-top:1px solid #2a3036;padding-top:16px;">
            Si le bouton ne fonctionne pas, copier ce lien dans votre navigateur :<br/>
            <span style="word-break:break-all;color:#8b939c;">${opts.acceptUrl}</span>
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#6b727a;">— L'equipe Vizyo</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const text = `${greeting}

${opts.inviterName} vous a invite a rejoindre la flotte ${opts.fleetName} sur Vizyo Tracky en tant que ${opts.role}.

Acceptez l'invitation en visitant ce lien :
${opts.acceptUrl}

Ce lien est valide jusqu'au ${expiresLabel}.

— L'equipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Template reset mot de passe — meme style que l'invitation.
   */
  buildPasswordResetEmail(opts: {
    recipientName?: string | null;
    resetUrl: string;
    expiresInMinutes: number;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const subject = `[Vizyo Tracky] Réinitialisation de votre mot de passe`;

    const html = `<!DOCTYPE html>
<html lang="fr">
<body style="margin:0;padding:0;background:#0b0f12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#f4f4f5;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0b0f12;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#13181d;border:1px solid #2a3036;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 32px 0 32px;">
          <div style="font-size:24px;font-weight:700;color:#10e0a0;letter-spacing:-0.5px;">Vizyo Tracky</div>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#f4f4f5;">${greeting}</h1>
          <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#cbd2d9;">
            Vous avez demande la reinitialisation de votre mot de passe sur Vizyo Tracky.
          </p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#cbd2d9;">
            Cliquez le bouton ci-dessous pour choisir un nouveau mot de passe :
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${opts.resetUrl}" style="display:inline-block;background:#10e0a0;color:#0b0f12;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:10px;">
              Reinitialiser mon mot de passe
            </a>
          </div>
          <p style="margin:0 0 8px;font-size:13px;color:#8b939c;">
            Ce lien est valide pendant <strong>${opts.expiresInMinutes} minutes</strong>. Si vous n'avez pas demande cette reinitialisation, ignorez cet email.
          </p>
          <p style="margin:24px 0 0;font-size:12px;color:#6b727a;border-top:1px solid #2a3036;padding-top:16px;">
            Si le bouton ne fonctionne pas, copier ce lien dans votre navigateur :<br/>
            <span style="word-break:break-all;color:#8b939c;">${opts.resetUrl}</span>
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#6b727a;">— L'equipe Vizyo</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const text = `${greeting}

Vous avez demande la reinitialisation de votre mot de passe sur Vizyo Tracky.

Cliquez ce lien pour choisir un nouveau mot de passe :
${opts.resetUrl}

Ce lien est valide pendant ${opts.expiresInMinutes} minutes.

Si vous n'avez pas demande cette reinitialisation, ignorez cet email.

— L'equipe Vizyo`;

    return { subject, html, text };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
