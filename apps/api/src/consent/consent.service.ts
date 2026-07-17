import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { CONSENT_DOC_TYPES, CONSENT_ENFORCE, CONSENT_VERSION } from './consent.constants';

/**
 * Consentements RGPD. Deux surfaces :
 *  - Utilisateurs de l'app : acceptation CGU + Confidentialité, versionnée, avec
 *    IP + userAgent (preuve CNIL). Le gate d'accès exige la version courante.
 *  - Visiteurs LP : choix accepter/refuser du bandeau, anonyme, avec IP.
 *
 * Cache mémoire des users à jour : le gate tourne à chaque requête ; sans cache ce
 * serait un SELECT par requête. Un user consentant est mis en cache pour la durée du
 * process (le consentement d'une version ne « se retire » pas — un bump de version
 * = nouveau déploiement = process neuf = cache vide → re-check).
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);
  private readonly consented = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  isCached(userId: string): boolean {
    return this.consented.has(userId);
  }

  /** true si l'utilisateur a accepté CGU ET PRIVACY à la version courante. */
  async hasCurrentConsent(userId: string): Promise<boolean> {
    if (this.consented.has(userId)) return true;
    const rows = await this.prisma.userConsent.findMany({
      where: { userId, version: CONSENT_VERSION, accepted: true },
      select: { docType: true },
    });
    const types = new Set(rows.map((r) => r.docType));
    const ok = CONSENT_DOC_TYPES.every((t) => types.has(t));
    if (ok) this.consented.add(userId);
    return ok;
  }

  /** Statut détaillé (pour l'écran de gate côté front). */
  async status(
    userId: string,
  ): Promise<{ version: string; cgu: boolean; privacy: boolean; required: boolean; enforce: boolean }> {
    const rows = await this.prisma.userConsent.findMany({
      where: { userId, version: CONSENT_VERSION, accepted: true },
      select: { docType: true },
    });
    const types = new Set(rows.map((r) => r.docType));
    const cgu = types.has('CGU');
    const privacy = types.has('PRIVACY');
    return { version: CONSENT_VERSION, cgu, privacy, required: !(cgu && privacy), enforce: CONSENT_ENFORCE };
  }

  /** Enregistre l'acceptation CGU + Confidentialité à la version courante (idempotent). */
  async acceptCurrent(
    userId: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ version: string }> {
    const existing = await this.prisma.userConsent.findMany({
      where: { userId, version: CONSENT_VERSION, accepted: true },
      select: { docType: true },
    });
    const have = new Set(existing.map((r) => r.docType));
    const data = CONSENT_DOC_TYPES.filter((t) => !have.has(t)).map((docType) => ({
      userId,
      docType,
      version: CONSENT_VERSION,
      accepted: true,
      ip,
      userAgent: userAgent ? userAgent.slice(0, 400) : null,
    }));
    if (data.length) await this.prisma.userConsent.createMany({ data });
    this.consented.add(userId);
    return { version: CONSENT_VERSION };
  }

  /** Enregistre le choix de consentement d'un VISITEUR LP (anonyme, avec IP). */
  async recordLp(input: {
    choice: string;
    sessionId?: string | null;
    categories?: unknown;
    ip: string | null;
    userAgent: string | null;
    page?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.lpConsent.create({
        data: {
          choice: input.choice === 'granted' ? 'granted' : 'denied',
          sessionId: input.sessionId ? input.sessionId.slice(0, 64) : null,
          categories:
            input.categories == null ? undefined : (input.categories as Prisma.InputJsonValue),
          ip: input.ip,
          userAgent: input.userAgent ? input.userAgent.slice(0, 400) : null,
          page: input.page ? input.page.slice(0, 120) : null,
        },
      });
    } catch (e) {
      // Le 204 est conservé (le bandeau LP ne doit jamais casser), mais la PREUVE
      // CNIL du choix visiteur ne doit pas se perdre en silence → centre d'alerte.
      this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'consent', {
        note: 'échec écriture LpConsent (preuve bandeau LP)',
      });
    }
  }

  /** ADMIN — statut de consentement app par utilisateur (avec date + IP d'acceptation). */
  async adminUsersOverview(requesterIsOwner: boolean) {
    const users = await this.prisma.user.findMany({
      where: { isActive: true, ...(requesterIsOwner ? {} : { isOwner: false }) },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        consents: {
          where: { version: CONSENT_VERSION, accepted: true },
          select: { docType: true, acceptedAt: true, ip: true },
        },
        devicePermissions: { select: { kind: true, granted: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return users.map((u) => {
      const cgu = u.consents.find((c) => c.docType === 'CGU') ?? null;
      const privacy = u.consents.find((c) => c.docType === 'PRIVACY') ?? null;
      // État d'une permission device : null = jamais demandée, true = accordée sur au
      // moins un appareil, false = demandée mais refusée partout.
      const permState = (kind: string): boolean | null => {
        const rows = u.devicePermissions.filter((p) => p.kind === kind);
        if (rows.length === 0) return null;
        return rows.some((p) => p.granted);
      };
      return {
        userId: u.id,
        email: u.email,
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
        role: u.role,
        version: CONSENT_VERSION,
        cgu: cgu ? { accepted: true, at: cgu.acceptedAt, ip: cgu.ip } : { accepted: false },
        privacy: privacy ? { accepted: true, at: privacy.acceptedAt, ip: privacy.ip } : { accepted: false },
        compliant: !!cgu && !!privacy,
        notif: permState('PUSH'),
        geo: permState('GEOLOCATION'),
      };
    });
  }

  /** Enregistre une permission device accordée/refusée (notifications, localisation). */
  async recordPermission(
    userId: string,
    input: { kind: string; granted: boolean; deviceId: string; ip: string | null; userAgent: string | null },
  ): Promise<void> {
    const kind =
      input.kind === 'GEOLOCATION' ? 'GEOLOCATION' : input.kind === 'PUSH' ? 'PUSH' : null;
    if (!kind || !input.deviceId) return;
    const deviceId = input.deviceId.slice(0, 100);
    const userAgent = input.userAgent ? input.userAgent.slice(0, 400) : null;
    try {
      await this.prisma.userPermission.upsert({
        where: { userId_deviceId_kind: { userId, deviceId, kind } },
        create: { userId, deviceId, kind, granted: input.granted, ip: input.ip, userAgent },
        update: { granted: input.granted, ip: input.ip, userAgent },
      });
    } catch (e) {
      // Preuve d'octroi/refus des permissions device (dont la géoloc obligatoire à
      // l'onboarding conducteur) : un échec silencieux fausse la vue admin conformité.
      this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'consent', {
        userId, note: 'échec écriture UserPermission (preuve device)',
      });
    }
  }

  /** ADMIN — derniers consentements de VISITEURS LP (choix + IP). */
  async adminLpConsents(limit: number) {
    const take = Math.min(Math.max(limit || 100, 1), 200);
    return this.prisma.lpConsent.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        choice: true,
        ip: true,
        page: true,
        sessionId: true,
        categories: true,
        createdAt: true,
      },
    });
  }
}
