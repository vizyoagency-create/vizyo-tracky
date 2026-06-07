import { Injectable, Logger } from '@nestjs/common';
import type { Alert, AlertRule, User, Vehicle } from '@prisma/client';
import { UserRole } from '@prisma/client';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { WebPushService } from './web-push.service';

/**
 * V1.5 (Sprint M) — Dispatch d'une alerte sur les channels actifs.
 *
 * Pour une `Alert` donnee :
 *   1. Trouve les `AlertRule` matching (par fleet, par vehicle, par alertType,
 *      avec catch-all '*'). Si aucune regle, defaut = ['IN_APP'] (legacy WS
 *      seulement, pas d'envoi externe).
 *   2. Pour chaque channel actif (WEB_PUSH / EMAIL / WHATSAPP), envoie au
 *      destinataire (FLEET_ADMIN par defaut, ou User specifique via la regle).
 *   3. Pour les escalades (Sprint M-cron), `dispatchEscalation()` notifie
 *      l'`escalateToUserId` ou `User.escalationContactUserId` du destinataire
 *      original.
 */

export type AlertChannel = 'IN_APP' | 'WEB_PUSH' | 'EMAIL' | 'WHATSAPP' | 'SMS';

/**
 * V1.15 — Anti-flood SMS : au plus 1 SMS d'alerte par (destinataire, type
 * d'alerte) sur cette fenetre. Evite qu'une rafale d'alertes du meme type
 * (ex: 20 OVERSPEED en 2min) ne declenche 20 SMS (spam + cout SIM). Les autres
 * canaux (push/email/whatsapp) ne sont pas throttles.
 */
const SMS_THROTTLE_MS = 5 * 60_000;

interface AlertWithVehicle extends Alert {
  vehicle?: Vehicle | null;
}

