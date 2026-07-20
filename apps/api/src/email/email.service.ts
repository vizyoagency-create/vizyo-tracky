import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailStatus } from '@prisma/client';
import { Resend } from 'resend';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/** Identifiant de modèle e-mail (journalisé dans EmailLog.template). */
export type EmailTemplateId =
  | 'invitation'
  | 'password_reset'
  | 'device_verification'
  | 'two_factor_disable'
  | 'weekly_report'
  | 'alert'
  | 'error_rate_alert'
  | 'lead'
  | 'lead_welcome'
  | 'quote_signed'
  | 'quote_client'
  | 'audio_activation'
  | 'audio_info'
  | 'installation_slot_requested'
  | 'installation_slot_confirmed'
  | 'reservation_requested'
  | 'reservation_confirmed'
  | 'ai_invoice_request';

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
  /** Modèle e-mail — journalisé dans EmailLog (centre e-mails admin). */
  template?: EmailTemplateId;
  /** Flotte concernée si connue (sinon lue depuis context.fleetId). */
  fleetId?: string | null;
  context?: Record<string, unknown>;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly client: Resend | null;
  private readonly fromAddress: string;
  private readonly enabled: boolean;
  /** URL absolue du logo PNG (charte 2026) — cf. EMAIL_LOGO_URL. */
  private readonly logoUrl: string;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly systemActivity: SystemActivityService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    this.fromAddress = this.config.get('RESEND_FROM', { infer: true });
    this.logoUrl = this.config.get('EMAIL_LOGO_URL', { infer: true });
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
      // Journal EmailLog même en no-op (dev/test) : l'admin voit les envois simulés.
      await this.persistLog(params, { status: EmailStatus.SENT });
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
        this.recordActivity(params, false, result.error.message);
        await this.persistLog(params, { status: EmailStatus.FAILED, errorMessage: result.error.message });
        return { ok: false, error: result.error.message };
      }
      this.recordActivity(params, true);
      await this.persistLog(params, { status: EmailStatus.QUEUED, providerId: result.data?.id ?? null });
      return { ok: true, id: result.data?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Email send threw to ${params.to}: ${message}`);
      this.recordActivity(params, false, message);
      await this.persistLog(params, { status: EmailStatus.FAILED, errorMessage: message });
      return { ok: false, error: message };
    }
  }

  /**
   * Centre e-mails (admin) — journalise l'envoi dans EmailLog. BEST-EFFORT : un
   * échec d'écriture ne DOIT JAMAIS faire échouer un envoi (try/catch + warn).
   * QUEUED = accepté par Resend (providerId présent, statut affiné ensuite par le
   * webhook) ; SENT = mode no-op ; FAILED = erreur d'envoi immédiate.
   */
  private async persistLog(
    params: SendEmailParams,
    opts: { status: EmailStatus; providerId?: string | null; errorMessage?: string },
  ): Promise<void> {
    try {
      const ctxFleet =
        typeof params.context?.['fleetId'] === 'string' ? (params.context['fleetId'] as string) : null;
      await this.prisma.emailLog.create({
        data: {
          providerId: opts.providerId ?? null,
          template: params.template ?? 'unknown',
          toAddress: params.to,
          subject: params.subject,
          status: opts.status,
          fleetId: params.fleetId ?? ctxFleet,
          errorMessage: opts.errorMessage ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`EmailLog persist failed: ${String(e)}`);
    }
  }

  /**
   * Palier B — trace l'e-mail envoyé dans le journal des actions système (arrière-plan).
   * Le mode no-op (dev, sans RESEND_API_KEY) n'est PAS journalisé (aucun envoi réel). Couvre
   * invitations, reset MDP, rapports hebdo, alertes/escalades — toutes passent par `send()`.
   */
  private recordActivity(params: SendEmailParams, ok: boolean, error?: string): void {
    const fleetId = typeof params.context?.['fleetId'] === 'string' ? (params.context['fleetId'] as string) : null;
    // Attribution : même clé de contexte que le SMS (`requestedByUserId`). Un reset MDP
    // déclenché par un admin ou une invitation apparaît alors « déclenché par X » au
    // lieu d'un « system » anonyme ; les envois cron restent 'system'.
    const requestedBy =
      typeof params.context?.['requestedByUserId'] === 'string'
        ? (params.context['requestedByUserId'] as string)
        : null;
    this.systemActivity.record({
      category: 'EMAIL',
      action: 'email_sent',
      status: ok ? 'SUCCESS' : 'FAILURE',
      actor: 'system',
      target: params.to,
      detail: params.subject,
      fleetId,
      triggeredByUserId: requestedBy,
      meta: error ? { error } : undefined,
    });
  }

  /**
   * Gabarit e-mail commun (charte 2026). Header logo + eyebrow, carte sombre,
   * footer mono. `body` = HTML interne DÉJÀ échappé (rangées `<tr><td>…`). `accent`
   * colore le filet haut + l'eyebrow (emerald par défaut, ambre conformité, rouge
   * alerte). Un seul endroit à maintenir → header/footer/logo cohérents partout.
   *
   * Public : réutilisé par LeadsService (même en-tête/pied que les e-mails du service).
   */
  shell(opts: {
    eyebrow: string;
    body: string;
    footer: string;
    accent?: string;
    borderColor?: string;
  }): string {
    const accent = opts.accent ?? '#10E0A0';
    const border = opts.borderColor ?? 'rgba(255,255,255,.08)';
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#060807;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#060807;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#101514;border:1px solid ${border};border-radius:18px;overflow:hidden;">
        <tr><td style="height:3px;background:${accent};line-height:3px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:30px 36px 0;">
          <table role="presentation" width="100%"><tr>
            <td style="vertical-align:middle;">
              <img src="${this.logoUrl}" width="27" height="27" alt="Vizyo Tracky" style="display:inline-block;vertical-align:middle;border:0;" />
              <span style="font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:16px;font-weight:700;letter-spacing:-0.01em;color:#EAEFED;vertical-align:middle;margin-left:8px;">Vizyo <span style="color:#10E0A0;">Tracky</span></span>
            </td>
            <td align="right" style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:10px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${accent};">${opts.eyebrow}</td>
          </tr></table>
        </td></tr>
        ${opts.body}
        <tr><td style="padding:24px 36px 30px;">
          <div style="height:1px;background:rgba(255,255,255,.07);margin-bottom:16px;"></div>
          <p style="margin:0;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:10.5px;line-height:1.7;letter-spacing:0.03em;color:#565f5b;">${opts.footer}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  /**
   * Template invitation utilisateur — utilise par InvitationsService.
   * Charte 2026 (charte e-mails Tracky) via shell().
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

    const html = this.shell({
      eyebrow: 'Accès · Invitation',
      footer: 'VIZYO TRACKY · GPS FLOTTE · OCCITANIE<br>Vous recevez cet e-mail suite à une invitation. Ne pas répondre.',
      body: `
        <tr><td style="padding:28px 36px 8px;">
          <h1 style="margin:0 0 6px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Rejoignez la flotte<br><span style="color:#10E0A0;">${escapeHtml(opts.fleetName)}</span></h1>
        </td></tr>
        <tr><td style="padding:8px 36px 0;">
          <p style="margin:0 0 16px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 22px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;"><span style="color:#EAEFED;font-weight:600;">${escapeHtml(opts.inviterName)}</span> vous invite à rejoindre sa flotte sur Vizyo Tracky en tant que <span style="color:#10E0A0;font-weight:600;">${escapeHtml(opts.role)}</span>. Créez votre mot de passe pour accéder à votre espace.</p>
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.acceptUrl}" style="display:inline-block;padding:14px 30px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Accepter l'invitation →</a>
          </td></tr></table>
          <p style="margin:22px 0 0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#69736E;">Ce lien expire le <span style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;color:#9BA5A1;">${expiresLabel}</span>. Si vous ne reconnaissez pas cette invitation, ignorez cet e-mail.</p>
        </td></tr>`,
    });

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

    const html = this.shell({
      eyebrow: 'Sécurité · Mot de passe',
      footer: 'VIZYO TRACKY · SÉCURITÉ DU COMPTE<br>E-mail automatique de sécurité. Ne pas répondre.',
      body: `
        <tr><td style="padding:28px 36px 0;">
          <div style="width:46px;height:46px;border-radius:12px;background:rgba(16,224,160,.12);text-align:center;line-height:46px;font-size:22px;margin-bottom:18px;">🔐</div>
          <h1 style="margin:0 0 12px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Réinitialisez votre mot de passe</h1>
          <p style="margin:0 0 22px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">Vous avez demandé à réinitialiser votre mot de passe. Choisissez-en un nouveau en cliquant ci-dessous.</p>
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.resetUrl}" style="display:inline-block;padding:14px 30px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Choisir un nouveau mot de passe →</a>
          </td></tr></table>
          <div style="margin:22px 0 0;padding:14px 16px;background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:11px;">
            <p style="margin:0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#9BA5A1;">Ce lien est valide <span style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;color:#10E0A0;">${opts.expiresInMinutes} min</span>. Vous n'êtes pas à l'origine de cette demande ? <span style="color:#EAEFED;">Ignorez cet e-mail</span>, votre mot de passe reste inchangé.</p>
          </div>
        </td></tr>`,
    });

    const text = `${greeting}

