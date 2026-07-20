import { Injectable } from '@nestjs/common';
import { EmailStatus, Prisma, PushStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_TEMPLATE_META,
  PUSH_TEMPLATE_META,
  SMS_TEMPLATE_META,
  templateLabel,
  type CommChannel,
} from './communications.catalog';

const DAY_MS = 86_400_000;

/** Issue normalisée, comparable d'un canal à l'autre. */
export type CommOutcome = 'DELIVERED' | 'SENT' | 'FAILED' | 'EXPIRED' | 'RECEIVED';

export interface CommLogDto {
  id: string;
  channel: CommChannel;
  template: string | null;
  templateLabel: string;
  /** Destinataire (adresse, numéro masqué, ou utilisateur). */
  target: string;
  /** Sujet e-mail / extrait SMS / titre de la notification. */
  subject: string;
  status: string;
  outcome: CommOutcome;
  error: string | null;
  createdAt: Date;
}

const EMAIL_DELIVERED: EmailStatus[] = [EmailStatus.DELIVERED, EmailStatus.OPENED, EmailStatus.CLICKED];
const EMAIL_FAILED: EmailStatus[] = [EmailStatus.BOUNCED, EmailStatus.FAILED, EmailStatus.COMPLAINED];
const SMS_FAILED = ['failed', 'undelivered', 'rejected', 'error', 'cancelled', 'canceled'];

function emailOutcome(s: EmailStatus): CommOutcome {
  if (EMAIL_DELIVERED.includes(s)) return 'DELIVERED';
  if (EMAIL_FAILED.includes(s)) return 'FAILED';
  return 'SENT';
}
function smsOutcome(direction: string, status: string | null): CommOutcome {
  if (direction === 'IN') return 'RECEIVED';
  const s = (status ?? '').toLowerCase();
  if (s === 'delivered') return 'DELIVERED';
  if (SMS_FAILED.includes(s)) return 'FAILED';
  return 'SENT';
}
function pushOutcome(s: PushStatus): CommOutcome {
  if (s === PushStatus.EXPIRED) return 'EXPIRED';
  if (s === PushStatus.FAILED) return 'FAILED';
  return 'SENT';
}

/** Masque un numéro : +33 6 12 34 56 78 → +336••••78. */
function maskPhone(n: string | null): string {
  if (!n) return '—';
  const t = n.trim();
  return t.length <= 6 ? t : `${t.slice(0, 4)}••••${t.slice(-2)}`;
}

/**
 * MODULE COMMUNICATIONS — vue unifiée de TOUT ce que Tracky envoie à un humain.
 *
 * Un seul service agrège les trois journaux (`email_logs`, `sms_logs`, `push_logs`)
 * derrière un DTO commun, plutôt que trois écrans qui ne se parlent pas. Les
 * spécificités e-mail (délivrabilité Resend, aperçu, envoi de test) restent dans
 * EmailAdminService — ce service ne les duplique pas.
 */
