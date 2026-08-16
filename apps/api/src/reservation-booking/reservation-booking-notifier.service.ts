import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EmailService, type EmailTemplateId } from '../email/email.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';

/** Source des erreurs → visible dans le centre d'alerte admin (/admin/alerts). */
const SOURCE = 'RESERVATION_BOOKING';

/**
 * Refonte agenda/IA (2026-07, P4) — Notifications au DEMANDEUR d'un lien public.
 * Découplé du flux réservation : à la SOUMISSION (accusé de réception) et à la VALIDATION
 * (`@OnEvent('reservation.confirmed')`). Canal : e-mail si le contact contient « @ », sinon SMS.
 * Best-effort : tout échec (envoi ou exception) est journalisé dans le CENTRE D'ALERTE admin via
 * ErrorLogger (source RESERVATION_BOOKING) — jamais d'exception propagée au flux métier.
 */
@Injectable()
export class ReservationBookingNotifier {
  constructor(
    private readonly email: EmailService,
    private readonly sms: SmsGatewayService,
    private readonly errors: ErrorLogger,
    private readonly prisma: PrismaService,
  ) {}

  /** Accusé de réception (à la soumission publique) — e-mail AU THÈME (charte 2026). Best-effort. */
  async sendAcknowledgment(input: {
    fleetId: string;
    contact: string;
    destination: string | null;
    startAt: string;
    endAt: string;
    seats?: number | null;
  }): Promise<void> {
    const built = this.email.buildReservationRequestedEmail({
      fleetName: await this.fleetNameOf(input.fleetId),
      slotLabel: this.fmtSlot(input.startAt, input.endAt),
      destination: input.destination,
      seats: input.seats ?? null,
    });
    await this.notify(input.contact, input.fleetId, built, 'reservation_requested');
  }

  /** Confirmation à la VALIDATION d'une réservation publique — e-mail AU THÈME. */
  @OnEvent('reservation.confirmed', { async: true })
  async onConfirmed(payload: {
    fleetId: string;
    vehiclePlate: string | null;
    startAt: string;
    endAt: string | null;
    metadata: Record<string, unknown> | null;
  }): Promise<void> {
    const m = payload?.metadata;
    if (!m || m['public'] !== true) return; // uniquement les demandes publiques
    const contact = typeof m['requesterContact'] === 'string' ? (m['requesterContact'] as string) : '';
    if (!contact.trim()) return;
    const built = this.email.buildReservationConfirmedEmail({
      fleetName: await this.fleetNameOf(payload.fleetId),
      slotLabel: this.fmtSlot(payload.startAt, payload.endAt),
      destination: typeof m['destination'] === 'string' ? (m['destination'] as string) : null,
      vehicle: payload.vehiclePlate,
    });
    await this.notify(contact, payload.fleetId, built, 'reservation_confirmed');
  }

  // ─── Interne ───────────────────────────────────────────────────────────────

  /** Nom de la flotte (pour l'e-mail). Best-effort → « la société » si indisponible. */
  private async fleetNameOf(fleetId: string): Promise<string> {
    try {
      const f = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { name: true } });
      return f?.name?.trim() || 'la société';
    } catch {
      return 'la société';
    }
  }

  /** Envoie e-mail (contact avec « @ ») ou SMS. Tout échec → centre d'alerte admin. */
  private async notify(
    contact: string,
    fleetId: string,
    built: { subject: string; text: string; html: string },
    template: EmailTemplateId,
  ): Promise<void> {
    const c = (contact || '').trim();
    if (!c) return;
    const isEmail = c.includes('@');
    try {
      const res = isEmail
        ? await this.email.send({ to: c, subject: built.subject, html: built.html, text: built.text, template, fleetId, context: { kind: 'public_reservation' } })
        : await this.sms.send(c, built.text, { template: 'reservation_public', kind: 'public_reservation', fleetId });
      if (!res.ok) {
        await this.errors.record(
          `Notification demandeur échouée (${isEmail ? 'e-mail' : 'SMS'}) : ${res.error ?? 'erreur inconnue'}`,
          SOURCE,
          { fleetId, channel: isEmail ? 'email' : 'sms', contact: this.mask(c) },
        );
      }
    } catch (e) {
      await this.errors.record(
        e instanceof Error ? e : String(e),
        SOURCE,
        { fleetId, channel: isEmail ? 'email' : 'sms', contact: this.mask(c) },
      );
    }
  }

  /** Créneau lisible (Europe/Paris) pour l'e-mail / SMS. */
  private fmtSlot(startAtIso: string, endAtIso: string | null): string {
    try {
      const s = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      }).format(new Date(startAtIso));
      const e = endAtIso
        ? ' → ' + new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(endAtIso))
        : '';
      return s + e;
    } catch {
      return startAtIso;
    }
  }

  /** Masque le contact pour la journalisation (RGPD : pas de PII en clair dans les alertes). */
  private mask(c: string): string {
    if (c.includes('@')) {
      const [u, d] = c.split('@');
      return `${(u ?? '').slice(0, 2)}***@${d ?? ''}`;
    }
    return c.length > 4 ? `${c.slice(0, 3)}***${c.slice(-2)}` : '***';
  }
}
