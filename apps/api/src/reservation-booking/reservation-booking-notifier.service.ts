import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EmailService } from '../email/email.service';
import { ErrorLogger } from '../observability/error-logger.service';
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
  ) {}

  /** Accusé de réception (à la soumission publique). Best-effort. */
  async sendAcknowledgment(input: {
    fleetId: string;
    contact: string;
    destination: string | null;
    startAt: string;
    endAt: string;
    count: number;
  }): Promise<void> {
    const dest = input.destination ? ` → ${input.destination}` : '';
    const when = this.fmtSlot(input.startAt, input.endAt);
    const subject = 'Demande de réservation reçue';
    const text = `Bonjour,\n\nNous avons bien reçu votre demande${dest} (${input.count} véhicule(s)) pour ${when}.\nVous recevrez une confirmation dès qu'elle sera validée.\n\nMerci.`;
    const html = `<p>Bonjour,</p><p>Nous avons bien reçu votre demande${dest} (${input.count} véhicule(s)) pour <strong>${when}</strong>.</p><p>Vous recevrez une confirmation dès qu'elle sera validée.</p>`;
    await this.notify(input.contact, input.fleetId, subject, text, html);
  }

  /** Confirmation à la VALIDATION d'une réservation publique. */
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
    const dest = typeof m['destination'] === 'string' && m['destination'] ? ` → ${m['destination'] as string}` : '';
    const when = this.fmtSlot(payload.startAt, payload.endAt);
    const plate = payload.vehiclePlate ?? 'votre véhicule';
    const subject = 'Votre réservation est confirmée';
    const text = `Bonjour,\n\nVotre demande de réservation${dest} a été VALIDÉE.\nVéhicule ${plate} — ${when}.\n\nMerci.`;
    const html = `<p>Bonjour,</p><p>Votre demande de réservation${dest} a été <strong>validée</strong>.</p><p>Véhicule <strong>${plate}</strong> — ${when}.</p><p>Merci.</p>`;
    await this.notify(contact, payload.fleetId, subject, text, html);
  }

  // ─── Interne ───────────────────────────────────────────────────────────────

  /** Envoie e-mail (contact avec « @ ») ou SMS. Tout échec → centre d'alerte admin. */
  private async notify(contact: string, fleetId: string, subject: string, text: string, html: string): Promise<void> {
    const c = (contact || '').trim();
    if (!c) return;
    const isEmail = c.includes('@');
    try {
      const res = isEmail
        ? await this.email.send({ to: c, subject, html, text, fleetId, context: { kind: 'public_reservation' } })
        : await this.sms.send(c, text, { kind: 'public_reservation', fleetId });
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