@Injectable()
export class CommunicationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** KPI par canal sur N jours + volume par jour (histogramme partagé). */
  async overview(days = 30) {
    const since = new Date(Date.now() - days * DAY_MS);

    const [emails, sms, pushes] = await Promise.all([
      this.prisma.emailLog.findMany({
        where: { createdAt: { gte: since } },
        select: { status: true, template: true, createdAt: true },
      }),
      this.prisma.smsLog.findMany({
        where: { createdAt: { gte: since }, direction: 'OUT' },
        select: { status: true, template: true, createdAt: true, direction: true },
      }),
      this.prisma.pushLog.findMany({
        where: { createdAt: { gte: since } },
        select: { status: true, template: true, createdAt: true },
      }),
    ]);

    const channels = [
      {
        channel: 'EMAIL' as const,
        sent: emails.length,
        failed: emails.filter((e) => EMAIL_FAILED.includes(e.status)).length,
        delivered: emails.filter((e) => EMAIL_DELIVERED.includes(e.status)).length,
        lastAt: emails.reduce<Date | null>((a, e) => (!a || e.createdAt > a ? e.createdAt : a), null),
      },
      {
        channel: 'SMS' as const,
        sent: sms.length,
        failed: sms.filter((s) => SMS_FAILED.includes((s.status ?? '').toLowerCase())).length,
        delivered: sms.filter((s) => (s.status ?? '').toLowerCase() === 'delivered').length,
        lastAt: sms.reduce<Date | null>((a, s) => (!a || s.createdAt > a ? s.createdAt : a), null),
      },
      {
        channel: 'PUSH' as const,
        sent: pushes.length,
        failed: pushes.filter((p) => p.status !== PushStatus.SENT).length,
        delivered: pushes.filter((p) => p.status === PushStatus.SENT).length,
        lastAt: pushes.reduce<Date | null>((a, p) => (!a || p.createdAt > a ? p.createdAt : a), null),
      },
    ].map((c) => ({
      ...c,
      successRate: c.sent ? Math.round(((c.sent - c.failed) / c.sent) * 100) : 0,
    }));

    // Répartition par modèle, tous canaux confondus (top 12).
    const counts = new Map<string, { channel: CommChannel; template: string; count: number }>();
    const bump = (channel: CommChannel, template: string | null) => {
      const key = `${channel}:${template ?? 'unknown'}`;
      const e = counts.get(key) ?? { channel, template: template ?? 'unknown', count: 0 };
      e.count++;
      counts.set(key, e);
    };
    emails.forEach((e) => bump('EMAIL', e.template));
    sms.forEach((s) => bump('SMS', s.template));
    pushes.forEach((p) => bump('PUSH', p.template));
    const byTemplate = [...counts.values()]
      .map((c) => ({ ...c, label: templateLabel(c.channel, c.template) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    return {
      days,
      totalSent: emails.length + sms.length + pushes.length,
      channels,
      byTemplate,
      series: this.buildSeries(
        [
          ...emails.map((e) => ({ createdAt: e.createdAt, failed: EMAIL_FAILED.includes(e.status) })),
          ...sms.map((s) => ({ createdAt: s.createdAt, failed: SMS_FAILED.includes((s.status ?? '').toLowerCase()) })),
          ...pushes.map((p) => ({ createdAt: p.createdAt, failed: p.status !== PushStatus.SENT })),
        ],
        14,
      ),
    };
  }

  private buildSeries(rows: { createdAt: Date; failed: boolean }[], days: number) {
    const now = new Date();
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const out: { day: string; ok: number; failed: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const from = startOfDay(new Date(now.getTime() - i * DAY_MS));
      const to = from + DAY_MS;
      const slice = rows.filter((r) => r.createdAt.getTime() >= from && r.createdAt.getTime() < to);
      out.push({
        day: new Date(from).toISOString().slice(0, 10),
        ok: slice.filter((r) => !r.failed).length,
        failed: slice.filter((r) => r.failed).length,
      });
    }
    return out;
  }

  /**
   * Journal unifié. Avec `channel`, on pagine la table concernée (offset simple).
   * Sans `channel`, on prend les N plus récents de CHAQUE table puis on fusionne par
   * date — volontairement borné (pas de curseur inter-tables, qui n'aurait pas de
   * sens sur trois séquences d'id différentes).
   */
  async logs(params: {
    channel?: CommChannel;
    template?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: CommLogDto[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    const offset = Math.max(0, params.offset ?? 0);
    const q = params.q?.trim();
    const wants = (c: CommChannel) => !params.channel || params.channel === c;

    const items: CommLogDto[] = [];

    if (wants('EMAIL')) {
      const where: Prisma.EmailLogWhereInput = {};
      if (params.template) where.template = params.template;
      if (q) {
        where.OR = [
          { toAddress: { contains: q, mode: 'insensitive' } },
          { subject: { contains: q, mode: 'insensitive' } },
        ];
      }
      const rows = await this.prisma.emailLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        skip: params.channel ? offset : 0,
      });
      items.push(
        ...rows.map((r) => ({
          id: r.id,
          channel: 'EMAIL' as const,
          template: r.template,
          templateLabel: templateLabel('EMAIL', r.template),
          target: r.toAddress,
          subject: r.subject,
          status: r.status,
          outcome: emailOutcome(r.status),
          error: r.errorMessage,
          createdAt: r.createdAt,
        })),
      );
    }

    if (wants('SMS')) {
      const where: Prisma.SmsLogWhereInput = {};
      if (params.template) where.template = params.template;
      if (q) {
        where.OR = [
          { toNumber: { contains: q, mode: 'insensitive' } },
          { body: { contains: q, mode: 'insensitive' } },
        ];
      }
      const rows = await this.prisma.smsLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        skip: params.channel ? offset : 0,
      });
      items.push(
        ...rows.map((r) => ({
          id: r.id,
          channel: 'SMS' as const,
          template: r.template,
          templateLabel: r.direction === 'IN' ? 'SMS entrant' : templateLabel('SMS', r.template),
          target: maskPhone(r.direction === 'IN' ? r.fromNumber : r.toNumber),
          subject: r.body.slice(0, 120),
          status: r.status ?? '—',
          outcome: smsOutcome(r.direction, r.status),
          error: r.errorMessage,
          createdAt: r.createdAt,
        })),
      );
    }

    if (wants('PUSH')) {
      const where: Prisma.PushLogWhereInput = {};
      if (params.template) where.template = params.template;
      if (q) where.title = { contains: q, mode: 'insensitive' };
      const rows = await this.prisma.pushLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        skip: params.channel ? offset : 0,
      });
      items.push(
        ...rows.map((r) => ({
          id: r.id,
          channel: 'PUSH' as const,
          template: r.template,
          templateLabel: templateLabel('PUSH', r.template),
          target: r.userId ? `user:${r.userId.slice(0, 8)}` : '—',
          subject: r.title,
          status: r.status,
          outcome: pushOutcome(r.status),
          error: r.errorMessage,
          createdAt: r.createdAt,
        })),
      );
    }

    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const hasMore = items.length > limit;
    return { items: hasMore ? items.slice(0, limit) : items, hasMore };
  }

  /**
   * Catalogue complet (3 canaux) enrichi des agrégats 30 j. C'est l'« espace Modèles » :
   * la garantie qu'aucun message ne part sans être recensé ici.
   */
  async templates() {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [emails, sms, pushes] = await Promise.all([
      this.prisma.emailLog.findMany({ where: { createdAt: { gte: since } }, select: { template: true, status: true, createdAt: true } }),
      this.prisma.smsLog.findMany({ where: { createdAt: { gte: since }, direction: 'OUT' }, select: { template: true, status: true, createdAt: true } }),
      this.prisma.pushLog.findMany({ where: { createdAt: { gte: since } }, select: { template: true, status: true, createdAt: true } }),
    ]);

    const agg = new Map<string, { count: number; failed: number; last: Date | null }>();
    const bump = (channel: CommChannel, template: string | null, failed: boolean, at: Date) => {
      const key = `${channel}:${template ?? 'unknown'}`;
      const e = agg.get(key) ?? { count: 0, failed: 0, last: null };
      e.count++;
      if (failed) e.failed++;
      if (!e.last || at > e.last) e.last = at;
      agg.set(key, e);
    };
    emails.forEach((e) => bump('EMAIL', e.template, EMAIL_FAILED.includes(e.status), e.createdAt));
    sms.forEach((s) => bump('SMS', s.template, SMS_FAILED.includes((s.status ?? '').toLowerCase()), s.createdAt));
    pushes.forEach((p) => bump('PUSH', p.template, p.status !== PushStatus.SENT, p.createdAt));

    return ALL_TEMPLATE_META.map((m) => {
      const a = agg.get(`${m.channel}:${m.id}`);
      return {
        ...m,
        sent30d: a?.count ?? 0,
        failed30d: a?.failed ?? 0,
        lastSentAt: a?.last ?? null,
        /** Aperçu disponible uniquement pour l'e-mail (rendu HTML). */
        previewable: m.channel === 'EMAIL',
      };
    });
  }

  /** Compteurs du catalogue — sert au bandeau « N modèles recensés ». */
  catalogCounts() {
    return {
      email: ALL_TEMPLATE_META.filter((t) => t.channel === 'EMAIL').length,
      sms: SMS_TEMPLATE_META.length,
      push: PUSH_TEMPLATE_META.length,
      total: ALL_TEMPLATE_META.length,
    };
  }
}