@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webPush: WebPushService,
    private readonly email: EmailService,
    private readonly sms: SmsGatewayService,
  ) {}

  /**
   * Dispatch an alert to all matching channels. Called by AlertsService.create
   * via EventEmitter or direct invocation. Errors are swallowed per-channel —
   * one channel failure doesn't abort the others.
   */
  async dispatchAlert(alert: AlertWithVehicle): Promise<{ channels: AlertChannel[] }> {
    const rules = await this.findMatchingRules(alert);
    const channels = this.mergeChannels(rules);

    // Recipients = tous les FLEET_ADMIN actifs de la fleet (par defaut).
    // Si une regle specifie escalateToUserId, on l'inclut aussi.
    const recipients = await this.resolveRecipients(alert, rules);
    if (recipients.length === 0) {
      this.logger.debug(`Alert ${alert.id}: no recipients found`);
      return { channels };
    }

    for (const recipient of recipients) {
      for (const channel of channels) {
        if (channel === 'IN_APP') continue; // legacy WS deja envoye par AlertsService
        try {
          await this.sendOnChannel(channel, recipient, alert);
        } catch (err) {
          this.logger.warn(
            `Dispatch ${channel} alert ${alert.id} -> ${recipient.email} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    return { channels };
  }

  /**
   * Escalation : notifies the original recipient's escalation contact about
   * an unacknowledged CRITICAL alert. Called by ReportsCronService at fixed
   * intervals (Sprint M cron escalade).
   */
  async dispatchEscalation(alert: AlertWithVehicle): Promise<void> {
    // Escalade par defaut : tous les FLEET_ADMIN escalent vers leur escalationContactUserId.
    const fleetAdmins = await this.prisma.user.findMany({
      where: { fleetId: alert.fleetId, role: UserRole.FLEET_ADMIN, isActive: true },
    });
    const escalationTargets = new Map<string, User>();
    for (const admin of fleetAdmins) {
      if (!admin.escalationContactUserId) continue;
      const target = await this.prisma.user.findUnique({
        where: { id: admin.escalationContactUserId },
      });
      if (target && target.isActive) {
        escalationTargets.set(target.id, target);
      }
    }

    // Dispatch sur les channels actifs pour cette alert (memes regles que la
    // notification initiale, en supposant que l'escalade utilise les memes
    // canaux). Si pas de cible, on ne fait rien.
    if (escalationTargets.size === 0) return;

    const rules = await this.findMatchingRules(alert);
    const channels = this.mergeChannels(rules);
    for (const target of escalationTargets.values()) {
      for (const channel of channels) {
        if (channel === 'IN_APP') continue;
        try {
          await this.sendOnChannel(channel, target, alert, /* isEscalation */ true);
        } catch (err) {
          this.logger.warn(
            `Escalation ${channel} alert ${alert.id} -> ${target.email} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }

  private async findMatchingRules(alert: AlertWithVehicle): Promise<AlertRule[]> {
    return this.prisma.alertRule.findMany({
      where: {
        fleetId: alert.fleetId,
        enabled: true,
        OR: [
          { vehicleId: alert.vehicleId ?? null },
          { vehicleId: null },
        ],
        AND: [
          { OR: [{ alertType: alert.type as string }, { alertType: '*' }] },
        ],
      },
    });
  }

  private mergeChannels(rules: AlertRule[]): AlertChannel[] {
    if (rules.length === 0) return ['IN_APP']; // pas de regle = in-app only (legacy)
    const set = new Set<AlertChannel>();
    set.add('IN_APP');
    for (const rule of rules) {
      const list = (rule.channels as unknown as AlertChannel[]) ?? [];
      for (const c of list) set.add(c);
    }
    return Array.from(set);
  }

  private async resolveRecipients(
    alert: AlertWithVehicle,
    rules: AlertRule[],
  ): Promise<User[]> {
    const userIds = new Set<string>();

    // Si une regle a escalateToUserId defini, on l'inclut deja dans les destinataires
    // initiaux (pas reellement utilise pour escalation ici — utile pour cibler
    // un user precis).
    for (const rule of rules) {
      if (rule.escalateToUserId) userIds.add(rule.escalateToUserId);
    }

    // Par defaut : tous les FLEET_ADMIN de la fleet.
    const fleetAdmins = await this.prisma.user.findMany({
      where: { fleetId: alert.fleetId, role: UserRole.FLEET_ADMIN, isActive: true },
    });
    for (const admin of fleetAdmins) userIds.add(admin.id);

    // V1.6 — Surveillance Max : pour les alertes SURVEILLANCE_TRIGGERED, on
    // ajoute les destinataires supplementaires definis sur le profil
    // (typiquement des FLEET_MANAGER opt-in autorises a recevoir les alertes
    // de vol pour ce vehicule precis).
    if (alert.type === 'SURVEILLANCE_TRIGGERED' && alert.vehicleId) {
      const profile = await this.prisma.surveillanceProfile.findUnique({
        where: { vehicleId: alert.vehicleId },
        select: { additionalNotifyUserIds: true },
      });
      if (profile) {
        for (const id of profile.additionalNotifyUserIds) userIds.add(id);
      }
    }

    if (userIds.size === 0) return [];

    // Filtre tenant strict : on ne retient que les users de la flotte de l'alerte.
    // Empeche un escalateToUserId ou additionalNotifyUserIds mal configure de
    // router une notif vers un user d'une autre flotte (cross-tenant leak).
    return this.prisma.user.findMany({
      where: {
        id: { in: Array.from(userIds) },
        isActive: true,
        fleetId: alert.fleetId,
      },
    });
  }

  private async sendOnChannel(
    channel: AlertChannel,
    user: User,
    alert: AlertWithVehicle,
    isEscalation = false,
  ): Promise<void> {
    const prefix = isEscalation ? '[ESCALADE] ' : '';
    const plate = alert.vehicle?.plate ?? alert.vehicleId ?? '';
    const subject = `${prefix}[Tracky] ${alert.title}${plate ? ` — ${plate}` : ''}`;
    const bodyText = `${prefix}${alert.title}\n${alert.message ?? ''}\n\nVehicule : ${plate || 'N/A'}\nSeverite : ${alert.severity}\n\nVoir l'alerte : (acceder a Tracky pour acquitter)`;

    if (channel === 'WEB_PUSH') {
      // expectedFleetId = alert.fleetId : defense en profondeur, refuse l'envoi
      // si l'user n'appartient pas a la flotte de l'alerte.
      await this.webPush.sendToUser(user.id, {
        title: subject,
        body: alert.message ?? alert.title,
        url: '/alerts',
        data: {
          alertId: alert.id,
          escalation: isEscalation,
          severity: alert.severity,
          vehiclePlate: plate,
        },
        // Severite -> SW : pattern vibration + requireInteraction si CRITICAL.
        severity: alert.severity as 'INFO' | 'WARNING' | 'CRITICAL',
        // Tag = alertId : si l'alerte est re-pushee (escalade), la nouvelle notif
        // remplace l'ancienne dans le centre de notifications du browser/OS.
        tag: alert.id,
      }, alert.fleetId);
      return;
    }
    if (channel === 'EMAIL') {
      const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1f2937;">
<h2 style="color:${isEscalation ? '#dc2626' : '#10E0A0'};">${prefix}${escapeHtml(alert.title)}</h2>
<p style="color:#374151;">${escapeHtml(alert.message ?? '')}</p>
<table style="border-collapse:collapse;margin-top:12px;">
  <tr><td style="padding:4px 8px;color:#6b7280;">Vehicule</td><td style="padding:4px 8px;">${escapeHtml(plate || 'N/A')}</td></tr>
  <tr><td style="padding:4px 8px;color:#6b7280;">Severite</td><td style="padding:4px 8px;">${alert.severity}</td></tr>
  <tr><td style="padding:4px 8px;color:#6b7280;">Type</td><td style="padding:4px 8px;font-family:monospace;">${alert.type}</td></tr>
  <tr><td style="padding:4px 8px;color:#6b7280;">Cree le</td><td style="padding:4px 8px;">${alert.createdAt.toLocaleString('fr-FR')}</td></tr>
</table>
<p style="margin-top:18px;"><a href="${escapeHtml(process.env.APP_BASE_URL ?? 'http://localhost:4200')}/alerts" style="background:#10E0A0;color:#0b0f12;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600;">Acquitter l'alerte</a></p>
</div>`;
      await this.email.send({ to: user.email, subject, html, text: bodyText });
      return;
    }
    if (channel === 'WHATSAPP' && user.phone) {
      // Envoi WhatsApp via Twilio (numero whatsapp:+... requis cote Twilio).
      // Pour V1, on passe par le canal SMS Twilio classique — Twilio supporte
      // WhatsApp via prefix 'whatsapp:'. Si le user n'a pas de phone, skip.
      const target = user.phone.startsWith('whatsapp:') ? user.phone : `whatsapp:${user.phone}`;
      await this.sms.send(target, bodyText, { alertId: alert.id, channel: 'whatsapp', escalation: isEscalation });
      return;
    }
    if (channel === 'SMS' && user.phone) {
      // V1.15 — SMS via vizyo-texto. Contrairement a WhatsApp, pas de prefixe :
      // on envoie au numero E.164 brut. Throttle anti-flood par (user, type).
      // SmsGatewayService gere deja l'audit sms_logs + l'ErrorLog CRITICAL si KO.
      if (await this.isSmsThrottled(user.id, alert.type as string)) {
        this.logger.debug(`SMS throttled for ${user.id} / ${alert.type} (alert ${alert.id})`);
        return;
      }
      await this.sms.send(user.phone, this.formatAlertSms(alert, isEscalation), {
        source: 'alert-notification',
        alertId: alert.id,
        vehicleId: alert.vehicleId ?? undefined,
        userId: user.id,
        alertType: alert.type as string,
        escalation: isEscalation,
      });
      return;
    }
  }

  /**
   * Format court pour SMS (1 segment ~160 char max — au-dela ca fragmente cote
   * gateway = surcout). Ex: "[Vizyo Tracky] CRITICAL — Exces de vitesse · TE002ST · 14h23".
   */
  private formatAlertSms(alert: AlertWithVehicle, isEscalation: boolean): string {
    const plate = alert.vehicle?.plate ?? alert.vehicleId ?? '?';
    const time = alert.createdAt.toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Paris',
    });
    const esc = isEscalation ? 'ESCALADE ' : '';
    const body = `[Vizyo Tracky] ${esc}${alert.severity} — ${alert.title} · ${plate} · ${time}`;
    return body.length > 160 ? `${body.slice(0, 157)}...` : body;
  }

  /**
   * True si un SMS d'alerte a deja ete tente pour ce (user, alertType) dans la
   * fenetre SMS_THROTTLE_MS. On compte toute tentative (meme failed/noop) :
   * l'objectif est de plafonner le volume SMS, pas de garantir la livraison
   * (les autres canaux restent envoyes a chaque alerte).
   */
  private async isSmsThrottled(userId: string, alertType: string): Promise<boolean> {
    const since = new Date(Date.now() - SMS_THROTTLE_MS);
    const recent = await this.prisma.smsLog.findFirst({
      where: {
        direction: 'OUT',
        createdAt: { gte: since },
        AND: [
          { context: { path: ['source'], equals: 'alert-notification' } },
          { context: { path: ['userId'], equals: userId } },
          { context: { path: ['alertType'], equals: alertType } },
        ],
      },
      select: { id: true },
    });
    return recent !== null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[m]!));
}