Vous avez demande la reinitialisation de votre mot de passe sur Vizyo Tracky.

Cliquez ce lien pour choisir un nouveau mot de passe :
${opts.resetUrl}

Ce lien est valide pendant ${opts.expiresInMinutes} minutes.

Si vous n'avez pas demande cette reinitialisation, ignorez cet email.

— L'equipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Sécurité (2026-07) — code de vérification d'un NOUVEL appareil (2FA app).
   * Envoyé quand une flotte exige la vérification e-mail et qu'un appareil non
   * reconnu se connecte. Le code (6 chiffres) est généré par Vizyo Auth ; Tracky
   * se charge de l'envoi (même partage que le reset mot de passe). Accent emerald,
   * code affiché en gros mono. `expiresInMinutes` = validité du code.
   */
  buildDeviceVerificationEmail(opts: {
    recipientName?: string | null;
    code: string;
    expiresInMinutes: number;
    deviceLabel?: string | null;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const subject = `[Vizyo Tracky] Votre code de connexion : ${opts.code}`;
    const spaced = opts.code.split('').join('&nbsp;');
    const deviceLine = opts.deviceLabel
      ? `<p style="margin:0 0 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#69736E;">Appareil : <span style="color:#9BA5A1;">${escapeHtml(opts.deviceLabel)}</span></p>`
      : '';

    const html = this.shell({
      eyebrow: 'Sécurité · Nouvel appareil',
      footer: 'VIZYO TRACKY · SÉCURITÉ DU COMPTE<br>E-mail automatique de sécurité. Ne pas répondre.',
      body: `
        <tr><td style="padding:28px 36px 0;">
          <div style="width:46px;height:46px;border-radius:12px;background:rgba(16,224,160,.12);text-align:center;line-height:46px;font-size:22px;margin-bottom:18px;">🔐</div>
          <h1 style="margin:0 0 12px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Votre code de connexion</h1>
          <p style="margin:0 0 6px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">Une connexion à votre compte a été demandée depuis un <span style="color:#EAEFED;font-weight:600;">nouvel appareil</span>. Saisissez ce code pour la confirmer :</p>
          ${deviceLine}
          <table role="presentation" width="100%"><tr><td align="center" style="background:#161D1B;border:1px solid rgba(16,224,160,.25);border-radius:13px;padding:22px 18px;">
            <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:38px;font-weight:600;letter-spacing:0.12em;color:#10E0A0;">${spaced}</div>
          </td></tr></table>
          <div style="margin:22px 0 0;padding:14px 16px;background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:11px;">
            <p style="margin:0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#9BA5A1;">Ce code est valide <span style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;color:#10E0A0;">${opts.expiresInMinutes} min</span>. Vous n'êtes pas à l'origine de cette connexion ? <span style="color:#EAEFED;">Ignorez cet e-mail</span> et changez votre mot de passe par précaution.</p>
          </div>
        </td></tr>`,
    });

    const text = `${greeting}

Une connexion à votre compte Vizyo Tracky a été demandée depuis un nouvel appareil.

Votre code de vérification : ${opts.code}

Ce code est valide pendant ${opts.expiresInMinutes} minutes.

Si vous n'êtes pas à l'origine de cette connexion, ignorez cet e-mail et changez votre mot de passe par précaution.

— L'équipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Code de confirmation pour DÉSACTIVER la double authentification. C'est un
   * abaissement de sécurité : on insiste pour que l'utilisateur qui n'en est pas
   * l'origine réagisse (compte potentiellement compromis).
   */
  buildTwoFactorDisableEmail(opts: {
    recipientName?: string | null;
    code: string;
    expiresInMinutes: number;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const subject = `[Vizyo Tracky] Code pour désactiver la double authentification : ${opts.code}`;
    const spaced = opts.code.split('').join('&nbsp;');

    const html = this.shell({
      eyebrow: 'Sécurité · Double authentification',
      footer: 'VIZYO TRACKY · SÉCURITÉ DU COMPTE<br>E-mail automatique de sécurité. Ne pas répondre.',
      body: `
        <tr><td style="padding:28px 36px 0;">
          <div style="width:46px;height:46px;border-radius:12px;background:rgba(245,158,11,.14);text-align:center;line-height:46px;font-size:22px;margin-bottom:18px;">⚠️</div>
          <h1 style="margin:0 0 12px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Désactiver la double authentification</h1>
          <p style="margin:0 0 6px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">Vous avez demandé à <span style="color:#EAEFED;font-weight:600;">désactiver</span> la double authentification de votre compte. Saisissez ce code pour le confirmer :</p>
          <table role="presentation" width="100%"><tr><td align="center" style="background:#161D1B;border:1px solid rgba(245,158,11,.3);border-radius:13px;padding:22px 18px;">
            <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:38px;font-weight:600;letter-spacing:0.12em;color:#F5A623;">${spaced}</div>
          </td></tr></table>
          <div style="margin:22px 0 0;padding:14px 16px;background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:11px;">
            <p style="margin:0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#9BA5A1;">Ce code est valide <span style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;color:#F5A623;">${opts.expiresInMinutes} min</span>. <span style="color:#EAEFED;">Vous n'êtes pas à l'origine de cette demande&nbsp;?</span> N'entrez pas ce code, et changez votre mot de passe immédiatement — votre compte est peut-être compromis.</p>
          </div>
        </td></tr>`,
    });

    const text = `${greeting}

Vous avez demandé à DÉSACTIVER la double authentification de votre compte Vizyo Tracky.

Votre code de confirmation : ${opts.code}

Ce code est valide pendant ${opts.expiresInMinutes} minutes.

Vous n'êtes pas à l'origine de cette demande ? N'entrez pas ce code et changez votre mot de passe immédiatement — votre compte est peut-être compromis.

— L'équipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Sprint 4 (garde-fou #6) — mail OBLIGATIONS envoyé à TOUS les utilisateurs actifs
   * d'une flotte à l'activation de l'écoute audio (micro embarqué). Rappel des
   * obligations de l'exploitant : informer conducteurs/occupants, poser la
   * signalétique, finalité strictement limitée. La conformité (mandat, information,
   * AIPD/CNIL) reste la RESPONSABILITÉ de l'exploitant — le mail trace l'information.
   */
  buildAudioActivationEmail(opts: {
    fleetName: string;
    activatedBy: string;
  }): { subject: string; html: string; text: string } {
    const subject = `[Vizyo Tracky] Écoute audio activée pour ${opts.fleetName} — obligations`;

    const html = this.shell({
      eyebrow: 'Conformité · Écoute audio',
      accent: '#F5B33D',
      borderColor: 'rgba(245,179,61,.25)',
      footer: "VIZYO TRACKY · GARDE-FOU CONFORMITÉ<br>La conformité réglementaire reste la responsabilité de l'exploitant.",
      body: `
        <tr><td style="padding:26px 36px 0;">
          <h1 style="margin:0 0 12px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#EAEFED;">Écoute audio activée</h1>
          <p style="margin:0 0 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">L'écoute audio à distance (micro embarqué) a été activée pour <span style="color:#EAEFED;font-weight:600;">${escapeHtml(opts.fleetName)}</span> par <span style="color:#EAEFED;font-weight:600;">${escapeHtml(opts.activatedBy)}</span>. Cette capacité est <span style="color:#F5B33D;font-weight:600;">légalement sensible</span> : avant tout usage, vous devez —</p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;">
            <tr><td style="padding:14px 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#9BA5A1;"><span style="color:#F5B33D;font-weight:700;">01</span>&nbsp;&nbsp;<span style="color:#EAEFED;font-weight:600;">Informer</span> les conducteurs et occupants concernés.</td></tr>
            <tr><td style="border-top:1px solid rgba(255,255,255,.06);padding:14px 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#9BA5A1;"><span style="color:#F5B33D;font-weight:700;">02</span>&nbsp;&nbsp;<span style="color:#EAEFED;font-weight:600;">Poser la signalétique</span> indiquant le dispositif.</td></tr>
            <tr><td style="border-top:1px solid rgba(255,255,255,.06);padding:14px 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#9BA5A1;"><span style="color:#F5B33D;font-weight:700;">03</span>&nbsp;&nbsp;Limiter la <span style="color:#EAEFED;font-weight:600;">finalité</span> à la sécurité / sûreté.</td></tr>
            <tr><td style="border-top:1px solid rgba(255,255,255,.06);padding:14px 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#9BA5A1;"><span style="color:#F5B33D;font-weight:700;">04</span>&nbsp;&nbsp;Respecter le cadre applicable <span style="color:#565f5b;">(information, AIPD/CNIL, DPO)</span>.</td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:18px 36px 0;">
          <p style="margin:0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#69736E;">Chaque déclenchement est tracé (qui, quand, quel véhicule, motif). La fonction est désactivable à tout moment dans les réglages de la flotte.</p>
        </td></tr>`,
    });

    const text = `Écoute audio activée — ${opts.fleetName}

La fonction d'écoute audio à distance (micro embarqué) a été activée pour la flotte ${opts.fleetName} par ${opts.activatedBy}.

Cette capacité est légalement sensible. En tant qu'exploitant, vous êtes responsable de sa conformité. Avant tout usage, vous devez :
- Informer les conducteurs et occupants des véhicules concernés.
- Poser la signalétique indiquant la présence d'un dispositif d'écoute.
- Limiter strictement la finalité (sécurité / sûreté) — jamais de surveillance permanente ou détournée.
- Respecter le cadre applicable (information, AIPD/CNIL, DPO le cas échéant).

Chaque déclenchement est tracé (qui, quand, quel véhicule, motif obligatoire). La fonction peut être désactivée à tout moment depuis les paramètres de la flotte.

La conformité réglementaire reste la responsabilité de l'exploitant. Vizyo fournit l'outil et les garde-fous techniques.

— L'equipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Sprint 4 — mail d'INFORMATION « Mode assistance » envoyé À LA DEMANDE du prestataire
   * (super-admin) à un utilisateur (typiquement un fleet-admin) pour lui présenter la
   * fonction AVANT activation. Pédagogique : explique le principe (écoute LIVE en cas
   * d'accident, sur autorisation EXPLICITE du client, AUCUN enregistrement conservé,
   * seules les métadonnées sont tracées) + la marche à suivre pour activer + les
   * obligations. Même structure/style que buildAudioActivationEmail (mint/green, fond
   * sombre). « le prestataire » reste générique (pas de marque tierce).
   */
  buildAudioInfoEmail(opts: {
    recipientName?: string | null;
    fleetName: string;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.recipientName ? `Bonjour ${opts.recipientName},` : 'Bonjour,';
    const subject = `[Vizyo Tracky] Nouvelle fonction « Mode assistance » — ${opts.fleetName}`;

    const appBase = this.config.get('APP_BASE_URL', { infer: true });

    const html = this.shell({
      eyebrow: 'Nouveauté · Assistance',
      footer: 'VIZYO TRACKY · NOUVELLE FONCTION<br>Informez conducteurs et occupants, posez la signalétique. Conformité à votre charge.',
      body: `
        <tr><td style="padding:26px 36px 0;">
          <p style="margin:0 0 6px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#10E0A0;">Disponible pour ${escapeHtml(opts.fleetName)}</p>
          <h1 style="margin:0 0 14px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Le Mode assistance<br>arrive sur votre flotte</h1>
          <p style="margin:0 0 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">En cas d'accident, et <span style="color:#EAEFED;font-weight:600;">uniquement avec votre autorisation explicite</span>, le prestataire peut ouvrir brièvement le micro de la cabine pour porter assistance.</p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:10px;margin:0 -10px;">
            <tr>
              <td width="50%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;vertical-align:top;">
                <div style="font-size:20px;margin-bottom:8px;">🎧</div>
                <div style="font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:700;color:#EAEFED;margin-bottom:4px;">Écoute en direct</div>
                <div style="font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:12.5px;line-height:1.5;color:#69736E;">Aucun fichier audio n'est stocké.</div>
              </td>
              <td width="50%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;vertical-align:top;">
                <div style="font-size:20px;margin-bottom:8px;">🗂️</div>
                <div style="font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:700;color:#EAEFED;margin-bottom:4px;">Métadonnées tracées</div>
                <div style="font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:12.5px;line-height:1.5;color:#69736E;">Qui, quand, quel véhicule, motif.</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 36px 0;">
          <p style="margin:0 0 12px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#69736E;">Pour l'activer</p>
          <p style="margin:0 0 6px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#9BA5A1;"><span style="color:#10E0A0;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;">1 →</span> Réglages → Mode assistance</p>
          <p style="margin:0 0 6px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#9BA5A1;"><span style="color:#10E0A0;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;">2 →</span> Cochez l'attestation</p>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#9BA5A1;"><span style="color:#10E0A0;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;">3 →</span> Activez la fonction</p>
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${appBase}/settings/audio-monitoring" style="display:inline-block;padding:14px 30px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Découvrir dans les réglages →</a>
          </td></tr></table>
        </td></tr>`,
    });

    const text = `${greeting}

Une nouvelle fonction est disponible pour la flotte ${opts.fleetName} : le Mode assistance.

Le principe. En cas d'accident, et uniquement avec votre autorisation explicite, le prestataire peut ouvrir brièvement le micro de la cabine du véhicule afin de porter assistance (évaluer la situation, rassurer / guider l'occupant, déclencher les secours).

Aucun enregistrement n'est conservé. Il s'agit d'une écoute en direct uniquement — aucun fichier audio n'est stocké. Seules des métadonnées sont tracées : qui a écouté, quand, quel véhicule, et le motif.

Comment l'activer.
- Rendez-vous dans Réglages → Mode assistance.
- Cochez l'attestation.
- Activez la fonction (possible une fois que le prestataire a rendu votre flotte éligible).

Vos obligations. Le Mode assistance est légalement sensible. Avant tout usage, vous devez :
- Informer les conducteurs et occupants des véhicules concernés.
- Poser la signalétique indiquant la présence d'un dispositif d'écoute.
- Respecter la réglementation applicable (information, AIPD/CNIL, DPO le cas échéant).

La conformité réglementaire reste la responsabilité de l'exploitant. Vizyo fournit l'outil et les garde-fous techniques.

— L'equipe Vizyo`;

    return { subject, html, text };
  }

  /**
   * Charte 2026 — rapport hebdomadaire. Déplacé de ReportsCronService pour passer
   * par le shell(). Renvoie UNIQUEMENT le HTML ; le cron conserve subject / text /
   * pièce jointe PDF (logique métier inchangée). Grille de 4 stats mono.
   */
  buildWeeklyReportEmail(opts: {
    fromStr: string;
    toStr: string;
    tripsCount: number;
    totalKm: number;
    alertsTotal: number;
    liters: number;
    costEur: number;
    pdfName?: string;
  }): string {
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    const km = opts.totalKm.toFixed(1);
    const liters = opts.liters.toFixed(0);
    const cost = opts.costEur.toFixed(2);
    const chip = opts.pdfName
      ? `<table role="presentation"><tr><td style="background:rgba(16,224,160,.1);border:1px solid rgba(16,224,160,.25);border-radius:9px;padding:9px 14px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;color:#10E0A0;">📎 ${escapeHtml(opts.pdfName)} en pièce jointe</td></tr></table>`
      : '';
    return this.shell({
      eyebrow: 'Rapport · Hebdo',
      footer: 'VIZYO TRACKY · RAPPORT AUTOMATIQUE HEBDOMADAIRE<br>Gérez la fréquence depuis Réglages → Rapports.',
      body: `
        <tr><td style="padding:26px 36px 0;">
          <p style="margin:0 0 6px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.06em;color:#69736E;">SEMAINE DU ${escapeHtml(opts.fromStr)} → ${escapeHtml(opts.toStr)}</p>
          <h1 style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Votre semaine en bref</h1>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:10px;margin:0 -10px;">
            <tr>
              <td width="50%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;">
                <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#69736E;margin-bottom:8px;">Trajets</div>
                <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:30px;font-weight:600;color:#EAEFED;">${opts.tripsCount}</div>
              </td>
              <td width="50%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;">
                <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#69736E;margin-bottom:8px;">Distance</div>
                <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:30px;font-weight:600;color:#10E0A0;">${km}<span style="font-size:14px;color:#69736E;"> km</span></div>
              </td>
            </tr>
            <tr>
              <td width="50%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;">
                <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#69736E;margin-bottom:8px;">Alertes</div>
                <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:30px;font-weight:600;color:#F5B33D;">${opts.alertsTotal}</div>
              </td>
              <td width="50%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;padding:16px 18px;">
                <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#69736E;margin-bottom:8px;">Conso estimée</div>
                <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:30px;font-weight:600;color:#EAEFED;">${liters}<span style="font-size:14px;color:#69736E;"> L</span></div>
                <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:12px;color:#69736E;margin-top:3px;">≈ ${cost} €</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 36px 0;">
          ${chip}
          <table role="presentation" style="margin-top:${opts.pdfName ? '20px' : '0'};"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${appBase}/dashboard" style="display:inline-block;padding:14px 30px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Ouvrir le tableau de bord →</a>
          </td></tr></table>
        </td></tr>`,
    });
  }

  /**
   * Charte 2026 — e-mail d'alerte. Déplacé de NotificationDispatchService pour
   * passer par le shell(). Renvoie le HTML ; le dispatch conserve subject / bodyText.
   * Accent conditionnel : escalade OU CRITICAL → rouge, WARNING → ambre, INFO →
   * emerald. Le bouton d'action reste emerald (charte). `plate` déjà résolu par l'appelant.
   */
  /**
   * Saturation du centre d'alerte : « ça se remplit vite ». On donne le CHIFFRE, le seuil qui a
   * été franchi, et surtout les sources responsables — pour savoir où regarder sans ouvrir l'app.
   */
  buildErrorRateAlertEmail(data: {
    total: number;
    critical: number;
    threshold: number;
    top: { source: string; count: number }[];
    since: Date;
  }): string {
    const accent = data.critical > 0 ? '#F2706B' : '#F5B33D';
    const border = data.critical > 0 ? 'rgba(242,112,107,.28)' : 'rgba(245,179,61,.25)';
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    const depuis = data.since.toLocaleString('fr-FR');
    const lignes = data.top
      .map(
        (t, i) => `
            ${i > 0 ? '<tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.06);"></td></tr>' : ''}
            <tr>
              <td style="padding:13px 18px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#69736E;">${escapeHtml(t.source)}</td>
              <td align="right" style="padding:13px 18px;"><span style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:13px;font-weight:600;color:#EAEFED;background:rgba(255,255,255,.05);border-radius:6px;padding:3px 9px;">${t.count}</span></td>
            </tr>`,
      )
      .join('');
    return this.shell({
      eyebrow: `● Centre d'alerte · Seuil dépassé`,
      accent,
      borderColor: border,
      footer: "VIZYO TRACKY · VIGIE DU CENTRE D'ALERTE<br>Une seule alerte par heure, même si les erreurs continuent.",
      body: `
        <tr><td style="padding:26px 36px 0;">
          <h1 style="margin:0 0 6px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#EAEFED;">${data.total} erreurs en une heure</h1>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#9BA5A1;">
            Le seuil de ${data.threshold} erreurs par heure a été franchi${data.critical > 0 ? `, dont <strong style="color:${accent};">${data.critical} critiques</strong>` : ''}.
            Relevé depuis le ${escapeHtml(depuis)}.
          </p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;">${lignes}
          </table>
        </td></tr>
        <tr><td style="padding:22px 36px 0;">
          <a href="${appBase}/admin/observability" style="display:inline-block;background:#10E0A0;color:#04130D;font-family:'Manrope',system-ui,sans-serif;font-size:14px;font-weight:800;text-decoration:none;padding:12px 22px;border-radius:10px;">Ouvrir le centre d'alerte</a>
        </td></tr>`,
    });
  }

  buildAlertEmail(
    alert: { title: string; message: string | null; plate: string; severity: string; createdAt: Date },
    opts: { isEscalation?: boolean } = {},
  ): string {
    const isEsc = opts.isEscalation ?? false;
    const sev = alert.severity;
    const accent = isEsc || sev === 'CRITICAL' ? '#F2706B' : sev === 'WARNING' ? '#F5B33D' : '#10E0A0';
    const border = isEsc || sev === 'CRITICAL' ? 'rgba(242,112,107,.28)' : sev === 'WARNING' ? 'rgba(245,179,61,.25)' : 'rgba(255,255,255,.08)';
    const sevLabel = sev === 'CRITICAL' ? 'Critique' : sev === 'WARNING' ? 'Avertissement' : 'Information';
    const eyebrow = `● ${isEsc ? 'Escalade' : 'Alerte'} · ${sevLabel}`;
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    const heure = alert.createdAt.toLocaleString('fr-FR');
    const messageP = alert.message
      ? `<p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#9BA5A1;">${escapeHtml(alert.message)}</p>`
      : '';
    return this.shell({
      eyebrow,
      accent,
      borderColor: border,
      footer: "VIZYO TRACKY · NOTIFICATION D'ALERTE<br>Réglez vos canaux dans Réglages → Alertes.",
      body: `
        <tr><td style="padding:26px 36px 0;">
          <h1 style="margin:0 0 6px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#EAEFED;">${escapeHtml(alert.title)}</h1>
          ${messageP}
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;">
            <tr>
              <td style="padding:13px 18px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#69736E;">Véhicule</td>
              <td align="right" style="padding:13px 18px;"><span style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:13px;font-weight:600;color:#EAEFED;background:rgba(255,255,255,.05);border-radius:6px;padding:3px 9px;">${escapeHtml(alert.plate || 'N/A')}</span></td>
            </tr>
            <tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.06);"></td></tr>
            <tr>
              <td style="padding:13px 18px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#69736E;">Sévérité</td>
              <td align="right" style="padding:13px 18px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:13px;font-weight:600;color:${accent};">${escapeHtml(sev)}</td>
            </tr>
            <tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.06);"></td></tr>
            <tr>
              <td style="padding:13px 18px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#69736E;">Heure</td>
              <td align="right" style="padding:13px 18px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:13px;color:#9BA5A1;">${escapeHtml(heure)}</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:22px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${appBase}/alerts" style="display:inline-block;padding:14px 30px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Acquitter l'alerte →</a>
          </td></tr></table>
        </td></tr>`,
    });
  }

  /** Ligne « clé / valeur » réutilisable dans une carte détail (charte). */
  private kvRow(key: string, value: string, last = false): string {
    const border = last ? '' : 'border-bottom:1px solid rgba(255,255,255,.06);';
    return `<tr>
      <td style="padding:12px 18px;${border}font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#69736E;white-space:nowrap;">${escapeHtml(key)}</td>
      <td align="right" style="padding:12px 18px;${border}font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;color:#EAEFED;">${escapeHtml(value)}</td>
    </tr>`;
  }

  /**
   * Prise de RDV en ligne — NOTIFICATION OPÉRATEUR (→ contact@vizyoagency.com) quand un
   * client dépose une demande de créneau via un lien public.
   */
  buildInstallationSlotRequestedEmail(opts: {
    companyName: string;
    slotLabel: string;
    clientName: string;
    clientEmail: string;
    clientPhone?: string | null;
    clientAddress?: string | null;
    vehicle?: string | null;
    notes?: string | null;
    manageUrl: string;
  }): { subject: string; html: string; text: string } {
    const subject = `[Vizyo Tracky] Demande de créneau d'installation — ${opts.companyName}`;
    const rows = [
      this.kvRow('Créneau', opts.slotLabel),
      this.kvRow('Client', opts.clientName),
      this.kvRow('E-mail', opts.clientEmail),
      opts.clientPhone ? this.kvRow('Téléphone', opts.clientPhone) : '',
      opts.clientAddress ? this.kvRow('Adresse', opts.clientAddress) : '',
      opts.vehicle ? this.kvRow('Véhicule', opts.vehicle) : '',
    ].filter(Boolean);
    // Dernière ligne sans bordure basse.
    const body = `
        <tr><td style="padding:28px 36px 8px;">
          <h1 style="margin:0 0 6px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:24px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Nouvelle demande de créneau</h1>
          <p style="margin:0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#9BA5A1;">Pour <span style="color:#10E0A0;font-weight:600;">${escapeHtml(opts.companyName)}</span>, à valider.</p>
        </td></tr>
        <tr><td style="padding:18px 36px 0;">
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
          ${opts.notes ? `<p style="margin:16px 0 0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#9BA5A1;"><span style="color:#69736E;">Note du client :</span> ${escapeHtml(opts.notes)}</p>` : ''}
        </td></tr>
        <tr><td style="padding:22px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.manageUrl}" style="display:inline-block;padding:14px 30px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Gérer la demande →</a>
          </td></tr></table>
        </td></tr>`;
    const html = this.shell({
      eyebrow: 'Installation · Demande',
      footer: 'VIZYO TRACKY · PLANIFICATION DES INSTALLATIONS<br>Notification automatique. Répondez au client via son e-mail.',
      body,
    });
    const text = `Nouvelle demande de créneau d'installation — ${opts.companyName}
Créneau : ${opts.slotLabel}
Client : ${opts.clientName} (${opts.clientEmail})${opts.clientPhone ? `\nTéléphone : ${opts.clientPhone}` : ''}${opts.clientAddress ? `\nAdresse : ${opts.clientAddress}` : ''}${opts.vehicle ? `\nVéhicule : ${opts.vehicle}` : ''}${opts.notes ? `\nNote : ${opts.notes}` : ''}

Gérer : ${opts.manageUrl}`;
    return { subject, html, text };
  }

  /**
   * Prise de RDV en ligne — CONFIRMATION CLIENT (→ e-mail du client) quand l'opérateur
   * valide le créneau. Envoyée depuis contact@vizyoagency.com (RESEND_FROM).
   */
  buildInstallationSlotConfirmedEmail(opts: {
    companyName: string;
    slotLabel: string;
    clientName?: string | null;
    address?: string | null;
  }): { subject: string; html: string; text: string } {
    const greeting = opts.clientName ? `Bonjour ${opts.clientName},` : 'Bonjour,';
    const subject = `[Vizyo Tracky] Votre créneau d'installation est confirmé`;
    const rows = [
      this.kvRow('Créneau', opts.slotLabel),
      opts.address ? this.kvRow('Lieu', opts.address) : '',
    ].filter(Boolean);
    const body = `
        <tr><td style="padding:28px 36px 0;">
          <div style="width:46px;height:46px;border-radius:12px;background:rgba(16,224,160,.12);text-align:center;line-height:46px;font-size:22px;margin-bottom:18px;">✅</div>
          <h1 style="margin:0 0 12px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:25px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Votre créneau est confirmé</h1>
          <p style="margin:0 0 6px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">Votre rendez-vous d'installation est bien confirmé. Voici le récapitulatif :</p>
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
          <p style="margin:20px 0 0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#69736E;">Un imprévu ? Répondez à cet e-mail pour convenir d'un autre créneau. À très bientôt.</p>
        </td></tr>`;
    const html = this.shell({
      eyebrow: 'Installation · Confirmation',
      footer: 'VIZYO TRACKY · GPS FLOTTE · OCCITANIE',
      body,
    });
    const text = `${greeting}

Votre créneau d'installation est confirmé.
Créneau : ${opts.slotLabel}${opts.address ? `\nLieu : ${opts.address}` : ''}

Un imprévu ? Répondez à cet e-mail. À bientôt.
— L'équipe Vizyo`;
    return { subject, html, text };
  }

  /**
   * Lien public de réservation — ACCUSÉ DE RÉCEPTION (→ demandeur) quand une demande est déposée.
   * Charte 2026 via shell(). Aucun véhicule exposé (la demande est en attente de validation).
   */
  buildReservationRequestedEmail(opts: {
    fleetName: string;
    slotLabel: string;
    destination?: string | null;
    seats?: number | null;
  }): { subject: string; html: string; text: string } {
    const subject = `[Vizyo Tracky] Votre demande de réservation a bien été reçue`;
    const rows = [
      this.kvRow('Créneau', opts.slotLabel),
      opts.destination ? this.kvRow('Destination', opts.destination) : '',
      opts.seats ? this.kvRow('Places', String(opts.seats)) : '',
    ].filter(Boolean);
    const body = `
        <tr><td style="padding:28px 36px 0;">
          <div style="width:46px;height:46px;border-radius:12px;background:rgba(16,224,160,.12);text-align:center;line-height:46px;font-size:22px;margin-bottom:18px;">📩</div>
          <h1 style="margin:0 0 12px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:25px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Demande bien reçue</h1>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">Bonjour, nous avons bien reçu votre demande de véhicule auprès de <span style="color:#10E0A0;font-weight:600;">${escapeHtml(opts.fleetName)}</span>. Elle est en cours de validation — vous recevrez une confirmation dès qu'un gestionnaire l'aura validée.</p>
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
        </td></tr>`;
    const html = this.shell({ eyebrow: 'Réservation · Demande reçue', footer: 'VIZYO TRACKY · RÉSERVATION DE VÉHICULES', body });
    const text = `Bonjour,

Nous avons bien reçu votre demande de réservation auprès de ${opts.fleetName}.
Créneau : ${opts.slotLabel}${opts.destination ? `\nDestination : ${opts.destination}` : ''}${opts.seats ? `\nPlaces : ${opts.seats}` : ''}

Vous recevrez une confirmation dès qu'elle sera validée.`;
    return { subject, html, text };
  }

  /**
   * Lien public de réservation — CONFIRMATION (→ demandeur) quand un gestionnaire valide. Le véhicule
   * attribué est indiqué (post-validation : le demandeur doit savoir quel véhicule il utilisera).
   */
  buildReservationConfirmedEmail(opts: {
    fleetName: string;
    slotLabel: string;
    destination?: string | null;
    vehicle?: string | null;
  }): { subject: string; html: string; text: string } {
    const subject = `[Vizyo Tracky] Votre réservation est confirmée`;
    const rows = [
      this.kvRow('Créneau', opts.slotLabel),
      opts.destination ? this.kvRow('Destination', opts.destination) : '',
      this.kvRow('Véhicule', opts.vehicle || 'attribué par la société'),
    ].filter(Boolean);
    const body = `
        <tr><td style="padding:28px 36px 0;">
          <div style="width:46px;height:46px;border-radius:12px;background:rgba(16,224,160,.12);text-align:center;line-height:46px;font-size:22px;margin-bottom:18px;">✅</div>
          <h1 style="margin:0 0 12px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:25px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Votre réservation est confirmée</h1>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">Bonjour, votre demande auprès de <span style="color:#10E0A0;font-weight:600;">${escapeHtml(opts.fleetName)}</span> a été <span style="color:#EAEFED;font-weight:600;">validée</span>. Voici le récapitulatif :</p>
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
          <p style="margin:20px 0 0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;line-height:1.6;color:#69736E;">Un imprévu ? Répondez à cet e-mail pour prévenir la société. À très bientôt.</p>
        </td></tr>`;
    const html = this.shell({ eyebrow: 'Réservation · Confirmée', footer: 'VIZYO TRACKY · RÉSERVATION DE VÉHICULES', body });
    const text = `Bonjour,

Votre réservation auprès de ${opts.fleetName} est confirmée.
Créneau : ${opts.slotLabel}${opts.destination ? `\nDestination : ${opts.destination}` : ''}
Véhicule : ${opts.vehicle || 'attribué par la société'}

Un imprévu ? Répondez à cet e-mail. À bientôt.
— L'équipe Vizyo`;
    return { subject, html, text };
  }

  /** Facturation — un fleet-admin demande une FACTURE PHYSIQUE pour l'option IA (→ contact@vizyoagency.com). */
  buildAiInvoiceRequestEmail(opts: {
    fleetName: string;
    requester: string;
    vehicleCount: number;
    monthlyLabel: string;
  }): { subject: string; html: string; text: string } {
    const subject = `Facture physique — Option IA · ${opts.fleetName}`;
    const rows = [
      this.kvRow('Société', opts.fleetName),
      this.kvRow('Demandeur', opts.requester),
      this.kvRow('Véhicules facturables', String(opts.vehicleCount)),
      this.kvRow('Montant estimé', `~${opts.monthlyLabel}/mois`),
    ];
    const body = `
        <tr><td style="padding:28px 36px 0;">
          <div style="width:46px;height:46px;border-radius:12px;background:rgba(16,224,160,.12);text-align:center;line-height:46px;font-size:22px;margin-bottom:18px;">🧾</div>
          <h1 style="margin:0 0 12px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:25px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:#EAEFED;">Demande de facture physique — Option IA</h1>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.65;color:#9BA5A1;">La société <span style="color:#10E0A0;font-weight:600;">${escapeHtml(opts.fleetName)}</span> souhaite activer l'<span style="color:#EAEFED;font-weight:600;">option IA</span> par <span style="color:#EAEFED;font-weight:600;">facture physique</span>. Émettez la facture puis activez l'IA de la société depuis l'espace admin (page Coûts IA).</p>
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:12px;border-collapse:separate;">
            ${rows.join('')}
          </table>
        </td></tr>`;
    const html = this.shell({ eyebrow: 'Facturation · Option IA', footer: 'VIZYO TRACKY · FACTURATION', body });
    const text = `Demande de facture physique — Option IA
Société : ${opts.fleetName}
Demandeur : ${opts.requester}
Véhicules facturables : ${opts.vehicleCount}
Montant estimé : ~${opts.monthlyLabel}/mois

Émettez la facture puis activez l'IA de la société depuis l'espace admin (page Coûts IA).`;
    return { subject, html, text };
  }

  /**
   * Signature commerciale PERSONNELLE (charte) — bloc `<tr><td>` réutilisé dans
   * les e-mails prospects pour un ton humain (« un vrai commercial », pas un
   * robot ni « l'équipe »). Une identité + un contact direct : les gens
   * répondent mieux à une personne. `contactEmail`/`whatsappUrl`/`phone` sont
   * les coordonnées Vizyo (RESEND_FROM = contact@vizyoagency.com).
   */
  private commercialSignature(): string {
    const sans = "'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif";
    // Signature sobre, comme au bas d'un vrai e-mail personnel : pas d'avatar ni
    // de boutons — juste un nom et un contact direct.
    return `
      <tr><td style="padding:22px 36px 0;">
        <p style="margin:0;font-family:${sans};font-size:15px;line-height:1.75;color:#C7CFCB;">Bien à vous,</p>
        <p style="margin:0;font-family:${sans};font-size:15px;line-height:1.75;color:#EAEFED;font-weight:700;">Y. Haddou</p>
        <p style="margin:0;font-family:${sans};font-size:14.5px;line-height:1.75;color:#9BA5A1;">Vizyo Tracky</p>
        <p style="margin:0;font-family:${sans};font-size:14.5px;line-height:1.75;color:#9BA5A1;">06&nbsp;52&nbsp;07&nbsp;70&nbsp;38 &nbsp;—&nbsp; tél &amp; WhatsApp &nbsp;·&nbsp; <a href="mailto:contact@vizyoagency.com" style="color:#10E0A0;text-decoration:none;">contact@vizyoagency.com</a></p>
      </td></tr>`;
  }

  private commercialSignatureText(): string {
    return `Bien à vous,

Y. Haddou
Vizyo Tracky · votre interlocuteur dédié
WhatsApp / Tél : 06 52 07 70 38
E-mail : contact@vizyoagency.com`;
  }

  /** Carte « récap devis » (le texte du simulateur, sauts de ligne préservés). */
  private quoteRecapCard(quoteText: string): string {
    const inner = escapeHtml(quoteText).replace(/\n/g, '<br>');
    return `<div style="padding:16px 18px;background:#0C110F;border:1px solid rgba(16,224,160,.18);border-radius:12px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:12.5px;line-height:1.75;color:#9BA5A1;">${inner}</div>`;
  }

  /**
   * Suivi commercial — e-mail de BIENVENUE au PROSPECT (→ son e-mail) dès qu'il
   * remplit un formulaire de demande sur la LP. Ton PERSONNEL (signé Y. Haddou),
   * comme un commercial qui prend en main le dossier. Présentation vidéo (hub
   * privé) + 3 univers + configuration devis en soft (sans brusquer) + signature.
   */
  buildLeadWelcomeEmail(opts: {
    recipientName?: string | null;
    hubUrl: string;
    tarifsUrl: string;
    ficheUrl: string;
  }): { subject: string; html: string; text: string } {
    const firstName = (opts.recipientName || '').trim().split(/\s+/)[0] || '';
    const greeting = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
    const subject = 'Votre présentation Vizyo Tracky — et mes coordonnées';
    const sans = "'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif";

    const html = this.shell({
      eyebrow: 'Vizyo Tracky',
      footer: 'VIZYO TRACKY · GPS &amp; GESTION DE FLOTTE · OCCITANIE<br>Vous recevez cet e-mail suite à votre demande sur tracky.vizyoagency.com.',
      body: `
        <tr><td style="padding:30px 36px 0;">
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#C7CFCB;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#C7CFCB;">Merci de m'avoir contacté via le site. Je suis Y. Haddou, et c'est moi qui vais suivre votre demande — personnellement, pas un service automatique.</p>
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#C7CFCB;">Pour que vous vous fassiez une idée concrète de ce que nous faisons, j'ai réuni une courte présentation de nos services en vidéo. Vous la regardez tranquillement, quand vous avez un moment&nbsp;: <a href="${opts.hubUrl}" style="color:#10E0A0;text-decoration:none;font-weight:600;">c'est par ici</a>. Vous y verrez l'essentiel — la supervision de votre flotte en temps réel (carte live, alertes, coupe-circuit antivol), l'analyse des trajets et des coûts (rapports, économies de carburant), et toute la gestion au quotidien&nbsp;: comptes, permissions, installation partout en France.</p>
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#C7CFCB;">Dès que vous aurez une idée du nombre de véhicules à équiper, vous pouvez <a href="${opts.tarifsUrl}" style="color:#10E0A0;text-decoration:none;font-weight:600;">estimer votre tarif et configurer un devis en ligne</a>, sans le moindre engagement. Cela dit, le plus simple reste souvent d'en discuter de vive voix — dites-moi ce qui vous arrange, je m'adapte à votre rythme.</p>
          <p style="margin:0;font-family:${sans};font-size:15px;line-height:1.75;color:#C7CFCB;">Une question, un doute, une contrainte particulière&nbsp;? Répondez simplement à cet e-mail, ou appelez-moi. Je m'en occupe.</p>
        </td></tr>
        ${this.commercialSignature()}`,
    });

    const text = `${greeting}

Merci de m'avoir contacté via le site. Je suis Y. Haddou, et c'est moi qui vais suivre votre demande — personnellement, pas un service automatique.

Pour que vous vous fassiez une idée concrète de ce que nous faisons, j'ai réuni une courte présentation de nos services en vidéo, à regarder tranquillement quand vous avez un moment :
${opts.hubUrl}

Vous y verrez l'essentiel : la supervision de votre flotte en temps réel (carte live, alertes, coupe-circuit antivol), l'analyse des trajets et des coûts (rapports, économies de carburant), et toute la gestion au quotidien (comptes, permissions, installation partout en France).

Dès que vous aurez une idée du nombre de véhicules à équiper, vous pouvez estimer votre tarif et configurer un devis en ligne, sans le moindre engagement :
${opts.tarifsUrl}

Cela dit, le plus simple reste souvent d'en discuter de vive voix — dites-moi ce qui vous arrange. Si vous préférez un document, la fiche produit est là : ${opts.ficheUrl}

Une question, un doute ? Répondez simplement à cet e-mail, ou appelez-moi. Je m'en occupe.

${this.commercialSignatureText()}`;

    return { subject, html, text };
  }

  /**
   * Devis signé en ligne — NOTIFICATION ADMIN (→ contact@vizyoagency.com) quand un
   * prospect valide « bon pour accord » un devis auto-configuré sur la page Tarifs.
   * Reprend le récap exact du simulateur pour retraiter/finaliser rapidement.
   */
  buildQuoteSignedAdminEmail(opts: {
    name: string;
    email: string;
    phone?: string | null;
    company?: string | null;
    fleetSize?: string | null;
    quoteText: string;
    managerUrl: string;
  }): { subject: string; html: string; text: string } {
    const sans = "'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif";
    const subject = `Devis signé en ligne — ${opts.company || opts.name}${opts.fleetSize ? ` (${opts.fleetSize})` : ''}`;
    const rows = [
      this.kvRow('Nom', opts.name),
      this.kvRow('E-mail', opts.email),
      opts.phone ? this.kvRow('Téléphone', opts.phone) : '',
      opts.company ? this.kvRow('Société', opts.company) : '',
      opts.fleetSize ? this.kvRow('Flotte', opts.fleetSize, true) : '',
    ].filter(Boolean);
    const html = this.shell({
      eyebrow: 'Devis signé · Prospect',
      footer: 'VIZYO TRACKY · NOTIFICATION INTERNE · DEVIS',
      body: `
        <tr><td style="padding:26px 36px 0;">
          <div style="display:inline-block;padding:5px 12px;border-radius:999px;background:rgba(16,224,160,.12);font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:10.5px;letter-spacing:0.08em;text-transform:uppercase;color:#10E0A0;margin-bottom:12px;">Bon pour accord</div>
          <h1 style="margin:0 0 4px;font-family:${sans};font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#EAEFED;">Devis signé en ligne</h1>
          <p style="margin:0 0 20px;font-family:${sans};font-size:14px;color:#69736E;">Configuré et validé à l'instant via la page Tarifs.</p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;border-collapse:separate;">${rows.join('')}</table>
        </td></tr>
        <tr><td style="padding:16px 36px 0;">
          ${this.quoteRecapCard(opts.quoteText)}
        </td></tr>
        <tr><td style="padding:20px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="${opts.managerUrl}" style="display:inline-block;padding:14px 30px;font-family:${sans};font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Ouvrir Vizyo Manager →</a>
          </td></tr></table>
        </td></tr>`,
    });
    const text = `Devis signé en ligne — ${opts.company || opts.name}

Nom : ${opts.name}
E-mail : ${opts.email}${opts.phone ? `\nTéléphone : ${opts.phone}` : ''}${opts.company ? `\nSociété : ${opts.company}` : ''}${opts.fleetSize ? `\nFlotte : ${opts.fleetSize}` : ''}

${opts.quoteText}

Gérer : ${opts.managerUrl}`;
    return { subject, html, text };
  }

  /**
   * Devis signé en ligne — COPIE CLIENT (→ e-mail du prospect). Ton personnel
   * (signé Y. Haddou) : récap de son devis + « je vous recontacte pour
   * finaliser ». Rassure (indicatif, sans engagement, tarif bloqué).
   */
  buildQuoteClientEmail(opts: {
    recipientName?: string | null;
    quoteText: string;
    tarifsUrl: string;
  }): { subject: string; html: string; text: string } {
    const firstName = (opts.recipientName || '').trim().split(/\s+/)[0] || '';
    const greeting = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
    const subject = 'Votre devis Vizyo Tracky — récapitulatif';
    const sans = "'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif";
    const html = this.shell({
      eyebrow: 'Vizyo Tracky · Votre devis',
      footer: 'VIZYO TRACKY · GPS &amp; GESTION DE FLOTTE · OCCITANIE<br>Devis indicatif sans engagement — tarif bloqué à la souscription.',
      body: `
        <tr><td style="padding:30px 36px 0;">
          <p style="margin:0 0 15px;font-family:${sans};font-size:15px;line-height:1.75;color:#C7CFCB;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 18px;font-family:${sans};font-size:15px;line-height:1.75;color:#C7CFCB;">Merci d'avoir pris le temps de configurer votre devis. Vous en trouverez le récapitulatif juste en dessous. Je le regarde de mon côté et je reviens vers vous très vite pour le finaliser ensemble et répondre à vos questions.</p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          ${this.quoteRecapCard(opts.quoteText)}
          <p style="margin:16px 0 0;font-family:${sans};font-size:14px;line-height:1.7;color:#9BA5A1;">C'est un devis indicatif et sans engagement — le tarif est bloqué à la souscription. Si vous souhaitez ajuster quoi que ce soit, vous pouvez le <a href="${opts.tarifsUrl}" style="color:#10E0A0;text-decoration:none;">reconfigurer en ligne</a> ou simplement me le dire.</p>
        </td></tr>
        ${this.commercialSignature()}`,
    });
    const text = `${greeting}

Merci d'avoir pris le temps de configurer votre devis. Vous en trouverez le récapitulatif ci-dessous. Je le regarde de mon côté et je reviens vers vous très vite pour le finaliser ensemble et répondre à vos questions.

${opts.quoteText}

Ce devis est indicatif et sans engagement — le tarif est bloqué à la souscription.
Reconfigurer en ligne : ${opts.tarifsUrl}

${this.commercialSignatureText()}`;
    return { subject, html, text };
  }

  /**
   * Centre e-mails (admin) — rend un modèle avec des DONNÉES D'EXEMPLE, pour l'aperçu
   * (drawer, via iframe srcdoc) et le bouton « Envoyer un test ». Réutilise les builders
   * existants → aucune duplication du markup des modèles côté front.
   */
  previewTemplate(id: EmailTemplateId): { subject: string; html: string; text: string } {
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    const fleetName = 'Transports Legrand';
    switch (id) {
      case 'invitation':
        return this.buildInvitationEmail({
          recipientName: 'Camille',
          inviterName: 'Julien Marchetti',
          fleetName,
          role: 'Gestionnaire',
          acceptUrl: `${appBase}/accept-invite?token=apercu`,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        });
      case 'password_reset':
        return this.buildPasswordResetEmail({
          recipientName: 'Camille',
          resetUrl: `${appBase}/reset?token=apercu`,
          expiresInMinutes: 30,
        });
      case 'device_verification':
        return this.buildDeviceVerificationEmail({
          recipientName: 'Camille',
          code: '482913',
          expiresInMinutes: 10,
          deviceLabel: 'Chrome · Windows',
        });
      case 'two_factor_disable':
        return this.buildTwoFactorDisableEmail({
          recipientName: 'Camille',
          code: '482913',
          expiresInMinutes: 10,
        });
      case 'audio_activation':
        return this.buildAudioActivationEmail({ fleetName, activatedBy: 'Julien Marchetti' });
      case 'audio_info':
        return this.buildAudioInfoEmail({ recipientName: 'Camille', fleetName });
      case 'installation_slot_requested':
        return this.buildInstallationSlotRequestedEmail({
          companyName: fleetName,
          slotLabel: 'lun. 7 juil., 08:00 – 10:00',
          clientName: 'Camille Bernard',
          clientEmail: 'camille.bernard@example.com',
          clientPhone: '+33 6 12 34 56 78',
          clientAddress: '12 rue des Fleurs, 31000 Toulouse',
          vehicle: 'AB-123-CD · Renault Kangoo · Diesel',
          notes: 'Disponible plutôt le matin.',
          manageUrl: `${appBase}/admin/installation-bookings`,
        });
      case 'installation_slot_confirmed':
        return this.buildInstallationSlotConfirmedEmail({
          companyName: fleetName,
          slotLabel: 'lun. 7 juil., 08:00 – 10:00',
          clientName: 'Camille',
          address: '12 rue des Fleurs, 31000 Toulouse',
        });
      case 'reservation_requested':
        return this.buildReservationRequestedEmail({
          fleetName,
          slotLabel: 'mar. 8 juil., 09:00 → 17:00',
          destination: 'Carcassonne',
          seats: 11,
        });
      case 'reservation_confirmed':
        return this.buildReservationConfirmedEmail({
          fleetName,
          slotLabel: 'mar. 8 juil., 09:00 → 17:00',
          destination: 'Carcassonne',
          vehicle: 'TE-001-ST',
        });
      case 'ai_invoice_request':
        return this.buildAiInvoiceRequestEmail({
          fleetName,
          requester: 'admin@societe.fr',
          vehicleCount: 12,
          monthlyLabel: '60,00 €',
        });
      case 'weekly_report':
        return {
          subject: `[Vizyo Tracky] Rapport hebdomadaire — ${fleetName}`,
          html: this.buildWeeklyReportEmail({
            fromStr: '23/06/2026',
            toStr: '29/06/2026',
            tripsCount: 128,
            totalKm: 2340,
            alertsTotal: 14,
            liters: 287,
            costEur: 458,
            pdfName: 'rapport-semaine.pdf',
          }),
          text: 'Aperçu du rapport hebdomadaire (données d’exemple).',
        };
      case 'error_rate_alert':
        return {
          subject: '[Tracky] 47 erreurs en 1 h (dont 12 critiques)',
          html: this.buildErrorRateAlertEmail({
            total: 47,
            critical: 12,
            threshold: 5,
            top: [
              { source: 'engine-control', count: 21 },
              { source: 'sms-gateway', count: 18 },
              { source: 'gps-integrity', count: 8 },
            ],
            since: new Date(Date.now() - 60 * 60 * 1000),
          }),
          text: "Aperçu de l'alerte de saturation (données d'exemple).",
        };
      case 'alert':
        return {
          subject: '[Tracky] Excès de vitesse détecté — TE-002-ST',
          html: this.buildAlertEmail({
            title: 'Excès de vitesse détecté',
            message: '142 km/h relevés sur une portion limitée à 110 km/h.',
            plate: 'TE-002-ST',
            severity: 'CRITICAL',
            createdAt: new Date(),
          }),
          text: 'Aperçu de l’alerte (données d’exemple).',
        };
      case 'lead':
        return {
          subject: 'Nouveau lead Tracky — SARL Delmas (25 véhicules)',
          html: this.shell({
            eyebrow: 'Lead · Prospect',
            footer: 'VIZYO TRACKY · NOTIFICATION INTERNE · LEADS',
            body: `
              <tr><td style="padding:26px 36px 0;">
                <h1 style="margin:0 0 4px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#EAEFED;">Nouveau prospect</h1>
                <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;color:#69736E;">Reçu à l'instant via la landing page</p>
              </td></tr>
              <tr><td style="padding:0 36px;">
                <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;">
                  <tr><td style="padding:12px 18px;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#69736E;width:110px;">Nom</td><td style="padding:12px 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;color:#EAEFED;">Antoine Delmas</td></tr>
                  <tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.06);"></td></tr>
                  <tr><td style="padding:12px 18px;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#69736E;">Société</td><td style="padding:12px 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;color:#EAEFED;">SARL Delmas · <span style="color:#10E0A0;font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:13px;">25 véhicules</span></td></tr>
                </table>
              </td></tr>`,
          }),
          text: 'Aperçu du lead (données d’exemple).',
        };
      case 'lead_welcome':
        return this.buildLeadWelcomeEmail({
          recipientName: 'Camille Bernard',
          hubUrl: 'https://tracky.vizyoagency.com/decouvrir.html',
          tarifsUrl: 'https://tracky.vizyoagency.com/tarifs.html#simulateur',
          ficheUrl: 'https://tracky.vizyoagency.com/vizyo-tracky.pdf',
        });
      case 'quote_signed':
        return this.buildQuoteSignedAdminEmail({
          name: 'Antoine Delmas',
          email: 'antoine.delmas@example.com',
          phone: '+33 6 12 34 56 78',
          company: 'SARL Delmas',
          fleetSize: '25 véhicules',
          quoteText:
            'DEVIS AUTO-CONFIGURÉ — Tracky Pro (annuel renouvelable (tarif bloqué))\n25 véhicule(s) · Options : Live temps réel (15 s), Agent IA · Rétention : 1 an\nPar véhicule : 44,80 €/mois HT · Mensuel total : 1 120,00 € HT\n1re année (boîtier + install + abo) : 18 165 € · Années suivantes : 13 440 €\nÉconomies estimées : 5 000 – 10 000 €/an\nBon pour accord (devis indicatif, à confirmer par Vizyo).',
          managerUrl: 'https://manager.vizyoagency.com/services/leads',
        });
      case 'quote_client':
        return this.buildQuoteClientEmail({
          recipientName: 'Antoine Delmas',
          tarifsUrl: 'https://tracky.vizyoagency.com/tarifs.html#simulateur',
          quoteText:
            'DEVIS AUTO-CONFIGURÉ — Tracky Pro (annuel renouvelable (tarif bloqué))\n25 véhicule(s) · Options : Live temps réel (15 s), Agent IA · Rétention : 1 an\nPar véhicule : 44,80 €/mois HT · Mensuel total : 1 120,00 € HT\n1re année (boîtier + install + abo) : 18 165 € · Années suivantes : 13 440 €\nÉconomies estimées : 5 000 – 10 000 €/an\nBon pour accord (devis indicatif, à confirmer par Vizyo).',
        });
      default:
        return {
          subject: 'Aperçu',
          html: this.shell({
            eyebrow: 'Aperçu',
            footer: 'VIZYO TRACKY',
            body: `<tr><td style="padding:26px 36px;font-family:'Manrope',system-ui,sans-serif;color:#9BA5A1;">Modèle inconnu.</td></tr>`,
          }),
          text: '',
        };
    }
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
