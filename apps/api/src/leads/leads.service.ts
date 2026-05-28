import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { CreateLeadDto } from './dto/create-lead.dto';

const ADMIN_EMAIL = 'contact@vizyoagency.com';

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

    // Envoyer email de notification à l'admin
    const subjectPrefix = isResubmission ? `[Re-soumission #${submissionCount}] ` : '';
    const subject = `${subjectPrefix}Nouveau lead Tracky — ${dto.company || dto.name}${dto.fleetSize ? ` (${dto.fleetSize} vehicules)` : ''}`;

    const { html, text } = this.buildLeadNotificationEmail(lead, isResubmission, submissionCount);
    const result = await this.email.send({ to: ADMIN_EMAIL, subject, html, text });

    if (!result.ok) {
      this.logger.warn(`Failed to send lead notification: ${result.error}`);
    }

    return { ok: true, leadId: lead.id, isResubmission };
  }

  private buildLeadNotificationEmail(
    lead: { name: string; email: string; phone?: string | null; company?: string | null; fleetSize?: string | null; message?: string | null },
    isResubmission: boolean,
    submissionCount: number,
  ) {
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const resubBanner = isResubmission
      ? `<tr><td style="padding:12px 32px;background:#3b2f00;border-bottom:1px solid #5a4800;">
           <p style="margin:0;font-size:13px;font-weight:600;color:#fbbf24;">Re-soumission #${submissionCount} — Ce prospect a deja soumis le formulaire.</p>
         </td></tr>`
      : '';

    const row = (label: string, value: string | null | undefined, href?: string) => {
      if (!value) return '';
      const val = href
        ? `<a href="${href}" style="color:#10e0a0;text-decoration:none;">${escHtml(value)}</a>`
        : `<span style="color:#f4f4f5;">${escHtml(value)}</span>`;
      return `<tr>
        <td style="padding:8px 0;font-size:13px;color:#8b939c;width:120px;vertical-align:top;">${label}</td>
        <td style="padding:8px 0;font-size:14px;">${val}</td>
      </tr>`;
    };

    const html = `<!DOCTYPE html>
<html lang="fr">
<body style="margin:0;padding:0;background:#0b0f12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#f4f4f5;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0b0f12;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#13181d;border:1px solid #2a3036;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 32px 0 32px;">
          <div style="font-size:24px;font-weight:700;color:#10e0a0;letter-spacing:-0.5px;">Vizyo Tracky</div>
          <p style="margin:8px 0 0;font-size:12px;color:#6b727a;text-transform:uppercase;letter-spacing:0.1em;">Nouveau prospect</p>
        </td></tr>
        ${resubBanner}
        <tr><td style="padding:24px 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${row('Nom', lead.name)}
            ${row('Email', lead.email, `mailto:${lead.email}`)}
            ${row('Telephone', lead.phone, lead.phone ? `tel:${lead.phone}` : undefined)}
            ${row('Societe', lead.company)}
            ${row('Flotte', lead.fleetSize ? `${lead.fleetSize} vehicules` : null)}
          </table>
          ${lead.message ? `<div style="margin-top:16px;padding:14px;background:#1a1f25;border:1px solid #2a3036;border-radius:8px;">
            <p style="margin:0 0 6px;font-size:11px;color:#6b727a;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">Message</p>
            <p style="margin:0;font-size:14px;line-height:1.6;color:#cbd2d9;">${escHtml(lead.message)}</p>
          </div>` : ''}
          <div style="margin-top:24px;text-align:center;">
            <a href="https://manager.vizyoagency.com/services/leads" style="display:block;background:#10e0a0;color:#0b0f12;text-decoration:none;font-weight:700;font-size:14px;padding:14px 32px;border-radius:10px;text-align:center;">
              Ouvrir Vizyo Manager
            </a>
            <p style="margin:10px 0 0;font-size:11px;color:#6b727a;">Connectez-vous pour acceder au dashboard Leads</p>
          </div>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#6b727a;">— Vizyo Tracky LP</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const text = `Nouveau lead Tracky${isResubmission ? ` (Re-soumission #${submissionCount})` : ''}

Nom: ${lead.name}
Email: ${lead.email}
${lead.phone ? `Tel: ${lead.phone}\n` : ''}${lead.company ? `Societe: ${lead.company}\n` : ''}${lead.fleetSize ? `Flotte: ${lead.fleetSize} vehicules\n` : ''}${lead.message ? `\nMessage:\n${lead.message}\n` : ''}
— Vizyo Tracky LP`;

    return { html, text };
  }
}
