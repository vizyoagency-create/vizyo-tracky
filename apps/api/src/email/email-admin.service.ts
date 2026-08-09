import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailStatus, Prisma } from '@prisma/client';
import { Resend } from 'resend';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService, type EmailTemplateId } from './email.service';

/** Métadonnées statiques des modèles (le reste vient de l'agrégation EmailLog).
 *  DOIT rester aligné sur EmailTemplateId : tout modèle réellement envoyé doit y
 *  figurer, sinon il apparaît « brut » (id sans libellé) dans le centre e-mails et
 *  n'est ni prévisualisable ni testable. */
export const TEMPLATE_META: {
  id: EmailTemplateId;
  label: string;
  category: string;
  subject: string;
  trigger: string;
  /** true = pas de pixel d'ouverture (e-mail de sécurité) → openRate affiché « — ». */
  noOpenTracking?: boolean;
}[] = [
  { id: 'error_rate_alert', label: "Saturation du centre d'alerte", category: 'Supervision', subject: '{n} erreurs en 1 h (dont {n} critiques)', trigger: "Plus de 5 erreurs enregistrées sur l'heure glissante (vérifié toutes les 10 min, 1 e-mail/h max)" },
  { id: 'invitation', label: 'Invitation', category: 'Accès', subject: 'Vous êtes invité à rejoindre {flotte}', trigger: 'Un admin invite un membre' },
  { id: 'password_reset', label: 'Réinitialisation MDP', category: 'Sécurité', subject: 'Réinitialisation de votre mot de passe', trigger: 'Demande « mot de passe oublié »', noOpenTracking: true },
  { id: 'device_verification', label: 'Code nouvel appareil', category: 'Sécurité', subject: 'Votre code de connexion : {code}', trigger: 'Connexion depuis un appareil non reconnu (2FA)', noOpenTracking: true },
  { id: 'two_factor_disable', label: 'Désactivation 2FA', category: 'Sécurité', subject: 'Code pour désactiver la double authentification : {code}', trigger: 'Demande de désactivation du 2FA', noOpenTracking: true },
  { id: 'weekly_report', label: 'Rapport hebdomadaire', category: 'Rapport', subject: 'Rapport hebdomadaire — {flotte}', trigger: 'Cron · lundi 08:00' },
  { id: 'alert', label: 'Alerte véhicule', category: 'Alerte', subject: '[Tracky] {alerte} — {plaque}', trigger: 'Alerte temps réel' },
  { id: 'lead', label: 'Nouveau lead', category: 'Interne', subject: 'Nouveau lead Tracky — {société}', trigger: 'Formulaire landing page' },
  { id: 'lead_welcome', label: 'Bienvenue prospect', category: 'Commercial', subject: 'Votre présentation Vizyo Tracky — et mes coordonnées', trigger: '1re demande d\'un prospect (landing page)' },
  { id: 'quote_signed', label: 'Devis signé (interne)', category: 'Interne', subject: 'Devis signé en ligne — {société}', trigger: 'Un prospect valide « bon pour accord »' },
  { id: 'quote_client', label: 'Copie devis client', category: 'Commercial', subject: 'Votre devis Vizyo Tracky — récapitulatif', trigger: 'Copie envoyée au prospect à la signature' },
  { id: 'audio_activation', label: 'Écoute audio activée', category: 'Conformité', subject: 'Écoute audio activée — obligations', trigger: 'Activation micro embarqué' },
  { id: 'audio_info', label: 'Mode assistance', category: 'Nouveauté', subject: 'Nouvelle fonction « Mode assistance »', trigger: 'Présentation par le prestataire' },
  { id: 'installation_slot_requested', label: 'Demande de créneau', category: 'Installation', subject: 'Demande de créneau d\'installation — {flotte}', trigger: 'Client réserve via un lien public' },
  { id: 'installation_slot_confirmed', label: 'Créneau confirmé', category: 'Installation', subject: 'Votre créneau d\'installation est confirmé', trigger: 'L\'opérateur valide la demande' },
  { id: 'reservation_requested', label: 'Demande de réservation reçue', category: 'Réservation', subject: 'Votre demande de réservation a bien été reçue', trigger: 'Un demandeur soumet via un lien public' },
  { id: 'reservation_confirmed', label: 'Réservation confirmée', category: 'Réservation', subject: 'Votre réservation est confirmée', trigger: 'Un gestionnaire valide la demande' },
  { id: 'ai_invoice_request', label: 'Facture physique — Option IA', category: 'Facturation', subject: 'Facture physique — Option IA · {société}', trigger: 'Un fleet-admin demande une facture physique pour l\'option IA' },
  { id: 'partner_consent_invitation', label: 'Invitation à consentir', category: 'Intégration', subject: 'Autoriser le partage avec {partenaire}', trigger: 'Un super-admin invite un fleet-admin à autoriser le partage vers une application partenaire' },
  { id: 'mission_assigned', label: 'Livraison assignée', category: 'Espace dépôt', subject: 'Livraison prévue {jour} {début} → {fin}', trigger: 'Un gestionnaire crée une mission en désignant un compte dépôt destinataire' },
];
const TEMPLATE_IDS = new Set(TEMPLATE_META.map((t) => t.id));
const TEMPLATE_LABELS = new Map(TEMPLATE_META.map((t) => [t.id as string, t.label]));

