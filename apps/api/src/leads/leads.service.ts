import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { CreateLeadDto } from './dto/create-lead.dto';

const ADMIN_EMAIL = 'contact@vizyoagency.com';
// Suivi commercial automatisé (e-mails prospect : bienvenue + devis signé).
const VIDEO_HUB_URL = 'https://tracky.vizyoagency.com/decouvrir.html';
const TARIFS_URL = 'https://tracky.vizyoagency.com/tarifs.html#simulateur';
const FICHE_PRODUIT_URL = 'https://tracky.vizyoagency.com/vizyo-tracky.pdf';
const MANAGER_LEADS_URL = 'https://manager.vizyoagency.com/services/leads';
// Marqueur écrit par le simulateur de la LP (vt.js) dans le champ `message`
// quand le prospect valide un devis auto-configuré (« bon pour accord »).
const QUOTE_MARKER = 'DEVIS AUTO-CONFIGURÉ';

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async createLead(dto: CreateLeadDto, ip?: string) {
    // Vérifier re-soumission (même email)
    const existing = await this.prisma.lead.findFirst({
      where: { email: dto.email.toLowerCase() },
      orderBy: { createdAt: 'desc' },
    });

    const isResubmission = !!existing;
    const submissionCount = existing ? existing.submissionCount + 1 : 1;

    let lead;
    if (existing) {
      lead = await this.prisma.lead.update({
        where: { id: existing.id },
        data: {
          name: dto.name,
          phone: dto.phone,
          company: dto.company,
          fleetSize: dto.fleetSize,
          message: dto.message,
          ipAddress: ip,
          submissionCount,
          status: 'NEW',
        },
      });
    } else {
      lead = await this.prisma.lead.create({
        data: {
          name: dto.name,
          email: dto.email.toLowerCase(),
          phone: dto.phone,
          company: dto.company,
          fleetSize: dto.fleetSize,
          message: dto.message,
          ipAddress: ip,
          source: 'lp',
        },
      });
    }

    // Un devis signé en ligne = message rempli par le simulateur (« bon pour
    // accord »). On adapte alors les deux e-mails (admin + client).
    const isQuote = (lead.message ?? '').includes(QUOTE_MARKER);

    // ── NOTIFICATION ADMIN (→ contact@vizyoagency.com) ──
    if (isQuote) {
      const q = this.email.buildQuoteSignedAdminEmail({
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        company: lead.company,
        fleetSize: lead.fleetSize,
        quoteText: lead.message ?? '',
        managerUrl: MANAGER_LEADS_URL,
      });
      const prefix = isResubmission ? `[Re-soumission #${submissionCount}] ` : '';
      const r = await this.email.send({ to: ADMIN_EMAIL, subject: prefix + q.subject, html: q.html, text: q.text, template: 'quote_signed' });
      if (!r.ok) this.logger.warn(`Failed to send quote-signed notification: ${r.error}`);
    } else {
      const subjectPrefix = isResubmission ? `[Re-soumission #${submissionCount}] ` : '';
      const subject = `${subjectPrefix}Nouveau lead Tracky — ${dto.company || dto.name}${dto.fleetSize ? ` (${dto.fleetSize} vehicules)` : ''}`;
      const { html, text } = this.buildLeadNotificationEmail(lead, isResubmission, submissionCount);
      const result = await this.email.send({ to: ADMIN_EMAIL, subject, html, text, template: 'lead' });
      if (!result.ok) this.logger.warn(`Failed to send lead notification: ${result.error}`);
    }

    // ── COPIE / SUIVI CLIENT (→ e-mail du prospect) ──
    // Devis : copie du récap à CHAQUE soumission (action délibérée). Contact
    // simple : e-mail de bienvenue à la 1re demande uniquement (anti-spam).
    // Best-effort : un échec d'envoi ne DOIT jamais faire échouer le lead.
    try {
      if (isQuote) {
        const c = this.email.buildQuoteClientEmail({
          recipientName: lead.name,
          quoteText: lead.message ?? '',
          tarifsUrl: TARIFS_URL,
        });
        const cr = await this.email.send({ to: lead.email, subject: c.subject, html: c.html, text: c.text, template: 'quote_client' });
        if (!cr.ok) this.logger.warn(`Failed to send quote client copy: ${cr.error}`);
      } else if (!isResubmission) {
        const welcome = this.email.buildLeadWelcomeEmail({
          recipientName: lead.name,
          hubUrl: VIDEO_HUB_URL,
          tarifsUrl: TARIFS_URL,
          ficheUrl: FICHE_PRODUIT_URL,
        });
        const wr = await this.email.send({ to: lead.email, subject: welcome.subject, html: welcome.html, text: welcome.text, template: 'lead_welcome' });
        if (!wr.ok) this.logger.warn(`Failed to send lead welcome email: ${wr.error}`);
      }
    } catch (e) {
      this.logger.warn(`Client follow-up email threw: ${String(e)}`);
    }

    return { ok: true, leadId: lead.id, isResubmission };
  }

  private buildLeadNotificationEmail(
    lead: { name: string; email: string; phone?: string | null; company?: string | null; fleetSize?: string | null; message?: string | null },
    isResubmission: boolean,
    submissionCount: number,
  ) {
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Rangées de contact (mono label + valeur Manrope), séparées par un filet.
    const sep = `<tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.06);"></td></tr>`;
    const labelStyle = `padding:12px 18px;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#69736E;width:110px;vertical-align:top;`;
    const valStyle = `padding:12px 18px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;color:#EAEFED;`;
    const rows: string[] = [
      `<tr><td style="${labelStyle}">Nom</td><td style="${valStyle}">${escHtml(lead.name)}</td></tr>`,
      `<tr><td style="${labelStyle}">E-mail</td><td style="padding:12px 18px;font-size:14px;"><a href="mailto:${lead.email}" style="color:#10E0A0;text-decoration:none;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;">${escHtml(lead.email)}</a></td></tr>`,
    ];
    if (lead.phone) {
      rows.push(`<tr><td style="${labelStyle}">Téléphone</td><td style="${valStyle}"><a href="tel:${escHtml(lead.phone)}" style="color:#EAEFED;text-decoration:none;">${escHtml(lead.phone)}</a></td></tr>`);
    }
    if (lead.company || lead.fleetSize) {
      const parts: string[] = [];
      if (lead.company) parts.push(escHtml(lead.company));
      if (lead.fleetSize) parts.push(`<span style="color:#10E0A0;font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:13px;">${escHtml(lead.fleetSize)} véhicules</span>`);
      rows.push(`<tr><td style="${labelStyle}">Société</td><td style="${valStyle}">${parts.join(' · ')}</td></tr>`);
    }
    const contactTable = rows.join(sep);

    const messageBlock = lead.message
      ? `<div style="margin-top:12px;padding:14px 16px;background:#0C110F;border:1px solid rgba(255,255,255,.06);border-radius:11px;">
            <div style="font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#565f5b;margin-bottom:6px;">Message</div>
            <p style="margin:0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#9BA5A1;">${escHtml(lead.message)}</p>
          </div>`
      : '';

    const resubBanner = isResubmission
      ? `<tr><td style="padding:22px 36px 0;">
            <div style="padding:11px 15px;background:rgba(245,179,61,.1);border:1px solid rgba(245,179,61,.3);border-radius:11px;">
              <p style="margin:0;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;font-weight:600;color:#F5B33D;">Re-soumission #${submissionCount} — ce prospect a déjà soumis le formulaire.</p>
            </div>
          </td></tr>`
      : '';

    const html = this.email.shell({
      eyebrow: 'Lead · Prospect',
      footer: 'VIZYO TRACKY · NOTIFICATION INTERNE · LEADS',
      body: `
        ${resubBanner}
        <tr><td style="padding:26px 36px 0;">
          <h1 style="margin:0 0 4px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.02em;color:#EAEFED;">Nouveau prospect</h1>
          <p style="margin:0 0 20px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;color:#69736E;">Reçu à l'instant via la landing page</p>
        </td></tr>
        <tr><td style="padding:0 36px;">
          <table role="presentation" width="100%" style="background:#161D1B;border:1px solid rgba(255,255,255,.07);border-radius:13px;">${contactTable}</table>
          ${messageBlock}
        </td></tr>
        <tr><td style="padding:20px 36px 0;">
          <table role="presentation"><tr><td style="border-radius:11px;background:#10E0A0;">
            <a href="https://manager.vizyoagency.com/services/leads" style="display:inline-block;padding:14px 30px;font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#04130D;text-decoration:none;">Ouvrir Vizyo Manager →</a>
          </td></tr></table>
        </td></tr>`,
    });

    const text = `Nouveau lead Tracky${isResubmission ? ` (Re-soumission #${submissionCount})` : ''}

Nom: ${lead.name}
Email: ${lead.email}
${lead.phone ? `Tel: ${lead.phone}\n` : ''}${lead.company ? `Societe: ${lead.company}\n` : ''}${lead.fleetSize ? `Flotte: ${lead.fleetSize} vehicules\n` : ''}${lead.message ? `\nMessage:\n${lead.message}\n` : ''}
— Vizyo Tracky LP`;

    return { html, text };
  }
}