const DELIVERED_STATES: EmailStatus[] = [EmailStatus.DELIVERED, EmailStatus.OPENED, EmailStatus.CLICKED];
const OPENED_STATES: EmailStatus[] = [EmailStatus.OPENED, EmailStatus.CLICKED];
const FAILED_STATES: EmailStatus[] = [EmailStatus.BOUNCED, EmailStatus.FAILED, EmailStatus.COMPLAINED];
const DAY_MS = 86_400_000;

export interface EmailLogDto {
  id: string;
  providerId: string | null;
  template: string;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  fleetId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  openedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class EmailAdminService {
  private readonly logger = new Logger(EmailAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** KPI + séries pour l'onglet Suivi. */
  async stats(rangeDays = 30) {
    const since = new Date(Date.now() - rangeDays * DAY_MS);
    const since24h = new Date(Date.now() - DAY_MS);
    const logs = await this.prisma.emailLog.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, template: true, toAddress: true, createdAt: true },
    });

    const sent = logs.length;
    const delivered = logs.filter((l) => DELIVERED_STATES.includes(l.status)).length;
    // Taux d'ouverture : hors password_reset (pas de pixel, RGPD sécurité).
    const trackable = logs.filter((l) => l.template !== 'password_reset');
    const trackableDelivered = trackable.filter((l) => DELIVERED_STATES.includes(l.status)).length;
    const opened = trackable.filter((l) => OPENED_STATES.includes(l.status)).length;
    const failed24h = logs.filter((l) => FAILED_STATES.includes(l.status) && l.createdAt >= since24h).length;
    const suppressed = new Set(
      logs.filter((l) => l.status === EmailStatus.BOUNCED || l.status === EmailStatus.COMPLAINED).map((l) => l.toAddress),
    ).size;

    const counts = new Map<string, number>();
    for (const l of logs) counts.set(l.template, (counts.get(l.template) ?? 0) + 1);
    const byTemplate = [...counts.entries()]
      .map(([template, count]) => ({ template, label: TEMPLATE_LABELS.get(template) ?? template, count }))
      .sort((a, b) => b.count - a.count);

    return {
      sent,
      deliveredRate: sent ? Math.round((delivered / sent) * 100) : 0,
      openRate: trackableDelivered ? Math.round((opened / trackableDelivered) * 100) : 0,
      failed24h,
      suppressed,
      series: this.buildSeries(logs, 14),
      byTemplate,
    };
  }

  /** Histogramme empilé délivré/échec sur N jours. */
  private buildSeries(logs: { status: EmailStatus; createdAt: Date }[], days: number) {
    const now = new Date();
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const out: { day: string; delivered: number; failed: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = startOfDay(new Date(now.getTime() - i * DAY_MS));
      const dayEnd = dayStart + DAY_MS;
      const dayLogs = logs.filter((l) => l.createdAt.getTime() >= dayStart && l.createdAt.getTime() < dayEnd);
      out.push({
        day: new Date(dayStart).toISOString().slice(0, 10),
        delivered: dayLogs.filter((l) => DELIVERED_STATES.includes(l.status)).length,
        failed: dayLogs.filter((l) => FAILED_STATES.includes(l.status)).length,
      });
    }
    return out;
  }

  /** Page de logs (tri desc, filtres optionnels, pagination cursor). */
  async logs(params: { status?: string; template?: string; q?: string; cursor?: string; limit?: number }) {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const where: Prisma.EmailLogWhereInput = {};
    if (params.status && Object.prototype.hasOwnProperty.call(EmailStatus, params.status)) {
      where.status = params.status as EmailStatus;
    }
    if (params.template) where.template = params.template;
    if (params.q) {
      const q = params.q.trim();
      where.OR = [
        { toAddress: { contains: q, mode: 'insensitive' } },
        { fleetId: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.emailLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((l) => this.toDto(l)),
      nextCursor: hasMore ? page[page.length - 1]!.id : undefined,
    };
  }

  private toDto(l: {
    id: string; providerId: string | null; template: string; toAddress: string; subject: string;
    status: EmailStatus; fleetId: string | null; errorCode: string | null; errorMessage: string | null;
    openedAt: Date | null; createdAt: Date;
  }): EmailLogDto {
    return {
      id: l.id,
      providerId: l.providerId,
      template: l.template,
      toAddress: l.toAddress,
      subject: l.subject,
      status: l.status,
      fleetId: l.fleetId,
      errorCode: l.errorCode,
      errorMessage: l.errorMessage,
      openedAt: l.openedAt,
      createdAt: l.createdAt,
    };
  }

  /** Métadonnées des modèles + agrégats 30 j (volume, taux d'ouverture, dernier envoi). */
  async templates() {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const logs = await this.prisma.emailLog.findMany({
      where: { createdAt: { gte: since } },
      select: { template: true, status: true, createdAt: true },
    });
    const agg = new Map<string, { count: number; delivered: number; opened: number; last: Date | null }>();
    for (const l of logs) {
      const e = agg.get(l.template) ?? { count: 0, delivered: 0, opened: 0, last: null };
      e.count++;
      if (DELIVERED_STATES.includes(l.status)) e.delivered++;
      if (OPENED_STATES.includes(l.status)) e.opened++;
      if (!e.last || l.createdAt > e.last) e.last = l.createdAt;
      agg.set(l.template, e);
    }
    return TEMPLATE_META.map((m) => {
      const a = agg.get(m.id);
      return {
        id: m.id,
        label: m.label,
        category: m.category,
        subject: m.subject,
        trigger: m.trigger,
        sent30d: a?.count ?? 0,
        openRate: m.noOpenTracking ? null : a && a.delivered ? Math.round((a.opened / a.delivered) * 100) : 0,
        lastSentAt: a?.last ?? null,
      };
    });
  }

  /** Santé délivrabilité : auth domaine (Resend, best-effort) + bounces + suppression (EmailLog). */
  async deliverability() {
    const from = this.config.get('RESEND_FROM', { infer: true });
    // Gère aussi le format « Nom <addr@domaine> » (extrait le domaine sans le « > »).
    const domain = from.match(/@([^>\s]+)/)?.[1] ?? from;

    let verified = false;
    let spf: 'pass' | 'fail' = 'fail';
    let dkim: 'pass' | 'fail' = 'fail';
    let dmarc: 'pass' | 'warn' | 'fail' = 'warn';
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    if (apiKey) {
      try {
        const res = await new Resend(apiKey).domains.list();
        const list = ((res as { data?: unknown })?.data ?? []) as Array<{ name?: string; status?: string }> | { data?: Array<{ name?: string; status?: string }> };
        const arr = Array.isArray(list) ? list : (list.data ?? []);
        const match = arr.find((d) => d.name === domain);
        if (match?.status === 'verified') {
          verified = true;
          spf = 'pass';
          dkim = 'pass';
          dmarc = 'warn'; // Resend ne gère pas DMARC — à configurer côté DNS.
        }
      } catch (e) {
        this.logger.warn(`Resend domains lookup failed (délivrabilité dégradée): ${String(e)}`);
      }
    }

    const since = new Date(Date.now() - 30 * DAY_MS);
    const bounces = await this.prisma.emailLog.findMany({
      where: { status: { in: [EmailStatus.BOUNCED, EmailStatus.FAILED] }, createdAt: { gte: since } },
      select: { errorCode: true, errorMessage: true },
    });
    const reasons = new Map<string, { count: number; desc: string }>();
    for (const b of bounces) {
      const code = b.errorCode ?? 'unknown';
      const e = reasons.get(code) ?? { count: 0, desc: b.errorMessage ?? '' };
      e.count++;
      if (!e.desc && b.errorMessage) e.desc = b.errorMessage;
      reasons.set(code, e);
    }
    const bounceReasons = [...reasons.entries()]
      .map(([code, v]) => ({ code, label: code, desc: v.desc, count: v.count }))
      .sort((a, b) => b.count - a.count);

    const suppressedRows = await this.prisma.emailLog.findMany({
      where: { status: { in: [EmailStatus.BOUNCED, EmailStatus.COMPLAINED] } },
      orderBy: { createdAt: 'desc' },
      select: { toAddress: true, status: true, createdAt: true },
      take: 300,
    });
    const seen = new Set<string>();
    const suppression: { email: string; reason: string; date: string }[] = [];
    for (const s of suppressedRows) {
      if (seen.has(s.toAddress)) continue;
      seen.add(s.toAddress);
      suppression.push({
        email: s.toAddress,
        reason: s.status === EmailStatus.COMPLAINED ? 'Plainte (spam)' : 'Rejet (bounce)',
        date: s.createdAt.toISOString(),
      });
    }

    return { domain, verified, spf, dkim, dmarc, bounceReasons, suppression };
  }

  /** Aperçu HTML d'un modèle (données d'exemple) pour l'iframe du drawer. */
  preview(id: string): { subject: string; html: string } {
    const tid = this.assertTemplate(id);
    const tpl = this.email.previewTemplate(tid);
    return { subject: tpl.subject, html: tpl.html };
  }

  /** Envoie un e-mail de test (données d'exemple) au demandeur. */
  async sendTest(id: string, to: string) {
    const tid = this.assertTemplate(id);
    const tpl = this.email.previewTemplate(tid);
    const result = await this.email.send({
      to,
      subject: `[TEST] ${tpl.subject}`,
      html: tpl.html,
      text: tpl.text,
      template: tid,
    });
    return { ok: result.ok, error: result.error };
  }

  private assertTemplate(id: string): EmailTemplateId {
    if (!TEMPLATE_IDS.has(id as EmailTemplateId)) {
      throw new BadRequestException(`Modèle inconnu: ${id}`);
    }
    return id as EmailTemplateId;
  }
}
